import type { IncomingHttpHeaders, Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { AirSnapshot, OnAir } from './air.js'
import { type ChatLog, RateLimit } from './chat.js'
import type { PlayLog } from './history.js'
import { DEFAULT_DUCK, type Mic, type MicSnapshot } from './mic.js'
import type { PlaybackSnapshot } from './playback.js'
import type { Mutes } from './mutes.js'
import type { Padding } from './padding.js'
import { type Listener, Presence } from './presence.js'
import {
  type ServerMessage,
  airMessage,
  scheduleMessage,
  chatMessages,
  errorMessage,
  historyMessage,
  micMessage,
  parseClientMessage,
  presenceMessage,
  signalMessage,
  youMessage,
  queueMessage,
  stateMessage,
  wishedMessage,
} from './protocol.js'
import type { QueueEntry } from './queue.js'
import type { Schedule, ScheduledSession } from './schedule.js'
import type { Station } from './station.js'
import type { WishBook } from './wishes.js'

export interface RealtimeLogger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface RealtimeOptions {
  server: Server
  station: Station
  /**
   * Whether the station is broadcasting. Omit and it is always on, which is
   * what the tests that are about something else want.
   */
  air?: OnAir
  /**
   * The next session, announced. Optional like `air`: a harness that is about
   * something else should not have to build one, and a socket with no schedule
   * behind it simply says there is nothing announced.
   */
  schedule?: Schedule
  /**
   * Whether somebody is talking over the music. Optional like `air`, and absent
   * means a mic that is never open: a harness that is about the chat should not
   * have to build one to hear itself think.
   */
  mic?: Mic
  /** Who has been asked to stop talking. Omit and nobody is muted. */
  mutes?: Mutes
  /**
   * Heads the decks added to the headcount. Omit and the roster is the whole
   * count, which is the station nobody has padded.
   */
  padding?: Padding
  /** The session's chat. Omit and the socket refuses `say` frames. */
  chat?: ChatLog
  /** The session's wish book. Omit and the socket refuses `wish` frames. */
  wishes?: WishBook
  /** The session's history. Omit and the station keeps no record of what was on. */
  plays?: PlayLog
  path?: string
  /**
   * Decides whether an upgrade is allowed to become a socket at all.
   *
   * A predicate rather than the config, so realtime does not have to know what
   * a station key is, and so the tests can open sockets without one. Omit it
   * and every upgrade is admitted, which is the open station.
   */
  admit?(headers: IncomingHttpHeaders): boolean
  /** How often to probe sockets for liveness. */
  heartbeatIntervalMs?: number
  /** How long a shutdown waits for close handshakes before forcing sockets shut. */
  closeGraceMs?: number
  /** Messages a socket may send back to back before it has to wait. */
  chatBurst?: number
  /** How long one of those costs to earn back. */
  chatRefillMs?: number
  /** Roster-changing joins a socket may send back to back. */
  joinBurst?: number
  /** How long one of those costs to earn back. */
  joinRefillMs?: number
  /** Wishes a socket may make back to back. */
  wishBurst?: number
  /** How long one of those costs to earn back. */
  wishRefillMs?: number
  /**
   * Which upgrades are the decks.
   *
   * A predicate over the upgrade's headers, like `admit` beside it, and asked
   * exactly once per connection. The admin cookie is already on the upgrade
   * request, and `hasAdminCredentials` takes raw headers precisely so something
   * that never becomes a `FastifyRequest` can ask the same question of the same
   * code.
   *
   * This is the first thing the socket has ever known about who is on the other
   * end, and it buys exactly one privilege: addressing a signalling frame to a
   * listener. Everything else is still refused to an admin cookie the same way
   * it is refused to nothing at all. Omit it and no socket is the decks, which
   * is a station where nobody can offer anybody a voice — the right answer for
   * every test that is about something else.
   */
  isAdmin?(headers: IncomingHttpHeaders): boolean
  /**
   * The last socket that was the decks has closed.
   *
   * Wired to the mic's lease in `app.ts` rather than reached for from in here,
   * the way ending a session is: the socket layer knows a connection went away
   * and should not also be deciding what that means for a broadcast.
   */
  onDecksGone?(): void
  /** Signalling frames a listener may send back to back. */
  signalBurst?: number
  /** How long one of those costs to earn back. */
  signalRefillMs?: number
  log?: RealtimeLogger
}

export interface RealtimeHandle {
  clientCount(): number
  /** Who has named themselves: a subset of the sockets `clientCount` counts. */
  listeners(): Listener[]
  broadcast(message: ServerMessage): void
  close(): Promise<void>
}

/**
 * Frames were tiny until signalling arrived, and an SDP offer is not.
 *
 * A session description runs to a couple of kilobytes before it carries a
 * single ICE candidate, and comfortably past four with them, so the old 4 KiB
 * ceiling would have closed the socket (ws answers an oversized frame with a
 * 1009 and a disconnection) at exactly the moment a voice was being set up —
 * which reads as the station dropping for no reason. Candidates trickle
 * separately, so nothing here is near the new ceiling; this is headroom for a
 * description, not room for a payload.
 */
const MAX_PAYLOAD_BYTES = 16 * 1024
const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_CLOSE_GRACE_MS = 1_000
/** A few lines in a row is how people talk; a stream of them is not. */
const DEFAULT_CHAT_BURST = 5
const DEFAULT_CHAT_REFILL_MS = 2_000
/**
 * A socket names itself once, and again only if the listener changes their mind,
 * so this is generous for anything a person does, and the first thing a script
 * renaming itself in a loop runs into.
 */
const DEFAULT_JOIN_BURST = 5
const DEFAULT_JOIN_REFILL_MS = 5_000
/**
 * Asking for three things at once is a person remembering a set they liked;
 * asking for a fourth in the same half-minute is not. Tighter than chat because
 * a wish is not conversation: every one of them is a row in a list somebody
 * has to read, and a book nobody can get through is the same as no book.
 */
const DEFAULT_WISH_BURST = 3
const DEFAULT_WISH_REFILL_MS = 30_000
/**
 * Looser than anything a person types, because this is a machine answering.
 *
 * Setting up one voice is an answer and then a dribble of ICE candidates, a
 * dozen or two, as fast as the browser finds them. The bucket is here for the
 * same reason the chat's is — nothing a single anonymous socket sends should
 * turn into unbounded work — and it has to leave a legitimate negotiation
 * completely untouched, or it becomes a listener who cannot be heard.
 *
 * The decks are exempt; see `signal`.
 */
const DEFAULT_SIGNAL_BURST = 40
const DEFAULT_SIGNAL_REFILL_MS = 500

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

/** What a station with no `air` of its own reports: always broadcasting. */
const ALWAYS_ON: AirSnapshot = { live: true, since: null }

/**
 * What a station with no `mic` reports: nobody talking, and the depth the
 * console would start at anyway.
 *
 * `duckTo` is a real value rather than a null, because it is the answer to
 * "how far would the music drop", which has one whether or not this station
 * can ask it. A client is spared a special case it would only ever resolve to
 * the same number.
 */
const SHUT: MicSnapshot = { live: false, duckTo: DEFAULT_DUCK, since: null }

/**
 * Attaches the station's websocket surface to an existing HTTP server.
 *
 * Connections drive nothing, and that *is* the socket's half of the admin gate:
 * every mutation lives behind `requireAdmin` on an HTTP route, and
 * command-shaped frames are refused by name (see `parseClientMessage`), so the
 * only way to move the station is a request that went through the gate.
 *
 * Signalling is the one thing here that reads an admin cookie, and it is worth
 * being exact about what that does and does not change. It is not a command: an
 * offer mutates nothing, plays nothing and is not even read by this process,
 * which relays it the same way it relays no audio. What it is, is *addressed* —
 * the decks may reach a listener and a listener may only reach the decks — and
 * an address book needs to know which connection is which. So the socket now
 * asks, once, on the upgrade, and the answer buys exactly that one privilege.
 * A socket carrying the password still cannot skip a track, read the wish book
 * or go on air over this connection.
 *
 * A socket may name itself, and that is the whole of identity here: a nickname
 * held in memory for as long as the socket lasts, which buys a row in the
 * roster and no say over anything.
 */
export function attachRealtime({
  server,
  station,
  air,
  schedule,
  mic,
  mutes,
  padding,
  chat,
  wishes,
  plays,
  path = '/ws',
  admit,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
  chatBurst = DEFAULT_CHAT_BURST,
  chatRefillMs = DEFAULT_CHAT_REFILL_MS,
  joinBurst = DEFAULT_JOIN_BURST,
  joinRefillMs = DEFAULT_JOIN_REFILL_MS,
  wishBurst = DEFAULT_WISH_BURST,
  wishRefillMs = DEFAULT_WISH_REFILL_MS,
  isAdmin,
  onDecksGone,
  signalBurst = DEFAULT_SIGNAL_BURST,
  signalRefillMs = DEFAULT_SIGNAL_REFILL_MS,
  log,
}: RealtimeOptions): RealtimeHandle {
  const { playback, queue } = station
  // Omitting `air` means a station that is always on. Tests that are about the
  // chat should not each have to open a session first, and a socket layer that
  // refused everything without one would make them.
  const onAir = (): boolean => air?.live ?? true
  const airSnapshot = (): AirSnapshot => air?.snapshot() ?? ALWAYS_ON
  const micSnapshot = (): MicSnapshot => mic?.snapshot() ?? SHUT
  const wss = new WebSocketServer({
    server,
    path,
    maxPayload: MAX_PAYLOAD_BYTES,
    // Refused at the handshake, before a socket exists. Closing it a moment
    // later would work too, but the client cannot tell that apart from the
    // station dropping, and would sit there reconnecting into it forever,
    // telling the listener the station was down when it is only shut to them.
    // A 401 on the upgrade is unambiguous, and `ws` sends one for `false`.
    verifyClient: admit ? (info: { req: { headers: IncomingHttpHeaders } }) => admit(info.req.headers) : undefined,
  })
  // Sockets that have answered the most recent heartbeat.
  const responsive = new WeakSet<WebSocket>()
  const presence = new Presence()
  // Which listener a socket is.
  const listenerIds = new WeakMap<WebSocket, number>()
  // Identifies a socket in the roster for as long as it lasts. Not reused: a
  // listener who reconnects is a new row, which is what "left and came back"
  // should look like.
  let nextListenerId = 1
  /**
   * Every open socket by its id, and which of them are the decks.
   *
   * The roster cannot do this job: `Presence` holds only sockets that have
   * named themselves, and a signalling frame has to reach a console that never
   * did. These are about connections rather than about people, which is why
   * they are kept apart from the roster rather than folded into it.
   */
  const socketsById = new Map<number, WebSocket>()
  const deckSockets = new Set<number>()
  // Set once shutdown starts, and read by the roster broadcast below.
  let draining = false

  function broadcast(message: ServerMessage): void {
    // Serialise once, not once per listener.
    const payload = JSON.stringify(message)
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload)
    }
  }

  /** Zero on a station with no padding wired in, which is most of the tests. */
  const padded = (): number => padding?.count ?? 0

  function broadcastPresence(): void {
    // Nothing to tell anyone during a shutdown: every socket left on the roster
    // is on its way out, and announcing each departure to the others would be a
    // roster broadcast per listener as the room empties.
    if (draining) return
    log?.info(
      { present: presence.size, padding: padded(), listeners: wss.clients.size },
      'broadcasting presence',
    )
    broadcast(presenceMessage(presence.list(), padded()))
  }

  /**
   * Writes one message down and sends it to the room.
   *
   * The author is the nickname on the roster, looked up here rather than taken
   * from the frame, so a message can only ever be signed with the name its own
   * socket is listed under. That also makes the roster the gate: a socket that
   * has not said who it is has nothing to sign with, and is told to name itself
   * rather than being quietly ignored.
   */
  function say(socket: WebSocket, listenerId: number, limit: RateLimit, text: string): void {
    if (!chat) {
      send(socket, errorMessage('no_chat', 'this station has no chat', 'say'))
      return
    }
    if (!onAir()) {
      // Before the roster check and before the pace check: being off air is the
      // truest thing about the refusal, and telling somebody to name themselves
      // first would send them round a loop that ends here anyway.
      send(socket, errorMessage('off_air', 'the station is not on air', 'say'))
      return
    }
    const nickname = presence.nicknameOf(listenerId)
    if (nickname === null) {
      send(socket, errorMessage('not_joined', 'name yourself before saying anything', 'say'))
      return
    }
    // After the name is known, because a mute is about a name, and before the
    // pace check, so being muted does not also cost a token.
    if (mutes?.has(nickname)) {
      send(socket, errorMessage('muted', 'the decks have muted you', 'say'))
      return
    }
    if (!limit.take()) {
      send(socket, errorMessage('slow_down', 'slow down', 'say'))
      return
    }

    const message = chat.post(nickname, text)
    log?.info({ id: message.id, listeners: wss.clients.size }, 'broadcasting chat message')
    // A batch of one, in the same frame the history arrives in.
    broadcast(chatMessages([message]))
  }

  /**
   * Writes a wish down and tells the listener who made it. Nobody else.
   *
   * The gate is the roster, as it is for chat and for the same reason: a wish is
   * signed with the name its own socket is listed under, so there is nothing to
   * sign with before naming yourself. What is different is where it goes: this
   * is the one thing a listener can send that is *not* broadcast, because a wish
   * is addressed to whoever runs the decks rather than to the room. The room
   * would learn nothing from it, and the person who asked would have made a
   * request in public that may never be played.
   */
  function wish(socket: WebSocket, listenerId: number, limit: RateLimit, text: string): void {
    if (!wishes) {
      send(socket, errorMessage('no_wishes', 'this station takes no wishes', 'wish'))
      return
    }
    if (!onAir()) {
      send(socket, errorMessage('off_air', 'the station is not on air', 'wish'))
      return
    }
    const nickname = presence.nicknameOf(listenerId)
    if (nickname === null) {
      send(socket, errorMessage('not_joined', 'name yourself before asking for anything', 'wish'))
      return
    }
    // Muted covers wishes as well as chat. Both are text signed with a
    // nickname, and a mute that left the wish book open would just move where
    // somebody was shouting.
    if (mutes?.has(nickname)) {
      send(socket, errorMessage('muted', 'the decks have muted you', 'wish'))
      return
    }
    if (!limit.take()) {
      send(socket, errorMessage('slow_down', 'slow down', 'wish'))
      return
    }

    const made = wishes.make(nickname, text)
    log?.info({ id: made.id }, 'wish written down')
    // Straight back to the one socket that asked, so the listener sees what was
    // written down rather than being left to assume.
    send(socket, wishedMessage(made))
  }

  /**
   * Puts a socket on the roster under a name, and tells the room.
   *
   * Paced, because this is the one frame a listener can send that costs every
   * *other* listener something: a roster goes out to all of them each time one
   * changes. Unpaced, a single socket renaming itself in a loop is a broadcast
   * to the whole room per frame. The cheapest way in there is to make the
   * station shout at everyone, and it needs no nickname, no password and no
   * chat to do it.
   *
   * A join that names a socket what it is already called is free, because it
   * broadcasts nothing: only a change to the roster spends a token. That keeps a
   * client that re-sends its name (on a reconnect, or a render it didn't mean)
   * from being charged for saying nothing.
   */
  function join(socket: WebSocket, listenerId: number, limit: RateLimit, nickname: string): void {
    if (presence.nicknameOf(listenerId) === nickname) return
    if (!limit.take()) {
      send(socket, errorMessage('slow_down', 'slow down', 'join'))
      return
    }
    // Everyone, including the joiner: the roster they are now on is the same
    // frame the rest of the room gets, so there is one code path.
    if (presence.join(listenerId, nickname)) broadcastPresence()
  }

  /**
   * Carries one end of a negotiation to the other, without reading it.
   *
   * The station has no opinion about SDP and never will; what it owns is the
   * address book and the one rule on it. The decks may reach any socket, which
   * is what fanning a voice out is. A listener may reach the decks and nobody
   * else: two listeners have no business negotiating, and a socket that could
   * reach any other by id would be a way to make the station introduce
   * strangers to each other.
   *
   * `from` is stamped here rather than carried by the sender, for the reason a
   * chat message's author is looked up rather than taken from the frame: a
   * frame that named its own origin would let a listener pose as the decks and
   * offer somebody a microphone.
   */
  function signal(socket: WebSocket, senderId: number, limit: RateLimit, to: number, payload: unknown): void {
    const fromDecks = deckSockets.has(senderId)
    if (!fromDecks && !deckSockets.has(to)) {
      // Refused rather than dropped: a client that has this wrong is waiting on
      // an answer that is never coming, and silence is the one response it
      // cannot tell from a slow network.
      send(socket, errorMessage('not_the_decks', 'listeners may only signal the decks', 'signal'))
      return
    }
    // The decks are exempt from pacing, and this is the one place that matters:
    // fanning a voice out to a full room is one offer and a dribble of
    // candidates per listener, all at once, which is exactly the shape a bucket
    // sized for one person typing would refuse. Whoever is sending it already
    // holds the password.
    if (!fromDecks && !limit.take()) {
      send(socket, errorMessage('slow_down', 'slow down', 'signal'))
      return
    }

    const peer = socketsById.get(to)
    if (!peer) {
      // Ordinary rather than exceptional: a listener who closed the tab between
      // the roster going out and the offer being written.
      send(socket, errorMessage('no_such_peer', 'nobody is listening on that id', 'signal'))
      return
    }
    send(peer, signalMessage(senderId, payload))
  }

  wss.on('connection', (socket, request) => {
    responsive.add(socket)
    const listenerId = nextListenerId++
    listenerIds.set(socket, listenerId)
    socketsById.set(listenerId, socket)
    // Asked once, on the way in, and never again: the cookie was on the
    // upgrade, and a socket does not get to change its mind about who it is
    // halfway through an evening.
    if (isAdmin?.(request.headers)) deckSockets.add(listenerId)
    // Per socket, not per listener: the thing being paced is a connection, and
    // a bucket that outlived one would have to be cleaned up after sockets that
    // never come back.
    const chatLimit = new RateLimit({ burst: chatBurst, refillMs: chatRefillMs })
    const joinLimit = new RateLimit({ burst: joinBurst, refillMs: joinRefillMs })
    const wishLimit = new RateLimit({ burst: wishBurst, refillMs: wishRefillMs })
    const signalLimit = new RateLimit({ burst: signalBurst, refillMs: signalRefillMs })

    // First of all, and about this socket rather than about the station: an
    // offer is addressed to an id, and both ends need to know which id is
    // theirs before any of the rest of this means anything. See `YouMessage`.
    send(socket, youMessage(listenerId, deckSockets.has(listenerId)))

    // Whether there is a broadcast at all comes before what is on it: a page
    // told the decks are empty without being told the station is off air would
    // show a gap between songs that never ends.
    send(socket, airMessage(airSnapshot()))
    // And, straight after it, when the station is next on. The two are one
    // sentence on the off-air screen, and a page that got the first without the
    // second would draw "off the air" and then replace it a frame later.
    send(socket, scheduleMessage(schedule?.get() ?? null))
    // Before the music, so a listener arriving mid-break comes in already
    // ducked. The other way round, the first thing they would hear is half a
    // second of a song at full volume under somebody's voice, corrected a
    // frame later, which is a worse arrival than a quiet one.
    send(socket, micMessage(micSnapshot()))
    // Drop straight into the moment: the snapshot alone is enough to align.
    send(socket, stateMessage(playback.snapshot()))
    send(socket, queueMessage(queue.list()))
    // Who is already here. This socket is not on that list yet, because it has
    // not said who it is, and joins it the moment it does.
    send(socket, presenceMessage(presence.list(), padded()))
    // What has been on, so a listener who arrives at 9pm can see what they
    // caught the end of. Written down, so this survives a reload, unlike the
    // roster, which is only true while a socket is open.
    if (plays) send(socket, historyMessage(plays.recent()))
    // The conversation so far, so a joiner walks into a room mid-sentence
    // rather than an empty one. Also how a reconnecting client fills the gap.
    if (chat) send(socket, chatMessages(chat.recent()))

    socket.on('pong', () => responsive.add(socket))

    socket.on('message', (raw) => {
      const parsed = parseClientMessage(raw.toString())
      if (!parsed.ok) {
        send(socket, errorMessage(parsed.code, parsed.error, parsed.about))
        return
      }
      const { message } = parsed
      if (message.type === 'ping') {
        // Same clock that stamps startedAt. See PlaybackState.now().
        send(socket, { type: 'pong', t0: message.t0, t1: playback.now() })
      }
      if (message.type === 'join') join(socket, listenerId, joinLimit, message.nickname)
      if (message.type === 'say') say(socket, listenerId, chatLimit, message.text)
      if (message.type === 'wish') wish(socket, listenerId, wishLimit, message.text)
      if (message.type === 'signal') {
        signal(socket, listenerId, signalLimit, message.to, message.payload)
      }
    })

    // Every way a socket can end arrives here: a tab closing, a network that
    // vanished and was terminated by the heartbeat, a shutdown. So this is the
    // only place a listener needs to be taken off the roster.
    socket.on('close', () => {
      socketsById.delete(listenerId)
      // Only on the way to none, and only when this socket was one of them: a
      // console with two tabs open still has decks after one of them closes.
      // Not during a shutdown either, where every socket is on its way out and
      // the station is not going to be talking over anything.
      if (deckSockets.delete(listenerId) && deckSockets.size === 0 && !draining) {
        onDecksGone?.()
      }
      if (presence.leave(listenerId)) broadcastPresence()
    })

    socket.on('error', (err) => {
      log?.warn({ err }, 'websocket error')
      socket.terminate()
    })
  })

  const onChange = (snapshot: PlaybackSnapshot) => {
    log?.info(
      { trackId: snapshot.track?.id ?? null, listeners: wss.clients.size },
      'broadcasting playback state',
    )
    broadcast(stateMessage(snapshot))
    // A track going on is the one playback change worth writing down. `record`
    // is what decides that: most changes here are a pause, a seek or a resume,
    // and none of those is a new play. A batch of one, in the same frame the
    // history arrives in.
    const played = plays?.record(snapshot.track) ?? null
    if (played) {
      log?.info({ playId: played.id, trackId: played.track.id }, 'recording play')
      broadcast(historyMessage([played]))
    }
  }
  playback.on('change', onChange)

  const onAirChange = (snapshot: AirSnapshot) => {
    log?.info({ live: snapshot.live, listeners: wss.clients.size }, 'broadcasting air state')
    broadcast(airMessage(snapshot))
    // A session ending takes the chat and the history with it, since they are
    // scoped to it, so every client is told to start again rather than being
    // left showing a conversation that no longer exists anywhere.
    if (!snapshot.live) {
      broadcast(chatMessages([]))
      broadcast(historyMessage([]))
    }
  }
  const onMicChange = (snapshot: MicSnapshot) => {
    log?.info(
      { live: snapshot.live, duckTo: snapshot.duckTo, listeners: wss.clients.size },
      'broadcasting mic state',
    )
    broadcast(micMessage(snapshot))
  }
  const onScheduleChange = (next: ScheduledSession | null) => {
    log?.info({ announced: next !== null, listeners: wss.clients.size }, 'broadcasting schedule')
    broadcast(scheduleMessage(next))
  }

  // The padding is not the roster, but it is the other half of the same tally,
  // so it rides the same frame: one message shape carries the headcount, and a
  // page never has to reconcile two of them.
  const onPaddingChange = () => broadcastPresence()

  air?.on('change', onAirChange)
  schedule?.on('change', onScheduleChange)
  mic?.on('change', onMicChange)
  padding?.on('change', onPaddingChange)

  const onQueueChange = (entries: QueueEntry[]) => {
    log?.info({ queued: entries.length, listeners: wss.clients.size }, 'broadcasting queue')
    broadcast(queueMessage(entries))
  }
  queue.on('change', onQueueChange)

  // A listener whose network vanished leaves a socket that looks open forever.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!responsive.has(socket)) {
        socket.terminate()
        continue
      }
      responsive.delete(socket)
      socket.ping()
    }
  }, heartbeatIntervalMs)
  heartbeat.unref()

  // Shutting down twice is normal (a manual close followed by the app's
  // onClose hook), and ws throws if its server is closed a second time.
  let closing: Promise<void> | null = null

  async function shutdown(): Promise<void> {
    draining = true
    clearInterval(heartbeat)
    playback.off('change', onChange)
    queue.off('change', onQueueChange)
    air?.off('change', onAirChange)
    schedule?.off('change', onScheduleChange)
    mic?.off('change', onMicChange)
    padding?.off('change', onPaddingChange)

    const sockets = [...wss.clients]
    const allClosed = Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) resolve()
            else socket.once('close', () => resolve())
          }),
      ),
    )

    for (const socket of sockets) socket.close(1001, 'server shutting down')

    // An upgraded socket keeps the HTTP server open, so a listener that never
    // answers the close handshake would stall shutdown past the platform's
    // SIGTERM grace period. Ask politely, then insist.
    const forceClose = setTimeout(() => {
      for (const socket of sockets) socket.terminate()
    }, closeGraceMs)
    forceClose.unref()

    await allClosed
    clearTimeout(forceClose)

    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()))
    })
  }

  return {
    clientCount: () => wss.clients.size,
    listeners: () => presence.list(),
    broadcast,
    close() {
      closing ??= shutdown()
      return closing
    },
  }
}
