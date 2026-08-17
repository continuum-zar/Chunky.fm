/**
 * Presence QA in real browsers: listeners tune in one at a time, watch each
 * other arrive, watch each other go and, after the station is taken out from
 * under them, put themselves back on the roster without being asked.
 *
 * This is the acceptance check for the roster updating *in real time*, which is
 * the thing no unit test can show: every assertion waits on what a page is
 * actually rendering, not on what the server thinks.
 *
 * Needs a running Vite dev server and a built server (`cd server && npm run
 * build`), and the restart phase owns the server process. See README.
 */
import type { ChildProcess } from 'node:child_process'
import { type Browser, type Page, chromium } from 'playwright-core'
import {
  CHROME_PATH,
  STATION_URL,
  Checks,
  STATUS,
  TRACK_ID,
  health,
  playbackCommand,
  startServer,
  stopServer,
  tuneIn,
  wait,
} from './qa-env.js'

const checks = new Checks()
/** Generous: a roster hop is one broadcast, but CI machines are not fast. */
const SETTLE_MS = 3_000
/** Reconnect backoff climbs to 10s, and the rejoin rides the new socket. */
const RECONNECT_MS = 30_000

/** The roster as this page renders it, in order. */
const listeners = (page: Page): Promise<string[]> =>
  page.$$eval('[data-testid="listeners"] li', (rows) => rows.map((row) => row.textContent ?? ''))

/** Waits for the page's own list to say exactly this, then reports it. */
async function expectRoster(
  page: Page,
  who: string,
  expected: string[],
  { ordered = true, budgetMs = SETTLE_MS } = {},
): Promise<void> {
  // After a reconnect the roster is in whoever-got-back-first order, which is
  // not something to assert on, so those checks compare it as a set.
  const same = (seen: string[]) =>
    seen.length === expected.length &&
    (ordered ? seen : [...seen].sort()).every(
      (name, i) => name === (ordered ? expected : [...expected].sort())[i],
    )

  const deadline = Date.now() + budgetMs
  let seen: string[] = []
  while (Date.now() < deadline) {
    seen = await listeners(page)
    if (same(seen)) break
    await wait(100)
  }
  checks.run(`${who} sees [${expected.join(', ')}]`, same(seen), `showing [${seen.join(', ')}]`)
}

async function join(browser: Browser, nickname: string): Promise<Page> {
  // A context each: separate localStorage, separate sockets: as many listeners
  // as far as the station is concerned.
  const page = await (await browser.newContext()).newPage()
  // At `#chat`, which is where the roster is. Who else is here belongs to the
  // room rather than to the record, and the landing view is the record and the
  // words to it alone. The join form renders whatever the address says, so
  // tuning in from here lands straight on the room.
  await page.goto(`${STATION_URL}#chat`, { waitUntil: 'domcontentloaded' })
  await tuneIn(page, nickname)
  console.log(`${nickname}: tuned in`)
  return page
}

async function waitForStatus(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await page.evaluate<string>(STATUS)).includes(text)) return true
    await wait(500)
  }
  return false
}

let restarted: ChildProcess | null = null
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})

try {
  // Something on the decks, so the listeners are doing what listeners do.
  await playbackCommand({ action: 'play', trackId: TRACK_ID })

  const ana = await join(browser, 'ana')
  await expectRoster(ana, 'ana alone', ['ana'])

  const ben = await join(browser, 'ben')
  // The arrival reaches the listener who was already here, which is presence
  // working, as opposed to each page merely rendering its own connect frame.
  await expectRoster(ana, 'ana after ben joins', ['ana', 'ben'])
  await expectRoster(ben, 'ben on arrival', ['ana', 'ben'])

  const cleo = await join(browser, 'cleo')
  await expectRoster(ana, 'ana after cleo joins', ['ana', 'ben', 'cleo'])
  await expectRoster(ben, 'ben after cleo joins', ['ana', 'ben', 'cleo'])
  await expectRoster(cleo, 'cleo on arrival', ['ana', 'ben', 'cleo'])

  // A tab that opens the page but never tunes in holds a socket open and is
  // still not a listener: the roster is who named themselves, not who connected.
  const lurker = await (await browser.newContext()).newPage()
  await lurker.goto(`${STATION_URL}#chat`, { waitUntil: 'domcontentloaded' })
  await wait(1_000)
  await expectRoster(ana, 'ana with a lurker connected', ['ana', 'ben', 'cleo'])
  await lurker.close()

  console.log('\nben closes the tab…')
  await ben.close()
  await expectRoster(ana, 'ana after ben leaves', ['ana', 'cleo'])
  await expectRoster(cleo, 'cleo after ben leaves', ['ana', 'cleo'])

  // The roster is socket state, so a station that restarts has an empty one and
  // every listener has to say who they are again. Nobody presses anything: if
  // the rejoin did not ride the reconnect, the room would come back deserted
  // while three people were still listening to it.
  console.log('\ntaking the station down under them…')
  await stopServer()
  await health(false)
  checks.run(
    'listeners notice the station is gone',
    await waitForStatus(ana, 'reconnecting', 10_000),
    `ana's status`,
  )

  console.log('putting it back up…')
  restarted = startServer()
  checks.run('station came back', await health(true), 'health')

  for (const [page, who] of [
    [ana, 'ana'],
    [cleo, 'cleo'],
  ] as const) {
    checks.run(
      `${who} reconnects on its own`,
      await waitForStatus(page, 'on air', RECONNECT_MS),
      `${who}'s status`,
    )
  }

  // Both back, both named, and neither of them twice: the old sockets died with
  // the old process, so nothing ghosts.
  await expectRoster(ana, 'ana after the restart', ['ana', 'cleo'], {
    ordered: false,
    budgetMs: RECONNECT_MS,
  })
  await expectRoster(cleo, 'cleo after the restart', ['ana', 'cleo'], { ordered: false })
} finally {
  await browser.close()
  restarted?.unref()
}

checks.finish('PRESENCE QA')
