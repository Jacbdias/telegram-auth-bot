const metrics = require('./metrics-collector');
const alerts = require('./alerts');

class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
    this.abuse = new Map();
    this.cleanupInterval = this.startCleanup();
  }

  isAllowed(ip, path = '') {
    const now = Date.now();
    const entry = this.requests.get(ip);

    if (!entry || now > entry.resetAt) {
      this.requests.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (entry.count >= this.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      this.trackAbuse(ip, path);
      metrics.increment('rate_limit_hits');
      return { allowed: false, retryAfterSeconds };
    }

    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  trackAbuse(ip, path) {
    const now = Date.now();
    const abuseWindowMs = 5 * 60 * 1000;
    const current = this.abuse.get(ip) || [];
    const fresh = current.filter((timestamp) => now - timestamp < abuseWindowMs);
    fresh.push(now);
    this.abuse.set(ip, fresh);

    if (fresh.length > 10) {
      alerts.send(
        `RATE_LIMIT_ABUSE:${ip}`,
        `IP ${ip} atingiu rate limit ${fresh.length} vezes em 5min no endpoint ${path || 'unknown'}`,
        10 * 60 * 1000
      );
    }
  }

  startCleanup() {
    return setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.requests.entries()) {
        if (now > entry.resetAt) this.requests.delete(ip);
      }
      for (const [ip, hits] of this.abuse.entries()) {
        const fresh = hits.filter((timestamp) => now - timestamp < 5 * 60 * 1000);
        if (fresh.length === 0) this.abuse.delete(ip);
        else this.abuse.set(ip, fresh);
      }
    }, 300000);
  }

  stop() {
    clearInterval(this.cleanupInterval);
  }
}

module.exports = RateLimiter;
