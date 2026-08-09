import path from 'node:path'

export interface Config {
  host: string
  port: number
  /** Railway volume mount. Audio, artwork and the SQLite file all live here. */
  storageDir: string
  audioDir: string
  artworkDir: string
  /** Session posters. Public, unlike the audio and the artwork: see `Schedule`. */
  posterDir: string
  /** Uploads land here first and are only moved once they parse as audio. */
  tmpDir: string
  dbPath: string
  adminPassword: string
  /**
   * What a listener has to present to reach the station at all, or null for a
   * station anyone with the address can hear.
   *
   * A *separate field* from the admin password, because the two guard different
   * things and are shared with different people: this one goes out in a link to
   * everybody invited, and rotating it locks all of them out at once.
   *
   * On an unconfigured station they nevertheless hold the same value, because
   * both fall back to the house key, so out of the box one code opens both
   * doors. That is a choice about defaults and not about the model: set either
   * variable and they part company, and nothing downstream has to change,
   * because nothing downstream ever assumed they were equal.
   *
   * Null only when the station has been opened deliberately. See
   * `stationKeyFromEnv`. It is no longer what an unset `STATION_KEY` means.
   */
  stationKey: string | null
  maxUploadBytes: number
  /**
   * Where the station asks about lyrics. LRCLIB is public and keyless, so this
   * is an address rather than a credential; point it at a mirror if the public
   * one is ever unreachable from where the station runs.
   */
  lrclibBaseUrl: string
  /**
   * The built client, when this process is also the thing serving it.
   *
   * Null under compose and in development, where something else owns the front
   * door (nginx in the container, Vite's dev server locally) and this process
   * is only an API. Set to `client/dist` in the single-image deployment, where
   * there is no nginx and Fastify is the only thing listening.
   *
   * Null rather than a default path on purpose: a server that guessed at a
   * client directory and found nothing would answer the landing page with a
   * 404 instead of leaving `/` alone, and the compose stack would break in a
   * way that only shows up in a browser.
   */
  /**
   * Where a browser goes to find out how to reach another browser.
   *
   * The voice is peer-to-peer: it never touches this server, which is the whole
   * reason a mic costs nothing to run. What two browsers behind two routers do
   * need is help discovering each other, and that is all these are.
   *
   * **STUN** is a question — "what does my address look like from outside?" —
   * and the answer is a few hundred bytes, once, per connection. **TURN** is a
   * relay, for the minority (roughly one listener in six) behind a NAT strict
   * enough that no direct path exists. Mono voice is about 32 kbps, so a
   * relayed listener costs around 14 MB an hour, which is inside every free
   * tier on the market and inside a very small VPS if you would rather own it.
   *
   * Empty lists are a station that only works where every listener can be
   * reached directly, which in practice means a LAN. That is a real way to run
   * this and it is not the default.
   */
  /**
   * How much the station says about itself, as a pino level.
   *
   * `info` everywhere by default. The one reason to move it is a voice that
   * will not connect: at `debug` every ICE candidate the station relays is a
   * line, which says whether addresses are crossing at all and in which
   * direction they stop. That is far too much to keep on, and exactly what is
   * wanted for the ten minutes somebody is looking.
   */
  logLevel: string
  stunUrls: string[]
  /**
   * The relay, or null. See `stunUrls`.
   *
   * A list of URLs rather than one, sharing a set of credentials, because every
   * relay worth using hands you several and the differences between them are
   * the whole point: `turn:` over UDP is the fast path, the same host on TCP
   * survives a network that drops UDP, and `turns:` on 443 gets through the
   * kind of firewall that only believes in HTTPS. A station configured with the
   * first of those alone works everywhere except the places a relay was needed
   * for — which, since the listener who needs one is usually the one on a
   * phone, is most of them.
   */
  turn: { urls: string[]; username: string; credential: string } | null
  /**
   * Cloudflare's relay, which hands out credentials rather than holding one.
   *
   * A key id and an API token, exchanged at request time for a username and a
   * credential that expire. That is why it cannot go in `turn` above: there is
   * no static password to put there, and a relay credential that expires the
   * same day is a much smaller thing to have leaked than one that does not.
   *
   * Set alongside `turn` if you like; a browser is happy to be given both.
   */
  cloudflareTurn: { keyId: string; apiToken: string } | null
  clientDir: string | null
  /**
   * Who is allowed to tell the station where a request really came from.
   *
   * This is never reached directly in either supported deployment: nginx sits
   * in front of it in compose, and Railway's edge does in production. So the
   * socket's peer address is the proxy's, and `request.ip` is that same address
   * for every caller alive, which is fine for logging and *not* fine for
   * anything keyed on it. The sign-in throttle is keyed on it, and one shared
   * bucket there is not brute-force protection, it is a way for a stranger to
   * lock the admin out of their own station.
   *
   * True by default for that reason, which means trusting `X-Forwarded-For`.
   * Anyone who can reach the origin directly can therefore claim to be any
   * address they like, so don't publish the origin port. Set `TRUST_PROXY` to
   * `false` when nothing is in front, or to a hop count or a list of proxy
   * addresses to trust something narrower.
   */
  trustProxy: boolean | string | string[] | number
}

/**
 * `false`/`true` as written, a bare integer as a hop count, anything else as a
 * comma-separated list of addresses or CIDR ranges: the shapes Fastify already
 * takes, chosen from the string an env var has to be.
 */
function trustProxyFromEnv(value: string | undefined): Config['trustProxy'] {
  if (value === undefined || value === '') return true
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^\d+$/.test(value)) return Number(value)
  const addresses = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (addresses.length === 0) {
    throw new Error(`TRUST_PROXY must be true, false, a hop count or a list of addresses`)
  }
  return addresses
}

/**
 * The house key: the door code a station comes with when nobody has set one.
 *
 * Written backwards and in base64, the way you would write a door code on the
 * back of a beer mat rather than on the door. That is the whole of the trick,
 * and it is worth being straight about what it buys: nothing at all against
 * anyone holding this repository, and everything against the only threat that
 * actually exists here, which is the code sitting in plain sight in a file
 * somebody screen-shares. It never leaves the server: a listener presents a
 * guess and is told yes or no, so the browser never has it to give away.
 *
 * To read it back without printing it into a commit:
 *
 *     node -e "console.log([...Buffer.from('MTAxeWtudWhj','base64').toString()].reverse().join(''))"
 *
 * Only the decks use it now. The door came off the listening side: see
 * `stationKeyFromEnv`. Set `ADMIN_PASSWORD` to replace this with something you
 * chose, which is what any station reachable from the internet should do.
 */
function houseKey(): string {
  return [...Buffer.from('MTAxeWtudWhj', 'base64').toString('utf8')].reverse().join('')
}

/**
 * What guards the station, from the environment.
 *
 * **Nothing, unless you ask for it.** An unset `STATION_KEY` is an open
 * station: anybody with the address can listen, and nobody is asked for
 * anything on the way in.
 *
 * This default has now been both ways round, so it is worth writing down why it
 * is back here. The argument for a door by default was that a station which
 * quietly became public because a variable went missing is a bad surprise. The
 * argument against it, which won, is that the door was being paid for by every
 * single listener on every single visit, to protect a room of friends listening
 * to music together. A code somebody has to be told, remembered and typed is
 * the most expensive thing on the way in, and it was being charged to everyone
 * to guard something most stations do not need guarded at all.
 *
 * A door is still one variable away, and the whole mechanism behind it is
 * untouched: invite links, the cookie, the typed code, rotation. `STATION_KEY`
 * puts it back on.
 *
 * What is *not* affected is the decks. `ADMIN_PASSWORD` still guards every
 * upload, the queue and going on air, and it still falls back to the house key
 * above. Opening the station means anybody can listen; it has never meant
 * anybody can play anything.
 */
function stationKeyFromEnv(env: NodeJS.ProcessEnv): string | null {
  // `STATION_OPEN` is what taking the door off used to need, and it is now the
  // default. Still accepted, and still a no-op rather than an error, because a
  // compose file or a Railway variable that has been carrying it for months
  // should not start failing to mean what it always meant.
  return env.STATION_KEY?.trim() || null
}

const DEFAULT_MAX_UPLOAD_BYTES = 150 * 1024 * 1024

/**
 * Google's public STUN, as the out-of-the-box answer.
 *
 * This is the one place the station reaches somewhere it was not configured to,
 * and it is worth saying why rather than leaving it to be discovered. Nothing
 * else here does: the audio is self-hosted, the artwork is self-hosted, even
 * the gramophone's decoder is bundled rather than fetched, and the one existing
 * outbound call (LRCLIB) is for a thing the station cannot know on its own.
 * This is the same kind of thing — two browsers genuinely cannot work out how
 * to reach each other without asking something outside both of them.
 *
 * What crosses it is a browser's own address and nothing else: no audio, no
 * identity, nothing about the station or what is playing on it. Set
 * `STUN_URLS` to point somewhere else, or to an empty string to ask nobody,
 * which is a station that works on a LAN and not beyond one.
 */
const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302']

/** Comma-separated, trimmed, and an explicit empty string means none at all. */
function listFromEnv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * The relay, or nothing.
 *
 * All three parts or none: a URL with no credentials is a relay that will
 * refuse every listener it is handed to, and finding that out means watching
 * one person in six silently fail to hear a voice. Better to refuse at boot,
 * where somebody is looking.
 */
function turnFromEnv(env: NodeJS.ProcessEnv): Config['turn'] {
  // Comma-separated, like STUN_URLS: a provider hands you four of these and
  // giving the browser all of them is what lets it fall back from UDP to TCP
  // to TLS on 443 as the network in front of a listener gets stricter.
  const urls = listFromEnv(env.TURN_URL, [])
  const username = env.TURN_USERNAME?.trim()
  const credential = env.TURN_CREDENTIAL?.trim()
  if (urls.length === 0 && !username && !credential) return null
  if (urls.length === 0 || !username || !credential) {
    throw new Error('TURN_URL, TURN_USERNAME and TURN_CREDENTIAL must be set together, or not at all')
  }
  return { urls, username, credential }
}

/** Both halves or neither, for the reason `turnFromEnv` wants all three. */
function cloudflareTurnFromEnv(env: NodeJS.ProcessEnv): Config['cloudflareTurn'] {
  const keyId = env.TURN_KEY_ID?.trim()
  const apiToken = env.TURN_API_TOKEN?.trim()
  if (!keyId && !apiToken) return null
  if (!keyId || !apiToken) {
    throw new Error('TURN_KEY_ID and TURN_API_TOKEN must be set together, or not at all')
  }
  return { keyId, apiToken }
}

function intFromEnv(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Falls back to the same house key the door does, so an unconfigured station
  // has *one* code that opens both. That is a deliberate collapse of two
  // secrets into one, and it costs exactly what it sounds like: anybody handed
  // the code to listen can also upload, drive the decks and end the broadcast.
  // Fine for a room of friends, which is what this is; set ADMIN_PASSWORD for
  // anything else, and the two come apart again with no other change.
  const adminPassword = env.ADMIN_PASSWORD?.trim() || houseKey()

  const storageDir = path.resolve(env.AUDIO_STORAGE_DIR ?? 'audio_storage')

  return {
    host: env.HOST ?? '0.0.0.0',
    port: intFromEnv(env.PORT, 3000, 'PORT'),
    storageDir,
    audioDir: path.join(storageDir, 'audio'),
    artworkDir: path.join(storageDir, 'artwork'),
    posterDir: path.join(storageDir, 'posters'),
    tmpDir: path.join(storageDir, 'tmp'),
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(storageDir, 'chunky.sqlite'),
    adminPassword,
    stationKey: stationKeyFromEnv(env),
    maxUploadBytes: intFromEnv(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES, 'MAX_UPLOAD_BYTES'),
    lrclibBaseUrl: env.LRCLIB_BASE_URL?.trim() || 'https://lrclib.net',
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    stunUrls: listFromEnv(env.STUN_URLS, DEFAULT_STUN_URLS),
    turn: turnFromEnv(env),
    cloudflareTurn: cloudflareTurnFromEnv(env),
    // Unset means "something else is serving the client", which is true of both
    // the compose stack and `npm run dev`. Only the single-image deployment
    // sets it. See the root Dockerfile.
    clientDir: env.CLIENT_DIR?.trim() ? path.resolve(env.CLIENT_DIR.trim()) : null,
    trustProxy: trustProxyFromEnv(env.TRUST_PROXY),
  }
}
