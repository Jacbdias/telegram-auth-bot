const express = require('express');
const db = require('./database');
const {
  ACTIVATION_EVENTS,
  DEACTIVATION_EVENTS,
  ACTIVATION_STATUSES,
  DEACTIVATION_STATUSES,
  verifyHotmartSignature,
  extractSubscriberData,
  resolvePlanFromMapping,
  getEventType,
  getStatusFromPayload
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
  const normalizedStatus = getStatusFromPayload(payload);

  // 🔍 DEBUG 2: Tipo de evento
  console.log('📌 Event Type:', eventType);

  console.log('📊 Status normalizado:', normalizedStatus || '(vazio)');

  console.log('🔍 DEBUG CRÍTICO - Verificação de eventos:');
  console.log('  eventType extraído:', JSON.stringify(eventType));
  console.log('  eventType typeof:', typeof eventType);
  console.log('  eventType length:', eventType?.length);
  console.log('  ACTIVATION_EVENTS.has(eventType):', ACTIVATION_EVENTS.has(eventType));
  console.log('  DEACTIVATION_EVENTS.has(eventType):', DEACTIVATION_EVENTS.has(eventType));
  console.log('  ACTIVATION_STATUSES.has(status):', ACTIVATION_STATUSES.has(normalizedStatus));
  console.log('  DEACTIVATION_STATUSES.has(status):', DEACTIVATION_STATUSES.has(normalizedStatus));
  console.log('  Lista ACTIVATION_EVENTS:', Array.from(ACTIVATION_EVENTS).join(', '));
  console.log('  Lista DEACTIVATION_EVENTS:', Array.from(DEACTIVATION_EVENTS).join(', '));

  if (normalizedStatus) {
    console.log('  Lista ACTIVATION_STATUSES:', Array.from(ACTIVATION_STATUSES).join(', '));
    console.log('  Lista DEACTIVATION_STATUSES:', Array.from(DEACTIVATION_STATUSES).join(', '));
  }

  if (!eventType) {
    console.log('⚠️ Evento sem tipo explícito.');
  }

  let action = null;
  let actionSource = null;

  if (eventType && ACTIVATION_EVENTS.has(eventType)) {
    action = 'activation';
    actionSource = 'event';
  } else if (eventType && DEACTIVATION_EVENTS.has(eventType)) {
    action = 'deactivation';
    actionSource = 'event';
  } else if (normalizedStatus && ACTIVATION_STATUSES.has(normalizedStatus)) {
    action = 'activation';
    actionSource = 'status';
  } else if (normalizedStatus && DEACTIVATION_STATUSES.has(normalizedStatus)) {
    action = 'deactivation';
    actionSource = 'status';
  }

  if (!action) {
    console.log('⚠️ Nenhuma ação determinada a partir do evento/status. Evento ignorado.');
    console.log('=== FIM DEBUG ===');
    return res.status(202).json({
      success: true,
      message: `Evento ignorado: ${eventType || normalizedStatus || 'desconhecido'}`
    });
  }

  if (actionSource === 'status') {
    console.log(
      `⚠️ Ação determinada pelo status (${normalizedStatus}) devido a evento não mapeado (${eventType || 'sem tipo'}).`
    );
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
    if (action === 'activation') {
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

      await db.pool.query(
        `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, user_agent, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          'DEBUG',
          record?.id || null,
          'authorized',
          `Evento: ${eventType || 'n/d'}, Status: ${normalizedStatus || 'n/d'}, Origem: ${actionSource}, Email: ${subscriberData.email}, Ação: ACTIVATION`
        ]
      );
      console.log('=== FIM DEBUG ===');

      return res.json({ success: true, action: 'activated', subscriberId: record?.id || null, plan });
    }
    if (action === 'deactivation') {
      const record = await db.deactivateSubscriberByEmail(subscriberData.email);

      await db.pool.query(
        `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, user_agent, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          'DEBUG',
          record?.id || null,
          'revoked',
          `Evento: ${eventType || 'n/d'}, Status: ${normalizedStatus || 'n/d'}, Origem: ${actionSource}, Email: ${subscriberData.email}, Ação: DEACTIVATION`
        ]
      );
      console.log('=== FIM DEBUG ===');
      return res.json({ success: true, action: 'deactivated', subscriberId: record?.id || null, plan });
    }
  } catch (error) {
    console.error('❌ Erro ao processar evento do Hotmart:', error);
    console.log('=== FIM DEBUG ===');
    return res.status(500).json({ success: false, message: 'Erro interno ao processar evento' });
  }
  console.log('=== FIM DEBUG ===');
  return res.status(202).json({
    success: true,
    message: `Evento ignorado: ${eventType || normalizedStatus || 'desconhecido'}`
  });
});
module.exports = router;
