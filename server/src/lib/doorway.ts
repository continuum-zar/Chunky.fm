/**
 * What the front door does with a request, as a decision rather than a reply.
 *
 * Three rules decide what somebody arriving at the bare address gets, and they
 * are written down in three places because three different things can be the
 * front door:
 *
 *   - `client/nginx.conf`:     the compose stack, where nginx serves the client
 *   - `client/vite.config.ts`: `npm run dev` and `vite preview`
 *   - this file:               the single-image deployment, where Fastify is
 *                              the only thing listening and there is no nginx
 *
 * They have to agree. The app ships unchanged across all three, so a rule that
 * drifts in one of them is a difference nobody notices until whichever
 * environment holds the odd copy is the one in front of a listener. The rules:
 *
 *   /            the landing page, the document describing the station, which
 *                has to be able to speak on the days the station's own bundle
 *                would have nothing to say
 *   /?k=<key>    an invite, sent on to the station with the key intact
 *   /welcome     where the landing page used to live
 *
 * `/listen` needs no rule anywhere: an unknown path is answered with the
 * station in all three, which is exactly what it is.
 */

/**
 * The invite parameter, spelled out here as it is in `nginx.conf` and
 * `vite.config.ts`, and kept in step with `INVITE_PARAM` in the client's
 * `src/lib/invite.ts` by hand. Nothing imports across the two workspaces:
 * the client image does not contain the server directory, and vice versa.
 */
export const INVITE_PARAM = 'k'

export type Doorway =
  /** Send them somewhere else, with the path exactly as given. */
  | { kind: 'redirect'; status: 301 | 302; location: string }
  /** The page in front of the station. */
  | { kind: 'landing' }
  /** Not the doorway's business: a route, an asset, or the app itself. */
  | { kind: 'pass' }

/**
 * Where a request at the front door goes.
 *
 * Takes the raw URL rather than a parsed path because the query has to survive
 * an invite untouched: the station reads the key out of its own address bar, so
 * dropping or re-encoding it on the way through would hand the app a link it
 * cannot redeem.
 */
export function doorway(url: string): Doorway {
  // Only the path decides. `/welcome?utm=x` is still /welcome, and `/welcomely`
  // is not, the same split both other copies do.
  const cut = url.indexOf('?')
  const path = cut === -1 ? url : url.slice(0, cut)
  const query = cut === -1 ? '' : url.slice(cut + 1)

  if (path === '/welcome') {
    return { kind: 'redirect', status: 301, location: '/' }
  }

  if (path === '/') {
    // Non-empty rather than merely present, which is what nginx's `!= ""` says
    // and what `if ($arg_k)` would get wrong, since that reads a key of literally
    // "0" as no key at all.
    if ((new URLSearchParams(query).get(INVITE_PARAM) ?? '') !== '') {
      // Relative, and with the query carried across whole: an absolute location
      // would have to be built from a host header this process has no reliable
      // idea about, and an invite that lands on the wrong origin lands nowhere.
      return { kind: 'redirect', status: 302, location: `/listen?${query}` }
    }
    return { kind: 'landing' }
  }

  return { kind: 'pass' }
}

/**
 * Paths this process answers itself, and must never hand to the app.
 *
 * The station is one document that decides what to show from the fragment, so
 * the fallback for an unknown path is that document. That is right for
 * `/listen` and `/anything-else`, and wrong for a mistyped API route: a client
 * asking for `/api/wishez` should be told there is no such route, in the shape
 * every other refusal uses, not handed a page of HTML with a 200 on it.
 */
export function isServerPath(path: string): boolean {
  return path === '/health' || path === '/ws' || path.startsWith('/api/') || isCrawlPath(path)
}

/**
 * The files a crawler asks for, which the station answers rather than the
 * bundle. See `routes/crawl.ts`.
 *
 * Here rather than only in the route table because the app-shell fallback has
 * to know about them too: a request that somehow misses the routes must be told
 * there is no such file, not handed a page of HTML with a 200 on it. A robots
 * file that is a document is worse than one that is missing — the first is
 * read and misunderstood, and the second is simply absent.
 */
export function isCrawlPath(path: string): boolean {
  return path === '/robots.txt' || path === '/sitemap.xml' || path === '/llms.txt'
}
