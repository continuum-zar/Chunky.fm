/**
 * A listener being brought up, in real browsers.
 *
 * The sound check is the one part of this feature that cannot be tested away
 * from a browser, because what it actually measures is not arithmetic: it is
 * whether a microphone can hear the station. `sound-check.test.ts` pins the
 * state machine; this pins the thing the state machine is for.
 *
 * Two callers, and the difference between them is the whole milestone.
 *
 * **On speakers.** Chrome's built-in fake device is a beep every second, which
 * for once is exactly the wrong shape to pass — and that is what makes it
 * useful. It stands in for a laptop playing the station out loud with an open
 * microphone in front of it, which is the failure the gate exists to catch, and
 * it must never reach a way up.
 *
 * **On headphones.** A capture file of a second and a half of tone and then
 * silence: somebody who speaks and whose microphone then hears nothing, because
 * the station is not coming out of anything near it. They pass, they go up, and
 * their own music goes to silence — which is the headline of the milestone, and
 * the reason a caller hears the studio rather than the record.
 *
 * The capture file is written here rather than checked in: it is a sine wave
 * and some zeroes, and a megabyte of that in a repository is a megabyte nobody
 * can review.
 *
 * Needs a running Vite dev server, a running station, and a track on the decks.
 * See README.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright-core'
import {
  ADMIN_PASSWORD,
  CHROME_PATH,
  Checks,
  DUCKS,
  type Duck,
  INSTRUMENT_DUCKS,
  INSTRUMENT_VOICE,
  STATION_URL,
  VOICE_LEVEL,
  micCommand,
  tuneIn,
  wait,
} from './qa-env.js'

/**
 * Measures whatever the console ends up playing into its own headphones.
 *
 * Not the same instrument as `INSTRUMENT_VOICE` on a listener's page, and the
 * difference is the point: there, a voice is heard through the graph the join
 * click built, and the question is whether a listener can hear the decks. Here
 * the question is whether the decks can hear a *guest*, which means measuring
 * the console's own destination — the thing a pair of headphones is plugged
 * into — rather than any one node on the way to it.
 */
const INSTRUMENT_CUE = `(() => {
  window.__cue = null
  var create = AudioContext.prototype.createMediaStreamSource
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    var node = create.call(this, stream)
    var analyser = this.createAnalyser()
    analyser.fftSize = 1024
    node.connect(analyser)
    window.__cue = { analyser: analyser, samples: new Uint8Array(analyser.fftSize) }
    return node
  }
  return true
})()`

/** The loudest thing the console has heard since this was last read. */
const CUE_LEVEL = `(() => {
  if (!window.__cue) return -1
  var peak = 0
  for (var i = 0; i < 40; i++) {
    window.__cue.analyser.getByteTimeDomainData(window.__cue.samples)
    for (var j = 0; j < window.__cue.samples.length; j++) {
      var v = Math.abs((window.__cue.samples[j] - 128) / 128)
      if (v > peak) peak = v
    }
  }
  return peak
})()`

/**
 * The fake device is a loud continuous tone, so a voice that is arriving reads
 * far above this and one that is not reads far below. The gap is the test.
 */
const HEARD = 0.02

const checks = new Checks()
const ADMIN_URL = `${STATION_URL}#admin`

/** How long to wait for a check to reach a verdict. It is ten seconds of real
 *  time on a speaker, and about three on headphones; this is room for a slow
 *  machine on top of both. */
const VERDICT_MS = 30_000

/**
 * A caller wearing headphones, as a WAV: two seconds of talking, four of not.
 *
 * The duty cycle is doing two jobs at once and both of them are load bearing.
 * The four seconds of silence are what the sound check needs — it wants an
 * unbroken second and a half inside a six-second budget, and it is that silence
 * which stands in for headphones, because a caller on speakers would have the
 * station coming back into their microphone throughout. The two seconds of tone
 * are what there is to *measure* once they are on air.
 *
 * It loops, and that matters: the check takes a few seconds and the call comes
 * after it, so a file that played once would have run out by the time anybody
 * was listening — a guest sending real silence, which looks exactly like a
 * broken talk channel and would have this script fail for the wrong reason.
 *
 * Mono, 48 kHz, sixteen bit, written by hand because the alternative is a
 * binary in the repository or a dependency on ffmpeg for a file that is a sine
 * wave and some zeroes.
 */
function headphonesWav(): string {
  const rate = 48_000
  const toneS = 2
  const silenceS = 4
  const frames = Math.round((toneS + silenceS) * rate)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < Math.round(toneS * rate); i++) {
    // Loud enough to be unambiguously somebody talking; see SPEAKING.
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 12_000), i * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)

  const file = path.join(mkdtempSync(path.join(tmpdir(), 'chunky-callin-')), 'headphones.wav')
  writeFileSync(file, Buffer.concat([header, data]))
  return file
}

function browserWith(capture: string | null): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME_PATH,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // Looping, deliberately: see `headphonesWav`. A file that played once
      // would be exhausted by the time the call started, and a guest sending
      // real silence is indistinguishable from a talk channel that never
      // carried anything.
      ...(capture ? [`--use-file-for-fake-audio-capture=${capture}`] : []),
    ],
  })
}

/** Sign the console in and leave it on the desk. */
async function decks(browser: Browser, listening = false): Promise<Page> {
  const page = await browser.newPage()
  if (listening) await page.addInitScript(INSTRUMENT_CUE)
  await page.goto(ADMIN_URL)
  await page.fill('input[type=password]', ADMIN_PASSWORD)
  await page.click('button[type=submit]')
  await wait(2_000)
  return page
}

/** Raise a hand and have the console answer it. */
async function askedUp(guest: Page, console_: Page): Promise<void> {
  await guest.click('[data-testid=hand-toggle]')
  await wait(600)
  await console_.locator('[data-testid=floor-hands] button').first().click()
  await wait(800)
}

/** The check's verdict, or whatever it was still saying when time ran out. */
async function verdict(guest: Page): Promise<{ passed: boolean; notice: string }> {
  const until = Date.now() + VERDICT_MS
  while (Date.now() < until) {
    if ((await guest.locator('[data-testid=go-up]').count()) > 0) {
      return { passed: true, notice: 'passed' }
    }
    const notice = ((await guest.locator('[data-testid=check-notice]').textContent()) ?? '').trim()
    if (/Something is coming/i.test(notice)) return { passed: false, notice }
    await wait(400)
  }
  return { passed: false, notice: 'never reached a verdict' }
}

async function onSpeakers(): Promise<void> {
  console.log('\na caller whose microphone can hear the station…')
  const browser = await browserWith(null)
  try {
    const guest = await browser.newPage()
    await guest.goto(STATION_URL)
    await tuneIn(guest, 'sipho')
    await wait(1_200)
    const console_ = await decks(browser)
    await askedUp(guest, console_)

    const offered = await guest.locator('[data-testid=called-up]').isVisible()
    checks.run(
      'the console can offer, and the offer arrives',
      offered,
      offered ? 'the invitation is on the guest' : 'nothing arrived',
    )
    // Before anything else: there is no way up on the page at all, rather than
    // one that is present and disabled. A gate somebody can see is a gate
    // somebody will try.
    const early = await guest.locator('[data-testid=go-up]').count()
    checks.run(
      'there is no way up before the check',
      early === 0,
      early === 0 ? 'only a sound check is offered' : `${early} way(s) up`,
    )

    await guest.click('[data-testid=sound-check]')
    const { passed, notice } = await verdict(guest)
    checks.run(
      'a room the microphone can hear is refused',
      !passed && /headphones/i.test(notice),
      notice.slice(0, 72),
    )
    const after = await guest.locator('[data-testid=go-up]').count()
    checks.run(
      'and there is still no way up afterwards',
      after === 0,
      after === 0 ? 'the gate held' : `${after} way(s) up`,
    )
    // The ordering the whole detector depends on: the station has to be playing
    // where the guest is, or the quiet half is measuring nothing.
    const playing = await guest.evaluate(`(() => {
      const a = document.querySelector('audio')
      return !!a && !a.paused && a.currentTime > 0
    })()`)
    checks.run(
      'the station is still playing while they are checked',
      Boolean(playing),
      playing ? 'so there was something for it to detect' : 'the check tested nothing',
    )
  } finally {
    await browser.close()
  }
}

async function onHeadphones(): Promise<void> {
  console.log('\na caller wearing headphones…')
  const browser = await browserWith(headphonesWav())
  try {
    const guest = await browser.newPage()
    // Before any of the app runs, so the very first ramp is caught — and so the
    // guest's own ears can be measured, which is the assertion this whole
    // feature turns on.
    await guest.addInitScript(INSTRUMENT_DUCKS)
    await guest.addInitScript(INSTRUMENT_VOICE)
    await guest.goto(STATION_URL)
    await tuneIn(guest, 'ama')
    await wait(1_500)

    // An ordinary listener, who is the one the room is made of. They must hear
    // the guest; the guest must not.
    const room = await browser.newPage()
    await room.addInitScript(INSTRUMENT_VOICE)
    await room.goto(STATION_URL)
    await tuneIn(room, 'thabo')
    await wait(1_500)

    const console_ = await decks(browser, true)
    await askedUp(guest, console_)

    await guest.click('[data-testid=sound-check]')
    const { passed, notice } = await verdict(guest)
    checks.run('they pass, and are offered a way up', passed, notice.slice(0, 72))
    if (!passed) return

    // Nothing in anybody's headphones before there is a voice to put there.
    const before = (await console_.evaluate(CUE_LEVEL)) as number
    checks.run('the console hears nothing before they come up', before < HEARD, `peak ${before}`)

    await guest.click('[data-testid=go-up]')
    await wait(2_500)

    checks.run(
      'they land on the mic',
      await guest.locator('[data-testid=on-the-mic]').isVisible(),
      'the guest sees an on-air notice',
    )
    checks.run(
      'and the console sees it',
      (await console_.locator('[data-testid=floor-speaker]').count()) > 0,
      'a speaker on the floor card',
    )
    const reach = (await console_.locator('[data-testid=mic-reach]').textContent())?.trim()
    checks.run(
      'the mesh is up for them',
      Boolean(reach),
      reach?.split('hearing')[0]?.trim() ?? 'no connections at all',
    )
    checks.run(
      'and they have a mute they can reach',
      await guest.locator('[data-testid=guest-mute]').isVisible(),
      'a mute beside the on-air notice',
    )

    // The talk channel, which is the risky half of this whole feature: the
    // decks offered `recvonly`, the guest answered with a microphone on it, and
    // the console is now measuring its own headphones.
    let heard = 0
    for (let i = 0; i < 30 && heard < HEARD; i++) {
      heard = (await console_.evaluate(CUE_LEVEL)) as number
      if (heard < HEARD) await wait(500)
    }
    checks.run('the console can hear the guest', heard >= HEARD, `peak ${heard.toFixed(4)}`)
    checks.run(
      'and says so beside their name',
      ((await console_.locator('[data-testid=guest-link]').textContent()) ?? '').includes(
        'you can hear them',
      ),
      (await console_.locator('[data-testid=guest-link]').getAttribute('data-state')) ?? '?',
    )
    // And the guest is told so, which matters more than it looks: somebody
    // whose own music has gone silent and who can hear nothing of themselves
    // has no evidence at all that anything is working.
    checks.run(
      'and the guest is told the room can hear them',
      ((await guest.locator('[data-testid=on-the-mic-detail]').textContent()) ?? '').includes(
        'The room can hear you',
      ),
      'the guest is left guessing',
    )

    // The two facts this milestone is for, measured at the two ends that can
    // tell them apart. They are asserted together because either one alone is
    // meaningless: a room that hears nothing is a broken call, and a guest who
    // hears themselves is an unusable one.
    let inTheRoom = 0
    for (let i = 0; i < 30 && inTheRoom < HEARD; i++) {
      inTheRoom = (await room.evaluate(VOICE_LEVEL)) as number
      if (inTheRoom < HEARD) await wait(500)
    }
    checks.run('the room hears the guest', inTheRoom >= HEARD, `peak ${inTheRoom.toFixed(4)}`)

    // Over a whole cycle of the capture file, so "quiet" cannot be the silent
    // half of it. This is mix-minus, and it is inaudible from every angle
    // except this one: the console sees a healthy connection, the room hears
    // them perfectly, and the only person who knows is the one who cannot say.
    let inTheirEars = 0
    for (let i = 0; i < 14; i++) {
      inTheirEars = Math.max(inTheirEars, (await guest.evaluate(VOICE_LEVEL)) as number)
      await wait(500)
    }
    checks.run(
      'and the guest does not hear themselves',
      inTheirEars < HEARD,
      `peak ${inTheirEars.toFixed(4)}`,
    )

    // Muting has to reach the far end rather than only the button. Measured
    // over a whole cycle of the capture file, so that "quiet" cannot be the
    // silent half of it — which would pass whether or not the mute worked.
    await guest.click('[data-testid=guest-mute]')
    await wait(1_000)
    let muted = 0
    for (let i = 0; i < 14; i++) {
      muted = Math.max(muted, (await console_.evaluate(CUE_LEVEL)) as number)
      await wait(500)
    }
    checks.run('muting is heard at the other end', muted < HEARD, `peak ${muted.toFixed(4)}`)
    await guest.click('[data-testid=guest-mute]')
    await wait(1_000)

    // The headline: a caller hears the studio, not the record. Silence rather
    // than the duck depth, so there is nothing left for their own microphone
    // to pick up.
    const up = ((await guest.evaluate(DUCKS)) as Duck[]).at(-1)
    checks.run(
      'their own music goes to silence, not to the duck depth',
      up?.target === 0,
      `last ramp ${up?.target}`,
    )

    // The dump button, as much of one as a station whose music is aligned to a
    // clock can have: there is no delay to drop, so all it has is speed. It has
    // to take the guest off the room bus *and* stand them down, or the console
    // is left showing somebody on air who cannot be heard.
    await console_.click('[data-testid=guest-cut]')
    let afterCut = 0
    for (let i = 0; i < 6; i++) {
      afterCut = Math.max(afterCut, (await room.evaluate(VOICE_LEVEL)) as number)
      await wait(300)
    }
    checks.run('the cut takes them off the air', afterCut < HEARD, `peak ${afterCut.toFixed(4)}`)
    checks.run(
      'and stands them down with it',
      (await console_.locator('[data-testid=floor-speaker]').count()) === 0,
      'the floor is empty',
    )

    // The microphone has to go back when a call ends. A caller left holding an
    // open capture and a recording light after coming down is the sort of thing
    // nobody notices until somebody notices it about themselves.
    checks.run(
      'the microphone goes back when the call ends',
      (await guest.locator('[data-testid=guest-meter]').count()) === 0,
      'no meter, so no open capture',
    )

    // Then all the way round once more, so that a call after a cut is an
    // ordinary call: nothing left latched shut, nothing left connected, and a
    // fresh check because their situation may be exactly why they were cut.
    await askedUp(guest, console_)
    await guest.click('[data-testid=sound-check]')
    const second = await verdict(guest)
    checks.run('somebody cut off can be brought back', second.passed, second.notice.slice(0, 40))
    if (second.passed) {
      await guest.click('[data-testid=go-up]')
      let again = 0
      for (let i = 0; i < 30 && again < HEARD; i++) {
        again = (await room.evaluate(VOICE_LEVEL)) as number
        if (again < HEARD) await wait(500)
      }
      checks.run('and the room hears them again', again >= HEARD, `peak ${again.toFixed(4)}`)
    }

    await guest.click('[data-testid=come-down]')
    await wait(1_500)
    checks.run(
      'coming down hands the mic back',
      (await console_.locator('[data-testid=floor-speaker]').count()) === 0,
      'the floor is empty again',
    )
    const gone = (await console_.evaluate(CUE_LEVEL)) as number
    checks.run('and takes their voice with it', gone < HEARD, `peak ${gone.toFixed(4)}`)
    let roomAfter = 0
    for (let i = 0; i < 8; i++) {
      roomAfter = Math.max(roomAfter, (await room.evaluate(VOICE_LEVEL)) as number)
      await wait(400)
    }
    checks.run('and the room stops hearing them', roomAfter < HEARD, `peak ${roomAfter.toFixed(4)}`)
    // Back to the room's duck rather than to full, and that is the rule from
    // the floor showing through: standing a guest down does not shut the mic,
    // because whoever runs the decks nearly always says something after them.
    const down = ((await guest.evaluate(DUCKS)) as Duck[]).at(-1)
    checks.run(
      "their music comes back to the room's duck, the mic still being open",
      down?.target !== undefined && down.target > 0 && down.target < 1,
      `last ramp ${down?.target}`,
    )

    await micCommand({ action: 'close' })
    await wait(1_500)
    const shut = ((await guest.evaluate(DUCKS)) as Duck[]).at(-1)
    checks.run(
      'and all the way back once the mic shuts',
      shut?.target === 1,
      `last ramp ${shut?.target}`,
    )
  } finally {
    await browser.close()
  }
}

/**
 * What happens when a call ends by itself.
 *
 * The rows of the failure table that can be produced on demand: a caller whose
 * tab dies mid-sentence, and a listener who walks in while somebody else is
 * already talking. Both are ordinary — a phone locking, somebody arriving at
 * ten — and both are invisible from the console unless they are made to work.
 */
async function survivesContact(): Promise<void> {
  console.log('\nwhen a call ends by itself…')
  const browser = await browserWith(headphonesWav())
  try {
    const guest = await browser.newPage()
    await guest.goto(STATION_URL)
    await tuneIn(guest, 'ama')
    await wait(1_500)
    const console_ = await decks(browser, true)
    await askedUp(guest, console_)
    await guest.click('[data-testid=sound-check]')
    const { passed } = await verdict(guest)
    if (!passed) {
      checks.run('a caller gets up at all', false, 'the sound check never passed')
      return
    }
    await guest.click('[data-testid=go-up]')
    await wait(2_500)

    // Somebody walking in at ten, while a call is already happening.
    const latecomer = await browser.newPage()
    await latecomer.addInitScript(INSTRUMENT_DUCKS)
    await latecomer.addInitScript(INSTRUMENT_VOICE)
    await latecomer.goto(STATION_URL)
    await tuneIn(latecomer, 'thabo')

    let late = 0
    for (let i = 0; i < 30 && late < HEARD; i++) {
      late = (await latecomer.evaluate(VOICE_LEVEL)) as number
      if (late < HEARD) await wait(500)
    }
    checks.run('somebody arriving mid-call hears the guest', late >= HEARD, `peak ${late.toFixed(4)}`)
    // And arrives already ducked, rather than putting a bar of full-volume
    // music under somebody's voice and correcting it a frame later.
    const ducks = (await latecomer.evaluate(DUCKS)) as Duck[]
    checks.run(
      'and arrives already ducked for them',
      ducks.some((duck) => duck.target > 0 && duck.target < 1),
      `first ramp ${ducks[0]?.target}`,
    )

    // The caller's phone locks, or their tab is closed. Everything the floor
    // holds is pinned to a socket, which is why there is no lease on it.
    await guest.close()
    await wait(2_000)
    checks.run(
      'a caller whose tab dies is stood down',
      (await console_.locator('[data-testid=floor-speaker]').count()) === 0,
      'the floor is empty',
    )
    const after = (await console_.evaluate(CUE_LEVEL)) as number
    checks.run('and the console stops hearing them', after < HEARD, `peak ${after.toFixed(4)}`)
    let stillThere = 0
    for (let i = 0; i < 6; i++) {
      stillThere = Math.max(stillThere, (await latecomer.evaluate(VOICE_LEVEL)) as number)
      await wait(400)
    }
    checks.run('and so does the room', stillThere < HEARD, `peak ${stillThere.toFixed(4)}`)
  } finally {
    await browser.close()
  }
}

async function main(): Promise<void> {
  await onSpeakers()
  await onHeadphones()
  await survivesContact()
  checks.finish('CALL-IN QA')
}

void main()
