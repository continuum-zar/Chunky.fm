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

## C2 — extract the mixer — **built**

Shipped, and it did not turn out to be "no new behaviour" — the sketch was
wrong about that in a way worth recording.

**There are two doors into the mixer, not one.** Extracting the buses was the
easy half; the half that was missed is that something has to *build* them. The
only route into `ensure` was opening the microphone, so a console that brought
somebody up without ever granting a microphone still had no bus, and therefore
still had no peer connections — exactly the thing this milestone exists to fix,
failing silently. Bringing a guest up now builds the mixer too, and it has to
happen on that click rather than when the guest accepts: an audio context starts
suspended and only a user gesture may resume one, and the guest's acceptance is
not a gesture on this machine.

That was found in a browser rather than by a test, and it is worth knowing how,
because the first check written for it passed while the feature was broken. The
console renders its reach list whenever it has *something to send*, and the list
shows every listener as `connecting` until a peer connection says otherwise — so
a console with no bus at all draws a full list of people connecting, which is
indistinguishable at a glance from a working mesh. The assertion that caught it
is the summary line: **2 of 2 hearing you**, with no microphone open.

Two smaller things:

- **`MicInput.track` became `MicInput.live`.** The track belongs to the mixer now
  and outlives any one microphone, so what the console needs from the rig is not
  "what do I send" but "is there anything of mine on the bus". `sending` is that
  or a guest, and it is what takes the mesh up and down.
- **The rig no longer closes the context.** It stops its capture and disconnects
  its three nodes; the buses and the context belong to the mixer. Without that
  split, changing input device — which tears the rig down and rebuilds it —
  would have taken every connection in the room with it.

**Verified:** 14 new tests on the graph, including the one this whole feature
turns on — the room bus carries the guest and the guest bus does not — and
`qa:voice` passing unchanged in two real browsers, which is the claim the
milestone actually makes.

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

`client/test/mixer.test.ts`, 14 tests against a fake `AudioContext` that records
what was wired to what: the buses existing before any source is connected;
`talkIn` reaching both; **the guest reaching the room bus and never the guest
bus**; a guest arriving shut rather than on air; the cue never reaching the room;
the faders ramping, clamping, and cutting faster than they fade; and a browser
with no stream destination falling back to silence rather than throwing.

The real assertion of the milestone is not in that file, though: it is
`qa:voice` passing unchanged, in two real browsers, with the microphone rig
rebuilt underneath it.

**C2 is done when** `npm run qa:voice` passes with no behavioural change and the
console can open the mesh with no microphone granted.

---

## C3 — the guest's sound check — **built**

Shipped, and the interesting part is what the check turned out to be.

**It is a speaker detector, not a silence test.** The sketch described two
checks — say something, then don't — as if the second were about a quiet room.
It is not: the guest's music is still playing while it runs, because they have
not come up yet, so a microphone that hears anything is a microphone that can
hear the station, and on headphones it hears nothing. That reframing is load
bearing in two directions. It means the check must run *before* the local music
is taken away, which is an ordering the page has to preserve; and it means a
check run during a gap between tracks has nothing to detect, which is a few
seconds an evening and not worth engineering around. Both are written down where
somebody will find them.

**The verdict is slower than it looks and that is fine.** Measured in a browser:
a caller whose microphone can hear the station is refused at about ten seconds,
and one on headphones passes in about three. Against a sixty-second invitation
there is room for a failure and a retry, which was the number that needed
checking.

Three things that came out different from the sketch:

- **`useMicInput` now takes a bus rather than the console's mixer.** A guest
  needs one destination, not two, so `lib/mixer.ts` grew a `guestBus` beside
  `airMixer` and both satisfy a small `OutputBus`. The rig is otherwise
  identical at both ends of a call, which is the payoff for having separated it
  in C2 — the guest's microphone, meter, device handling and mute are the
  console's, with echo cancellation started on the other side of the switch.
- **The check reads the raw level, not the meter's.** The needle falls slowly on
  purpose — it is drawing the shape of a sentence — and a decision about whether
  a room is quiet made on it would keep failing rooms that had already gone
  silent. `useMicInput` gained an `onLevel` tap that hands out the raw number and
  a real interval, so a backgrounded tab reads as one long frame rather than a
  lot of missing ones.
- **`Called` became `CallIn.tsx`,** because it grew a microphone, a check and a
  meter, and `App.tsx` did not need another two hundred lines.

**Verified:** 23 new tests, and a new `qa:callin` — two real browsers, one
refused for being on speakers and one who passes, goes up, and whose own music
is measured going to silence and coming back. `qa:voice` still passes unchanged.

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

`client/test/sound-check.test.ts`, 15 tests over sequences of levels: silence
never passing `speak`; speech counted cumulatively, because "hello" is three
bursts with air between them; unbroken silence required for the second half; the
budget starting when the quiet half does rather than when the check did; and a
single long frame — a tab that was in a pocket — read as the time it really was
rather than as one frame.

Plus `deafened` in `hand.test.ts`, which is the whole of "a caller hears the
studio, not the record" as four assertions, and `guestBus` in `mixer.test.ts`.

What none of that can test is whether the check detects the thing it is for, so
`npm run qa:callin` does: a caller on Chrome's beeping fake device — which is
exactly the wrong shape to pass, and stands in for a laptop playing the station
out loud — never reaching a way up, and a caller on a capture file of speech
then silence passing, going up, and having their own music measured going to
zero and back.

**C3 is done when** a guest can be invited, pass a sound check, come up, hear
their own music go silent, watch their meter move — and still not be heard.

---

## C4 — the talk channel, to your headphones only — **built**

Shipped, and it earned its billing as the risky one — not in the negotiation,
which went in as designed, but in two bugs that every instrument except the
right one reported as success.

**A guest's stream needs an element to decode it.** The same Chrome quirk
`audio-graph.ts` has documented since M3, reappearing on the console's side of
the call and wearing the same disguise: the peer connection is `connected`, the
console's own health column says *you can hear them*, the guest's meter is
moving on their machine — and there is silence. `createMediaStreamSource` on its
own builds a graph that runs and carries nothing. The fix is the one that was
already written down twenty lines away, and the lesson is that the workaround
belongs anywhere a remote stream meets Web Audio, not only where it was first
found.

**The mute button did not mute.** `guest.input` is a fresh object every render,
so the effect that opens the microphone on the way up ran on every render too,
and put `talking` back a frame after anybody pressed mute. Destructuring the
`useState` setter — which is stable — fixed it. Neither of these is reachable by
a unit test: both are a real connection carrying real audio, and both were found
by measuring the console's own headphones.

Three things that came out different from the sketch:

- **The server rule got simpler and stronger.** The plan had the station
  refusing an offer from a listener *who does not hold the floor*, which would
  have meant the socket layer knowing about the floor. It does not need to: under
  this design a listener never offers at all, including the guest, because the
  decks offer `recvonly` and the guest answers. So the rule is just *listeners do
  not start negotiations* — one `kindOf` peek, no floor, no SDP parsed.
- **The channel tag is stamped inside `link`,** not by callers. A payload that
  left without one would be dropped by whichever connection caught it, silently,
  and "every caller remembered" is not a property worth relying on.
- **The cue lives on the mic card, not the floor card.** The floor card is about
  permission; whether you can hear somebody is about audio, and it belongs beside
  the list of who can hear you — one of it and thirty of those, which is why it
  sits above rather than in that list.

**Verified:** 6 new unit tests on the negotiation, 3 on the station's refusal, 2
on the decoder sink, and `qa:callin` grown to measure the console's own
headphones: nothing before they come up, a voice at peak 0.51 once they do,
silence when they mute, and silence again when they come down. `qa:voice`
unchanged.

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

- `client/test/webrtc.test.ts` — the decks offering `recvonly` even for a voice
  coming the other way; the microphone going onto the transceiver the offer made
  rather than onto a second one; `sendonly` set explicitly, because a `recvonly`
  offer is answered `inactive` by default; the guest's leg costing more than the
  fan-out does; candidates tagged; and an unknown channel refused rather than
  guessed at.
- `server/test/signalling.test.ts` — an offer from a listener refused by name,
  and their answers and candidates still carried, tag and all.
- `client/test/mixer.test.ts` — the stream parked on a muted element, which is
  the bug above with a test on it now.

**C4 is done when** you can hear a guest in your headphones and nobody else can
hear a thing.

---

## C5 — mix-minus, and on air — **built**

Shipped. The room hears a caller and the caller does not hear themselves,
measured at both ends: **0.28 in the room, 0.0006 in their own ears** — a factor
of about four hundred, which is the whole feature as one number.

The ordering held up exactly as the sketch below argues, and putting it inside
the talk-channel effect rather than leaving it to the console is what made it
possible to state: the swap onto the mix-minus bus happens when the connection
is *built*, which is necessarily before any audio can arrive on it, and the air
fader opens in `onStream`. There is no window, rather than a window nobody has
managed to hit yet.

Three things that came out different:

- **The cut stands the guest down as well.** The sketch had it dropping the
  fader and closing the channel, which would have left the console showing
  somebody on air who could not be heard — a state with no name and no way out
  except a second button. Now it is one key: the fader hits zero client-side in
  the same frame, and the floor drop follows over HTTP. Bound to `shift+X`
  rather than a bare key, because the console is a page somebody types on and
  this is the one control that cannot be undone.
- **`onAir` is called by the hook, not by the console.** The console owns the
  *level*; only `useVoiceBroadcast` knows whether the swap has happened yet, and
  the order matters more than the value.
- **`VOICE_CARRIES` is gone,** along with both branches it guarded. It existed to
  keep two screens honest across four milestones; a constant that outlived its
  reason would be worse than the sentence it replaced.

And one real bug, found by making the QA do a second call rather than one:
**the guest's microphone was never given back.** `CallIn` was rendered only
while somebody was invited or up, so React unmounted it before its own cleanup
could observe that the call had ended — leaving a caller who had come down with
an open capture and a recording light. It now renders always and draws nothing
most of the time, which looks wasteful and is the thing that makes the teardown
reachable.

**Verified:** `qa:callin` grown to seven more checks — the room hearing them, the
guest not, the cut, a call after a cut, and the microphone going back. Plus a
unit test that `replace` swaps the source without touching the local
description, which is what buys the gap-free swap. `qa:voice` unchanged.

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

`client/test/mixer.test.ts` already pinned the graph in C2 — **the room bus
contains the guest and the guest bus does not** — and `webrtc.test.ts` gained
the other half: `replace` swapping a sender's source while the local description
stays exactly as it was, which is what makes the swap free.

Neither is the real assertion. That one is in `qa:callin`, at both ends of a
real call at once, because either half alone is meaningless: a room that hears
nothing is a broken call, and a guest who hears themselves is an unusable one.

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

## C6 — survive contact — **built**

Shipped, and most of the list was already true — the floor has been pinned to a
socket since C1, which is what a lot of these rows turn out to be. What was
missing was in two places.

**The talk channel had no retry.** The room's connections have had a bounded
ladder since M4 and a guest's did not, which matters more rather than less: a
listener who cannot be reached misses a mic break, while a guest who cannot be
reached is *on air*, in front of a room that has ducked for them, saying things
nobody can hear. It has its own counter rather than a row in the room's, because
it counts a different thing — a caller whose downlink was rebuilt twice has used
none of the patience owed to their uplink — and the end of the ladder is a word
on the console rather than silence, because the decision to stand somebody down
belongs to the person who can see it.

**A call could end without the caller being told.** The decks stand them down,
the broadcast finishes, or their own socket drops and comes back as a new
listener — the capability was granted to a socket, and a reconnect is a
different one. All three look identical from the caller's side, which is a
banner disappearing mid-sentence. There is now a plain "you're off the mic" for
eight seconds, and it sits *behind* a fresh invitation rather than in front of
one, because somebody stood down and asked back up inside the same few seconds
is exactly what a failed connection and a second attempt look like.

The same honesty applies while they are up: what the page says now depends on
the actual state of their uplink, so a caller whose voice is not getting through
is told so rather than being left with an optimistic *on its way*. They cannot
fix it and should not keep talking into it.

One bug, and it was mine twice over: the "you're off the mic" notice was keyed
on the state rather than on the change, so on first render it told every
listener in the room that a turn they had never had was over.

**Verified:** `qa:callin` grown to 33 checks across three browsers, including
the two rows that can be produced on demand — somebody arriving mid-call
hearing the guest *and* arriving already ducked for them, and a caller whose tab
dies being stood down with the console and the room both going quiet. Plus a
server test for the row that cannot be produced in a browser: the console dying,
its lease lapsing, and the floor going with the mic.

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

`server/test/floor.test.ts` covers the state transitions and
`floor-routes.test.ts` the two that are wiring — the mic shutting for any
reason, including a lapsed lease, taking the floor with it. The reconnect and
teardown paths live in hooks, and this codebase tests the wire underneath hooks
rather than the hooks themselves, so the rest is `npm run qa:callin`: three
browsers, a call placed, cut, placed again, walked in on, and finally killed by
closing the caller's tab.

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
| C2 | Extract `useAirMixer` | Low | **built** — ~700 lines with tests | Yes |
| C3 | The guest's sound check | Low | **built** — ~900 lines with tests | **Yes** |
| C4 | The talk channel, cue only | **High** | **built** — ~700 lines with tests | **Yes** — audition |
| C5 | Mix-minus, on air, the cut | Medium | **built** — ~400 lines with tests | — |
| C6 | Survive contact | Medium | **built** — ~350 lines with tests | — |

All six are built.

C1, C3 and C4 were each worth shipping on their own, and that was not a
consolation prize: after C4 there was a station where somebody could raise a
hand, be brought up, duck the room and be heard by whoever runs the decks in
their headphones. Nothing built before it was wasted.

C5 was the one to be careful with — short, apparently trivial, and the bug it
can introduce is silent on every screen you can see. It went in cleanly, and the
reason is worth keeping: the ordering lives inside the effect that owns the
talk channel, so the swap happens when the connection is *built* and cannot
race the audio that arrives on it later.

## After the first evening

Run with people rather than with browsers, and it hung up on the caller. Three
bugs, and the first two were one bug wearing the other's clothes.

**The talk key hung up on the caller.** Whoever runs the decks says "hello
sipho", lets go, and four hundred milliseconds later the console asks the
station to close the mic — which is what a hangover is for, and which drops
whoever has the floor, because a shut mic is an un-ducked room and a guest still
shown as up would be talking under music at full volume. That wiring was right
and the verb was wrong: **closing the mic ends your own break, and standing
somebody down ends a call.** They are two acts and now have two verbs. The
station refuses a close while somebody holds the floor, and the console stops
asking; the lease still lapses directly, which is what ends a call the console
died in the middle of.

**The console's own microphone was open for the whole of every call.** The card
followed the station's mic state, which was the same answer as the talk key
right up until a guest could open the mic too. Nobody decided that a caller
being brought up should put the room the console is sitting in on the air.

**And then nobody could talk to their caller at all.** Fixing the second one
meant the talk key had to be held for the whole of a conversation — and a guest
hears the decks through that same gain, so the likely outcome was somebody
wondering why the person they had just invited could not hear them. Bringing
somebody up now latches the mic, because bringing somebody up *is* the decision
to talk to them.

The QA had a hole shaped exactly like this: it placed calls and never had
anybody speak during one. It does now, and it also measures the other direction
— the caller hearing the decks with no key held, which is the assertion that
would have caught all three.

One thing found and not fixed, because it is a guess rather than a diagnosis: a
console tab left hidden for more than a few minutes has its timers throttled to
about one a minute, and the mic lease is ten seconds. That would end a call the
same way and for a reason nobody chose. The fix is to stop leaning on a client
timer while a call is up — the console's *socket* is better evidence it is alive,
and the station already watches that — but it changes when a mic may lapse, so
it wants deciding rather than sneaking in.

## What this cost, in the end

| | Planned | Built |
|---|---|---|
| C1 | ~400 lines | ~1,000 with tests |
| C2 | ~200 lines | ~700 with tests |
| C3 | ~250 lines | ~900 with tests |
| C4 | ~250 lines | ~700 with tests |
| C5 | ~150 lines | ~400 with tests |
| C6 | ~150 lines | ~350 with tests |

The estimates were for the code and the tests are most of the rest, which is the
ordinary shape of it here. What the estimates missed entirely was the browser
work: four of the six bugs found in this feature were invisible to every unit
test and to every screen except one, and all four were caught by measuring
audio at both ends of a real call. `qa:callin` is 33 checks, and it earned every
one of them.
