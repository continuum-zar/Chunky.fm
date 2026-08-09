import type {
  AirSnapshot,
  MicSnapshot,
  PlaybackSnapshot,
  QueueEntry,
  ScheduledSession,
  Track,
  Wish,
  WishStatus,
} from './protocol.js'

/** Where the admin controls live. */
export const ADMIN_HASH = '#admin'

/**
 * The most the headcount can be padded by. Mirrors `server/src/padding.ts`;
 * keep the two in step. Held here so the panel's plus button stops where the
 * station would refuse it rather than sending a request that comes back 400.
 */
export const MAX_PADDING = 9_999

/**
 * The quietest the music may be ducked to. Mirrors `MIN_DUCK` in
 * `server/src/mic.ts`; keep the two in step. Held here so the fader stops where
 * the station would refuse it rather than sending a request that comes back 400.
 */
export const MIN_DUCK = 0.05

/**
 * How often an open mic is renewed, against the station's ten-second lease.
 *
 * Comfortably inside it: two renewals can be lost to a bad connection and the
 * mic still does not cut out mid-sentence, which is the only failure this pace
 * is trying to buy off.
 */
export const MIC_RENEW_MS = 3_000

/**
 * How long the mic stays open after the talk key comes up.
 *
 * Without it the music swells back between words, which sounds like the station
 * fighting you. Long enough to bridge a breath, short enough that the bed is
 * back before the next line of the song matters.
 */
export const MIC_HANGOVER_MS = 400

export function isAdminRoute(location: { pathname: string; hash: string }): boolean {
  return location.hash === ADMIN_HASH || location.pathname === '/admin'
}

export type PlaybackAction = 'play' | 'pause' | 'resume' | 'seek' | 'stop' | 'skip'

export interface PlaybackCommand {
  action: PlaybackAction
  trackId?: number
  positionMs?: number
}

export interface UploadResult {
  track: Track
  /** The file was already in the library: the same track, not a second copy. */
  duplicate: boolean
}

/**
 * The wish book as the station describes it: this session's wishes, oldest
 * first, and how many are still waiting on somebody. The count comes from the
 * server rather than being derived here, so the heading and the list can never
 * disagree about what is outstanding.
 */
export interface WishBook {
  wishes: Wish[]
  outstanding: number
}

/** A request the server refused. `status` is what decides how the UI reacts. */
export class AdminError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AdminError'
    this.status = status
    this.code = code
  }

  /** The session is over: sign in again, don't retry. */
  get unauthorized(): boolean {
    return this.status === 401
  }
}

/**
 * What the station said, when it is something worth repeating to the admin.
 *
 * Every 4xx message in this API is written for whoever is holding it wrong and
 * says nothing private; that is the contract `lib/errors.ts` keeps, and why
 * 5xx messages are replaced rather than repeated. So a refusal the station
 * wrote is shown as written, and anything else (a 500, a network failure, a
 * response that was not this API at all) is null for the caller to summarise.
 *
 * Without this, a throttled sign-in reads as "could not reach the station",
 * which sends the admin looking for a network problem that is not there.
 */
export function refusalMessage(err: unknown): string | null {
  if (!(err instanceof AdminError)) return null
  if (err.status < 400 || err.status >= 500) return null
  return err.message
}

export interface AdminApiOptions {
  /** Injected in tests; the browser supplies the real one. */
  fetch?: typeof globalThis.fetch
  /** Same origin by default: Vite proxies /api through to the server. */
  baseUrl?: string
}

interface ErrorBody {
  error?: unknown
  message?: unknown
}

/**
 * The admin's side of the HTTP API.
 *
 * The password is handed over once, at `signIn`, and exchanged for the signed
 * session cookie described in PLAN.md. Nothing here holds a secret afterwards:
 * the cookie is HttpOnly, so this code cannot read it even to send it. The
 * browser attaches it, and every method below is just a same-origin request.
 */
export class AdminApi {
  readonly #fetch: typeof globalThis.fetch
  readonly #baseUrl: string

  constructor({ fetch = globalThis.fetch, baseUrl = '' }: AdminApiOptions = {}) {
    // Bound: fetch called as a method of anything but window throws in browsers,
    // the same way calling a stored setTimeout does. See lib/station.ts.
    this.#fetch = fetch.bind(globalThis)
    this.#baseUrl = baseUrl
  }

  /**
   * Exchange the password for a session. `false` means the station said no,
   * which is the sign-in form's cue to stay up; a throw means it said nothing.
   */
  async signIn(password: string): Promise<boolean> {
    const response = await this.#request('POST', '/api/admin/session', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (response.status === 401) return false
    if (!response.ok) throw await this.#toError(response)
    return true
  }

  /** Is the session still good? What the panel asks before showing controls. */
  async verify(): Promise<boolean> {
    const response = await this.#request('GET', '/api/admin/session')
    if (response.status === 401) return false
    if (!response.ok) throw await this.#toError(response)
    return true
  }

  /**
   * End the session at the server, not just in this tab. Failure is ignored on
   * purpose: the admin asked to be signed out, and the UI obliges either way.
   */
  async signOut(): Promise<void> {
    try {
      await this.#request('DELETE', '/api/admin/session')
    } catch {
      // Unreachable station. The cookie lapses on its own soon enough.
    }
  }

  /** The library. Public, but only the admin has anything to do with it. */
  /**
   * The station key, or null on an open station.
   *
   * Admin-only at the station, and that is the invitation policy: a listener's
   * browser cannot rebuild an invite on its own, so the only way to be invited
   * is for whoever holds the password to send one.
   */
  async invite(): Promise<{ key: string | null }> {
    return this.#json<{ key: string | null }>('GET', '/api/invite')
  }

  async tracks(): Promise<Track[]> {
    return (await this.#json<{ tracks: Track[] }>('GET', '/api/tracks')).tracks
  }

  async upload(file: File): Promise<UploadResult> {
    const body = new FormData()
    body.append('file', file, file.name)

    // No content-type by hand: fetch sets it, with the multipart boundary.
    const response = await this.#request('POST', '/api/upload', { body })

    // Not an error worth showing as one: the file is in the library, which is
    // what the admin wanted. Uploading by content hash makes this a no-op.
    if (response.status === 409) {
      const duplicate = (await response.json()) as { track: Track }
      return { track: duplicate.track, duplicate: true }
    }
    if (!response.ok) throw await this.#toError(response)

    const stored = (await response.json()) as { track: Track }
    return { track: stored.track, duplicate: false }
  }

  /**
   * Announce the next session, or move the one already announced.
   *
   * One request carrying both, because a time with no poster and a poster with
   * no time are half-announcements. Leaving `poster` out keeps whatever picture
   * is already up, so changing the hour does not mean finding the image again;
   * see the route, which is where that rule actually lives.
   */
  async announce(startsAt: number, poster?: File | null): Promise<ScheduledSession | null> {
    const body = new FormData()
    body.append('startsAt', String(startsAt))
    if (poster) body.append('poster', poster, poster.name)

    const response = await this.#request('PUT', '/api/schedule', { body })
    if (!response.ok) throw await this.#toError(response)
    return ((await response.json()) as { schedule: ScheduledSession | null }).schedule
  }

  /** Take the announcement down. The poster goes with it. */
  async unannounce(): Promise<null> {
    await this.#json<{ schedule: null }>('DELETE', '/api/schedule')
    return null
  }

  /** Answers with the state the command produced: a snapshot, not a frame. */
  command(command: PlaybackCommand): Promise<PlaybackSnapshot> {
    return this.#json<PlaybackSnapshot>('POST', '/api/playback', command)
  }

  /**
   * Who has been asked to stop talking.
   *
   * Admin-only in both directions, unlike `/api/session`: publishing the list
   * would turn a quiet word into a public naming, and hand the room a roster of
   * who to needle about it.
   */
  async mutes(): Promise<string[]> {
    return (await this.#json<{ nicknames: string[] }>('GET', '/api/mutes')).nicknames
  }

  /**
   * Mute a nickname, or lift it. Answers with the whole list rather than the
   * one row, so the panel responds to the click instead of waiting for a poll.
   *
   * Carries where the nickname now stands rather than "toggle", the same shape
   * a re-join takes: two of these in a row leave one mute, so a retry after
   * a dropped response is safe.
   */
  async mute(nickname: string, muted: boolean): Promise<string[]> {
    return (
      await this.#json<{ nicknames: string[] }>('POST', '/api/mutes', { nickname, muted })
    ).nicknames
  }

  /**
   * Heads added to the headcount on top of the roster.
   *
   * Admin-only in both directions, like the mutes: the room is shown the total,
   * and publishing the split would tell every listener exactly how much of the
   * crowd is nobody. This panel is the only thing that reads it back.
   */
  async padding(): Promise<number> {
    return (await this.#json<{ padding: number }>('GET', '/api/padding')).padding
  }

  /**
   * Set the padding. Answers with the count the station now holds, which is not
   * always the one that was asked for: it is clamped into range there.
   *
   * Carries where the number now stands rather than a step, the same shape a
   * mute takes: two of these in a row leave one count, so a plus button that
   * lost its answer to a dropped connection cannot double the crowd on retry.
   */
  async setPadding(count: number): Promise<number> {
    return (await this.#json<{ padding: number }>('POST', '/api/padding', { padding: count }))
      .padding
  }

  /**
   * Whether the station is on air. Open, unlike everything else on this class:
   * it is the first thing a listener's page needs, and it is not a secret.
   */
  air(): Promise<AirSnapshot> {
    return this.#json<AirSnapshot>('GET', '/api/session')
  }

  /**
   * Go on air, or end the broadcast. Answers with the state it produced.
   *
   * Both are idempotent at the station, so a double-click is not an error and
   * this needs no guard of its own. Ending a session clears the decks and the
   * queue and closes the room. See `OnAir` on the server.
   */
  session(action: 'start' | 'end'): Promise<AirSnapshot> {
    return this.#json<AirSnapshot>('POST', '/api/session', { action })
  }

  /**
   * Whether somebody is talking over the music. Open, like `/api/session`, and
   * for the same reason: it is not a secret, and the socket volunteers it a
   * moment later anyway. Changing it is what needs the password.
   */
  micState(): Promise<MicSnapshot> {
    return this.#json<MicSnapshot>('GET', '/api/mic')
  }

  /**
   * Open the mic, keep it open, or shut it.
   *
   * `renew` is deliberately its own verb rather than a repeated `open`: the
   * console beats on a timer while the key is held, and a keep-alive still in
   * flight when it was released would otherwise put the station back on mic
   * behind whoever just stopped talking.
   *
   * Every one of them answers with the snapshot it produced, which is what the
   * card folds straight in: a talk button that waited for the broadcast would
   * duck the music after you had already started.
   */
  mic(action: 'open' | 'renew' | 'close'): Promise<MicSnapshot> {
    return this.#json<MicSnapshot>('POST', '/api/mic', { action })
  }

  /**
   * How far the music drops while the mic is open, as a linear gain.
   *
   * Where the fader now stands rather than a step, like the padding and a mute,
   * so a drag that lost its answer cannot walk the music down on retry. Clamped
   * at the station, which is why the answer is worth reading back.
   */
  duck(duckTo: number): Promise<MicSnapshot> {
    return this.#json<MicSnapshot>('POST', '/api/mic', { action: 'duck', duckTo })
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

  clearQueue(): Promise<{ entries: QueueEntry[] }> {
    return this.#json('DELETE', '/api/queue')
  }

  /**
   * What the room has asked for. Admin-only, unlike the library and the queue:
   * wishes are never broadcast, so this is the only way to read them, and a
   * listener reading it would be reading everyone else's requests.
   */
  wishes(): Promise<WishBook> {
    return this.#json<WishBook>('GET', '/api/wishes')
  }

  /** Marks a wish handled, or puts one back. Answers with the whole book. */
  markWish(wishId: number, status: WishStatus): Promise<WishBook> {
    return this.#json<WishBook>('POST', `/api/wishes/${wishId}`, { status })
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
   * `same-origin` is fetch's default, but it is the whole authentication story
   * now, and spelling it out keeps it from being dropped by accident.
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
    // A 401 mid-session is the session ending, not a password being typed
    // wrong. The panel signs out rather than showing this, but say it plainly.
    return new AdminError(
      response.status,
      code,
      response.status === 401 ? 'session ended, sign in again' : message,
    )
  }
}
