# Live mic: talking over the decks

PLAN.md ends with a list of things deferred on purpose, and this is the last
line of it: *mic / talk-over-the-music DJ mode*. This is the document that
un-defers it.

The short answer is yes, it's possible, it can be done for nothing, and the
hard part is not the microphone.

## The thing that makes this awkward

chunky.fm is not a stream. That is worth saying plainly before anything else,
because every instinct about "adding a mic to a radio station" assumes it is.

Nothing about the music passes through the server. The server holds a clock and
broadcasts one small tuple:

```ts
{ currentTrack, startedAt, pausedAt }
```

Every listener's browser fetches the file itself from `/api/audio/...` and
aligns to that tuple, correcting drift with a 2% playback-rate nudge. Thirty
listeners means thirty independent players agreeing on the time. It means the
server's outbound bandwidth is a few hundred bytes a second and its CPU is idle.
It's why the station runs on the cheapest thing Railway sells.

A microphone has none of those properties. The sound exists on exactly one
machine — yours — and there is no file to align to, no `startedAt` to seek
against. It has to genuinely travel, live, in a way nothing else in this app
does.

So the question isn't "how do I add a mic". It's **which of two stations do you
want to be running afterwards**, because there are two answers and they lead to
very different codebases.

## The two answers

### Answer 1 — keep the clock, send only the voice

The music keeps working exactly as it does today: local file, local playback,
clock-aligned. Only your voice travels, peer-to-peer, over WebRTC. When you
press talk, the server broadcasts a small `mic` frame and **every listener's
browser turns its own music down**. Nothing is mixed anywhere. The duck happens
in thirty places at once, on a shared clock, which is a trick this architecture
is unusually well set up to pull off.

Your voice is Opus mono at ~32 kbps. That is nothing.

### Answer 2 — become an actual stream

Mix music and mic on the server, encode once, and serve one MP3/AAC stream to
everybody. Icecast, or Liquidsoap, or AzuraCast. This is what a real internet
radio station is.

It is also a rewrite. `useSyncedAudio`, `useServerClock`, `lib/drift.ts`,
`lib/position.ts`, the whole clock-offset handshake, the range-request seeking
— all of it becomes dead code, because a stream has no position to align to; you
join where the stream is. You'd keep the queue, the chat, the wishes, the
console. You'd lose the part of the project that was hard and interesting, and
you'd start paying for bandwidth: 128 kbps × 30 listeners is ~1.7 GB an hour of
egress, against roughly zero today.

And it doesn't even solve the mic on its own. Getting your voice *into* a
server-side mixer still needs either WebRTC or a desktop encoder like BUTT or
Mixxx — at which point you're not broadcasting from the browser any more.

### Recommendation

**Answer 1.** It costs nothing, it leaves the sync engine untouched, and the
ducking behaviour it gives you is *better* than a mixed stream's, because the
duck is a station-wide event on a shared clock rather than a fader position
baked into an encode.

Answer 2 is the right call only if you outgrow ~30 listeners, or you want people
to be able to tune in from VLC and a car stereo, or you want the mic in the
recorded history. Note that below, and don't build for it now.

## What "free" actually means here

You asked about free APIs. For Answer 1 you don't need an API at all — WebRTC is
built into every browser. The pieces:

| Piece | What it does | Cost |
|---|---|---|
| Signalling | Passing SDP offers/answers and ICE candidates between browsers | **Free** — you already have a WebSocket doing exactly this kind of work |
| STUN | Lets two browsers discover their public address | **Free** — Google runs public ones; so does everyone |
| TURN | Relays audio for the minority who can't connect directly | **The only real cost, and it rounds to zero** |
| Encoding | Opus, in the browser | Free, your CPU |
| Bandwidth | Peer-to-peer, never touches Railway | Free |

TURN is needed for the ~10–20% of listeners behind a symmetric NAT or a strict
corporate firewall — for them, a direct connection just fails. But mono voice is
32 kbps, so a relayed listener costs about **14 MB an hour**. Five of them across
a four-hour session is under 300 MB. Every free tier on the market covers that
several times over:

- **Cloudflare Realtime TURN** — generous free allowance, no card for the tier
  you'd use.
- **Metered** — ~500 MB/month free, which is more than an evening needs.
- **Self-hosted coturn** — a $4/mo VPS, if you'd rather own it.

If you ever do want a managed service instead of hand-rolling the mesh:
**LiveKit Cloud** (free tier, open-source SFU, would fix the fan-out ceiling
described below), **Daily.co** or **Agora** (free minute allowances). None are
needed to start. For Answer 2, the free equivalents are **AzuraCast** or
**Icecast** self-hosted, or **Zeno.fm** for free hosted internet radio.

## How it works, concretely

### The duck is a broadcast, not a mix

This is the good idea in the whole document, so it goes first.

Right now, `useSyncedAudio` points an `<audio>` element at a URL and lets it
play. To duck it you need a gain stage, which means a small Web Audio graph on
every listener:

```
<audio> ──▶ MediaElementSource ──▶ GainNode ──▶ destination
                                      ▲
                              the duck rides here
```

The server grows a `mic` frame alongside `air` and `state`:

```ts
{ type: 'mic', live: boolean, duckTo: number, since: number | null }
```

`duckTo` is a linear gain — 0.2 is about −14 dB, a reasonable default and a knob
you should be able to turn from the console mid-sentence. When it arrives, every
client ramps:

```ts
gain.gain.setTargetAtTime(live ? duckTo : 1, ctx.currentTime, 0.08)
```

A ramp, never a jump. An instantaneous gain change is an audible click and reads
as a fault rather than a decision. ~250 ms to settle sounds like a hand on a
fader.

Notice what this buys: the duck is decoupled from the voice entirely. It works
before a single line of WebRTC exists, it works for a listener whose peer
connection failed, and it happens everywhere at once because it's the same
broadcast mechanism that already keeps thirty players on the same beat.

### The voice rides a mesh

Under thirty listeners, you don't need a media server. Your browser opens one
`RTCPeerConnection` per listener and sends the same mic track down all of them.

```
                 ┌──▶ listener 1
your browser ────┼──▶ listener 2      (music: still local, still clock-aligned)
   (mic only)    ├──▶ …               (voice: peer-to-peer, ~32 kbps each)
                 └──▶ listener 30
```

Signalling goes over the socket you already have. There's one wrinkle: the
socket is currently, and deliberately, read-only —

> *"Connections are read-only, and that is the socket's half of the admin gate.
> A socket that carries a valid admin cookie gets no more than one that carries
> nothing."* — `server/src/realtime.ts`

SDP and ICE have to flow *up* that socket, which breaks that rule. Two honest
options, and I'd take the second:

1. Do signalling over HTTP polling. Preserves the rule, adds latency and ugliness.
2. Let the socket carry signalling frames only, gated on the admin cookie for
   the offering side. The cookie is already on the upgrade request, and
   `realtime.ts` already has an `admit(headers)` hook that reads those headers —
   so this is a small, well-precedented change rather than a new auth story.
   Commands still go over HTTP; going on mic is a command, and belongs in a
   `routes/mic.ts` next to `routes/session.ts`. Only the SDP/ICE plumbing is on
   the socket, and plumbing isn't a command.

### Mute and unmute

Two different controls, and you want both:

- **Push-to-talk** — hold a key. Safer, and it's what you'll actually reach for.
  Bind it carefully: if it's the spacebar and focus is in the chat composer,
  you'll type a space and go live at the same time.
- **Latched** — click on, click off, for a long segment.

Under both, mute is `track.enabled = false`, **not** stopping the track. Stopping
tears down the media and unmuting then costs a renegotiation — a second of dead
air right when you've started talking. Disabling is instantaneous and the
connection stays warm.

The duck should follow the mic key with a small hangover — roughly 400 ms — so
the music doesn't swell back up in the gaps between your words.

### Feedback, which will bite you

Your browser is also a listener. It's playing the music out of your speakers. If
your mic is open, it picks that music up, sends it to thirty people, and they
hear a smeared echo of a song they're already playing. If you're monitoring
yourself, it becomes a howl.

- **Headphones, always.** This isn't advice, it's a requirement, and the console
  should say so above the mic button.
- **Local monitoring defaults to off**, with a toggle for when you're on
  headphones and want to hear yourself.
- Give the console a **VU meter**. Without one, the only way to know you're live
  is to hear yourself, and hearing yourself is the thing causing the problem.
- `getUserMedia` constraints are a real choice, not a default:
  `echoCancellation` is tuned for speech and mangles anything musical, so with
  headphones you want it **off** for a better voice. Expose it as "I'm on
  speakers" and flip the three constraints together.

### The gotcha that will waste an afternoon

Browsers won't start audio without a user gesture. PLAN.md already handles this
for music — the Join button *is* the gesture. But a listener who joined at 9pm
and hears your first mic break at 9:40 has no fresh gesture to spend.

So: **create the remote audio element and the AudioContext at join time**, while
you still have the gesture, even though there's no voice to put in them yet.
Attach the incoming track to that already-unlocked element later. Build it the
other way round and it works perfectly in your testing — because you clicked
something a moment ago — and is silent for everyone who's been sitting there a
while.

## What this costs you

Being honest about the downsides, roughly in order of how much they'll actually
hurt.

**1. Your upstream is the ceiling.** Thirty peer connections at 32 kbps is ~1
Mbps up, which most connections have. The sharper limit is CPU: Chrome encodes
separately per peer connection in a mesh, so thirty listeners is thirty Opus
encodes on your laptop. Opus mono is cheap, but this is the thing that breaks
first. Expect it to feel fine to ~15 and to get warm past that. If the station
outgrows it, the fix is an SFU — LiveKit's free tier — and it's a change to one
layer, not a rewrite.

**2. Some listeners will silently not hear you.** NAT traversal fails for a
minority, and the failure is invisible: they hear the music duck and then
nothing, which reads as you having gone quiet. TURN fixes most of it. Regardless,
the console needs a per-listener connection state — a column of green dots — or
you'll never know it happened.

**3. Your voice lands ~300–500 ms late.** You hear the music at the station's
clock position; listeners hear your words about half a second after you meant
them. For "that was Talking Heads, here's something slower", nobody will ever
notice. For dropping a line precisely on a beat, it's hopeless. Live radio has
always had this; it's only worth knowing so you don't chase it as a bug.

**4. The voice isn't in the timeline, and isn't in the history.** Someone who
joins mid-sentence hears half a sentence. There's no seeking back to it, and the
now-playing history won't show it. That's inherent to live, and the only cure is
Answer 2 plus a recorder.

**5. Mobile is a listener-only story.** iOS Safari suspends WebRTC in a
background tab, and grabbing the mic on iOS seizes the audio session in ways
that interfere with the music already playing. Listening on a phone is fine.
**DJing from a phone: don't support it initially.** Desktop Chrome or Firefox.

**6. Stale mic state strands everyone in a duck.** If your browser dies while
you're live, the server still thinks the mic is hot and thirty people listen to
a permanently quiet song. The `mic` state needs a heartbeat and an expiry, the
way `air.ts` needs `close()` so a crash doesn't leave a session open forever.
Same class of bug, and worth stealing the same shape of fix.

**7. Genuine architectural cost.** You are adding a second realtime path, with
completely different failure modes, to a codebase whose defining property is that
no audio flows through the server. That's roughly 600–900 lines across both
sides and a new category of "works on my machine".

## Build order

M1 is deliberately the whole user experience with none of the WebRTC risk, and
it's worth shipping on its own — you'll learn whether the ducking feels right
before committing to the hard part.

1. **The duck, with no microphone.** Web Audio gain stage on every listener,
   `mic` state on the server, `mic` frame on the wire, a talk button that ducks
   the room and lights an on-air lamp. Test it by talking over the phone to a
   friend while you press it. If ducking at 0.2 with a 250 ms ramp doesn't feel
   like radio, tune it here, where there's nothing else to blame.
2. **Console controls.** Duck depth knob, push-to-talk and latch, VU meter,
   input device picker, monitor toggle, the headphones warning.
3. **One-to-one voice.** WebRTC from your browser to exactly one listener.
   Signalling over the socket, STUN only, no TURN yet. This is the risky
   milestone; do it alone, as PLAN.md did with the sync spike.
4. **Fan out to the mesh.** N peer connections, per-listener connection state in
   the console, TURN configured for the ones that fail.
5. **Make it survivable.** Mic-state heartbeat and expiry, reconnect handling,
   a listener who joins mid-break, the DJ's tab dying mid-sentence.

## Files this touches

New:

```
server/src/mic.ts               mic state, modelled on air.ts
server/src/routes/mic.ts        go-mic / end-mic / duck depth, behind requireAdmin
client/src/lib/audio-graph.ts   the MediaElementSource → GainNode graph
client/src/lib/webrtc.ts        peer connection plumbing
client/src/hooks/useMic.ts      DJ side: capture, PTT, peers
client/src/hooks/useMicAudio.ts listener side: receive, duck, play
```

Changed:

```
server/src/protocol.ts     MicMessage out; signalling frames in
server/src/realtime.ts     admin-gated signalling; the read-only rule bends here
server/src/app.ts          register the mic routes
client/src/hooks/useSyncedAudio.ts   route the element through the gain node
client/src/AdminPanel.tsx  the mic section
client/src/App.tsx         the on-air lamp; unlock the context at join
```

The milestone-by-milestone version of this — frames, signatures, file by file —
is in [broadcasting-build.md](./broadcasting-build.md).

## Deferred, deliberately

- Recording mic breaks into the history.
- An SFU, until the mesh actually hurts.
- Listener call-ins. The mesh and the admin gate both assume exactly one voice.
- Answer 2, the real stream — revisit only if you outgrow thirty listeners or
  want people tuning in outside a browser.
