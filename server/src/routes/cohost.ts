import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { OnAir } from '../air.js'
import type { CoHost } from '../cohost.js'
import type { Config } from '../config.js'
import {
  clearedCoHostCookie,
  coHostCookie,
  hasCoHostCredentials,
  isSecureRequest,
  isValidCoHostKey,
  issueCoHostSession,
  requireAdmin,
  requireCoHost,
} from '../lib/auth.js'
import { KeyedRateLimit } from '../lib/rate-limit.js'

interface CoHostDeps {
  config: Config
  coHost: CoHost
  /** Whether the station is broadcasting. The seat is refused off air. */
  air: OnAir
  /** Wrong keys allowed from one address back to back. */
  redeemBurst?: number
  /** How long one of those costs to earn back. */
  redeemRefillMs?: number
}

/**
 * Tighter than the door's throttle and looser than the admin sign-in's.
 *
 * A wrong co-host key is not the same event as a wrong station key. The station
 * key goes out to everybody invited and is mistyped constantly by people who
 * were meant to have it; this one goes to a single person, in a single link, so
 * a run of failures here is much more likely to be somebody working through the
 * alphabet than a friend fumbling a code. Five a minute is generous for one
 * phone with a stale link and mean to anything else.
 *
 * **Only a wrong key costs anything.** The bucket exists to stop guessing, and
 * a correct key is not a guess — so a browser presenting a working link is
 * never paced, however many times it does it. Charging for success is how a
 * brute-force limit turns into a self-lockout: a co-host who opens their own
 * link a few times while getting set up would find the seat shut against them
 * at nine o'clock, by a rule written for somebody else entirely.
 */
const DEFAULT_REDEEM_BURST = 5
const DEFAULT_REDEEM_REFILL_MS = 60_000

interface RedeemBody {
  key?: unknown
}

const REDEEM_SCHEMA = {
  type: 'object',
  required: ['key'],
  properties: { key: { type: 'string', minLength: 1, maxLength: 512 } },
} as const

interface SeatBody {
  action?: unknown
  socket?: unknown
  nickname?: unknown
}

const SEAT_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['take', 'renew', 'leave'] },
    socket: { type: 'integer', minimum: 1 },
    nickname: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const

/**
 * The seat, and the key that opens it.
 *
 * Shaped like `listenRoutes` one rung up: a co-host presents the key once (out
 * of the `?k=` on the link they were sent) and gets back a signed HttpOnly
 * cookie the browser presents from then on. The key never sits in the page
 * afterwards, so the link can be forwarded without the receiving browser having
 * to keep the secret anywhere script can read.
 *
 * What is different, and what the whole of this file is really about, is that
 * holding the key is not the same as being in the seat. Redeeming gives a
 * browser the *right* to co-host. `POST /api/cohost/seat` is the co-host
 * deciding to actually go on air, and it is separate for two reasons that both
 * matter on a phone: somebody opening the page in a taxi to see what is on
 * should not be put in front of the room by loading a URL, and the console
 * needs a socket id to offer a microphone to — which a cookie does not carry
 * and a page can only learn once it has connected.
 *
 * Hence the odd-looking `socket` field. The cookie says *may this browser
 * co-host*; the socket id says *which connection is it*. The station checks
 * both, and refuses an id that never presented a co-host key on its upgrade, so
 * a listener cannot put somebody else in the seat by naming their id. See
 * `RealtimeHandle.isCoHostSocket`.
 */
export function coHostRoutes({
  config,
  coHost,
  air,
  redeemBurst = DEFAULT_REDEEM_BURST,
  redeemRefillMs = DEFAULT_REDEEM_REFILL_MS,
}: CoHostDeps): FastifyPluginAsync {
  const throttle = new KeyedRateLimit({ burst: redeemBurst, refillMs: redeemRefillMs })

  return async function routes(app: FastifyInstance) {
    const seat = { preHandler: requireCoHost(config) }

    /**
     * Does this browser hold a seat? Asked once on load, before the page opens
     * a socket, for the reason `/api/listen` is: a page that connected first
     * would spend its life reconnecting into a refusal.
     */
    app.get('/api/cohost/session', async (request, reply) => {
      if (!hasCoHostCredentials(config, request.headers)) {
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: 'co-host credentials required' })
      }
      return reply.code(204).send()
    })

    app.post<{ Body: RedeemBody }>(
      '/api/cohost/session',
      { schema: { body: REDEEM_SCHEMA } },
      async (request, reply) => {
        const secure = isSecureRequest(request)

        // The compare first, and the bucket only on the way past it. See the
        // note on the burst above: a correct key is not a guess and is never
        // paced. `isValidCoHostKey` is a constant-time compare, so ordering it
        // ahead of the throttle leaks nothing a timer could read.
        if (!isValidCoHostKey(config, request.body.key)) {
          if (!throttle.take(request.ip)) {
            request.log.warn({ ip: request.ip }, 'co-host key redemption throttled')
            return reply
              .header('set-cookie', clearedCoHostCookie(secure))
              .code(429)
              .send({ error: 'slow_down', message: 'too many tries. Wait a minute and try again' })
          }
          return reply
            .header('set-cookie', clearedCoHostCookie(secure))
            .code(401)
            .send({ error: 'unauthorized', message: 'that link is not a co-host link for this station' })
        }

        const session = issueCoHostSession(config.coHostKey)
        return reply.header('set-cookie', coHostCookie(session, secure)).code(204).send()
      },
    )

    /**
     * Hand the key back: this browser stops being able to co-host.
     *
     * Deliberately does *not* empty the seat, which looks like an oversight and
     * is not. This request carries a cookie and no connection, so it cannot
     * tell whether the browser sending it is the one currently on air — and a
     * stale tab signing itself out would otherwise take a co-host off the air
     * mid-sentence from another device. Standing up is
     * `POST /api/cohost/seat {action: 'leave'}`, which names a socket; the page
     * sends that first, and the socket closing covers it if the page did not.
     */
    app.delete('/api/cohost/session', async (request, reply) =>
      reply.header('set-cookie', clearedCoHostCookie(isSecureRequest(request))).code(204).send(),
    )

    /** Who is in the seat. Open, like `/api/session` and `/api/floor`. */
    app.get('/api/cohost', async () => coHost.snapshot())

    app.post<{ Body: SeatBody }>(
      '/api/cohost/seat',
      { ...seat, schema: { body: SEAT_SCHEMA } },
      async (request, reply) => {
        const { action, socket, nickname } = request.body

        if (action === 'leave') {
          // By id when one was given, so a stale page cannot stand up whoever
          // replaced it; wholesale when none was, which is the console taking
          // the seat back. Both are idempotent, so a double tap is not an error.
          coHost.leave(typeof socket === 'number' ? socket : null)
          return reply.code(200).send(coHost.snapshot())
        }

        if (typeof socket !== 'number') {
          return reply
            .code(400)
            .send({ error: 'missing_socket', message: 'taking the seat needs the socket it is on' })
        }

        // The cookie says this browser may co-host. This says the connection it
        // named is one that presented a co-host key on the way in — without it,
        // anybody holding a seat could put any listener on the air by guessing
        // an id, and the room would hear whoever was actually on that socket.
        if (!app.realtime.isCoHostSocket(socket)) {
          return reply.code(409).send({
            error: 'unknown_socket',
            message: 'that connection is not a co-host connection. Reload the page',
          })
        }

        if (action === 'renew') {
          if (!coHost.renew(socket)) {
            return reply
              .code(409)
              .send({ error: 'not_seated', message: 'that connection does not hold the seat' })
          }
          return reply.code(200).send(coHost.snapshot())
        }

        // Refused off air, and this is the one refusal here that is about the
        // evening rather than about credentials. Taking the seat opens a
        // microphone into a room that does not exist yet: the console would
        // offer a voice connection to somebody nobody can hear, and the seat
        // would be swept away the moment a session did start, since ending one
        // clears it. Whoever runs the decks opens the doors.
        if (!air.live) {
          return reply
            .code(409)
            .send({ error: 'off_air', message: 'the station is not on air yet' })
        }

        const called = typeof nickname === 'string' ? nickname.trim() : ''
        if (!coHost.take(socket, called === '' ? 'co-host' : called)) {
          // Idempotent for whoever already holds it, so the only way here is
          // somebody else being in it. Said plainly rather than as a 403: this
          // is a room with one other chair in it, not a permission problem.
          if (coHost.seat?.id !== socket) {
            return reply.code(409).send({
              error: 'seat_taken',
              message: `${coHost.seat?.nickname ?? 'somebody'} is already co-hosting`,
            })
          }
        }
        return reply.code(200).send(coHost.snapshot())
      },
    )

    /**
     * The co-host key, for whoever runs the decks, so the console can build a
     * link to send.
     *
     * Admin-only, and that is the whole policy: a co-host's own browser cannot
     * rebuild the link (the cookie is HttpOnly and the key came out of the
     * address bar on arrival), so the only way to be given the seat is for the
     * person with the password to hand it over. A co-host who could read this
     * could quietly recruit a third.
     *
     * The link itself is assembled in the browser, like the invite: the station
     * does not reliably know what address it is being reached on, and the
     * console's address bar does.
     */
    app.get('/api/cohost/key', { preHandler: requireAdmin(config) }, async () => ({
      key: config.coHostKey,
    }))
  }
}
