const CHECK_INTERVAL = 10_000;
const RESUME_GAP = CHECK_INTERVAL + 5000;

export class SleepGapMonitor {
  constructor(options = {}) {
    this.onResume = options.onResume || (() => {});
    this.wallNow = options.wallNow || (() => Date.now());
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.timer = null;
  }

  start() {
    if (this.timer !== null) return;
    this.lastTick = this.wallNow();
    this.timer = this.setInterval(() => this.tick(), CHECK_INTERVAL);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer !== null) this.clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (this.timer === null) return;
    const wallNow = this.wallNow();
    const gap = wallNow - this.lastTick;
    this.lastTick = wallNow;
    if (gap > RESUME_GAP) this.onResume(gap);
  }
}
