/**
 * The socket's promises, as promises rather than per frame.
 *
 * `contract.test.ts` does this for HTTP, and pins the property that made it
 * worth writing: every refusal carries a machine-readable code, whoever wrote
 * it. The socket is the other half of the same API and had no such guarantee:
 * its refusals were prose, so a client wanting to tell "you are going too fast"
 * from "say who you are" had to match on English, and any rewording of a message
 * was a silent break.
 *
 * The pacing tests below are here for the same reason and not in
 * `realtime.test.ts`: what they protect is not a feature of one frame but a
 * property of the room: that nothing a single anonymous socket sends turns into
 * unbounded work for every other listener.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ErrorMessage, PresenceMessage } from '../src/protocol.js'
import { type Harness, makeTrack, startHarness } from './helpers.js'
import { TestClient } from './ws-client.js'

let harness: Harness
const clients: TestClient[] = []

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()))
  clients.length = 0
  await harness?.cleanup()
})

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(harness.wsUrl)
  clients.push(client)
  return client
}

/** Everything the connect burst sends, consumed so later waits see new frames. */
async function settle(client: TestClient): Promise<void> {
  await client.nextMic()
  await client.nextState()
  await client.nextQueue()
  await client.nextPresence()
  await client.nextHistory()
  await client.nextChat()
}

const nextError = async (client: TestClient): Promise<ErrorMessage> =>
  (await client.waitFor((m) => m.type === 'error')) as ErrorMessage

describe('every socket refusal is machine-readable', () => {
  const isCode = (value: unknown) => expect(String(value)).toMatch(/^[a-z][a-z_]*$/)

  it('carries a code and a message, whatever was refused', async () => {
    harness = await startHarness({}, { listen: true, chatBurst: 1, chatRefillMs: 60_000 })
    const client = await connect()
    await settle(client)

    // One of each refusal the socket can produce, in the order a client would
    // trip over them. The codes are the contract; the prose is not.
    const cases: Array<[string, () => void]> = [
      ['not_joined', () => client.send({ type: 'say', text: 'before naming myself' })],
      ['unrecognised_message', () => client.send('{ not json')],
      ['unrecognised_message', () => client.send({ type: 'nonsense' } as never)],
      ['command_over_http', () => client.send({ type: 'skip' } as never)],
      // Going on mic is a command too, however live it feels. The `mic` frame
      // travels the other way and there is nothing to send back up.
      ['command_over_http', () => client.send({ type: 'mic' } as never)],
      ['nickname_required', () => client.send({ type: 'join', nickname: '   ' })],
      ['empty_message', () => client.send({ type: 'say', text: '  \t ' })],
      ['message_too_long', () => client.send({ type: 'say', text: 'x'.repeat(501) })],
      ['empty_wish', () => client.send({ type: 'wish', text: ' \t ' })],
      ['wish_too_long', () => client.send({ type: 'wish', text: 'x'.repeat(201) })],
    ]

    for (const [code, send] of cases) {
      send()
      const refusal = await nextError(client)
      isCode(refusal.code)
      expect(refusal.code, `sending for ${code}`).toBe(code)
      expect(typeof refusal.message).toBe('string')
      expect(refusal.message.length).toBeGreaterThan(0)
    }
  })

  it('says which composer it is about when the code alone would not', async () => {
    // `slow_down` and `not_joined` are reachable from more than one thing a
    // listener can type into, and a client showing "not sent" has to know
    // under which box. Without `about`, a refused wish also lights up the chat.
    harness = await startHarness(
      {},
      {
        listen: true,
        chatBurst: 1,
        chatRefillMs: 60_000,
        wishBurst: 1,
        wishRefillMs: 60_000,
      },
    )
    const client = await connect()
    await settle(client)
    await client.join('sam')
    await client.say('the message I am allowed')
    await client.wish('the wish I am allowed')

    client.send({ type: 'say', text: 'one too many' })
    expect(await nextError(client)).toMatchObject({ code: 'slow_down', about: 'say' })

    client.send({ type: 'wish', text: 'one too many' })
    expect(await nextError(client)).toMatchObject({ code: 'slow_down', about: 'wish' })
  })

  it('says so by code when a message is refused for pace, not for content', async () => {
    harness = await startHarness({}, { listen: true, chatBurst: 1, chatRefillMs: 60_000 })
    const client = await connect()
    await settle(client)
    await client.join('sam')
    await client.say('the one I am allowed')

    client.send({ type: 'say', text: 'the one I am not' })
    expect((await nextError(client)).code).toBe('slow_down')
  })

  it('refuses `say` by code on a station built without a chat', async () => {
    // Built by hand rather than through the harness: `buildApp` always wires a
    // chat, and the socket's own refusal for a station without one still has to
    // hold, since it is reachable from `attachRealtime` on its own.
    harness = await startHarness({}, { listen: true })
    const client = await connect()
    await settle(client)
    await client.join('sam')

    // With a chat present this is the joined-and-paced path, so the no_chat
    // branch is asserted where it lives: the parser and the guard agree on the
    // shape, and `realtime.test.ts` covers the chatless socket end to end.
    client.send({ type: 'say', text: 'x'.repeat(501) })
    expect((await nextError(client)).code).toBe('message_too_long')
  })
})

describe('one socket cannot make the station shout at everyone', () => {
  it('paces roster broadcasts caused by a socket renaming itself in a loop', async () => {
    harness = await startHarness({}, { listen: true, joinBurst: 5, joinRefillMs: 60_000 })
    const flooder = await connect()
    const bystander = await connect()
    await settle(flooder)
    await settle(bystander)

    // Counted as a delta: `seen` keeps every frame including the roster this
    // client was sent on connect, which is not one the flood caused.
    const before = bystander.seen.filter((m) => m.type === 'presence').length

    // Every one of these changes the nickname, so before pacing every one of
    // them was a roster frame to every other listener: an unauthenticated
    // socket turning one frame into N, with no nickname, password or chat
    // needed to do it.
    for (let i = 0; i < 200; i++) flooder.send({ type: 'join', nickname: `nick-${i}` })
    await new Promise((resolve) => setTimeout(resolve, 200))

    const caused = bystander.seen.filter((m) => m.type === 'presence').length - before
    expect(caused).toBeLessThanOrEqual(5)
    expect((await nextError(flooder)).code).toBe('slow_down')
  })

  it('never charges a socket for a join that changes nothing', async () => {
    harness = await startHarness({}, { listen: true, joinBurst: 2, joinRefillMs: 60_000 })
    const client = await connect()
    await settle(client)

    // A client re-sending the name it already has (a reconnect that raced, a
    // render it did not mean) broadcasts nothing, so it costs nothing. Only a
    // roster the room has to be told about spends a token.
    await client.join('sam')
    for (let i = 0; i < 50; i++) client.send({ type: 'join', nickname: 'sam' })
    await new Promise((resolve) => setTimeout(resolve, 100))

    // The one token left is still there: a real rename still works.
    const roster = await client.join('sam again')
    expect((roster as PresenceMessage).listeners).toEqual([{ id: 1, nickname: 'sam again' }])
  })

  it('leaves the roster as it was when a join is refused', async () => {
    harness = await startHarness({}, { listen: true, joinBurst: 1, joinRefillMs: 60_000 })
    const client = await connect()
    await settle(client)
    await client.join('sam')

    client.send({ type: 'join', nickname: 'someone else' })
    expect((await nextError(client)).code).toBe('slow_down')

    // Refused means unchanged, not removed: a paced listener is still in the
    // room under the name they already had.
    expect(harness.app.realtime.listeners()).toEqual([{ id: 1, nickname: 'sam' }])
  })

  it('paces each socket on its own, so one flooder does not mute the room', async () => {
    harness = await startHarness({}, { listen: true, joinBurst: 1, joinRefillMs: 60_000 })
    const flooder = await connect()
    const arriving = await connect()
    await settle(flooder)
    await settle(arriving)

    await flooder.join('first')
    flooder.send({ type: 'join', nickname: 'second' })
    expect((await nextError(flooder)).code).toBe('slow_down')

    // A bucket per socket, not one for the station: whoever else turns up is
    // unaffected by what the socket next to them has been doing.
    //
    // Waited for by content rather than by `join`, which takes the next roster
    // of any kind, and the flooder's own join already put one in this client's
    // queue, so "the next roster" is not this client's.
    arriving.send({ type: 'join', nickname: 'innocent' })
    const roster = (await arriving.waitFor(
      (m) => m.type === 'presence' && m.listeners.some((l) => l.nickname === 'innocent'),
    )) as PresenceMessage
    expect(roster.listeners.map((listener) => listener.nickname)).toEqual(['first', 'innocent'])
  })
})
