/*
 * reminders.js — stretch / water / scheduled messages / pomodoro.
 *
 * Lives in main rather than the renderer because it is the process that
 * survives; a renderer reload must not reset someone's pomodoro round.
 *
 * All scheduling is wall-clock based (compare against Date.now()) instead of
 * accumulating setInterval ticks, so a laptop that sleeps for two hours fires
 * once on wake rather than 120 times or never.
 */
const store = require("./store");

const PHASE = { IDLE: "idle", FOCUS: "focus", BREAK: "break" };

class Reminders {
  constructor(emit) {
    this.emit = emit; // (channel, payload) => void
    this.timer = null;
    this.lastFired = { stretch: Date.now(), water: Date.now() };
    this.firedMessages = new Set(); // "id@YYYY-MM-DD", cleared on date change
    this.day = new Date().toDateString();
    this.pomo = { phase: PHASE.IDLE, endsAt: 0, round: 1 };
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Called when the user changes an interval so the next fire uses the new one
  // from now, instead of retroactively deciding it is already overdue.
  resetCadence() {
    this.lastFired.stretch = Date.now();
    this.lastFired.water = Date.now();
  }

  tick() {
    const now = Date.now();
    const s = store.get();

    const today = new Date().toDateString();
    if (today !== this.day) {
      this.day = today;
      this.firedMessages.clear();
    }

    for (const kind of ["stretch", "water"]) {
      const cfg = s.reminders[kind];
      if (!cfg || !cfg.enabled) continue;
      const every = Math.max(1, cfg.everyMin) * 60_000;
      if (now - this.lastFired[kind] >= every) {
        this.lastFired[kind] = now;
        this.emit("say", {
          kind,
          text: this.phrase(kind, s.name),
          ms: 9000,
        });
      }
    }

    this.tickMessages(s);
    this.tickPomodoro(now, s);
  }

  tickMessages(s) {
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    for (const m of s.messages || []) {
      if (!m.enabled || m.time !== hhmm) continue;
      const key = `${m.id}@${this.day}`;
      if (this.firedMessages.has(key)) continue;
      this.firedMessages.add(key);
      this.emit("say", { kind: "message", text: m.text, ms: 12000 });
    }
  }

  tickPomodoro(now, s) {
    if (this.pomo.phase === PHASE.IDLE) return;
    const remaining = this.pomo.endsAt - now;
    if (remaining > 0) {
      this.emit("pomodoro", { ...this.pomo, remainingMs: remaining });
      return;
    }
    // phase boundary
    if (this.pomo.phase === PHASE.FOCUS) {
      this.pomo.phase = PHASE.BREAK;
      this.pomo.endsAt = now + Math.max(1, s.pomodoro.breakMin) * 60_000;
      this.emit("say", { kind: "pomodoro", text: this.phrase("breakStart", s.name), ms: 10000 });
    } else {
      this.pomo.round += 1;
      if (s.pomodoro.rounds && this.pomo.round > s.pomodoro.rounds) {
        this.stopPomodoro();
        this.emit("say", { kind: "pomodoro", text: this.phrase("allDone", s.name), ms: 12000 });
        return;
      }
      this.pomo.phase = PHASE.FOCUS;
      this.pomo.endsAt = now + Math.max(1, s.pomodoro.focusMin) * 60_000;
      this.emit("say", { kind: "pomodoro", text: this.phrase("focusStart", s.name), ms: 8000 });
    }
    this.emit("pomodoro", { ...this.pomo, remainingMs: this.pomo.endsAt - now });
  }

  startPomodoro() {
    const s = store.get();
    this.pomo = {
      phase: PHASE.FOCUS,
      endsAt: Date.now() + Math.max(1, s.pomodoro.focusMin) * 60_000,
      round: 1,
    };
    this.emit("say", { kind: "pomodoro", text: this.phrase("focusStart", s.name), ms: 8000 });
    this.emit("pomodoro", { ...this.pomo, remainingMs: this.pomo.endsAt - Date.now() });
  }

  stopPomodoro() {
    this.pomo = { phase: PHASE.IDLE, endsAt: 0, round: 1 };
    this.emit("pomodoro", { ...this.pomo, remainingMs: 0 });
  }

  togglePomodoro() {
    if (this.pomo.phase === PHASE.IDLE) this.startPomodoro();
    else this.stopPomodoro();
  }

  // A cat that says the same sentence every 45 minutes stops being a pet and
  // starts being a notification, so every prompt has a few variants.
  phrase(kind, name) {
    const who = name ? name : null;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const tail = who ? `, ${who}` : "";
    switch (kind) {
      case "stretch":
        return pick([
          `stretch time${tail}!`,
          `mrrrp — stand up${tail}`,
          `long cat says: stretch${tail}`,
          `unfold yourself${tail}`,
        ]);
      case "water":
        return pick([
          `water break${tail}`,
          `drink something${tail}!`,
          `hydrate, human${tail}`,
          `*taps glass*${tail}`,
        ]);
      case "focusStart":
        return pick([`focus time${tail}`, `let's work${tail}`, `heads down${tail}`]);
      case "breakStart":
        return pick([`break${tail}!`, `rest your eyes${tail}`, `nap o'clock${tail}`]);
      case "allDone":
        return pick([`all rounds done${tail}!`, `we did it${tail}`, `good work${tail}`]);
      default:
        return "mrrp";
    }
  }
}

module.exports = { Reminders, PHASE };
