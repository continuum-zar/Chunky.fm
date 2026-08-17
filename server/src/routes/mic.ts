import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { OnAir } from '../air.js'
import type { Config } from '../config.js'
import type { Floor } from '../floor.js'
import { hasAdminCredentials, requireCoHost } from '../lib/auth.js'
import { MIN_DUCK, type Mic, type MicHolder } from '../mic.js'

interface MicDeps {
  config: Config
  mic: Mic
  air: OnAir
  /** Who else is on the mic, which is the one thing `close` has to know about. */
  floor: Floor
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
 * The mic, as four verbs, on two rungs.
 *
 * Over HTTP, like every other mutation, and for the same reason: the socket has
 * no privileged frame to authenticate, so `mic` is refused by name if it
 * arrives on one (see `protocol.ts`). It feels like it ought to be a socket
 * frame — it is the most live thing on the console — and that feeling is
 * exactly what the rule exists to resist.
 *
 * `GET` is deliberately open, like `/api/session`. Whether somebody is talking
 * is not a secret; it arrives unasked on the socket a moment later anyway.
 * What is behind the gate is *changing* it.
 *
 * `renew` is separate from `open` because whoever is talking holds a lease and
 * beats on a timer. One verb for both would let a keep-alive still in flight
 * when somebody let go of the key reopen the mic behind them.
 *
 * Three of the four are the co-host's as well, because a seat that cannot open
 * a microphone is not a seat. **Which of them is asking matters**, and it is
 * the only thing on this route that reads the credential twice: the mic is open
 * while anybody is holding it, each with their own lease, so a co-host
 * releasing their talk key must let go of *their* grip rather than shutting the
 * mic on a sentence the decks are still in the middle of. See `MicHolder`.
 *
 * `duck` stays admin-only, and it is the odd one out on purpose. The other
 * three are somebody saying what they themselves are doing. How far the music
 * sits under a voice is a decision about how the station sounds, it is set once
 * and left, and it is the sort of thing that should be changed by the person
 * who can hear the room mix rather than by the person on a phone hearing their
 * own monitor.
 */
export function micRoutes({ config, mic, air, floor }: MicDeps): FastifyPluginAsync {
  return async function routes(app: FastifyInstance) {
    app.get('/api/mic', async () => mic.snapshot())

    app.post<{ Body: MicBody }>(
      '/api/mic',
      { preHandler: requireCoHost(config), schema: { body: BODY_SCHEMA } },
      async (request, reply) => {
        const { action } = request.body
        // Whoever runs the decks is a co-host too — admin ⊃ co-host — so this
        // reads the *stronger* credential to decide which grip is being taken,
        // and everything that is not the decks is the seat.
        const decks = hasAdminCredentials(config, request.headers)
        const holder: MicHolder = decks ? 'decks' : 'cohost'

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
            mic.open(holder)
            break
          }
          case 'renew': {
            // Answers 200 either way. A renew that arrives just after the mic
            // shut has nothing to keep alive, and that is the ordinary end of
            // every mic break rather than a failure worth a status code; the
            // snapshot below already says the mic is shut, which is what the
            // console needs to know.
            mic.renew(holder)
            break
          }
          case 'close': {
            // Refused while somebody else is on the mic, and this is the one
            // rule on this route that is not about the mic at all.
            //
            // Shutting the mic drops whoever has the floor — that wiring is
            // what stops a room being un-ducked with a guest still talking
            // under it, and it is what a lapsed lease uses to clear a call the
            // console died in the middle of. But the console asks to close on
            // an ordinary hangover, four hundred milliseconds after the talk
            // key comes up, so without this the first thing whoever runs the
            // decks says to their caller is also what hangs up on them.
            //
            // The two are different acts and now have different verbs: closing
            // the mic ends your own break, and standing somebody down ends a
            // call. The sweep still closes directly and is unaffected, which is
            // what keeps a dead console from ducking the room all evening.
            //
            // A co-host is exempt from this one. The rule exists so that the
            // hangover after your own sentence does not hang up on your caller
            // — and a co-host letting go of their key does not shut the mic at
            // all when anybody else is still holding it, so there is nothing
            // for it to protect against. Applying it anyway would mean a
            // co-host who could never stop talking while a guest was up.
            if (decks && floor.speaker) {
              return reply.code(409).send({
                error: 'floor_taken',
                message: 'somebody is on the mic; stand them down to end the call',
              })
            }
            mic.close(holder)
            break
          }
          case 'duck': {
            if (!decks) {
              return reply.code(403).send({
                error: 'not_the_decks',
                message: 'how far the music ducks is set at the decks',
              })
            }
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
