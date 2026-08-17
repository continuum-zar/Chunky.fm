/**
 * A voice, from the decks to a listener, in two real browsers.
 *
 * The one thing no unit test in this repository can show. Everything under the
 * mic is tested against a fake `RTCPeerConnection` and a fake `AudioContext`,
 * which pins the shape of the negotiation and says nothing at all about whether
 * two browsers can actually hear each other. This is that claim, made once,
 * end to end: a real console opens a real microphone, a real peer connection is
 * negotiated through the station's relay, and the listener's page is measured
 * for whether sound is coming out of it.
 *
 * Chrome's fake capture device is what makes it runnable without a person in
 * the room: `--use-fake-device-for-media-stream` produces a tone rather than
 * silence, so "the voice arrived" and "the voice can be heard" become two
 * different, separately observable facts. They are worth separating, because
 * the failure this milestone was most warned about — a remote stream connected
 * only to Web Audio is silent in Chrome — shows up as a connection that is
 * perfectly healthy and completely inaudible.
 *
 * Needs a running Vite dev server, a running station, and a track a few minutes
 * long in the library. See README.
 */
import { type Page, chromium } from 'playwright-core'
import {
  ADMIN_PASSWORD,
  CHROME_PATH,
  Checks,
  DUCKS,
  type Duck,
  INSTRUMENT_DUCKS,
  INSTRUMENT_VOICE,
  PLAYING,
  STATION_URL,
  TRACK_ID,
  VOICE_LEVEL,
  VOICE_STATE,
  type VoiceState,
  goLive,
  micCommand,
  playbackCommand,
  tuneIn,
  wait,
} from './qa-env.js'

const checks = new Checks()
const ADMIN_URL = `${STATION_URL}#admin`

/** Negotiating on loopback is fast; this is room for a slow CI machine. */
const CONNECT_MS = 15_000
/** Long enough for the far end to open its fader and for a tone to arrive. */
const AUDIBLE_MS = 6_000

/**
 * The fake device is a loud, continuous tone, so a voice that is arriving reads
 * far above this and one that is muted at the far end reads far below it. The
 * gap between the two is the whole test; nothing here is a near miss.
 */
const HEARD = 0.02
const QUIET = 0.005

const level = (page: Page): Promise<number> => page.evaluate<number>(VOICE_LEVEL)
const voice = (page: Page): Promise<VoiceState> => page.evaluate<VoiceState>(VOICE_STATE)

/** The loudest the arriving voice got over a window. */
async function peak(page: Page, overMs: number): Promise<number> {
  const deadline = Date.now() + overMs
  let highest = -1
  while (Date.now() < deadline) {
    const now = await level(page)
    if (now > highest) highest = now
    // Stop early once it is unambiguous: waiting out the window to confirm a
    // fact already established just makes the run longer.
    if (highest > HEARD) break
    await wait(50)
  }
  return highest
}

/** The quietest it settled to, having been given time to settle. */
async function trough(page: Page, overMs: number): Promise<number> {
  await wait(1_000)
  const deadline = Date.now() + overMs
  let lowest = 1
  while (Date.now() < deadline) {
    const now = await level(page)
    if (now >= 0 && now < lowest) lowest = now
    await wait(50)
  }
  return lowest
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs
  let last = await read()
  while (Date.now() < deadline && !ok(last)) {
    await wait(150)
    last = await read()
  }
  return last
}

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
})

try {
  await goLive()
  await micCommand({ action: 'close' })
  await playbackCommand({ action: 'play', trackId: TRACK_ID })

  // --- a listener, watched ---------------------------------------------------
  const listener = await (await browser.newContext()).newPage()
  await listener.addInitScript(INSTRUMENT_DUCKS)
  await listener.addInitScript(INSTRUMENT_VOICE)
  await listener.goto(STATION_URL, { waitUntil: 'domcontentloaded' })
  await tuneIn(listener, 'ana')
  await wait(1_000)
  checks.run('the listener is listening', await listener.evaluate<boolean>(PLAYING), 'audio running')

  // Nothing yet, and that is worth asserting: a page that reported a voice
  // before one was sent would make every check below meaningless.
  checks.run('no voice before anybody talks', (await voice(listener)).tracks === 0, 'no track yet')

  // --- the console, with a microphone ---------------------------------------
  const decks = await (await browser.newContext({ permissions: ['microphone'] })).newPage()
  await decks.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' })
  await decks.fill('[data-testid="admin-password"]', ADMIN_PASSWORD)
  await decks.getByRole('button', { name: 'Sign in' }).click()
  await decks.waitForSelector('[data-testid="mic-power"]', { timeout: 10_000 })

  console.log('\nopening the microphone…')
  await decks.click('[data-testid="mic-power"]')
  await decks.waitForSelector('[data-testid="mic-meter"]', { timeout: 10_000 })

  // The connection is built when the mic opens, not when somebody talks: that
  // is the point of the gain node, and this is where it shows.
  const arrived = await until(
    () => voice(listener),
    (v) => v.tracks > 0 && v.current === 'connected',
    CONNECT_MS,
  )
  checks.run('a voice connection reaches the listener', arrived.tracks > 0, `${arrived.tracks} track(s)`)
  checks.run(
    'and it gets to connected',
    arrived.current === 'connected',
    `now ${arrived.current}, via ${arrived.states.join(' → ') || 'nothing'}`,
  )

  // The console's own account of the same thing, which is the only way a
  // failure here would ever be noticed by a person.
  const reach = await until(
    () => decks.textContent('[data-testid="mic-reach"]').then((t) => t ?? ''),
    (text) => text.includes('1 of 1'),
    CONNECT_MS,
  )
  checks.run('the console says who is hearing it', reach.includes('1 of 1'), `reach: "${reach.trim()}"`)
  checks.run('and names them', reach.includes('ana'), `reach: "${reach.trim()}"`)

  // Connected, and still silent, because nobody has pressed anything. This is
  // the pair of facts that catches a mic left open between breaks.
  checks.run('connected but not yet audible', (await trough(listener, 1_500)) < QUIET, 'silent')

  // --- talking ---------------------------------------------------------------
  console.log('\ngoing on mic…')
  await decks.check('[data-testid="mic-latch"]')

  const heard = await peak(listener, AUDIBLE_MS)
  checks.run('the listener can actually hear it', heard > HEARD, `peaked at ${heard.toFixed(4)}`)

  // The other half of a mic break, and the half that works whether or not any
  // of the above does: the music gets out of the way.
  const ducks = await listener.evaluate<Duck[]>(DUCKS)
  const ducked = ducks.at(-1)
  checks.run(
    'and the music ducked under it',
    ducked !== undefined && ducked.target < 1,
    `last ramp ${ducked === undefined ? 'none' : ducked.target}`,
  )

  // --- and stopping ----------------------------------------------------------
  console.log('\ncoming off mic…')
  await decks.uncheck('[data-testid="mic-latch"]')

  checks.run('it goes quiet again', (await trough(listener, 2_000)) < QUIET, 'silent')

  // The connection is *kept*, which is what makes the next break start on the
  // first word instead of a second and a half later.
  const after = await voice(listener)
  checks.run('without tearing the connection down', after.current === 'connected', `now ${after.current}`)

  const backUp = await listener.evaluate<Duck[]>(DUCKS)
  checks.run(
    'and the music comes back up',
    backUp.at(-1)?.target === 1,
    `last ramp ${backUp.at(-1)?.target ?? 'none'}`,
  )

  // --- a second break, on the connection that was left warm ------------------
  console.log('\nsecond break…')
  await decks.check('[data-testid="mic-latch"]')
  const again = await peak(listener, AUDIBLE_MS)
  checks.run('a second break is heard on the same connection', again > HEARD, `peaked at ${again.toFixed(4)}`)
  await decks.uncheck('[data-testid="mic-latch"]')

  // --- the station going off air ends it -------------------------------------
  console.log('\nending the broadcast…')
  await decks.click('[data-testid="end-session"]')
  await decks.click('[data-testid="end-session-confirm"]')
  await wait(2_000)

  // What ends with a session ends completely, and a voice from a broadcast that
  // finished would be the one thing left talking.
  const ended = await until(() => voice(listener), (v) => v.current !== 'connected', 5_000)
  checks.run(
    'the voice connection ends with the session',
    ended.current === 'closed',
    `now ${ended.current}`,
  )
} finally {
  await micCommand({ action: 'close' }).catch(() => undefined)
  await browser.close()
}

checks.finish('VOICE QA')
