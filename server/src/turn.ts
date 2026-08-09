import type { IceServer } from './routes/rtc.js'

/**
 * Short-lived relay credentials, minted on demand.
 *
 * Cloudflare's TURN does not hand out a password to put in a config file. What
 * it gives you is a key id and an API token, and you exchange those for a
 * username and credential that expire — which is a better shape than a static
 * password and the reason `TURN_USERNAME` cannot simply be filled in with them.
 * A relay credential that leaks is a relay anybody can spend; one that leaks and
 * expires the same day is a much smaller thing to have lost.
 *
 * Held here rather than fetched per request, because a room arriving together
 * is thirty listeners asking `/api/rtc` inside a few seconds, and thirty calls
 * to Cloudflare to be told the same answer would be rude at best. One set is
 * minted, kept until it is near expiry, and shared.
 */

/** Cloudflare's documented endpoint; the key id goes in the path. */
const ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/**
 * How long a minted set lasts. A day, which is longer than any broadcast.
 *
 * Worth knowing that an expiring credential does not cut off a voice already
 * being relayed: an allocation outlives the credential that opened it. What
 * expires is the ability to open a *new* one, which is why this only has to
 * outlast the gap between somebody joining and somebody talking.
 */
const DEFAULT_TTL_SECONDS = 86_400

/**
 * Mint a fresh set this long before the old one lapses — or a quarter of the
 * way into its life, whichever is sooner.
 *
 * The second half of that is not decoration. A flat margin longer than the TTL
 * puts every set past its refresh point the moment it is minted, so the cache
 * never hits and every listener asking `/api/rtc` becomes a call to Cloudflare.
 * The failure is silent, costs nothing visible, and would only ever be found by
 * somebody reading a bill.
 */
const REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000

function refreshMargin(ttlMs: number): number {
  return Math.min(REFRESH_MARGIN_MS, ttlMs / 4)
}

export interface CloudflareTurnOptions {
  /** The TURN key id, which is not a secret and goes in the URL. */
  keyId: string
  /** The API token, which is. */
  apiToken: string
  /** The seam the tests use; production reaches Cloudflare. */
  fetchFn?: typeof fetch
  now?: () => number
  ttlSeconds?: number
  /**
   * Told when a mint fails. A station that cannot reach Cloudflare still works
   * for every listener who did not need a relay, so this is a line in the log
   * rather than a reason to refuse the request.
   */
  onError?(err: unknown): void
}

export class CloudflareTurn {
  readonly #keyId: string
  readonly #apiToken: string
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #ttlSeconds: number
  readonly #onError: (err: unknown) => void
  #cached: { servers: IceServer[]; expiresAt: number } | null = null
  /** The mint in flight, so a room arriving together makes one request. */
  #minting: Promise<IceServer[]> | null = null

  constructor({
    keyId,
    apiToken,
    fetchFn = fetch,
    now = Date.now,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    onError = () => undefined,
  }: CloudflareTurnOptions) {
    this.#keyId = keyId
    this.#apiToken = apiToken
    // Bound: fetch called as a method of anything but globalThis throws.
    this.#fetch = fetchFn.bind(globalThis)
    this.#now = now
    this.#ttlSeconds = ttlSeconds
    this.#onError = onError
  }

  /**
   * The relay, ready to hand to a browser. Empty when Cloudflare could not be
   * reached, which leaves a station serving STUN alone: worse, and still a
   * station, which is the right way for this to fail.
   */
  async servers(): Promise<IceServer[]> {
    const held = this.#cached
    const margin = refreshMargin(this.#ttlSeconds * 1000)
    if (held && held.expiresAt - margin > this.#now()) return held.servers
    this.#minting ??= this.#mint().finally(() => {
      this.#minting = null
    })
    return this.#minting
  }

  async #mint(): Promise<IceServer[]> {
    try {
      const response = await this.#fetch(
        `${ENDPOINT}/${encodeURIComponent(this.#keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ttl: this.#ttlSeconds }),
        },
      )
      if (!response.ok) throw new Error(`cloudflare answered ${response.status}`)

      const servers = readIceServers(await response.json())
      if (servers.length === 0) throw new Error('cloudflare returned no ice servers')

      this.#cached = { servers, expiresAt: this.#now() + this.#ttlSeconds * 1000 }
      return servers
    } catch (err) {
      this.#onError(err)
      // Whatever was minted last is better than nothing, even past the margin:
      // a credential a little stale still opens an allocation, and a station
      // that dropped its relay because one refresh failed would be worse than
      // one that kept using yesterday's for an hour.
      return this.#cached?.servers ?? []
    }
  }
}

/**
 * Cloudflare's answer, taken at arm's length.
 *
 * Everything here is somebody else's JSON crossing a network, so it is read
 * field by field rather than trusted: a shape that changed should cost this
 * station its relay and a line in the log, not a 500 on the endpoint both ends
 * of every voice depend on.
 */
export function readIceServers(body: unknown): IceServer[] {
  if (typeof body !== 'object' || body === null) return []
  const listed = (body as { iceServers?: unknown }).iceServers
  // Documented as an array; accepted as a lone object too, because it has been
  // one before and the difference is not worth losing a relay over.
  const entries = Array.isArray(listed) ? listed : listed === undefined ? [] : [listed]

  const servers: IceServer[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const { urls, username, credential } = entry as {
      urls?: unknown
      username?: unknown
      credential?: unknown
    }
    const addresses = (Array.isArray(urls) ? urls : [urls]).filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    )
    if (addresses.length === 0) continue

    const server: IceServer = { urls: addresses }
    // Both or neither: a relay address with half a credential is one that
    // refuses everybody, and a STUN entry legitimately has no credentials at
    // all — Cloudflare returns one of each.
    if (typeof username === 'string' && typeof credential === 'string') {
      server.username = username
      server.credential = credential
    }
    servers.push(server)
  }
  return servers
}
