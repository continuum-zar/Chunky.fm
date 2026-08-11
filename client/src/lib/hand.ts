import type { SocketErrorCode } from './protocol.js'

/**
 * Asking to say something, from the listener's side.
 *
 * The station's half of this is `floor.ts` on the server; this is the small
 * amount of it that is a pure function and therefore testable away from React.
 */

/**
 * Whether a guest's voice actually travels yet.
 *
 * False, and deliberately visible rather than implied. The floor is built
 * before the voice is — the permission, the invitation, the room ducking, the
 * badge with somebody's name on it — because all of that is worth living with
 * for an evening before anything harder is committed to. What it means until
 * the talk channel exists is that somebody can be brought up, be told they are
 * up, and not be heard by anybody.
 *
 * A page that said "everyone can hear you" under those conditions would be
 * lying to the one person who cannot check. So it says the true thing instead,
 * and this constant is what turns that sentence off again. Delete it, and the
 * branch it guards, when a voice arrives.
 */
export const VOICE_CARRIES = false

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
