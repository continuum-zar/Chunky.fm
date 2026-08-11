import type { SocketErrorCode } from './protocol.js'

/**
 * Asking to say something, from the listener's side.
 *
 * The station's half of this is `floor.ts` on the server; this is the small
 * amount of it that is a pure function and therefore testable away from React.
 */

/**
 * Why a hand was refused, in words, or null when the code says nothing a
 * listener can act on.
 *
 * Mirrors `wishRefusal`, including the shape of the sentence: what did not
 * happen, then why. A listener who pressed a button and saw nothing move needs
 * the first half more than the second.
 */
export function handRefusal(code: SocketErrorCode): string | null {
  switch (code) {
    case 'slow_down':
      return 'Not asked. You are changing your mind faster than the station will take it.'
    case 'not_joined':
      return 'Not asked. The station has not finished putting you in the room yet.'
    case 'no_floor':
      return 'Not asked. Nobody but the decks talks on this station.'
    case 'off_air':
      return 'Not asked. The station is not on air.'
    case 'muted':
      return 'Not asked. Whoever runs the decks has muted you.'
    case 'not_invited':
      // The one refusal here a listener can reach without doing anything wrong:
      // an invitation that lapsed, or was withdrawn, while they were reaching
      // for it. Worth saying plainly rather than as a failure.
      return 'That offer is no longer open.'
    default:
      return null
  }
}

/**
 * Where this listener's own music should sit while all this is going on, as a
 * linear gain.
 *
 * The interesting case is the first one, and it is the strongest move available
 * to a call-in: **a caller hears the studio, not the record.** While somebody is
 * up, their own copy of the music goes to silence — not to the duck depth, all
 * the way down.
 *
 * That removes the entire acoustic-echo problem in one line, because there is
 * no music coming out of their speakers for their microphone to pick up. It
 * also happens to be exactly what being a caller on real radio sounds like, so
 * it needs no explaining to the person it happens to. And it costs nothing to
 * undo: position is a pure function of the station clock, so coming back down
 * is not a resynchronisation, it is a volume.
 *
 * Zero here against `MIN_DUCK` on the station, and the difference is the point.
 * The station never ducks to silence because a listener who cannot hear the bed
 * has no way to tell a mic break from the station having died. Somebody holding
 * a microphone and watching their own meter is in no doubt.
 *
 * Note what this does *not* cover: the sound check, which runs before anybody
 * is up and must have the music playing, because a microphone that can hear the
 * station is exactly what it is looking for.
 */
export function deafened(
  speaking: boolean,
  mic: { live: boolean; duckTo: number } | null,
): number {
  if (speaking) return 0
  return mic?.live ? mic.duckTo : 1
}

/**
 * How long is left on an invitation, in whole seconds, floored at zero.
 *
 * Counted down on the page rather than trusted from a timer, because the number
 * that matters is the station's: `expiresAt` is on the station clock, and a
 * page that counted its own sixty seconds would drift away from the moment the
 * offer actually lapses.
 */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}
