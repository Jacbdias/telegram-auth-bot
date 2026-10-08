const express = require('express');
const logger = require('../shared/logger');
const metrics = require('../shared/metrics-collector');
const alerts = require('../shared/alerts');
const webhookQueue = require('../shared/webhook-queue');
const { sanitizeEmail } = require('../shared/sanitize');
const { createHotmartProcessor } = require('./hotmart-processor');
const { verifyHotmartSignature, timingSafeHottokMatches } = require('./hotmart-utils');

const router = express.Router();

const WEBHOOK_SECRET = process.env.HOTMART_WEBHOOK_SECRET || '';
const WEBHOOK_RETRY_INTERVAL_MS = Number(process.env.WEBHOOK_RETRY_INTERVAL_MS || 30000);
const WEBHOOK_STALE_MAX_AGE_MS = Number(process.env.WEBHOOK_STALE_MAX_AGE_MS || 15 * 60 * 1000);
const WEBHOOK_QUEUE_MONITOR_INTERVAL_MS = Number(process.env.WEBHOOK_QUEUE_MONITOR_INTERVAL_MS || 2 * 60 * 1000);

// As regras de negócio vivem em web/hotmart-processor.js.
const { processHotmartEvent } = createHotmartProcessor();

router.use(express.raw({ type: '*/*', limit: '2mb' }));

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
    // Comparação em tempo constante sobre o SHA-256 dos dois lados.
    if (!timingSafeHottokMatches(hottok, WEBHOOK_SECRET)) {
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
      return res
        .status(202)
        .json({ success: true, message: 'Evento ignorado', reason: result.reason || null });
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
  const queue = webhookQueue.getStatus();
  if (queue.queued === 0) return;

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
