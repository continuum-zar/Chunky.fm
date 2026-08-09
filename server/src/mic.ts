import { EventEmitter } from 'node:events'

/**
 * Whether whoever runs the decks is talking over the music.
 *
 * PLAN.md deferred this as "mic / talk-over-the-music DJ mode", and this is the
 * half of it that carries no sound. Nothing here is audio: the station does not
 * mix, and it does not learn to for this. What it holds is a fact — the mic is
 * open, and the music should sit this far down while it is — which every
 * listener is told, and which every listener applies to the copy of the track
 * their own browser is already playing.
 *
 * That is worth being plain about, because it is the whole trick. On a station
 * that streamed, ducking would be a fader position baked into one encode. Here
 * it is a broadcast, and thirty browsers turn their own music down on a clock
 * they already share. It costs the server nothing, it works for a listener
 * whose voice connection never establishes, and it is why this ships before any
 * of the hard parts exist.
 *
 * In memory, like the queue and the padding. A mic break is not written down.
 */

/**
 * How far the music drops while the mic is open, as a linear gain.
 *
 * 0.2 is about −14 dB: the bed is still there, still recognisable, and no
 * longer competing with a voice. It is a starting point rather than a rule,
 * and the console can move it mid-sentence.
 */
export const DEFAULT_DUCK = 0.2

/**
 * The quietest the music is allowed to go, and deliberately not silence.
 *
 * A duck to zero is a pause, and there is already a button for that. More
 * practically: a listener who cannot hear the bed at all has no way to tell a
 * mic break from the station having died, and the difference between those two
 * is most of what a radio station is.
 */
export const MIN_DUCK = 0.05

/**
 * How long an open mic stays open without being renewed.
 *
 * The console renews while it holds the mic (see `renew`), so this is not a
 * timeout anybody meets in normal use: it is what happens when the tab running
 * the decks dies mid-sentence. Without it, the station goes on believing
 * somebody is talking and every listener sits through a permanently quiet song
 * — the same class of bug as a session left open by a crash reading as "still
 * on air" forever, and it wants the same kind of fix.
 *
 * Ten seconds is long enough that a renew lost to a hiccup does not cut you
 * off, and short enough that a dead console is a pause rather than an evening.
 */
export const MIC_LEASE_MS = 10_000

/**
 * What the lease is cut to when the console's socket goes.
 *
 * Comfortably longer than the three seconds between renewals, so a console that
 * is merely reconnecting keeps its mic; short enough that one whose tab was
 * closed stops ducking the room within about the time it takes to notice. See
 * `Mic.hurry`.
 */
export const MIC_HURRY_MS = 6_000

export interface MicSnapshot {
  live: boolean
  /**
   * Linear gain the music sits at while the mic is hot, in `[MIN_DUCK, 1]`.
   *
   * Sent whether or not the mic is open, so a client always knows how far to
   * duck before it is asked to. A page that learned the depth at the same
   * moment it was told to duck would have to ramp from a number it had just
   * received, which is fine, and would also have nothing to show on the slider
   * until the first mic break, which is not.
   */
  duckTo: number
  /** Server epoch ms at which the mic opened; null while it is shut. */
  since: number | null
}

export interface MicOptions {
  /**
   * The station clock: `PlaybackState.now`, not `Date.now`, for the reason
   * `OnAir` takes one. Everything time-shaped the server says reads from there,
   * and a lease measured on a second timebase would expire against a clock
   * nothing else in the station agrees with.
   */
  now?: () => number
  /** How long an open mic lasts without a renew. See `MIC_LEASE_MS`. */
  leaseMs?: number
}

export declare interface Mic {
  on(event: 'change', listener: (snapshot: MicSnapshot) => void): this
  off(event: 'change', listener: (snapshot: MicSnapshot) => void): this
  emit(event: 'change', snapshot: MicSnapshot): boolean
}

export class Mic extends EventEmitter {
  readonly #now: () => number
  readonly #leaseMs: number
  #live = false
  #duckTo = DEFAULT_DUCK
  #since: number | null = null
  /** Station-clock ms after which an unrenewed mic is assumed abandoned. */
  #expiresAt = 0

  constructor({ now = Date.now, leaseMs = MIC_LEASE_MS }: MicOptions = {}) {
    super()
    this.#now = now
    this.#leaseMs = leaseMs
  }

  get live(): boolean {
    return this.#live
  }

  get duckTo(): number {
    return this.#duckTo
  }

  /** When an unrenewed mic lapses. Zero while shut; for the tests and the sweep. */
  get expiresAt(): number {
    return this.#live ? this.#expiresAt : 0
  }

  snapshot(): MicSnapshot {
    return { live: this.#live, duckTo: this.#duckTo, since: this.#since }
  }

  /**
   * Open the mic, and take a lease on it.
   *
   * Idempotent, and silent when it changes nothing, like `OnAir.goLive`: the
   * console holds a key down and renews on a timer, so most calls that arrive
   * here are about a mic that is already open. Those extend the lease and
   * announce nothing, because nothing a listener can hear has changed — a
   * broadcast every few seconds saying the mic is still open would be a frame
   * to the whole room per heartbeat.
   *
   * `since` is set on the way open and not touched on renewal, so it stays the
   * moment the break began rather than creeping forward with each keep-alive.
   */
  open(): boolean {
    this.#expiresAt = this.#now() + this.#leaseMs
    if (this.#live) return false
    this.#live = true
    this.#since = this.#now()
    return this.#changed()
  }

  /**
   * Keep an open mic open. False when there is nothing to renew.
   *
   * Deliberately not the same verb as `open`. A renew that opened the mic would
   * make the console's own heartbeat able to put it back on air, so a keep-alive
   * still in flight when somebody let go of the key would reopen it a moment
   * after it shut — the station talking over the music because of a race in its
   * own timing rather than because anyone decided to.
   */
  renew(): boolean {
    if (!this.#live) return false
    this.#expiresAt = this.#now() + this.#leaseMs
    return true
  }

  /** Shut the mic. Idempotent, for the reason `open` is. */
  close(): boolean {
    if (!this.#live) return false
    this.#live = false
    this.#since = null
    this.#expiresAt = 0
    return this.#changed()
  }

  /**
   * How far the music drops while the mic is open.
   *
   * Where the fader now stands rather than a step, the shape `Padding.set` and
   * a mute both take: two identical requests leave one value, so a slider that
   * lost its answer to a dropped connection cannot walk the music down on
   * retry. Clamped rather than refused, because this is a fader and a fader
   * that stops is more use than one that errors.
   *
   * Settable while the mic is shut, and applied live while it is open: this is
   * the one control on the console that is worth moving mid-sentence, when you
   * can hear that the bed is too loud under you.
   */
  duck(to: number): boolean {
    if (!Number.isFinite(to)) return false
    const next = Math.min(1, Math.max(MIN_DUCK, to))
    if (next === this.#duckTo) return false
    this.#duckTo = next
    return this.#changed()
  }

  /**
   * Cut the remaining lease short, without shutting the mic.
   *
   * What the console's socket dropping means. The obvious thing to do there is
   * shut the mic outright — the decks have gone, so nobody is talking — and it
   * is wrong, because the two paths are independent: the console renews over
   * HTTP, and that keeps working through a socket blip that lasts a second. A
   * mic closed on the socket alone would un-duck the room in the middle of a
   * sentence somebody is still saying, over a wobble nothing else noticed.
   *
   * So the socket does not decide; it only stops giving the benefit of the
   * doubt. A console that really has gone renews nothing and lapses in a few
   * seconds instead of ten. One that is merely reconnecting renews on the next
   * beat and gets its full lease back, having never gone off mic.
   *
   * Never extends: a hurry that found a shorter lease already running would be
   * handing time back to a mic that was on its way out.
   */
  hurry(withinMs: number): boolean {
    if (!this.#live) return false
    const soon = this.#now() + withinMs
    if (soon >= this.#expiresAt) return false
    this.#expiresAt = soon
    return true
  }

  /**
   * Shut a mic whose lease has lapsed. True when it actually closed one.
   *
   * Called on a timer from `app.ts` rather than from a timer in here, so that
   * every test of expiry is a clock and a call rather than a fake timer wheel,
   * and so the interval is owned in the same place as the station's other
   * housekeeping.
   */
  sweep(): boolean {
    if (!this.#live || this.#now() < this.#expiresAt) return false
    return this.close()
  }

  /**
   * What the end of a session does.
   *
   * Only the mic itself. `duckTo` survives on purpose, and the distinction is
   * worth keeping: the padding and the mutes are claims about tonight's room
   * and would be lies applied to another night, while this is a fader position
   * belonging to whoever runs the decks. Coming back next Saturday to a mute
   * you set in October would be a bug; coming back to your own duck depth is
   * the setting doing its job.
   */
  clear(): void {
    this.close()
  }

  #changed(): boolean {
    this.emit('change', this.snapshot())
    return true
  }
}
