const metrics = {
  window_started_at: new Date().toISOString(),
  slow_queries_24h: 0,
  query_errors_24h: 0,
  webhooks_24h: { hotmart: 0, kiwify: 0, eduzz: 0 },
  auth_actions_24h: { authorized: 0, revoked: 0 }
};

let resetTimerStarted = false;

function emit(level, msg, data = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...data
  };

  const line = JSON.stringify(payload);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function info(msg, data) { emit('info', msg, data); }
function warn(msg, data) { emit('warn', msg, data); }
function error(msg, data) { emit('error', msg, data); }

function query(name, durationMs, data = {}) {
  emit('info', 'db_query', { name, duration_ms: durationMs, ...data });
}

function incrementSlowQuery() { metrics.slow_queries_24h += 1; }
function incrementQueryError() { metrics.query_errors_24h += 1; }
function incrementWebhook(source) {
  if (metrics.webhooks_24h[source] !== undefined) metrics.webhooks_24h[source] += 1;
}
function incrementAuthAction(action) {
  if (metrics.auth_actions_24h[action] !== undefined) metrics.auth_actions_24h[action] += 1;
}

function getMetricsSnapshot() {
  return {
    ...metrics,
    webhooks_24h: { ...metrics.webhooks_24h },
    auth_actions_24h: { ...metrics.auth_actions_24h }
  };
}

function resetDailyMetrics() {
  metrics.window_started_at = new Date().toISOString();
  metrics.slow_queries_24h = 0;
  metrics.query_errors_24h = 0;
  metrics.webhooks_24h = { hotmart: 0, kiwify: 0, eduzz: 0 };
  metrics.auth_actions_24h = { authorized: 0, revoked: 0 };
}

function startDailyReset() {
  if (resetTimerStarted) return;
  resetTimerStarted = true;
  setInterval(() => {
    resetDailyMetrics();
    info('metrics_reset_24h');
  }, 24 * 60 * 60 * 1000);
}

module.exports = {
  info,
  warn,
  error,
  query,
  incrementSlowQuery,
  incrementQueryError,
  incrementWebhook,
  incrementAuthAction,
  getMetricsSnapshot,
  startDailyReset
};
