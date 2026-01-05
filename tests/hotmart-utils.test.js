const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  verifyHotmartSignature,
  extractSubscriberData,
  resolvePlanFromMapping,
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  getEventType
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

test('resolvePlanFromMapping prioriza ID do produto quando há fallback interno, mesmo com planName divergente', () => {
  const subscriber = {
    productId: '6558190', // Mentoria Renda Turbinada (fallback interno)
    planName: 'Close Friends LITE'
  };

  assert.equal(resolvePlanFromMapping({}, subscriber), 'Mentoria Renda Turbinada');
});

test('listas de eventos incluem ativações e cancelamentos esperados', () => {
  assert.equal(ACTIVATION_EVENTS.has('purchase.approved'), true);
  assert.equal(ACTIVATION_EVENTS.has('subscription.renewed'), true);
  assert.equal(DEACTIVATION_EVENTS.has('purchase.canceled'), true);
  assert.equal(DEACTIVATION_EVENTS.has('subscription.cancelled'), true);
});

test('getEventType normaliza diferentes formatos de evento', () => {
  assert.equal(getEventType({ event: 'Purchase.Approved' }), 'purchase.approved');
  assert.equal(getEventType({ data: { event_name: 'SUBSCRIPTION.CANCELED' } }), 'subscription.canceled');
  assert.equal(getEventType({}), '');
});
