/**
 * How one record becomes the next.
 *
 * The thing to hold on to here is that this object carries no audio and never
 * will — it is a number, broadcast, and the fade itself happens in thirty
 * browsers against two instants on the playback snapshot. Exactly the trick
 * `Mic` plays with the duck, one turn further.
 *
 * What is worth testing about a number is where it stops. `set` clamps rather
 * than refuses, because this is a fader; and `overlapFor` clamps again against
 * the two records it is actually folding, because a crossfade longer than the
 * music it is folding would start a track that was already over.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_BLEND_MS, MAX_BLEND_MS, Transition } from '../src/transition.js'

describe('Transition', () => {
  it('starts somewhere deliberate rather than at a cut', () => {
    // A station whose default is a hard cut sounds like a playlist, and the
    // whole difference between this and a playlist is that somebody runs it.
    expect(new Transition().snapshot()).toEqual({ blendMs: DEFAULT_BLEND_MS })
  })

  it('announces a change once, and says nothing about a repeat', () => {
    const blend = new Transition({ blendMs: 0 })
    const heard = vi.fn()
    blend.on('change', heard)

    expect(blend.set(4_000)).toBe(true)
    // Where the fader stands rather than a step, so two of these in a row leave
    // one value: a slider that lost its answer cannot walk the blend out.
    expect(blend.set(4_000)).toBe(false)
    expect(blend.blendMs).toBe(4_000)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('stops at the ends of its travel instead of erroring', () => {
    const blend = new Transition()

    blend.set(-5_000)
    expect(blend.blendMs).toBe(0)

    blend.set(MAX_BLEND_MS * 10)
    expect(blend.blendMs).toBe(MAX_BLEND_MS)
  })

  it('ignores a number that is not one', () => {
    const blend = new Transition({ blendMs: 3_000 })
    expect(blend.set(Number.NaN)).toBe(false)
    expect(blend.set(Number.POSITIVE_INFINITY)).toBe(false)
    expect(blend.blendMs).toBe(3_000)
  })

  it('gives the whole length when both records are long enough to spare it', () => {
    expect(new Transition({ blendMs: 4_000 }).overlapFor(200_000, 180_000)).toBe(4_000)
  })

  it('never folds more than half the shorter of the two', () => {
    const blend = new Transition({ blendMs: 12_000 })

    // A five-second interlude cannot give twelve seconds to a transition. Half
    // rather than all of it, because an overlap equal to a record's whole
    // length is not a transition, it is two records playing.
    expect(blend.overlapFor(200_000, 5_000)).toBe(2_500)
    expect(blend.overlapFor(5_000, 200_000)).toBe(2_500)
  })

  it('is a cut when it is set to nothing', () => {
    expect(new Transition({ blendMs: 0 }).overlapFor(200_000, 180_000)).toBe(0)
  })

  it('is a cut against a record with no length the station believes in', () => {
    const blend = new Transition({ blendMs: 4_000 })
    expect(blend.overlapFor(0, 180_000)).toBe(0)
    expect(blend.overlapFor(200_000, Number.NaN)).toBe(0)
  })
})
