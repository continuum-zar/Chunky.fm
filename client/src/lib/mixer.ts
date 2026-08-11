/**
 * What goes out, and to whom.
 *
 *     mic ──┬──▶ analyser                      (the meter, useMicInput)
 *           ├──▶ monitor ──▶ your headphones   (useMicInput)
 *           └──▶ talkIn ──┬──▶ room bus  ──────▶ every listener
 *                         └──▶ guest bus ──────▶ the guest
 *
 *     guest ──┬──▶ cue ──▶ your headphones
 *             └──▶ air ──▶ room bus
 *
 * Two destinations rather than one, and the thing that matters most about this
 * file is a line that is not in it: **there is no path from the guest to the
 * guest bus.** That absence is called mix-minus in a studio, and it is the whole
 * reason a call-in is possible. Send a guest the room bus and they hear their
 * own voice about six hundred milliseconds after they said it, which is not a
 * cosmetic problem — delayed feedback at that interval is used deliberately to
 * disrupt fluency, and somebody experiencing it will stop mid-sentence and
 * assume the station is broken.
 *
 * The other reason this is its own object is smaller and more immediate: the
 * microphone and *what goes out* used to be one thing, so there was no outbound
 * bus until `getUserMedia` succeeded, and no peer connections either. A segment
 * where a guest talks and whoever runs the decks says nothing needs the second
 * without the first.
 *
 * Nothing here reaches a listener by itself. The bus is a track; `useVoice` is
 * what carries it.
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
  /** What the guest is sent: the room bus, minus the guest. */
  readonly guestTrack: MediaStreamTrack | null
  /**
   * A voice arriving from a guest. Null takes it away again.
   *
   * Builds the guest half of the graph on the first call and keeps it, so a
   * second caller costs nothing and a station nobody ever calls carries none of
   * it. Whatever `cue` and `air` were last told is applied here, so the console
   * can set them before there is anybody to apply them to.
   */
  hear(stream: MediaStream | null): void
  /** The guest in your headphones, and nowhere else. Pre-fade listen. */
  cue(on: boolean): void
  /** The guest in the room, as a linear gain. */
  air(level: number): void
  /**
   * Off the room bus, now.
   *
   * Client-side and immediate: no round trip, so the guest is out of what every
   * listener is being sent in the same frame the key went down. It cannot un-say
   * the word. It can stop the second one, and on a station whose music is
   * aligned to a clock — so cannot be delayed behind a dump button — that is the
   * whole of what is available.
   */
  cut(): void
}

/** A bus on a browser with no Web Audio: everything, audibly, nothing. */
const DEAF: AirMixer = {
  context: null,
  talkIn: { connect: () => undefined, disconnect: () => undefined } as unknown as AudioNode,
  roomTrack: null,
  guestTrack: null,
  hear: () => undefined,
  cue: () => undefined,
  air: () => undefined,
  cut: () => undefined,
  resume: () => undefined,
  close: () => undefined,
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
 * Build the two buses. One per console, held for as long as the page is open.
 *
 * **Call this from inside a user gesture,** for the reason `stationAudio` says
 * so: contexts start suspended and only a gesture may resume one. On the console
 * every route into this is a button — opening the microphone, or bringing
 * somebody up — so there is always one to spend.
 */
export function airMixer(context: AudioContext): AirMixer {
  let talkIn: GainNode
  let roomBus: MediaStreamAudioDestinationNode
  let guestBus: MediaStreamAudioDestinationNode
  try {
    talkIn = context.createGain()
    roomBus = context.createMediaStreamDestination()
    guestBus = context.createMediaStreamDestination()
    // Both, and this is the mix-minus: whoever runs the decks is heard by the
    // room and by the guest, because a guest who could not hear the person
    // interviewing them would have nothing to answer.
    talkIn.connect(roomBus)
    talkIn.connect(guestBus)
  } catch {
    // A context that cannot make a stream destination is one this cannot use.
    return DEAF
  }

  // The guest half, built on the first voice and kept afterwards.
  let guest: MediaStreamAudioSourceNode | null = null
  let cueGain: GainNode | null = null
  let airGain: GainNode | null = null
  // What the console asked for before there was anybody to apply it to.
  let cueing = false
  let airLevel = 0

  const apply = () => {
    const now = context.currentTime
    if (cueGain) ramp(cueGain.gain, cueing ? 1 : 0, now, RAMP_S)
    if (airGain) ramp(airGain.gain, airLevel, now, RAMP_S)
  }

  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  return {
    context,
    talkIn,
    get roomTrack() {
      return roomBus.stream.getAudioTracks()[0] ?? null
    },
    get guestTrack() {
      return guestBus.stream.getAudioTracks()[0] ?? null
    },

    hear(stream: MediaStream | null) {
      guest?.disconnect()
      guest = null
      if (stream === null) return

      resume()
      cueGain ??= context.createGain()
      airGain ??= context.createGain()
      // Both start shut. A guest whose voice arrived already on the air would
      // be somebody put in front of thirty people by a connection completing,
      // which is a decision nobody made.
      cueGain.gain.value = 0
      airGain.gain.value = 0

      guest = context.createMediaStreamSource(stream)
      guest.connect(cueGain)
      guest.connect(airGain)
      cueGain.connect(context.destination)
      airGain.connect(roomBus)
      // Deliberately not `guestBus`. See the top of this file; this missing
      // line is the feature.

      apply()
    },

    cue(on: boolean) {
      cueing = on
      apply()
    },

    air(level: number) {
      airLevel = Math.min(1, Math.max(0, level))
      apply()
    },

    cut() {
      airLevel = 0
      if (airGain) ramp(airGain.gain, 0, context.currentTime, CUT_S)
    },

    resume,

    close() {
      guest?.disconnect()
      talkIn.disconnect()
      for (const track of roomBus.stream.getAudioTracks()) track.stop()
      for (const track of guestBus.stream.getAudioTracks()) track.stop()
      void context.close().catch(() => undefined)
    },
  }
}
