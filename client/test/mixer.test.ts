/**
 * What goes out, and to whom.
 *
 * One assertion in this file matters more than the rest of it put together:
 * **the room bus carries a voice and that voice's own bus does not.** That is
 * mix-minus, and it is the difference between a call-in and a person hearing
 * their own voice half a second late, which is a well-documented way of making
 * somebody unable to finish a sentence.
 *
 * It is also invisible from every angle except the speaker's. The console sees
 * a healthy connection, the room hears them perfectly, and the only person who
 * knows anything is wrong is the one who cannot say so. So it is pinned here,
 * on the graph, rather than left to be noticed.
 *
 * With a co-host there can be two people up at once, which turns one assertion
 * into three: each of them reaches the room, each of them reaches the *other*,
 * and neither reaches themselves. A shared minus-bus would pass the first and
 * fail the second, and the failure is a three-way conversation where two of the
 * three are talking past each other.
 *
 * The rest is the property this object exists for: the bus is not the
 * microphone. It is there before anybody has granted one, and it survives a rig
 * being torn down and rebuilt, which is what changing input device does.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { airMixer, guestBus } from '../src/lib/mixer.js'

type Call = [string, ...number[]]

class FakeParam {
  value = 0
  readonly calls: Call[] = []
  cancelScheduledValues(when: number): void {
    this.calls.push(['cancel', when])
  }
  setValueAtTime(value: number, when: number): void {
    this.calls.push(['set', value, when])
    this.value = value
  }
  linearRampToValueAtTime(value: number, when: number): void {
    this.calls.push(['ramp', value, when])
    this.value = value
  }
}

/** Every node records what it was wired to, which is the whole assertion. */
class FakeNode {
  readonly name: string
  readonly outputs: FakeNode[] = []
  disconnects = 0
  constructor(name: string) {
    this.name = name
  }
  connect(target: FakeNode): void {
    this.outputs.push(target)
  }
  disconnect(): void {
    this.disconnects += 1
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam()
}

class FakeTrack {
  stopped = 0
  stop(): void {
    this.stopped += 1
  }
}

class FakeDestination extends FakeNode {
  readonly track = new FakeTrack()
  readonly stream = { getAudioTracks: () => [this.track] }
}

class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  currentTime = 0
  closed = 0
  readonly destination = new FakeNode('speakers')
  readonly gains: FakeGain[] = []
  readonly destinations: FakeDestination[] = []
  readonly sources: FakeNode[] = []
  /** Set to make `createMediaStreamDestination` throw, as an old browser does. */
  refuseDestination = false

  createGain(): FakeGain {
    const gain = new FakeGain(`gain${this.gains.length}`)
    this.gains.push(gain)
    return gain
  }
  createMediaStreamDestination(): FakeDestination {
    if (this.refuseDestination) throw new Error('not supported')
    const bus = new FakeDestination(`bus${this.destinations.length}`)
    this.destinations.push(bus)
    return bus
  }
  createMediaStreamSource(): FakeNode {
    const source = new FakeNode(`guest${this.sources.length}`)
    this.sources.push(source)
    return source
  }
  async resume(): Promise<void> {
    this.state = 'running'
  }
  async close(): Promise<void> {
    this.state = 'closed'
    this.closed += 1
  }
}

class FakeElement {
  autoplay = false
  muted = false
  srcObject: MediaStream | null = null
  plays = 0
  async play(): Promise<void> {
    this.plays += 1
  }
}

let context: FakeContext
let elements: FakeElement[] = []
const build = () => airMixer(context as unknown as AudioContext)
const stream = () => ({}) as MediaStream

/** Whether anything downstream of `from` reaches `to`. Depth-first, cycle-free. */
function reaches(from: FakeNode, to: FakeNode): boolean {
  if (from === to) return true
  return from.outputs.some((next) => reaches(next, to))
}

/**
 * The fader between a given voice's source and `to`.
 *
 * Selected through the source rather than by asking which gain reaches the
 * room, because the talk input reaches the room as well — that is the whole
 * design — and picking the first gain that did would silently assert about
 * whoever runs the decks instead of about the person who called in.
 */
function faderTo(to: FakeNode, source = context.sources.at(-1)): FakeGain | undefined {
  if (!source) return undefined
  return context.gains.find(
    (gain) => source.outputs.includes(gain) && gain.outputs.includes(to),
  )
}

/** The seat bus built for an id, by the order they were asked for. */
const seatBus = (index: number) => context.destinations[index + 1]!

beforeEach(() => {
  context = new FakeContext()
  elements = []
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => {
      const element = new FakeElement()
      elements.push(element)
      return element
    },
  }
})

describe('the buses', () => {
  it('exist before there is a microphone', () => {
    const mixer = build()

    // The whole reason this is not part of `useMicInput` any more. There is
    // something to send from the moment the console builds a graph, so somebody
    // can be on air through a console that never granted a microphone.
    expect(mixer.roomTrack).not.toBeNull()
    expect(mixer.seatTrack(7)).not.toBeNull()
    expect(mixer.roomTrack).not.toBe(mixer.seatTrack(7))
  })

  it('builds a minus-bus per voice, once each', () => {
    const mixer = build()

    const first = mixer.seatTrack(7)
    expect(mixer.seatTrack(7)).toBe(first)
    expect(mixer.seatTrack(9)).not.toBe(first)
    // The room bus, plus one each.
    expect(context.destinations).toHaveLength(3)
  })

  it('can be asked for a seat before there is anybody on it', () => {
    // The ordinary order of things: the console offers a connection, and the
    // track it offers has to exist before there is anything coming back on it.
    const mixer = build()
    expect(mixer.seatTrack(7)).not.toBeNull()
    expect(() => mixer.hear(7, stream())).not.toThrow()
  })

  it('carry whoever runs the decks to the room and to everybody up', () => {
    const mixer = build()
    mixer.seatTrack(7)
    mixer.seatTrack(9)
    const [room] = context.destinations

    // Somebody who could not hear the person interviewing them would have
    // nothing to answer, so the talk input goes to all of them.
    expect(reaches(mixer.talkIn as unknown as FakeNode, room!)).toBe(true)
    expect(reaches(mixer.talkIn as unknown as FakeNode, seatBus(0))).toBe(true)
    expect(reaches(mixer.talkIn as unknown as FakeNode, seatBus(1))).toBe(true)
  })

  it('falls back to silence rather than throwing on a browser without them', () => {
    context.refuseDestination = true
    const mixer = build()

    // Worse, and still a console: every control it has except the ones that
    // would have made sound. The same honest failure `stationAudio` takes.
    expect(mixer.roomTrack).toBeNull()
    expect(mixer.seatTrack(7)).toBeNull()
    expect(mixer.context).toBeNull()
    expect(() => mixer.hear(7, stream())).not.toThrow()
  })
})

describe('mix-minus', () => {
  it('puts a voice on the room bus and never on their own', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.seatTrack(7)

    mixer.hear(7, stream())
    mixer.air(7, 1)

    const source = context.sources[0]!
    expect(reaches(source, room!)).toBe(true)
    // The assertion this whole file is for. A path from here to their own bus
    // is somebody hearing themselves about six hundred milliseconds late,
    // which is inaudible to everybody who could report it.
    expect(reaches(source, seatBus(0))).toBe(false)
  })

  it('lets two people up hear each other and not themselves', () => {
    // The co-host and a caller. One shared minus-bus would pass the first half
    // of this and fail the second, and the failure is a conversation in which
    // the two of them cannot hear each other at all.
    const mixer = build()
    mixer.seatTrack(7)
    mixer.seatTrack(9)
    mixer.hear(7, stream())
    mixer.hear(9, stream())
    const [seven, nine] = context.sources

    expect(reaches(seven!, seatBus(1))).toBe(true)
    expect(reaches(nine!, seatBus(0))).toBe(true)
    expect(reaches(seven!, seatBus(0))).toBe(false)
    expect(reaches(nine!, seatBus(1))).toBe(false)
  })

  it('wires a voice into a seat that was asked for after they arrived', () => {
    // Order must not matter: a co-host can be heard before the console has any
    // reason to ask for a caller's bus, and the caller must still hear them.
    const mixer = build()
    mixer.hear(7, stream())
    mixer.seatTrack(9)

    expect(reaches(context.sources[0]!, seatBus(0))).toBe(true)
  })

  it('does not put a voice on the air just because they connected', () => {
    const mixer = build()
    const [room] = context.destinations

    mixer.hear(7, stream())

    // Wired, and shut. Somebody put in front of thirty people by a negotiation
    // completing is a decision nobody made.
    const source = context.sources[0]!
    expect(reaches(source, room!)).toBe(true)
    expect(faderTo(room!)?.gain.value).toBe(0)
  })

  it('keeps a fader the console set before anybody was there to hear it', () => {
    const mixer = build()
    const [room] = context.destinations

    mixer.air(7, 0.5)
    mixer.hear(7, stream())

    // The console can ride a level between calls, and the voice arrives at it
    // rather than at whatever the graph happened to be built with.
    expect(faderTo(room!)?.gain.value).toBe(0.5)
  })

  it('keeps the two faders apart', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(7, stream())
    mixer.hear(9, stream())
    const [seven, nine] = context.sources

    mixer.air(7, 0.3)
    mixer.air(9, 0.9)

    // A partner on a phone in a kitchen and a caller on a headset are not the
    // same volume, and one control would mean fixing either by breaking the
    // other.
    expect(faderTo(room!, seven)?.gain.value).toBe(0.3)
    expect(faderTo(room!, nine)?.gain.value).toBe(0.9)
  })

  it('sends the cue to your headphones and nowhere near the room', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.seatTrack(7)

    mixer.hear(7, stream())
    mixer.cue(7, true)

    const cue = faderTo(context.destination)
    expect(cue?.gain.value).toBe(1)
    // Pre-fade listen: auditioning somebody must not be broadcasting them.
    expect(reaches(cue as unknown as FakeNode, room!)).toBe(false)
    expect(reaches(cue as unknown as FakeNode, seatBus(0))).toBe(false)
  })

  it('parks the stream on an element, or Chrome never decodes it', () => {
    const mixer = build()
    const voice = stream()

    mixer.hear(7, voice)

    // The failure this prevents is the worst shape one can take: the peer
    // connection is `connected`, the console's health column says "you can hear
    // them", their own meter is moving — and there is silence. Every instrument
    // says the call is working except the only one that counts.
    expect(elements[0]?.srcObject).toBe(voice)
    expect(elements[0]?.muted).toBe(true)
    expect(elements[0]?.plays).toBe(1)
  })

  it('lets the element go when the voice does', () => {
    const mixer = build()
    mixer.hear(7, stream())

    mixer.hear(7, null)

    expect(elements[0]?.srcObject).toBeNull()
  })

  it('replaces one voice with the next on the same id rather than stacking them', () => {
    const mixer = build()

    mixer.hear(7, stream())
    mixer.hear(7, stream())

    // A reconnect through a console that never let go of the first would be two
    // of the same person mixed together, one of whom has hung up.
    expect(context.sources[0]!.disconnects).toBe(1)
  })

  it('leaves one voice alone when the other goes', () => {
    const mixer = build()
    mixer.hear(7, stream())
    mixer.hear(9, stream())

    mixer.hear(9, null)

    // The caller hung up. The co-host is still talking.
    expect(context.sources[0]!.disconnects).toBe(0)
    expect(context.sources[1]!.disconnects).toBe(1)
  })
})

describe('the faders', () => {
  it('ramp rather than step, at both ends', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(7, stream())

    mixer.air(7, 1)

    // A step in gain is an audible click, and a click in the middle of a call
    // reads as the station breaking rather than as somebody deciding.
    const air = faderTo(room!)!
    expect(air.gain.calls.map(([kind]) => kind)).toContain('ramp')
    // Read the level first, then pin it: a fader interrupted halfway carries
    // on from where it actually is.
    expect(air.gain.calls.map(([kind]) => kind)).toEqual(
      expect.arrayContaining(['cancel', 'set', 'ramp']),
    )
  })

  it('clamps what it is given, because a fader that stops beats one that errors', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(7, stream())

    mixer.air(7, 4)
    const air = faderTo(room!)!
    expect(air.gain.value).toBe(1)

    mixer.air(7, -1)
    expect(air.gain.value).toBe(0)
  })

  it('cuts faster than it fades', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(7, stream())
    mixer.air(7, 1)
    const air = faderTo(room!)!
    const fade = air.gain.calls.filter(([kind]) => kind === 'ramp').at(-1)!

    context.currentTime = 10
    mixer.cut()

    // The control reached for when something has to stop *now*. Still not a
    // step: zero is a click, and a click is one more thing to interpret.
    const cut = air.gain.calls.filter(([kind]) => kind === 'ramp').at(-1)!
    expect(cut[1]).toBe(0)
    expect(cut[2]! - 10).toBeLessThan(fade[2]! - 0)
  })

  it('cuts everybody, because picking a name is not what you are doing', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(7, stream())
    mixer.hear(9, stream())
    mixer.air(7, 1)
    mixer.air(9, 1)
    const [seven, nine] = context.sources

    mixer.cut()

    expect(faderTo(room!, seven)!.gain.value).toBe(0)
    expect(faderTo(room!, nine)!.gain.value).toBe(0)
  })

  it('stays cut until somebody puts them back', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(7, stream())
    mixer.air(7, 1)

    mixer.cut()
    // A reconnect into a console that had cut them must not inherit an open
    // fader from the connection before it.
    mixer.hear(7, stream())

    expect(faderTo(room!)!.gain.value).toBe(0)
  })
})

describe("a guest's end", () => {
  const bus = () => guestBus(context as unknown as AudioContext)

  it('is one bus and nothing to mix', () => {
    const guest = bus()

    // No second destination, because there is nobody to send a different mix
    // to; no cue, because a guest is not auditioning anybody; no air fader,
    // because whether the room hears them is taken at the console's end.
    expect(context.destinations).toHaveLength(1)
    expect(guest.track).not.toBeNull()
  })

  it('carries whatever is plugged into it', () => {
    const guest = bus()
    expect(reaches(guest.talkIn as unknown as FakeNode, context.destinations[0]!)).toBe(true)
  })

  it('falls back to silence on a browser without stream destinations', () => {
    context.refuseDestination = true
    const guest = bus()

    expect(guest.track).toBeNull()
    expect(guest.context).toBeNull()
  })

  it('stops the track and the context on the way out', () => {
    const guest = bus()
    const [only] = context.destinations

    guest.close()

    // A caller who came down and left a live capture behind would be a browser
    // showing a recording light for a call that ended.
    expect(only!.track.stopped).toBe(1)
    expect(context.closed).toBe(1)
  })
})

describe('closing', () => {
  it('stops every bus and the context with them', () => {
    const mixer = build()
    mixer.seatTrack(7)
    mixer.seatTrack(9)
    const [room] = context.destinations

    mixer.close()

    expect(room!.track.stopped).toBe(1)
    expect(seatBus(0).track.stopped).toBe(1)
    expect(seatBus(1).track.stopped).toBe(1)
    expect(context.closed).toBe(1)
  })
})
