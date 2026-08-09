import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VOICE_BITRATE,
  type VoiceReport,
  diagnose,
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

  /**
   * Drive what a real implementation would raise on its own.
   *
   * The `candidate` string is carried as well as the JSON, because that is
   * where the address type is read from — and Firefox's end-of-gathering marker
   * is an empty one, which is the case worth being able to reproduce.
   */
  emitCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onicecandidate?.({
      candidate:
        candidate === null
          ? null
          : ({
              candidate: candidate.candidate ?? '',
              type: / typ (\w+)/.exec(candidate.candidate ?? '')?.[1] ?? null,
              toJSON: () => candidate,
            } as unknown as RTCIceCandidate),
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

/**
 * Turning the numbers into somewhere to look.
 *
 * When a voice will not connect there are four or five reasons it could be,
 * they need completely different fixes, and every one of them looks identical
 * from the console: a listener who never gets past "connecting". These are the
 * counts that tell them apart, so what matters is that the *first* sentence
 * offered is the one worth acting on.
 */
describe('diagnose', () => {
  const report = (over: Partial<VoiceReport> = {}): VoiceReport => ({
    label: 'peer',
    state: 'failed',
    iceServers: 1,
    gathered: { host: 2, srflx: 1 },
    received: { host: 2, srflx: 1 },
    selected: null,
    ...over,
  })

  it('names a signalling problem before anything about the network', () => {
    // Nothing arriving from the far end is not a NAT problem and no amount of
    // TURN will touch it: the addresses are not getting back here at all.
    expect(diagnose(report({ received: {} }))).toMatch(/signalling/)
  })

  it('names an unconfigured station before blaming a network', () => {
    expect(diagnose(report({ iceServers: 0, received: { host: 1 } }))).toMatch(/no STUN or TURN/)
  })

  it('says which end STUN failed at', () => {
    expect(diagnose(report({ gathered: { host: 2 } }))).toMatch(/here/)
    expect(diagnose(report({ received: { host: 2 } }))).toMatch(/far end/)
  })

  it('asks for a relay only once both ends know their public address', () => {
    // The one that costs money to fix, so it is not offered until everything
    // cheaper has been ruled out.
    expect(diagnose(report())).toMatch(/needs TURN/)
  })

  it('has something to say when a relay was there and it still failed', () => {
    const withRelay = report({
      gathered: { host: 1, srflx: 1, relay: 1 },
      received: { host: 1, srflx: 1, relay: 1 },
    })
    expect(diagnose(withRelay)).toMatch(/relay was available/)
  })
})

describe('counting addresses', () => {
  /** The counts a failure is read from, out of a finished link. */
  async function countsFor(candidates: string[]): Promise<Record<string, number>> {
    const seen: Record<string, number> = {}
    const link = receiveVoice({
      iceServers: [],
      send: () => undefined,
      onStream: () => undefined,
    })
    for (const candidate of candidates) {
      await link.accept({ kind: 'ice', candidate: { candidate } })
    }
    // Read back through what the connection was actually handed, which is the
    // only externally visible record of what was counted.
    for (const given of FakePeerConnection.built[0]!.candidates) {
      const type = / typ (\w+)/.exec(given.candidate ?? '')?.[1] ?? (given.candidate ? 'unknown' : 'end')
      seen[type] = (seen[type] ?? 0) + 1
    }
    return seen
  }

  it('tells the three kinds of address apart', async () => {
    // The whole diagnosis rests on this. `host` is a machine's own address and
    // only works between browsers that can already reach each other; `srflx` is
    // what the outside world sees; `relay` is a TURN server carrying the audio.
    expect(
      await countsFor([
        'candidate:1 1 udp 1 192.168.1.5 5000 typ host',
        'candidate:2 1 udp 1 203.0.113.9 5000 typ srflx',
        'candidate:3 1 udp 1 198.51.100.4 5000 typ relay',
      ]),
    ).toEqual({ host: 1, srflx: 1, relay: 1 })
  })

  it('forwards the end-of-gathering marker without calling it an address', async () => {
    // Firefox signals the end with an empty candidate string rather than the
    // null everything else uses. It is worth forwarding — the far end reads it
    // as "that is all of them" — and counting it as an address put an
    // `unknown` in the middle of the numbers somebody reads a failure from.
    const link = receiveVoice({ iceServers: [], send: () => undefined, onStream: () => undefined })
    await link.accept({ kind: 'ice', candidate: { candidate: '' } })
    expect(FakePeerConnection.built[0]!.candidates).toEqual([{ candidate: '' }])
  })
})
