import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type ClientBundle, sendDocument } from '../routes/client.js'
import { isServerPath, isStationPath } from './doorway.js'

/**
 * One error shape for the whole API.
 *
 * Every refusal written by hand in this codebase answers `{error, message}`,
 * where `error` is a machine-readable code the client switches on; see
 * `AdminError.code` on the other side. Fastify's own refusals do not: a schema
 * rejection or an unparseable body comes back as `{statusCode, error: "Bad
 * Request", message}`, where `error` is prose about the *status*, not a code
 * for the failure. A client cannot tell the two apart, so half the API's
 * errors were unusable programmatically.
 *
 * These handlers put the framework's failures into the same shape as ours.
 */

/** Status → code. Deliberately coarse: the detail belongs in `message`. */
const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'too_many_requests',
}

export interface ErrorBody {
  error: string
  message: string
}

export function errorBody(statusCode: number, message: string): ErrorBody {
  const fallback = statusCode >= 500 ? 'internal_error' : 'request_failed'
  return { error: CODES[statusCode] ?? fallback, message }
}

/**
 * @param appShell The built client, when this process is also serving it. Given
 *   one, `/listen` and `/admin` are answered with the station document — it
 *   decides what to show from the fragment, so `/listen` and `/listen#chat` are
 *   the same request as far as this side is concerned — and any other unknown
 *   page address is answered with the 404 document and a 404. Null under
 *   compose and in development, where nginx and Vite do this.
 */
export function registerErrorHandlers(
  app: FastifyInstance,
  appShell: ClientBundle | null = null,
): void {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode ?? 500

    if (status >= 500) {
      // The only case where the message is not safe to repeat: it can carry a
      // server-side path, a SQL fragment, or a stack. Log it, answer plainly.
      request.log.error({ err }, 'unhandled error')
      return reply
        .code(status)
        .send(errorBody(status, 'the station could not complete that request'))
    }

    // A validation message ("body must have required property 'action'") is
    // written for whoever is holding the API wrong, and says nothing private.
    return reply.code(status).send(errorBody(status, err.message))
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // Only when there is a client to answer with, and only for the kind of
    // request a browser makes for a page. A mistyped API route (`/api/wishez`)
    // must still be told there is no such route, in the shape every other
    // refusal uses: handing it a page of HTML would make a typo look like a
    // working endpoint returning nonsense.
    if (appShell !== null && (request.method === 'GET' || request.method === 'HEAD')) {
      const cut = request.url.indexOf('?')
      const path = cut === -1 ? request.url : request.url.slice(0, cut)

      // The station, for the two paths that are the station. Everything else
      // used to land here too, which meant every typo was a page with a 200 on
      // it — see `isStationPath` for why that stopped.
      if (isStationPath(path)) {
        return sendDocument(reply, appShell.index)
      }

      // A page saying so, with a 404 on it. Both halves matter: the status is
      // what stops a crawler indexing the address, and the page is what stops
      // a reader thinking the station is broken rather than the link.
      if (!isServerPath(path) && appShell.notFound !== null) {
        return reply
          .code(404)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-cache')
          .send(appShell.notFound)
      }
    }
    return reply.code(404).send(errorBody(404, `no route for ${request.method} ${request.url}`))
  })
}
