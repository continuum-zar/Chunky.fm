/**
 * Who, besides the decks, is allowed to talk.
 *
 * Four things are worth holding on to here, and the file is about those four.
 *
 * The first is that no sound goes through this either. `Floor` is a permission
 * and a name; a guest's voice travels from their browser to the console and out
 * again on connections the room already has, and nothing in this module can
 * make or move any of it.
 *
 * The second is that an invitation is a reply, never a summons. `invite`
 * refuses an id with no hand up, which is what stops the station being able to
 * open a stranger's microphone — and, incidentally, is why this object never
 * has to know what a roster is.
 *
 * The third is that the capability runs both ways and neither end can do the
 * other's half: the console decides who *may* talk, and the listener decides
 * whether to. `accept` from an uninvited socket is refused rather than granted.
 *
 * The fourth is what a socket closing means. Everything here is pinned to one,
 * which is why there is a lease on the invitation and on nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import { Floor, INVITE_TTL_MS } from '../src/floor.js'
import { fakeClock } from './helpers.js'

/** A floor and a clock to drive it, which is what nearly every test wants. */
function build(inviteTtlMs?: number) {
  const clock = fakeClock()
  const floor = new Floor({ now: clock.now, inviteTtlMs })
  const changed = vi.fn()
  const hands = vi.fn()
  floor.on('change', changed)
  floor.on('hands', hands)
  return { clock, floor, changed, hands }
}

/** Raise a hand and bring them up, which is the preamble to half of these. */
function up(floor: Floor, id = 7, nickname = 'sipho'): void {
  floor.raise(id, nickname)
  floor.invite(id)
  floor.accept(id)
}

describe('Floor', () => {
  it('starts empty, with nobody up and nobody asked', () => {
    const { floor } = build()
    expect(floor.snapshot()).toEqual({ speaker: null, invited: null })
    expect(floor.hands()).toEqual([])
    expect(floor.busy).toBe(false)
  })

  describe('hands', () => {
    it('keeps them in the order they went up', () => {
      const { floor } = build()
      floor.raise(3, 'ama')
      floor.raise(1, 'sipho')
      floor.raise(9, 'thabo')

      // Oldest first, so the console reads as a queue rather than as a set.
      expect(floor.hands()).toEqual([
        { id: 3, nickname: 'ama' },
        { id: 1, nickname: 'sipho' },
        { id: 9, nickname: 'thabo' },
      ])
    })

    it('is silent when a hand that is already up goes up again', () => {
      const { floor, hands } = build()
      expect(floor.raise(3, 'ama')).toBe(true)
      expect(floor.raise(3, 'ama')).toBe(false)
      // One row on the console, and one frame to it. A client re-sending on a
      // reconnect must not cost the decks a list that redraws itself.
      expect(hands).toHaveBeenCalledTimes(1)
    })

    it('never reaches the room, only the decks', () => {
      const { floor, changed, hands } = build()
      floor.raise(3, 'ama')

      // The whole of the privacy story, and it is this line: raising a hand
      // emits nothing the room is told about. A queue the room can see is a
      // social cost paid by the shyest person in it.
      expect(changed).not.toHaveBeenCalled()
      expect(hands).toHaveBeenCalledTimes(1)
    })

    it('refuses a hand from somebody who already has what they are asking for', () => {
      const { floor } = build()
      up(floor, 7, 'sipho')

      expect(floor.raise(7, 'sipho')).toBe(false)
      // Otherwise the console would show a row offering to bring up the person
      // currently talking.
      expect(floor.hands()).toEqual([])
    })

    it('follows a listener who changes their name', () => {
      const { floor, hands } = build()
      floor.raise(3, 'ama')
      hands.mockClear()

      expect(floor.rename(3, 'ama d')).toBe(true)
      expect(floor.hands()).toEqual([{ id: 3, nickname: 'ama d' }])
      expect(hands).toHaveBeenCalledTimes(1)
      // A rename to the name they already have is not a change.
      expect(floor.rename(3, 'ama d')).toBe(false)
    })
  })

  describe('invite', () => {
    it('only offers the mic to somebody who asked for it', () => {
      const { floor } = build()

      // The rule that makes this a reply rather than a summons, and the reason
      // there is no route for "put this listener on air".
      expect(floor.invite(4)).toBe(false)
      expect(floor.snapshot().invited).toBeNull()

      floor.raise(4, 'thabo')
      expect(floor.invite(4)).toBe(true)
      expect(floor.snapshot().invited).toMatchObject({ id: 4, nickname: 'thabo' })
    })

    it('consumes the hand it answers', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)

      // They are being dealt with; a row still offering to bring them up would
      // be the console offering to do what it has just done.
      expect(floor.hands()).toEqual([])
    })

    it('tells the room, because somebody is about to talk', () => {
      const { floor, changed } = build()
      floor.raise(4, 'thabo')
      changed.mockClear()

      floor.invite(4)

      // Unlike the hand it came from. The pause before a voice arrives is worth
      // the room being able to read.
      expect(changed).toHaveBeenCalledTimes(1)
    })

    it('refuses while anybody is up or on their way up', () => {
      const { floor } = build()
      floor.raise(1, 'ama')
      floor.raise(2, 'sipho')

      expect(floor.invite(1)).toBe(true)
      // One at a time, enforced here rather than only in the console's markup:
      // a disabled button is a thing a page draws, not a thing that cannot
      // happen.
      expect(floor.invite(2)).toBe(false)

      floor.accept(1)
      expect(floor.invite(2)).toBe(false)
    })

    it('lapses if nobody answers it', () => {
      const { clock, floor, changed } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)
      changed.mockClear()

      clock.advance(INVITE_TTL_MS - 1)
      expect(floor.sweep()).toBe(false)

      clock.advance(1)
      expect(floor.sweep()).toBe(true)
      expect(floor.snapshot().invited).toBeNull()
      expect(changed).toHaveBeenCalledTimes(1)
      // And is not swept again: a console showing "waiting for thabo" all
      // evening is the failure this exists to prevent, not a frame per tick.
      expect(floor.sweep()).toBe(false)
    })

    it('does not put the hand back when it lapses', () => {
      const { clock, floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)
      clock.advance(INVITE_TTL_MS)
      floor.sweep()

      // They can ask again. A hand that reappeared by itself would be the
      // console being asked a second time by somebody who had walked away.
      expect(floor.hands()).toEqual([])
    })
  })

  describe('accept', () => {
    it('is refused without an invitation', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')

      // Asking is not being given. The invitation is the capability, and this
      // is the whole of the permission story on the listener's side.
      expect(floor.accept(4)).toBe(false)
      expect(floor.snapshot().speaker).toBeNull()
    })

    it('is refused from anybody but the id it was offered to', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)

      expect(floor.accept(5)).toBe(false)
      expect(floor.snapshot().speaker).toBeNull()
      expect(floor.snapshot().invited).toMatchObject({ id: 4 })
    })

    it('stamps when the call began, from the station clock', () => {
      const { clock, floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)
      clock.advance(5_000)
      floor.accept(4)

      expect(floor.snapshot()).toEqual({
        speaker: { id: 4, nickname: 'thabo', since: clock.now() },
        invited: null,
      })
    })
  })

  describe('lower', () => {
    it('withdraws a hand', () => {
      const { floor, hands } = build()
      floor.raise(4, 'thabo')
      hands.mockClear()

      expect(floor.lower(4)).toBe(true)
      expect(floor.hands()).toEqual([])
      expect(hands).toHaveBeenCalledTimes(1)
    })

    it('declines an invitation', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)

      expect(floor.lower(4)).toBe(true)
      expect(floor.snapshot().invited).toBeNull()
    })

    it('comes down off the mic', () => {
      const { floor } = build()
      up(floor, 4, 'thabo')

      // One verb for all three, because they are one intent. Three would be
      // three chances for a client to pick the wrong one, and the worst of
      // those is a guest pressing "leave" and staying on air.
      expect(floor.lower(4)).toBe(true)
      expect(floor.snapshot().speaker).toBeNull()
    })

    it('is silent about somebody who was not asking for anything', () => {
      const { floor, changed, hands } = build()
      expect(floor.lower(99)).toBe(false)
      expect(changed).not.toHaveBeenCalled()
      expect(hands).not.toHaveBeenCalled()
    })
  })

  describe('drop', () => {
    it('takes the mic back from whoever has it', () => {
      const { floor } = build()
      up(floor, 4, 'thabo')

      expect(floor.drop()).toBe(true)
      expect(floor.snapshot().speaker).toBeNull()
    })

    it('cancels an invitation nobody has answered yet', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)

      // The same button either way, which is what lets it be the one you reach
      // for in a hurry without having to know which state you are in.
      expect(floor.drop()).toBe(true)
      expect(floor.snapshot()).toEqual({ speaker: null, invited: null })
    })

    it('leaves the hands alone', () => {
      const { floor } = build()
      floor.raise(1, 'ama')
      floor.raise(2, 'sipho')
      floor.invite(1)
      floor.drop()

      // Standing one person down does not clear the queue behind them.
      expect(floor.hands()).toEqual([{ id: 2, nickname: 'sipho' }])
    })

    it('is silent when nobody is up', () => {
      const { floor, changed } = build()
      expect(floor.drop()).toBe(false)
      expect(changed).not.toHaveBeenCalled()
    })
  })

  describe('leave', () => {
    it('takes a hand with the socket that raised it', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')

      expect(floor.leave(4)).toBe(true)
      expect(floor.hands()).toEqual([])
    })

    it('takes an invitation with the socket it was addressed to', () => {
      const { floor } = build()
      floor.raise(4, 'thabo')
      floor.invite(4)

      expect(floor.leave(4)).toBe(true)
      expect(floor.snapshot().invited).toBeNull()
    })

    it('ends a call when the guest closes the tab', () => {
      const { floor, changed } = build()
      up(floor, 4, 'thabo')
      changed.mockClear()

      // No benefit of the doubt, unlike the mic's lease: the mic is renewed
      // over HTTP and survives a socket blip, while everything the floor holds
      // *is* the socket.
      expect(floor.leave(4)).toBe(true)
      expect(floor.snapshot().speaker).toBeNull()
      expect(changed).toHaveBeenCalledTimes(1)
    })

    it('says nothing about a socket that was never asking', () => {
      const { floor, changed, hands } = build()
      floor.raise(4, 'thabo')
      changed.mockClear()
      hands.mockClear()

      // Most sockets that close are this one, so it must be free.
      expect(floor.leave(99)).toBe(false)
      expect(changed).not.toHaveBeenCalled()
      expect(hands).not.toHaveBeenCalled()
    })
  })

  describe('clear', () => {
    it('empties everything the session held, hands included', () => {
      const { floor } = build()
      floor.raise(1, 'ama')
      floor.raise(2, 'sipho')
      floor.invite(1)
      floor.accept(1)

      floor.clear()

      // Unlike the mic, nothing here belongs to whoever runs the decks. Coming
      // back next Saturday to a hand somebody put up in October would be a bug.
      expect(floor.snapshot()).toEqual({ speaker: null, invited: null })
      expect(floor.hands()).toEqual([])
    })

    it('is silent on a floor that was already empty', () => {
      const { floor, changed, hands } = build()
      floor.clear()
      expect(changed).not.toHaveBeenCalled()
      expect(hands).not.toHaveBeenCalled()
    })
  })
})
