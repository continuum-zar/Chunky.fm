import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import type { OutputBus } from '../lib/mixer.js'
import {
  type InputDevice,
  clippedIn,
  inputsFrom,
  levelFrom,
  meterScale,
  micConstraints,
  nextLevel,
} from '../lib/mic-input.js'

/**
 * The microphone on the console: level, monitoring, and where it plugs in.
 *
 *     getUserMedia ──▶ MediaStreamSource ──┬──▶ AnalyserNode          (the meter)
 *                                          ├──▶ monitor ──▶ speakers  (optional)
 *                                          └──▶ talk ──▶ mixer.talkIn (the room)
 *
 * The third branch is worth explaining, because the obvious way to mute a
 * microphone is `track.enabled = false` and that is what this deliberately does
 * *not* do. A disabled track produces silence for everything downstream of it,
 * including the analyser — so the meter would die the moment you stopped
 * talking, which is exactly when somebody is most likely to be looking at it to
 * set their level. Instead the capture runs continuously, the meter reads it
 * always, and what the room receives comes from a gain node that is turned down
 * between breaks. Multiplying by zero is as silent as disabling, and unlike
 * disabling it can be ramped, so a break does not open with a click.
 *
 * What this no longer owns is the bus. `talk` used to end in a stream
 * destination here, which meant there was nothing to send until `getUserMedia`
 * had succeeded — and therefore no peer connections either. A guest talking
 * while whoever runs the decks says nothing needs the second without the first,
 * so the buses moved to `useAirMixer` and this connects into one. It also means
 * the rig can be torn down and rebuilt — which is exactly what changing input
 * device does — without the room's connections noticing.
 *
 * The context comes from the mixer, and is deliberately not the one the music
 * sits in. A console reached from `#on-air` is still playing the station —
 * `joined` survives the trip — so the two graphs coexist on the same page and
 * have nothing to say to each other.
 */

export type MicInputStatus =
  /** Nothing open. Nobody has asked for the microphone yet. */
  | 'idle'
  /** The permission prompt is up, or the device is being opened. */
  | 'asking'
  /** Open, metering, and monitoring if that is switched on. */
  | 'live'
  /** The browser said no, and will keep saying no until the site is re-allowed. */
  | 'denied'
  /** Something else went wrong: no device, or one that is already in use. */
  | 'failed'

export interface MicInput {
  status: MicInputStatus
  /** What to tell somebody, when there is anything worth telling them. */
  error: string | null
  devices: InputDevice[]
  /** Which input, or null for whatever the system is pointed at. */
  deviceId: string | null
  /** Whether to assume a speaker in the room; see `micConstraints`. */
  onSpeakers: boolean
  monitoring: boolean
  /**
   * The bar the meter paints into, scaled along its own width.
   *
   * A ref rather than a number in state, and that is not a micro-optimisation:
   * a level in state is a React render every animation frame, sixty times a
   * second, for the whole time the mic is open — with the queue, the library
   * and the room all on the same page.
   */
  meterRef: RefObject<HTMLDivElement | null>
  /**
   * Whether the rig is open and plugged into the mixer.
   *
   * What used to be `track` being non-null. The track itself belongs to the
   * mixer now and outlives any one microphone, so what the console needs from
   * here is not "what do I send" but "is there anything of mine on the bus".
   */
  live: boolean
  open(): void
  close(): void
  choose(deviceId: string | null): void
  setOnSpeakers(onSpeakers: boolean): void
  setMonitoring(monitoring: boolean): void
  /**
   * Whether the room is being sent anything.
   *
   * On the console this is the talk button, held down and released. For a guest
   * it is a latch: whoever runs the decks chose to be there and will reach for
   * a key, while a guest fumbling a held key while trying to talk is worse than
   * a guest who forgets to unmute.
   */
  talking: boolean
  /** Open or close what goes out. Ramped; see `talk`. */
  setTalking(talking: boolean): void
}

/** Long enough not to click, short enough not to swallow the first syllable. */
const TALK_RAMP_S = 0.015

/** How long the clip lamp stays lit after the last sample against the rail. */
const CLIP_HOLD_MS = 1_200

interface Rig {
  stream: MediaStream
  context: AudioContext
  analyser: AnalyserNode
  monitor: GainNode
  talk: GainNode
  frame: number | null
}

/**
 * Everything this hook made, and nothing it borrowed.
 *
 * The context and the buses belong to the mixer and survive this: closing them
 * here would take the room's connections down every time somebody changed
 * input device, which rebuilds the rig. What goes is the capture — first, so
 * the browser's recording indicator is off before anything else can fail — and
 * the three nodes hung off it.
 */
function teardown(rig: Rig): void {
  if (rig.frame !== null) cancelAnimationFrame(rig.frame)
  for (const track of rig.stream.getTracks()) track.stop()
  rig.talk.disconnect()
  rig.monitor.disconnect()
  rig.analyser.disconnect()
}

export interface MicInputOptions {
  /**
   * Whether to assume a speaker in the room to begin with.
   *
   * False on the console, where whoever runs the decks read a warning and chose
   * their own machine, and echo cancellation only costs voice quality. True for
   * a guest, who is whoever put their hand up on whatever they were holding: it
   * mangles anything musical, and a guest is not sending music.
   */
  onSpeakers?: boolean
  /**
   * Every frame's raw level, and how long since the last one.
   *
   * Raw rather than the smoothed number the meter draws: the needle falls
   * slowly on purpose, and a decision made on it would still be reading a room
   * that had already gone quiet. Called from inside the animation loop, so it
   * must not render — the sound check keeps its state in a ref and only tells
   * React when the *stage* moves.
   */
  onLevel?(level: number, sinceMs: number): void
}

export function useMicInput(
  bus: { ensure(): OutputBus | null },
  { onSpeakers: startOnSpeakers = false, onLevel }: MicInputOptions = {},
): MicInput {
  const [wanted, setWanted] = useState(false)
  /**
   * Bumped on every ask, and in the effect's dependencies.
   *
   * Without it, "turn the mic on" after a refusal is a no-op: `wanted` is
   * already true, so nothing changes and nothing re-runs, and the button sits
   * there doing nothing for the one person most likely to press it twice.
   */
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<MicInputStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [onSpeakers, setOnSpeakers] = useState(startOnSpeakers)
  const [monitoring, setMonitoring] = useState(false)
  const [talking, setTalking] = useState(false)

  const meterRef = useRef<HTMLDivElement | null>(null)
  const rigRef = useRef<Rig | null>(null)
  // Read inside the animation frame rather than closed over, so switching
  // monitoring on and off never has to rebuild the graph.
  const monitoringRef = useRef(monitoring)
  monitoringRef.current = monitoring
  // Read inside the effect and the loop rather than in their dependencies:
  // both are stable in practice, and a handle or a callback that changed
  // identity would re-acquire the microphone on a render.
  const busRef = useRef(bus)
  busRef.current = bus
  const levelRef = useRef(onLevel)
  levelRef.current = onLevel

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      setDevices(inputsFrom(await navigator.mediaDevices.enumerateDevices()))
    } catch {
      // A listing nobody can read is not worth a banner; the picker just stays
      // on whatever it had, and the default device still works.
    }
  }, [])

  // Once on mount, and again whenever something is plugged in or pulled out.
  // A USB interface arriving is the ordinary case, and a picker that needed the
  // page reloaded to notice would be the wrong kind of surprise mid-set.
  useEffect(() => {
    void refreshDevices()
    const media = navigator.mediaDevices
    if (!media?.addEventListener) return
    const onChange = () => void refreshDevices()
    media.addEventListener('devicechange', onChange)
    return () => media.removeEventListener('devicechange', onChange)
  }, [refreshDevices])

  /**
   * Opens the device and builds the graph, and tears it down again on the way
   * out. Keyed on the constraints as well as on `wanted`, because changing the
   * input or the echo-cancellation setting means asking for a different stream:
   * `applyConstraints` can do some of this in some browsers, and re-acquiring
   * does all of it in all of them, at the cost of a moment of dead meter.
   */
  useEffect(() => {
    if (!wanted) return

    let cancelled = false
    setStatus('asking')
    setError(null)

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(deviceId, onSpeakers),
        })
        // The await above is where this can go stale: the device can be changed
        // again, or the mic switched off, while the prompt is still up.
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }

        // The mixer's, not one of this hook's own, and built on the click that
        // asked for the microphone. See `useAirMixer`.
        const air = busRef.current.ensure()
        const context = air?.context ?? null
        if (!air || !context) {
          // Nothing to recover, and the capture has to go back: a browser
          // holding a microphone open for a graph that was never built would
          // show the recording indicator all evening for no sound at all.
          for (const track of stream.getTracks()) track.stop()
          setStatus('failed')
          setError('this browser has no audio engine to run the mic through')
          return
        }
        const source = context.createMediaStreamSource(stream)
        const analyser = context.createAnalyser()
        // Small enough to be current — a meter reading 40ms ago is a meter
        // nobody trusts — and big enough that the RMS is of a waveform rather
        // than of a handful of samples.
        analyser.fftSize = 1024
        const monitor = context.createGain()
        monitor.gain.value = 0
        // Shut, whatever was happening a moment ago. Re-acquiring the device
        // (a different input, the speakers switch) rebuilds this branch, and it
        // must never come back open: a rebuild that inherited an old `true`
        // would put a live microphone on the air with nobody holding anything.
        const talk = context.createGain()
        talk.gain.value = 0
        source.connect(analyser)
        source.connect(monitor)
        source.connect(talk)
        // Into the mixer rather than into a destination of its own. From here
        // the room bus and the guest bus both carry this, which is what lets
        // somebody being interviewed hear the person interviewing them.
        talk.connect(air.talkIn)
        monitor.connect(context.destination)

        const rig: Rig = { stream, context, analyser, monitor, talk, frame: null }
        rigRef.current = rig
        // Opening the mic is a click, so the context can be woken here.
        air.resume()

        const samples = new Uint8Array(analyser.fftSize)
        let level = 0
        let clipUntil = 0
        let last = performance.now()

        const paint = () => {
          rig.frame = requestAnimationFrame(paint)
          analyser.getByteTimeDomainData(samples)
          const raw = levelFrom(samples)
          level = nextLevel(level, raw)
          const now = performance.now()
          // The raw number and a real interval, so whatever is reading this is
          // not assuming sixty frames a second on a machine that is not giving
          // them. A backgrounded tab stops painting altogether, which is one
          // long frame rather than a lot of missing ones.
          levelRef.current?.(raw, now - last)
          last = now
          if (clippedIn(samples)) clipUntil = now + CLIP_HOLD_MS

          // Monitoring is read here rather than in an effect of its own so that
          // it is one assignment in a loop that is already running, and so a
          // mic that is off can never leave a live monitor behind it.
          monitor.gain.value = monitoringRef.current ? 1 : 0

          const bar = meterRef.current
          if (bar) {
            bar.style.transform = `scaleX(${meterScale(level).toFixed(3)})`
            // An attribute rather than React state: the loop runs sixty times a
            // second and must not render the console on any of them.
            bar.dataset.clip = now < clipUntil ? 'true' : 'false'
          }
        }
        paint()

        // A device pulled out from under an open stream ends its track rather
        // than raising anything, so without this the meter simply stops and the
        // console goes on claiming to be live.
        const track = stream.getAudioTracks()[0]
        track?.addEventListener('ended', () => {
          if (!cancelled) {
            setStatus('failed')
            setError('the microphone went away')
          }
        })

        setStatus('live')
        // Labels are empty until permission has been granted once, so this is
        // the first moment the picker can show real names.
        void refreshDevices()
      } catch (err) {
        if (cancelled) return
        const denied = err instanceof DOMException && err.name === 'NotAllowedError'
        setStatus(denied ? 'denied' : 'failed')
        setError(
          denied
            ? 'the browser is refusing the microphone; allow it in the address bar'
            : 'no microphone answered',
        )
      }
    })()

    return () => {
      cancelled = true
      const rig = rigRef.current
      rigRef.current = null
      // Nothing is being sent down a rig that no longer exists, and a stale
      // `true` here would reopen the gain the instant one was rebuilt.
      setTalking(false)
      if (rig) teardown(rig)
      const bar = meterRef.current
      if (bar) {
        bar.style.transform = 'scaleX(0)'
        bar.dataset.clip = 'false'
      }
    }
  }, [wanted, attempt, deviceId, onSpeakers, refreshDevices])

  /**
   * Opens and closes what the room hears, without touching the capture.
   *
   * Ramped rather than switched, because a gain that steps is a click at both
   * ends of every sentence. Keyed on `status` as well so that a rig rebuilt
   * mid-break — somebody changing input while talking — comes back at the
   * level it was at rather than silently shut.
   */
  useEffect(() => {
    const rig = rigRef.current
    if (!rig) return
    const now = rig.context.currentTime
    const gain = rig.talk.gain
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    gain.linearRampToValueAtTime(talking ? 1 : 0, now + TALK_RAMP_S)
  }, [talking, status])

  const open = useCallback(() => {
    setWanted(true)
    setAttempt((count) => count + 1)
  }, [])
  const close = useCallback(() => {
    setWanted(false)
    setStatus('idle')
    setError(null)
    // Nobody wants to come back to a mic that is quietly playing itself into
    // the room, and this is off by default anyway.
    setMonitoring(false)
  }, [])
  const choose = useCallback((next: string | null) => setDeviceId(next), [])

  /**
   * Saying you are on speakers takes the monitor down with it.
   *
   * The checkbox for hearing yourself is disabled while this is on, but a
   * setting made before the switch was flipped would otherwise survive it, and
   * the survivor is a microphone playing into the speaker it is listening to.
   * The guard belongs here rather than only in the markup: a disabled input is
   * a thing the page draws, not a thing that cannot happen.
   */
  const chooseSpeakers = useCallback((next: boolean) => {
    setOnSpeakers(next)
    if (next) setMonitoring(false)
  }, [])

  return {
    status,
    error,
    devices,
    deviceId,
    onSpeakers,
    monitoring,
    meterRef,
    live: status === 'live',
    talking,
    open,
    close,
    choose,
    setOnSpeakers: chooseSpeakers,
    setMonitoring,
    setTalking,
  }
}
