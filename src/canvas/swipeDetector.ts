// Thresholds tuned for Magic Trackpad / MacBook trackpad wheel events.
// These are prototype values — adjust after real-world testing.
const SWIPE_MIN_DELTA_X = 80; // px accumulated horizontally
const SWIPE_MAX_DELTA_Y = 60; // px accumulated vertically (reject diagonal)
const SWIPE_MAX_DURATION = 500; // ms — quick flick, not a pan
const SWIPE_MIN_EVENTS = 2; // need at least 2 wheel events
const SWIPE_IDLE_TIMEOUT = 120; // ms between events to consider a new gesture
// After a trigger, macOS keeps sending a long, smoothly-decaying tail of
// momentum wheel events — confirmed via real-device logging, values like
// -113, -110, -106, ... -57 arriving well under 300ms apart throughout the
// whole decay. A sliding idle-timeout on that stream never actually goes
// idle, so it never releases in time for the next real swipe. Releasing on
// amplitude instead — the first sample that decays back down near zero —
// tracks the physical gesture ending rather than guessing at a timing gap.
const SWIPE_MOMENTUM_RELEASE_DELTA = 8; // px — below this, momentum has settled
const SWIPE_COOLDOWN_MAX_DURATION = 900; // ms — hard cap if momentum never visibly settles

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

  return {
    handleWheel(event: SwipeInput): SwipeResult {
      const now = Date.now();

      // If we previously triggered, absorb the rest of that gesture's
      // momentum tail — but release the instant a sample decays down near
      // zero (the gesture has physically ended), not on a timing gap that
      // a dense momentum stream may never produce. The hard cap is just a
      // safety net for a tail that never visibly settles.
      if (cooldownStartedAt !== null) {
        const magnitude = Math.max(
          Math.abs(event.deltaX),
          Math.abs(event.deltaY),
        );
        const cooldownElapsed = now - cooldownStartedAt;
        const settled =
          magnitude < SWIPE_MOMENTUM_RELEASE_DELTA ||
          cooldownElapsed > SWIPE_COOLDOWN_MAX_DURATION;
        if (!settled) {
          return { triggered: false };
        }
        cooldownStartedAt = null;
        // Fall through — this low-amplitude/timed-out sample is free to
        // start a fresh gesture below rather than being consumed itself.
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
        tracker = null;
        return { triggered: true, direction };
      }

      return { triggered: false };
    },

    reset() {
      tracker = null;
      cooldownStartedAt = null;
    },
  };
}
