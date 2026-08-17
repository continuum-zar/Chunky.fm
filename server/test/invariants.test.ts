/**
 * Properties that have to hold while the station moves underneath a request.
 *
 * Nothing here tests a single call in isolation. The point is the seam: a
 * queue reordered while a track ends, a session checked on the millisecond it
 * lapses, an upload that failed halfway. That seam is where this project's
 * bugs have actually been (see docs/qa-notes.md), and it is invisible to tests
 * that drive one endpoint at a time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import {
  ADMIN_COOKIE,
  hasAdminCredentials,
  issueAdminSession,
  verifyAdminSession,
} from '../src/lib/auth.js'
import { parseClientMessage } from '../src/protocol.js'
import {
  ADMIN_PASSWORD,
  type Harness,
  fixture,
  listDir,
  makeTrack,
  multipartBody,
  multipartHeaders,
  signIn,
  startHarness,
} from './helpers.js'
import { TestClient } from './ws-client.js'

describe('the session boundary', () => {
  const config = loadConfig({ ADMIN_PASSWORD: 'a-password', AUDIO_STORAGE_DIR: '/tmp/chunky-x' })

  it('lapses on the millisecond it says it will, not after', () => {
    const session = issueAdminSession(config, 1_700_000_000_000)
    expect(verifyAdminSession(config, session.token, session.expiresAt - 1)).toBe(true)
    expect(verifyAdminSession(config, session.token, session.expiresAt)).toBe(false)
    expect(verifyAdminSession(config, session.token, session.expiresAt + 1)).toBe(false)
  })

  it('refuses a token signed for a different password', () => {
    const other = loadConfig({ ADMIN_PASSWORD: 'other', AUDIO_STORAGE_DIR: '/tmp/chunky-x' })
    expect(verifyAdminSession(config, issueAdminSession(other).token)).toBe(false)
  })

  it('refuses a token whose expiry has been rewritten', () => {
    const session = issueAdminSession(config, 1_700_000_000_000)
    const [, nonce, signature] = session.token.split('.')
    expect(verifyAdminSession(config, `${Date.now() + 60_000}.${nonce}.${signature}`)).toBe(false)
  })

  it('does not throw on a malformed cookie header', () => {
    for (const cookie of ['', '=', ';;;', 'chunky_admin', 'chunky_admin=', 'chunky_admin=...']) {
      expect(() => hasAdminCredentials(config, { cookie }), cookie).not.toThrow()
      expect(hasAdminCredentials(config, { cookie }), cookie).toBe(false)
    }
  })

  it('matches the cookie by name, not by prefix, wherever it sits', () => {
    const { token } = issueAdminSession(config)
    expect(hasAdminCredentials(config, { cookie: `not_${ADMIN_COOKIE}=${token}` })).toBe(false)
    expect(hasAdminCredentials(config, { cookie: `${ADMIN_COOKIE}=${token}` })).toBe(true)
    expect(hasAdminCredentials(config, { cookie: `theme=dark; ${ADMIN_COOKIE}=${token}` })).toBe(
      true,
    )
  })
})

describe('the socket refuses everything it is not', () => {
  it('names command-shaped frames rather than shrugging at them', () => {
    for (const type of ['play', 'pause', 'skip', 'enqueue', 'upload', 'admin']) {
      const parsed = parseClientMessage(JSON.stringify({ type }))
      expect(parsed.ok, type).toBe(false)
      if (!parsed.ok) expect(parsed.error).toMatch(/HTTP/)
    }
  })

  it('refuses a ping whose t0 could not be a clock reading', () => {
    for (const t0 of ['0', null, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(parseClientMessage(JSON.stringify({ type: 'ping', t0 })).ok, String(t0)).toBe(false)
    }
  })

  it('survives JSON that parses but is not a message', () => {
    for (const raw of ['null', '"ping"', '3', '[]', 'true']) {
      expect(parseClientMessage(raw).ok, raw).toBe(false)
    }
  })
})

describe('the socket, over a real connection', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await startHarness({}, { listen: true })
  })
  afterEach(async () => {
    await harness.cleanup()
  })

  it('opens with the whole room: you, air, schedule, mic, floor, cohost, transition, state, queue, roster, history, chat', async () => {
    for (let i = 0; i < 5; i++) {
      const client = await TestClient.connect(harness.wsUrl)
      await client.nextChat() // the last of the twelve
      expect(client.seen.map((m) => m.type)).toEqual([
        // Who this socket is, before anything about the station: an offer is
        // addressed to an id, and both ends of one need to know which id is
        // theirs. It is also the only frame here about the socket rather than
        // about the room, which is why it is not among the rest.
        'you',
        // Then, deliberately: whether there is a broadcast at all comes
        // before what is on it. A page told the decks are empty without being
        // told the station is off air shows a gap between songs that never ends.
        'air',
        // And straight after it, when the station is next on: the two are one
        // sentence on the off-air screen, so they arrive together or the page
        // draws "off the air" and replaces it a frame later.
        'schedule',
        // Before the music, so a listener arriving mid-break comes in already
        // ducked. The other way round, the first thing they hear is half a
        // second of a song at full volume under somebody's voice.
        'mic',
        // Straight after the mic and still before the music, for the same
        // reason one step down: a listener arriving mid-call comes in already
        // ducked *and* already knowing whose voice they are about to hear.
        //
        // Note what is not here. A console gets one more frame than this — the
        // raised hands — and a listener never does, which is the only asymmetry
        // in the burst and the whole of this feature's privacy story.
        'floor',
        // And who is co-hosting, in the same breath: a second voice on the air
        // for the whole evening is a second name the room is owed before it
        // arrives, the same way a guest's is.
        'cohost',
        // Last of the frames that change how the music is played, and still
        // before the music itself. A page told what is on without being told
        // how long a transition runs would run the first one as a cut.
        'transition',
        'state',
        'queue',
        'presence',
        'history',
        'chat',
      ])
      await client.close()
    }
  })

  it('answers pongs on the same clock startedAt is expressed in', async () => {
    harness.station.playback.play(makeTrack())
    const client = await TestClient.connect(harness.wsUrl)
    const state = await client.nextState()

    const t0 = Date.now()
    client.send({ type: 'ping', t0 })
    const pong = (await client.waitFor((m) => m.type === 'pong')) as { t0: number; t1: number }

    expect(pong.t0).toBe(t0)
    // A pong drawn from a different timebase than startedAt would show up here
    // as a wild gap, and downstream as every listener aligning to the wrong
    // instant, which is the one thing this project cannot get wrong.
    expect(pong.t1).toBeGreaterThanOrEqual(state.serverTime)
    expect(pong.t1 - state.serverTime).toBeLessThan(5_000)
    await client.close()
  })

  it('echoes a fractional t0 exactly: the client matches probes by that number', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    const t0 = Date.now() + 0.001
    client.send({ type: 'ping', t0 })
    expect(((await client.waitFor((m) => m.type === 'pong')) as { t0: number }).t0).toBe(t0)
    await client.close()
  })

  it('answers a junk frame with an error instead of dropping the listener', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    client.send('not json at all')
    expect(await client.waitFor((m) => m.type === 'error')).toMatchObject({ type: 'error' })
    // Still listening: a bad frame is not grounds for disconnection.
    client.send({ type: 'ping', t0: Date.now() })
    expect(await client.waitFor((m) => m.type === 'pong')).toBeTruthy()
    await client.close()
  })

  it('tells every listener the same startedAt, whenever they joined', async () => {
    const early = await TestClient.connect(harness.wsUrl)
    await early.nextState()
    harness.station.playback.play(makeTrack())
    const first = await early.nextState()

    const late = await TestClient.connect(harness.wsUrl)
    expect((await late.nextState()).startedAt).toBe(first.startedAt)

    await early.close()
    await late.close()
  })
})

describe('playback keeps its invariants under the routes', () => {
  let harness: Harness
  let cookie: string

  beforeEach(async () => {
    harness = await startHarness()
    cookie = await signIn(harness)
  })
  afterEach(async () => {
    await harness.cleanup()
  })

  const admin = () => ({ cookie })

  function seedTrack(durationMs = 240_000): number {
    const result = harness.db
      .prepare(
        `INSERT INTO tracks (title, artist, album, duration_ms, filename, artwork_path, content_hash, uploaded_at)
         VALUES ('Seeded', 'QA', NULL, ?, ?, NULL, ?, 0)`,
      )
      .run(durationMs, `${Math.random()}.mp3`, String(Math.random()))
    return Number(result.lastInsertRowid)
  }

  const post = async (payload: Record<string, unknown>) =>
    await harness.app.inject({ method: 'POST', url: '/api/playback', headers: admin(), payload })

  it('never reports a position past the end of the track', async () => {
    await post({ action: 'play', trackId: seedTrack(1_000), positionMs: 999_999 })
    expect(harness.playback.positionMs()).toBeLessThanOrEqual(1_000)

    const { startedAt, serverTime } = harness.playback.snapshot()
    expect(startedAt).toBeLessThanOrEqual(serverTime)
  })

  it('pauses idempotently, without moving the needle', async () => {
    await post({ action: 'play', trackId: seedTrack(), positionMs: 5_000 })
    const first = await post({ action: 'pause' })
    const second = await post({ action: 'pause' })
    expect(second.json().pausedAt).toBe(first.json().pausedAt)
  })

  it('treats resume on a station that was never paused as a no-op, not a restart', async () => {
    const played = await post({ action: 'play', trackId: seedTrack(), positionMs: 30_000 })
    const resumed = await post({ action: 'resume' })
    expect(resumed.json().startedAt).toBe(played.json().startedAt)
  })

  it('goes off air when the last track is skipped, rather than replaying it', async () => {
    await post({ action: 'play', trackId: seedTrack() })
    expect((await post({ action: 'skip' })).json().track).toBeNull()
  })
})

describe('the queue keeps its promises while the station moves', () => {
  let harness: Harness
  let cookie: string

  beforeEach(async () => {
    harness = await startHarness()
    cookie = await signIn(harness)
    // Hold the decks, so enqueuing does not immediately drain into playback.
    harness.station.playback.play(makeTrack({ durationMs: 600_000 }))
  })
  afterEach(async () => {
    await harness.cleanup()
  })

  const admin = () => ({ cookie })

  function seedTrack(): number {
    const result = harness.db
      .prepare(
        `INSERT INTO tracks (title, artist, album, duration_ms, filename, artwork_path, content_hash, uploaded_at)
         VALUES ('Seeded', 'QA', NULL, 240000, ?, NULL, ?, 0)`,
      )
      .run(`${Math.random()}.mp3`, String(Math.random()))
    return Number(result.lastInsertRowid)
  }

  const enqueue = async (): Promise<number> =>
    (
      await harness.app.inject({
        method: 'POST',
        url: '/api/queue',
        headers: admin(),
        payload: { trackId: seedTrack() },
      })
    ).json().entry.id

  it('never reuses an entry id after the queue has advanced past it', async () => {
    const first = await enqueue()
    const second = await enqueue()
    expect(second).toBeGreaterThan(first)

    harness.station.advance() // first is now on the decks
    expect(await enqueue()).toBeGreaterThan(second)
  })

  it('clamps an out-of-range move rather than refusing it', async () => {
    const ids = [await enqueue(), await enqueue(), await enqueue()]
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/queue/move',
      headers: admin(),
      payload: { entryId: ids[0], toIndex: 999 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().entries.at(-1).id).toBe(ids[0])
  })

  it('moves an entry by one place, not to the end', async () => {
    const ids = [await enqueue(), await enqueue(), await enqueue(), await enqueue()]
    // What the panel's ↓ button sends: the entry's id and its index + 1.
    await harness.app.inject({
      method: 'POST',
      url: '/api/queue/move',
      headers: admin(),
      payload: { entryId: ids[1], toIndex: 2 },
    })
    const listed = (await harness.app.inject({ method: 'GET', url: '/api/queue' })).json()
    expect(listed.entries.map((e: { id: number }) => e.id)).toEqual([ids[0], ids[2], ids[1], ids[3]])
  })

  it('keeps ids addressing the same tracks across a reorder and an advance', async () => {
    const ids = [await enqueue(), await enqueue(), await enqueue(), await enqueue()]

    await harness.app.inject({
      method: 'POST',
      url: '/api/queue/move',
      headers: admin(),
      payload: { entryId: ids[3], toIndex: 0 },
    })
    harness.station.advance() // takes ids[3]: the one just moved to the front

    const listed = (await harness.app.inject({ method: 'GET', url: '/api/queue' })).json()
    expect(listed.entries.map((e: { id: number }) => e.id)).toEqual([ids[0], ids[1], ids[2]])
  })
})

describe('an upload leaves nothing behind, whatever happens to it', () => {
  let harness: Harness
  let cookie: string

  beforeEach(async () => {
    harness = await startHarness()
    cookie = await signIn(harness)
  })
  afterEach(async () => {
    await harness.cleanup()
  })

  const upload = async (data: Buffer, filename: string, contentType = 'audio/mpeg') =>
    harness.app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { ...multipartHeaders(), cookie },
      payload: multipartBody([{ name: 'file', filename, contentType, data }]),
    })

  it('empties the tmp directory after every outcome', async () => {
    await upload(await fixture('tagged.mp3'), 'tagged.mp3') // 201
    await upload(await fixture('tagged.mp3'), 'tagged.mp3') // 409
    await upload(Buffer.from('not audio'), 'fake.mp3') // 415
    await upload(Buffer.alloc(0), 'empty.mp3') // 400
    expect(await listDir(harness.config.tmpDir)).toEqual([])
  })

  it('writes nothing to the served directories when it refuses a file', async () => {
    await upload(Buffer.from('not audio at all'), 'fake.mp3')
    expect(await listDir(harness.config.audioDir)).toEqual([])
    expect(await listDir(harness.config.artworkDir)).toEqual([])
  })

  it('stores two identical files as one track and one file on disk', async () => {
    const data = await fixture('tagged.mp3')
    const [first, second] = await Promise.all([
      upload(data, 'a.mp3'),
      upload(Buffer.from(data), 'b.mp3'),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409])
    expect(await listDir(harness.config.audioDir)).toHaveLength(1)
    expect((harness.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n).toBe(1)
  })

  it('names the stored file after its content, never after the client', async () => {
    const res = await upload(await fixture('tagged.mp3'), '../../escape.mp3')
    expect(res.statusCode).toBe(201)
    const { filename } = res.json().track
    expect(filename).toMatch(/^[0-9a-f]{64}\.[a-z0-9]+$/)
    expect(await listDir(harness.config.audioDir)).toEqual([filename])
  })

  it('behaves identically for the bearer password and the cookie', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { ...multipartHeaders(), authorization: `Bearer ${ADMIN_PASSWORD}` },
      payload: multipartBody([
        {
          name: 'file',
          filename: 'tagged.mp3',
          contentType: 'audio/mpeg',
          data: await fixture('tagged.mp3'),
        },
      ]),
    })
    expect(res.statusCode).toBe(201)
  })

  it('survives upload → queue → decks with its duration intact', async () => {
    const { track } = (await upload(await fixture('tagged.mp3'), 'tagged.mp3')).json()
    expect(track.durationMs).toBeGreaterThan(0)

    const queued = await harness.app.inject({
      method: 'POST',
      url: '/api/queue',
      headers: { cookie },
      payload: { trackId: track.id },
    })
    expect(queued.statusCode).toBe(201)
    // An idle station starts it at once, so it is on the decks, not queued.
    expect(harness.playback.snapshot().track).toEqual(track)
    expect(queued.json().entries).toEqual([])
  })
})
