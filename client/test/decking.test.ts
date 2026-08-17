/**
 * Which record sits on which deck.
 *
 * The rule the whole crossfade rests on is *never move a record that is already
 * playing*. At the instant a transition begins, the outgoing record has been
 * streaming for four minutes and is exactly where it should be; asking the
 * other element to load, decode and seek it right then is a stutter at the one
 * moment nothing is allowed to stutter. So the decks alternate, and this is
 * what keeps track of which is which.
 *
 * Tested as a sequence rather than case by case, because the interesting
 * failures are all about the third transition rather than the first.
 */
import { describe, expect, it } from 'vitest'
import { NO_DECKS, deckingFor, fadingNow, nextDecking, outgoingPositionSeconds } from '../src/lib/decking.js'
import type { StateMessage, Track } from '../src/lib/protocol.js'

const track = (id: number, durationMs = 200_000): Track => ({
  id,
  title: `Track ${id}`,
  artist: null,
  album: null,
  durationMs,
  filename: `${id}.mp3`,
  artworkPath: null,
  contentHash: `hash-${id}`,
  gainDb: 0,
  uploadedAt: 0,
})

const url = (id: number) => `/api/audio/${id}.mp3`

describe('nextDecking', () => {
  it('puts the first record on the deck it starts on', () => {
    expect(nextDecking(NO_DECKS, url(1), null)).toEqual({
      front: 'a',
      urls: { a: url(1), b: null },
    })
  })

  it('changes nothing when the same record is described again', () => {
    // The ordinary frame: a `state` re-broadcast for a pause, a resume, a
    // reconnect. Reloading the element for one of these would be a hitch in the
    // middle of a song for no reason at all.
    const one = nextDecking(NO_DECKS, url(1), null)
    expect(nextDecking(one, url(1), null)).toEqual(one)
  })

  it('cuts on the same deck when there is nothing fading out', () => {
    // No reason to alternate: swapping decks for its own sake would leave the
    // back deck holding a record nobody is listening to.
    const one = nextDecking(NO_DECKS, url(1), null)
    expect(nextDecking(one, url(2), null)).toEqual({
      front: 'a',
      urls: { a: url(2), b: null },
    })
  })

  it('lands the incoming record on the other deck during a blend', () => {
    const one = nextDecking(NO_DECKS, url(1), null)
    const blending = nextDecking(one, url(2), url(1))

    expect(blending.front).toBe('b')
    // Untouched: still pointed where it was, still playing, still in time.
    expect(blending.urls.a).toBe(url(1))
    expect(blending.urls.b).toBe(url(2))
  })

  it('alternates across a run of transitions', () => {
    let decks = nextDecking(NO_DECKS, url(1), null)
    const fronts = [decks.front]

    for (let id = 2; id <= 6; id++) {
      decks = nextDecking(decks, url(id), url(id - 1))
      fronts.push(decks.front)
    }

    expect(fronts).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
  })

  it('holds the incoming record in place once the blend is over', () => {
    const one = nextDecking(NO_DECKS, url(1), null)
    const blending = nextDecking(one, url(2), url(1))
    // The far end of the transition: the station stops describing an outgoing
    // record and the incoming one must not move off the deck it is playing on.
    const after = nextDecking(blending, url(2), null)

    expect(after.front).toBe('b')
    expect(after.urls.b).toBe(url(2))
    // And the deck that was fading is emptied, so an element does not sit on a
    // finished record's buffer for the rest of the evening.
    expect(after.urls.a).toBeNull()
  })

  it('blends a record into itself on two decks rather than one', () => {
    // Somebody queued the same track twice. The naive rule — reuse the deck
    // that already holds this URL — would be a record crossfading with itself
    // on one element, which is one record playing.
    const one = nextDecking(NO_DECKS, url(1), null)
    const again = nextDecking(one, url(1), url(1))

    expect(again.front).toBe('b')
    expect(again.urls).toEqual({ a: url(1), b: url(1) })
  })

  it('clears both decks when the station goes quiet', () => {
    const one = nextDecking(NO_DECKS, url(1), null)
    expect(nextDecking(one, null, null)).toEqual({ front: 'a', urls: { a: null, b: null } })
  })
})

describe('fadingNow', () => {
  const state = (over: Partial<StateMessage> = {}): StateMessage => ({
    type: 'state',
    track: track(2),
    startedAt: 1_000_000,
    pausedAt: null,
    serverTime: 1_000_000,
    outgoing: null,
    ...over,
  })

  const outgoing = { track: track(1), startedAt: 800_000, endsAt: 1_004_000 }

  it('is the record itself while the window is open', () => {
    expect(fadingNow(state({ outgoing }), 1_002_000)).toBe(outgoing)
  })

  it('is nothing once the window has closed', () => {
    // The station broadcasts no frame at the far end of a transition — nothing
    // happens there a page cannot work out from the two instants it already
    // has — so a `state` sitting in a client for ten minutes still carries the
    // last blend. Reading it without checking the clock would leave a record on
    // the back deck all evening.
    expect(fadingNow(state({ outgoing }), 1_004_000)).toBeNull()
    expect(fadingNow(state({ outgoing }), 9_000_000)).toBeNull()
  })

  it('is nothing when nothing was ever fading', () => {
    expect(fadingNow(state(), 1_002_000)).toBeNull()
  })

  it('is what `deckingFor` reads to decide where the second record goes', () => {
    const during = deckingFor(
      { front: 'a', urls: { a: url(1), b: null } },
      state({ outgoing }),
      1_002_000,
    )
    expect(during).toEqual({ front: 'b', urls: { a: url(1), b: url(2) } })

    // And the same state, read after the window: one deck, no blend.
    const after = deckingFor({ front: 'b', urls: { a: url(1), b: url(2) } }, state({ outgoing }), 1_009_000)
    expect(after).toEqual({ front: 'b', urls: { a: null, b: url(2) } })
  })
})

describe('outgoingPositionSeconds', () => {
  it('is where the outgoing needle should be, on the station clock', () => {
    expect(
      outgoingPositionSeconds({ track: track(1), startedAt: 800_000, endsAt: 1_000_000 }, 900_000),
    ).toBe(100)
  })

  it('never runs past the end of the record it is on', () => {
    // A blend cut short leaves `endsAt` before the natural end; a blend that
    // overran would leave it after. Neither may seek past the file.
    expect(
      outgoingPositionSeconds({ track: track(1, 10_000), startedAt: 0, endsAt: 999_999 }, 500_000),
    ).toBe(10)
  })
})
