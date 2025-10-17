const express = require('express');
const db = require('./database');
const {
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  verifyHotmartSignature,
  extractSubscriberData,
  resolvePlanFromMapping,
  getEventType
} = require('./hotmart-utils');

const router = express.Router();

const WEBHOOK_SECRET = process.env.HOTMART_WEBHOOK_SECRET || '';
const PLAN_MAPPING = process.env.HOTMART_PLAN_MAP || '';
const DEFAULT_PLAN = process.env.HOTMART_DEFAULT_PLAN || process.env.DEFAULT_PLAN || null;

router.use(express.raw({ type: '*/*', limit: '2mb' }));

router.post('/', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const signature = req.get('X-Hotmart-Hmac-SHA256') || req.get('X-Hotmart-Hmac-Sha256');

  if (!verifyHotmartSignature(rawBody, signature, WEBHOOK_SECRET)) {
    return res.status(401).json({ success: false, message: 'Assinatura inválida' });
  }

  let payload;

  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    console.error('Erro ao analisar payload do Hotmart:', error);
    return res.status(400).json({ success: false, message: 'JSON inválido' });
  }

  const eventType = getEventType(payload);

  if (!eventType) {
    return res.status(202).json({ success: true, message: 'Evento ignorado: tipo ausente' });
  }

  if (!ACTIVATION_EVENTS.has(eventType) && !DEACTIVATION_EVENTS.has(eventType)) {
    return res.status(202).json({ success: true, message: `Evento ignorado: ${eventType}` });
  }

  const subscriberData = extractSubscriberData(payload);

  if (!subscriberData.email) {
    return res.status(400).json({ success: false, message: 'Email não encontrado no payload' });
  }

  const plan = resolvePlanFromMapping(PLAN_MAPPING, subscriberData, DEFAULT_PLAN);

  if (!plan) {
    return res.status(422).json({ success: false, message: 'Plano não configurado para o evento recebido' });
  }

  try {
    if (ACTIVATION_EVENTS.has(eventType)) {
      const record = await db.upsertSubscriberFromHotmart({
        name: subscriberData.name || subscriberData.email,
        email: subscriberData.email,
        phone: subscriberData.phone,
        plan,
        status: 'active'
      });

      return res.json({ success: true, action: 'activated', subscriberId: record?.id || null, plan });
    }

    if (DEACTIVATION_EVENTS.has(eventType)) {
      const record = await db.deactivateSubscriberByEmail(subscriberData.email);
      return res.json({ success: true, action: 'deactivated', subscriberId: record?.id || null, plan });
    }
  } catch (error) {
    console.error('Erro ao processar evento do Hotmart:', error);
    return res.status(500).json({ success: false, message: 'Erro interno ao processar evento' });
  }

  return res.status(202).json({ success: true, message: `Evento ignorado: ${eventType}` });
});

module.exports = router;
