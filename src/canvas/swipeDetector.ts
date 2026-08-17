// Thresholds tuned for Magic Trackpad / MacBook trackpad wheel events.
// These are prototype values — adjust after real-world testing.
const SWIPE_MIN_DELTA_X = 80; // px accumulated horizontally
const SWIPE_MAX_DELTA_Y = 60; // px accumulated vertically (reject diagonal)
const SWIPE_MAX_DURATION = 500; // ms — quick flick, not a pan
const SWIPE_MIN_EVENTS = 2; // need at least 2 wheel events
const SWIPE_IDLE_TIMEOUT = 120; // ms between events to consider a new gesture

// After a trigger, macOS keeps emitting a long, smoothly-decaying tail of
// momentum wheel events — values like -113, -110, -106 … at the normal ~60Hz
// rate for a second or more after the fingers have left. Those are not a
// gesture and must never page again.
//
// THE REAL FIX, once it is available: Chromium exposes a `momentum` boolean on
// wheel events from Chrome 151 — the platform stating it outright, the same
// information macOS has always had natively as NSEvent.momentumPhase. Electron
// 41 here is Chromium 146 and does not have it; verified directly, including
// with the experimental Blink flag forced on. When Electron reaches Chromium
// 151+, delete all of this and branch on `event.momentum`.
//
// Until then, momentum is separated from a gesture by SHAPE, not by timing.
// Two earlier attempts got this wrong in opposite directions:
//
//   - Releasing the cooldown on the tail's own amplitude cannot work, because a
//     decaying tail passes through every amplitude on its way down. The release
//     was guaranteed to fire mid-tail and let the rest through, which is what
//     paged a second time on its own.
//   - Releasing only after a gap of silence fails the other way. A real tail
//     lasts about a second, so a second swipe lands inside it, is absorbed, and
//     resets the quiet clock — measured at roughly two swipes registering in
//     five when paging quickly.
//
// Momentum only ever decays; a hand rises. So the cooldown ends when a sample
// breaks the decay curve — clearly above the recent trend. That is how
// Lethargy, the established JS library for this problem, separates the two, and
// it is what the platform flag encodes natively.
const MOMENTUM_WINDOW = 4; // samples averaged, so one jittery reading can't flip it
const MOMENTUM_RISE_FACTOR = 1.5; // how far above the trend reads as a new gesture
// A single sample above the trend is not enough. The swipe that fired is still
// in progress when the cooldown opens — it triggers partway through, and its
// remaining samples can legitimately be larger than the ones that met the
// threshold. One rise is therefore ambiguous; a hand accelerating produces
// several in a row, while a decaying tail produces none.
const MOMENTUM_RISES_TO_BREAK = 2;
// Absolute floor, the second lesson from Lethargy: the tail's low end is never a
// gesture however the ratio reads. Without it, decay from 3px to 6px is a "2x
// rise", and a long crawl of tiny samples can still accumulate past the trigger.
const MOMENTUM_FLOOR = 12; // px
// Secondary release for the unhurried case that never breaks the curve: the tail
// genuinely ended and the wheel went quiet.
const SWIPE_MOMENTUM_QUIET_GAP = 120; // ms
// Pure lockout guard for a stream that somehow never pauses and never rises.
// Releases, but CONSUMES the sample that trips it — an unbroken stream must
// never be able to seed a gesture.
const SWIPE_COOLDOWN_HARD_CAP = 3000; // ms

interface SwipeTracker {
  startTime: number;
  accumulatedX: number;
  accumulatedY: number;
  signedX: number;
  eventCount: number;
  lastEventTime: number;
}

export interface SwipeInput {
  deltaX: number;
  deltaY: number;
}

export interface SwipeResult {
  triggered: boolean;
  /**
   * +1 / -1 once triggered, undefined otherwise. Sign convention here is a
   * guess (positive accumulated deltaX -> +1) — trackpad "natural scrolling"
   * flips this per-device/per-user, so verify on real hardware and flip
   * this one line if next/previous come out backwards.
   */
  direction?: 1 | -1;
}

/**
 * Shared two-finger horizontal swipe detector — originally built for the
 * clear-focus gesture (see trackpadSwipeFocus.ts, still using it
 * unmodified), reused here (src/canvas/XyFlowCanvas.tsx's focus-mode
 * paging) rather than re-tuning thresholds from scratch. Each call site
 * should hold its own instance (independent gesture state).
 */
export function createSwipeDetector() {
  let tracker: SwipeTracker | null = null;
  let cooldownStartedAt: number | null = null;
  let lastCooldownEventAt = 0;
  /** Recent tail magnitudes, newest last — the decay curve being tracked. */
  let cooldownWindow: number[] = [];
  let consecutiveRises = 0;

  const endCooldown = () => {
    cooldownStartedAt = null;
    cooldownWindow = [];
    consecutiveRises = 0;
  };

  return {
    handleWheel(event: SwipeInput): SwipeResult {
      const now = Date.now();

      // Absorb the momentum tail of the gesture just fired, until something
      // arrives that momentum cannot explain. See the notes on
      // MOMENTUM_RISE_FACTOR for why shape rather than timing.
      if (cooldownStartedAt !== null) {
        const magnitude = Math.max(
          Math.abs(event.deltaX),
          Math.abs(event.deltaY),
        );
        const trend =
          cooldownWindow.length > 0
            ? cooldownWindow.reduce((a, b) => a + b, 0) / cooldownWindow.length
            : magnitude;

        // A hand accelerating; momentum only ever slows. Floored so the tail's
        // low end can't produce a large ratio out of two small numbers.
        const rising =
          magnitude >= MOMENTUM_FLOOR && magnitude > trend * MOMENTUM_RISE_FACTOR;
        consecutiveRises = rising ? consecutiveRises + 1 : 0;
        const brokeDecay = consecutiveRises >= MOMENTUM_RISES_TO_BREAK;
        const wentQuiet = now - lastCooldownEventAt >= SWIPE_MOMENTUM_QUIET_GAP;

        if (brokeDecay || wentQuiet) {
          // A new gesture. Fall through so this sample starts it rather than
          // being swallowed — waiting for the next one loses the swipe's onset.
          endCooldown();
        } else if (now - cooldownStartedAt > SWIPE_COOLDOWN_HARD_CAP) {
          // Never rose, never paused. Release so the detector cannot lock up,
          // but consume this sample: an unbroken stream is not a swipe.
          endCooldown();
          lastCooldownEventAt = now;
          return { triggered: false };
        } else {
          cooldownWindow.push(magnitude);
          if (cooldownWindow.length > MOMENTUM_WINDOW) cooldownWindow.shift();
          lastCooldownEventAt = now;
          return { triggered: false };
        }
      }

      // Start a new sequence if idle for too long
      if (!tracker || now - tracker.lastEventTime > SWIPE_IDLE_TIMEOUT) {
        tracker = {
          startTime: now,
          accumulatedX: 0,
          accumulatedY: 0,
          signedX: 0,
          eventCount: 0,
          lastEventTime: now,
        };
      }

      tracker.accumulatedX += Math.abs(event.deltaX);
      tracker.accumulatedY += Math.abs(event.deltaY);
      tracker.signedX += event.deltaX;
      tracker.eventCount++;
      tracker.lastEventTime = now;

      const duration = now - tracker.startTime;

      // Reject if too much vertical drift (diagonal scroll)
      if (tracker.accumulatedY > SWIPE_MAX_DELTA_Y) {
        tracker = null;
        return { triggered: false };
      }

      // Reject if the gesture drags on too long (it's a pan, not a flick)
      if (duration > SWIPE_MAX_DURATION) {
        tracker = null;
        return { triggered: false };
      }

      // Trigger: enough horizontal distance, enough events, fast enough
      if (
        tracker.accumulatedX >= SWIPE_MIN_DELTA_X &&
        tracker.eventCount >= SWIPE_MIN_EVENTS &&
        duration <= SWIPE_MAX_DURATION
      ) {
        const direction: 1 | -1 = tracker.signedX >= 0 ? 1 : -1;
        cooldownStartedAt = now;
        lastCooldownEventAt = now;
        // Seed the curve with the gesture's own last sample, so the tail is
        // compared against where it started decaying from rather than against
        // its own first reading.
        cooldownWindow = [Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY))];
        tracker = null;
        return { triggered: true, direction };
      }

      return { triggered: false };
    },

    reset() {
      tracker = null;
      endCooldown();
      lastCooldownEventAt = 0;
    },
  };
}
