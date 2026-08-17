/**
 * `/api/cohost`, and what the seat can reach.
 *
 * The seat is a third rung between a listener and the decks, and this file is
 * mostly about where it stops. Two rules do most of the work:
 *
 *   - **admin ⊃ co-host.** Whoever holds the password can already do everything
 *     the seat can and more, so an admin cookie satisfies every gate here. A
 *     console that had to hold a second cookie to drive its own queue would be
 *     a rule enforced against the one person it was never written for.
 *   - **A cookie says *may this browser*; a socket id says *which connection*.**
 *     Taking the seat needs both, because a cookie cannot carry a socket id and
 *     the console has to be told which connection to offer a microphone to.
 *
 * The second is the one worth being paranoid about: without the check on the
 * named socket, anybody holding a seat could put an arbitrary listener on the
 * air by guessing an id, and the room would hear whoever was really on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CO_HOST_KEY, type Harness, signIn, startHarness, takeKey } from './helpers.js'
import { TestClient } from './ws-client.js'

let harness: Harness
let seat: string
let admin: string

beforeEach(async () => {
  harness = await startHarness({}, { listen: true })
  seat = await takeKey(harness)
  admin = await signIn(harness)
})
afterEach(() => harness.cleanup())

/** A socket that presented the co-host key, and the id the station gave it. */
async function seatedSocket(): Promise<{ client: TestClient; id: number }> {
  const client = await TestClient.connect(harness.wsUrl, { cookie: seat })
  const you = (await client.waitFor((m) => m.type === 'you')) as { id: number }
  return { client, id: you.id }
}

const post = (url: string, payload: unknown, cookie?: string) =>
  harness.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    ...(cookie ? { headers: { cookie } } : {}),
  })

describe('the co-host key', () => {
  it('is exchanged for a cookie, once, and never sits in the page after', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/cohost/session',
      payload: { key: CO_HOST_KEY },
    })

    expect(res.statusCode).toBe(204)
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toContain('chunky_cohost=')
    // HttpOnly so page script cannot read the token even to send it, and
    // SameSite=Strict so nothing the co-host clicks elsewhere can drive the
    // station on their behalf.
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('refuses the wrong key, and sheds whatever cookie was presented', async () => {
    const res = await post('/api/cohost/session', { key: 'not the key' })
    expect(res.statusCode).toBe(401)
    expect(String(res.headers['set-cookie'])).toContain('chunky_cohost=;')
  })

  it('is not the station key and not the password', async () => {
    // Three secrets guarding three different things, and the whole point of the
    // seat is that holding one of them is not holding the others.
    expect(harness.config.coHostKey).not.toBe(harness.config.adminPassword)
    expect(await post('/api/cohost/session', { key: harness.config.adminPassword })).toMatchObject({
      statusCode: 401,
    })
  })

  it('is readable by the decks, so the console can build a link', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/cohost/key',
      headers: { cookie: admin },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ key: CO_HOST_KEY })
  })

  it('is not readable by a co-host, who would otherwise recruit a third', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/cohost/key',
      headers: { cookie: seat },
    })
    expect(res.statusCode).toBe(401)
  })

  it('never paces a working link, however many times it is opened', async () => {
    // The bucket is for guessing, and a correct key is not a guess. Charging
    // for success is how a brute-force limit becomes a self-lockout: a co-host
    // getting set up would find their own seat shut against them.
    const fresh = await startHarness()
    try {
      for (let i = 0; i < 20; i++) {
        const res = await fresh.app.inject({
          method: 'POST',
          url: '/api/cohost/session',
          payload: { key: CO_HOST_KEY },
        })
        expect(res.statusCode, `attempt ${i}`).toBe(204)
      }
    } finally {
      await fresh.cleanup()
    }
  })

  it('throttles somebody working through the alphabet', async () => {
    const fresh = await startHarness({}, { listen: false })
    try {
      const codes: number[] = []
      for (let i = 0; i < 8; i++) {
        codes.push((await fresh.app.inject({
          method: 'POST',
          url: '/api/cohost/session',
          payload: { key: `guess-${i}` },
        })).statusCode)
      }
      expect(codes).toContain(429)
    } finally {
      await fresh.cleanup()
    }
  })
})

describe('taking the seat', () => {
  it('needs the key and the connection, not just the key', async () => {
    const { client, id } = await seatedSocket()
    try {
      expect((await post('/api/cohost/seat', { action: 'take' }, seat)).statusCode).toBe(400)

      const res = await post('/api/cohost/seat', { action: 'take', socket: id, nickname: 'thabo' }, seat)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ seat: { id, nickname: 'thabo' } })
    } finally {
      await client.close()
    }
  })

  it('refuses a socket that never presented a co-host key', async () => {
    // The attack this exists for: a browser holding a seat naming somebody
    // else's connection, which would put that listener on the air.
    const listener = await TestClient.connect(harness.wsUrl)
    const you = (await listener.waitFor((m) => m.type === 'you')) as { id: number }
    try {
      const res = await post('/api/cohost/seat', { action: 'take', socket: you.id }, seat)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('unknown_socket')
      expect(harness.coHost.seat).toBeNull()
    } finally {
      await listener.close()
    }
  })

  it('refuses a browser with no seat at all', async () => {
    const { client, id } = await seatedSocket()
    try {
      const res = await post('/api/cohost/seat', { action: 'take', socket: id })
      expect(res.statusCode).toBe(401)
    } finally {
      await client.close()
    }
  })

  it('refuses while the station is off air', async () => {
    const off = await startHarness({}, { listen: true, live: false })
    try {
      const key = await takeKey(off)
      const client = await TestClient.connect(off.wsUrl, { cookie: key })
      const you = (await client.waitFor((m) => m.type === 'you')) as { id: number }
      const res = await off.app.inject({
        method: 'POST',
        url: '/api/cohost/seat',
        headers: { cookie: key },
        payload: { action: 'take', socket: you.id },
      })
      // Taking the seat opens a microphone into a room that does not exist yet.
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('off_air')
      await client.close()
    } finally {
      await off.cleanup()
    }
  })

  it('says who is already in it rather than shoving them out', async () => {
    const first = await seatedSocket()
    const second = await seatedSocket()
    try {
      await post('/api/cohost/seat', { action: 'take', socket: first.id, nickname: 'thabo' }, seat)
      const res = await post('/api/cohost/seat', { action: 'take', socket: second.id }, seat)

      expect(res.statusCode).toBe(409)
      expect(res.json().message).toContain('thabo')
      expect(harness.coHost.seat?.id).toBe(first.id)
    } finally {
      await first.client.close()
      await second.client.close()
    }
  })

  it('tells the whole room who is co-hosting', async () => {
    const { client, id } = await seatedSocket()
    const listener = await TestClient.connect(harness.wsUrl)
    await listener.waitFor((m) => m.type === 'cohost')
    try {
      await post('/api/cohost/seat', { action: 'take', socket: id, nickname: 'thabo' }, seat)

      const frame = await listener.waitFor(
        (m) => m.type === 'cohost' && (m as { seat?: unknown }).seat !== null,
      )
      expect(frame).toMatchObject({ type: 'cohost', seat: { id, nickname: 'thabo' } })
    } finally {
      await client.close()
      await listener.close()
    }
  })

  it('gives the seat up when the socket goes', async () => {
    const { client, id } = await seatedSocket()
    await post('/api/cohost/seat', { action: 'take', socket: id, nickname: 'thabo' }, seat)
    expect(harness.coHost.seat?.id).toBe(id)

    await client.close()
    // Pinned to a socket the station already watches, so nothing has to expire
    // for this: closing is the mechanism and the lease is only the backstop.
    await vi.waitFor(() => expect(harness.coHost.seat).toBeNull())
  })

  it('leaves the floor entirely alone', async () => {
    const { client, id } = await seatedSocket()
    try {
      await post('/api/cohost/seat', { action: 'take', socket: id, nickname: 'thabo' }, seat)
      // A co-host is not a guest. Nothing about seating one should look like
      // somebody having been brought up.
      expect(harness.floor.snapshot()).toEqual({ speaker: null, invited: null })
    } finally {
      await client.close()
    }
  })
})

describe('what the seat can reach', () => {
  it('queues, moves and drops records', async () => {
    const trackId = seedTrack()
    const added = await post('/api/queue', { trackId }, seat)
    expect(added.statusCode).toBe(201)

    const second = await post('/api/queue', { trackId }, seat)
    const entryId = second.json().entry.id as number

    expect((await post('/api/queue/move', { entryId, toIndex: 0 }, seat)).statusCode).toBe(200)
    const dropped = await harness.app.inject({
      method: 'DELETE',
      url: `/api/queue/${entryId}`,
      headers: { cookie: seat },
    })
    expect(dropped.statusCode).toBe(200)
  })

  it('cannot empty the whole queue', async () => {
    // Everything the seat gets is one row and undone by doing the opposite.
    // Emptying the queue is somebody's prepared set gone on one tap.
    const res = await harness.app.inject({
      method: 'DELETE',
      url: '/api/queue',
      headers: { cookie: seat },
    })
    expect(res.statusCode).toBe(401)
  })

  it('pauses, resumes, skips and blends', async () => {
    for (const action of ['pause', 'resume', 'skip', 'blend']) {
      expect((await post('/api/playback', { action }, seat)).statusCode, action).toBe(200)
    }
  })

  it('cannot put a different record on, seek inside one, or clear the decks', async () => {
    const trackId = seedTrack()
    for (const payload of [
      { action: 'play', trackId },
      { action: 'seek', positionMs: 1_000 },
      { action: 'stop' },
    ]) {
      const res = await post('/api/playback', payload, seat)
      expect(res.statusCode, JSON.stringify(payload)).toBe(403)
      expect(res.json().error).toBe('not_the_decks')
    }
  })

  it('opens and closes its own microphone', async () => {
    expect((await post('/api/mic', { action: 'open' }, seat)).statusCode).toBe(200)
    expect(harness.mic.holders()).toEqual(['cohost'])
    expect((await post('/api/mic', { action: 'close' }, seat)).statusCode).toBe(200)
    expect(harness.mic.live).toBe(false)
  })

  it('cannot decide how far the music ducks', async () => {
    const res = await post('/api/mic', { action: 'duck', duckTo: 0.5 }, seat)
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('not_the_decks')
  })

  it('sets how long a transition runs', async () => {
    const res = await post('/api/transition', { blendMs: 6_000 }, seat)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ blendMs: 6_000 })
    expect(harness.station.transition.blendMs).toBe(6_000)
  })

  it('cannot end the night, mute anybody, or pad the room', async () => {
    for (const [url, payload] of [
      ['/api/session', { action: 'end' }],
      ['/api/mutes', { nickname: 'somebody', muted: true }],
      ['/api/padding', { padding: 50 }],
    ] as const) {
      expect((await post(url, payload, seat)).statusCode, url).toBe(401)
    }
  })

  it('admits an admin everywhere it admits a co-host', async () => {
    // admin ⊃ co-host. Whoever runs the decks should never be refused by a rule
    // written for somebody with less.
    expect((await post('/api/playback', { action: 'blend' }, admin)).statusCode).toBe(200)
    expect((await post('/api/transition', { blendMs: 2_000 }, admin)).statusCode).toBe(200)
    expect((await post('/api/queue', { trackId: seedTrack() }, admin)).statusCode).toBe(201)
  })
})

function seedTrack(): number {
  const info = harness.db
    .prepare(
      `INSERT INTO tracks (title, artist, album, duration_ms, filename, artwork_path, content_hash, gain_db, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('A Record', 'Somebody', null, 200_000, `${Math.random()}.mp3`, null, `${Math.random()}`, 0, Date.now())
  return Number(info.lastInsertRowid)
}
