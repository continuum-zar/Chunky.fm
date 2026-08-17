/**
 * Announcing the next session.
 *
 * The one thing the station holds that is not about tonight, and the one read
 * in this API that a stranger is allowed. Both of those are the point rather
 * than an oversight, so both are pinned here.
 */
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { Schedule } from '../src/schedule.js'
import { type Harness, multipartBody, multipartHeaders, signIn, startHarness } from './helpers.js'
import { TestClient } from './ws-client.js'

/** The smallest thing that sniffs as a PNG. */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('the rest is never read'),
])

/**
 * A body carrying a time and, optionally, a poster. The schedule takes both in
 * one request, so this is `multipartBody` with a field alongside the file.
 */
function posterBody(
  startsAt: number | null,
  file: Buffer | null,
  said: { kind?: string; title?: string } = {},
) {
  const parts = []
  if (startsAt !== null) parts.push({ name: 'startsAt', data: Buffer.from(String(startsAt)) })
  if (said.kind !== undefined) parts.push({ name: 'kind', data: Buffer.from(said.kind) })
  if (said.title !== undefined) parts.push({ name: 'title', data: Buffer.from(said.title) })
  if (file !== null) {
    parts.push({ name: 'poster', filename: 'poster.png', contentType: 'image/png', data: file })
  }
  return multipartBody(parts)
}

const SATURDAY = 1_700_500_000_000

/** What an announcement that says nothing about itself comes out as. */
const PLAIN = { kind: 'set', title: null } as const

describe('Schedule', () => {
  it('holds one announcement, and replacing it hands back the poster it displaced', () => {
    const db = openDb(':memory:')
    const schedule = new Schedule({ db, now: () => 0 })

    expect(schedule.get()).toBeNull()
    expect(schedule.set({ startsAt: SATURDAY, poster: 'a.png', ...PLAIN })).toEqual({ poster: null })
    expect(schedule.get()).toEqual({ startsAt: SATURDAY, poster: 'a.png', ...PLAIN })

    // A new picture displaces the old one, which the caller then unlinks.
    expect(schedule.set({ startsAt: SATURDAY, poster: 'b.png', ...PLAIN })).toEqual({
      poster: 'a.png',
    })
    // The same picture over a new time does not: changing the hour is the
    // ordinary edit, and unlinking there would blank the page.
    expect(schedule.set({ startsAt: SATURDAY + 3600_000, poster: 'b.png', ...PLAIN })).toEqual({
      poster: null,
    })
    expect(schedule.get()).toEqual({ startsAt: SATURDAY + 3600_000, poster: 'b.png', ...PLAIN })
    db.close()
  })

  it('remembers which kind of night is being promised, and what it is called', () => {
    const db = openDb(':memory:')
    const schedule = new Schedule({ db })

    schedule.set({
      startsAt: SATURDAY,
      poster: null,
      kind: 'talk',
      title: 'A conversation with Sipho',
    })
    expect(schedule.get()).toEqual({
      startsAt: SATURDAY,
      poster: null,
      kind: 'talk',
      title: 'A conversation with Sipho',
    })

    // And an announcement that goes back to being a set says so, rather than
    // keeping the kind of the one it replaced.
    schedule.set({ startsAt: SATURDAY, poster: null, ...PLAIN })
    expect(schedule.get()).toEqual({ startsAt: SATURDAY, poster: null, ...PLAIN })
    db.close()
  })

  it('never keeps two, whatever it is asked', () => {
    const db = openDb(':memory:')
    const schedule = new Schedule({ db })
    schedule.set({ startsAt: SATURDAY, poster: null, ...PLAIN })
    schedule.set({ startsAt: SATURDAY + 1, poster: null, ...PLAIN })
    schedule.set({ startsAt: SATURDAY + 2, poster: null, ...PLAIN })
    expect(db.prepare('SELECT COUNT(*) AS n FROM schedule').get()).toEqual({ n: 1 })
    db.close()
  })

  it('says so when it changes, which is what the socket broadcasts on', () => {
    const db = openDb(':memory:')
    const schedule = new Schedule({ db })
    const seen: unknown[] = []
    schedule.on('change', (next) => seen.push(next))

    schedule.set({ startsAt: SATURDAY, poster: null, ...PLAIN })
    schedule.clear()
    expect(seen).toEqual([{ startsAt: SATURDAY, poster: null, ...PLAIN }, null])
    db.close()
  })

  it('clearing nothing is not a change', () => {
    const db = openDb(':memory:')
    const schedule = new Schedule({ db })
    let changes = 0
    schedule.on('change', () => changes++)
    expect(schedule.clear()).toEqual({ poster: null })
    expect(changes).toBe(0)
    db.close()
  })
})

describe('the schedule over HTTP', () => {
  let harness: Harness
  afterEach(() => harness.cleanup())

  async function announce(payload: Buffer) {
    const cookie = await signIn(harness)
    return harness.app.inject({
      method: 'PUT',
      url: '/api/schedule',
      headers: { ...multipartHeaders(), cookie },
      payload,
    })
  }

  it('is readable by a stranger, on a station with a door on it', async () => {
    harness = await startHarness({ stationKey: 'sesame' })
    harness.schedule.set({ startsAt: SATURDAY, poster: null, ...PLAIN })

    // Everything else on this private station refuses an unkeyed caller. A
    // poster is an advertisement: it is for the people who are not in yet.
    expect((await harness.app.inject({ url: '/api/tracks' })).statusCode).toBe(401)
    const res = await harness.app.inject({ url: '/api/schedule' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ schedule: { startsAt: SATURDAY, poster: null, ...PLAIN } })
  })

  it('answers null when nothing is announced, rather than 404', async () => {
    harness = await startHarness()
    const res = await harness.app.inject({ url: '/api/schedule' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ schedule: null })
  })

  it('takes a time and a poster together, and serves the poster back', async () => {
    harness = await startHarness()
    const res = await announce(posterBody(SATURDAY, PNG))
    expect(res.statusCode).toBe(200)

    const { schedule } = res.json() as { schedule: { startsAt: number; poster: string } }
    expect(schedule.startsAt).toBe(SATURDAY)
    // A bare name, as a track's filename is: the client builds the address.
    expect(schedule.poster).toMatch(/^[0-9a-f-]+\.png$/)
    expect(await fs.readdir(harness.config.posterDir)).toEqual([schedule.poster])

    // And it is served open, like the read.
    const fetched = await harness.app.inject({ url: `/api/poster/${schedule.poster}` })
    expect(fetched.statusCode).toBe(200)
  })

  it('keeps the poster already up when a later edit sends no new file', async () => {
    harness = await startHarness()
    const first = (await announce(posterBody(SATURDAY, PNG))).json() as {
      schedule: { poster: string }
    }

    const moved = await announce(posterBody(SATURDAY + 3600_000, null))
    expect(moved.statusCode).toBe(200)
    // Changing the hour should not mean finding the image again.
    expect((moved.json() as { schedule: { poster: string } }).schedule.poster).toBe(
      first.schedule.poster,
    )
    expect(await fs.readdir(harness.config.posterDir)).toHaveLength(1)
  })

  it('unlinks the poster it replaces, so the disk holds one', async () => {
    harness = await startHarness()
    await announce(posterBody(SATURDAY, PNG))
    await announce(posterBody(SATURDAY, PNG))
    expect(await fs.readdir(harness.config.posterDir)).toHaveLength(1)
  })

  it('refuses a file that is not an image, whatever it says it is', async () => {
    harness = await startHarness()
    const res = await announce(posterBody(SATURDAY, Buffer.from('MZ not a picture')))
    expect(res.statusCode).toBe(415)
    expect(res.json()).toMatchObject({ error: 'unsupported_poster' })
    // And nothing is left behind on the way out.
    expect(await fs.readdir(harness.config.posterDir)).toEqual([])
  })

  it('refuses an announcement with no time on it', async () => {
    harness = await startHarness()
    const res = await announce(posterBody(null, PNG))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'no_time' })
    expect(await fs.readdir(harness.config.posterDir)).toEqual([])
  })

  it('is admin-only to set and to take down', async () => {
    harness = await startHarness()
    const set = await harness.app.inject({
      method: 'PUT',
      url: '/api/schedule',
      headers: multipartHeaders(),
      payload: posterBody(SATURDAY, null),
    })
    expect(set.statusCode).toBe(401)
    expect((await harness.app.inject({ method: 'DELETE', url: '/api/schedule' })).statusCode).toBe(
      401,
    )
  })

  it('takes the poster down with the announcement', async () => {
    harness = await startHarness()
    await announce(posterBody(SATURDAY, PNG))
    const cookie = await signIn(harness)

    const res = await harness.app.inject({ method: 'DELETE', url: '/api/schedule', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ schedule: null })
    // It was only ever for that night.
    expect(await fs.readdir(harness.config.posterDir)).toEqual([])
  })

  it('survives a session, because it is about the next one', async () => {
    harness = await startHarness(undefined, { live: true })
    harness.schedule.set({ startsAt: SATURDAY, poster: null, ...PLAIN })

    harness.air.end()

    // The chat, the queue and the library all go here. This is the one thing
    // that is about a night which has not happened yet.
    expect(harness.schedule.get()).toEqual({ startsAt: SATURDAY, poster: null, ...PLAIN })
  })

  it('takes the kind and the title alongside the time', async () => {
    harness = await startHarness()
    const res = await announce(
      posterBody(SATURDAY, null, { kind: 'talk', title: '  A conversation with  Sipho ' }),
    )

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      schedule: {
        startsAt: SATURDAY,
        poster: null,
        kind: 'talk',
        // Collapsed and trimmed on the way in: this ends up on a public page.
        title: 'A conversation with Sipho',
      },
    })
  })

  it('is a set with no title when the fields are not sent at all', async () => {
    harness = await startHarness()
    const res = await announce(posterBody(SATURDAY, null))
    // Which is what every announcement made before there were two kinds of
    // night meant, and what the old two-field form still sends.
    expect(res.json()).toEqual({ schedule: { startsAt: SATURDAY, poster: null, ...PLAIN } })
  })

  it('does not carry a title over an edit that clears it', async () => {
    harness = await startHarness()
    await announce(posterBody(SATURDAY, null, { kind: 'talk', title: 'Sipho' }))

    const cleared = await announce(posterBody(SATURDAY, null, { kind: 'talk', title: '' }))
    // Only the poster is kept across an edit, and only because a file costs
    // something to send again. A title somebody emptied is emptied.
    expect(cleared.json()).toEqual({
      schedule: { startsAt: SATURDAY, poster: null, kind: 'talk', title: null },
    })
  })

  it('caps a title at the length a poster line can hold', async () => {
    harness = await startHarness()
    const res = await announce(posterBody(SATURDAY, null, { title: 'x'.repeat(200) }))
    const { schedule } = res.json() as { schedule: { title: string } }
    expect(schedule.title).toHaveLength(80)
  })

  it('reads an unknown kind as a set rather than storing it', async () => {
    harness = await startHarness()
    const res = await announce(posterBody(SATURDAY, null, { kind: 'karaoke' }))
    // There is no third kind of night, and a column the listener page cannot
    // switch on would reach it as a session that renders as neither.
    expect((res.json() as { schedule: { kind: string } }).schedule.kind).toBe('set')
  })
})

describe('the schedule over the socket', () => {
  let harness: Harness
  afterEach(() => harness.cleanup())

  it('is sent on connect and broadcast when it changes', async () => {
    harness = await startHarness({}, { listen: true })
    harness.schedule.set({ startsAt: SATURDAY, poster: 'a.png', ...PLAIN })

    const client = await TestClient.connect(harness.wsUrl)
    expect(await client.nextSchedule()).toMatchObject({
      schedule: { startsAt: SATURDAY, poster: 'a.png' },
    })

    // A page left open on the off-air screen picks up an announcement made
    // after it loaded, which is the whole reason this is on the socket.
    harness.schedule.set({
      startsAt: SATURDAY + 3600_000,
      poster: null,
      kind: 'talk',
      title: 'Sipho',
    })
    // Whole, rather than a hand-written subset: the socket used to spell out
    // the two fields it knew about, which is how it would come to say less
    // than the same announcement read over HTTP.
    expect(await client.nextSchedule()).toMatchObject({
      schedule: { startsAt: SATURDAY + 3600_000, poster: null, kind: 'talk', title: 'Sipho' },
    })

    harness.schedule.clear()
    expect(await client.nextSchedule()).toEqual({ type: 'schedule', schedule: null })
    await client.close()
  })
})
