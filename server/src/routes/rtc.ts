import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Config } from '../config.js'
import { requireListener } from '../lib/auth.js'
import type { CloudflareTurn } from '../turn.js'

interface RtcDeps {
  config: Config
  /** Cloudflare's relay, when one is configured. See `CloudflareTurn`. */
  turn?: CloudflareTurn | null
}

/** What an `RTCPeerConnection` takes, in the shape it takes it. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export function iceServers(config: Config): IceServer[] {
  const servers: IceServer[] = []
  // One entry with every URL rather than one entry each: that is the shape the
  // browser prefers, and it lets it try them in parallel.
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls })
  if (config.turn) {
    servers.push({
      urls: config.turn.urls,
      username: config.turn.username,
      credential: config.turn.credential,
    })
  }
  return servers
}

/**
 * How to reach another browser.
 *
 * Behind the listener gate rather than baked into the client bundle, and that
 * is the only reason this is an endpoint at all: a TURN credential in a
 * JavaScript file is a relay anybody who loads the page can spend, indefinitely
 * and from anywhere. Served per request, it reaches exactly the people already
 * allowed to hear the station.
 *
 * The listener gate rather than the admin one because both ends of a voice need
 * this: the decks to offer it and the listener to answer. On an open station
 * that gate admits everybody, which is the same set of people who can already
 * hear the music.
 *
 * If you run your own coturn, prefer its REST scheme — a username of
 * `<expiry>:<name>` and an HMAC of it as the credential — over a static
 * password. It is a few lines there and it means an answer to this that leaks
 * is worth nothing in an hour.
 */
export function rtcRoutes({ config, turn = null }: RtcDeps): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    app.get('/api/rtc', { preHandler: requireListener(config) }, async () => {
      // Configured addresses first, then anything minted. Order is not a
      // preference — a browser tries them all — but keeping the station's own
      // settings ahead of a third party's reads better in a log.
      const minted = turn ? await turn.servers() : []
      return { iceServers: [...iceServers(config), ...minted] }
    })
  }
}
