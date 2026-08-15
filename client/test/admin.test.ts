import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminApi, AdminError, isAdminRoute, refusalMessage } from '../src/lib/admin.js'

const PASSWORD = 'hunter2'

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[]
let respond: (url: string, init: RequestInit) => Response

/** Stands in for the network. Every request is recorded, in order. */
const fetchStub = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input)
  calls.push({ url, init })
  return Promise.resolve(respond(url, init))
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const api = () => new AdminApi({ fetch: fetchStub as unknown as typeof globalThis.fetch })

const headerOf = (call: Call, name: string) =>
  new Headers(call.init.headers as HeadersInit).get(name)

beforeEach(() => {
  calls = []
  respond = () => json({})
  fetchStub.mockClear()
})

describe('isAdminRoute', () => {
  it('opens on #admin or /admin, and nowhere else', () => {
    expect(isAdminRoute({ pathname: '/', hash: '#admin' })).toBe(true)
    expect(isAdminRoute({ pathname: '/admin', hash: '' })).toBe(true)

    expect(isAdminRoute({ pathname: '/', hash: '' })).toBe(false)
    expect(isAdminRoute({ pathname: '/', hash: '#administrator' })).toBe(false)
    expect(isAdminRoute({ pathname: '/admin-ish', hash: '' })).toBe(false)
  })
})

describe('AdminApi sign-in', () => {
  it('posts the password once, and nowhere else', async () => {
    respond = () => json({ ok: true, tracks: [], entries: [] })

    const session = api()
    await session.signIn(PASSWORD)
    await session.command({ action: 'pause' })
    await session.enqueue(7)
    await session.upload(new File(['bytes'], 'track.mp3', { type: 'audio/mpeg' }))

    expect(calls[0]).toMatchObject({ url: '/api/admin/session' })
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ password: PASSWORD })

    // After that the cookie is the credential: the password is not repeated,
    // and nothing here could resend it if it wanted to.
    for (const call of calls.slice(1)) {
      expect(headerOf(call, 'authorization')).toBeNull()
      expect(String(call.init.body ?? '')).not.toContain(PASSWORD)
    }
  })

  it('sends the session cookie with every request', async () => {
    respond = () => json({ ok: true, tracks: [], entries: [] })

    const session = api()
    await session.signIn(PASSWORD)
    await session.verify()
    await session.tracks()
    await session.command({ action: 'skip' })
    await session.move(3, 0)
    await session.remove(3)
    await session.clearQueue()
    await session.signOut()

    expect(calls).toHaveLength(8)
    for (const call of calls) {
      expect(call.init.credentials).toBe('same-origin')
    }
  })

  it('reports a rejected password rather than throwing', async () => {
    respond = () => json({ error: 'unauthorized', message: 'wrong password' }, 401)

    await expect(api().signIn('nope')).resolves.toBe(false)
    await expect(api().verify()).resolves.toBe(false)
  })

  it('accepts a session the server is happy with', async () => {
    respond = (url) => (url.endsWith('/api/admin/session') ? json({ ok: true }) : json({}, 500))

    await expect(api().signIn(PASSWORD)).resolves.toBe(true)
    await expect(api().verify()).resolves.toBe(true)
  })

  it('throws when the station cannot answer at all, which is not a wrong password', async () => {
    respond = () => new Response('<html>502 Bad Gateway</html>', { status: 502 })

    await expect(api().signIn(PASSWORD)).rejects.toBeInstanceOf(AdminError)
    await expect(api().verify()).rejects.toBeInstanceOf(AdminError)
  })

  it('asks the station to end the session, and shrugs if it cannot', async () => {
    respond = () => json({ ok: true })
    await api().signOut()

    expect(calls[0]).toMatchObject({ url: '/api/admin/session' })
    expect(calls[0]!.init.method).toBe('DELETE')

    // The admin asked to be signed out; an unreachable station doesn't get a
    // say in it, and a rejected promise here would surface as a UI error.
    respond = () => json({ error: 'nope' }, 500)
    await expect(api().signOut()).resolves.toBeUndefined()
  })

  it('marks a mid-session 401 as unauthorized, so the UI can sign out', async () => {
    respond = () => json({ error: 'unauthorized' }, 401)

    const err = await api()
      .command({ action: 'skip' })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AdminError)
    expect((err as AdminError).unauthorized).toBe(true)
    expect((err as AdminError).message).toBe('session ended, sign in again')
  })
})

describe('AdminApi playback commands', () => {
  it('posts the command as JSON', async () => {
    respond = () => json({ type: 'state', track: null })

    await api().command({ action: 'play', trackId: 4 })

    expect(calls[0]!.url).toBe('/api/playback')
    expect(calls[0]!.init.method).toBe('POST')
    expect(headerOf(calls[0]!, 'content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ action: 'play', trackId: 4 })
  })

  it('surfaces what the server said when a command is refused', async () => {
    respond = () => json({ error: 'unknown_track', message: 'no track 99' }, 404)

    const err = await api()
      .command({ action: 'play', trackId: 99 })
      .catch((e: unknown) => e)

    expect((err as AdminError).status).toBe(404)
    expect((err as AdminError).code).toBe('unknown_track')
    expect((err as AdminError).message).toBe('no track 99')
  })

  it('still says something useful when the failure is not JSON', async () => {
    respond = () => new Response('<html>502 Bad Gateway</html>', { status: 502 })

    const err = await api().clearQueue().catch((e: unknown) => e)

    expect((err as AdminError).status).toBe(502)
    expect((err as AdminError).message).toBe('request failed (502)')
  })
})

describe('AdminApi queue', () => {
  it('addresses entries by id, and sends the target position', async () => {
    respond = () => json({ entries: [] })

    await api().move(12, 3)
    await api().remove(12)
    await api().clearQueue()

    expect(calls[0]!.url).toBe('/api/queue/move')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ entryId: 12, toIndex: 3 })
    expect(calls[1]).toMatchObject({ url: '/api/queue/12' })
    expect(calls[1]!.init.method).toBe('DELETE')
    expect(calls[2]).toMatchObject({ url: '/api/queue' })
    expect(calls[2]!.init.method).toBe('DELETE')
  })

  it('queues a track by id', async () => {
    respond = () => json({ entry: { id: 1 }, entries: [{ id: 1 }] })

    const result = await api().enqueue(5)

    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ trackId: 5 })
    expect(result.entries).toHaveLength(1)
  })

  it('unwraps the library and the queue', async () => {
    respond = (url) =>
      url.endsWith('/api/tracks') ? json({ tracks: [{ id: 1 }] }) : json({ entries: [{ id: 9 }] })

    expect(await api().tracks()).toEqual([{ id: 1 }])
    expect(await api().queue()).toEqual([{ id: 9 }])
  })
})

describe('AdminApi wishes', () => {
  const book = { wishes: [{ id: 3, nickname: 'sam', text: 'some Bowie', at: 0, status: 'new' }], outstanding: 1 }

  it('reads the book whole, count and all', async () => {
    respond = () => json(book)

    // Not unwrapped to just the list: the count comes from the server so the
    // heading and the rows can never disagree about what is outstanding.
    expect(await api().wishes()).toEqual(book)
    expect(calls[0]).toMatchObject({ url: '/api/wishes' })
    expect(calls[0]!.init.method).toBe('GET')
  })

  it('marks one handled by id, and can put it back', async () => {
    respond = () => json({ wish: { id: 3, status: 'handled' }, ...book })

    await api().markWish(3, 'handled')
    await api().markWish(3, 'new')

    expect(calls[0]).toMatchObject({ url: '/api/wishes/3' })
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ status: 'handled' })
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ status: 'new' })
  })

  it('throws a session-ended error when the cookie has lapsed', async () => {
    respond = () => json({ error: 'unauthorized', message: 'nope' }, 401)

    // The panel polls this on a timer, so it is the first request likely to
    // meet a lapsed session, and it has to be the same error every other
    // control reacts to by signing out.
    await expect(api().wishes()).rejects.toMatchObject({ name: 'AdminError', status: 401 })
  })
})

describe('AdminApi upload', () => {
  const file = () => new File(['audio bytes'], 'track.mp3', { type: 'audio/mpeg' })

  it('sends the file as multipart, and lets fetch set the boundary', async () => {
    respond = () => json({ track: { id: 1, title: 'Track' } }, 201)

    const result = await api().upload(file())

    expect(calls[0]!.url).toBe('/api/upload')
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
    expect((calls[0]!.init.body as FormData).get('file')).toBeInstanceOf(File)
    // Setting content-type by hand here would omit the multipart boundary and
    // the server would reject the body as malformed.
    expect(headerOf(calls[0]!, 'content-type')).toBeNull()
    expect(result.duplicate).toBe(false)
  })

  it('treats a duplicate as a success: the track is in the library either way', async () => {
    respond = () =>
      json({ error: 'duplicate', message: 'already', track: { id: 3, title: 'Track' } }, 409)

    const result = await api().upload(file())

    expect(result.duplicate).toBe(true)
    expect(result.track.id).toBe(3)
  })

  it('reports what the server said about a file it would not take', async () => {
    respond = () => json({ error: 'unsupported_audio', message: 'not usable audio' }, 415)

    const err = await api().upload(file()).catch((e: unknown) => e)

    expect((err as AdminError).status).toBe(415)
    expect((err as AdminError).message).toBe('not usable audio')
  })
})

/**
 * Which refusals are the station's words, and which are ours.
 *
 * Every 4xx message in this API is written to be shown; that is the contract
 * `server/src/lib/errors.ts` keeps, and why it replaces 5xx messages rather than
 * repeating them. Sign-in is throttled, so "wait a moment and try again" is now
 * a thing the station says, and reporting it as "could not reach the station"
 * would send the admin looking for a network problem that is not there.
 */
describe('refusalMessage', () => {
  it('repeats what the station said about a refusal it wrote', () => {
    const throttled = new AdminError(429, 'too_many_requests', 'too many sign-in attempts')
    expect(refusalMessage(throttled)).toBe('too many sign-in attempts')
  })

  it('says nothing about a failure the station did not describe', () => {
    // A 500's message is replaced server-side precisely because it can carry a
    // path or a stack, so there is nothing there worth showing.
    expect(refusalMessage(new AdminError(500, 'internal_error', 'the station could not'))).toBeNull()
    // And a network failure is not an AdminError at all.
    expect(refusalMessage(new TypeError('Failed to fetch'))).toBeNull()
    expect(refusalMessage(undefined)).toBeNull()
  })
})

describe('going on and off air', () => {
  it('asks the station which way round it is', async () => {
    respond = () => json({ live: true, since: 1_700_000_000_000 })
    expect(await api().air()).toEqual({ live: true, since: 1_700_000_000_000 })
    expect(calls[0]?.url).toBe('/api/session')
    expect(calls[0]?.init.method).toBe('GET')
  })

  it('sends the verb the station takes', async () => {
    respond = () => json({ live: true, since: 1 })
    await api().session('start')
    expect(calls[0]?.url).toBe('/api/session')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'start' })
  })

  it('ends it', async () => {
    respond = () => json({ live: false, since: null })
    expect(await api().session('end')).toEqual({ live: false, since: null })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'end' })
  })

  it('says what kind of night is starting, when it is not the usual one', async () => {
    respond = () => json({ live: true, since: 1, kind: 'talk' })
    await api().session('start', 'talk')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'start', kind: 'talk' })
  })

  it('leaves the kind out rather than guessing it', async () => {
    // Absent means a set at the station, which is what every caller written
    // before there were two kinds of night meant by saying nothing. Sending
    // `kind: undefined` would be this class inventing an answer for them.
    respond = () => json({ live: false, since: null })
    await api().session('end', undefined)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ action: 'end' })
  })
})

describe('announcing the next session', () => {
  /** The multipart body as a map of the fields it carries. */
  function fields(body: unknown): Record<string, string> {
    const form = body as FormData
    const out: Record<string, string> = {}
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') out[name] = value
    }
    return out
  }

  it('carries the kind and the title beside the time', async () => {
    respond = () => json({ schedule: null })
    await api().announce(1_700_500_000_000, null, { kind: 'talk', title: 'Sipho' })

    expect(calls[0]?.url).toBe('/api/schedule')
    expect(fields(calls[0]?.init.body)).toEqual({
      startsAt: '1700500000000',
      kind: 'talk',
      title: 'Sipho',
    })
  })

  it('sends both of them even when they are empty', async () => {
    // Unlike the poster, these are not kept across an edit at the station, so a
    // form that left them out would announce a set with no title every time
    // somebody moved the hour of a conversation.
    respond = () => json({ schedule: null })
    await api().announce(1_700_500_000_000)
    expect(fields(calls[0]?.init.body)).toEqual({
      startsAt: '1700500000000',
      kind: 'set',
      title: '',
    })
  })
})

describe('muting a nickname', () => {
  it('reads the list', async () => {
    respond = () => json({ nicknames: ['sam'] })
    expect(await api().mutes()).toEqual(['sam'])
    expect(calls[0]?.url).toBe('/api/mutes')
    expect(calls[0]?.init.method).toBe('GET')
  })

  it('says where the nickname now stands, not "toggle"', async () => {
    // The same shape a re-join takes: two of these in a row leave one mute,
    // so a retry after a dropped response is safe.
    respond = () => json({ nicknames: ['sam'] })
    expect(await api().mute('sam', true)).toEqual(['sam'])
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ nickname: 'sam', muted: true })
  })

  it('lifts one', async () => {
    respond = () => json({ nicknames: [] })
    expect(await api().mute('sam', false)).toEqual([])
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ nickname: 'sam', muted: false })
  })

  it('reports a refusal the way every other call does', async () => {
    respond = () => json({ error: 'unauthorized', message: 'sign in first' }, 401)
    await expect(api().mute('sam', true)).rejects.toBeInstanceOf(AdminError)
  })
})

describe('padding the headcount', () => {
  it('reads the count', async () => {
    respond = () => json({ padding: 28 })
    expect(await api().padding()).toBe(28)
    expect(calls[0]?.url).toBe('/api/padding')
    expect(calls[0]?.init.method).toBe('GET')
  })

  it('says where the count now stands, not "one more"', async () => {
    // The shape that makes the plus button safe to press twice: a retry after
    // a dropped response leaves one count, not two.
    respond = () => json({ padding: 29 })
    expect(await api().setPadding(29)).toBe(29)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ padding: 29 })
  })

  it("takes the station's answer rather than what was asked for", async () => {
    // The count is clamped at the station, so the panel renders what came back
    // and can never be left showing a number nobody holds.
    respond = () => json({ padding: 9_999 })
    expect(await api().setPadding(50_000)).toBe(9_999)
  })

  it('reports a refusal the way every other call does', async () => {
    respond = () => json({ error: 'unauthorized', message: 'sign in first' }, 401)
    await expect(api().setPadding(1)).rejects.toBeInstanceOf(AdminError)
  })
})
