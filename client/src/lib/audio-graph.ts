/**
 * The gain stage the music sits in, so somebody can talk over it and so one
 * record can become the next.
 *
 *     <audio A> ─▶ src ─▶ deck A ─┐
 *                         ▲       │
 *                      the fade   ├─▶ Gain ─▶ Gain ─▶ ┐
 *     <audio B> ─▶ src ─▶ deck B ─┘     ▲       ▲     │
 *                         ▲          the music  │     ├─▶ Gain ─▶ destination
 *                      the fade              the duck │      ▲
 *                                                     │   the hush
 *     MediaStream ─▶ src ────────────────────────────-┘
 *
 * Five gains, and no two of them are the same control.
 *
 * **The decks** are the crossfade, one per record, and they are the reason
 * there are two elements at all. A transition is two records playing at once
 * with one coming up as the other goes down, and a single element cannot be in
 * two places in a song. See `blend`.
 *
 * **The duck** is the station's, applied to the music alone, and it is what
 * makes a voice audible over a record. **The music** fader is this listener's
 * and also covers the music alone — how loud the record is for them, under
 * whatever else they are hearing. **The hush** is this listener's too and
 * covers everything, voices included: it is the mute button.
 *
 * Folding any two of those together breaks something specific. Duck into music
 * and the next mic break overwrites a level somebody set; music into hush and
 * turning the record down turns down the person you are answering; duck into
 * hush and a mic break becomes something a listener cannot turn off.
 *
 * The station does not mix — not the music, not the voice, and not the
 * transition. Nothing about any of it passes through the server, so a
 * crossfade cannot be a fader there any more than the duck could be. What
 * arrives instead is two instants on the clock the room already shares, and
 * thirty browsers run the same fade against them at the same moment.
 *
 * Built lazily, and deliberately: see `stationAudio`.
 */

/**
 * How quickly the duck moves, as `setTargetAtTime`'s time constant. About
 * 250ms to settle, which sounds like a hand on a fader.
 *
 * A ramp rather than a jump, always. An instantaneous gain change is an audible
 * click, and a click reads as a fault rather than as a decision.
 */
const RAMP_TIME_CONSTANT = 0.08

/**
 * How quickly a deck fader settles when it is not mid-crossfade.
 *
 * Short, and a *linear* ramp rather than the duck's exponential approach, which
 * is the same shape the crossfade segments use one line down. That keeps the
 * whole of the transition on one kind of automation: the decks are always
 * linear ramps, and `setTargetAtTime` is only ever a hand on a fader — the
 * duck, the mute, a listener's own music level.
 *
 * The distinction is not only tidiness. It is what lets an instrument outside
 * the graph tell the two apart, which is how `qa-mic.ts` measures a duck
 * without also measuring every transition of the evening.
 */
const DECK_SETTLE_S = 0.05

/**
 * How many straight segments a crossfade is drawn with.
 *
 * A crossfade between two unrelated records wants to be **equal-power** rather
 * than linear: two uncorrelated signals at half amplitude each sum to about
 * 0.7 of one at full, so a straight line down and a straight line up leave an
 * audible dip in the middle of every transition. The curve that does not is
 * `cos`/`sin`, and this is how finely it is approximated.
 *
 * Segments rather than `setValueCurveAtTime`, which is the obvious tool and the
 * wrong one here: a value curve cannot be cancelled cleanly mid-flight in every
 * browser, and it throws outright if a second one overlaps it — which is
 * exactly what happens when a listener's clock estimate improves halfway
 * through a fade and the ramp is redrawn. Eight linear ramps are cancellable,
 * re-drawable from wherever the gain actually is, and inaudibly different from
 * the curve they trace.
 */
const FADE_SEGMENTS = 8

/**
 * Which of the two decks a record is on.
 *
 * The pair alternates rather than being fixed, and that is the whole reason
 * this is a type rather than "the front one and the back one". During a
 * crossfade the outgoing record has to keep playing *without being reloaded* —
 * it is already streaming, already positioned, already decoded — so the
 * incoming record goes onto the deck the outgoing one is not using. Which deck
 * that is flips every transition.
 */
export type Deck = 'a' | 'b'

/** The other one. */
export const otherDeck = (deck: Deck): Deck => (deck === 'a' ? 'b' : 'a')

/** A fade, as the two instants the station broadcasts. */
export interface Blend {
  /** Which deck is coming up. The other is going down. */
  incoming: Deck
  /** Seconds from now until the fade begins. Negative means already underway. */
  startsIn: number
  /** Seconds from now until it finishes. */
  endsIn: number
}

export interface StationAudio {
  /** Where the music should sit, as a linear gain. Ramped, never jumped. */
  duck(to: number): void
  /**
   * How loud the music is for this listener alone, as a linear gain.
   *
   * A *third* control on the music, and it is neither of the other two. The
   * duck is the station's and is applied to everybody at once. The hush is this
   * listener's and covers everything, voices included. This is this listener's
   * and covers the music only, which is a thing only one page has ever needed:
   * a co-host talking over a record has to be able to hear the record under
   * themselves without turning down the person they are talking to.
   *
   * Its own node rather than folded into either. Folded into the duck, the next
   * mic break would overwrite it; folded into the hush, turning the music down
   * would turn down the voice you are answering.
   *
   * One everywhere else, which is what makes it invisible to every page that
   * does not use it.
   */
  music(level: number): void
  /**
   * This listener's own silence, over everything the station sends.
   *
   * `audio.muted` was the whole of muting until there were nights with no
   * track on at all, and it only ever covered the element: a voice arriving
   * over the talk channel goes to the graph rather than to the element, so
   * muting a conversation muted nothing. During a set that was a mic break
   * somebody could not turn off; during a talk session it is the mute button
   * doing nothing whatsoever.
   *
   * Ramped like the duck, and for the same reason: an instantaneous gain change
   * is an audible click, and a click reads as a fault rather than a decision.
   * The elements are still muted alongside this, so a browser with no Web Audio
   * at all keeps the mute it always had.
   */
  hush(on: boolean): void
  /**
   * Put one deck up and the other down, across a window on the clock.
   *
   * The window is given in seconds from *now* rather than as station time,
   * because that is the only form Web Audio can schedule against: the audio
   * context has its own clock and no idea what a server epoch is. Converting
   * happens at the call site, which is the one place that holds both.
   *
   * Safe to call again with the same window, which matters more than it looks:
   * this is re-run every time the clock estimate improves, and each call redraws
   * the remaining part of the fade from wherever the gains actually are.
   */
  blend(blend: Blend): void
  /**
   * One deck up, the other silent, now. What a station that is not mid-fade is.
   *
   * Ramped rather than switched for the reason everything here is, and quickly:
   * this is also what cancels a fade the station has abandoned — a pause, a
   * seek — and a transition that stops should stop promptly.
   */
  only(deck: Deck): void
  /**
   * Nudge a suspended context back awake. Cheap and safe to call again; worth
   * calling from anything that is already a user gesture, because a context
   * suspended by the OS (a call, a lock screen, a backgrounded tab) is silence
   * rather than quiet music.
   */
  resume(): void
  /**
   * Play a voice arriving from the decks. Null takes it away again.
   *
   * Straight to the output gain, deliberately past the duck: the duck is for
   * the music, and running the voice through it would turn every mic break into
   * somebody talking quietly over quiet music. Past the decks too, for the same
   * reason and one more — a voice on a deck would be crossfaded out by the next
   * transition.
   *
   * This is where a voice goes rather than a fresh `<audio>` element, and the
   * reason is the one that reads as over-thinking right up until it bites. A
   * listener who joined at nine and hears the first break at twenty to ten has
   * no gesture left to spend, so `play()` on a new element is simply refused
   * for them — while working perfectly in testing, because whoever is testing
   * clicked something a moment ago. The context here was resumed by the join
   * click and is already running, so nothing has to be asked twice.
   */
  play(stream: MediaStream | null): void
  close(): void
}

/**
 * Graphs already built, per element.
 *
 * `createMediaElementSource` may be called exactly once for a given element:
 * a second call throws `InvalidStateError`. React's StrictMode double-invokes
 * effects in development, and a listener can press join more than once, so
 * without this the naive version throws the first time it is run. The same
 * trick `audio-element.ts` uses for pending seeks, for the same class of reason.
 *
 * Keyed on the first element, which is the one a caller identifies the pair by.
 */
const graphs = new WeakMap<HTMLAudioElement, StationAudio>()

/**
 * A no-op stage, for a browser with no Web Audio at all.
 *
 * `audio.volume` is not the fallback it looks like: it is read-only on iOS, and
 * it cannot be ramped, so it would trade a working duck for a click on the
 * platform least able to spare one. Doing nothing is the honest failure — the
 * listener hears the music at full volume under a voice and hears transitions
 * as cuts, which is worse radio and is still radio.
 */
const DEAF: StationAudio = {
  duck: () => undefined,
  music: () => undefined,
  hush: () => undefined,
  blend: () => undefined,
  only: () => undefined,
  resume: () => undefined,
  play: () => undefined,
  close: () => undefined,
}

/**
 * A silent element to park a remote stream on.
 *
 * Chrome will not decode a `MediaStream` that is only connected to Web Audio:
 * `createMediaStreamSource` on its own produces a graph that runs and a voice
 * nobody hears. Attaching the same stream to a media element is what starts the
 * decoder, and the element is muted because it is not the thing being listened
 * to — the audible path is the graph, and letting both through would be one
 * voice played twice, slightly apart.
 *
 * Created here rather than rendered, because it is not part of any page: it has
 * no size, no controls and nothing to look at, and a component that drew it
 * would be inventing a reason for it to exist in a tree.
 */
function decoderSink(): HTMLAudioElement {
  const sink = document.createElement('audio')
  sink.autoplay = true
  sink.muted = true
  return sink
}

/** Equal power, as a fraction of the way through: `0` silent, `1` full. */
function fadeIn(progress: number): number {
  return Math.sin((Math.min(1, Math.max(0, progress)) * Math.PI) / 2)
}

/**
 * The gain stage for these elements, building it on first ask.
 *
 * **Call this from inside a user gesture.** Routing an element through Web
 * Audio is permanent and total: from then on its sound reaches the speakers
 * only through the graph, so a context that is still suspended is not quiet
 * music, it is no music. Contexts start suspended, and only a gesture may
 * resume one. Building the graph lazily, at the moment the listener presses
 * join, means the elements play normally until there is a gesture to spend and
 * are never routed through a graph that cannot be woken.
 *
 * `second` is optional, and a page that passes nothing gets a station that
 * cuts between records rather than blending. That is the honest degradation and
 * not a special case anybody has to handle: `blend` on a one-deck graph simply
 * puts the incoming deck up, which is what a cut is.
 */
export function stationAudio(
  audio: HTMLAudioElement,
  second?: HTMLAudioElement | null,
): StationAudio {
  const existing = graphs.get(audio)
  if (existing) return existing

  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return DEAF

  let context: AudioContext
  let gain: GainNode
  let out: GainNode
  let level: GainNode
  const decks: Record<Deck, GainNode | null> = { a: null, b: null }
  try {
    context = new Ctor()
    gain = context.createGain()
    // Everything reaches the speakers through this one, which is what makes it
    // able to be the mute: a voice connected later joins the graph here rather
    // than at the destination, so it is covered without being ducked.
    out = context.createGain()
    // Between the decks and the duck, so it is the music and nothing else: a
    // voice joins the graph at `out`, past both of these. See `music`.
    level = context.createGain()
    level.connect(gain)
    gain.connect(out)
    out.connect(context.destination)

    const plug = (element: HTMLAudioElement, deck: Deck) => {
      const source = context.createMediaElementSource(element)
      const fader = context.createGain()
      // Deck A comes up open and deck B shut, which is a station playing one
      // record: the ordinary state, and the one every page is in until the
      // first transition. A pair that both started open would be the same
      // record twice for anybody whose second element happened to be loaded.
      fader.gain.value = deck === 'a' ? 1 : 0
      source.connect(fader)
      fader.connect(level)
      decks[deck] = fader
    }

    plug(audio, 'a')
    if (second) plug(second, 'b')
  } catch {
    // Most likely a second source node for one of these elements from a code
    // path that did not come through here. Nothing to recover: the element is
    // already routed somewhere, and building a second graph would not be heard.
    graphs.set(audio, DEAF)
    return DEAF
  }

  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  // Both are built on the first voice and kept afterwards, so a second mic
  // break costs nothing and so nothing here exists on a station nobody talks on.
  let sink: HTMLAudioElement | null = null
  let voice: MediaStreamAudioSourceNode | null = null

  /** Move a gain to a level, from wherever it actually is. */
  const ramp = (node: GainNode, to: number) => {
    const target = Math.min(1, Math.max(0, to))
    const now = context.currentTime
    // Read the value first, then pin it: `gain.value` during an automation is
    // the level right now, so a duck interrupted halfway (talk, stop, talk
    // again) ramps on from where it actually is rather than snapping back to
    // wherever the last ramp was aimed.
    const current = node.gain.value
    node.gain.cancelScheduledValues(now)
    node.gain.setValueAtTime(current, now)
    node.gain.setTargetAtTime(target, now, RAMP_TIME_CONSTANT)
  }

  /** Move a deck fader to a level now. See `DECK_SETTLE_S`. */
  const settle = (node: GainNode | null, to: number) => {
    if (!node) return
    const now = context.currentTime
    const param = node.gain
    const current = param.value
    param.cancelScheduledValues(now)
    param.setValueAtTime(current, now)
    param.linearRampToValueAtTime(Math.min(1, Math.max(0, to)), now + DECK_SETTLE_S)
  }

  /**
   * Draw one half of a crossfade: a gain walking a curve across a window.
   *
   * The window may already have started, and usually has by a few milliseconds
   * — the frame that noticed the transition is not the frame it began on. So
   * this draws only what is left of it, starting from where the curve says the
   * gain should be right now rather than from where it happens to be. Starting
   * from the actual value would be gentler and would also mean a listener whose
   * page was busy at the wrong moment finishing their fade late, out of step
   * with everybody else's.
   */
  const curve = (node: GainNode, startsIn: number, endsIn: number, up: boolean) => {
    const now = context.currentTime
    const length = endsIn - startsIn
    const param = node.gain
    param.cancelScheduledValues(now)

    if (length <= 0) {
      param.setValueAtTime(up ? 1 : 0, now)
      return
    }

    // Where in the fade this browser actually is. Clamped below at zero for the
    // ordinary case of a window that has not begun yet.
    const from = Math.max(0, -startsIn / length)
    const level = (progress: number) => (up ? fadeIn(progress) : fadeIn(1 - progress))
    param.setValueAtTime(level(from), Math.max(now, now + startsIn))

    for (let step = 1; step <= FADE_SEGMENTS; step++) {
      const progress = from + ((1 - from) * step) / FADE_SEGMENTS
      param.linearRampToValueAtTime(level(progress), now + startsIn + progress * length)
    }
  }

  const stage: StationAudio = {
    duck(to: number) {
      ramp(gain, to)
    },
    music(to: number) {
      ramp(level, to)
    },
    hush(on: boolean) {
      ramp(out, on ? 0 : 1)
    },
    blend({ incoming, startsIn, endsIn }: Blend) {
      const up = decks[incoming]
      const down = decks[otherDeck(incoming)]
      // One deck is a station that cuts. Putting the incoming one up is the
      // whole of what a cut is, and there is nothing to take down.
      if (!up || !down) {
        settle(up, 1)
        return
      }
      curve(up, startsIn, endsIn, true)
      curve(down, startsIn, endsIn, false)
    },
    only(deck: Deck) {
      settle(decks[deck], 1)
      settle(decks[otherDeck(deck)], 0)
    },
    resume,
    play(stream: MediaStream | null) {
      voice?.disconnect()
      voice = null
      if (stream === null) {
        if (sink) sink.srcObject = null
        return
      }
      // The context may have been suspended since the join click — a call, a
      // lock screen, a tab in the background. A break arriving is not a gesture
      // and cannot force it, but asking costs nothing and often works.
      resume()
      sink ??= decoderSink()
      sink.srcObject = stream
      // Refused where a gesture is genuinely required; the graph below is the
      // audible path either way, so this is the decoder and not the sound.
      void sink.play().catch(() => undefined)
      voice = context.createMediaStreamSource(stream)
      // Into the output gain rather than the destination: past the duck, which
      // is for the music, and inside the mute, which is for this listener. A
      // voice wired straight to the destination is one nobody can turn off.
      voice.connect(out)
    },
    close() {
      graphs.delete(audio)
      voice?.disconnect()
      if (sink) sink.srcObject = null
      void context.close().catch(() => undefined)
    },
  }

  resume()
  graphs.set(audio, stage)
  return stage
}
