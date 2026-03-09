class SimpleCache {
  constructor(defaultTTL = 300000) {
    this.cache = new Map();
    this.defaultTTL = defaultTTL;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttl) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttl || this.defaultTTL)
    });
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  invalidatePattern(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  getStats() {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size
    };
  }
}

module.exports = new SimpleCache();
