/**
 * The microphone, as the parts that are worth testing away from a browser.
 *
 * `useMicInput` owns the getUserMedia call, the audio context and the animation
 * frame; everything here is the arithmetic and the decisions underneath it,
 * kept separate because none of it needs a device to be right.
 *
 * Nothing in this file sends anything anywhere. The mic exists at this stage so
 * that whoever runs the decks can see their level and hear themselves before
 * there is any voice on the wire — which is exactly the point of doing it
 * before the peer connections: "the browser will not give me the microphone"
 * and "the connection will not establish" are different problems, and meeting
 * them one at a time is worth a milestone.
 */

/** One thing you could talk into. */
export interface InputDevice {
  id: string
  label: string
}

/**
 * The inputs, named.
 *
 * Labels are empty until the browser has granted microphone permission at least
 * once — a privacy rule, not a bug — so the picker is a list of "Microphone 1"
 * on first open and a list of real names afterwards. Numbering them from their
 * position keeps the fallback stable within a listing, which is as stable as an
 * unnamed device gets.
 *
 * Chrome also offers `default` and `communications`: aliases for whatever the
 * OS is currently pointed at rather than devices in their own right. They are
 * kept, because "follow the system" is a genuinely useful choice and usually
 * the right one, but they are the reason a device id is not a device.
 */
export function inputsFrom(devices: MediaDeviceInfo[]): InputDevice[] {
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`,
    }))
}

/**
 * What to ask getUserMedia for.
 *
 * The interesting decision is `echoCancellation`, and it goes the way most
 * examples do not. Cancellation exists to stop a speaker's output being sent
 * back through its own microphone, and it is tuned for speech: it gates, it
 * ducks, and it treats anything sustained and musical as the echo it is trying
 * to remove. On headphones there is no echo to cancel and it only costs voice
 * quality, so it comes off.
 *
 * On speakers it goes back on, and it is doing real work: the console can be
 * playing the station out loud, so an open mic there is a genuine feedback
 * path. It will not save a set — the honest answer is still headphones — but a
 * hot mic over speakers with cancellation off is a howl rather than a mistake.
 *
 * Mono throughout: it is a voice, and a second channel is bytes spent on
 * nothing. `noiseSuppression` and `autoGainControl` stay on either way, since
 * a room is a room and nobody is riding their own gain live.
 */
export function micConstraints(deviceId: string | null, onSpeakers: boolean): MediaTrackConstraints {
  return {
    ...(deviceId === null ? {} : { deviceId: { ideal: deviceId } }),
    channelCount: { ideal: 1 },
    echoCancellation: onSpeakers,
    noiseSuppression: true,
    autoGainControl: true,
  }
}

/**
 * How loud the last frame was, as 0…1.
 *
 * `getByteTimeDomainData` fills a buffer of samples centred on 128, so this is
 * an ordinary RMS once each one is put back either side of zero. RMS rather
 * than peak because a meter that followed peaks would spend the evening at the
 * top: what somebody setting their level wants to see is how loud they *are*,
 * and the clip lamp is what covers how loud they briefly were.
 */
export function levelFrom(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const centred = ((samples[i] as number) - 128) / 128
    sum += centred * centred
  }
  return Math.min(1, Math.sqrt(sum / samples.length))
}

/**
 * Whether that frame hit the rails.
 *
 * Read off the raw samples rather than the RMS, because clipping is a peak
 * event: a single sample pinned at either end is distortion that has already
 * happened, and an average will never show it.
 */
export function clippedIn(samples: Uint8Array): boolean {
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] as number
    if (sample <= 1 || sample >= 254) return true
  }
  return false
}

/** Fraction of the gap closed per frame when the level is rising. */
export const METER_ATTACK = 0.5
/** And when it is falling. Much slower; see `nextLevel`. */
export const METER_RELEASE = 0.08

/**
 * Where the needle moves to next.
 *
 * Fast up, slow down, which is what every meter worth looking at does. Speech
 * is mostly gaps, and a meter that tracked the signal honestly in both
 * directions would flicker between full and nothing several times a word and be
 * unreadable. Rising fast means a peak is never missed; falling slowly means
 * the bar shows the shape of a sentence rather than of its syllables.
 */
export function nextLevel(
  current: number,
  sample: number,
  attack = METER_ATTACK,
  release = METER_RELEASE,
): number {
  const rate = sample > current ? attack : release
  return current + (sample - current) * rate
}

/**
 * The meter's scale, as 0…1 across the bar.
 *
 * Not the linear level: voice sits so far down a linear scale that a healthy
 * signal is a stub and everything useful happens in the last few pixels. This
 * is dBFS across a 60 dB window instead, so the range somebody is actually
 * setting — roughly −30 to −6 — takes up the middle of the bar where it can be
 * read.
 */
export const METER_FLOOR_DB = -60

export function meterScale(level: number): number {
  if (level <= 0) return 0
  const db = 20 * Math.log10(level)
  if (db <= METER_FLOOR_DB) return 0
  return Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)
}
