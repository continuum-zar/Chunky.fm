/**
 * One record becoming the next, in real browsers.
 *
 * The claim being tested is the one this whole feature rests on and the one no
 * unit test can make: **two listeners, in two browsers, hear the same
 * crossfade at the same moment.** The station does not mix — it broadcasts two
 * instants on a clock, and every browser runs the fade itself — so a
 * transition that works is a transition that lands identically in two places
 * that never spoke to each other.
 *
 * Four things are checked, and the third is the one that would be quietly wrong
 * in a version that otherwise looked fine:
 *
 * 1. Both decks run at once, with two different records on them. That is the
 *    difference between a crossfade and a cut.
 * 2. The gains actually cross: the incoming one comes up while the outgoing one
 *    goes down. A pair of elements both playing at full volume is two records,
 *    not a transition.
 * 3. **The outgoing record is not reloaded.** The deck it was already playing on
 *    keeps it, and the incoming record lands on the other one. Getting this
 *    wrong is a seek and a decode at the exact moment nothing may stutter, and
 *    it sounds like a fault rather than a transition. See `lib/decking.ts`.
 * 4. Two browsers agree on where in the fade they are, to well inside the
 *    tolerance the station is built to.
 *
 * Needs a running Vite dev server, a running station, and two tracks in the
 * library a few minutes long. See README.
 */
import { type Browser, type Page, chromium } from 'playwright-core'
import {
  ADMIN_PASSWORD,
  API_URL,
  CHROME_PATH,
  Checks,
  OTHER_TRACK_ID,
  PLAYING,
  STATION_URL,
  TRACK_ID,
  goLive,
  playbackCommand,
  tuneIn,
  wait,
} from './qa-env.js'

/**
 * Every deck, and what it is doing.
 *
 * The elements rather than any React state, because the claim is about sound.
 * A page whose state said "crossfading" while one element sat paused would pass
 * a state assertion and be a hard cut.
 */
const DECKS = `(() => {
  return Array.prototype.slice.call(document.querySelectorAll('audio')).map(function (el, i) {
    return {
      deck: i,
      src: (el.getAttribute('src') || '').split('/').pop() || null,
      paused: el.paused,
      at: Math.round(el.currentTime * 100) / 100,
    }
  })
})()`

/**
 * Watches the two deck faders cross.
 *
 * The gains are inside a Web Audio graph, which is not readable from outside:
 * there is no property to poll and no attribute that changes. Patching the one
 * method the crossfade uses turns it into a list, without the app carrying a
 * seam that exists only for a test — the same trick `INSTRUMENT_DUCKS` plays on
 * the duck, and it reads a different method for the reason described there.
 */
const INSTRUMENT_FADES = `(() => {
  window.__fades = []
  const original = AudioParam.prototype.linearRampToValueAtTime
  AudioParam.prototype.linearRampToValueAtTime = function (value, when) {
    window.__fades.push({ value: value, when: when })
    return original.call(this, value, when)
  }
  return true
})()`

const FADES = `window.__fades || []`
const RESET_FADES = `(window.__fades = [], true)`

interface Deck {
  deck: number
  src: string | null
  paused: boolean
  at: number
}

interface Fade {
  value: number
  when: number
}

const decksOn = (page: Page) => page.evaluate<Deck[]>(DECKS)
const playing = (decks: Deck[]) => decks.filter((deck) => !deck.paused && deck.at > 0)

/**
 * An empty queue, whatever the last run left behind.
 *
 * This script asserts on *which* record is on which deck, so it cannot start
 * from a queue somebody else filled: one stray entry and the transition goes
 * somewhere the checks below were not written about, and every deck assertion
 * fails for a reason that has nothing to do with crossfading. `qa-all.sh`
 * restarts the station between scripts for the same reason; this is the same
 * guarantee for a script run on its own.
 */
async function emptyQueue(): Promise<void> {
  await fetch(`${API_URL}/api/queue`, {
    method: 'DELETE',
    headers: { 'x-admin-password': ADMIN_PASSWORD },
  })
}

/** Queue a record behind whatever is on. */
async function queue(trackId: number): Promise<void> {
  await fetch(`${API_URL}/api/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': ADMIN_PASSWORD },
    body: JSON.stringify({ trackId }),
  })
}

/** How long two records overlap, set the way the co-host's slider sets it. */
async function blendMs(ms: number): Promise<void> {
  await fetch(`${API_URL}/api/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': ADMIN_PASSWORD },
    body: JSON.stringify({ blendMs: ms }),
  })
}

async function listener(browser: Browser, label: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.addInitScript(INSTRUMENT_FADES)
  await page.goto(STATION_URL, { waitUntil: 'domcontentloaded' })
  await tuneIn(page, label)
  await page.waitForFunction(PLAYING, null, { timeout: 15_000 })
  return page
}

async function main(): Promise<void> {
  const checks = new Checks()
  const ok = (detail: string, passed: boolean) => checks.run('transition', passed, detail)
  let browser: Browser | null = null

  try {
    await goLive('set')
    await emptyQueue()
    await blendMs(6_000)
    await playbackCommand({ action: 'play', trackId: TRACK_ID })
    await queue(OTHER_TRACK_ID)

    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    })

    const ana = await listener(browser, 'ana')
    const ben = await listener(browser, 'ben')
    console.log('two listeners, playing\n')
    await wait(2_000)

    // --- before ------------------------------------------------------------
    const before = await decksOn(ana)
    ok('a page holds two decks', before.length === 2)
    ok('and only one of them is playing while nothing is fading', playing(before).length === 1)
    const wasOn = playing(before)[0]!

    await ana.evaluate(RESET_FADES)
    await ben.evaluate(RESET_FADES)

    // --- the transition ----------------------------------------------------
    console.log('taking the transition…')
    await playbackCommand({ action: 'blend' })
    await wait(2_000)

    const during = await decksOn(ana)
    const both = playing(during)
    ok('both decks run at once: this is the crossfade rather than a cut', both.length === 2)
    ok(
      'and they are two different records',
      both.length === 2 && both[0]!.src !== both[1]!.src,
    )

    // The rule the whole design rests on. The outgoing record must still be on
    // the deck it was already playing on: reloading it would be a decode and a
    // seek at the one moment nothing may stutter.
    const stillThere = during.find((deck) => deck.deck === wasOn.deck)
    ok(
      'the outgoing record was never moved off the deck it was playing on',
      stillThere?.src === wasOn.src && !stillThere.paused,
    )
    ok(
      'and its needle carried straight on rather than restarting',
      (stillThere?.at ?? 0) > wasOn.at,
    )

    const fades = await ana.evaluate<Fade[]>(FADES)
    const up = fades.filter((fade) => fade.value > 0.9)
    const down = fades.filter((fade) => fade.value < 0.1)
    ok('one fader is being taken up', up.length > 0)
    ok('while the other is taken down', down.length > 0)
    // Equal power rather than a straight line: two uncorrelated records at half
    // amplitude sum to about 0.7 of one, so a linear crossfade dips audibly in
    // the middle of every transition.
    ok(
      'and they cross through about 0.7 rather than 0.5',
      fades.some((fade) => fade.value > 0.68 && fade.value < 0.74),
    )

    // --- the two of them together -----------------------------------------
    const [anaDecks, benDecks] = await Promise.all([decksOn(ana), decksOn(ben)])
    const anaIn = playing(anaDecks).sort((a, b) => a.at - b.at)[0]
    const benIn = playing(benDecks).sort((a, b) => a.at - b.at)[0]
    const apart = Math.abs((anaIn?.at ?? 0) - (benIn?.at ?? 0))
    ok(
      `both browsers are at the same point in the incoming record (${apart.toFixed(3)}s apart)`,
      apart < 0.25,
    )
    ok('and both are running two decks', playing(benDecks).length === 2)

    // --- after -------------------------------------------------------------
    console.log('waiting out the fade…')
    await wait(6_000)
    const after = await decksOn(ana)
    ok('the outgoing deck stops when its window closes', playing(after).length === 1)
    ok(
      'and what is left is the record that came in',
      playing(after)[0]!.src === both.sort((a, b) => a.at - b.at)[0]!.src,
    )

    // --- a station set to cut ---------------------------------------------
    console.log('setting the crossfade to nothing…')
    await blendMs(0)
    await emptyQueue()
    await queue(TRACK_ID)
    await ana.evaluate(RESET_FADES)
    await playbackCommand({ action: 'blend' })
    await wait(1_500)
    ok(
      'a blend length of zero is a hard cut, on one deck',
      playing(await decksOn(ana)).length === 1,
    )
  } finally {
    await browser?.close()
  }

  checks.finish('transition')
}

void main()
