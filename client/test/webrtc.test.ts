import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VOICE_BITRATE,
  isSignalPayload,
  offerVoice,
  receiveVoice,
  type SignalPayload,
} from '../src/lib/webrtc.js'

/**
 * One voice, from the decks to one listener.
 *
 * The negotiation here is deliberately the simplest one WebRTC allows: audio
 * one way, the decks always offering, a listener never offering. This file is
 * mostly about pinning that asymmetry, because it is what buys the whole of the
 * simplicity — two peers can only collide if both of them can start, and only
 * one of these can, so none of the perfect-negotiation machinery applies.
 */

interface Sent {
  payload: SignalPayload
}

class FakeSender {
  parameters: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters
  applied: RTCRtpSendParameters | null = null
  getParameters(): RTCRtpSendParameters {
    return this.parameters
  }
  async setParameters(next: RTCRtpSendParameters): Promise<void> {
    this.applied = next
  }
}

class FakePeerConnection {
  static built: FakePeerConnection[] = []

  readonly config: RTCConfiguration
  readonly senders: FakeSender[] = []
  readonly transceivers: { kind: string; init?: RTCRtpTransceiverInit }[] = []
  readonly added: { track: MediaStreamTrack; stream: MediaStream }[] = []
  readonly candidates: RTCIceCandidateInit[] = []
  local: RTCSessionDescriptionInit | null = null
  remote: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'
  closed = false

  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null

  constructor(config: RTCConfiguration = {}) {
    this.config = config
    FakePeerConnection.built.push(this)
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): FakeSender {
    this.added.push({ track, stream })
    const sender = new FakeSender()
    this.senders.push(sender)
    return sender
  }

  addTransceiver(kind: string, init?: RTCRtpTransceiverInit): void {
    this.transceivers.push({ kind, init })
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'the-offer' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'the-answer' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.local = description
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remote = description
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.candidates.push(candidate)
  }

  close(): void {
    this.closed = true
  }

  /** Drive what a real implementation would raise on its own. */
  emitCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({
      candidate: candidate === null ? null : ({ toJSON: () => candidate } as RTCIceCandidate),
    })
  }

  enter(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

const track = () => ({ kind: 'audio' }) as MediaStreamTrack

/** Everything sent to the far end, in order. */
function collector() {
  const sent: Sent[] = []
  return { sent, send: (payload: SignalPayload) => sent.push({ payload }) }
}

/** Waits for the promise chains inside offerVoice to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  FakePeerConnection.built = []
  ;(globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection
  ;(globalThis as { MediaStream?: unknown }).MediaStream = class {
    constructor(readonly tracks: MediaStreamTrack[] = []) {}
  }
})

afterEach(() => {
  delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection
  delete (globalThis as { MediaStream?: unknown }).MediaStream
})

describe('isSignalPayload', () => {
  it('recognises the three shapes that cross the station', () => {
    expect(isSignalPayload({ kind: 'offer', sdp: 'x' })).toBe(true)
    expect(isSignalPayload({ kind: 'answer', sdp: 'x' })).toBe(true)
    expect(isSignalPayload({ kind: 'ice', candidate: {} })).toBe(true)
  })

  it('rejects anything else', () => {
    // The station relays these without reading them, so whatever arrives has
    // been through nothing at all: this is the only check there is.
    for (const value of [null, 'offer', 42, {}, { kind: 'offer' }, { kind: 'ice' }, { kind: 'hello' }]) {
      expect(isSignalPayload(value), JSON.stringify(value)).toBe(false)
    }
  })
})

describe('offerVoice: the decks’ end', () => {
  it('offers without being asked', async () => {
    const { sent, send } = collector()
    offerVoice(track(), { iceServers: [], send })
    await settle()
    expect(sent).toEqual([{ payload: { kind: 'offer', sdp: 'the-offer' } }])
  })

  it('sends the microphone it was handed', async () => {
    // Handed in rather than acquired here, so one microphone can go to a room
    // full of connections.
    const mic = track()
    offerVoice(mic, { iceServers: [], send: collector().send })
    await settle()
    expect(FakePeerConnection.built[0]!.added[0]!.track).toBe(mic)
  })

  it('caps what a voice costs on the wire', async () => {
    // Through setParameters rather than by rewriting the SDP: munging works,
    // and it is string surgery on a format nobody here controls.
    offerVoice(track(), { iceServers: [], send: collector().send })
    await settle()
    const sender = FakePeerConnection.built[0]!.senders[0]!
    expect(sender.applied?.encodings?.[0]?.maxBitrate).toBe(VOICE_BITRATE)
  })

  it('trickles candidates as it finds them', async () => {
    const { sent, send } = collector()
    offerVoice(track(), { iceServers: [], send })
    await settle()
    FakePeerConnection.built[0]!.emitCandidate({ candidate: 'one' })
    FakePeerConnection.built[0]!.emitCandidate({ candidate: 'two' })
    // And the null that marks the end of gathering is not a candidate.
    FakePeerConnection.built[0]!.emitCandidate(null)

    expect(sent.slice(1)).toEqual([
      { payload: { kind: 'ice', candidate: { candidate: 'one' } } },
      { payload: { kind: 'ice', candidate: { candidate: 'two' } } },
    ])
  })

  it('takes the answer that comes back', async () => {
    const link = offerVoice(track(), { iceServers: [], send: collector().send })
    await settle()
    await link.accept({ kind: 'answer', sdp: 'the-answer' })
    expect(FakePeerConnection.built[0]!.remote).toEqual({ type: 'answer', sdp: 'the-answer' })
  })

  it('carries the ice servers it was given', async () => {
    const servers = [{ urls: 'stun:example:3478' }]
    offerVoice(track(), { iceServers: servers, send: collector().send })
    await settle()
    expect(FakePeerConnection.built[0]!.config.iceServers).toBe(servers)
  })

  it('reports where the connection got to', async () => {
    const states: RTCPeerConnectionState[] = []
    offerVoice(track(), { iceServers: [], send: collector().send, onState: (s) => states.push(s) })
    await settle()
    FakePeerConnection.built[0]!.enter('connecting')
    FakePeerConnection.built[0]!.enter('connected')
    expect(states).toEqual(['connecting', 'connected'])
  })
})

describe('receiveVoice: a listener’s end', () => {
  it('asks for nothing but to receive', async () => {
    // `recvonly`, declared up front. It means a listener's browser is never
    // asked for a microphone: somebody who came to hear a radio station should
    // not be prompted for permission to speak on it.
    receiveVoice({ iceServers: [], send: collector().send, onStream: () => undefined })
    expect(FakePeerConnection.built[0]!.transceivers).toEqual([
      { kind: 'audio', init: { direction: 'recvonly' } },
    ])
    expect(FakePeerConnection.built[0]!.added).toEqual([])
  })

  it('says nothing until it is offered something', () => {
    const { sent, send } = collector()
    receiveVoice({ iceServers: [], send, onStream: () => undefined })
    expect(sent).toEqual([])
  })

  it('answers an offer', async () => {
    const { sent, send } = collector()
    const link = receiveVoice({ iceServers: [], send, onStream: () => undefined })
    await link.accept({ kind: 'offer', sdp: 'the-offer' })

    expect(FakePeerConnection.built[0]!.remote).toEqual({ type: 'offer', sdp: 'the-offer' })
    expect(sent).toEqual([{ payload: { kind: 'answer', sdp: 'the-answer' } }])
  })

  it('hands over the voice when one arrives', async () => {
    let heard: MediaStream | null = null
    receiveVoice({ iceServers: [], send: collector().send, onStream: (s) => (heard = s) })
    const stream = {} as MediaStream
    FakePeerConnection.built[0]!.ontrack?.({ streams: [stream], track: track() })
    expect(heard).toBe(stream)
  })

  it('takes candidates in any order, including too early', async () => {
    // ICE is a race by design. A candidate that arrives before the remote
    // description, or one for a transport already settled, is normal, and
    // losing a leg of the race is not something to surface.
    const link = receiveVoice({ iceServers: [], send: collector().send, onStream: () => undefined })
    await expect(link.accept({ kind: 'ice', candidate: { candidate: 'early' } })).resolves.toBeUndefined()
    expect(FakePeerConnection.built[0]!.candidates).toEqual([{ candidate: 'early' }])
  })
})

describe('closing a link', () => {
  it('shuts the connection and stops listening to it', async () => {
    const link = offerVoice(track(), { iceServers: [], send: collector().send })
    await settle()
    link.close()
    const pc = FakePeerConnection.built[0]!
    expect(pc.closed).toBe(true)
    expect(pc.onicecandidate).toBeNull()
    expect(pc.onconnectionstatechange).toBeNull()
    expect(pc.ontrack).toBeNull()
  })
})
