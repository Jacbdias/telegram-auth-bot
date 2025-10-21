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

  const normalizeNumber = (value) => String(value || '').replace(/\D/g, '');

  // ✅ CORREÇÃO: Suporte para webhook v2.0 da Hotmart
  // Os campos checkout_phone_code e checkout_phone são usados no webhook v2.0
  if (source.checkout_phone || source.checkout_phone_code) {
    const code = normalizeNumber(source.checkout_phone_code);
    const number = normalizeNumber(source.checkout_phone);

    if (number) {
      return code ? `${code}${number}` : number;
    }
  }

  // ✅ NOVO: Alguns payloads trazem os campos fragmentados (country/area/number)
  const checkoutFragments = [
    normalizeNumber(source.checkout_phone_country_code || source.checkout_country_code),
    normalizeNumber(source.checkout_phone_area_code || source.checkout_area_code),
    normalizeNumber(source.checkout_phone_number || source.checkout_phone_local || source.checkout_phone_local_code),
    normalizeNumber(source.checkout_phone_local_number),
    normalizeNumber(source.checkout_phone)
  ].filter(Boolean);

  if (checkoutFragments.length > 0) {
    const number = checkoutFragments.join('');
    if (number) {
      return number;
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
      .map((value) => normalizeNumber(value));

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

  if (typeof source.whatsapp === 'string') {
    return source.whatsapp;
  }

  if (typeof source.whatsapp_number === 'string') {
    return source.whatsapp_number;
  }

  if (source.contact && typeof source.contact.phone === 'string') {
    return source.contact.phone;
  }

  return '';
}

function getFirstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function extractSubscriberData(payload = {}) {
  const data = payload.data || payload;
  const purchase = data.purchase || {};
  const subscription = data.subscription || {};
  const offer = data.offer || {};
  const product = data.product || {};

  const subscriberCandidates = [data.subscriber, subscription.subscriber].filter(Boolean);
  const buyerCandidates = [
    data.buyer,
    data.customer,
    purchase.buyer,
    purchase.customer,
    purchase.payer,
    subscription.buyer,
    subscription.customer
  ].filter(Boolean);

  const allContacts = [...subscriberCandidates, ...buyerCandidates];

  const contactWithEmail = allContacts.find((candidate) => normalizeString(candidate?.email));
  const fallbackContact = allContacts[0] || {};
  const contact = contactWithEmail || fallbackContact;

  const email = getFirstNonEmpty(
    contact?.email,
    ...subscriberCandidates.map((candidate) => candidate?.email),
    ...buyerCandidates.map((candidate) => candidate?.email),
    data.email,
    payload.email
  ).toLowerCase();

  const name = getFirstNonEmpty(
    contact?.name,
    contact?.full_name,
    ...allContacts.map((candidate) => candidate?.name),
    ...allContacts.map((candidate) => candidate?.full_name),
    data.full_name,
    data.name,
    product.name,
    subscription.plan?.name
  );

  const phone = getFirstNonEmpty(
    ...allContacts.map((candidate) => extractPhone(candidate)),
    extractPhone(data),
    extractPhone(payload)
  );

  const offerCode = getFirstNonEmpty(offer.code, offer.offer_code, offer.offer_code_hash, purchase.offer_code);
  const offerId = getFirstNonEmpty(offer.id, offer.offer_id);
  const productId = getFirstNonEmpty(product.id, product.product_id, purchase.product_id);
  const productName = getFirstNonEmpty(product.name, purchase.product_name, subscription.plan?.name);
  const planName = getFirstNonEmpty(data.plan, data.plan_name, offer.name, product.name, subscription.plan?.name);

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
