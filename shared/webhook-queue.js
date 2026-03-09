class WebhookRetryQueue {
  constructor(maxSize = 100, maxRetries = 3) {
    this.queue = [];
    this.maxSize = maxSize;
    this.maxRetries = maxRetries;
    this.deadLetter = [];
    this.maxDeadLetter = 50;
  }

  enqueue(webhook) {
    if (this.queue.length >= this.maxSize) {
      const dropped = this.queue.shift();
      if (dropped) this.moveToDeadLetter({ ...dropped, reason: 'queue_full' }, new Error('queue_full'));
    }

    this.queue.push({
      ...webhook,
      attempt: (webhook.attempt || 0) + 1,
      timestamp: Date.now()
    });
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  moveToDeadLetter(webhook, error) {
    if (this.deadLetter.length >= this.maxDeadLetter) {
      this.deadLetter.shift();
    }

    this.deadLetter.push({
      ...webhook,
      error: error && error.message ? error.message : String(error || 'unknown_error'),
      failedAt: Date.now()
    });
  }

  getStatus() {
    return {
      queued: this.queue.length,
      deadLetter: this.deadLetter.length,
      items: this.queue.map((w) => ({
        type: w.type,
        attempt: w.attempt,
        age_ms: Date.now() - w.timestamp
      }))
    };
  }

  getDeadLetterItems() {
    return [...this.deadLetter];
  }

  retryDeadLetter() {
    const items = [...this.deadLetter];
    this.deadLetter = [];
    items.forEach((item) => this.enqueue({ ...item, attempt: 0 }));
    return items.length;
  }

  clearDeadLetter() {
    const count = this.deadLetter.length;
    this.deadLetter = [];
    return count;
  }
}

module.exports = new WebhookRetryQueue();
