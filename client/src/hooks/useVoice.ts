import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerMessage } from '../lib/protocol.js'
import type { PeerHealth, PeerState } from '../lib/reach.js'
import type { StationConnection } from '../lib/station.js'
import {
  type PeerLink,
  channelOf,
  inviteVoice,
  isSignalPayload,
  offerVoice,
  receiveVoice,
  sendVoice,
} from '../lib/webrtc.js'

/**
 * The voice, both ends of it.
 *
 * Two hooks and one thing they share: neither of them moves any music. Every
 * listener is still playing the file themselves on the station's clock, and
 * what these carry is a microphone, peer to peer, past the station entirely.
 * That is why the ducking in M1 was built first and separately — it works
 * whether or not any of this connects, and a listener whose peer connection
 * never establishes still hears the music dip and come back.
 */

/** Where the browser goes to find out how to reach another browser. */
export function useIceServers(enabled: boolean): RTCIceServer[] | null {
  const [servers, setServers] = useState<RTCIceServer[] | null>(null)

  useEffect(() => {
    if (!enabled || servers !== null) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/rtc', { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`/api/rtc answered ${response.status}`)
        const body = (await response.json()) as { iceServers?: RTCIceServer[] }
        const found = body.iceServers ?? []
        if (cancelled) return
        setServers(found)
        // Said out loud, because an empty list here is the difference between a
        // station that works across the internet and one that works on a LAN,
        // and nothing else on either screen would ever mention it.
        if (found.length === 0) {
          console.warn('[voice] the station offered no STUN or TURN: same-network connections only')
        } else {
          console.info(
            '[voice] ice servers',
            found.map((server) => ({
              urls: server.urls,
              // Never the credential itself. Whether one exists is the whole
              // question; what it is, is not this log's business.
              relay: Boolean(server.username),
            })),
          )
        }
      } catch (err) {
        // An empty list is not nothing: it is host candidates only, which is a
        // station that works for everyone on the same network and nobody else.
        // Better than refusing to try, and the honest fallback for a request
        // that failed rather than a station that was configured this way.
        if (cancelled) return
        console.warn('[voice] could not ask the station how to reach anybody:', err)
        setServers([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, servers])

  return servers
}

/**
 * How many times a connection is rebuilt before the console gives up on it.
 *
 * ICE fails for reasons that pass — a network changing under a laptop, a relay
 * that was briefly out — and for reasons that do not, which is a NAT no direct
 * path crosses and no TURN configured to relay it. Two attempts tells them
 * apart without either giving up on the first flake or hammering a listener who
 * was never going to be reachable.
 */
const MAX_VOICE_ATTEMPTS = 2

/** Long enough for whatever broke to have finished breaking. */
const RETRY_DELAY_MS = 2_000

/**
 * How much signalling is held for a page that cannot act on it yet.
 *
 * One negotiation is an offer and a dozen or two candidates, so this is a
 * couple of them: enough that nothing real is lost while `/api/rtc` answers,
 * and small enough that a page which never becomes ready is not quietly
 * collecting an evening of them.
 */
const MAX_HELD_SIGNALS = 64

interface BroadcastOptions {
  connection: StationConnection | null
  /** This socket's own id, so the decks never offer themselves a microphone. */
  me: number | null
  /** What to send the room. Null while there is nothing to send, which is also "no peers". */
  track: MediaStreamTrack | null
  /**
   * What to send whoever is up: the room bus, minus themselves.
   *
   * The whole feature is this being a different track from the one above. Send
   * a guest the room bus and they hear their own voice about six hundred
   * milliseconds after they said it, which is not a cosmetic problem — delayed
   * feedback at that interval is used deliberately to disrupt fluency, and the
   * person it happens to will stop mid-sentence and assume the station broke.
   */
  guestTrack: MediaStreamTrack | null
  /** Who to send it to: the roster, minus this console. */
  targets: number[]
  iceServers: RTCIceServer[] | null
  /**
   * Whoever has the floor, or null. The second connection to exactly one of the
   * targets, going the other way.
   */
  speaker: number | null
  /** A guest's voice, once one is arriving. Null takes it away again. */
  onGuest(stream: MediaStream | null): void
  /**
   * Put the guest on the air, or take them off, as a linear gain.
   *
   * Called by this hook rather than by the console, because the *order* matters
   * more than the value and only this knows when the swap happened. See the
   * talk-channel effect.
   */
  onAir(level: number): void
}

export interface VoiceBroadcast {
  handleMessage(message: ServerMessage): void
  peers: PeerState[]
  /** How the connection carrying the guest's voice is doing, if there is one. */
  guest: PeerHealth | null
}

/**
 * The decks' end: one microphone, one connection per listener.
 *
 * The connections exist for as long as the mic is open, not for as long as
 * somebody is talking, and that is the whole reason the mute in `useMicInput`
 * is a gain node rather than a torn-down peer. Negotiating a connection takes a
 * second or two; doing it when the talk button went down would lose the first
 * second of every break, which is the part with the greeting in it.
 *
 * Between breaks the room is being sent silence, and silence over Opus with
 * discontinuous transmission costs almost nothing.
 */
export function useVoiceBroadcast({
  connection,
  me,
  track,
  guestTrack,
  targets,
  iceServers,
  speaker,
  onGuest,
  onAir,
}: BroadcastOptions): VoiceBroadcast {
  const links = useRef(new Map<number, PeerLink>())
  /**
   * The one connection that goes the other way.
   *
   * Kept apart from `links` rather than in it under a compound key, because it
   * is not the same kind of thing: `links` is a fan-out that follows the roster
   * and this is a single connection that follows the floor. Sharing a map would
   * have the roster diff tearing down a guest's microphone every time somebody
   * else left the room.
   */
  const talk = useRef<{ id: number; link: PeerLink } | null>(null)
  const [guest, setGuest] = useState<PeerHealth | null>(null)
  /**
   * How many times this call's microphone has been rebuilt, and whether one is
   * waiting out its delay.
   *
   * Its own counter rather than a row in `attempts`, because it counts a
   * different thing: that map is about reaching a listener, and this is about
   * hearing one. A guest whose downlink was rebuilt twice has used none of the
   * patience owed to their uplink, and reading one number for both would give
   * up on a call for a reason that had nothing to do with it.
   */
  const talkAttempts = useRef(0)
  const talkRetrying = useRef(false)
  const [talkTick, setTalkTick] = useState(0)
  // Read through a ref so the effect below is not rebuilt — and the guest's
  // connection not torn down — every time the console re-renders.
  const guestStream = useRef(onGuest)
  guestStream.current = onGuest
  const fader = useRef(onAir)
  fader.current = onAir
  // The two buses, read inside the effects rather than listed as dependencies:
  // they are stable for the life of the mixer, and a track identity that
  // changed would tear down every connection in the room.
  const buses = useRef({ track, guestTrack })
  buses.current = { track, guestTrack }
  const attempts = useRef(new Map<number, number>())
  const retries = useRef(new Set<number>())
  const [peers, setPeers] = useState<PeerState[]>([])
  // Bumped to send the effect below round again, which is what rebuilds a
  // connection it finds missing. The retry does not build anything itself:
  // there is one place peers are made, and two would drift.
  const [retryTick, setRetryTick] = useState(0)

  const note = useCallback((id: number, state: PeerHealth) => {
    setPeers((current) => {
      const next = current.filter((peer) => peer.id !== id)
      // Dropped rather than kept as a tombstone: a listener whose connection
      // closed is a listener who left, and the roster beside this already says
      // who is here.
      return state === 'closed' ? next : [...next, { id, state }].sort((a, b) => a.id - b.id)
    })
  }, [])

  /**
   * Build the connection again, a bounded number of times.
   *
   * A rebuild rather than `restartIce`, and the difference is worth being
   * deliberate about. An ICE restart keeps the peer connection and renegotiates
   * its transport, which is lighter and is the right tool when there is state
   * worth preserving. Here there is none: the audio goes one way, the decks
   * always offer, and a listener answering a fresh offer on a fresh connection
   * is a path this code already takes every time somebody joins. Reusing it
   * costs a second or two on a rare failure and removes an entire second way
   * for a negotiation to be half-finished.
   */
  const retry = useCallback(
    (id: number) => {
      if (retries.current.has(id)) return
      const tried = attempts.current.get(id) ?? 0
      if (tried >= MAX_VOICE_ATTEMPTS) {
        // Said out loud rather than left as `failed`, which reads as though it
        // might still come back. This one will not without something changing,
        // and the something is usually a relay nobody has configured.
        note(id, 'unreachable')
        return
      }
      attempts.current.set(id, tried + 1)
      retries.current.add(id)
      note(id, 'retrying')
      window.setTimeout(() => {
        retries.current.delete(id)
        links.current.get(id)?.close()
        links.current.delete(id)
        setRetryTick((tick) => tick + 1)
      }, RETRY_DELAY_MS)
    },
    [note],
  )

  /**
   * Build the guest's microphone again, a bounded number of times.
   *
   * The same ladder the room's connections climb, and for the same reason: ICE
   * fails both for things that pass — a network changing under a laptop, a
   * relay briefly out — and for things that do not, and two attempts tells them
   * apart without either giving up on a flake or hammering somebody who was
   * never reachable.
   *
   * What is different is what a failure *means* here. A listener who cannot be
   * reached misses a mic break. A guest who cannot be reached is on air, in
   * front of a room that has ducked for them, saying things nobody can hear —
   * so the end of this ladder is not silence but a word on the console, and the
   * decision to stand them down stays with the person who can see it.
   */
  const retryTalk = useCallback((id: number) => {
    if (talkRetrying.current) return
    if (talkAttempts.current >= MAX_VOICE_ATTEMPTS) {
      setGuest('unreachable')
      return
    }
    talkAttempts.current += 1
    talkRetrying.current = true
    setGuest('retrying')
    window.setTimeout(() => {
      talkRetrying.current = false
      const open = talk.current
      if (open?.id !== id) return
      open.link.close()
      talk.current = null
      setTalkTick((tick) => tick + 1)
    }, RETRY_DELAY_MS)
  }, [])

  // Deliberately not `targets` itself: a new array every render would tear down
  // every connection on every render. What matters is which ids are in it.
  const wanted = targets.join(',')

  useEffect(() => {
    const open = links.current
    if (!connection || !track || iceServers === null || me === null) {
      for (const link of open.values()) link.close()
      open.clear()
      // A microphone that was shut and opened again deserves a clean slate:
      // whatever could not be reached ten minutes ago is worth one more try,
      // and the failure it gave up on may well have been fixed since.
      attempts.current.clear()
      retries.current.clear()
      setPeers([])
      return
    }

    const ids = wanted === '' ? [] : wanted.split(',').map(Number)
    const live = new Set(ids)

    // Gone: a listener who closed the tab. Their connection is already dead in
    // every way that matters; this is what stops it being remembered.
    for (const [id, link] of open) {
      if (!live.has(id)) {
        link.close()
        open.delete(id)
        attempts.current.delete(id)
        note(id, 'closed')
      }
    }

    // New: somebody who just arrived, everybody the first time through, or one
    // being rebuilt after a failure. A connection waiting out its retry delay
    // is deliberately not rebuilt here — it has no link, and making one now
    // would skip the wait.
    for (const id of ids) {
      if (open.has(id) || retries.current.has(id) || id === me) continue
      note(id, 'new')
      open.set(
        id,
        // Whoever holds the floor gets the bus that does not carry them. This
        // covers the listener who is *already* up when their connection is
        // built — a reconnect, or somebody the console retried — where there is
        // no swap to make because there was nothing there to swap.
        offerVoice(id === speaker ? (buses.current.guestTrack ?? track) : track, {
          iceServers,
          label: `to listener ${id}`,
          send: (payload) => connection.send({ type: 'signal', to: id, payload }),
          onState: (state) => {
            note(id, state)
            if (state === 'failed') retry(id)
          },
        }),
      )
    }
  }, [connection, track, iceServers, me, wanted, retryTick, speaker, note, retry])

  // Leaving the console, or closing the mic, takes every connection with it.
  useEffect(() => {
    const open = links.current
    return () => {
      for (const link of open.values()) link.close()
      open.clear()
    }
  }, [])

  /**
   * The talk channel: one connection, to whoever has the floor.
   *
   * Deliberately independent of the fan-out above. A guest's microphone must
   * not be renegotiated because somebody else joined the room, and their
   * downlink must not be disturbed because their uplink failed — those are two
   * failures with different causes, and the console's job is to tell them
   * apart rather than to bundle them.
   */
  useEffect(() => {
    const open = talk.current
    const wanted = connection && iceServers !== null && speaker !== null && speaker !== me

    // A different caller, or none, is a clean slate: whatever could not be
    // reached ten minutes ago has no bearing on whoever is up now.
    if (!wanted || open?.id !== speaker) {
      if (talkAttempts.current !== 0 && open?.id !== speaker) talkAttempts.current = 0
    }

    if (open && (!wanted || open.id !== speaker)) {
      // Coming down, and the order is the reverse of going up for the same
      // reason. Off the air first, so nothing of theirs is still reaching the
      // room while the rest of this happens; then the voice away; and only then
      // their own connection back onto the bus that carries the room, which is
      // now a room they are no longer on.
      fader.current(0)
      open.link.close()
      talk.current = null
      setGuest(null)
      guestStream.current(null)
      links.current.get(open.id)?.replace(buses.current.track)
    }
    // A rebuild waiting out its delay is deliberately not built here: it has no
    // link, and making one now would skip the wait.
    if (!wanted || talk.current || talkRetrying.current) return

    const id = speaker as number
    // **Before anything of theirs can reach the room.** This is the whole
    // milestone in one line and one ordering: swap their downlink onto the bus
    // that does not carry them, and only then let them onto the one that does.
    // The other way round leaves a window — short, and a whole syllable long —
    // in which a guest is on the room bus and still receiving it, which is the
    // delayed-sidetone failure this entire design exists to avoid.
    links.current.get(id)?.replace(buses.current.guestTrack)
    setGuest('new')
    talk.current = {
      id,
      link: inviteVoice({
        iceServers,
        channel: 'talk',
        label: `from listener ${id}`,
        send: (payload) => connection.send({ type: 'signal', to: id, payload }),
        onStream: (stream) => {
          guestStream.current(stream)
          // On the air only once there is a voice to put there, which is also
          // safely after the swap above: the connection was built before this
          // could fire.
          fader.current(1)
        },
        onState: (state) => {
          setGuest(state)
          // `disconnected` is often a blip ICE recovers from on its own, so
          // only the states it does not come back from take the voice away.
          if (state === 'failed' || state === 'closed') {
            fader.current(0)
            guestStream.current(null)
          }
          if (state === 'failed') retryTalk(id)
        },
      }),
    }
  }, [connection, iceServers, speaker, me, talkTick, retryTalk])

  // Leaving the console takes the guest's connection with it, as it does the
  // room's. Its own effect because it must not run on a speaker changing.
  useEffect(() => {
    const open = talk
    return () => {
      open.current?.link.close()
      open.current = null
    }
  }, [])

  const handleMessage = useCallback((message: ServerMessage) => {
    if (message.type !== 'signal') return
    if (!isSignalPayload(message.payload)) return
    // Answers and candidates only, on either channel. An offer arriving here
    // would be a listener trying to start something, which nothing in this
    // station does — the decks always offer — and which the console has no
    // business accepting. The station refuses to relay one too; see `signal`.
    if (message.payload.kind === 'offer') return
    if (channelOf(message.payload) === 'talk') {
      if (talk.current?.id === message.from) void talk.current.link.accept(message.payload)
      return
    }
    void links.current.get(message.from)?.accept(message.payload)
  }, [])

  return { handleMessage, peers, guest }
}

interface ReceiverOptions {
  connection: StationConnection | null
  me: number | null
  /** Whether this page is in a state to hear anything: tuned in, and on air. */
  active: boolean
  iceServers: RTCIceServer[] | null
  /** Where the voice goes. Null takes it away again. */
  onStream(stream: MediaStream | null): void
  /**
   * This listener's own microphone, for the one of them who has been brought
   * up. Null for everybody else, which is almost everybody.
   *
   * Its presence is what decides whether a talk-channel offer is answered at
   * all: a page with nothing to send has nothing to say to one, and answering
   * with an empty transceiver would leave the console holding a connection that
   * establishes perfectly and carries silence.
   */
  talkTrack?: MediaStreamTrack | null
}

export interface VoiceReceiver {
  handleMessage(message: ServerMessage): void
  /** Whether a voice is actually arriving, as opposed to being announced. */
  connected: boolean
  /** How this listener's own microphone is getting to the decks, if at all. */
  talking: RTCPeerConnectionState | null
}

/**
 * A listener's end: answers whoever offered, and never offers.
 *
 * `recvonly`, so a listener's browser is never asked for a microphone. Somebody
 * who came to hear a radio station should not be prompted for permission to
 * speak on it, and there is nothing here that could accept if they granted it.
 */
export function useVoiceReceiver({
  connection,
  me,
  active,
  iceServers,
  onStream,
  talkTrack = null,
}: ReceiverOptions): VoiceReceiver {
  const link = useRef<PeerLink | null>(null)
  const talk = useRef<PeerLink | null>(null)
  const [connected, setConnected] = useState(false)
  const [talking, setTalking] = useState<RTCPeerConnectionState | null>(null)
  /**
   * Signalling that arrived before this page could act on it.
   *
   * Joining does three things at once — tunes in, asks `/api/rtc` how to reach
   * another browser, and puts this listener on the roster — and the decks offer
   * the moment they see the third. Nothing orders those, so an offer can land
   * while the ICE servers are still a request in flight. Dropping it looked
   * safe and is not: the decks offer when the roster *changes*, so there is no
   * second chance, and the listener would sit through the evening ducking for
   * mic breaks they never hear.
   */
  const waiting = useRef<ServerMessage[]>([])
  const [ready, setReady] = useState(false)

  // Read through refs so the message handler never has to be rebuilt: it is
  // wired into the socket once, and a new identity every render would mean
  // re-registering it on every frame the station sends.
  const held = useRef({ connection, me, active, iceServers, onStream, talkTrack })
  useEffect(() => {
    held.current = { connection, me, active, iceServers, onStream, talkTrack }
  })

  const drop = useCallback(() => {
    link.current?.close()
    link.current = null
    talk.current?.close()
    talk.current = null
    setConnected(false)
    setTalking(null)
    held.current.onStream(null)
  }, [])

  // Coming down closes the microphone's connection and leaves the other alone:
  // somebody who has stopped talking is still listening, and tearing down their
  // downlink would take the station away from them as a reward for it.
  useEffect(() => {
    if (talkTrack === null && talk.current) {
      talk.current.close()
      talk.current = null
      setTalking(null)
    }
  }, [talkTrack])

  /**
   * Ends the voice, and the four things that mean it is over.
   *
   * `active` covers tuning out and the station going off air — what ends with a
   * session ends completely, and a voice from a broadcast that finished is as
   * stale as the chat it would have been talked over. `me` and `connection`
   * cover a reconnect: a new socket is a new row in the roster, so the
   * negotiation the old one was in the middle of is one nobody is still having.
   */
  useEffect(() => {
    // Anything held back from before belongs to the socket or the broadcast
    // that has just ended, and answering it later would be answering a
    // negotiation nobody is still having.
    waiting.current = []
    if (!active) drop()
  }, [active, me, connection, drop])

  useEffect(() => () => drop(), [drop])

  const deliver = useCallback(
    (message: ServerMessage) => {
      if (message.type !== 'signal') return
      const { connection: socket, me: self, active: on, iceServers: servers, onStream: play } = held.current
      if (!socket || !on || servers === null) return
      // The station stamps `from`, so this cannot be forged; the guard is
      // against the decks addressing themselves while also tuned in.
      if (message.from === self) return
      if (!isSignalPayload(message.payload)) return

      // Answers never arrive here: a listener does not offer, so the decks have
      // nothing to answer. Anything else is a candidate for a link below.
      if (message.payload.kind === 'answer') return

      if (channelOf(message.payload) === 'talk') {
        const { talkTrack: microphone } = held.current
        if (message.payload.kind === 'offer') {
          // Nothing to send means nothing to answer with. A page that answered
          // anyway would hand the console a connection that establishes
          // perfectly and carries silence, which is the worst shape a failure
          // can take: healthy on every screen and inaudible in the room.
          if (!microphone) return
          talk.current?.close()
          talk.current = sendVoice(microphone, {
            iceServers: servers,
            channel: 'talk',
            label: `to the decks (${message.from})`,
            send: (out) => socket.send({ type: 'signal', to: message.from, payload: out }),
            onState: (state) => setTalking(state),
          })
        }
        void talk.current?.accept(message.payload)
        return
      }

      if (message.payload.kind === 'offer') {
        // A fresh offer replaces whatever was there. The decks re-offer when
        // they reconnect, and answering the new one on the old connection would
        // be answering a negotiation nobody is still having.
        link.current?.close()
        link.current = receiveVoice({
          iceServers: servers,
          label: `from the decks (${message.from})`,
          send: (payload) => socket.send({ type: 'signal', to: message.from, payload }),
          onStream: (stream) => play(stream),
          onState: (state) => {
            setConnected(state === 'connected')
            // `disconnected` is often a blip that ICE recovers from on its own,
            // so only the states it does not come back from take the voice away.
            if (state === 'failed' || state === 'closed') {
              setConnected(false)
              play(null)
            }
          },
        })
      }
      // The offer itself goes through the same door as a candidate: `accept`
      // is what turns it into an answer and sends it back.
      void link.current?.accept(message.payload)
    },
    [],
  )

  // Whether this page could act on a signalling frame if one arrived.
  useEffect(() => {
    setReady(connection !== null && active && iceServers !== null)
  }, [connection, active, iceServers])

  // Whatever was held back, in the order it arrived, the moment it can be
  // acted on. Order matters: an offer has to be answered before the candidates
  // that follow it mean anything.
  useEffect(() => {
    if (!ready || waiting.current.length === 0) return
    const held = waiting.current
    waiting.current = []
    for (const message of held) deliver(message)
  }, [ready, deliver])

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type !== 'signal') return
      if (ready) {
        deliver(message)
        return
      }
      // Bounded, so a page that never becomes ready — a listener who opened the
      // door and walked away — does not quietly collect an evening of ICE.
      if (waiting.current.length < MAX_HELD_SIGNALS) waiting.current.push(message)
    },
    [ready, deliver],
  )

  return { handleMessage, connected, talking }
}
