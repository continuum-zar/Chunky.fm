import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OnAir } from '../src/air.js'
import { type Db, type SessionRow, openDb } from '../src/db.js'
import { ADMIN_PASSWORD, type Harness, makeTrack, signIn, startHarness } from './helpers.js'
import { TestClient } from './ws-client.js'

/**
 * Going live, and ending it: PLAN.md's "you go live, you end it".
 *
 * The thing under test is not really the flag. It is that a session is a
 * stretch of time with an end, that what belongs to one goes away with it, and
 * that a station which is off air is telling listeners something different from
 * a station nobody can reach.
 */

describe('OnAir', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })
  afterEach(() => db.close())

  const sessions = () => db.prepare('SELECT * FROM sessions ORDER BY id').all() as SessionRow[]

  it('starts off air, with no session at all', () => {
    const air = new OnAir({ db })
    // No kind either, and that is the same claim as `since` being null: off air
    // there is no session, so there is nothing for it to be a kind of.
    expect(air.snapshot()).toEqual({ live: false, since: null, kind: null })
    expect(air.current).toBeNull()
    expect(sessions()).toEqual([])
  })

  it('opens a session on going live', () => {
    const air = new OnAir({ db, now: () => 1_700_000_000_000 })
    expect(air.goLive()).toEqual({ live: true, since: 1_700_000_000_000, kind: 'set' })
    expect(air.current).not.toBeNull()
    expect(sessions()).toMatchObject([
      { started_at: 1_700_000_000_000, ended_at: null, kind: 'set' },
    ])
  })

  it('opens a talk session when that is what is being started', () => {
    const air = new OnAir({ db, now: () => 1_700_000_000_000 })
    expect(air.goLive('talk')).toMatchObject({ live: true, kind: 'talk' })
    // Written down as well as broadcast: the night is what it was, after it.
    expect(sessions()).toMatchObject([{ kind: 'talk' }])
  })

  it('will not change the kind of a night already on air', () => {
    // Going live twice is an admin double-clicking, and the second call is
    // ignored whole. Rewriting the kind under a room that has already been told
    // what it walked into is the one thing that would make that call unsafe.
    const air = new OnAir({ db })
    air.goLive('talk')
    expect(air.goLive('set')).toMatchObject({ kind: 'talk' })
    expect(sessions()).toHaveLength(1)
  })

  it('closes it on ending', () => {
    let now = 1_700_000_000_000
    const air = new OnAir({ db, now: () => now })
    air.goLive('talk')
    now = 1_700_000_060_000
    expect(air.end()).toEqual({ live: false, since: null, kind: null })
    expect(sessions()).toMatchObject([
      { started_at: 1_700_000_000_000, ended_at: 1_700_000_060_000 },
    ])
  })

  it('does not open a second session when told to go live twice', () => {
    // An admin double-clicking is the ordinary case. A second session here
    // would leave the first with no `ended_at` forever, and move the chat to a
    // room nobody is in.
    const air = new OnAir({ db })
    air.goLive()
    const id = air.current
    air.goLive()
    expect(air.current).toBe(id)
    expect(sessions()).toHaveLength(1)
  })

  it('says nothing when going live changes nothing', () => {
    const air = new OnAir({ db })
    air.goLive()
    let changes = 0
    air.on('change', () => changes++)
    air.goLive()
    expect(changes).toBe(0)
  })

  it('ending an already-ended session is quiet, not an error', () => {
    const air = new OnAir({ db })
    let changes = 0
    air.on('change', () => changes++)
    expect(() => air.end()).not.toThrow()
    expect(changes).toBe(0)
    expect(sessions()).toEqual([])
  })

  it('going live again is a new session, not the old one resumed', () => {
    const air = new OnAir({ db })
    air.goLive()
    const first = air.current
    air.end()
    air.goLive()
    expect(air.current).not.toBe(first)
    expect(sessions()).toHaveLength(2)
  })

  it('closes an open session at shutdown, without announcing it', () => {
    // A session left open reads as "still on air" forever, which is what makes
    // a clean stop indistinguishable from a crash.
    const air = new OnAir({ db, now: () => 1_700_000_000_000, live: true })
    let changes = 0
    air.on('change', () => changes++)
    air.close()
    expect(changes).toBe(0)
    expect(sessions()).toMatchObject([{ ended_at: 1_700_000_000_000 }])
  })
})

describe('what a session takes with it', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness({}, { live: true })
  })
  afterEach(() => harness.cleanup())

  it('empties the chat, the book and the history when it ends', () => {
    harness.chat.post('sam', 'hello')
    harness.wishes.make('sam', 'something off Rumours')
    harness.plays.record(makeTrack())
    expect(harness.chat.recent()).toHaveLength(1)
    expect(harness.wishes.list()).toHaveLength(1)
    // `count`, not `recent`: the history joins against the library, and this
    // track was never uploaded; see the inner join in PlayLog.recent.
    expect(harness.plays.count()).toBe(1)

    harness.air.end()

    expect(harness.chat.recent()).toEqual([])
    expect(harness.wishes.list()).toEqual([])
    expect(harness.plays.count()).toBe(0)
  })

  it('deletes the rows outright, rather than only making them unreadable', () => {
    harness.chat.post('sam', 'hello')
    harness.wishes.make('sam', 'something off Rumours')
    harness.plays.record(makeTrack())

    harness.air.end()

    // Scoping already made all three unreadable. This is the rows: two of them
    // free text somebody typed and signed, the third stranded by the library
    // wipe and so not a record at all. See `ChatLog.forgetAll`.
    const rows = (table: string) =>
      harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
    expect(rows('messages')).toEqual({ n: 0 })
    expect(rows('wishes')).toEqual({ n: 0 })
    expect(rows('plays')).toEqual({ n: 0 })
  })

  it('takes every session with it, not only the one just ended', () => {
    // By the time anything hears about an ending there is no session left to
    // scope a delete to, so the delete is not scoped. This pins that: an
    // evening from before the one being ended goes too.
    const rows = (table: string) =>
      harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()

    harness.chat.post('sam', 'monday')
    harness.wishes.make('sam', 'monday')
    harness.plays.record(makeTrack())
    harness.air.end()
    harness.air.goLive()
    harness.chat.post('ana', 'tuesday')
    harness.wishes.make('ana', 'tuesday')
    harness.plays.record(makeTrack())
    expect([rows('messages'), rows('wishes'), rows('plays')]).toEqual([
      { n: 1 },
      { n: 1 },
      { n: 1 },
    ])

    harness.air.end()
    expect([rows('messages'), rows('wishes'), rows('plays')]).toEqual([
      { n: 0 },
      { n: 0 },
      { n: 0 },
    ])
  })

  it('opens a fresh room rather than resuming the last one', () => {
    harness.chat.post('sam', 'last night')
    harness.air.end()
    harness.air.goLive()

    expect(harness.chat.recent()).toEqual([])
    harness.chat.post('ana', 'tonight')
    expect(harness.chat.recent().map((m) => m.text)).toEqual(['tonight'])
  })

  it('refuses to write anything down while off air', () => {
    harness.air.end()
    expect(() => harness.chat.post('sam', 'anyone there')).toThrow(/off air/)
    expect(() => harness.wishes.make('sam', 'anything')).toThrow(/off air/)
    // The play log is reached from inside playback's change event, so it
    // declines rather than throwing; see the schema note on `plays`.
    expect(harness.plays.record(makeTrack())).toBeNull()
  })

  it('clears the decks and the queue on the way off air', () => {
    harness.station.queue.add(makeTrack())
    harness.station.playback.play(makeTrack())
    expect(harness.station.playback.track).not.toBeNull()

    harness.air.end()

    expect(harness.station.playback.track).toBeNull()
    expect(harness.station.queue.size).toBe(0)
  })

  it('leaves a queue built before the doors open alone', () => {
    // Going live must not clear anything: queueing a set up and then opening
    // the doors is the ordinary way to start an evening.
    harness.air.end()
    harness.station.queue.add(makeTrack())
    harness.air.goLive()
    expect(harness.station.queue.size).toBe(1)
  })
})

describe('POST /api/session', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness({}, { live: false })
  })
  afterEach(() => harness.cleanup())

  it('reports whether the station is on air, to anyone', async () => {
    // Not behind the gate: whether there is a station tonight is the first
    // thing a listener's page needs, and it is not a secret.
    const res = await harness.app.inject({ method: 'GET', url: '/api/session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ live: false, since: null, kind: null })
  })

  it('refuses to go live without the password', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'start' },
    })
    expect(res.statusCode).toBe(401)
    expect(harness.air.live).toBe(false)
  })

  it('goes live for an admin', async () => {
    const cookie = await signIn(harness, ADMIN_PASSWORD)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'start' },
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ live: true })
    expect(harness.air.live).toBe(true)
  })

  it('ends it again', async () => {
    const cookie = await signIn(harness)
    await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'start' },
      headers: { cookie },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'end' },
      headers: { cookie },
    })
    expect(res.json()).toEqual({ live: false, since: null, kind: null })
  })

  it('starts the kind of night the console asked for', async () => {
    const cookie = await signIn(harness)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'start', kind: 'talk' },
      headers: { cookie },
    })
    expect(res.json()).toMatchObject({ live: true, kind: 'talk' })
  })

  it('goes live as a set when no kind is named', async () => {
    // Which is what a caller written before there were two kinds of night
    // meant by saying nothing, and what the `qa:` scripts still send.
    const cookie = await signIn(harness)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'start' },
      headers: { cookie },
    })
    expect(res.json()).toMatchObject({ live: true, kind: 'set' })
  })

  it('refuses a kind of night it does not have', async () => {
    const cookie = await signIn(harness)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'start', kind: 'karaoke' },
      headers: { cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(harness.air.live).toBe(false)
  })

  it('refuses an action it does not have', async () => {
    const cookie = await signIn(harness)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { action: 'pause' },
      headers: { cookie },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'bad_request' })
  })
})

describe('what a listener is told', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness({}, { listen: true, live: false })
  })
  afterEach(() => harness.cleanup())

  it('is the first thing said about the station', async () => {
    // Second overall, and only because `you` comes first: that one is about the
    // socket rather than about the station, and both ends of a signalling
    // exchange need their own id before anything else means anything. Of the
    // frames describing the station, this is still ahead of all of them — a
    // page told the decks are empty without being told the station is off air
    // shows a gap between songs that never ends.
    const client = await TestClient.connect(harness.wsUrl)
    const air = await client.nextAir()
    expect(air).toMatchObject({ type: 'air', live: false })
    expect(client.seen.map((m) => m.type).slice(0, 2)).toEqual(['you', 'air'])
    await client.close()
  })

  it('hears the station go on and off air', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextAir()

    harness.air.goLive()
    expect(await client.nextAir()).toMatchObject({ live: true })

    harness.air.end()
    expect(await client.nextAir()).toMatchObject({ live: false })
    await client.close()
  })

  it('is told the room is empty when the session ends', async () => {
    harness.air.goLive()
    const client = await TestClient.connect(harness.wsUrl)
    await client.join('sam')
    await client.say('still here?')

    harness.air.end()

    // The chat is scoped to the session, so a page left open must be told to
    // clear rather than left showing a conversation that no longer exists.
    expect(await client.nextChat()).toMatchObject({ messages: [] })
    expect(await client.nextHistory()).toMatchObject({ plays: [] })
    await client.close()
  })

  it('refuses a message and a wish while off air', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextAir()
    await client.join('sam')

    for (const [frame, about] of [
      [{ type: 'say', text: 'hello' }, 'say'],
      [{ type: 'wish', text: 'anything' }, 'wish'],
    ] as const) {
      client.send(frame)
      const error = await client.waitFor((m) => m.type === 'error')
      expect(error).toMatchObject({ code: 'off_air', about })
    }
    await client.close()
  })

  it('takes a message again once the station is back on', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    await client.nextAir()
    // The empty chat sent on connect, consumed before anything waits on a
    // `chat` frame: messages are queued, so leaving it there means `say`
    // returns the frame from before it said anything.
    await client.nextChat()
    await client.join('sam')

    harness.air.goLive()
    await client.nextAir()

    expect(await client.say('good evening')).toMatchObject({
      messages: [{ nickname: 'sam', text: 'good evening' }],
    })
    await client.close()
  })

  it('refuses a command-shaped frame on the socket', async () => {
    // Going live is a command like any other: it goes over HTTP, where the
    // admin gate is. A socket carrying an admin cookie gets no more say.
    const client = await TestClient.connect(harness.wsUrl)
    client.send(JSON.stringify({ type: 'go_live' }))
    expect(await client.waitFor((m) => m.type === 'error')).toMatchObject({
      code: 'command_over_http',
    })
    expect(harness.air.live).toBe(false)
    await client.close()
  })
})
