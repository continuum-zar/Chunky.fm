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

/**
 * Who is holding the mic open.
 *
 * The mic used to be a boolean with one lease on it, which was exactly right
 * while there was one person who could talk. A co-host makes two, both working
 * a push-to-talk button, and a boolean cannot hold that: the co-host finishing
 * a sentence would un-duck the room in the middle of one the decks were still
 * saying, because `close` meant *shut* rather than *I have stopped*.
 *
 * So the mic is open while **anybody** is holding it, and each holder has its
 * own lease. Everything on the wire is unchanged — the room is still told a
 * `live` and a `duckTo`, because how far the music sits down is not a function
 * of how many people are talking over it — and every existing caller still
 * means the decks, which is what the default on every verb below is for.
 */
export type MicHolder = 'decks' | 'cohost'

/** What a caller that does not say means. See `MicHolder`. */
const DECKS: MicHolder = 'decks'

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
  #duckTo = DEFAULT_DUCK
  #since: number | null = null
  /**
   * Who is holding the mic open, and until when.
   *
   * Station-clock ms per holder, after which that one's grip is assumed
   * abandoned. Empty is a shut mic — there is no separate `live` flag, because
   * two pieces of state saying the same thing is two pieces of state that can
   * disagree, and the one time they would is the one this map exists for.
   */
  readonly #holders = new Map<MicHolder, number>()

  constructor({ now = Date.now, leaseMs = MIC_LEASE_MS }: MicOptions = {}) {
    super()
    this.#now = now
    this.#leaseMs = leaseMs
  }

  get live(): boolean {
    return this.#holders.size > 0
  }

  /** Who is holding it open right now. For the tests and the log line. */
  holders(): MicHolder[] {
    return [...this.#holders.keys()]
  }

  get duckTo(): number {
    return this.#duckTo
  }

  /**
   * When the mic lapses if nobody renews. Zero while shut.
   *
   * The *last* holder to run out, since the mic is open while anybody has it.
   * For the tests and for reading a log; the sweep works holder by holder.
   */
  get expiresAt(): number {
    let latest = 0
    for (const at of this.#holders.values()) latest = Math.max(latest, at)
    return latest
  }

  snapshot(): MicSnapshot {
    return { live: this.live, duckTo: this.#duckTo, since: this.#since }
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
  open(holder: MicHolder = DECKS): boolean {
    const wasLive = this.live
    this.#holders.set(holder, this.#now() + this.#leaseMs)
    if (wasLive) return false
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
  renew(holder: MicHolder = DECKS): boolean {
    if (!this.#holders.has(holder)) return false
    this.#holders.set(holder, this.#now() + this.#leaseMs)
    return true
  }

  /**
   * Let go. Shuts the mic only when nobody else is still holding it.
   *
   * *I have stopped talking*, not *shut the mic*, and the difference is the
   * whole reason the holders exist. A co-host's push-to-talk sends one of these
   * at the end of every sentence, and the room must not un-duck under whoever
   * runs the decks still speaking.
   *
   * Idempotent, for the reason `open` is: a hangover timer that fires twice,
   * or a page that closes on both a key-up and a blur, changes nothing the
   * second time.
   */
  close(holder: MicHolder = DECKS): boolean {
    if (!this.#holders.delete(holder)) return false
    if (this.live) return false
    this.#since = null
    return this.#changed()
  }

  /**
   * Shut it for everybody, whoever is holding it.
   *
   * What a lapsed session does, and the one place the old meaning of `close` is
   * still wanted: ending a broadcast is not somebody stopping mid-sentence, it
   * is the room going away.
   */
  shut(): boolean {
    if (!this.live) return false
    this.#holders.clear()
    this.#since = null
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
  hurry(withinMs: number, holder: MicHolder = DECKS): boolean {
    const expiresAt = this.#holders.get(holder)
    if (expiresAt === undefined) return false
    const soon = this.#now() + withinMs
    if (soon >= expiresAt) return false
    this.#holders.set(holder, soon)
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
    const now = this.#now()
    let dropped = false
    for (const [holder, expiresAt] of this.#holders) {
      if (now >= expiresAt) {
        this.#holders.delete(holder)
        dropped = true
      }
    }
    // Only when the last one went. A co-host whose phone stopped renewing while
    // the decks are still talking is one grip lost, not a mic break ending.
    if (!dropped || this.live) return false
    this.#since = null
    return this.#changed()
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
    this.shut()
  }

  #changed(): boolean {
    this.emit('change', this.snapshot())
    return true
  }
}
