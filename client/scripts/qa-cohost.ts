/**
 * The co-host's seat, in a real browser.
 *
 * Four things here cannot be tested away from one, and they are the four this
 * script exists for.
 *
 * **The link is the credential.** A co-host arrives at `/cohost?k=<key>`, and
 * the key has to be redeemed for a cookie and taken back out of the address bar
 * before anything else happens — a secret left in a URL is a secret in every
 * screenshot and every entry in the browser's history.
 *
 * **Sitting down is a gesture.** The seat, the audio context and the microphone
 * are all built on one click, because contexts start suspended and only a
 * gesture may resume one. A page that built them on mount would be silent in a
 * way nothing reports.
 *
 * **Push-to-talk is held, not clicked.** A click fires on release, so a talk
 * button wired to one starts talking when you stop. This drives the pointer
 * events a thumb actually produces, and watches the station's mic frame follow
 * them — including the hangover, which is the part that stops the music
 * swelling back between words.
 *
 * **The crossfade is two elements.** A transition is two records playing at
 * once, which is the one claim in this whole feature that a unit test cannot
 * make: it needs a browser with two `<audio>` elements actually decoding two
 * files while two gain nodes cross. So the page is instrumented and asked.
 *
 * **And the voice actually gets to the room.** This is the headline of the
 * whole seat and it crosses three browsers: the co-host's phone sends to the
 * console over WebRTC, the console mixes it into what it is already sending,
 * and a listener who has never heard of a co-host hears them. Every instrument
 * on the way can say the call is healthy while the room hears silence — that
 * is precisely the failure mode of a stream connected only to Web Audio — so
 * the only assertion worth making is at the listener's own speakers.
 *
 * Needs a running Vite dev server, a running station, and two tracks in the
 * library. See README.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Page, chromium } from 'playwright-core'
import {
  ADMIN_PASSWORD,
  API_URL,
  CHROME_PATH,
  CLIENT_URL,
  Checks,
  INSTRUMENT_VOICE,
  OTHER_TRACK_ID,
  PLAYING,
  STATION_URL,
  TRACK_ID,
  VOICE_LEVEL,
  goLive,
  playbackCommand,
  tuneIn,
  wait,
} from './qa-env.js'

const ADMIN_URL = `${STATION_URL}#admin`

/**
 * Counts what the two decks are actually doing.
 *
 * Reads the elements rather than the React state, because the claim being made
 * is about sound: how many of them are unpaused, and where each one's needle
 * is. A page whose state said "crossfading" while one element sat paused would
 * pass a state assertion and be a hard cut.
 */
const DECKS = `(() => {
  var found = Array.from(document.querySelectorAll('audio'))
  return found.map(function (el) {
    return {
      src: (el.getAttribute('src') || '').split('/').pop(),
      paused: el.paused,
      at: Math.round(el.currentTime * 10) / 10,
    }
  })
})()`

/** What the station last said about the mic. Asked from inside the page so it
 * goes through the same origin — and the same cookies — the page itself uses. */
const MIC = `fetch('/api/mic').then(function (r) { return r.json() })`

interface Mic {
  live: boolean
  duckTo: number
}

async function seat(page: Page, key: string): Promise<void> {
  await page.goto(`${CLIENT_URL}/cohost?k=${encodeURIComponent(key)}`)
  await page.waitForSelector('[data-testid="cohost-sit"]', { timeout: 10_000 })
}

/**
 * A microphone that sounds like somebody on headphones.
 *
 * Chrome's built-in fake device is a beep every second, which is exactly the
 * wrong shape to get past the sound check — and rightly so: an unbroken tone is
 * what a phone on speaker sounds like when the station is coming back into it,
 * and refusing that is the whole point of the gate. So this script supplies its
 * own capture, the same one `qa-callin.ts` uses and for the same reason.
 *
 * Two seconds of tone and four of silence, looping. The silence is what stands
 * in for headphones — the check wants an unbroken second and a half of it — and
 * the tone is what there is to measure once somebody is on air. It loops
 * because the check takes a few seconds and the talking comes after it, so a
 * file that played once would have run out by the time anybody was listening.
 *
 * Written here rather than checked in: it is a sine wave and some zeroes, and a
 * megabyte of that in a repository is a megabyte nobody can review.
 */
function headphonesWav(): string {
  const rate = 48_000
  const frames = Math.round(6 * rate)
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < Math.round(2 * rate); i++) {
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

  const file = path.join(mkdtempSync(path.join(tmpdir(), 'chunky-cohost-')), 'headphones.wav')
  writeFileSync(file, Buffer.concat([header, data]))
  return file
}

/** The co-host key, the way the console gets it. */
async function coHostKey(): Promise<string> {
  const session = await fetch(`${API_URL}/api/admin/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const answer = await fetch(`${API_URL}/api/cohost/key`, { headers: { cookie } })
  if (!answer.ok) throw new Error(`/api/cohost/key answered ${answer.status}`)
  return ((await answer.json()) as { key: string }).key
}

/**
 * The console, signed in and holding a microphone.
 *
 * A co-host's voice does not reach the room by itself: it goes to the console
 * and out again on the connections the room already has, exactly as a call-in
 * guest's does. So the desk has to be open for any of this to be audible, and
 * its own microphone has to be on — that is what builds the mixer the co-host's
 * voice is mixed into.
 */
/**
 * The loudest this page heard over a window, rather than at an instant.
 *
 * The capture standing in for a microphone is two seconds of tone and four of
 * silence, looping — see `headphonesWav`, where the silence is what gets past
 * the sound check. So a single reading is as likely to land in the gap as in
 * the tone, and a check built on one would fail about two thirds of the time
 * for a reason that has nothing to do with the station.
 *
 * A window longer than the loop, sampled often, and the peak of it. That is
 * also the honest question: "can the room hear them" is about whether anything
 * gets through at all, not about the level at one arbitrary millisecond.
 */
async function peak(page: Page, overMs: number, settleMs = 0): Promise<number> {
  // `settleMs` is for the checks that measure *silence*. A fader takes about
  // fifteen milliseconds to close — it is ramped rather than switched, because
  // a step in gain is an audible click — so a sampler that started at the
  // instant of release would record the level on the way down and call it
  // sound. Nothing here is measuring how fast a ramp is; that is `mixer.test.ts`.
  if (settleMs > 0) await wait(settleMs)
  let loudest = 0
  const until = Date.now() + overMs
  while (Date.now() < until) {
    loudest = Math.max(loudest, (await page.evaluate<number>(VOICE_LEVEL)) ?? 0)
    await wait(200)
  }
  return loudest
}

async function openDesk(browser: Browser): Promise<Page> {
  const page = await browser.newPage()
  await page.goto(ADMIN_URL)
  await page.fill('input[type=password]', ADMIN_PASSWORD)
  await page.click('button[type=submit]')
  await wait(2_000)
  // The microphone is what builds the mixer, and the mixer is what the
  // co-host's voice is mixed into. A desk with no mic open has no bus for
  // anybody's voice to reach the room on.
  await page.click('[data-testid="mic-power"]')
  await wait(3_000)
  return page
}

async function main(): Promise<void> {
  const checks = new Checks()
  /** Sugar over the harness's `run`, so each line below reads as one claim. */
  const ok = (detail: string, passed: boolean) => checks.run('cohost', passed, detail)
  const is = (detail: string, actual: unknown, expected: unknown) =>
    checks.run(
      'cohost',
      actual === expected,
      `${detail}${actual === expected ? '' : ` (got ${JSON.stringify(actual)})`}`,
    )
  let browser: Browser | null = null

  try {
    const key = await coHostKey()
    await goLive('set')
    // A record on, and one behind it, so there is something to transition into.
    await playbackCommand({ action: 'play', trackId: TRACK_ID })
    await fetch(`${API_URL}/api/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-password': ADMIN_PASSWORD },
      body: JSON.stringify({ trackId: OTHER_TRACK_ID }),
    })

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // See `headphonesWav`: the built-in fake device is a beep, which the
        // sound check is designed to refuse.
        `--use-file-for-fake-audio-capture=${headphonesWav()}`,
      ],
    })
    const context = await browser.newContext({
      permissions: ['microphone'],
      // A phone, because that is the only device this page is for. The layout
      // has a talk button sized against the viewport, and a desktop window
      // would be testing a page nobody uses.
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    const page = await context.newPage()

    // --- the link ---------------------------------------------------------
    await seat(page, key)
    ok('the link opens the seat rather than the door', true)
    is('the key is taken out of the address bar', new URL(page.url()).searchParams.get('k'), null)
    is(
      'and is not readable by page script: the cookie is HttpOnly',
      await page.evaluate(`document.cookie.includes('chunky_cohost')`),
      false,
    )

    // --- sitting down -----------------------------------------------------
    await page.fill('[data-testid="cohost-nickname"]', 'qa-cohost')
    await page.click('[data-testid="cohost-sit"]')
    await page.waitForSelector('[data-testid="cohost-desk"]', { timeout: 10_000 })
    ok('one gesture names you, sits you down and wakes the audio', true)

    const named = (await fetch(`${API_URL}/api/cohost`).then((r) => r.json())) as {
      seat: { nickname: string } | null
    }
    is('the station knows who is co-hosting', named.seat?.nickname, 'qa-cohost')

    // --- the decks --------------------------------------------------------
    await wait(2_000)
    const decks = (await page.evaluate(DECKS)) as { src: string; paused: boolean; at: number }[]
    is('the page holds two decks, because a transition is two records', decks.length, 2)
    ok(
      'one of them is playing the record on air',
      decks.some((deck) => !deck.paused && deck.at > 0),
    )
    is(
      'and only one, while nothing is fading',
      decks.filter((deck) => !deck.paused).length,
      1,
    )

    // --- push to talk -----------------------------------------------------
    // The check runs on the microphone this browser was given and takes a few
    // seconds. Nothing offers a way to talk before it passes, which is the gate
    // working rather than something to wait around: see `lib/sound-check.ts`.
    await page.waitForFunction(
      `!document.querySelector('[data-testid="cohost-talk"]').disabled`,
      undefined,
      { timeout: 20_000 },
    )
    ok('the sound check lets somebody on headphones through', true)
    const button = (await page.waitForSelector('[data-testid="cohost-talk"]'))!
    const box = (await button.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await wait(700)

    ok('holding the button ducks the room', ((await page.evaluate(MIC)) as Mic).live)
    ok(
      'and the button says so',
      Boolean(
        await page.evaluate(
          `document.querySelector('[data-testid="cohost-talk"]').getAttribute('aria-pressed') === 'true'`,
        ),
      ),
    )

    await page.mouse.up()
    // Inside the hangover: the music must not have swelled back yet, or the
    // last syllable of every sentence lands over a rising record.
    await wait(200)
    ok('the hangover holds the mic open past the release', ((await page.evaluate(MIC)) as Mic).live)
    await wait(1_500)
    is('and lets go a moment later', ((await page.evaluate(MIC)) as Mic).live, false)

    // --- the transition ---------------------------------------------------
    await page.evaluate(`fetch('/api/transition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blendMs: 6000 })
    })`)
    await wait(500)
    await page.click('[data-testid="cohost-blend"]')
    await wait(1_500)

    const blending = (await page.evaluate(DECKS)) as { src: string; paused: boolean; at: number }[]
    const playing = blending.filter((deck) => !deck.paused && deck.at > 0)
    is(
      'taking it over runs both decks at once: this is the crossfade, in a browser',
      playing.length,
      2,
    )
    ok(
      'and they are two different records rather than one played twice',
      playing.length === 2 && playing[0]!.src !== playing[1]!.src,
    )

    await wait(6_000)
    const after = (await page.evaluate(DECKS)) as { paused: boolean }[]
    is(
      'and the outgoing deck stops when its window closes',
      after.filter((deck) => !deck.paused).length,
      1,
    )

    // --- the room actually hears them ---------------------------------------
    // Three browsers: this phone, a console to relay through, and somebody who
    // has never heard of a co-host. The assertion is at the last one's speakers,
    // because every instrument before it can say the call is healthy while the
    // room hears nothing.
    console.log('opening the desk and putting a listener in the room…')
    const desk = await openDesk(browser)
    const room = await browser.newPage()
    await room.addInitScript(INSTRUMENT_VOICE)
    await room.goto(STATION_URL, { waitUntil: 'domcontentloaded' })
    await tuneIn(room, 'a listener')
    await room.waitForFunction(PLAYING, null, { timeout: 15_000 })
    await wait(6_000)

    // Over a window longer than the capture's loop, so "silent" means silent
    // rather than "sampled during the gap". See `peak`.
    const quiet = await peak(room, 7_000)
    ok(`the room hears nothing while the co-host is quiet: peak ${quiet.toFixed(4)}`, quiet < 0.02)

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    const heard = await peak(room, 9_000)
    await page.mouse.up()

    // **The headline of the whole seat**, and the only assertion in this file
    // made at somebody else's speakers. Three browsers: the phone sends over
    // WebRTC, the console mixes it into what it is already sending, and a
    // listener who has never heard of a co-host hears them.
    ok(`the room hears the co-host: peak ${heard.toFixed(4)}`, heard > 0.02)

    const stopped = await peak(room, 7_000, 1_000)
    ok(`and stops when they let go: peak ${stopped.toFixed(4)}`, stopped < 0.02)

    await room.close()
    await desk.close()

    // --- standing up ------------------------------------------------------
    await page.click('[data-testid="cohost-stand"]')
    await wait(1_000)
    const empty = (await fetch(`${API_URL}/api/cohost`).then((r) => r.json())) as {
      seat: unknown | null
    }
    is('standing down gives the seat back', empty.seat, null)
  } finally {
    await browser?.close()
  }

  checks.finish('co-host')
}

void main()
