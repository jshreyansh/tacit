// Thresholds tuned for Magic Trackpad / MacBook trackpad wheel events.
// These are prototype values — adjust after real-world testing.
const SWIPE_MIN_DELTA_X = 80; // px accumulated horizontally
const SWIPE_MAX_DELTA_Y = 60; // px accumulated vertically (reject diagonal)
const SWIPE_MAX_DURATION = 500; // ms — quick flick, not a pan
const SWIPE_MIN_EVENTS = 2; // need at least 2 wheel events
const SWIPE_IDLE_TIMEOUT = 120; // ms between events to consider a new gesture

// After a trigger, macOS keeps emitting a long, smoothly-decaying tail of
// momentum wheel events — values like -113, -110, -106 … arriving at the
// normal ~60Hz rate for a second or more after the fingers have left.
//
// Releasing that cooldown on the tail's own amplitude, or on a fixed elapsed
// time, is what made focus mode skip a node: whichever released first let the
// REMAINING tail through, and a few dozen decaying samples still accumulate
// past the trigger distance inside the duration window. Swipe A→B, arrive at
// B, land on C a second later having touched nothing.
//
// The reliable end-of-gesture signal is a gap in the stream. Momentum never
// pauses until it genuinely stops, and a human's next swipe always follows one
// — fingers have to lift and reposition. So the cooldown ends when the wheel
// goes quiet, not when its numbers get small.
const SWIPE_MOMENTUM_QUIET_GAP = 120; // ms of silence that means the tail ended
// Pure safety net for a device that somehow streams without ever pausing. It
// releases the cooldown but deliberately CONSUMES the sample that trips it,
// so an unbroken stream can never seed a gesture — the failure it exists to
// prevent is a lockout, not a missed swipe.
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

  return {
    handleWheel(event: SwipeInput): SwipeResult {
      const now = Date.now();

      // Absorb the momentum tail of the gesture we just fired, until the wheel
      // actually goes quiet. See SWIPE_MOMENTUM_QUIET_GAP for why silence is
      // the signal rather than the tail's amplitude or a fixed duration.
      if (cooldownStartedAt !== null) {
        if (now - lastCooldownEventAt >= SWIPE_MOMENTUM_QUIET_GAP) {
          // The stream paused, so the previous gesture is physically over and
          // this event belongs to a new one. Fall through and let it start.
          cooldownStartedAt = null;
        } else if (now - cooldownStartedAt > SWIPE_COOLDOWN_HARD_CAP) {
          // Never observed a pause. Release so the detector cannot lock up,
          // but consume this sample — an unbroken stream is not a swipe.
          cooldownStartedAt = null;
          lastCooldownEventAt = now;
          return { triggered: false };
        } else {
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
        tracker = null;
        return { triggered: true, direction };
      }

      return { triggered: false };
    },

    reset() {
      tracker = null;
      cooldownStartedAt = null;
      lastCooldownEventAt = 0;
    },
  };
}
