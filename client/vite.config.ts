import react from '@vitejs/plugin-react'
import { type Connect, type Plugin, defineConfig } from 'vite'

const SERVER = process.env.CHUNKY_SERVER ?? 'http://localhost:3000'

/**
 * Where this station answers, written out in full.
 *
 * The one place it is spelled. A canonical link and an Open Graph image both
 * have to be absolute — a card is fetched by a machine that has no idea what
 * page it came from — so the address ends up in the documents whether anybody
 * likes it or not, and the choice is between it being in one place or five.
 *
 * A Railway subdomain today. When there is a real domain, this line is the
 * change, or `PUBLIC_ORIGIN` is set in the build and this is never touched.
 * No trailing slash: everything below appends its own path.
 */
const ORIGIN = (process.env.PUBLIC_ORIGIN ?? 'https://chunkyfm-production.up.railway.app').replace(
  /\/+$/,
  '',
)

/**
 * When this build was cut, for the `dateModified` in the landing page's schema.
 *
 * The one thing a crawler has to go on for whether what it read six weeks ago
 * still stands. It is the build rather than the last edit to the copy, which is
 * a slight overstatement — a build that changed nothing still moves it — but it
 * is the honest end of the two options available. The alternative is a date
 * typed into the markup by hand, which is right on the day it is written and
 * quietly wrong every day after.
 *
 * `SOURCE_DATE_EPOCH` is honoured because it costs one line and it is the
 * convention for making a build reproducible.
 */
const BUILT = new Date(
  process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now(),
).toISOString()

/**
 * Substitutes `%ORIGIN%` and `%BUILT%` in both documents.
 *
 * Vite has its own `%VITE_*%` replacement for HTML, and it is deliberately not
 * used: it reads from a `.env` file that would have to exist, and a build
 * without one leaves the placeholder in the markup — a canonical link pointing
 * at the literal string `%VITE_ORIGIN%`, which is worse than having none at
 * all and would not fail anything on the way out.
 */
function origin(): Plugin {
  return {
    name: 'chunky-origin',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('%ORIGIN%', ORIGIN).replaceAll('%BUILT%', BUILT),
    },
  }
}

/**
 * The doorway, in development and in `vite preview`.
 *
 * nginx decides what `/` is in the container (see nginx.conf) and the two
 * have to agree for the same reason the /api and /ws proxies do: the app ships
 * unchanged, so what happens at the front door in front of a dev server has to
 * be what happens in production, or the first place anyone notices a difference
 * is production. Three rules, and they are the same three:
 *
 *   /               the landing page, rewritten rather than redirected so the
 *                   station's bare address stays bare
 *   /?k=<key>       an invite, sent on to the station with the key intact
 *   /welcome        where the landing page used to be
 *   /how-it-works   the page that explains the station, same rewrite as `/`:
 *                   the address a link points at has no `.html` on the end of it
 *   /cohost         the co-host's control surface, its own document for the
 *                   reason `/how-it-works` is one: a separate bundle, served
 *                   without its `.html` because that is the address the link
 *                   somebody is sent actually says
 *
 * `/listen` needs no rule in either place: Vite's SPA fallback answers it with
 * the station, and nginx names it outright.
 *
 * The fourth rule is the one place the doors are deliberately allowed to
 * differ. nginx answers an address that is nothing with a 404 (see the
 * `error_page` note in nginx.conf — a 200 on every typo is a soft 404, and the
 * whole reason for it was to reach `/listen`, which is now named). Vite goes on
 * falling back to the station, because the same strictness here would mean
 * listing every path the dev server invents — `/@vite/client`, `/src/…`,
 * `/node_modules/.vite/…` — and getting that list wrong breaks the reload, not
 * a search result. Nothing crawls a dev server, and the difference only shows
 * on addresses that were never real.
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

    if (path === '/how-it-works') {
      req.url = query === undefined ? '/how-it-works.html' : `/how-it-works.html?${query}`
      next()
      return
    }

    // The query survives whole, because a co-host link is `/cohost?k=<key>` and
    // the page reads the key out of its own address bar. Rewritten rather than
    // redirected, for the reason `/` is: a redirect would put the key through a
    // second `Location` header and a second entry in the browser's history.
    if (path === '/cohost') {
      req.url = query === undefined ? '/cohost.html' : `/cohost.html?${query}`
      next()
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
  plugins: [origin(), react(), doorway()],
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
        // The co-host's own document. A third entry rather than a route on the
        // station, and the reason is the device: the station's bundle carries a
        // globe, a gramophone and three.js, and none of that belongs on a phone
        // whose whole job is one button. See `src/cohost/main.tsx`.
        cohost: 'cohost.html',
        // No script tag on this one, and it is still an input rather than a
        // file in public/: it needs `%ORIGIN%` and `%BUILT%` substituted, and
        // public/ is copied byte for byte without going near a plugin.
        how: 'how-it-works.html',
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
