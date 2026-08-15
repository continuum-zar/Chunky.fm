import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stationAudio } from '../src/lib/audio-graph.js'

/**
 * The gain stage the music sits in while somebody talks over it.
 *
 * Two things here are worth a test rather than a comment. The first is that a
 * given element is only ever routed once: `createMediaElementSource` throws on
 * a second call for the same element, React's StrictMode double-invokes effects
 * in development, and a listener can press join twice, so the guard is load
 * bearing rather than tidy.
 *
 * The second is that the duck is always a ramp. A step change in gain is an
 * audible click, and a click in the middle of a song reads as the station
 * breaking rather than as somebody deciding to speak.
 */

type Call = [string, ...number[]]

class FakeParam {
  value = 1
  readonly calls: Call[] = []

  cancelScheduledValues(when: number): void {
    this.calls.push(['cancel', when])
  }

  setValueAtTime(value: number, when: number): void {
    this.calls.push(['set', value, when])
    this.value = value
  }

  setTargetAtTime(target: number, when: number, constant: number): void {
    this.calls.push(['target', target, when, constant])
  }
}

class FakeGain {
  readonly gain = new FakeParam()
  connected = 0
  connect(): void {
    this.connected += 1
  }
}

class FakeSource {
  connected = 0
  connect(): void {
    this.connected += 1
  }
}

class FakeStreamSource {
  readonly connectedTo: unknown[] = []
  disconnects = 0
  connect(target: unknown): void {
    this.connectedTo.push(target)
  }
  disconnect(): void {
    this.disconnects += 1
  }
}

/** Enough of an `<audio>` element for the decoder-sink workaround. */
class FakeElement {
  autoplay = false
  muted = false
  srcObject: MediaStream | null = null
  plays = 0
  async play(): Promise<void> {
    this.plays += 1
  }
}

class FakeContext {
  static built: FakeContext[] = []
  /** Set to make `createMediaElementSource` throw, as a re-route really does. */
  static refuseSource = false

  state: 'suspended' | 'running' | 'closed' = 'suspended'
  currentTime = 0
  readonly destination = {}
  sources = 0
  readonly gains: FakeGain[] = []
  readonly streamSources: FakeStreamSource[] = []

  constructor() {
    FakeContext.built.push(this)
  }

  createMediaElementSource(): FakeSource {
    if (FakeContext.refuseSource) throw new Error('InvalidStateError')
    this.sources += 1
    return new FakeSource()
  }

  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }

  createMediaStreamSource(): FakeStreamSource {
    const source = new FakeStreamSource()
    this.streamSources.push(source)
    return source
  }

  async resume(): Promise<void> {
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }
}

/** A fresh key for the module's WeakMap; nothing here touches the element. */
const element = () => ({}) as HTMLAudioElement

function withAudio(Ctor: unknown): void {
  ;(globalThis as { window?: unknown }).window = { AudioContext: Ctor }
}

let elements: FakeElement[] = []

beforeEach(() => {
  FakeContext.built = []
  FakeContext.refuseSource = false
  elements = []
  withAudio(FakeContext)
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => {
      const element = new FakeElement()
      elements.push(element)
      return element
    },
  }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { document?: unknown }).document
})

/** The last automation the stage asked for, which is where the ramp shows up. */
const lastTarget = (gain: FakeGain): Call | undefined =>
  [...gain.gain.calls].reverse().find((call) => call[0] === 'target')

describe('stationAudio', () => {
  it('routes the element through two gain stages on the way to the speakers', () => {
    const audio = element()
    stationAudio(audio)

    const context = FakeContext.built[0]!
    expect(context.sources).toBe(1)
    // The duck and the mute. They are separate because they answer to different
    // people: the station decides where the music sits under a voice, and this
    // listener decides whether any of it comes out at all.
    expect(context.gains).toHaveLength(2)
    expect(context.gains[0]!.connected).toBe(1)
    expect(context.gains[1]!.connected).toBe(1)
  })

  it('wakes the context, because a suspended one is silence rather than quiet', () => {
    stationAudio(element())
    expect(FakeContext.built[0]!.state).toBe('running')
  })

  it('routes a given element exactly once', () => {
    // The load-bearing part. StrictMode runs effects twice in development and a
    // listener can press join twice; a second source node for the same element
    // throws, and the version without this guard fails the first time it runs.
    const audio = element()
    const first = stationAudio(audio)
    const second = stationAudio(audio)

    expect(second).toBe(first)
    expect(FakeContext.built).toHaveLength(1)
    expect(FakeContext.built[0]!.sources).toBe(1)
  })

  it('ramps rather than jumping', () => {
    const audio = element()
    stationAudio(audio).duck(0.2)

    const gain = FakeContext.built[0]!.gains[0]!
    expect(lastTarget(gain)).toEqual(['target', 0.2, 0, expect.any(Number)])
    // The time constant is what makes it a fader rather than a switch.
    expect(lastTarget(gain)![3]).toBeGreaterThan(0)
  })

  it('ramps on from where the music actually is, not from where it was aimed', () => {
    // A break interrupted halfway — talk, stop, talk again — must not snap back
    // to the previous ramp's target before starting the new one.
    const audio = element()
    const stage = stationAudio(audio)
    const gain = FakeContext.built[0]!.gains[0]!

    stage.duck(0.2)
    gain.gain.value = 0.6 // mid-ramp, on the way down
    stage.duck(1)

    const pinned = gain.gain.calls.filter((call) => call[0] === 'set').at(-1)
    expect(pinned).toEqual(['set', 0.6, 0])
    expect(lastTarget(gain)).toEqual(['target', 1, 0, expect.any(Number)])
  })

  it('clamps a depth it could not play', () => {
    const audio = element()
    const stage = stationAudio(audio)
    const gain = FakeContext.built[0]!.gains[0]!

    stage.duck(-1)
    expect(lastTarget(gain)![1]).toBe(0)
    stage.duck(4)
    expect(lastTarget(gain)![1]).toBe(1)
  })

  it('goes deaf rather than throwing where there is no Web Audio', () => {
    // `audio.volume` is not the fallback it looks like: read-only on iOS, and
    // unrampable everywhere, so it would trade a working duck for a click on
    // the platform least able to spare one. Doing nothing is the honest failure.
    withAudio(undefined)
    const stage = stationAudio(element())

    expect(() => stage.duck(0.2)).not.toThrow()
    expect(() => stage.hush(true)).not.toThrow()
    expect(() => stage.resume()).not.toThrow()
    expect(() => stage.close()).not.toThrow()
    expect(FakeContext.built).toHaveLength(0)
  })

  it('goes deaf rather than throwing when the element is already routed', () => {
    // The case the guard above cannot catch: something outside this module got
    // to the element first. There is nothing to recover — a second graph would
    // not be heard — so the failure is silence in the stage, not in the song.
    FakeContext.refuseSource = true
    const stage = stationAudio(element())

    expect(() => stage.duck(0.2)).not.toThrow()
  })

  it('plays a voice past the duck, not through it', () => {
    // The one assertion here that is about how it sounds. The first gain node is
    // for the music; running the voice through it would turn every mic break
    // into somebody talking quietly over quiet music.
    const audio = element()
    const stage = stationAudio(audio)
    const context = FakeContext.built[0]!
    stage.play({} as MediaStream)

    const voice = context.streamSources[0]!
    expect(voice.connectedTo).not.toContain(context.gains[0])
  })

  it('plays a voice inside the mute, so a listener can turn a conversation off', () => {
    // The other half of the same wiring, and the reason it is not the
    // destination any more. A voice connected straight to the speakers is one
    // this page has no control over, which was a mic break nobody could mute
    // during a set, and on a night that is nothing but voices is the mute
    // button doing nothing at all.
    const stage = stationAudio(element())
    const context = FakeContext.built[0]!
    stage.play({} as MediaStream)

    expect(context.streamSources[0]!.connectedTo).toEqual([context.gains[1]])
  })

  it('mutes and unmutes on a ramp, like everything else here', () => {
    const stage = stationAudio(element())
    const out = FakeContext.built[0]!.gains[1]!

    stage.hush(true)
    expect(lastTarget(out)).toEqual(['target', 0, 0, expect.any(Number)])
    stage.hush(false)
    expect(lastTarget(out)).toEqual(['target', 1, 0, expect.any(Number)])
  })

  it('keeps the mute and the duck apart', () => {
    // Muted, then a break starts and ends. The duck moves the music; the mute
    // must still be where the listener left it, or the station would be able to
    // turn somebody's sound back on by talking.
    const stage = stationAudio(element())
    const [music, out] = FakeContext.built[0]!.gains as [FakeGain, FakeGain]

    stage.hush(true)
    stage.duck(0.2)
    stage.duck(1)

    expect(lastTarget(music)).toEqual(['target', 1, 0, expect.any(Number)])
    expect(lastTarget(out)).toEqual(['target', 0, 0, expect.any(Number)])
  })

  it('parks the voice on a muted element as well, or Chrome never decodes it', () => {
    // A remote stream connected only to Web Audio produces a graph that runs
    // and a voice nobody hears. The element is what starts the decoder, and it
    // is muted because the graph above is the thing being listened to — both
    // audible would be one voice played twice, slightly apart.
    const stream = {} as MediaStream
    stationAudio(element()).play(stream)

    const sink = elements[0]!
    expect(sink.srcObject).toBe(stream)
    expect(sink.muted).toBe(true)
    expect(sink.autoplay).toBe(true)
    expect(sink.plays).toBe(1)
  })

  it('takes the voice away again', () => {
    const stage = stationAudio(element())
    stage.play({} as MediaStream)
    stage.play(null)

    expect(FakeContext.built[0]!.streamSources[0]!.disconnects).toBe(1)
    expect(elements[0]!.srcObject).toBeNull()
  })

  it('does not build a sink on a station nobody talks on', () => {
    stationAudio(element()).duck(0.2)
    expect(elements).toHaveLength(0)
  })

  it('reuses the sink for a second break', () => {
    const stage = stationAudio(element())
    stage.play({} as MediaStream)
    stage.play(null)
    stage.play({} as MediaStream)
    expect(elements).toHaveLength(1)
  })

  it('lets go of the element on close', () => {
    const audio = element()
    stationAudio(audio).close()

    stationAudio(audio)

    expect(FakeContext.built).toHaveLength(2)
  })
})
