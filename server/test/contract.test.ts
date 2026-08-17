/**
 * The API's promises, tested as promises rather than per route.
 *
 * The per-module suites check that each endpoint does its job. This one checks
 * the things that are only true across endpoints: that the admin gate is the
 * same gate everywhere, that a refusal looks the same wherever it came from,
 * and that what goes over the wire is what `client/src/lib/protocol.ts`
 * compiles against. Those are exactly the properties that rot silently when a
 * route is added, because no single route's tests are watching them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_PASSWORD, type Harness, signIn, startHarness } from './helpers.js'

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

function seedTrack(overrides: Record<string, unknown> = {}): number {
  const row = {
    title: 'Seeded',
    artist: 'QA',
    album: null,
    duration_ms: 240_000,
    filename: `${Math.random().toString(36).slice(2)}.mp3`,
    artwork_path: null,
    content_hash: Math.random().toString(36).slice(2),
    uploaded_at: Date.now(),
    ...overrides,
  }
  const result = harness.db
    .prepare(
      `INSERT INTO tracks (title, artist, album, duration_ms, filename, artwork_path, content_hash, uploaded_at)
       VALUES (@title, @artist, @album, @duration_ms, @filename, @artwork_path, @content_hash, @uploaded_at)`,
    )
    .run(row)
  return Number(result.lastInsertRowid)
}

/** Every route that changes something, as the client actually calls it. */
const MUTATING_ROUTES = [
  { method: 'POST' as const, url: '/api/upload', payload: undefined },
  { method: 'POST' as const, url: '/api/playback', payload: { action: 'pause' } },
  { method: 'POST' as const, url: '/api/queue', payload: { trackId: 1 } },
  { method: 'POST' as const, url: '/api/queue/move', payload: { entryId: 1, toIndex: 0 } },
  { method: 'DELETE' as const, url: '/api/queue/1', payload: undefined },
  { method: 'DELETE' as const, url: '/api/queue', payload: undefined },
  { method: 'POST' as const, url: '/api/wishes/1', payload: { status: 'handled' } },
  { method: 'POST' as const, url: '/api/padding', payload: { padding: 5 } },
]

describe('the admin gate is the same gate everywhere', () => {
  for (const route of MUTATING_ROUTES) {
    const name = `${route.method} ${route.url}`

    it(`${name} refuses an anonymous caller`, async () => {
      const res = await harness.app.inject({ ...route })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ error: 'unauthorized' })
    })

    it(`${name} refuses a cookie it did not sign`, async () => {
      const res = await harness.app.inject({
        ...route,
        headers: { cookie: `chunky_admin=${Date.now() + 60_000}.nonce.notasignature` },
      })
      expect(res.statusCode).toBe(401)
    })

    it(`${name} accepts the password presented directly`, async () => {
      const res = await harness.app.inject({
        ...route,
        headers: { authorization: `Bearer ${ADMIN_PASSWORD}` },
      })
      expect(res.statusCode).not.toBe(401)
    })
  }

  it('reads stay open: listeners get the same queue over the socket anyway', async () => {
    for (const url of ['/api/tracks', '/api/queue', '/api/playback', '/health']) {
      expect((await harness.app.inject({ method: 'GET', url })).statusCode, url).toBe(200)
    }
  })

  it('except the padding, which the room is only ever shown folded in', async () => {
    // The tally the room sees is the roster plus this, on the same frame.
    // Reading the split apart is the console's privilege: publishing it would
    // tell every listener how much of tonight's crowd is nobody.
    expect((await harness.app.inject({ method: 'GET', url: '/api/padding' })).statusCode).toBe(401)
    expect(
      (await harness.app.inject({ method: 'GET', url: '/api/padding', headers: admin() }))
        .statusCode,
    ).toBe(200)
  })

  it('except the wish book, which was never broadcast to anyone', async () => {
    // The open reads are open because the socket already sends the same thing
    // to every listener. Wishes are the one thing it does not: a wish goes to
    // the admin and back to whoever made it, so reading the book is a
    // privilege rather than a second way to see what you were already sent.
    expect((await harness.app.inject({ method: 'GET', url: '/api/wishes' })).statusCode).toBe(401)
    expect(
      (await harness.app.inject({ method: 'GET', url: '/api/wishes', headers: admin() })).statusCode,
    ).toBe(200)
  })
})

/**
 * `error` is a code the client switches on; see `AdminError.code`. Fastify's
 * own refusals used to answer `error: "Bad Request"`, which is prose about the
 * status, so half the API's errors could not be told apart programmatically.
 */
describe('every refusal is machine-readable, whoever wrote it', () => {
  const isCode = (value: unknown) => expect(String(value)).toMatch(/^[a-z][a-z_]*$/)

  it('a handler refusal and a schema refusal answer in the same shape', async () => {
    const byHandler = await harness.app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: admin(),
      payload: { action: 'play' }, // no trackId: the handler refuses
    })
    expect(byHandler.statusCode).toBe(400)
    expect(byHandler.json()).toMatchObject({ error: 'missing_track' })

    const bySchema = await harness.app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: admin(),
      payload: { action: 'fly' }, // not in the enum: the schema refuses
    })
    expect(bySchema.statusCode).toBe(400)
    isCode(bySchema.json().error)
    expect(typeof bySchema.json().message).toBe('string')
  })

  it('an unparseable body is refused in the API shape, not the framework’s', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { ...admin(), 'content-type': 'application/json' },
      payload: '{"action":',
    })
    expect(res.statusCode).toBe(400)
    isCode(res.json().error)
  })

  it('an unknown route answers in the API shape', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/nothing-here' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })

  it('a body larger than the JSON limit is refused in the API shape', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: { ...admin(), 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'pause', pad: 'x'.repeat(2 * 1024 * 1024) }),
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    isCode(res.json().error)
  })

  it('a missing track and a missing entry are each addressable by code', async () => {
    const noTrack = await harness.app.inject({
      method: 'POST',
      url: '/api/queue',
      headers: admin(),
      payload: { trackId: 9999 },
    })
    expect(noTrack.statusCode).toBe(404)
    expect(noTrack.json()).toMatchObject({ error: 'unknown_track' })

    const noEntry = await harness.app.inject({
      method: 'DELETE',
      url: '/api/queue/9999',
      headers: admin(),
    })
    expect(noEntry.statusCode).toBe(404)
    expect(noEntry.json()).toMatchObject({ error: 'unknown_entry' })
  })

  it('every refusal carries both a code and a message', async () => {
    const refusals = [
      harness.app.inject({ method: 'POST', url: '/api/playback', payload: { action: 'pause' } }),
      harness.app.inject({ method: 'GET', url: '/api/nope' }),
      harness.app.inject({
        method: 'POST',
        url: '/api/queue',
        headers: admin(),
        payload: { trackId: 'seven' },
      }),
      harness.app.inject({
        method: 'POST',
        url: '/api/queue/move',
        headers: admin(),
        payload: { entryId: 1 },
      }),
    ]
    for (const res of await Promise.all(refusals)) {
      const body = res.json()
      isCode(body.error)
      expect(typeof body.message, JSON.stringify(body)).toBe('string')
    }
  })
})

describe('the media routes stay inside their root', () => {
  for (const url of [
    '/api/audio/../chunky.sqlite',
    '/api/audio/..%2fchunky.sqlite',
    '/api/audio/..%252fchunky.sqlite',
    '/api/audio/%2e%2e/%2e%2e/etc/passwd',
    '/api/artwork/../audio/x.mp3',
  ]) {
    it(`refuses ${url}`, async () => {
      expect((await harness.app.inject({ method: 'GET', url })).statusCode).toBeGreaterThanOrEqual(
        400,
      )
    })
  }

  it('a file that is simply not there is a 404, in the API shape', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/audio/nothing.mp3' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })
})

describe('the wire shapes the client compiles against', () => {
  it('a track is camelCase, with no storage columns leaking through', async () => {
    seedTrack()
    const [track] = (await harness.app.inject({ method: 'GET', url: '/api/tracks' })).json().tracks
    expect(Object.keys(track).sort()).toEqual([
      'album',
      'artist',
      'artworkPath',
      'contentHash',
      'durationMs',
      'filename',
      'gainDb',
      'id',
      'title',
      'uploadedAt',
    ])
  })

  it('a wish is camelCase, with no storage columns leaking through', async () => {
    harness.app.wishes.make('sam', 'something off Rumours')
    const [wish] = (await harness.app.inject({
      method: 'GET',
      url: '/api/wishes',
      headers: admin(),
    })).json().wishes

    expect(Object.keys(wish).sort()).toEqual(['at', 'id', 'nickname', 'status', 'text'])
  })

  it('a queue entry is {id, track} and nothing else', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/queue',
      headers: admin(),
      payload: { trackId: seedTrack() },
    })
    expect(Object.keys(res.json().entry).sort()).toEqual(['id', 'track'])
  })

  it('every playback command answers with the whole snapshot, and only that', async () => {
    const trackId = seedTrack()
    for (const payload of [
      { action: 'play', trackId },
      { action: 'pause' },
      { action: 'resume' },
      { action: 'seek', positionMs: 1_000 },
      { action: 'skip' },
      { action: 'blend' },
      { action: 'stop' },
    ]) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/playback',
        headers: admin(),
        payload,
      })
      const label = JSON.stringify(payload)
      expect(res.statusCode, label).toBe(200)
      // The same five keys the socket's `state` frame carries, minus `type`.
      expect(Object.keys(res.json()).sort(), label).toEqual([
        // What is still fading out under `track`, during a crossfade, and null
        // the rest of the time. Present on every answer rather than only on the
        // ones that could have set it: a field that came and went would be a
        // client having to tell "no blend" from "this station does not blend".
        'outgoing',
        'pausedAt',
        'serverTime',
        'startedAt',
        'track',
      ])
    }
  })

  it('GET and POST /api/playback describe the station identically', async () => {
    const trackId = seedTrack()
    const posted = await harness.app.inject({
      method: 'POST',
      url: '/api/playback',
      headers: admin(),
      payload: { action: 'play', trackId },
    })
    const fetched = await harness.app.inject({ method: 'GET', url: '/api/playback' })
    expect(fetched.json().track).toEqual(posted.json().track)
    expect(fetched.json().startedAt).toBe(posted.json().startedAt)
  })

  it('every queue mutation answers with the queue as it now stands', async () => {
    harness.station.playback.play({
      id: -1,
      title: 'holding the decks',
      artist: null,
      album: null,
      durationMs: 600_000,
      filename: 'x.mp3',
      artworkPath: null,
      contentHash: 'x',
      gainDb: 0,
      uploadedAt: 0,
    })

    const added = await harness.app.inject({
      method: 'POST',
      url: '/api/queue',
      headers: admin(),
      payload: { trackId: seedTrack() },
    })
    expect(added.statusCode).toBe(201)
    const entryId = added.json().entry.id

    for (const res of [
      added,
      await harness.app.inject({
        method: 'POST',
        url: '/api/queue/move',
        headers: admin(),
        payload: { entryId, toIndex: 0 },
      }),
      await harness.app.inject({
        method: 'DELETE',
        url: `/api/queue/${entryId}`,
        headers: admin(),
      }),
      await harness.app.inject({ method: 'DELETE', url: '/api/queue', headers: admin() }),
    ]) {
      expect(Array.isArray(res.json().entries)).toBe(true)
    }
  })
})
