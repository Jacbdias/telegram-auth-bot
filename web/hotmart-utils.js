const crypto = require('crypto');

// Suporte para webhook v1.0 (com ponto) e v2.0 (com underline)
const ACTIVATION_EVENTS = new Set([
  'purchase.approved',
  'purchase_approved',
  'purchase.completed',
  'purchase_completed',
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
  'subscription.canceled',
  'subscription_canceled',
  'subscription.cancelled',
  'subscription_cancelled',
  'subscription.deactivated',
  'subscription_deactivated',
  'subscription.expired',
  'subscription_expired',
  'subscription.suspended',
  'subscription_suspended'
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
  if (source.checkout_phone || source.checkout_phone_code) {
    const code = String(source.checkout_phone_code || '').replace(/\D/g, '');
    const number = String(source.checkout_phone || '').replace(/\D/g, '');
    
    if (number) {
      // ⚠️ CORREÇÃO: Verificar se o número já começa com o código
      // Exemplo: code="67", number="67992998920" -> número já tem o DDD!
      if (code && number.startsWith(code)) {
        // Número já tem o DDD, retorna só o número
        return number;
      } else if (code) {
        // Número não tem o DDD, concatena
        return `${code}${number}`;
      } else {
        // Não tem código, retorna só o número
        return number;
      }
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

  const phone = normalizeString(
    extractPhone(contact) || extractPhone(buyer) || extractPhone(subscriber) || extractPhone(data)
  );

  const offerCode = normalizeString(offer.code || offer.offer_code || offer.offer_code_hash || purchase.offer_code);
  const offerId = normalizeString(offer.id || offer.offer_id);
  const productId = normalizeString(product.id || product.product_id || purchase.product_id);
  const productName = normalizeString(product.name || purchase.product_name);
  const planName = normalizeString(data.plan || data.plan_name || offer.name || product.name);

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

  const keysToTry = [
    subscriberData.offerCode,
    subscriberData.offerId,
    subscriberData.productId,
    subscriberData.productName,
    subscriberData.planName
  ];

  for (const rawKey of keysToTry) {
    const key = normalizeString(rawKey).toLowerCase();

    if (key && mapping[key]) {
      return mapping[key];
    }
  }

  if (subscriberData.planName) {
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

module.exports = {
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  verifyHotmartSignature,
  extractSubscriberData,
  resolvePlanFromMapping,
  normalizePlanMapping,
  getEventType
};
