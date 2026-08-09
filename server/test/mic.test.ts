/**
 * Talking over the music.
 *
 * Three things are worth holding on to here, and the file is about those three.
 *
 * The first is that no sound goes through this. `Mic` is a fact and a number —
 * somebody is talking, the music should sit this far down — and the ducking
 * happens in thirty browsers that were already playing the track. Nothing in
 * this module can make or move audio, and nothing below asks it to.
 *
 * The second is the lease. A console that dies mid-sentence would otherwise
 * leave the whole room listening to a permanently quiet song, so an open mic
 * expires unless it is renewed, and `renew` is deliberately not `open`.
 *
 * The third is which half of this survives a session. The mic does not: nobody
 * is talking over a station that is off. The duck depth does, because it is a
 * fader position belonging to whoever runs the decks rather than a claim about
 * tonight's room.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DUCK, MIC_LEASE_MS, MIN_DUCK, Mic } from '../src/mic.js'
import { type Harness, fakeClock, signIn, startHarness } from './helpers.js'
import { TestClient } from './ws-client.js'

describe('Mic', () => {
  it('starts shut, at a depth it can already answer for', () => {
    // `duckTo` is a real value from the start rather than a null waiting for
    // the first break: a client asking how far the music would drop has an
    // answer whether or not anybody has talked yet, and the console's fader
    // has somewhere to sit.
    expect(new Mic().snapshot()).toEqual({ live: false, duckTo: DEFAULT_DUCK, since: null })
  })

  it('opens once, however many times it is asked', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    const heard = vi.fn()
    mic.on('change', heard)

    expect(mic.open()).toBe(true)
    expect(mic.open()).toBe(false)
    expect(mic.live).toBe(true)
    // One frame for the room, not one per press. The console holds a key down.
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('keeps `since` at the moment the break began, not the last keep-alive', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()
    const began = mic.snapshot().since

    clock.advance(4_000)
    mic.open()
    mic.renew()

    expect(mic.snapshot().since).toBe(began)
  })

  it('shuts once, however many times it is asked', () => {
    const mic = new Mic()
    mic.open()
    const heard = vi.fn()
    mic.on('change', heard)

    expect(mic.close()).toBe(true)
    expect(mic.close()).toBe(false)
    expect(mic.snapshot()).toMatchObject({ live: false, since: null })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('will not let a renew open the mic', () => {
    // The reason the two verbs are separate. The console beats on a timer while
    // the key is held, so a keep-alive still in flight when it was released
    // would put the station back on mic behind whoever just stopped talking.
    const mic = new Mic()
    const heard = vi.fn()
    mic.on('change', heard)

    expect(mic.renew()).toBe(false)
    expect(mic.live).toBe(false)
    expect(heard).not.toHaveBeenCalled()
  })

  it('renews quietly: the room learns nothing from a keep-alive', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()
    const heard = vi.fn()
    mic.on('change', heard)

    clock.advance(3_000)
    expect(mic.renew()).toBe(true)

    expect(heard).not.toHaveBeenCalled()
    expect(mic.expiresAt).toBe(clock.now() + MIC_LEASE_MS)
  })

  it('shuts a mic nobody is renewing', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()

    clock.advance(MIC_LEASE_MS - 1)
    expect(mic.sweep()).toBe(false)
    expect(mic.live).toBe(true)

    clock.advance(1)
    expect(mic.sweep()).toBe(true)
    expect(mic.live).toBe(false)
  })

  it('keeps a mic that is being renewed open indefinitely', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()

    // A console holding the key through a long link, beating every 3s against
    // a 10s lease. Two renewals can be lost and it still does not cut out.
    for (let i = 0; i < 20; i++) {
      clock.advance(3_000)
      mic.renew()
      expect(mic.sweep()).toBe(false)
    }

    expect(mic.live).toBe(true)
  })

  it('cuts a lease short without ending it', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    const heard = vi.fn()
    mic.open()
    mic.on('change', heard)

    expect(mic.hurry(2_000)).toBe(true)

    // Still on air: the console's socket going away is not proof it has gone,
    // and nothing about this is worth telling the room.
    expect(mic.live).toBe(true)
    expect(heard).not.toHaveBeenCalled()
    expect(mic.expiresAt).toBe(clock.now() + 2_000)
  })

  it('lets a renew undo the hurry, which is a console that only blipped', () => {
    // The case that makes this a hurry rather than a close. Renewals ride HTTP
    // and survive a socket wobble, so a console that is merely reconnecting
    // gets its full lease back without ever having gone off mic.
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()
    mic.hurry(2_000)

    clock.advance(1_500)
    mic.renew()
    clock.advance(1_000)

    expect(mic.sweep()).toBe(false)
    expect(mic.live).toBe(true)
  })

  it('lapses on its own when nothing renews after the hurry', () => {
    // And the case it exists for: a tab that was closed. Nothing renews, so
    // the room stops being ducked in seconds rather than in a full lease.
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()
    mic.hurry(2_000)

    clock.advance(2_000)

    expect(mic.sweep()).toBe(true)
    expect(mic.live).toBe(false)
  })

  it('never hands time back to a mic already on its way out', () => {
    const clock = fakeClock()
    const mic = new Mic({ now: clock.now })
    mic.open()
    mic.hurry(2_000)

    expect(mic.hurry(8_000)).toBe(false)
    expect(mic.expiresAt).toBe(clock.now() + 2_000)
  })

  it('has nothing to hurry when the mic is shut', () => {
    expect(new Mic().hurry(2_000)).toBe(false)
  })

  it('sweeps a shut mic to nothing', () => {
    const mic = new Mic()
    expect(mic.sweep()).toBe(false)
    expect(mic.expiresAt).toBe(0)
  })

  it('holds where the fader now stands, rather than stepping', () => {
    const mic = new Mic()
    expect(mic.duck(0.4)).toBe(true)
    expect(mic.duck(0.4)).toBe(false)
    expect(mic.duckTo).toBe(0.4)
  })

  it('clamps rather than refusing, because it is a fader', () => {
    const mic = new Mic()
    mic.duck(0)
    // Not silence: a duck to nothing is a pause, and a listener who cannot hear
    // the bed has no way to tell a mic break from the station having died.
    expect(mic.duckTo).toBe(MIN_DUCK)
    mic.duck(4)
    expect(mic.duckTo).toBe(1)
  })

  it('ignores a depth that is not a number', () => {
    const mic = new Mic()
    mic.duck(0.3)
    mic.duck(Number.NaN)
    expect(mic.duckTo).toBe(0.3)
  })

  it('takes the fader while the mic is open, which is when it is wanted', () => {
    const mic = new Mic()
    mic.open()
    const heard = vi.fn()
    mic.on('change', heard)

    mic.duck(0.35)

    expect(mic.snapshot()).toMatchObject({ live: true, duckTo: 0.35 })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('clears the mic and keeps the fader', () => {
    // The distinction the end of a session turns on. A mute set in October
    // reappearing next Saturday is a bug; your own duck depth is a setting.
    const mic = new Mic()
    mic.duck(0.5)
    mic.open()

    mic.clear()

    expect(mic.live).toBe(false)
    expect(mic.duckTo).toBe(0.5)
  })
})

describe('the mic over the socket', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness({}, { listen: true })
  })
  afterEach(() => harness.cleanup())

  it('is handed to a listener on connect, before the music', async () => {
    // The ordering is the point. A page told what is playing before it is told
    // to duck would put half a second of a song at full volume under somebody's
    // voice and then correct itself, which is a worse arrival than a quiet one.
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextState()

    const order = client.seen.map((message) => message.type)
    expect(order.indexOf('mic')).toBeGreaterThan(-1)
    expect(order.indexOf('mic')).toBeLessThan(order.indexOf('state'))
    await client.close()
  })

  it('tells a listener arriving mid-break that one is happening', async () => {
    harness.mic.duck(0.3)
    harness.mic.open()

    const client = await TestClient.connect(harness.wsUrl)

    expect(await client.nextMic()).toMatchObject({ live: true, duckTo: 0.3 })
    await client.close()
  })

  it('reaches the room the moment it opens and again when it shuts', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextMic()

    harness.mic.open()
    expect(await client.nextMic()).toMatchObject({ live: true })

    harness.mic.close()
    expect(await client.nextMic()).toMatchObject({ live: false, since: null })
    await client.close()
  })

  it('says nothing on a keep-alive', async () => {
    // Otherwise an open mic is a broadcast to every listener every few seconds
    // for as long as somebody is talking.
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextMic()
    harness.mic.open()
    await client.nextMic()

    harness.mic.renew()
    harness.mic.renew()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(client.seen.filter((m) => m.type === 'mic')).toHaveLength(2)
    await client.close()
  })

  it('carries a change of depth to everyone, mid-sentence', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextMic()
    harness.mic.open()
    await client.nextMic()

    harness.mic.duck(0.45)

    expect(await client.nextMic()).toMatchObject({ live: true, duckTo: 0.45 })
    await client.close()
  })

  it('goes when the session does, and tells the room so', async () => {
    harness.mic.open()
    const client = await TestClient.connect(harness.wsUrl)
    expect(await client.nextMic()).toMatchObject({ live: true })

    harness.air.end()

    expect(await client.nextMic()).toMatchObject({ live: false })
    expect(harness.mic.live).toBe(false)
    await client.close()
  })

  it('buys nobody a voice: the socket is what it was', async () => {
    // The mic is the station talking, not a channel anything can be sent up.
    // An open mic changes nothing about what a listener's socket will accept.
    harness.mic.open()
    const client = await TestClient.connect(harness.wsUrl)

    client.send({ type: 'mic' } as never)

    expect(await client.waitFor((m) => m.type === 'error')).toMatchObject({
      code: 'command_over_http',
    })
    await client.close()
  })
})

describe('a console that died mid-sentence', () => {
  let harness: Harness
  beforeEach(async () => {
    // A lease measured in milliseconds rather than seconds, and the sweep left
    // to the real interval: what is being tested is that the station notices on
    // its own, so nothing here calls `sweep` by hand.
    harness = await startHarness({}, { listen: true, micLeaseMs: 20, micSweepIntervalMs: 10 })
  })
  afterEach(() => harness.cleanup())

  it('does not leave the room ducked forever', async () => {
    // The whole reason the lease exists. The console goes on mic and then stops
    // renewing — a tab closed, a laptop shut, a crash mid-sentence — and every
    // listener is told to bring the music back up without anybody deciding to.
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextMic()

    const opened = await harness.app.inject({
      method: 'POST',
      url: '/api/mic',
      payload: { action: 'open' },
      headers: { cookie: await signIn(harness) },
    })
    expect(opened.json()).toMatchObject({ live: true })
    expect(await client.nextMic()).toMatchObject({ live: true })

    expect(await client.nextMic()).toMatchObject({ live: false })
    expect(harness.mic.live).toBe(false)
    await client.close()
  })
})
