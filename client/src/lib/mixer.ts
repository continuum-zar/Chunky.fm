/**
 * What goes out, and to whom.
 *
 *     mic ──┬──▶ analyser                      (the meter, useMicInput)
 *           ├──▶ monitor ──▶ your headphones   (useMicInput)
 *           └──▶ talkIn ──┬──▶ room bus  ──────────▶ every listener
 *                         ├──▶ seat bus (guest) ───▶ the guest
 *                         └──▶ seat bus (co-host) ─▶ the co-host
 *
 *     guest ───┬──▶ cue ──▶ your headphones
 *              ├──▶ air ──▶ room bus
 *              └──────────▶ seat bus (co-host)     ← and NOT seat bus (guest)
 *
 *     co-host ─┬──▶ cue ──▶ your headphones
 *              ├──▶ air ──▶ room bus
 *              └──────────▶ seat bus (guest)       ← and NOT seat bus (co-host)
 *
 * A bus per voice rather than one for all of them, and the thing that matters
 * most about this file is still a line that is not in it: **there is no path
 * from a voice to its own seat bus.** That absence is called mix-minus in a
 * studio, and it is the whole reason a call is possible. Send somebody the room
 * bus and they hear their own voice about six hundred milliseconds after they
 * said it, which is not a cosmetic problem — delayed feedback at that interval
 * is used deliberately to disrupt fluency, and the person it happens to will
 * stop mid-sentence and assume the station is broken.
 *
 * It used to be one bus for everybody who was not the console, which was right
 * while only one person could be up. With a co-host there can be two, and one
 * shared minus-bus would mean the co-host and the caller could each hear the
 * decks and neither could hear the other — a three-way conversation in which
 * two of the three are talking past each other. So each voice gets a bus that
 * carries everything except itself, and the arithmetic falls out: two people up
 * is two buses, and the missing line in each is a different one.
 *
 * The other reason this is its own object is smaller and more immediate: the
 * microphone and *what goes out* used to be one thing, so there was no outbound
 * bus until `getUserMedia` succeeded, and no peer connections either. A segment
 * where a guest talks and whoever runs the decks says nothing needs the second
 * without the first.
 *
 * Nothing here reaches a listener by itself. The buses are tracks; `useVoice`
 * is what carries them.
 */

/**
 * How quickly a fader moves. Short enough not to swallow a syllable, long
 * enough not to click — the same reasoning, and roughly the same number, as the
 * talk gain in `useMicInput`.
 */
const RAMP_S = 0.015

/**
 * How quickly the guest is taken off the air by `cut`.
 *
 * Faster than a fader and still not a step. This is the control reached for
 * when something has to stop *now*, and the difference between five and fifteen
 * milliseconds is not audible while the difference between fifteen and zero is:
 * zero is a click, and a click is one more thing the room has to interpret.
 */
const CUT_S = 0.005

/**
 * Somewhere a microphone can be plugged in.
 *
 * The little that `useMicInput` needs to know about what is downstream of it,
 * and the reason the same rig serves both ends of a call: the console plugs
 * into two buses and a guest plugs into one, and neither of them is the
 * microphone's business.
 */
export interface OutputBus {
  /**
   * The graph everything hangs off, or null on a browser that could not give
   * one.
   *
   * Exposed because the microphone rig builds its analyser and its faders in
   * the same context as the bus they feed — nodes from two contexts cannot be
   * connected — and reaching through a node to find it would be a worse way of
   * saying the same thing.
   */
  readonly context: AudioContext | null
  /**
   * Where the microphone plugs in.
   *
   * A node rather than a track, because the rig upstream owns its own ramping —
   * the talk button is a gain in `useMicInput`, and it has to stay there so
   * that the meter goes on reading a capture that is running whether or not
   * anybody can hear it.
   */
  readonly talkIn: AudioNode
  /** Nudge a suspended context awake. Cheap, and safe to call again. */
  resume(): void
  close(): void
}

/**
 * A guest's end: one bus, and nothing to mix.
 *
 * The whole of a caller's outbound side. There is no second destination because
 * there is nobody to send a different mix to, no cue because a guest is not
 * auditioning anybody, and no air fader because whether the room hears them is
 * the console's decision and is taken at the console's end.
 *
 * Its own object rather than an `airMixer` with the unused half ignored: the
 * two are the same shape and not the same thing, and a guest holding a mixer
 * with a `cut()` on it would be a guest holding a control that does nothing.
 */
export interface GuestBus extends OutputBus {
  /** What the console is sent, once there is a bus to send. */
  readonly track: MediaStreamTrack | null
}

export function guestBus(context: AudioContext): GuestBus {
  let talkIn: GainNode
  let bus: MediaStreamAudioDestinationNode
  try {
    talkIn = context.createGain()
    bus = context.createMediaStreamDestination()
    talkIn.connect(bus)
  } catch {
    return { ...DEAF, track: null }
  }

  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  return {
    context,
    talkIn,
    get track() {
      return bus.stream.getAudioTracks()[0] ?? null
    },
    resume,
    close() {
      talkIn.disconnect()
      for (const track of bus.stream.getAudioTracks()) track.stop()
      void context.close().catch(() => undefined)
    },
  }
}

export interface AirMixer extends OutputBus {
  /** What every listener is sent. Exists from the moment the mixer does. */
  readonly roomTrack: MediaStreamTrack | null
  /**
   * What one voice is sent: the room bus, minus themselves.
   *
   * Built on the first ask for a given id and kept afterwards, so a second
   * caller costs nothing and a station nobody calls carries none of it. The
   * missing line is the feature; see the top of this file.
   *
   * Safe to ask for before there is a voice on that id, which is the ordinary
   * order of things: the console offers somebody a connection, and the track it
   * offers has to exist before there is anything coming back on it.
   */
  seatTrack(id: number): MediaStreamTrack | null
  /**
   * A voice arriving. Null takes it away again.
   *
   * Builds that voice's half of the graph on the first call and keeps it.
   * Whatever `cue` and `air` were last told for this id is applied here, so the
   * console can set them before there is anybody to apply them to.
   */
  hear(id: number, stream: MediaStream | null): void
  /** One voice in your headphones, and nowhere else. Pre-fade listen. */
  cue(id: number, on: boolean): void
  /** One voice in the room, as a linear gain. */
  air(id: number, level: number): void
  /**
   * Everybody off the room bus, now.
   *
   * Client-side and immediate: no round trip, so nobody's voice is still
   * reaching what every listener is being sent in the same frame the key went
   * down. Takes no id, because this is the control reached for when something
   * has to stop *now* and picking the right person out of a list is not what
   * anybody is doing at that moment.
   *
   * It cannot un-say the word. It can stop the second one, and on a station
   * whose music is aligned to a clock — so cannot be delayed behind a dump
   * button — that is the whole of what is available.
   */
  cut(): void
}

/** A bus on a browser with no Web Audio: everything, audibly, nothing. */
const DEAF: AirMixer = {
  context: null,
  talkIn: { connect: () => undefined, disconnect: () => undefined } as unknown as AudioNode,
  roomTrack: null,
  seatTrack: () => null,
  hear: () => undefined,
  cue: () => undefined,
  air: () => undefined,
  cut: () => undefined,
  resume: () => undefined,
  close: () => undefined,
}
/**
 * A silent element to park a guest's stream on.
 *
 * The same workaround `audio-graph.ts` needs on the listener's side, and it
 * bites here for the same reason and in the same disguise: Chrome will not
 * decode a `MediaStream` that is only connected to Web Audio, so
 * `createMediaStreamSource` on its own builds a graph that runs perfectly and
 * carries nothing. Attaching the stream to a media element is what starts the
 * decoder.
 *
 * What makes it worth a comment in two places is how it presents. The peer
 * connection is `connected`, the console's own health column says *you can hear
 * them*, the guest's meter is moving on their machine — and there is silence.
 * Every instrument says the call is working except the only one that counts.
 *
 * Muted, because it is not the thing being listened to: the audible path is the
 * graph, and letting both through would be one voice played twice, slightly
 * apart. Created rather than rendered, because it is not part of any page.
 */
function decoderSink(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null
  const sink = document.createElement('audio')
  sink.autoplay = true
  sink.muted = true
  return sink
}

function ramp(param: AudioParam, to: number, at: number, seconds: number): void {
  // Read first, then pin: `value` during an automation is the level right now,
  // so a fader interrupted halfway carries on from where it actually is rather
  // than snapping back to wherever the last ramp was aimed.
  const current = param.value
  param.cancelScheduledValues(at)
  param.setValueAtTime(current, at)
  param.linearRampToValueAtTime(to, at + seconds)
}

/**
 * One voice arriving, and the three places it can go.
 *
 * `sink` is the decoder workaround above; `cue` is your headphones; `air` is
 * the room bus and every *other* seat bus. The absence of a connection from
 * `air` to this voice's own seat bus is the mix-minus.
 */
interface Voice {
  source: MediaStreamAudioSourceNode | null
  sink: HTMLAudioElement | null
  cueGain: GainNode
  airGain: GainNode
  cueing: boolean
  level: number
}

/**
 * Build the buses. One mixer per console, held for as long as the page is open.
 *
 * **Call this from inside a user gesture,** for the reason `stationAudio` says
 * so: contexts start suspended and only a gesture may resume one. On the console
 * every route into this is a button — opening the microphone, or bringing
 * somebody up — so there is always one to spend.
 */
export function airMixer(context: AudioContext): AirMixer {
  let talkIn: GainNode
  let roomBus: MediaStreamAudioDestinationNode
  try {
    talkIn = context.createGain()
    roomBus = context.createMediaStreamDestination()
    talkIn.connect(roomBus)
  } catch {
    // A context that cannot make a stream destination is one this cannot use.
    return DEAF
  }

  /** A minus-bus per voice, built on the first ask and kept afterwards. */
  const seats = new Map<number, MediaStreamAudioDestinationNode>()
  /** A voice per id, built on the first stream and kept afterwards. */
  const voices = new Map<number, Voice>()

  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  /**
   * Connect everything to everything it should be connected to.
   *
   * Run after any change to either map rather than threading the right pair of
   * connections through each call site, and it is safe to run again: Web Audio
   * ignores a `connect` between a pair that is already connected, so this
   * converges rather than accumulating. The alternative — working out the delta
   * — would be four cases (a seat arriving, a voice arriving, and each of them
   * leaving) with one line each, and the one that gets forgotten is a person
   * who cannot hear one of the other two for reasons nothing reports.
   */
  const wire = () => {
    for (const [id, bus] of seats) {
      // Whoever runs the decks reaches everybody. A guest who could not hear
      // the person interviewing them would have nothing to answer.
      talkIn.connect(bus)
      for (const [other, voice] of voices) {
        // **The missing line.** Everything above this exists so that this
        // comparison can be here rather than nowhere.
        if (other === id) continue
        voice.airGain.connect(bus)
      }
    }
  }

  const apply = (voice: Voice) => {
    const now = context.currentTime
    ramp(voice.cueGain.gain, voice.cueing ? 1 : 0, now, RAMP_S)
    ramp(voice.airGain.gain, voice.level, now, RAMP_S)
  }

  /** The row for an id, built shut on first ask. */
  const voiceFor = (id: number): Voice | null => {
    const existing = voices.get(id)
    if (existing) return existing
    try {
      const cueGain = context.createGain()
      const airGain = context.createGain()
      // Both start shut. A voice that arrived already on the air would be
      // somebody put in front of thirty people by a connection completing,
      // which is a decision nobody made.
      cueGain.gain.value = 0
      airGain.gain.value = 0
      cueGain.connect(context.destination)
      airGain.connect(roomBus)
      const voice: Voice = {
        source: null,
        sink: null,
        cueGain,
        airGain,
        cueing: false,
        level: 0,
      }
      voices.set(id, voice)
      wire()
      return voice
    } catch {
      return null
    }
  }

  return {
    context,
    talkIn,
    get roomTrack() {
      return roomBus.stream.getAudioTracks()[0] ?? null
    },

    seatTrack(id: number) {
      let bus = seats.get(id)
      if (!bus) {
        try {
          bus = context.createMediaStreamDestination()
        } catch {
          return null
        }
        seats.set(id, bus)
        wire()
      }
      return bus.stream.getAudioTracks()[0] ?? null
    },

    hear(id: number, stream: MediaStream | null) {
      const voice = voiceFor(id)
      if (!voice) return

      voice.source?.disconnect()
      voice.source = null
      if (stream === null) {
        if (voice.sink) voice.sink.srcObject = null
        // The gains are kept rather than torn down: the same person can be
        // brought back up, and rebuilding them would drop whatever the console
        // had set for them in the meantime.
        return
      }

      resume()
      // Before the graph, and the reason is above: without an element to drive
      // it, nothing downstream of `createMediaStreamSource` ever gets a sample.
      voice.sink ??= decoderSink()
      if (voice.sink) {
        voice.sink.srcObject = stream
        // Refused where a gesture is genuinely required. The graph below is the
        // audible path either way, so this is the decoder and not the sound.
        void voice.sink.play().catch(() => undefined)
      }

      try {
        voice.source = context.createMediaStreamSource(stream)
      } catch {
        return
      }
      voice.source.connect(voice.cueGain)
      voice.source.connect(voice.airGain)
      // Deliberately never to this voice's own seat bus. See the top of this
      // file; the connection that is not made here is the feature.
      wire()
      apply(voice)
    },

    cue(id: number, on: boolean) {
      const voice = voiceFor(id)
      if (!voice) return
      voice.cueing = on
      apply(voice)
    },

    air(id: number, level: number) {
      const voice = voiceFor(id)
      if (!voice) return
      voice.level = Math.min(1, Math.max(0, level))
      apply(voice)
    },

    cut() {
      const now = context.currentTime
      for (const voice of voices.values()) {
        voice.level = 0
        ramp(voice.airGain.gain, 0, now, CUT_S)
      }
    },

    resume,

    close() {
      for (const voice of voices.values()) {
        voice.source?.disconnect()
        if (voice.sink) voice.sink.srcObject = null
        voice.cueGain.disconnect()
        voice.airGain.disconnect()
      }
      voices.clear()
      talkIn.disconnect()
      for (const track of roomBus.stream.getAudioTracks()) track.stop()
      for (const bus of seats.values()) {
        for (const track of bus.stream.getAudioTracks()) track.stop()
      }
      seats.clear()
      void context.close().catch(() => undefined)
    },
  }
}
