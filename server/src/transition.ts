import { EventEmitter } from 'node:events'

/**
 * How one record becomes the next.
 *
 * The station does not mix, so this is not a fader anywhere. It is a *number*,
 * broadcast to the room, and every browser runs the crossfade itself on the
 * clock they already share: the incoming track starts this far before the
 * outgoing one ends, both are playing at once for that overlap, and thirty
 * browsers ramp two gains against each other and land on the same downbeat.
 *
 * Exactly the trick `Mic` plays with the duck, one turn further. Ducking taught
 * the station that a decision can be broadcast instead of mixed; this is the
 * same sentence applied to the one moment radio is actually judged on. What it
 * costs the server is a field on the playback snapshot.
 *
 * Zero is a hard cut, which is what the station did before this existed and is
 * still the right answer for a lot of music. There is deliberately no *style*
 * beside the length: a crossfade of zero and a cut are the same event, and a
 * second control that could disagree with the first would only ever be a way to
 * ask for a four-second cut.
 *
 * In memory, like the duck depth, and like the duck depth it survives the end
 * of a session: this is a setting belonging to whoever runs the decks, not a
 * claim about tonight's room. Coming back next Saturday to your own crossfade
 * length is the setting doing its job.
 */

/**
 * The longest overlap the station will run.
 *
 * Long enough for the kind of blend that only works between two records chosen
 * to be blended, and short enough that it is still a transition rather than a
 * mashup. Past about this the useful question stops being "how long" and starts
 * being "which bar", which is a different feature and needs beatgrids.
 */
export const MAX_BLEND_MS = 12_000

/**
 * Where a station starts.
 *
 * Not zero, and that is a small opinion worth stating. A station whose default
 * is a hard cut sounds like a playlist, and the whole difference between this
 * and a playlist is that somebody is running it. Three seconds is the length
 * that reads as deliberate on almost anything without needing to be chosen.
 */
export const DEFAULT_BLEND_MS = 3_000

export interface TransitionSnapshot {
  /** How long two records overlap, in ms. Zero is a hard cut. */
  blendMs: number
}

export declare interface Transition {
  on(event: 'change', listener: (snapshot: TransitionSnapshot) => void): this
  off(event: 'change', listener: (snapshot: TransitionSnapshot) => void): this
  emit(event: 'change', snapshot: TransitionSnapshot): boolean
}

export class Transition extends EventEmitter {
  #blendMs: number

  constructor({ blendMs = DEFAULT_BLEND_MS }: { blendMs?: number } = {}) {
    super()
    this.#blendMs = clamp(blendMs)
  }

  get blendMs(): number {
    return this.#blendMs
  }

  snapshot(): TransitionSnapshot {
    return { blendMs: this.#blendMs }
  }

  /**
   * Set the length. Where the fader now stands rather than a step, the shape
   * `Mic.duck` and `Padding.set` both take: two identical requests leave one
   * value, so a slider that lost its answer to a phone's flaky connection
   * cannot walk the crossfade out on retry.
   *
   * Clamped rather than refused, because this is a fader and a fader that stops
   * is more use than one that errors.
   */
  set(blendMs: number): boolean {
    if (!Number.isFinite(blendMs)) return false
    const next = clamp(blendMs)
    if (next === this.#blendMs) return false
    this.#blendMs = next
    this.emit('change', this.snapshot())
    return true
  }

  /**
   * How long two particular records may actually overlap.
   *
   * The setting is a wish, and this is what the station can honour of it. Two
   * limits, and both are about the same failure — a crossfade longer than the
   * music it is folding, which would start a track that was already over or run
   * an overlap past the far end of the incoming one.
   *
   * Half of the shorter of the two, at most. Half rather than all of it because
   * an overlap equal to a track's whole length is not a transition, it is two
   * records playing, and because the outgoing track's *previous* transition may
   * still be finishing at the other end of it.
   */
  overlapFor(outgoingMs: number, incomingMs: number): number {
    const shortest = Math.min(outgoingMs, incomingMs)
    if (!Number.isFinite(shortest) || shortest <= 0) return 0
    return Math.max(0, Math.min(this.#blendMs, Math.floor(shortest / 2)))
  }
}

function clamp(ms: number): number {
  return Math.min(MAX_BLEND_MS, Math.max(0, Math.round(ms)))
}
