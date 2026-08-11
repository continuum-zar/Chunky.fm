import react from '@vitejs/plugin-react'
import { type Connect, type Plugin, defineConfig } from 'vite'

const SERVER = process.env.CHUNKY_SERVER ?? 'http://localhost:3000'

/**
 * The doorway, in development and in `vite preview`.
 *
 * nginx decides what `/` is in the container (see nginx.conf) and the two
 * have to agree for the same reason the /api and /ws proxies do: the app ships
 * unchanged, so what happens at the front door in front of a dev server has to
 * be what happens in production, or the first place anyone notices a difference
 * is production. Three rules, and they are the same three:
 *
 *   /            the landing page, rewritten rather than redirected so the
 *                station's bare address stays bare
 *   /?k=<key>    an invite, sent on to the station with the key intact
 *   /welcome     where the landing page used to be
 *
 * `/listen` needs no rule in either place: Vite's SPA fallback and nginx's
 * `try_files … /index.html` both already answer an unknown path with the
 * station, which is exactly what it is.
 */
function doorway(): Plugin {
  // Kept in step with INVITE_PARAM in src/lib/invite.ts by hand, because this file is
  // bundled by esbuild before the app's module graph exists, and nginx.conf
  // spells the same letter out too.
  const INVITE = 'k'

  const route: Connect.NextHandleFunction = (req, res, next) => {
    // Only the path: `/welcome?utm=…` is still /welcome, and `/welcomely`
    // is not.
    const [path, query] = (req.url ?? '').split('?')

    if (path === '/welcome') {
      res.statusCode = 301
      res.setHeader('location', '/')
      res.end()
      return
    }

    if (path === '/') {
      if ((new URLSearchParams(query ?? '').get(INVITE) ?? '') !== '') {
        res.statusCode = 302
        res.setHeader('location', `/listen?${query}`)
        res.end()
        return
      }
      req.url = query === undefined ? '/landing.html' : `/landing.html?${query}`
    }

    next()
  }

  return {
    name: 'chunky-doorway',
    configureServer(server) {
      server.middlewares.use(route)
    },
    configurePreviewServer(server) {
      server.middlewares.use(route)
    },
  }
}

export default defineConfig({
  plugins: [react(), doorway()],
  build: {
    // Two documents, not one app with two routes: the landing page has to be
    // able to describe the station on the days the station's own bundle would
    // have nothing to say. `/` is the landing entry and `/listen` the station.
    // Naming index.html here is not optional: the moment `input` is given, it
    // stops being the default.
    rollupOptions: {
      input: {
        station: 'index.html',
        landing: 'landing.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
      // The crawl files, which the station answers rather than the bundle.
      // Nothing crawls a dev server; this is here so the three front doors go
      // on agreeing, which is the property `lib/doorway.ts` exists to protect.
      '/robots.txt': { target: SERVER, changeOrigin: true },
      '/sitemap.xml': { target: SERVER, changeOrigin: true },
      '/llms.txt': { target: SERVER, changeOrigin: true },
    },
  },
})
