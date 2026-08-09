/** Shared config and helpers for the browser QA scripts. */

import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright-core'

export const CLIENT_URL = process.env.CLIENT_URL ?? 'http://localhost:5173'
/**
 * The station itself, which is not the origin: `/` is the page in front of it.
 * Every script here drives the app, so this is what they all open. See
 * STATION_PATH in src/lib/routes.ts, which this has to agree with.
 */
export const STATION_URL = `${CLIENT_URL.replace(/\/+$/, '')}/listen`
export const API_URL = process.env.API_URL ?? 'http://localhost:3000'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'change-me'
export const CHROME_PATH = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
/** Which track these scripts put on the decks. Needs to be a few minutes long. */
export const TRACK_ID = Number(process.env.TRACK_ID ?? 1)
export const OTHER_TRACK_ID = Number(process.env.OTHER_TRACK_ID ?? 2)

/**
 * Evaluate bodies are strings on purpose: the TypeScript runner rewrites inline
 * functions with helpers (`__name`) that do not exist inside the page.
 */
export const PLAYING = `(() => {
  const a = document.querySelector('audio')
  return !!a && !a.paused && a.currentTime > 0
})()`

export const AUDIO = `(() => {
  const a = document.querySelector('audio')
  return {
    currentTime: a ? a.currentTime : -1,
    paused: a ? a.paused : true,
    rate: a ? a.playbackRate : -1,
    src: a ? a.getAttribute('src') : null,
  }
})()`

export const STATUS = `(document.querySelector('.status') || {}).textContent || ''`

/** Records every seek, so an otherwise invisible audio glitch becomes countable. */
export const INSTRUMENT_SEEKS = `(() => {
  const a = document.querySelector('audio')
  window.__seeks = []
  a.addEventListener('seeking', function () {
    window.__seeks.push({ at: Date.now(), to: a.currentTime })
  })
  return true
})()`

export const SEEKS = `window.__seeks || []`
export const RESET_SEEKS = `(window.__seeks = [], true)`

export interface AudioState {
  currentTime: number
  paused: boolean
  rate: number
  src: string | null
}

/**
 * Joins the station: name yourself, then tune in.
 *
 * The button is disabled until the field has something in it, so every script
 * that used to click straight through now has to type first. Each page gets its
 * own nickname so a run with several listeners is readable at a glance.
 */
export async function tuneIn(page: Page, nickname = 'qa'): Promise<void> {
  await page.getByLabel('What should everyone call you?').fill(nickname)
  await page.getByRole('button', { name: 'Tune in' }).click()
}

/**
 * Give one of the rail's destinations the whole screen.
 *
 * The landing view is the deck and the words now; the queue, the evening and
 * the room each live behind their mark on the rail, which is where a script
 * that wants to read them has to go, the same trip a person makes.
 */
export async function visit(page: Page, hash: string): Promise<void> {
  await page.evaluate((destination) => {
    window.location.hash = destination
  }, hash)
  await wait(400)
}

export function playbackCommand(body: unknown): Promise<unknown> {
  return fetch(`${API_URL}/api/playback`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json())
}

/**
 * Opens the doors.
 *
 * A station comes up off air — a deploy that went live on its own would put
 * every restart on air with an empty queue — so a script that wants listeners
 * to hear anything has to say so first. Idempotent at the station, so calling
 * it on an already-live one is free.
 */
export function goLive(): Promise<unknown> {
  return fetch(`${API_URL}/api/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  }).then((res) => res.json())
}

/** Drives the mic the way the console does: over HTTP, behind the password. */
export function micCommand(body: unknown): Promise<{ live: boolean; duckTo: number }> {
  return fetch(`${API_URL}/api/mic`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json() as Promise<{ live: boolean; duckTo: number }>)
}

/**
 * Records every gain ramp the page asks for, before any of its script runs.
 *
 * The duck happens inside a Web Audio graph, which is not readable from
 * outside: there is no property on the element to poll and no attribute that
 * changes. Patching the one method the stage uses turns it into a list, and
 * does it without the app carrying a seam that exists only for a test.
 *
 * Every ramp in the station is the duck, so nothing else lands in here.
 */
export const INSTRUMENT_DUCKS = `(() => {
  window.__ducks = []
  const original = AudioParam.prototype.setTargetAtTime
  AudioParam.prototype.setTargetAtTime = function (target, when, constant) {
    window.__ducks.push({ target: target, at: Date.now() })
    return original.call(this, target, when, constant)
  }
  return true
})()`

export const DUCKS = `window.__ducks || []`

export interface Duck {
  target: number
  at: number
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* --- taking the station down and putting it back up ------------------------
 *
 * The only way to drop a listener's socket for real. A browser told it is
 * offline (`context.setOffline(true)`) keeps an established WebSocket open
 * and keeps answering pings on it, so nothing observes a disconnection at all.
 * Killing the server does, which is why both the reconnect and presence scripts
 * own the server process rather than assuming one is already running.
 *
 * The server has to be built first: `cd server && npm run build`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_DIR = process.env.SERVER_DIR ?? path.resolve(HERE, '../../server')
export const STORAGE_DIR = process.env.AUDIO_STORAGE_DIR ?? path.resolve(SERVER_DIR, 'audio_storage')
export const SERVER_PORT = new URL(API_URL).port || '3000'

export const startServer = (): ChildProcess =>
  spawn('node', ['dist/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ADMIN_PASSWORD, AUDIO_STORAGE_DIR: STORAGE_DIR, PORT: SERVER_PORT },
    stdio: 'ignore',
  })

export const stopServer = (): Promise<void> =>
  new Promise((resolve) => {
    spawn('pkill', ['-f', 'dist/index\\.js']).on('exit', () => resolve())
  })

/** Polls /health until the station is up (or, with `false`, until it is gone). */
export async function health(expectUp: boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`${API_URL}/health`)
      if (expectUp) return true
    } catch {
      if (!expectUp) return true
    }
    await wait(200)
  }
  return false
}

export class Checks {
  #failures = 0

  run(label: string, ok: boolean, detail: string): void {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`)
    if (!ok) this.#failures++
  }

  get failures(): number {
    return this.#failures
  }

  finish(name: string): never {
    console.log(this.#failures === 0 ? `\n${name} PASSED` : `\n${this.#failures} ${name} CHECK(S) FAILED`)
    process.exit(this.#failures === 0 ? 0 : 1)
  }
}
