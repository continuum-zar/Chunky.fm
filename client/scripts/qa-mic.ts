/**
 * Talking over the music, in real browsers.
 *
 * The acceptance check for M1, and for the claim the whole design rests on: the
 * station holds no mixer, so a mic break is a broadcast and thirty browsers
 * turn down the copy of the track they are each already playing. What that has
 * to look like from outside is two listeners dipping *together*, on a station
 * that sent no audio to either of them.
 *
 * The duck lives inside a Web Audio graph, which nothing outside the page can
 * read, so each page is instrumented before its script runs and every gain ramp
 * is recorded. See INSTRUMENT_DUCKS in qa-env.ts.
 *
 * Needs a running Vite dev server and a station with a track on the decks. See
 * README.
 */
import { type Browser, type Page, chromium } from 'playwright-core'
import {
  CHROME_PATH,
  Checks,
  type Duck,
  DUCKS,
  INSTRUMENT_DUCKS,
  PLAYING,
  STATION_URL,
  TRACK_ID,
  goLive,
  micCommand,
  playbackCommand,
  tuneIn,
  wait,
} from './qa-env.js'

const checks = new Checks()
/** A ramp settles in about 250ms; this is room for a broadcast on top of it. */
const SETTLE_MS = 2_000
/** How far the music drops in this run. Deliberately not the default. */
const DUCK_TO = 0.3

const ducks = (page: Page): Promise<Duck[]> => page.evaluate<Duck[]>(DUCKS)

/** The depth the page is heading for, or null if it never asked for one. */
async function target(page: Page): Promise<number | null> {
  const seen = await ducks(page)
  return seen.length === 0 ? null : seen[seen.length - 1]!.target
}

/** Waits for a page to be heading somewhere near `expected`, then reports. */
async function expectDuck(page: Page, who: string, expected: number): Promise<void> {
  const deadline = Date.now() + SETTLE_MS
  let seen: number | null = null
  while (Date.now() < deadline) {
    seen = await target(page)
    if (seen !== null && Math.abs(seen - expected) < 0.001) break
    await wait(50)
  }
  checks.run(
    `${who} is heading for ${expected}`,
    seen !== null && Math.abs(seen - expected) < 0.001,
    `last ramp ${seen === null ? 'none' : seen}`,
  )
}

async function join(browser: Browser, nickname: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  // Before the app's script, so the very first ramp is caught. A listener who
  // arrives mid-break ducks inside the join handler, which is earlier than
  // anything this script could patch afterwards.
  await page.addInitScript(INSTRUMENT_DUCKS)
  await page.goto(STATION_URL, { waitUntil: 'domcontentloaded' })
  await tuneIn(page, nickname)
  await wait(500)
  console.log(`${nickname}: tuned in`)
  return page
}

/** What the deck says it is doing, which is the listener's half of the story. */
const onMic = (page: Page): Promise<string> =>
  page.$eval('[data-testid="on-mic"]', (node) => node.textContent ?? '').catch(() => '')

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})

try {
  // A station is off air by default, and the mic is refused without a
  // broadcast to talk over.
  await goLive()
  await playbackCommand({ action: 'play', trackId: TRACK_ID })
  await micCommand({ action: 'close' })
  await micCommand({ action: 'duck', duckTo: DUCK_TO })

  const ana = await join(browser, 'ana')
  const ben = await join(browser, 'ben')

  for (const [page, who] of [
    [ana, 'ana'],
    [ben, 'ben'],
  ] as const) {
    checks.run(`${who} is listening`, await page.evaluate<boolean>(PLAYING), 'audio running')
  }

  // Both start open: joining off-mic asks for full volume, which is a ramp to 1
  // and the baseline everything below moves away from.
  await expectDuck(ana, 'ana before the break', 1)
  await expectDuck(ben, 'ben before the break', 1)

  console.log('\ngoing on mic…')
  const opened = await micCommand({ action: 'open' })
  checks.run('the station says the mic is open', opened.live === true, JSON.stringify(opened))

  // The whole point: nobody sent either browser any audio, and both of them
  // turned their own music down.
  await expectDuck(ana, 'ana during the break', DUCK_TO)
  await expectDuck(ben, 'ben during the break', DUCK_TO)

  // And it is a ramp, not a jump. Every dip went through setTargetAtTime,
  // which is the only reason this script can see them at all — a bare
  // assignment to `.value` would be a click, and would record nothing here.
  checks.run(
    'the dip was ramped, not switched',
    (await ducks(ana)).length >= 2,
    `${(await ducks(ana)).length} ramps recorded`,
  )

  for (const [page, who] of [
    [ana, 'ana'],
    [ben, 'ben'],
  ] as const) {
    const label = await onMic(page)
    checks.run(`${who} is told a break is happening`, /on the mic/i.test(label), `deck says "${label}"`)
  }

  // A listener who arrives in the middle of one comes in already ducked, rather
  // than getting half a second of a song at full volume under somebody's voice.
  console.log('\ncleo arrives mid-break…')
  const cleo = await join(browser, 'cleo')
  const first = (await ducks(cleo))[0]
  checks.run(
    'cleo arrives already ducked',
    first !== undefined && Math.abs(first.target - DUCK_TO) < 0.001,
    `first ramp ${first === undefined ? 'none' : first.target}`,
  )

  console.log('\ncoming off mic…')
  await micCommand({ action: 'close' })

  await expectDuck(ana, 'ana after the break', 1)
  await expectDuck(ben, 'ben after the break', 1)
  await expectDuck(cleo, 'cleo after the break', 1)

  const label = await onMic(ana)
  checks.run('the deck stops saying it', !/on the mic/i.test(label), `deck says "${label}"`)

  // Moving the fader mid-sentence reaches everyone, which is the control worth
  // having: it is the one you reach for when you can hear the bed is too loud.
  console.log('\nre-opening and moving the fader under it…')
  await micCommand({ action: 'open' })
  await expectDuck(ana, 'ana on the second break', DUCK_TO)
  await micCommand({ action: 'duck', duckTo: 0.6 })
  await expectDuck(ana, 'ana after the fader moves', 0.6)
  await expectDuck(ben, 'ben after the fader moves', 0.6)
} finally {
  await micCommand({ action: 'close' }).catch(() => undefined)
  await browser.close()
}

checks.finish('MIC QA')
