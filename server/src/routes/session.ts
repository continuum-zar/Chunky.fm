import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { OnAir } from '../air.js'
import type { Config } from '../config.js'
import { requireAdmin } from '../lib/auth.js'

interface SessionDeps {
  config: Config
  air: OnAir
}

interface CommandBody {
  action?: unknown
  kind?: unknown
}

/**
 * `kind` is optional and means `set` when it is missing, which is what every
 * caller written before there were two kinds of night meant by saying nothing.
 * It is only read on `start`: a session's kind is decided when it opens and
 * cannot be changed under a room that has already been told what it walked
 * into. See `OnAir.goLive`.
 */
const BODY_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['start', 'end'] },
    kind: { type: 'string', enum: ['set', 'talk'] },
  },
} as const

/**
 * Going live, and ending it: PLAN.md's availability decision, as two verbs.
 *
 * Over HTTP behind `requireAdmin`, like every other mutation, and for the same
 * reason: the socket has no privileged frame to authenticate. `go_live` and
 * `end_session` are refused by name if they arrive on it (see `protocol.ts`).
 *
 * `GET` is deliberately open. Whether there is a station tonight is not a
 * secret: it is the first thing a listener's page needs to know, and it also
 * arrives unasked on the socket. What is behind the gate is *changing* it.
 */
export function sessionRoutes({ config, air }: SessionDeps): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    app.get('/api/session', async () => air.snapshot())

    app.post<{ Body: CommandBody }>(
      '/api/session',
      { preHandler: requireAdmin(config), schema: { body: BODY_SCHEMA } },
      async (request, reply) => {
        // Both verbs are idempotent; see OnAir. Ending an already-ended
        // session answers 200 with the same snapshot rather than a conflict:
        // the caller wanted the station off air, and it is.
        const snapshot =
          request.body.action === 'start'
            ? air.goLive(request.body.kind === 'talk' ? 'talk' : 'set')
            : air.end()
        // The websocket broadcast has already gone out by here.
        return reply.code(200).send(snapshot)
      },
    )
  }
}
