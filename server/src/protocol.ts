import type { AirSnapshot } from './air.js'
import { type ChatMessage, MESSAGE_MAX_LENGTH, normalizeMessageText } from './chat.js'
import type { Play } from './history.js'
import type { MicSnapshot } from './mic.js'
import type { PlaybackSnapshot } from './playback.js'
import { type Listener, normalizeNickname } from './presence.js'
import type { QueueEntry } from './queue.js'
import { type Wish, WISH_MAX_LENGTH, normalizeWishText } from './wishes.js'

/**
 * Who this socket is, as far as the station is concerned. The first frame of
 * all, and the only one addressed to one socket about itself.
 *
 * The id is the same one the roster carries, and it exists on every socket
 * whether or not anybody has named themselves. Until the mic learned to send a
 * voice, nothing needed it: a listener is told who *else* is here and never has
 * to place itself among them. Signalling does, twice over. The decks address an
 * offer to a listener by id, so they need to know which id not to offer to —
 * whoever runs the station is usually tuned in as well, and a console that
 * called itself would spend the evening negotiating with its own microphone.
 * And a listener answers whoever offered, which means reading an id off a frame
 * and trusting it is not its own.
 */
export interface YouMessage {
  type: 'you'
  id: number
  /**
   * Whether the station considers this socket the decks.
   *
   * Here because a socket cannot change its mind about who it is, and a browser
   * has no way to know what it presented on an upgrade it did not write. The
   * console opens its socket when the page loads, which is *before* anybody has
   * signed in, so a sign-in that happens afterwards leaves a connection that
   * carries no admin cookie and never will. Everything else about the console
   * keeps working — commands go over HTTP, which does carry it — and the only
   * symptom is that no listener can be offered a voice, silently.
   *
   * So the station says so, and the client reconnects to get a socket that
   * carries what it now has. Without this the page has to guess, and guessing
   * means either reconnecting every time it signs in or never noticing.
   */
  decks: boolean
}

/**
 * One end of a WebRTC negotiation talking to the other, relayed.
 *
 * The station does not read these. `payload` is an offer, an answer or an ICE
 * candidate, and it is carried from one socket to another without being
 * understood — the same way the station carries no audio. What the server does
 * own is *who may say what to whom*, which is the whole of the gate:
 *
 * - The decks may address any socket. That is what fanning a voice out is.
 * - A listener may address the decks and nobody else. Two listeners have no
 *   business negotiating with each other, and a socket that could reach any
 *   other by id would be a way to make the station introduce strangers.
 *
 * `from` on the way out is stamped by the server, never carried by the sender,
 * for the reason a chat message's author is: a frame that named its own origin
 * would let a listener pose as the decks and offer somebody a microphone.
 */
export interface SignalMessage {
  type: 'signal'
  from: number
  payload: unknown
}

/** Full playback state. Sent on connect and on every change. */
export type StateMessage = PlaybackSnapshot & { type: 'state' }

/**
 * Whether the station is broadcasting at all. Sent on connect and on every
 * change.
 *
 * Deliberately separate from `state`, and not derivable from it. "No track on
 * the decks" and "not on air tonight" look identical in a playback snapshot and
 * mean entirely different things to somebody staring at a page: the first is a
 * gap between songs, the second is a room that is closed. It is also separate
 * from the socket being up, which is the other thing a listener could mistake it
 * for: a station that cannot be reached and a station that is deliberately off
 * are told apart on the client, and only because this frame exists.
 */
export type AirMessage = AirSnapshot & { type: 'air' }

/**
 * When the station is next on, and the poster for it.
 *
 * The other half of the sentence `air` starts. Off air on its own is a fact
 * about right now and nothing a listener can do anything with; this is what
 * turns it into "back Saturday at nine". Sent on connect and again whenever an
 * admin changes it, so a page left open on the off-air screen picks up an
 * announcement made after it loaded.
 *
 * `schedule` is null when nothing is announced, which is the ordinary state and
 * the one the off-air screen already had a sentence for. `poster` is a URL
 * under `/api/poster/`, or null for a time with no picture behind it. Unlike
 * everything else on this socket the same thing is readable over HTTP without a
 * key: see `scheduleRoutes`.
 */
export interface ScheduleMessage {
  type: 'schedule'
  schedule: { startsAt: number; poster: string | null } | null
}

/**
 * Whether somebody is talking over the music, and how far it drops while they
 * are. Sent on connect and on every change.
 *
 * Kept out of `state` for the reason the queue is, and then some: playback
 * changes several times a track, and a mic break changes twice a sentence, so
 * folding them together would ship a playback snapshot every time whoever runs
 * the decks drew breath.
 *
 * It is on the wire at all because the ducking is not a mix. Nothing about the
 * music passes through this server, so there is no fader here to move; what
 * there is instead is this frame, and thirty browsers turning down the copy
 * they are each already playing at the same instant. A listener who arrives
 * mid-break is handed it in the connect burst, before `state`, so they come in
 * already ducked rather than putting half a second of full-volume music under
 * somebody's voice.
 */
export type MicMessage = MicSnapshot & { type: 'mic' }

/**
 * What's coming up. Kept out of `state` on purpose: playback changes several
 * times a track and the queue rarely does, so folding them together would ship
 * the whole queue on every seek.
 */
export interface QueueMessage {
  type: 'queue'
  entries: QueueEntry[]
}

/**
 * Who is listening. Sent on connect and whenever the roster changes, and kept
 * out of `state` for the same reason the queue is: presence turns over on its
 * own schedule, and nobody needs the whole roster again because of a seek.
 */
export interface PresenceMessage {
  type: 'presence'
  listeners: Listener[]
  /**
   * Heads the decks added to the tally, on top of the roster. Zero unless
   * somebody with the password says otherwise; see `Padding`.
   *
   * Alongside the roster rather than folded into it, so that every name a page
   * draws is a listener and the invented part of the count is a number with no
   * name on it. A client shows `listeners.length + padding` as the headcount.
   */
  padding: number
}

/**
 * Chat, as a batch rather than one message per frame.
 *
 * A joiner is handed the tail of the conversation, and a new message is a batch
 * of one: same frame, same handling on the other side. Because messages carry
 * ids, a client that merges on id gets two things for free: a reconnect replays
 * history without duplicating anything, and whatever was said while it was away
 * arrives in that replay instead of being a hole in the conversation.
 */
export interface ChatMessagesMessage {
  type: 'chat'
  messages: ChatMessage[]
}

/**
 * "Your wish is written down", and only to the socket that made it.
 *
 * Not a broadcast, unlike everything else the server volunteers. A wish is
 * addressed to whoever runs the decks rather than to the room. PLAN.md puts
 * "see wishes" on the admin surface and keeps it off the social one, so the
 * only client told about a wish is the one that made it, and the only other way
 * to read the book is `GET /api/wishes`, behind the admin gate.
 *
 * It carries the whole wish rather than an "ok", so the listener sees what was
 * actually written down: normalised, timestamped by the server, and signed with
 * the name they are on the roster under.
 */
export interface WishedMessage {
  type: 'wished'
  wish: Wish
}

/**
 * What has been on, as a batch rather than one play per frame.
 *
 * The same shape as chat, and for the same reasons: a joiner is handed the
 * evening so far, a track starting is a batch of one, and because plays carry
 * ids a client that merges on id neither duplicates what a reconnect replays nor
 * leaves a hole where the outage was. Oldest first, as the chat is; the page
 * renders it newest first, which is a display decision rather than a wire one.
 */
export interface HistoryMessage {
  type: 'history'
  plays: Play[]
}

/**
 * Reply to a clock probe. The client computes
 * `rtt = t2 - t0` and `offset = t1 - (t0 + rtt / 2)`, keeping the sample with
 * the lowest RTT, because the fastest round trip is the least contaminated by
 * queueing delay.
 */
export interface PongMessage {
  type: 'pong'
  /** Echoed back untouched so the client can match probe to reply. */
  t0: number
  /** Server clock when the probe was answered. */
  t1: number
}

/**
 * Why the socket refused something.
 *
 * Snake_case, and the same idea as the `error` field on every HTTP refusal (see
 * `lib/errors.ts`): a code the client switches on, with `message` left as prose
 * for a human. The HTTP surface was made uniform first; a socket refusal that
 * carried only prose left the other half of the API unreadable by machine, so a
 * client wanting to tell "you are going too fast" from "say who you are" had to
 * match on English.
 */
export type SocketErrorCode =
  /** The frame was not JSON, or not a frame this station knows. */
  | 'unrecognised_message'
  /** A join whose nickname was empty once normalised. */
  | 'nickname_required'
  /** A message longer than the station stores. Refused, not truncated. */
  | 'message_too_long'
  /** A message that was nothing but whitespace. */
  | 'empty_message'
  /** A command-shaped frame. Those go over HTTP, where the admin gate is. */
  | 'command_over_http'
  /** Said something before saying who they are. */
  | 'not_joined'
  /** This station was built without a chat. */
  | 'no_chat'
  /** A wish longer than the station stores. Refused, not truncated. */
  | 'wish_too_long'
  /** A wish that was nothing but whitespace. */
  | 'empty_wish'
  /** This station was built without a wish book. */
  | 'no_wishes'
  /** Doing that faster than the station will take it. */
  | 'slow_down'
  /**
   * The station is not on air. There is no session for a message or a wish to
   * belong to, so both are refused until somebody goes live.
   */
  | 'off_air'
  /**
   * Whoever runs the decks has muted this nickname. Told rather than swallowed:
   * a message that vanished silently would read exactly like one that was sent,
   * and somebody would spend the evening talking to a room that cannot hear
   * them without ever finding out.
   */
  | 'muted'
  /**
   * A listener tried to signal something that is not the decks.
   *
   * The one rule the relay enforces on content, and the reason it is a refusal
   * rather than a silent drop: a client that has this wrong is negotiating with
   * a peer that will never answer, and would sit waiting on it forever.
   */
  | 'not_the_decks'
  /**
   * Signalling addressed to a socket that is not there: a listener who left
   * between the roster and the offer, which is ordinary rather than an error.
   */
  | 'no_such_peer'

/**
 * Which frame a refusal is about, when it is about one.
 *
 * The code says what went wrong; this says what it went wrong *for*. Two of the
 * codes (`slow_down` and `not_joined`) are reachable from more than one thing
 * a listener can send, and a client showing "not sent" under the composer has
 * to know which composer. Without it, a wish refused for pace also lights up the
 * chat, telling someone a message they never sent was not sent.
 */
export type SocketErrorAbout = 'join' | 'say' | 'wish' | 'signal'

export interface ErrorMessage {
  type: 'error'
  code: SocketErrorCode
  message: string
  /** Absent when the frame was too malformed to say what it was trying to do. */
  about?: SocketErrorAbout
}

export function errorMessage(
  code: SocketErrorCode,
  message: string,
  about?: SocketErrorAbout,
): ErrorMessage {
  // `about` left undefined simply doesn't survive JSON.stringify, which is the
  // "absent" the type describes, so there is nothing to strip by hand.
  return { type: 'error', code, message, about }
}

export type ServerMessage =
  | YouMessage
  | SignalMessage
  | StateMessage
  | AirMessage
  | ScheduleMessage
  | MicMessage
  | QueueMessage
  | PresenceMessage
  | ChatMessagesMessage
  | WishedMessage
  | HistoryMessage
  | PongMessage
  | ErrorMessage

export interface PingMessage {
  type: 'ping'
  t0: number
}

/**
 * "Here is what to call me."
 *
 * The one frame a listener sends that the server keeps, and it still drives
 * nothing: a nickname buys a row in the roster and no say over the decks. It is
 * separate from connecting because a socket opens when the page loads, which is
 * before anyone has typed a name, and because a reconnect has to say it again.
 */
export interface JoinMessage {
  type: 'join'
  nickname: string
}

/**
 * "Say this to the room."
 *
 * Carries the text and nothing else: no author, no timestamp, no id. Those are
 * the server's to decide: a frame that named its own sender would let a client
 * sign someone else's name to a message, and the nickname on the roster is
 * already the answer to who this socket is.
 */
export interface SayMessage {
  type: 'say'
  text: string
}

/**
 * "I'd love to hear this."
 *
 * Free text and nothing else: no track id, because listeners do not browse the
 * library, and no author, for the reason `say` carries none. What comes back is
 * a `wished` frame to this socket alone; the room is not told, and neither is
 * the queue. Whether it gets played is a person's decision, made later.
 */
export interface WishMessage {
  type: 'wish'
  text: string
}

/**
 * "Pass this to that socket."
 *
 * The one frame a client sends that the station does not act on at all. It is
 * carried, not read: `payload` is somebody's SDP or an ICE candidate, and the
 * station has no opinion about any of it. What it does have an opinion about is
 * `to`, which is the whole gate. See `SignalMessage`.
 *
 * This is also the one place the socket's read-only rule bends, and it bends
 * narrowly on purpose: signalling mutates nothing and drives nothing, so it is
 * not a command, and commands still go over HTTP where the admin gate is. What
 * it *is* is privileged — only the decks may address a listener — which is why
 * the socket now has to know which of its connections is the admin.
 */
export interface SignalClientMessage {
  type: 'signal'
  to: number
  payload: unknown
}

export type ClientMessage = PingMessage | JoinMessage | SayMessage | WishMessage | SignalClientMessage

/**
 * Frames that read as an attempt to drive the station.
 *
 * The socket has no mutating surface at all. Commands go over HTTP, where the
 * admin gate is, so these are refused like anything else. They are named only
 * so a client that tries gets told why instead of a shrug, and so the refusal
 * is a line of code with a test behind it rather than an accident of `ping`
 * being the one type the parser happens to know.
 */
const COMMAND_TYPES = new Set([
  'play',
  'pause',
  'resume',
  'seek',
  'stop',
  'skip',
  'queue',
  'enqueue',
  'move',
  'remove',
  'clear',
  'upload',
  'admin',
  // Going live and ending the broadcast are commands like any other, and go
  // over HTTP for the same reason: that is where the admin gate is.
  'go_live',
  'end_session',
  'mute',
  'unmute',
  // Opening the mic is a command too, however live it feels. The `mic` frame
  // travels the other way, and a client that tries to send one is a client
  // that has mistaken being told for being able to tell.
  'mic',
])

/** Either a message the socket will act on, or why it won't. */
export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: SocketErrorCode; error: string; about?: SocketErrorAbout }

export function stateMessage(snapshot: PlaybackSnapshot): StateMessage {
  return { type: 'state', ...snapshot }
}

export function airMessage(snapshot: AirSnapshot): AirMessage {
  return { type: 'air', ...snapshot }
}

export function scheduleMessage(next: ScheduleMessage['schedule']): ScheduleMessage {
  return { type: 'schedule', schedule: next }
}

export function micMessage(snapshot: MicSnapshot): MicMessage {
  return { type: 'mic', ...snapshot }
}

export function youMessage(id: number, decks: boolean): YouMessage {
  return { type: 'you', id, decks }
}

export function signalMessage(from: number, payload: unknown): SignalMessage {
  return { type: 'signal', from, payload }
}

export function queueMessage(entries: QueueEntry[]): QueueMessage {
  return { type: 'queue', entries }
}

export function presenceMessage(listeners: Listener[], padding = 0): PresenceMessage {
  return { type: 'presence', listeners, padding }
}

export function chatMessages(messages: ChatMessage[]): ChatMessagesMessage {
  return { type: 'chat', messages }
}

export function wishedMessage(wish: Wish): WishedMessage {
  return { type: 'wished', wish }
}

export function historyMessage(plays: Play[]): HistoryMessage {
  return { type: 'history', plays }
}

export function parseClientMessage(raw: string): ParsedClientMessage {
  const unrecognised = {
    ok: false,
    code: 'unrecognised_message',
    error: 'unrecognised message',
  } as const

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unrecognised
  }
  if (typeof parsed !== 'object' || parsed === null) return unrecognised

  const message = parsed as Record<string, unknown>
  if (message.type === 'ping' && typeof message.t0 === 'number' && Number.isFinite(message.t0)) {
    return { ok: true, message: { type: 'ping', t0: message.t0 } }
  }
  if (message.type === 'join' && typeof message.nickname === 'string') {
    // Normalised here rather than taken as sent. The client caps and cleans a
    // nickname before it stores one, but nothing about a socket obliges it to,
    // and the roster goes out to every listener, so the rules are enforced on
    // the side that owns the roster.
    const nickname = normalizeNickname(message.nickname)
    if (nickname.length === 0) {
      return {
        ok: false,
        code: 'nickname_required',
        error: 'a nickname is required',
        about: 'join',
      }
    }
    return { ok: true, message: { type: 'join', nickname } }
  }
  if (message.type === 'say' && typeof message.text === 'string') {
    // Over-length is refused rather than truncated: the composer caps what can
    // be typed, so anything longer arrived from something hand-written, and
    // quietly publishing half of what it said would be worse than saying no.
    if ([...message.text].length > MESSAGE_MAX_LENGTH) {
      return {
        ok: false,
        code: 'message_too_long',
        error: `a message is at most ${MESSAGE_MAX_LENGTH} characters`,
        about: 'say',
      }
    }
    const text = normalizeMessageText(message.text)
    if (text.length === 0) {
      return {
        ok: false,
        code: 'empty_message',
        error: 'an empty message is not a message',
        about: 'say',
      }
    }
    return { ok: true, message: { type: 'say', text } }
  }
  if (message.type === 'wish' && typeof message.text === 'string') {
    // Refused rather than truncated, as an over-long message is: the composer
    // caps what can be typed, and half a request is worse than none, since the admin
    // would read out an album title cut in the middle.
    if ([...message.text].length > WISH_MAX_LENGTH) {
      return {
        ok: false,
        code: 'wish_too_long',
        error: `a wish is at most ${WISH_MAX_LENGTH} characters`,
        about: 'wish',
      }
    }
    const text = normalizeWishText(message.text)
    if (text.length === 0) {
      return { ok: false, code: 'empty_wish', error: 'an empty wish is not a wish', about: 'wish' }
    }
    return { ok: true, message: { type: 'wish', text } }
  }
  if (message.type === 'signal') {
    // `to` is checked here; *who may address it* is checked in the socket
    // layer, which is the only place that knows which connections are the
    // decks. The payload is not checked at all, on purpose: it is somebody
    // else's SDP, and a station that validated it would be a station with an
    // opinion about WebRTC versions it has no way to keep current.
    if (typeof message.to !== 'number' || !Number.isInteger(message.to) || message.to <= 0) {
      return {
        ok: false,
        code: 'unrecognised_message',
        error: 'signalling needs a peer to address',
        about: 'signal',
      }
    }
    if (message.payload === undefined) {
      return {
        ok: false,
        code: 'unrecognised_message',
        error: 'signalling needs something to carry',
        about: 'signal',
      }
    }
    return { ok: true, message: { type: 'signal', to: message.to, payload: message.payload } }
  }
  if (typeof message.type === 'string' && COMMAND_TYPES.has(message.type)) {
    return {
      ok: false,
      code: 'command_over_http',
      error: 'admin commands go over HTTP, not the socket',
    }
  }
  return unrecognised
}
