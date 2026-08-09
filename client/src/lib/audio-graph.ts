/**
 * The gain stage the music sits in, so somebody can talk over it.
 *
 *     <audio> ──▶ MediaElementSource ──▶ GainNode ──▶ destination
 *                                            ▲
 *                                        the duck
 *
 * The station does not mix. Nothing about the music passes through the server,
 * so ducking cannot be a fader there; what arrives instead is a `mic` frame
 * saying how far down the music should sit, and every listener applies it here,
 * to the copy of the track their own browser is already playing. Thirty
 * browsers turn themselves down on a clock they already share.
 *
 * Built lazily, and deliberately: see `stationAudio`.
 */

/**
 * How quickly the music moves, as `setTargetAtTime`'s time constant. About
 * 250ms to settle, which sounds like a hand on a fader.
 *
 * A ramp rather than a jump, always. An instantaneous gain change is an audible
 * click, and a click reads as a fault rather than as a decision.
 */
const RAMP_TIME_CONSTANT = 0.08

export interface StationAudio {
  /** Where the music should sit, as a linear gain. Ramped, never jumped. */
  duck(to: number): void
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
   * Straight to the destination, deliberately past the gain node: the duck is
   * for the music, and running the voice through it would turn every mic break
   * into somebody talking quietly over quiet music.
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
 */
const graphs = new WeakMap<HTMLAudioElement, StationAudio>()

/**
 * A no-op stage, for a browser with no Web Audio at all.
 *
 * `audio.volume` is not the fallback it looks like: it is read-only on iOS, and
 * it cannot be ramped, so it would trade a working duck for a click on the
 * platform least able to spare one. Doing nothing is the honest failure — the
 * listener hears the music at full volume under a voice, which is worse radio
 * and is still radio.
 */
const DEAF: StationAudio = {
  duck: () => undefined,
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

/**
 * The gain stage for this element, building it on first ask.
 *
 * **Call this from inside a user gesture.** Routing an element through Web
 * Audio is permanent and total: from then on its sound reaches the speakers
 * only through the graph, so a context that is still suspended is not quiet
 * music, it is no music. Contexts start suspended, and only a gesture may
 * resume one. Building the graph lazily, at the moment the listener presses
 * join, means the element plays normally until there is a gesture to spend and
 * is never routed through a graph that cannot be woken.
 */
export function stationAudio(audio: HTMLAudioElement): StationAudio {
  const existing = graphs.get(audio)
  if (existing) return existing

  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return DEAF

  let context: AudioContext
  let gain: GainNode
  try {
    context = new Ctor()
    const source = context.createMediaElementSource(audio)
    gain = context.createGain()
    source.connect(gain)
    gain.connect(context.destination)
  } catch {
    // Most likely a second source node for this element from a code path that
    // did not come through here. Nothing to recover: the element is already
    // routed somewhere, and building a second graph would not be heard.
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

  const stage: StationAudio = {
    duck(to: number) {
      const target = Math.min(1, Math.max(0, to))
      const now = context.currentTime
      // Read the value first, then pin it: `gain.value` during an automation is
      // the level right now, so a duck interrupted halfway (talk, stop, talk
      // again) ramps on from where it actually is rather than snapping back to
      // wherever the last ramp was aimed.
      const current = gain.gain.value
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(current, now)
      gain.gain.setTargetAtTime(target, now, RAMP_TIME_CONSTANT)
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
      voice.connect(context.destination)
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
