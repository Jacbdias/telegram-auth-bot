const crypto = require('crypto');

// Mapeamentos internos para planos conhecidos que precisam funcionar
// mesmo que o HOTMART_PLAN_MAP não esteja atualizado em produção.
const BUILTIN_PLAN_MAPPING = new Map([
  // Mentoria Renda Turbinada
  ['6558190', 'Mentoria Renda Turbinada'],
  ['renda turbinada', 'Mentoria Renda Turbinada'],
  ['mentoria renda turbinada', 'Mentoria Renda Turbinada'],

  // Close Friends LITE
  ['5060609', 'Close Friends LITE'],
  ['3129181', 'Close Friends LITE'],
  ['1874171', 'Close Friends LITE'],
  ['3671256', 'Close Friends LITE'],
  ['close friends lite', 'Close Friends LITE'],

  // CF VIP - FATOS DA BOLSA 1
  ['5060349', 'CF VIP - FATOS DA BOLSA 1'],

  // CF VIP - FATOS DA BOLSA 2
  ['1650879', 'CF VIP - FATOS DA BOLSA 2'],
  ['3670772', 'CF VIP - FATOS DA BOLSA 2'],

  // CF VIP - FATOS DA BOLSA 3
  ['1128762', 'CF VIP - FATOS DA BOLSA 3'],
  ['1762716', 'CF VIP - FATOS DA BOLSA 3'],
  ['2163067', 'CF VIP - FATOS DA BOLSA 3'],
  ['2947386', 'CF VIP - FATOS DA BOLSA 3'],
  ['cf vip - fatos da bolsa 3', 'CF VIP - FATOS DA BOLSA 3'],

  // Projeto Renda Passiva
  ['3547657', 'Projeto Renda Passiva'],
  ['projeto renda passiva', 'Projeto Renda Passiva']
]);

// Suporte para webhook v1.0 (com ponto) e v2.0 (com underline)
const ACTIVATION_EVENTS = new Set([
  'purchase.approved',
  'purchase_approved',
  'purchase.completed',
  'purchase_completed',
  'purchase.complete',      // ← ADICIONAR
  'purchase_complete',      // ← ADICIONAR
  'purchase.finished',
  'purchase_finished',
  'subscription.approved',
  'subscription_approved',
  'subscription.renewed',
  'subscription_renewed',
  'subscription.reactivated',
  'subscription_reactivated'
]);

const DEACTIVATION_EVENTS = new Set([
  'purchase.canceled',
  'purchase_canceled',
  'purchase.cancelled',
  'purchase_cancelled',
  'purchase.chargeback',
  'purchase_chargeback',
  'purchase.refunded',
  'purchase_refunded',
  'purchase.protest',
  'purchase_protest',
  'purchase.dispute',
  'purchase_dispute',
  'subscription.canceled',
  'subscription_canceled',
  'subscription.cancelled',
  'subscription_cancelled',
  'subscription.cancellation',    // ← ADICIONAR
  'subscription_cancellation',    // ← ADICIONAR
  'subscription.deactivated',
  'subscription_deactivated',
  'subscription.expired',
  'subscription_expired',
  'subscription.suspended',
  'subscription_suspended'
]);

const ACTIVATION_STATUSES = new Set([
  'approved',
  'completed',
  'finished',
  'active',
  'paid',
  'up_to_date',
  'authorized',
  'current',
  'available'
]);

const DEACTIVATION_STATUSES = new Set([
  'refunded',
  'refund_requested',
  'refund_in_process',
  'refund_in_progress',
  'refund_in_analysis',
  'refund_pending',
  'refused',
  'chargeback',
  'chargeback_refunded',
  'chargeback_pending',
  'chargeback_in_process',
  'waiting_chargeback',
  'dispute',         
  'disputed',
  'protest',              
  'canceled',
  'cancelled',
  'expired',
  'suspended',
  'blocked',
  'overdue',
  'delayed',
  'inactive',
  'unpaid'
]);

function normalizeString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function verifyHotmartSignature(rawBody, signature, secret) {
  if (!secret) {
    return false;
  }

  const providedSignature = normalizeString(signature);

  if (!providedSignature) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedSignature = hmac.digest('base64');

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(providedSignature);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function extractPhone(source = {}) {
  if (!source) {
    return '';
  }

  // ✅ CORREÇÃO: Suporte para webhook v2.0 da Hotmart
  // IMPORTANTE: O Hotmart às vezes envia o número JÁ com o DDD incluído em checkout_phone
  if (
    source.checkout_phone ||
    source.checkout_phone_code ||
    source.checkout_phone_number ||
    source.checkout_phone_country_code ||
    source.checkout_phone_area_code
  ) {
    const country = String(source.checkout_phone_country_code || '').replace(/\D/g, '');
    const area = String(source.checkout_phone_area_code || '').replace(/\D/g, '');
    const code = String(source.checkout_phone_code || country).replace(/\D/g, '');
    const number = String(source.checkout_phone || source.checkout_phone_number || '').replace(/\D/g, '');

    if (number) {
      const shouldPrependArea =
        area && !number.startsWith(area) && !(country && number.startsWith(country));
      const combinedNumber = shouldPrependArea ? `${area}${number}` : number;

      // ⚠️ CORREÇÃO: Verificar se o número já começa com o código
      // Exemplo: code="67", number="67992998920" -> número já tem o DDD!
      if (code && combinedNumber.startsWith(code)) {
        // Número já tem o DDD, retorna só o número
        return combinedNumber;
      } else if (code) {
        // Número não tem o DDD, concatena
        return `${code}${combinedNumber}`;
      } else {
        // Não tem código, retorna só o número
        return combinedNumber;
      }
    }

    const combined = [country || code, area, number].filter(Boolean).join('');

    if (combined) {
      return combined;
    }
  }

  // Código original para outros formatos (webhook v1.0 e outras variações)
  if (typeof source.phone === 'string') {
    return source.phone;
  }

  if (source.phone && typeof source.phone === 'object') {
    if (typeof source.phone.full_number === 'string') {
      return source.phone.full_number;
    }

    const parts = [source.phone.country_code, source.phone.area_code, source.phone.number, source.phone.phone_number]
      .filter(Boolean)
      .map((value) => String(value).replace(/\D/g, ''));

    if (parts.length > 0) {
      return parts.join('');
    }
  }

  if (typeof source.phone_number === 'string') {
    return source.phone_number;
  }

  if (typeof source.cellphone === 'string') {
    return source.cellphone;
  }

  if (typeof source.mobile === 'string') {
    return source.mobile;
  }

  if (source.contact && typeof source.contact.phone === 'string') {
    return source.contact.phone;
  }

  return '';
}

function extractSubscriberData(payload = {}) {
  const data = payload.data || payload;
  const purchase = data.purchase || {};
  const subscriber = data.subscriber || {};
  const buyer = data.buyer || data.customer || {};
  const offer = data.offer || {};
  const product = data.product || {};

  const contact = subscriber.email ? subscriber : buyer;

  const email = normalizeString(contact.email || buyer.email || subscriber.email || data.email || payload.email).toLowerCase();
  const name = normalizeString(
    contact.name ||
      contact.full_name ||
      buyer.name ||
      subscriber.name ||
      data.full_name ||
      data.name ||
      product.name ||
      ''
  );

  const phoneCandidates = [
    extractPhone(contact),
    extractPhone(buyer),
    extractPhone(subscriber),
    extractPhone(purchase.customer),
    extractPhone(purchase),
    extractPhone(data)
  ];

  const phone = normalizeString(phoneCandidates.find((value) => normalizeString(value)) || '');

  const offerCode = normalizeString(offer.code || offer.offer_code || offer.offer_code_hash || purchase.offer_code);
  const offerId = normalizeString(offer.id || offer.offer_id);
  const productId = normalizeString(product.id || product.product_id || purchase.product_id);
  const productName = normalizeString(product.name || purchase.product_name);
  const planCandidates = [
    data.plan,
    data.plan_name,
    offer.name,
    product.name,
    purchase.plan?.name,
    purchase.plan_name,
    purchase.plan?.plan_name,
    data.subscription?.plan?.name,
    data.subscription?.plan_name,
    data.subscription?.plan?.plan_name
  ];

  const planName = planCandidates
    .map((value) => normalizeString(value))
    .find((value) => value) || '';

  return {
    email,
    name,
    phone,
    offerCode,
    offerId,
    productId,
    productName,
    planName
  };
}

function normalizePlanMapping(input) {
  if (!input) {
    return {};
  }

  let rawMapping = input;

  if (typeof input === 'string') {
    try {
      rawMapping = JSON.parse(input);
    } catch (error) {
      console.error('HOTMART_PLAN_MAP inválido. Informe um JSON válido.');
      return {};
    }
  }

  if (typeof rawMapping !== 'object' || rawMapping === null) {
    return {};
  }

  const normalized = {};

  for (const [key, value] of Object.entries(rawMapping)) {
    const normalizedKey = normalizeString(key).toLowerCase();

    if (!normalizedKey) {
      continue;
    }

    const normalizedValue = normalizeString(value);

    if (!normalizedValue) {
      continue;
    }

    normalized[normalizedKey] = normalizedValue;
  }

  return normalized;
}

function resolvePlanFromMapping(mappingInput, subscriberData = {}, defaultPlan = null) {
  const mapping = normalizePlanMapping(mappingInput);

  const getPlanForKey = (rawKey) => {
    const key = normalizeString(rawKey).toLowerCase();

    if (!key) {
      return null;
    }

    if (mapping[key]) {
      return mapping[key];
    }

    if (BUILTIN_PLAN_MAPPING.has(key)) {
      return BUILTIN_PLAN_MAPPING.get(key);
    }

    return null;
  };

  const offerKeys = [subscriberData.offerCode, subscriberData.offerId];

  for (const rawKey of offerKeys) {
    const plan = getPlanForKey(rawKey);

    if (plan) {
      return plan;
    }
  }

  const productKeys = [subscriberData.productId, subscriberData.productName];

  for (const rawKey of productKeys) {
    const plan = getPlanForKey(rawKey);

    if (plan) {
      return plan;
    }
  }

  if (subscriberData.planName) {
    const planNameMapping = getPlanForKey(subscriberData.planName);

    if (planNameMapping) {
      return planNameMapping;
    }

    return subscriberData.planName;
  }

  return defaultPlan;
}

function getEventType(payload = {}) {
  const event =
    payload.event ||
    payload.event_name ||
    (payload.data && (payload.data.event || payload.data.event_name));

  return normalizeString(event).toLowerCase();
}

function getStatusFromPayload(payload = {}) {
  const candidates = [
    payload.status,
    payload.status_name,
    payload.data?.status,
    payload.data?.status_name,
    payload.data?.sale_status,
    payload.data?.subscriber?.status,
    payload.data?.subscriber?.status_name,
    payload.data?.purchase?.status,
    payload.data?.purchase?.status_name,
    payload.data?.purchase?.sale_status,
    payload.data?.purchase?.purchase_status,
    payload.data?.purchase?.original_status,
    payload.data?.subscription?.status,
    payload.data?.subscription?.status_name
  ];

  for (const rawValue of candidates) {
    const normalized = normalizeString(rawValue).toLowerCase();

    if (normalized) {
      return normalized;
    }
  }

  return '';
}

module.exports = {
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  ACTIVATION_STATUSES,
  DEACTIVATION_STATUSES,
  verifyHotmartSignature,
  extractSubscriberData,
  resolvePlanFromMapping,
  normalizePlanMapping,
  getEventType,
  getStatusFromPayload
};
