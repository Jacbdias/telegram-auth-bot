const crypto = require('crypto');

// Mapeamentos internos para planos conhecidos que precisam funcionar
// mesmo que o HOTMART_PLAN_MAP não esteja atualizado em produção.
const BUILTIN_PLAN_MAPPING = new Map([
  // Mentoria Renda Turbinada
  ['6558190', 'Mentoria Renda Turbinada'],
  ['6568672', 'Mentoria Renda Turbinada'],
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
  ['projeto renda passiva', 'Projeto Renda Passiva'],

  // Do Zero Ao Avançado - Criptomoedas e NFTs
  ['1835417', 'Do Zero Ao Avançado - Criptomoedas e NFTs'],
  ['do zero ao avançado - criptomoedas e nfts', 'Do Zero Ao Avançado - Criptomoedas e NFTs'],

  // Projeto FIIS
  ['4218223', 'Projeto FIIS'],
  ['projeto fiis', 'Projeto FIIS'],

  // Projeto Trump
  ['5325106', 'Projeto Trump'],
  ['projeto trump', 'Projeto Trump']
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
  'subscription.deactivated',
  'subscription_deactivated',
  'subscription.expired',
  'subscription_expired',
  'subscription.suspended',
  'subscription_suspended'
]);

// Cancelamento de renovação. NÃO corta na hora (regra 1 do Davi): o acesso
// vai até o fim do período já pago. O webhook grava `access_until` para o
// plano daquela assinatura e o job diário é que remove o plano quando a data
// passa. Antes deste PR estes eventos estavam em DEACTIVATION_EVENTS e
// cortavam no mesmo dia.
//
// Todas as grafias da MESMA regra de negócio entram aqui — o evento v2.0 é
// `SUBSCRIPTION_CANCELLATION`, e as variações `subscription.canceled` /
// `subscription_cancelled` (webhook v1.0) descrevem o mesmo cancelamento de
// renovação. Deixá-las em DEACTIVATION_EVENTS manteria o corte imediato para
// quem usa o formato antigo, contrariando a regra 1.
const CANCELLATION_EVENTS = new Set([
  'subscription.cancellation',
  'subscription_cancellation',
  'subscription.canceled',
  'subscription_canceled',
  'subscription.cancelled',
  'subscription_cancelled'
]);

// Troca nativa de plano da Hotmart. O plano novo vem em `data.plans[]` com
// `current: true` e o payload NÃO traz `data.product`. Só a troca para um
// plano VIP (pelo mapa de planos) de quem tem LITE no bot faz migração; o
// resto é registrado para revisão e não muda nada.
const SWITCH_PLAN_EVENTS = new Set([
  'switch_plan',
  'switch.plan'
]);

// Eventos que o bot responde 202 e apenas registra. A mudança de dia de
// cobrança não altera acesso nenhum — e, como chega com
// `subscription.status = ACTIVE`, antes deste PR ela ATIVAVA pelo status.
const IGNORED_EVENTS = new Set([
  'update_subscription_charge_date',
  'update.subscription.charge.date'
]);

// ⚠️ NÃO é mais usado para decidir ativação. A ativação acontece só por evento
// explícito (ACTIVATION_EVENTS). O status ficou aqui apenas como referência
// histórica: `SWITCH_PLAN` e `UPDATE_SUBSCRIPTION_CHARGE_DATE` chegam com
// `subscription.status = ACTIVE`, e uma assinatura reembolsada que a Hotmart
// continua mostrando como ACTIVE era reativada por eles.
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

// Único uso do status para DECIDIR: atraso de pagamento (regra 3 do Davi —
// corta no dia seguinte à data em que a renovação deveria ter sido paga, sem
// tolerância). A lista é deliberadamente curta.
//
// Por que é seguro: este fallback só roda depois de IGNORED_EVENTS,
// CANCELLATION_EVENTS, SWITCH_PLAN_EVENTS, ACTIVATION_EVENTS e
// DEACTIVATION_EVENTS, ou seja, só para evento desconhecido/ausente. Os dois
// eventos que chegam com status ACTIVE (`SWITCH_PLAN` e
// `UPDATE_SUBSCRIPTION_CHARGE_DATE`) têm tratamento próprio antes daqui, e
// `delayed`/`overdue` não aparecem neles. O cancelamento de renovação chega
// com status de cancelamento, que NÃO está nesta lista — por isso ele deixa de
// cortar na hora mesmo quando o evento vem sem nome reconhecido.
const DEACTIVATION_STATUS_FALLBACK = new Set(['delayed', 'overdue']);

function normalizeString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

// Normaliza texto para comparação: remove acentos, espaços extras e caixa.
// Usado para casar nomes de oferta ("Migração VIP") contra palavras-chave.
function normalizeMatchKey(value) {
  return normalizeString(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Plano de origem (LITE) e destino (VIP) da migração, configuráveis por env.
const MIGRATION_SOURCE_PLAN = normalizeString(process.env.HOTMART_MIGRATION_SOURCE_PLAN) || 'Close Friends LITE';
const MIGRATION_TARGET_PLAN = normalizeString(process.env.HOTMART_MIGRATION_TARGET_PLAN) || 'CF VIP - FATOS DA BOLSA 3';

// Palavras-chave (já normalizadas) que, no nome da oferta de um produto LITE,
// indicam uma migração/upgrade para o VIP. Configurável via
// HOTMART_MIGRATION_KEYWORDS (lista separada por vírgula).
const DEFAULT_MIGRATION_KEYWORDS = [
  'migracao vip',
  'migracao',
  'troca de plano',
  'troca de plano vip',
  'troca',
  'mudanca de plano',
  'upgrade',
  'vip'
];

const MIGRATION_KEYWORDS = (() => {
  const custom = normalizeString(process.env.HOTMART_MIGRATION_KEYWORDS);
  const source = custom
    ? custom.split(',').map((item) => normalizeMatchKey(item)).filter(Boolean)
    : DEFAULT_MIGRATION_KEYWORDS;

  return [...new Set(source)];
})();

// ─── Mapa por PLANO da Hotmart ────────────────────────────────────────────
//
// Cada produto da Hotmart tem vários PLANOS, e alguns produtos LITE vendem
// planos VIP dentro (planos de migração antigos e a troca de plano nativa da
// Hotmart, que só funciona dentro do mesmo produto). Decidir pelo NOME da
// oferta erra nesses casos; o id do plano não erra.
//
// Esta é a lista confirmada pelo Davi um por um, a mesma de
// `HOTMART_PLAN_EXCEPTIONS` no portal (src/lib/hotmart-product-map.ts).
// Chave: `plan.id` do payload. O produto entre parênteses é só para leitura —
// a decisão é pelo plano, qualquer que seja o produto.
const BUILTIN_PLAN_ID_MAPPING = new Map([
  // Produto 1874171 (LITE)
  ['830231', MIGRATION_TARGET_PLAN], // Migração - Close Friends VIP 997
  ['494607', MIGRATION_TARGET_PLAN], // Close Friends VIP - 2023
  ['773294', MIGRATION_TARGET_PLAN], // Migração - Close Friends VIP

  // Produto 3129181 (LITE)
  ['810167', MIGRATION_TARGET_PLAN], // Migração - Close Friends VIP
  ['699092', MIGRATION_SOURCE_PLAN], // Migração - Renda Passiva (LITE_V2)

  // Produto 3671256 (LITE)
  ['853270', MIGRATION_TARGET_PLAN], // Migração - Close Friends VIP 997
  ['773559', MIGRATION_TARGET_PLAN], // Migração - Close Friends VIP
  ['706794', MIGRATION_TARGET_PLAN], // Close Friends VIP

  // Produto 5060609 (LITE)
  ['1263167', MIGRATION_TARGET_PLAN], // Close Friends VIP
  ['1063182', MIGRATION_TARGET_PLAN], // Close Friends VIP - Migração
  ['1381590', MIGRATION_TARGET_PLAN], // Migração Plano VIP

  // Produto 3547657 (Projeto Renda Passiva)
  ['853268', MIGRATION_TARGET_PLAN], // Migração - Plano VIP 997
  ['687186', MIGRATION_SOURCE_PLAN] // Migração - Close Friends LITE (LITE_V2)
]);

// Plano do bot para um `plan.id` da Hotmart, ou null quando o plano não tem
// exceção. Só consulta o mapa por PLANO — nunca o mapa por produto — para que
// um id de plano não case por acidente com um id de produto.
function resolvePlanFromPlanId(planId, mapping = {}) {
  const key = normalizeString(planId).toLowerCase();

  if (!key) {
    return null;
  }

  // Uma entrada explícita do HOTMART_PLAN_MAP para este id de plano ganha da
  // lista interna, para o Davi poder corrigir em produção sem deploy.
  if (mapping && mapping[key]) {
    return mapping[key];
  }

  return BUILTIN_PLAN_ID_MAPPING.get(key) || null;
}

function isLitePlan(plan) {
  const key = normalizeMatchKey(plan);
  return !!key && (key.includes('lite') || key === normalizeMatchKey(MIGRATION_SOURCE_PLAN));
}

// Quebra "Plano A, Plano B" em lista de planos, como o banco guarda.
function splitPlanList(plan) {
  if (Array.isArray(plan)) {
    return [...new Set(plan.map((item) => normalizeString(item)).filter(Boolean))];
  }

  return [
    ...new Set(
      normalizeString(plan)
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

// Planos LITE presentes numa lista de planos (os valores exatos gravados no
// banco, para poder removê-los na migração).
function findLitePlans(plan) {
  return splitPlanList(plan).filter((item) => isLitePlan(item));
}

function migrationResult(source, removePlans = [MIGRATION_SOURCE_PLAN]) {
  return {
    isMigration: true,
    source,
    sourcePlan: MIGRATION_SOURCE_PLAN,
    targetPlan: MIGRATION_TARGET_PLAN,
    removePlans
  };
}

// Migração detectada pelo ID DO PLANO: o plano vendido é VIP pelo mapa, mas o
// PRODUTO é LITE. É o caso dos planos VIP vendidos dentro de produtos LITE
// (tabela confirmada pelo Davi). Vale tanto para `PURCHASE_APPROVED` desses
// planos quanto para a troca de plano.
//
// Um plano VIP dentro de um produto que NÃO é LITE (ex.: plano 853268 no
// produto 3547657, Projeto Renda Passiva) resolve para VIP pelo mapa de
// planos, mas não remove nada: só a migração LITE -> VIP substitui plano.
function resolvePlanIdMigration(subscriberData = {}, mapping = {}) {
  const planFromPlanId =
    resolvePlanFromPlanId(subscriberData.planId, mapping) ||
    resolvePlanFromPlanId(subscriberData.currentPlanId, mapping);

  if (normalizeMatchKey(planFromPlanId) !== normalizeMatchKey(MIGRATION_TARGET_PLAN)) {
    return null;
  }

  const productKey = normalizeString(subscriberData.productId).toLowerCase();
  const productPlan = productKey ? BUILTIN_PLAN_MAPPING.get(productKey) : null;

  if (!isLitePlan(productPlan)) {
    return null;
  }

  return migrationResult('plan_id');
}

// Detecta se o evento representa uma migração LITE -> VIP.
//
// Duas formas, nesta ordem:
//   1. pelo ID do plano (`resolvePlanIdMigration`) — a regra confirmada;
//   2. pelo NOME da oferta — RESERVA, para payloads sem `plan.id`. A migração
//      acontece "dentro" do plano LITE: o produto continua LITE, mas a OFERTA
//      carrega um nome de migração/upgrade.
function resolveMigration(subscriberData = {}, basePlan = null, mapping = {}) {
  const byPlanId = resolvePlanIdMigration(subscriberData, mapping);

  if (byPlanId) {
    return byPlanId;
  }

  if (!isLitePlan(basePlan)) {
    return { isMigration: false };
  }

  const haystacks = [subscriberData.offerName, subscriberData.planName]
    .map((value) => normalizeMatchKey(value))
    .filter(Boolean);

  const matched = haystacks.some((text) =>
    MIGRATION_KEYWORDS.some((keyword) => keyword && text.includes(keyword))
  );

  if (!matched) {
    return { isMigration: false };
  }

  return migrationResult('offer_name');
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

// Lista de planos da troca nativa (`SWITCH_PLAN`): `data.plans[]` ou
// `data.subscription.plans[]`. O plano novo é o que tem `current: true`.
function extractPlans(data = {}) {
  const candidates = [data.plans, data.subscription?.plans];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }

  return [];
}

function extractSubscriberData(payload = {}) {
  const data = payload.data || payload;
  const purchase = data.purchase || {};
  const subscriber = data.subscriber || {};
  const buyer = data.buyer || data.customer || {};
  const offer = data.offer || {};
  const product = data.product || {};
  const plans = extractPlans(data);
  const currentPlan = plans.find((item) => item && item.current === true) || null;

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
  const offerName = normalizeString(offer.name || offer.offer_name || purchase.offer?.name || purchase.offer_name);
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

  // `plan.id` da Hotmart. Mesmos caminhos que o portal usa
  // (src/lib/hotmart-payload-paths.ts: `planId`).
  const planId = normalizeString(data.subscription?.plan?.id || data.plan?.id);

  return {
    email,
    name,
    phone,
    offerCode,
    offerId,
    offerName,
    productId,
    productName,
    planName,
    planId,
    plans,
    currentPlanId: normalizeString(currentPlan?.id),
    currentPlanName: normalizeString(currentPlan?.name)
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

  // 1º o mapa por PLANO: um plano VIP vendido dentro de um produto LITE tem de
  // resolver para VIP, e isso só o id do plano diz. Vem antes do mapa por
  // oferta/produto de propósito.
  const planFromPlanId =
    resolvePlanFromPlanId(subscriberData.planId, mapping) ||
    resolvePlanFromPlanId(subscriberData.currentPlanId, mapping);

  if (planFromPlanId) {
    return planFromPlanId;
  }

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

// ─── Datas ────────────────────────────────────────────────────────────────

// Abaixo disso, um epoch numérico está em segundos (1e11 s é o ano 5138;
// 1e11 ms é 1973, antes de qualquer evento da Hotmart).
const EPOCH_SECONDS_LIMIT = 1e11;

// Datas da Hotmart chegam em epoch ms (número ou string de dígitos) ou ISO.
// Epoch em segundos também é aceito. Mesma regra do portal
// (parseHotmartTimestamp em src/lib/hotmart-webhook-events.ts).
function parseHotmartTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    return null;
  }

  const asNumber =
    typeof value === 'number'
      ? value
      : /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : null;

  const parsed =
    asNumber !== null
      ? new Date(asNumber < EPOCH_SECONDS_LIMIT ? asNumber * 1000 : asNumber)
      : new Date(String(value));

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Data da próxima cobrança. No CANCELAMENTO o caminho real é
// `data.date_next_charge` — confirmado no mapa de caminhos do portal
// (src/lib/hotmart-payload-paths.ts, campo `nextCharge`, comentado
// "cancelamento"). Os outros caminhos entram como reserva: `data.purchase.*`
// é o da compra (confirmado nos logs de produção do portal) e
// `data.subscription.*` o do evento de dia de cobrança.
//
// Devolve também QUAL caminho casou, para o log dizer de onde veio a data.
const NEXT_CHARGE_PATHS = [
  'data.date_next_charge',
  'data.purchase.date_next_charge',
  'data.subscription.date_next_charge'
];

function readPath(root, path) {
  let current = root;

  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function extractNextChargeDate(payload = {}) {
  for (const path of NEXT_CHARGE_PATHS) {
    const raw = readPath(payload, path);
    const parsed = parseHotmartTimestamp(raw);

    if (parsed) {
      return { date: parsed, path, raw };
    }
  }

  return { date: null, path: null, raw: null };
}

// ─── Hottok ───────────────────────────────────────────────────────────────

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

// Compara o hottok em tempo constante. Usa o SHA-256 dos dois lados para o
// tempo não depender do conteúdo NEM do tamanho — mesma ideia de
// `timingSafeSecretMatches` (web/internal-routes.js) e de `computeHottokMatch`
// no portal. Antes deste PR a comparação era `!==`.
function timingSafeHottokMatches(providedHottok, expectedHottok) {
  const provided = normalizeString(providedHottok);
  const expected = normalizeString(expectedHottok);

  if (!provided || !expected) {
    return false;
  }

  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

// ─── Decisão do evento ────────────────────────────────────────────────────

// O que fazer com um payload. A ORDEM é a regra:
//
//   1. IGNORED_EVENTS        -> 202, só registra
//   2. CANCELLATION_EVENTS   -> agenda o fim do acesso (não corta)
//   3. SWITCH_PLAN_EVENTS    -> migração LITE->VIP ou revisão
//   4. ACTIVATION_EVENTS     -> ativa
//   5. DEACTIVATION_EVENTS   -> corta na hora (reembolso, chargeback, disputa)
//   6. status delayed/overdue -> corta na hora (regra 3)
//
// O status NUNCA ativa: a ativação só acontece por evento explícito.
function decideHotmartAction(payload = {}) {
  const eventType = getEventType(payload);
  const status = getStatusFromPayload(payload);
  const base = { eventType, status };

  if (eventType && IGNORED_EVENTS.has(eventType)) {
    return { ...base, action: null, ignored: true, reason: 'event_ignored' };
  }

  if (eventType && CANCELLATION_EVENTS.has(eventType)) {
    return { ...base, action: 'cancellation', actionSource: 'event' };
  }

  if (eventType && SWITCH_PLAN_EVENTS.has(eventType)) {
    return { ...base, action: 'switch_plan', actionSource: 'event' };
  }

  if (eventType && ACTIVATION_EVENTS.has(eventType)) {
    return { ...base, action: 'activation', actionSource: 'event' };
  }

  if (eventType && DEACTIVATION_EVENTS.has(eventType)) {
    return { ...base, action: 'deactivation', actionSource: 'event' };
  }

  if (status && DEACTIVATION_STATUS_FALLBACK.has(status)) {
    return { ...base, action: 'deactivation', actionSource: 'status' };
  }

  return {
    ...base,
    action: null,
    ignored: true,
    reason: eventType ? 'event_unknown' : 'event_missing'
  };
}

module.exports = {
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  CANCELLATION_EVENTS,
  SWITCH_PLAN_EVENTS,
  IGNORED_EVENTS,
  ACTIVATION_STATUSES,
  DEACTIVATION_STATUSES,
  DEACTIVATION_STATUS_FALLBACK,
  decideHotmartAction,
  verifyHotmartSignature,
  timingSafeHottokMatches,
  parseHotmartTimestamp,
  extractNextChargeDate,
  extractSubscriberData,
  resolvePlanFromMapping,
  resolvePlanFromPlanId,
  resolveMigration,
  resolvePlanIdMigration,
  isLitePlan,
  splitPlanList,
  findLitePlans,
  normalizePlanMapping,
  normalizeMatchKey,
  getEventType,
  getStatusFromPayload,
  MIGRATION_SOURCE_PLAN,
  MIGRATION_TARGET_PLAN,
  MIGRATION_KEYWORDS,
  BUILTIN_PLAN_ID_MAPPING
};
