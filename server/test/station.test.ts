import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackState } from '../src/playback.js'
import { Station } from '../src/station.js'
import { Transition } from '../src/transition.js'
import { type FakeClock, advanceAll, fakeClock, makeTrack } from './helpers.js'

let clock: FakeClock
let station: Station
let playback: PlaybackState

const BACKSTOP_MS = 2_000

const first = makeTrack({ id: 1, title: 'Opening Number', durationMs: 200_000 })
const second = makeTrack({ id: 2, title: 'The Follow Up', durationMs: 180_000 })
const third = makeTrack({ id: 3, title: 'Closer', durationMs: 120_000 })

const nowPlaying = () => playback.snapshot().track?.title ?? null
const queued = () => station.queue.list().map((entry) => entry.track.title)

beforeEach(() => {
  vi.useFakeTimers()
  clock = fakeClock()
  playback = new PlaybackState({ now: clock.now })
  // A hard cut, so everything below is about *when* the station advances rather
  // than about how one record becomes the next. The crossfade has its own block
  // at the bottom of this file, and it moves when the advance happens by design.
  station = new Station({
    playback,
    transition: new Transition({ blendMs: 0 }),
    backstopIntervalMs: BACKSTOP_MS,
  })
})

afterEach(() => {
  station.close()
  vi.useRealTimers()
})

describe('Station queueing', () => {
  it('starts an idle station on the first track queued', () => {
    station.enqueue(first)

    expect(nowPlaying()).toBe('Opening Number')
    expect(queued()).toEqual([])
    expect(playback.positionMs()).toBe(0)
  })

  it('leaves a playing station alone and queues behind it', () => {
    station.enqueue(first)
    station.enqueue(second)
    station.enqueue(third)

    expect(nowPlaying()).toBe('Opening Number')
    expect(queued()).toEqual(['The Follow Up', 'Closer'])
  })

  it('does not jump the gun on a paused station', () => {
    station.enqueue(first)
    playback.pause()

    station.enqueue(second)

    expect(nowPlaying()).toBe('Opening Number')
    expect(playback.isPlaying).toBe(false)
    expect(queued()).toEqual(['The Follow Up'])
  })
})

describe('Station advancement', () => {
  it('moves to the next track the moment the current one ends', async () => {
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, first.durationMs - 1_000)
    expect(nowPlaying()).toBe('Opening Number')

    await advanceAll(clock, 1_000)

    expect(nowPlaying()).toBe('The Follow Up')
    expect(playback.snapshot().startedAt).toBe(clock.now())
    expect(queued()).toEqual([])
  })

  it('plays a whole queue through, in order', async () => {
    for (const track of [first, second, third]) station.enqueue(track)

    const heard = [nowPlaying()]
    for (const track of [first, second, third]) {
      await advanceAll(clock, track.durationMs)
      heard.push(nowPlaying())
    }

    expect(heard).toEqual(['Opening Number', 'The Follow Up', 'Closer', null])
  })

  it('goes off air when the last track ends', async () => {
    station.enqueue(first)

    await advanceAll(clock, first.durationMs)

    expect(nowPlaying()).toBeNull()
    expect(playback.isPlaying).toBe(false)
  })

  it('holds the track while paused, however long that is', async () => {
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, 10_000)
    playback.pause()
    await advanceAll(clock, first.durationMs * 3)

    expect(nowPlaying()).toBe('Opening Number')
    expect(playback.positionMs()).toBe(10_000)
    expect(queued()).toEqual(['The Follow Up'])
  })

  it('advances on the time left after a resume, not the original duration', async () => {
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, 150_000)
    playback.pause()
    await advanceAll(clock, 600_000) // dead air while paused
    playback.resume()

    await advanceAll(clock, 49_000)
    expect(nowPlaying()).toBe('Opening Number')

    await advanceAll(clock, 1_000)
    expect(nowPlaying()).toBe('The Follow Up')
  })

  it('reschedules when a seek moves the end of the track', async () => {
    station.enqueue(first)
    station.enqueue(second)

    playback.seek(first.durationMs - 5_000)
    await advanceAll(clock, 5_000)

    expect(nowPlaying()).toBe('The Follow Up')
  })

  it('advances immediately when resumed at the very end', async () => {
    station.enqueue(first)
    station.enqueue(second)

    playback.seek(first.durationMs)
    playback.pause()
    expect(nowPlaying()).toBe('Opening Number')

    playback.resume()
    await vi.advanceTimersByTimeAsync(1)

    expect(nowPlaying()).toBe('The Follow Up')
  })

  it('keeps a hand-picked track on the decks until it ends, then follows the queue', async () => {
    station.enqueue(first)
    station.enqueue(second)

    playback.play(third) // admin drops something on top of what's queued

    expect(nowPlaying()).toBe('Closer')
    await advanceAll(clock, third.durationMs)

    expect(nowPlaying()).toBe('The Follow Up')
  })
})

describe('Station backstop', () => {
  it('catches a track that outlived its timer', async () => {
    station.enqueue(first)
    station.enqueue(second)

    // The wall clock jumps past the end of the track without the timer wheel
    // reaching it: an event loop blocked under load, as far as the station is
    // concerned. Only the backstop sweep runs.
    clock.advance(first.durationMs + 30_000)
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS)

    expect(nowPlaying()).toBe('The Follow Up')
    // The overrun is not carried over: the next track starts at 0:00 however
    // late the station noticed the last one had finished.
    expect(playback.positionMs()).toBe(0)
  })

  it('leaves a track that is merely playing alone', async () => {
    station.enqueue(first)
    station.enqueue(second)

    clock.advance(60_000)
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 3)

    expect(nowPlaying()).toBe('Opening Number')
  })

  it('does not advance a paused station, however far behind it falls', async () => {
    station.enqueue(first)
    station.enqueue(second)
    playback.pause()

    clock.advance(first.durationMs * 2)
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 3)

    expect(nowPlaying()).toBe('Opening Number')
  })

  it('does not run when nothing is on the decks', async () => {
    clock.advance(600_000)
    await vi.advanceTimersByTimeAsync(BACKSTOP_MS * 3)

    expect(nowPlaying()).toBeNull()
  })
})

describe('Station skip', () => {
  it('advances on demand, without waiting for the track to end', () => {
    station.enqueue(first)
    station.enqueue(second)

    station.advance()

    expect(nowPlaying()).toBe('The Follow Up')
    expect(playback.positionMs()).toBe(0)
  })

  it('goes off air when there is nothing to skip to', () => {
    station.enqueue(first)

    station.advance()

    expect(nowPlaying()).toBeNull()
  })
})

describe('Station shutdown', () => {
  it('stops advancing once closed', async () => {
    station.enqueue(first)
    station.enqueue(second)

    station.close()
    await advanceAll(clock, first.durationMs * 2)

    expect(nowPlaying()).toBe('Opening Number')
  })
})

describe('Station crossfades', () => {
  /** A station that blends, built fresh so the shared one stays a hard cut. */
  function blending(blendMs: number): Station {
    station.close()
    station = new Station({
      playback,
      transition: new Transition({ blendMs }),
      backstopIntervalMs: BACKSTOP_MS,
    })
    return station
  }

  it('starts the next record early, and says what is fading out under it', async () => {
    blending(4_000)
    station.enqueue(first)
    station.enqueue(second)
    const startedFirst = clock.now()

    // A second before the blend is due, nothing has happened yet.
    await advanceAll(clock, first.durationMs - 5_000)
    expect(nowPlaying()).toBe('Opening Number')
    expect(playback.snapshot().outgoing).toBeNull()

    await advanceAll(clock, 1_000)

    const snapshot = playback.snapshot()
    expect(snapshot.track?.title).toBe('The Follow Up')
    expect(snapshot.startedAt).toBe(clock.now())
    // The window the browsers fade across: this record's beginning to the last
    // one's end, which is exactly the overlap.
    expect(snapshot.outgoing?.track.title).toBe('Opening Number')
    expect(snapshot.outgoing?.startedAt).toBe(startedFirst)
    expect(snapshot.outgoing?.endsAt).toBe(startedFirst + first.durationMs)
    expect(snapshot.outgoing!.endsAt - snapshot.startedAt).toBe(4_000)
  })

  it('stops reporting the outgoing record once it has actually run out', async () => {
    blending(4_000)
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, first.durationMs - 4_000)
    expect(playback.snapshot().outgoing).not.toBeNull()

    await advanceAll(clock, 4_000)
    expect(playback.snapshot().outgoing).toBeNull()
    expect(nowPlaying()).toBe('The Follow Up')
  })

  it('cuts rather than blends when there is nothing queued behind', async () => {
    blending(4_000)
    station.enqueue(first)

    await advanceAll(clock, first.durationMs - 4_000)
    // The end of the set is not a transition into anything.
    expect(nowPlaying()).toBe('Opening Number')

    await advanceAll(clock, 4_000)
    expect(nowPlaying()).toBeNull()
    expect(playback.snapshot().outgoing).toBeNull()
  })

  it('never overlaps more than half the shorter of the two records', async () => {
    const brief = makeTrack({ id: 9, title: 'Interlude', durationMs: 5_000 })
    blending(12_000)
    station.enqueue(first)
    station.enqueue(brief)

    await advanceAll(clock, first.durationMs - 2_500)

    const snapshot = playback.snapshot()
    expect(snapshot.track?.title).toBe('Interlude')
    expect(snapshot.outgoing!.endsAt - snapshot.startedAt).toBe(2_500)
  })

  it('blends on demand, cutting the outgoing record where the fade ends', async () => {
    blending(4_000)
    station.enqueue(first)
    station.enqueue(second)
    const startedFirst = clock.now()

    await advanceAll(clock, 30_000)
    station.blend()

    const snapshot = playback.snapshot()
    expect(snapshot.track?.title).toBe('The Follow Up')
    expect(snapshot.outgoing?.track.title).toBe('Opening Number')
    expect(snapshot.outgoing?.startedAt).toBe(startedFirst)
    // Not its natural end: a manual transition takes the old record off where
    // the fade finishes, rather than leaving it running underneath for another
    // two and a half minutes.
    expect(snapshot.outgoing?.endsAt).toBe(clock.now() + 4_000)
  })

  it('skips as a hard cut even on a station that blends', async () => {
    blending(4_000)
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, 30_000)
    station.advance()

    expect(nowPlaying()).toBe('The Follow Up')
    expect(playback.snapshot().outgoing).toBeNull()
  })

  it('moves the transition when the length changes mid-record', async () => {
    blending(0)
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, first.durationMs - 6_000)
    expect(nowPlaying()).toBe('Opening Number')

    // A timer was already set for the end of the record. Lengthening the blend
    // has to move it, or the transition this asked for never happens.
    station.transition.set(8_000)
    // A millisecond, only to let the rescheduled timer actually fire.
    await advanceAll(clock, 1)

    expect(nowPlaying()).toBe('The Follow Up')
    expect(playback.snapshot().outgoing?.track.title).toBe('Opening Number')
  })

  it('brings the transition forward when something is queued late', async () => {
    blending(4_000)
    station.enqueue(first)

    // Nothing queued, so the timer is set for the end of the record.
    await advanceAll(clock, first.durationMs - 4_000)
    expect(nowPlaying()).toBe('Opening Number')

    // Queueing behind it means the blend is due right now, not in four seconds.
    station.enqueue(second)
    // A millisecond, only to let the rescheduled timer actually fire.
    await advanceAll(clock, 1)

    expect(nowPlaying()).toBe('The Follow Up')
    expect(playback.snapshot().outgoing?.track.title).toBe('Opening Number')
  })

  it('abandons the blend when the deck is paused mid-fade', async () => {
    blending(4_000)
    station.enqueue(first)
    station.enqueue(second)

    await advanceAll(clock, first.durationMs - 4_000)
    expect(playback.snapshot().outgoing).not.toBeNull()

    playback.pause()
    expect(playback.snapshot().outgoing).toBeNull()
  })
})
