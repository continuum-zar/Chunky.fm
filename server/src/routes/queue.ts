import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Config } from '../config.js'
import type { Db, TrackRow } from '../db.js'
import { requireAdmin, requireCoHost } from '../lib/auth.js'
import { toTrack } from '../lib/track.js'
import type { Station } from '../station.js'

interface QueueDeps {
  config: Config
  db: Db
  station: Station
}

interface AddBody {
  trackId?: unknown
}

interface MoveBody {
  entryId?: unknown
  toIndex?: unknown
}

const ADD_SCHEMA = {
  type: 'object',
  required: ['trackId'],
  properties: { trackId: { type: 'integer', minimum: 1 } },
} as const

const MOVE_SCHEMA = {
  type: 'object',
  required: ['entryId', 'toIndex'],
  properties: {
    entryId: { type: 'integer', minimum: 1 },
    // Clamped server-side: an admin dragging to the end of a queue that just
    // advanced shouldn't get a 400 for being one row optimistic.
    toIndex: { type: 'integer', minimum: 0 },
  },
} as const

const ENTRY_PARAMS_SCHEMA = {
  type: 'object',
  required: ['entryId'],
  properties: { entryId: { type: 'integer', minimum: 1 } },
} as const

/**
 * What's coming up. Reads are open, since listeners get the same queue over the
 * websocket anyway.
 *
 * Every mutation used to be admin-only and now most of them are one rung down,
 * behind the co-host seat. *Deciding what plays next is the co-host's whole
 * job* — the seat exists so somebody on a phone can watch the room and line
 * records up while whoever runs the decks does something else — and a seat that
 * could not touch the queue would be a microphone with a job title.
 *
 * `DELETE /api/queue` is the exception and stays admin-only. Adding, moving and
 * dropping a record are all one row, visible, and undone by doing the opposite;
 * emptying the queue is the whole of somebody's prepared set gone with one tap
 * on a phone that is going in a pocket. The asymmetry is deliberate: the seat
 * gets everything that is recoverable and nothing that is not.
 *
 * Entries are addressed by entry id rather than position, because the queue
 * shifts by itself when a track ends: an index the UI read a second ago may
 * already point at a different track.
 */
export function queueRoutes({ config, db, station }: QueueDeps): FastifyPluginAsync {
  const findTrack = (id: number) =>
    db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined

  return async function routes(app: FastifyInstance) {
    const admin = { preHandler: requireAdmin(config) }
    // The seat, which the console also satisfies: admin ⊃ co-host, so nothing
    // here needs a second rule for whoever holds the password.
    const seat = { preHandler: requireCoHost(config) }
    const entries = () => ({ entries: station.queue.list() })

    app.get('/api/queue', async () => entries())

    app.post<{ Body: AddBody }>(
      '/api/queue',
      { ...seat, schema: { body: ADD_SCHEMA } },
      async (request, reply) => {
        const { trackId } = request.body
        const row = typeof trackId === 'number' ? findTrack(trackId) : undefined
        if (!row) {
          return reply.code(404).send({ error: 'unknown_track', message: `no track ${trackId}` })
        }

        // On an idle station this starts playing immediately (see
        // Station.enqueue), so the entry may already be off the queue by the
        // time we answer. That's why the entry is reported alongside it.
        const entry = station.enqueue(toTrack(row))
        return reply.code(201).send({ entry, ...entries() })
      },
    )

    app.post<{ Body: MoveBody }>(
      '/api/queue/move',
      { ...seat, schema: { body: MOVE_SCHEMA } },
      async (request, reply) => {
        const { entryId, toIndex } = request.body
        const moved =
          typeof entryId === 'number' && typeof toIndex === 'number'
            ? station.queue.move(entryId, toIndex)
            : null
        if (!moved) {
          return reply.code(404).send({ error: 'unknown_entry', message: `no entry ${entryId}` })
        }
        return reply.code(200).send({ entry: moved, ...entries() })
      },
    )

    app.delete<{ Params: { entryId: number } }>(
      '/api/queue/:entryId',
      { ...seat, schema: { params: ENTRY_PARAMS_SCHEMA } },
      async (request, reply) => {
        const removed = station.queue.remove(request.params.entryId)
        if (!removed) {
          return reply
            .code(404)
            .send({ error: 'unknown_entry', message: `no entry ${request.params.entryId}` })
        }
        return reply.code(200).send({ entry: removed, ...entries() })
      },
    )

    app.delete('/api/queue', admin, async () => {
      station.queue.clear()
      return entries()
    })
  }
}
