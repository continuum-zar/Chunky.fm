/**
 * Introducing two browsers to each other.
 *
 * The station relays signalling and reads none of it: an offer, an answer and
 * an ICE candidate all cross this server as opaque payloads, the same way no
 * audio crosses it at all. So almost nothing here is about WebRTC. What it is
 * about is the address book, which is the only part the station owns:
 *
 *   - the decks may reach any socket, which is what fanning a voice out is;
 *   - a listener may reach the decks and nobody else;
 *   - `from` is stamped by the server, so nobody can claim to be the decks.
 *
 * That third one is the load-bearing rule. Without it a listener could offer
 * another listener a microphone in the station's name, and the station would
 * introduce two strangers on the strength of a field one of them typed.
 *
 * The other thing pinned here is the frame size. An SDP description does not
 * fit in the ceiling the socket used to have, and the failure mode was not a
 * refusal but a disconnection — the station appearing to drop at exactly the
 * moment somebody tried to speak.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ErrorMessage, SignalMessage, YouMessage } from '../src/protocol.js'
import { ADMIN_PASSWORD, type Harness, startHarness } from './helpers.js'
import { TestClient } from './ws-client.js'

let harness: Harness
const clients: TestClient[] = []

beforeEach(async () => {
  harness = await startHarness({}, { listen: true })
})
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()))
  clients.length = 0
  await harness.cleanup()
})

/** A plain listener. */
async function listener(): Promise<TestClient> {
  const client = await TestClient.connect(harness.wsUrl)
  clients.push(client)
  return client
}

/**
 * The console. The password rides the upgrade the way the admin cookie does in
 * a browser; `hasAdminCredentials` takes either, which is what lets the socket
 * ask the same question of the same code.
 */
async function decks(): Promise<TestClient> {
  const client = await TestClient.connect(harness.wsUrl, { 'x-admin-password': ADMIN_PASSWORD })
  clients.push(client)
  return client
}

const whoAmI = async (client: TestClient): Promise<number> =>
  ((await client.waitFor((m) => m.type === 'you')) as YouMessage).id

const nextSignal = async (client: TestClient): Promise<SignalMessage> =>
  (await client.waitFor((m) => m.type === 'signal')) as SignalMessage

const nextError = async (client: TestClient): Promise<ErrorMessage> =>
  (await client.waitFor((m) => m.type === 'error')) as ErrorMessage

describe('who a socket is', () => {
  it('is the first thing it is told', async () => {
    // Before anything about the station, because an offer is addressed to an
    // id and neither end of one means anything until both know their own.
    const client = await listener()
    expect(await whoAmI(client)).toBeGreaterThan(0)
    expect(client.seen[0]?.type).toBe('you')
  })

  it('is a different id for every socket, and never reused', async () => {
    // A reconnect is a new row in the roster, which is what "left and came
    // back" should look like, and the same reason means an id cannot be
    // recycled onto somebody else mid-negotiation.
    const first = await whoAmI(await listener())
    const second = await listener()
    const third = await listener()
    const ids = [first, await whoAmI(second), await whoAmI(third)]
    expect(new Set(ids).size).toBe(3)

    await second.close()
    expect(ids).not.toContain(await whoAmI(await listener()))
  })

  it('matches the id this socket appears under on the roster', async () => {
    // The two have to be the same number or the decks would be offering a voice
    // to a name rather than to a connection.
    const client = await listener()
    const id = await whoAmI(client)
    await client.nextPresence()
    const roster = await client.join('sam')
    expect(roster.listeners).toEqual([{ id, nickname: 'sam' }])
  })
})

describe('the decks signalling a listener', () => {
  it('carries the payload through untouched', async () => {
    const sam = await listener()
    const samId = await whoAmI(sam)
    const console_ = await decks()
    const deckId = await whoAmI(console_)

    // Deliberately not SDP-shaped: the station has no opinion about what this
    // is, and a test that sent a real offer would suggest it had one.
    const payload = { kind: 'offer', sdp: 'v=0\r\nnonsense', extra: [1, 2, 3] }
    console_.send({ type: 'signal', to: samId, payload })

    expect(await nextSignal(sam)).toEqual({ type: 'signal', from: deckId, payload })
  })

  it('lets the listener answer', async () => {
    const sam = await listener()
    const samId = await whoAmI(sam)
    const console_ = await decks()
    const deckId = await whoAmI(console_)

    console_.send({ type: 'signal', to: samId, payload: { kind: 'offer', sdp: 'x' } })
    await nextSignal(sam)
    sam.send({ type: 'signal', to: deckId, payload: { kind: 'answer', sdp: 'y' } })

    expect(await nextSignal(console_)).toMatchObject({
      from: samId,
      payload: { kind: 'answer', sdp: 'y' },
    })
  })

  it('reaches a socket that never named itself', async () => {
    // Presence holds only sockets that have said who they are, and a console is
    // usually not one of them. Signalling is addressed to connections, so it
    // has to work for a socket the roster has never heard of.
    const lurker = await listener()
    const lurkerId = await whoAmI(lurker)
    const console_ = await decks()

    console_.send({ type: 'signal', to: lurkerId, payload: { kind: 'offer', sdp: 'x' } })

    expect(await nextSignal(lurker)).toMatchObject({ payload: { kind: 'offer', sdp: 'x' } })
    expect(harness.app.realtime.listeners()).toEqual([])
  })

  it('says so when the listener has already gone', async () => {
    // Ordinary rather than exceptional: a tab closed between the roster going
    // out and the offer being written. Told, so the decks stop waiting on it.
    const sam = await listener()
    const samId = await whoAmI(sam)
    const console_ = await decks()
    await sam.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    console_.send({ type: 'signal', to: samId, payload: { kind: 'offer', sdp: 'x' } })

    expect(await nextError(console_)).toMatchObject({ code: 'no_such_peer', about: 'signal' })
  })
})

describe('what a listener may not do', () => {
  it('cannot signal another listener', async () => {
    // The rule the whole relay exists to enforce. Two listeners have no
    // business negotiating, and a socket that could reach any other by id
    // would be a way to make the station introduce strangers.
    const sam = await listener()
    const ben = await listener()
    const benId = await whoAmI(ben)
    await whoAmI(sam)

    sam.send({ type: 'signal', to: benId, payload: { kind: 'offer', sdp: 'x' } })

    expect(await nextError(sam)).toMatchObject({ code: 'not_the_decks', about: 'signal' })
    // And nothing arrived: a refusal that still delivered would be worse than
    // no rule at all.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(ben.seen.filter((m) => m.type === 'signal')).toHaveLength(0)
  })

  it('cannot claim a frame came from somebody else', async () => {
    // `from` is stamped by the server and the sender's own `from` is ignored,
    // for the reason a chat message's author is looked up rather than taken
    // from the frame: otherwise a listener could pose as the decks.
    const sam = await listener()
    const samId = await whoAmI(sam)
    const console_ = await decks()
    const deckId = await whoAmI(console_)

    sam.send({
      type: 'signal',
      to: deckId,
      from: 9999,
      payload: { kind: 'answer', sdp: 'x' },
    } as never)

    expect(await nextSignal(console_)).toMatchObject({ from: samId })
  })

  it('cannot signal itself into being the decks', async () => {
    const sam = await listener()
    const samId = await whoAmI(sam)
    sam.send({ type: 'signal', to: samId, payload: { kind: 'offer', sdp: 'x' } })
    expect(await nextError(sam)).toMatchObject({ code: 'not_the_decks' })
  })

  it('is paced, unlike the decks', async () => {
    // The bucket is here for the reason the chat's is: nothing a single
    // anonymous socket sends should turn into unbounded work. The decks are
    // exempt, because fanning a voice out to a full room is a burst by design
    // and whoever is doing it already holds the password.
    await harness.cleanup()
    harness = await startHarness({}, { listen: true, signalBurst: 2, signalRefillMs: 60_000 })

    const console_ = await TestClient.connect(harness.wsUrl, { 'x-admin-password': ADMIN_PASSWORD })
    clients.push(console_)
    const deckId = await whoAmI(console_)
    const sam = await TestClient.connect(harness.wsUrl)
    clients.push(sam)
    const samId = await whoAmI(sam)

    for (let i = 0; i < 2; i++) sam.send({ type: 'signal', to: deckId, payload: { i } })
    sam.send({ type: 'signal', to: deckId, payload: { i: 'one too many' } })
    expect(await nextError(sam)).toMatchObject({ code: 'slow_down', about: 'signal' })

    // The same burst from the decks goes through untouched.
    for (let i = 0; i < 10; i++) console_.send({ type: 'signal', to: samId, payload: { i } })
    for (let i = 0; i < 10; i++) expect(await nextSignal(sam)).toMatchObject({ payload: { i } })
  })
})

describe('the shape of a signalling frame', () => {
  it('needs somebody to address', async () => {
    const sam = await listener()
    for (const frame of [
      { type: 'signal', payload: {} },
      { type: 'signal', to: 'decks', payload: {} },
      { type: 'signal', to: 0, payload: {} },
      { type: 'signal', to: -1, payload: {} },
      { type: 'signal', to: 1.5, payload: {} },
    ]) {
      sam.send(frame as never)
      expect(await nextError(sam), JSON.stringify(frame)).toMatchObject({
        code: 'unrecognised_message',
        about: 'signal',
      })
    }
  })

  it('needs something to carry', async () => {
    const sam = await listener()
    const console_ = await decks()
    sam.send({ type: 'signal', to: await whoAmI(console_) } as never)
    expect(await nextError(sam)).toMatchObject({ code: 'unrecognised_message', about: 'signal' })
  })

  it('takes a description far larger than the socket used to allow', async () => {
    // The gotcha this milestone was warned about. A real SDP runs past the old
    // 4 KiB ceiling, and ws answers an oversized frame by *closing the socket*
    // — so the failure looked like the station dropping for no reason, at
    // exactly the moment somebody tried to speak.
    const sam = await listener()
    const samId = await whoAmI(sam)
    const console_ = await decks()

    const sdp = `v=0\r\n${'a=candidate:fake 1 udp 2113937151 192.0.2.1 50000 typ host\r\n'.repeat(100)}`
    expect(sdp.length).toBeGreaterThan(4 * 1024)
    console_.send({ type: 'signal', to: samId, payload: { kind: 'offer', sdp } })

    expect(await nextSignal(sam)).toMatchObject({ payload: { sdp } })
    // And the socket that sent it is still up, which is the half that used to
    // fail silently.
    expect(await whoAmI(console_)).toBeGreaterThan(0)
  })
})

describe('who counts as the decks', () => {
  it('is decided on the upgrade, from the credentials the browser already sends', async () => {
    // The same question `requireAdmin` asks of an HTTP request, asked of the
    // upgrade that became this socket. It buys one privilege and one only:
    // addressing a listener.
    const sam = await listener()
    const console_ = await decks()
    console_.send({ type: 'signal', to: await whoAmI(sam), payload: { kind: 'offer', sdp: 'x' } })
    expect(await nextSignal(sam)).toMatchObject({ from: await whoAmI(console_) })
  })

  it('is not a password that nearly worked', async () => {
    const impostor = await TestClient.connect(harness.wsUrl, { 'x-admin-password': 'not-the-one' })
    clients.push(impostor)
    const ben = await listener()

    impostor.send({ type: 'signal', to: await whoAmI(ben), payload: {} })

    expect(await nextError(impostor)).toMatchObject({ code: 'not_the_decks' })
  })

  it('shortens the mic when the last one leaves, rather than ending it', async () => {
    // A console whose socket dropped may only be reconnecting: renewals ride
    // HTTP, which survives a blip the socket does not. So the mic stays open
    // and its lease is cut short, and a console that really has gone lapses in
    // a few seconds instead of a full one.
    const console_ = await decks()
    await whoAmI(console_)
    harness.mic.open()
    const wasExpiring = harness.mic.expiresAt

    await console_.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.mic.live).toBe(true)
    expect(harness.mic.expiresAt).toBeLessThan(wasExpiring)
  })

  it('leaves the mic alone while another console is still open', async () => {
    // Two tabs on the decks is ordinary, and closing one of them is not the
    // station losing its console.
    const first = await decks()
    const second = await decks()
    await whoAmI(first)
    await whoAmI(second)
    harness.mic.open()
    const wasExpiring = harness.mic.expiresAt

    await first.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.mic.expiresAt).toBe(wasExpiring)
  })

  it('says nothing about a listener leaving', async () => {
    const console_ = await decks()
    const sam = await listener()
    await whoAmI(console_)
    await whoAmI(sam)
    harness.mic.open()
    const wasExpiring = harness.mic.expiresAt

    await sam.close()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(harness.mic.expiresAt).toBe(wasExpiring)
  })

  it('still buys nothing else: the socket drives no more than it ever did', async () => {
    // The read-only rule bends for signalling and for nothing beside it. A
    // socket holding the password is refused a command exactly as a stranger's
    // is, because commands go over HTTP where the gate lives.
    const console_ = await decks()
    console_.send({ type: 'skip' } as never)
    expect(await nextError(console_)).toMatchObject({ code: 'command_over_http' })

    console_.send({ type: 'mic' } as never)
    expect(await nextError(console_)).toMatchObject({ code: 'command_over_http' })
  })
})
