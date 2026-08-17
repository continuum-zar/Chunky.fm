import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Config } from '../config.js'
import { requireCoHost } from '../lib/auth.js'
import type { Station } from '../station.js'
import { MAX_BLEND_MS } from '../transition.js'

interface TransitionDeps {
  config: Config
  station: Station
}

interface BlendBody {
  blendMs?: unknown
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['blendMs'],
  properties: {
    // Clamped at the station as well, which is what makes a slider dragged to
    // the end of its travel a fader that stops rather than a request that 400s.
    // The bounds here are only to keep something absurd out of the arithmetic.
    blendMs: { type: 'integer', minimum: 0, maximum: MAX_BLEND_MS },
  },
} as const

/**
 * How long one record overlaps the next.
 *
 * Reads are open, like `/api/mic` and `/api/session`: every browser needs the
 * number to run the crossfade itself, the socket volunteers it a moment later
 * anyway, and it is not a secret. Changing it is what needs a credential.
 *
 * Co-host rather than admin, and that is the point of the seat. Deciding how
 * one record becomes the next is the most hands-on thing about running a set,
 * and it is exactly the sort of judgement the person watching the queue should
 * be able to make without asking. It also cannot break anything: the worst
 * setting here is a transition somebody dislikes, and the next one is three
 * seconds away.
 */
export function transitionRoutes({ config, station }: TransitionDeps): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    app.get('/api/transition', async () => station.transition.snapshot())

    app.post<{ Body: BlendBody }>(
      '/api/transition',
      { preHandler: requireCoHost(config), schema: { body: BODY_SCHEMA } },
      async (request, reply) => {
        const { blendMs } = request.body
        if (typeof blendMs === 'number') station.transition.set(blendMs)
        // The snapshot the station now holds, which is not always the one that
        // was asked for: it is clamped in `Transition.set`, and a slider that
        // reads its own answer back stays honest about where it actually is.
        return reply.code(200).send(station.transition.snapshot())
      },
    )
  }
}
