// Banco falso que imita web/database.js para os testes do webhook da Hotmart.
//
// Reproduz o que importa para as regras testadas: mesclagem de planos com
// `removePlans`, remoção POR PLANO (com registro do que foi revogado no
// Telegram) e a tabela `subscriber_plan_access` — que pode ser "inexistente",
// para testar o comportamento antes do SQL manual rodar.

function splitPlans(plan) {
  if (Array.isArray(plan)) {
    return [...new Set(plan.map((item) => String(item || '').trim()).filter(Boolean))];
  }

  return [
    ...new Set(
      String(plan || '')
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function mergePlans(existingPlan, incomingPlan, removePlans = []) {
  const removeSet = new Set(splitPlans(removePlans).map((item) => item.toLowerCase()));
  const kept = splitPlans(existingPlan).filter((item) => !removeSet.has(item.toLowerCase()));
  return [...new Set([...kept, ...splitPlans(incomingPlan)])].join(', ');
}

function createFakeDb({ subscribers = [], planAccessTableMissing = false } = {}) {
  let subscriberSeq = 1;
  let planAccessSeq = 1;

  const state = {
    subscribers: subscribers.map((subscriber) => ({
      id: subscriber.id || subscriberSeq++,
      name: subscriber.name || subscriber.email,
      email: String(subscriber.email).toLowerCase(),
      phone: subscriber.phone || '11999990000',
      plan: subscriber.plan || '',
      status: subscriber.status || 'active',
      origin: subscriber.origin || 'hotmart'
    })),
    planAccess: [],
    planAccessTableMissing,
    // Tudo o que o bot "fez" no Telegram, para os testes conferirem que
    // ninguém foi cortado quando não devia.
    revocations: [],
    authorizationLogs: []
  };

  function findByEmail(email) {
    const normalized = String(email || '').toLowerCase().trim();
    return state.subscribers.find((subscriber) => subscriber.email === normalized) || null;
  }

  function missingTableError() {
    const error = new Error('relation "subscriber_plan_access" does not exist');
    error.code = '42P01';
    return error;
  }

  const db = {
    state,

    async getSubscriberByEmail(email) {
      const found = findByEmail(email);
      return found ? { ...found } : null;
    },

    async upsertSubscriberFromHotmart({ name, email, phone, plan, status = 'active', removePlans = [] }) {
      const normalized = String(email || '').toLowerCase().trim();
      const existing = findByEmail(normalized);

      if (existing) {
        existing.name = name && String(name).trim() ? String(name).trim() : existing.name;
        existing.phone = String(phone || '').replace(/\D/g, '') || existing.phone;
        existing.plan = mergePlans(existing.plan, plan, removePlans);
        existing.status = status;
        existing.origin = 'hotmart';
        return { ...existing };
      }

      const created = {
        id: subscriberSeq++,
        name: name || normalized,
        email: normalized,
        phone: String(phone || '').replace(/\D/g, ''),
        plan: mergePlans(null, plan, removePlans),
        status,
        origin: 'hotmart'
      };

      state.subscribers.push(created);
      return { ...created };
    },

    // Mesma semântica de web/database.js: com `plan`, remove só aquele plano e
    // revoga convites/canais daquele plano; sem `plan`, desativa tudo.
    async deactivateSubscriberByEmail(email, { plan } = {}) {
      const subscriber = findByEmail(email);

      if (!subscriber) {
        return null;
      }

      const targetPlan = plan && String(plan).trim();
      let planRevoked = false;

      if (targetPlan) {
        const current = splitPlans(subscriber.plan);
        const remaining = current.filter(
          (item) => item.toLowerCase() !== targetPlan.toLowerCase()
        );

        planRevoked = remaining.length !== current.length;

        if (planRevoked) {
          subscriber.plan = remaining.join(', ');
          subscriber.status = remaining.length === 0 ? 'inactive' : subscriber.status;
          state.revocations.push({
            email: subscriber.email,
            revokedPlans: targetPlan,
            remainingPlan: subscriber.plan,
            full: remaining.length === 0
          });
        }
      } else {
        subscriber.status = 'inactive';
        state.revocations.push({ email: subscriber.email, revokedPlans: null, full: true });
      }

      return { ...subscriber, planRevoked };
    },

    async logWebhookAuthorization(entry) {
      state.authorizationLogs.push(entry);
      return { id: state.authorizationLogs.length, ...entry };
    },

    async setPlanAccessUntil({ subscriberId, plan, accessUntil, reason = null }) {
      if (state.planAccessTableMissing) {
        throw missingTableError();
      }

      const normalizedPlan = String(plan || '').trim();
      const date = accessUntil instanceof Date ? accessUntil : new Date(accessUntil);
      const existing = state.planAccess.find(
        (row) =>
          row.subscriber_id === subscriberId &&
          row.plan.toLowerCase() === normalizedPlan.toLowerCase()
      );

      if (existing) {
        existing.access_until = date;
        existing.reason = reason;
        return { ...existing };
      }

      const row = {
        id: planAccessSeq++,
        subscriber_id: subscriberId,
        plan: normalizedPlan,
        access_until: date,
        reason
      };

      state.planAccess.push(row);
      return { ...row };
    },

    async clearPlanAccessUntil({ subscriberId, plan }) {
      if (state.planAccessTableMissing) {
        throw missingTableError();
      }

      const targets = new Set(splitPlans(plan).map((item) => item.toLowerCase()));
      const before = state.planAccess.length;

      state.planAccess = state.planAccess.filter(
        (row) => !(row.subscriber_id === subscriberId && targets.has(row.plan.toLowerCase()))
      );

      return before - state.planAccess.length;
    },

    async listExpiredPlanAccess(now = new Date()) {
      if (state.planAccessTableMissing) {
        throw missingTableError();
      }

      const reference = now instanceof Date ? now : new Date(now);

      return state.planAccess
        .filter((row) => row.access_until.getTime() <= reference.getTime())
        .map((row) => {
          const subscriber = state.subscribers.find((item) => item.id === row.subscriber_id);
          return {
            ...row,
            email: subscriber ? subscriber.email : null,
            subscriber_plan: subscriber ? subscriber.plan : null
          };
        });
    },

    async deletePlanAccessById(id) {
      if (state.planAccessTableMissing) {
        throw missingTableError();
      }

      const before = state.planAccess.length;
      state.planAccess = state.planAccess.filter((row) => row.id !== id);
      return before - state.planAccess.length;
    }
  };

  return db;
}

// Envolve o banco falso com a mesma proteção do real: sem a tabela, as funções
// de agendamento devolvem null/[]/0 em vez de estourar.
function createFakeDbWithoutPlanAccessTable(options = {}) {
  const db = createFakeDb({ ...options, planAccessTableMissing: true });

  return {
    ...db,
    state: db.state,
    async setPlanAccessUntil() {
      return null;
    },
    async clearPlanAccessUntil() {
      return 0;
    },
    async listExpiredPlanAccess() {
      return [];
    },
    async deletePlanAccessById() {
      return 0;
    }
  };
}

function createSilentLogger() {
  const entries = [];

  const record = (level) => (event, data) => entries.push({ level, event, data });

  return {
    entries,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    incrementWebhook: () => {},
    find(event) {
      return entries.filter((entry) => entry.event === event);
    }
  };
}

const silentMetrics = { increment: () => {} };
const noopCache = { invalidate: () => {} };

module.exports = {
  createFakeDb,
  createFakeDbWithoutPlanAccessTable,
  createSilentLogger,
  silentMetrics,
  noopCache,
  splitPlans
};
