/**
 * Where you are on the station.
 *
 * The whole app is one document and the address bar's fragment decides what is
 * on screen. A fragment rather than a path because the station is served as a
 * static bundle behind nginx: a real path would need the server to know every
 * route, and `try_files … /index.html` already lies to it about that once. One
 * lie is enough.
 *
 * PLAN.md calls this "one page, two modes", and it still is: `admin` is the
 * other mode, and everything else is the listener page pointed at one of the
 * things on it. What the rail offers is a way to give any of them the whole
 * screen, the same data, with room to read it.
 */

export type Route =
  /** The deck, and everything the design puts around it. Where you land. */
  | 'on-air'
  /** The clock numbers, in full. The project lives or dies on these. */
  | 'sync'
  /** The room, talking. */
  | 'chat'
  /** The words to what is on, given the whole screen. Phones read them here. */
  | 'lyrics'
  /** What this listener has asked for. */
  | 'wishes'
  /** The evening so far. */
  | 'history'
  /** The decks. The other mode, not another view. */
  | 'admin'

/** Where you land, and what an address nobody recognises falls back to. */
export const DEFAULT_ROUTE: Route = 'on-air'

/**
 * The fragment each route answers to.
 *
 * `on-air` is the empty fragment: the station's address is the bare link you
 * paste to somebody, and it should not grow a `#on-air` the moment they arrive.
 * `admin` keeps the plain `#admin` it has always had: it is in the QA scripts,
 * in the README, and in whatever bookmark whoever runs the decks is using.
 */
const HASHES: Record<Route, string> = {
  'on-air': '',
  sync: '#sync',
  chat: '#chat',
  lyrics: '#lyrics',
  wishes: '#wishes',
  history: '#history',
  admin: '#admin',
}

/**
 * The route a fragment names, or null if it names nothing.
 *
 * Exported because the landing page asks it too. It stands at `/`, which is
 * where every `/#chat` and `/#admin` link handed out before the doorway moved
 * still points, and forwarding those needs to know which fragments are the
 * station's and which (`#clockwork`) are its own.
 */
export function routeInHash(hash: string): Route | null {
  const normalized = hash.startsWith('#') ? hash : `#${hash}`
  const found = Object.entries(HASHES).find(([, value]) => value !== '' && value === normalized)
  return found ? (found[0] as Route) : null
}

/** The address bar's fragment for a route. Empty string for where you land. */
export function hashFor(route: Route): string {
  return HASHES[route]
}

/**
 * The station's own address.
 *
 * `/` is the page in front of it (see nginx.conf and the landing page) so the
 * app itself lives one name in. Nothing inside the app depends on this: every
 * link the rail and the topbar draw is a bare fragment, which works at whatever
 * path the document was served from. It is here for the things *outside* the
 * app that have to name the station: the landing page's ways in, the invite
 * link the console hands out, and the QA scripts.
 */
export const STATION_PATH = '/listen'

/**
 * The co-host's own address.
 *
 * A third document rather than a route on the station, and the reason is the
 * device. The station's bundle carries a globe, a gramophone and three.js; the
 * console carries the whole desk. Neither is what you want to hand somebody on
 * a phone in a kitchen who has to press one button in the next four seconds.
 * So the seat is its own entry with its own bundle, holding only what a co-host
 * touches — see `cohost.html` and `vite.config.ts`.
 *
 * Named here rather than in the co-host page so that `lib/cohost.ts` and the
 * console's share button, which are the two things that build a link to it,
 * agree with the three front doors about what the address is.
 */
export const CO_HOST_PATH = '/cohost'

/** The address of a route on the station, for a link written from outside it. */
export function stationUrl(route: Route = DEFAULT_ROUTE): string {
  return `${STATION_PATH}${hashFor(route)}`
}

/**
 * Which route a location is on.
 *
 * `/admin` as a path is honoured as well as `#admin`, because it always has
 * been; see `isAdminRoute`, which this replaces at the call site and agrees
 * with everywhere it mattered.
 */
export function routeFrom(location: { pathname: string; hash: string }): Route {
  if (location.pathname === '/admin') return 'admin'
  return routeInHash(location.hash) ?? DEFAULT_ROUTE
}

/** True for the one route that is a different mode rather than another view. */
export function isConsole(route: Route): boolean {
  return route === 'admin'
}

/**
 * Whether a route has anything on it for somebody who has not tuned in.
 *
 * Only two do. Everything else is a view of what the station has told this
 * listener, and before joining it has told them nothing, so the rail says so
 * rather than offering six ways to reach an empty page.
 */
export function needsJoin(route: Route): boolean {
  return route !== 'on-air' && route !== 'admin'
}
