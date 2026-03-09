class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.requiredSuccesses = options.requiredSuccesses || 2;
    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailure = null;
    this.successesInHalfOpen = 0;
  }

  canExecute() {
    if (this.state === 'CLOSED') return true;

    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.successesInHalfOpen = 0;
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successesInHalfOpen += 1;
      if (this.successesInHalfOpen >= this.requiredSuccesses) {
        this.state = 'CLOSED';
        this.failures = 0;
      }
      return;
    }

    this.failures = 0;
  }

  recordFailure() {
    this.failures += 1;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure
    };
  }
}

module.exports = CircuitBreaker;
