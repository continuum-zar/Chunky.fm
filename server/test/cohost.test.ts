/**
 * The other person at the decks.
 *
 * Three things this file is really about, and they are the three that make a
 * co-host different from everything the station already had.
 *
 * The first is that the seat is **not the floor**. A guest is invited and can
 * only be invited after asking; a co-host arrives holding a key and seats
 * themselves. Nothing here touches `Floor`, and the tests below say so.
 *
 * The second is that the seat **survives the talk button**. A co-host works
 * push-to-talk, which closes the mic at the end of every sentence, and the
 * wiring that drops a guest when the mic shuts must not reach this. That one is
 * tested where it lives, in `mic.test.ts` and the route tests.
 *
 * The third is the lease. The seat is pinned to a socket the station already
 * watches, so `leave` is the mechanism; the lease is the backstop for a phone
 * that went into a tunnel, where the connection is neither open nor known shut.
 */
import { describe, expect, it, vi } from 'vitest'
import { CoHost, SEAT_LEASE_MS } from '../src/cohost.js'
import { fakeClock } from './helpers.js'

describe('CoHost', () => {
  it('starts empty', () => {
    expect(new CoHost().snapshot()).toEqual({ seat: null })
  })

  it('seats somebody without them having asked for anything', () => {
    const clock = fakeClock()
    const seat = new CoHost({ now: clock.now })
    const heard = vi.fn()
    seat.on('change', heard)

    expect(seat.take(7, 'thabo')).toBe(true)

    // No hand, no invitation, no console in the middle. That absence is the
    // whole difference between this and `Floor.invite`, which refuses an id
    // with no hand up.
    expect(seat.snapshot()).toEqual({ seat: { id: 7, nickname: 'thabo', since: clock.now() } })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('holds one at a time, and will not let a second walk the first off the air', () => {
    const seat = new CoHost()
    seat.take(7, 'thabo')

    expect(seat.take(9, 'somebody else')).toBe(false)
    expect(seat.seat?.nickname).toBe('thabo')
  })

  it('is idempotent for whoever already holds it', () => {
    const clock = fakeClock()
    const seat = new CoHost({ now: clock.now })
    const heard = vi.fn()
    seat.take(7, 'thabo')
    seat.on('change', heard)

    clock.advance(5_000)
    // A page that reconnected and re-took its seat. Same id, same seat, nothing
    // announced: the room does not need a frame saying somebody is still there.
    expect(seat.take(7, 'thabo')).toBe(false)
    expect(heard).not.toHaveBeenCalled()
    expect(seat.seat?.since).toBe(clock.now() - 5_000)
  })

  it('follows a co-host who changes what they are called', () => {
    const seat = new CoHost()
    seat.take(7, 'thabo')

    expect(seat.rename(7, 'thabo on the aux')).toBe(true)
    expect(seat.seat?.nickname).toBe('thabo on the aux')
    // A rename for somebody who is not in it changes nothing.
    expect(seat.rename(9, 'nobody')).toBe(false)
  })

  it('refuses to be stood up by anybody but its own id', () => {
    const seat = new CoHost()
    seat.take(7, 'thabo')

    expect(seat.leave(9)).toBe(false)
    expect(seat.busy).toBe(true)
    expect(seat.leave(7)).toBe(true)
    expect(seat.busy).toBe(false)
  })

  it('empties for the console, which names nobody', () => {
    const seat = new CoHost()
    seat.take(7, 'thabo')

    expect(seat.leave(null)).toBe(true)
    expect(seat.snapshot()).toEqual({ seat: null })
    // Idempotent: a second tap on the same button is not an error.
    expect(seat.leave(null)).toBe(false)
  })

  it('renews only for whoever is actually in it', () => {
    const clock = fakeClock()
    const seat = new CoHost({ now: clock.now })
    seat.take(7, 'thabo')

    clock.advance(SEAT_LEASE_MS - 1_000)
    expect(seat.renew(7)).toBe(true)
    // A keep-alive from a page that has since been replaced must not put its
    // sender back in a seat it does not hold. Same reason `Mic.renew` is not
    // `Mic.open`.
    expect(seat.renew(9)).toBe(false)

    clock.advance(SEAT_LEASE_MS - 1_000)
    expect(seat.sweep()).toBe(false)
    expect(seat.busy).toBe(true)
  })

  it('sweeps up a seat nobody is renewing', () => {
    const clock = fakeClock()
    const seat = new CoHost({ now: clock.now })
    seat.take(7, 'thabo')

    clock.advance(SEAT_LEASE_MS - 1)
    expect(seat.sweep()).toBe(false)

    clock.advance(1)
    expect(seat.sweep()).toBe(true)
    expect(seat.snapshot()).toEqual({ seat: null })
  })

  it('empties at the end of a session, because who is co-hosting is about tonight', () => {
    const seat = new CoHost()
    seat.take(7, 'thabo')

    seat.clear()

    expect(seat.snapshot()).toEqual({ seat: null })
  })
})
