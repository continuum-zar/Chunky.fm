import { useCallback, useEffect, useRef, useState } from 'react'
import { type CoHostApi, SEAT_HANGOVER_MS } from '../lib/cohost.js'
import { MIC_RENEW_MS } from '../lib/admin.js'
import type { MicInput } from '../hooks/useMicInput.js'
import type { MicSnapshot } from '../lib/protocol.js'

/**
 * Hold to talk, on a phone.
 *
 * Two things happen when the button goes down and they are completely
 * independent, which is the whole reason this is a hook rather than an
 * `onPointerDown`:
 *
 * **The gain opens**, locally and instantly, and that is what the room actually
 * hears — the voice goes peer-to-peer, past the station entirely. **The mic
 * frame goes to the station**, over HTTP, and that is what makes thirty
 * browsers turn their own music down. The first works whether or not the second
 * does. The second works whether or not the voice connection ever established.
 * Neither waits for the other, and a co-host on a bad connection gets whichever
 * of the two is working rather than nothing.
 *
 * The hangover is the part that is specific to a thumb. Releasing a key is
 * precise; releasing a screen is not — a thumb slides, and lifts early over a
 * bump — so the mic stays open a little after the button comes up. Without it
 * the music swells back between words, which sounds like the station fighting
 * you, and the last syllable of every sentence is the thing that gets eaten.
 *
 * What this deliberately does *not* do is shut the mic on release. It sends
 * `close`, and the station reads that as *this person has stopped talking*
 * rather than *shut the mic* — so the room stays ducked if whoever runs the
 * decks is still mid-sentence. See `MicHolder` on the server.
 */

export interface PushToTalk {
  /** Whether this co-host's voice is reaching the room right now. */
  talking: boolean
  /** Bind to the button: pointer down, up, cancel and leave. */
  press(): void
  release(): void
}

export interface PushToTalkOptions {
  api: CoHostApi
  /** The rig, whose gain is what the room actually hears. */
  input: MicInput
  /** Whether talking is possible at all: seated, on air, mic open. */
  allowed: boolean
  /** Fold the station's answer in without waiting for the broadcast. */
  onMic(snapshot: MicSnapshot): void
  hangoverMs?: number
  renewMs?: number
}

export function usePushToTalk({
  api,
  input,
  allowed,
  onMic,
  hangoverMs = SEAT_HANGOVER_MS,
  renewMs = MIC_RENEW_MS,
}: PushToTalkOptions): PushToTalk {
  const [held, setHeld] = useState(false)
  /**
   * Whether the station is being told the mic is open.
   *
   * Distinct from `held` because of the hangover: for a few hundred
   * milliseconds after the button comes up, the button is not held and the mic
   * is still open. Folding the two together would either lose the hangover or
   * leave the local gain open through it.
   */
  const [open, setOpen] = useState(false)
  const hangover = useRef<number | null>(null)
  // Read inside the timers rather than closed over, so a re-render does not
  // restart the keep-alive and the hangover survives one.
  const bag = useRef({ api, input, onMic })
  bag.current = { api, input, onMic }

  const press = useCallback(() => {
    if (!allowed) return
    if (hangover.current !== null) {
      window.clearTimeout(hangover.current)
      hangover.current = null
    }
    setHeld(true)
    setOpen(true)
    // Local first, and not awaited: this is what the room hears, and it should
    // not wait on a round trip to a station that is not carrying the audio.
    bag.current.input.setTalking(true)
    void bag.current.api
      .mic('open')
      .then((snapshot) => bag.current.onMic(snapshot))
      .catch(() => undefined)
  }, [allowed])

  const release = useCallback(() => {
    setHeld(false)
    // The gain shuts with the button rather than with the hangover, and the two
    // are different on purpose: the hangover is for the *music*, so it does not
    // swell back between words, and holding the microphone open through it
    // would broadcast whatever was said in the room after you stopped.
    bag.current.input.setTalking(false)
    if (hangover.current !== null) window.clearTimeout(hangover.current)
    hangover.current = window.setTimeout(() => {
      hangover.current = null
      setOpen(false)
      void bag.current.api
        .mic('close')
        .then((snapshot) => bag.current.onMic(snapshot))
        .catch(() => undefined)
    }, hangoverMs)
  }, [hangoverMs])

  // Beating while the mic is open, against the station's lease. Without it a
  // long sentence would be cut off in the middle by a lease nobody renewed.
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => {
      void bag.current.api.mic('renew').catch(() => undefined)
    }, renewMs)
    return () => window.clearInterval(timer)
  }, [open, renewMs])

  /**
   * Anything that takes the seat away takes the mic with it.
   *
   * The commonest of them is not a button: it is the page being backgrounded
   * with a thumb still on the button — a call arriving, the screen locking —
   * where no pointer event is ever delivered and the release never happens. A
   * microphone that stayed open through that is a phone in somebody's pocket
   * broadcasting to a room.
   */
  useEffect(() => {
    if (allowed) return
    setHeld(false)
    setOpen(false)
    bag.current.input.setTalking(false)
  }, [allowed])

  useEffect(() => {
    const stop = () => {
      if (document.visibilityState === 'hidden') release()
    }
    document.addEventListener('visibilitychange', stop)
    return () => document.removeEventListener('visibilitychange', stop)
  }, [release])

  useEffect(
    () => () => {
      if (hangover.current !== null) window.clearTimeout(hangover.current)
    },
    [],
  )

  return { talking: held, press, release }
}
