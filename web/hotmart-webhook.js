const express = require('express');
const db = require('./database');
const cache = require('../bot/cache');
const logger = require('../shared/logger');
const metrics = require('../shared/metrics-collector');
const alerts = require('../shared/alerts');
const webhookQueue = require('../shared/webhook-queue');
const { sanitizeEmail, sanitizeText } = require('../shared/sanitize');
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
const WEBHOOK_RETRY_INTERVAL_MS = Number(process.env.WEBHOOK_RETRY_INTERVAL_MS || 30000);
const WEBHOOK_STALE_MAX_AGE_MS = Number(process.env.WEBHOOK_STALE_MAX_AGE_MS || 15 * 60 * 1000);
const WEBHOOK_QUEUE_MONITOR_INTERVAL_MS = Number(process.env.WEBHOOK_QUEUE_MONITOR_INTERVAL_MS || 2 * 60 * 1000);

router.use(express.raw({ type: '*/*', limit: '2mb' }));

async function processHotmartEvent(payload) {
  const eventType = getEventType(payload);
  const normalizedStatus = getStatusFromPayload(payload);
  logger.incrementWebhook('hotmart');
  metrics.increment('webhook_received');
  metrics.increment('webhook_hotmart');

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
    return { ignored: true, action: null };
  }

  const subscriberData = extractSubscriberData(payload);
  const sanitizedEmail = sanitizeEmail(subscriberData.email);
  const sanitizedName = sanitizeText(subscriberData.name || sanitizedEmail, 255);
  const sanitizedPhone = sanitizeText(subscriberData.phone || '', 30);

  if (!sanitizedEmail) {
    const err = new Error('Email não encontrado no payload');
    err.statusCode = 400;
    throw err;
  }

  const plan = resolvePlanFromMapping(PLAN_MAPPING, subscriberData, DEFAULT_PLAN);

  if (!plan) {
    const err = new Error('Plano não configurado para o evento recebido');
    err.statusCode = 422;
    throw err;
  }

  if (action === 'activation') {
    const record = await db.upsertSubscriberFromHotmart({
      name: sanitizedName,
      email: sanitizedEmail,
      phone: sanitizedPhone,
      plan,
      status: 'active'
    });

    if (record?.id) {
      cache.invalidate(`sub:${record.id}`);
    }

    if (record?.id) {
      await db.logWebhookAuthorization({
        subscriberId: record.id,
        action: 'authorized',
        platform: 'HOTMART',
        eventType,
        status: normalizedStatus,
        source: actionSource
      });
    }

    logger.info('webhook_hotmart_processed', {
      action: 'activation',
      email: sanitizedEmail,
      plan: sanitizeText(plan, 255),
      subscriber_id: record?.id || null
    });

    return { action: 'activated', subscriberId: record?.id || null, plan };
  }

  const record = await db.deactivateSubscriberByEmail(sanitizedEmail, { plan: sanitizeText(plan, 255) });
  if (record?.id) {
    await db.logWebhookAuthorization({
      subscriberId: record.id,
      action: 'revoked',
      platform: 'HOTMART',
      eventType,
      status: normalizedStatus,
      source: actionSource
    });
  }
  if (record?.id) cache.invalidate(`sub:${record.id}`);

  logger.info('webhook_hotmart_processed', {
    action: 'deactivation',
    email: sanitizedEmail,
    plan: sanitizeText(plan, 255),
    subscriber_id: record?.id || null
  });

  return { action: 'deactivated', subscriberId: record?.id || null, plan };
}

function isRetryableWebhookError(error) {
  const statusCode = Number(error?.statusCode || error?.response?.status || 0);
  if (statusCode >= 400 && statusCode < 500) {
    return false;
  }
  return true;
}

router.post('/', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const signature = req.get('X-Hotmart-Hmac-SHA256') || req.get('X-Hotmart-Hmac-Sha256') || req.get('X-Hotmart-Hottok');
  const hottok = req.get('X-Hotmart-Hottok');

  if (hottok) {
    if (hottok !== WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: 'Hottok inválido' });
    }
  } else if (!verifyHotmartSignature(rawBody, signature, WEBHOOK_SECRET)) {
    return res.status(401).json({ success: false, message: 'Assinatura inválida' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (_error) {
    return res.status(400).json({ success: false, message: 'JSON inválido' });
  }

  try {
    const result = await processHotmartEvent(payload);
    if (result.ignored) {
      return res.status(202).json({ success: true, message: 'Evento ignorado' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    metrics.increment('webhook_errors');
    alerts.send('WEBHOOK_ERROR', `Webhook hotmart falhou para email ${sanitizeEmail(payload?.buyer?.email || payload?.subscriber?.email || '')}: ${error.message}`, 2 * 60 * 1000);
    const retryable = isRetryableWebhookError(error);

    if (retryable) {
      webhookQueue.enqueue({ type: 'hotmart', payload: payload || {}, error: error.message });
    }

    logger.error('webhook_hotmart_error', {
      error: error.message,
      retryable,
      status_code: error?.statusCode || null,
      queue: webhookQueue.getStatus()
    });
    return res.status(error.statusCode || 500).json({ success: false, message: 'Erro interno ao processar evento' });
  }
});

const retryInterval = setInterval(async () => {
  const moved = webhookQueue.moveStaleToDeadLetter(WEBHOOK_STALE_MAX_AGE_MS);
  if (moved > 0) {
    logger.warn('webhook_retry_stale_moved', {
      moved,
      max_age_ms: WEBHOOK_STALE_MAX_AGE_MS,
      queue: webhookQueue.getStatus()
    });
  }

  const item = webhookQueue.dequeue();
  if (!item || item.type !== 'hotmart') return;

  try {
    logger.info('webhook_retry', { type: item.type, attempt: item.attempt, queue: webhookQueue.getStatus() });
    await processHotmartEvent(item.payload);
    logger.info('webhook_retry_success', { type: item.type, attempt: item.attempt, queue: webhookQueue.getStatus() });
  } catch (error) {
    const retryable = isRetryableWebhookError(error);

    if (retryable && item.attempt < webhookQueue.maxRetries) {
      webhookQueue.enqueue({ ...item, error: error.message, attempt: item.attempt });
      logger.warn('webhook_retry_requeued', {
        type: item.type,
        attempt: item.attempt,
        max_retries: webhookQueue.maxRetries,
        error: error.message,
        queue: webhookQueue.getStatus()
      });
    } else {
      const reason = retryable ? 'max_retries_reached' : 'non_retryable_error';
      webhookQueue.moveToDeadLetter({ ...item, reason }, error);
      logger.error('webhook_retry_dead_letter', {
        type: item.type,
        attempt: item.attempt,
        retryable,
        reason,
        error: error.message,
        status_code: error?.statusCode || null,
        queue: webhookQueue.getStatus()
      });
    }
  }
}, WEBHOOK_RETRY_INTERVAL_MS);

const queueMonitorInterval = setInterval(() => {
  const status = webhookQueue.getStatus();
  if (status.queued > 0 || status.deadLetter > 0) {
    logger.info('webhook_queue_status', status);
  }
}, WEBHOOK_QUEUE_MONITOR_INTERVAL_MS);

function stopWebhookRetryInterval() {
  clearInterval(retryInterval);
  clearInterval(queueMonitorInterval);
}

module.exports = router;
module.exports.stopWebhookRetryInterval = stopWebhookRetryInterval;
