import {
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import commentsIcon from './assets/icons/comments.svg'
import gripIcon from './assets/icons/grip.svg'
import playIcon from './assets/icons/play.svg'
import uploadIcon from './assets/icons/upload-cloud.svg'
import usersIcon from './assets/icons/users.svg'
import {
  AdminError,
  MAX_PADDING,
  MIC_HANGOVER_MS,
  MIC_RENEW_MS,
  MIN_DUCK,
  SCHEDULE_TITLE_MAX_LENGTH,
  type AdminApi,
  type PlaybackCommand,
  type WishBook,
} from './lib/admin.js'
import { formatTime } from './lib/chat.js'
import { kindLabel, kindPromise } from './lib/kind.js'
import { expectedPositionSeconds, formatClock } from './lib/position.js'
import { inviteLink } from './lib/invite.js'
import { fromLocalInput, nextSessionLabel, toLocalInput } from './lib/schedule.js'
import { posterUrl } from './lib/protocol.js'
import type {
  AirSnapshot,
  ChatMessage,
  Listener,
  CoHostSnapshot,
  FloorSnapshot,
  MicSnapshot,
  PlaybackSnapshot,
  ServerMessage,
  QueueEntry,
  ScheduledSession,
  SessionKind,
  StateMessage,
  TransitionSnapshot,
  Track,
} from './lib/protocol.js'
import type { AdminSession } from './hooks/useAdminSession.js'
import { type MicInput, useMicInput } from './hooks/useMicInput.js'
import type { StationConnection, StationStatus } from './lib/station.js'
import { MAX_BLEND_MS, coHostLink } from './lib/cohost.js'
import { type AirMixerHandle, useAirMixer } from './hooks/useAirMixer.js'
import {
  HEALTH,
  PENDING,
  type PeerHealth,
  type PeerState,
  hearingCount,
  orderByHealth,
} from './lib/reach.js'
import { useVoiceBroadcast } from './hooks/useVoice.js'

export interface AdminPanelProps {
  /** The station's own broadcast; the panel never keeps its own copy. */
  state: StateMessage | null
  /**
   * Whether the station is on air. Null until the first frame arrives.
   *
   * The one piece of state on this panel that is not about *what* is playing
   * but about whether there is a broadcast at all: PLAN.md's "you go live, you
   * end it". Ending it clears the decks and the queue and closes the room, so
   * the control for it is deliberately away from the transport buttons.
   */
  air: AirSnapshot | null
  /**
   * The next session, announced, or null when nothing is. The one thing on this
   * panel that outlives the session it is set during: see `ScheduleCard`.
   */
  schedule: ScheduledSession | null
  queue: QueueEntry[] | null
  /**
   * Who is really in the room, or null before the first roster.
   *
   * The names rather than a count, because the console needs both halves of
   * what a roster is for: the size of it, so the padding beside it reads as
   * what it is, and the people in it, so a mic break can say who is hearing it.
   */
  listeners: Listener[] | null
  /** Heads added to that count by whoever is running the decks. */
  padding: number
  /** The room talking, read-only; the console is not in the room. */
  messages: ChatMessage[]
  /**
   * Whether this station is talking over its own music, and how far the music
   * sits under it. Null until the first frame.
   *
   * Arrives on the socket like everything else here rather than being kept by
   * the card, so a mic opened from a second tab moves this one too, and so the
   * console is ducking against exactly the number every listener was sent.
   */
  mic: MicSnapshot | null
  /**
   * Who, besides this console, is on the mic — and who has just been asked up.
   * Null until the first frame.
   *
   * On the socket like the mic beside it, and for the same reason: a guest
   * brought up from a second tab moves this one too.
   */
  floor: FloorSnapshot | null
  /**
   * Who is co-hosting. Null until the first frame.
   *
   * On the socket like the floor beside it, and for the same reason: a co-host
   * who sat down while this tab was elsewhere still has to appear on it.
   */
  coHost: CoHostSnapshot | null
  /** How long one record overlaps the next. Null until the first frame. */
  transition: TransitionSnapshot | null
  /**
   * Who has asked for the mic, oldest first.
   *
   * The one thing on this panel the room is never sent. A raised hand is a
   * request addressed to whoever runs the decks, like a wish, and putting the
   * queue in front of everybody would be a social cost paid by the shyest
   * person in the room.
   */
  hands: Listener[]
  /** The socket, for signalling. Commands still go over HTTP. */
  connection: StationConnection | null
  /** This console's own id, so it never offers itself a microphone. */
  me: number | null
  /**
   * Signed in, but the station does not see this socket as the decks.
   *
   * Which means no listener can be offered a voice, on a console where
   * everything else works. Said out loud because it is otherwise invisible.
   */
  deaf: boolean
  /** How to reach another browser, or null until `/api/rtc` has answered. */
  iceServers: RTCIceServer[] | null
  /** Read the socket. This page can be both ends of a voice; see App. */
  subscribe(reader: (message: ServerMessage) => void): () => void
  /**
   * The station's clock, for the scrub bar. The console reads a position out of
   * `startedAt`, which is a point on the *server's* clock, so subtracting this
   * browser's `Date.now()` from it would put the needle wherever the two
   * machines happen to disagree.
   */
  serverNow(): number
  /**
   * Held by App rather than by this panel, because the top bar needs it too:
   * the way to the console is shown only to a browser that is already signed
   * in, so a listener is never offered a door they cannot open.
   */
  session: AdminSession
  status: StationStatus
  /** Fold a command's own answer straight in; see useStation. */
  applyState(snapshot: PlaybackSnapshot): void
  applyQueue(entries: QueueEntry[]): void
  applyPadding(count: number): void
  applyAir(snapshot: AirSnapshot): void
  applySchedule(next: ScheduledSession | null): void
  applyMic(snapshot: MicSnapshot): void
  /** Fold in what `POST /api/floor` just answered. See `applyState`. */
  applyFloor(snapshot: FloorSnapshot): void
  /** Fold in what `POST /api/cohost/seat` just answered. See `applyState`. */
  applyCoHost(snapshot: CoHostSnapshot): void
  /** Fold in what `POST /api/transition` just answered. See `applyState`. */
  applyTransition(snapshot: TransitionSnapshot): void
}

/**
 * The decks, for whoever runs the station.
 *
 * Reachable only at #admin and only once the server has accepted a session, so
 * the listener page ships no controls, though the gate that matters is the one
 * on the server, since a hidden button is not a permission.
 *
 * Nothing here holds playback or queue state: both arrive over the websocket
 * the listener already has open, so a command issued from another tab, or a
 * track ending on its own, moves this panel too.
 */
export function AdminPanel({
  state,
  air,
  schedule,
  queue,
  listeners,
  padding,
  messages,
  mic,
  connection,
  me,
  deaf,
  iceServers,
  subscribe,
  serverNow,
  session,
  status,
  applyState,
  applyQueue,
  applyPadding,
  applyAir,
  applySchedule,
  applyMic,
  floor,
  coHost,
  transition,
  hands,
  applyFloor,
  applyCoHost,
  applyTransition,
}: AdminPanelProps) {
  const { status: signedIn, api, error: sessionError, signIn, signOut } = session

  if (signedIn === 'checking') {
    return (
      <section className="console" data-testid="admin-panel">
        <p className="console__note">checking credentials…</p>
      </section>
    )
  }

  if (signedIn !== 'signed-in' || !api) {
    return <SignIn onSubmit={signIn} error={sessionError} />
  }

  return (
    <Controls
      api={api}
      state={state}
      air={air}
      schedule={schedule}
      queue={queue}
      listeners={listeners}
      padding={padding}
      messages={messages}
      mic={mic}
      floor={floor}
      coHost={coHost}
      transition={transition}
      hands={hands}
      applyCoHost={applyCoHost}
      applyTransition={applyTransition}
      connection={connection}
      me={me}
      deaf={deaf}
      iceServers={iceServers}
      subscribe={subscribe}
      serverNow={serverNow}
      connected={status === 'connected'}
      applyState={applyState}
      applyQueue={applyQueue}
      applyPadding={applyPadding}
      applyAir={applyAir}
      applySchedule={applySchedule}
      applyMic={applyMic}
      applyFloor={applyFloor}
      onSignOut={signOut}
    />
  )
}

/**
 * The door.
 *
 * Deliberately the whole console until it is answered: there is nothing behind
 * it worth showing in outline, and a greyed-out set of controls would only
 * suggest the password was the last thing standing between a stranger and the
 * decks. It is not: the server refuses every one of these calls without a
 * session, whatever this page renders.
 */
function SignIn({
  onSubmit,
  error,
}: {
  onSubmit: (password: string) => Promise<boolean>
  error: string | null
}) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    const accepted = await onSubmit(password)
    setSubmitting(false)
    if (accepted) setPassword('')
  }

  return (
    <section className="console console--gate" data-testid="admin-signin">
      <div className="gate">
        <h1 className="console__title">Broadcast Console</h1>
        <p className="console__blurb">
          Whoever runs the decks, this is the way in. Not the door code; this is
          the other one.
        </p>
        <form className="gate__form" onSubmit={submit}>
          <input
            type="password"
            className="gate__input"
            placeholder="admin password"
            aria-label="Admin password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            data-testid="admin-password"
          />
          <button type="submit" className="button" disabled={submitting || !password}>
            Sign in
          </button>
        </form>
        {error && (
          <p className="console__error" data-testid="admin-error">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

/** How often the panel asks for the wish book while it is open. */
const WISH_POLL_MS = 10_000

interface ControlsProps {
  api: AdminApi
  state: StateMessage | null
  air: AirSnapshot | null
  schedule: ScheduledSession | null
  queue: QueueEntry[] | null
  listeners: Listener[] | null
  padding: number
  messages: ChatMessage[]
  mic: MicSnapshot | null
  floor: FloorSnapshot | null
  coHost: CoHostSnapshot | null
  transition: TransitionSnapshot | null
  hands: Listener[]
  applyCoHost(snapshot: CoHostSnapshot): void
  applyTransition(snapshot: TransitionSnapshot): void
  connection: StationConnection | null
  me: number | null
  /**
   * Signed in, but the station does not see this socket as the decks.
   *
   * Which means no listener can be offered a voice, on a console where
   * everything else works. Said out loud because it is otherwise invisible.
   */
  deaf: boolean
  iceServers: RTCIceServer[] | null
  subscribe(reader: (message: ServerMessage) => void): () => void
  serverNow(): number
  connected: boolean
  applyState(snapshot: PlaybackSnapshot): void
  applyQueue(entries: QueueEntry[]): void
  applyPadding(count: number): void
  applyAir(snapshot: AirSnapshot): void
  applySchedule(next: ScheduledSession | null): void
  applyMic(snapshot: MicSnapshot): void
  applyFloor(snapshot: FloorSnapshot): void
  onSignOut: () => void
}

function Controls({
  api,
  state,
  air,
  schedule,
  queue,
  listeners,
  padding,
  messages,
  mic,
  floor,
  coHost,
  transition,
  hands,
  applyCoHost,
  applyTransition,
  connection,
  me,
  deaf,
  iceServers,
  subscribe,
  serverNow,
  connected,
  applyState,
  applyQueue,
  applyPadding,
  applyAir,
  applySchedule,
  applyMic,
  applyFloor,
  onSignOut,
}: ControlsProps) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [book, setBook] = useState<WishBook>({ wishes: [], outstanding: 0 })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploads, setUploads] = useState<{ id: number; line: string }[]>([])
  // Held here rather than arriving on the socket: who has been muted is
  // admin-only, so it is never broadcast. See routes/mutes.ts.
  const [muted, setMuted] = useState<string[]>([])
  /**
   * What goes out, and to whom.
   *
   * Owned by the console rather than by the mic card, and that is the point of
   * it: the buses outlive any one microphone, so changing input device rebuilds
   * the rig without the room's connections noticing, and a guest can be on air
   * through a console whose own microphone was never opened.
   */
  const mixer = useAirMixer()

  const refreshLibrary = useCallback(async () => {
    try {
      setTracks(await api.tracks())
    } catch {
      setError('could not load the library')
    }
  }, [api])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  // Once, on open. A mute only changes because somebody on this panel changed
  // it, and the answer to that request carries the new list, so there is
  // nothing for a poll to discover.
  useEffect(() => {
    void (async () => {
      try {
        setMuted(await api.mutes())
      } catch {
        // Not worth a banner. The controls still work; the worst case is a
        // button that says "Mute" about somebody already muted, and pressing
        // it answers with the truth.
      }
    })()
  }, [api])

  /**
   * Not through `run`: this fires on a timer, and a poll that set `busy` would
   * flicker every control on the panel twice a minute. A lapsed session still
   * has to end the same way it does everywhere else, though: the poll is the
   * one request here that happens without the admin touching anything, so it is
   * also the first thing to notice.
   */
  const refreshWishes = useCallback(async () => {
    try {
      setBook(await api.wishes())
    } catch (err) {
      if (err instanceof AdminError && err.unauthorized) return onSignOut()
      setError('could not load the wishes')
    }
  }, [api, onSignOut])

  /**
   * Polled, because a wish arrives over a socket that carries no privileged
   * frames: the gate is on HTTP, and the station deliberately tells a socket
   * holding an admin cookie nothing it would not tell a stranger. So the panel
   * asks, rather than the station pushing. Ten seconds is well inside how long
   * a track lasts, which is the pace anyone is actually working at.
   */
  useEffect(() => {
    void refreshWishes()
    const timer = window.setInterval(() => void refreshWishes(), WISH_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshWishes])

  /**
   * Every control goes through here. A 401 means the session stopped being
   * accepted (it lapsed, or the server restarted with a different password),
   * and the only honest response is to put the sign-in form back rather than
   * let the admin keep pressing buttons that quietly do nothing.
   */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await action()
      } catch (err) {
        if (err instanceof AdminError && err.unauthorized) {
          onSignOut()
          return
        }
        setError(err instanceof Error ? err.message : 'something went wrong')
      } finally {
        setBusy(false)
      }
    },
    [onSignOut],
  )

  // Both fold the server's answer straight into the station's state, so a
  // control responds to the click rather than to the broadcast that follows it.
  const command = useCallback(
    (body: PlaybackCommand) => run(async () => applyState(await api.command(body))),
    [api, applyState, run],
  )
  const queueAction = useCallback(
    (act: () => Promise<{ entries: QueueEntry[] }>) =>
      run(async () => applyQueue((await act()).entries)),
    [applyQueue, run],
  )
  const setAir = useCallback(
    (action: 'start' | 'end', kind?: SessionKind) =>
      run(async () => applyAir(await api.session(action, kind))),
    [api, applyAir, run],
  )
  const mute = useCallback(
    (nickname: string, muting: boolean) =>
      run(async () => setMuted(await api.mute(nickname, muting))),
    [api, run],
  )
  // Folded straight in like a playback command, and for the same reason: the
  // broadcast that follows carries the identical number, so the button responds
  // to the press rather than to the round trip.
  const setPadding = useCallback(
    (count: number) => run(async () => applyPadding(await api.setPadding(count))),
    [api, applyPadding, run],
  )

  /**
   * The mic, deliberately not through `run`.
   *
   * Everything else on this panel is a click that can afford to grey the
   * console for a round trip. The mic is held down, renewed every few seconds
   * while it is, and released again: a talk button that set `busy` would
   * flicker every other control three times a sentence. The 401 still has to be
   * caught, because a lapsed session must end the same way everywhere.
   */
  const micAction = useCallback(
    async (act: () => Promise<MicSnapshot>) => {
      try {
        applyMic(await act())
      } catch (err) {
        if (err instanceof AdminError && err.unauthorized) return onSignOut()
        setError(err instanceof Error ? err.message : 'the mic did not answer')
      }
    },
    [applyMic, onSignOut],
  )

  const openMic = useCallback(() => void micAction(() => api.mic('open')), [api, micAction])
  const closeMic = useCallback(() => void micAction(() => api.mic('close')), [api, micAction])
  const renewMic = useCallback(() => void micAction(() => api.mic('renew')), [api, micAction])
  const setDuck = useCallback(
    (to: number) => void micAction(() => api.duck(to)),
    [api, micAction],
  )

  /**
   * Bringing somebody up, and standing them down.
   *
   * Through `micAction` rather than `run`, and for its reason rather than its
   * own: this is the one control on the panel that gets pressed while a record
   * is ending, and greying out the transport for a round trip because somebody
   * put their hand up would be the console taking itself away at the worst
   * moment. Standing a guest down has the sharper version of the same argument.
   */
  const floorAction = useCallback(
    async (act: () => Promise<FloorSnapshot>) => {
      try {
        applyFloor(await act())
      } catch (err) {
        if (err instanceof AdminError && err.unauthorized) return onSignOut()
        setError(err instanceof Error ? err.message : 'the floor did not answer')
      }
    },
    [applyFloor, onSignOut],
  )

  const bringUp = useCallback(
    (listener: number) => {
      // Build the buses here, if nothing has yet.
      //
      // This is a gesture and the guest's acceptance is not, which is the whole
      // reason it happens on this click rather than when they come up: an audio
      // context starts suspended and only a gesture may resume one, so a mixer
      // built a moment later would be a graph nothing can wake. It is also the
      // second of the two doors into `ensure` — the first is opening the
      // microphone — and before this existed there was no bus at all unless
      // somebody had granted one, which meant a guest could be on air with no
      // connections to carry them.
      mixer.ensure()
      void floorAction(() => api.floor('invite', listener))
    },
    [api, floorAction, mixer],
  )
  const standDown = useCallback(
    () => void floorAction(() => api.floor('drop')),
    [api, floorAction],
  )

  /**
   * The dump button, as much of one as this station can have.
   *
   * Real radio runs seven seconds behind and drops the last seven when
   * something is said that should not have been. That is not available here:
   * the music is aligned to a server clock and the voice is live, so delaying
   * the voice would put every cue seven seconds late over a record that did not
   * wait, and delaying everything means delaying the clock, which is the
   * project.
   *
   * So the honest substitute is speed. The fader goes to zero in the same frame
   * the key goes down — client side, no round trip, nothing to wait for — and
   * the rest follows: the connection closes, and the station is told. It cannot
   * un-say the word. It can stop the second one, and that is the whole of what
   * is on offer.
   */
  const cut = useCallback(() => {
    if (!floor?.speaker) return
    mixer.mixer?.cut()
    void floorAction(() => api.floor('drop'))
  }, [api, floor?.speaker, floorAction, mixer.mixer])

  const report = (line: string) => setUploads((seen) => [...seen, { id: seen.length, line }])

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      // One file per request is what the endpoint takes, and uploading in
      // sequence keeps the report in the order the admin picked them.
      for (const file of files) {
        try {
          const { track: uploaded, duplicate } = await api.upload(file)
          report(`${uploaded.title}: ${duplicate ? 'already in the library' : 'uploaded'}`)
        } catch (err) {
          if (err instanceof AdminError && err.unauthorized) return onSignOut()
          report(`${file.name}: ${err instanceof Error ? err.message : 'failed'}`)
        }
      }
      await refreshLibrary()
    },
    [api, onSignOut, refreshLibrary],
  )

  const track = state?.track ?? null
  const paused = state !== null && state.pausedAt !== null
  const entries = queue ?? []

  return (
    <section className="console console--desk" data-testid="admin-panel">
      <header className="console__head">
        <div className="console__ident">
          <h1 className="console__title">Broadcast Console</h1>
          <p className="console__blurb">
            Upload tracks, arrange the queue, and keep an eye on the room.
          </p>
        </div>
        <div className="console__actions">
          <Headcount roster={listeners?.length ?? null} padding={padding} busy={busy} onSet={setPadding} />
          <OnAirSwitch air={air} busy={busy} onSet={setAir} />
          <ShareInvite api={api} />
          <button type="button" className="button button--quiet" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {(error || !connected) && (
        <div className="console__banners">
          {error && (
            <p className="console__error" data-testid="admin-error">
              {error}
            </p>
          )}

          {/* Commands go over HTTP and still land while the socket is down, but
              what the panel shows arrives on the socket, so say so rather than
              quietly showing a queue that may have moved on. */}
          {!connected && (
            <p className="console__note" data-testid="admin-offline">
              reconnecting; what's shown here may be out of date
            </p>
          )}
        </div>
      )}

      {/* Three columns, and the split is the work rather than the components:
          what this machine is doing (the mic, and the night after this one),
          what is going out (the decks, and everything they can reach for), and
          who it is going out to. Each one scrolls inside itself, so the desk is
          a screen you look at rather than a page you scroll: the talk button
          and the transport are never below the fold while you read the room. */}
      <div className="console__columns">
        <div className="console__column console__column--desk">
          {/* First, because it is the one control here that is held rather than
              clicked, and the one that is reached for without looking. */}
          <MicCard
            mic={mic}
            air={air}
            connection={connection}
            me={me}
            deaf={deaf}
            listeners={listeners}
            iceServers={iceServers}
            subscribe={subscribe}
            mixer={mixer}
            floor={floor}
            coHost={coHost}
            onCut={cut}
            onOpen={openMic}
            onClose={closeMic}
            onRenew={renewMic}
            onDuck={setDuck}
          />
          {/* Under the mic, because it is the same control surface: who is
              talking over the music, and whether it is you. */}
          <FloorCard
            floor={floor}
            hands={hands}
            air={air}
            onBringUp={bringUp}
            onStandDown={standDown}
          />
          {/* And beside it, the other person who can be on the air: not a
              listener you brought up for a minute but somebody running half of
              the night from a phone. Same column because it is the same
              question — whose voice is going out — and its own card because
              everything about how they got there is different. */}
          <CoHostCard
            api={api}
            coHost={coHost}
            transition={transition}
            busy={busy}
            onStandDown={() => run(async () => applyCoHost(await api.dropCoHost()))}
            onBlend={(blendMs) => run(async () => applyTransition(await api.blend(blendMs)))}
          />
          {/* Last in this column, and deliberately. Everything else on the
              panel drives a broadcast that is happening or is about to; this is
              about a night that has not, and it is the one thing here nobody
              needs to reach during a set. */}
          <ScheduleCard
            schedule={schedule}
            busy={busy}
            onAnnounce={(startsAt, poster, said) =>
              run(async () => applySchedule(await api.announce(startsAt, poster, said)))
            }
            onTakeDown={() => run(async () => applySchedule(await api.unannounce()))}
          />
        </div>

        <div className="console__column console__column--air">
          <QueueCard
            entries={entries}
            state={state}
            track={track}
            paused={paused}
            busy={busy}
            serverNow={serverNow}
            command={command}
            queueAction={queueAction}
            api={api}
          />
          {/* The library takes whatever height is left, and the drop zone sits
              on it as a header rather than as the widest thing on the page:
              uploading is the rarest thing anybody does here and it had been
              given the best real estate on the desk. */}
          <LibraryCard
            tracks={tracks}
            busy={busy}
            onQueue={(id) => queueAction(() => api.enqueue(id))}
            onPlay={(id) => command({ action: 'play', trackId: id })}
            onFiles={upload}
            uploads={uploads}
          />
        </div>

        <div className="console__column console__column--room">
          {/* Above the room, and beside the library: a wish is read here and
              answered by queueing something from the column to the left. */}
          <WishesCard book={book} busy={busy} onMark={(id, status) =>
            run(async () => setBook(await api.markWish(id, status)))
          } />
          <CommentsCard messages={messages} muted={muted} busy={busy} onMute={mute} />
        </div>
      </div>
    </section>
  )
}


/** The talk key. A letter, and not the spacebar; see the note in `MicCard`. */
const TALK_KEY = 'm'

/**
 * The cut, on shift and a letter.
 *
 * Not a bare key, because the thing it does cannot be undone and the console is
 * a page somebody types on. Not a modifier the browser has an opinion about
 * either: ctrl and meta are full of shortcuts that would fire alongside it.
 */
const CUT_KEY = 'x'

/** How far the music drops, in dB, for a slider that speaks a radio language. */
const decibels = (gain: number) => Math.round(20 * Math.log10(gain))

/**
 * The mic.
 *
 * What this card does *not* do is carry any sound: the station holds no mixer
 * and this sends no audio. Pressing talk tells the station the mic is open, and
 * every listener's browser turns down the copy of the track it is already
 * playing. The duck lands everywhere at once, on the clock the room already
 * shares, and it costs the station nothing — which is why it works before there
 * is any voice to put over it, and would keep working for a listener whose
 * voice connection had failed.
 *
 * Two ways to hold it, because they are for different things. Push-to-talk is
 * what anyone actually reaches for: hold the button, or hold the key, and let
 * go. Latch is for a long segment where holding something down would be absurd.
 *
 * Held, not toggled, is the safer default in the way that matters: the failure
 * mode of a toggle is a mic left open over a record while you talk to someone
 * in the room.
 */
function MicCard({
  mic,
  air,
  connection,
  me,
  deaf,
  listeners,
  iceServers,
  subscribe,
  mixer,
  floor,
  coHost,
  onCut,
  onOpen,
  onClose,
  onRenew,
  onDuck,
}: {
  mic: MicSnapshot | null
  air: AirSnapshot | null
  connection: StationConnection | null
  me: number | null
  /**
   * Signed in, but the station does not see this socket as the decks.
   *
   * Which means no listener can be offered a voice, on a console where
   * everything else works. Said out loud because it is otherwise invisible.
   */
  deaf: boolean
  listeners: Listener[] | null
  iceServers: RTCIceServer[] | null
  subscribe(reader: (message: ServerMessage) => void): () => void
  /**
   * What goes out, and to whom. Held by the console rather than by this card,
   * because it outlives any one microphone: see `useAirMixer`.
   */
  mixer: AirMixerHandle
  /** Who else is talking, which is the other reason the mesh comes up. */
  floor: FloorSnapshot | null
  /** And who is co-hosting, who is the other person sending a voice up here. */
  coHost: CoHostSnapshot | null
  /** Take the guest off the air now, and stand them down. See `cut`. */
  onCut(): void
  onOpen(): void
  onClose(): void
  onRenew(): void
  onDuck(to: number): void
}) {
  const [held, setHeld] = useState(false)
  const [latched, setLatched] = useState(false)
  // The microphone itself, which at this stage feeds a meter and a pair of
  // headphones and nothing else. See `useMicInput`, and `SoundCheck` below for
  // why it is worth having before there is anywhere for the voice to go.
  const input = useMicInput(mixer)

  /**
   * Whether there is anything of this console's on the bus.
   *
   * The mesh comes up for this and goes down without it. It used to be "the
   * microphone is open", which was the same thing right up until a listener
   * could be brought up: a guest talking while whoever runs the decks says
   * nothing is a broadcast with no microphone in it, and a room with no
   * connections to carry it.
   *
   * Deliberately not "always, while on air". Warm connections all evening would
   * save the second of negotiation at the start of every break, and would also
   * hold a relay allocation open per listener who needs one, all night, for
   * silence. Today's rule is the cheaper one; this only widens it by a guest.
   */
  const sending = input.live || floor?.speaker != null

  /**
   * The voice, out to the room.
   *
   * One connection per listener, held open for as long as the microphone is,
   * rather than built when somebody starts talking: negotiating takes a second
   * or two, and doing it on the talk button would lose the beginning of every
   * break — the part with the greeting in it. What opens and closes with the
   * button is a gain node inside `useMicInput`, which is instant.
   */
  // Everybody on the roster but this browser. Whoever runs the station is
  // usually tuned in as well, and a console that called itself would spend the
  // evening negotiating with its own microphone.
  //
  // Empty off air, which takes every connection down with it: the sound check
  // still works for setting a level between broadcasts, but a room that is not
  // being broadcast to has no business holding a path to a live microphone.
  const room = useMemo(
    () => (air?.live ? (listeners ?? []).filter((listener) => listener.id !== me) : []),
    [air?.live, listeners, me],
  )
  const targets = useMemo(() => room.map((listener) => listener.id), [room])

  /**
   * Whether the guest is in your headphones.
   *
   * On by default, because bringing somebody up is already the decision to talk
   * to them, and a console that made you press a second button before you could
   * hear the person you had just invited would be a console arguing with you.
   * Off is for the times you want them warm on the line and out of your ears.
   *
   * Pre-fade listen, in a studio. Here it is which node is connected, and it
   * reaches your headphones and nothing else — auditioning a caller must never
   * be broadcasting them.
   */
  const [cueing, setCueing] = useState(true)
  /**
   * How loud the guest is in the room, as a linear gain.
   *
   * A fader rather than a switch, because a caller on a phone in a corridor and
   * a caller on a decent headset are not the same volume and the difference is
   * something you hear rather than something you set beforehand. It starts
   * open: they were brought up in order to be heard, and a console that put
   * somebody on air at zero would have you looking for the fault in the
   * connection.
   */
  const [guestAir, setGuestAir] = useState(1)
  /**
   * The same, for the co-host.
   *
   * Its own number rather than one fader for both, because they are two people
   * on two devices: a partner on a phone in a kitchen and a caller on a headset
   * are not the same volume, and one control would mean fixing either of them
   * by breaking the other.
   */
  const [coHostAir, setCoHostAir] = useState(1)

  /**
   * Everybody who should be sending a voice up to this console.
   *
   * Two routes into the same list, and they could not be more different: one
   * was invited after asking, one arrived holding a key and sat down. From here
   * they are the same thing — a second connection to somebody already on the
   * roster, going the other way — which is exactly why the hook takes a list
   * rather than a floor and a seat.
   */
  const voices = useMemo(
    () =>
      [floor?.speaker?.id, coHost?.seat?.id].filter(
        (id): id is number => typeof id === 'number',
      ),
    [floor?.speaker?.id, coHost?.seat?.id],
  )

  /**
   * Every voice arriving, kept, so it can be put in a mixer built afterwards.
   *
   * A stream arrives exactly once — `ontrack` fires when the negotiation
   * completes and never again — so anything not connected at that instant is
   * lost for the rest of the call. Until there was a co-host that could not
   * happen: a guest is *invited*, and inviting one is a click that builds the
   * mixer before the offer even goes out.
   *
   * A co-host seats themselves. Nothing on this console decides when, so their
   * voice can and does arrive before whoever runs the decks has opened a
   * microphone — and the failure is the worst shape one can take, because every
   * instrument says the call is fine: the connection is `connected`, the
   * console's own health column says *you can hear them*, their meter is moving
   * on their phone, and the room hears silence.
   */
  const heldVoices = useRef(new Map<number, MediaStream>())

  /**
   * Put whatever has already arrived into a mixer that has just been built.
   *
   * The other half of `heldVoices`. Also covers the reverse order, which is the
   * ordinary one: a mixer that already existed when the voice turned up simply
   * re-applies the same stream, and `hear` replaces a source with itself.
   */
  useEffect(() => {
    const engine = mixer.mixer
    if (!engine) return
    for (const [id, stream] of heldVoices.current) engine.hear(id, stream)
  }, [mixer.mixer])

  /**
   * A seat taken is a reason to build the buses, whether or not the microphone
   * is open.
   *
   * A co-host can be the only person talking all evening — whoever runs the
   * decks may never open their own mic — and without this the room would have
   * no bus to hear them on. `ensure` is safe to call again and cheap after the
   * first time.
   *
   * Outside a gesture, which is the one thing that is not ideal: a context
   * built here starts suspended, and only a gesture may resume one. It is still
   * strictly better than no context at all — every other control on this panel
   * is a click, so one usually arrives within seconds — and `resume` is called
   * from all of them.
   */
  useEffect(() => {
    if (voices.length === 0) return
    mixer.ensure()?.resume()
  }, [voices.length, mixer])

  /** Which fader belongs to which of them. */
  const levelFor = useCallback(
    (id: number) => (id === coHost?.seat?.id ? coHostAir : guestAir),
    [coHost?.seat?.id, coHostAir, guestAir],
  )

  const broadcast = useVoiceBroadcast({
    connection,
    me,
    // The mixer's bus, not the microphone's: one track for the life of the
    // console, so changing input device rebuilds the rig without the room's
    // connections noticing. Null when there is nothing to send, which is what
    // takes them down.
    track: sending ? mixer.roomTrack : null,
    targets,
    iceServers,
    // A bus per voice, asked for by id at the moment there is an id to ask
    // about. Two people can be up at once — a co-host and a caller — and one
    // shared minus-bus would leave each of them unable to hear the other.
    seatTrack: useCallback(
      (id: number) => mixer.mixer?.seatTrack(id) ?? null,
      [mixer.mixer],
    ),
    voices,
    // Straight into the mixer, which wires them to your headphones and to the
    // room bus behind a fader that is shut. Wired and silent: somebody put in
    // front of thirty people by a negotiation completing would be a decision
    // nobody made.
    //
    // Remembered as well as applied, and that is not belt-and-braces — see
    // `heldVoices`, and the reason a co-host can arrive before there is a mixer
    // to put them in.
    onVoice: useCallback(
      (id: number, stream: MediaStream | null) => {
        if (stream === null) heldVoices.current.delete(id)
        else heldVoices.current.set(id, stream)
        mixer.mixer?.hear(id, stream)
      },
      [mixer.mixer],
    ),
    // The level is this card's; *when* it is applied is the hook's, because
    // only that knows whether the voice has been swapped onto the bus that does
    // not carry them yet. See the talk-channel effect.
    onAir: useCallback(
      (id: number, level: number) => mixer.mixer?.air(id, level === 0 ? 0 : levelFor(id)),
      [mixer.mixer, levelFor],
    ),
  })

  // Riding the faders while somebody is up. Only while they are: a level set
  // between calls is remembered by the mixer and applied to the next one.
  useEffect(() => {
    for (const id of voices) {
      if (broadcast.voices.get(id) === 'connected') mixer.mixer?.air(id, levelFor(id))
    }
  }, [voices, broadcast.voices, mixer.mixer, levelFor])

  // Follow the button, and re-apply whenever a voice arrives: `hear` builds a
  // voice's half of the graph on the first call, so a cue set before there was
  // anybody to apply it to has to be applied to them when they turn up.
  useEffect(() => {
    for (const id of voices) mixer.mixer?.cue(id, cueing)
  }, [cueing, voices, mixer.mixer, broadcast.voices])


  useEffect(() => subscribe(broadcast.handleMessage), [subscribe, broadcast.handleMessage])
  // What the slider shows while it is being dragged. The station's value is
  // the truth, but a fader that only moved when the round trip landed would
  // feel broken under the hand.
  const [draft, setDraft] = useState<number | null>(null)

  const live = mic?.live ?? false
  const duckTo = draft ?? mic?.duckTo ?? MIN_DUCK
  const onAir = air?.live ?? false
  /**
   * Off air is folded in here rather than only into the button, so the talk key
   * is refused by the same rule the station refuses it by. Otherwise holding it
   * with the doors shut would spend a request to be told 409 and put a refusal
   * on the console for a mistake nobody made.
   *
   * It also covers the other direction: a broadcast ended mid-sentence takes
   * the mic with it, and this is what lets go of the key on the console's side.
   */
  const wanted = (held || latched) && onAir

  // A latch left down across the end of a broadcast would put the station on
  // mic the instant it next went live, before anybody had touched anything.
  useEffect(() => {
    if (!onAir) setLatched(false)
  }, [onAir])

  /**
   * What the room can actually hear, driven by what the station says rather
   * than by the button.
   *
   * `live` is the mic state as broadcast — the same value every listener was
   * sent and ducked to. Opening the voice on the local button instead would
   * put sound on the air a round trip before anyone's music got out of its way,
   * so the first word of every break would land on top of a full-volume song.
   */
  const setTalking = input.setTalking
  useEffect(() => {
    // Both, and each is doing a different job.
    //
    // `live` is the mic state as broadcast — the same value every listener was
    // sent and ducked to — and gating on it is what stops the first word of a
    // break landing on top of a full-volume song, a round trip before anybody's
    // music got out of the way.
    //
    // `wanted` is the talk control. It used to be left out, and while nothing
    // but this card could open the mic that was the same answer: `live` became
    // true *because* the key went down. A guest changed that. The station now
    // opens the mic when somebody comes up, so a console following `live` alone
    // had an open microphone on the air for the whole of every call, whether or
    // not anybody had touched anything.
    setTalking(live && wanted)
  }, [live, wanted, setTalking])

  /**
   * Whether *this* card is the reason the mic is open.
   *
   * Not `mic.live`, which is the station's answer and can be true because
   * another tab is holding it. Without the distinction, mounting this card
   * beside an open mic would schedule a close for a break somebody else is in
   * the middle of.
   */
  const engaged = useRef(false)
  const hangover = useRef<number | null>(null)
  // Read inside a timer that fires after the fact, so it has to be a ref: what
  // matters is whether somebody is on the mic when the hangover lands, not when
  // the key came up.
  const guestUp = useRef(false)
  guestUp.current = floor?.speaker != null

  /**
   * Bringing somebody up latches the mic.
   *
   * Because bringing somebody up *is* the decision to talk to them, and because
   * the alternative is worse than it sounds: the guest hears the decks through
   * the same gain the talk key opens, so a console that did not latch would
   * leave whoever runs it holding a key for the whole of a conversation — or,
   * far more likely, wondering why the person they just invited cannot hear
   * them.
   *
   * Not un-latched when the call ends, deliberately, and for the reason
   * standing a guest down does not shut the mic: what comes next is almost
   * always "thanks, sipho", and cutting that off mid-sentence to be tidy would
   * be the station tidying up over somebody talking.
   */
  useEffect(() => {
    if (floor?.speaker) setLatched(true)
  }, [floor?.speaker])

  // Kept in refs so the effect below runs on the press and the release, and on
  // nothing else. It is what opens and shuts the mic; re-running it because a
  // callback's identity changed would reopen a mic that had just been let go.
  const handlers = useRef({ onOpen, onClose })
  useEffect(() => {
    handlers.current = { onOpen, onClose }
  })

  useEffect(() => {
    if (wanted) {
      // Re-engaging during the hangover: nothing to reopen, because the close
      // has not happened yet. Cancelling the timer is the whole of it.
      if (hangover.current !== null) {
        window.clearTimeout(hangover.current)
        hangover.current = null
      }
      if (engaged.current) return
      engaged.current = true
      handlers.current.onOpen()
      return
    }

    if (!engaged.current) return
    hangover.current = window.setTimeout(() => {
      hangover.current = null
      engaged.current = false
      // Not while somebody is on the mic. Closing it drops them — that wiring
      // is what stops a room being un-ducked with a guest still talking under
      // it — so without this, the first thing you say to a caller is also what
      // hangs up on them, four hundred milliseconds after you stop saying it.
      //
      // The station refuses it too. This is the half that keeps the console
      // from asking, so an ordinary hangover is not a refusal on the screen.
      if (guestUp.current) return
      handlers.current.onClose()
    }, MIC_HANGOVER_MS)
  }, [wanted])

  // Leaving the console mid-break must not leave the room ducked until the
  // lease lapses. Ten seconds of a quiet song is a long time to explain.
  useEffect(
    () => () => {
      if (hangover.current !== null) window.clearTimeout(hangover.current)
      if (engaged.current) handlers.current.onClose()
    },
    [],
  )

  /**
   * The lease. The station shuts a mic nobody is renewing, which is what keeps
   * a console that died mid-sentence from ducking the room for the rest of the
   * evening; this is the other half of that bargain.
   */
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(onRenew, MIC_RENEW_MS)
    return () => window.clearInterval(timer)
  }, [live, onRenew])

  /**
   * Hold `M` to talk.
   *
   * Not the spacebar, which is the obvious choice and the wrong one twice over:
   * it scrolls, and it presses whatever button happens to have focus, so the
   * key for going live would also be the key for skipping a track.
   *
   * `repeat` is ignored because a held key fires over and over, and `blur`
   * releases because a key let go after switching windows never sends its
   * keyup — which would otherwise leave the mic latched open by accident,
   * exactly the failure push-to-talk exists to prevent.
   */
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && target.closest('input, textarea, [contenteditable]') !== null

    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== TALK_KEY) return
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (typing(event.target)) return
      event.preventDefault()
      setHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== TALK_KEY) return
      setHeld(false)
    }
    const release = () => setHeld(false)

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
    }
  }, [])

  // Nothing to talk over, and the station refuses it anyway. Said rather than
  // just greyed out, so it reads as "not yet" instead of "broken".
  const shut = !onAir

  return (
    <section className="card card--mic">
      <header className="card__head">
        <h2 className="card__title">Mic</h2>
        <span className={`mic__lamp${live ? ' mic__lamp--live' : ''}`} data-testid="mic-lamp">
          {live ? 'ON MIC' : 'off'}
        </span>
      </header>

      {/* Above the button, not below it. This is the one instruction here that
          has to be read before the first press rather than after it: your own
          browser is playing the music out loud, and an open mic over speakers
          sends thirty people a smeared echo of the song they already have. */}
      <p className="mic__warn">Headphones. On speakers the mic will feed back into the room.</p>

      {/* The one failure on this card that nothing else would ever show. The
          mic opens, the room ducks, the meter moves, and not one listener can
          be offered a voice, because this browser's connection to the station
          was made before it signed in and cannot be told otherwise. */}
      {deaf && (
        <p className="mic__broken" data-testid="mic-deaf">
          This browser signed in after it connected, and reconnecting did not take.
          Reload the page: until then the mic will duck the room and nobody will
          hear you.
        </p>
      )}

      <div className="mic__controls">
        <button
          type="button"
          className={`button mic__talk${live ? ' mic__talk--live' : ''}`}
          data-testid="mic-talk"
          disabled={shut}
          // Pointer capture, so a press that slides off the button still ends
          // when the finger lifts. Without it, dragging away swallows the
          // release and the mic stays open until the lease runs out.
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            setHeld(true)
          }}
          onPointerUp={() => setHeld(false)}
          onPointerCancel={() => setHeld(false)}
        >
          {live ? 'On air — talking' : 'Hold to talk'}
        </button>

        <label className="mic__latch">
          <input
            type="checkbox"
            data-testid="mic-latch"
            checked={latched}
            disabled={shut}
            onChange={(event) => setLatched(event.target.checked)}
          />
          Latch
        </label>
      </div>

      {/* Under the button it belongs to, and only while there is something to
          show: a bar that never moves is worse than no bar, because it reads
          as a mic that is not working rather than as one that is not open. */}
      {input.status === 'live' && (
        <div className="mic__meter" data-testid="mic-meter" role="presentation">
          <div className="mic__meter-fill" ref={input.meterRef} data-clip="false" />
        </div>
      )}

      <p className="mic__hint">
        {shut ? 'Go live first; there is nothing to talk over.' : `Or hold ${TALK_KEY.toUpperCase()}.`}
      </p>

      {/* Only during a broadcast. Off air there are no connections by design,
          and a list saying so would be reporting a decision as a fault. */}
      {floor?.speaker && (
        <GuestLink
          nickname={floor.speaker.nickname}
          state={broadcast.voices.get(floor.speaker.id) ?? null}
          cueing={cueing}
          onCue={setCueing}
          air={guestAir}
          onAir={setGuestAir}
          onCut={onCut}
        />
      )}

      {/* And the co-host, on their own row with their own fader. Shown with
          the same controls because from the mixer's side they are the same
          thing, and named differently because from the room's side they are
          not: one was invited for a minute, the other is here all evening. */}
      {coHost?.seat && (
        <GuestLink
          nickname={`${coHost.seat.nickname} (co-host)`}
          state={broadcast.voices.get(coHost.seat.id) ?? null}
          cueing={cueing}
          onCue={setCueing}
          air={coHostAir}
          onAir={setCoHostAir}
          onCut={onCut}
        />
      )}

      {sending && onAir && <VoiceReach room={room} peers={broadcast.peers} />}

      <label className="mic__duck">
        <span className="mic__duck-label">
          Music under the mic
          <em data-testid="mic-duck-db">{decibels(duckTo)} dB</em>
        </span>
        <input
          type="range"
          data-testid="mic-duck"
          min={Math.round(MIN_DUCK * 100)}
          max={100}
          value={Math.round(duckTo * 100)}
          // Moves under the hand, commits on release. One request instead of
          // forty, and forty broadcasts to the room instead of one.
          onChange={(event) => setDraft(Number(event.target.value) / 100)}
          onPointerUp={() => {
            if (draft !== null) onDuck(draft)
            setDraft(null)
          }}
          onKeyUp={() => {
            if (draft !== null) onDuck(draft)
            setDraft(null)
          }}
          onBlur={() => {
            if (draft !== null) onDuck(draft)
            setDraft(null)
          }}
        />
      </label>

      <SoundCheck input={input} />
    </section>
  )
}

interface FloorCardProps {
  floor: FloorSnapshot | null
  /** Who has asked, oldest first. The room is never sent this. */
  hands: Listener[]
  air: AirSnapshot | null
  onBringUp(listener: number): void
  onStandDown(): void
}

/**
 * Who else gets to talk.
 *
 * The list here is the one thing on this panel that nobody else on the station
 * can see, and that is deliberate rather than incidental: a raised hand is a
 * request addressed to whoever runs the decks, exactly like a wish, and a queue
 * the room could see would be a social cost paid by the shyest person in it and
 * a thing people get nagged about.
 *
 * There is no way to put somebody on air who did not ask for it. The station
 * refuses an id with no hand up, so this card can only ever answer a request —
 * which is what makes an invitation a reply rather than a summons, and is why
 * there is no roster to pick from here.
 *
 * Standing somebody down is one button whatever state they are in: *never mind*
 * while an invitation is out, *stand down* once they are up. That is what lets
 * it be the control reached for in a hurry without first having to work out
 * which of two things is happening.
 */
function FloorCard({ floor, hands, air, onBringUp, onStandDown }: FloorCardProps) {
  const onAir = air?.live ?? false
  const speaker = floor?.speaker ?? null
  const invited = floor?.invited ?? null

  return (
    <section className="card card--floor" data-testid="floor-card">
      <header className="card__head">
        <h2 className="card__title">Callers</h2>
      </header>

      {speaker ? (
        <div className="floor__up" data-testid="floor-speaker">
          <span className="floor__who">{speaker.nickname} has the mic</span>
          <button type="button" className="button" onClick={onStandDown}>
            Stand down
          </button>
        </div>
      ) : invited ? (
        <div className="floor__up" data-testid="floor-invited">
          <span className="floor__who">{invited.nickname} — asked up, waiting</span>
          <button type="button" className="button" onClick={onStandDown}>
            Never mind
          </button>
        </div>
      ) : hands.length === 0 ? (
        <p className="card__empty" data-testid="floor-empty">
          {onAir ? 'Nobody has asked for the mic.' : 'Off air. Nobody can ask.'}
        </p>
      ) : (
        <ul className="floor__hands" data-testid="floor-hands">
          {hands.map((listener) => (
            <li key={listener.id} className="floor__hand">
              <span className="floor__who">{listener.nickname}</span>
              <button
                type="button"
                className="button"
                data-testid={`bring-up-${listener.id}`}
                onClick={() => onBringUp(listener.id)}
                disabled={!onAir}
              >
                Bring up
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Whether you can hear the guest, which is not the same question as whether
 * they can hear you.
 *
 * Two connections, two failures, two fixes. The reach list below answers "who
 * can hear me"; this answers "can I hear them", and keeping them apart is the
 * difference between somebody looking at the right end of a call and somebody
 * looking at the wrong one. It sits above the list because there is one of it
 * and thirty of those.
 *
 * The cue is here rather than on the floor card for the same reason: that card
 * is about permission, and this is about audio.
 */
function GuestLink({
  nickname,
  state,
  cueing,
  onCue,
  air,
  onAir,
  onCut,
}: {
  nickname: string
  state: PeerHealth | null
  cueing: boolean
  onCue(on: boolean): void
  air: number
  onAir(level: number): void
  onCut(): void
}) {
  const health = HEALTH[state ?? PENDING]

  // The cut, on a key, because the whole of its value is being faster than
  // reaching for a mouse. Held to one letter with a modifier: it must not be
  // reachable by accident, and it must not need looking for.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== CUT_KEY || !event.shiftKey) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, [contenteditable]') !== null
      ) {
        return
      }
      event.preventDefault()
      onCut()
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [onCut])
  return (
    <div className="guest" data-testid="guest-link" data-state={state ?? PENDING}>
      <div className="guest__row">
        <span className={`reach__dot reach__dot--${health.tone}`} aria-hidden="true" />
        <span className="guest__who">{nickname}</span>
        <span className="guest__state">
          {state === 'connected' ? 'you can hear them' : health.label}
        </span>
      </div>
      <label className="guest__cue">
        <input
          type="checkbox"
          data-testid="guest-cue"
          checked={cueing}
          onChange={(event) => onCue(event.target.checked)}
        />
        In my headphones
      </label>

      <label className="guest__fader">
        <span className="guest__fader-label">
          In the room
          <em data-testid="guest-air">{air === 0 ? 'off' : `${Math.round(air * 100)}%`}</em>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={air}
          data-testid="guest-air-fader"
          onChange={(event) => onAir(Number(event.target.value))}
        />
      </label>

      {/* Sharp, and next to a polite one, so the sharp one stays sharp. This
          takes the guest off the room bus in the same frame it is pressed —
          client side, no round trip — and then stands them down. */}
      <button
        type="button"
        className="button button--danger guest__cut"
        data-testid="guest-cut"
        onClick={onCut}
      >
        Cut ({CUT_KEY.toUpperCase()})
      </button>
    </div>
  )
}

/** Who can actually hear the mic. See `lib/reach.ts` for why this exists. */
function VoiceReach({ room, peers }: { room: Listener[]; peers: PeerState[] }) {
  const rows = orderByHealth(room, peers)
  const hearing = hearingCount(rows)

  if (room.length === 0) {
    return (
      <p className="reach__none" data-testid="mic-reach">
        Nobody is tuned in yet.
      </p>
    )
  }

  return (
    <div className="reach" data-testid="mic-reach">
      <p className="reach__summary">
        {hearing} of {room.length} hearing you
      </p>
      <ul className="reach__list">
        {rows.map(({ listener, state }) => (
          <li key={listener.id} className="reach__row" data-state={state}>
            <span className={`reach__dot reach__dot--${HEALTH[state].tone}`} aria-hidden="true" />
            <span className="reach__who">{listener.nickname}</span>
            <span className="reach__state">{HEALTH[state].label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The microphone, before there is anywhere for it to go.
 *
 * Nothing here reaches a listener, and the card says so, because a set of mic
 * controls that quietly did nothing would be the most confusing thing on this
 * page. What it is for is the half of the problem that can be solved alone: is
 * the browser giving up the microphone, is it the right microphone, and is the
 * level somewhere sensible. Meeting that separately from "the connection will
 * not establish" is the reason it is its own milestone.
 *
 * The mic is off until asked for, and asking is a button rather than something
 * that happens on open. A console that grabbed the microphone the moment it
 * loaded would put the browser's recording light on for the whole evening,
 * including the parts spent queueing records.
 */
function SoundCheck({ input }: { input: MicInput }) {
  const { status, error, devices, deviceId, onSpeakers, monitoring } = input
  const live = status === 'live'

  return (
    <div className="soundcheck">
      <div className="soundcheck__head">
        <h3 className="soundcheck__title">Sound check</h3>
        <button
          type="button"
          className="button button--quiet soundcheck__power"
          data-testid="mic-power"
          disabled={status === 'asking'}
          onClick={() => (live ? input.close() : input.open())}
        >
          {status === 'asking' ? 'asking…' : live ? 'Turn mic off' : 'Turn mic on'}
        </button>
      </div>

      {error && (
        <p className="soundcheck__error" data-testid="mic-error">
          {error}
        </p>
      )}

      <label className="soundcheck__row">
        <span>Input</span>
        <select
          data-testid="mic-device"
          value={deviceId ?? ''}
          onChange={(event) => input.choose(event.target.value === '' ? null : event.target.value)}
        >
          {/* First, and the default, because "whatever the system is pointed
              at" is usually the right answer and survives a device being
              unplugged. */}
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <label className="soundcheck__check">
        <input
          type="checkbox"
          data-testid="mic-speakers"
          checked={onSpeakers}
          onChange={(event) => input.setOnSpeakers(event.target.checked)}
        />
        {/* This is a constraints switch wearing a plain-English label. On
            headphones echo cancellation is off, which is a noticeably better
            voice; on speakers it goes back on and does real work. */}
        I'm on speakers
      </label>

      <label className="soundcheck__check">
        <input
          type="checkbox"
          data-testid="mic-monitor"
          checked={monitoring}
          // Monitoring into a speaker while a microphone is open is a feedback
          // loop with nothing between the two ends of it. Refused rather than
          // warned about: the failure is instant, loud, and in everybody's ears.
          disabled={!live || onSpeakers}
          onChange={(event) => input.setMonitoring(event.target.checked)}
        />
        Hear myself
        {onSpeakers && <em className="soundcheck__why">— not on speakers</em>}
      </label>

      <p className="soundcheck__note">
        The mic stays open while this is on, and the room only hears you while
        the talk button is down.
      </p>
    </div>
  )
}

/**
 * The headcount, and the one control on this panel that changes what the room
 * is told rather than what it hears.
 *
 * The number on the buttons is the total the top bar shows every listener: the
 * people actually here, plus whatever has been added on top. Both halves are
 * spelled out under it, because this is the only page where they are separable,
 * and a console that showed one figure would let whoever runs the station lose
 * track of how much of tonight's crowd is real.
 *
 * Minus stops at nothing added, not at nobody listening: the roster is not this
 * control's to touch, and there is no way from here to take a listener who is
 * really in the room off the count.
 */
function Headcount({
  roster,
  padding,
  busy,
  onSet,
}: {
  roster: number | null
  padding: number
  busy: boolean
  onSet(count: number): void
}) {
  const here = roster ?? 0
  const total = here + padding

  return (
    <div className="headpad" role="group" aria-label="Listeners on the headcount">
      <div className="headpad__row">
        <button
          type="button"
          className="headpad__step"
          data-testid="padding-down"
          aria-label="One fewer on the headcount"
          disabled={busy || padding === 0}
          onClick={() => onSet(padding - 1)}
        >
          −
        </button>
        <span className="headpad__count" data-testid="padding-count">
          <img src={usersIcon} alt="" width={14} height={14} />
          {total.toLocaleString()}
        </span>
        <button
          type="button"
          className="headpad__step"
          data-testid="padding-up"
          aria-label="One more on the headcount"
          disabled={busy || padding >= MAX_PADDING}
          onClick={() => onSet(padding + 1)}
        >
          +
        </button>
      </div>
      <p className="headpad__split" data-testid="padding-split">
        {padding === 0
          ? `${here.toLocaleString()} here`
          : `${here.toLocaleString()} here, ${padding.toLocaleString()} added`}
      </p>
    </div>
  )
}

/** What an announcement says about itself, beside its time and its picture. */
interface Announced {
  kind: SessionKind
  /** As typed. Trimmed, capped and turned into null by the station. */
  title: string
}

/**
 * The next session, announced before it happens.
 *
 * The one control on this panel that is not about tonight. Everything else here
 * drives a broadcast that is happening or is about to; this writes down a night
 * that has not, and it survives the session it was set during, because the
 * moment it becomes worth reading is usually the moment the broadcast ends.
 *
 * **It starts nothing.** The time is a promise to whoever reads it. Going on
 * air is still the button above, which is PLAN.md's decision and not this
 * card's to take back: a clock that opened the station by itself would do it
 * into an empty queue and an empty room more often than not.
 *
 * The poster is optional and separate from the time in the one way that
 * matters: leaving the file alone and changing the hour keeps the picture. An
 * admin moving a session by an hour from a phone should not have to find the
 * image again.
 *
 * The kind and the title are not treated that way, and the difference is worth
 * knowing: they are sent on every announcement, empty or not, so clearing a
 * title clears it. Only the file is expensive enough to be worth a rule.
 */
function ScheduleCard({
  schedule,
  busy,
  onAnnounce,
  onTakeDown,
}: {
  schedule: ScheduledSession | null
  busy: boolean
  onAnnounce(startsAt: number, poster: File | null, said: Announced): void
  onTakeDown(): void
}) {
  // Seeded from what is announced, and re-seeded when that changes underneath,
  // so a second tab setting a time does not leave this field lying about it.
  const [when, setWhen] = useState(() => (schedule ? toLocalInput(schedule.startsAt) : ''))
  const [poster, setPoster] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const [kind, setKind] = useState<SessionKind>(() => schedule?.kind ?? 'set')
  const [title, setTitle] = useState(() => schedule?.title ?? '')
  const announced = schedule?.startsAt ?? null
  useEffect(() => {
    setWhen(announced === null ? '' : toLocalInput(announced))
    setPoster(null)
  }, [announced])

  /*
   * The other two fields follow whatever is announced, on their own signal.
   *
   * Separate from the effect above because they change without the time
   * changing: renaming a night or turning it from a set into a conversation
   * leaves `startsAt` exactly where it was, and folding these into that effect
   * would leave the two fields showing the last thing this tab typed while the
   * station held something else. Keyed on the values themselves so that a
   * second console, or a take-down, is followed here too.
   */
  const announcedKind = schedule?.kind ?? null
  const announcedTitle = schedule?.title ?? null
  useEffect(() => {
    setKind(announcedKind ?? 'set')
    setTitle(announcedTitle ?? '')
  }, [announcedKind, announcedTitle])

  // What a picked file looks like, before it has been anywhere. Revoked on the
  // way out: an object URL pins the file in memory until it is let go, and an
  // admin trying three posters would pin all three.
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    if (!poster) return setPreview(null)
    const url = URL.createObjectURL(poster)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [poster])

  const startsAt = fromLocalInput(when)
  // The picked file wins over what is up: it is what pressing Update will
  // announce, and showing the old one there would be the panel arguing with
  // the button under it.
  const shown = preview ?? posterUrl(schedule)

  return (
    <section className="card card--schedule">
      <header className="card__head">
        <h2 className="card__title">Next session</h2>
        {schedule && (
          <button
            type="button"
            className="card__more"
            disabled={busy}
            onClick={onTakeDown}
            data-testid="schedule-clear"
          >
            Take down
          </button>
        )}
      </header>

      <form
        className="schedule__form"
        onSubmit={(event) => {
          event.preventDefault()
          if (startsAt !== null) onAnnounce(startsAt, poster, { kind, title })
        }}
      >
        {/* The poster is both the preview and the way to change it: the whole
            rectangle is the target, the same way the upload zone above is, and
            a picture that can be dropped on is more obviously replaceable than
            a picture with a file input under it.

            A label wrapping a real input rather than a div with a handler,
            because that is what gives it a keyboard and a screen reader. */}
        <label
          className={`poster${over ? ' poster--over' : ''}${shown ? ' poster--set' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            // Images only, and quietly: a dragged folder or a stray mp3 is a
            // slip, not something worth an error about a file nobody meant.
            const picked = [...event.dataTransfer.files].find((file) =>
              file.type.startsWith('image/'),
            )
            if (picked) setPoster(picked)
          }}
        >
          {shown ? (
            <img className="poster__art" src={shown} alt="" />
          ) : (
            <span className="poster__badge" aria-hidden="true">
              <img src={uploadIcon} alt="" width={22} height={22} />
            </span>
          )}
          <span className="poster__hint">
            {poster
              ? `${poster.name}. Press ${schedule ? 'Update' : 'Announce'} to put it up.`
              : shown
                ? 'Drop a new poster, or click to replace'
                : 'Drop a poster here, or click to browse'}
          </span>
          {/* Said once, here, rather than discovered from a 415 after the
              upload. 1080x1350 is Instagram's portrait post, which is the shape
              whoever runs the decks already has one in. */}
          <span className="poster__spec">1080&times;1350 reads best. Under 8 MB.</span>
          <input
            type="file"
            className="dropzone__input"
            accept="image/jpeg,image/png,image/webp"
            // Named explicitly, or it inherits the whole of the label's copy as
            // its accessible name.
            aria-label="Choose a poster"
            data-testid="schedule-poster"
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null
              event.target.value = '' // so the same file can be picked twice
              setPoster(picked)
            }}
          />
        </label>

        <label className="schedule__field">
          <span className="schedule__label">When</span>
          <input
            type="datetime-local"
            className="gate__input"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            data-testid="schedule-when"
          />
        </label>

        {/* What kind of night is being promised. On the poster rather than only
            on the night itself, because the two are announced to different
            people at different times: this one is read by somebody deciding
            whether to turn up, and "a conversation" and "a set" are not the
            same decision. It is also independent of what actually gets started
            on the night; a plan is not a session. */}
        <div className="schedule__field">
          <span className="schedule__label" id="schedule-kind-label">
            What
          </span>
          <div className="schedule__kinds" role="group" aria-labelledby="schedule-kind-label">
            {(['set', 'talk'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`golive__kind${kind === option ? ' golive__kind--on' : ''}`}
                data-testid={`schedule-kind-${option}`}
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
              >
                {kindLabel(option)}
              </button>
            ))}
          </div>
        </div>

        <label className="schedule__field">
          <span className="schedule__label">Called</span>
          <input
            type="text"
            className="gate__input"
            value={title}
            maxLength={SCHEDULE_TITLE_MAX_LENGTH}
            placeholder={kind === 'talk' ? 'Who is coming on' : 'The theme, if there is one'}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="schedule-title"
          />
        </label>

        <button type="submit" className="button" disabled={busy || startsAt === null}>
          {schedule ? 'Update' : 'Announce'}
        </button>

        {/* The sentence a listener will actually read, checked against the
            field rather than against what was saved: the point of showing it is
            to catch a date typed as next year before it is announced. It says
            the whole line now, because the kind and the title go on the same
            poster and a preview of one third of it is a preview of nothing. */}
        {startsAt !== null && (
          <p className="schedule__preview" data-testid="schedule-preview">
            Listeners see:{' '}
            <strong>
              {kindPromise(kind)}
              {title.trim() ? `, ${title.trim()}` : ''}. {nextSessionLabel(startsAt, Date.now())}
            </strong>
          </p>
        )}
      </form>
    </section>
  )
}

/**
 * Going on air, and ending it. PLAN.md's availability decision, as one button.
 *
 * Ending a broadcast is the most destructive thing on this panel: it stops the
 * music, empties the queue and closes the room, and the chat and the history go
 * with the session, so it asks first. Going live does not: it takes nothing
 * away, and an evening that starts a click sooner than intended is not a
 * problem the way one that ends early is.
 *
 * Disabled until the station has said which way round it is. A button that
 * guessed would spend its first render offering to end a broadcast that had not
 * started, and a misclick on that is exactly what the confirmation is for.
 */
function OnAirSwitch({
  air,
  busy,
  onSet,
}: {
  air: AirSnapshot | null
  busy: boolean
  onSet(action: 'start' | 'end', kind?: SessionKind): void
}) {
  const [confirming, setConfirming] = useState(false)
  /**
   * Which kind of night the next one is, while it is still being decided.
   *
   * Held here rather than beside the session because it is not a fact about the
   * station: it is the state of a control that has not been pressed yet. Once
   * the button goes, the answer is `air.kind` and this stops meaning anything,
   * which is why nothing reads it while the station is live.
   */
  const [starting, setStarting] = useState<SessionKind>('set')

  // Not yet known. See the note above: no guessing which way round it is.
  if (air === null) {
    return (
      <button type="button" className="button button--quiet" disabled>
        …
      </button>
    )
  }

  // The white pill, not a red one: red on this page means "on the air right
  // now" and nothing else, and a button wearing it before anything is on would
  // be the second bright thing the design does not allow.
  //
  // Two controls in one now: what kind of night, and start it. They are next to
  // each other rather than a choice that appears after the click, because a
  // dialog between deciding to go live and going live is a dialog somebody
  // dismisses at ten past nine with a room waiting, and the kind cannot be
  // changed afterwards. The default is a set, so the ordinary evening is still
  // one press of one button.
  if (!air.live) {
    return (
      <span className="golive">
        <span className="golive__kinds" role="group" aria-label="What kind of night">
          {(['set', 'talk'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`golive__kind${starting === kind ? ' golive__kind--on' : ''}`}
              data-testid={`kind-${kind}`}
              aria-pressed={starting === kind}
              onClick={() => setStarting(kind)}
            >
              {kindLabel(kind)}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="button"
          data-testid="go-live"
          disabled={busy}
          onClick={() => onSet('start', starting)}
        >
          Go live
        </button>
      </span>
    )
  }

  if (confirming) {
    return (
      <span className="confirm" role="group" aria-label="End the broadcast?">
        <button
          type="button"
          className="button button--danger"
          data-testid="end-session-confirm"
          disabled={busy}
          onClick={() => {
            setConfirming(false)
            onSet('end')
          }}
        >
          End it (clears the queue)
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setConfirming(false)}
        >
          Keep going
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="button button--quiet"
      data-testid="end-session"
      disabled={busy}
      onClick={() => setConfirming(true)}
    >
      End broadcast
    </button>
  )
}

/**
 * The link to hand out.
 *
 * The one place an invite can come from. A listener's browser cannot build one:
 * the cookie is HttpOnly and the key was taken out of the address bar when
 * they arrived, so being invited means somebody with the password sent you a
 * link, which is the whole point of the station key.
 *
 * The link is always shown, not only copied. Sharing and clipboard access both
 * need a secure context, so on a LAN address over plain HTTP neither exists;
 * and even where they do, seeing what you are about to send somebody is worth
 * more than a button that claims it worked.
 */
function ShareInvite({ api }: { api: AdminApi }) {
  const [link, setLink] = useState<string | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      // No clipboard here: an insecure origin, or permission refused. The link
      // is on screen either way, which is the fallback that always works.
      setCopied(false)
    }
  }

  async function share() {
    setError(null)
    try {
      const invite = await api.invite()
      const url = inviteLink(window.location.origin, invite.key)
      setKey(invite.key)
      setLink(url)

      // The native sheet where there is one: on a phone this is the whole
      // gesture. A cancelled share is a decision, not a failure, so it does not
      // fall through to the clipboard.
      if (navigator.share) {
        try {
          await navigator.share({ title: 'chunky.fm', url })
          return
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return
        }
      }
      await copy(url)
    } catch {
      setError('could not fetch the invite')
    }
  }

  return (
    <div className="invite">
      <button type="button" className="button" data-testid="admin-share" onClick={() => void share()}>
        {copied ? 'Copied' : 'Share'}
      </button>

      {error && <p className="console__note">{error}</p>}

      {link !== null && (
        <div className="invite__link">
          <input
            className="invite__url"
            data-testid="admin-invite-link"
            readOnly
            value={link}
            aria-label="Invite link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="button button--quiet" onClick={() => void copy(link)}>
            Copy
          </button>
        </div>
      )}

      {link !== null && (
        <p className="invite__note">
          {key === null
            ? 'The station is open. Anyone with this address can listen. Set STATION_KEY to change that.'
            : 'This link carries the station key. Rotating STATION_KEY ends every link already sent.'}
        </p>
      )}
    </div>
  )
}

/**
 * The other person at the decks.
 *
 * Two things in one card, and they belong together because they are the same
 * decision from two sides: who is helping run tonight, and how the records they
 * line up turn into each other.
 *
 * The link is always shown, not only copied, for the reason the invite's is:
 * sharing and clipboard access both need a secure context, so on a LAN address
 * over plain HTTP neither exists, and even where they do, seeing what you are
 * about to send somebody is worth more than a button claiming it worked.
 *
 * The crossfade slider lives here rather than beside the transport, and that is
 * a claim about who reaches for it. It is set once at the start of an evening
 * to suit the music, not ridden between records, and the person most likely to
 * change it is the one watching the queue — which is the co-host, who has the
 * same slider on their phone.
 */
function CoHostCard({
  api,
  coHost,
  transition,
  busy,
  onStandDown,
  onBlend,
}: {
  api: AdminApi
  coHost: CoHostSnapshot | null
  transition: TransitionSnapshot | null
  busy: boolean
  onStandDown(): void
  onBlend(blendMs: number): void
}) {
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What the slider shows while it is being dragged. The station's value is the
  // truth, but a fader that only moved when the round trip landed would feel
  // broken under the hand. Same trick as the duck's.
  const [draft, setDraft] = useState<number | null>(null)
  const seat = coHost?.seat ?? null
  const blendMs = draft ?? transition?.blendMs ?? 0

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      // No clipboard here: an insecure origin, or permission refused. The link
      // is on screen either way, which is the fallback that always works.
      setCopied(false)
    }
  }

  async function share() {
    setError(null)
    try {
      const { key } = await api.coHostKey()
      const url = coHostLink(window.location.origin, key)
      setLink(url)

      // The native sheet where there is one: this link is going to a phone, so
      // on a phone this is the whole gesture. A cancelled share is a decision,
      // not a failure, so it does not fall through to the clipboard.
      if (navigator.share) {
        try {
          await navigator.share({ title: 'chunky.fm — co-host', url })
          return
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return
        }
      }
      await copy(url)
    } catch {
      setError('could not fetch the co-host link')
    }
  }

  return (
    <section className="card card--cohost" data-testid="cohost-card">
      <h2 className="card__title">Co-host</h2>

      {seat ? (
        <div className="cohost__seated" data-testid="cohost-seated">
          <span className="cohost__who">{seat.nickname} is co-hosting</span>
          <button
            type="button"
            className="button button--quiet"
            data-testid="cohost-stand-down"
            disabled={busy}
            onClick={onStandDown}
          >
            Stand down
          </button>
        </div>
      ) : (
        <p className="card__empty" data-testid="cohost-empty">
          Nobody is co-hosting. Send the link and they can talk, queue records
          and take the transitions from their phone.
        </p>
      )}

      <div className="invite">
        <button
          type="button"
          className="button"
          data-testid="cohost-share"
          onClick={() => void share()}
        >
          {copied ? 'Copied' : 'Send the co-host link'}
        </button>

        {error && <p className="console__note">{error}</p>}

        {link !== null && (
          <div className="invite__link">
            <input
              className="invite__url"
              data-testid="cohost-link"
              readOnly
              value={link}
              aria-label="Co-host link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="button button--quiet" onClick={() => void copy(link)}>
              Copy
            </button>
          </div>
        )}

        {link !== null && (
          <p className="invite__note">
            This link is not the station password. Whoever holds it can talk,
            queue and move the current record along — and cannot end the night,
            upload anything or mute anybody. Set CO_HOST_KEY to rotate it on its
            own; changing ADMIN_PASSWORD rotates it too.
          </p>
        )}
      </div>

      <label className="mic__duck">
        <span className="mic__duck-label">
          Crossfade
          <em data-testid="cohost-blend">
            {blendMs === 0 ? 'straight cut' : `${(blendMs / 1000).toFixed(1)}s`}
          </em>
        </span>
        <input
          type="range"
          data-testid="cohost-blend-slider"
          min={0}
          max={MAX_BLEND_MS}
          step={250}
          value={blendMs}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={() => {
            if (draft !== null) onBlend(draft)
            setDraft(null)
          }}
          onKeyUp={() => {
            if (draft !== null) onBlend(draft)
            setDraft(null)
          }}
          onBlur={() => {
            if (draft !== null) onBlend(draft)
            setDraft(null)
          }}
        />
      </label>
    </section>
  )
}

/**
 * Where files come in.
 *
 * The design draws the whole rectangle as the target, so the whole rectangle is
 * one: a click opens the picker and a drop takes the files directly. It is a
 * label wrapping a real file input rather than a div with a click handler,
 * because that is what gives it a keyboard and a screen reader for free.
 *
 * A strip across the top of the library rather than the block it used to be.
 * Uploading is the rarest thing anybody does at this desk and it had been given
 * the widest, tallest element on the page; the whole strip is still one target,
 * which is what the gesture actually needs.
 */
function DropZone({ onFiles }: { onFiles: (files: File[]) => Promise<void> }) {
  const [over, setOver] = useState(false)

  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setOver(false)
    // Audio only, and quietly: a dragged folder or screenshot is a slip, not
    // something worth an error message about a file nobody meant to send.
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('audio/'))
    void onFiles(files)
  }

  return (
    <label
      className={`dropzone${over ? ' dropzone--over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <span className="dropzone__badge">
        <img src={uploadIcon} alt="" width={18} height={18} />
      </span>
      <span className="dropzone__say">
        <span className="dropzone__headline">Drop MP3 files here</span>
        <span className="dropzone__detail">or click to browse. Files are added to the queue</span>
      </span>
      <input
        type="file"
        className="dropzone__input"
        accept="audio/*"
        multiple
        data-testid="admin-upload"
        // Named explicitly, or it inherits the whole of the label's copy as its
        // accessible name, which is a paragraph to read out before you can
        // pick a file, and a name that collides with every other control on the
        // page whose label happens to contain one of those words.
        aria-label="Choose audio files"
        onChange={(event) => {
          // Copied out before the input is reset: clearing `value` empties
          // `files` too, so handing the FileList straight to an async upload
          // would leave it with nothing to send.
          const picked = [...(event.target.files ?? [])]
          event.target.value = '' // so the same file can be picked twice
          void onFiles(picked)
        }}
      />
    </label>
  )
}

interface QueueCardProps {
  entries: QueueEntry[]
  state: StateMessage | null
  track: Track | null
  paused: boolean
  busy: boolean
  serverNow(): number
  command(body: PlaybackCommand): Promise<void>
  queueAction(act: () => Promise<{ entries: QueueEntry[] }>): Promise<void>
  api: AdminApi
}

/**
 * What is on, and what is after it.
 *
 * The row at the top is the station, not the queue: it is what everyone is
 * hearing right now, and it is the only row here that no button reorders.
 * Everything below it is the running order, which is a list the admin owns.
 */
function QueueCard({
  entries,
  state,
  track,
  paused,
  busy,
  serverNow,
  command,
  queueAction,
  api,
}: QueueCardProps) {
  // Which row is in the air, by entry id. Positions shift under a drag as the
  // queue advances, so the id is the only thing worth holding on to.
  const dragging = useRef<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  // Where the needle is, worked out from the station's tuple rather than from
  // any audio element: the console is not playing anything.
  const [position, setPosition] = useState(0)
  // What the admin is dragging the scrub bar to, before they let go. Null when
  // nobody is holding it, which is when the ticker below owns the value.
  const [scrubbing, setScrubbing] = useState<number | null>(null)

  useEffect(() => {
    if (!state?.track) return
    const tick = () => setPosition(expectedPositionSeconds(state, serverNow()) * 1000)
    tick()
    // A second is plenty: this is a position readout on a desk, not the audio
    // clock, and the thing it is reporting moves at exactly one second a second.
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [state, serverNow])

  const duration = track?.durationMs ?? 0
  // While the admin is holding the bar, what they are holding it at wins over
  // the ticker; otherwise every tick would drag the needle back under them.
  const shown = scrubbing ?? position

  // Every command here moves everyone in the room, so they are not sent per
  // frame of a drag or per press of an arrow key. A drag commits on release;
  // a run of arrow presses commits once it stops, which is also what makes a
  // held-down arrow accumulate instead of restarting from the last tick.
  const pending = useRef<number | null>(null)
  const commit = useCallback(
    (positionMs: number) => {
      if (pending.current !== null) window.clearTimeout(pending.current)
      pending.current = null
      // Cleared only once the station has answered, so the needle does not jump
      // back to where it was for the length of a round trip.
      void command({ action: 'seek', positionMs: Math.round(positionMs) }).then(() =>
        setScrubbing(null),
      )
    },
    [command],
  )

  function scrubTo(positionMs: number) {
    setScrubbing(positionMs)
    if (pending.current !== null) window.clearTimeout(pending.current)
    pending.current = window.setTimeout(() => commit(positionMs), 400)
  }

  useEffect(() => () => void (pending.current !== null && window.clearTimeout(pending.current)), [])

  function drop(index: number) {
    const id = dragging.current
    dragging.current = null
    setOver(null)
    if (id === null) return
    // The server addresses entries by id and clamps the index it is given,
    // which is what makes this safe against a queue that advanced mid-drag.
    void queueAction(() => api.move(id, index))
  }

  return (
    <section className="card">
      <header className="card__head">
        <div>
          <h2 className="card__title">
            Up next <span className="card__count">({entries.length})</span>
          </h2>
          <p className="card__blurb">Drag to reorder · top of list plays next</p>
        </div>
        <div className="card__actions">
          <button
            type="button"
            className="button"
            disabled={busy || (!track && entries.length === 0)}
            data-testid="admin-skip"
            onClick={() => void command({ action: 'skip' })}
          >
            <img src={playIcon} alt="" width={14} height={14} />
            Play next
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={busy || !track}
            data-testid="admin-playpause"
            onClick={() => void command({ action: paused ? 'resume' : 'pause' })}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={busy || !track}
            data-testid="admin-stop"
            onClick={() => void command({ action: 'stop' })}
          >
            Stop
          </button>
        </div>
      </header>

      {/* Always rendered, on air or not: the console's first question is "what
          is going out", and an empty space is not an answer to it. */}
      <div className={`onair-row${track ? '' : ' onair-row--off'}`}>
        <span className="onair-row__tile" aria-hidden="true">
          <span className="onair-row__dot" />
        </span>
        <span className="onair-row__body">
          <span className="onair-row__title" data-testid="admin-now">
            {track ? `${track.title}${paused ? ' (paused)' : ''}` : 'off air'}
          </span>
          <span className="onair-row__sub">
            {track
              ? `${paused ? 'Paused' : 'On air now'} · ${track.artist ?? 'Unknown artist'}`
              : 'Nothing on the decks'}
          </span>
        </span>
      </div>

      {/* PLAN.md's last unbuilt transport control. A range input rather than a
          bar with a pointer handler, because that is what gives it arrow keys,
          Home and End, and a value a screen reader can read out, and because
          the station takes a position in milliseconds either way.

          The command goes on release, not on every frame of the drag: each one
          moves every listener in the room, and a scrub across a four-minute
          track would otherwise be a hundred of them. */}
      {track && (
        <div className="scrub">
          <span className="scrub__at">{formatClock(shown / 1000)}</span>
          <input
            type="range"
            className="scrub__bar"
            data-testid="admin-seek"
            min={0}
            max={duration}
            step={1000}
            value={Math.min(shown, duration)}
            disabled={busy}
            aria-label={`Seek within ${track.title}`}
            onChange={(event) => scrubTo(Number(event.target.value))}
            // A release is a decision: no reason to make it wait out the idle
            // timer that keyboard runs need.
            onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          />
          <span className="scrub__of">{formatClock(duration / 1000)}</span>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="card__empty">Nothing queued.</p>
      ) : (
        <ol className="queue" data-testid="admin-queue">
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              className={`queue__row${over === entry.id ? ' queue__row--over' : ''}`}
              data-entry={entry.id}
              draggable={!busy}
              onDragStart={(event) => {
                dragging.current = entry.id
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setOver(entry.id)
              }}
              onDragLeave={() => setOver((current) => (current === entry.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault()
                drop(index)
              }}
              onDragEnd={() => {
                dragging.current = null
                setOver(null)
              }}
            >
              <img className="queue__grip" src={gripIcon} alt="" width={16} height={16} />
              <span className="queue__index">{index + 1}</span>
              <span className="queue__body">
                <span className="queue__title">{entry.track.title}</span>
                <span className="queue__sub">
                  {entry.track.artist ?? 'Unknown artist'} ·{' '}
                  {formatClock(entry.track.durationMs / 1000)}
                </span>
              </span>
              {/* Dragging is the design's gesture and the quick one; these are
                  the same three moves for anyone on a keyboard, or on a touch
                  screen where a drag between two 52px rows is a coin toss. */}
              <span className="queue__moves">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move ${entry.track.title} up`}
                  disabled={busy || index === 0}
                  onClick={() => void queueAction(() => api.move(entry.id, index - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move ${entry.track.title} down`}
                  disabled={busy || index === entries.length - 1}
                  onClick={() => void queueAction(() => api.move(entry.id, index + 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--remove"
                  aria-label={`Remove ${entry.track.title}`}
                  disabled={busy}
                  onClick={() => void queueAction(() => api.remove(entry.id))}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {entries.length > 0 && (
        <footer className="card__foot">
          <button
            type="button"
            className="card__link"
            disabled={busy}
            data-testid="admin-queue-clear"
            onClick={() => void queueAction(() => api.clearQueue())}
          >
            Clear
          </button>
        </footer>
      )}
    </section>
  )
}

/**
 * What the room has asked for.
 *
 * Above the library on purpose: a wish is read, and then answered by queueing
 * something from the list below it.
 */
function WishesCard({
  book,
  busy,
  onMark,
}: {
  book: WishBook
  busy: boolean
  onMark(id: number, status: 'new' | 'handled'): void
}) {
  return (
    <section className="card">
      <header className="card__head">
        <h2 className="card__title">
          Wishes <span className="card__count">({book.outstanding})</span>
        </h2>
      </header>
      {book.wishes.length === 0 ? (
        <p className="card__empty">Nobody has asked for anything.</p>
      ) : (
        <ul className="wish-book" data-testid="admin-wishes">
          {book.wishes.map((wish) => (
            <li
              key={wish.id}
              className={`wish-book__row${wish.status === 'handled' ? ' wish-book__row--handled' : ''}`}
              data-wish={wish.id}
              data-status={wish.status}
            >
              <time className="wish-book__at">{formatTime(wish.at)}</time>
              <span className="wish-book__nick">{wish.nickname}</span>
              <span className="wish-book__text">{wish.text}</span>
              {/* Reversible: the mark is a note to whoever is reading the list,
                  and a misclick should not be the end of somebody's request. */}
              <button
                type="button"
                className="card__link"
                disabled={busy}
                onClick={() => onMark(wish.id, wish.status === 'handled' ? 'new' : 'handled')}
              >
                {wish.status === 'handled' ? 'Undo' : 'Mark handled'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Everything the station has to play, and the way to add to it.
 *
 * The card takes whatever height the column has left over and scrolls inside
 * itself: a station with two hundred records should not be a page that scrolls
 * the transport out of sight to reach the fifth one.
 */
function LibraryCard({
  tracks,
  busy,
  onQueue,
  onPlay,
  onFiles,
  uploads,
}: {
  tracks: Track[]
  busy: boolean
  onQueue(id: number): void
  onPlay(id: number): void
  onFiles(files: File[]): Promise<void>
  /** What the last upload did, a line per file. */
  uploads: { id: number; line: string }[]
}) {
  return (
    <section className="card card--library">
      <header className="card__head">
        <h2 className="card__title">
          Library <span className="card__count">({tracks.length})</span>
        </h2>
      </header>

      <DropZone onFiles={onFiles} />

      {uploads.length > 0 && (
        <ul className="uploads" data-testid="admin-uploads">
          {uploads.map((line) => (
            <li key={line.id}>{line.line}</li>
          ))}
        </ul>
      )}

      {tracks.length === 0 ? (
        <p className="card__empty">Nothing uploaded yet.</p>
      ) : (
        <ul className="library" data-testid="admin-library">
          {tracks.map((track) => (
            <li key={track.id} className="library__row" data-track={track.id}>
              <span className="library__body">
                <span className="queue__title">{track.title}</span>
                <span className="queue__sub">
                  {track.artist ?? 'Unknown artist'} · {formatClock(track.durationMs / 1000)}
                </span>
              </span>
              <button
                type="button"
                className="card__link"
                disabled={busy}
                onClick={() => onQueue(track.id)}
              >
                Queue
              </button>
              <button
                type="button"
                className="card__link"
                disabled={busy}
                onClick={() => onPlay(track.id)}
              >
                Play now
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The room, from the other side of the glass.
 *
 * Read-only, and not because the design left the composer out: the console
 * never tunes in, so it is not in the room, and the station would refuse a
 * message from it. Whoever is running the decks and wants to say something
 * opens the listener page, which is one press of the chip in the top bar.
 */
function CommentsCard({
  messages,
  muted,
  busy,
  onMute,
}: {
  messages: ChatMessage[]
  /** Nicknames the decks have asked to stop talking. */
  muted: string[]
  busy: boolean
  onMute(nickname: string, muted: boolean): void
}) {
  const list = useRef<HTMLOListElement>(null)
  // A Set, because this is asked once per message and the room is small but the
  // conversation is not.
  const silenced = new Set(muted)

  // Follow the conversation, exactly as the listener page does.
  useEffect(() => {
    const element = list.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages])

  return (
    <section className="card card--comments">
      <header className="card__head">
        <h2 className="card__title">
          <img src={commentsIcon} alt="" width={16} height={16} />
          Listener Comments
        </h2>
        <p className="card__aside">
          {messages.length === 1 ? '1 total' : `${messages.length} total`}
          {muted.length > 0 && `, ${muted.length} muted`}
        </p>
      </header>
      {messages.length === 0 ? (
        <p className="card__empty">Nobody has said anything yet.</p>
      ) : (
        <ol className="comments" data-testid="admin-comments" ref={list}>
          {messages.map((message) => (
            <li key={message.id} className="comments__row" data-message={message.id}>
              <span
                className="comments__avatar"
                aria-hidden="true"
                style={{ '--hue': `${hueFor(message.nickname)}` } as CSSProperties}
              >
                {[...message.nickname.trim()][0] ?? '?'}
              </span>
              <span className="comments__bubble">
                <span className="comments__head">
                  <span className="comments__nick">{message.nickname}</span>
                  <time className="comments__at" dateTime={new Date(message.at).toISOString()}>
                    {formatTime(message.at)}
                  </time>
                  {/* On the message rather than in a roster of its own: the
                      moment you want to mute somebody is the moment you are
                      reading the thing they said, and a separate list would
                      mean finding them in it by name. Muting is by nickname, so
                      it does not matter which of their messages this is. */}
                  <button
                    type="button"
                    className="comments__mute"
                    data-testid={`mute-${message.nickname}`}
                    disabled={busy}
                    aria-pressed={silenced.has(message.nickname)}
                    title={
                      silenced.has(message.nickname)
                        ? `Let ${message.nickname} talk again`
                        : `Mute ${message.nickname}`
                    }
                    onClick={() =>
                      onMute(message.nickname, !silenced.has(message.nickname))
                    }
                  >
                    {silenced.has(message.nickname) ? 'Muted' : 'Mute'}
                  </button>
                </span>
                <span className="comments__text">{message.text}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/**
 * A stable hue in [0, 360) for a nickname: the same derivation the listener
 * page uses, so a listener is the same colour on both sides of the station.
 */
function hueFor(nickname: string): number {
  let total = 0
  for (const character of nickname) total = (total * 31 + character.codePointAt(0)!) % 360
  return total
}
