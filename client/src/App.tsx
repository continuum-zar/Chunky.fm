import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AdminPanel } from './AdminPanel.js'
import { Lyrics } from './Lyrics.js'
import { Sidebar } from './Sidebar.js'
import { Topbar } from './Topbar.js'
import { Deck, Mute, OnAir, Waveform } from './Turntable.js'
import { type AdminSession, useAdminSession } from './hooks/useAdminSession.js'
import { useNarrow } from './hooks/useNarrow.js'
import { type Access, useStationAccess } from './hooks/useStationAccess.js'
import { useMediaSession } from './hooks/useMediaSession.js'
import { usePresence } from './hooks/usePresence.js'
import { useServerClock } from './hooks/useServerClock.js'
import { type SyncTrails, useSyncTrails } from './hooks/useSyncTrails.js'
import { useStation } from './hooks/useStation.js'
import { useSyncedAudio } from './hooks/useSyncedAudio.js'
import { useIceServers, useVoiceReceiver } from './hooks/useVoice.js'
import { seekTo } from './lib/audio-element.js'
import { type StationAudio, stationAudio } from './lib/audio-graph.js'
import {
  type Availability,
  type Standing,
  canTuneIn,
  outage,
  staleNotice,
  standing,
} from './lib/availability.js'
import {
  chatRefusal,
  draftAfterRefusal,
  formatTime,
  isSendableMessage,
  MESSAGE_MAX_LENGTH,
  normalizeMessageText,
} from './lib/chat.js'
import type { Correction } from './lib/drift.js'
import { playedEarlier, playedLabel } from './lib/history.js'
import {
  isValidNickname,
  loadNickname,
  NICKNAME_MAX_LENGTH,
  saveNickname,
} from './lib/nickname.js'
import { expectedPositionSeconds } from './lib/position.js'
import { isUpcoming, nextSessionLabel, nextSessionShort } from './lib/schedule.js'
import {
  artworkUrl,
  posterUrl,
  type ChatMessage,
  type Listener,
  type Play,
  type ScheduledSession,
  type Track,
  type ServerMessage,
  type SocketRefusal,
  type Wish,
  refusalAbout,
} from './lib/protocol.js'
import { DEFAULT_ROUTE, type Route, isConsole, needsJoin, routeFrom } from './lib/routes.js'
import { TRAIL_WINDOW_MS, chart, nearest } from './lib/trail.js'
import type { StationConnection } from './lib/station.js'
import {
  isSendableWish,
  normalizeWishText,
  WISH_MAX_LENGTH,
  wishRefusal,
  wishStatusLabel,
} from './lib/wishes.js'

/**
 * The door, and then the station.
 *
 * Split in two so that nothing below opens a socket, starts a clock or asks for
 * a roster until the station has said this browser may hear it. On an open
 * station (the default, and what PLAN.md describes) that answer is yes and
 * this costs one request; on a private one it is the difference between a page
 * that explains itself and a page that reconnects forever.
 */
export function App() {
  const route = useRoute()
  const session = useAdminSession()
  const { access, submit, error: codeError, submitting } = useStationAccess()

  const admitted =
    // The console is never behind the invite gate. It is how whoever runs the
    // station gets in, and needing an invite to reach the sign-in form would
    // lock the owner out of their own station, there being no way to issue
    // themselves one. Nothing is given away by rendering it: every route it
    // calls is gated on the server, and the gate is the password.
    isConsole(route) ||
    // And once signed in, admitted everywhere else too. The station already
    // agrees, since admin credentials satisfy the listener gate, but this browser
    // asked before it had any, and the answer it got is now out of date.
    session.status === 'signed-in' ||
    access === 'admitted' ||
    // A station that has not answered has refused nothing. The offline screen
    // is what that case is for: it keeps retrying and tunes in by itself, and
    // the probe keeps asking, so a private station still gets to say so.
    access === 'unreachable'

  if (!admitted) {
    return (
      <Doorway access={access} onSubmit={submit} error={codeError} submitting={submitting} />
    )
  }
  return <Station route={route} session={session} />
}

/**
 * What stands in for the whole page while the station decides, or instead of it
 * when the answer is no.
 *
 * Deliberately not the outage screen: an outage is the station being gone and
 * fixing itself, and neither is true here. Somebody without an invite needs to
 * know there is nothing wrong and nothing to wait for: the only thing that
 * helps is a link from whoever runs it.
 */
function Doorway({
  access,
  onSubmit,
  error,
  submitting,
}: {
  access: Access
  onSubmit(code: string): Promise<void>
  error: string | null
  submitting: boolean
}) {
  const [code, setCode] = useState('')

  return (
    <div className="doorway">
      <h1 className="wordmark">
        chunky<span className="wordmark__tld">.fm</span>
      </h1>
      {access === 'refused' ? (
        <>
          <div className="outage" data-testid="not-invited" role="status">
            <p className="outage__headline">This station is private.</p>
            <p className="outage__detail">
              If somebody gave you the door code, put it in. Otherwise you need a link from whoever
              runs it, and if you had one that worked before, it has been replaced.
            </p>
          </div>

          {/* The door, for a code somebody was told rather than sent.

              It goes through the same endpoint the `?k=` on a link does, because
              it is the same secret: a code said over the phone and a code pasted
              into an address bar differ only in how they arrived. Typing it has
              one advantage over the link, which is that it never enters the
              address bar, so there is nothing to strip out of the history
              afterwards. */}
          <form
            className="gate__form"
            onSubmit={(event) => {
              event.preventDefault()
              void onSubmit(code)
            }}
          >
            <input
              type="password"
              className="gate__input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="door code"
              aria-label="Station door code"
              data-testid="door-code"
              autoComplete="current-password"
              autoFocus
            />
            <button type="submit" className="button" disabled={submitting || !code.trim()}>
              {submitting ? 'Knocking…' : 'Come in'}
            </button>
          </form>
          {error && (
            <p className="console__error" data-testid="door-error" role="alert">
              {error}
            </p>
          )}
          {/* The one screen where somebody is standing outside wondering what
              they have been sent, so it is the one screen that says. Outside
              the status region rather than in it: what is being reported is
              that the door is shut, and a link is not part of that report.

              Only here. Somebody on the unreachable screen has an invite that
              works and a station that is away. They know what this is, and
              they are waiting rather than asking. */}
          <a className="button button--quiet" href="/">
            What chunky.fm is
          </a>
        </>
      ) : access === 'unreachable' ? (
        <div className="outage" data-testid="doorway-unreachable" role="status">
          <p className="outage__headline">Nothing is answering.</p>
          <p className="outage__detail">
            That is the station being away rather than being shut to you. Leave the page open and
            reload when it is back.
          </p>
        </div>
      ) : (
        <p className="off-air__detail">knocking…</p>
      )}
    </div>
  )
}

function Station({ route: requested, session }: { route: Route; session: AdminSession }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  // A phone, where the landing view is the deck alone. See useNarrow.
  const narrow = useNarrow()
  const [joined, setJoined] = useState(false)
  // Read once, at mount: what a previous visit left behind is the starting
  // point for the field, not a decision to join. The gesture still has to
  // happen (a browser will not start audio because localStorage had a name in
  // it), so a returning listener finds the field filled and presses the button.
  const [nickname, setNickname] = useState(() => loadNickname() ?? '')

  // The clock needs to see pongs but the station owns the socket, so the
  // handler goes through a ref to break what would otherwise be a cycle. The
  // voice reads the same socket for the same reason: a signalling frame is
  // just another thing arriving on it.
  const routeToClock = useRef<(message: ServerMessage) => void>(() => undefined)
  /**
   * Everything else that wants to read the socket.
   *
   * A set rather than a second ref, because there are now two ends of the voice
   * and this page can be both of them at once: the console is usually tuned in
   * as well, so a signalling frame may be for the microphone it is sending or
   * for the voice it is hearing. The socket has one handler, so the fan-out has
   * to happen somewhere, and here is the only place that can see both.
   */
  /**
   * Bumped to throw the socket away and open a new one.
   *
   * There is exactly one reason to. A socket presents its cookies once, on the
   * upgrade, and the console's socket opens when the page loads — which is
   * before anybody has signed in. So signing in leaves a connection the station
   * does not recognise as the decks, on a page where everything else works,
   * because every command goes over HTTP and HTTP does carry the cookie. The
   * only thing that breaks is offering a listener a voice, and it breaks
   * silently: the offer is refused, no answer comes back, and the connection
   * sits at "connecting" for the rest of the evening.
   */
  const [socketEpoch, setSocketEpoch] = useState(0)
  const readers = useRef(new Set<(message: ServerMessage) => void>())
  const subscribe = useCallback((reader: (message: ServerMessage) => void) => {
    readers.current.add(reader)
    return () => {
      readers.current.delete(reader)
    }
  }, [])
  const {
    status,
    reach,
    state,
    air,
    queue,
    listeners,
    padding,
    messages,
    myWishes,
    history,
    socketError,
    clearSocketError,
    connection,
    applyState,
    applyQueue,
    applyPadding,
    applyAir,
    schedule,
    applySchedule,
    mic,
    applyMic,
    me,
    decks,
  } = useStation(
    undefined,
    (message) => {
      routeToClock.current(message)
      for (const reader of readers.current) reader(message)
    },
    socketEpoch,
  )
  const admin = isConsole(requested)
  const clock = useServerClock(connection, { connected: status === 'connected' })
  // Only once tuned in: a socket is open from the moment the page loads, and a
  // name typed into the field is not yet a listener in the room.
  usePresence(connection, {
    connected: status === 'connected',
    nickname: joined ? nickname : null,
  })
  // Assigned after commit, not during render: a render React throws away
  // must not leave a handler wired up behind it.
  useEffect(() => {
    routeToClock.current = clock.handleMessage
  }, [clock.handleMessage])

  const [drift, setDrift] = useState<{ correction: Correction; diff: number } | null>(null)
  const onCorrection = useCallback(
    (correction: Correction, diff: number) => setDrift({ correction, diff }),
    [],
  )

  // Remembered here rather than in the sync view, so arriving at `#sync`
  // shows the last few minutes instead of a line that starts at your click.
  const trails = useSyncTrails({
    offsetMs: clock.synced ? clock.offsetMs : null,
    rttMs: clock.rttMs,
    driftMs: drift ? drift.diff * 1000 : null,
  })

  useSyncedAudio({
    audioRef,
    state,
    joined,
    serverNow: clock.serverNow,
    synced: clock.synced,
    onCorrection,
  })

  /**
   * The gain stage the music sits in, so the decks can talk over it.
   *
   * Built at join and not before. Routing an element through Web Audio is
   * permanent and total, and a context that has never been resumed is silence
   * rather than quiet music, so the graph is made in the one place there is a
   * gesture to spend on waking it. See `lib/audio-graph.ts`.
   */
  const stage = useRef<StationAudio | null>(null)
  useEffect(() => () => stage.current?.close(), [])

  /**
   * The voice, when there is one.
   *
   * Only once tuned in, for the reason nothing else makes a sound before then:
   * the gain stage does not exist until the join click, so there is nowhere to
   * play a voice and no woken context to play it through.
   */
  /**
   * Get a socket that carries what this browser now has.
   *
   * Once per sign-in, and only when the station has actually said this socket
   * is not the decks — so a console opened with a session already in the
   * browser reconnects not at all, and one that just signed in reconnects
   * exactly once. The guard is what keeps a station that refuses the cookie for
   * some other reason from turning this into a reconnect loop: having tried, it
   * stops, and the console says so rather than silently retrying forever.
   */
  const signedIn = session.status === 'signed-in'
  /**
   * Which intent we last opened a fresh socket for, or null once the socket
   * agrees with this browser about who it is.
   *
   * The guard, and it has to be this rather than a boolean, because the fix is
   * needed in both directions: signing in leaves a socket that cannot offer
   * anybody a voice, and signing out leaves one that still could. Recording
   * *what* was attempted means each change of mind gets exactly one reconnect,
   * and a station that disagrees for some third reason gets one and then a
   * message rather than a loop.
   */
  const [attempted, setAttempted] = useState<boolean | null>(null)
  useEffect(() => {
    if (decks === null) return
    if (decks === signedIn) {
      setAttempted(null)
      return
    }
    if (attempted === signedIn) return
    setAttempted(signedIn)
    setSocketEpoch((epoch) => epoch + 1)
  }, [signedIn, decks, attempted])

  /**
   * Signed in, reconnected for it, and the station still does not see the decks.
   *
   * Worth saying out loud on the console, because what it breaks is invisible:
   * the mic opens, the room ducks, the meter moves, and no listener can be
   * offered a voice.
   */
  const deafConsole = signedIn && decks === false && attempted === true

  // Asked for by whichever end of a voice this page is, and it can be both.
  const iceServers = useIceServers(joined || admin)
  const voice = useVoiceReceiver({
    connection,
    me,
    // Tuned in *and* there being a broadcast. What ends with a session ends
    // completely — the chat, the wishes, the history all go — and a voice from
    // an evening that finished would be the one thing left talking.
    active: joined && (air?.live ?? false),
    iceServers,
    onStream: useCallback((stream: MediaStream | null) => stage.current?.play(stream), []),
  })
  useEffect(() => subscribe(voice.handleMessage), [subscribe, voice.handleMessage])


  /**
   * Follow the station down and back up.
   *
   * The whole of the ducking on this side: the server broadcasts how far the
   * music should sit and every listener applies it to their own copy, so a
   * break lands everywhere at the same instant without a byte of audio passing
   * through the station. `duck` ramps; nothing here has to.
   */
  useEffect(() => {
    stage.current?.duck(mic?.live ? mic.duckTo : 1)
  }, [mic?.live, mic?.duckTo])

  // Only this listener's own ears. Muting is not leaving, so the socket, the
  // roster and the clock all carry on exactly as they were.
  const [muted, setMuted] = useState(false)

  /**
   * Sound back on, and back in the room if it stopped rather than went quiet.
   *
   * Muting from the page never pauses the element, so on the way back there is
   * normally nothing to do but unmute. A lock screen, a headset button or an
   * incoming call can pause it though, and a paused element resumes exactly
   * where it stopped: a listener minutes behind everybody else, with nothing on
   * screen saying so. So the live edge is sought again, and only when the
   * element actually stopped, because a seek nobody needed is an audible hitch
   * for nothing.
   */
  function listen() {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = false
    setMuted(false)
    // A gesture, and the one place a listener reliably makes another one after
    // joining. The OS suspends audio contexts for a call or a lock screen, and
    // a suspended context is not quiet music, it is none: unmuting an element
    // whose graph is asleep would look like the button not working.
    stage.current?.resume()
    if (audio.paused && state?.track && state.pausedAt === null) {
      seekTo(audio, expectedPositionSeconds(state, clock.serverNow()))
      void audio.play().catch(() => undefined)
    }
  }

  function silence() {
    const audio = audioRef.current
    if (!audio) return
    audio.muted = true
    setMuted(true)
  }

  // The element is the source of truth for which way this goes, not `muted`,
  // because the lock screen can press either of these without the page having
  // rendered in between.
  function toggleMute() {
    if (audioRef.current?.muted) listen()
    else silence()
  }

  function joinStation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    // The gate: no nickname, no session. The button is disabled without one,
    // but Enter in the field arrives here too, and refusing to join belongs
    // next to joining rather than only in what the button looks like.
    const stored = saveNickname(nickname)
    if (stored === null) return
    setNickname(stored)

    // Autoplay policy: play() has to be called synchronously inside the submit
    // handler, not after an await, or the browser refuses it. That is why the
    // nickname is a field on the form the button submits rather than a step
    // before it: naming yourself and tuning in are one gesture, and splitting
    // them would leave the audio starting outside any gesture at all.
    const audio = audioRef.current
    if (audio) {
      // Inside the gesture, and before play(), because this is the moment the
      // browser will let a context be resumed. It is also the last moment it is
      // safe to route the element at all: after this the music only reaches the
      // speakers through the graph.
      stage.current = stationAudio(audio)
      // Applied here rather than left to the effect, so somebody arriving in
      // the middle of a mic break comes in already ducked. The effect runs
      // after the commit, which is a few milliseconds of a song at full volume
      // under somebody's voice — the exact arrival the server sends the `mic`
      // frame before `state` to avoid.
      stage.current.duck(mic?.live ? mic.duckTo : 1)
    }
    if (audio && state?.track && state.pausedAt === null) {
      // Through seekTo, not currentTime: the click can land before the element
      // has metadata, and a bare assignment is silently dropped there, which
      // is a listener starting at 0:00 while everyone else is at 2:14.
      seekTo(audio, expectedPositionSeconds(state, clock.serverNow()))
      void audio.play().catch(() => undefined)
    }
    setJoined(true)
  }

  const track = state?.track ?? null
  const artwork = track ? artworkUrl(track) : null
  const tuning = joined && !clock.synced
  const paused = state?.pausedAt !== null && state?.pausedAt !== undefined
  // Nothing left on the page that came from a station: either this listener
  // never got one, or the outage arrived before the first frame did. There is
  // no stale truth to keep showing, so the outage screen takes the whole panel.
  const stranded = reach !== 'live' && (!clock.synced || state === null)
  /**
   * The one thing the page says about the station, connectivity and broadcast
   * folded together. See `standing`. Everything below reads this rather than
   * `reach`, so "we cannot find it" and "nobody is on the decks tonight" stay
   * different sentences instead of both coming out as silence.
   */
  const here: Standing = standing(reach, air?.live ?? null)
  // Off air is not an outage, and nothing is broken, but it is the same screen:
  // no music, and nothing on the page worth presenting as current.
  const closed = here === 'off-air'
  // The record turns for exactly one reason: audio is coming out of it.
  const onAir = Boolean(joined && !stranded && !tuning && track && !paused)

  // What the phone says while the page is in a pocket. The same two facts the
  // deck shows, handed to the OS: what is on, and that it is live rather than
  // some number of minutes into something.
  useMediaSession({
    track,
    playing: onAir && !muted,
    onResume: listen,
    onPause: silence,
  })

  // Somebody can type `#chat` into the address bar before tuning in, and there
  // is nothing behind it when they do: the station has not told this browser
  // who is in the room or what has been on. So the address is honoured only
  // once it leads somewhere, and until then every view is the one you land on.
  const route: Route = needsJoin(requested) && !joined ? 'on-air' : requested

  const wishes = (
    <Wishes
      wishes={myWishes}
      connection={connection}
      live={status === 'connected'}
      refusal={refusalAbout(socketError, 'wish')}
      clearRefusal={clearSocketError}
    />
  )
  const chat = (
    <Chat
      messages={messages}
      connection={connection}
      live={status === 'connected'}
      refusal={refusalAbout(socketError, 'say')}
      clearRefusal={clearSocketError}
    />
  )
  const readout = (
    <ClockReadout
      offsetMs={clock.offsetMs}
      rttMs={clock.rttMs}
      diff={drift?.diff ?? null}
      correction={drift?.correction ?? null}
      trails={trails}
    />
  )

  return (
    <div className="station">
      <Sidebar
        active={route}
        joined={joined}
        showConsole={session.status === 'signed-in'}
      />

      <div className="station__main">
        <Topbar
          reach={here}
          // What the room is told: who is here, plus whatever the decks have
          // added on top. Null until the first roster, since a count nobody
          // has sent is not zero. See `PresenceMessage`.
          listeners={listeners === null ? null : listeners.length + padding}
          admin={admin}
          nextSession={
            // Off air only, and only for an announcement that has not gone
            // stale. On air the station is the thing to say.
            closed && isUpcoming(schedule, Date.now())
              ? nextSessionShort(schedule.startsAt, Date.now())
              : null
          }
          showConsole={session.status === 'signed-in'}
        />

        {/* Above everything it is about. What is below stopped being live at the
            drop (the roster, the tally and the clock all did), and a page that
            kept presenting it as current would be the broken UI this replaces.
            The console says the same thing in its own words, so this is only
            for the listener page. */}
        {!admin && joined && !stranded && <StaleNotice state={here} />}

        {/* The two sides of the station, and never both at once: the console
            takes the whole page, because whoever is running the decks is
            working, not listening. The chip in the top bar is the way back. */}
        {admin ? (
          <AdminPanel
            state={state}
            air={air}
            queue={queue}
            // The roster itself, not a count: the console needs the names to
            // say who is hearing a mic break and who is not.
            listeners={listeners}
            padding={padding}
            messages={messages}
            serverNow={clock.serverNow}
            session={session}
            status={status}
            applyState={applyState}
            applyQueue={applyQueue}
            applyPadding={applyPadding}
            applyAir={applyAir}
            schedule={schedule}
            applySchedule={applySchedule}
            mic={mic}
            applyMic={applyMic}
            connection={connection}
            me={me}
            deaf={deafConsole}
            iceServers={iceServers}
            subscribe={subscribe}
          />
        ) : !joined ? (
          canTuneIn(here) ? (
            <div className="station__columns">
              <section className="column column--stage">
                <Deck artwork={null} spinning={false} />
                <div className="join">
                  <p className="join__blurb">
                    One station. Everyone hears the same instant of the same song.
                  </p>
                  <form className="join__form" onSubmit={joinStation}>
                    <label className="join__label" htmlFor="nickname">
                      What should everyone call you?
                    </label>
                    <input
                      id="nickname"
                      className="join__input"
                      name="nickname"
                      value={nickname}
                      onChange={(event) => setNickname(event.target.value)}
                      placeholder="nickname"
                      maxLength={NICKNAME_MAX_LENGTH}
                      autoComplete="nickname"
                      autoFocus
                      required
                    />
                    <button
                      type="submit"
                      className="join__button"
                      disabled={!isValidNickname(nickname)}
                    >
                      Tune in
                    </button>
                  </form>
                </div>
              </section>
            </div>
          ) : (
            <Outage state={here} schedule={schedule} />
          )
        ) : stranded || closed ? (
          <Outage state={here} schedule={schedule} />
        ) : route === 'on-air' ? (
          // The listener page, whole: the deck and what it is playing on the
          // left, the words to it on the right. Every other view below is one
          // of the rail's destinations given the screen.
          //
          // On a phone it is only the first half. Stacked into one column the
          // whole thing ran to about six screens of scrolling, and the record,
          // the one thing on the page you came for, spent five of them off the
          // top. So everything else lives at the rail's own destinations:
          // `#lyrics`, `#history`, `#chat`, `#wishes`, `#sync`. Nothing is
          // hidden, and nothing is duplicated; the deck simply stops being a
          // lid on a pile.
          //
          // What is *coming* is deliberately not on this side at all any more:
          // the queue is the admin's worksheet, and a listener page that
          // printed it would spend its space answering a question the room
          // did not ask. What was on is still at `#history`.
          //
          // The wishes and the clock are gone from here at every width. See
          // the note further down.
          <div className="station__columns">
            <section className="column column--stage">
              <Deck artwork={artwork} spinning={onAir} />

              {tuning ? (
                <div className="off-air">
                  <p className="off-air__headline">tuning in…</p>
                </div>
              ) : track ? (
                <div className="stage">
                  <OnAir
                    live={onAir}
                    idleLabel={paused ? 'PAUSED' : 'OFF AIR'}
                    // Only while there is sound to talk over. A break announced
                    // under a paused deck would be a badge about nothing.
                    talking={Boolean(onAir && mic?.live)}
                  />

                  {/* No clock under the title. A listener is not seeking and
                      cannot, so "1:46 / 4:00" was answering a question nobody
                      on this side of the station gets to ask, and the badge
                      above already says the thing that matters, which is that
                      this is live. The numbers are still exact and still read:
                      they are what the audio is aligned against, and what the
                      sync view prints. */}
                  <div className="stage__head">
                    <h2 className="now-playing__title">{track.title}</h2>
                    <p className="now-playing__artist">{track.artist ?? 'Unknown artist'}</p>
                  </div>

                  <Waveform live={onAir} />

                  <Mute muted={muted} onToggle={toggleMute} enabled={Boolean(track)} />
                </div>
              ) : (
                // The station is there and answering; it just isn't playing
                // anything. That reads exactly like a broken page unless the
                // page says otherwise, so it says both halves: nothing is on,
                // and you have missed nothing.
                <div className="off-air" data-testid="off-air">
                  <p className="off-air__headline">Nothing on the decks right now.</p>
                  <p className="off-air__detail">
                    You're tuned in. Whatever goes on next starts here on its own.
                  </p>
                </div>
              )}

              {/* No wishes here, and no clock, at any width.

                  Both have a mark on the rail and a screen of their own, and
                  both are things you go to rather than things the deck should
                  be carrying. Asking for something wants the composer at full
                  width with what you have already asked for listed under it,
                  not a footnote below the record. The clock numbers want the
                  glossary beside them that says what each one means, which is
                  the only time anybody reads them. A strip of four figures
                  under the mute button is a readout you glance at, worry
                  about, and cannot act on. Both are at `#wishes` and `#sync`.

                  Who else is here stays: that is not somewhere you go, it is
                  something about the room you are already in. */}
              {!narrow && <Listeners listeners={listeners} padding={padding} />}
            </section>

            {!narrow && (
              <section className="column column--aside">
                {/* The whole column, and nothing else on it. The queue, the
                    evening and the room used to stack here; they all still
                    exist, one rail mark away, where each gets a full screen
                    instead of a third of a column. What sits beside the deck
                    now is the one thing that belongs to *this* moment of the
                    song and no other: the words. */}
                <Lyrics state={state} serverNow={clock.serverNow} />
              </section>
            )}
          </div>
        ) : (
          // One thing, with the whole screen. Nothing here is new data; it is
          // the same panel the landing view carries in a column, without the
          // column, which is the only thing a rail full of destinations can
          // honestly offer on a station this size.
          <div className={`view view--${route}`}>
            {route === 'sync' && <SyncView readout={readout} synced={clock.synced} reach={reach} />}
            {/* Who is in the room, above what the room is saying. The roster is
                the one panel on the landing view with no mark of its own, so
                on a phone, where the landing view no longer carries it, this
                is where it goes. It belongs here at every width: "the room" is
                the people as much as the conversation. */}
            {route === 'chat' && (
              <>
                <Listeners listeners={listeners} padding={padding} />
                {chat}
              </>
            )}
            {route === 'wishes' && wishes}
            {route === 'history' && (
              <Earlier plays={history} currentTrackId={track?.id ?? null} standalone />
            )}
            {route === 'lyrics' && <Lyrics state={state} serverNow={clock.serverNow} />}
          </div>
        )}
      </div>

      {/* Owned imperatively: React never sets currentTime or calls play(). */}
      <audio ref={audioRef} preload="auto" />
    </div>
  )
}

/**
 * The station is not there.
 *
 * PLAN.md's offline screen. What it is for is the case where every other part
 * of this page is a lie: no socket, so no track, no roster, no chat, and a
 * layout full of empty boxes that reads like a page that broke rather than a
 * station that went away. This says which one it is.
 *
 * There is no Retry button and there deliberately never will be. The connection
 * is already retrying on a backoff (`lib/station.ts`), so the only thing a
 * button could do is exactly what is happening anyway, while implying the page
 * had given up and was waiting to be told to try again.
 */
function Outage({ state, schedule }: { state: Standing; schedule?: ScheduledSession | null }) {
  const notice = outage(state)
  if (!notice) return null

  // Only over "nobody is on the decks tonight", and never over an outage. A
  // station that cannot be reached has not told this page anything, and the
  // announcement it is holding may be hours out of date; promising a Saturday
  // on top of "no signal" would be the page inventing good news.
  const next = state === 'off-air' && isUpcoming(schedule ?? null, Date.now()) ? schedule : null

  return (
    <div className="outage" data-testid="outage" data-reach={state} role="status">
      {next && <NextSession next={next} />}
      <p className="outage__headline">{notice.headline}</p>
      <p className="outage__detail">{notice.detail}</p>
    </div>
  )
}

/**
 * The poster, and when the station is next on.
 *
 * "Off the air" is a fact about right now and nothing anybody can do with it.
 * This is the half that is worth reading: a picture somebody made for the night
 * and the evening it is on, which between them turn a closed room into an
 * appointment.
 *
 * The poster is above the headline rather than under it because it is the thing
 * being said. The sentence under it is a caption.
 */
function NextSession({ next }: { next: ScheduledSession }) {
  const art = posterUrl(next)
  return (
    <div className="next" data-testid="next-session">
      {art && (
        <img
          className="next__poster"
          src={art}
          alt=""
          /* The date under it says the same thing in words, so the image is
             decoration to a screen reader rather than a second announcement. */
        />
      )}
      <p className="next__label">Next session</p>
      <p className="next__when">
        <time dateTime={new Date(next.startsAt).toISOString()}>
          {nextSessionLabel(next.startsAt, Date.now())}
        </time>
      </p>
    </div>
  )
}

/**
 * The station is not there, but the page still has what it last said.
 *
 * A drop of a second or two is the common one, and the audio usually plays
 * straight through it out of the buffer, so blanking a track the listener can
 * still hear would be worse than the outage. What the page must not do is go on
 * presenting a frozen roster and a dead tally as live, and this line is the
 * difference between the two.
 */
function StaleNotice({ state }: { state: Standing }) {
  const notice = staleNotice(state)
  if (!notice) return null

  return (
    <p className="stale" data-testid="stale-notice" data-reach={state} role="status">
      {notice}
    </p>
  )
}

/**
 * What has already been on: the design's "Recently Played".
 *
 * PLAN.md's now-playing history, from the listener's side: the evening so far,
 * newest first, so somebody who walked in on the end of something can see what
 * it was. The station writes a play down when the track starts, which makes the
 * newest row whatever is on right now (already shown in full beside this list),
 * so `playedEarlier` drops it and this list is only what was missed.
 *
 * Written down rather than held on the socket, so unlike the roster it survives
 * a reload and covers an outage: whatever went on while a listener was
 * reconnecting arrives in the replay, merged by id.
 */
function Earlier({
  plays,
  currentTrackId,
  standalone,
}: {
  plays: Play[]
  currentTrackId: number | null
  /**
   * True when this panel is the whole page. An empty history is worth no space
   * beside the deck, but on its own view a blank screen is a dead end, so
   * there it says the evening has not started rather than nothing.
   */
  standalone?: boolean
}) {
  const earlier = playedEarlier(plays, currentTrackId)
  if (earlier.length === 0 && !standalone) return null

  return (
    <section className="panel" id="earlier" data-testid="earlier">
      <div className="panel__head">
        <h2 className="panel__title">Recently Played</h2>
        <p className="panel__aside">{earlier.length} played</p>
      </div>
      {earlier.length === 0 ? (
        <p className="panel__empty">
          Nothing has been on yet this session. What plays from here shows up in this list.
        </p>
      ) : (
        // A shelf rather than a list, and it scrolls rather than capping at
        // four with a button under it. What was on is a row of sleeves, which
        // is how records are kept and how you find one again: you recognise the
        // cover before you have read anything. Sideways because the panel is a
        // column of other panels, and an evening's worth of covers stacked
        // downwards would be the whole page.
        <ol className="shelf" data-testid="shelf">
          {earlier.map((play) => (
            <li className="shelf__slot" key={play.id} data-play={play.id} data-track={play.track.id}>
              {/* One string for the tooltip and the screen reader, the same one
                  the rows used, because the sleeve carries no words of its own
                  and the two lines under it are cut to fit. */}
              <span className="shelf__card" title={playedLabel(play)}>
                <Sleeve track={play.track} />
                <span className="shelf__title">{play.track.title}</span>
                <span className="shelf__artist">{play.track.artist ?? 'Unknown artist'}</span>
                <time className="shelf__at" dateTime={new Date(play.at).toISOString()}>
                  {formatTime(play.at)}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * The cover, or the most honest stand-in for one.
 *
 * Plenty of uploads carry no artwork, and a shelf with holes in it reads as a
 * page that failed to load rather than as a record nobody scanned. The stand-in
 * is the initial of the title on a plain tile: it is not pretending to be a
 * sleeve, it is the same trick the roster plays with a nickname, and it keeps
 * the shelf a shelf.
 */
function Sleeve({ track }: { track: Track }) {
  const art = artworkUrl(track)
  if (art) {
    return <img className="shelf__art" src={art} alt="" loading="lazy" width={96} height={96} />
  }
  return (
    <span className="shelf__art shelf__art--none" aria-hidden="true">
      {track.title.trim().charAt(0).toUpperCase() || '·'}
    </span>
  )
}

/**
 * Who else is here.
 *
 * The roster arrives whole on every change rather than as joins and leaves, so
 * there is nothing to reconcile: render what the last frame said. Rows are
 * keyed on the socket's id, not the nickname, because two listeners are allowed
 * to pick the same name and both of them should show up.
 *
 * Null before the first roster arrives, and empty for the moment between tuning
 * in and this listener's own join landing; neither is worth a heading.
 *
 * The count in the heading is the same one the top bar shows, padding and all,
 * so the two can never disagree; the names are the part of it that is people.
 */
function Listeners({ listeners, padding }: { listeners: Listener[] | null; padding: number }) {
  if (!listeners) return null
  const total = listeners.length + padding
  if (total === 0) return null

  return (
    <section className="panel panel--stage" data-testid="listeners">
      <div className="panel__head">
        <h2 className="panel__title">Listening now</h2>
        {/* The whole count, so this agrees with the top bar. The names below
            are the part of it with people attached. */}
        <p className="panel__aside">{total}</p>
      </div>
      <ul className="listeners__list">
        {listeners.map((listener) => (
          <li key={listener.id} className="listeners__name" data-listener={listener.id}>
            {listener.nickname}
          </li>
        ))}
        {/* The rest of the count, as one pill rather than as invented names.
            Nobody is behind this number, so it gets nothing to be greeted by:
            a row here that read like a nickname would be a stranger the room
            could say hello to and never hear back from. */}
        {padding > 0 && (
          <li className="listeners__name listeners__name--more" data-testid="listeners-more">
            +{padding} more
          </li>
        )}
      </ul>
    </section>
  )
}

interface WishesProps {
  /** This listener's own: the only ones the station tells them about. */
  wishes: Wish[]
  connection: StationConnection | null
  live: boolean
  /** The last refusal that was about a wish, if any. */
  refusal: SocketRefusal | null
  clearRefusal(): void
}

/**
 * Asking for something.
 *
 * PLAN.md's requests decision, in full: free text, and no library to browse.
 * There is nothing to pick from here on purpose: a listener asks in their own
 * words for something the station may not even have, and whoever runs the decks
 * reads it and decides. So this composer promises nothing, and says so.
 *
 * What comes back is the wish as the station wrote it down, and that is the
 * whole confirmation. Nothing is rendered optimistically, for the reason the
 * chat renders nothing optimistically: a line that says "asked" for something
 * that was refused is worse than no line at all.
 */
function Wishes({
  wishes,
  connection,
  live,
  refusal,
  clearRefusal,
}: WishesProps) {
  const [draft, setDraft] = useState('')
  // What went out and has not been answered, so a refusal can hand it back.
  const unanswered = useRef<string | null>(null)

  const seq = refusal?.seq
  useEffect(() => {
    if (seq === undefined) return
    const text = unanswered.current
    unanswered.current = null
    setDraft((current) => draftAfterRefusal(current, text))
  }, [seq])

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = normalizeWishText(draft)
    if (text.length === 0 || !connection || !live) return
    // Only when this composer has a notice up. The station keeps one refusal at
    // a time for the whole socket, and clearing it from here would take down
    // the chat's "not sent" because somebody asked for a song.
    if (refusal) clearRefusal()
    unanswered.current = text
    connection.send({ type: 'wish', text })
    setDraft('')
  }

  const refusalNotice = refusal ? wishRefusal(refusal.error.code) : null

  return (
    <section className="panel panel--stage" id="wishes" data-testid="wishes">
      <div className="panel__head">
        <h2 className="panel__title">Wishes</h2>
        <p className="panel__aside">no promises</p>
      </div>
      {wishes.length === 0 ? (
        <p className="panel__empty">
          Ask for anything. Whoever's on the decks reads these. No promises.
        </p>
      ) : (
        <ol className="wishes__list" data-testid="wishes-list">
          {wishes.map((wish) => (
            <li key={wish.id} className="wishes__line" data-wish={wish.id}>
              <span className="wishes__text">{wish.text}</span>
              {/* Only ever "asked" for now: nothing tells a listener their wish
                  was played, so a status that could change is rendered rather
                  than assumed. */}
              <span className="wishes__status">{wishStatusLabel(wish.status)}</span>
            </li>
          ))}
        </ol>
      )}
      {refusalNotice && (
        <p className="refusal" role="status" data-testid="wishes-refusal">
          {refusalNotice}
        </p>
      )}
      <form className="compose" onSubmit={ask}>
        <label className="compose__label" htmlFor="wish-input">
          Ask for something
        </label>
        <input
          id="wish-input"
          className="compose__input"
          data-testid="wish-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={live ? 'anything off Rumours…' : 'reconnecting…'}
          maxLength={WISH_MAX_LENGTH}
          autoComplete="off"
          disabled={!live}
        />
        <button type="submit" className="compose__send" disabled={!live || !isSendableWish(draft)}>
          Ask
        </button>
      </form>
    </section>
  )
}

interface ChatProps {
  messages: ChatMessage[]
  connection: StationConnection | null
  /** False while reconnecting: a send would go on the floor unannounced. */
  live: boolean
  /** The last refusal that was about a message, if any. */
  refusal: SocketRefusal | null
  clearRefusal(): void
}

/**
 * The room, talking.
 *
 * Nothing is rendered optimistically: what was typed goes out, and appears when
 * it comes back with the id and timestamp the server gave it. That costs a
 * round trip on a station where everyone is already listening to the same
 * server, and it buys a list that is the same list for everyone in the room:
 * no local-only line that a refused message would leave sitting there looking
 * sent.
 */
function Chat({ messages, connection, live, refusal, clearRefusal }: ChatProps) {
  const [draft, setDraft] = useState('')
  const list = useRef<HTMLOListElement>(null)
  // What went out and has not been answered, so a refusal can hand it back.
  const unanswered = useRef<string | null>(null)

  // Follow the conversation. Reading back through it is a scroll away, but a
  // new line arriving should not leave the listener looking at an old one.
  useEffect(() => {
    const element = list.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages])

  // A refused message is not a sent message, so give the text back rather than
  // leaving the listener to retype something they watched disappear. Keyed on
  // the sequence number, so a second identical refusal is still a refusal.
  //
  // Only into a composer they have not started refilling: whatever they are
  // typing now is newer than whatever was refused, and restoring over the top
  // of it would destroy the one thing here that isn't recoverable.
  const seq = refusal?.seq
  useEffect(() => {
    if (seq === undefined) return
    const text = unanswered.current
    unanswered.current = null
    setDraft((current) => draftAfterRefusal(current, text))
  }, [seq])

  function say(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = normalizeMessageText(draft)
    if (text.length === 0 || !connection || !live) return
    // Only this composer's own. See the same line under the wishes.
    if (refusal) clearRefusal()
    unanswered.current = text
    connection.send({ type: 'say', text })
    setDraft('')
  }

  const refusalNotice = refusal ? chatRefusal(refusal.error.code) : null

  return (
    <section className="panel" id="chat" data-testid="chat">
      <div className="panel__head">
        <h2 className="panel__title">Live Chat</h2>
        <p className="panel__aside">
          <span className="panel__dot" aria-hidden="true" />
          {messages.length} messages
        </p>
      </div>
      <div className="chat__panel">
        {messages.length === 0 ? (
          <p className="panel__empty">Nobody has said anything yet.</p>
        ) : (
          <ol className="chat__list" data-testid="chat-list" ref={list}>
            {messages.map((message) => (
              <li key={message.id} className="chat__line" data-message={message.id}>
                <Avatar nickname={message.nickname} />
                <span className="chat__body">
                  {/* The time sits beside the name, not inside it: `.chat__nick`
                      is read as the name on its own, here and in the QA runs. */}
                  <span className="chat__head">
                    <span className="chat__nick">{message.nickname}</span>
                    <time className="chat__at" dateTime={new Date(message.at).toISOString()}>
                      {formatTime(message.at)}
                    </time>
                  </span>
                  <span className="chat__text">{message.text}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {refusalNotice && (
          <p className="refusal" role="status" data-testid="chat-refusal">
            {refusalNotice}
          </p>
        )}
        <form className="compose" onSubmit={say}>
          <label className="compose__label" htmlFor="chat-input">
            Say something
          </label>
          <input
            id="chat-input"
            className="compose__input"
            data-testid="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={live ? 'say something' : 'reconnecting…'}
            maxLength={MESSAGE_MAX_LENGTH}
            autoComplete="off"
            disabled={!live}
          />
          <button
            type="submit"
            className="compose__send"
            disabled={!live || !isSendableMessage(draft)}
          >
            Send
          </button>
        </form>
      </div>
    </section>
  )
}

/**
 * The circle beside a message.
 *
 * The design puts a photograph here; the station has no photographs and never
 * asks for one, so this is the most the page honestly knows about a listener:
 * their name, drawn as an initial over a colour derived from the same name. The
 * derivation is pure, so the same nickname is the same colour on every screen
 * in the room without a byte crossing the wire to arrange it.
 */
function Avatar({ nickname }: { nickname: string }) {
  const hue = useMemo(() => hueFor(nickname), [nickname])
  return (
    <span
      className="chat__avatar"
      aria-hidden="true"
      style={{ '--hue': `${hue}` } as CSSProperties}
    >
      {[...nickname.trim()][0] ?? '?'}
    </span>
  )
}

/** A stable hue in [0, 360) for a nickname. Not a hash anyone relies on. */
function hueFor(nickname: string): number {
  let total = 0
  for (const character of nickname) total = (total * 31 + character.codePointAt(0)!) % 360
  return total
}

/**
 * Where the address bar says we are, following it without a reload.
 *
 * Both events, not just `hashchange`: the back button after a same-document
 * navigation fires `popstate`, and a rail that only listened for the first one
 * would leave the browser's own history buttons doing nothing.
 */
function useRoute(): Route {
  const read = () => (typeof window === 'undefined' ? DEFAULT_ROUTE : routeFrom(window.location))
  const [route, setRoute] = useState(read)

  useEffect(() => {
    const update = () => setRoute(routeFrom(window.location))
    // The address may have moved between first render and this effect running.
    update()
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])

  return route
}

interface SyncViewProps {
  readout: ReactNode
  synced: boolean
  reach: Availability
}

/**
 * The clock numbers, with the whole screen.
 *
 * PLAN.md: "the whole project lives or dies on these numbers." The landing view
 * carries them as a strip under the deck, where they are a glance; this is the
 * same strip with what each one means beside it, which is what you want when
 * the glance said something you did not like.
 *
 * The readout itself is passed in rather than rebuilt, so there is exactly one
 * of it in the app and no chance of the two disagreeing.
 */
function SyncView({ readout, synced, reach }: SyncViewProps) {
  return (
    <section className="panel" data-testid="sync-view">
      <div className="panel__head">
        <h2 className="panel__title">Sync</h2>
        <p className="panel__aside">
          <span
            className="panel__dot"
            style={{ background: synced ? undefined : 'var(--faint)' }}
            aria-hidden="true"
          />
          {synced ? 'locked to the station' : 'not locked yet'}
        </p>
      </div>

      {readout}

      {reach !== 'live' && (
        <p className="panel__empty">
          These stopped updating when the station went away. They will pick up again by themselves
          the moment it is back.
        </p>
      )}
    </section>
  )
}

interface ClockReadoutProps {
  offsetMs: number
  rttMs: number | null
  diff: number | null
  correction: Correction | null
  trails: SyncTrails
}

/** How tall the chart is. One frame, so the whole height belongs to it. */
const CHART_HEIGHT = 280

/**
 * The three lines, in the order they are drawn and listed. The colors are the
 * one place this page steps outside the monochrome design: three lines in one
 * frame need identities, and identity is what categorical color is for. The
 * trio was validated (CVD ΔE ≥ 8, ≥3:1 on this background); see styles.css.
 */
const SYNC_SERIES = [
  { key: 'offset', label: 'clock offset', testId: 'sync-offset' },
  { key: 'rtt', label: 'rtt', testId: 'sync-rtt' },
  { key: 'drift', label: 'drift', testId: 'sync-drift' },
] as const

/** How far apart two line-end labels have to sit before they collide. */
const TAG_GAP = 15

/**
 * Visible sync diagnostics: the whole project lives or dies on these numbers.
 *
 * One graph, three lines, one scale. Everything here is milliseconds, and the
 * point of drawing the three together is that their sizes compare: the drift
 * should be small against the offset, the rtt should be small against both,
 * and a line that suddenly stands taller than its neighbours is the story.
 * Each line is named twice: at its right-hand end, and in the legend under
 * the frame, where the live numbers are. No cards and no captions: the graph
 * is the reading.
 *
 * Pointing anywhere in the frame holds that moment: a crosshair, a dot per
 * line, and the legend swaps to what each metric was then.
 */
function ClockReadout({ offsetMs, rttMs, diff, correction, trails }: ClockReadoutProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [heldAt, setHeldAt] = useState<number | null>(null)

  // Real pixels, measured, so a 2px line is 2px and the hover dots are round.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => setWidth(frame.clientWidth)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(frame)
    return () => watcher.disconnect()
  }, [])

  const now = Date.now()
  const inMs = (value: number) => `${Math.round(value)}ms`
  const trailOf = { offset: trails.offset, rtt: trails.rtt, drift: trails.drift }
  const live = {
    offset: inMs(offsetMs),
    rtt: rttMs === null ? '—' : inMs(rttMs),
    drift: diff === null ? '—' : inMs(diff * 1000),
  }

  const geometry = chart([trails.offset, trails.rtt, trails.drift], {
    width,
    height: CHART_HEIGHT,
    now,
    minSpanMs: 30,
  })
  const drawn = geometry.series.some((line) => line.points !== null)

  // Each line's name at its right-hand end, nudged apart when two lines end
  // at the same height: a label readable only by tracing the line back is
  // not a label.
  const tags = SYNC_SERIES.map((series, index) => ({
    series,
    line: geometry.series[index]!,
    y: geometry.series[index]!.endY ?? 0,
  }))
    .filter((tag) => tag.line.points !== null)
    .sort((a, b) => a.y - b.y)
  for (let i = 0; i < tags.length; i++) {
    const above = i === 0 ? 10 : tags[i - 1]!.y + TAG_GAP
    tags[i]!.y = Math.min(Math.max(tags[i]!.y, above), CHART_HEIGHT - 6 - (tags.length - 1 - i) * TAG_GAP)
  }

  const held = heldAt !== null
  const heldSample = (key: (typeof SYNC_SERIES)[number]['key']) =>
    heldAt === null ? null : nearest(trailOf[key], heldAt)

  function hold(event: ReactPointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0) return
    const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1)
    setHeldAt(now - (1 - fraction) * TRAIL_WINDOW_MS)
  }

  return (
    <div className="sync" data-testid="sync-readout">
      <div className="sync__frame" ref={frameRef}>
        {drawn ? (
          <svg
            className="sync__plot"
            width={width}
            height={CHART_HEIGHT}
            onPointerMove={hold}
            onPointerLeave={() => setHeldAt(null)}
            role="img"
            aria-label="Clock offset, rtt and drift over the last three minutes"
          >
            {geometry.zeroY !== null && (
              <>
                <line
                  className="sync__zero"
                  x1={0}
                  x2={width}
                  y1={geometry.zeroY}
                  y2={geometry.zeroY}
                />
                <text className="sync__scale" x={4} y={geometry.zeroY - 5}>
                  0
                </text>
              </>
            )}
            {/* The scale, quietly: what the top and bottom of the frame mean. */}
            <text className="sync__scale" x={4} y={12}>
              {inMs(geometry.max)}
            </text>
            <text className="sync__scale" x={4} y={CHART_HEIGHT - 5}>
              {inMs(geometry.min)}
            </text>

            {heldAt !== null && (
              <line
                className="sync__cross"
                x1={geometry.xAt(heldAt)}
                x2={geometry.xAt(heldAt)}
                y1={0}
                y2={CHART_HEIGHT}
              />
            )}

            {SYNC_SERIES.map((series, index) => {
              const line = geometry.series[index]!
              if (line.points === null) return null
              const sample = heldSample(series.key)
              const spot = sample !== null ? geometry.project(sample) : null
              return (
                <g key={series.key}>
                  <polyline className={`sync__line sync__line--${series.key}`} points={line.points} />
                  {spot !== null ? (
                    <circle
                      className={`sync__spot sync__spot--${series.key}`}
                      cx={spot.x}
                      cy={spot.y}
                      r={3.5}
                    />
                  ) : (
                    line.endX !== null && (
                      <circle
                        className={`sync__spot sync__spot--${series.key}`}
                        cx={line.endX}
                        cy={line.endY ?? 0}
                        r={3}
                      />
                    )
                  )}
                </g>
              )
            })}

            {tags.map((tag) => (
              <text
                key={tag.series.key}
                className="sync__tag"
                x={(tag.line.endX ?? width) - 8}
                y={tag.y + 4}
                textAnchor="end"
              >
                {tag.series.label}
              </text>
            ))}
          </svg>
        ) : (
          <p className="sync__waiting">waiting for the station…</p>
        )}
      </div>

      <div className="sync__legend">
        {SYNC_SERIES.map((series) => {
          const sample = heldSample(series.key)
          return (
            <p className="sync__key" key={series.key}>
              <span className={`sync__swatch sync__swatch--${series.key}`} aria-hidden="true" />
              <span className="sync__name">{series.label}</span>
              <span className="sync__reading" data-testid={series.testId}>
                {sample !== null ? inMs(sample.value) : live[series.key]}
              </span>
            </p>
          )
        })}
        <p className="sync__key">
          <span className="sync__name">correcting</span>
          <span className="sync__reading" data-testid="sync-correction">
            {correction === null
              ? '—'
              : correction.kind === 'rate'
                ? `${correction.playbackRate.toFixed(3)}×`
                : correction.kind}
          </span>
        </p>
        {held && heldAt !== null && (
          <p className="sync__ago">{Math.max(0, Math.round((now - heldAt) / 1000))}s ago</p>
        )}
      </div>
    </div>
  )
}
