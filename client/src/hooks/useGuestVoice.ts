import { useCallback, useEffect, useRef, useState } from 'react'
import { type GuestBus, guestBus } from '../lib/mixer.js'
import { CHECK_START, type Check, type CheckStage, nextCheck } from '../lib/sound-check.js'
import { type MicInput, useMicInput } from './useMicInput.js'

/**
 * A listener's end of a call: their microphone, and whether they may use it.
 *
 * The same rig the console runs, pointed at one bus instead of two and started
 * on the other side of the echo-cancellation switch. Two differences from the
 * console, and both are about who a guest is: whoever runs the decks read a
 * warning and set their own machine up, while a guest is whoever put their hand
 * up on whatever they happened to be holding.
 *
 * **Cancellation on by default.** It mangles anything musical and costs voice
 * quality, which is why the console leaves it off — and a guest is not sending
 * music, while a guest on a laptop speaker is a genuine feedback path.
 *
 * **The sound check is a gate.** `ready` is false until it passes, and nothing
 * on the page offers to put somebody up before then. See `lib/sound-check.ts`
 * for what it actually detects, which is not quite what it looks like.
 *
 * Nothing here transmits. The bus exists so that the guest's voice has
 * somewhere to be when there is a connection to carry it, and until then this
 * is a microphone, a meter and a decision.
 */

export interface GuestVoice {
  input: MicInput
  /** Where the check stands. `passed` is the only stage that opens the gate. */
  stage: CheckStage
  /** Whether this guest may take a microphone that has been offered. */
  ready: boolean
  /** Open the microphone and start the check, or start it again. A gesture. */
  begin(): void
  /** Give the microphone back. */
  end(): void
  /** What the console would be sent. Null until there is a rig. */
  track: MediaStreamTrack | null
}

export function useGuestVoice(): GuestVoice {
  const held = useRef<GuestBus | null>(null)
  const [track, setTrack] = useState<MediaStreamTrack | null>(null)
  const [stage, setStage] = useState<CheckStage>('speak')
  // The check itself lives here rather than in state: it is fed sixty times a
  // second, and a render per frame on a page that is also playing a record and
  // running a clock would be the most expensive thing on it. Only the stage —
  // which moves three or four times in a lifetime — reaches React.
  const check = useRef<Check>(CHECK_START)
  // Set while the microphone is deliberately shut, so the loop's last frame
  // cannot restart a check that has just been abandoned.
  const running = useRef(false)

  const ensure = useCallback(() => {
    if (held.current) return held.current
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    try {
      held.current = guestBus(new Ctor())
    } catch {
      return null
    }
    setTrack(held.current.track)
    return held.current
  }, [])

  const onLevel = useCallback((level: number, sinceMs: number) => {
    if (!running.current) return
    const before = check.current.stage
    check.current = nextCheck(check.current, level, sinceMs)
    if (check.current.stage !== before) setStage(check.current.stage)
  }, [])

  const input = useMicInput({ ensure }, { onSpeakers: true, onLevel })

  const begin = useCallback(() => {
    check.current = CHECK_START
    setStage('speak')
    running.current = true
    input.open()
  }, [input])

  const end = useCallback(() => {
    running.current = false
    check.current = CHECK_START
    setStage('speak')
    input.close()
  }, [input])

  // A microphone that went away mid-check — unplugged, or taken by another app
  // — leaves a check that will never move again. Better to be back at the start
  // with a button that says so than to sit at "say something" for ever.
  useEffect(() => {
    if (input.status === 'denied' || input.status === 'failed') {
      running.current = false
      check.current = CHECK_START
      setStage('speak')
    }
  }, [input.status])

  // Leaving the page takes the bus with it. The rig's own teardown stops the
  // capture; this is the context and the track it fed.
  useEffect(
    () => () => {
      held.current?.close()
      held.current = null
    },
    [],
  )

  return {
    input,
    stage,
    ready: stage === 'passed' && input.status === 'live',
    begin,
    end,
    track,
  }
}
