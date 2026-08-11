import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { doorway, isServerPath, isStationPath } from '../src/lib/doorway.js'
import { type Harness, startHarness } from './helpers.js'

/**
 * The front door, in the deployment where Fastify is the only thing listening.
 *
 * The compose stack's copy of these rules is nginx's, and CI checks it by
 * curling a running container (see the `stack` job in ci.yml). This is the same
 * set of assertions against the copy in `lib/doorway.ts`, because the whole
 * risk of having the rules written down three times is that one of them drifts.
 */

const INDEX = '<!doctype html><title>station</title><div id="root"></div><script src="/assets/station-abc.js">'
const LANDING = '<!doctype html><title>chunky.fm</title><div id="root"></div><script src="/assets/landing-abc.js">'
const HOW = '<!doctype html><title>How chunky.fm works</title><h1>How chunky.fm works</h1>'
const NOT_FOUND = '<!doctype html><title>Not a page</title><h1>Nothing at this address</h1>'

describe('doorway rules', () => {
  it('sends /welcome to the root, permanently', () => {
    expect(doorway('/welcome')).toEqual({ kind: 'redirect', status: 301, location: '/' })
  })

  it('is about the path, not a prefix of it', () => {
    // `/welcomely` is not `/welcome`, and a rule matching on prefix would
    // swallow any future path that happens to start with it.
    expect(doorway('/welcomely')).toEqual({ kind: 'pass' })
  })

  it('keeps the query off the /welcome decision', () => {
    expect(doorway('/welcome?utm=x')).toEqual({ kind: 'redirect', status: 301, location: '/' })
  })

  it('answers the bare root with the landing page', () => {
    expect(doorway('/')).toEqual({ kind: 'landing' })
    expect(doorway('/?utm=x')).toEqual({ kind: 'landing' })
  })

  it('sends an invite on to the station with its key intact', () => {
    expect(doorway('/?k=abc123')).toEqual({
      kind: 'redirect',
      status: 302,
      location: '/listen?k=abc123',
    })
  })

  it('carries the whole query across, not just the key', () => {
    // The station reads its own address bar; dropping a parameter on the way
    // through would lose whatever else the link was carrying.
    expect(doorway('/?k=abc&utm=mail')).toEqual({
      kind: 'redirect',
      status: 302,
      location: '/listen?k=abc&utm=mail',
    })
  })

  it('treats a key of literally "0" as a key', () => {
    // The bug `if ($arg_k)` would have in nginx, and `if (query.k)` here: "0"
    // is a perfectly good key and reads as false in both languages.
    expect(doorway('/?k=0')).toEqual({ kind: 'redirect', status: 302, location: '/listen?k=0' })
  })

  it('treats an empty key as no key at all', () => {
    expect(doorway('/?k=')).toEqual({ kind: 'landing' })
  })

  it('answers /how-it-works with the page that explains it', () => {
    expect(doorway('/how-it-works')).toEqual({ kind: 'how' })
    expect(doorway('/how-it-works?utm=x')).toEqual({ kind: 'how' })
  })

  it('sends a document filename to the one address that document has', () => {
    // Every canonical link and every sitemap entry names these without the
    // extension. Reachable at both, they are two pages to a crawler.
    expect(doorway('/landing.html')).toEqual({ kind: 'redirect', status: 301, location: '/' })
    expect(doorway('/how-it-works.html')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/how-it-works',
    })
    expect(doorway('/index.html')).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/listen',
    })
  })

  it('leaves everything else alone', () => {
    expect(doorway('/listen')).toEqual({ kind: 'pass' })
    expect(doorway('/api/tracks')).toEqual({ kind: 'pass' })
    expect(doorway('/assets/station-abc.js')).toEqual({ kind: 'pass' })
    // Not a prefix rule, the same way /welcome is not.
    expect(doorway('/how-it-works-really')).toEqual({ kind: 'pass' })
  })
})

describe('isStationPath', () => {
  it('names the two paths that are the station', () => {
    expect(isStationPath('/listen')).toBe(true)
    expect(isStationPath('/admin')).toBe(true)
  })

  it('is everything an unknown path used to be, and no longer is', () => {
    // The soft 404: every one of these was answered with the station and a 200.
    expect(isStationPath('/whatever')).toBe(false)
    expect(isStationPath('/listen/extra')).toBe(false)
    expect(isStationPath('/')).toBe(false)
  })
})

describe('isServerPath', () => {
  it('claims the paths this process answers itself', () => {
    expect(isServerPath('/health')).toBe(true)
    expect(isServerPath('/ws')).toBe(true)
    expect(isServerPath('/api/tracks')).toBe(true)
    expect(isServerPath('/api/nope')).toBe(true)
  })

  it('leaves the app everything else', () => {
    expect(isServerPath('/')).toBe(false)
    expect(isServerPath('/listen')).toBe(false)
    expect(isServerPath('/apiary')).toBe(false)
  })
})

describe('serving the client from the server', () => {
  let harness: Harness
  let clientDir: string

  beforeAll(async () => {
    clientDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunky-client-'))
    await fs.mkdir(path.join(clientDir, 'assets'))
    await fs.writeFile(path.join(clientDir, 'index.html'), INDEX)
    await fs.writeFile(path.join(clientDir, 'landing.html'), LANDING)
    await fs.writeFile(path.join(clientDir, 'how-it-works.html'), HOW)
    await fs.writeFile(path.join(clientDir, '404.html'), NOT_FOUND)
    await fs.writeFile(path.join(clientDir, 'assets', 'station-abc.js'), 'console.log(1)')
    harness = await startHarness({ clientDir })
  })

  afterAll(async () => {
    await harness.cleanup()
    await fs.rm(clientDir, { recursive: true, force: true })
  })

  it('answers the root with the landing page', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('/assets/landing-abc.js')
    expect(res.headers['content-type']).toContain('text/html')
  })

  it('never caches a document', async () => {
    // The filenames inside it are immutable; this is the one response that has
    // to be re-fetched for a deploy to be visible at all.
    const res = await harness.app.inject({ method: 'GET', url: '/' })
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('sends an invite at the root on to the station', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/?k=abc123' })
    expect(res.statusCode).toBe(302)
    // Relative on purpose: an absolute location would be built from a host
    // header this process has no reliable idea about.
    expect(res.headers.location).toBe('/listen?k=abc123')
  })

  it('redirects /welcome to the root', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/welcome' })
    expect(res.statusCode).toBe(301)
    expect(res.headers.location).toBe('/')
  })

  it('answers the station paths with the station', async () => {
    // The fragment never reaches the server, so `/listen` and `/listen#chat`
    // are one request here, and there are exactly two paths to name.
    for (const url of ['/listen', '/admin']) {
      const res = await harness.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.body, url).toContain('/assets/station-abc.js')
    }
  })

  it('answers the explaining page, and does not put a bundle behind it', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/how-it-works' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('How chunky.fm works')
    expect(res.body).not.toContain('/assets/station-abc.js')
  })

  it('answers an address that is nothing with a page and a 404', async () => {
    // Both halves. It used to be the station with a 200 on it, which told a
    // crawler every typo was a real page and offered it an unlimited supply of
    // duplicate stations.
    for (const url of ['/whatever', '/listen/extra', '/lsiten']) {
      const res = await harness.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(404)
      expect(res.headers['content-type'], url).toContain('text/html')
      expect(res.body, url).toContain('Nothing at this address')
    }
  })

  it('serves assets, cached hard', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/assets/station-abc.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers['cache-control']).toContain('max-age=31536000')
  })

  it('still refuses a mistyped API route in JSON', async () => {
    // The failure the app-shell fallback would otherwise cause: a typo looking
    // like a working endpoint that returns a page of HTML.
    const res = await harness.app.inject({ method: 'GET', url: '/api/wishez' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })

  it('does not answer a POST to the root with a page', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/', payload: {} })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('leaves the API and health alone', async () => {
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      ok: true,
    })
    expect((await harness.app.inject({ method: 'GET', url: '/api/tracks' })).statusCode).toBe(200)
  })
})

describe('without a client to serve', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await startHarness()
  })
  afterAll(() => harness.cleanup())

  it('leaves the front door to whatever is in front of it', async () => {
    // The compose stack and `npm run dev`, where nginx and Vite own `/`. The
    // server must not start answering it, or the two deployments diverge.
    const res = await harness.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'not_found' })
  })

  it('still refuses an unknown path rather than inventing a page', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/listen' })
    expect(res.statusCode).toBe(404)
  })
})
