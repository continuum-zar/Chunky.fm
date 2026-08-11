/**
 * `/api/floor`: the console's half, and where the gate is.
 *
 * Bringing somebody up is a command like any other and goes over HTTP for the
 * reason every command does. The listener's half of the same conversation —
 * asking, declining, taking what was offered — rides the socket alongside `say`
 * and `wish`, because a listener has no credentials and that is the only
 * channel they have. See `realtime.test.ts` for that side.
 *
 * The read is open, like `/api/mic` and unlike `/api/mutes`: who is on the mic
 * is broadcast to every listener a moment later anyway. What is deliberately
 * *not* here in any form is the list of raised hands. That goes to the decks
 * over the socket and has no HTTP surface, because an endpoint listing who
 * wants to talk would be one more place for that list to leak out of.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Harness, signIn, startHarness } from './helpers.js'

let harness: Harness
let cookie: string

beforeEach(async () => {
  harness = await startHarness()
  cookie = await signIn(harness)
})
afterEach(() => harness.cleanup())

async function post(
  payload: Record<string, unknown>,
  headers: Record<string, string> = { cookie },
) {
  return await harness.app.inject({ method: 'POST', url: '/api/floor', payload, headers })
}

describe('GET /api/floor', () => {
  it('is open, and answers the whole snapshot', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/floor' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ speaker: null, invited: null })
  })

  it('says who is up without saying who asked', async () => {
    harness.floor.raise(3, 'ama')
    harness.floor.raise(7, 'sipho')
    harness.floor.invite(7)

    const body = (await harness.app.inject({ method: 'GET', url: '/api/floor' })).json()
    expect(body.invited).toMatchObject({ id: 7, nickname: 'sipho' })
    // The one thing this endpoint must never grow. Anybody can read it.
    expect(JSON.stringify(body)).not.toContain('ama')
  })
})

describe('POST /api/floor', () => {
  it('is admin-only', async () => {
    harness.floor.raise(7, 'sipho')

    for (const payload of [{ action: 'invite', listener: 7 }, { action: 'drop' }]) {
      const res = await post(payload, {})
      expect(res.statusCode, JSON.stringify(payload)).toBe(401)
    }
    expect(harness.floor.snapshot().invited).toBeNull()
  })

  it('refuses an action it does not have', async () => {
    // The schema, not the handler: `promote` is the kind of thing a client
    // invents, and it should be a 400 rather than a silent 200 that did nothing.
    expect((await post({ action: 'promote', listener: 7 })).statusCode).toBe(400)
    expect((await post({})).statusCode).toBe(400)
  })

  describe('invite', () => {
    it('brings up somebody who asked, and answers with the state it produced', async () => {
      harness.floor.raise(7, 'sipho')

      const res = await post({ action: 'invite', listener: 7 })
      expect(res.statusCode).toBe(200)
      expect(res.json().invited).toMatchObject({ id: 7, nickname: 'sipho' })
      expect(res.json().invited.expiresAt).toEqual(expect.any(Number))
      // The nickname is the roster's, never the body's: there is nowhere in
      // this request to put one.
      expect(harness.floor.snapshot().invited?.nickname).toBe('sipho')
    })

    it('needs a listener to invite', async () => {
      const res = await post({ action: 'invite' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('missing_listener')
    })

    it('refuses somebody who never asked', async () => {
      const res = await post({ action: 'invite', listener: 7 })
      expect(res.statusCode).toBe(409)
      // The rule that makes an invitation a reply rather than a summons, and
      // the reason there is no way to put a stranger on air from here.
      expect(res.json().error).toBe('no_hand')
    })

    it('refuses while somebody already has the mic', async () => {
      harness.floor.raise(3, 'ama')
      harness.floor.raise(7, 'sipho')
      await post({ action: 'invite', listener: 3 })

      const res = await post({ action: 'invite', listener: 7 })
      expect(res.statusCode).toBe(409)
      // Told apart from `no_hand` on purpose: they mean different things to
      // whoever pressed the button, and only one of them is worth waiting out.
      expect(res.json().error).toBe('floor_taken')
    })

    it('refuses off air', async () => {
      harness.floor.raise(7, 'sipho')
      harness.air.end()

      const res = await post({ action: 'invite', listener: 7 })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('off_air')
    })

    it('ducks the room, because somebody is about to talk over it', async () => {
      harness.floor.raise(7, 'sipho')
      await post({ action: 'invite', listener: 7 })
      // Not yet: an invitation is not a voice, and a room ducked for somebody
      // still deciding would be a quiet song with nothing over it.
      expect(harness.mic.live).toBe(false)

      harness.floor.accept(7)
      // Now. The mic follows the floor so that the room is already ducked when
      // the first word lands, rather than a frame after it.
      expect(harness.mic.live).toBe(true)
    })
  })

  describe('drop', () => {
    it('takes the mic back', async () => {
      harness.floor.raise(7, 'sipho')
      harness.floor.invite(7)
      harness.floor.accept(7)

      const res = await post({ action: 'drop' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ speaker: null, invited: null })
    })

    it('answers 200 with nobody up', async () => {
      // A drop that arrives just after the guest left has nothing to drop, and
      // that is the ordinary end of a call rather than a failure worth a code.
      const res = await post({ action: 'drop' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ speaker: null, invited: null })
    })

    it('leaves the mic open, so the decks can say thanks', async () => {
      harness.floor.raise(7, 'sipho')
      harness.floor.invite(7)
      harness.floor.accept(7)
      expect(harness.mic.live).toBe(true)

      await post({ action: 'drop' })

      // Un-ducking between a guest's last word and your first would be a swell
      // of music in the middle of a sentence. Closing the mic is its own verb.
      expect(harness.mic.live).toBe(true)
    })
  })

  describe('the mic and the floor, wired together', () => {
    it('takes the guest down when the mic shuts', async () => {
      harness.floor.raise(7, 'sipho')
      harness.floor.invite(7)
      harness.floor.accept(7)

      await harness.app.inject({
        method: 'POST',
        url: '/api/mic',
        payload: { action: 'close' },
        headers: { cookie },
      })

      // A shut mic is an un-ducked room, so a guest still shown as up would be
      // talking under music at full volume. The commonest way this happens is
      // not a button but the lease lapsing because the console died.
      expect(harness.floor.snapshot().speaker).toBeNull()
    })

    it('takes the guest down when the console dies mid-call', async () => {
      harness.floor.raise(7, 'sipho')
      harness.floor.invite(7)
      harness.floor.accept(7)
      expect(harness.mic.live).toBe(true)

      // What a console whose tab was closed looks like from here: its socket
      // goes, which shortens the lease rather than ending it — a console that
      // is merely reconnecting keeps its mic — and then nothing renews it.
      harness.mic.hurry(0)
      harness.mic.sweep()

      // The floor goes with the mic, and this is the row of the failure table
      // it is really for. A guest still shown as up in a room that has stopped
      // ducking is somebody talking under music at full volume — and their
      // voice was travelling through that console anyway, so it stopped when
      // the console did whether the station admits it or not.
      expect(harness.mic.live).toBe(false)
      expect(harness.floor.snapshot().speaker).toBeNull()
    })

    it('clears everything when the broadcast ends', async () => {
      harness.floor.raise(3, 'ama')
      harness.floor.raise(7, 'sipho')
      harness.floor.invite(7)
      harness.floor.accept(7)

      harness.air.end()

      expect(harness.floor.snapshot()).toEqual({ speaker: null, invited: null })
      // The hands too, unlike the duck depth. Who asked is a claim about
      // tonight's room and a lie applied to another night.
      expect(harness.floor.hands()).toEqual([])
    })
  })
})
