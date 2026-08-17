/**
 * The sound check, in a real browser with a real getUserMedia.
 *
 * Chrome's fake capture device is what makes this runnable without a
 * microphone or a person: `--use-fake-device-for-media-stream` generates a
 * tone, and `--use-fake-ui-for-media-stream` answers the permission prompt.
 * Between them, everything this milestone is about becomes observable —
 * whether the browser gives up a device, whether it is the right one, and
 * whether the level ever moves.
 *
 * Which is the point of doing it before any of the peer connections: "the
 * browser will not give me the microphone" and "the connection will not
 * establish" are different problems, and this is the one that can be answered
 * on one machine.
 *
 * Needs a running Vite dev server and a running station. See README.
 */
import { type Page, chromium } from 'playwright-core'
import { ADMIN_PASSWORD, CHROME_PATH, STATION_URL, Checks, goLive, wait } from './qa-env.js'

const checks = new Checks()
const ADMIN_URL = `${STATION_URL}#admin`

/** How wide the meter's fill is drawn, as the 0…1 it is scaled to. */
const METER = `(() => {
  const bar = document.querySelector('[data-testid="mic-meter"] > div')
  if (!bar) return null
  const match = /scaleX\\(([0-9.]+)\\)/.exec(bar.style.transform || '')
  return match ? Number(match[1]) : 0
})()`

const has = (page: Page, testId: string) =>
  page.locator(`[data-testid="${testId}"]`).count().then((n) => n > 0)

/** The highest the meter got over a window, which is what a tone should move. */
async function peak(page: Page, overMs: number): Promise<number> {
  const deadline = Date.now() + overMs
  let highest = 0
  while (Date.now() < deadline) {
    const now = await page.evaluate<number | null>(METER)
    if (now !== null && now > highest) highest = now
    await wait(50)
  }
  return highest
}

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    // A microphone that is always there and always making a noise, and a
    // permission prompt that answers itself.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
})

try {
  // The reach list only means anything during a broadcast, and a station is
  // off air by default.
  await goLive()

  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' })
  await page.fill('[data-testid="admin-password"]', ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('[data-testid="mic-power"]', { timeout: 10_000 })

  // The console does not take the microphone on open, and that is deliberate:
  // grabbing it would put the browser's recording light on for the whole
  // evening, including the parts spent queueing records.
  checks.run('the mic is off until asked for', !(await has(page, 'mic-meter')), 'no meter drawn')

  console.log('\nturning the mic on…')
  await page.click('[data-testid="mic-power"]')
  await page.waitForSelector('[data-testid="mic-meter"]', { timeout: 10_000 })
  checks.run('the browser gave up a device', await has(page, 'mic-meter'), 'meter drawn')
  checks.run('nothing was refused', !(await has(page, 'mic-error')), 'no error shown')

  // The fake device plays a tone, so a meter that is wired up moves and one
  // that is not sits at zero. This is the whole milestone in one number.
  const moving = await peak(page, 3_000)
  checks.run('the meter follows the input', moving > 0.05, `peaked at ${moving.toFixed(3)}`)

  // Labels are empty until permission has been granted once, so the picker
  // being readable at all is itself the check: it means the list was rebuilt
  // after the device opened rather than only on load.
  const options = await page.$$eval('[data-testid="mic-device"] option', (nodes) =>
    nodes.map((node) => node.textContent ?? ''),
  )
  checks.run('the picker offers the system default', options[0] === 'System default', `[${options.join(', ')}]`)
  checks.run('and names the devices it found', options.length > 1, `${options.length - 1} device(s)`)

  // Monitoring is a feedback loop when it goes into the speaker the microphone
  // is listening to, so the console refuses it rather than warning about it.
  checks.run(
    'hearing yourself is offered on headphones',
    await page.isEnabled('[data-testid="mic-monitor"]'),
    'monitor enabled',
  )
  await page.check('[data-testid="mic-monitor"]')
  await page.check('[data-testid="mic-speakers"]')
  await wait(500)
  checks.run(
    'and refused on speakers',
    !(await page.isEnabled('[data-testid="mic-monitor"]')),
    'monitor disabled',
  )
  checks.run(
    'and switched off rather than left set',
    !(await page.isChecked('[data-testid="mic-monitor"]')),
    'monitor unchecked',
  )

  // Saying you are on speakers re-asks for the stream with echo cancellation
  // on, which is a different device open. The meter has to come back.
  await page.waitForSelector('[data-testid="mic-meter"]', { timeout: 10_000 })
  const afterSwitch = await peak(page, 3_000)
  checks.run(
    'the meter survives a constraints change',
    afterSwitch > 0.05,
    `peaked at ${afterSwitch.toFixed(3)}`,
  )

  // With nobody tuned in there is nothing to reach, and the console says so
  // rather than showing an empty list that reads like a fault.
  checks.run(
    'says when there is nobody to reach',
    (await page.textContent('[data-testid="mic-reach"]'))?.includes('Nobody is tuned in') === true,
    'reach line',
  )

  console.log('\nturning the mic off…')
  await page.click('[data-testid="mic-power"]')
  await wait(500)
  checks.run('the meter goes with it', !(await has(page, 'mic-meter')), 'no meter drawn')

  // And it can be turned back on, which is the path a refusal leaves you on:
  // without the attempt counter in useMicInput, pressing this again is a no-op.
  await page.click('[data-testid="mic-power"]')
  await page.waitForSelector('[data-testid="mic-meter"]', { timeout: 10_000 })
  checks.run('and can be opened again', await has(page, 'mic-meter'), 'meter back')
} finally {
  await browser.close()
}

checks.finish('SOUND CHECK QA')
