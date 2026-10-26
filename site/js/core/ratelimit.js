// Hyperliquid meters REST traffic by weight: 1200 per minute per IP. An l2Book costs 2,
// most other info requests 20. This limiter enforces the same rule the server does — a
// sliding one-minute window — with a safety margin, so a burst can never exceed it.

export class WeightLimiter {
  /**
   * @param {object} o
   * @param {number} o.budget     weight allowed in any window
   * @param {number} o.windowMs   window length
   * @param {() => number} o.now  clock (injectable for tests)
   * @param {(fn: () => void, ms: number) => unknown} o.schedule  timer (injectable)
   */
  constructor({ budget = 1000, windowMs = 60_000, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.budget = budget
    this.windowMs = windowMs
    this.now = now
    this.schedule = schedule
    this.queue = []
    this.spent = [] // { t, weight }, oldest first
    this.timer = null
    this.blockedUntil = 0
  }

  prune() {
    const horizon = this.now() - this.windowMs
    while (this.spent.length && this.spent[0].t <= horizon) this.spent.shift()
  }

  /** Weight spent in the current window. */
  usage() {
    this.prune()
    return this.spent.reduce((sum, s) => sum + s.weight, 0)
  }

  pending() {
    return this.queue.length
  }

  /** Resolves once `weight` fits into the window. Lower `priority` numbers go first. */
  take(weight, priority = 5) {
    return new Promise((resolve) => {
      const job = { weight: Math.min(weight, this.budget), priority, resolve }
      const at = this.queue.findIndex((j) => j.priority > priority)
      if (at < 0) this.queue.push(job)
      else this.queue.splice(at, 0, job)
      this.pump()
    })
  }

  /** Record weight discovered after the fact (the per-item weight of a history call). */
  charge(weight) {
    if (weight > 0) this.spent.push({ t: this.now(), weight })
  }

  /**
   * After a 429, hold all traffic for `ms`. Idempotent: a burst of rejections costs one
   * pause, not one per rejected request.
   */
  backoff(ms) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms)
  }

  wake(ms) {
    this.timer = this.schedule(() => {
      this.timer = null
      this.pump()
    }, Math.max(5, ms))
  }

  pump() {
    if (this.timer) return
    const t = this.now()
    if (t < this.blockedUntil) return this.wake(this.blockedUntil - t)
    let used = this.usage()
    while (this.queue.length && used + this.queue[0].weight <= this.budget) {
      const job = this.queue.shift()
      this.spent.push({ t, weight: job.weight })
      used += job.weight
      job.resolve()
    }
    if (!this.queue.length) return
    // Wait until enough of the oldest spends have left the window.
    let excess = used + this.queue[0].weight - this.budget
    let wait = 0
    for (const s of this.spent) {
      excess -= s.weight
      wait = s.t + this.windowMs - t
      if (excess <= 0) break
    }
    this.wake(wait)
  }
}
