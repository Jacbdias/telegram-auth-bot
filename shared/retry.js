function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    retryableErrors = [],
    onRetry = null,
    getDelayMs = null
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      const isRetryable = retryableErrors.length === 0
        || retryableErrors.some((code) => err.code === code || String(err.message || '').includes(code));

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const exponential = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const delay = typeof getDelayMs === 'function' ? getDelayMs(err, attempt, exponential) : exponential;
      const jitter = delay * 0.2 * Math.random();

      if (typeof onRetry === 'function') {
        await onRetry(err, attempt, delay);
      }

      await sleep(delay + jitter);
    }
  }
}

module.exports = { withRetry, sleep };
