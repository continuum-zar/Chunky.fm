/** Wire types. Mirrors server/src/protocol.ts; keep the two in step. */

export interface Track {
  id: number
  title: string
  artist: string | null
  album: string | null
  durationMs: number
  filename: string
  artworkPath: string | null
  contentHash: string
  gainDb: number
  uploadedAt: number
}

/**
 * Who this socket is. The first frame of all, and the only one about this
 * browser rather than about the station.
 *
 * The id is the same one the roster carries. Nothing needed it until a voice
 * had to be addressed: the decks offer to a listener by id and so must know
 * which id *not* to offer to — whoever runs the station is usually tuned in as
 * well — and a listener answers whoever offered, which means reading an id off
 * a frame and knowing it is not their own.
 */
export interface YouMessage {
  type: 'you'
  id: number
  /**
   * Whether the station considers this socket the decks.
   *
   * A socket presents its credentials once, on the upgrade, and cannot change
   * its mind afterwards. The console opens its socket when the page loads,
   * which is before anybody has signed in — so a sign-in that happens after
   * that leaves a connection carrying no admin cookie, on a page that otherwise
   * works perfectly, because commands go over HTTP and HTTP does carry it.
   *
   * The only symptom is that no listener can be offered a voice, and it is
   * silent. This is how the page finds out, and what tells it to reconnect.
   */
  decks: boolean
}

/**
 * One end of a WebRTC negotiation, relayed by the station.
 *
 * The station carries these without reading them, the same way it carries no
 * audio: `payload` is an offer, an answer or an ICE candidate. What it does
 * decide is who may send one to whom — the decks may reach any listener, a
 * listener may reach only the decks — and `from` is stamped by the server, so a
 * frame cannot claim to be from somebody it is not.
 */
export interface SignalMessage {
  type: 'signal'
  from: number
  payload: unknown
}

export interface StateMessage {
  type: 'state'
  track: Track | null
  /** Server epoch ms at which the current track was at 0:00. */
  startedAt: number
  /** Position in ms while paused; null while playing. */
  pausedAt: number | null
  serverTime: number
}

/**
 * The same tuple as it comes back from `POST /api/playback`: the broadcast's
 * payload without the frame around it.
 */
export type PlaybackSnapshot = Omit<StateMessage, 'type'>

/**
 * Whether the station is broadcasting at all. Sent on connect, before anything
 * else, and again on every change.
 *
 * Three different things can leave a page with no music, and a listener is owed
 * a different sentence for each: the socket is down (no signal), the station is
 * on air with nothing on the decks (a gap between songs), or nobody is
 * broadcasting tonight. Only the last of those is this. It cannot be derived
 * from the playback snapshot (an empty deck looks identical either way) which
 * is the whole reason it is its own frame.
 */
export interface AirMessage {
  type: 'air'
  live: boolean
  /** Server epoch ms at which this stretch on air began; null while off. */
  since: number | null
}

/** The same pair as it comes back from `/api/session`, without the frame. */
export type AirSnapshot = Omit<AirMessage, 'type'>

/**
 * Whether somebody is talking over the music, and how far it drops while they
 * are. Sent on connect — before `state`, so a listener arriving mid-break comes
 * in already ducked — and again on every change.
 *
 * This is the whole of the talkover on the wire, and it carries no audio. The
 * station does not mix: what it broadcasts is the fact and the depth, and every
 * browser turns down the copy of the track it is already playing. So the duck
 * works whether or not anything else does, and lands everywhere at the same
 * instant, on the clock the room already shares.
 */
export interface MicMessage {
  type: 'mic'
  live: boolean
  /**
   * Linear gain the music sits at while the mic is hot. Carried whether or not
   * the mic is open, so a page always knows how far to duck before it is asked
   * to, and the console's slider has something to show before the first break.
   */
  duckTo: number
  /** Server epoch ms at which the mic opened; null while it is shut. */
  since: number | null
}

/** The same three as they come back from `/api/mic`, without the frame. */
export type MicSnapshot = Omit<MicMessage, 'type'>

/**
 * Who, besides the decks, is allowed to talk. Sent on connect and on change.
 *
 * The mic frame beside this one says the music should sit down and how far;
 * this says whose voice it is sitting down for. Carries no audio either — a
 * guest's voice goes from their browser to the console and out again on the
 * connections the room already has, and the station holds no more of it than it
 * holds of the music.
 *
 * `invited` is broadcast rather than sent to the one page it concerns. The
 * guest reads their own id off it, and a room that can see somebody being
 * brought up reads the pause before a voice for what it is.
 */
export interface FloorMessage {
  type: 'floor'
  speaker: (Listener & { since: number }) | null
  invited: (Listener & { expiresAt: number }) | null
}

/** The same two as they come back from `/api/floor`, without the frame. */
export type FloorSnapshot = Omit<FloorMessage, 'type'>

/**
 * Who has asked for the mic. Only a console is ever sent one of these.
 *
 * The private half of the floor, and the reason it is a separate frame: who is
 * talking is the room's business, and who *asked* is not. A queue the room can
 * see is a social cost paid by the shyest person in it. Same split as the wish
 * book, for the same reasons.
 */
export interface HandsMessage {
  type: 'hands'
  hands: Listener[]
}

/** A track waiting its turn. The id is the entry's, not the track's. */
export interface QueueEntry {
  id: number
  track: Track
}

/** What's coming up. Sent on connect and whenever the queue changes. */
export interface QueueMessage {
  type: 'queue'
  entries: QueueEntry[]
}

/** One listener on the roster. The id is the socket's, not the nickname's. */
export interface Listener {
  id: number
  nickname: string
}

/**
 * Who is listening. Sent on connect and whenever someone joins or leaves, and
 * whenever the decks change the padding below.
 */
export interface PresenceMessage {
  type: 'presence'
  listeners: Listener[]
  /**
   * Heads the decks added to the tally on top of the roster, and zero unless
   * somebody with the password says otherwise.
   *
   * Alongside the roster rather than folded into it, so every name this page
   * draws is a listener who is really there and the added part is a number
   * with no name on it. The headcount is `listeners.length + padding`.
   */
  padding: number
}

/** Something someone said. `at` is server epoch ms. */
export interface ChatMessage {
  id: number
  nickname: string
  text: string
  at: number
}

/**
 * Chat, in batches: the tail of the conversation on connect, and a batch of one
 * for each new message. Merged on id, so a reconnect's replay neither
 * duplicates what is already shown nor leaves a hole where the outage was.
 */
export interface ChatMessagesMessage {
  type: 'chat'
  messages: ChatMessage[]
}

/** Where a wish stands with whoever runs the decks. */
export type WishStatus = 'new' | 'handled'

/** Something a listener asked for. `at` is server epoch ms. */
export interface Wish {
  id: number
  nickname: string
  text: string
  at: number
  status: WishStatus
}

/**
 * "Your wish is written down", to the socket that made it and to no other.
 *
 * The one thing the server sends that is not a broadcast: a wish goes to the
 * admin, who reads the book over HTTP, and back to whoever asked. So the only
 * wishes a listener is ever told about are their own, and this is the whole of
 * that: nothing replays them, so a reload starts the list empty even though the
 * wishes themselves are still in the book. (Unlike the history, which is
 * replayed on connect precisely because it is the room's rather than one
 * listener's.)
 */
export interface WishedMessage {
  type: 'wished'
  wish: Wish
}

/** A track that went on air. `at` is server epoch ms: when it started. */
export interface Play {
  /** The play's id, not the track's: the same track can be on more than once. */
  id: number
  track: Track
  at: number
}

/**
 * What has been on, in batches: the evening so far on connect, and a batch of
 * one each time a track starts. Merged by id, like the chat, so a reconnect
 * fills in what was missed without duplicating what is already on screen.
 * Oldest first on the wire; the page renders it the other way up.
 */
export interface HistoryMessage {
  type: 'history'
  plays: Play[]
}

export interface PongMessage {
  type: 'pong'
  t0: number
  t1: number
}

/**
 * Why the socket refused something. Mirrors `SocketErrorCode` on the server;
 * keep the two in step.
 *
 * A code rather than prose for the same reason `AdminError.code` is one: a
 * client that has to tell "you are going too fast" from "say who you are" should
 * switch on a value, not match on English.
 */
export type SocketErrorCode =
  | 'unrecognised_message'
  | 'nickname_required'
  | 'message_too_long'
  | 'empty_message'
  | 'command_over_http'
  | 'not_joined'
  | 'no_chat'
  | 'wish_too_long'
  | 'empty_wish'
  | 'no_wishes'
  | 'nothing_playing'
  | 'slow_down'
  | 'off_air'
  | 'muted'
  | 'not_the_decks'
  | 'no_such_peer'
  | 'no_floor'
  | 'not_invited'

/**
 * Which frame a refusal is about, when it is about one.
 *
 * `slow_down` and `not_joined` can each come from more than one thing a
 * listener did: both composers, on one socket. Without this, a wish refused
 * for pace also puts "not sent" under the chat, telling someone a message they
 * never sent went nowhere.
 */
export type SocketErrorAbout = 'join' | 'say' | 'wish' | 'signal' | 'hand'

export interface ErrorMessage {
  type: 'error'
  code: SocketErrorCode
  message: string
  /** Absent when the frame was too malformed to say what it was trying to do. */
  about?: SocketErrorAbout
}

/** What a socket refused, and the sequence number that makes a repeat visible. */
export interface SocketRefusal {
  error: ErrorMessage
  seq: number
}

/**
 * The refusal, if the last one was about this composer; otherwise nothing.
 *
 * Null rather than a stale value on purpose: a composer that filtered on the
 * code alone would react to the other one's refusals, and one that held onto
 * the last refusal of its own would react again every time the *other* composer
 * was refused.
 */
export function refusalAbout(
  refusal: SocketRefusal | null,
  about: SocketErrorAbout,
): SocketRefusal | null {
  return refusal && refusal.error.about === about ? refusal : null
}

/**
 * When the station is next on, and the poster for it.
 *
 * The other half of the sentence `air` starts: off air on its own is a fact
 * about right now, and this is what turns it into "back Saturday at nine". Null
 * when nothing is announced. Sent on connect and again whenever it changes, so
 * a page left open on the off-air screen picks up an announcement made after it
 * loaded.
 *
 * `poster` is a bare filename, the way a track carries `artworkPath`; see
 * `posterUrl`. Unlike everything else on this socket the same thing is readable
 * over HTTP without a key, which is what lets the landing page draw it.
 */
export interface ScheduledSession {
  startsAt: number
  poster: string | null
}

export interface ScheduleMessage {
  type: 'schedule'
  schedule: ScheduledSession | null
}

export type ServerMessage =
  | YouMessage
  | SignalMessage
  | StateMessage
  | AirMessage
  | ScheduleMessage
  | MicMessage
  | FloorMessage
  | HandsMessage
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

/** "Here is what to call me." Sent after tuning in, and again on every reconnect. */
export interface JoinMessage {
  type: 'join'
  nickname: string
}

/** "Say this to the room." The server decides who said it, and when. */
export interface SayMessage {
  type: 'say'
  text: string
}

/**
 * "I'd love to hear this." Free text and nothing else: listeners do not browse
 * the library, and the name on it is the one the roster already has.
 */
export interface WishMessage {
  type: 'wish'
  text: string
}

/**
 * "I'd like to say something", and the two answers to being taken up on it.
 *
 * On the socket rather than over HTTP, alongside `say` and `wish`, because a
 * listener has no credentials and this is the only channel they have. The
 * console's half of the same conversation goes to `/api/floor`, where the admin
 * gate is.
 *
 * `lower` does three jobs — withdraw a hand, decline an invitation, come down
 * off the mic — because they are one intent, and which of the three it is
 * depends only on state the station already holds.
 */
export interface HandMessage {
  type: 'hand'
  action: 'raise' | 'lower' | 'accept'
}

/**
 * "Pass this to that socket." The only frame the station carries rather than
 * acts on: it has no opinion about SDP, only about who may address whom.
 */
export interface SignalClientMessage {
  type: 'signal'
  to: number
  payload: unknown
}

export type ClientMessage =
  | PingMessage
  | JoinMessage
  | SayMessage
  | WishMessage
  | HandMessage
  | SignalClientMessage

export const audioUrl = (track: Track) => `/api/audio/${track.filename}`
export const artworkUrl = (track: Track) =>
  track.artworkPath ? `/api/artwork/${track.artworkPath}` : null

/** The poster, or null for an announced time with no picture behind it. */
export const posterUrl = (next: ScheduledSession | null) =>
  next?.poster ? `/api/poster/${next.poster}` : null
