import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { OnAir } from '../air.js'
import type { Config } from '../config.js'
import type { Floor, FloorSnapshot } from '../floor.js'
import { requireAdmin } from '../lib/auth.js'

interface FloorDeps {
  config: Config
  floor: Floor
  air: OnAir
}

interface FloorBody {
  action?: unknown
  listener?: unknown
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['invite', 'drop'] },
    /** A socket id, which is always a positive integer. See `Presence`. */
    listener: { type: 'integer', minimum: 1 },
  },
} as const

/**
 * The floor, as two verbs.
 *
 * Over HTTP behind `requireAdmin`, like every other mutation, while the
 * listener's half of the same conversation — raising a hand, accepting, coming
 * down — rides the socket alongside `say` and `wish`. That split is not
 * arbitrary and it is not new: a listener has no credentials, so the socket is
 * the only channel they have, and commands from the console go where the admin
 * gate is. This feature just happens to use both ends of the rule at once.
 *
 * `GET` is deliberately open, like `/api/mic` and `/api/session`. Who is on the
 * mic is not a secret; it arrives unasked on the socket a moment later anyway.
 * What is behind the gate is *changing* it. Note that the hands are not here at
 * all: they go to the decks over the socket and have no HTTP surface, because
 * an endpoint that listed who wants to talk would be one more place for that
 * list to leak out of.
 *
 * There is no verb for taking somebody up who did not ask. `Floor.invite`
 * refuses an id with no hand raised, which is what keeps this an answer to a
 * request rather than a station able to open a stranger's microphone.
 */
export function floorRoutes({ config, floor, air }: FloorDeps): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    app.get('/api/floor', async (): Promise<FloorSnapshot> => floor.snapshot())

    app.post<{ Body: FloorBody }>(
      '/api/floor',
      { preHandler: requireAdmin(config), schema: { body: BODY_SCHEMA } },
      async (request, reply) => {
        const { action } = request.body

        if (action === 'invite') {
          // Refused off air for the reason opening the mic is: there is no
          // broadcast to talk over, and somebody brought up with the doors shut
          // would be up in a room that does not exist.
          if (!air.live) {
            return reply
              .code(409)
              .send({ error: 'off_air', message: 'the station is not on air' })
          }
          if (typeof request.body.listener !== 'number') {
            return reply
              .code(400)
              .send({ error: 'missing_listener', message: 'invite needs a listener' })
          }
          // Told apart on the way in rather than left to one refusal, because
          // the two mean different things to whoever pressed the button:
          // somebody else is already up, or this hand went down while you were
          // reaching for it.
          if (floor.busy) {
            return reply
              .code(409)
              .send({ error: 'floor_taken', message: 'somebody already has the mic' })
          }
          if (!floor.invite(request.body.listener)) {
            return reply
              .code(409)
              .send({ error: 'no_hand', message: 'that listener has not asked for the mic' })
          }
        }

        if (action === 'drop') {
          // Answers 200 either way. A drop that arrives just after the guest
          // left has nothing to drop, and that is the ordinary end of a call
          // rather than a failure worth a status code — the snapshot below
          // already says nobody is up, which is what the console needs to know.
          floor.drop()
        }

        // What the station now holds, not what was asked for, exactly as the
        // mic answers with the depth it clamped to. The websocket broadcast has
        // already gone out.
        return reply.code(200).send(floor.snapshot())
      },
    )
  }
}
