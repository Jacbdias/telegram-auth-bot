// Job diário do fim do período pago.
//
// Quem cancelou a renovação tem `access_until` gravado em
// `subscriber_plan_access` (regra 1 do Davi: o acesso vai até o fim do período
// já pago). Este job varre os vencidos e remove SÓ AQUELE PLANO, usando a
// remoção por plano que já existe: `deactivateSubscriberByEmail(email,
// { plan })` revoga os convites e tira a pessoa dos canais daquele plano,
// como o /sync faz. As outras assinaturas da pessoa continuam valendo.
//
// Enquanto o SQL manual (sql/subscriber-plan-access.sql) não rodar,
// `listExpiredPlanAccess` devolve [] e o job não faz nada.

const defaultDb = require('./database');
const defaultLogger = require('../shared/logger');

const DEFAULT_INTERVAL_MS = Number(process.env.PLAN_ACCESS_JOB_INTERVAL_MS || 24 * 60 * 60 * 1000);
// Primeira passada pouco depois do boot, para o Davi conferir o job sem
// esperar 24h pelo primeiro tick.
const DEFAULT_START_DELAY_MS = Number(process.env.PLAN_ACCESS_JOB_START_DELAY_MS || 60 * 1000);

async function runPlanAccessExpiryJob({
  db = defaultDb,
  logger = defaultLogger,
  now = new Date()
} = {}) {
  const summary = { checked: 0, revoked: 0, skipped: 0, failures: [] };

  let expired;

  try {
    expired = await db.listExpiredPlanAccess(now);
  } catch (error) {
    logger.error('plan_access_job_list_failed', { error: error.message });
    summary.failures.push({ scope: 'list', error: error.message });
    return summary;
  }

  summary.checked = expired.length;

  if (expired.length === 0) {
    return summary;
  }

  for (const row of expired) {
    if (!row.email || !row.plan) {
      summary.skipped++;
      logger.warn('plan_access_job_row_incomplete', {
        plan_access_id: row.id || null,
        subscriber_id: row.subscriber_id || null
      });
      continue;
    }

    try {
      const record = await db.deactivateSubscriberByEmail(row.email, { plan: row.plan });

      // Só apaga a linha depois da remoção: se a remoção falhar, o job tenta
      // de novo no próximo tick.
      await db.deletePlanAccessById(row.id);

      summary.revoked++;

      logger.info('plan_access_job_revoked', {
        plan_access_id: row.id,
        subscriber_id: row.subscriber_id,
        plan: row.plan,
        access_until: row.access_until,
        reason: row.reason || null,
        plan_revoked: record?.planRevoked ?? null,
        remaining_plan: record?.plan ?? null
      });
    } catch (error) {
      summary.failures.push({
        plan_access_id: row.id || null,
        subscriber_id: row.subscriber_id || null,
        plan: row.plan,
        error: error.message
      });

      logger.error('plan_access_job_revoke_failed', {
        plan_access_id: row.id || null,
        subscriber_id: row.subscriber_id || null,
        plan: row.plan,
        error: error.message
      });
    }
  }

  logger.info('plan_access_job_done', {
    checked: summary.checked,
    revoked: summary.revoked,
    skipped: summary.skipped,
    failures: summary.failures.length
  });

  return summary;
}

let jobInterval = null;
let startTimeout = null;

function startPlanAccessExpiryJob({
  db = defaultDb,
  logger = defaultLogger,
  intervalMs = DEFAULT_INTERVAL_MS,
  startDelayMs = DEFAULT_START_DELAY_MS
} = {}) {
  if (jobInterval) {
    return { alreadyRunning: true };
  }

  const tick = () => {
    runPlanAccessExpiryJob({ db, logger }).catch((error) => {
      logger.error('plan_access_job_failed', { error: error.message });
    });
  };

  startTimeout = setTimeout(tick, startDelayMs);
  jobInterval = setInterval(tick, intervalMs);

  logger.info('plan_access_job_started', {
    interval_ms: intervalMs,
    start_delay_ms: startDelayMs
  });

  return { alreadyRunning: false, intervalMs, startDelayMs };
}

function stopPlanAccessExpiryJob() {
  if (startTimeout) {
    clearTimeout(startTimeout);
    startTimeout = null;
  }

  if (jobInterval) {
    clearInterval(jobInterval);
    jobInterval = null;
  }
}

module.exports = {
  runPlanAccessExpiryJob,
  startPlanAccessExpiryJob,
  stopPlanAccessExpiryJob,
  DEFAULT_INTERVAL_MS
};
