class MetricsCollector {
  constructor() {
    this.hourly = {};
    this.daily = {};
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
  }

  increment(metric, value = 1) {
    try {
      const hourKey = new Date().toISOString().substring(0, 13);
      const dayKey = new Date().toISOString().substring(0, 10);

      if (!this.hourly[hourKey]) this.hourly[hourKey] = {};
      this.hourly[hourKey][metric] = (this.hourly[hourKey][metric] || 0) + value;

      if (!this.daily[dayKey]) this.daily[dayKey] = {};
      this.daily[dayKey][metric] = (this.daily[dayKey][metric] || 0) + value;
    } catch (_error) {}
  }

  recordLatency(metric, ms) {
    try {
      const hourKey = new Date().toISOString().substring(0, 13);
      const dayKey = new Date().toISOString().substring(0, 10);
      const sumKey = `${metric}_latency_sum`;
      const countKey = `${metric}_latency_count`;
      const maxKey = `${metric}_latency_max`;

      if (!this.hourly[hourKey]) this.hourly[hourKey] = {};
      if (!this.daily[dayKey]) this.daily[dayKey] = {};

      this.hourly[hourKey][sumKey] = (this.hourly[hourKey][sumKey] || 0) + ms;
      this.hourly[hourKey][countKey] = (this.hourly[hourKey][countKey] || 0) + 1;
      this.hourly[hourKey][maxKey] = Math.max(this.hourly[hourKey][maxKey] || 0, ms);

      this.daily[dayKey][sumKey] = (this.daily[dayKey][sumKey] || 0) + ms;
      this.daily[dayKey][countKey] = (this.daily[dayKey][countKey] || 0) + 1;
      this.daily[dayKey][maxKey] = Math.max(this.daily[dayKey][maxKey] || 0, ms);
    } catch (_error) {}
  }

  getHourly(hours = 24) {
    const keys = Object.keys(this.hourly).sort().slice(-hours);
    return keys.map((hour) => this.#materializePeriod('hour', hour, this.hourly[hour]));
  }

  getDaily(days = 30) {
    const keys = Object.keys(this.daily).sort().slice(-days);
    return keys.map((day) => this.#materializePeriod('day', day, this.daily[day]));
  }

  #materializePeriod(keyName, keyValue, payload = {}) {
    const item = { [keyName]: keyValue, ...payload };

    for (const metricName of ['db', 'query']) {
      const sum = item[`${metricName}_latency_sum`] || 0;
      const count = item[`${metricName}_latency_count`] || 0;
      item[`${metricName}_latency_avg`] = count > 0 ? Math.round(sum / count) : 0;
    }

    return item;
  }

  cleanup() {
    const now = Date.now();
    const hourlyCutoff = now - (24 * 60 * 60 * 1000);
    const dailyCutoff = now - (30 * 24 * 60 * 60 * 1000);

    Object.keys(this.hourly).forEach((key) => {
      const timestamp = Date.parse(`${key}:00:00.000Z`);
      if (Number.isNaN(timestamp) || timestamp < hourlyCutoff) {
        delete this.hourly[key];
      }
    });

    Object.keys(this.daily).forEach((key) => {
      const timestamp = Date.parse(`${key}T00:00:00.000Z`);
      if (Number.isNaN(timestamp) || timestamp < dailyCutoff) {
        delete this.daily[key];
      }
    });
  }

  stop() {
    clearInterval(this.cleanupInterval);
  }
}

module.exports = new MetricsCollector();
