# Live mic: the build

The companion to [broadcasting.md](./broadcasting.md), which argues for keeping
the clock and sending only the voice. This is that decision turned into files,
frames and an order to write them in.

Nothing here changes how music reaches a listener. `useSyncedAudio`, the clock
handshake and the drift loop are untouched, and every milestone below is written
so that a listener whose voice connection never establishes still hears exactly
the station they hear today.

## The shape of it

```
        HTTP, behind requireAdmin              the socket, broadcast
   console ──── POST /api/mic ────▶ Mic ─────── { type: 'mic', … } ────▶ everyone
      │                                                                     │
      │                                                            ducks its own
      │                                                            music, locally
      │
      └──── voice, peer-to-peer, ~32 kbps ─────────────────────────────────▶
```

Two independent paths. The duck is a broadcast on the existing socket and works
on its own; the voice is WebRTC and is allowed to fail without taking the room
down with it. That separation is the whole reason M1 ships before any of the
hard parts exist.

---

## M1 — the duck, with no microphone — **built**

Shipped. Two things came out different from the sketch below, both for the
better, and both worth knowing before M3 builds on them:

- **The gain stage is built at join, not in `useSyncedAudio`.** Routing an
  element through Web Audio is permanent and total, so a context that is never
  resumed is not quiet music but *no* music. Building it lazily inside the join
  click means the element plays normally until there is a gesture to spend, and
  is never routed through a graph that cannot be woken. `App.tsx` owns it;
  `useSyncedAudio` was not touched at all.
- **The lease is `renew` as its own verb, swept from `app.ts`.** `Mic.sweep()`
  is a plain method against an injected clock rather than a timer inside the
  object, so every expiry test is a clock and a call.

The console gained one guard the sketch didn't call for: `wanted` folds in
`air.live`, so the talk key is refused by the same rule the station refuses it
by, and a broadcast ended mid-sentence lets go of the key on the console's side
too.


The complete experience of talking over the music, minus the talking. Worth
shipping and living with for an evening before committing to M3.

### `server/src/mic.ts` (new)

Modelled on `padding.ts`: in-memory, an `EventEmitter`, cleared when the session
ends. Not on `air.ts` — a mic break isn't a session and writes nothing down.

```ts
export interface MicSnapshot {
  live: boolean
  /** Linear gain the music sits at while the mic is hot. 0.2 ≈ −14 dB. */
  duckTo: number
  since: number | null
}

export class Mic extends EventEmitter {
  open(now: number): boolean      // idempotent; extends the lease
  close(): boolean                // idempotent
  duck(to: number): boolean       // clamped to [MIN_DUCK, 1]
  sweep(now: number): void        // closes a lapsed mic
  snapshot(): MicSnapshot
}
```

`set`-shaped rather than step-shaped, exactly as `Padding.set` is, and for the
same reason: two identical requests must leave one value, so a retry after a
dropped response can't double anything.

**The lease.** A mic that's live has an `expiresAt` a few seconds out. The
console renews it while it holds the mic, a `setInterval` on the server sweeps
lapsed ones. This is milestone 6 from the previous doc — *stale mic state
strands everyone in a duck* — and it costs about ten lines here rather than a
new mechanism later:

```ts
const MIC_LEASE_MS = 10_000   // renewed every 3s by the console
const MIC_SWEEP_MS = 2_000
```

If your tab dies mid-sentence, the room un-ducks within ten seconds. M3 tightens
this to instant by binding the mic to a socket; the lease stays as the backstop.

`MIN_DUCK` is `0.05`, not `0`. A duck to silence is a pause, and there's already
a pause button; more practically, a listener who can't hear the bed has no way
to tell a duck from the station having died.

### `server/src/routes/mic.ts` (new)

A near-copy of `routes/session.ts`. Commands go over HTTP behind
`requireAdmin`; `GET` is open, because whether someone is talking is not a
secret and arrives unasked on the socket anyway.

```
GET  /api/mic                                    → MicSnapshot
POST /api/mic { action: 'open' | 'close' | 'renew' }   → MicSnapshot
POST /api/mic { action: 'duck', duckTo: number }       → MicSnapshot
```

`renew` is separate from `open` so the console's 3-second heartbeat doesn't have
to mean "go live" — otherwise a race between a renew in flight and a deliberate
close reopens the mic.

Add `'mic'` to `COMMAND_TYPES` in `protocol.ts`, so a client that tries it on
the socket is told why rather than shrugged at, like `go_live` before it.

### `server/src/protocol.ts`

One new server frame, alongside `air` and `state`:

```ts
export type MicMessage = MicSnapshot & { type: 'mic' }
export function micMessage(snapshot: MicSnapshot): MicMessage
```

Add it to `ServerMessage`. It's separate from `state` for the reason the queue
is: playback changes several times a track, the mic changes on its own schedule,
and folding them together would ship a playback snapshot every time you drew
breath.

### `server/src/realtime.ts`

Three small additions, each mirroring what `air` already does:

- `mic?: Mic` in `RealtimeOptions`, optional, absent meaning never-live — the
  same shape as `air` being absent meaning always-on, so the existing tests
  don't need to know this feature exists.
- `send(socket, micMessage(mic?.snapshot() ?? SILENT))` in the connect burst,
  after `airMessage` and before `stateMessage`. A joiner mid-break must arrive
  already ducked, or they get a half-second of full-volume music under your
  voice.
- `mic?.on('change', …)` → `broadcast(micMessage(snapshot))`, unsubscribed in
  `shutdown()` alongside the others.

### `server/src/app.ts`

Build the `Mic`, register the routes, start the sweep interval (`.unref()`, like
the heartbeat), and hang the reset off the session-end path where `padding` and
`mutes` are already cleared — a mic left open across the end of a broadcast is
the same bug class as a padded headcount surviving the night.

### `client/src/lib/audio-graph.ts` (new)

The gain stage. This is the only genuinely fiddly file in M1.

```ts
export interface StationAudio {
  /** Ramp the music. Never a jump: a step change reads as a fault. */
  duck(to: number): void
  /** Spend the join gesture. Must be called from inside the click handler. */
  resume(): Promise<void>
  /** Where the voice plays, from M3. */
  play(stream: MediaStream): void
  close(): void
}

export function attachGraph(audio: HTMLAudioElement): StationAudio
```

```
<audio> ──▶ MediaElementSource ──▶ GainNode ──▶ destination
                                       ▲
                                   the duck
```

```ts
gain.gain.setTargetAtTime(to, ctx.currentTime, 0.08)
```

A time constant of `0.08` settles in roughly 250 ms, which sounds like a hand on
a fader.

Four things that will bite, in the order you'll meet them:

1. **`createMediaElementSource` may be called once per element, ever.** A second
   call throws `InvalidStateError`, and React's StrictMode double-invokes
   effects in development, so the naive version throws the first time you run
   it. Keep the node in a `WeakMap<HTMLAudioElement, StationAudio>` and return
   the existing one — the same trick `lib/audio-element.ts` already uses for
   pending seeks.
2. **Routing through the graph is permanent.** Once the element is a source
   node, its audio only reaches the speakers through the graph. That's fine —
   `setSource` swapping the `src` doesn't disturb it — but it means a bug in the
   gain path is total silence, not a quiet song.
3. **The context starts suspended.** `resume()` has to happen inside the join
   click, not in an effect that runs after it.
4. **The existing mute button is unaffected.** `App.tsx` mutes the element
   itself, upstream of the graph, so mute and duck compose without either
   knowing about the other. Leave it exactly as it is.

### `client/src/hooks/useSyncedAudio.ts`

One line: get the graph for the element and hold it. The sync logic doesn't
change at all — it still owns `currentTime` and `playbackRate`, and the graph
only owns gain.

### `client/src/lib/protocol.ts`, `useStation.ts`

Mirror the `mic` frame; add `mic: MicSnapshot | null` to `Station` alongside
`air`, and an `applyMic` for the optimistic fold-in that every other admin
command already does.

### `client/src/App.tsx`

- `station.mic?.live` → `audio.duck(mic.duckTo)`, else `duck(1)`.
- An on-air lamp. There's a natural home next to the existing `onAir` boolean at
  line 373 and the `Topbar`.
- `audio.resume()` inside the join handler.

### `client/src/AdminPanel.tsx`

A `MicCard` following the shape of `OnAirSwitch` and `Headcount`: a big talk
button, a duck-depth slider, and the headphones warning above both.

Push-to-talk and latch both, from the start — you'll reach for PTT and want
latch for a long segment:

```ts
// Ignore auto-repeat, and never while typing: the composer is one Tab away,
// and a spacebar that goes live mid-message is the worst version of this bug.
if (event.repeat || event.isComposing) return
if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return
```

**Hangover.** On key-up, wait ~400 ms before closing the mic. Without it the
music swells back up between your words. Doing it here rather than on the server
keeps the wire dumb: one timer in the console, nothing new on the protocol.

### Tests

Following the existing files exactly:

- `server/test/mic.test.ts` — open/close idempotent, `duckTo` clamped, lease
  expiry closes it, session end clears it.
- `server/test/mic-routes.test.ts` — `requireAdmin` gate, body schema, `GET`
  open, repeated `open` answers 200 with the same snapshot.
- `server/test/socket-contract.test.ts` — the `mic` frame is in the connect
  burst, and lands before `state`.
- `client/scripts/qa-mic.ts` — a Playwright script in the `qa-*` family: two
  browsers, press talk, assert both gain nodes ramp down.

**M1 is done when** you can open two browsers, press and hold talk in the
console, and watch the music dip in both at the same instant and come back
smoothly. Roughly 350 lines. Nothing about WebRTC exists yet.

---

## M2 — the console becomes usable — **built**

Shipped, and it earned its place: `getUserMedia` and its permission prompt now
land here rather than in M3, so a microphone that will not open is a problem
with a name of its own before any peer connection exists to be blamed for it.

Two things worth carrying into M3:

- **The mic has its own `AudioContext`,** separate from the music's. A console
  reached from `#on-air` is still playing the station — `joined` survives the
  trip — so the two graphs coexist on the same page. That also means the
  feedback path the headphones warning is about is real on the console itself,
  not hypothetical.
- **The monitor is refused on speakers, not warned about.** M3 adds a second
  place a microphone can reach a speaker; the same rule should hold there.

The meter loop writes `transform` straight to the node and never touches React.
When M3 adds per-peer connection state to the same card, that state *is* React
state — it changes a few times a minute, not sixty times a second — and the two
should not be confused for each other.


Small, entirely client-side, no protocol changes.

- **VU meter.** `ctx.createAnalyser()` on the mic stream,
  `getByteTimeDomainData`, RMS to a bar, driven by `requestAnimationFrame`.
  This is what tells you you're live without your having to hear yourself, which
  is the thing causing the feedback in the first place.
- **Input device picker.** `enumerateDevices()` filtered to `audioinput`. Note
  that labels are empty until permission has been granted once, so the picker is
  blank on first load and populated after — don't treat that as a bug.
- **Monitor toggle**, default off. When on, the mic stream goes to a second gain
  node into `destination`.
- **The headphones switch**, which is really a constraints switch:

  ```ts
  // On headphones: echo cancellation is tuned for speech and mangles anything
  // musical, and there's no echo to cancel. Off is a noticeably better voice.
  const constraints = onHeadphones
    ? { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    : { echoCancellation: true,  noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  ```

The mic stream is acquired here for the meter, which means `getUserMedia` and
its permission prompt land in M2 rather than M3 — a good thing, because it
separates "the browser won't give me the microphone" from "the peer connection
won't establish".

---

## M3 — voice — **built**

Shipped, with one deliberate scope change: **it fans out to the whole roster
rather than to one listener.** Limiting it to one would have meant shipping a
feature that silently does nothing for most of a room, and the code is the same
either way — a `Map` keyed by listener id, fed the roster minus this console.
The risky part of this milestone was never the count; it was whether SDP flows,
whether ICE connects, and whether a voice arrives and plays, and that risk is
identical for one peer or ten.

So M4 is now what is left of it: the per-listener status column, binding the mic
to the admin socket, `restartIce`, and the reconnect paths. The one-line
summary the console shows ("N of M hearing you") is the minimum honest
substitute in the meantime — a listener whose connection failed hears the music
duck and then nothing, which is invisible from the decks' side.

Two design changes worth carrying forward:

- **No `'decks'` literal.** Everything is addressed by socket id, which needs a
  new `you` frame telling each socket its own. That removes a special case and
  a genuine ambiguity — with two console tabs open, "the decks" is not one
  peer — and it means the rule the server enforces is a lookup rather than a
  keyword. A listener may address a socket that is an admin; that is the whole
  check.
- **The mute is a gain node, not `track.enabled`.** A disabled track silences
  everything downstream of it *including the analyser*, so the meter would die
  the moment you stopped talking — exactly when somebody is looking at it to set
  a level. The capture runs continuously, the meter always reads it, and what
  the peers receive comes off a `MediaStreamAudioDestinationNode` behind a gain
  that ramps.


The risky milestone. Do it alone, the way PLAN.md did the sync spike.

### Signalling on the socket

This is where the read-only rule bends, so it bends narrowly and on purpose.
`realtime.ts` currently says:

> *"Connections are read-only, and that is the socket's half of the admin gate."*

Signalling is not a command — it mutates nothing and drives nothing. But it is
privileged, so the socket needs to know who the admin is. It already can:
`verifyClient` receives the upgrade headers, and `hasAdminCredentials(config,
headers)` takes raw headers precisely so "the websocket upgrade, which never
becomes one, can ask the same question of the same code". Add an `isAdmin?:
(headers) => boolean` option beside `admit`, evaluate it once at connection, and
hold the boolean per socket.

Then one frame each way, with the server as an opaque relay that never parses
SDP:

```ts
// client → server
{ type: 'signal', to: number | 'decks', payload: unknown }
// server → client
{ type: 'signal', from: number | 'decks', payload: unknown }
```

Addressed by `listenerId`, which `Presence` already assigns per socket and
already publishes in the roster. Rules, enforced server-side:

- A non-admin socket may only address `'decks'`. Listeners must not be able to
  open connections to each other.
- Only an admin socket may address a numeric id.
- Rate-limited with its own bucket — `signalBurst` / `signalRefillMs`, following
  `chatBurst` and friends. Trickle ICE is chatty, so this is looser than chat:
  ~30 in a burst.

**`MAX_PAYLOAD_BYTES` is 4 KiB and an SDP offer will exceed it.** This is the
first thing that will break and it will look like the socket dying for no
reason. Two fixes, apply both: raise the cap to 16 KiB, and use trickle ICE so
candidates arrive as their own small frames instead of being bundled into a
fat offer.

### `client/src/lib/webrtc.ts` (new)

Peer plumbing, no React. The DJ is always the offerer and the audio is one-way,
so none of the perfect-negotiation machinery applies — there is no glare to
resolve.

```ts
// decks
const pc = new RTCPeerConnection({ iceServers })
pc.addTrack(micTrack, micStream)
pc.getSenders()[0].setParameters({ ...p, encodings: [{ maxBitrate: 32_000 }] })

// listener
pc.addTransceiver('audio', { direction: 'recvonly' })
```

`setParameters` rather than SDP munging. Munging works and is a maintenance
liability; the sender API says the same thing in one line.

### Where the voice plays

Not through a fresh `<audio>` element, and this is the part that reads as
over-thinking until it bites.

A remote WebRTC stream attached only to a Web Audio graph is silent in Chrome —
a long-standing quirk where the stream needs an element to drive its decoder.
And a fresh element created at 9:40 pm has no user gesture to spend, so
`play()` is refused for anyone who joined at nine.

So: **park the stream on a hidden muted `<audio autoplay>` element to satisfy
Chrome, and actually hear it through the AudioContext**, which the join click
already resumed:

```ts
sink.srcObject = stream          // muted; exists only to drive the decoder
ctx.createMediaStreamSource(stream).connect(ctx.destination)
```

The element goes in `App.tsx` next to the existing `<audio ref={audioRef}>` at
line 632, rendered always, so it exists before there's anything to put in it.

### `GET /api/rtc`

ICE server configuration, behind `requireListener`, so TURN credentials aren't
baked into the client bundle. New config in `server/src/config.ts`:
`STUN_URLS`, `TURN_URL`, `TURN_USER`, `TURN_PASS`, all optional — with none set
the station falls back to public STUN and works for most people.

If you self-host coturn, mint short-lived HMAC credentials per request rather
than serving a static password. It's a dozen lines and it means a leaked bundle
response is worthless in an hour.

**M3 is done when** one other browser hears you.

---

## M4 — status and control — **built**

The fan-out itself came forward into M3, so what shipped here is the part that
makes a failure visible and survivable.

**The mic is not bound to the console's socket, and that was a mistake in the
plan.** Closing the mic when the deck socket drops is wrong, because the two
paths are independent: the console renews over HTTP, which keeps working
through a socket blip that lasts a second. A mic closed on the socket alone
would un-duck the room in the middle of a sentence somebody is still saying.
So the socket does not decide — it only stops giving the benefit of the doubt.
`Mic.hurry` cuts the remaining lease to six seconds, which is comfortably longer
than the three between renewals: a console that is merely reconnecting keeps its
mic, and one whose tab was closed lapses in about the time it takes to notice.

**A failed connection is rebuilt rather than ICE-restarted.** An ICE restart is
lighter and is the right tool when there is transport state worth preserving.
Here there is none — audio one way, decks always offering — and a listener
answering a fresh offer on a fresh connection is a path this code already takes
every time somebody joins. Reusing it costs a second or two on a rare failure
and removes a whole second way for a negotiation to be half-finished. Bounded at
two attempts, which tells a network that changed under a laptop apart from a NAT
nothing will cross without a relay.

The console lists every listener, worst first. `lib/reach.ts` holds the ordering
because that is the feature — trouble has to be at the top of a list somebody
glances at between records — and it is testable away from React, which is how
everything else under a hook in this codebase is tested.

## M4 (original plan) — the mesh

Fan out. `useMic` watches `station.listeners` and diffs the roster: a new id
gets a peer connection, a departed id gets `pc.close()`. The same `micTrack`
object goes into every connection.

The console grows a column of connection states, from
`pc.connectionState` — `connecting` / `connected` / `failed` — because a
listener whose ICE failed hears the duck and then nothing, which is invisible
from your side and reads to them as you having gone quiet.

Bind the mic to the admin socket here, now that the socket knows it's the admin:
mic closes the moment that socket does, and the M1 lease stays as the backstop
for a machine that freezes without closing anything.

Expect it to feel fine to about fifteen listeners. Chrome encodes separately per
peer connection, so the ceiling is your CPU rather than your uplink. When it
hurts, the fix is an SFU behind the same `webrtc.ts` interface — LiveKit's free
tier — and it touches one layer.

---

## M5 — survive contact — **built**

Most of the list turned out to already work, and the one thing that did not was
not on it.

**Signalling that arrives before a page can act on it is now held, not
dropped.** Joining does three things at once — tunes in, asks `/api/rtc` how to
reach another browser, and lands on the roster — and the decks offer the moment
they see the third. Nothing orders those, so an offer can arrive while the ICE
servers are still a request in flight. The old code returned early, which looked
safe and was not: the decks offer when the roster *changes*, so there is no
second chance, and that listener would duck for every mic break for the rest of
the evening and hear none of them. Held frames are replayed in order (an offer
has to be answered before its candidates mean anything), bounded, and thrown
away whenever the socket or the broadcast they belonged to ends.

**The voice is gated on the station being on air at both ends.** What ends with
a session ends completely — the chat, the wishes, the history all go — and a
voice from a broadcast that finished would be the one thing left talking. The
sound check still works off air, because setting a level between broadcasts is
ordinary; what goes is the peer connections.

**A reconnect needed less than expected, and the reason is worth keeping.** If
only the console's socket drops, the listeners keep their ids, so the roster
does not change and the existing peer connections are left alone — which is
correct, because WebRTC is independent of the signalling channel once
established. The DJ reconnecting does not interrupt a voice. Only a listener
whose own socket dropped gets a new id, and that lands as a new roster entry the
existing diff already offers to.

Not covered by unit tests: the holdback queue and the readiness gating live in a
hook, and this codebase tests the wire underneath hooks rather than the hooks
themselves. The pure parts around it — ordering, health, peer plumbing — are,
and `npm run qa:voice` covers the whole path end to end in two real browsers.

## Verifying it

`qa:voice` is the one check that says two browsers can actually hear each other,
and it is worth knowing what it separates. Everything under the mic is unit
tested against a fake `RTCPeerConnection` and a fake `AudioContext`, which pins
the shape of a negotiation and says nothing about whether sound comes out of the
far end. So the script measures two different facts:

- **the voice arrived** — the peer connection is wrapped, tracks are counted,
  and `connectionState` is read rather than only remembered (`close()` sets it
  without firing an event, so a teardown never appears in the history);
- **the voice can be heard** — `createMediaStreamSource` is wrapped and an
  analyser hung off whatever the page plays, so the level at the listener's end
  is a number.

A connection that is healthy while the analyser reads zero is exactly the
failure this milestone was most warned about — a remote stream connected only to
Web Audio is silent in Chrome — and it is invisible from every other angle.
Chrome's `--use-fake-device-for-media-stream` makes the difference measurable
without a person in the room, because it produces a tone rather than silence.

## M5 (original plan) — survive contact

- A listener who joins mid-break: they get `mic.live` in the connect burst and
  duck immediately, but they need an offer too, so the roster diff has to fire
  on join, not only on mic-open.
- Reconnects. `StationConnection` already reconnects the socket; peer
  connections don't survive it and must be rebuilt on the new roster.
- `iceconnectionstatechange` → `failed` triggers one `restartIce()` before
  giving up.
- End-of-session: mic closed, all peers torn down, alongside the existing
  padding and mutes reset.
- The console's own tab closing mid-sentence, tested for real by killing it.

---

## Cost, once more, concretely

| | |
|---|---|
| New services | None |
| Railway egress | Unchanged — voice never touches the server |
| Railway CPU | Unchanged — the server relays a few hundred bytes of SDP per listener |
| TURN | ~14 MB per relayed listener-hour; inside every free tier, or ~$4/mo self-hosted |
| Your laptop | The real ceiling. ~15 listeners before the mesh gets warm |

## Order of work

| | | Risk | Rough size |
|---|---|---|---|
| M1 | The duck, no microphone | Low | **built** |
| M2 | Console: meter, devices, monitor | Low | **built** |
| M3 | Voice, fanned out to the roster | **High** | **built** |
| M4 | Per-peer status, mic lease on socket loss, retries | Medium | **built** |
| M5 | Reconnects, edges, teardown | Medium | **built** |

M1 and M2 are worth shipping on their own. If M3 goes badly, you still have a
station that ducks its music on command, and nothing you built is wasted.
