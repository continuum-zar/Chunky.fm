/**
 * Asking to say something, from the listener's side.
 *
 * Two small pure things, and one of them earns a test more than it looks like
 * it should. `secondsLeft` counts down an invitation against the *station's*
 * clock rather than sixty seconds of its own, so the number on screen and the
 * moment the offer actually lapses are the same moment; a countdown that
 * drifted would let somebody press a button that had already stopped working.
 */
import { describe, expect, it, vi } from 'vitest'
import { AdminApi } from '../src/lib/admin.js'
import { deafened, handRefusal, secondsLeft } from '../src/lib/hand.js'
import type { SocketErrorCode } from '../src/lib/protocol.js'

describe('handRefusal', () => {
  it('says what did not happen before it says why', () => {
    // The shape `wishRefusal` uses, and for the same reason: somebody who
    // pressed a button and saw nothing move needs the first half more.
    for (const code of ['slow_down', 'not_joined', 'off_air', 'muted', 'no_floor'] as const) {
      expect(handRefusal(code), code).toMatch(/^Not asked\./)
    }
  })

  it('does not call a lapsed invitation a failure', () => {
    // The one refusal here a listener can reach without doing anything wrong.
    // "Not asked" would be untrue and would read as their fault.
    expect(handRefusal('not_invited')).toBe('That offer is no longer open.')
  })

  it('says nothing about a code a listener cannot act on', () => {
    // A signalling refusal reaching this composer would put words about peer
    // connections under a button about putting your hand up.
    for (const code of ['not_the_decks', 'no_such_peer', 'wish_too_long'] as SocketErrorCode[]) {
      expect(handRefusal(code), code).toBeNull()
    }
  })
})

describe('secondsLeft', () => {
  it('rounds up, so the last second is shown rather than skipped', () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(10_001, 10_000)).toBe(1)
  })

  it('floors at zero rather than counting into the past', () => {
    // The offer has lapsed at the station. A negative number on a button is a
    // page still offering something that is gone.
    expect(secondsLeft(10_000, 12_000)).toBe(0)
  })

  it("reads the station clock, not this browser's", () => {
    // Both arguments are the caller's: nothing here reaches for `Date.now`, so
    // a page whose clock is a minute out still counts the station's minute.
    const expiresAt = 1_700_000_060_000
    expect(secondsLeft(expiresAt, 1_700_000_000_000)).toBe(60)
  })
})

describe('deafened', () => {
  const mic = (live: boolean, duckTo = 0.2) => ({ live, duckTo })

  it('leaves the music alone when nothing is happening', () => {
    expect(deafened(false, mic(false))).toBe(1)
    expect(deafened(false, null)).toBe(1)
  })

  it('follows the station down for an ordinary mic break', () => {
    expect(deafened(false, mic(true, 0.2))).toBe(0.2)
  })

  it('takes a caller\'s own music away entirely', () => {
    // The strongest move available to a call-in, and the reason it is silence
    // rather than the duck depth: there is then no music coming out of their
    // speakers for their own microphone to pick up. It is also what being a
    // caller on real radio sounds like.
    expect(deafened(true, mic(true, 0.2))).toBe(0)
  })

  it('does so even before the station has ducked for them', () => {
    // The two arrive on different frames — the floor says who is up, the mic
    // says the room has ducked — and a caller hearing a bar of full-volume
    // music into an open microphone is the gap between them.
    expect(deafened(true, mic(false))).toBe(0)
    expect(deafened(true, null)).toBe(0)
  })
})

describe('the floor, over HTTP', () => {
  const calls: { url: string; body: unknown }[] = []
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body ?? 'null')) })
    return new Response(JSON.stringify({ speaker: null, invited: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const api = () => new AdminApi({ fetch: fetchStub as unknown as typeof globalThis.fetch })

  it('sends the listener to invite, and no listener to drop', async () => {
    calls.length = 0

    await api().floor('invite', 7)
    await api().floor('drop')

    expect(calls[0]).toEqual({ url: '/api/floor', body: { action: 'invite', listener: 7 } })
    // `undefined` does not survive JSON, which is the absent the station's
    // schema describes: there is no such thing as dropping a particular person,
    // because there is only ever one of them.
    expect(calls[1]).toEqual({ url: '/api/floor', body: { action: 'drop' } })
  })
})
