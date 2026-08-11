import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'

/**
 * The three files a crawler asks for before it asks for anything else.
 *
 * They were all answering with the station: an unknown path is the app shell in
 * every one of the three front doors, which is right for `/listen` and wrong
 * for these — a robots file that is an HTML document is a robots file nothing
 * can read, served with a 200 so nothing knows to complain.
 *
 * Server routes rather than files in the client bundle, and `/health` is the
 * precedent: something the deployment answers, proxied through by nginx,
 * outside the doorway's business. The reason is `origin` below. A sitemap has
 * to carry absolute URLs, and the address this station answers on is about to
 * change — it is a Railway subdomain today and a real domain when somebody buys
 * one. Built from the request, that costs nothing and needs no configuration;
 * written into a file, it is a wrong hostname sitting in the repository waiting
 * to be noticed.
 *
 * Deliberately outside the listener gate, as the client documents are. A
 * private station refuses the socket, the library and the media — the things
 * that *are* the station — and not the sign that says what it is.
 */

/**
 * Where this station is being reached, as a crawler would write it down.
 *
 * `x-forwarded-proto` because everything real sits behind a proxy that
 * terminated the TLS, and Fastify is configured to trust it (see
 * `Config.trustProxy`). Falling back to the protocol of the socket would put
 * `http://` into a sitemap served over `https://`, which is a different origin
 * as far as anything reading it is concerned.
 */
function origin(request: FastifyRequest): string {
  const host = request.headers.host ?? 'localhost'
  return `${request.protocol}://${host}`
}

/**
 * What a crawler may have, and what there is no point in it having.
 *
 * `/listen` is disallowed on purpose and it is worth saying why, because it
 * looks like the page anybody would want indexed. It is an application: there
 * is nothing in the document but a mount point, it is behind a door on a
 * private station, and most of the time it would tell a search result the
 * station is off the air — which is true, and is the worst possible sentence to
 * meet somebody with who has just found this for the first time. The page that
 * describes the station is `/`, it is true on every day of the week, and it is
 * the one being offered here.
 *
 * The AI crawlers are allowed, and that is a decision rather than an omission.
 * A station whose premise is that it holds thirty people has a real argument
 * for refusing them. The argument the other way is narrower and, I think,
 * better: somebody asking where they can listen to music with other people
 * should be able to be told this exists. Being findable is not the same as
 * being crowded, and the door is still a door.
 */
function robots(base: string): string {
  return [
    'User-agent: *',
    'Allow: /$',
    'Disallow: /api/',
    'Disallow: /listen',
    'Disallow: /admin',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n')
}

/**
 * Two URLs, and it is not for discovery.
 *
 * Nothing here needs finding: there are two pages and one of them is disallowed
 * above. What a sitemap is for at this size is `lastmod` — the one way to tell
 * a crawler that the page it read six weeks ago has changed, without waiting
 * for it to come back and find out.
 */
function sitemap(base: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    '</urlset>',
    '',
  ].join('\n')
}

/**
 * The same thing again, for whatever is going to answer a question about it.
 *
 * An emerging convention rather than a standard, and cheap enough that it does
 * not have to be a safe bet to be worth having. What it buys is the difference
 * between something summarising this station from a page of animation and
 * something summarising it from six sentences written to be true.
 */
function llms(base: string): string {
  return `# chunky.fm

> A live internet radio station where everyone listening hears the same second
> of the same song. One person chooses the records; there is no shuffle, no
> skipping and no algorithm.

Sessions happen on announced evenings and end when they end. The station is
deliberately off air in between, and the page in front of it says when the next
one is.

Everyone tuned in hears the same moment because every browser aligns itself to
the station's own clock rather than being sent a stream: the audio is played
locally and corrected against a shared timebase, so no sound passes through the
server at all. Whoever is on the decks can talk over the music, and a listener
can put a hand up and be brought on air to say something themselves.

There is no account and nothing to sign up for. A listener picks a name when
they arrive and it is kept in their own browser. Listening is free.

## Pages

- [The station, and what it is](${base}/): what chunky.fm is, why it exists, and when the next session is.
- [Tune in](${base}/listen): the station itself. An application; there is nothing to read here.

## Notes

- chunky.fm is one station and one room, on purpose. It is not a platform, it
  hosts no other broadcasters, and it takes no uploads from listeners.
- The station may be private. When it is, a link with a key in it is needed to
  hear it, and the page above still describes it to anybody.
`
}

export function crawlRoutes(): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    // An hour. Long enough that a crawler asking twice in a morning is answered
    // from a cache, short enough that a station which has just moved to its own
    // domain is not handing out the old one for a week.
    const cache = 'public, max-age=3600'

    app.get('/robots.txt', async (request, reply) =>
      reply.type('text/plain; charset=utf-8').header('cache-control', cache).send(robots(origin(request))),
    )

    app.get('/sitemap.xml', async (request, reply) =>
      reply.type('application/xml; charset=utf-8').header('cache-control', cache).send(sitemap(origin(request))),
    )

    app.get('/llms.txt', async (request, reply) =>
      reply.type('text/plain; charset=utf-8').header('cache-control', cache).send(llms(origin(request))),
    )
  }
}
