import { type RefObject, useEffect, useRef } from 'react'
import type { StationAudio } from '../lib/audio-graph.js'
import { seekTo, setSource } from '../lib/audio-element.js'
import {
  type Decking,
  NO_DECKS,
  deckingFor,
  fadingNow,
  outgoingPositionSeconds,
} from '../lib/decking.js'
import {
  type Correction,
  DEFAULT_DRIFT_CHECK_INTERVAL_MS,
  applyCorrection,
  correctionFor,
} from '../lib/drift.js'
import { expectedPositionSeconds } from '../lib/position.js'
import type { StateMessage } from '../lib/protocol.js'
import { otherDeck } from '../lib/audio-graph.js'

export interface SyncedAudioOptions {
  audioRef: RefObject<HTMLAudioElement | null>
  /**
   * The other deck, for the record on its way out during a crossfade.
   *
   * Optional, and a page that leaves it out gets a station that cuts between
   * records. That is the honest degradation rather than a broken one: the
   * incoming track still starts at the instant the station says, on the clock
   * everybody shares, so a one-deck listener is in time with a two-deck one at
   * the end of every transition. They just hear the join.
   */
  secondRef?: RefObject<HTMLAudioElement | null>
  /**
   * The gain stage, for the fade. Null until the listener has spent a gesture
   * on building it, which is also before anything is allowed to make noise.
   */
  stage?: StationAudio | null
  state: StateMessage | null
  /** Nothing is allowed to make noise until the listener has tuned in. */
  joined: boolean
  serverNow: () => number
  /** Until the clock handshake lands, aligning would align to the wrong time. */
  synced: boolean
  driftIntervalMs?: number
  onCorrection?: (correction: Correction, diffSeconds: number) => void
}

/**
 * Keeps the audio elements on the station's clock, and runs the transitions.
 *
 * Three loops now.
 *
 * The first realigns whenever the server broadcasts a change: a new track, a
 * pause, a seek — and, since transitions, a *second* record arriving alongside
 * the first. That is where the deck assignment happens; see `lib/decking.ts`,
 * which owns the rule that a record already playing is never moved.
 *
 * The second runs continuously, because being aligned once is not the same as
 * staying aligned: audio clocks drift from system clocks. It corrects both
 * decks, since a record fading out that has drifted half a second is a
 * transition landing in the wrong place.
 *
 * The third is the fade itself, redrawn every time the state changes or the
 * clock estimate improves. It is scheduled against the audio context's own
 * clock rather than being animated, so a busy main thread cannot stutter a
 * transition — the ramps are already in the graph before the fade begins.
 */
export function useSyncedAudio({
  audioRef,
  secondRef,
  stage = null,
  state,
  joined,
  serverNow,
  synced,
  driftIntervalMs = DEFAULT_DRIFT_CHECK_INTERVAL_MS,
  onCorrection,
}: SyncedAudioOptions): void {
  // Read through refs in the loops below so neither is torn down and restarted
  // on every render. The drift interval should be genuinely continuous, and
  // realignment should happen only when the station actually says something.
  const stateRef = useRef(state)
  const serverNowRef = useRef(serverNow)
  const onCorrectionRef = useRef(onCorrection)
  /**
   * Which record is on which deck.
   *
   * A ref rather than state, and not as an optimisation: this is derived from
   * the state frame the effect below is already reacting to, so putting it in
   * state would mean a render whose only job is to schedule the render that
   * does the work — and, worse, a frame in which the elements and this
   * disagree about what they are playing.
   */
  const decksRef = useRef<Decking>(NO_DECKS)
  useEffect(() => {
    stateRef.current = state
    serverNowRef.current = serverNow
    onCorrectionRef.current = onCorrection
  })

  useEffect(() => {
    const front = audioRef.current
    if (!front || !state) return

    const now = serverNowRef.current()
    const previous = decksRef.current
    const decks = deckingFor(previous, state, now)
    decksRef.current = decks

    // Deck A is `audioRef` and deck B is `secondRef`, always, and this mapping
    // must never rotate. It is the graph's mapping too — `stationAudio` plugs
    // the first element into deck A's fader and the second into deck B's — so a
    // client-side map that swapped them would put the incoming record on the
    // fader that is going *down* and the outgoing one on the fader coming up.
    //
    // What alternates is which of the two is the *front*, and that is
    // `decks.front`. Confusing the two is the same bug twice over: the fade
    // runs backwards, and the record that was already playing gets reloaded at
    // the exact moment nothing may stutter. See `lib/decking.ts`.
    const elements: Record<Decking['front'], HTMLAudioElement | null> = {
      a: front,
      b: secondRef?.current ?? null,
    }
    const back = elements[otherDeck(decks.front)]

    const track = state.track
    const frontElement = elements[decks.front]
    // Nothing to do on a page whose second deck has not mounted, which is what
    // a one-deck station is: `decks.front` is always 'a' there, because nothing
    // ever fades.
    if (!frontElement) return
    const changed = setSource(frontElement, decks.urls[decks.front])
    if (back) setSource(back, decks.urls[otherDeck(decks.front)])

    if (!track || !joined || !synced) return

    // The clock is read through the ref on purpose. serverNow's identity
    // changes every time the offset estimate improves, and keying this effect
    // on it would hard-seek the elements mid-song, exactly the audible glitch
    // the rate nudge exists to avoid. Offset refinements are the drift loop's
    // job, and it corrects them gently.
    //
    // Seeked only when the source actually moved, or when the record is not
    // where it should be by more than the drift loop would ever let it get. A
    // `state` re-broadcast during a transition would otherwise seek the record
    // that is already playing correctly, in the middle of the fade.
    const expected = expectedPositionSeconds(state, now)
    if (changed || Math.abs(frontElement.currentTime - expected) > 1) {
      seekTo(frontElement, expected)
    }
    frontElement.playbackRate = 1

    if (state.pausedAt === null) {
      // Rejected when the browser hasn't seen a gesture yet; the join button
      // is that gesture, so by here it normally succeeds.
      void frontElement.play().catch(() => undefined)
    } else {
      frontElement.pause()
    }

    // And the record on its way out, which is already playing and already in
    // the right place unless this page has just arrived in the middle of a
    // transition — a listener who joined four seconds before the end of a song.
    // For them this is the whole of the second deck being set up.
    const outgoing = fadingNow(state, now)
    if (outgoing && back) {
      const where = outgoingPositionSeconds(outgoing, now)
      // Seeked only when it is genuinely in the wrong place — which, in the
      // ordinary case, it never is: this deck has been playing this record for
      // four minutes and the transition did not move it. The one caller that
      // needs a seek here is a listener who *arrived* mid-fade.
      if (Math.abs(back.currentTime - where) > 1) seekTo(back, where)
      back.playbackRate = 1
      void back.play().catch(() => undefined)
    } else if (back) {
      back.pause()
    }
  }, [audioRef, secondRef, state, joined, synced])

  /**
   * The fade, scheduled rather than animated.
   *
   * Redrawn on every state change and every improvement to the clock estimate,
   * which is what `serverNow` changing identity means. That is safe and
   * deliberate: `blend` draws only the part of the window that is left, from
   * where the curve says the gain should be, so redrawing mid-fade corrects a
   * transition rather than restarting it.
   */
  useEffect(() => {
    if (!stage || !state || !joined || !synced) return

    const now = serverNow()
    const outgoing = fadingNow(state, now)
    const decks = decksRef.current

    if (!outgoing || !secondRef?.current) {
      stage.only(decks.front)
      return
    }

    stage.blend({
      incoming: decks.front,
      // Seconds from now, because the audio context has its own clock and no
      // idea what a server epoch is. This is the one place that holds both.
      startsIn: (state.startedAt - now) / 1000,
      endsIn: (outgoing.endsAt - now) / 1000,
    })

    // And stop the outgoing element when its window closes. Without this a
    // record cut short by a manual transition goes on playing at silence for
    // however long it had left, holding a buffer and a decoder for nothing.
    //
    // The element is captured now rather than looked up when the timer fires:
    // by then the decking may have moved on, and the deck that *was* the back
    // one could be the record currently playing.
    const back = decks.front === 'a' ? secondRef.current : audioRef.current
    const stop = window.setTimeout(() => back?.pause(), Math.max(0, outgoing.endsAt - now))
    return () => window.clearTimeout(stop)
  }, [stage, state, joined, synced, serverNow, secondRef])

  useEffect(() => {
    if (!joined || !synced) return

    const timer = window.setInterval(() => {
      const current = stateRef.current
      if (!current?.track) return
      const now = serverNowRef.current()

      // **Which element holds which record, not which ref is which.** The pair
      // alternates every transition, so `audioRef` is deck A rather than "the
      // record that is on" — and a loop that assumed otherwise would spend the
      // whole of a crossfade dragging each record to the other one's position,
      // in seeks, because they are several seconds apart. Which is a transition
      // that stutters twice and lands in the wrong place, on every listener.
      const decks = decksRef.current
      const elements: Record<Decking['front'], HTMLAudioElement | null> = {
        a: audioRef.current,
        b: secondRef?.current ?? null,
      }
      const front = elements[decks.front]
      const back = elements[otherDeck(decks.front)]

      // Nothing to correct against while paused or off air.
      if (front && current.pausedAt === null && !front.paused) {
        const expected = expectedPositionSeconds(current, now)
        const correction = correctionFor(front.currentTime, expected)
        applyCorrection(front, correction)
        onCorrectionRef.current?.(correction, front.currentTime - expected)
      }

      // The record on its way out gets the same treatment and reports nothing.
      // It is corrected because a transition between two records that disagree
      // about the time is a transition landing in the wrong place; it is not
      // reported because the sync readout is about *the station's clock*, and
      // two numbers for one listener would be one number too many.
      const outgoing = fadingNow(current, now)
      if (back && outgoing && !back.paused) {
        applyCorrection(
          back,
          correctionFor(back.currentTime, outgoingPositionSeconds(outgoing, now)),
        )
      }
    }, driftIntervalMs)

    return () => window.clearInterval(timer)
  }, [audioRef, secondRef, joined, synced, driftIntervalMs])
}

