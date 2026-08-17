import type { Listener } from './protocol.js'

/**
 * Who can hear the mic, and how loudly the console should say so.
 *
 * The thing this exists for is invisible without it. A listener whose peer
 * connection failed hears the music duck and then nothing at all, which from
 * the decks' side looks exactly like a room that is listening — and the person
 * it happened to has no way to tell you, and will assume you went quiet on
 * purpose. Nobody would ever find out.
 */

/**
 * How a connection is doing, in the console's terms rather than the browser's.
 *
 * `RTCPeerConnectionState` plus the two things it has no word for: waiting to
 * try again, and having stopped trying. Both need telling apart from `failed`,
 * which on its own reads as permanent when it usually is not.
 */
export type PeerHealth = RTCPeerConnectionState | 'retrying' | 'unreachable'

export interface PeerState {
  id: number
  state: PeerHealth
}

export interface ReachRow {
  listener: Listener
  state: PeerHealth
}

/**
 * What each state is called, and how far up the list it belongs.
 *
 * The ranking matters more than the words. What somebody glances at this for is
 * whether anything is wrong, so trouble sorts to the top and the people who can
 * hear you sort out of the way: a room where everything works reads as a quiet
 * list, and a room with one problem in it puts that problem first.
 */
export const HEALTH: Record<PeerHealth, { label: string; rank: number; tone: 'good' | 'wait' | 'bad' }> = {
  unreachable: { label: 'cannot be reached', rank: 0, tone: 'bad' },
  failed: { label: 'connection failed', rank: 1, tone: 'bad' },
  retrying: { label: 'trying again', rank: 2, tone: 'wait' },
  disconnected: { label: 'dropped out', rank: 3, tone: 'wait' },
  new: { label: 'connecting', rank: 4, tone: 'wait' },
  connecting: { label: 'connecting', rank: 4, tone: 'wait' },
  closed: { label: 'gone', rank: 5, tone: 'wait' },
  connected: { label: 'hearing you', rank: 6, tone: 'good' },
}

/**
 * Somebody the roster has but no connection has been made for yet.
 *
 * The roster is the truth about who is in the room, and it moves first: a
 * listener appears there the moment they name themselves, a beat before the
 * decks have offered them anything. Reading that gap as "no connection" rather
 * than as an absence is what stops a new arrival flickering onto the list as a
 * problem and off again a second later.
 */
export const PENDING: PeerHealth = 'new'

/**
 * The room, worst first.
 *
 * Everybody is listed rather than only the broken ones. A count of failures
 * answers "is anything wrong"; a list answers "who do I apologise to", and on a
 * station of under thirty people both are worth having. Ties fall back to id,
 * so the order is stable and a list nobody is touching does not shuffle itself
 * while being read.
 */
export function orderByHealth(room: Listener[], peers: PeerState[]): ReachRow[] {
  const health = new Map(peers.map((peer) => [peer.id, peer.state]))
  return room
    .map((listener) => ({ listener, state: health.get(listener.id) ?? PENDING }))
    .sort((a, b) => HEALTH[a.state].rank - HEALTH[b.state].rank || a.listener.id - b.listener.id)
}

/** How many of them can actually hear it. The number the summary line shows. */
export function hearingCount(rows: ReachRow[]): number {
  return rows.filter((row) => row.state === 'connected').length
}
