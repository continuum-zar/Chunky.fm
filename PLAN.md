# chunky.fm build plan

A single, permanent radio station. You paste one link, friends land in it, and
everyone hears the exact same instant of the exact same song. You run the decks.

## Decisions locked

| Question | Decision |
|---|---|
| Audio source | Self-hosted files you upload |
| Sync | True live sync: join mid-song, drop into the moment |
| Scale | Under ~30 concurrent |
| Availability | Session-based: you go live, you end it |
| Requests | Free-text wishes, no library browsing for listeners |
| Ingest | Drag-and-drop web upload, admin only |
| Identity | Nickname only, stored in localStorage |
| Rooms | One station, one permanent link |
| Social | Presence list, now-playing history, skip votes |
| Host | Railway |
| Stack | Full-stack TypeScript |

## Stack

- **Server.** Node + TypeScript, Fastify (clean story for websockets, static
  range requests, and multipart uploads in one process).
- **Realtime.** Plain `ws`. Socket.IO handles reconnection and heartbeats for
  you, but it's weight you don't need at this scale; budget ~30 lines for a
  reconnect wrapper instead.
- **DB.** SQLite via `better-sqlite3`, file sitting on the Railway volume next
  to the audio. Synchronous API, one writer, no second service to pay for.
- **Uploads.** `@fastify/multipart` + `music-metadata` for ID3 tags and
  embedded artwork.
- **Client.** React + Vite. One page, two modes (listener / admin).

## The hard part: synchronized playback

Everything else here is CRUD. This is the part that decides whether the project
feels magic or broken, so build it first, before any chat or queue UI.

### Server holds the clock

The server's entire notion of playback is:

```ts
{
  currentTrack: Track | null,
  startedAt: number,        // server epoch ms at which this track was at 0:00
  pausedAt: number | null,  // position in ms, if paused
}
```

Position at any moment is `pausedAt ?? (Date.now() - startedAt)`. That's it.
No per-listener state, no streaming, no mixing. Listeners are told the tuple and
are responsible for aligning themselves to it.

Because `startedAt` is a point in the past, a listener joining at 2:14 computes
2:14 and seeks there. Joining mid-song is the *same code path* as joining at the
start; there's no special case.

### Clock offset handshake

Browser clocks are wrong by seconds. Measure the offset, NTP-style:

1. Client sends `ping{t0: clientNow}`.
2. Server replies `pong{t0, t1: serverNow}`.
3. Client receives at `t2` and computes:
   - `rtt = t2 - t0`
   - `offset = t1 - (t0 + rtt/2)`

Run this ~5 times on connect and keep **the sample with the lowest RTT**, not
the average, because the fastest round trip is the least contaminated by queueing
delay. Re-run every 30s to catch clock drift. Then `serverNow()` is just
`Date.now() + offset`.

### Drift correction

Audio clocks drift from system clocks. Check every 2s:

```ts
const expected = (serverNow() - startedAt) / 1000
const diff = audio.currentTime - expected

if (Math.abs(diff) > 1.0) {
  audio.currentTime = expected           // way off, eat the audible seek
} else if (Math.abs(diff) > 0.05) {
  audio.playbackRate = 1 - clamp(diff * 0.5, -0.02, 0.02)
} else {
  audio.playbackRate = 1
}
```

Correct with **playback rate, not seeking**. A seek is an audible glitch; a 2%
rate nudge is not. Modern browsers default `preservesPitch = true`, so the rate
change time-stretches instead of pitch-shifting, and at 2% there's no perceptible
artifact. Convergence takes a few seconds, which is fine.

### Things that will bite

- **Autoplay policy.** Browsers won't start audio without a user gesture. The
  nickname "Join" button *is* that gesture, so call `audio.play()` synchronously
  inside that click handler, not in a promise chain after it.
- **Range requests.** Seeking to 2:14 requires the server to honour
  `Range` headers. Fastify's static plugin does; verify it rather than assume.
- **Buffering on join.** A listener who seeks to 2:14 needs that byte range
  before playing. Show a brief "tuning in…" state instead of letting them sit
  in silence wondering if it's broken.
- **Volume differences between uploads.** Files from mixed sources vary wildly
  in loudness, which is jarring on shuffle. Real fix is ReplayGain-style
  analysis at upload time; cheap fix is a per-track gain field you set by ear.

## Data model

```sql
tracks    (id, title, artist, album, duration_ms, filename,
           artwork_path, gain_db, uploaded_at)
sessions  (id, started_at, ended_at)
plays     (id, session_id, track_id, played_at)      -- now-playing history
wishes    (id, session_id, nick, text, created_at, status)
messages  (id, session_id, nick, text, created_at)
```

The queue lives in memory, not the DB: it's session-scoped and dies with the
session anyway.

## Server responsibilities

- Own the clock; broadcast `{track, startedAt, pausedAt}` on every change.
- Advance tracks with a `setTimeout` for the remaining duration, **plus** a
  slower interval as a backstop in case the timer fires late under load.
- Track presence: socket → nickname map, broadcast on join/leave.
- Tally skip votes as a set of socket IDs; clear it on every track change.
- Gate admin actions behind auth on the socket, not just the UI.

## Admin surface

Password from an env var, exchanged for a signed cookie at `/admin`. The
listener page never ships admin controls.

Controls: upload, queue reorder / remove, play / pause / skip / seek, start and
end session, see wishes, see skip tallies, mute a nickname.

## Milestones

Build in this order. M1 is the only one with real technical risk, so it goes
first and alone.

1. **Sync spike.** Upload one file, play it, open two browsers, confirm they're
   locked together. No UI polish, no chat, no queue. If sync doesn't feel right
   here, nothing built on top of it will.
2. **Queue + admin controls.** Play / pause / skip / reorder, tracks advance
   automatically.
3. **Join flow, presence, chat.** Nickname screen, who's-listening list.
4. **Wishes, skip votes, history.**
5. **Deploy + polish.** Railway volume, offline screen, mobile-tolerable layout.

## Railway specifics

- **Mount a volume.** Without one, the filesystem is ephemeral and every deploy
  silently wipes your uploads and your SQLite file. ~$0.15/GB/mo.
- **Pin to a single replica.** Playback state is in memory. Two replicas means
  two stations disagreeing with each other, with listeners randomly split
  between them, which is a genuinely confusing bug to diagnose.
- **Disable app sleeping.** A sleeping instance drops every websocket.
- If the library outgrows the volume, move audio to Cloudflare R2 (no egress
  fees) and keep the app on Railway. Don't start there.

## Deferred, deliberately

- Floating emoji reactions: cheapest way to add life later, and it reuses the
  sync work already done.
- Auto-DJ when the queue empties.
- Multiple rooms.
- Listener uploads.
- ~~Mic / talk-over-the-music DJ mode.~~ **Built.** The station ducks on
  command, and the voice travels peer-to-peer without touching the server, so
  it still costs nothing to run. See `docs/broadcasting.md` for why the ducking
  was built first and separately from the voice, and
  `docs/broadcasting-build.md` for what each milestone actually cost.
