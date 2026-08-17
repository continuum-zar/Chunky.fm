import { EventEmitter } from 'node:events'
import type { Track } from './lib/track.js'

/**
 * The station's entire notion of playback.
 *
 * There is no per-listener state and nothing is streamed: listeners are handed
 * this tuple and align themselves to it. Because `startedAt` is a point in the
 * past, a listener joining at 2:14 computes 2:14 and seeks there, so joining
 * mid-song is the same code path as joining at the start.
 */
export interface PlaybackSnapshot {
  track: Track | null
  /** Server epoch ms at which the current track was at 0:00. */
  startedAt: number
  /** Position in ms while paused; null while playing. */
  pausedAt: number | null
  /** Server clock when this snapshot was taken, for client offset checks. */
  serverTime: number
  /**
   * The record still finishing under this one, during a crossfade.
   *
   * Null almost always, and null the whole time on a station whose crossfade
   * length is zero. `track` above is unchanged in meaning: it is what is on,
   * and during an overlap that is the incoming record from the instant it
   * starts. That matters more than it looks — the play log, the lyrics, the
   * media session and the now-playing line all read `track`, and every one of
   * them wants the new one the moment the blend begins.
   *
   * So this is additive and ignorable. A client that has never heard of it
   * plays the incoming track on the clock and cuts, exactly as before; one that
   * has runs a second deck and fades between them. Both stay on the clock,
   * which is the property nothing here is allowed to cost.
   */
  outgoing: Outgoing | null
}

/**
 * A record on its way out.
 *
 * The window is given as two absolute station-clock instants rather than a
 * length, and that is deliberate: a listener who joins *during* a crossfade has
 * to be able to work out where in it they have landed, and a duration would
 * only tell them how long it was for whoever was already here. `startedAt` is
 * also on the snapshot beside this, so the fade window is exactly
 * `[snapshot.startedAt, outgoing.endsAt]` — the incoming record's beginning to
 * the outgoing record's end — and neither end has to be inferred.
 */
export interface Outgoing {
  track: Track
  /** Server epoch ms at which the outgoing track was at 0:00. */
  startedAt: number
  /**
   * Server epoch ms at which it stops, and the far end of the blend.
   *
   * Its natural end when the station reached the transition by running out of
   * record, which is the ordinary case. Sooner when somebody pressed the
   * transition button halfway through — a manual blend cuts the outgoing track
   * off where the overlap ends, because the alternative is a fade that finishes
   * and then a minute of the old record still playing under the new one.
   */
  endsAt: number
}

export interface PlaybackStateOptions {
  /** Injectable clock. Tests drive this; production leaves it alone. */
  now?: () => number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export declare interface PlaybackState {
  on(event: 'change', listener: (snapshot: PlaybackSnapshot) => void): this
  off(event: 'change', listener: (snapshot: PlaybackSnapshot) => void): this
  emit(event: 'change', snapshot: PlaybackSnapshot): boolean
}

export class PlaybackState extends EventEmitter {
  readonly #now: () => number
  #track: Track | null = null
  #startedAt: number
  #pausedAt: number | null = null
  #outgoing: Outgoing | null = null

  constructor({ now = Date.now }: PlaybackStateOptions = {}) {
    super()
    this.#now = now
    this.#startedAt = now()
  }

  get track(): Track | null {
    return this.#track
  }

  get isPlaying(): boolean {
    return this.#track !== null && this.#pausedAt === null
  }

  /**
   * Server epoch ms at which the current track was at 0:00.
   *
   * Exposed for the one caller that has to describe the record it is replacing
   * rather than the one it is putting on: a crossfade's outgoing half is the
   * *previous* track's window, and `Station.advance` can only build it while it
   * still holds this. Derivable from `now() - positionMs()`, and a getter
   * rather than that arithmetic repeated at the call site because the two would
   * quietly disagree on a paused deck.
   */
  get startedAt(): number {
    return this.#startedAt
  }

  /**
   * The station clock. Everything time-shaped the server says (`startedAt`,
   * `serverTime`, the pong in the offset handshake) must read from here, or
   * clients would be aligning to a timebase that isn't the one `startedAt` is
   * expressed in.
   */
  now(): number {
    return this.#now()
  }

  /** Where the needle is right now, in ms. Zero when nothing is loaded. */
  positionMs(): number {
    if (!this.#track) return 0
    const raw = this.#pausedAt ?? this.#now() - this.#startedAt
    return clamp(raw, 0, this.#track.durationMs)
  }

  /**
   * What is still finishing under the current track, or null.
   *
   * Reported as null once it has actually run out, rather than being cleared on
   * a timer. Nothing changes at the far end of a blend — the outgoing record
   * simply stops mattering — so a timer would exist only to broadcast a frame
   * saying so, to a room that already worked it out from `endsAt`.
   */
  get outgoing(): Outgoing | null {
    if (this.#outgoing === null) return null
    return this.#now() < this.#outgoing.endsAt ? this.#outgoing : null
  }

  snapshot(): PlaybackSnapshot {
    return {
      track: this.#track,
      startedAt: this.#startedAt,
      pausedAt: this.#pausedAt,
      serverTime: this.#now(),
      outgoing: this.outgoing,
    }
  }

  /**
   * Put a track on the decks and start it, optionally partway in.
   *
   * `under` is the record this one is starting on top of, during a crossfade,
   * and is the only way one is ever set: an overlap begins when a new track
   * starts, so there is no second verb and no state where a blend exists
   * without something to blend into. Omit it — as every caller that is not
   * `Station.advance` does — and whatever was fading out is dropped, because a
   * track put on by hand is not a transition from anything.
   */
  play(track: Track, atMs = 0, under: Outgoing | null = null): PlaybackSnapshot {
    const position = clamp(atMs, 0, track.durationMs)
    this.#track = track
    this.#startedAt = this.#now() - position
    this.#pausedAt = null
    this.#outgoing = under
    return this.#changed()
  }

  pause(): PlaybackSnapshot {
    if (!this.#track || this.#pausedAt !== null) return this.snapshot()
    this.#pausedAt = this.positionMs()
    // A blend cannot be paused, only abandoned. The outgoing record's window is
    // two points on the wall clock and there is nowhere to put the time a pause
    // takes: hold it and the overlap resumes against a track that has been
    // silent for a minute, drop it and the fade is over. Dropping it is the one
    // of those a listener can make sense of.
    this.#outgoing = null
    return this.#changed()
  }

  resume(): PlaybackSnapshot {
    if (!this.#track || this.#pausedAt === null) return this.snapshot()
    // Rewrite history so the elapsed time still lands on the paused position.
    this.#startedAt = this.#now() - this.#pausedAt
    this.#pausedAt = null
    return this.#changed()
  }

  seek(positionMs: number): PlaybackSnapshot {
    if (!this.#track) return this.snapshot()
    const position = clamp(positionMs, 0, this.#track.durationMs)
    // Moving the needle on the incoming record puts it somewhere the outgoing
    // one was never lined up against, which is the whole of what a blend is.
    this.#outgoing = null
    if (this.#pausedAt === null) {
      this.#startedAt = this.#now() - position
    } else {
      this.#pausedAt = position
    }
    return this.#changed()
  }

  /** Clear the decks: off air, nothing loaded. */
  stop(): PlaybackSnapshot {
    if (!this.#track) return this.snapshot()
    this.#track = null
    this.#startedAt = this.#now()
    this.#pausedAt = null
    // Clearing the decks clears both of them. A record fading out under a deck
    // that is now empty is dead air with a countdown on it.
    this.#outgoing = null
    return this.#changed()
  }

  #changed(): PlaybackSnapshot {
    const snapshot = this.snapshot()
    this.emit('change', snapshot)
    return snapshot
  }
}
