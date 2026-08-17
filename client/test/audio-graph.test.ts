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

  linearRampToValueAtTime(value: number, when: number): void {
    this.calls.push(['ramp', value, when])
    this.value = value
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

/**
 * The last linear ramp, which is where a *deck* fader shows up.
 *
 * A different automation from the one above, and deliberately: the decks move
 * on linear ramps because they are the crossfade, and `setTargetAtTime` is only
 * ever a hand on a fader. That split is what lets an instrument outside the
 * graph measure a duck without also measuring every transition; see
 * `DECK_SETTLE_S`.
 */
const lastRamp = (gain: FakeGain): Call | undefined =>
  [...gain.gain.calls].reverse().find((call) => call[0] === 'ramp')

describe('stationAudio', () => {
  it('routes each element through its own fader, then the duck, then the mute', () => {
    const audio = element()
    const second = element()
    stationAudio(audio, second)

    const context = FakeContext.built[0]!
    expect(context.sources).toBe(2)
    // Five, and no two of them are the same control: the duck, the mute, this
    // listener's own music fader, and one per deck. See the diagram at the top
    // of `audio-graph.ts` for why none of them can be folded into another.
    expect(context.gains).toHaveLength(5)
    for (const gain of context.gains) expect(gain.connected).toBe(1)
  })

  it('runs on one deck, and cuts rather than blending', () => {
    const audio = element()
    stationAudio(audio)

    const context = FakeContext.built[0]!
    expect(context.sources).toBe(1)
    // The duck, the mute, the music fader, and one deck. A page that only ever
    // hands over one element gets a station that cuts, which is the honest
    // degradation.
    expect(context.gains).toHaveLength(4)
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

describe('stationAudio crossfades', () => {
  /**
   * The two deck faders.
   *
   * By position, after the three that are built first — the duck, the mute and
   * the music fader — because they are made in a fixed order and there is
   * nothing else to tell them apart by on a fake this small.
   */
  function decks() {
    const gains = FakeContext.built[0]!.gains
    return { a: gains[3]!, b: gains[4]! }
  }

  it('comes up on one deck, so a station playing one record plays it once', () => {
    stationAudio(element(), element())
    // A pair that both started open would be the same record twice for anybody
    // whose second element happened to be loaded.
    expect(decks().a.gain.value).toBe(1)
    expect(decks().b.gain.value).toBe(0)
  })

  it('walks one deck up and the other down across the window', () => {
    const stage = stationAudio(element(), element())
    stage.blend({ incoming: 'b', startsIn: 0, endsIn: 4 })

    const ramps = (gain: { gain: { calls: Call[] } }) =>
      gain.gain.calls.filter((call) => call[0] === 'ramp')

    // Both are drawn as segments rather than one straight line, because a
    // linear crossfade between two unrelated records dips audibly in the middle
    // — two uncorrelated signals at half amplitude sum to about 0.7 of one.
    expect(ramps(decks().b).length).toBeGreaterThan(1)
    expect(ramps(decks().a).length).toBeGreaterThan(1)

    expect(ramps(decks().b).at(-1)).toEqual(['ramp', expect.closeTo(1, 5), 4])
    expect(ramps(decks().a).at(-1)).toEqual(['ramp', expect.closeTo(0, 5), 4])
  })

  it('holds equal power through the middle rather than dipping', () => {
    const stage = stationAudio(element(), element())
    stage.blend({ incoming: 'b', startsIn: 0, endsIn: 4 })

    const at = (gain: { gain: { calls: Call[] } }, when: number) =>
      gain.gain.calls.find((call) => call[0] === 'ramp' && call[2] === when)![1]!

    // Halfway, both faders sit at about 0.707 — which sums to one, not to the
    // 0.5 a straight line would give. This is the whole reason for the curve.
    expect(at(decks().b, 2)).toBeCloseTo(Math.SQRT1_2, 3)
    expect(at(decks().a, 2)).toBeCloseTo(Math.SQRT1_2, 3)
  })

  it('picks up a fade already underway from where it should be, not from zero', () => {
    const stage = stationAudio(element(), element())
    // A listener who arrived three quarters of the way through a transition.
    stage.blend({ incoming: 'b', startsIn: -3, endsIn: 1 })

    const first = decks().b.gain.calls.find((call) => call[0] === 'set')!
    // Not silence: they should come in hearing the incoming record almost fully
    // up, and finish the last second of the fade in step with everybody else.
    expect(first[1]).toBeCloseTo(Math.sin((0.75 * Math.PI) / 2), 3)
  })

  it('is a cut when the window has no length', () => {
    const stage = stationAudio(element(), element())
    stage.blend({ incoming: 'b', startsIn: 0, endsIn: 0 })

    expect(decks().b.gain.value).toBe(1)
    expect(decks().a.gain.value).toBe(0)
  })

  it('puts one deck up and the other away when there is nothing fading', () => {
    const stage = stationAudio(element(), element())
    stage.only('b')

    expect(lastRamp(decks().b)?.[1]).toBe(1)
    expect(lastRamp(decks().a)?.[1]).toBe(0)
    // A ramp rather than a step, and rather than the duck's approach: quick
    // enough not to be heard as a fade, slow enough not to click.
    expect(lastRamp(decks().b)?.[2]).toBeGreaterThan(0)
    // And never a `setTargetAtTime`, which is what the duck and the mute use
    // and what an instrument outside the graph counts to measure one.
    expect(lastTarget(decks().b)).toBeUndefined()
  })

  it('just puts the incoming deck up on a page with one element', () => {
    const stage = stationAudio(element())
    // No second deck to take down, and nothing to throw about: a one-deck
    // station cuts, and `blend` is where that falls out rather than a branch
    // every caller has to remember.
    expect(() => stage.blend({ incoming: 'a', startsIn: 0, endsIn: 4 })).not.toThrow()
    expect(lastRamp(FakeContext.built[0]!.gains[3]!)?.[1]).toBe(1)
  })
})

describe('the music fader', () => {
  it('sits on the music alone, under both of the other two', () => {
    const stage = stationAudio(element(), element())
    stage.music(0.4)

    // Not the duck, which the station owns and would overwrite this on the next
    // mic break; not the mute, which covers voices too and would turn down the
    // person you are answering. Its own node, between the decks and the duck.
    const music = FakeContext.built[0]!.gains[2]!
    expect(lastTarget(music)).toEqual(['target', 0.4, 0, expect.any(Number)])

    stage.duck(0.2)
    // Untouched by a mic break: the two multiply rather than one replacing the
    // other, which is the whole reason there are two of them.
    expect(lastTarget(music)).toEqual(['target', 0.4, 0, expect.any(Number)])
  })

  it('ramps, and clamps, like every other fader here', () => {
    const stage = stationAudio(element())
    const music = FakeContext.built[0]!.gains[2]!

    stage.music(4)
    expect(lastTarget(music)![1]).toBe(1)
    stage.music(-1)
    expect(lastTarget(music)![1]).toBe(0)
  })
})
