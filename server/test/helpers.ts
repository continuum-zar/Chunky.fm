import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { ChatLog } from '../src/chat.js'
import type { Config } from '../src/config.js'
import type { OnAir } from '../src/air.js'
import type { Schedule } from '../src/schedule.js'
import type { Mic } from '../src/mic.js'
import type { Mutes } from '../src/mutes.js'
import type { Padding } from '../src/padding.js'
import { type Db, openDb } from '../src/db.js'
import type { Track } from '../src/lib/track.js'
import { PlaybackState } from '../src/playback.js'
import type { Station } from '../src/station.js'
import type { PlayLog } from '../src/history.js'
import type { LyricsService } from '../src/lyrics.js'
import type { WishBook } from '../src/wishes.js'

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const ADMIN_PASSWORD = 'hunter2-for-tests'

export interface Harness {
  app: FastifyInstance
  db: Db
  config: Config
  playback: PlaybackState
  station: Station
  chat: ChatLog
  wishes: WishBook
  plays: PlayLog
  air: OnAir
  schedule: Schedule
  mutes: Mutes
  mic: Mic
  padding: Padding
  lyrics: LyricsService
  /** Only set when the harness was started with `listen: true`. */
  wsUrl: string
  cleanup(): Promise<void>
}

export interface HarnessOptions {
  playback?: PlaybackState
  heartbeatIntervalMs?: number
  backstopIntervalMs?: number
  chatHistoryLimit?: number
  playHistoryLimit?: number
  /**
   * Whether to come up on air. Defaults true, which is the opposite of
   * production: almost every test here is about chat, wishes, votes or history,
   * all of which need a session to write to, and making each of them open one
   * first would be ceremony that tests nothing. The tests that *are* about
   * going on and off air pass `live: false` and drive it by hand.
   */
  live?: boolean
  chatBurst?: number
  chatRefillMs?: number
  joinBurst?: number
  joinRefillMs?: number
  wishBurst?: number
  wishRefillMs?: number
  /** Signalling frames a listener may send back to back. The decks are exempt. */
  signalBurst?: number
  signalRefillMs?: number
  signInBurst?: number
  signInRefillMs?: number
  /** How long an open mic lasts without a renew. See `Mic`. */
  micLeaseMs?: number
  /**
   * How often a lapsed mic is swept up. The tests that are about expiry call
   * `mic.sweep()` by hand against a clock they drive, so this is only here for
   * anything that wants the real interval out of the way.
   */
  micSweepIntervalMs?: number
  /**
   * Stands in for LRCLIB. Defaults to an archive that knows nothing, so no
   * test reaches the real internet by accident; the lyrics tests hand in one
   * that answers.
   */
  lyricsFetch?: typeof fetch
  /** Bind a real port: required for anything that opens a websocket. */
  listen?: boolean
}

export async function startHarness(
  overrides: Partial<Config> = {},
  {
    playback = new PlaybackState(),
    heartbeatIntervalMs,
    backstopIntervalMs,
    chatHistoryLimit,
    playHistoryLimit,
    live = true,
    chatBurst,
    chatRefillMs,
    joinBurst,
    joinRefillMs,
    wishBurst,
    wishRefillMs,
    signalBurst,
    signalRefillMs,
    signInBurst,
    signInRefillMs,
    micLeaseMs,
    micSweepIntervalMs,
    lyricsFetch = async () => new Response(null, { status: 404 }),
    listen = false,
  }: HarnessOptions = {},
): Promise<Harness> {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunky-test-'))
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    storageDir,
    audioDir: path.join(storageDir, 'audio'),
    artworkDir: path.join(storageDir, 'artwork'),
    posterDir: path.join(storageDir, 'posters'),
    tmpDir: path.join(storageDir, 'tmp'),
    dbPath: ':memory:',
    adminPassword: ADMIN_PASSWORD,
    // Open by default, which is what an unset STATION_KEY means and what most
    // tests want. The ones about the gate pass a key through `overrides`.
    stationKey: null,
    maxUploadBytes: 10 * 1024 * 1024,
    // Never resolved: the harness stubs the fetch itself. See `lyricsFetch`.
    lrclibBaseUrl: 'http://lrclib.invalid',
    // Never read: the harness passes `logger: false`. Present so the shape is
    // the shape production has.
    logLevel: 'silent',
    // No STUN and no relay, so nothing here reaches the internet to find out
    // how two browsers would meet. The tests that are about `/api/rtc` pass
    // their own through `overrides`.
    stunUrls: [],
    turn: null,
    // No client bundle: these tests are about the API. The doorway tests build
    // a bundle in a temp dir and pass it through `overrides`.
    clientDir: null,
    // As deployed: something is always in front of this, and anything keyed on
    // the caller's address is only correct if it reads through it.
    trustProxy: true,
    ...overrides,
  }

  const db = openDb(config.dbPath)
  const app = await buildApp({
    config,
    db,
    logger: false,
    playback,
    heartbeatIntervalMs,
    backstopIntervalMs,
    chatHistoryLimit,
    playHistoryLimit,
    live,
    chatBurst,
    chatRefillMs,
    joinBurst,
    joinRefillMs,
    wishBurst,
    wishRefillMs,
    signalBurst,
    signalRefillMs,
    signInBurst,
    signInRefillMs,
    micLeaseMs,
    micSweepIntervalMs,
    lyricsFetch,
  })

  let wsUrl = ''
  if (listen) {
    await app.listen({ host: config.host, port: 0 })
    const { port } = app.server.address() as AddressInfo
    wsUrl = `ws://${config.host}:${port}/ws`
  }

  return {
    app,
    db,
    config,
    playback,
    station: app.station,
    chat: app.chat,
    wishes: app.wishes,
    plays: app.plays,
    air: app.air,
    schedule: app.schedule,
    mutes: app.mutes,
    mic: app.mic,
    padding: app.padding,
    lyrics: app.lyrics,
    wsUrl,
    async cleanup() {
      await app.close()
      db.close()
      await fs.rm(storageDir, { recursive: true, force: true })
    },
  }
}

/**
 * Sign in the way the browser does, and hand back the `Cookie` header it would
 * send from then on: `chunky_admin=<token>`, without the attributes, which is
 * all a request carries back.
 */
export async function signIn(harness: Harness, password = ADMIN_PASSWORD): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/admin/session',
    payload: { password },
  })
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`)
  return String(res.headers['set-cookie']).split(';')[0]!
}

/** The signed token out of a `Set-Cookie`, for asserting on it directly. */
export function tokenFrom(res: { headers: Record<string, unknown> }): string {
  return String(res.headers['set-cookie']).split(';')[0]!.split('=').slice(1).join('=')
}

let nextTrackId = 1

export function makeTrack(overrides: Partial<Track> = {}): Track {
  const id = overrides.id ?? nextTrackId++
  return {
    id,
    title: `Track ${id}`,
    artist: 'Test Artist',
    album: 'Test Album',
    durationMs: 240_000,
    filename: `${'a'.repeat(64)}.mp3`,
    artworkPath: null,
    contentHash: 'a'.repeat(64),
    gainDb: 0,
    uploadedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** A clock the test drives by hand, so nothing depends on wall time. */
export function fakeClock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
    set(value: number) {
      current = value
    },
  }
}

export type FakeClock = ReturnType<typeof fakeClock>

/**
 * Move the station clock and the timer wheel together.
 *
 * The two are independent (PlaybackState reads an injected clock, timers live
 * on vitest's fake wheel), so stepping only one produces states that cannot
 * happen in production. Stepping in slices keeps them close enough that a timer
 * firing mid-window still sees a sane clock; anything that ends exactly on a
 * slice boundary lands on the exact millisecond.
 */
export async function advanceAll(clock: FakeClock, ms: number, stepMs = 1_000): Promise<void> {
  for (let left = ms; left > 0; ) {
    const slice = Math.min(stepMs, left)
    clock.advance(slice)
    await vi.advanceTimersByTimeAsync(slice)
    left -= slice
  }
}

export interface MultipartPart {
  name: string
  filename?: string
  contentType?: string
  data: Buffer | string
}

export const BOUNDARY = '----chunkyfmtestboundary'

export function multipartBody(parts: MultipartPart[], boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`
    if (part.filename !== undefined) head += `; filename="${part.filename}"`
    head += '\r\n'
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`
    head += '\r\n'
    chunks.push(Buffer.from(head), Buffer.from(part.data), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

export function multipartHeaders(boundary = BOUNDARY): Record<string, string> {
  return { 'content-type': `multipart/form-data; boundary=${boundary}` }
}

export function fixture(name: string): Promise<Buffer> {
  return fs.readFile(path.join(FIXTURES, name))
}

export async function listDir(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort()
}
