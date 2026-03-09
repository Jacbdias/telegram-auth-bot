class RateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
    this.startCleanup();
  }

  isAllowed(ip) {
    const now = Date.now();
    const entry = this.requests.get(ip);

    if (!entry || now > entry.resetAt) {
      this.requests.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (entry.count >= this.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.requests.entries()) {
        if (now > entry.resetAt) this.requests.delete(ip);
      }
    }, 300000);
  }
}

module.exports = RateLimiter;
