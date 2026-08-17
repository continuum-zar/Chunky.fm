/**
 * A listener asking to say something, over the socket.
 *
 * The console's half of this conversation goes over HTTP behind the admin gate
 * and is tested in `floor-routes.test.ts`. This is the other half, and it is on
 * the socket for the reason `say` and `wish` are: a listener has no credentials,
 * so this is the only channel they have. The rule about commands is not bent by
 * that — asking is not deciding, and nothing a socket sends here moves the
 * station on its own.
 *
 * Three things are pinned below.
 *
 * The gates, which are a wish's gates in a wish's order: off air, then the
 * roster, then the mute, then the pace. A mute that covered the chat and left
 * the microphone open would only move where somebody was shouting from.
 *
 * The privacy, which is the whole reason `hands` is a separate frame from
 * `floor`: who is talking is the room's business and who *asked* is not.
 *
 * And the capability, which runs in both directions and cannot be forged from
 * either end: the console decides who may talk, the listener decides whether
 * to, and a socket that takes a microphone nobody offered is refused by name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ErrorMessage, FloorMessage, HandsMessage, YouMessage } from '../src/protocol.js'
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

/** A plain listener, named and on the roster, which is where a hand starts. */
async function listener(nickname: string): Promise<TestClient> {
  const client = await TestClient.connect(harness.wsUrl)
  clients.push(client)
  await client.nextPresence()
  await client.join(nickname)
  return client
}

/** The console. The password rides the upgrade the way the cookie does. */
async function decks(): Promise<TestClient> {
  const client = await TestClient.connect(harness.wsUrl, { 'x-admin-password': ADMIN_PASSWORD })
  clients.push(client)
  return client
}

const whoAmI = async (client: TestClient): Promise<number> =>
  ((await client.waitFor((m) => m.type === 'you')) as YouMessage).id

const nextError = async (client: TestClient): Promise<ErrorMessage> =>
  (await client.waitFor((m) => m.type === 'error')) as ErrorMessage

describe('raising a hand', () => {
  it('reaches the decks and nobody else', async () => {
    const console_ = await decks()
    await console_.nextHands() // the empty list in the connect burst
    const room = await listener('ama')
    const sipho = await listener('sipho')

    sipho.send({ type: 'hand', action: 'raise' })

    const hands = await console_.nextHands()
    expect(hands.hands).toEqual([{ id: await whoAmI(sipho), nickname: 'sipho' }])
    // The whole privacy story in one assertion. A queue the room can see is a
    // social cost paid by the shyest person in it, and a thing people get
    // nagged about. The room is told who is *talking*, which is a different
    // frame with a different audience.
    await expect(room.nextHands(200)).rejects.toThrow(/timed out/)
    expect(room.seen.some((m) => m.type === 'hands')).toBe(false)
  })

  it("is a console's first news on connecting, however long ago it went up", async () => {
    const sipho = await listener('sipho')
    sipho.send({ type: 'hand', action: 'raise' })
    // Nobody was running the decks when it went up.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const console_ = await decks()
    const hands = await console_.nextHands()

    // A console that opened after three hands went up must not start empty and
    // stay that way until somebody changes their mind.
    expect(hands.hands).toEqual([{ id: await whoAmI(sipho), nickname: 'sipho' }])
  })

  it('is signed with the name on the roster, never one from the frame', async () => {
    const console_ = await decks()
    await console_.nextHands()
    const sipho = await listener('sipho')

    // There is nowhere in this frame to put a name, which is the point: the
    // socket is the identity, exactly as it is for a chat message's author.
    sipho.send({ type: 'hand', action: 'raise', nickname: 'the dj' } as never)

    expect((await console_.nextHands()).hands[0]?.nickname).toBe('sipho')
  })

  it('follows a listener who renames themselves while they wait', async () => {
    const console_ = await decks()
    await console_.nextHands()
    const sipho = await listener('sipho')
    sipho.send({ type: 'hand', action: 'raise' })
    await console_.nextHands()

    await sipho.join('sipho m')

    // Otherwise the room's on-air lamp would introduce them, later, by a name
    // they had already abandoned.
    expect((await console_.nextHands()).hands[0]?.nickname).toBe('sipho m')
  })

  it('comes down again', async () => {
    const console_ = await decks()
    await console_.nextHands()
    const sipho = await listener('sipho')

    sipho.send({ type: 'hand', action: 'raise' })
    expect((await console_.nextHands()).hands).toHaveLength(1)

    sipho.send({ type: 'hand', action: 'lower' })
    expect((await console_.nextHands()).hands).toEqual([])
  })

  it('goes with the socket that raised it', async () => {
    const console_ = await decks()
    await console_.nextHands()
    const sipho = await listener('sipho')
    sipho.send({ type: 'hand', action: 'raise' })
    await console_.nextHands()

    await sipho.close()

    // Everything the floor holds is pinned to a socket, which is why there is
    // no lease on any of it except the invitation.
    expect((await console_.nextHands()).hands).toEqual([])
  })
})

describe('the gates on a hand', () => {
  it('needs a name first', async () => {
    const client = await TestClient.connect(harness.wsUrl)
    clients.push(client)

    client.send({ type: 'hand', action: 'raise' })

    expect((await nextError(client)).code).toBe('not_joined')
  })

  it('is refused off air', async () => {
    harness.air.end()
    const sipho = await listener('sipho')

    sipho.send({ type: 'hand', action: 'raise' })

    // The truest thing about the refusal, and told first for that reason:
    // there is no broadcast to ask to be part of.
    expect((await nextError(sipho)).code).toBe('off_air')
  })

  it('is refused from a muted nickname', async () => {
    const sipho = await listener('sipho')
    harness.mutes.set('sipho', true)

    sipho.send({ type: 'hand', action: 'raise' })

    // A mute that covered the chat and the wish book but left the microphone
    // open would only move where somebody was shouting from.
    const refusal = await nextError(sipho)
    expect(refusal.code).toBe('muted')
    expect(refusal.about).toBe('hand')
    expect(harness.floor.hands()).toEqual([])
  })

  it("is paced, so the console's list cannot be made to flicker", async () => {
    harness = await startHarness({}, { listen: true, handBurst: 1, handRefillMs: 60_000 })
    const sipho = await listener('sipho')

    sipho.send({ type: 'hand', action: 'raise' })
    sipho.send({ type: 'hand', action: 'lower' })

    // Letting go is inside the limit rather than exempt from it: the cheapest
    // way to make the list jump is to raise and lower in a loop, and exempting
    // half the pair would leave the loop open.
    expect((await nextError(sipho)).code).toBe('slow_down')
  })

  it('says what it was about, so the right control can show the refusal', async () => {
    harness.air.end()
    const sipho = await listener('sipho')

    sipho.send({ type: 'hand', action: 'raise' })

    // `off_air` is reachable from chat, wishes and this. Without `about`, a
    // hand refused would light up the chat composer.
    expect((await nextError(sipho)).about).toBe('hand')
  })

  it('refuses a frame that is not one of the three actions', async () => {
    const sipho = await listener('sipho')

    sipho.send({ type: 'hand', action: 'seize' } as never)

    expect((await nextError(sipho)).code).toBe('unrecognised_message')
  })
})

describe('taking the mic', () => {
  it('is refused when nobody offered it', async () => {
    const sipho = await listener('sipho')
    sipho.send({ type: 'hand', action: 'raise' })

    sipho.send({ type: 'hand', action: 'accept' })

    // Asking is not being given. Refused rather than dropped, because a client
    // that believes it is up would go on to offer a voice nobody is listening
    // for, and would look, to the person holding it, exactly like being live.
    expect((await nextError(sipho)).code).toBe('not_invited')
    expect(harness.floor.snapshot().speaker).toBeNull()
  })

  it('is refused from anybody but the socket it was offered to', async () => {
    const sipho = await listener('sipho')
    const ama = await listener('ama')
    sipho.send({ type: 'hand', action: 'raise' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    harness.floor.invite(await whoAmI(sipho))

    ama.send({ type: 'hand', action: 'accept' })

    expect((await nextError(ama)).code).toBe('not_invited')
    expect(harness.floor.snapshot().speaker).toBeNull()
  })

  it('tells the whole room who is on the mic', async () => {
    const sipho = await listener('sipho')
    const room = await listener('ama')
    await room.nextFloor() // the empty one from the connect burst
    sipho.send({ type: 'hand', action: 'raise' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const id = await whoAmI(sipho)

    harness.floor.invite(id)
    // Being brought up is public: the pause before a voice arrives is worth
    // the room being able to read, and the guest learns of it from this frame
    // rather than from one addressed to them alone.
    expect((await room.nextFloor()).invited).toMatchObject({ id, nickname: 'sipho' })

    sipho.send({ type: 'hand', action: 'accept' })

    const floor = (await room.nextFloor()) as FloorMessage
    expect(floor.speaker).toMatchObject({ id, nickname: 'sipho' })
    expect(floor.invited).toBeNull()
  })

  it('ducks the room, without a byte of audio passing through the station', async () => {
    const sipho = await listener('sipho')
    const room = await listener('ama')
    await room.nextMic()
    sipho.send({ type: 'hand', action: 'raise' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    harness.floor.invite(await whoAmI(sipho))

    sipho.send({ type: 'hand', action: 'accept' })

    // The same trick the mic has always used, pointed at somebody else's voice:
    // thirty browsers turn down the copy of the track they are each already
    // playing, on a clock they already share.
    expect((await room.nextMic()).live).toBe(true)
  })

  it('ends the call when the guest closes the tab', async () => {
    const sipho = await listener('sipho')
    const room = await listener('ama')
    await room.nextFloor()
    sipho.send({ type: 'hand', action: 'raise' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    harness.floor.invite(await whoAmI(sipho))
    sipho.send({ type: 'hand', action: 'accept' })
    await room.nextFloor()
    await room.nextFloor()

    await sipho.close()

    expect((await room.nextFloor()).speaker).toBeNull()
  })

  it('comes down when the guest says they are done', async () => {
    const sipho = await listener('sipho')
    sipho.send({ type: 'hand', action: 'raise' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const id = await whoAmI(sipho)
    harness.floor.invite(id)
    sipho.send({ type: 'hand', action: 'accept' })
    await sipho.nextFloor()

    // The same verb that withdraws a hand and declines an invitation. Three
    // would be three chances to pick the wrong one, and the worst of those is
    // a guest pressing "leave" and staying on air.
    sipho.send({ type: 'hand', action: 'lower' })

    const floor = await sipho.waitFor(
      (m) => m.type === 'floor' && (m as FloorMessage).speaker === null,
    )
    expect((floor as FloorMessage).speaker).toBeNull()
  })
})

describe('the floor is not a command surface', () => {
  it('refuses a console trying to bring somebody up over the socket', async () => {
    const console_ = await decks()

    console_.send({ type: 'floor', action: 'invite', listener: 2 } as never)

    // However live it feels. The `floor` frame travels the other way, and a
    // client that tries to send one has mistaken being told for being able to
    // tell — exactly as `mic` has always been refused here.
    const refusal = (await console_.waitFor((m) => m.type === 'error')) as ErrorMessage
    expect(refusal.code).toBe('command_over_http')
  })

  it('does not let an admin cookie raise a hand for somebody else', async () => {
    const console_ = await decks()
    await console_.nextHands()

    // The password buys exactly one privilege on this socket — addressing a
    // signalling frame to a listener — and this is not it. A hand raised here
    // is the console's own, under whatever name it joined as, or nothing.
    console_.send({ type: 'hand', action: 'raise' })

    expect((await nextError(console_)).code).toBe('not_joined')
    expect(harness.floor.hands()).toEqual([])
  })
})
