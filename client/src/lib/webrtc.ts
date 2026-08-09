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
}

export interface PeerLink {
  /** Take something the far end sent. Order-independent except the offer. */
  accept(payload: SignalPayload): Promise<void>
  readonly connection: RTCPeerConnection
  close(): void
}

function link(pc: RTCPeerConnection, { send, onState }: PeerLinkOptions): PeerLink {
  // Trickle: candidates go as they are found rather than being gathered into
  // the offer. Two reasons, and the second is the one that bites — it is
  // dramatically faster to connect, and a description with every candidate
  // folded in is several kilobytes, which is what makes an SDP frame big
  // enough to be worth thinking about at all.
  pc.onicecandidate = (event) => {
    if (event.candidate) send({ kind: 'ice', candidate: event.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => onState?.(pc.connectionState)

  return {
    connection: pc,
    async accept(payload) {
      if (payload.kind === 'ice') {
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
