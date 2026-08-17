/**
 * Which record sits on which deck, and why it is not simply "the current one".
 *
 * A crossfade is two records playing at once, so a listener needs two audio
 * elements. The obvious arrangement — element one always plays what is on,
 * element two always plays what is fading out — is wrong in a way that is
 * silent until you hear it: at the instant a transition begins it would ask
 * element two to load, seek and start a record that element one has been
 * playing perfectly for four minutes. Even from cache that is a decode and a
 * seek at exactly the moment nothing is allowed to stutter.
 *
 * So the decks **alternate**. The outgoing record stays on the deck it was
 * already playing on, untouched, and the incoming one goes onto the other. The
 * cost is that neither deck is "the" deck, which is what this module exists to
 * keep track of.
 *
 * Pure, and separate from the hook that drives it, because the interesting
 * cases are all about sequence — three transitions in a row, the same record
 * queued twice, a cut in the middle of a blend — and none of them needs an
 * `<audio>` element to be wrong.
 */

import { type Deck, otherDeck } from './audio-graph.js'
import { type StateMessage, audioUrl } from './protocol.js'

export type { Deck }

/** What each deck should be playing, and which of them is the record that is on. */
export interface Decking {
  /** The deck holding what the station says is playing now. */
  front: Deck
  /** The URL each deck should be pointed at. Null unloads it. */
  urls: Record<Deck, string | null>
}

/** Silence, on both decks. Where a page starts. */
export const NO_DECKS: Decking = { front: 'a', urls: { a: null, b: null } }

/**
 * Where the two records should sit, given where they sat a moment ago.
 *
 * Three rules, in order, and the order is the whole of it:
 *
 * 1. **Never move a record that is already playing.** If either deck is already
 *    pointed at the incoming URL, that deck is the front and nothing is
 *    reloaded. This is what makes the ordinary frame — a `state` re-broadcast
 *    for a pause, a seek, a reconnect — cost nothing at all.
 * 2. **Never land on the outgoing record's deck.** It is mid-fade and mid-song;
 *    pointing it somewhere else would cut it dead in the middle of the
 *    transition it is half of.
 * 3. **Otherwise stay put.** With nothing fading out there is no reason to
 *    alternate, and swapping decks for its own sake would mean the back deck
 *    accumulating a record nobody is listening to.
 *
 * Rule 1 has one exception, and it is the one that would have been found in
 * production rather than here: **the same record can follow itself.** Somebody
 * queues a track twice, or plays it and blends into it again. Then the incoming
 * URL is already on a deck — the one it is fading out on — and reusing it would
 * be a record crossfading into itself on one element, which is one record. So
 * rule 2 wins over rule 1 when they disagree.
 */
export function nextDecking(
  previous: Decking,
  incomingUrl: string | null,
  outgoingUrl: string | null,
): Decking {
  if (incomingUrl === null) return { front: previous.front, urls: { a: null, b: null } }

  // Which deck, if any, is carrying the record on its way out. Only meaningful
  // while there is one: `outgoingUrl` is null the rest of the time, and a deck
  // holding null must not be mistaken for holding it.
  const fading: Deck | null =
    outgoingUrl === null
      ? null
      : previous.urls.a === outgoingUrl
        ? 'a'
        : previous.urls.b === outgoingUrl
          ? 'b'
          : null

  const already: Deck | null =
    previous.urls.a === incomingUrl ? 'a' : previous.urls.b === incomingUrl ? 'b' : null

  const front =
    already !== null && already !== fading
      ? already
      : fading !== null
        ? otherDeck(fading)
        : previous.front

  return {
    front,
    urls: {
      [front]: incomingUrl,
      // Whatever is fading out, or nothing. Unloading the back deck the moment
      // a transition ends is deliberate: an element left pointed at a finished
      // record goes on holding its buffer for the rest of the evening.
      [otherDeck(front)]: outgoingUrl,
    } as Record<Deck, string | null>,
  }
}

/**
 * What is fading out right now, or null.
 *
 * The station stops describing a blend once it is over, but only by *not
 * changing* — no frame is broadcast at the far end of a transition, because
 * nothing happens there that a page cannot work out from the two instants it
 * already has. So a `state` that has been sitting in a client for ten minutes
 * still carries the last transition's `outgoing`, and reading it without
 * checking the clock would leave a record on the back deck all evening.
 */
export function fadingNow(state: StateMessage, serverNow: number): StateMessage['outgoing'] {
  const outgoing = state.outgoing
  if (!outgoing) return null
  return serverNow < outgoing.endsAt ? outgoing : null
}

/** Where the outgoing record's needle should be, in seconds. */
export function outgoingPositionSeconds(
  outgoing: NonNullable<StateMessage['outgoing']>,
  serverNow: number,
): number {
  const positionMs = serverNow - outgoing.startedAt
  return Math.min(Math.max(positionMs, 0), outgoing.track.durationMs) / 1000
}

/** The decking a state implies, from scratch. Convenience over `nextDecking`. */
export function deckingFor(
  previous: Decking,
  state: StateMessage,
  serverNow: number,
): Decking {
  const outgoing = fadingNow(state, serverNow)
  return nextDecking(
    previous,
    state.track ? audioUrl(state.track) : null,
    outgoing ? audioUrl(outgoing.track) : null,
  )
}
