/**
 * Short-lived relay credentials.
 *
 * Cloudflare's TURN hands out a key id and an API token rather than a password,
 * and those are exchanged for a username and credential that expire. That is a
 * better shape than a static secret — a relay credential that leaks and lapses
 * the same day is a much smaller thing to have lost — and it is why they cannot
 * simply be typed into `TURN_USERNAME`.
 *
 * Two things are worth holding on to here. The first is that this is somebody
 * else's JSON crossing a network, so it is read field by field rather than
 * trusted: a shape that changed should cost the station its relay and a line in
 * the log, never a 500 on the endpoint both ends of every voice depend on. The
 * second is that a room arriving together must not become a room's worth of
 * requests to Cloudflare to be told the same answer.
 */
import { describe, expect, it, vi } from 'vitest'
import { CloudflareTurn, readIceServers } from '../src/turn.js'
import { fakeClock } from './helpers.js'

/** What Cloudflare documents itself as answering. */
const ANSWER = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'a-minted-username',
      credential: 'a-minted-credential',
    },
  ],
}

function answering(body: unknown, status = 201) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('readIceServers', () => {
  it('takes the documented answer', () => {
    expect(readIceServers(ANSWER)).toEqual(ANSWER.iceServers)
  })

  it('takes a lone object too', () => {
    // It has been one before, and the difference is not worth losing a relay
    // over: a station with no TURN is a station that fails for everybody on a
    // phone, which is the case it was configured for.
    const single = { iceServers: { urls: 'turn:one:3478', username: 'u', credential: 'c' } }
    expect(readIceServers(single)).toEqual([
      { urls: ['turn:one:3478'], username: 'u', credential: 'c' },
    ])
  })

  it('keeps a STUN entry that has no credentials, and drops half a credential', () => {
    // Both or neither. A relay address with only a username refuses everybody,
    // and would look configured while being useless.
    const body = {
      iceServers: [
        { urls: ['stun:one:3478'] },
        { urls: ['turn:two:3478'], username: 'u' },
        { urls: ['turn:three:3478'], username: 'u', credential: 'c' },
      ],
    }
    expect(readIceServers(body)).toEqual([
      { urls: ['stun:one:3478'] },
      { urls: ['turn:two:3478'] },
      { urls: ['turn:three:3478'], username: 'u', credential: 'c' },
    ])
  })

  it('shrugs at anything it cannot read', () => {
    for (const body of [null, 'no', 42, {}, { iceServers: 'no' }, { iceServers: [null, {}, { urls: [] }] }]) {
      expect(readIceServers(body), JSON.stringify(body)).toEqual([])
    }
  })
})

describe('CloudflareTurn', () => {
  it('asks Cloudflare the way Cloudflare documents', async () => {
    const fetchFn = answering(ANSWER)
    const turn = new CloudflareTurn({ keyId: 'the-key', apiToken: 'the-token', fetchFn })

    expect(await turn.servers()).toEqual(ANSWER.iceServers)

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/the-key/credentials/generate-ice-servers',
    )
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer the-token')
    expect(JSON.parse(String(init.body))).toEqual({ ttl: 86_400 })
  })

  it('mints once and shares it', async () => {
    // A room arriving together is thirty listeners asking inside a few seconds.
    const fetchFn = answering(ANSWER)
    const turn = new CloudflareTurn({ keyId: 'k', apiToken: 't', fetchFn })

    await Promise.all(Array.from({ length: 30 }, () => turn.servers()))

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('keeps them until they are near lapsing', async () => {
    const clock = fakeClock()
    const fetchFn = answering(ANSWER)
    const turn = new CloudflareTurn({
      keyId: 'k',
      apiToken: 't',
      fetchFn,
      now: clock.now,
      ttlSeconds: 3_600,
    })

    await turn.servers()
    clock.advance(10 * 60 * 1000)
    await turn.servers()
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Past the refresh margin, which for a short life is a quarter of it. What
    // expires is the ability to open a *new* allocation, not one already
    // carrying a voice, so there is no need to cut this fine.
    clock.advance(50 * 60 * 1000)
    await turn.servers()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does not re-mint on every ask when the credentials are short-lived', async () => {
    // The margin is relative for this reason. A flat one longer than the TTL
    // puts every set past its refresh point the moment it is minted, so the
    // cache never hits and every listener becomes a call to Cloudflare —
    // silently, and only ever noticed on a bill.
    const clock = fakeClock()
    const fetchFn = answering(ANSWER)
    const turn = new CloudflareTurn({
      keyId: 'k',
      apiToken: 't',
      fetchFn,
      now: clock.now,
      ttlSeconds: 60,
    })

    for (let i = 0; i < 10; i++) await turn.servers()

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('says so and carries on when Cloudflare refuses', async () => {
    // A station that cannot mint still works for every listener who did not
    // need a relay. Losing the endpoint would take the voice from all of them.
    const onError = vi.fn()
    const turn = new CloudflareTurn({
      keyId: 'k',
      apiToken: 't',
      fetchFn: answering({ error: 'nope' }, 403),
      onError,
    })

    expect(await turn.servers()).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('says so when it cannot be reached at all', async () => {
    const onError = vi.fn()
    const turn = new CloudflareTurn({
      keyId: 'k',
      apiToken: 't',
      fetchFn: vi.fn(async () => {
        throw new Error('offline')
      }),
      onError,
    })

    expect(await turn.servers()).toEqual([])
    expect(onError).toHaveBeenCalled()
  })

  it('keeps yesterday’s rather than dropping the relay over one failed refresh', async () => {
    const clock = fakeClock()
    let body: unknown = ANSWER
    let status = 201
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status })

    const turn = new CloudflareTurn({
      keyId: 'k',
      apiToken: 't',
      fetchFn,
      now: clock.now,
      ttlSeconds: 3_600,
    })
    await turn.servers()

    body = { error: 'briefly unavailable' }
    status = 500
    clock.advance(50 * 60 * 1000)

    // A credential a little stale still opens an allocation; a station that
    // dropped its relay because one refresh failed would be worse.
    expect(await turn.servers()).toEqual(ANSWER.iceServers)
  })

  it('tries again after a failure rather than caching the emptiness', async () => {
    let body: unknown = { error: 'nope' }
    let status = 500
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify(body), { status })

    const turn = new CloudflareTurn({ keyId: 'k', apiToken: 't', fetchFn })
    expect(await turn.servers()).toEqual([])

    body = ANSWER
    status = 201
    expect(await turn.servers()).toEqual(ANSWER.iceServers)
  })
})
