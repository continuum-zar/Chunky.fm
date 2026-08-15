/**
 * Wishes in real browsers: a listener asks for something, the room never hears
 * about it, and the admin reads it and marks it off.
 *
 * The property worth driving a browser for is the one no unit test can see:
 * that a wish reaches exactly two places. It goes to whoever runs the decks,
 * and back to the person who asked; every other listener in the room is told
 * nothing. Chat is the control here: two listeners who can see each other's
 * messages still cannot see each other's wishes.
 *
 * Needs a running server and a running Vite dev server. See README.
 */
import { type Browser, type Page, chromium } from 'playwright-core'
import { ADMIN_PASSWORD, API_URL, CHROME_PATH, STATION_URL, Checks, tuneIn, wait } from './qa-env.js'

const checks = new Checks()
const ADMIN_URL = `${STATION_URL}#admin`

/**
 * The wish book is kept for the life of a session, so a second run of this
 * script walks into whatever the first one left behind. Everything below is
 * scoped to this run's tag.
 */
const TAG = `run-${Date.now().toString(36).slice(-5)}`

async function openPage(browser: Browser, url: string): Promise<Page> {
  // A context each, so the listener cannot inherit the admin's cookie, since the
  // whole point of one of the checks below is that they are different people.
  const page = await (await browser.newContext()).newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return page
}

async function askFor(page: Page, text: string): Promise<void> {
  await page.getByTestId('wish-input').fill(text)
  await page.getByTestId('wish-input').press('Enter')
}

/** What this listener has been told about their own wishes. */
const ownWishes = (page: Page): Promise<string[]> =>
  page.locator('.wishes__text').allTextContents()

/** The book as the station holds it, read the way the panel reads it. */
async function serverBook(): Promise<{ id: number; nickname: string; text: string; status: string }[]> {
  const res = await fetch(`${API_URL}/api/wishes`, {
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}` },
  })
  return (await res.json()).wishes
}

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
})

try {
  // At `#wishes`, which is where the composer is. The landing view is the
  // record and the words to it and nothing else; asking for something is a
  // destination on the rail, with the whole screen and what you have already
  // asked for listed under it. The join form still renders whatever the
  // address says, so tuning in below works from here.
  const sam = await openPage(browser, `${STATION_URL}#wishes`)
  const ana = await openPage(browser, `${STATION_URL}#wishes`)
  await tuneIn(sam, 'sam')
  await tuneIn(ana, 'ana')
  await wait(1_000)

  // --- asking ----------------------------------------------------------------
  await askFor(sam, `${TAG} anything off Rumours`)
  await wait(1_000)

  const mine = await ownWishes(sam)
  checks.run(
    'a wish comes back to the listener who made it',
    mine.some((line) => line.includes(TAG)),
    mine.length === 0 ? 'nothing on screen' : `"${mine.at(-1)}"`,
  )

  const theirs = await ownWishes(ana)
  checks.run(
    'and to nobody else in the room',
    !theirs.some((line) => line.includes(TAG)),
    `${theirs.length} wish(es) on the other listener's screen`,
  )

  // The control: the room is not simply silent. What sam says reaches ana, so
  // the wish not reaching her is about wishes rather than about the socket.
  await sam.getByTestId('chat-input').fill(`${TAG} can you hear me`)
  await sam.getByTestId('chat-input').press('Enter')
  await wait(1_000)
  const heard = await ana.locator('.chat__text').allTextContents()
  checks.run(
    'while a message sent the same second reaches the same listener',
    heard.some((line) => line.includes(TAG)),
    `${heard.length} line(s) in the other listener's chat`,
  )

  // --- what the station wrote down -------------------------------------------
  const book = (await serverBook()).filter((wish) => wish.text.includes(TAG))
  checks.run(
    'the station wrote it down under the roster name, not one the page chose',
    book.length === 1 && book[0]!.nickname === 'sam',
    book.length === 0 ? 'not in the book' : `signed "${book[0]!.nickname}"`,
  )
  checks.run(
    'and it starts as something nobody has dealt with yet',
    book[0]?.status === 'new',
    `status "${book[0]?.status}"`,
  )

  // --- the admin reads it and marks it off ------------------------------------
  // No tuning in: the console is the whole page at #admin, and whoever is
  // running the decks is not in the room: the wish book reaches them over
  // HTTP, not over a listener's socket.
  const admin = await openPage(browser, ADMIN_URL)
  await admin.fill('[data-testid="admin-password"]', ADMIN_PASSWORD)
  await admin.getByRole('button', { name: 'Sign in' }).click()
  await wait(1_500)

  const row = admin.locator(`[data-testid="admin-wishes"] [data-wish="${book[0]?.id}"]`)
  checks.run(
    'the admin sees the wish, and who asked for it',
    (await row.count()) === 1 && (await row.textContent())!.includes('sam'),
    (await row.count()) === 0 ? 'no row for it' : `"${(await row.textContent())?.trim()}"`,
  )

  await row.getByRole('button', { name: 'Mark handled' }).click()
  await wait(1_000)
  checks.run(
    'marking it handled sticks, in the panel and in the station',
    (await row.getAttribute('data-status')) === 'handled' &&
      (await serverBook()).find((wish) => wish.id === book[0]?.id)?.status === 'handled',
    `panel says "${await row.getAttribute('data-status')}"`,
  )

  // Reversible, because the mark is a note to whoever is reading the list and
  // a misclick should not be the end of somebody's request.
  await row.getByRole('button', { name: 'Undo' }).click()
  await wait(1_000)
  checks.run(
    'and can be put back',
    (await row.getAttribute('data-status')) === 'new',
    `panel says "${await row.getAttribute('data-status')}"`,
  )

  // A listener is never told what became of their wish, so their own list is
  // still what they asked for and nothing more. Better a station that says
  // nothing than one that says "played" about a track that never went on.
  const after = await ownWishes(sam)
  checks.run(
    'the listener’s own list is unchanged by what the admin did',
    after.filter((line) => line.includes(TAG)).length === 1,
    `${after.length} wish(es) still listed`,
  )
} finally {
  await browser.close()
}

checks.finish('WISHES QA')
