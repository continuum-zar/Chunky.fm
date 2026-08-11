/**
 * Whether somebody is fit to go on air, decided before they are.
 *
 * Whoever runs the decks read a warning about headphones, chose their own
 * machine and set it up. A guest is whoever put their hand up, on whatever they
 * happened to be holding, and the failure they are about to cause is one they
 * cannot hear: a laptop playing the station out loud with an open microphone in
 * front of it sends the room a smeared copy of the record it is already
 * playing, and then a howl. So this is a gate rather than advice, and it is the
 * one thing standing between a raised hand and a live microphone.
 *
 * Two checks, in this order, and the second is the one that matters.
 *
 * **Say something.** Proves the right device is open and the browser is really
 * handing over audio. Catches a microphone muted in hardware, which is the
 * commonest way this fails and the one somebody would otherwise discover in
 * front of thirty people.
 *
 * **Now don't.** A couple of seconds of quiet. This is the speaker detector,
 * and it works for a reason worth being deliberate about: **the guest's music is
 * still playing while it runs.** They have not come up yet, so the station is
 * coming out of whatever they are listening on, and if that is a speaker their
 * microphone hears it. On headphones it hears nothing. The check is not really
 * asking whether the room is quiet; it is asking whether the room can hear the
 * station, which is the actual question.
 *
 * It follows that this must run *before* the local music is ducked away for
 * somebody going up, and that a check run during a gap between tracks has
 * nothing to detect. Neither is worth engineering around: the first is an
 * ordering the page already has, and the second is a few seconds an evening.
 */

/**
 * Loud enough to be a person talking, as RMS.
 *
 * About −28 dBFS. Comfortably above a room and comfortably below anything
 * anybody would call speaking up, so a quiet talker passes and a fan does not.
 */
export const SPEAKING = 0.04

/**
 * Quiet enough that nothing is coming in, as RMS.
 *
 * About −38 dBFS. The gap between this and `SPEAKING` is deliberately wide:
 * what sits in between is a room with something in it, and the whole point is
 * to be sure rather than to be sensitive.
 */
export const QUIET = 0.012

/** How long they have to keep talking. Long enough not to trip on a cough. */
export const SPEAK_MS = 400

/** And how long they have to stop for. Long enough to be a silence. */
export const QUIET_MS = 1_500

/**
 * How long the quiet half will wait before calling it.
 *
 * Somebody who cannot manage a second and a half of silence in six seconds has
 * something making noise into their microphone, and the most likely something
 * is the station itself. Long enough not to punish a passing car; short enough
 * that a guest is not left staring at a bar while an invitation runs out.
 */
export const QUIET_BUDGET_MS = 6_000

export type CheckStage =
  /** Waiting to hear anything at all. */
  | 'speak'
  /** Heard them; now waiting for them to stop. */
  | 'quiet'
  /** Both halves done. The only stage from which somebody may go up. */
  | 'passed'
  /** Something is coming into the microphone that should not be. */
  | 'noisy'

export interface Check {
  stage: CheckStage
  /** Time held in whatever the current stage is waiting for. Reset by a lapse. */
  heldMs: number
  /** Time spent in the current stage altogether, for the half that gives up. */
  spentMs: number
}

export const CHECK_START: Check = { stage: 'speak', heldMs: 0, spentMs: 0 }

/**
 * Where the check stands after one more frame.
 *
 * A reducer over the *raw* level rather than the smoothed one the meter draws.
 * The meter falls slowly on purpose — it is showing the shape of a sentence —
 * and a decision about whether a room is quiet made on a needle that takes a
 * fifth of a second to come down would keep failing rooms that had already gone
 * silent.
 *
 * Both terminal stages stay put. Trying again is a fresh `CHECK_START` from
 * whatever is driving this, so a retry is a decision somebody made rather than
 * a level that happened to dip.
 */
export function nextCheck(check: Check, level: number, sinceMs: number): Check {
  if (check.stage === 'passed' || check.stage === 'noisy') return check

  const spentMs = check.spentMs + sinceMs

  if (check.stage === 'speak') {
    // Cumulative rather than continuous: speech is mostly gaps, and demanding
    // four hundred unbroken milliseconds would fail somebody saying "hello".
    const heldMs = level >= SPEAKING ? check.heldMs + sinceMs : check.heldMs
    if (heldMs >= SPEAK_MS) return { stage: 'quiet', heldMs: 0, spentMs: 0 }
    return { stage: 'speak', heldMs, spentMs }
  }

  // Continuous, and reset by anything at all: the question is whether there is
  // a stretch of silence, and a room that is quiet half the time is a room with
  // something in it.
  const heldMs = level <= QUIET ? check.heldMs + sinceMs : 0
  if (heldMs >= QUIET_MS) return { stage: 'passed', heldMs, spentMs }
  if (spentMs >= QUIET_BUDGET_MS) return { stage: 'noisy', heldMs, spentMs }
  return { stage: 'quiet', heldMs, spentMs }
}

/** What to tell somebody, at each stage. The gate has to explain itself. */
export function checkNotice(stage: CheckStage): string {
  switch (stage) {
    case 'speak':
      return 'Say something, and watch the bar move.'
    case 'quiet':
      return 'Now stop talking for a moment.'
    case 'passed':
      return "That's you. You can go up."
    case 'noisy':
      // Both causes, because the guest cannot tell which one it was and the fix
      // for the one that matters is the same either way.
      return 'Something is coming into your microphone. If the station is playing out of speakers, headphones will fix it — otherwise find somewhere quieter.'
  }
}
