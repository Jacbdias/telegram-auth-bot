const express = require('express');
const db = require('./database');
const cache = require('../bot/cache');
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
    console.error('❌ Erro ao analisar payload do Hotmart:', error);
    return res.status(400).json({ success: false, message: 'JSON inválido' });
  }

  const eventType = getEventType(payload);
  const normalizedStatus = getStatusFromPayload(payload);

  // Log único e conciso
  console.log(`📨 Webhook Hotmart: ${eventType} | Status: ${normalizedStatus || 'n/d'}`);

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
    console.log(`⚠️ Evento ignorado: ${eventType || normalizedStatus || 'desconhecido'}`);
    return res.status(202).json({
      success: true,
      message: `Evento ignorado: ${eventType || normalizedStatus || 'desconhecido'}`
    });
  }

  if (actionSource === 'status') {
    console.log(`⚠️ Ação por status: ${normalizedStatus} | Evento: ${eventType || 'n/d'}`);
  }

  const subscriberData = extractSubscriberData(payload);
  console.log(`👤 Dados: ${subscriberData.email} | ${subscriberData.phone || 'sem tel'} | ${subscriberData.name}`);

  if (!subscriberData.email) {
    return res.status(400).json({ success: false, message: 'Email não encontrado no payload' });
  }

  const plan = resolvePlanFromMapping(PLAN_MAPPING, subscriberData, DEFAULT_PLAN);
  console.log(`📋 Plano: ${plan}`);

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

      const record = await db.upsertSubscriberFromHotmart(dataToInsert);
      if (record?.id) {
        cache.invalidate(`sub:${record.id}`);
        const linkedUsers = await db.pool.query(
          'SELECT telegram_id FROM authorized_users WHERE subscriber_id = $1',
          [record.id]
        );
        linkedUsers.rows.forEach((row) => {
          if (row.telegram_id) {
            cache.invalidate(`user:tg:${row.telegram_id}`);
          }
        });
      }
      console.log(`✅ Ativado: ${subscriberData.email} | ID: ${record?.id} | Plano: ${plan}`);

      await db.pool.query(
        `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, user_agent, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          'HOTMART',
          record?.id || null,
          'authorized',
          `Evento: ${eventType || 'n/d'}, Status: ${normalizedStatus || 'n/d'}, Origem: ${actionSource}`
        ]
      );

      return res.json({ success: true, action: 'activated', subscriberId: record?.id || null, plan });
    }

    if (action === 'deactivation') {
      const record = await db.deactivateSubscriberByEmail(subscriberData.email, { plan });
      if (record?.id) {
        cache.invalidate(`sub:${record.id}`);
        const linkedUsers = await db.pool.query(
          'SELECT telegram_id FROM authorized_users WHERE subscriber_id = $1',
          [record.id]
        );
        linkedUsers.rows.forEach((row) => {
          if (row.telegram_id) {
            cache.invalidate(`user:tg:${row.telegram_id}`);
          }
        });
      }
      const remainingPlans = (record?.plan || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const noChanges = !record || (plan && !record.planRevoked);
      const deactivationAction =
        noChanges || !plan
          ? 'deactivated'
          : remainingPlans.length > 0
            ? 'plan_revoked'
            : 'deactivated';
      const responseAction = noChanges ? 'ignored' : deactivationAction;

      const logSuffix = noChanges
        ? `Nenhuma alteração realizada${plan ? ` para o plano ${plan}` : ''}`
        : deactivationAction === 'plan_revoked'
          ? `Plano removido: ${plan} | Planos restantes: ${remainingPlans.join(', ') || 'nenhum'}`
          : 'Assinante totalmente desativado';

      console.log(`⚠️ Desativado: ${subscriberData.email} | ID: ${record?.id || 'n/d'} | ${logSuffix}`);

      if (!noChanges) {
        await db.pool.query(
          `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, user_agent, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            'HOTMART',
            record?.id || null,
            'revoked',
            `Evento: ${eventType || 'n/d'}, Status: ${normalizedStatus || 'n/d'}, Origem: ${actionSource}`
          ]
        );
      }

      return res.json({
        success: true,
        action: responseAction,
        subscriberId: record?.id || null,
        plan
      });
    }
  } catch (error) {
    console.error('❌ Erro ao processar evento do Hotmart:', error);
    return res.status(500).json({ success: false, message: 'Erro interno ao processar evento' });
  }

  return res.status(202).json({
    success: true,
    message: `Evento ignorado: ${eventType || normalizedStatus || 'desconhecido'}`
  });
});

module.exports = router;
