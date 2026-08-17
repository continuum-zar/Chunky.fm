import type { Track } from './lib/track.js'
import { type Outgoing, type PlaybackSnapshot, PlaybackState } from './playback.js'
import { type QueueEntry, TrackQueue } from './queue.js'
import { Transition } from './transition.js'

export interface StationOptions {
  /** Supply your own state (and clock) in tests; production builds its own. */
  playback?: PlaybackState
  queue?: TrackQueue
  /**
   * How long two records overlap. Its own object because the number is
   * broadcast and settable while a set is running; see `Transition`.
   */
  transition?: Transition
  /**
   * How often the backstop sweep checks whether the current track has run out.
   * This is the safety net, not the mechanism: the setTimeout below is what
   * normally advances the station.
   */
  backstopIntervalMs?: number
}

/** Slow enough to be free, fast enough that a missed timer isn't dead air. */
const DEFAULT_BACKSTOP_MS = 2_000

/**
 * The decks plus what's coming up next.
 *
 * PlaybackState knows only about the track that is on right now, and nothing in
 * it advances by itself. The Station adds the two pieces that make it a radio
 * station rather than a player: a queue, and a timer that moves to the next
 * track the moment the current one runs out.
 *
 * Scheduling hangs off PlaybackState's `change` event rather than off the
 * Station's own methods, so a caller that reaches for `station.playback`
 * directly (pause, seek, a track swapped from the admin routes) still gets a
 * correctly rescheduled advance.
 *
 * The one thing that makes this more than a timer is the crossfade. With a
 * blend length set, the next track does not start when the current one ends —
 * it starts *early*, by the overlap, and the two run together for it. So the
 * timer fires before the end of the record rather than at it, and the snapshot
 * that goes out carries both records. See `Transition`, which owns the number,
 * and `Outgoing`, which is the shape on the wire.
 */
export class Station {
  readonly playback: PlaybackState
  readonly queue: TrackQueue
  readonly transition: Transition
  readonly #backstopIntervalMs: number
  #advanceTimer: NodeJS.Timeout | null = null
  #backstop: NodeJS.Timeout | null = null
  #closed = false

  constructor({
    playback = new PlaybackState(),
    queue = new TrackQueue(),
    transition = new Transition(),
    backstopIntervalMs = DEFAULT_BACKSTOP_MS,
  }: StationOptions = {}) {
    this.playback = playback
    this.queue = queue
    this.transition = transition
    this.#backstopIntervalMs = backstopIntervalMs

    this.playback.on('change', this.#onPlaybackChange)
    // A blend length changed mid-record moves when the next one has to start,
    // so the pending timer is wrong from that moment on. Cheaper and more
    // obviously correct than working out whether it moved by enough to matter.
    this.transition.on('change', this.#onPlaybackChange)
    // And so does the queue: the overlap is sized against the *next* track as
    // well as the current one, so queueing something different behind what is
    // playing can change when the transition begins. Without this, a station
    // that had nothing queued would keep the timer it set for running out —
    // which is the end of the record, not the start of the blend.
    this.queue.on('change', this.#onPlaybackChange)

    // A setTimeout can fire late (or, if the event loop is blocked long
    // enough, effectively not at all), and the failure mode is silence until
    // someone notices. The sweep costs a comparison every couple of seconds.
    this.#backstop = setInterval(() => this.#advanceIfFinished(), this.#backstopIntervalMs)
    this.#backstop.unref()

    this.#reschedule()
  }

  /** Everything a client needs: the tuple, plus what's coming. */
  snapshot(): PlaybackSnapshot & { queue: QueueEntry[] } {
    return { ...this.playback.snapshot(), queue: this.queue.list() }
  }

  /**
   * Put a track at the back of the queue.
   *
   * An idle station starts playing it immediately: with nothing on the decks
   * there is nothing to wait for, and a queue that needs a separate `play` to
   * get going isn't a station. A *paused* station stays paused: that's the
   * admin's decision, not an empty deck.
   */
  enqueue(track: Track): QueueEntry {
    const entry = this.queue.add(track)
    if (this.playback.track === null) this.advance()
    return entry
  }

  /**
   * Move to the next queued track, or go off air when nothing is queued.
   *
   * A hard cut: whatever was on stops the instant the next one starts. This is
   * what `skip` does, and it is the right shape for it — somebody reaching for
   * skip has decided the current record is over, and folding four seconds of it
   * into the next one is the opposite of what they asked for. The end-of-record
   * transition goes through `blend` instead.
   */
  advance(): PlaybackSnapshot {
    const next = this.queue.take()
    return next ? this.playback.play(next.track) : this.playback.stop()
  }

  /**
   * Start the next record over the top of this one, and fade between them.
   *
   * What the timer does at the end of a track, and what the transition button
   * on the co-host's phone does in the middle of one. The two differ only in
   * where the outgoing record is cut: at its natural end for the first, and at
   * the end of the overlap for the second, which is what stops a manual blend
   * leaving the old track running underneath for another minute.
   *
   * Falls back to a plain advance whenever there is nothing to fade — an empty
   * queue, a paused deck, an empty one, or a blend length of zero — so this is
   * safe to call in place of `advance` without asking first.
   *
   * `overlapMs` is clamped against both records; see `Transition.overlapFor`.
   */
  blend(overlapMs = this.#overlapMs()): PlaybackSnapshot {
    const outgoing = this.playback.track
    const now = this.playback.now()
    const next = this.queue.peek()
    if (!outgoing || !next || !this.playback.isPlaying || overlapMs <= 0) return this.advance()

    const overlap = this.transition.overlapFor(outgoing.durationMs, next.track.durationMs)
    const capped = Math.min(overlapMs, overlap)
    if (capped <= 0) return this.advance()

    const startedAt = this.playback.startedAt
    const under: Outgoing = {
      track: outgoing,
      startedAt,
      // Whichever comes first: the record running out, or the end of the fade
      // we are starting right now. The first is the end-of-track case and the
      // second is somebody pressing the button early, and taking the minimum
      // means neither has to be told apart from the other here.
      endsAt: Math.min(startedAt + outgoing.durationMs, now + capped),
    }
    // Taken only now that the blend is certain to happen: peeked at above so
    // the overlap could be sized against it, and everything that could refuse
    // has already refused.
    this.queue.take()
    return this.playback.play(next.track, 0, under)
  }

  close(): void {
    this.#closed = true
    this.playback.off('change', this.#onPlaybackChange)
    this.transition.off('change', this.#onPlaybackChange)
    this.queue.off('change', this.#onPlaybackChange)
    if (this.#advanceTimer) clearTimeout(this.#advanceTimer)
    if (this.#backstop) clearInterval(this.#backstop)
    this.#advanceTimer = null
    this.#backstop = null
  }

  #onPlaybackChange = (): void => {
    this.#reschedule()
  }

  /** Time left on the current track, or null when nothing is running out. */
  #remainingMs(): number | null {
    const track = this.playback.track
    if (!track || !this.playback.isPlaying) return null
    return track.durationMs - this.playback.positionMs()
  }

  /**
   * How far before the end of the current record the next one starts.
   *
   * Zero whenever there is nothing to fade into, which collapses everything
   * below back to the behaviour this station had before crossfades existed: the
   * timer fires at the end of the record and the next one cuts in. That is not
   * a special case anybody has to remember — it falls out of the arithmetic,
   * which is why the lead is a number here rather than a branch.
   */
  #overlapMs(): number {
    const track = this.playback.track
    const next = this.queue.peek()
    if (!track || !next) return 0
    return this.transition.overlapFor(track.durationMs, next.track.durationMs)
  }

  #reschedule(): void {
    if (this.#advanceTimer) {
      clearTimeout(this.#advanceTimer)
      this.#advanceTimer = null
    }
    if (this.#closed) return

    const remaining = this.#remainingMs()
    if (remaining === null) return

    this.#advanceTimer = setTimeout(() => {
      this.#advanceTimer = null
      this.#advanceIfFinished()
    }, Math.max(remaining - this.#overlapMs(), 0))
    this.#advanceTimer.unref()
  }

  #advanceIfFinished(): void {
    const remaining = this.#remainingMs()
    if (remaining === null) return
    // Read once: the sleep below and the fade above have to be sized against
    // the same number, and the queue can change between two calls.
    const overlap = this.#overlapMs()
    if (remaining > overlap) {
      // The station clock is the authority, not whatever woke us. A timer that
      // fired early, or a sweep that found no timer at all, both end up here,
      // and the fix for both is to sleep for what is actually left.
      if (this.#advanceTimer === null) this.#reschedule()
      return
    }
    // `blend` falls back to a hard cut on its own when the overlap is zero, so
    // this is the one call for both the crossfading station and the one whose
    // length is set to nothing.
    this.blend(overlap)
  }
}
