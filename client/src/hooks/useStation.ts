import { useCallback, useEffect, useRef, useState } from 'react'
import { type Availability, INITIALLY, nextAvailability } from '../lib/availability.js'
import { mergeMessages } from '../lib/chat.js'
import { mergePlays } from '../lib/history.js'
import type {
  AirSnapshot,
  ChatMessage,
  Listener,
  MicSnapshot,
  Play,
  PlaybackSnapshot,
  QueueEntry,
  ScheduledSession,
  ServerMessage,
  SocketRefusal,
  StateMessage,
  Wish,
} from '../lib/protocol.js'
import { StationConnection, type StationStatus } from '../lib/station.js'
import { mergeWishes } from '../lib/wishes.js'

export function defaultStationUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws`
}

export interface Station {
  /** The socket itself. What decides whether a send would land. */
  status: StationStatus
  /**
   * What this page can honestly say about the station: the same story with
   * its history folded in, which is what a screen needs and a single status
   * cannot give: whether an outage is one this page has ever seen the other
   * side of. See `lib/availability.ts`.
   */
  reach: Availability
  state: StateMessage | null
  /**
   * Whether the station is broadcasting, and since when. Null until the first
   * `air` frame arrives, which is the first frame of all, so the gap is a few
   * milliseconds and reads as "not yet known" rather than as "off".
   *
   * Deliberately not folded into `reach`: that is about whether this page can
   * reach the station, and this is about whether there is anything to reach.
   * `standing()` in lib/availability.ts is where the two become one answer.
   */
  air: AirSnapshot | null
  /**
   * This socket's own id, or null before the first frame arrives.
   *
   * Needed only by the voice, and needed by both ends of it: the decks must not
   * offer themselves a microphone, and a listener answering an offer has to
   * know the id it is reading is somebody else's. It changes on every reconnect,
   * because a reconnect is a new socket and therefore a new row in the roster.
   */
  me: number | null
  /**
   * When the station is next on, or null when nothing is announced.
   *
   * The other half of the sentence `air` starts, and the one thing here that
   * is not about tonight. See `ScheduleMessage`.
   */
  schedule: ScheduledSession | null
  /**
   * Whether somebody is talking over the music, and how far it drops while
   * they are. Null until the first `mic` frame, which arrives in the connect
   * burst before `state`, so the gap is a few milliseconds.
   *
   * Beside `air` rather than folded into `state` for the reason the queue is
   * beside it: this changes twice a sentence and playback does not, and a page
   * should not re-align its audio because somebody drew breath.
   */
  mic: MicSnapshot | null
  /** What's coming up. Null until the first queue frame arrives. */
  queue: QueueEntry[] | null
  /** Who else is here. Null until the first roster arrives. */
  listeners: Listener[] | null
  /**
   * Heads the decks added on top of the roster, and zero until told otherwise.
   *
   * Kept beside the roster rather than mixed into it, exactly as it arrives:
   * the names are people, this is a number. The headcount a page shows is the
   * two added together. See `PresenceMessage`.
   */
  padding: number
  /** The conversation, oldest first. Empty until the first chat frame arrives. */
  messages: ChatMessage[]
  /**
   * What *this* listener has asked for, oldest first.
   *
   * Only their own: a wish goes to whoever runs the decks, and the station
   * answers the socket that made it rather than the room. Nothing replays it,
   * so this survives a reconnect (the connection is remade under the same
   * hook) and starts empty on a reload, while the wishes themselves are still
   * in the book the admin reads.
   */
  myWishes: Wish[]
  /**
   * What has been on this session, oldest first. Empty until the first history
   * frame arrives.
   *
   * Written down by the station rather than held on the socket, so unlike the
   * roster this survives a reload: a listener who refreshes at 10 still sees
   * the evening, and one who arrives then sees what they missed.
   */
  history: Play[]
  /**
   * The last thing the socket refused, and a sequence number that goes up on
   * every refusal.
   *
   * The counter is what makes two identical refusals in a row ("slow down",
   * then "slow down" again) distinguishable, so whatever is showing them can
   * react to the second one. Without it a repeat is the same value and nothing
   * downstream ever hears about it. Null until something is refused.
   */
  socketError: SocketRefusal | null
  clearSocketError(): void
  connection: StationConnection | null
  /**
   * Fold in state the server just handed back over HTTP.
   *
   * An admin command answers with the state it produced, which is the same
   * thing the broadcast is about to carry, so applying it here costs nothing
   * and means the panel doesn't sit unchanged for a round trip, or, if the
   * socket happens to be reconnecting, until it comes back. The broadcast still
   * arrives and overwrites it with the identical value.
   */
  applyState(snapshot: PlaybackSnapshot): void
  applyQueue(entries: QueueEntry[]): void
  /** Fold in what `POST /api/padding` just answered. See `applyState`. */
  applyPadding(count: number): void
  /** Fold in what `POST /api/session` just answered. See `applyState`. */
  applyAir(snapshot: AirSnapshot): void
  /** Fold in what `PUT /api/schedule` just answered. See `applyState`. */
  applySchedule(next: ScheduledSession | null): void
  /**
   * Fold in what `POST /api/mic` just answered. See `applyState`, and note that
   * this one earns it more than the others: the talk button is held down, and a
   * console whose own duck waited for the round trip would hear the music drop
   * after it had already started talking.
   */
  applyMic(snapshot: MicSnapshot): void
}

/** Holds the websocket open and tracks the station's broadcast state. */
export function useStation(
  url: string = defaultStationUrl(),
  onMessage?: (message: ServerMessage) => void,
): Station {
  const [status, setStatus] = useState<StationStatus>('connecting')
  const [reach, setReach] = useState<Availability>(INITIALLY)
  const [state, setState] = useState<StateMessage | null>(null)
  const [air, setAir] = useState<AirSnapshot | null>(null)
  const [me, setMe] = useState<number | null>(null)
  const [schedule, setSchedule] = useState<ScheduledSession | null>(null)
  const [mic, setMic] = useState<MicSnapshot | null>(null)
  const [queue, setQueue] = useState<QueueEntry[] | null>(null)
  const [listeners, setListeners] = useState<Listener[] | null>(null)
  const [padding, setPadding] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [myWishes, setMyWishes] = useState<Wish[]>([])
  const [history, setHistory] = useState<Play[]>([])
  const [socketError, setSocketError] = useState<SocketRefusal | null>(null)
  const [connection, setConnection] = useState<StationConnection | null>(null)

  // Kept in a ref so a changing handler doesn't tear down the socket.
  const messageHandler = useRef(onMessage)
  messageHandler.current = onMessage

  useEffect(() => {
    // A different url is a different station, and nothing this page learned
    // about the last one is about this one.
    setReach(INITIALLY)
    // A different station has its own answer to whether it is on air, and this
    // page has not heard it yet.
    setAir(null)
    // And its own next evening.
    setSchedule(null)
    // And its own answer to whether anybody is talking over it.
    setMic(null)
    // A new socket is a new row in the roster, so whatever this page was called
    // on the last one says nothing about what it is called on this one.
    setMe(null)
    const station = new StationConnection({
      url,
      onStatus: (next) => {
        setStatus(next)
        setReach((current) => nextAvailability(current, next))
      },
      onMessage: (message) => {
        if (message.type === 'you') setMe(message.id)
        if (message.type === 'state') setState(message)
        if (message.type === 'air') setAir({ live: message.live, since: message.since })
        if (message.type === 'schedule') setSchedule(message.schedule)
        if (message.type === 'mic') {
          setMic({ live: message.live, duckTo: message.duckTo, since: message.since })
        }
        if (message.type === 'queue') setQueue(message.entries)
        if (message.type === 'presence') {
          setListeners(message.listeners)
          setPadding(message.padding)
        }
        // Merged rather than replaced: a batch is either the history or one new
        // line, and both fold into what is already on screen the same way.
        if (message.type === 'chat') {
          setMessages((current) => mergeMessages(current, message.messages))
        }
        // The station's note back, and the only wish frame a listener ever
        // sees: their own, as it was written down.
        if (message.type === 'wished') {
          setMyWishes((current) => mergeWishes(current, [message.wish]))
        }
        // Merged rather than replaced, exactly as the chat is: a batch is
        // either the evening so far or the one track that just started.
        if (message.type === 'history') {
          setHistory((current) => mergePlays(current, message.plays))
        }
        // Kept rather than dropped. A refusal is the *only* thing the server
        // says about a frame that went nowhere: a rate-limited message would
        // otherwise leave the composer cleared and nothing on screen, which
        // reads exactly like having said something.
        if (message.type === 'error') {
          setSocketError((current) => ({ error: message, seq: (current?.seq ?? 0) + 1 }))
        }
        messageHandler.current?.(message)
      },
    })
    setConnection(station)
    station.connect()
    return () => {
      station.close()
      setConnection(null)
    }
  }, [url])

  const applyState = useCallback(
    (snapshot: PlaybackSnapshot) => setState({ type: 'state', ...snapshot }),
    [],
  )
  const applyQueue = useCallback((entries: QueueEntry[]) => setQueue(entries), [])
  /** Fold in what `POST /api/padding` just answered. See `applyState`. */
  const applyPadding = useCallback((count: number) => setPadding(count), [])
  const applyAir = useCallback((snapshot: AirSnapshot) => setAir(snapshot), [])
  /**
   * Fold in what `PUT /api/schedule` just answered, the way `applyAir` folds in
   * a session change: the socket is about to carry the same thing, and the
   * console should not sit unchanged for a round trip.
   */
  const applySchedule = useCallback((next: ScheduledSession | null) => setSchedule(next), [])
  const applyMic = useCallback((snapshot: MicSnapshot) => setMic(snapshot), [])
  const clearSocketError = useCallback(() => setSocketError(null), [])

  return {
    status,
    reach,
    state,
    air,
    me,
    schedule,
    mic,
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
    applySchedule,
    applyMic,
  }
}
