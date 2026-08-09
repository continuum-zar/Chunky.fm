import { describe, expect, it } from 'vitest'
import {
  METER_FLOOR_DB,
  clippedIn,
  inputsFrom,
  levelFrom,
  meterScale,
  micConstraints,
  nextLevel,
} from '../src/lib/mic-input.js'

/** A frame of time-domain bytes: a sine at `amplitude`, centred on 128. */
function tone(amplitude: number, samples = 512): Uint8Array {
  const buffer = new Uint8Array(samples)
  for (let i = 0; i < samples; i++) {
    const value = Math.round(128 + Math.sin((i / samples) * Math.PI * 8) * 127 * amplitude)
    buffer[i] = Math.max(0, Math.min(255, value))
  }
  return buffer
}

const device = (over: Partial<MediaDeviceInfo>): MediaDeviceInfo =>
  ({ deviceId: 'x', kind: 'audioinput', label: '', groupId: 'g', ...over }) as MediaDeviceInfo

describe('micConstraints', () => {
  it('takes echo cancellation off on headphones', () => {
    // The decision this whole function exists for. Cancellation is tuned for
    // speech: it gates, it ducks, and it treats anything sustained and musical
    // as the echo it is removing. On headphones there is no echo to cancel and
    // it costs voice quality for nothing.
    expect(micConstraints(null, false)).toMatchObject({ echoCancellation: false })
  })

  it('puts it back on for somebody on speakers', () => {
    // The console can be playing the station out loud, so an open mic there is
    // a real feedback path. This does not save a set — headphones do — but it
    // is the difference between a mistake and a howl.
    expect(micConstraints(null, true)).toMatchObject({ echoCancellation: true })
  })

  it('asks for one channel, and leaves the room-shaped problems switched on', () => {
    expect(micConstraints(null, false)).toMatchObject({
      channelCount: { ideal: 1 },
      noiseSuppression: true,
      autoGainControl: true,
    })
  })

  it('names a device only when one was chosen', () => {
    expect(micConstraints(null, false)).not.toHaveProperty('deviceId')
    // `ideal`, not `exact`: a device that has been unplugged since it was
    // picked should hand the station the default microphone, not an error.
    expect(micConstraints('abc', false)).toMatchObject({ deviceId: { ideal: 'abc' } })
  })
})

describe('inputsFrom', () => {
  it('keeps the inputs and drops everything else', () => {
    const devices = [
      device({ deviceId: 'a', kind: 'audioinput', label: 'Scarlett Solo' }),
      device({ deviceId: 'b', kind: 'audiooutput', label: 'Speakers' }),
      device({ deviceId: 'c', kind: 'videoinput', label: 'Webcam' }),
    ]
    expect(inputsFrom(devices)).toEqual([{ id: 'a', label: 'Scarlett Solo' }])
  })

  it('names the unnamed, which is every device before permission', () => {
    // Empty labels are a privacy rule rather than a fault: the picker is a list
    // of "Microphone 1" on first open and a list of real names afterwards.
    expect(inputsFrom([device({ deviceId: 'a' }), device({ deviceId: 'b' })])).toEqual([
      { id: 'a', label: 'Microphone 1' },
      { id: 'b', label: 'Microphone 2' },
    ])
  })

  it('keeps the aliases, because following the system is a real choice', () => {
    const devices = [
      device({ deviceId: 'default', label: 'Default - Built-in' }),
      device({ deviceId: 'abc', label: 'Built-in' }),
    ]
    expect(inputsFrom(devices).map((input) => input.id)).toEqual(['default', 'abc'])
  })
})

describe('levelFrom', () => {
  it('reads silence as nothing', () => {
    expect(levelFrom(new Uint8Array(256).fill(128))).toBe(0)
  })

  it('rises with the signal', () => {
    const quiet = levelFrom(tone(0.1))
    const loud = levelFrom(tone(0.9))
    expect(quiet).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(quiet)
    expect(loud).toBeLessThanOrEqual(1)
  })

  it('is an average rather than a peak', () => {
    // RMS, so a sine reads near 1/√2 of its amplitude rather than at it. A
    // meter that followed peaks would sit at the top all evening, and the
    // question somebody setting a level is asking is how loud they *are*.
    expect(levelFrom(tone(1))).toBeLessThan(0.8)
    expect(levelFrom(tone(1))).toBeGreaterThan(0.6)
  })

  it('has an answer for an empty frame', () => {
    expect(levelFrom(new Uint8Array(0))).toBe(0)
  })
})

describe('clippedIn', () => {
  it('says nothing about a signal with room left', () => {
    expect(clippedIn(tone(0.8))).toBe(false)
  })

  it('catches a single pinned sample', () => {
    // Read off the samples rather than the RMS on purpose: clipping is a peak
    // event, and one sample against the rail is distortion an average will
    // never show.
    const buffer = new Uint8Array(256).fill(128)
    buffer[100] = 255
    expect(clippedIn(buffer)).toBe(true)
  })

  it('catches the bottom rail too', () => {
    const buffer = new Uint8Array(256).fill(128)
    buffer[7] = 0
    expect(clippedIn(buffer)).toBe(true)
  })
})

describe('nextLevel', () => {
  it('rises faster than it falls', () => {
    // Speech is mostly gaps. A meter that tracked the signal honestly in both
    // directions would flicker between full and nothing several times a word.
    const up = nextLevel(0, 1)
    const down = 1 - nextLevel(1, 0)
    expect(up).toBeGreaterThan(down)
  })

  it('never overshoots what it is heading for', () => {
    let level = 0
    for (let i = 0; i < 100; i++) level = nextLevel(level, 0.5)
    expect(level).toBeGreaterThan(0.49)
    expect(level).toBeLessThanOrEqual(0.5)
  })

  it('settles back to silence', () => {
    let level = 1
    for (let i = 0; i < 200; i++) level = nextLevel(level, 0)
    expect(level).toBeLessThan(0.001)
  })
})

describe('meterScale', () => {
  it('is empty at silence and full at the rails', () => {
    expect(meterScale(0)).toBe(0)
    expect(meterScale(1)).toBe(1)
  })

  it('puts a voice in the middle of the bar rather than the last few pixels', () => {
    // The reason this is not the linear level. −18 dBFS is a healthy speaking
    // level and reads as 0.1 of a linear bar, which is a stub; on this scale it
    // is most of the way along, where it can actually be set by eye.
    const healthy = meterScale(10 ** (-18 / 20))
    expect(healthy).toBeGreaterThan(0.6)
    expect(healthy).toBeLessThan(0.85)
  })

  it('bottoms out rather than going negative below the floor', () => {
    expect(meterScale(10 ** ((METER_FLOOR_DB - 20) / 20))).toBe(0)
  })

  it('climbs with the signal', () => {
    expect(meterScale(0.5)).toBeGreaterThan(meterScale(0.05))
  })
})
