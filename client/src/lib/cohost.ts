/**
 * The co-host's side of the HTTP API.
 *
 * A third rung between a listener and the decks, and the shape of this file is
 * the shape of that: it is `AdminApi` with most of it missing. There is no
 * upload here, no `stop`, no way to end the night or mute anybody or pad the
 * room — not because the page chooses not to draw those buttons, but because
 * the station refuses them to this credential. A UI that merely hid them would
 * be a seat that was one devtools console away from being the decks.
 *
 * What is here is the job: talk, decide what plays next, move the current
 * record along, and choose how one becomes the other.
 *
 * The key is handed over once, at `redeem`, and exchanged for a signed HttpOnly
 * cookie. Nothing here holds a secret afterwards — this code cannot read the
 * cookie even to send it. The browser attaches it, and every method below is
 * just a same-origin request.
 */

import { AdminError } from './admin.js'
import type {
  CoHostSnapshot,
  MicSnapshot,
  PlaybackSnapshot,
  QueueEntry,
  Track,
  TransitionSnapshot,
} from './protocol.js'
import { CO_HOST_PATH } from './routes.js'

export { AdminError, refusalMessage } from './admin.js'

/**
 * The longest a crossfade may be. Mirrors `MAX_BLEND_MS` in
 * `server/src/transition.ts`; keep the two in step. Held here so the slider
 * stops where the station would clamp rather than sending a request that comes
 * back describing a number nobody asked for.
 */
export const MAX_BLEND_MS = 12_000

/**
 * How often a held seat is renewed, against the station's thirty-second lease.
 *
 * Comfortably inside it, for the reason `MIC_RENEW_MS` is inside the mic's:
 * several renewals can be lost to a phone's flaky signal and the seat still
 * does not go out from under somebody mid-sentence. Slower than the mic's beat
 * because the lease is three times as long and this is running on a battery.
 */
export const SEAT_RENEW_MS = 10_000

/**
 * How long the mic stays open after the talk button comes up.
 *
 * Longer than the console's four hundred milliseconds, and the difference is
 * the device. A thumb on a screen releases less precisely than a finger on a
 * key — it slides, it lifts early on a bump — and the failure it causes is the
 * last word of a sentence being cut off, which is the one artefact a listener
 * cannot explain to themselves.
 */
export const SEAT_HANGOVER_MS = 600

/** The verbs the seat has at the decks. See the server's `playback.ts`. */
export type SeatAction = 'pause' | 'resume' | 'skip' | 'blend'

export interface CoHostApiOptions {
  /** Injected in tests; the browser supplies the real one. */
  fetch?: typeof globalThis.fetch
  /** Same origin by default: Vite proxies /api through to the server. */
  baseUrl?: string
}

interface ErrorBody {
  error?: unknown
  message?: unknown
}

export class CoHostApi {
  readonly #fetch: typeof globalThis.fetch
  readonly #baseUrl: string

  constructor({ fetch = globalThis.fetch, baseUrl = '' }: CoHostApiOptions = {}) {
    // Bound: fetch called as a method of anything but window throws in browsers,
    // the same way calling a stored setTimeout does. See lib/station.ts.
    this.#fetch = fetch.bind(globalThis)
    this.#baseUrl = baseUrl
  }

  /**
   * Exchange the key for a seat. `false` means the station said no, which is
   * the door's cue to stay up; a throw means it said nothing.
   */
  async redeem(key: string): Promise<boolean> {
    const response = await this.#request('POST', '/api/cohost/session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    if (response.status === 401) return false
    if (response.status === 429) throw await this.#toError(response)
    if (!response.ok) throw await this.#toError(response)
    return true
  }

  /** Does this browser still hold a seat? What the page asks before connecting. */
  async verify(): Promise<boolean> {
    const response = await this.#request('GET', '/api/cohost/session')
    if (response.status === 401) return false
    if (!response.ok) throw await this.#toError(response)
    return true
  }

  /**
   * Hand the key back. Failure is ignored on purpose, the way `signOut` ignores
   * its own: the co-host asked to be signed out and the page obliges either way.
   */
  async forget(): Promise<void> {
    try {
      await this.#request('DELETE', '/api/cohost/session')
    } catch {
      // Unreachable station. The cookie lapses on its own soon enough.
    }
  }

  /** Who is co-hosting. Open, like `/api/session` and `/api/floor`. */
  seat(): Promise<CoHostSnapshot> {
    return this.#json<CoHostSnapshot>('GET', '/api/cohost')
  }

  /**
   * Sit down, keep the seat, or stand up.
   *
   * `socket` is this page's own id, off the `you` frame, and it is not
   * redundant with the cookie: the cookie says *this browser may co-host* and
   * the socket says *which connection it is on*, which is what the console has
   * to be told in order to offer a microphone to anything. The station refuses
   * an id that never presented a co-host key, so nobody can put somebody else
   * in the seat by naming their connection.
   *
   * `renew` is its own verb rather than a repeated `take`, for the reason the
   * mic's is: a keep-alive still in flight when somebody stood up would put
   * them back in a seat they had just left.
   */
  takeSeat(socket: number, nickname: string): Promise<CoHostSnapshot> {
    return this.#json<CoHostSnapshot>('POST', '/api/cohost/seat', {
      action: 'take',
      socket,
      nickname,
    })
  }

  renewSeat(socket: number): Promise<CoHostSnapshot> {
    return this.#json<CoHostSnapshot>('POST', '/api/cohost/seat', { action: 'renew', socket })
  }

  leaveSeat(socket: number): Promise<CoHostSnapshot> {
    return this.#json<CoHostSnapshot>('POST', '/api/cohost/seat', { action: 'leave', socket })
  }

  /**
   * Open the mic, keep it open, or shut it.
   *
   * The same three verbs the console has, and the station tells the two apart:
   * the mic is open while *anybody* is holding it, so `close` here means "I
   * have stopped talking" rather than "shut the mic", and the room stays ducked
   * if whoever runs the decks is still mid-sentence. See `MicHolder`.
   *
   * Every one of them answers with the snapshot it produced, which the page
   * folds straight in: a talk button that waited for the broadcast would duck
   * the music after you had already started.
   */
  mic(action: 'open' | 'renew' | 'close'): Promise<MicSnapshot> {
    return this.#json<MicSnapshot>('POST', '/api/mic', { action })
  }

  /** The library. Open, and the co-host needs it to queue anything. */
  async tracks(): Promise<Track[]> {
    return (await this.#json<{ tracks: Track[] }>('GET', '/api/tracks')).tracks
  }

  async queue(): Promise<QueueEntry[]> {
    return (await this.#json<{ entries: QueueEntry[] }>('GET', '/api/queue')).entries
  }

  enqueue(trackId: number): Promise<{ entries: QueueEntry[] }> {
    return this.#json('POST', '/api/queue', { trackId })
  }

  /** Reorder. Positions are clamped server-side, so an edge is not an error. */
  move(entryId: number, toIndex: number): Promise<{ entries: QueueEntry[] }> {
    return this.#json('POST', '/api/queue/move', { entryId, toIndex })
  }

  remove(entryId: number): Promise<{ entries: QueueEntry[] }> {
    return this.#json('DELETE', `/api/queue/${entryId}`)
  }

  /**
   * Move the current record along. Four verbs, and no fifth.
   *
   * Everything here acts on the record already playing — the one the co-host
   * can see, has been talking over, and is watching run out. Putting a
   * different one on, seeking inside one, or clearing the decks are the decks'
   * own, and the station refuses them to this credential rather than this page
   * declining to ask.
   */
  command(action: SeatAction): Promise<PlaybackSnapshot> {
    return this.#json<PlaybackSnapshot>('POST', '/api/playback', { action })
  }

  /** How long one record overlaps the next. Zero is a hard cut. */
  transition(blendMs: number): Promise<TransitionSnapshot> {
    return this.#json<TransitionSnapshot>('POST', '/api/transition', {
      // Rounded here rather than left to the schema: a slider that reports
      // 3000.0000000004 gets a 400 for being a number the station calls not an
      // integer, which is a refusal nobody could act on.
      blendMs: Math.round(blendMs),
    })
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#request(
      method,
      path,
      body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
    if (!response.ok) throw await this.#toError(response)
    return (await response.json()) as T
  }

  /**
   * Every request goes through here, so every request carries the cookie.
   * `same-origin` is fetch's default, but it is the whole authentication story,
   * and spelling it out keeps it from being dropped by accident.
   */
  #request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}${path}`, { method, credentials: 'same-origin', ...init })
  }

  /** The server answers errors as `{error, message}`; anything else is a shrug. */
  async #toError(response: Response): Promise<AdminError> {
    let body: ErrorBody = {}
    try {
      body = (await response.json()) as ErrorBody
    } catch {
      // An HTML error page from something in front of the server, most likely.
    }
    const code = typeof body.error === 'string' ? body.error : 'request_failed'
    const message =
      typeof body.message === 'string' ? body.message : `request failed (${response.status})`
    return new AdminError(
      response.status,
      code,
      response.status === 401 ? 'that seat has lapsed; open the link again' : message,
    )
  }
}

/**
 * The link to send a co-host.
 *
 * Built in the browser rather than by the station, for the reason `inviteLink`
 * is: the station does not reliably know what address it is being reached on
 * (behind nginx, behind Railway, on a LAN IP) and the console's own address bar
 * does.
 */
export function coHostLink(origin: string, key: string): string {
  return `${origin.replace(/\/+$/, '')}${CO_HOST_PATH}?k=${encodeURIComponent(key)}`
}
