import { useCallback, useEffect, useRef, useState } from 'react'
import { type CoHostApi, SEAT_RENEW_MS, refusalMessage } from '../lib/cohost.js'
import type { CoHostSnapshot } from '../lib/protocol.js'

/**
 * Being in the chair, and staying in it.
 *
 * Three things here, and the second is the one that is easy to get wrong.
 *
 * **Sitting down is a decision, not a page load.** Holding the key means this
 * browser *may* co-host; taking the seat is going on air. They are separate
 * because somebody opening the page in a taxi to see what is on should not be
 * put in front of the room by a URL, and because the console needs a socket id
 * to offer a microphone to — which a cookie cannot carry.
 *
 * **The seat is pinned to a socket, so a reconnect loses it.** A dropped
 * connection is a new id, which is a new row in the roster, which is not the
 * connection the console is offering a microphone to. So this watches for the
 * id changing under it and sits back down on the new one — otherwise a co-host
 * whose phone changed from wifi to mobile data would be silently off the air
 * with a page that still said they were on it.
 *
 * **The lease is a backstop, not the mechanism.** The socket closing is what
 * normally gives the seat up. The heartbeat below is for the case a closed
 * socket cannot cover: a phone in a tunnel, where the connection is neither
 * open nor known to be shut.
 */

export type SeatStatus =
  /** Not in it, and not trying to be. Where the page starts. */
  | 'out'
  /** A request is in flight, either sitting down or standing up. */
  | 'moving'
  /** In it: on air, offered a microphone, named to the room. */
  | 'seated'
  /** Somebody else is co-hosting, or the station is not on air yet. */
  | 'refused'

export interface Seat {
  status: SeatStatus
  /** Who is in it, as the station describes it. Not necessarily this page. */
  snapshot: CoHostSnapshot | null
  /** Whether the person in it is this page. */
  mine: boolean
  /** What to tell somebody, when there is anything worth telling them. */
  error: string | null
  /** Sit down. A gesture: this is also what wakes the audio context. */
  take(): void
  /** Stand up. */
  leave(): void
}

export interface SeatOptions {
  api: CoHostApi
  /** This page's own socket id, off the `you` frame. Null before it lands. */
  me: number | null
  /** What to call this co-host on the air. */
  nickname: string
  /** What the socket last said about the seat, which is the truth. */
  broadcast: CoHostSnapshot | null
  /** Fold a fresh snapshot in without waiting for the broadcast to catch up. */
  onSnapshot(snapshot: CoHostSnapshot): void
  renewMs?: number
}

export function useSeat({
  api,
  me,
  nickname,
  broadcast,
  onSnapshot,
  renewMs = SEAT_RENEW_MS,
}: SeatOptions): Seat {
  const [status, setStatus] = useState<SeatStatus>('out')
  const [error, setError] = useState<string | null>(null)
  /**
   * Whether this page is *trying* to be in the seat.
   *
   * Separate from `status`, which is where it actually is. The difference is
   * what makes a reconnect recoverable: wanting the seat survives the socket
   * that was holding it, so when a new id arrives there is something left to
   * say what to do with it.
   */
  const wanted = useRef(false)
  // Read inside the callbacks rather than closed over, so a re-render does not
  // rebuild the heartbeat and a nickname typed mid-set does not restart it.
  const held = useRef({ api, nickname, onSnapshot })
  held.current = { api, nickname, onSnapshot }

  const mine = broadcast?.seat?.id === me && me !== null

  const sit = useCallback(
    async (id: number) => {
      const { api: client, nickname: called, onSnapshot: fold } = held.current
      setStatus('moving')
      setError(null)
      try {
        fold(await client.takeSeat(id, called))
        setStatus('seated')
      } catch (err) {
        // The station's own sentence when it wrote one — "somebody is already
        // co-hosting", "the station is not on air yet" — because both are
        // things the person reading can act on, and neither is a fault.
        setError(refusalMessage(err) ?? 'could not take the seat')
        setStatus('refused')
      }
    },
    [],
  )

  const take = useCallback(() => {
    wanted.current = true
    if (me === null) {
      // The socket has not said who this page is yet. Nothing is lost: the
      // effect below sits down the moment an id arrives, and this is the same
      // path a reconnect takes.
      setStatus('moving')
      return
    }
    void sit(me)
  }, [me, sit])

  const leave = useCallback(() => {
    wanted.current = false
    setStatus('moving')
    setError(null)
    void (async () => {
      try {
        if (me !== null) held.current.onSnapshot(await held.current.api.leaveSeat(me))
      } catch {
        // Standing up is not something to be refused at. The socket closing
        // does the same job, and the lease does it after that.
      }
      setStatus('out')
    })()
  }, [me])

  /**
   * Sit back down on a new connection.
   *
   * The whole of reconnect handling, and it is one effect because there is only
   * one thing that goes wrong: the id changed. A co-host whose phone moved from
   * wifi to mobile data mid-sentence comes back as a different row in the
   * roster, and without this they would be looking at a page that says they are
   * on air while the console offers a microphone to a socket that has gone.
   */
  useEffect(() => {
    if (!wanted.current || me === null) return
    if (broadcast?.seat?.id === me) return
    void sit(me)
  }, [me, broadcast?.seat?.id, sit])

  /**
   * The heartbeat, against the station's lease.
   *
   * Only while actually seated, and it deliberately does not try to recover
   * from a failed renew: the effect above is what handles losing the seat, and
   * a heartbeat that also re-took it would be two things racing to sit down.
   */
  useEffect(() => {
    if (status !== 'seated' || me === null) return
    const timer = window.setInterval(() => {
      void held.current.api.renewSeat(me).catch(() => undefined)
    }, renewMs)
    return () => window.clearInterval(timer)
  }, [status, me, renewMs])

  /**
   * The station taking the seat back.
   *
   * Whoever runs the decks can stand a co-host down from the console, and the
   * only way this page hears about it is the broadcast. Without this it would
   * go on renewing a seat it does not have and drawing a talk button that does
   * nothing.
   */
  useEffect(() => {
    if (status !== 'seated') return
    if (broadcast === null) return
    if (broadcast.seat?.id === me) return
    wanted.current = false
    setStatus('out')
    setError(
      broadcast.seat === null
        ? 'the decks stood you down'
        : `${broadcast.seat.nickname} is co-hosting now`,
    )
  }, [status, broadcast, me])

  return {
    status: status === 'seated' && !mine ? 'moving' : status,
    snapshot: broadcast,
    mine,
    error,
    take,
    leave,
  }
}
