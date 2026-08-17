import { EventEmitter } from 'node:events'
import type { Track } from './lib/track.js'

/**
 * A track waiting its turn.
 *
 * The entry id exists because the same track may sit in the queue more than
 * once, and because the queue shifts under the admin's feet every time a track
 * ends: an index-addressed "remove the third one" races with auto-advance and
 * removes the wrong track. Entry ids don't move.
 */
export interface QueueEntry {
  id: number
  track: Track
}

export declare interface TrackQueue {
  on(event: 'change', listener: (entries: QueueEntry[]) => void): this
  off(event: 'change', listener: (entries: QueueEntry[]) => void): this
  emit(event: 'change', entries: QueueEntry[]): boolean
}

/**
 * What's coming up next, in memory only.
 *
 * The queue is session-scoped and dies with the process along with the rest of
 * playback state; see PLAN.md. Nothing here knows about timers or the decks;
 * advancing is the Station's job.
 */
export class TrackQueue extends EventEmitter {
  #entries: QueueEntry[] = []
  #nextId = 1

  get size(): number {
    return this.#entries.length
  }

  /** A copy: callers must not be able to reorder the queue by mutating it. */
  list(): QueueEntry[] {
    return [...this.#entries]
  }

  add(track: Track): QueueEntry {
    const entry: QueueEntry = { id: this.#nextId++, track }
    this.#entries.push(entry)
    this.#changed()
    return entry
  }

  /**
   * What is next, without taking it. Null when there is nothing queued.
   *
   * The crossfade needs this and nothing else does. An overlap has to be sized
   * against *both* records — half the shorter of the two, see
   * `Transition.overlapFor` — so the station has to know how long the next
   * track is several seconds before it is allowed to start it. Taking it early
   * and putting it back would be a queue that briefly lies to the room about
   * what is coming.
   */
  peek(): QueueEntry | null {
    return this.#entries[0] ?? null
  }

  /** Pull the head off, for the decks. Null when there is nothing queued. */
  take(): QueueEntry | null {
    const entry = this.#entries.shift()
    if (!entry) return null
    this.#changed()
    return entry
  }

  remove(entryId: number): QueueEntry | null {
    const index = this.#entries.findIndex((entry) => entry.id === entryId)
    if (index === -1) return null
    const [removed] = this.#entries.splice(index, 1)
    this.#changed()
    return removed ?? null
  }

  /** Move an entry to a new position, clamped to the queue it lands in. */
  move(entryId: number, toIndex: number): QueueEntry | null {
    const from = this.#entries.findIndex((entry) => entry.id === entryId)
    if (from === -1) return null
    const [entry] = this.#entries.splice(from, 1)
    if (!entry) return null
    const to = Math.min(Math.max(Math.trunc(toIndex), 0), this.#entries.length)
    this.#entries.splice(to, 0, entry)
    this.#changed()
    return entry
  }

  clear(): void {
    if (this.#entries.length === 0) return
    this.#entries = []
    this.#changed()
  }

  #changed(): void {
    this.emit('change', this.list())
  }
}
