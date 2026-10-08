const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  verifyHotmartSignature,
  extractSubscriberData,
  resolvePlanFromMapping,
  resolveMigration,
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  CANCELLATION_EVENTS,
  SWITCH_PLAN_EVENTS,
  IGNORED_EVENTS,
  DEACTIVATION_STATUS_FALLBACK,
  decideHotmartAction,
  timingSafeHottokMatches,
  parseHotmartTimestamp,
  extractNextChargeDate,
  resolvePlanFromPlanId,
  findLitePlans,
  getEventType,
  MIGRATION_SOURCE_PLAN,
  MIGRATION_TARGET_PLAN
} = require('../web/hotmart-utils');

test('verifyHotmartSignature valida HMAC SHA256 do Hotmart', () => {
  const secret = 'segredo-teste';
  const body = Buffer.from(JSON.stringify({ exemplo: true }));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(verifyHotmartSignature(body, signature, secret), true);
  assert.equal(verifyHotmartSignature(body, 'assinatura-invalida', secret), false);
  assert.equal(verifyHotmartSignature(body, signature, ''), false);
});

test('extractSubscriberData captura campos básicos do payload', () => {
  const payload = {
    event: 'purchase.approved',
    data: {
      buyer: {
        name: 'Maria Compradora',
        email: 'MARIA@EMAIL.COM',
        phone: { country_code: '+55', area_code: '11', number: '91234-5678' }
      },
      offer: {
        code: 'OF123',
        name: 'Plano VIP'
      },
      product: {
        id: 999,
        name: 'Close Friends VIP'
      }
    }
  };

  const result = extractSubscriberData(payload);

  assert.equal(result.email, 'maria@email.com');
  assert.equal(result.name, 'Maria Compradora');
  assert.equal(result.phone.includes('5511'), true);
  assert.equal(result.offerCode, 'OF123');
  assert.equal(result.productId, '999');
  assert.equal(result.planName, 'Plano VIP');
});

test('extractSubscriberData usa telefone do purchase.customer quando subscriber não tem telefone', () => {
  const payload = {
    event: 'subscription.approved',
    data: {
      subscriber: {
        email: 'assinante@dominio.com',
        name: 'Assinante Hotmart'
      },
      subscription: {
        plan: { name: 'Plano Premium' },
        subscriber: {
          email: 'assinante@dominio.com',
          name: 'Assinante Hotmart'
        }
      },
      purchase: {
        customer: {
          checkout_phone_country_code: '+55',
          checkout_phone_area_code: '11',
          checkout_phone_number: '99876-5432'
        }
      }
    }
  };

  const result = extractSubscriberData(payload);

  assert.equal(result.email, 'assinante@dominio.com');
  assert.equal(result.name, 'Assinante Hotmart');
  assert.equal(result.planName, 'Plano Premium');
  assert.equal(result.phone, '5511998765432');
});

test('resolvePlanFromMapping prioriza código da oferta e fallback para padrão', () => {
  const mapping = {
    of123: 'vip',
    '999': 'premium'
  };

  const subscriber = {
    offerCode: 'OF123',
    productId: '999',
    planName: 'Plano Livre'
  };

  assert.equal(resolvePlanFromMapping(mapping, subscriber, 'basico'), 'vip');
  assert.equal(resolvePlanFromMapping(mapping, { productId: '999' }, 'basico'), 'premium');
  assert.equal(resolvePlanFromMapping(mapping, { planName: 'Outro Plano' }, 'basico'), 'Outro Plano');
  assert.equal(resolvePlanFromMapping(mapping, {}, 'basico'), 'basico');
});

test('resolvePlanFromMapping usa IDs dos produtos Close Friends sem precisar de env', () => {
  assert.equal(resolvePlanFromMapping({}, { productId: '5060349' }), 'CF VIP - FATOS DA BOLSA 1');
  assert.equal(resolvePlanFromMapping({}, { productId: '5060609' }), 'Close Friends LITE');
  assert.equal(resolvePlanFromMapping({}, { productId: '1650879' }), 'CF VIP - FATOS DA BOLSA 2');
  assert.equal(resolvePlanFromMapping({}, { productId: '1128762' }), 'CF VIP - FATOS DA BOLSA 3');
  assert.equal(resolvePlanFromMapping({}, { productName: 'CF VIP - FATOS DA BOLSA 3' }), 'CF VIP - FATOS DA BOLSA 3');
  assert.equal(resolvePlanFromMapping({}, { productId: '6568672' }), 'Mentoria Renda Turbinada');
  assert.equal(
    resolvePlanFromMapping({}, { productId: '1835417' }),
    'Do Zero Ao Avançado - Criptomoedas e NFTs'
  );
  assert.equal(resolvePlanFromMapping({}, { productId: '4218223' }), 'Projeto FIIS');
  assert.equal(resolvePlanFromMapping({}, { productId: '5325106' }), 'Projeto Trump');
});

test('resolvePlanFromMapping reconhece o Projeto Trump pelo nome do produto/plano', () => {
  assert.equal(resolvePlanFromMapping({}, { productName: 'Projeto Trump' }), 'Projeto Trump');
  assert.equal(resolvePlanFromMapping({}, { productName: 'PROJETO TRUMP' }), 'Projeto Trump');
  assert.equal(resolvePlanFromMapping({}, { planName: 'projeto trump' }), 'Projeto Trump');
  assert.equal(
    resolvePlanFromMapping({}, { productId: '5325106', planName: 'Close Friends LITE' }),
    'Projeto Trump'
  );
});

test('resolvePlanFromMapping prioriza ID do produto quando há fallback interno, mesmo com planName divergente', () => {
  const subscriber = {
    productId: '6558190', // Mentoria Renda Turbinada (fallback interno)
    planName: 'Close Friends LITE'
  };

  assert.equal(resolvePlanFromMapping({}, subscriber), 'Mentoria Renda Turbinada');
});

test('extractSubscriberData captura o nome da oferta (offerName)', () => {
  const payload = {
    event: 'purchase.approved',
    data: {
      buyer: { email: 'cliente@email.com', name: 'Cliente' },
      offer: { code: 'OF999', name: 'Migração VIP' },
      product: { id: 5060609, name: 'Close Friends LITE' }
    }
  };

  const result = extractSubscriberData(payload);

  assert.equal(result.offerName, 'Migração VIP');
  assert.equal(result.productName, 'Close Friends LITE');
});

test('resolveMigration detecta migração LITE -> VIP por várias formas no nome da oferta', () => {
  const variantes = [
    'Migração VIP',
    'migracao vip',
    'VIP',
    'Migração',
    'Troca de Plano',
    'Upgrade para VIP'
  ];

  for (const offerName of variantes) {
    const result = resolveMigration({ offerName }, MIGRATION_SOURCE_PLAN);
    assert.equal(result.isMigration, true, `deveria migrar para oferta "${offerName}"`);
    assert.equal(result.targetPlan, MIGRATION_TARGET_PLAN);
    assert.deepEqual(result.removePlans, [MIGRATION_SOURCE_PLAN]);
  }
});

test('resolveMigration ignora compra normal de LITE sem palavra-chave de migração', () => {
  const result = resolveMigration({ offerName: 'Plano Anual LITE' }, MIGRATION_SOURCE_PLAN);
  assert.equal(result.isMigration, false);
});

test('resolveMigration não dispara quando o produto base não é LITE', () => {
  // Mesmo com "vip" no nome da oferta, se o produto não é LITE não é migração.
  const result = resolveMigration({ offerName: 'Oferta VIP' }, 'Mentoria Renda Turbinada');
  assert.equal(result.isMigration, false);
});

test('listas de eventos incluem ativações e cancelamentos esperados', () => {
  assert.equal(ACTIVATION_EVENTS.has('purchase.approved'), true);
  assert.equal(ACTIVATION_EVENTS.has('subscription.renewed'), true);
  assert.equal(DEACTIVATION_EVENTS.has('purchase.canceled'), true);

  // MUDANÇA: o cancelamento de renovação saiu de DEACTIVATION_EVENTS (que
  // corta na hora) e virou CANCELLATION_EVENTS, que agenda o fim do acesso
  // para o fim do período já pago (regra 1 do Davi).
  assert.equal(DEACTIVATION_EVENTS.has('subscription.cancellation'), false);
  assert.equal(DEACTIVATION_EVENTS.has('subscription.cancelled'), false);
  assert.equal(CANCELLATION_EVENTS.has('subscription_cancellation'), true);
  assert.equal(CANCELLATION_EVENTS.has('subscription.cancelled'), true);

  // Reembolso, chargeback e disputa continuam cortando na hora.
  assert.equal(DEACTIVATION_EVENTS.has('purchase.refunded'), true);
  assert.equal(DEACTIVATION_EVENTS.has('purchase.chargeback'), true);
  assert.equal(DEACTIVATION_EVENTS.has('purchase.protest'), true);
  assert.equal(DEACTIVATION_EVENTS.has('subscription.expired'), true);
});

test('getEventType normaliza diferentes formatos de evento', () => {
  assert.equal(getEventType({ event: 'Purchase.Approved' }), 'purchase.approved');
  assert.equal(getEventType({ data: { event_name: 'SUBSCRIPTION.CANCELED' } }), 'subscription.canceled');
  assert.equal(getEventType({}), '');
});

// ─── Mapa por id do plano ─────────────────────────────────────────────────

test('o mapa por plano resolve todos os ids confirmados pelo Davi', () => {
  // Planos VIP vendidos dentro de outros produtos.
  const vip = [
    '830231', '494607', '773294', // produto 1874171
    '810167', // produto 3129181
    '853270', '773559', '706794', // produto 3671256
    '1263167', '1063182', '1381590', // produto 5060609
    '853268' // produto 3547657
  ];

  for (const planId of vip) {
    assert.equal(resolvePlanFromPlanId(planId), MIGRATION_TARGET_PLAN, `plano ${planId}`);
  }

  // Planos LITE_V2 vendidos dentro de outros produtos.
  assert.equal(resolvePlanFromPlanId('699092'), MIGRATION_SOURCE_PLAN);
  assert.equal(resolvePlanFromPlanId('687186'), MIGRATION_SOURCE_PLAN);

  // Plano sem exceção não resolve por aqui.
  assert.equal(resolvePlanFromPlanId('1263162'), null);
  assert.equal(resolvePlanFromPlanId(''), null);
  assert.equal(resolvePlanFromPlanId(null), null);
});

test('o mapa por plano vem ANTES do mapa por produto', () => {
  // Produto 5060609 é LITE; o plano 1263167 dentro dele é VIP.
  assert.equal(
    resolvePlanFromMapping({}, { productId: '5060609', planId: '1263167' }),
    MIGRATION_TARGET_PLAN
  );

  // Sem o id do plano, decide o produto — como antes.
  assert.equal(resolvePlanFromMapping({}, { productId: '5060609' }), MIGRATION_SOURCE_PLAN);

  // Plano do mesmo produto sem exceção também cai no produto.
  assert.equal(
    resolvePlanFromMapping({}, { productId: '5060609', planId: '1263162' }),
    MIGRATION_SOURCE_PLAN
  );
});

test('o mapa por plano vem ANTES do código da oferta', () => {
  const mapping = { 'of-lite': MIGRATION_SOURCE_PLAN };

  assert.equal(
    resolvePlanFromMapping(mapping, {
      offerCode: 'of-lite',
      productId: '5060609',
      planId: '1263167'
    }),
    MIGRATION_TARGET_PLAN
  );
});

test('HOTMART_PLAN_MAP pode sobrescrever um id de plano da lista interna', () => {
  const mapping = { '1263167': 'Plano Especial' };

  assert.equal(
    resolvePlanFromMapping(mapping, { productId: '5060609', planId: '1263167' }),
    'Plano Especial'
  );
});

test('resolveMigration detecta a migração pelo id do plano, sem palavra na oferta', () => {
  const result = resolveMigration(
    { productId: '5060609', planId: '1263167', offerName: 'Renovação Anual' },
    MIGRATION_TARGET_PLAN
  );

  assert.equal(result.isMigration, true);
  assert.equal(result.source, 'plan_id');
  assert.equal(result.targetPlan, MIGRATION_TARGET_PLAN);
  assert.deepEqual(result.removePlans, [MIGRATION_SOURCE_PLAN]);
});

test('plano VIP em produto que NÃO é LITE resolve VIP mas não substitui plano', () => {
  // Plano 853268 no produto 3547657 (Projeto Renda Passiva).
  const subscriberData = { productId: '3547657', planId: '853268' };

  assert.equal(resolvePlanFromMapping({}, subscriberData), MIGRATION_TARGET_PLAN);
  assert.equal(resolveMigration(subscriberData, MIGRATION_TARGET_PLAN).isMigration, false);
});

test('findLitePlans acha os planos LITE gravados no banco', () => {
  assert.deepEqual(
    findLitePlans('Close Friends LITE, Mentoria Renda Turbinada'),
    ['Close Friends LITE']
  );
  assert.deepEqual(findLitePlans('CF VIP - FATOS DA BOLSA 3'), []);
  assert.deepEqual(findLitePlans(''), []);
});

// ─── Decisão do evento ────────────────────────────────────────────────────

test('decideHotmartAction: o status nunca ativa', () => {
  // SWITCH_PLAN e UPDATE_SUBSCRIPTION_CHARGE_DATE chegam com status ACTIVE.
  assert.equal(
    decideHotmartAction({ event: 'SWITCH_PLAN', data: { subscription: { status: 'ACTIVE' } } }).action,
    'switch_plan'
  );

  const ignored = decideHotmartAction({
    event: 'UPDATE_SUBSCRIPTION_CHARGE_DATE',
    data: { subscription: { status: 'ACTIVE' } }
  });
  assert.equal(ignored.action, null);
  assert.equal(ignored.reason, 'event_ignored');

  // Evento desconhecido com status de ativação NÃO ativa mais.
  const unknown = decideHotmartAction({
    event: 'EVENTO_NOVO_DA_HOTMART',
    data: { purchase: { status: 'APPROVED' } }
  });
  assert.equal(unknown.action, null);
  assert.equal(unknown.reason, 'event_unknown');

  // Payload sem evento algum também não ativa.
  assert.equal(decideHotmartAction({ data: { purchase: { status: 'ACTIVE' } } }).action, null);
});

test('decideHotmartAction: cancelamento agenda, reembolso corta', () => {
  assert.equal(
    decideHotmartAction({ event: 'SUBSCRIPTION_CANCELLATION', data: {} }).action,
    'cancellation'
  );
  assert.equal(
    decideHotmartAction({ event: 'PURCHASE_REFUNDED', data: {} }).action,
    'deactivation'
  );
  assert.equal(
    decideHotmartAction({ event: 'PURCHASE_CHARGEBACK', data: {} }).action,
    'deactivation'
  );
  assert.equal(
    decideHotmartAction({ event: 'PURCHASE_APPROVED', data: {} }).action,
    'activation'
  );
});

test('decideHotmartAction: o status só desativa em delayed e overdue', () => {
  assert.deepEqual([...DEACTIVATION_STATUS_FALLBACK].sort(), ['delayed', 'overdue']);

  for (const status of ['delayed', 'overdue']) {
    const decision = decideHotmartAction({
      event: 'EVENTO_DESCONHECIDO',
      data: { purchase: { status } }
    });
    assert.equal(decision.action, 'deactivation');
    assert.equal(decision.actionSource, 'status');
  }

  // Um status de cancelamento num evento desconhecido NÃO corta mais: o
  // cancelamento de renovação não pode cortar na hora.
  for (const status of ['canceled', 'cancelled', 'refunded', 'expired']) {
    const decision = decideHotmartAction({
      event: 'EVENTO_DESCONHECIDO',
      data: { purchase: { status } }
    });
    assert.equal(decision.action, null, `status ${status} não deveria decidir sozinho`);
  }
});

test('as listas de eventos novos não se sobrepõem às antigas', () => {
  for (const event of CANCELLATION_EVENTS) {
    assert.equal(DEACTIVATION_EVENTS.has(event), false, `${event} em DEACTIVATION_EVENTS`);
    assert.equal(ACTIVATION_EVENTS.has(event), false, `${event} em ACTIVATION_EVENTS`);
  }

  for (const event of SWITCH_PLAN_EVENTS) {
    assert.equal(ACTIVATION_EVENTS.has(event), false);
    assert.equal(DEACTIVATION_EVENTS.has(event), false);
  }

  for (const event of IGNORED_EVENTS) {
    assert.equal(ACTIVATION_EVENTS.has(event), false);
    assert.equal(DEACTIVATION_EVENTS.has(event), false);
  }
});

// ─── Datas ────────────────────────────────────────────────────────────────

test('parseHotmartTimestamp aceita epoch em ms, em segundos, string e ISO', () => {
  const ms = Date.UTC(2027, 9, 6, 12, 0, 0);

  assert.equal(parseHotmartTimestamp(ms).toISOString(), new Date(ms).toISOString());
  assert.equal(parseHotmartTimestamp(String(ms)).toISOString(), new Date(ms).toISOString());
  assert.equal(
    parseHotmartTimestamp(Math.floor(ms / 1000)).toISOString(),
    new Date(ms).toISOString()
  );
  assert.equal(
    parseHotmartTimestamp('2027-10-06T12:00:00.000Z').toISOString(),
    new Date(ms).toISOString()
  );

  assert.equal(parseHotmartTimestamp(null), null);
  assert.equal(parseHotmartTimestamp(''), null);
  assert.equal(parseHotmartTimestamp('nao-e-data'), null);
  assert.equal(parseHotmartTimestamp({}), null);
});

test('extractNextChargeDate lê data.date_next_charge no cancelamento', () => {
  const ms = Date.UTC(2027, 9, 6, 12, 0, 0);

  const cancelamento = extractNextChargeDate({ data: { date_next_charge: ms } });
  assert.equal(cancelamento.path, 'data.date_next_charge');
  assert.equal(cancelamento.date.toISOString(), new Date(ms).toISOString());

  // Reserva: o caminho da compra.
  const compra = extractNextChargeDate({ data: { purchase: { date_next_charge: ms } } });
  assert.equal(compra.path, 'data.purchase.date_next_charge');

  // Reserva: o caminho do evento de dia de cobrança.
  const assinatura = extractNextChargeDate({ data: { subscription: { date_next_charge: ms } } });
  assert.equal(assinatura.path, 'data.subscription.date_next_charge');

  // Sem data.
  assert.equal(extractNextChargeDate({ data: {} }).date, null);
  assert.equal(extractNextChargeDate({}).date, null);
});

// ─── Hottok ───────────────────────────────────────────────────────────────

test('timingSafeHottokMatches aceita o hottok certo e recusa o errado', () => {
  assert.equal(timingSafeHottokMatches('token-secreto', 'token-secreto'), true);
  assert.equal(timingSafeHottokMatches('token-errado', 'token-secreto'), false);

  // Tamanhos diferentes não estouram (o SHA-256 tem sempre o mesmo tamanho).
  assert.equal(timingSafeHottokMatches('t', 'token-secreto'), false);
  assert.equal(timingSafeHottokMatches('token-secreto-muito-mais-longo', 'token-secreto'), false);

  // Vazio nunca passa.
  assert.equal(timingSafeHottokMatches('', 'token-secreto'), false);
  assert.equal(timingSafeHottokMatches('token-secreto', ''), false);
  assert.equal(timingSafeHottokMatches(undefined, undefined), false);

  // Espaços em volta são aparados, como no portal.
  assert.equal(timingSafeHottokMatches('  token-secreto  ', 'token-secreto'), true);
});

test('extractSubscriberData lê plan.id e o plano current de plans[]', () => {
  const comPlanId = extractSubscriberData({
    event: 'PURCHASE_APPROVED',
    data: {
      buyer: { email: 'a@b.com' },
      product: { id: 5060609 },
      subscription: { plan: { id: 1263167, name: 'Close Friends VIP' } }
    }
  });

  assert.equal(comPlanId.planId, '1263167');
  assert.equal(comPlanId.productId, '5060609');

  const troca = extractSubscriberData({
    event: 'SWITCH_PLAN',
    data: {
      subscriber: { email: 'a@b.com' },
      plans: [
        { id: 1263162, name: 'LITE 2026', current: false },
        { id: 1263167, name: 'Close Friends VIP', current: true }
      ]
    }
  });

  assert.equal(troca.currentPlanId, '1263167');
  assert.equal(troca.currentPlanName, 'Close Friends VIP');
  // SWITCH_PLAN não traz data.product.
  assert.equal(troca.productId, '');
});
