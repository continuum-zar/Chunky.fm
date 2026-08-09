/**
 * How a browser finds out how to reach another browser.
 *
 * The voice is peer-to-peer and never touches this server, which is the whole
 * reason a microphone costs nothing to run. What two browsers behind two
 * routers do need is help discovering each other, and this is the only part of
 * that the station has anything to do with: handing over the addresses to ask.
 *
 * The reason it is an endpoint rather than a constant in the bundle is the TURN
 * credential. A relay password sitting in a JavaScript file is a relay anybody
 * who loads the page can spend, from anywhere, for as long as it is valid.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { iceServers } from '../src/routes/rtc.js'
import { type Harness, signIn, startHarness } from './helpers.js'

let harness: Harness
afterEach(() => harness?.cleanup())

describe('iceServers', () => {
  it('is empty when nothing is configured', async () => {
    // A real way to run this, and not the default: host candidates only, which
    // works for everybody on the same network and nobody beyond it.
    harness = await startHarness()
    expect(iceServers(harness.config)).toEqual([])
  })

  it('puts every STUN address in one entry', async () => {
    // One entry with many URLs rather than many entries: the shape the browser
    // prefers, and the one that lets it try them in parallel.
    harness = await startHarness({ stunUrls: ['stun:a:3478', 'stun:b:3478'] })
    expect(iceServers(harness.config)).toEqual([{ urls: ['stun:a:3478', 'stun:b:3478'] }])
  })

  it('carries the relay credentials alongside it', async () => {
    harness = await startHarness({
      stunUrls: ['stun:a:3478'],
      turn: {
        // What a provider actually hands you: the fast path, the one that
        // survives a network with no UDP, and the one that gets through a
        // firewall which only believes in HTTPS.
        urls: ['turn:relay:3478', 'turn:relay:80?transport=tcp', 'turns:relay:443?transport=tcp'],
        username: 'sam',
        credential: 'hunter2',
      },
    })
    expect(iceServers(harness.config)).toEqual([
      { urls: ['stun:a:3478'] },
      {
        urls: ['turn:relay:3478', 'turn:relay:80?transport=tcp', 'turns:relay:443?transport=tcp'],
        username: 'sam',
        credential: 'hunter2',
      },
    ])
  })
})

describe('GET /api/rtc', () => {
  it('is open on an open station, like the music it goes with', async () => {
    // The listener gate rather than the admin one, because both ends of a voice
    // need this: the decks to offer it and a listener to answer.
    harness = await startHarness({ stunUrls: ['stun:a:3478'] })
    const res = await harness.app.inject({ method: 'GET', url: '/api/rtc' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ iceServers: [{ urls: ['stun:a:3478'] }] })
  })

  it('is behind the door when there is one', async () => {
    // A relay credential is worth something, so it reaches exactly the people
    // already allowed to hear the station and nobody else.
    harness = await startHarness({
      stationKey: 'a-real-key',
      turn: { urls: ['turn:relay:3478'], username: 'sam', credential: 'hunter2' },
    })
    expect((await harness.app.inject({ method: 'GET', url: '/api/rtc' })).statusCode).toBe(401)

    const withKey = await harness.app.inject({
      method: 'GET',
      url: '/api/rtc',
      headers: { 'x-station-key': 'a-real-key' },
    })
    expect(withKey.statusCode).toBe(200)
  })

  it('answers whoever runs the decks, who never needs an invite to their own station', async () => {
    harness = await startHarness({ stationKey: 'a-real-key', stunUrls: ['stun:a:3478'] })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/rtc',
      headers: { cookie: await signIn(harness) },
    })
    expect(res.statusCode).toBe(200)
  })
})
