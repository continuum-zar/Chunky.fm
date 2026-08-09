/**
 * `/api/mic`: the four verbs, and where the gate is.
 *
 * Opening the mic is a command like any other and goes over HTTP for the reason
 * every command does — that is where the admin gate is — however live it feels.
 * The socket carries the `mic` frame the other way and nothing back; a client
 * that tries is refused by name. See `mic.test.ts` for that half.
 *
 * The read is deliberately open, like `/api/session` and unlike `/api/mutes`.
 * Whether somebody is talking is not a secret: it is broadcast to every
 * listener a moment later anyway. What needs the password is changing it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DUCK, MIN_DUCK } from '../src/mic.js'
import { type Harness, signIn, startHarness } from './helpers.js'

let harness: Harness
let cookie: string

beforeEach(async () => {
  harness = await startHarness()
  cookie = await signIn(harness)
})
afterEach(() => harness.cleanup())

async function post(
  payload: Record<string, unknown>,
  headers: Record<string, string> = { cookie },
) {
  return await harness.app.inject({ method: 'POST', url: '/api/mic', payload, headers })
}

describe('GET /api/mic', () => {
  it('is open, and answers the whole snapshot', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/mic' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ live: false, duckTo: DEFAULT_DUCK, since: null })
  })
})

describe('POST /api/mic', () => {
  it('is admin-only', async () => {
    for (const payload of [{ action: 'open' }, { action: 'close' }, { action: 'duck', duckTo: 0.5 }]) {
      const res = await post(payload, {})
      expect(res.statusCode, JSON.stringify(payload)).toBe(401)
    }
    expect(harness.mic.live).toBe(false)
    expect(harness.mic.duckTo).toBe(DEFAULT_DUCK)
  })

  it('opens the mic and answers with the state it produced', async () => {
    const res = await post({ action: 'open' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ live: true, duckTo: DEFAULT_DUCK })
    expect(res.json().since).toEqual(expect.any(Number))
    expect(harness.mic.live).toBe(true)
  })

  it('is idempotent, so a key held down is not a hundred openings', async () => {
    for (let i = 0; i < 3; i++) expect((await post({ action: 'open' })).statusCode).toBe(200)
    expect(harness.mic.live).toBe(true)
  })

  it('shuts the mic, and shutting a shut mic is not an error', async () => {
    await post({ action: 'open' })
    expect((await post({ action: 'close' })).json()).toMatchObject({ live: false, since: null })
    expect((await post({ action: 'close' })).statusCode).toBe(200)
    expect(harness.mic.live).toBe(false)
  })

  it('renews without opening', async () => {
    // The reason `renew` is its own verb: a keep-alive still in flight when the
    // key came up must not put the station back on mic behind the person who
    // just stopped talking.
    const res = await post({ action: 'renew' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ live: false })
    expect(harness.mic.live).toBe(false)
  })

  it('refuses to open the mic off air', async () => {
    // Nothing to talk over, and a mic opened against a shut station would duck
    // a room that is not listening to anything.
    harness.air.end()

    const res = await post({ action: 'open' })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'off_air' })
    expect(harness.mic.live).toBe(false)
  })

  it('still lets the fader move off air', async () => {
    // Setting up before the doors open is the ordinary case, and the depth is
    // not a claim about a broadcast that is happening.
    harness.air.end()
    expect((await post({ action: 'duck', duckTo: 0.4 })).statusCode).toBe(200)
    expect(harness.mic.duckTo).toBe(0.4)
  })

  it('sets the depth and answers with what the station now holds', async () => {
    const res = await post({ action: 'duck', duckTo: 0.35 })
    expect(res.json()).toMatchObject({ duckTo: 0.35 })
    expect(harness.mic.duckTo).toBe(0.35)
  })

  it('wants a depth with the depth verb', async () => {
    const res = await post({ action: 'duck' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'missing_duck' })
  })

  it('refuses a body it cannot act on', async () => {
    const refused: Record<string, unknown>[] = [
      {},
      { action: 'talk' },
      { action: 'open', duckTo: 'quiet' },
      // Bounded at the door as well as clamped in `Mic`, so a depth the fader
      // could not draw never reaches the station, whatever it came through.
      { action: 'duck', duckTo: 0 },
      { action: 'duck', duckTo: MIN_DUCK / 2 },
      { action: 'duck', duckTo: 1.5 },
    ]
    for (const payload of refused) {
      const res = await post(payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(harness.mic.live).toBe(false)
    expect(harness.mic.duckTo).toBe(DEFAULT_DUCK)
  })

  it('keeps the fader across a session and takes the mic with it', async () => {
    await post({ action: 'duck', duckTo: 0.5 })
    await post({ action: 'open' })

    harness.air.end()

    expect(harness.mic.live).toBe(false)
    expect(harness.mic.duckTo).toBe(0.5)
  })
})
