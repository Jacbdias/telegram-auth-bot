const test = require('node:test');
const assert = require('node:assert/strict');

const { createHotmartProcessor } = require('../web/hotmart-processor');
const { runPlanAccessExpiryJob } = require('../web/plan-access-job');
const {
  createFakeDb,
  createFakeDbWithoutPlanAccessTable,
  createSilentLogger,
  silentMetrics,
  noopCache
} = require('./helpers/fake-db');

const LITE = 'Close Friends LITE';
const VIP3 = 'CF VIP - FATOS DA BOLSA 3';
const MENTORIA = 'Mentoria Renda Turbinada';

// Produto LITE 2.0 e o plano VIP vendido dentro dele (exceção confirmada).
const PRODUTO_LITE = 5060609;
const PLANO_VIP_NO_LITE = 1263167;
const PLANO_LITE_NORMAL = 1263162;

// 06/10/2027 12:00 UTC em epoch ms, como a Hotmart manda.
const PROXIMA_COBRANCA_MS = Date.UTC(2027, 9, 6, 12, 0, 0);

function makeProcessor(db, overrides = {}) {
  const logger = overrides.logger || createSilentLogger();

  const { processHotmartEvent } = createHotmartProcessor({
    db,
    cache: noopCache,
    logger,
    metrics: silentMetrics,
    planMapping: '',
    defaultPlan: null,
    ...overrides
  });

  return { processHotmartEvent, logger };
}

function purchaseApproved({ email, productId = PRODUTO_LITE, planId, offerName, nextCharge } = {}) {
  return {
    id: 'evt-approved',
    event: 'PURCHASE_APPROVED',
    version: '2.0.0',
    data: {
      product: { id: productId, name: LITE },
      buyer: { email, name: 'Cliente Teste', checkout_phone: '11999990000' },
      purchase: {
        transaction: 'HP-1',
        status: 'APPROVED',
        ...(nextCharge ? { date_next_charge: nextCharge } : {}),
        offer: { code: 'of-1', ...(offerName ? { name: offerName } : {}) }
      },
      subscription: {
        status: 'ACTIVE',
        subscriber: { code: 'SUB1', email },
        ...(planId ? { plan: { id: planId, name: 'Plano' } } : {})
      }
    }
  };
}

// Cancelamento de renovação. O caminho real da data é `data.date_next_charge`
// (confirmado no mapa de caminhos do portal, src/lib/hotmart-payload-paths.ts).
function subscriptionCancellation({ email, nextCharge = PROXIMA_COBRANCA_MS, productId = PRODUTO_LITE } = {}) {
  return {
    id: 'evt-cancel',
    event: 'SUBSCRIPTION_CANCELLATION',
    version: '2.0.0',
    data: {
      product: { id: productId, name: LITE },
      subscriber: { code: 'SUB1', email },
      subscription: { status: 'CANCELLED_BY_CUSTOMER' },
      ...(nextCharge === null ? {} : { date_next_charge: nextCharge }),
      cancellation_date: Date.UTC(2026, 9, 8)
    }
  };
}

function switchPlan({ email, newPlanId, oldPlanId = PLANO_LITE_NORMAL }) {
  // A troca nativa manda o plano novo em `data.plans[]` com `current: true` e
  // NÃO manda `data.product`.
  return {
    id: 'evt-switch',
    event: 'SWITCH_PLAN',
    version: '2.0.0',
    data: {
      subscription: { status: 'ACTIVE', subscriber: { code: 'SUB1', email } },
      subscriber: { code: 'SUB1', email },
      plans: [
        { id: oldPlanId, name: 'Close Friends LITE 2026', current: false },
        { id: newPlanId, name: 'Close Friends VIP', current: true }
      ],
      switch_plan_date: Date.UTC(2026, 9, 8)
    }
  };
}

function updateChargeDate({ email }) {
  return {
    id: 'evt-charge-date',
    event: 'UPDATE_SUBSCRIPTION_CHARGE_DATE',
    version: '2.0.0',
    data: {
      subscriber: { code: 'SUB1', email },
      subscription: { status: 'ACTIVE' },
      old_charge_day: 5,
      new_charge_day: 15,
      date_next_charge: PROXIMA_COBRANCA_MS
    }
  };
}

function refunded({ email, productId = PRODUTO_LITE, event = 'PURCHASE_REFUNDED' }) {
  return {
    id: 'evt-refund',
    event,
    version: '2.0.0',
    data: {
      product: { id: productId, name: LITE },
      buyer: { email, name: 'Cliente Teste' },
      purchase: { transaction: 'HP-1', status: 'REFUNDED' },
      // Caso real: a Hotmart continua mostrando a assinatura como ACTIVE.
      subscription: { status: 'ACTIVE', subscriber: { code: 'SUB1', email } }
    }
  };
}

// ─── Cancelamento de renovação (regra 1) ──────────────────────────────────

test('SUBSCRIPTION_CANCELLATION grava access_until e NÃO corta ninguém', async () => {
  const email = 'cancelou@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent } = makeProcessor(db);

  const result = await processHotmartEvent(subscriptionCancellation({ email }));

  assert.equal(result.action, 'access_scheduled');
  assert.equal(result.plan, LITE);
  assert.equal(result.accessUntil, new Date(PROXIMA_COBRANCA_MS).toISOString());
  // O caminho real da data no cancelamento.
  assert.equal(result.accessUntilPath, 'data.date_next_charge');

  // Nada foi cortado e os planos continuam intactos.
  assert.deepEqual(db.state.revocations, []);
  assert.equal(db.state.subscribers[0].plan, `${LITE}, ${MENTORIA}`);
  assert.equal(db.state.subscribers[0].status, 'active');

  assert.equal(db.state.planAccess.length, 1);
  assert.equal(db.state.planAccess[0].plan, LITE);
  assert.equal(db.state.planAccess[0].reason, 'subscription_cancellation');
});

test('cancelamento aceita a data em ISO, não só em milissegundos', async () => {
  const email = 'cancelou-iso@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: LITE }] });
  const { processHotmartEvent } = makeProcessor(db);

  const result = await processHotmartEvent(
    subscriptionCancellation({ email, nextCharge: '2027-10-06T12:00:00.000Z' })
  );

  assert.equal(result.action, 'access_scheduled');
  assert.equal(result.accessUntil, new Date(PROXIMA_COBRANCA_MS).toISOString());
  assert.deepEqual(db.state.revocations, []);
});

test('cancelamento SEM data não corta: vai para revisão', async () => {
  const email = 'sem-data@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent, logger } = makeProcessor(db);

  const result = await processHotmartEvent(subscriptionCancellation({ email, nextCharge: null }));

  assert.equal(result.action, 'cancellation_review');
  assert.equal(result.reason, 'next_charge_missing');

  assert.deepEqual(db.state.revocations, []);
  assert.equal(db.state.planAccess.length, 0);
  assert.equal(db.state.subscribers[0].plan, `${LITE}, ${MENTORIA}`);
  assert.equal(logger.find('webhook_hotmart_cancellation_review').length, 1);
});

test('cancelamento SEM a tabela não corta e não quebra', async () => {
  const email = 'sem-tabela@email.com';
  const db = createFakeDbWithoutPlanAccessTable({
    subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }]
  });
  const { processHotmartEvent, logger } = makeProcessor(db);

  const result = await processHotmartEvent(subscriptionCancellation({ email }));

  assert.equal(result.action, 'cancellation_review');
  assert.equal(result.reason, 'plan_access_table_missing');
  // A data foi lida mesmo sem a tabela, e aparece no log para revisão.
  assert.equal(result.accessUntil, new Date(PROXIMA_COBRANCA_MS).toISOString());

  assert.deepEqual(db.state.revocations, []);
  assert.equal(db.state.subscribers[0].plan, `${LITE}, ${MENTORIA}`);
  assert.equal(db.state.subscribers[0].status, 'active');
  assert.equal(logger.find('webhook_hotmart_cancellation_review').length, 1);
});

test('uma nova PURCHASE_APPROVED apaga o access_until daquele plano', async () => {
  const email = 'voltou@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: LITE }] });
  const { processHotmartEvent } = makeProcessor(db);

  await processHotmartEvent(subscriptionCancellation({ email }));
  assert.equal(db.state.planAccess.length, 1);

  const result = await processHotmartEvent(purchaseApproved({ email }));

  assert.equal(result.action, 'activated');
  assert.equal(result.plan, LITE);
  assert.equal(result.scheduledAccessCleared, 1);
  assert.equal(db.state.planAccess.length, 0);
});

// ─── Job diário ───────────────────────────────────────────────────────────

test('o job corta SÓ aquele plano depois da data e mantém os outros', async () => {
  const email = 'venceu@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent } = makeProcessor(db);
  const logger = createSilentLogger();

  await processHotmartEvent(subscriptionCancellation({ email }));

  // Antes da data: nada acontece.
  const antes = await runPlanAccessExpiryJob({
    db,
    logger,
    now: new Date(PROXIMA_COBRANCA_MS - 1000)
  });

  assert.equal(antes.checked, 0);
  assert.equal(antes.revoked, 0);
  assert.deepEqual(db.state.revocations, []);
  assert.equal(db.state.subscribers[0].plan, `${LITE}, ${MENTORIA}`);

  // Depois da data: corta só o LITE.
  const depois = await runPlanAccessExpiryJob({
    db,
    logger,
    now: new Date(PROXIMA_COBRANCA_MS + 1000)
  });

  assert.equal(depois.checked, 1);
  assert.equal(depois.revoked, 1);
  assert.deepEqual(depois.failures, []);

  // Revogação por plano: só o LITE, e o Mentoria continua valendo.
  assert.equal(db.state.revocations.length, 1);
  assert.equal(db.state.revocations[0].revokedPlans, LITE);
  assert.equal(db.state.revocations[0].full, false);
  assert.equal(db.state.subscribers[0].plan, MENTORIA);
  assert.equal(db.state.subscribers[0].status, 'active');

  // A linha vencida sai da tabela: o job não repete a remoção.
  assert.equal(db.state.planAccess.length, 0);

  const novamente = await runPlanAccessExpiryJob({
    db,
    logger,
    now: new Date(PROXIMA_COBRANCA_MS + 2000)
  });
  assert.equal(novamente.revoked, 0);
  assert.equal(db.state.revocations.length, 1);
});

test('o job não faz nada (e não quebra) sem a tabela', async () => {
  const db = createFakeDbWithoutPlanAccessTable({
    subscribers: [{ email: 'x@email.com', plan: LITE }]
  });
  const logger = createSilentLogger();

  const summary = await runPlanAccessExpiryJob({ db, logger, now: new Date() });

  assert.equal(summary.checked, 0);
  assert.equal(summary.revoked, 0);
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(db.state.revocations, []);
});

test('o job mantém a linha quando a remoção falha, para tentar de novo', async () => {
  const email = 'falhou@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent } = makeProcessor(db);
  const logger = createSilentLogger();

  await processHotmartEvent(subscriptionCancellation({ email }));

  db.deactivateSubscriberByEmail = async () => {
    throw new Error('telegram fora do ar');
  };

  const summary = await runPlanAccessExpiryJob({
    db,
    logger,
    now: new Date(PROXIMA_COBRANCA_MS + 1000)
  });

  assert.equal(summary.revoked, 0);
  assert.equal(summary.failures.length, 1);
  assert.equal(db.state.planAccess.length, 1);
});

// ─── Reembolso, chargeback e disputa cortam na hora (regra 2) ─────────────

for (const event of ['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_PROTEST']) {
  test(`${event} continua cortando na hora, mesmo com status ACTIVE`, async () => {
    const email = 'reembolsou@email.com';
    const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
    const { processHotmartEvent } = makeProcessor(db);

    const result = await processHotmartEvent(refunded({ email, event }));

    assert.equal(result.action, 'deactivated');
    assert.equal(result.plan, LITE);
    assert.equal(db.state.revocations.length, 1);
    assert.equal(db.state.revocations[0].revokedPlans, LITE);
    // As outras assinaturas continuam.
    assert.equal(db.state.subscribers[0].plan, MENTORIA);
    assert.equal(db.state.planAccess.length, 0);
  });
}

test('atraso (status delayed/overdue) continua cortando na hora', async () => {
  for (const status of ['DELAYED', 'OVERDUE']) {
    const email = 'atrasou@email.com';
    const db = createFakeDb({ subscribers: [{ email, plan: LITE }] });
    const { processHotmartEvent } = makeProcessor(db);

    const result = await processHotmartEvent({
      event: 'EVENTO_DESCONHECIDO',
      data: {
        product: { id: PRODUTO_LITE, name: LITE },
        buyer: { email },
        purchase: { status }
      }
    });

    assert.equal(result.action, 'deactivated', `status ${status} deveria cortar`);
    assert.equal(db.state.revocations.length, 1);
  }
});

// ─── O status não ativa mais ninguém ─────────────────────────────────────

test('SWITCH_PLAN e UPDATE_SUBSCRIPTION_CHARGE_DATE com status ACTIVE não ativam ninguém', async () => {
  const email = 'novo@email.com';

  // SWITCH_PLAN de quem não está no bot: não cria assinante.
  const db1 = createFakeDb();
  const r1 = await makeProcessor(db1).processHotmartEvent(
    switchPlan({ email, newPlanId: PLANO_VIP_NO_LITE })
  );
  assert.equal(r1.action, 'switch_plan_review');
  assert.equal(r1.reason, 'subscriber_not_found');
  assert.equal(db1.state.subscribers.length, 0);

  // UPDATE_SUBSCRIPTION_CHARGE_DATE é ignorado: 202 e registro.
  const db2 = createFakeDb();
  const { processHotmartEvent, logger } = makeProcessor(db2);
  const r2 = await processHotmartEvent(updateChargeDate({ email }));

  assert.equal(r2.ignored, true);
  assert.equal(r2.action, null);
  assert.equal(r2.reason, 'event_ignored');
  assert.equal(db2.state.subscribers.length, 0);
  assert.equal(logger.find('webhook_hotmart_ignored').length, 1);
});

test('um reembolsado não é reativado por SWITCH_PLAN nem por UPDATE_SUBSCRIPTION_CHARGE_DATE', async () => {
  const email = 'reembolsado@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent } = makeProcessor(db);

  // Reembolso cortou o LITE.
  await processHotmartEvent(refunded({ email }));
  assert.equal(db.state.subscribers[0].plan, MENTORIA);

  // A Hotmart ainda mostra a assinatura como ACTIVE e manda estes eventos.
  const switchResult = await processHotmartEvent(
    switchPlan({ email, newPlanId: PLANO_VIP_NO_LITE })
  );
  assert.equal(switchResult.action, 'switch_plan_review');
  assert.equal(switchResult.reason, 'subscriber_without_lite');

  const chargeResult = await processHotmartEvent(updateChargeDate({ email }));
  assert.equal(chargeResult.ignored, true);

  // O LITE não voltou.
  assert.equal(db.state.subscribers[0].plan, MENTORIA);
});

test('um assinante inativo não é reativado por SWITCH_PLAN', async () => {
  const email = 'inativo@email.com';
  const db = createFakeDb({
    subscribers: [{ email, plan: LITE, status: 'inactive' }]
  });
  const { processHotmartEvent } = makeProcessor(db);

  const result = await processHotmartEvent(switchPlan({ email, newPlanId: PLANO_VIP_NO_LITE }));

  assert.equal(result.action, 'switch_plan_review');
  assert.equal(result.reason, 'subscriber_inactive');
  assert.equal(db.state.subscribers[0].plan, LITE);
  assert.equal(db.state.subscribers[0].status, 'inactive');
});

// ─── Troca de plano pelo id do plano (regra 4) ────────────────────────────

test('SWITCH_PLAN para plano VIP migra: troca o LITE pelo VIP e preserva os outros', async () => {
  const email = 'migrou@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}`, name: 'Nome Real', phone: '11988887777' }] });
  const { processHotmartEvent } = makeProcessor(db);

  const result = await processHotmartEvent(switchPlan({ email, newPlanId: PLANO_VIP_NO_LITE }));

  assert.equal(result.action, 'activated');
  assert.equal(result.migration, true);
  assert.equal(result.plan, VIP3);
  assert.equal(result.migratedFrom, LITE);

  assert.equal(db.state.subscribers[0].plan, `${MENTORIA}, ${VIP3}`);
  assert.equal(db.state.subscribers[0].status, 'active');
  // O payload de SWITCH_PLAN não traz nome nem telefone: os do banco ficam.
  assert.equal(db.state.subscribers[0].name, 'Nome Real');
  assert.equal(db.state.subscribers[0].phone, '11988887777');
});

test('SWITCH_PLAN para outro plano vai para revisão e não muda nada', async () => {
  const email = 'trocou@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${VIP3}, ${MENTORIA}` }] });
  const { processHotmartEvent, logger } = makeProcessor(db);

  // Troca para o plano LITE normal do produto (rebaixamento): NÃO rebaixa.
  const result = await processHotmartEvent(
    switchPlan({ email, newPlanId: PLANO_LITE_NORMAL, oldPlanId: PLANO_VIP_NO_LITE })
  );

  assert.equal(result.action, 'switch_plan_review');
  assert.equal(result.reason, 'new_plan_not_vip');
  assert.equal(db.state.subscribers[0].plan, `${VIP3}, ${MENTORIA}`);
  assert.deepEqual(db.state.revocations, []);
  assert.equal(logger.find('webhook_hotmart_switch_plan_review').length, 1);
});

test('PURCHASE_APPROVED do plano 1263167 no produto 5060609 vira VIP 3 e substitui o LITE', async () => {
  const email = 'comprou-vip@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent } = makeProcessor(db);

  const result = await processHotmartEvent(
    purchaseApproved({ email, productId: PRODUTO_LITE, planId: PLANO_VIP_NO_LITE })
  );

  assert.equal(result.action, 'activated');
  assert.equal(result.plan, VIP3);
  assert.equal(result.migration, true);
  assert.equal(db.state.subscribers[0].plan, `${MENTORIA}, ${VIP3}`);
});

test('a busca por palavra no nome da oferta continua funcionando sem o id do plano', async () => {
  const email = 'migracao-por-nome@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: `${LITE}, ${MENTORIA}` }] });
  const { processHotmartEvent } = makeProcessor(db);

  // Sem `plan.id` no payload: só o nome da oferta indica a migração.
  const result = await processHotmartEvent(
    purchaseApproved({ email, productId: PRODUTO_LITE, offerName: 'Migração VIP' })
  );

  assert.equal(result.action, 'activated');
  assert.equal(result.plan, VIP3);
  assert.equal(result.migration, true);
  assert.equal(db.state.subscribers[0].plan, `${MENTORIA}, ${VIP3}`);
});

test('compra normal de LITE continua LITE', async () => {
  const email = 'lite@email.com';
  const db = createFakeDb();
  const { processHotmartEvent } = makeProcessor(db);

  const result = await processHotmartEvent(
    purchaseApproved({ email, productId: PRODUTO_LITE, planId: PLANO_LITE_NORMAL })
  );

  assert.equal(result.action, 'activated');
  assert.equal(result.plan, LITE);
  assert.equal(result.migration, false);
});

test('payload sem email devolve erro 400', async () => {
  const db = createFakeDb();
  const { processHotmartEvent } = makeProcessor(db);

  await assert.rejects(
    () => processHotmartEvent(purchaseApproved({ email: '' })),
    (error) => error.statusCode === 400
  );
});
