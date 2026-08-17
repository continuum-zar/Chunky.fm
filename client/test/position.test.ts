import { describe, expect, it } from 'vitest'
import { expectedPositionSeconds, formatClock } from '../src/lib/position.js'
import type { StateMessage, Track } from '../src/lib/protocol.js'

const track: Track = {
  id: 1,
  title: 'Test',
  artist: null,
  album: null,
  durationMs: 200_000,
  filename: 'abc.mp3',
  artworkPath: null,
  contentHash: 'abc',
  gainDb: 0,
  uploadedAt: 0,
}

const state = (over: Partial<StateMessage> = {}): StateMessage => ({
  type: 'state',
  track,
  startedAt: 1_000_000,
  pausedAt: null,
  serverTime: 1_000_000,
  // Nothing fading out. This module is about one record's needle; the two-deck
  // arithmetic lives in `decking.ts` and is tested there.
  outgoing: null,
  ...over,
})

describe('expectedPositionSeconds', () => {
  it('is zero when nothing is on the decks', () => {
    expect(expectedPositionSeconds(state({ track: null }), 1_500_000)).toBe(0)
  })

  it('derives the position from elapsed server time', () => {
    expect(expectedPositionSeconds(state(), 1_000_000)).toBe(0)
    expect(expectedPositionSeconds(state(), 1_134_000)).toBe(134)
  })

  it('treats a mid-song join exactly like a join at the start', () => {
    // Same call, same maths: the only difference is how far in the past
    // startedAt sits.
    const atStart = expectedPositionSeconds(state({ startedAt: 1_000_000 }), 1_000_000)
    const midSong = expectedPositionSeconds(state({ startedAt: 866_000 }), 1_000_000)

    expect(atStart).toBe(0)
    expect(midSong).toBe(134)
  })

  it('uses the frozen position while paused, ignoring the clock', () => {
    const paused = state({ pausedAt: 45_000 })

    expect(expectedPositionSeconds(paused, 1_000_000)).toBe(45)
    expect(expectedPositionSeconds(paused, 9_000_000)).toBe(45)
  })

  it('never runs past the end of the track or before the start', () => {
    expect(expectedPositionSeconds(state(), 9_000_000)).toBe(200)
    expect(expectedPositionSeconds(state(), 900_000)).toBe(0)
  })
})

describe('formatClock', () => {
  it('formats minutes and seconds', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9)).toBe('0:09')
    expect(formatClock(134)).toBe('2:14')
    expect(formatClock(3_600)).toBe('60:00')
  })

  it('does not render negative time', () => {
    expect(formatClock(-5)).toBe('0:00')
  })
})
