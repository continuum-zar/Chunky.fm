import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { OnAir } from '../air.js'
import type { Config } from '../config.js'
import { requireAdmin } from '../lib/auth.js'
import { MIN_DUCK, type Mic } from '../mic.js'

interface MicDeps {
  config: Config
  mic: Mic
  air: OnAir
}

interface MicBody {
  action?: unknown
  duckTo?: unknown
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['open', 'renew', 'close', 'duck'] },
    duckTo: { type: 'number', minimum: MIN_DUCK, maximum: 1 },
  },
} as const

/**
 * The mic, as four verbs.
 *
 * Over HTTP behind `requireAdmin`, like every other mutation, and for the same
 * reason: the socket has no privileged frame to authenticate, so `mic` is
 * refused by name if it arrives on one (see `protocol.ts`). It feels like it
 * ought to be a socket frame — it is the most live thing on the console — and
 * that feeling is exactly what the rule exists to resist.
 *
 * `GET` is deliberately open, like `/api/session`. Whether somebody is talking
 * is not a secret; it arrives unasked on the socket a moment later anyway.
 * What is behind the gate is *changing* it.
 *
 * `renew` is separate from `open` because the console holds a lease and beats
 * on a timer. One verb for both would let a keep-alive still in flight when
 * somebody let go of the key reopen the mic behind them.
 */
export function micRoutes({ config, mic, air }: MicDeps): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    app.get('/api/mic', async () => mic.snapshot())

    app.post<{ Body: MicBody }>(
      '/api/mic',
      { preHandler: requireAdmin(config), schema: { body: BODY_SCHEMA } },
      async (request, reply) => {
        const { action } = request.body

        switch (action) {
          case 'open': {
            // Refused off air, the way a message and a wish are: there is no
            // broadcast to talk over, and a mic that could be opened with the
            // station shut would leave the room ducked the moment it opened.
            if (!air.live) {
              return reply
                .code(409)
                .send({ error: 'off_air', message: 'the station is not on air' })
            }
            mic.open()
            break
          }
          case 'renew': {
            // Answers 200 either way. A renew that arrives just after the mic
            // shut has nothing to keep alive, and that is the ordinary end of
            // every mic break rather than a failure worth a status code; the
            // snapshot below already says the mic is shut, which is what the
            // console needs to know.
            mic.renew()
            break
          }
          case 'close':
            mic.close()
            break
          case 'duck': {
            if (typeof request.body.duckTo !== 'number') {
              return reply
                .code(400)
                .send({ error: 'missing_duck', message: 'duck requires a duckTo' })
            }
            mic.duck(request.body.duckTo)
            break
          }
        }

        // What the station now holds, not what was asked for: `duck` clamps,
        // so answering with the request would let the slider show a depth the
        // station does not have. The websocket broadcast has already gone out.
        return reply.code(200).send(mic.snapshot())
      },
    )
  }
}
