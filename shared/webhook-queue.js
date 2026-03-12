class WebhookRetryQueue {
  constructor(maxSize = 100, maxRetries = 3) {
    this.queue = [];
    this.maxSize = maxSize;
    this.maxRetries = maxRetries;
    this.maxAgeMs = 15 * 60 * 1000;
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
    const now = Date.now();
    const oldestQueued = this.queue[0];

    return {
      queued: this.queue.length,
      deadLetter: this.deadLetter.length,
      maxRetries: this.maxRetries,
      oldestQueuedAgeMs: oldestQueued ? now - oldestQueued.timestamp : 0,
      items: this.queue.map((w) => ({
        type: w.type,
        attempt: w.attempt,
        age_ms: now - w.timestamp
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

  clearQueue() {
    const count = this.queue.length;
    this.queue = [];
    return count;
  }

  moveStaleToDeadLetter(maxAgeMs = this.maxAgeMs) {
    const now = Date.now();
    const keep = [];
    let moved = 0;

    for (const item of this.queue) {
      if (now - item.timestamp > maxAgeMs) {
        this.moveToDeadLetter({ ...item, reason: 'stale_item' }, new Error('stale_item'));
        moved += 1;
      } else {
        keep.push(item);
      }
    }

    this.queue = keep;
    return moved;
  }
}

module.exports = new WebhookRetryQueue();
