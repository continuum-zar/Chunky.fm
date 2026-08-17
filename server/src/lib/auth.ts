import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'

/** The signed session cookie the admin surface runs on. */
export const ADMIN_COOKIE = 'chunky_admin'

/** The signed cookie a listener gets in exchange for the station key. */
export const LISTENER_COOKIE = 'chunky_listener'

/** The signed cookie a co-host gets in exchange for the co-host key. */
export const CO_HOST_COOKIE = 'chunky_cohost'

/**
 * How long a co-host seat lasts in a browser before the link is needed again.
 *
 * Between the other two on purpose, and the reason is who is holding it. An
 * admin session is twelve hours because a set runs for an evening and whoever
 * runs the decks is at a machine they own. An invite is a month because being
 * asked to dig out a link every evening to *listen* is its own kind of broken.
 *
 * A co-host is a person on a phone who is expected back next week and whose
 * seat can move records and open a microphone. A week is long enough that a
 * regular partner never re-redeems mid-run, and short enough that a phone left
 * in a taxi is not a standing invitation to the decks.
 */
export const CO_HOST_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How long an invite lasts in a browser before the link is needed again.
 *
 * Much longer than an admin session: this is not a set of controls, it is
 * whether somebody can hear the station at all, and asking a listener to dig
 * out the link every evening would be its own kind of broken. Rotating
 * STATION_KEY is what actually ends them, all at once.
 */
export const LISTENER_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** How long a sign-in lasts. A set runs for an evening, not for a week. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Domain separation for the signing key. Without it the key would *be* the
 * password, and every signature an oracle for it.
 */
const KEY_LABEL = 'chunky.fm/admin-session/v1'
const LISTENER_KEY_LABEL = 'chunky.fm/listener-session/v1'
const CO_HOST_KEY_LABEL = 'chunky.fm/co-host-session/v1'

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Derived from the password rather than from a second env var: changing
 * ADMIN_PASSWORD then invalidates every cookie already handed out, which is
 * what changing a password is supposed to do. It also leaves one secret to
 * configure, and no session key to lose across a restart.
 *
 * The label is what keeps this apart from the listener key below, and it earns
 * its keep now that both can be derived from the *same* string: on a station
 * where nobody set ADMIN_PASSWORD, the admin password and the door code are one
 * value, and without domain separation a listener cookie would be a valid admin
 * cookie. The two labels are the only reason it is not.
 */
function sessionKey(config: Config): Buffer {
  return createHmac('sha256', config.adminPassword).update(KEY_LABEL).digest()
}

function sign(config: Config, payload: string): string {
  return createHmac('sha256', sessionKey(config)).update(payload).digest('base64url')
}

/**
 * Derived from the station key for the same reason the admin key is derived
 * from the password: rotating STATION_KEY then invalidates every cookie already
 * handed out, so an old link stops working everywhere at once.
 */
function listenerKey(stationKey: string): Buffer {
  return createHmac('sha256', stationKey).update(LISTENER_KEY_LABEL).digest()
}

function signListener(stationKey: string, payload: string): string {
  return createHmac('sha256', listenerKey(stationKey)).update(payload).digest('base64url')
}

/** Mint an invite for a browser that has just presented the station key. */
export function issueListenerSession(
  stationKey: string,
  now = Date.now(),
  ttlMs = LISTENER_TTL_MS,
): AdminSession {
  const expiresAt = now + ttlMs
  const payload = `${expiresAt}.${randomBytes(12).toString('base64url')}`
  return { token: `${payload}.${signListener(stationKey, payload)}`, expiresAt }
}

export function verifyListenerSession(stationKey: string, token: string, now = Date.now()): boolean {
  const cut = token.lastIndexOf('.')
  if (cut <= 0) return false
  if (!constantTimeEquals(token.slice(cut + 1), signListener(stationKey, token.slice(0, cut)))) {
    return false
  }
  const payload = token.slice(0, cut)
  const expiresAt = Number(payload.slice(0, payload.indexOf('.')))
  return Number.isFinite(expiresAt) && expiresAt > now
}

/**
 * Derived from the co-host key for the reason the other two are derived from
 * what they guard: rotating `CO_HOST_KEY` — or the admin password it falls back
 * to — invalidates every seat already handed out, so an old link stops working
 * everywhere at once.
 */
function coHostSigningKey(coHostKey: string): Buffer {
  return createHmac('sha256', coHostKey).update(CO_HOST_KEY_LABEL).digest()
}

function signCoHost(coHostKey: string, payload: string): string {
  return createHmac('sha256', coHostSigningKey(coHostKey)).update(payload).digest('base64url')
}

/** Mint a seat for a browser that has just presented the co-host key. */
export function issueCoHostSession(
  coHostKey: string,
  now = Date.now(),
  ttlMs = CO_HOST_TTL_MS,
): AdminSession {
  const expiresAt = now + ttlMs
  const payload = `${expiresAt}.${randomBytes(12).toString('base64url')}`
  return { token: `${payload}.${signCoHost(coHostKey, payload)}`, expiresAt }
}

export function verifyCoHostSession(coHostKey: string, token: string, now = Date.now()): boolean {
  const cut = token.lastIndexOf('.')
  if (cut <= 0) return false
  if (!constantTimeEquals(token.slice(cut + 1), signCoHost(coHostKey, token.slice(0, cut)))) {
    return false
  }
  const payload = token.slice(0, cut)
  const expiresAt = Number(payload.slice(0, payload.indexOf('.')))
  return Number.isFinite(expiresAt) && expiresAt > now
}

/** Does this candidate match the co-host key? The gate on taking the seat. */
export function isValidCoHostKey(config: Config, candidate: unknown): boolean {
  return typeof candidate === 'string' && constantTimeEquals(candidate, config.coHostKey)
}

/**
 * Is this request a co-host, or something that outranks one?
 *
 * Admin credentials count, and that is not a shortcut. Whoever runs the decks
 * can already do everything the seat can and more, and a console that had to
 * hold a second cookie to drive its own queue would be a rule enforced against
 * the one person it was never written for. The relation is a ladder, not two
 * separate doors: admin ⊃ co-host.
 *
 * Raw headers rather than a `FastifyRequest`, so the websocket upgrade — which
 * never becomes one — can ask the same question of the same code. That matters
 * more here than it does for the admin gate: the socket is how the console
 * learns which id to offer a microphone to.
 */
export function hasCoHostCredentials(
  config: Config,
  headers: IncomingHttpHeaders,
  now = Date.now(),
): boolean {
  const token = readCookie(headers.cookie, CO_HOST_COOKIE)
  if (token !== null && verifyCoHostSession(config.coHostKey, token, now)) return true

  // For curl and the QA scripts, which have nowhere to keep a cookie. The same
  // affordance `mayListen` gives the station key.
  const presented = headers['x-cohost-key']
  if (typeof presented === 'string' && constantTimeEquals(presented, config.coHostKey)) return true

  return hasAdminCredentials(config, headers, now)
}

/** `Set-Cookie` for a fresh seat. */
export function coHostCookie(session: AdminSession, secure: boolean, now = Date.now()): string {
  return cookie(
    session.token,
    Math.max(0, Math.floor((session.expiresAt - now) / 1000)),
    secure,
    CO_HOST_COOKIE,
  )
}

/** `Set-Cookie` that drops a seat the station no longer recognises. */
export function clearedCoHostCookie(secure: boolean): string {
  return cookie('', 0, secure, CO_HOST_COOKIE)
}

/**
 * The gate on everything the seat can reach.
 *
 * Shaped exactly like `requireAdmin`, including shedding the cookie on the way
 * out: a signature that no longer verifies is usually the admin password having
 * changed, and a browser that went on presenting it would be refused on every
 * request for the rest of the week the seat was minted for.
 */
export function requireCoHost(config: Config) {
  return async function coHostGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!hasCoHostCredentials(config, request.headers)) {
      return reply
        .header('set-cookie', clearedCoHostCookie(isSecureRequest(request)))
        .code(401)
        .send({ error: 'unauthorized', message: 'co-host credentials required' })
    }
  }
}

/** Does this candidate match the station key? The gate on redeeming a link. */
export function isValidStationKey(config: Config, candidate: unknown): boolean {
  // Falsy rather than `=== null`: an unset env var, an empty one and a config
  // built without the field all mean the same thing (no key), and an open
  // station must never accept a key it does not have.
  if (!config.stationKey) return false
  return typeof candidate === 'string' && constantTimeEquals(candidate, config.stationKey)
}

/**
 * May this request hear the station?
 *
 * An open station admits everyone, which now means one opened on purpose with
 * STATION_OPEN, or a config assembled without the field at all, as the tests do.
 * Otherwise: a valid invite cookie, the key presented directly (for curl and
 * the QA scripts, which have nowhere to keep a cookie), or admin credentials:
 * whoever runs the decks does not also need an invite to their own station.
 *
 * Raw headers rather than a `FastifyRequest`, so the websocket upgrade can ask
 * the same question of the same code.
 */
export function mayListen(
  config: Config,
  headers: IncomingHttpHeaders,
  now = Date.now(),
): boolean {
  // Falsy rather than `=== null`, so a config assembled without the field is
  // an open station rather than one nobody can reach. The station has always
  // been open; a new setting must not shut it by being absent.
  if (!config.stationKey) return true

  const token = readCookie(headers.cookie, LISTENER_COOKIE)
  if (token !== null && verifyListenerSession(config.stationKey, token, now)) return true

  const presented = headers['x-station-key']
  if (typeof presented === 'string' && constantTimeEquals(presented, config.stationKey)) return true

  // And a co-host, who obviously may hear the station they are helping run.
  // Without this a private station would hand somebody a co-host link and then
  // refuse their websocket, which presents as a seat that cannot connect — and
  // the co-host page is *mostly* socket, so it would present as nothing working
  // at all. `hasCoHostCredentials` already admits an admin, so this covers both.
  return hasCoHostCredentials(config, headers, now)
}

/** The gate on everything a listener can reach. */
export function requireListener(config: Config) {
  return async function listenerGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!mayListen(config, request.headers)) {
      return reply
        .header('set-cookie', clearedListenerCookie(isSecureRequest(request)))
        .code(401)
        .send({ error: 'unauthorized', message: 'this station is private' })
    }
  }
}

export interface AdminSession {
  /** The cookie value: `<expiresAt>.<nonce>.<signature>`. */
  token: string
  expiresAt: number
}

/**
 * Mint a session for someone who has just proved they know the password.
 *
 * The expiry lives inside the signed payload, so it is the server's word rather
 * than the browser's, so a client that ignores `Max-Age` and keeps the cookie
 * still finds it refused. The nonce only makes two sessions minted in the same
 * millisecond distinct from each other.
 */
export function issueAdminSession(
  config: Config,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
): AdminSession {
  const expiresAt = now + ttlMs
  const payload = `${expiresAt}.${randomBytes(12).toString('base64url')}`
  return { token: `${payload}.${sign(config, payload)}`, expiresAt }
}

export function verifyAdminSession(config: Config, token: string, now = Date.now()): boolean {
  const cut = token.lastIndexOf('.')
  if (cut <= 0) return false

  const payload = token.slice(0, cut)
  // Signature first: an expiry read off an unverified payload is just a number
  // the client chose.
  if (!constantTimeEquals(token.slice(cut + 1), sign(config, payload))) return false

  const expiresAt = Number(payload.slice(0, payload.indexOf('.')))
  return Number.isFinite(expiresAt) && expiresAt > now
}

/** `Set-Cookie` for a fresh session. */
export function sessionCookie(session: AdminSession, secure: boolean, now = Date.now()): string {
  return cookie(session.token, Math.max(0, Math.floor((session.expiresAt - now) / 1000)), secure)
}

/** `Set-Cookie` that drops the session: signing out, or shedding a stale one. */
export function clearedCookie(secure: boolean): string {
  return cookie('', 0, secure)
}

/** `Set-Cookie` for a fresh invite. */
export function listenerCookie(session: AdminSession, secure: boolean, now = Date.now()): string {
  return cookie(session.token, Math.max(0, Math.floor((session.expiresAt - now) / 1000)), secure, LISTENER_COOKIE)
}

/** `Set-Cookie` that drops an invite the station no longer recognises. */
export function clearedListenerCookie(secure: boolean): string {
  return cookie('', 0, secure, LISTENER_COOKIE)
}

function cookie(value: string, maxAgeSeconds: number, secure: boolean, name = ADMIN_COOKIE): string {
  // HttpOnly so page script can't read the token, SameSite=Strict so nothing
  // the admin clicks on another site can drive the station on their behalf.
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * `Secure` would make the cookie unusable over plain HTTP, which is exactly how
 * the station is developed, so it follows the scheme the request arrived on.
 * Railway terminates TLS in front of the app, hence the forwarded header.
 */
export function isSecureRequest(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof proto === 'string') return proto.split(',')[0]!.trim() === 'https'
  return request.protocol === 'https'
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return null
}

/**
 * The password presented directly. The browser exchanges it for a cookie at
 * `POST /api/admin/session` and never sends it again; a curl one-liner or a QA
 * script has nowhere to keep a cookie and shouldn't need one.
 */
function presentedPassword(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  const header = headers['x-admin-password']
  if (typeof header === 'string') return header
  return null
}

/**
 * Is this request the admin? Either credential is enough: a valid session
 * cookie, or the password itself.
 *
 * Takes raw headers rather than a `FastifyRequest` so the websocket upgrade,
 * which never becomes one, can ask the same question of the same code.
 */
export function hasAdminCredentials(
  config: Config,
  headers: IncomingHttpHeaders,
  now = Date.now(),
): boolean {
  const token = readCookie(headers.cookie, ADMIN_COOKIE)
  if (token !== null && verifyAdminSession(config, token, now)) return true

  const password = presentedPassword(headers)
  return password !== null && constantTimeEquals(password, config.adminPassword)
}

/** Does this candidate match the station password? The gate on sign-in. */
export function isValidPassword(config: Config, candidate: unknown): boolean {
  return typeof candidate === 'string' && constantTimeEquals(candidate, config.adminPassword)
}

/** The gate on every admin-only route. Refuses before the handler runs at all. */
export function requireAdmin(config: Config) {
  return async function adminGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!hasAdminCredentials(config, request.headers)) {
      // Shed the cookie on the way out: a signature that no longer verifies
      // (usually a restart with a different password) would otherwise be sent
      // again on every request the browser makes for the rest of the session.
      return reply
        .header('set-cookie', clearedCookie(isSecureRequest(request)))
        .code(401)
        .send({ error: 'unauthorized', message: 'admin credentials required' })
    }
  }
}
