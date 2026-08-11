import { EventEmitter } from 'node:events'
import type { Listener } from './presence.js'

/**
 * Who, besides the decks, is allowed to talk.
 *
 * The mic says whether somebody is talking over the music; this says whether
 * that somebody is a listener. Nothing here carries audio either — a guest's
 * voice travels from their browser to the console and out again on the
 * connections the room already has, and the station holds no more of it than it
 * holds of the music. What it holds is permission, and the fact of it, so that
 * the room can be told who is on the mic and the console can be told who asked.
 *
 * Modelled on `mic.ts`, which is the right precedent: in memory, a snapshot on
 * the wire, mutated by verbs, cleared when the session ends. A call is not
 * written down, for the same reason a mic break is not.
 *
 * The one rule worth stating on its own: **the microphone is only ever offered
 * to somebody who asked for it.** `invite` refuses an id with no hand up. That
 * is not politeness — it is what makes an invitation a reply rather than a
 * summons, and it means this object never has to be told who is on the roster,
 * because the name came in with the hand.
 */

/**
 * How long an invitation stands before it lapses.
 *
 * The only lease here, and the reason is worth keeping. The mic needs one
 * because the console renews over HTTP and the station cannot see it die; every
 * other state on this object is pinned to a socket the station is already
 * watching and already reaps on close, so `leave` does the job a lease would.
 * An invitation is the exception because it is waiting on a person, and a
 * console showing *waiting for sipho* for the rest of the evening because sipho
 * went to make tea is a worse failure than a minute that ran out.
 */
export const INVITE_TTL_MS = 60_000

/** Somebody up, or on their way up. The roster's row, plus when. */
export interface FloorSnapshot {
  /** Who is on air besides the decks. Broadcast to the room. */
  speaker: (Listener & { since: number }) | null
  /**
   * Asked up, not yet answered.
   *
   * Broadcast rather than sent to the one socket it concerns, which looks like
   * an oversight and is not: the guest reads their own id off it, and so does
   * the console, and a room that can see somebody is being brought up sees the
   * pause before a voice arrives for what it is. Nothing here is a secret —
   * `hands` is the private half, and it is a different frame.
   */
  invited: (Listener & { expiresAt: number }) | null
}

export interface FloorOptions {
  /**
   * The station clock: `PlaybackState.now`, not `Date.now`, for the reason
   * `Mic` and `OnAir` take one. Everything time-shaped the server says reads
   * from there, and an invitation measured on a second timebase would lapse
   * against a clock nothing else in the station agrees with.
   */
  now?: () => number
  /** How long an invitation stands. See `INVITE_TTL_MS`. */
  inviteTtlMs?: number
}

export declare interface Floor {
  on(event: 'change', listener: (snapshot: FloorSnapshot) => void): this
  on(event: 'hands', listener: (hands: Listener[]) => void): this
  off(event: 'change', listener: (snapshot: FloorSnapshot) => void): this
  off(event: 'hands', listener: (hands: Listener[]) => void): this
  emit(event: 'change', snapshot: FloorSnapshot): boolean
  emit(event: 'hands', hands: Listener[]): boolean
}

export class Floor extends EventEmitter {
  readonly #now: () => number
  readonly #inviteTtlMs: number
  /**
   * Hands up, in the order they went up, which a Map keeps for free.
   *
   * Held here as id → nickname rather than as a list of ids, so that `invite`
   * can name whoever it brings up without this object ever learning what a
   * roster is. The nickname arrived with the hand, and the hand arrived on a
   * socket where it had already been looked up rather than taken from a frame.
   */
  readonly #hands = new Map<number, string>()
  #speaker: (Listener & { since: number }) | null = null
  #invited: (Listener & { expiresAt: number }) | null = null

  constructor({ now = Date.now, inviteTtlMs = INVITE_TTL_MS }: FloorOptions = {}) {
    super()
    this.#now = now
    this.#inviteTtlMs = inviteTtlMs
  }

  get speaker(): (Listener & { since: number }) | null {
    return this.#speaker
  }

  get invited(): (Listener & { expiresAt: number }) | null {
    return this.#invited
  }

  /** Whether anybody is up or on their way up. What `invite` refuses on. */
  get busy(): boolean {
    return this.#speaker !== null || this.#invited !== null
  }

  snapshot(): FloorSnapshot {
    return { speaker: this.#speaker, invited: this.#invited }
  }

  /**
   * Who has asked, oldest first. For the decks and nobody else.
   *
   * Not part of the snapshot, and that is the design rather than a shortcut.
   * The speaker is public because a voice arriving from nowhere with no name on
   * it is worse than one that was introduced; a raised hand is private because
   * putting it in front of the room is a small social cost paid by the shyest
   * person in it, and because a visible queue is something a room will nag you
   * about. Same split as the wish book, for the same reasons.
   */
  hands(): Listener[] {
    return [...this.#hands].map(([id, nickname]) => ({ id, nickname }))
  }

  /**
   * Ask for the mic. False when it changes nothing.
   *
   * Refused outright for somebody already up or already invited: they have what
   * they were asking for, and a hand from them would put a row on the console
   * offering to bring up the person currently talking.
   */
  raise(id: number, nickname: string): boolean {
    if (this.#speaker?.id === id || this.#invited?.id === id) return false
    if (this.#hands.get(id) === nickname) return false
    this.#hands.set(id, nickname)
    return this.#handsChanged()
  }

  /**
   * "Actually, no." One verb doing three jobs, deliberately.
   *
   * Withdrawing a hand, declining an invitation and coming down off the mic are
   * one intent — *I do not want the microphone* — and which of the three it is
   * depends only on state the station already holds. A client that had to pick
   * the right one of three verbs would be a client that can pick the wrong one,
   * and the failure would be a guest pressing *leave* and staying on air.
   */
  lower(id: number): boolean {
    if (this.#speaker?.id === id) {
      this.#speaker = null
      return this.#changed()
    }
    if (this.#invited?.id === id) {
      this.#invited = null
      return this.#changed()
    }
    if (!this.#hands.delete(id)) return false
    return this.#handsChanged()
  }

  /**
   * Offer the mic to somebody who asked for it.
   *
   * Two refusals, and both are the console's own button drawn as a rule. One
   * speaker at a time, because the mixer would take several without complaint
   * and the room would not: two people over a round trip of half a second is not
   * a conversation, and every extra open microphone multiplies what can go wrong
   * acoustically. And only somebody with a hand up, which is what makes this a
   * reply rather than a summons.
   *
   * A disabled button is a thing the page draws, not a thing that cannot
   * happen; this is the thing that cannot happen.
   */
  invite(id: number): boolean {
    if (this.busy) return false
    const nickname = this.#hands.get(id)
    if (nickname === undefined) return false
    this.#hands.delete(id)
    this.#invited = { id, nickname, expiresAt: this.#now() + this.#inviteTtlMs }
    this.#handsChanged()
    return this.#changed()
  }

  /**
   * Take the mic that was offered. Only from the id it was offered to.
   *
   * The invitation is the capability. A socket that sends this without one is
   * refused rather than promoted, which is the whole of the permission story on
   * this side: the console decides who may talk, and the listener decides
   * whether to, and neither can do the other's half.
   */
  accept(id: number): boolean {
    if (this.#invited?.id !== id) return false
    this.#speaker = { id, nickname: this.#invited.nickname, since: this.#now() }
    this.#invited = null
    return this.#changed()
  }

  /**
   * The console taking the mic back, from whoever has it.
   *
   * Takes no id, because there is only ever one of them and because this is one
   * button: *stand down* while somebody is up, *never mind* while an invitation
   * is out, and the same key either way in a hurry.
   */
  drop(): boolean {
    if (!this.busy) return false
    this.#speaker = null
    this.#invited = null
    return this.#changed()
  }

  /**
   * A socket has gone: a tab closed, a network that vanished, a shutdown.
   *
   * Everything this object holds about that id, in one call, because the socket
   * layer has one place it learns a connection ended and should not have to
   * know which of three states the listener happened to be in.
   */
  leave(id: number): boolean {
    const hadHand = this.#hands.delete(id)
    const wasHere = this.#speaker?.id === id || this.#invited?.id === id
    if (this.#speaker?.id === id) this.#speaker = null
    if (this.#invited?.id === id) this.#invited = null
    if (hadHand) this.#handsChanged()
    if (wasHere) this.#changed()
    return hadHand || wasHere
  }

  /**
   * Follow a listener who changed what they are called.
   *
   * The roster is the truth about names, and it can move under this: somebody
   * raises a hand, thinks better of the name they picked, and changes it while
   * they wait. Without this the room's on-air lamp would introduce them by a
   * name they had already abandoned.
   */
  rename(id: number, nickname: string): boolean {
    let moved = false
    if (this.#hands.has(id) && this.#hands.get(id) !== nickname) {
      this.#hands.set(id, nickname)
      this.#handsChanged()
      moved = true
    }
    if (this.#speaker?.id === id && this.#speaker.nickname !== nickname) {
      this.#speaker = { ...this.#speaker, nickname }
      this.#changed()
      moved = true
    }
    if (this.#invited?.id === id && this.#invited.nickname !== nickname) {
      this.#invited = { ...this.#invited, nickname }
      this.#changed()
      moved = true
    }
    return moved
  }

  /**
   * Drop an invitation nobody answered. True when it actually dropped one.
   *
   * Called on a timer from `app.ts` rather than from a timer in here, exactly
   * as `Mic.sweep` is, so that every test of expiry is a clock and a call and
   * so the interval is owned where the station's other housekeeping is.
   */
  sweep(): boolean {
    if (this.#invited === null || this.#now() < this.#invited.expiresAt) return false
    this.#invited = null
    return this.#changed()
  }

  /**
   * What the end of a session does. Everything, including the hands.
   *
   * Unlike the mic, nothing here is a fader position belonging to whoever runs
   * the decks. It is all claims about tonight's room — who is here, who asked,
   * who is talking — and every one of them is a lie applied to another night.
   */
  clear(): void {
    if (this.#hands.size > 0) {
      this.#hands.clear()
      this.#handsChanged()
    }
    if (this.busy) {
      this.#speaker = null
      this.#invited = null
      this.#changed()
    }
  }

  #changed(): boolean {
    this.emit('change', this.snapshot())
    return true
  }

  #handsChanged(): boolean {
    this.emit('hands', this.hands())
    return true
  }
}
