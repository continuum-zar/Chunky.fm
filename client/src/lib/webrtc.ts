/**
 * One voice, from the decks to one listener.
 *
 * The music does not come through here and never will: every listener is still
 * playing the file themselves, aligned to the station's clock. What travels is
 * a microphone, mono, around 32 kbps, straight from one browser to another
 * without touching the station — which is why a mic costs nothing to run and
 * why the duck works whether or not any of this does.
 *
 * The negotiation is deliberately the simplest one WebRTC allows. Audio goes
 * one way, the decks always offer, and a listener never does. That means none
 * of the perfect-negotiation machinery applies, because there is no glare to
 * resolve: two peers can only collide if both of them can start, and only one
 * of these can.
 */

/**
 * What crosses the station between two browsers.
 *
 * Relayed rather than read — the server carries these without understanding
 * them, the same way it carries no audio. Kept to three shapes so the client
 * side can at least tell an offer from a candidate without parsing SDP.
 */
export type SignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }

export function isSignalPayload(value: unknown): value is SignalPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as { kind?: unknown; sdp?: unknown; candidate?: unknown }
  if (payload.kind === 'offer' || payload.kind === 'answer') return typeof payload.sdp === 'string'
  if (payload.kind === 'ice') return typeof payload.candidate === 'object' && payload.candidate !== null
  return false
}

/**
 * What a voice is worth on the wire.
 *
 * Opus at 32 kbps mono is comfortably transparent for speech, and thirty of
 * them is about a megabit off the decks' uplink — which is the number that
 * decides how big a room this can serve. Set through `setParameters` rather
 * than by rewriting the SDP: munging works, and it is a line of string surgery
 * that has to keep pace with a format nobody here controls.
 */
export const VOICE_BITRATE = 32_000

export interface PeerLinkOptions {
  iceServers: RTCIceServer[]
  /** Hand a payload to the far end. The socket is the only route there. */
  send(payload: SignalPayload): void
  /** Whether this link is connecting, connected, or has given up. */
  onState?(state: RTCPeerConnectionState): void
  /** Who this connection is with, for the log line when it settles. */
  label?: string
}

/**
 * What kind of address a candidate is, out of the SDP line it arrives as.
 *
 * The three that matter read straight off it. `host` is this machine's own
 * address, which only works between two browsers that can already reach each
 * other — the same network, or the same laptop. `srflx` is what the outside
 * world sees, discovered by asking a STUN server, and is what carries most
 * connections across the internet. `relay` is a TURN server carrying the audio
 * because nothing direct exists.
 *
 * Counting them is the whole diagnosis when a connection will not establish.
 * Only `host` on both sides means STUN never answered, and no amount of waiting
 * will help. `srflx` on both sides and still failing means a NAT nothing
 * direct crosses, which is what TURN is for and nothing else fixes.
 */
function candidateType(candidate: string): string {
  return / typ (\w+)/.exec(candidate)?.[1] ?? 'unknown'
}

/** How each side's addresses turned out, which is what a failure is diagnosed from. */
export interface VoiceReport {
  label: string
  state: RTCPeerConnectionState
  /** How many ICE servers this connection was given. Zero is host-only. */
  iceServers: number
  /** Local candidate types, counted: `{host: 2, srflx: 1}`. */
  gathered: Record<string, number>
  /** And the far end's, as they arrived. */
  received: Record<string, number>
  /** The pair actually carrying audio, if any got that far. */
  selected: string | null
}

/**
 * Says how a connection turned out, once it has.
 *
 * On the console this is the answer to "why can nobody hear me", and it is
 * printed rather than shown because the shape of the answer changes with the
 * problem: a reader needs the numbers, not a sentence somebody guessed at.
 */
function report(report: VoiceReport): void {
  const line = `[voice] ${report.label}: ${report.state}`
  const detail = {
    iceServers: report.iceServers,
    gathered: report.gathered,
    received: report.received,
    selected: report.selected,
  }
  if (report.state === 'failed') {
    console.warn(
      `${line} — ${diagnose(report)}`,
      detail,
    )
    return
  }
  console.info(line, detail)
}

/**
 * The most likely reason, in a sentence, from the numbers above.
 *
 * Ordered from the failure that explains the most to the one that explains the
 * least, because several of these can be true at once and only the first one
 * is worth acting on. Exported because it decides where somebody looks next,
 * and getting that wrong costs an afternoon in the wrong place.
 */
export function diagnose({ iceServers, gathered, received }: VoiceReport): string {
  const mine = Object.keys(gathered)
  const theirs = Object.keys(received)
  if (theirs.length === 0) {
    return 'the far end sent no addresses at all: signalling is not getting back here'
  }
  if (iceServers === 0) {
    return 'no STUN or TURN was configured, so only same-network connections can work'
  }
  if (!mine.includes('srflx') && !mine.includes('relay')) {
    return 'STUN never answered here, so this browser only knows its own local address'
  }
  if (!theirs.includes('srflx') && !theirs.includes('relay')) {
    return 'STUN never answered at the far end, so it only knows its own local address'
  }
  if (!mine.includes('relay') && !theirs.includes('relay')) {
    return 'both ends know their public address and still cannot meet: this needs TURN'
  }
  return 'a relay was available and the connection still failed'
}

export interface PeerLink {
  /** Take something the far end sent. Order-independent except the offer. */
  accept(payload: SignalPayload): Promise<void>
  readonly connection: RTCPeerConnection
  close(): void
}

function link(pc: RTCPeerConnection, { send, onState, iceServers, label = 'peer' }: PeerLinkOptions): PeerLink {
  const gathered: Record<string, number> = {}
  const received: Record<string, number> = {}
  let settled = false

  /** The pair actually carrying audio, when the browser will say. */
  async function selectedPair(): Promise<string | null> {
    try {
      const stats = await pc.getStats?.()
      if (!stats) return null
      let pair: string | null = null
      stats.forEach((entry: { type?: string; state?: string; nominated?: boolean; localCandidateId?: string }) => {
        if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
          pair = entry.nominated ? 'nominated' : 'succeeded'
        }
      })
      return pair
    } catch {
      return null
    }
  }

  async function settle(state: RTCPeerConnectionState): Promise<void> {
    if (settled) return
    settled = true
    report({
      label,
      state,
      iceServers: iceServers.length,
      gathered,
      received,
      selected: await selectedPair(),
    })
  }

  // Trickle: candidates go as they are found rather than being gathered into
  // the offer. Two reasons, and the second is the one that bites — it is
  // dramatically faster to connect, and a description with every candidate
  // folded in is several kilobytes, which is what makes an SDP frame big
  // enough to be worth thinking about at all.
  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    const type = event.candidate.type ?? candidateType(event.candidate.candidate)
    gathered[type] = (gathered[type] ?? 0) + 1
    send({ kind: 'ice', candidate: event.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState
    onState?.(state)
    // Once, when it is decided. `connected` and `failed` are both worth a line:
    // the working case is what the failing one has to be read against.
    if (state === 'connected' || state === 'failed') void settle(state)
  }

  return {
    connection: pc,
    async accept(payload) {
      if (payload.kind === 'ice') {
        const type = candidateType(payload.candidate.candidate ?? '')
        received[type] = (received[type] ?? 0) + 1
        try {
          await pc.addIceCandidate(payload.candidate)
        } catch {
          // A candidate that arrives before the remote description, or one for
          // a transport that is already settled. Neither is worth surfacing:
          // ICE is a race by design and losing one leg of it is normal.
        }
        return
      }
      if (payload.kind === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
        return
      }
      // An offer, which only a listener ever receives.
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      send({ kind: 'answer', sdp: answer.sdp ?? '' })
    },
    close() {
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      pc.ontrack = null
      pc.close()
    },
  }
}

/**
 * The decks' end: sends a microphone, offers, and never answers.
 *
 * The track is handed in rather than acquired here, and the same track object
 * goes to every listener — one microphone, many connections. It is also handed
 * in *enabled or not*: whether the room can hear it is `track.enabled`, which
 * is instant, while tearing the connection down and rebuilding it would cost a
 * second of dead air at exactly the moment somebody started talking.
 */
export function offerVoice(track: MediaStreamTrack, options: PeerLinkOptions): PeerLink {
  const pc = new RTCPeerConnection({ iceServers: options.iceServers })
  const stream = new MediaStream([track])
  const sender = pc.addTrack(track, stream)

  // Best-effort: `encodings` is empty before negotiation in some browsers, and
  // a bitrate that failed to apply is a voice that costs more than it should
  // rather than one nobody can hear.
  void (async () => {
    try {
      const parameters = sender.getParameters()
      const encodings = parameters.encodings?.length ? parameters.encodings : [{}]
      encodings[0] = { ...encodings[0], maxBitrate: VOICE_BITRATE }
      await sender.setParameters({ ...parameters, encodings })
    } catch {
      // Older or stricter implementations. Not worth failing a connection over.
    }
  })()

  const made = link(pc, options)

  void (async () => {
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      options.send({ kind: 'offer', sdp: offer.sdp ?? '' })
    } catch {
      options.onState?.('failed')
    }
  })()

  return made
}

export interface ReceiveOptions extends PeerLinkOptions {
  /** The voice, once there is one. Fires before the connection is `connected`. */
  onStream(stream: MediaStream): void
}

/**
 * A listener's end: receives a voice, answers, and never offers.
 *
 * `recvonly`, declared up front rather than left to be inferred from having no
 * track to send. It says what this connection is for in the first description
 * either side sees, and it means a listener's browser never asks for a
 * microphone: nothing here can capture anything, and a listener is never
 * prompted for permission to be on a station they came to hear.
 */
export function receiveVoice(options: ReceiveOptions): PeerLink {
  const pc = new RTCPeerConnection({ iceServers: options.iceServers })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track])
    options.onStream(stream)
  }
  return link(pc, options)
}
