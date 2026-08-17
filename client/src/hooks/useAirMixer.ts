import { useCallback, useEffect, useRef, useState } from 'react'
import { type AirMixer, airMixer } from '../lib/mixer.js'

/**
 * The console's outbound side, held for as long as the panel is open.
 *
 * A thin wrapper over `lib/mixer.ts`, which is where the graph and all of the
 * reasoning live. What is here is the two things React has to own: when the
 * context gets built, and telling the page that the buses now exist.
 *
 * **Built lazily, on a gesture.** Contexts start suspended and only a user
 * gesture may resume one, so this is not built on mount — a mixer created when
 * the console loaded would be a graph that can never be woken, and every route
 * into `ensure` is a button somebody pressed: opening the microphone, or
 * bringing a listener up.
 *
 * One per console rather than one per microphone, which is the whole point of
 * separating it from `useMicInput`. The rig can be torn down and rebuilt —
 * changing input device does exactly that — without the room's connections
 * noticing, and a guest can be on air through a console whose own microphone
 * was never opened.
 */
export interface AirMixerHandle {
  /**
   * Build the graph if it is not built, and hand it back.
   *
   * Call from inside a click. Null on a browser with no Web Audio at all, which
   * is the same honest failure `stationAudio` takes: worse, and still a station.
   */
  ensure(): AirMixer | null
  /** The mixer, once something has asked for one. Null before that. */
  mixer: AirMixer | null
  /**
   * What every listener is sent, once there is a bus to send.
   *
   * State rather than a getter off the mixer, because this is what decides
   * whether `useVoiceBroadcast` has anything to offer, and a value the effect
   * could not see change would leave the room unconnected until something else
   * happened to re-render the console.
   */
  roomTrack: MediaStreamTrack | null
}

export function useAirMixer(): AirMixerHandle {
  const held = useRef<AirMixer | null>(null)
  const [mixer, setMixer] = useState<AirMixer | null>(null)
  const [roomTrack, setRoomTrack] = useState<MediaStreamTrack | null>(null)

  const ensure = useCallback(() => {
    if (held.current) return held.current
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null

    let built: AirMixer
    try {
      built = airMixer(new Ctor())
    } catch {
      // No context at all. Nothing to recover: the console keeps every control
      // it has except the ones that would have made sound.
      return null
    }
    held.current = built
    setMixer(built)
    // Read once, here, rather than on every render. A destination node has its
    // track from the moment it exists, so there is nothing to wait for and
    // nothing that would change it later.
    //
    // The minus-buses are deliberately not read here alongside it. There is one
    // per voice now and they are built on demand, so there is no fixed set to
    // hold in state — whatever needs one asks `mixer.seatTrack(id)` for it at
    // the moment it knows the id, which is also the moment it has one to ask
    // about. See `airMixer`.
    setRoomTrack(built.roomTrack)
    return built
  }, [])

  // Leaving the console takes the buses with it, which stops the tracks and
  // closes the context. The peer connections are torn down by `useVoice`'s own
  // cleanup; this is the other end of the same departure.
  useEffect(
    () => () => {
      held.current?.close()
      held.current = null
    },
    [],
  )

  return { ensure, mixer, roomTrack }
}
