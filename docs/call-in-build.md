# Call-in: the build

The companion to [call-in.md](./call-in.md), which argues for making the console
the hub rather than putting a guest into the mesh. This is that decision turned
into files, frames and an order to write them in.

It follows [broadcasting-build.md](./broadcasting-build.md) and inherits its
rules. Nothing here changes how music reaches a listener; nothing here changes
what an ordinary listener — one who never raises a hand — experiences. Every
milestone is written so that a station with the floor permanently empty behaves
exactly as it does today.

Milestones are numbered `C1…C6` so they do not collide with the mic's `M1…M5`.

## The shape of it

```
        HTTP, behind requireAdmin           the socket, from a listener
   console ─── POST /api/floor ───▶ Floor ◀─── { type: 'hand', … }
                                     │
                                     ├─── { type: 'floor', … } ──▶ everyone
                                     └─── { type: 'hands', … } ──▶ the decks

   guest ──── voice, one connection, ~48 kbps ────▶ console
                                                      │ mixes
                                                      ▼
                        room bus ──── voice, ~32 kbps ────▶ every listener
                        guest bus ─── voice, minus the guest ───▶ the guest
```

Three independent paths again, and the separation is the reason C1 ships alone.
The floor is state on the existing socket and works with no audio at all. The
talk channel is WebRTC and is allowed to fail without taking the room down. The
mix-minus is Web Audio on one machine and is invisible to the wire.

---

## C1 — the floor, with no audio — **built**

Shipped. Six things came out different from the sketch below, and the first two
are the ones worth knowing before C4 builds on them.

- **`invite` refuses anybody who has not raised a hand.** The sketch left the
  door open to bringing up an arbitrary listener; closing it made the whole
  design smaller. There is no way to open a stranger's microphone, an invitation
  is a reply rather than a summons, and — the part that was not foreseen —
  `Floor` never has to know what a roster is, because the nickname arrived with
  the hand. That removed the wiring that would have had to reach the presence
  map from an HTTP route.
- **Three verbs from the listener, not four.** `lower` withdraws a hand,
  declines an invitation and comes down off the mic, because those are one
  intent and the station already holds the state that says which. Four verbs
  would be four chances for a client to pick the wrong one, and the worst of
  those is a guest pressing *leave* and staying on air.
- **Two events, not one.** `Floor` emits `change` (broadcast) and `hands` (to
  the decks alone, through a new `toDecks` in `realtime.ts`). One event carrying
  both would have made a raised hand a broadcast, which is the one thing this
  feature must not do.
- **The listener page tracks its own raised hand.** It has to: the station tells
  the decks who asked and tells nobody else, so a page cannot read its own hand
  off a broadcast. It remembers, and forgets on a reconnect, on a session
  ending, on being invited, and on a refusal — which is the price of the privacy
  and worth paying.
- **The mic and the floor are wired together in `app.ts`, asymmetrically.**
  Somebody coming up opens the mic; standing them down does *not* shut it. But
  the mic shutting — including the lease lapsing because the console died — does
  take the floor with it, because a shut mic is an un-ducked room and a guest
  still shown as up would be talking under music at full volume.
- **`VOICE_CARRIES`, a constant that exists to be deleted.** C1 can bring
  somebody up, duck thirty browsers and put their name on the badge, and cannot
  carry a word they say. A page telling them "the room can hear you" would be
  lying to the only person who cannot check, so both screens say the true thing
  instead and one constant in `lib/hand.ts` turns that sentence off in C5.

One smaller correction, found on review rather than in a test: the invitation
countdown reads `clock.serverNow` rather than `Date.now`. `expiresAt` is a point
on the station's clock, and a browser a minute out would have offered a button
that had already stopped working.

**Verified:** 663 server tests, 358 client tests, and one pass by hand against a
running station — hand up, reaching the console and no listener; invite;
accept; the room ducking; drop leaving the mic open; and the guest's tab dying
mid-call taking the floor with it.


The complete experience of bringing somebody up, minus their voice. A hand goes
up, you bring them up, the room ducks and the lamp says *sipho is on the mic* —
and sipho cannot say anything, because nothing is transmitted yet.

Worth shipping and living with. You will learn whether sixty seconds is the right
invitation window and whether hands should really be private before any of it is
load-bearing.

### `server/src/floor.ts` (new)

Modelled on `mic.ts`: in memory, an `EventEmitter`, cleared when the session
ends. A call is not written down, for the same reason a mic break is not.

```ts
export interface Guest {
  id: number
  nickname: string
}

export interface FloorSnapshot {
  /** Who is on air besides the decks. Broadcast to everyone. */
  speaker: (Guest & { since: number }) | null
  /** Asked up, not yet answered. Broadcast, because the guest learns of it here. */
  invited: (Guest & { expiresAt: number }) | null
}

export class Floor extends EventEmitter {
  raise(id: number, nickname: string): boolean    // listener, over the socket
  lower(id: number): boolean
  hands(): Guest[]                                // for the decks only
  invite(id: number, nickname: string): boolean   // console, over HTTP
  accept(id: number): boolean                     // guest, over the socket
  drop(id: number): boolean                       // console, or the guest leaving
  leave(id: number): boolean                      // a socket closed
  sweep(): boolean                                // an invitation nobody answered
  clear(): void                                   // the session ended
  snapshot(): FloorSnapshot
}
```

Five things to get right here, because they are cheaper now than later.

**`invite` refuses while anybody is up or invited.** One speaker, enforced in the
one place that can enforce it. The console's button should be disabled too, but a
disabled button is a thing the page draws, not a thing that cannot happen — the
same reasoning `useMicInput.chooseSpeakers` already uses for the monitor.

**`accept` only from the id that was invited.** The invitation is the capability.
A listener who sends `accept` without one is refused, not promoted.

**No lease on the speaker, and one on the invitation.** The mic needs a lease
because the console renews over HTTP and the station cannot see it die. Every
floor state is pinned to a socket the server is already watching and already
reaps in `socket.on('close')`, so `leave(id)` is enough. The exception is the
invitation, which is waiting on a human:

```ts
export const INVITE_TTL_MS = 60_000
```

Swept from `app.ts` beside the mic's sweep, for the reason `Mic.sweep` is: every
expiry test becomes a clock and a call rather than a fake timer wheel.

**Hands survive a lower and a leave, and nothing else.** A hand is not a queue
position, it is a fact about a socket. When the socket goes, so does it.

**`clear()` empties everything, including the hands.** Unlike `Mic`, nothing here
is a fader position belonging to whoever runs the decks; it is all claims about
tonight's room, and every one of them is a lie applied to another night.

### `server/src/routes/floor.ts` (new)

A near-copy of `routes/mic.ts`.

```
GET  /api/floor                                        → FloorSnapshot
POST /api/floor { action: 'invite', listener: number }  → FloorSnapshot
POST /api/floor { action: 'drop' }                      → FloorSnapshot
```

`GET` open, like `/api/mic`: who is talking is not a secret and arrives unasked
on the socket a moment later. `POST` behind `requireAdmin`.

`invite` refuses `409` off air, and `409` when somebody is already up. `drop`
answers `200` either way — a drop that arrives just after the guest left has
nothing to drop, and that is the ordinary end of every call rather than a
failure worth a status code.

`invite` reads the nickname from `Presence`, never from the body. A frame that
named its own nickname would let the console put a name on the room's on-air lamp
that the roster does not agree with — the same rule that makes `chat` look up its
author.

Add `'floor'` to `COMMAND_TYPES` in `protocol.ts`, so a client that tries it on
the socket is told `command_over_http` rather than shrugged at.

### `server/src/protocol.ts`

Two frames down, one up.

```ts
export type FloorMessage = FloorSnapshot & { type: 'floor' }
export function floorMessage(snapshot: FloorSnapshot): FloorMessage

export interface HandsMessage {
  type: 'hands'
  hands: Guest[]
}
export function handsMessage(hands: Guest[]): HandsMessage

export interface HandClientMessage {
  type: 'hand'
  action: 'raise' | 'lower' | 'accept' | 'leave'
}
```

Add `'hand'` to `SocketErrorAbout`, so a refusal can say what it was about, the
way `join`, `say`, `wish` and `signal` already do.

`hand` is on the socket and `floor` is on HTTP, and that split is not arbitrary:
a listener has no credentials and the socket is the only channel they have, which
is exactly why `say` and `wish` live there. Commands from the console go over
HTTP. Nothing changes about the rule; the feature just uses both ends of it.

### `server/src/realtime.ts`

`floor?: Floor` in `RealtimeOptions`, optional, absent meaning nobody can ever be
up — the same shape as `air` and `mic` being absent, so the existing tests do not
need to know this feature exists.

A `hand` handler beside `say` and `wish`, with the same gates in the same order:

```ts
function hand(socket, listenerId, limit, action) {
  if (!floor)   → 'no_floor'
  if (!onAir()) → 'off_air'          // before the roster check, as `say` does
  nickname = presence.nicknameOf(listenerId)
  if (nickname === null) → 'not_joined'
  if (mutes?.has(nickname)) → 'muted'  // after the name, before the pace check
  if (!limit.take()) → 'slow_down'
  …
}
```

The mute gate matters. A mute already covers chat and wishes because both are
text signed with a nickname; a mute that left the microphone open would just move
where somebody was shouting.

Its own bucket, tight — a hand is not chatty:

```ts
const DEFAULT_HAND_BURST = 5
const DEFAULT_HAND_REFILL_MS = 3_000
```

Two new broadcast paths. `floor` goes to everyone, exactly like `mic`. `hands`
goes to the decks only, which needs a small helper that the roster cannot do,
because `deckSockets` and `socketsById` are about connections rather than about
people:

```ts
function toDecks(message: ServerMessage): void {
  for (const id of deckSockets) {
    const socket = socketsById.get(id)
    if (socket?.readyState === WebSocket.OPEN) send(socket, message)
  }
}
```

In the connect burst, `floorMessage` goes immediately after `micMessage` and
before `stateMessage`, for the same reason `mic` does: a listener arriving
mid-call should come in already knowing who is talking rather than being told a
frame later. And `handsMessage` only if this socket is one of the decks — a
console that opens after three hands went up must not start empty.

In `socket.on('close')`: `floor?.leave(listenerId)` before the presence check,
and broadcast if it changed anything. In the existing `onDecksGone` path, clear
the floor — the guest's voice travels through the console, so a console that has
gone takes the call with it whether the station admits it or not.

### `server/src/app.ts`

Build the `Floor`, register the routes, fold `floor.sweep()` into the interval
that already sweeps the mic, and hang `floor.clear()` off the session-end path
where `padding`, `mutes` and the mic are already cleared.

**The mic follows the floor.** `floor.on('change')` opens the mic when a speaker
appears:

```ts
floor.on('change', (snapshot) => { if (snapshot.speaker) mic.open() })
```

The room must be ducked before the first word, which is the same reason a
listener arriving mid-break is handed `mic` before `state`. Note what is *not*
here: dropping a guest does not close the mic. You will nearly always say
something after them, and un-ducking between their last word and your first is a
swell of music in the middle of a sentence.

### `client/src/lib/protocol.ts`, `useStation.ts`, `lib/admin.ts`

Mirror the frames — `FloorMessage`, `FloorSnapshot`, `HandsMessage`, `Guest` —
following `MicMessage`/`MicSnapshot` exactly. In `useStation`: `floor:
FloorSnapshot | null` and `hands: Guest[]` beside `mic`, reset to `null`/`[]`
alongside it, plus an `applyFloor` for the optimistic fold-in every other admin
command already does. In `admin.ts`, a `floor(action, listener?)` next to
`mic(action)`.

### `client/src/App.tsx`

- A **raise-hand** button, next to the wish composer, which is the control it
  most resembles: a small private request to whoever runs the decks. Disabled
  off air and while muted, refused by the same rules the station refuses it by.
- The **invitation**, when `floor.invited?.id === me`: a panel that says the
  decks have asked you up, with a countdown, *go up* and *not now*. In C1 *go up*
  sends `{type:'hand', action:'accept'}` and does nothing else.
- The **on-air lamp gains a name**. There is already an `onAir` boolean and a
  `Topbar`; the guest's nickname goes beside it.

Nothing about `stationAudio` changes. The room ducks because `mic.live` went
true, through the path M1 built.

### `client/src/AdminPanel.tsx`

A `FloorCard` beside `MicCard`, following the shape of `Mutes` and `Headcount`:
the hands list with a *bring up* per row, and whoever is up with a *stand down*.

Use the `micAction` pattern, not `run`: bringing somebody up while holding the
talk key must not grey the console for a round trip.

### Tests

- `server/test/floor.test.ts` — 29 tests: every transition; `accept` from an
  uninvited id refused; `invite` refused while somebody is up and refused for an
  id with no hand; the invitation expiring; a socket closing at each state;
  `clear` emptying the hands.
- `server/test/floor-routes.test.ts` — 15 tests: the `requireAdmin` gate, the
  body schema, `GET` open and carrying no hands, `409` off air, `drop`
  idempotent, and the mic wired to the floor in both directions.
- `server/test/hands.test.ts` — 20 tests over real sockets: a hand reaching the
  decks and no listener, the gates in a wish's order, pacing, the name coming
  off the roster, a rename following, `accept` refused without an invitation and
  from the wrong socket, and the room ducking for a guest.
- `server/test/invariants.test.ts`, `socket-contract.test.ts` — `floor` in the
  connect burst, landing after `mic`; `floor` refused as a socket command.
- `client/test/hand.test.ts` — the refusal prose, and the countdown reading a
  clock it is handed rather than one it reaches for.

**C1 is done when** you can raise a hand in one browser, bring it up in the
console, watch the music duck in a third, and see *sipho is on the mic* on every
screen — with sipho unable to make a sound. Roughly 400 lines.

---

## C2 — extract the mixer

No new behaviour whatsoever. This is the milestone that makes C4 and C5 small,
and it is the easiest one to verify because everything must keep working exactly
as it does today.

The problem it solves: `useMicInput` couples the microphone and what goes out.
Today the outbound bus does not exist until `getUserMedia` succeeds, and
`useVoiceBroadcast` only builds peer connections when `track !== null`. A
guest-only segment — you bring somebody up and let them talk while you say
nothing — needs the second without the first.

### `client/src/hooks/useAirMixer.ts` (new)

Owns the context, the buses, the guest input and the faders. `useMicInput` keeps
the capture, the meter, the device picker and the monitor, and connects into it.

```ts
export interface AirMixer {
  /** Where a source goes to be heard by the room and by the guest. */
  readonly talkIn: GainNode | null
  /** What every listener is sent. Exists whenever the mixer does. */
  readonly roomTrack: MediaStreamTrack | null
  /** What the guest is sent: the room, minus the guest. */
  readonly guestTrack: MediaStreamTrack | null
  /** Play a voice arriving from a guest. Null takes it away. */
  hear(stream: MediaStream | null): void
  /** The guest in your headphones. C4. */
  cue(on: boolean): void
  /** The guest in the room. C5. */
  air(level: number): void
  /** Take the guest off the room bus in a ramp too short to hear. C5. */
  cut(): void
  resume(): void
  close(): void
}
```

```
mic ──┬─▶ analyser                      (the meter, useMicInput)
      ├─▶ monitor gain ──▶ destination  (your headphones, useMicInput)
      └─▶ talkIn ──┬─▶ room bus
                   └─▶ guest bus

guest ──▶ cue gain ──▶ destination      (C4)
      └─▶ air gain ──▶ room bus         (C5)
```

Three gotchas, in the order you will meet them.

1. **The mixer's context is the mic's context.** `useMicInput` already builds its
   own, deliberately separate from the music's, and both a guest's voice and your
   own have to end up on the same buses. Move the context into the mixer and let
   `useMicInput` take it as an argument; do not build a third.
2. **`talkIn` is a node, not a track.** `useMicInput`'s `talk` gain connects to
   it. Keep the ramp where it is — it is what stops a break opening with a click.
3. **A `MediaStreamAudioDestinationNode` produces a track immediately**, before
   anything is connected to it, which is exactly what makes this milestone
   possible: the mesh can come up before there is a microphone.

### `client/src/hooks/useVoice.ts`, `AdminPanel.tsx`

The mesh gate moves from *the mic is open* to *there is something to send*:

```ts
const sending = input.track !== null || floor.speaker !== null
```

Deliberately not *always, while on air*. Warm connections all evening would
remove the second of negotiation at the start of every break, and would also
hold a relay allocation open per listener who needs one, all night, for silence.
Today's rule is the cheaper one; keep it and just widen it by a guest.

### Tests

`client/test/mixer.test.ts` against the existing fake `AudioContext`: the room
track exists before any source is connected; connecting `talkIn` reaches both
buses; closing disconnects everything. Plus the existing `mic-input.test.ts` and
`audio-graph.test.ts` continuing to pass untouched, which is the real assertion
of this milestone.

**C2 is done when** `npm run qa:voice` passes with no behavioural change and the
console can open the mesh with no microphone granted.

---

## C3 — the guest's sound check

Entirely client-side, no protocol changes, nothing transmitted. The guest opens
their microphone, sees a meter, and is told whether their room is going to be a
problem.

### `client/src/hooks/useGuestVoice.ts` (new)

Wraps `useMicInput`, which is already free of anything console-specific, with two
differences that matter.

**Echo cancellation on by default**, the opposite of the console's default.
`micConstraints(deviceId, onSpeakers)` already flips the three constraints
together; a guest simply starts on the `onSpeakers: true` side of it. It mangles
music, and a guest is not sending music.

**The sound check is a gate, not advice.** Two checks, both off the analyser
that already exists:

```ts
export type SoundCheck = 'speak' | 'quiet' | 'passed' | 'noisy'
```

- *speak* — the level has to move. Proves the right device is open, and catches
  a mic muted in hardware, which is the single most common way this fails.
- *quiet* — then two seconds of silence. If the level is still up, something in
  their room is making noise into the microphone, and they are told before thirty
  people hear it.

`passed` is a precondition of `accept`, not something offered afterwards.

### The caller hears the studio, not the record

One line, and the strongest thing in this document. While this listener is up,
their own music ducks to silence locally — not to `duckTo`, all the way down:

```ts
// App.tsx, replacing the existing duck effect
const up = floor?.speaker?.id === me
stage.current?.duck(up ? 0 : mic?.live ? mic.duckTo : 1)
```

This removes the entire acoustic-echo class of problem, because there is no music
coming out of their speakers to be picked up. It is also exactly what being a
caller on real radio sounds like, so it needs no explaining to the person it
happens to. When they come down the music resumes — position is a pure function
of the station clock, so there is nothing to resynchronise.

On iOS this stops being a choice: `getUserMedia` seizes the audio session and
will interrupt the element anyway. Better done deliberately everywhere than
suffered on one platform.

Note the `0` here versus `MIN_DUCK` on the server. `MIN_DUCK` exists so a
listener can tell a mic break from the station having died; a guest who is
holding a microphone and watching their own meter is in no doubt.

### `client/src/CallIn.tsx` (new)

The guest's panel: the invitation and countdown, the sound check, a large meter,
an unmissable on-air state, a mute button they can reach without hunting, and
*leave*.

Latched, not push-to-talk. The console gets PTT because whoever runs it chose to
be there; a guest fumbling a held key while trying to talk is worse than a guest
who forgets to mute.

### Tests

`client/test/sound-check.test.ts` — the state machine over a sequence of levels:
silence never passes `speak`; noise never passes `quiet`; the two in order pass.
Pure, and testable away from React like everything else under a hook here.

**C3 is done when** a guest can be invited, pass a sound check, come up, hear
their own music go silent, watch their meter move — and still not be heard.

---

## C4 — the talk channel, to your headphones only

The risky milestone. Do it alone, the way M3 was done, and stop before the room
hears anything. What you get at the end of it is genuinely useful on its own:
auditioning a caller before airing them is a thing a station does.

### `client/src/lib/webrtc.ts`

A channel tag on the payload, and one new function. That is the whole change.

```ts
/** Which of the two connections this belongs to. Absent means 'listen'. */
export type Channel = 'listen' | 'talk'

export type SignalPayload =
  | { kind: 'offer';  sdp: string;                    channel?: Channel }
  | { kind: 'answer'; sdp: string;                    channel?: Channel }
  | { kind: 'ice';    candidate: RTCIceCandidateInit; channel?: Channel }

/** The console's end of the talk channel: offers recvonly, receives a voice. */
export function inviteVoice(options: ReceiveOptions): PeerLink
```

Optional and defaulting, so nothing already on the wire changes meaning.
`isSignalPayload` validates it when present and rejects an unknown string.

**Why the tag is not optional in practice:** both connections between the console
and the guest carry signalling from the same socket id. An ICE candidate for the
talk channel is indistinguishable from one for the listen channel, and whichever
link receives it wrongly discards it silently. Both ends key their link maps by
`` `${id}:${channel}` `` instead of by id.

**The decks still always offer.** `inviteVoice` offers `recvonly` — *I would like
to receive* — and the guest answers `sendonly` with their track attached. The
listener never initiates anything, so the sentence the whole file rests on still
holds and there is still no glare to resolve:

```ts
export function inviteVoice(options: ReceiveOptions): PeerLink {
  const pc = new RTCPeerConnection({ iceServers: options.iceServers })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = (event) => options.onStream(event.streams[0] ?? new MediaStream([event.track]))
  const made = link(pc, options)
  // …offer, exactly as offerVoice does
  return made
}
```

The guest's end is `offerVoice` — the function the console already uses — pointed
at their own capture and answering rather than offering. `link()` already handles
the offer→answer path generically; the only change is that a listener may now
attach a track before answering, when the offer asked for one.

**Raise the guest leg's bitrate.** `VOICE_BITRATE` is 32 kbps because it is
multiplied by thirty. The guest → console leg is a single connection and it is
the input to a re-encode, so give it more:

```ts
/** The guest's uplink: one connection, and the source of everything the room
 *  will hear of them. Better in means better out of the re-encode. */
export const GUEST_BITRATE = 48_000
```

### `client/src/hooks/useVoice.ts`

`useVoiceBroadcast` grows a second map for talk-channel links, opened for exactly
one id — whoever the server says holds the floor — and torn down when that
changes. Its `handleMessage` still ignores offers on the listen channel and now
accepts answers and candidates on both.

**The one client-side gate that matters:** an offer arriving on the talk channel
is only accepted from `floor.speaker?.id`. The server permits a listener to
address the decks — it always has — so without this check any listener could push
audio at the console by offering unasked.

`useVoiceReceiver` grows the guest's side: when this page holds the floor and has
passed its sound check, an incoming `recvonly` offer on the talk channel is
answered with the capture track attached.

### `server/src/realtime.ts` — belt and braces

The server already peeks at `kindOf(payload)` to choose a log level. That is
enough to refuse relaying an `offer` from a listener who does not hold the floor,
without ever parsing SDP and without acquiring an opinion about WebRTC versions
it cannot keep current:

```ts
if (!fromDecks && kind === 'offer' && floor?.snapshot().speaker?.id !== senderId) {
  send(socket, errorMessage('not_the_floor', 'only a guest may offer a voice', 'signal'))
  return
}
```

Two independent refusals for the one thing that would actually be bad here.

`MAX_PAYLOAD_BYTES` is already 16 KiB and the signalling bucket is already 40 in
a burst; a second negotiation with one peer fits inside both with room to spare.
Nothing to change.

### `client/src/AdminPanel.tsx`

A cue button on the guest's row, and a `ReachRow` for their talk channel using
the `HEALTH` table `reach.ts` already exports. Two states worth telling apart in
the UI, because they have different causes and different fixes: *they cannot hear
you* (listen channel) and *you cannot hear them* (talk channel).

### Tests

- `client/test/webrtc.test.ts` — a candidate tagged `talk` reaches the talk link
  and not the listen link; `isSignalPayload` rejects an unknown channel.
- `client/test/voice-gate.test.ts` — an offer on the talk channel from an id that
  does not hold the floor is ignored.
- `server/test/realtime.test.ts` — the server refuses to relay an offer from a
  listener without the floor, and still relays their answers and candidates.

**C4 is done when** you can hear a guest in your headphones and nobody else can
hear a thing.

---

## C5 — mix-minus, and on air

The short milestone that the previous four were for.

### The swap, and its order

```ts
mixer.hear(stream)                     // C4: the guest's voice arrives
guestLink.replaceTrack(mixer.guestTrack)   // 1. swap them onto the mix-minus bus
mixer.air(1)                               // 2. only then put them on the room bus
```

**That order is the milestone.** Do it the other way round and there is a window
— short, but a whole syllable — in which the guest is on the room bus and still
receiving it, which is the delayed-sidetone failure this entire design exists to
avoid. On stand-down, reverse it: `air(0)` first, then swap back to the room bus.

`replaceTrack` does not renegotiate. Both tracks are mono audio off the same
context, so the sender swaps sources and the guest hears no gap in your voice
while they are being put on air. If a browser ever refuses, the fallback is the
rebuild path `useVoiceBroadcast` already takes on a failed connection — a second
of silence, not a broken feature.

### `useVoiceBroadcast` takes a track per peer

```ts
- track: MediaStreamTrack | null
+ trackFor(id: number): MediaStreamTrack | null
```

Everyone gets the room bus; whoever holds the floor gets the guest bus. Keep the
map keyed on the id so the existing diff — new ids get a connection, departed ids
get `close()` — does not have to learn anything new.

### The instant cut

One key on the console, always bound, always reachable, that takes the air gain
to zero in a ramp too short to hear and then closes the talk channel. Client-side,
so it costs no round trip: the guest is off the room bus in the same frame you
press it.

It cannot un-say the word. It can stop the second one, and that is the whole of
what is available — [call-in.md](./call-in.md) explains why a profanity delay is
not on the table for a station whose music is aligned to a clock.

Bind it to something you cannot hit by accident and cannot miss in a hurry, with
the same guards `MicCard` already uses for the talk key:

```ts
if (event.repeat || event.isComposing) return
if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return
```

Put a *stand down* button next to it that is polite rather than abrupt, so the
sharp one stays sharp.

### Tests

`client/test/mixer.test.ts`, extended — **the room bus contains the guest and the
guest bus does not.** This is the most important test in the feature, because the
bug it catches is inaudible to the only person who can see the console. Assert on
the fake `AudioContext`'s connection graph: a path from the guest source to the
room destination, and no path from the guest source to the guest destination.

`client/scripts/qa-callin.ts` — three Chrome pages with fake devices, following
`qa-voice.ts` exactly, which is built for making two separately observable claims:

- **the listener hears the guest** — the analyser on the plain listener's page
  reads above `HEARD` while the guest's fake device is playing its tone;
- **the guest does not hear the guest** — the analyser on the guest's page reads
  below `QUIET` at the same instant.

The second assertion is the one that would otherwise only ever be found by a
guest giving up mid-sentence and not telling you why.

**C5 is done when** a caller can be heard by the room, cannot hear themselves,
and can be cut in the time it takes to press one key.

---

## C6 — survive contact

Every row of the failure table in [call-in.md](./call-in.md), made true.

- **The guest's tab closes.** `socket.on('close')` → `floor.leave` → broadcast.
  The console tears down both channels on the roster diff it already runs.
- **The invitation is never answered.** `floor.sweep()` at `INVITE_TTL_MS`.
- **The talk channel fails ICE.** The same bounded retry ladder as the listen
  channel — `MAX_VOICE_ATTEMPTS`, `RETRY_DELAY_MS` — then `unreachable`, and the
  console says which direction failed.
- **Your tab dies mid-call.** The mic lease lapses and the room un-ducks; the
  floor is cleared by `onDecksGone`. The guest's voice was travelling through you,
  so it stops with you either way — this only makes the room's state agree with
  what it can hear.
- **The guest's own socket reconnects.** They get a new id, which lands as a new
  roster entry — and, critically, as a *different* id from the one holding the
  floor. Decide deliberately: the simplest correct answer is that a reconnect
  ends the call, because the capability was granted to a socket. Say so on their
  screen rather than leaving them holding a dead microphone.
- **A listener joins mid-call.** They get `mic` and `floor` in the connect burst,
  so they arrive ducked and knowing who is talking, and the console's roster diff
  offers them a listen channel as it already does.
- **The broadcast ends mid-call.** `floor.clear()` alongside the mic, the padding
  and the mutes. What ends with a session ends completely.

### Tests

`server/test/floor.test.ts` covers the state transitions; the reconnect and
teardown paths live in hooks, and this codebase tests the wire underneath hooks
rather than the hooks themselves. `npm run qa:callin` covers the whole path.

---

## Cost, once more, concretely

| | |
|---|---|
| New services | None |
| Railway egress | Unchanged — no audio touches the server, still |
| Railway CPU | Unchanged — a second negotiation's worth of SDP per call |
| TURN | One more relayed leg while a call is live: ~20 MB per hour, worst case |
| The guest's machine | One connection each way. A phone can do this |
| Your laptop | +1 decode, +1 mix. Against thirty encodes already running, nothing |

The station's defining property survives intact, which remains the main argument
for building it this way.

## Order of work

| | | Risk | Rough size | Ships alone |
|---|---|---|---|---|
| C1 | The floor, no audio | Low | **built** — ~1,000 lines with tests | **Yes** |
| C2 | Extract `useAirMixer` | Low | ~200 lines, no new behaviour | Yes |
| C3 | The guest's sound check | Low | ~250 lines | **Yes** |
| C4 | The talk channel, cue only | **High** | ~250 lines | **Yes** — audition |
| C5 | Mix-minus, on air, the cut | Medium | ~150 lines | — |
| C6 | Survive contact | Medium | ~150 lines | — |

C1, C3 and C4 are each worth shipping on their own, and that is not a
consolation prize: if C4 goes badly you still have a station where somebody can
raise a hand, be brought up, duck the room and be heard by you in your
headphones. Nothing built before it is wasted.

The one to be careful with is C5, because it is short, it looks trivial, and the
bug it can introduce is silent on every screen you can see.
