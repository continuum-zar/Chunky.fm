import { EventEmitter } from 'node:events'
import { type Db, type SessionKind, type SessionRef, closeSession, openSession } from './db.js'

/**
 * Whether the station is on air, and the session that is open while it is.
 *
 * PLAN.md locks availability as session-based ("you go live, you end it"), and
 * this is the thing that decides. Until now a session was a run of the process:
 * one opened at boot and closed at shutdown, so the only way to end a broadcast
 * was to stop the server. That worked, and it meant a deploy silently ended the
 * evening while a restart silently began a new one.
 *
 * Off air is a real state, not an absence of one. It is deliberately *not* the
 * same as the station being unreachable. A listener whose page cannot find the
 * server sees "no signal", and one whose station is simply not broadcasting
 * tonight sees that instead. Conflating the two would tell somebody to check
 * their connection when the truth is that nobody is playing anything.
 *
 * What ends with a session ends completely: the chat, the wish book and the
 * history are all scoped to `sessionId`, so going live opens a fresh room
 * rather than resuming last night's. That is the point of the scoping, and it
 * is why this object, rather than a number fixed at boot, is what the three
 * logs read their session from.
 */

export interface AirSnapshot {
  live: boolean
  /**
   * Server epoch ms at which this stretch on air began; null while off.
   *
   * Sent to listeners so a page can say how long the station has been on
   * without having to have been there when it started.
   */
  since: number | null
  /**
   * What kind of night this is, and null while there is no night.
   *
   * Null rather than defaulting to `set` off air, for the reason `since` is
   * null there: the page would otherwise be told the station is running a set
   * that does not exist, and something would eventually believe it. Off air has
   * no kind, because there is no session to have one.
   *
   * It travels with `live` rather than with the playback state because it
   * belongs to the session and changes exactly when the session does. A
   * listener arriving mid-conversation is handed it in the same frame that
   * tells them the station is on, which is what lets the page lead with the
   * conversation instead of an empty deck.
   */
  kind: SessionKind | null
}

export interface OnAirOptions {
  db: Db
  /**
   * The station clock: `PlaybackState.now`, not `Date.now`, for the reason the
   * play log takes one: a session's `started_at` and the `startedAt` of the
   * first track on it describe the same evening, and two timebases would
   * disagree about it.
   */
  now?: () => number
  /**
   * Whether to come up already broadcasting.
   *
   * False in production: a station that went live the instant it was deployed
   * would put every restart on air with an empty queue, which is the thing a
   * deliberate off-air state exists to prevent. True is for tests that are
   * about something else and just need a session to write to.
   */
  live?: boolean
}

export declare interface OnAir {
  on(event: 'change', listener: (snapshot: AirSnapshot) => void): this
  off(event: 'change', listener: (snapshot: AirSnapshot) => void): this
  emit(event: 'change', snapshot: AirSnapshot): boolean
}

export class OnAir extends EventEmitter implements SessionRef {
  readonly #db: Db
  readonly #now: () => number
  #sessionId: number | null = null
  #since: number | null = null
  #kind: SessionKind | null = null

  constructor({ db, now = Date.now, live = false }: OnAirOptions) {
    super()
    this.#db = db
    this.#now = now
    if (live) this.#open('set')
  }

  /** The open session, or null while off air. This is the `SessionRef`. */
  get current(): number | null {
    return this.#sessionId
  }

  get live(): boolean {
    return this.#sessionId !== null
  }

  snapshot(): AirSnapshot {
    return { live: this.live, since: this.#since, kind: this.#kind }
  }

  /**
   * Go on air, opening a session of a kind.
   *
   * Idempotent, and silent when it changes nothing: going live twice must not
   * open a second session, or the first one would be left with no `ended_at`
   * forever and the chat would move to a room nobody is in. An admin
   * double-clicking the button is the ordinary case, not an error.
   *
   * Which means the kind is decided once, at the moment the station goes on,
   * and the second call is ignored along with everything else about it. That is
   * deliberate rather than a gap: changing what kind of night it is halfway
   * through would rewrite what the room was told when they walked in, and the
   * honest way to do it is to end the session and start the other one, which is
   * also the only way that gives the new night its own chat and its own
   * history. Defaulted, so every existing caller means what it always meant.
   */
  goLive(kind: SessionKind = 'set'): AirSnapshot {
    if (this.live) return this.snapshot()
    this.#open(kind)
    return this.#changed()
  }

  /**
   * End the broadcast.
   *
   * Idempotent for the same reason `goLive` is. What this does *not* do is
   * stop the music or empty the queue. Those belong to the station, and are
   * wired to this object's `change` event in `app.ts` rather than reached for
   * from in here. A session is a record of a stretch of time; it should not be
   * able to drive the decks directly.
   */
  end(): AirSnapshot {
    if (!this.live) return this.snapshot()
    closeSession(this.#db, this.#sessionId as number, this.#now())
    this.#sessionId = null
    this.#since = null
    this.#kind = null
    return this.#changed()
  }

  /**
   * Shutdown. Marks an open session ended without announcing it: there is
   * nobody left to tell, and the sockets are already being drained.
   *
   * A session left open by a crash keeps a null `ended_at`, which reads as
   * "still on air" forever. Closing it here is what makes a clean stop
   * distinguishable from one.
   */
  close(): void {
    if (!this.live) return
    closeSession(this.#db, this.#sessionId as number, this.#now())
    this.#sessionId = null
    this.#since = null
    this.#kind = null
  }

  #open(kind: SessionKind): void {
    const at = this.#now()
    this.#sessionId = openSession(this.#db, at, kind)
    this.#since = at
    this.#kind = kind
  }

  #changed(): AirSnapshot {
    const snapshot = this.snapshot()
    this.emit('change', snapshot)
    return snapshot
  }
}
