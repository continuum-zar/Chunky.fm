import { EventEmitter } from 'node:events'
import type { Listener } from './presence.js'

/**
 * The other person at the decks.
 *
 * A co-host is neither of the two roles this station had. A listener hears it.
 * Whoever holds the admin password *is* it — they can end the night, empty the
 * library, mute anybody. A co-host sits between: a voice on the air and a hand
 * on what plays next, on a phone, with none of the powers that would let them
 * take the evening apart.
 *
 * Holds no audio, like `Mic` and `Floor` beside it, and for the same reason —
 * the station does not mix. A co-host's voice goes from their phone to the
 * console and out again on the connections the room already has. What this
 * holds is the fact of the seat: who is in it, since when, so the console knows
 * which socket to offer a microphone to and the room can be told who is
 * talking.
 *
 * **Deliberately not the floor.** A call-in guest and a co-host look alike from
 * the outside — both are a second voice arriving over WebRTC — and are opposite
 * in every rule that matters. A guest is invited and may only be invited after
 * asking; a co-host arrives holding a key and seats themselves. A guest coming
 * down ends with the mic closing; a co-host works a push-to-talk button, so the
 * mic closes between every sentence and the seat has to survive that. Folding
 * the two together would mean a co-host thrown out of their own seat by
 * releasing the talk button. See `Floor`, which is untouched by all of this, and
 * `app.ts`, where the mic's coupling to the floor is wired.
 *
 * In memory, like the queue and the mic. A seat is not written down.
 */

/**
 * How long a seat survives without being renewed.
 *
 * The seat is pinned to a socket the station is already watching and already
 * reaps on close, so this is not the mechanism — `leave` is. It is the backstop
 * for the one case a closed socket does not cover: a phone that went into a
 * tunnel, where the TCP connection is neither open nor known to be shut, and
 * the console would go on offering a microphone to somebody who is on a train.
 *
 * Generous, because the cost of getting this wrong points one way. Losing the
 * seat mid-sentence over a phone's flaky signal is worse than a console that
 * offers a voice to nobody for half a minute.
 */
export const SEAT_LEASE_MS = 30_000

/** Somebody in the seat. The roster's row, plus when they took it. */
export interface CoHostSnapshot {
  /**
   * Who is co-hosting, or null.
   *
   * Broadcast to the whole room rather than to the console alone, and that is
   * the difference between this and `hands`. A second voice arriving with no
   * name on it is worse than one that was introduced, and unlike a raised hand
   * there is no social cost here to publish: the seat was taken deliberately by
   * somebody who was given a key.
   */
  seat: (Listener & { since: number }) | null
}

export interface CoHostOptions {
  /**
   * The station clock: `PlaybackState.now`, not `Date.now`, for the reason
   * `Mic` and `Floor` take one. Everything time-shaped the server says reads
   * from there, and a lease measured on a second timebase would lapse against a
   * clock nothing else in the station agrees with.
   */
  now?: () => number
  /** How long a seat lasts without a renew. See `SEAT_LEASE_MS`. */
  leaseMs?: number
}

export declare interface CoHost {
  on(event: 'change', listener: (snapshot: CoHostSnapshot) => void): this
  off(event: 'change', listener: (snapshot: CoHostSnapshot) => void): this
  emit(event: 'change', snapshot: CoHostSnapshot): boolean
}

export class CoHost extends EventEmitter {
  readonly #now: () => number
  readonly #leaseMs: number
  #seat: (Listener & { since: number }) | null = null
  /** Station-clock ms after which an unrenewed seat is assumed abandoned. */
  #expiresAt = 0

  constructor({ now = Date.now, leaseMs = SEAT_LEASE_MS }: CoHostOptions = {}) {
    super()
    this.#now = now
    this.#leaseMs = leaseMs
  }

  get seat(): (Listener & { since: number }) | null {
    return this.#seat
  }

  /** Whether anybody is co-hosting. What `take` refuses on. */
  get busy(): boolean {
    return this.#seat !== null
  }

  snapshot(): CoHostSnapshot {
    return { seat: this.#seat }
  }

  /** When an unrenewed seat lapses. Zero while empty; for the tests and the sweep. */
  get expiresAt(): number {
    return this.#seat ? this.#expiresAt : 0
  }

  /**
   * Take the seat. False when it changes nothing.
   *
   * One co-host at a time, for the reason the floor allows one speaker: the
   * mixer would take several without complaint and the room would not. Refused
   * rather than replaced, so a second phone holding the same link cannot walk
   * the first one off the air mid-sentence — the seat has to be given up before
   * it can be taken.
   *
   * Idempotent for whoever already holds it, which is what makes a page that
   * reconnects and re-takes its seat safe: same id, same seat, lease extended,
   * nothing announced.
   */
  take(id: number, nickname: string): boolean {
    this.#expiresAt = this.#now() + this.#leaseMs
    if (this.#seat?.id === id) {
      if (this.#seat.nickname === nickname) return false
      // They changed what they are called while sitting there. The roster is
      // the truth about names, and the room's on-air lamp should not go on
      // introducing them by one they abandoned.
      this.#seat = { ...this.#seat, nickname }
      return this.#changed()
    }
    if (this.busy) return false
    this.#seat = { id, nickname, since: this.#now() }
    return this.#changed()
  }

  /**
   * Keep a seat. False when there is nothing to renew.
   *
   * Deliberately not the same verb as `take`, for the reason `Mic.renew` is not
   * `Mic.open`: a keep-alive still in flight when somebody stood up would
   * otherwise put them back in a seat they had just left.
   */
  renew(id: number): boolean {
    if (this.#seat?.id !== id) return false
    this.#expiresAt = this.#now() + this.#leaseMs
    return true
  }

  /**
   * Stand up. From the seat's own id, or from the console taking it back.
   *
   * `null` is the console's form of it — *whoever is up, stand down* — because
   * there is only ever one of them and because it is one button in a hurry.
   */
  leave(id: number | null): boolean {
    if (!this.#seat) return false
    if (id !== null && this.#seat.id !== id) return false
    this.#seat = null
    this.#expiresAt = 0
    return this.#changed()
  }

  /**
   * Follow a co-host who changed what they are called. See `Floor.rename`.
   */
  rename(id: number, nickname: string): boolean {
    if (this.#seat?.id !== id || this.#seat.nickname === nickname) return false
    this.#seat = { ...this.#seat, nickname }
    return this.#changed()
  }

  /**
   * Empty a seat whose lease has lapsed. True when it actually emptied one.
   *
   * Called on a timer from `app.ts` rather than from a timer in here, exactly
   * as `Mic.sweep` and `Floor.sweep` are, so that every test of expiry is a
   * clock and a call and so the interval is owned where the station's other
   * housekeeping is.
   */
  sweep(): boolean {
    if (this.#seat === null || this.#now() < this.#expiresAt) return false
    return this.leave(null)
  }

  /**
   * What the end of a session does.
   *
   * All of it. Who is co-hosting is a claim about tonight, like who is here and
   * who is talking, and every one of them is a lie applied to another night.
   * The *key* survives, of course — that is a credential, not a claim, and it
   * lives in the config rather than in here.
   */
  clear(): void {
    this.leave(null)
  }

  #changed(): boolean {
    this.emit('change', this.snapshot())
    return true
  }
}
