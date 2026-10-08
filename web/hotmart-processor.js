// Decide e aplica o efeito de um evento da Hotmart no bot.
//
// Separado de web/hotmart-webhook.js (que é só a rota HTTP + fila de retry)
// para poder receber `db`/`cache` por injeção e ser testável sem banco.
//
// As regras de negócio são as mesmas do portal:
//
//   1. Renovação cancelada -> acesso até o fim do período já pago. NÃO corta
//      na hora: grava `access_until` e quem corta é o job diário.
//   2. Reembolso, chargeback e disputa -> cortam na hora.
//   3. Atraso (status `delayed`/`overdue`) -> corta na hora.
//   4. Rebaixamento acontece por compra nova, não por troca de plano para
//      baixo. Troca de plano que não é LITE -> VIP vai para revisão.
//
// E a ativação acontece SÓ por evento explícito: o status do payload nunca
// ativa ninguém.

const defaultDb = require('./database');
const defaultCache = require('../bot/cache');
const defaultLogger = require('../shared/logger');
const defaultMetrics = require('../shared/metrics-collector');
const { sanitizeEmail, sanitizeText } = require('../shared/sanitize');
const {
  decideHotmartAction,
  extractSubscriberData,
  extractNextChargeDate,
  normalizePlanMapping,
  resolvePlanFromMapping,
  resolvePlanFromPlanId,
  resolveMigration,
  normalizeMatchKey,
  findLitePlans,
  MIGRATION_TARGET_PLAN
} = require('./hotmart-utils');

const CANCELLATION_REASON = 'subscription_cancellation';

function createHotmartProcessor({
  db = defaultDb,
  cache = defaultCache,
  logger = defaultLogger,
  metrics = defaultMetrics,
  planMapping = process.env.HOTMART_PLAN_MAP || '',
  defaultPlan = process.env.HOTMART_DEFAULT_PLAN || process.env.DEFAULT_PLAN || null
} = {}) {
  const mapping = normalizePlanMapping(planMapping);

  function invalidate(subscriberId) {
    if (subscriberId) {
      cache.invalidate(`sub:${subscriberId}`);
    }
  }

  // Uma ativação (compra nova ou renovação paga) apaga o agendamento de fim de
  // acesso dos planos envolvidos: a pessoa reativou ou comprou de novo.
  async function clearScheduledAccess(subscriberId, plans) {
    if (!subscriberId) {
      return 0;
    }

    const list = plans.filter(Boolean);

    if (list.length === 0) {
      return 0;
    }

    try {
      return await db.clearPlanAccessUntil({ subscriberId, plan: list });
    } catch (error) {
      // Não derruba a ativação por causa do agendamento.
      logger.error('webhook_hotmart_clear_access_failed', {
        subscriber_id: subscriberId,
        error: error.message
      });
      return 0;
    }
  }

  async function handleActivation({ decision, plan, migration, context }) {
    const removePlans = migration.isMigration ? migration.removePlans : [];

    const record = await db.upsertSubscriberFromHotmart({
      name: context.name,
      email: context.email,
      phone: context.phone,
      plan,
      status: 'active',
      removePlans
    });

    invalidate(record?.id);

    const cleared = await clearScheduledAccess(record?.id, [plan, ...removePlans]);

    if (record?.id) {
      await db.logWebhookAuthorization({
        subscriberId: record.id,
        action: 'authorized',
        platform: 'HOTMART',
        eventType: decision.eventType,
        status: decision.status,
        source: decision.actionSource
      });
    }

    logger.info('webhook_hotmart_processed', {
      action: 'activation',
      email: context.email,
      plan: sanitizeText(plan, 255),
      subscriber_id: record?.id || null,
      migration: migration.isMigration || false,
      migration_source: migration.isMigration ? migration.source : null,
      migrated_from: migration.isMigration ? sanitizeText(String(removePlans.join(', ')), 255) : null,
      scheduled_access_cleared: cleared
    });

    return {
      action: 'activated',
      subscriberId: record?.id || null,
      plan,
      migration: migration.isMigration || false,
      scheduledAccessCleared: cleared,
      ...(migration.isMigration
        ? { migratedFrom: removePlans.join(', '), migratedTo: migration.targetPlan }
        : {})
    };
  }

  // Reembolso, chargeback, disputa, expiração, suspensão e atraso: corta agora.
  async function handleDeactivation({ decision, plan, context }) {
    const record = await db.deactivateSubscriberByEmail(context.email, {
      plan: sanitizeText(plan, 255)
    });

    if (record?.id) {
      await db.logWebhookAuthorization({
        subscriberId: record.id,
        action: 'revoked',
        platform: 'HOTMART',
        eventType: decision.eventType,
        status: decision.status,
        source: decision.actionSource
      });

      invalidate(record.id);
    }

    logger.info('webhook_hotmart_processed', {
      action: 'deactivation',
      email: context.email,
      plan: sanitizeText(plan, 255),
      subscriber_id: record?.id || null
    });

    return { action: 'deactivated', subscriberId: record?.id || null, plan };
  }

  // Regra 1: cancelamento de renovação NÃO corta. Grava até quando o plano
  // vale e deixa o job diário cortar depois da data.
  async function handleCancellation({ decision, plan, context, payload }) {
    const review = (reason, extra = {}) => {
      logger.warn('webhook_hotmart_cancellation_review', {
        reason,
        email: context.email,
        plan: sanitizeText(plan, 255),
        event_type: decision.eventType,
        status: decision.status,
        ...extra
      });

      return { action: 'cancellation_review', reason, plan, ...extra };
    };

    const subscriber = await db.getSubscriberByEmail(context.email);

    if (!subscriber) {
      return review('subscriber_not_found');
    }

    // Sem a data não dá para saber até quando o período pago vai: registra
    // para revisão e NÃO corta.
    const nextCharge = extractNextChargeDate(payload);

    if (!nextCharge.date) {
      return review('next_charge_missing', { subscriberId: subscriber.id });
    }

    const accessUntil = nextCharge.date.toISOString();

    const record = await db.setPlanAccessUntil({
      subscriberId: subscriber.id,
      plan,
      accessUntil: nextCharge.date,
      reason: CANCELLATION_REASON
    });

    // Sem a tabela (SQL manual ainda não rodou) o cancelamento só é
    // registrado. Ninguém é cortado.
    if (!record) {
      return review('plan_access_table_missing', {
        subscriberId: subscriber.id,
        accessUntil,
        accessUntilPath: nextCharge.path
      });
    }

    logger.info('webhook_hotmart_processed', {
      action: 'access_scheduled',
      email: context.email,
      plan: sanitizeText(plan, 255),
      subscriber_id: subscriber.id,
      access_until: accessUntil,
      access_until_path: nextCharge.path,
      event_type: decision.eventType,
      status: decision.status
    });

    return {
      action: 'access_scheduled',
      subscriberId: subscriber.id,
      plan,
      accessUntil,
      accessUntilPath: nextCharge.path
    };
  }

  // Troca nativa de plano da Hotmart (`SWITCH_PLAN`). Só a troca para um plano
  // VIP (pelo id do plano) de quem tem LITE no bot migra; o resto vai para
  // revisão e não muda nada — inclusive a troca para baixo, que por regra do
  // Davi não rebaixa sozinha.
  async function handleSwitchPlan({ decision, subscriberData, context }) {
    const review = (reason, extra = {}) => {
      logger.warn('webhook_hotmart_switch_plan_review', {
        reason,
        email: context.email,
        event_type: decision.eventType,
        status: decision.status,
        current_plan_id: subscriberData.currentPlanId || null,
        current_plan_name: sanitizeText(subscriberData.currentPlanName || '', 255),
        ...extra
      });

      return {
        action: 'switch_plan_review',
        reason,
        currentPlanId: subscriberData.currentPlanId || null,
        ...extra
      };
    };

    if (!subscriberData.currentPlanId) {
      return review('current_plan_missing');
    }

    const targetPlan = resolvePlanFromPlanId(subscriberData.currentPlanId, mapping);

    if (normalizeMatchKey(targetPlan) !== normalizeMatchKey(MIGRATION_TARGET_PLAN)) {
      return review('new_plan_not_vip', { resolvedPlan: targetPlan || null });
    }

    const subscriber = await db.getSubscriberByEmail(context.email);

    if (!subscriber) {
      return review('subscriber_not_found');
    }

    // Uma assinatura reembolsada que a Hotmart ainda mostra como ACTIVE não
    // volta por uma troca de plano.
    if (subscriber.status === 'inactive') {
      return review('subscriber_inactive', { subscriberId: subscriber.id });
    }

    const litePlans = findLitePlans(subscriber.plan);

    if (litePlans.length === 0) {
      return review('subscriber_without_lite', { subscriberId: subscriber.id });
    }

    // O payload de SWITCH_PLAN não traz nome nem telefone: preserva os que já
    // estão no banco para não sobrescrever com vazio.
    const record = await db.upsertSubscriberFromHotmart({
      name: context.rawName || subscriber.name,
      email: context.email,
      phone: context.phone || subscriber.phone,
      plan: targetPlan,
      status: 'active',
      removePlans: litePlans
    });

    invalidate(record?.id);

    const cleared = await clearScheduledAccess(record?.id || subscriber.id, [
      targetPlan,
      ...litePlans
    ]);

    if (record?.id) {
      await db.logWebhookAuthorization({
        subscriberId: record.id,
        action: 'authorized',
        platform: 'HOTMART',
        eventType: decision.eventType,
        status: decision.status,
        source: decision.actionSource
      });
    }

    logger.info('webhook_hotmart_processed', {
      action: 'switch_plan',
      email: context.email,
      plan: sanitizeText(targetPlan, 255),
      subscriber_id: record?.id || null,
      migration: true,
      migration_source: 'switch_plan',
      migrated_from: sanitizeText(litePlans.join(', '), 255),
      scheduled_access_cleared: cleared
    });

    return {
      action: 'activated',
      subscriberId: record?.id || null,
      plan: targetPlan,
      migration: true,
      migratedFrom: litePlans.join(', '),
      migratedTo: targetPlan,
      scheduledAccessCleared: cleared
    };
  }

  async function processHotmartEvent(payload) {
    const decision = decideHotmartAction(payload);

    logger.incrementWebhook('hotmart');
    metrics.increment('webhook_received');
    metrics.increment('webhook_hotmart');

    if (!decision.action) {
      logger.info('webhook_hotmart_ignored', {
        reason: decision.reason,
        event_type: decision.eventType,
        status: decision.status
      });

      return {
        ignored: true,
        action: null,
        reason: decision.reason,
        eventType: decision.eventType
      };
    }

    const subscriberData = extractSubscriberData(payload);
    const context = {
      email: sanitizeEmail(subscriberData.email),
      rawName: sanitizeText(subscriberData.name || '', 255),
      phone: sanitizeText(subscriberData.phone || '', 30)
    };
    context.name = context.rawName || context.email;

    if (!context.email) {
      const err = new Error('Email não encontrado no payload');
      err.statusCode = 400;
      throw err;
    }

    // SWITCH_PLAN não traz `data.product`: o plano vem de `data.plans[]`.
    if (decision.action === 'switch_plan') {
      return handleSwitchPlan({ decision, subscriberData, context });
    }

    const basePlan = resolvePlanFromMapping(mapping, subscriberData, defaultPlan);
    const migration = resolveMigration(subscriberData, basePlan, mapping);
    const plan = migration.isMigration ? migration.targetPlan : basePlan;

    if (!plan) {
      const err = new Error('Plano não configurado para o evento recebido');
      err.statusCode = 422;
      throw err;
    }

    if (decision.action === 'cancellation') {
      return handleCancellation({ decision, plan, context, payload });
    }

    if (decision.action === 'activation') {
      return handleActivation({ decision, plan, migration, context });
    }

    return handleDeactivation({ decision, plan, context });
  }

  return { processHotmartEvent };
}

module.exports = { createHotmartProcessor, CANCELLATION_REASON };
