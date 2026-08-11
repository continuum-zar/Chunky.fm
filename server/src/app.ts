import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { OnAir } from './air.js'
import { ChatLog } from './chat.js'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { Floor } from './floor.js'
import { PlayLog } from './history.js'
import { registerErrorHandlers } from './lib/errors.js'
import { emptyLibrary } from './lib/library.js'
import { ensureStorageDirs } from './lib/storage.js'
import { LyricsService } from './lyrics.js'
import { MIC_HURRY_MS, Mic } from './mic.js'
import { Mutes } from './mutes.js'
import { Padding } from './padding.js'
import { PlaybackState } from './playback.js'
import { type RealtimeHandle, attachRealtime } from './realtime.js'
import { hasAdminCredentials, mayListen } from './lib/auth.js'
import { adminRoutes } from './routes/admin.js'
import { crawlRoutes } from './routes/crawl.js'
import { floorRoutes } from './routes/floor.js'
import { micRoutes } from './routes/mic.js'
import { rtcRoutes } from './routes/rtc.js'
import { mutesRoutes } from './routes/mutes.js'
import { paddingRoutes } from './routes/padding.js'
import { sessionRoutes } from './routes/session.js'
import { type ClientBundle, clientRoutes, doorwayHook, loadClientBundle } from './routes/client.js'
import { listenRoutes } from './routes/listen.js'
import { lyricsRoutes } from './routes/lyrics.js'
import { mediaRoutes } from './routes/media.js'
import { playbackRoutes } from './routes/playback.js'
import { queueRoutes } from './routes/queue.js'
import { uploadRoutes } from './routes/upload.js'
import { wishesRoutes } from './routes/wishes.js'
import { Station } from './station.js'
import { CloudflareTurn } from './turn.js'
import { Schedule } from './schedule.js'
import { scheduleRoutes } from './routes/schedule.js'
import { WishBook } from './wishes.js'

declare module 'fastify' {
  interface FastifyInstance {
    station: Station
    playback: PlaybackState
    realtime: RealtimeHandle
    chat: ChatLog
    wishes: WishBook
    plays: PlayLog
    /** Whether the station is broadcasting, and the open session while it is. */
    air: OnAir
    /** The next session, announced. Outlives every session; see `Schedule`. */
    schedule: Schedule
    mutes: Mutes
    /** Whether somebody is talking over the music. See `Mic`. */
    mic: Mic
    /** Who, besides the decks, is allowed to talk. See `Floor`. */
    floor: Floor
    /** Heads the decks added to the headcount. See `Padding`. */
    padding: Padding
    lyrics: LyricsService
  }
}

/**
 * How often a lapsed mic is noticed. Slow enough to be free, fast enough that
 * a console that died mid-sentence is a pause rather than the rest of the
 * evening. See `Mic.sweep`.
 */
const DEFAULT_MIC_SWEEP_MS = 2_000

export interface BuildAppOptions {
  config: Config
  db: Db
  logger?: FastifyServerOptions['logger']
  /** Supply your own state (and clock) in tests; production builds its own. */
  playback?: PlaybackState
  heartbeatIntervalMs?: number
  backstopIntervalMs?: number
  /** How often a mic nobody is renewing is checked for having lapsed. */
  micSweepIntervalMs?: number
  /** How long an open mic lasts without a renew. See `MIC_LEASE_MS`. */
  micLeaseMs?: number
  /** How long an invitation to the mic stands. See `INVITE_TTL_MS`. */
  inviteTtlMs?: number
  closeGraceMs?: number
  chatHistoryLimit?: number
  playHistoryLimit?: number
  /** Come up already on air. Tests that are about something else want this. */
  live?: boolean
  chatBurst?: number
  chatRefillMs?: number
  joinBurst?: number
  joinRefillMs?: number
  wishBurst?: number
  wishRefillMs?: number
  /** Hand frames a socket may send back to back. */
  handBurst?: number
  handRefillMs?: number
  /** Signalling frames a listener may send back to back. The decks are exempt. */
  signalBurst?: number
  signalRefillMs?: number
  signInBurst?: number
  signInRefillMs?: number
  /** The seam tests mock LRCLIB through; production reaches the real archive. */
  lyricsFetch?: typeof fetch
  /** The same, for Cloudflare's relay. See `CloudflareTurn`. */
  turnFetch?: typeof fetch
}

export async function buildApp({
  config,
  db,
  logger,
  playback = new PlaybackState(),
  heartbeatIntervalMs,
  backstopIntervalMs,
  micSweepIntervalMs = DEFAULT_MIC_SWEEP_MS,
  micLeaseMs,
  inviteTtlMs,
  closeGraceMs,
  chatHistoryLimit,
  playHistoryLimit,
  live = false,
  chatBurst,
  chatRefillMs,
  joinBurst,
  joinRefillMs,
  wishBurst,
  wishRefillMs,
  handBurst,
  handRefillMs,
  signalBurst,
  signalRefillMs,
  signInBurst,
  signInRefillMs,
  lyricsFetch,
  turnFetch,
}: BuildAppOptions): Promise<FastifyInstance> {
  await ensureStorageDirs(config)

  // trustProxy so `request.ip` is the caller rather than whatever proxy is in
  // front. See Config.trustProxy. The sign-in throttle is keyed on it, and one
  // bucket shared by everyone behind the proxy would be a lockout, not a limit.
  const app = Fastify({
    // `LOG_LEVEL=debug` is what makes the station print every ICE candidate it
    // relays, which is the one view that says whether two browsers are
    // exchanging addresses at all. See `Config.logLevel`.
    logger: logger ?? { level: config.logLevel },
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy,
  })

  // Loaded before the error handlers because the app shell *is* the not-found
  // handler when this process serves the client. Null under compose and in
  // development, where nginx and Vite own the front door respectively.
  const clientBundle: ClientBundle | null = config.clientDir
    ? await loadClientBundle(config.clientDir)
    : null

  // Before the routes: everything registered after this inherits the handlers,
  // so a schema rejection on /api/playback answers in the same shape the
  // handler's own refusals do.
  registerErrorHandlers(app, clientBundle)

  // At the root, before routing, so it sees `/` and `/welcome` the way nginx
  // sees them. Everything else it passes straight through.
  if (clientBundle !== null) {
    app.addHook('onRequest', doorwayHook(clientBundle))
  }

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 8,
    },
  })

  app.get('/health', async () => ({ ok: true }))

  const station = new Station({ playback, backstopIntervalMs })

  // A session is a stretch of time the station is on air, opened and closed by
  // whoever runs the decks, not a run of the process, which is what it used to
  // be. Off air by default: a station that went live the instant it booted
  // would put every deploy on air with an empty queue.
  //
  // Stamped from the station clock rather than `Date.now`, for the reason the
  // play log takes one: everything time-shaped the server says reads from there.
  const air = new OnAir({ db, now: () => playback.now(), live })
  // All three are scoped to whatever session is open *now*, which is why they
  // take the `air` object rather than a number. Going live opens a fresh room;
  // ending the session empties it.
  const chat = new ChatLog({ db, session: air, historyLimit: chatHistoryLimit })
  const wishes = new WishBook({ db, session: air })
  const plays = new PlayLog({
    db,
    session: air,
    limit: playHistoryLimit,
    now: () => playback.now(),
  })

  // Ending a broadcast clears the decks and what was queued behind them. The
  // station owns both, so this is wired here rather than reached for from
  // inside OnAir: a record of a stretch of time should not be able to drive
  // the decks directly.
  //
  // Only on the way *off* air: going live deliberately leaves the decks alone,
  // so an admin who queued a set up before opening the doors still has it.
  // A mute is about tonight, so it ends with the session, like the queue, and
  // for the same reason. Somebody shouting over the music at midnight should
  // not find themselves silenced next Tuesday by a rule nobody remembers.
  const mutes = new Mutes()

  // The other half of the headcount: the roster is who is actually here, and
  // this is whatever the decks have added on top of it. About tonight, like the
  // mutes and the queue, and cleared with them below, so a station that comes
  // back up never goes on claiming a crowd from a night that is over.
  const padding = new Padding()

  // The talkback. It holds no audio and never will: what it carries is whether
  // somebody is talking and how far the music should sit under them, and every
  // listener applies that to the copy of the track their own browser is already
  // playing. Stamped from the station clock, like everything else time-shaped
  // here, because the lease below is measured against it.
  const mic = new Mic({ now: () => playback.now(), leaseMs: micLeaseMs })

  // Who, besides the decks, is allowed to talk. Holds no audio either: a guest's
  // voice goes from their browser to the console and out again on the
  // connections the room already has, and the station carries no more of it than
  // it carries of the music. What it holds is permission. See `Floor`.
  const floor = new Floor({ now: () => playback.now(), inviteTtlMs })

  // A console that dies mid-sentence would otherwise leave the whole room
  // listening to a permanently quiet song. See `Mic.sweep`. The floor's one
  // lease — an invitation nobody answered — rides the same interval, because
  // both are the same kind of housekeeping and neither is worth a timer of its
  // own. See `Floor.sweep`.
  const micSweep = setInterval(() => {
    mic.sweep()
    floor.sweep()
  }, micSweepIntervalMs)
  micSweep.unref()

  /**
   * The mic follows the floor, in both directions, and neither is symmetrical.
   *
   * Somebody coming up opens the mic, because the room has to be ducked before
   * their first word — the same reason a listener arriving mid-break is handed
   * `mic` before `state`. Note what is deliberately absent: standing a guest
   * down does *not* shut the mic. You will nearly always say something after
   * them, and un-ducking between their last word and your first is a swell of
   * music in the middle of a sentence.
   *
   * The mic closing does take the floor with it, and that half is not optional.
   * A shut mic is an un-ducked room, so a guest still shown as up would be
   * talking under music at full volume — and the commonest way this happens is
   * not somebody pressing a button, it is the lease lapsing because the console
   * died, which is exactly when the station's story about who is talking should
   * stop being wrong.
   */
  floor.on('change', (snapshot) => {
    if (snapshot.speaker) mic.open()
  })
  mic.on('change', (snapshot) => {
    if (!snapshot.live) floor.drop()
  })

  // Deliberately not wired to the air change below. Everything else in this
  // file is about tonight and goes when tonight does; an announcement is about
  // a night that has not happened, and ending a broadcast is usually the moment
  // it becomes worth reading.
  const schedule = new Schedule({ db, now: () => playback.now() })

  const lyrics = new LyricsService({ db, baseUrl: config.lrclibBaseUrl, fetchFn: lyricsFetch })

  // Cloudflare hands out relay credentials rather than holding one, so they are
  // minted here and shared: a room arriving together is thirty listeners asking
  // `/api/rtc` inside a few seconds, and thirty calls to be told the same
  // answer would be rude. Null unless configured, which is a station on STUN.
  const turn = config.cloudflareTurn
    ? new CloudflareTurn({
        ...config.cloudflareTurn,
        fetchFn: turnFetch,
        // Logged rather than raised: a station that cannot reach Cloudflare
        // still works for every listener who did not need a relay, and
        // refusing the request would take the voice away from all of them.
        onError: (err) => app.log.error({ err }, 'could not mint relay credentials'),
      })
    : null

  air.on('change', (snapshot) => {
    if (snapshot.live) return
    station.playback.stop()
    station.queue.clear()
    mutes.clear()
    padding.clear()
    // Nobody is talking over a station that is off. Only the mic itself: the
    // duck depth is a fader position belonging to whoever runs the decks, not
    // a claim about tonight's room, so it survives. See `Mic.clear`.
    //
    // The floor goes with it, and all of it, hands included — unlike the duck
    // depth there is nothing here belonging to whoever runs the decks. Who is
    // here, who asked and who is talking are all claims about tonight, and every
    // one of them is a lie applied to another night. See `Floor.clear`.
    mic.clear()
    floor.clear()
    // And everything written down during it. Scoping already made all three
    // unreadable; this is about the rows. The chat and the book are free text
    // somebody typed, signed with the name they were using, said to a room that
    // no longer exists. The play log is only ids and times, but the library
    // wipe below strands it anyway, and a row nothing can ever read again is
    // not a record, it is litter. See `ChatLog.forgetAll`.
    chat.forgetAll()
    wishes.forgetAll()
    plays.forgetAll()
    // The set goes with the session it played in. The station is an evening,
    // not an archive: ending the broadcast deletes every track, its file, its
    // artwork and its lyrics, so the disk holds tonight and never everything.
    // Uploads made *after* ending (an admin prepping the next set) land in
    // an already-empty library and survive to their own session.
    //
    // Fire-and-forget for the same reason the handler above it is synchronous:
    // an air change must never be able to fail on housekeeping. The files are
    // unlinked after the rows are gone, and a straggler only wastes bytes.
    void emptyLibrary(db, config).catch((err) => {
      app.log.error({ err }, 'failed to empty the library after the session')
    })
  })

  await app.register(adminRoutes({ config, signInBurst, signInRefillMs }))
  await app.register(sessionRoutes({ config, air }))
  await app.register(scheduleRoutes({ config, schedule }))
  await app.register(micRoutes({ config, mic, air, floor }))
  await app.register(floorRoutes({ config, floor, air }))
  await app.register(rtcRoutes({ config, turn }))
  await app.register(mutesRoutes({ config, mutes }))
  await app.register(paddingRoutes({ config, padding }))
  // Before the client routes and well before the app-shell fallback, which is
  // what was answering these with a page of HTML. See `crawlRoutes`.
  await app.register(crawlRoutes())
  await app.register(listenRoutes({ config }))
  await app.register(uploadRoutes({ config, db, lyrics }))
  await app.register(mediaRoutes({ config, db }))
  await app.register(lyricsRoutes({ config, db, lyrics }))
  await app.register(playbackRoutes({ config, db, station }))
  await app.register(queueRoutes({ config, db, station }))
  await app.register(wishesRoutes({ config, wishes }))
  // Last of the routes, so nothing it registers can shadow an API path.
  if (clientBundle !== null) {
    await app.register(clientRoutes({ config }))
  }

  const realtime = attachRealtime({
    server: app.server,
    station,
    air,
    schedule,
    mic,
    floor,
    mutes,
    padding,
    // The socket is the station: refusing it is what makes a private station
    // private, since everything a listener sees arrives on it.
    admit: (headers) => mayListen(config, headers),
    // And which of the admitted are the decks. The same question `requireAdmin`
    // asks of an HTTP request, asked of the upgrade that became this socket,
    // and it buys one thing only: the right to offer a listener a voice.
    isAdmin: (headers) => hasAdminCredentials(config, headers),
    // The console's socket going away is not proof it has gone: renewals ride
    // HTTP, which survives a blip the socket does not. So this shortens the
    // mic's lease rather than ending it, and a console that is only
    // reconnecting keeps its mic. See `Mic.hurry`.
    onDecksGone: () => mic.hurry(MIC_HURRY_MS),
    chat,
    wishes,
    plays,
    heartbeatIntervalMs,
    closeGraceMs,
    chatBurst,
    chatRefillMs,
    joinBurst,
    joinRefillMs,
    wishBurst,
    wishRefillMs,
    handBurst,
    handRefillMs,
    signalBurst,
    signalRefillMs,
    log: app.log,
  })

  app.decorate('station', station)
  app.decorate('playback', playback)
  app.decorate('realtime', realtime)
  app.decorate('chat', chat)
  app.decorate('wishes', wishes)
  app.decorate('plays', plays)
  app.decorate('air', air)
  app.decorate('schedule', schedule)
  app.decorate('mutes', mutes)
  app.decorate('mic', mic)
  app.decorate('floor', floor)
  app.decorate('padding', padding)
  app.decorate('lyrics', lyrics)

  // preClose, not onClose: an upgraded websocket keeps the HTTP server open, so
  // the sockets have to be drained *before* Fastify tries to close it. Using
  // onClose here deadlocks shutdown for as long as anyone is listening.
  app.addHook('preClose', async () => {
    station.close()
    clearInterval(micSweep)
    await realtime.close()
    // A session left open by a stop keeps a null `ended_at`, which reads as
    // "still on air" forever. Closed quietly: the sockets are already drained,
    // so there is nobody left to announce it to.
    air.close()
  })

  return app
}
