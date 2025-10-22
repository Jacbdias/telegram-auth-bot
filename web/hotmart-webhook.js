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
  
  // CORREÇÃO: Aceitar tanto HMAC quanto Hottok
  const signature = req.get('X-Hotmart-Hmac-SHA256') || 
                    req.get('X-Hotmart-Hmac-Sha256') ||
                    req.get('X-Hotmart-Hottok');
  
  // CORREÇÃO: Se for Hottok (webhook v2.0.0), fazer validação simples
  const hottok = req.get('X-Hotmart-Hottok');
  if (hottok) {
    // Validação simples: comparar o Hottok recebido com o configurado
    if (hottok !== WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: 'Hottok inválido' });
    }
  } else {
    // Validação HMAC (webhook v1.0)
    if (!verifyHotmartSignature(rawBody, signature, WEBHOOK_SECRET)) {
      return res.status(401).json({ success: false, message: 'Assinatura inválida' });
    }
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    console.error('Erro ao analisar payload do Hotmart:', error);
    return res.status(400).json({ success: false, message: 'JSON inválido' });
  }

  // 🔍 DEBUG 1: Payload completo
  console.log('=== DEBUG HOTMART WEBHOOK ===');
  console.log('📥 Payload completo:', JSON.stringify(payload, null, 2));

  const eventType = getEventType(payload);
  
  // 🔍 DEBUG 2: Tipo de evento
  console.log('📌 Event Type:', eventType);

  if (!eventType) {
    return res.status(202).json({ success: true, message: 'Evento ignorado: tipo ausente' });
  }
  if (!ACTIVATION_EVENTS.has(eventType) && !DEACTIVATION_EVENTS.has(eventType)) {
    return res.status(202).json({ success: true, message: `Evento ignorado: ${eventType}` });
  }

  // 🔍 DEBUG 3: Dados do buyer ANTES da extração
  console.log('🔎 Buyer do payload:', JSON.stringify(payload.data?.buyer, null, 2));

  const subscriberData = extractSubscriberData(payload);

  // 🔍 DEBUG: Ver campos de telefone do buyer
console.log('🔎 CAMPOS DE TELEFONE DO BUYER:');
console.log('  checkout_phone_code:', payload.data?.buyer?.checkout_phone_code);
console.log('  checkout_phone:', payload.data?.buyer?.checkout_phone);

// 🔍 DEBUG 4: Dados extraídos (este log já existe)
console.log('👤 Dados extraídos:', JSON.stringify(subscriberData, null, 2));

  // 🔍 DEBUG 4: Dados extraídos
  console.log('👤 Dados extraídos:', JSON.stringify(subscriberData, null, 2));
  console.log('📞 Telefone extraído:', subscriberData.phone || '(VAZIO)');
  console.log('📧 Email extraído:', subscriberData.email || '(VAZIO)');
  console.log('🏷️ Nome extraído:', subscriberData.name || '(VAZIO)');

  if (!subscriberData.email) {
    return res.status(400).json({ success: false, message: 'Email não encontrado no payload' });
  }
  const plan = resolvePlanFromMapping(PLAN_MAPPING, subscriberData, DEFAULT_PLAN);
  
  // 🔍 DEBUG 5: Plano resolvido
  console.log('📋 Plano resolvido:', plan);

  if (!plan) {
    return res.status(422).json({ success: false, message: 'Plano não configurado para o evento recebido' });
  }
  try {
    if (ACTIVATION_EVENTS.has(eventType)) {
      const dataToInsert = {
        name: subscriberData.name || subscriberData.email,
        email: subscriberData.email,
        phone: subscriberData.phone,
        plan,
        status: 'active'
      };

      // 🔍 DEBUG 6: Dados que serão inseridos
      console.log('💾 Dados para inserir no banco:', JSON.stringify(dataToInsert, null, 2));

      const record = await db.upsertSubscriberFromHotmart(dataToInsert);

      // 🔍 DEBUG 7: Resultado da inserção
      console.log('✅ Registro salvo:', JSON.stringify(record, null, 2));
      console.log('=== FIM DEBUG ===');

      return res.json({ success: true, action: 'activated', subscriberId: record?.id || null, plan });
    }
    if (DEACTIVATION_EVENTS.has(eventType)) {
      const record = await db.deactivateSubscriberByEmail(subscriberData.email);
      console.log('=== FIM DEBUG ===');
      return res.json({ success: true, action: 'deactivated', subscriberId: record?.id || null, plan });
    }
  } catch (error) {
    console.error('❌ Erro ao processar evento do Hotmart:', error);
    console.log('=== FIM DEBUG ===');
    return res.status(500).json({ success: false, message: 'Erro interno ao processar evento' });
  }
  console.log('=== FIM DEBUG ===');
  return res.status(202).json({ success: true, message: `Evento ignorado: ${eventType}` });
});
module.exports = router;
