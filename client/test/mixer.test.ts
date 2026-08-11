/**
 * What goes out, and to whom.
 *
 * One assertion in this file matters more than the rest of it put together:
 * **the room bus carries the guest and the guest bus does not.** That is
 * mix-minus, and it is the difference between a call-in and a person hearing
 * their own voice half a second late, which is a well-documented way of making
 * somebody unable to finish a sentence.
 *
 * It is also invisible from every angle except the guest's. The console sees a
 * healthy connection, the room hears the guest perfectly, and the only person
 * who knows anything is wrong is the one who cannot say so. So it is pinned
 * here, on the graph, rather than left to be noticed.
 *
 * The rest is the property C2 exists for: the bus is not the microphone. It is
 * there before anybody has granted a microphone, and it survives a rig being
 * torn down and rebuilt, which is what changing input device does.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { airMixer } from '../src/lib/mixer.js'

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

let context: FakeContext
const build = () => airMixer(context as unknown as AudioContext)
const stream = () => ({}) as MediaStream

/** Whether anything downstream of `from` reaches `to`. Depth-first, cycle-free. */
function reaches(from: FakeNode, to: FakeNode): boolean {
  if (from === to) return true
  return from.outputs.some((next) => reaches(next, to))
}

/**
 * The fader between the most recent guest and `to`.
 *
 * Selected through the guest source rather than by asking which gain reaches
 * the room, because the talk input reaches the room as well — that is the whole
 * design — and picking the first gain that did would silently assert about
 * whoever runs the decks instead of about the caller.
 */
function faderTo(to: FakeNode): FakeGain | undefined {
  const source = context.sources.at(-1)
  if (!source) return undefined
  return context.gains.find(
    (gain) => source.outputs.includes(gain) && gain.outputs.includes(to),
  )
}

beforeEach(() => {
  context = new FakeContext()
})

describe('the buses', () => {
  it('exist before there is a microphone', () => {
    const mixer = build()

    // The whole reason this is not part of `useMicInput` any more. There is
    // something to send from the moment the console builds a graph, so a guest
    // can be on air through a console that never granted a microphone.
    expect(mixer.roomTrack).not.toBeNull()
    expect(mixer.guestTrack).not.toBeNull()
    expect(mixer.roomTrack).not.toBe(mixer.guestTrack)
  })

  it('carry whoever runs the decks to the room and to the guest', () => {
    const mixer = build()
    const [room, guest] = context.destinations

    // A guest who could not hear the person interviewing them would have
    // nothing to answer, so the talk input goes to both.
    expect(reaches(mixer.talkIn as unknown as FakeNode, room!)).toBe(true)
    expect(reaches(mixer.talkIn as unknown as FakeNode, guest!)).toBe(true)
  })

  it('falls back to silence rather than throwing on a browser without them', () => {
    context.refuseDestination = true
    const mixer = build()

    // Worse, and still a console: every control it has except the ones that
    // would have made sound. The same honest failure `stationAudio` takes.
    expect(mixer.roomTrack).toBeNull()
    expect(mixer.context).toBeNull()
    expect(() => mixer.hear(stream())).not.toThrow()
  })
})

describe('mix-minus', () => {
  it('puts the guest on the room bus and never on the guest bus', () => {
    const mixer = build()
    const [room, guest] = context.destinations

    mixer.hear(stream())
    mixer.air(1)

    const source = context.sources[0]!
    expect(reaches(source, room!)).toBe(true)
    // The assertion this whole file is for. A path from here to the guest bus
    // is the guest hearing themselves about six hundred milliseconds late,
    // which is inaudible to everybody who could report it.
    expect(reaches(source, guest!)).toBe(false)
  })

  it('does not put the guest on the air just because they connected', () => {
    const mixer = build()
    const [room] = context.destinations

    mixer.hear(stream())

    // Wired, and shut. Somebody put in front of thirty people by a negotiation
    // completing is a decision nobody made.
    const source = context.sources[0]!
    expect(reaches(source, room!)).toBe(true)
    expect(faderTo(room!)?.gain.value).toBe(0)
  })

  it('keeps a fader the console set before anybody was there to hear it', () => {
    const mixer = build()
    const [room] = context.destinations

    mixer.air(0.5)
    mixer.hear(stream())

    // The console can ride a level between calls, and the guest arrives at it
    // rather than at whatever the graph happened to be built with.
    expect(faderTo(room!)?.gain.value).toBe(0.5)
  })

  it('sends the cue to your headphones and nowhere near the room', () => {
    const mixer = build()
    const [room, guest] = context.destinations

    mixer.hear(stream())
    mixer.cue(true)

    const cue = faderTo(context.destination)
    expect(cue?.gain.value).toBe(1)
    // Pre-fade listen: auditioning a caller must not be broadcasting them.
    expect(reaches(cue as unknown as FakeNode, room!)).toBe(false)
    expect(reaches(cue as unknown as FakeNode, guest!)).toBe(false)
  })

  it('replaces one voice with the next rather than stacking them', () => {
    const mixer = build()

    mixer.hear(stream())
    mixer.hear(stream())

    // A second caller through a console that never let go of the first would
    // be two people mixed together, one of whom has hung up.
    expect(context.sources[0]!.disconnects).toBe(1)
  })

  it('takes the voice away when it is handed a null', () => {
    const mixer = build()
    mixer.hear(stream())

    mixer.hear(null)

    expect(context.sources[0]!.disconnects).toBe(1)
  })
})

describe('the faders', () => {
  it('ramp rather than step, at both ends', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(stream())

    mixer.air(1)

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
    mixer.hear(stream())

    mixer.air(4)
    const air = faderTo(room!)!
    expect(air.gain.value).toBe(1)

    mixer.air(-1)
    expect(air.gain.value).toBe(0)
  })

  it('cuts faster than it fades', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(stream())
    mixer.air(1)
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

  it('stays cut until somebody puts the guest back', () => {
    const mixer = build()
    const [room] = context.destinations
    mixer.hear(stream())
    mixer.air(1)

    mixer.cut()
    // A second caller arriving into a console that had cut the first must not
    // inherit an open fader from them.
    mixer.hear(stream())

    expect(faderTo(room!)!.gain.value).toBe(0)
  })
})

describe('closing', () => {
  it('stops both buses and the context with them', () => {
    const mixer = build()
    const [room, guest] = context.destinations

    mixer.close()

    expect(room!.track.stopped).toBe(1)
    expect(guest!.track.stopped).toBe(1)
    expect(context.closed).toBe(1)
  })
})
