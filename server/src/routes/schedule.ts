import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { Config } from '../config.js'
import type { SessionKind } from '../db.js'
import { requireAdmin } from '../lib/auth.js'
import { discard, posterFilePath } from '../lib/storage.js'
import type { Schedule } from '../schedule.js'

/**
 * Announcing the next session, and the poster that goes with it.
 *
 * The read is **open**, and deliberately: the whole point of a poster is to be
 * seen by somebody who is not in the room yet, and the page in front of the
 * station has no key to present. So this is the one thing about the station a
 * stranger can ask for. It carries a time and a picture and nothing else, which
 * is what makes that safe: no track, no nickname, no word anybody said.
 *
 * Writing it is admin-only, like every other write in this API.
 */

/** A poster is 1080x1350, Instagram's portrait post. This is that with room. */
const MAX_POSTER_BYTES = 8 * 1024 * 1024

/**
 * What a poster may be, and the extension it is stored under.
 *
 * The declared content type is a hint from whoever is uploading, so it is
 * checked against the first bytes of the file rather than believed. Not a
 * security boundary on its own (the file is served as an attachment-free static
 * asset either way) but it keeps a mistyped upload from becoming a poster that
 * no browser will draw.
 */
const POSTER_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function sniff(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head.length >= 8 && head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png'
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

/**
 * How long a title may be.
 *
 * A line on a poster rather than a description of the evening: it has to sit
 * under a time on the page in front of the station and inside the one line the
 * top bar has, and anything longer would be cut by a layout rather than by
 * something that could tell whoever typed it. Cut here instead, where the limit
 * is a rule somebody can read, and at a length that holds a theme ("Songs that
 * sound like forgiveness") or a name and what they do.
 */
const TITLE_MAX_LENGTH = 80

/**
 * A typed title as it goes into the database, or null for no title at all.
 *
 * Empty is null rather than an empty string: a field somebody cleared and a
 * field nobody filled in are the same announcement, and two spellings of it
 * would be two things every reader has to check for. Whitespace is collapsed
 * and control characters go with it, because this ends up in the markup of a
 * public page and inside an `alt`, and a newline in the middle of a poster
 * caption is somebody's paste of a whole paragraph arriving as a title.
 */
function toTitle(value: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().replace(/\s+/g, ' ')
  return clean.length > 0 ? clean.slice(0, TITLE_MAX_LENGTH) : null
}

interface ScheduleDeps {
  config: Config
  schedule: Schedule
}

export function scheduleRoutes({ config, schedule }: ScheduleDeps): FastifyPluginAsync {
  /**
   * The announcement as it goes over the wire, which is the same shape the
   * socket sends: a bare filename, not a URL. Tracks carry `filename` and
   * `artworkPath` the same way and the client turns both into addresses, so a
   * poster that arrived pre-addressed would be the one thing in this API that
   * did it the other way round.
   */
  const body = () => ({ schedule: schedule.get() })

  return async function routes(app: FastifyInstance) {
    // Open, and so is the poster below it. See the note at the top.
    app.get('/api/schedule', async () => body())

    await app.register(fastifyStatic, {
      root: config.posterDir,
      prefix: '/api/poster/',
      decorateReply: false,
      // Named by a fresh id every time one is set, so a URL never changes
      // under a page that has already drawn it.
      cacheControl: true,
      maxAge: '365d',
      immutable: true,
      index: false,
      dotfiles: 'deny',
    })

    /**
     * Announce the next session.
     *
     * Multipart because a poster comes with it, and one request rather than two
     * because a time with no picture and a picture with no time are both
     * half-announcements: an admin who uploaded and then failed to set the time
     * would have published a poster for nothing.
     *
     * The poster is optional on purpose. A time on its own is a real
     * announcement, and it is the one somebody can make from a phone at short
     * notice. Sending no file *keeps* whatever poster is already up, so
     * changing the time by an hour does not mean finding the image again.
     *
     * `kind` and `title` are optional in the other direction: absent means a set
     * with no title, not "leave what is there". Only the poster is kept across
     * an edit, because only the poster costs something to send again. Two text
     * fields a form fills in every time do not, and a rule that quietly kept
     * them would make "clear the title" impossible to express.
     */
    app.put('/api/schedule', { preHandler: requireAdmin(config) }, async (request, reply) => {
      let startsAt: number | null = null
      let stored: string | null = null
      let sawFile = false
      let kind: SessionKind = 'set'
      let title: string | null = null

      try {
        for await (const part of request.parts({
          limits: { fileSize: MAX_POSTER_BYTES, files: 1 },
        })) {
          if (part.type === 'field' && part.fieldname === 'startsAt') {
            const parsed = Number(part.value)
            if (Number.isFinite(parsed)) startsAt = Math.round(parsed)
            continue
          }
          // Anything that is not one of the two known kinds is a set. A poster
          // announcing the wrong sort of evening is a worse failure than a
          // 400 would be inconvenient, but there is no third thing this could
          // honestly mean, and the only sender is a form with two radios.
          if (part.type === 'field' && part.fieldname === 'kind') {
            kind = part.value === 'talk' ? 'talk' : 'set'
            continue
          }
          if (part.type === 'field' && part.fieldname === 'title') {
            title = typeof part.value === 'string' ? toTitle(part.value) : null
            continue
          }
          if (part.type !== 'file') continue
          sawFile = true

          // An empty file part is how a browser sends "no new poster" when the
          // input was left alone, so it is a no-op rather than a refusal.
          const head = await part.file.read(16)
          if (head === null) {
            await part.file.resume()
            sawFile = false
            continue
          }

          const declared = POSTER_TYPES[part.mimetype.toLowerCase()]
          const actual = sniff(Buffer.from(head))
          if (!actual || (declared && declared !== actual)) {
            await part.file.resume()
            return reply.code(415).send({
              error: 'unsupported_poster',
              message: 'a poster has to be a JPEG, a PNG or a WebP',
            })
          }

          stored = `${randomUUID()}.${actual}`
          part.file.unshift(head)
          await pipeline(part.file, createWriteStream(posterFilePath(config, stored)))
          if (part.file.truncated) {
            await discard(posterFilePath(config, stored))
            return reply.code(413).send({
              error: 'poster_too_large',
              message: `a poster has to be under ${Math.round(MAX_POSTER_BYTES / 1024 / 1024)} MB`,
            })
          }
        }
      } catch (err) {
        if (stored) await discard(posterFilePath(config, stored))
        throw err
      }

      if (startsAt === null) {
        if (stored) await discard(posterFilePath(config, stored))
        return reply
          .code(400)
          .send({ error: 'no_time', message: 'a session needs a time to be announced for' })
      }

      // A poster that was not re-sent is the one already up. `sawFile` tells a
      // request that left the file input alone apart from one that could not be
      // read, and only the first of those keeps what is there.
      const keeping = stored ?? (sawFile ? null : (schedule.get()?.poster ?? null))
      const displaced = schedule.set({ startsAt, poster: keeping, kind, title })
      if (displaced.poster) await discard(posterFilePath(config, displaced.poster))

      return body()
    })

    /** Take it down. The poster goes with it: it was only ever for that night. */
    app.delete('/api/schedule', { preHandler: requireAdmin(config) }, async () => {
      const displaced = schedule.clear()
      if (displaced.poster) await discard(posterFilePath(config, displaced.poster))
      return body()
    })
  }
}
