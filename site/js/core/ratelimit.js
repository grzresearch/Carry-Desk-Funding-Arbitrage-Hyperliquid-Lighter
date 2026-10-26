// Hyperliquid meters REST traffic by weight (1200 per minute per IP; an l2Book costs 2,
// most other info requests 20). A token bucket that understands weights keeps the
// dashboard comfortably below that ceiling no matter how many books it watches.

export class WeightLimiter {
  /**
   * @param {object} o
   * @param {number} o.budget     weight allowed per window
   * @param {number} o.windowMs   window length
   * @param {() => number} o.now  clock (injectable for tests)
   * @param {(fn: () => void, ms: number) => unknown} o.schedule  timer (injectable)
   */
  constructor({ budget = 900, windowMs = 60_000, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.budget = budget
    this.rate = budget / windowMs
    this.tokens = budget
    this.now = now
    this.schedule = schedule
    this.stamp = now()
    this.queue = []
    this.timer = null
    this.spent = []
  }

  refill() {
    const t = this.now()
    this.tokens = Math.min(this.budget, this.tokens + (t - this.stamp) * this.rate)
    this.stamp = t
  }

  /** Resolves once `weight` can be spent. Lower `priority` numbers go first. */
  take(weight, priority = 5) {
    return new Promise((resolve) => {
      const job = { weight: Math.min(weight, this.budget), priority, resolve }
      const at = this.queue.findIndex((j) => j.priority > priority)
      if (at < 0) this.queue.push(job)
      else this.queue.splice(at, 0, job)
      this.pump()
    })
  }

  /** Charge weight discovered after the fact (e.g. per-item weight of a history call). */
  charge(weight) {
    this.refill()
    this.tokens -= weight
    this.record(weight)
  }

  record(weight) {
    const t = this.now()
    this.spent.push({ t, weight })
    const horizon = t - 60_000
    while (this.spent.length && this.spent[0].t < horizon) this.spent.shift()
  }

  /** Weight spent in the trailing minute, for the status bar. */
  usage() {
    const horizon = this.now() - 60_000
    return this.spent.reduce((sum, s) => (s.t >= horizon ? sum + s.weight : sum), 0)
  }

  pending() {
    return this.queue.length
  }

  pump() {
    if (this.timer) return
    this.refill()
    while (this.queue.length && this.tokens >= this.queue[0].weight) {
      const job = this.queue.shift()
      this.tokens -= job.weight
      this.record(job.weight)
      job.resolve()
    }
    if (this.queue.length) {
      const wait = Math.max(5, (this.queue[0].weight - this.tokens) / this.rate)
      this.timer = this.schedule(() => {
        this.timer = null
        this.pump()
      }, wait)
    }
  }
}
