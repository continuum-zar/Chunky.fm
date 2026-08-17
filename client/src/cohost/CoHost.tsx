import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGuestVoice } from '../hooks/useGuestVoice.js'
import { useServerClock } from '../hooks/useServerClock.js'
import { useStation } from '../hooks/useStation.js'
import { useSyncedAudio } from '../hooks/useSyncedAudio.js'
import { useIceServers, useVoiceReceiver } from '../hooks/useVoice.js'
import { type StationAudio, stationAudio } from '../lib/audio-graph.js'
import { CoHostApi, MAX_BLEND_MS, type SeatAction, refusalMessage } from '../lib/cohost.js'
import { INVITE_PARAM, withoutInvite } from '../lib/invite.js'
import { loadNickname, saveNickname } from '../lib/nickname.js'
import { formatClock } from '../lib/position.js'
import type { QueueEntry, ServerMessage, Track } from '../lib/protocol.js'
import { Door } from './Door.js'
import { Queue } from './Queue.js'
import { useSeat } from './useSeat.js'
import { usePushToTalk } from './usePushToTalk.js'

/**
 * The other side of the decks, in one hand.
 *
 * Everything on this page is one of four things, and the layout is that order
 * from the top down because it is the order of how often a thumb reaches for
 * them under pressure:
 *
 *   1. what is on, and how long is left of it
 *   2. **hold to talk** — the one control that is held rather than tapped, and
 *      the reason the page is a page rather than a row in the console
 *   3. the two faders: how loud you go out, how loud the record is in your ear
 *   4. what plays next, and how this record becomes it
 *
 * What is deliberately absent is most of the console. There is no upload, no
 * library management, no way to end the night or mute anybody or seek inside a
 * record — and not because the page declines to draw those buttons. The station
 * refuses them to this credential; see `routes/cohost.ts`. A seat that was one
 * devtools console away from being the decks would not be a seat.
 *
 * It is also a separate bundle from the station, and that is about the device
 * rather than about tidiness. The station's document carries a globe, a
 * gramophone and three.js; the console carries the whole desk. Neither is what
 * you want to hand somebody on a phone who has to press one button in the next
 * four seconds.
 */

/** Where a co-host's monitor level starts: the record, comfortably under you. */
const DEFAULT_MUSIC = 0.7

export function CoHost() {
  const api = useMemo(() => new CoHostApi(), [])

  /**
   * Whether this browser holds a seat at all.
   *
   * Asked once on load, before anything opens a socket, for the reason
   * `/api/listen` is asked first on the station: a page that connected first
   * would spend its life reconnecting into a refusal, and tell somebody the
   * station was down when it is only shut to them.
   */
  const [admitted, setAdmitted] = useState<'checking' | 'in' | 'out'>('checking')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // The key out of the address bar first, if there is one. A secret that
      // stays in the URL is a secret in every screenshot, every "share this
      // tab", every Referer header and every entry in the browser's history —
      // so it is redeemed for a cookie and taken straight back out again.
      const key = new URLSearchParams(window.location.search).get(INVITE_PARAM)
      if (key !== null && key.trim() !== '') {
        try {
          await api.redeem(key.trim())
        } catch {
          // Throttled, or the station said nothing. Either way the check below
          // is the one that decides, and it is about to run.
        }
        const clean = withoutInvite(window.location.href)
        if (clean !== null) window.history.replaceState(null, '', clean)
      }
      try {
        const ok = await api.verify()
        if (!cancelled) setAdmitted(ok ? 'in' : 'out')
      } catch {
        if (!cancelled) setAdmitted('out')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  if (admitted === 'checking') {
    return (
      <main className="seat seat--waiting">
        <p className="seat__note">checking the link…</p>
      </main>
    )
  }

  if (admitted === 'out') {
    return <Door api={api} onIn={() => setAdmitted('in')} />
  }

  return <Desk api={api} />
}

/** The page, once this browser is allowed to be on it. */
function Desk({ api }: { api: CoHostApi }) {
  const [nickname, setNickname] = useState(() => loadNickname() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [music, setMusic] = useState(DEFAULT_MUSIC)
  const [tracks, setTracks] = useState<Track[]>([])

  const audioRef = useRef<HTMLAudioElement>(null)
  const secondRef = useRef<HTMLAudioElement>(null)
  /**
   * The gain stage, built on the gesture that takes the seat.
   *
   * Not before, for the reason the station's is not: routing an element through
   * Web Audio is permanent and total, and a context that has never been resumed
   * is silence rather than quiet music. Sitting down is the click there is to
   * spend on it, and it is the first thing anybody does here.
   */
  const stage = useRef<StationAudio | null>(null)
  useEffect(() => () => stage.current?.close(), [])

  /**
   * Everything on this page that wants to read the socket.
   *
   * One socket, several readers — the clock, the voice — and a set rather than
   * a list of named callbacks so that adding one is a `useEffect` rather than
   * another line in the message handler. Exactly the shape the station's page
   * uses, for the same reason.
   */
  const readers = useRef(new Set<(message: ServerMessage) => void>())
  const routeToClock = useRef<(message: ServerMessage) => void>(() => undefined)

  const station = useStation(undefined, (message) => {
    routeToClock.current(message)
    for (const reader of readers.current) reader(message)
  })
  const {
    state,
    air,
    mic,
    coHost,
    transition,
    queue,
    me,
    connection,
    status,
    applyState,
    applyQueue,
    applyMic,
    applyCoHost,
    applyTransition,
  } = station

  const subscribe = useCallback((reader: (message: ServerMessage) => void) => {
    readers.current.add(reader)
    return () => {
      readers.current.delete(reader)
    }
  }, [])

  const clock = useServerClock(connection, { connected: status === 'connected' })
  // Assigned after commit rather than during render: a render React throws away
  // must not leave a handler wired up behind it. The clock is routed directly
  // rather than through `readers` because it is the one reader that has to see
  // every frame from the moment the socket opens, before anything has
  // subscribed to anything.
  useEffect(() => {
    routeToClock.current = clock.handleMessage
  }, [clock.handleMessage])

  const track = state?.track ?? null
  const live = air?.live ?? false

  /**
   * This co-host's microphone, with the check in front of it.
   *
   * The same rig a call-in guest runs, and for the same reasons: echo
   * cancellation on by default, because this is whatever handset was to hand
   * rather than a machine somebody set up; and the sound check as a gate,
   * because a phone that can hear the station through its own speaker is a
   * feedback loop the room pays for. See `lib/sound-check.ts`.
   */
  const voice = useGuestVoice()

  const seat = useSeat({
    api,
    me,
    nickname: nickname.trim() || 'co-host',
    broadcast: coHost,
    onSnapshot: applyCoHost,
  })

  const iceServers = useIceServers(seat.mine)

  /**
   * The downlink and the uplink, on one hook.
   *
   * A co-host is a listener with a microphone, which is exactly the shape this
   * already had for a call-in guest: it answers whatever the console offers,
   * and `talkTrack` is what turns the second offer into a voice going the other
   * way. What arrives on the downlink is the room bus *minus this co-host* —
   * see `airMixer.seatTrack` — so they hear the decks, and the caller if there
   * is one, and never themselves.
   */
  const link = useVoiceReceiver({
    connection,
    me,
    // Only once seated. Before that there is no gain stage to play a voice
    // through and nothing this page should be answering.
    active: seat.mine && live,
    iceServers,
    onStream: useCallback((stream: MediaStream | null) => stage.current?.play(stream), []),
    talkTrack: seat.mine ? voice.track : null,
  })
  useEffect(() => subscribe(link.handleMessage), [subscribe, link.handleMessage])

  const talk = usePushToTalk({
    api,
    input: voice.input,
    // Everything that has to be true before a voice can go out, in one place:
    // in the seat, on air, and a microphone that passed its check.
    allowed: seat.mine && live && voice.ready,
    onMic: applyMic,
  })

  useSyncedAudio({
    audioRef,
    secondRef,
    stage: stage.current,
    state,
    // The seat is the join: nothing here makes a sound before somebody has sat
    // down, because until then there is no woken context to make it through.
    joined: seat.mine,
    serverNow: clock.serverNow,
    synced: clock.synced,
  })

  // The station's duck, applied to the copy of the record this phone is
  // playing, exactly as every listener applies it. A co-host hears the room
  // duck for their own voice, which is the only honest monitor there is.
  useEffect(() => {
    stage.current?.duck(mic?.live ? mic.duckTo : 1)
  }, [mic?.live, mic?.duckTo])

  // And this co-host's own level on top of it. Two faders on the music rather
  // than one: the station decides how far it sits under a voice, and this
  // decides how loud it is in this particular ear. See `StationAudio.music`.
  useEffect(() => {
    stage.current?.music(music)
  }, [music])

  /*
   * Deliberately no `useMediaSession` here, unlike the station.
   *
   * On the listener's page the lock-screen buttons are that listener's own ears
   * and nothing else — pause means "I have stopped listening". On this page the
   * nearest thing to a pause button stops the record for *everybody*, and there
   * is no version of putting that under a headphone pinch that ends well. A
   * lock screen that showed a play button doing nothing would be worse again:
   * the one thing a control surface must never do is draw a control that lies.
   */

  useEffect(() => {
    void (async () => {
      try {
        setTracks(await api.tracks())
      } catch {
        // The library is what the queue is filled from, and an empty one is a
        // page that can still talk and still move the current record along.
        // Worth a line rather than a screen.
        setError('could not load the library')
      }
    })()
  }, [api])

  /** Everything that touches the station, with one place for what went wrong. */
  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(refusalMessage(err) ?? 'the station did not answer')
    } finally {
      setBusy(false)
    }
  }, [])

  const command = useCallback(
    (action: SeatAction) => void run(async () => applyState(await api.command(action))),
    [api, applyState, run],
  )

  function sitDown(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const stored = saveNickname(nickname)
    if (stored === null) return
    setNickname(stored)

    // Inside the gesture, and before anything else: this is the moment the
    // browser will let a context be resumed, and after it the music reaches the
    // speakers only through the graph.
    const audio = audioRef.current
    if (audio) {
      stage.current = stationAudio(audio, secondRef.current)
      stage.current.music(music)
      stage.current.duck(mic?.live ? mic.duckTo : 1)
    }
    // And the microphone, on the same gesture. Asking for it later would mean a
    // permission prompt arriving in the middle of a set.
    voice.begin()
    seat.take()
  }

  const paused = state?.pausedAt !== null && Boolean(track)
  const position = track
    ? Math.min(track.durationMs, Math.max(0, (state?.pausedAt ?? clock.serverNow() - (state?.startedAt ?? 0))))
    : 0
  const left = track ? Math.max(0, track.durationMs - position) : 0

  /*
   * The decks, rendered whether or not anybody is sitting at them.
   *
   * They have to exist *before* the click that takes the seat, and that is not
   * a detail: `stationAudio` routes these elements through Web Audio, and it
   * has to happen inside a gesture because a context that has never been
   * resumed is silence rather than quiet music. Render them only once seated
   * and the gesture has nothing to route — which is a page that takes the seat,
   * says it is on air, and plays nothing at all, with no error anywhere.
   *
   * Owned imperatively either way: React never sets currentTime or calls
   * play(). Two of them because a transition is two records at once; see
   * `lib/decking.ts`.
   */
  const decks = (
    <>
      <audio ref={audioRef} preload="auto" />
      <audio ref={secondRef} preload="auto" />
    </>
  )

  if (!seat.mine) {
    return (
      <>
        <SitDown
          nickname={nickname}
          onNickname={setNickname}
          onSubmit={sitDown}
          seat={seat}
          live={live}
          status={status}
          check={voice.stage}
        />
        {decks}
      </>
    )
  }

  return (
    <main className="seat" data-testid="cohost-desk">
      <header className="seat__now">
        <div className="seat__now-line">
          <span className={`seat__lamp${live ? ' seat__lamp--live' : ''}`} aria-hidden="true" />
          <span className="seat__now-title" data-testid="cohost-now">
            {track ? track.title : live ? 'nothing on the decks' : 'off air'}
          </span>
        </div>
        {track && (
          <p className="seat__now-artist">
            {track.artist ?? 'unknown'}
            {/* Time *left*, not time elapsed. On this page the only question
                anybody asks of a clock is how long until you have to do
                something, and the answer to it should not need arithmetic. */}
            <em data-testid="cohost-left">−{formatClock(left / 1000)}</em>
          </p>
        )}
        <div className="seat__progress" role="presentation">
          <span
            className="seat__progress-fill"
            style={{ width: track ? `${(position / track.durationMs) * 100}%` : '0%' }}
          />
        </div>
      </header>

      {error && (
        <p className="seat__error" data-testid="cohost-error" role="status">
          {error}
        </p>
      )}

      {/* The one control here that is held rather than tapped, and the biggest
          thing on the page by a wide margin. `touch-action: none` and the
          pointer events rather than a click: a click fires on release, which
          would be a talk button that starts talking when you stop. */}
      <button
        type="button"
        className={`ptt${talk.talking ? ' ptt--live' : ''}`}
        data-testid="cohost-talk"
        disabled={!live || !voice.ready}
        aria-pressed={talk.talking}
        onPointerDown={talk.press}
        onPointerUp={talk.release}
        onPointerCancel={talk.release}
        onPointerLeave={talk.release}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="ptt__label">{talk.talking ? 'ON AIR' : 'HOLD TO TALK'}</span>
        <span className="ptt__meter" role="presentation">
          <span className="ptt__meter-fill" ref={voice.input.meterRef} data-clip="false" />
        </span>
      </button>

      <p className="seat__hint" data-testid="cohost-voice-state">
        {!live
          ? 'The station is off air.'
          : !voice.ready
            ? 'Put headphones on — the check needs to hear you without hearing the station.'
            : link.talking === 'connected'
              ? 'The decks can hear you.'
              : link.talking === null
                ? 'Waiting for the decks to open a line.'
                : `Connecting your microphone (${link.talking}).`}
      </p>

      <section className="faders">
        <Fader
          label="Your voice"
          testId="cohost-mic-level"
          value={voice.input.level}
          onChange={voice.input.setLevel}
        />
        <Fader
          label="Music in your ear"
          testId="cohost-music-level"
          value={music}
          onChange={setMusic}
          // Local, and said so: this is the one fader on the page that changes
          // nothing for anybody else, and a co-host who thought it was the
          // room's would spend the evening mixing for an audience of one.
          note="yours only"
        />
      </section>

      <section className="transport" aria-label="The record that is on">
        <button
          type="button"
          className="transport__button"
          data-testid="cohost-playpause"
          disabled={busy || !track}
          onClick={() => command(paused ? 'resume' : 'pause')}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        {/* The transition, and the reason this page exists as much as the talk
            button is. `blend` rather than `skip`: it takes the next record
            *over* this one across the crossfade, which is the thing a person
            standing at the decks is actually doing. Skip is beside it and is a
            different intent — this record is over — so it cuts. */}
        <button
          type="button"
          className="transport__button transport__button--blend"
          data-testid="cohost-blend"
          disabled={busy || !track || (queue?.length ?? 0) === 0}
          onClick={() => command('blend')}
        >
          Take it over
        </button>
        <button
          type="button"
          className="transport__button"
          data-testid="cohost-skip"
          disabled={busy || !track}
          onClick={() => command('skip')}
        >
          Cut
        </button>
      </section>

      <Blend
        blendMs={transition?.blendMs ?? 0}
        disabled={busy}
        onChange={(blendMs) => void run(async () => applyTransition(await api.transition(blendMs)))}
      />

      <Queue
        entries={queue ?? []}
        tracks={tracks}
        busy={busy}
        onAdd={(trackId) =>
          void run(async () => applyQueue((await api.enqueue(trackId)).entries))
        }
        onRemove={(entryId) =>
          void run(async () => applyQueue((await api.remove(entryId)).entries))
        }
        onMove={(entryId, toIndex) =>
          void run(async () => applyQueue((await api.move(entryId, toIndex)).entries))
        }
      />

      <footer className="seat__foot">
        <span className="seat__foot-who">
          co-hosting as {coHost?.seat?.nickname ?? nickname}
        </span>
        <button
          type="button"
          className="seat__stand"
          data-testid="cohost-stand"
          onClick={() => {
            voice.end()
            seat.leave()
          }}
        >
          Stand down
        </button>
      </footer>

      {decks}
    </main>
  )
}

/** Naming yourself and sitting down, which are one gesture. */
function SitDown({
  nickname,
  onNickname,
  onSubmit,
  seat,
  live,
  status,
  check,
}: {
  nickname: string
  onNickname(value: string): void
  onSubmit(event: FormEvent<HTMLFormElement>): void
  seat: ReturnType<typeof useSeat>
  live: boolean
  status: string
  check: string
}) {
  return (
    <main className="seat seat--sitdown">
      <h1 className="seat__title">Co-host</h1>
      <p className="seat__blurb">
        You can talk over the record, line up what plays next, and take the
        transitions. You cannot end the night or change the library — that stays
        at the decks.
      </p>

      <form className="seat__form" onSubmit={onSubmit}>
        <label className="seat__field">
          <span>What the room should call you</span>
          <input
            type="text"
            data-testid="cohost-nickname"
            value={nickname}
            onChange={(event) => onNickname(event.target.value)}
            placeholder="thabo"
            maxLength={24}
            autoComplete="nickname"
          />
        </label>
        <button
          type="submit"
          className="seat__sit"
          data-testid="cohost-sit"
          disabled={nickname.trim() === '' || seat.status === 'moving'}
        >
          {seat.status === 'moving' ? 'Sitting down…' : 'Take the seat'}
        </button>
      </form>

      {/* Said before the button is pressed rather than after it is refused: a
          co-host who arrives at ten to nine should be told the doors are not
          open yet, not told it as an error. */}
      {!live && (
        <p className="seat__note" data-testid="cohost-offair">
          The station is not on air yet. Whoever runs the decks opens the doors.
        </p>
      )}
      {seat.snapshot?.seat && !seat.mine && (
        <p className="seat__note">{seat.snapshot.seat.nickname} is co-hosting right now.</p>
      )}
      {seat.error && (
        <p className="seat__error" data-testid="cohost-seat-error" role="status">
          {seat.error}
        </p>
      )}
      {status !== 'open' && <p className="seat__note">reconnecting to the station…</p>}
      {check !== 'speak' && <p className="seat__note">sound check: {check}</p>}

      <p className="seat__small">
        Headphones. The check will refuse a phone that can hear the station
        through its own speaker, because that is a feedback loop the whole room
        pays for.
      </p>
    </main>
  )
}

/** One fader, drawn big enough for a thumb. */
function Fader({
  label,
  testId,
  value,
  onChange,
  note,
}: {
  label: string
  testId: string
  value: number
  onChange(value: number): void
  note?: string
}) {
  return (
    <label className="fader">
      <span className="fader__label">
        {label}
        <em>
          {Math.round(value * 100)}%{note ? ` · ${note}` : ''}
        </em>
      </span>
      <input
        type="range"
        data-testid={testId}
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
    </label>
  )
}

/**
 * How long one record overlaps the next.
 *
 * Held locally while it is being dragged and sent on release, the way the
 * console's duck is: a fader that only moved when the round trip landed would
 * feel broken under a thumb, and a request per pixel would be a request per
 * pixel.
 */
function Blend({
  blendMs,
  disabled,
  onChange,
}: {
  blendMs: number
  disabled: boolean
  onChange(blendMs: number): void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? blendMs
  const commit = () => {
    if (draft !== null) onChange(draft)
    setDraft(null)
  }

  return (
    <label className="fader fader--blend">
      <span className="fader__label">
        Crossfade
        <em data-testid="cohost-blend-length">
          {shown === 0 ? 'straight cut' : `${(shown / 1000).toFixed(1)}s`}
        </em>
      </span>
      <input
        type="range"
        data-testid="cohost-blend-slider"
        min={0}
        max={MAX_BLEND_MS}
        step={250}
        value={shown}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  )
}

export type { QueueEntry }
