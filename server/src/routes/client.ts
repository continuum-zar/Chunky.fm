import fs from 'node:fs/promises'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify'
import type { Config } from '../config.js'
import { doorway } from '../lib/doorway.js'

/**
 * The two documents Vite builds, held in memory.
 *
 * Read once at boot rather than off disk per request: they are a couple of
 * kilobytes each, they cannot change under a running process (the image is
 * built with them in it), and having them in hand before the error handlers are
 * registered is what lets the app shell be the fallback for an unknown path.
 *
 * Read failure is fatal on purpose. A server told where the client is and
 * unable to find it would otherwise come up healthy and answer every page with
 * a 404, which looks like a routing bug and is actually a build that shipped
 * without its client.
 */
export interface ClientBundle {
  /** The station. Vite's `index.html` entry. */
  index: Buffer
  /** The page in front of it. Vite's `landing.html` entry. */
  landing: Buffer
  /** How it works. Vite's `how-it-works.html` entry; prose, and no bundle. */
  how: Buffer
  /**
   * The co-host's control surface. Vite's `cohost.html` entry.
   *
   * Required like the other three rather than optional like the 404 page,
   * because it is a document with a bundle behind it: a build that shipped
   * without it would come up healthy and answer a co-host link with a 404,
   * which is the same class of wrong as shipping without the station.
   */
  cohost: Buffer
  /**
   * What an address that is nothing gets, or null if the build predates it.
   *
   * Optional where the three documents above are required, and for the same
   * reason the favicon is: a station that cannot find its 404 page should say
   * so in JSON and stay on the air, not refuse to boot. A missing *document* is
   * a build that shipped without its client, which is a different kind of wrong.
   */
  notFound: Buffer | null
  /**
   * The handful of files that have to answer on their own name.
   *
   * Everything else the client ships is under `/assets/` with a hash in it,
   * which is what makes it cacheable forever. These cannot be: the address of
   * a card is written into the document as an absolute URL, and something
   * fetching it is a machine on the other side of the internet that has no
   * idea what a content hash is. So they sit at the root, unhashed, and this is
   * what stops them being answered with the app shell — which is what an
   * unknown path gets, and which would have made the preview image a page of
   * HTML that every unfurler quietly gave up on.
   */
  root: Map<string, { body: Buffer; type: string }>
}

/**
 * What is served from the root, and what each one is.
 *
 * A list rather than a directory read, because the alternative is serving
 * whatever happens to be in the build output at the top level — and the build
 * output's top level also contains the two documents, which are already served
 * by the doorway with rules of their own about caching and redirects.
 */
const ROOT_FILES: Record<string, string> = {
  'og.png': 'image/png',
  'apple-touch-icon.png': 'image/png',
  'favicon.svg': 'image/svg+xml',
}

export async function loadClientBundle(clientDir: string): Promise<ClientBundle> {
  const read = async (name: string): Promise<Buffer> => {
    try {
      return await fs.readFile(path.join(clientDir, name))
    } catch (cause) {
      throw new Error(
        `CLIENT_DIR is ${clientDir} but ${name} is not in it: the client was not built into this image`,
        { cause },
      )
    }
  }
  const [index, landing, how, cohost] = await Promise.all([
    read('index.html'),
    read('landing.html'),
    read('how-it-works.html'),
    read('cohost.html'),
  ])

  // See `notFound` above for why this one is allowed to be absent.
  let notFound: Buffer | null = null
  try {
    notFound = await fs.readFile(path.join(clientDir, '404.html'))
  } catch {
    // A build from before the page existed.
  }

  // Optional, unlike the documents above, and deliberately: a station with no
  // favicon is a station with no favicon, and refusing to boot over one would
  // take a broadcast off the air for a picture. A missing document is a build
  // that shipped without its client, which is a different kind of wrong.
  const root = new Map<string, { body: Buffer; type: string }>()
  await Promise.all(
    Object.entries(ROOT_FILES).map(async ([name, type]) => {
      try {
        root.set(name, { body: await fs.readFile(path.join(clientDir, name)), type })
      } catch {
        // Not built, or not built yet. `npm run assets:og` makes them.
      }
    }),
  )

  return { index, landing, how, cohost, notFound, root }
}

/**
 * Send a document. Never cached: the filenames inside it are hashed and cached
 * forever, so this is the one response that has to be re-fetched for a deploy
 * to be visible at all.
 */
export function sendDocument(reply: FastifyReply, html: Buffer): FastifyReply {
  return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html)
}

/**
 * The front door, as a hook rather than a pair of routes.
 *
 * Registered at the root so it sees every request before routing does, which is
 * the same shape nginx has and the reason the two stay comparable: the rules are
 * about *addresses*, not about handlers, and `/welcome` is not a thing this
 * server offers so much as a thing it forwards. A `pass` decision calls `done`
 * and the request carries on to whatever route was going to answer it.
 */
export function doorwayHook(bundle: ClientBundle) {
  return function onRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    // GET and HEAD only. The doorway is about documents, and a POST to `/` is a
    // client holding the API wrong; better a 404 from the router than a
    // landing page with a 200 on it.
    if (request.method !== 'GET' && request.method !== 'HEAD') return done()

    const decision = doorway(request.url)
    switch (decision.kind) {
      case 'redirect':
        void reply.redirect(decision.location, decision.status)
        return
      case 'landing':
        void sendDocument(reply, bundle.landing)
        return
      case 'how':
        void sendDocument(reply, bundle.how)
        return
      case 'cohost':
        void sendDocument(reply, bundle.cohost)
        return
      case 'pass':
        return done()
    }
  }
}

interface ClientDeps {
  config: Config
  /** The documents and the root files, already read. See `loadClientBundle`. */
  bundle: ClientBundle
}

/**
 * Serving the client's assets from the same process that serves the API.
 *
 * Only registered in the single-image deployment: `config.clientDir` is null
 * under compose, where nginx does this job, and in development, where Vite
 * does. What this is, together with `doorwayHook` and the app-shell fallback in
 * `lib/errors.ts`, is nginx.conf's static half rewritten in Fastify; the rules
 * they enforce are `lib/doorway.ts`, which explains why there are three copies.
 *
 * Deliberately outside the listener gate, exactly as nginx is. A private
 * station refuses the socket, the library and the media, the things that *are*
 * the station, and not the documents: the page has to load in order to redeem
 * the key in its own address bar, and a gate in front of it would refuse every
 * invite before it could be presented.
 */
export function clientRoutes({ config, bundle }: ClientDeps): FastifyPluginAsync {
  const clientDir = config.clientDir
  if (clientDir === null) {
    throw new Error('clientRoutes registered without a clientDir')
  }

  return async function routes(app: FastifyInstance) {
    // Hashed filenames, so this is safe to cache hard and has to be: it is the
    // whole of the bundle, the fonts, the artwork and the 1 MB gramophone.
    await app.register(fastifyStatic, {
      root: path.join(clientDir, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
      cacheControl: true,
      maxAge: '365d',
      immutable: true,
      index: false,
      dotfiles: 'deny',
    })

    // A day. These are unhashed, so a change has to be able to reach a cache
    // eventually; and the things that fetch a card cache it for far longer than
    // this anyway, so a shorter number would buy nothing and cost requests.
    for (const [name, file] of bundle.root) {
      app.get(`/${name}`, async (_request, reply) =>
        reply.type(file.type).header('cache-control', 'public, max-age=86400').send(file.body),
      )
    }
  }
}
