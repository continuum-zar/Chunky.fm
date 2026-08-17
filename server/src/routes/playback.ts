import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Config } from '../config.js'
import type { Db, TrackRow } from '../db.js'
import { hasAdminCredentials, requireCoHost } from '../lib/auth.js'
import { toTrack } from '../lib/track.js'
import type { Station } from '../station.js'

interface PlaybackDeps {
  config: Config
  db: Db
  station: Station
}

interface CommandBody {
  action?: unknown
  trackId?: unknown
  positionMs?: unknown
}

const BODY_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['play', 'pause', 'resume', 'seek', 'stop', 'skip', 'blend'],
    },
    trackId: { type: 'integer', minimum: 1 },
    positionMs: { type: 'integer', minimum: 0 },
  },
} as const

/**
 * The verbs a console reaches for, on two rungs.
 *
 * `SEAT_ACTIONS` are the ones the co-host has: moving the record along, and
 * nothing that puts a different one on. The dividing line is not danger, it is
 * *what the room is looking at*. Pausing, resuming, skipping and blending all
 * act on the record already playing, which is the one the co-host can see, has
 * been talking over, and is watching run out. `play`, `seek` and `stop` reach
 * past it — into the library, into the middle of a track, into an empty deck —
 * and those are the decks' own, because the person holding them is the person
 * who can see the whole set.
 */
const SEAT_ACTIONS = new Set(['pause', 'resume', 'skip', 'blend'])

/**
 * Driving the decks by hand: the verbs PlaybackState has, plus `skip`, which is
 * the same hard advance the end-of-track timer used to perform, and `blend`,
 * which is the crossfading one it performs now. What's queued up behind the
 * current track lives at /api/queue.
 *
 * The two advances are deliberately different verbs rather than one with a
 * flag. Skipping is *this record is over*, and folding four seconds of it into
 * the next one is the opposite of what somebody reaching for skip asked for.
 * Blending is *take us into the next one*, which is a transition somebody is
 * performing. Same destination, opposite intentions, and a client that had to
 * pick a boolean would get it wrong in the direction that is audible.
 */
export function playbackRoutes({ config, db, station }: PlaybackDeps): FastifyPluginAsync {
  const { playback } = station
  const findTrack = (id: number) =>
    db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined

  return async function routes(app: FastifyInstance) {
    app.get('/api/playback', async () => playback.snapshot())

    app.post<{ Body: CommandBody }>(
      '/api/playback',
      { preHandler: requireCoHost(config), schema: { body: BODY_SCHEMA } },
      async (request, reply) => {
        const { action, trackId, positionMs } = request.body

        // The gate above admits the seat; this is the half of it the seat does
        // not get. Checked here rather than as a second preHandler because it
        // depends on the body, and a route split in two would be two places for
        // the verb list to drift from.
        if (
          typeof action === 'string' &&
          !SEAT_ACTIONS.has(action) &&
          !hasAdminCredentials(config, request.headers)
        ) {
          return reply.code(403).send({
            error: 'not_the_decks',
            message: `co-hosts may pause, resume, skip and blend. \`${action}\` is the decks'`,
          })
        }

        switch (action) {
          case 'play': {
            if (typeof trackId !== 'number') {
              return reply
                .code(400)
                .send({ error: 'missing_track', message: 'play requires a trackId' })
            }
            const row = findTrack(trackId)
            if (!row) {
              return reply.code(404).send({ error: 'unknown_track', message: `no track ${trackId}` })
            }
            playback.play(toTrack(row), typeof positionMs === 'number' ? positionMs : 0)
            break
          }
          case 'pause':
            playback.pause()
            break
          case 'resume':
            playback.resume()
            break
          case 'seek': {
            if (typeof positionMs !== 'number') {
              return reply
                .code(400)
                .send({ error: 'missing_position', message: 'seek requires a positionMs' })
            }
            playback.seek(positionMs)
            break
          }
          case 'stop':
            playback.stop()
            break
          case 'skip':
            // Off air when the queue is empty: skipping the last track is
            // the end of the set, not a reason to replay anything.
            station.advance()
            break
          case 'blend':
            // Falls back to a hard cut on its own when there is nothing to fade
            // — an empty queue, a paused deck, a blend length of zero — so the
            // button on the phone never has to ask first. See `Station.blend`.
            station.blend()
            break
        }

        // The websocket broadcast has already gone out by here.
        return reply.code(200).send(playback.snapshot())
      },
    )
  }
}
