# Chunky.fm

A single, permanent radio station. See [PLAN.md](PLAN.md) for the design.

## Running it

In Docker, the whole station from one command:

```bash
./start.sh
```

It writes a `.env` with a generated `ADMIN_PASSWORD` the first time, rebuilds
whatever has changed since last time, and waits until the station answers before
telling you where it is:
<http://localhost:18173/listen> to listen, `/listen#admin` to run it. The bare
<http://localhost:18173> is the page describing the station; see [the landing
page](#the-landing-page).

**Listening asks for nothing.** Anybody with the address can tune in: no code,
no account, nothing to type. A door is one variable away if you want one, and
the whole mechanism behind it is still there, but it is off by default, because
a code somebody has to be told and then remember is the most expensive thing on
the way in and most stations do not need it. See
[`/api/listen`](#apilisten--who-may-hear-the-station).

**The decks are guarded.** `ADMIN_PASSWORD` is what stands between a listener
and uploading, driving the decks or ending the broadcast, and unset it falls
back to a code baked into the server: `houseKey` in `server/src/config.ts` says
how to read it back without it being written down anywhere. Anything reachable
from the internet should set its own.

```bash
./start.sh --build    # the same, but pull fresh base images first
./start.sh logs       # follow them
./start.sh status     # what is up, and how healthy
./start.sh stop       # stop, keeping the library
```

The published ports are `18173` (station) and `13000` (API) rather than the
`5173`/`3000` that `npm run dev` uses, so the container stack and a dev server
can be up at the same time without fighting over a port. Change them in `.env`
(`WEB_PORT`, `SERVER_PORT`), or per-run: `WEB_PORT=18080 ./start.sh`. If either
is already taken, `start.sh` says so by name instead of letting Docker fail with
a container id.

### What is actually running

Two containers, not three. chunky.fm's database is SQLite, opened in-process by
the server through `better-sqlite3`, so there is no database server to start, and
the thing a `db` container would own is a volume instead:

| | |
|---|---|
| `server` | Fastify: API, `/ws`, and the SQLite file it opens directly. Always :3000 inside the network; published on `SERVER_PORT`. |
| `web` | nginx serving the built client, proxying `/api` and `/ws` to `server`, the same job Vite's dev proxy does, so the client ships unchanged. |
| `chunky-fm_data` | The volume behind `AUDIO_STORAGE_DIR`: `chunky.sqlite`, audio, artwork. |

Those three parts of the volume only mean anything together: the rows name
files, so back it up whole:

```bash
docker run --rm -v chunky-fm_data:/data -v "$PWD:/out" busybox \
  tar czf /out/chunky-backup.tar.gz -C /data .
```

`./start.sh stop` and `--build` both leave it alone. To actually throw the
library away: `docker compose down && docker volume rm chunky-fm_data`.

### Without Docker

Two processes in development: the server, and Vite for the client:

```bash
cd server && npm install && cp .env.example .env && npm run dev   # :3000
cd client && npm install && npm run dev                           # :5173
```

Vite proxies `/api` and `/ws` through to the server, so the client only ever
talks to its own origin.

Then open <http://localhost:5173/listen#admin> and sign in with `ADMIN_PASSWORD` to
upload tracks and run the station. The browser trades the password for a session
cookie once and never sends it again; a shell has nowhere to keep a cookie, so
the password itself is accepted on any admin request too:

```bash
curl -H "Authorization: Bearer $ADMIN_PASSWORD" -F "file=@track.mp3" \
     http://localhost:3000/api/upload
curl -H "Authorization: Bearer $ADMIN_PASSWORD" -H 'content-type: application/json' \
     -d '{"action":"play","trackId":1}' http://localhost:3000/api/playback
```

Or queue tracks up and let the station run itself. The first one goes straight
on the decks, the rest follow as each track ends:

```bash
curl -H "Authorization: Bearer $ADMIN_PASSWORD" -H 'content-type: application/json' \
     -d '{"trackId":1}' http://localhost:3000/api/queue
```

## Server

```bash
cd server
npm install
cp .env.example .env      # set ADMIN_PASSWORD
npm run dev
```

Scripts: `npm run dev`, `npm run build`, `npm start`, `npm run typecheck`, `npm test`,
`npm run sync-check` (joins two listeners at different times and checks they land
on the same instant of the same song).

### Storage layout

Everything the station owns lives under `AUDIO_STORAGE_DIR` (the Railway volume):

```
audio_storage/
  audio/            <sha256>.mp3       the uploaded files, named by content hash
  artwork/          <sha256>.jpg       artwork extracted from tags
  tmp/                                 in-flight uploads, cleaned on completion
  chunky.sqlite
```

The database holds `tracks` (the library), and `sessions` + `messages` +
`wishes` + `plays` (the chat, the requests and what has been on; see below).
Playback, the queue, the roster and the skip tally are not in it: they are true
only while the process (or the socket) is up, by design.

### `POST /api/upload`

Admin-only, one audio file per request as `multipart/form-data`.

```bash
curl -H "Authorization: Bearer $ADMIN_PASSWORD" \
     -F "file=@track.mp3" \
     http://localhost:3000/api/upload
```

The upload streams to `tmp/` first and is only moved into `audio/` once
`music-metadata` confirms it is a container we can serve, so the declared
Content-Type is a hint, never the gate. Files are stored under their SHA-256,
which makes re-uploading the same track a no-op rather than a second copy.

| Status | When |
|---|---|
| `201` | Stored. Body is `{ track }`. |
| `400` | No file part, empty file, or a malformed multipart body. |
| `401` | Missing or refused admin credentials. |
| `409` | Already in the library. Body carries the existing `track`. |
| `413` | Over `MAX_UPLOAD_BYTES` (default 150 MB). |
| `415` | Not audio, or a container we don't serve. |

Supported containers: MP3, FLAC, Ogg/Opus, WAV, MP4/M4A, AIFF.

### Serving the library

| Route | What |
|---|---|
| `GET /api/tracks` | The library, as JSON. |
| `GET /api/audio/:filename` | The audio, with `Range` support. |
| `GET /api/artwork/:filename` | Artwork extracted at upload time. |

Range support is load-bearing: a listener joining at 2:14 has to fetch that byte
range before it can play, and without it the browser pulls the file from 0:00
first. URLs are content hashes, so responses are `immutable`.

### `GET /ws`: the station clock

The server owns playback and holds it entirely in memory:

```ts
{ track, startedAt, pausedAt }
```

Position is `pausedAt ?? (serverNow - startedAt)`. Nothing is streamed and there
is no per-listener state: listeners are handed the tuple and align themselves
to it. Because `startedAt` is a point in the past, joining at 2:14 is the same
code path as joining at 0:00.

**Server → client**

| Message | When |
|---|---|
| `{ type: 'state', track, startedAt, pausedAt, serverTime }` | On connect, and on every playback change. |
| `{ type: 'queue', entries }` | On connect, and on every queue change. |
| `{ type: 'presence', listeners }` | On connect, and whenever someone joins, leaves or renames. |
| `{ type: 'chat', messages }` | On connect (the tail of the conversation), and one per new message. |
| `{ type: 'wished', wish }` | To the socket that made a wish, and to nobody else. |
| `{ type: 'history', plays }` | On connect (the evening so far), and one per track going on. |
| `{ type: 'skips', trackId, votes, voted }` | On connect, on every skip vote, and whenever a track change clears the tally. |
| `{ type: 'pong', t0, t1 }` | In reply to a clock probe. |
| `{ type: 'error', code, message, about? }` | Anything the socket refused; the connection stays open. |

`code` is machine-readable and `message` is prose, the same split as the `error`
field on every HTTP refusal, so a client telling `slow_down` from `not_joined`
switches on the code rather than matching on English. The codes are
`unrecognised_message`, `nickname_required`, `message_too_long`,
`empty_message`, `command_over_http`, `not_joined`, `no_chat`, `wish_too_long`,
`empty_wish`, `no_wishes`, `nothing_playing` and `slow_down`. `about` names the
frame a refusal was for (`'join'`, `'say'`, `'wish'` or `'vote'`) and is absent
only when the frame was too malformed to say what it was trying to do; a page
with two composers and a vote button needs it to put "not sent" under the right
one.

`wished` is the only message here that is not a broadcast. See **Wishes**.
`skips` is the only one sent socket by socket rather than serialised once, since
`voted` is a different answer for each listener. See **Skip votes**.

The queue and the roster are separate messages rather than fields on `state`:
playback changes several times a track and neither of the others does, so
folding them together would ship both on every seek.

**Client → server**

| Message | Purpose |
|---|---|
| `{ type: 'ping', t0 }` | Clock offset probe. |
| `{ type: 'join', nickname }` | "Here is what to call me." |
| `{ type: 'say', text }` | "Say this to the room." |
| `{ type: 'wish', text }` | "I'd love to hear this." Goes to the admin, not the room. |
| `{ type: 'vote_skip', voted }` | "I'd rather hear something else." Counts; skips nothing. |

Every frame a listener can repeat is paced per socket, with a bucket of its own:
five messages back to back (one earned back every 2s), five *roster-changing*
joins (one every 5s), three wishes (one every 30s), and five *tally-changing*
skip votes (one every 5s). Separate buckets, so being refused a wish never costs
a listener their voice. A join that renames a
socket to what it is already called broadcasts nothing and so costs nothing,
which is what keeps a reconnect's rejoin free. Over the limit is a `slow_down`
refusal, not a dropped connection. Chat and wishes are paced because the server
writes them down; `join` because a roster goes out to every listener each time
one changes, which is otherwise the cheapest way for one anonymous socket to
make the station shout at the whole room.

Browser clocks are wrong by seconds, so a client measures the offset NTP-style:
send `t0`, receive `t1`, note `t2` on arrival, then
`rtt = t2 - t0` and `offset = t1 - (t0 + rtt / 2)`. Run ~5 probes and keep **the
sample with the lowest RTT**, because the fastest round trip is the least contaminated
by queueing delay. `t1` and `startedAt` are stamped from the same server clock,
so the measured offset applies directly.

Connections are read-only: nothing anyone can send over the socket changes
playback. That is also the socket's half of the admin gate: a socket
carrying a valid admin cookie gets no more than one carrying nothing, and frames
that look like commands (`play`, `skip`, `enqueue`, …) are refused *by name*, so
a client that tries is told where the controls actually are rather than left
guessing. There is no privileged frame here to authenticate, because every
mutation lives behind `requireAdmin` on an HTTP route.

**Commands go over HTTP, not the socket**, deliberately. The socket carries
state outward, and inward only what has nowhere else to go: a clock probe, which
is meaningless anywhere but on the connection it is measuring; a nickname, which
lives exactly as long as the socket does; a chat message, which has to reach
everyone in the room the moment it is sent; a wish, which has to be signed with
the name its own socket is listed under, and a `POST` would have to be told who was
asking, and a request that names its own author can name someone else; and a
skip vote, which is that same signature problem plus a tally that has to reach
the room live. None of the five drives the station. An admin action wants
exactly what HTTP already gives it: a request/response pair, a status code that
says whether it worked, and, for upload, a body measured in megabytes. Adding
a second, authenticated command channel over the socket would duplicate that
surface and add an auth gate to get wrong, in exchange for nothing a `POST`
doesn't already do. A socket that cannot mutate anything is a socket that cannot
be abused into mutating something.

So the loop is: admin `POST`s, the server changes its state, and the change goes
out to every client, including the admin's own page, on the socket they all
already have open.

### Presence

The server keeps a socket → nickname map and broadcasts the whole roster
whenever it changes. `listeners` is `[{id, nickname}]`, in join order. The same
frame carries `padding`, the count with no names on it; see below.

A socket is not a listener. A tab holds one open from the moment the page loads,
which is before anyone has typed a name, so the roster is who has *said* who
they are. `join` is what puts a listener on it, and the socket closing is what
takes them off. There is no leave frame: closing is the only signal that also
covers a tab closed, a laptop shut, and a network that simply stopped. A socket
that vanishes without a close is dropped by the heartbeat, so a listener whose
network died lingers for up to one heartbeat interval (30s) and no longer.

The id is the socket's, which has two consequences worth knowing. Two listeners
may pick the same nickname and are still two rows: the id is what keeps them
apart, and what a client should key its list on. And a listener who reconnects
comes back as a new row rather than reclaiming the old one: identity that a
client could assert is identity a client could assert about *someone else*, and
the roster is not worth an eviction primitive. Rosters go out whole rather than
as joins and leaves, so a client renders the last frame and has nothing to
reconcile.

A `join` buys a row and nothing else. Nicknames are re-normalised server-side:
collapsed, stripped of control characters, capped at 24 characters, and refused
when what's left is empty, because the client's own normalising is a courtesy
to the listener, not a guarantee to the server. Re-sending the name a socket
already has costs no broadcast; sending a different one is a rename, and keeps
the listener's place in the list.

### Padding the headcount

| | |
|---|---|
| `GET /api/padding` | Admin. `{padding}`: heads added to the tally, on top of the roster. |
| `POST /api/padding` | Admin. `{padding}` → the count as it now stands. Whole numbers, 0–9999. |

The roster is the truth about who is in the room, and nothing can put a row in
it but a browser with a person behind it. This is the other number, and it is
worth being plain about what it is: a figure whoever runs the station types in,
added to the tally the top bar shows every listener. Nobody is behind it.

It is kept **beside** the roster rather than folded into it, and that is the
whole design. A padded roster would put invented names in the room, sitting in
the same list as everyone else, and somebody would say hello to one of them.
Keeping the two apart means every name a page draws is a person, and the added
part is a count with no name attached, drawn as a single `+28 more` pill at the
end of the row. Nothing gated on the roster moves: chat, wishes and mutes see
exactly the room they saw before, because padding buys no socket and no voice.

Carried on the presence frame rather than on one of its own: the headcount is
one number made of two halves, and a client that received them separately could
render a moment where they disagreed. Setting it broadcasts the roster again;
setting it to what it already was broadcasts nothing.

Admin-only in **both** directions, like the mutes: the room is shown the total,
and publishing the split would tell every listener exactly how much of tonight's
crowd is nobody. Held in memory and cleared when the session ends, like the
queue and the mutes, so a station that comes back up never goes on claiming a
crowd that has gone home.

### Chat

Unlike playback, the queue and the roster, this one is written down:

```sql
sessions  (id, started_at, ended_at)
messages  (id, session_id, nick, text, created_at)
```

A message is `{id, nickname, text, at}` on the wire, and frames carry a *batch*
of them: the tail of the conversation on connect, and a batch of one for each
new message. One frame type, one code path on the client, and because messages
carry ids, a client that merges on id gets two properties for free. A reconnect
replays history without duplicating a line, and whatever was said while it was
away arrives in that replay instead of being a hole in the conversation.

**Who said it is the server's answer, not the client's.** A `say` frame carries
text and nothing else; the author is the nickname the sending socket is listed
under on the roster. A frame that could name its own sender could sign someone
else's name to a message. That also makes the roster the gate: a socket that has
not joined has no name to sign with, and is told to name itself rather than
being quietly ignored. A rename applies from then on; what was already said
keeps the name it was said under, because `nick` is a copy, not a reference.

**Sessions.** PLAN.md's availability story is session-based (you go live, you
end it) and chat is scoped to a session, so "the chat" means this time on air
rather than everything ever said. The admin controls for starting and ending one
are a later task; for now a run of the process is a session, opened at startup
and closed on shutdown. A restarted station is a new session with an empty room,
and only the line that opens the session has to change when the admin can do it
by hand.

**Pacing.** Chat is the first thing a listener can send that the server writes
down, so each socket gets a token bucket: five messages back to back, one earned
back every two seconds. Without it, one client in a loop is an unbounded row
count and a broadcast storm to everyone else. Buckets are per socket rather than
per listener, so one listener talking never spends another's, and there is
nothing to clean up after a socket that never comes back. Over-length messages
are refused rather than truncated: the composer caps what can be typed, so
anything longer came from something hand-written, and quietly publishing half of
what it said would be worse than saying no.

### Wishes

PLAN.md's requests decision (*free-text wishes, no library browsing for
listeners*) written down next to the chat:

```sql
wishes  (id, session_id, nick, text, created_at, status)
```

A listener sends `{type: 'wish', text}` over the socket and gets back
`{type: 'wished', wish}`, where a wish is `{id, nickname, text, at, status}` and
`status` is `new` or `handled`. There is nothing to pick from and no `trackId`:
a listener asks in their own words, for something the station may not even have,
and whoever runs the decks reads it and decides. Nothing here touches the queue.

**A wish is not broadcast.** It reaches exactly two places: the admin, and back
to the socket that made it. That is the one thing on this socket that is not
sent to the room, and it is why `GET /api/wishes` is the one read in the API
behind the admin gate: everything else a listener could fetch they were already
sent, so gating it would protect nothing, while a public book would turn asking
for a song into asking in front of everyone. It is also why the frame comes back
at all: with no broadcast to see their wish arrive in, a listener would be left
guessing whether it went anywhere.

Who asked is the server's answer, exactly as it is for chat: the frame carries
no author, and the name written down is the one the sending socket is listed
under on the roster. So the roster is the gate here too: a socket that has not
joined has no name to sign with and is told to name itself.

| Route | What |
|---|---|
| `GET /api/wishes` | Admin. `{wishes, outstanding}`: this session's, oldest first, and how many are still waiting. |
| `POST /api/wishes/:wishId` | Admin. `{status: 'new'\|'handled'}` → the wish and the book as it now stands. `404 unknown_wish` otherwise. |

Marking is reversible, and a handled wish stays in the book: the mark is a note
to whoever is reading the list, and a misclick should not be the end of
somebody's request. The status is constrained in the schema as well as in the
type, because the column outlives the process that wrote it, and a wish in a state
nothing can render is a wish nobody will ever see.

**Pacing.** Three wishes back to back, one earned back every 30 seconds,
tighter than chat, because a wish is not conversation. Every one of them is a
row somebody has to read, and a book nobody can get through is the same as no
book. The bucket is separate from the chat's, so being refused a wish never
costs a listener their voice. Over-length wishes are refused rather than
truncated, for the reason messages are: the admin would otherwise read out an
album title cut in half.

**Refusals say which composer they are about.** `slow_down` and `not_joined` are
reachable from both the chat and the wishes, and the page has a box for each, so
every socket refusal that is about something a listener typed carries
`about: 'say' | 'wish' | 'join'` alongside the code. Without it, a wish refused
for pace also puts "not sent" under the chat, telling someone a message they
never sent went nowhere.

### Skip votes

The room's opinion of what is on, and PLAN.md's line for it in full: *tally skip
votes as a set of socket IDs; clear it on every track change.* A listener sends
`{type: 'vote_skip', voted}` and everyone gets back
`{type: 'skips', trackId, votes, voted}`.

**A vote skips nothing.** No threshold here advances the station, and that is a
decision rather than an unfinished half: the socket carries nothing that drives
the decks, and a quorum that did would be exactly such a frame wearing a vote as
a disguise. PLAN.md puts *see skip tallies* on the admin surface: the tally is
the room telling whoever runs the decks something, and what happens next is a
person pressing Skip. A unanimous room is still a room.

**The votes are a set of listeners, not a counter.** One listener counts once
however many times they press it, and the frame carries where they now stand
rather than "toggle", so a retry after a refusal, or a second tap on a slow
connection, leaves one vote instead of cancelling itself. A vote that changes
nothing broadcasts nothing and so costs nothing, exactly as a re-join under an
unchanged nickname does.

**A vote lives on the socket that cast it.** It is dropped when that socket
closes, which keeps a tally from counting people who left the room it is a
fraction of; otherwise "4 of 3 want the next one". That is also why `voted` is
the station's answer rather than something the page remembers: a client that kept
its own flag would show a vote across a reconnect that the station let go with
the old socket. It is the one field that differs per listener, and the reason
this frame is the only one sent socket by socket instead of serialised once.
Under thirty listeners, a stringify each is cheaper than a lie.

**Cleared on every track change, and only on a track change.** A pause, a seek
and a resume all leave the same song on, so the tally survives them. A count
that a seek could wipe would let the person the room is voting at clear it by
nudging the needle. The tally goes out *after* the state that cleared it, so no
client blanks the count against the song that just ended.

The roster is the gate, as it is for chat and wishes: a socket that has not said
who it is cannot vote, or the count would stop being a fraction of the room:
a script could open sockets and vote from each without ever appearing in it.
Voting with nothing on the decks is refused by code (`nothing_playing`) rather
than counted against whatever comes on next.

### Now-playing history

The other thing PLAN.md puts in SQLite, and the second list that outlives a
socket:

```sql
plays  (id, session_id, track_id, played_at)
```

A play is `{id, track, at}` on the wire, in batches like the chat: the evening
so far on connect, and a batch of one each time a track starts. Ids are the
play's, not the track's (the same track twice in an evening is two plays) so a
client that merges on id replays a reconnect without duplicating a line and
fills in whatever went on while it was away.

**A play is written when a track starts, and only then.** The history hangs off
the same `change` event the state broadcast does, because that is the one place
that sees every way a track can go on: the end-of-track timer, the admin
pressing play, a queue advancing by itself. But most of those changes are not a
track starting (a pause, a seek and a resume all leave the same song on) so
the track id is compared against what the log last saw, and only a different one
is a play. Unfiltered, an evening of one song would be forty rows. Going off air
writes nothing and resets that memory, so the same track starting after a stop
is a new play of it.

`played_at` is stamped from the station clock, not `Date.now()`: a play and the
`startedAt` of the same track describe one instant, and two timebases would
disagree about it.

**The row stores a track id, not a copy of the title**, the opposite of what a
message does with a nickname. A nickname is copied because a person can rename
themselves and what they said keeps the name it was said under; a track that
gets retagged was mislabelled all along, so the history should read correctly
rather than preserve the typo. It is *not* a foreign key even so, which is the
one place this table is looser than the others: the insert happens inside the
playback change event, so a constraint that could refuse it would throw into
whatever put the track on: an admin command answering 500 after the track
already changed, or the end-of-track timer dying mid-set. A note about what
happened must not be able to break the thing it is a note about. The read is an
inner join, so a play it cannot name is left out rather than rendered blank.

Scoped to a session, like the chat and the wishes: a restarted station starts a
new list, and the old rows stay where they are.

### `POST /api/playback`: admin

Driving the decks by hand: `{action: 'play'|'pause'|'resume'|'seek'|'stop'
|'skip', trackId?, positionMs?}`, admin-only, returns the new state. Every
command broadcasts over `/ws` before the HTTP response returns. `skip` is the
same advance the end-of-track timer performs: next queued track, or off air.

### `/api/admin/session`: the admin session

PLAN.md's password-for-a-signed-cookie exchange. The password crosses the wire
once, at sign-in, and what comes back is an HMAC-signed token in a cookie the
browser presents from then on.

| Route | What |
|---|---|
| `POST /api/admin/session` | `{password}` → `200 {ok, expiresAt}` and the cookie, `401`, or `429` once guesses are coming too fast. |
| `GET /api/admin/session` | `{ok: true}` while the session holds, `401` once it doesn't. |
| `DELETE /api/admin/session` | Signs out. Needs no credentials; dropping a cookie you hold isn't an attack. |

Sign-in is paced per caller: five wrong passwords, then one earned back a
minute, answered `429` with a `Retry-After`. The password is the whole admin
gate, so the rate at which a stranger can test guesses is part of how strong it
is. Unpaced, a passphrase that would take centuries offline is a few hours of
HTTP. Only *wrong* attempts are charged, and getting it right clears the count,
so an admin who fumbles their own password twice is not then locked out of
their own station. Nothing else is throttled: a session already issued is a
credential its holder has proved.

```bash
curl -c jar -X POST -H 'content-type: application/json' \
     -d "{\"password\":\"$ADMIN_PASSWORD\"}" http://localhost:3000/api/admin/session
curl -b jar -H 'content-type: application/json' \
     -d '{"action":"skip"}' http://localhost:3000/api/playback
```

The cookie is `HttpOnly` (page script can't read the token, so an XSS can't
carry it off), `SameSite=Strict` (nothing the admin clicks elsewhere can drive
the station), and `Secure` whenever the request arrived over TLS, following the
scheme rather than hardcoding it, or development over plain HTTP would never get
the cookie back.

There is no session store. The token is `<expiresAt>.<nonce>.<signature>`, and
the expiry is *inside* the signed payload, so a client that keeps the cookie
past `Max-Age` still finds it refused. The signing key is derived from
`ADMIN_PASSWORD` (through an HMAC, so a signature is never an oracle for the
password itself), which means a restart leaves sessions intact and a **password
change ends every one of them at once**. Sessions last 12 hours: an evening,
not a week. Revoking one session in particular is not something a station with
one admin has any use for.

`GET` exists because every other admin route *does* something: there is no
harmless one to probe with, and the panel has to ask whether it is still signed
in before it shows a single control.

**The password is still accepted directly**, as `Authorization: Bearer …` or
`x-admin-password`, on every admin route, which is what the curl examples and
the QA scripts use. The browser is the thing that shouldn't be holding a shared
secret for hours; a one-liner in a terminal has nowhere else to put it.

### `/api/listen`: who may hear the station

The same exchange one rung down, and the answer to "only the people I invited".

**There is no door by default.** An unset `STATION_KEY` is an open station:
anybody with the address can listen, and nobody is asked for anything.

This default has been both ways round, so it is worth writing down why it is
here. The argument for a door was that a station which quietly became public
because a variable went missing is a bad surprise. The argument against it,
which won, is that the door was being paid for by every listener on every visit
to protect a room of friends listening to music together. A code that has to be
told, remembered and typed is the most expensive thing on the way in.

Setting `STATION_KEY` puts the door back on, and everything below is what
happens when you do: the mechanism is untouched, not removed. `STATION_OPEN` is
what taking the door off used to need; it is still accepted and is now a no-op,
so a compose file that has been carrying it keeps meaning what it always meant.

None of this touches the decks. Opening the station means anybody can listen; it
has never meant anybody can play anything. See [one code, or two](#one-code-or-two).

The code arrives two ways, and it is the same secret either way:

- **On a link.** `https://…/listen?k=<key>`, and `https://…/?k=<key>`, which is
  what older invites say, is redirected there with the key intact rather than
  being answered by the landing page. The key then comes straight back *out* of
  the address bar, because a secret left in a URL is a secret in the history, in
  every screenshot and in the `Referer` of every outbound link.
- **Typed at the door.** The refused screen carries an input. That is what
  makes the station something you can tell somebody over the phone, and it has
  one advantage over a link: a typed code never enters the address bar, so there
  is nothing to strip out afterwards.

Either way the browser presents it once and gets back an HMAC-signed HttpOnly
cookie good for a month.

**If you forget which code is in force**, sign in to the console and press
Share. Admin credentials satisfy the listener gate too, so whoever holds
`ADMIN_PASSWORD` can always get in and read the key back, which is why there is
no way to lock yourself out of your own station.

### One code, or two

`ADMIN_PASSWORD` is optional, and unset it falls back to a code baked into the
server. An unconfigured station is therefore **open to listen and shut to
drive**: anybody with the address hears the music, and the decks want a
password. Set your own for anything reachable from the internet.

They remain two separate settings, not one (moving either leaves the other
alone) and what keeps an invited listener out of the console when both hold the
same string is domain separation in `lib/auth.ts`: the two cookies are HMACs of
that value under different labels, so a listener token does not verify as an
admin token. That was a nicety when the secrets differed and is load-bearing now
that they need not, which is why `admin-routes.test.ts` pins it against a
station deliberately configured with one string for both.

Set `ADMIN_PASSWORD` and the two part company immediately.

| Route | What |
|---|---|
| `GET /api/listen` | `204` if this browser is admitted, `401` if not. Asked once on load, before anything opens a socket. |
| `POST /api/listen` | `{key}` → `204` and the cookie, `401` for a key that is not this station's, `429` once tries come too fast. |
| `GET /api/invite` | Admin-only. `{key}`: the station key, or `null` on a station with no door on it. What the console's Share button builds a link out of, and how you read back a code you forgot. |

What the key actually guards is the socket and the audio: `/ws` is refused at
the handshake, and `/api/tracks`, `/api/audio/*` and `/api/artwork/*` are all
behind the same gate. The socket is the important one (everything a listener
sees arrives on it) and it is refused with a `401` on the upgrade rather than
closed a moment later, because a client cannot tell a closed socket from a
station that dropped, and would sit there reconnecting into the refusal forever.

The signing key is derived from `STATION_KEY` itself, so **rotating it ends
every invite at once**, which is how you un-invite somebody. There is no
per-person revocation; a single shared key is the whole model.

**Share** in the console header is where invites come from. It asks the station
for the key and assembles the link against the address bar the console is
actually on: behind nginx or Railway the server does not reliably know that,
and the browser does. The link is shown as well as copied: sharing and clipboard
access both need a secure context, so on a LAN address over plain HTTP neither
exists, and seeing what you are about to send somebody beats a button claiming
it worked.

`GET /api/invite` is admin-only, and that is the entire invitation policy. A
listener's browser cannot rebuild an invite on its own (the cookie is HttpOnly
and the key was taken out of the address bar when they arrived) so being
invited means somebody holding the password sent you a link. Handing the key to
anyone already admitted would let one invite quietly invite everybody else.

Whoever runs the decks never needs an invite: admin credentials satisfy the
listener gate too, and `#admin` is deliberately outside it altogether, since needing
an invite to reach the sign-in form would lock the owner out of their own
station, with no way to issue themselves one. And the console is never advertised to anyone else: the
Listener/Admin control in the top bar and the mark at the foot of the rail are
both rendered only for a browser already holding an admin session. That is not
a lock, and is not doing any security work: `#admin` still reaches the sign-in
form if you type it, and every route that does anything is gated on the server.
It is the page declining to show a door to the hundred per cent of visitors it
would refuse.

### Going live

| | |
|---|---|
| `GET /api/session` | Open. `{live, since}`: whether the station is broadcasting, and since when. |
| `POST /api/session` | Admin. `{action: 'start'\|'end'}` → the state it produced. Both idempotent. |

PLAN.md locks availability as session-based ("you go live, you end it") and
`POST /api/session` is the whole of it. `{"action":"start"}` opens a session,
`{"action":"end"}` closes it. Both are behind the admin gate, and both are
idempotent: an admin double-clicking is the ordinary case, not an error.

`GET /api/session` is deliberately **open**. Whether there is a station tonight
is the first thing a listener's page needs, it is not a secret, and it arrives
unasked on the socket anyway. What is behind the gate is *changing* it.

A session used to be a run of the process (one opened at boot, closed at
shutdown) which meant a deploy silently ended the evening and a restart
silently began a new one. Now the station comes up **off air**, because a
station that went live the instant it was deployed would put every restart on
air with an empty queue.

What ends with a session ends completely. The chat, the wish book and the
history are all scoped to `sessionId`, so going live opens a fresh room rather
than resuming last night's, and ending one:

- stops the decks and empties the queue,
- clears every mute (see below), and the padding on the headcount,
- leaves the rows in the database, tied to a session that is over. Nothing is
  deleted, there is simply nothing to read while nothing is open.

Going live deliberately clears *nothing*: queueing a set up and then opening the
doors is the ordinary way to start an evening.

While off air, `say`, `wish` and `vote_skip` are all refused with `off_air`:
there is no session for any of them to belong to.

### Talking over the music

| | |
|---|---|
| `GET /api/mic` | Open. `{live, duckTo, since}`: whether somebody is talking, and how far the music sits under them. |
| `POST /api/mic` | Admin. `{action: 'open'\|'renew'\|'close'}`, or `{action: 'duck', duckTo}` → the state it produced. |

PLAN.md's last deferred line was "mic / talk-over-the-music DJ mode". This is
the half of it that carries no sound, and it is worth being plain about why
that half exists on its own.

**The station does not mix.** Nothing about the music passes through this
server: it broadcasts `{track, startedAt, pausedAt}` and every listener's
browser plays the file itself, aligned by clock. So there is no fader here to
move. What there is instead is a frame — the mic is open, the music should sit
this far down — and thirty browsers turning down the copy they are each already
playing, on the clock they already share.

That makes the ducking *better* than a mixed stream's rather than a compromise:
it lands everywhere at the same instant, it costs the server nothing, and it
works for a listener whose voice connection has failed or does not exist yet.
Which is the point — this ships before any voice does, and the whole experience
of a mic break is testable without a microphone.

`duckTo` is a linear gain, clamped to `[0.05, 1]`. The floor is deliberately
not silence: a duck to nothing is a pause, and there is already a button for
that, but more practically a listener who cannot hear the bed has no way to
tell a mic break from the station having died. The default is `0.2`, about
−14 dB. It is a fader and it is meant to be moved mid-sentence, which is when
you can hear the bed is too loud under you.

The `mic` frame is sent on connect **before** `state`, and the ordering is
load-bearing: a page told what is playing before it is told to duck puts half a
second of a song at full volume under somebody's voice and then corrects
itself, which is a worse arrival than a quiet one.

**`renew` is deliberately not `open`.** An open mic holds a ten-second lease and
the console beats every three seconds while the key is held. Without the lease,
a tab that died mid-sentence would leave the station believing somebody was
talking and every listener sitting through a permanently quiet song — the same
class of bug as a session left open by a crash reading as "still on air"
forever. Without the *separate verb*, a keep-alive still in flight when the key
came up would reopen the mic behind whoever had just stopped talking.

Opening the mic is refused off air with `off_air`, like `say` and `wish`: there
is no broadcast to talk over. Moving the fader is not, because setting up before
the doors open is ordinary and a depth is not a claim about a broadcast.

Ending a session takes the mic with it and **keeps the depth**. The distinction
is the one the rest of this page turns on: mutes and padding are claims about
tonight's room and would be lies applied to another night, while the duck depth
is a fader position belonging to whoever runs the decks. A mute set in October
reappearing next Saturday is a bug; your own duck depth is a setting.

Like every other mutation this goes over HTTP, and `mic` is refused by name on
the socket — however live it feels, and that feeling is exactly what the rule
exists to resist.

On the client the gain stage is built lazily, inside the join click. Routing an
element through Web Audio is permanent and total, and a context that has never
been resumed is not quiet music but *no* music, so the graph is only ever made
at the moment there is a gesture to spend on waking it. See
`client/src/lib/audio-graph.ts`, and `docs/broadcasting.md` for where the voice
itself goes next.

#### The voice

| | |
|---|---|
| `GET /api/rtc` | Listener. `{iceServers}`: how to reach another browser. |
| `signal` (socket, both ways) | Relayed, not read. The decks may address any socket; a listener may address only the decks. |

The voice is WebRTC, peer-to-peer, and it does not touch this server. One
`RTCPeerConnection` per listener, Opus mono capped at 32 kbps, so a room of
thirty is about a megabit off the console's uplink and nothing at all off the
station's. The music is still a file each listener plays themselves on the
station's clock; the only thing that travels live is somebody talking.

**What the server owns is the address book.** It relays offers, answers and ICE
candidates without reading any of them — `payload` is opaque, and a station that
validated SDP would be a station with an opinion about WebRTC versions it has no
way to keep current. What it does decide is who may say what to whom:

- The decks may address any socket. That is what fanning a voice out is.
- A listener may address the decks and nobody else. Two listeners have no
  business negotiating, and a socket that could reach any other by id would be a
  way to make the station introduce strangers.
- `from` is stamped by the server, never carried by the sender — the same rule
  that makes a chat message's author the roster's answer rather than the
  frame's. Without it a listener could pose as the decks and offer somebody a
  microphone.

This is the one place the socket's read-only rule bends, and it bends narrowly.
Signalling is not a command: it mutates nothing, plays nothing, and is not even
read by this process. But it *is* addressed, and an address book has to know
which connection is which — so the socket now asks `hasAdminCredentials` of the
upgrade headers, once, and the answer buys exactly that one privilege. A socket
carrying the password still cannot skip a track or go on air over it.

Every socket is told its own id in a `you` frame, before anything about the
station. Both ends need it: the decks must know which id *not* to offer to,
since whoever runs the station is usually tuned in as well, and a listener
answering an offer has to know the id it read is somebody else's.

That frame also carries whether the station considers this socket the decks,
and the reason is a bug that reached a deployed station before anyone saw it.
**A socket presents its credentials once, on the upgrade** — and the console
opens its socket when the page loads, which is before anybody has typed a
password. So signing in afterwards leaves a connection the station does not
recognise as the decks, on a page where everything else works perfectly,
because every command goes over HTTP and HTTP does carry the cookie.

The only thing that breaks is offering a listener a voice, and it breaks in
silence: the offer is refused, no answer comes back, and the connection sits at
`connecting` for the rest of the evening while the room ducks obediently for a
voice nobody can hear. So the station says which it thinks you are, and the
console opens a fresh socket once per change of mind — in both directions,
since signing *out* leaves a socket that still holds the privilege. If a
reconnect does not settle it, the console says so rather than retrying forever.

Two things about this bit up front, because both cost an afternoon otherwise:

- **`MAX_PAYLOAD_BYTES` was 4 KiB and an SDP description does not fit.** The
  failure was not a refusal but a disconnection — `ws` answers an oversized
  frame by closing the socket — so it looked like the station dropping for no
  reason at exactly the moment somebody tried to speak. It is 16 KiB now, and
  candidates trickle separately so nothing goes near it.
- **A remote stream connected only to Web Audio is silent in Chrome.** The
  stream is also parked on a hidden muted `<audio>` element, which is what
  starts the decoder; the audible path is still the graph, because a listener
  who joined at nine has no gesture left to spend on a `play()` at twenty to
  ten. It works perfectly in testing either way, because whoever is testing
  clicked something a moment ago.

The connections are held open for as long as the microphone is, not for as long
as somebody is talking. Negotiating takes a second or two, and doing it on the
talk button would lose the beginning of every break — the part with the greeting
in it. What opens and closes with the button is a gain node, which is instant,
and it is driven by the *broadcast* mic state rather than the local button so
the first word never lands before everyone's music has got out of its way.

`GET /api/rtc` exists rather than a constant in the bundle because of the TURN
credential: a relay password in a JavaScript file is a relay anybody who loads
the page can spend, from anywhere. It sits behind the listener gate, because
both ends of a voice need it.

**The listener who needs a relay is usually the one on a phone.** A desktop
browser on the same network as the console meets it on a local or reflexive
address and connects with STUN alone. A phone on cellular sits behind
carrier-grade NAT, where the public address STUN reports differs for every
destination — so the address it advertises is useless to the other end, and
there is no direct path to find. Nothing but TURN fixes that. Give `TURN_URL`
every address your provider hands you, not just the first: UDP is the fast path,
TCP survives a network that drops UDP, and `turns:` on 443 gets through a
firewall that only believes in HTTPS, and the strict networks are exactly where
a relay was needed in the first place.

**A failed connection is rebuilt, twice, then given up on.** Not an ICE restart:
there is no transport state worth preserving here, and a listener answering a
fresh offer on a fresh connection is a path the code already takes every time
somebody joins. Two attempts tells a network that changed under a laptop apart
from a NAT that nothing will cross without a relay.

**The console lists every listener, worst first.** This is the only way the
failure above is ever noticed: a listener whose connection failed hears the
music duck and then silence, which from the decks' side looks exactly like a
room that is listening, and the person it happened to will assume you went quiet
on purpose. Ordering is the feature — trouble at the top of a list somebody
glances at between records — so it lives in `lib/reach.ts` where it can be
tested away from React.

**Signalling that arrives before a page can use it is held, not dropped.**
Joining tunes in, asks `/api/rtc` how to reach another browser, and lands on the
roster, all at once — and the decks offer the moment they see the last of those.
Nothing orders them, so an offer can arrive while the ICE servers are still in
flight. Returning early there looks safe and is not: the decks offer when the
roster *changes*, so there is no second chance, and that listener would duck for
every mic break for the rest of the evening and hear none of them.

**The voice exists only while the station is on air**, at both ends. What ends
with a session ends completely, and a voice from a broadcast that finished would
be the one thing left talking. The sound check still works off air — setting a
level between broadcasts is ordinary — but the peer connections go.

**A console reconnecting does not interrupt a voice.** If only the console's
socket drops, listeners keep their ids, the roster does not change, and the
existing connections are left alone — which is right, because WebRTC is
independent of the signalling channel once established. Only a listener whose
own socket dropped gets a new id, and that arrives as a new roster entry the
existing diff already offers to.

**Losing the console's socket shortens the mic's lease rather than ending it.**
The obvious thing is to shut the mic when the decks disconnect, and it is wrong:
renewals ride HTTP, which survives a socket blip the websocket does not, so
that would un-duck the room mid-sentence over a wobble nothing else noticed. The
lease is cut to six seconds instead — longer than the three between renewals, so
a console that is only reconnecting keeps its mic, and one whose tab was closed
lapses in about the time it takes to notice.

#### The sound check

The console has a microphone, and it goes nowhere. It feeds a level meter and,
optionally, your own headphones; no listener hears any of it. That sounds like
an odd thing to build, and it is the most useful thing to build next: "the
browser will not give me the microphone" and "the connection will not
establish" are separate problems, and this is the one that can be answered on
one machine, before any of the peer-connection work exists to be blamed.

It is off until asked for. A console that took the microphone on open would put
the browser's recording light on for the whole evening, including the parts
spent queueing records.

Three controls, and each is doing more than it looks like:

- **Input.** `enumerateDevices` filtered to `audioinput`. Device labels are
  empty until permission has been granted at least once, so the list is
  "Microphone 1, Microphone 2" on first open and real names afterwards; it is
  rebuilt when the stream opens, and again on `devicechange`, because a USB
  interface being plugged in mid-set is ordinary.
- **"I'm on speakers"** is an echo-cancellation switch wearing plain English.
  Cancellation is tuned for speech — it gates, it ducks, and it treats anything
  sustained and musical as the echo it is removing — so on headphones it comes
  **off** and the voice is noticeably better. On speakers it goes back on and
  does real work, because a console reached from `#on-air` is still playing the
  station (`joined` survives the trip), which makes an open mic there a genuine
  feedback path.
- **"Hear myself"** is *refused* on speakers rather than warned about. A monitor
  feeding the speaker its own microphone is listening to is a loop with nothing
  between its ends, and the failure is instant and in everybody's ears.

The meter is fast up and slow down, like any meter worth looking at: speech is
mostly gaps, and one that tracked the signal honestly in both directions would
flicker several times a word. It is scaled in dBFS over a 60 dB window rather
than linearly, so a healthy speaking level sits in the middle of the bar
instead of in the last few pixels, and the clip lamp is read off raw samples
rather than the average, because clipping is a peak event an RMS never shows.

Nothing in that loop touches React. The bar's `transform` is written straight to
the node from the animation frame; a level in state would be a re-render of the
whole console sixty times a second, with the queue, the library and the room all
on the same page.

### Muting a nickname

| | |
|---|---|
| `GET /api/mutes` | Admin. `{nicknames}`: who has been asked to stop talking. |
| `POST /api/mutes` | Admin. `{nickname, muted}` → the whole list as it now stands. |

PLAN.md's last unbuilt admin control. `GET /api/mutes` and `POST /api/mutes`
with `{nickname, muted}`, where the nickname now *stands*, rather than
"toggle", so two of them in a row leave one mute and a retry after a dropped
response is safe. The console puts the button on the message itself, because the
moment you want to mute somebody is the moment you are reading what they said.

Admin-only in **both** directions, unlike `/api/session`: publishing the list
would turn a quiet word into a public naming, and hand the room a roster of who
to needle about it.

A muted listener is **told**, with a `muted` refusal, rather than having the
message quietly swallowed. A message that vanished would read exactly like one
that was sent, and somebody would spend the evening talking to a room that
cannot hear them. It covers wishes as well as chat, since a mute that left the
book open would only move where somebody was shouting. It costs no rate-limit
token, so being unmuted does not also leave you throttled. And it does not
remove anyone from the room: they keep hearing the music, which is what they
came for.

Muting is by nickname, not by socket: a mute on the connection would last until
the tab was reloaded, which is about as long as it takes to notice. The honest
limit of that is that somebody can rename themselves out of it, and nothing here
stops them. Making it stick would need identity, and PLAN.md's decision is
"nickname only, stored in localStorage": there is nothing to pin a person to.
This is a volume knob for a room of under thirty people who mostly know each
other, not a ban hammer.

### The queue

What's coming up lives in memory, not the DB: it's session-scoped and dies with
the process along with the rest of playback state. Entries are addressed by
**entry id, not position**, because the queue shifts by itself every time a track ends,
so "remove the third one" races with auto-advance and removes the wrong track.
The same track may be queued more than once, and each sitting is its own entry.

| Route | What |
|---|---|
| `GET /api/queue` | `{ entries }`. Open, like `GET /api/playback`. |
| `POST /api/queue` | Admin. `{trackId}` → `201 {entry, entries}`. |
| `POST /api/queue/move` | Admin. `{entryId, toIndex}`, clamped to the queue. |
| `DELETE /api/queue/:entryId` | Admin. Drops one entry. |
| `DELETE /api/queue` | Admin. Empties the queue; leaves the current track playing. |

Queueing onto an **idle** station starts that track immediately: with nothing
on the decks there is nothing to wait for. A *paused* station stays paused;
that's the admin's decision, not an empty deck.

### Advancing

When a track ends the server moves to the next one on its own, so a station left
alone keeps playing. The mechanism is a `setTimeout` for the time remaining,
rescheduled from PlaybackState's `change` event, so a pause, a resume, a seek
or a hand-picked track all re-arm it correctly.

Behind that is a slower sweep (every 2s) that advances any track whose time is
up. A `setTimeout` fires late under load, and if the event loop stalls long
enough it may as well not have fired at all; the failure mode is dead air until
someone notices. The station clock, not the timer, decides whether a track is
over: a timer that fires early goes back to sleep for what's actually left.
Overrun isn't carried over: the next track always starts at 0:00.

## Client

React + Vite. The station itself is one page, served at `/listen`: the listener
names themselves and taps **Tune in** (which is also the user gesture browsers
require before audio may start) and from then on the page follows the station.
At `/` there is a second, much smaller document in front of it; see [the landing
page](#the-landing-page).

- `lib/position.ts`: where the needle should be, given the tuple and a server time.
- `lib/nickname.ts`: normalising the nickname, and keeping it in localStorage.
- `lib/chat.ts`: what is worth sending, and folding a batch into what is shown.
- `lib/wishes.ts`: what is worth asking for, and what a refused wish should say.
- `lib/skips.ts`: the skip tally, what it is about and how it reads.
- `lib/history.ts`: folding in what has been on, and what counts as *earlier*.
- `lib/station.ts`: the websocket, with reconnect and backoff.
- `lib/availability.ts`: whether there is a station there, and what to say when there isn't.
- `lib/admin.ts`: the admin's side of the HTTP API, and where `#admin` lives.
- `hooks/useAdminSession.ts`: signs in, and asks the station whether it still counts.
- `lib/clock.ts`: clock offset estimation from ping/pong samples.
- `lib/drift.ts`: what to do about an error of a given size.
- `hooks/useServerClock.ts`: runs the handshake, exposes `serverNow()`.
- `hooks/usePresence.ts`: says who this listener is, and says it again on reconnect.
- `hooks/useSyncedAudio.ts`: aligns on every broadcast, and every 2s in between.
- `AdminPanel.tsx`: the decks, for whoever runs the station.

### The landing page

`/` is a second document (`landing.html`, entered at `src/landing/main.tsx`)
that answers "what is this" for somebody who has not been let in yet. It has no
socket, no clock and no audio element in its bundle, which is the point: it has
to describe the station on the days the station is not up.

It stands at the bare address because that is where somebody who has only heard
the name arrives. The station itself is one name in, at **`/listen`**
(`STATION_PATH` in `lib/routes.ts`), and nothing inside the app depends on that,
since every link the rail and the topbar draw is a bare fragment that works at
whatever path the document came from. What depends on it is everything
*outside*: the landing page's two ways in, the invite link the console hands
out, and the QA scripts.

The one thing the root may not swallow is an invite. A private station's link is
`/?k=<key>`, and links handed out before the doorway moved are still in people's
messages, and serving those the landing page would hand the key to a document with
no code in it to redeem it. So a request for `/` **carrying a key** is sent on
to `/listen` with the key intact, and only a request without one gets the
landing page. (`if ($arg_k != "")`, not `if ($arg_k)`: the latter is nginx's own
idea of truth, and would read a key of literally `0` as no key at all.)

The fragment is the one part of a request nginx never sees, so `/#admin` (the
console's address for the whole of the project so far, and in whatever bookmark
whoever runs the decks is using) arrives at the landing page looking like any
other visit. `src/landing/main.tsx` honours it anyway: any fragment `routeInHash`
recognises is replaced with the same route on `/listen`. Fragments the page owns,
like `#clockwork`, name no route and are left alone. `/welcome`, where the
landing page used to live, is a 301 to `/`.

All of that lives in two places that have to agree: `nginx.conf`, and a small
plugin in `vite.config.ts` that does the same three things for `npm run dev` and
`vite preview`. They agree for the same reason the `/api` and `/ws` proxies do:
the client ships unchanged, so what happens at the front door in front of a dev
server has to be what happens in production, or the first place anyone notices a
difference is production. `/listen` itself needs no rule in either: Vite's SPA
fallback and nginx's `try_files … /index.html` both already answer an unknown
path with the station, which is what it is.

The one place the station links back to it is the doorway, on the `refused`
screen: somebody standing outside a private station is the only visitor who does
not already know what they have been sent. The `unreachable` screen does not
link to it, because an invite that works and a station that is away is somebody
waiting, not somebody asking.

The design is shared rather than copied, which is what stops the page in front
of the product drifting a shade off the product:

| | |
|---|---|
| `src/tokens.css` | Every colour, radius and face. Imported by both stylesheets and owned by neither. |
| `src/shared.css` | The objects both pages draw: the turntable, the LIVE badge, the level meter, the wordmark, the white pill. |
| `src/styles.css` | The station: the shell, the rail, the panels, the console. |
| `src/landing/landing.css` | Arrangement only. It specifies no colour, radius or face of its own. |

The record behind the headline is not a picture of the deck; it is
`Turntable.tsx`'s own `Deck`, and the LIVE badge and level meter further down are
its `OnAir` and `Waveform`, rendered from the same components the listener page
uses. Every one of them sits inside an `aria-hidden` block, because each is
normally a *report* (red means on the air right now, the record turns because
audio is running) and this page has no station behind it to report on. Shown as
a picture of the deck working, they are honest; shown as live instruments beside
the headline, they would be claiming something the page cannot know.

#### One word that will not sit still

*Music is **infinite** now* uses [Aceternity UI's Squiggly
Text](https://ui.aceternity.com/components/squiggly-text), Lucas Bebber's
trick: five SVG filters, each `feTurbulence` noise fed into an
`feDisplacementMap`, cycled fast enough that the letters appear to wriggle.
Nothing actually moves; it is five stills shown in turn.

One word rather than the line, and it is the right one: the sentence is about a
thing that will not hold still or stop, and *infinite* is where that lands.
Squiggling the whole headline would just be a wobbly headline.

Two departures, both about frames this page has other plans for. The original
derives the current filter from motion's clock, which is a callback on every one
of sixty frames a second to pick a value that changes twelve times a second; an
interval at the step duration writes the same filter at the same moments for a
twentieth of the cost. And it stops when the section is off screen, since an SVG
filter swap re-rasterises the text it is applied to, which is not free, and it
was doing it four screens away. Same `useOnScreen` as the gramophone and the
globe.

It does not run at all under `prefers-reduced-motion`. Text that wobbles
continuously is near the top of the list of things that setting exists for.

#### The room, revealed

*And the room around it* is [Aceternity UI's Sticky Scroll
Reveal](https://ui.aceternity.com/components/sticky-scroll-reveal): three things
to read down the left of its own scroll container, the one nearest a breakpoint
at `index / count` brought to full opacity while the others sit at 0.3, and one
sticky panel held against the right edge showing whatever that item is about: a nickname, then
the room talking, then the room disagreeing. All three panels are real features:
the join screen, the chat, the skip tally.

Being its own scroller is the good part of the design. The element it measures
is one whose height nobody changes, so unlike the floating bar and the standing
panel it cannot be thrown by the document growing underneath it.

**What is not ported is how it reads that scroller.** The original goes through
`useScroll({ container, offset })`, and the progress that came back did not line
up with the `index / count` breakpoints the same file then compares it against:
the middle item of three was never the nearest to anything, so the panel went
straight from the first to the last and a third of the section was unreachable.
`scrollTop / (scrollHeight − clientHeight)` is the fraction those breakpoints
are expressed in, so it reads that.

**The sticky side is a deck.** It is [Aceternity UI's Card
Stack](https://ui.aceternity.com/components/card-stack), with the original's
arithmetic kept: the card at position `i` sits `i × 10px` higher, at
`1 − i × 0.06` scale, `length − i` deep, transform origin at the top so the ones
behind peek out above the face rather than growing out of the middle of it.

The one departure is what turns it. The original runs a `setInterval` that moves
the last card to the front every five seconds, which is right for a stack
decorating a page on its own. This one is inside a reveal that already knows
which of its three things you are reading, so the deck is cut to that instead;
scrolling deals the next card.

Two things it needed that the original does not. The card face has to be
**opaque**: at `--panel`'s 70% you can read the skip tally and the join screen
through the conversation sitting on top of them. And the deck sits *inside* the
sticky box rather than being it: sharing one element meant `.stack` and
`.sticky-reveal__panel` both declaring `position` and `width`, and whichever came
later in the stylesheet won. That collapsed the column of text once and killed
the stickiness once before I split them.

Two other changes. The original animates the container between three
slate-to-black backgrounds and the panel between three saturated gradients:
cyan/emerald, pink/indigo, orange/yellow. Unlike the glare card's foil these are
not a hover; they would be on screen the whole time somebody is reading, so the
change of state is kept and drawn in the design's own greys. And the panels are
hidden rather than unmounted when inactive: the conversation in one of them is
filling as the page scrolls, and a panel rebuilt on every change would keep
starting the evening again.

The panel is pinned right with `margin-left: auto` rather than by letting the
text column push it there: the column is capped at 42ch, so on a wide section it
stops growing long before the panel runs out of room, and the pair would drift
into the middle together. The container's right padding is zero and the
scrollbar gets `scrollbar-gutter: stable`, so a scrollbar appearing does not
shove the panel back in.

The middle panel is drawn as a chat conversation: an avatar, a bubble, a name
and the second of the record it was said at, with consecutive lines from one
person losing the repeated face. The station has no picture of anybody, so the
avatar is the one thing it can honestly draw: the first letter of the nickname.

The lines land **one at a time**. The playhead says how many are *due* (how
many the record has gone past) and `useOneByOne` walks the count up to that, a
line every 420ms. Due is not the same as said: arriving at the section with the
record already at 2:13 makes five lines due in the same frame, and five bubbles
appearing together is a transcript rather than a conversation. The same applies
to a hard scroll, which would otherwise dump four at once. Backwards is not
paced: scrolling up takes the playhead with it and lines fall back out, and
running that in reverse a step at a time would be the room un-saying things at a
stately pace while the reader is already somewhere else. `nextStep` is the pure
half of it, so the pacing is tested without a clock.

It follows itself down as lines arrive, which needs one non-obvious thing. A
line opens from `0fr` to `1fr`, so at the moment it is said the row is still
flat and `scrollHeight` does not include it, so scrolling to the bottom lands at a
bottom that has not happened. A timer set to the transition's length works until
somebody changes it in the stylesheet; a `ResizeObserver` on the rows fires when
they have actually finished opening, whatever the CSS says, and costs nine
observations.

(Aceternity's own *Chat Conversation* illustration block is behind Pro:
`shadcn add` returns *"You are not authorized to access the item"* and the
registry 401s, where free components on the same endpoint return 200. This is
built from its public description rather than ported from its source.)

One bug worth remembering, because it is easy to write again. The scroll effect
must depend on `items.length`, not on `items`. The array is built inline by the
caller, so it is a new one every render, and this section re-renders on every
scroll frame, because the conversation panel follows the page's playhead. On
`items`, the listener was torn down and re-added constantly and any scroll event
landing in the gap was lost: the active item would stop changing until something
else forced a re-render.

#### The wishes

The card is the one from [Aceternity UI's features
section](https://ui.aceternity.com/components/feature-sections-free): a surface
grading from the panel colour down into the sheet, a large radius, and a
suggestion of graph paper in the upper-left corner. The paper is the original's
two masks doing the work: a linear one fading the grid downward and a radial
one fading it away from the top edge, so it reads as a corner rather than a
texture over the card.

One departure. The original picks its filled cells with `Math.random()` in the
render body, so every re-render re-rolls the pattern. On a page whose sections
re-render as you scroll, the squares would twitch; `GridPattern` takes a seed
instead, so each card has an arrangement of its own and keeps it.

Four wishes rather than six, in a 2×2: each card is large enough to read at a
glance, and four is a wall somebody finishes.

An earlier pass had these cards carrying Aceternity's Canvas Reveal Effect with
the wish hidden until you pointed at a card. It is a good effect and it was the
wrong one here: these four sentences *are* the section's argument, and a wall
that says nothing until you touch it says nothing at all on a phone.

#### The panel that stands up

*What the room asks for* sits inside [Aceternity UI's Container Scroll
Animation](https://ui.aceternity.com/components/container-scroll-animation), in
the demo's own pattern: a centred title above a device-frame card that starts
laid back 20°, comes upright as you scroll it into place, and settles from 1.05
to 1 while the title drifts up 100px. It is the one centred thing on a
left-aligned page, which is also why it reads as a moment rather than another
block: the wishes are the most surprising thing the station does.

Two departures. The bezel uses `--raised-soft` and `--raised` rather than the
original's `#6C6C6C` and `#222222`, so the frame is the same grey as the deck in
the hero instead of looking like a screenshot of somebody else's site. And the
card is not a fixed 30/40rem: the original's content is an image, which crops
happily, and ours is text, and text in an `overflow-hidden` box at a height nobody
measured is text with its last line sliced off. It takes the height of what is
in it, with a floor.

**The one that mattered.** The original drives everything from
`useScroll({ target })`, which caches where the element sits in the document and
re-measures on resize. That is right on a page of fixed height and wrong on this
one: the room panel opens a row every time the playhead reaches another line, so
everything below it moves down without a resize ever firing, the cached offsets
go stale, and the progress comes out as a step: the card sat at 20° through the
whole section and then snapped flat in one frame. `getBoundingClientRect` on a
rAF-throttled scroll listener is the same quantity from live geometry, and
cannot be stale. (This is the second component on the page to hit that; the
floating bar has the same problem and the same answer.)

#### Two objects that were always drawing

Both three.js scenes (the hero gramophone and the globe) rendered every frame
for the entire length of the document, whether or not anybody could see them.
The cost lands on everything else that wants a frame: the bar's resize, the
pile, the reveal.

`useOnScreen` stops them. Measured idle cost at 1440×900, under a software
renderer so the absolute numbers are pessimistic but the ratios are real:

| where | drawing | frame |
|---|---|---|
| top of the page | both | 217ms |
| past the hero | globe only | 100ms |
| bottom of the page | neither | 16.7ms |

The gramophone skips the draw when it is away; the globe uses
react-three-fiber's `frameloop="never"`, which stops the loop without unmounting
the scene, since rebuilding it would refetch nothing but would cost a stutter every
time it came back. The clock keeps running in both cases, so an object returns
at the angle it would have reached rather than the one it left at.

The gramophone also draws at 30fps rather than 60. A full turn takes twenty-six
seconds, so it moves about a seventh of a degree per frame, and half of those
frames are indistinguishable from the one before and every one of them costs the
same as a real one.

And the sections that do not read the playhead are `memo`ised. `Landing`
re-renders on every scroll frame, so without it a moving playhead re-rendered
nine sleeves, twelve glare cards, the globe wrapper and the bar, the last of
which holds a spring that should not be interrupted. Its props are built once at
the module for the same reason.

#### The bar

[Aceternity UI's Resizable Navbar](https://ui.aceternity.com/components/resizable-navbar):
full width at the top of the page, and past 100px of scroll it animates into a
floating pill: width, a 20px drop, a backdrop blur and a shadow, all on one
spring. The hovered item is a single pill that slides between the links on a
shared `layoutId` rather than one background fading in per link.

It replaces two things the page used to have separately, a sticky masthead and a
floating bar that came back on scroll-up. One bar is easier to reason about than
two that have to agree about which of them is on screen.

**Shrunk, it is glass.** `backdrop-filter: blur(22px) saturate(180%)`, and the
saturate is the half people leave out: blur alone gives you frosted plastic, and
pushing the colour of whatever is behind gives you glass. What passes under this
bar is album art and a lit gramophone, which is exactly the sort of thing worth
saturating. Over that sits a tint at 55% (thinner than it looks like it should
be: a bar that reads as glass at 55% reads as paint at 80%), a sheen down from
the top edge and a highlight off the upper-left shoulder, both painted as part of
the element's own background so they sit under the words rather than across them.
The edge is three hairlines: a ring all the way round, a brighter line along the
top where a light source catches the bevel, and a dark one along the bottom where
the far edge falls away.

The filter is applied at one strength the whole time rather than animated in. It
is not composited, so changing it would repaint the bar every frame of the
resize, and at the top of the page there is nothing behind it but the sheet, so
a filter there costs nothing and shows nothing either. What arrives with the
shrink is the tint, the sheen and the edge.

**Two things had to change about how it is animated, and both are visible.**

The original animates `boxShadow` from `"none"` to a five-part shadow. That pair
cannot be interpolated, so motion writes one frame and abandons the whole
`animate` object: the bar never resizes, never drops and never blurs, because
every property in the batch goes down with the shadow. Making the pair
interpolable gets it working, and then you can see the second problem: a
box-shadow is not a composited property, so interpolating one repaints the
element every frame, and one of its five parts is a 1px white `inset` ring. A
hairline being colour-interpolated *and* re-rasterised at a new width sixty times
a second shimmers along its edge, a glitchy-looking border, because it is one.
So the lift lives on `.navbar__body::after` and arrives on `opacity`, which the
compositor can do without repainting anything. The blur is on the whole time for
the same reason: `backdrop-filter` is not composited either, and over a
near-black page there is nothing behind the bar to blur at the top of the
document anyway.

**And the cap belongs on the wrapper, not the bar.** With `max-width: 1080px` on
the bar itself, the first quarter of the shrink did nothing: `100%` of a 1440px
window is 1440, clamped to 1080, so the spring ran from 100% to about 75% with
the bar visibly frozen and then jumped when the percentage finally fell below the
cap. On the wrapper the percentages are of a box that is already 1080 wide, so
the first frame moves: `1080 → 1031 → 933 → 856 → … → 626`, largest single-frame
step 25px of a 454px move.

Two smaller departures. The original imports two icons from `@tabler/icons-react`
for the mobile toggle and does not list it as a dependency, so `shadcn add`
leaves you with a build error; two nine-line SVGs cost less than the package. And
it passes `{ target, offset }` to `useScroll` when it only reads `scrollY`, which
is the window's either way, so dropping them removes a measurement this page has
twice been bitten by and changes nothing.

It also shrinks further than the original, which goes to 40% with an 800px floor:
on most screens the floor wins and the bar barely moves. This page is capped at
1080px and has no floor, so the shrink is one you can see: 1080px to 626px.

Which is why the links are **in flow rather than absolutely centred**. The
original places them with `absolute; inset: 0`, so they are laid out without
reference to the wordmark or the buttons either side of them. That is fine while
the bar is wide and wrong the moment it is not: at 626px the centred group ran
straight into *Run the decks* and the two read as one word. A flex item cannot
overlap its siblings, and the links are still centred, in the space that is
actually theirs rather than in a box they share with two other things.

The decks label drops to its icon on `[data-shrunk='true']` as well as at a
narrow window. The attribute is the only signal that can see a 626px bar inside
a 1440px window; no media query can.

#### The evening's six steps

*How an evening runs* is six [Aceternity UI Glare
Cards](https://ui.aceternity.com/components/glare-card) in an [Infinite Moving
Cards](https://ui.aceternity.com/components/infinite-moving-cards) row: the
pointer-driven tilt, the white glare that follows the cursor, and the rainbow
foil under it with its four stacked gradients and its blend modes, going past
forever. The glare effect is entirely CSS custom properties; all
`GlareCard.tsx` does in JavaScript is measure the pointer and write six numbers
(`--m-x/y`, `--r-x/y`, `--bg-x/y`).

The row holds the six twice and translates itself by exactly half its width, so
the second lap arrives where the first started and the loop has no seam (`- 8px`
is half the gap, which the 50% would otherwise count twice). Two things about
`InfiniteMovingCards.tsx` are not the original's, and both are because of what
is in the row rather than preference:

- **The second lap is rendered, not cloned.** The original walks the DOM and
  `cloneNode(true)`s every card into the same list, which is fine for its own
  cards because they are markup. Ours are `GlareCard`s, and a cloned node has no
  React on it, and half the cards in the row would sit there dead, not tilting, not
  catching the light, for no reason a visitor could work out.
- **It pauses on focus and on touch, not only on hover.** A glare card only
  shows you anything while a pointer is on it, so one that slid out from under
  the cursor would be the one thing on the page you cannot look at. `:focus-within`
  covers a keyboard and `:active` covers a finger, which has no hover at all.

The second lap is `aria-hidden`: it is the same six things said twice, and a
screen reader being read the evening's six steps twelve times is the loop
leaking out of the visual layer it belongs in. Under `prefers-reduced-motion`
the row stops, the duplicate lap is dropped and the container becomes a plain
scrollable row, which is what it was before it moved.

Two departures. The radius is 18px rather than 48px, because everything on this
site is drawn at 14–22px and a 48px corner on a 236px card is a lozenge. And
worth being explicit about the foil: `tokens.css` allows this design one accent
(white) and one signal (red, meaning on the air right now), and a rainbow is
neither, but the original already keeps `--opacity` at 0 until hover, so the
page a visitor reads is still monochrome and the foil is something they find.

Two things were changed rather than ported. The original blends its *content*
layer with `soft-light` too, which is right for the artwork in its demo and
wrong for words: body text over a dark surface goes to something you lean in to
read. Only the glare and the foil blend here. And its pointermove handler
contains a `console.log(state.current)`, which fires on every frame the cursor
is over a card.

The cards are `div`s and these six are an ordered list, and the sequence is the
content, so each one stays inside its `li` rather than replacing it.

#### The globe

Beside the sentence, a globe with twelve listeners' arcs all landing on the one
station. `World.tsx` is a port of [Aceternity UI's GitHub
Globe](https://ui.aceternity.com/components/github-globe): three-globe's hex
polygons, the dashed animated arcs, the rings firing at their origins, with
four deliberate departures:

- **Colour.** The demo is a blue globe with cyan, blue and indigo arcs. This
  design has one accent (white) and one signal (red, meaning on the air right
  now, which nothing else may borrow). So the globe is monochrome and there is
  no red anywhere near it.
- **Where the arcs go.** The demo draws a mesh of city-to-city routes, which is
  the picture of a network. This is not a network: it is one station and one
  link, so every arc lands on the same point. Twelve of them, because the
  limits section says *around thirty listeners, not thirty thousand*, and a
  globe implying otherwise would be advertising a different product.
- **No drei, and no hand-built camera.** The original spins the globe with an
  `OrbitControls` that has pan, zoom and rotate all switched off: a whole
  dependency for `autoRotate`, which is one line in `useFrame`. Its camera is
  built with a hardcoded 1.2 aspect ratio, which draws the sphere as an ellipse
  in any box that is not that shape; described to the `Canvas` instead,
  react-three-fiber keeps the aspect in step with the box.
- **`arcDashGap`.** The original's 15 leaves each arc dark for ~95% of its cycle
  (1.6 here). On a demo with fifty arcs something is always lit; with twelve the
  globe is mostly empty.

The component imports `@/data/globe.json`, which shadcn does not install and you
are expected to supply. `npm run assets:countries` builds it: Natural Earth 110m
(public domain, from three-globe's own examples) with every property stripped (the
globe reads geometry and nothing else) and coordinates cut to three decimal
places, about 100m and far under one hex at resolution 3. 477 KB to 183 KB.

Two of the things that script does are not for size. `hexPolygonsData` runs every
ring through **h3-js**, which is stricter about geometry than a renderer is: a
zero-length edge throws `E_FAILED`, which surfaces as an uncaught *"The operation
failed but a more specific error is not available (code: 1)"* and silently drops
the countries after the bad ring. Rounding coordinates is what makes those edges.
So consecutive duplicate points are removed, and rings left with fewer than four
points are dropped along with any polygon left without an outer ring. At two
decimal places one ring in Natural Earth collapses that way; at three, none do.

Loaded the same way as the hero model: WebGL is probed first, then the whole
thing arrives on a dynamic import once the page is readable. It is the largest
chunk on the site by far, and none of it is in the landing bundle.

#### The pile of records

*The Moment* is the globe and one sentence side by side, under them the
evening's sleeves on a table across the full width of the page, and under those
the level meter, centred. They can be picked up and thrown. Full width
because there are nine of them: four sat in a column beside the sentence, and
nine want a table.

Every sleeve is the same sleeve. The record that is on is the one at the front
of the pile and nothing else: no badge on it, no clock, no head count. It is a
record, and a record does not report anything; the LIVE mark beside the sentence
and the bar along the bottom of the page are where this page says what is
happening, and saying it a third time would be the pile pretending to be an
interface rather than a stack of records on a table.

`DraggableCard.tsx` is a port of [Aceternity UI's Draggable
Card](https://ui.aceternity.com/components/draggable-card), which arrives via
`npx shadcn add` and is written for Tailwind. This is not a shadcn project and
has no Tailwind, so the physics is kept exactly: the same spring (stiffness
100, damping 20, mass 0.5), the same ±300px→∓25° tilt, the same glare, the same
velocity-carried throw, and every utility class is a rule in `landing.css`
drawn from `tokens.css` instead. It needs `motion`, which is the one dependency
in the landing bundle rather than behind a dynamic import.

One departure from the original: `dragEnabled`. A dragged element swallows the
gesture that started on it, so on a touch screen a pile covering half a column
is a pile that stops the page scrolling under a thumb. Drag is on for
`(hover: hover) and (pointer: fine)` and off everywhere else, where the pile is
a pile of records to look at.

The sleeves are `SLEEVES`: `BEEN_ON` filtered to the records the page has cover
art for, rather than a second list. One evening drawn twice, so the pile cannot
come to disagree with the written-down evening further down the page; the tests
in `test/session.test.ts` are what hold that. `npm run assets:albums` squares
the scans and takes them to WebP at 640.

Where each one lies is `PILE` in `Landing.tsx`, in percentages of the table
rather than pixels, so one arrangement holds its shape from a phone to a wide
monitor instead of being three scatters in three media queries. Below 720px the
table shows the six most recent and below 560px the five, because nine sleeves
across a phone is not a pile but a heap: every card at its floor size, every
one behind another, and nowhere for a caption like *The Miseducation of Lauryn
Hill* to go. Nothing is lost by it: the whole evening is listed in *What has
been on* a few screens down, sleeve or no sleeve.

#### The object in the hero

A gramophone, turned slowly behind the headline, rendered with three.js. It
replaces the flat `Deck` that used to sit there, but only once it has arrived,
and only on a machine that can draw it. `Gramophone.tsx` checks for WebGL before
it fetches anything, imports three and the model dynamically so neither is in
the landing bundle, and keeps the `Deck` on screen until the model is ready. A
machine with no WebGL downloads neither and keeps the deck for good. The page
has never needed the model, so nothing about the page waits for it, breaks
without it, or reserves a hole where it would have gone.

The file arrived from Sketchfab at **30.8 MB**: 31k triangles, which is
nothing, and 25 PNG textures, which was all of it. `npm run assets:models` is
the command that takes it to ~1 MB: textures to WebP at 1024, geometry
quantized. Quantization rather than Draco deliberately: Draco needs a decoder
fetched at runtime, and nothing in this app reaches off its own origin. The
original lives in `client/assets-src/` and is not copied into the image; the
optimized one lives in `src/assets/models/` and is imported with `?url`, so
Vite hashes its filename and the `immutable` cache header on `location /assets/`
is telling the truth about it.

Like everything else on this page it is `aria-hidden` and reports nothing: it
turns because gramophones turn, not because a station is playing.

#### The page is a song

The document is scrubbed through five and a half minutes of one record: the top
is 0:00, the bottom is the last bar, and `useScrubbedSession` turns the scroll
offset into a position. That number drives two things: the slim player fixed to
the bottom of the window, and the room panel in *And the room around it*, whose
lines arrive as the playhead reaches the second each was said at. By the time
somebody has read the page they have moved through a song with a room talking
around them, which is the product, felt rather than described. Arriving at the
room section part-way through the conversation is the point rather than a bug:
it is what walking into a station mid-song is like.

The arithmetic under it (`scrubbed`, `saidBy`, `clock`, `through`) is pure and
lives in `landing/session.ts` beside the invented session it operates on, so
what the page is doing is testable without a window (`test/session.test.ts`).

Everything on that page is made up, and has to be: it cannot ask the station
anything, which is the whole reason it exists. What it may not do is *look* like
a report. So the bar is `aria-hidden` and carries the words **sample session**
next to the badge: on this site a red dot means on the air right now, and a bar
borrowing that meaning to advertise with would be the one thing on the page
actively lying. The invented head count is checked against the station's real
ceiling in the tests for the same reason: a landing page boasting five figures
would be advertising a different product from the one the limits section
describes two screens further down.

### Joining

The join screen asks for a nickname, and the station will not take a listener
without one: the button stays disabled until the field has something in it, and
pressing Enter on an empty field is refused the same way. What comes back is
stored under `chunky.fm:nickname` in localStorage, PLAN.md's identity story in
full, with no account and nothing held server-side.

The nickname and the join are deliberately the *same* gesture. Browsers only
start audio from inside a user gesture, so the form's submit handler is where
`play()` has to be called; a nickname step before a separate Tune in button
would leave the audio starting outside any gesture at all.

A returning listener finds the field already filled and joins without retyping,
but still has to press the button: a name in localStorage is not a gesture, and
a page that tried to start playing on load would be refused by the browser.
Nicknames are normalised on the way in *and* on the way out: whitespace runs
collapse, control characters go, and the result is capped at 24 characters, so
what a listener finds when they come back is a name rather than whatever pasting
went wrong. A browser that refuses storage (Safari's private mode throws on
write, and blocked cookies throw on even touching `localStorage`) costs the
listener a retype next visit and nothing else.

### Who's listening

Once tuned in, the page shows the room: everyone currently listening, by
nickname, updating as people arrive and leave. It is the roster the socket
broadcasts, rendered whole each time, with rows keyed on the listener id, so two
people called "sam" are two chips rather than one. If the decks have padded the
headcount, the rest of the count follows the names as one unnamed `+28 more`
pill: the tally in the heading matches the top bar, and every chip beside it is
still somebody who is really there.

The nickname reaches the server as a `join` frame sent *after* tuning in, not on
connect: a socket opens with the page, and a name typed into the field is not
yet someone in the room. `usePresence` waits for the connection to be open
rather than merely to exist: a send on a socket that is still opening is thrown
away in silence, and a join lost there would be a listener nobody can see, with
nothing to retry it. It is the same trap the clock handshake fell into once,
which is why both hooks are written against `connected` rather than `connection`.

Hanging the join off `connected` is also what makes reconnection work: presence
lives with the socket, a reconnect is a new socket, and the effect re-runs each
time the connection comes back. So a listener who drops during an outage is put
back on the roster by the same line that put them there in the first place, and
a station that restarts finds its room refilling on its own. `npm run
qa:presence` is that whole story, in three browsers.

### Talking

The chat sits under the roster, and nothing in it is rendered optimistically:
what was typed goes out, and appears when it comes back with the id and
timestamp the server gave it. On a station where everyone is already connected
to the same server that costs a round trip, and it buys a list that is the same
list for everyone in the room, rather than a local-only line that a refused
message would leave sitting there looking sent.

The composer is disabled while the socket is down, for the reason the join frame
waits for `connected`: a send on a closed socket is thrown away in silence, and
a message that vanished would be worse than one that could not be typed. What
arrives is merged by id, so a reconnect fills in what was missed without
duplicating what is already on screen. `lib/chat.ts` is that merge, and it is
the piece worth reading if the chat ever looks doubled or out of order.

### Wishing

Under the roster, above the chat: one field, no library to browse, and a list of
what this listener has asked for. Nothing is rendered until the station answers:
the line that appears is the wish as it was written down, with the station's
own timestamp and the name from the roster.

The list is only ever this listener's own, because that is all the station tells
them. It survives a reconnect (the connection is remade under the same hook) and
starts empty after a reload, while the wishes themselves are still in the book
the admin reads. Nothing tells a listener their wish was played, either: a
station that said "played" about a track that never went on would be worse than
one that says nothing, so the row reads *asked* until the page is reloaded away.

The two composers share one socket, so each is handed only the refusals that
carry its own `about`. `refusalAbout` in `lib/protocol.ts` is that filter, and
it is what to look at if a refusal ever appears under the wrong box.

### What was that?

Under the queue, an **Earlier** list: what has been on this session, newest
first, so somebody who walked in on the end of something can see what it was.

The station writes a play down when the track *starts*, which makes the newest
row whatever is on right now (already shown in full at the top of the page) so
the page drops that one row and shows only what was missed (`playedEarlier` in
`lib/history.ts`). Only that row, and only while it names the track that is on: a
track played earlier in the evening and again now is two plays, and the earlier
one belongs in the list.

This is the one social list that survives a reload. The roster and the skip
tally are true only while a socket is open, so a refresh starts them again; the
history is in the database, so a listener who reloads at 10 still sees the
evening, and one who arrives then sees what they missed, including whatever
went on while they were reconnecting, merged by id.

### Voting on what's on

Under the track, a line saying how much of the room wants the next one and a
button to join them: `3 of 4 want the next one`, as a fraction of the roster
rendered below it, because a bare count means nothing. Three out of four is the
room; three out of thirty is three people.

Nothing here is optimistic. Both the count *and* whether this listener's own vote
is in come back from the station, so the button never claims a vote the station
does not hold, including after a reconnect, which drops it. The tally is
rendered only against the track it names (`tallyFor` in `lib/skips.ts`), so the
moment between a `state` frame and the `skips` frame that follows it shows no
count rather than the last song's.

The vote button is the listener page's alone: the admin panel has a Skip button,
and voting for something you can simply do is theatre. The tally still reaches
the panel, next to that button, which is the only thing in the system that acts
on it.

### When there is no station

PLAN.md's offline screen. Everything above assumes a socket; without one the
page is a column of empty boxes and a small grey word in the corner, which reads
like something that broke rather than a station that went away.

The page distinguishes four of those, because they call for four different
things being said:

- **Never reached it.** Nothing has ever answered. The panel says *Can't find
  the station*, and there is no Tune in button at all.
- **Had it and lost it.** The socket dropped. Whatever the station last said
  stays on screen, with a line above it saying it is from before the drop.
- **Off air.** The station answers perfectly well and nobody is broadcasting.
  *chunky.fm is off the air*, and no Tune in button: there is nothing to tune
  into, and the click would be spent on silence. See [going live](#going-live).
- **There, and quiet.** The station is on air with nothing on the decks. The
  page says both halves: nothing is on, and you are tuned in for whatever is.

The last two look identical in a playback snapshot (an empty deck either way)
which is exactly why `air` is its own frame rather than something derived from
`state`. And the first two are about the *socket* while the third is about the
*station*, so `standing()` folds the two questions into the one sentence a
screen can show. Connectivity wins when they disagree: a page that cannot reach
the station does not know whether anyone is on air, and the last thing it heard
has stopped being evidence of anything.

The distinction that costs something is the first two, and `lib/availability.ts`
is where it lives. `StationStatus` is about one socket, which is the wrong grain
for a screen: a page loaded against a dead server cycles `connecting → offline →
connecting` forever as the backoff runs, so anything keyed on the raw status
alternates between two messages once per retry while the truth (nothing has
ever answered) never changes. So availability is a *fold* over the statuses
rather than a mapping of them: `connecting` is not news, and leaves whatever the
page had already concluded standing until the attempt resolves.

Two things it deliberately does not do. There is no Retry button, because the
connection is already retrying on a backoff and the only thing a button could do
is what is happening anyway, while implying the page had given up and was
waiting to be asked. And a drop does not blank the track: a short outage is the
common one and the audio usually plays through it out of the buffer, so a page
that cleared a song the listener can still hear would be worse than the outage.
The line above it is what stops the frozen roster and dead tally from still
reading as live.

Tuning in is refused while the station is unreachable, and not only because the
join frame would go on the floor. Browsers start audio from inside a user
gesture and nowhere else, so a listener who spends their click on an absent
station gets a page that says a track is on and no sound when it comes back:
`play()` would be called from a broadcast handler rather than a click, and
refused. Better to hold the button back and hand it over when there is a station
to hand it to, which the page does on its own, without a reload.

### Admin mode

The controls live at **`/listen#admin`** (`/admin` works too, wherever the page
is served with an SPA fallback). Off that route nothing admin renders, and the
route alone reveals nothing: the panel shows a password form until the server
has accepted a session at `/api/admin/session`. A wrong password gets the form
back, and so does a `401` mid-session, which is what happens when the session
lapses, or the station restarts with a different password.

**The client keeps no secret at all.** The password is typed, posted once, and
gone; what remains is the `HttpOnly` cookie, which page script cannot read and
does not need to, because the browser attaches it. So there is nothing to store,
nothing to remember across a reload, and nothing an XSS could carry off. A
reload asks `GET /api/admin/session` once, because the only way to know whether
a cookie is still good is to ask, and the answer decides between the form and the
controls.

Signing out waits for the server to drop the cookie before the form comes back,
so "signed out" means the session is over rather than that this tab stopped
drawing buttons.

The panel keeps no playback or queue state of its own. Both arrive on the
websocket the listener already has open, so a track ending by itself, or a
command issued from another tab, moves the panel too.

A command's own response carries the state it produced, which is the same thing
the broadcast is about to say, so the panel folds it in immediately
(`useStation`'s `applyState` / `applyQueue`) rather than sitting unchanged for a
round trip. If the socket happens to be reconnecting, the command still lands
(it went over HTTP) and the panel says so instead of quietly showing a queue
that has moved on.

Listeners see the queue too, as a read-only **Up next** list. It is the same
frame the panel reorders, seen from the other side.

| Control | What it does |
|---|---|
| Upload | One request per file; reports stored / already in the library / why not. |
| Pause / Resume, Skip, Stop | `POST /api/playback`. Skip advances the queue. |
| Queue ↑ ↓ ✕ | `POST /api/queue/move`, `DELETE /api/queue/:entryId`. |
| Library **Queue** / **Play now** | Queue behind what's playing, or take the decks. |
| Wishes **Mark handled** / **Undo** | `POST /api/wishes/:wishId`. A note to yourself, and reversible. |
| Headcount **−** / **+** | `POST /api/padding`. Adds heads to the tally the room is shown. The split, `6 here, 28 added`, is under the buttons, because the console is the only page that can see it. |
| Skip votes | Read-only, next to Skip. What the room wants; pressing it is still yours. |

The wish book sits above the library, because a wish is read and then answered
by queueing something from the list below it. It is the one part of the panel
that is *polled* rather than pushed: every ten seconds, and after every mark.
A wish arrives over a socket that carries no privileged frames at all: the
station deliberately tells a socket holding an admin cookie nothing it would not
tell a stranger, so the panel asks rather than the station pushing. Ten seconds
is well inside the length of a track, which is the pace anyone is working at.

Reordering sends the *entry id* and the position it should land at. The row
positions come from a render, and the queue can advance underneath it, which is
exactly why the server addresses entries by id and clamps the index it is given.

### Staying in sync

Two separate problems, solved separately.

**The browser's clock is wrong.** Every decision is made against `startedAt`, a
server timestamp, so the client first measures how far its own clock sits from
the server's: send `t0`, get back `t1`, note `t2`, then `rtt = t2 - t0` and
`offset = t1 - (t0 + rtt/2)`. Five probes, 150ms apart, spaced rather than
fired in one burst, because five packets sent at once share a queueing delay,
which is exactly the contamination that taking the lowest RTT is meant to
avoid. Samples live in a rolling window, so one slow round trip can never
briefly become the estimate; a bad offset would be audible as a hard seek.
Re-measured every 30s.

**Audio clocks drift from system clocks.** Being aligned once is not staying
aligned, so every 2s:

| Error | Response |
|---|---|
| > 1s | Seek. A nudge would take a minute to close that. |
| > 50ms | Nudge `playbackRate` by up to ±2%. |
| ≤ 50ms | Leave it alone. |

Correcting with rate rather than seeking is the whole trick: a seek is an
audible glitch, a 2% rate change is not. `preservesPitch` defaults to true, so
it time-stretches instead of pitch-shifting.

One note on the constants, which come from PLAN.md: since the smallest error
that escapes the 50ms dead zone already exceeds the ±2% cap once multiplied by
the 0.5 gain, the clamp always binds and correction is effectively bang-bang.
That converges from the worst non-seeking case in under a minute and is
inaudible, so it is left as specified, but the proportional term only starts
doing anything if the dead zone drops below 40ms.

### Verifying it

Sync, and anything else that only happens in a real browser, is what unit
tests cannot judge, so there are eleven scripts that drive real Chrome. Each
needs a running server, a running Vite dev server, and at least two uploaded
tracks (one of them a few minutes long). `qa:offline` is the exception on the
first count: it starts by taking the server away, and needs one only to put it
back.

```bash
cd client
npm run verify:sync    # two listeners joining at different times stay together
npm run qa:playback    # seeks, pause/resume/seek/stop, track changes
npm run qa:reconnect   # kills the server underneath a listener and restarts it
npm run qa:offline     # loads the page against a dead station, then takes one away
npm run qa:presence    # three listeners watch each other arrive and leave
npm run qa:chat        # they talk, one joins late, one tries to speak as another
npm run qa:chat-refusal # types faster than the room will take, and checks what it says
npm run qa:wishes      # one listener asks, the room hears nothing, the admin marks it off
npm run qa:skips       # three listeners vote, the room agrees, the next track starts fresh
npm run qa:history     # tracks appear in Earlier as they change, and survive a reload
npm run qa:admin       # sign in, upload, queue, reorder, drive the decks
npm run qa:mic         # two listeners duck together, and a third arrives mid-break
npm run qa:soundcheck  # opens a real microphone on the console and watches the meter
npm run qa:voice       # a real voice, decks to listener, measured at the far end

npm run qa:all         # all fourteen, restarting the station between each
```

Prefer `qa:all` for a full pass. Run back-to-back by hand they interfere with
each other: the roster, the skip tally, the chat and the evening's history all
live in the session, and most of these scripts open by asserting on an empty
one, so whichever goes second fails on the first one's leftovers. `qa:all`
restarts the station before each script, which is the only thing that gives
them the empty room they are written against.

They read `CLIENT_URL`, `API_URL`, `ADMIN_PASSWORD`, `TRACK_ID`,
`OTHER_TRACK_ID` and `CHROME_PATH` from the environment. `qa:reconnect`,
`qa:offline`, `qa:presence` and `qa:chat` also start and stop the server itself,
so build it first (`cd server && npm run build`), because telling a browser it is offline does *not* drop an
established WebSocket, so taking the station away is the only way to test a
disconnection for real. `qa:admin` uploads `QA_UPLOAD_FILE` (default: the short test fixture, so
point it at something a few minutes long) and drives three tabs at once: an
admin, a listener, and a second listener that joins after the queue was built.
It checks that both listeners hear every command, show the same queue as the
admin without a reload, and never grow a control. `qa:wishes` drives three tabs
for the property no unit test can see: that a wish reaches the person who asked
and the admin, and nobody else, with a chat message sent the same second as the
control, so "the other listener saw nothing" means something. `qa:skips` drives
three for the properties that are about the room: one number three pages agree
on live, each of them with its own answer to "is my vote in?", a vote that leaves
with the tab that cast it, and a unanimous room that skips nothing. `qa:history`
is the two halves of that acceptance: a line appearing the moment a track
changes without anyone touching the page, and the same list still there after a
reload and for someone who only just arrived. `qa:offline` is the only one that
starts with no station at all: it loads the page against a dead server, watches
the message hold still through several backoff attempts rather than flickering
once per retry, waits for the page to tune itself in when the server appears,
and then takes it away again underneath a playing listener, which has to read
as a drop rather than as never having found it, and must not blank the track.

Between them these caught five bugs that every unit test passed straight
through; see `docs/qa-notes.md`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `master` and every pull
request, in four jobs:

- **checks.** Typecheck, unit tests and build, for both workspaces, on Node 20
  and Node 22. Two versions because `server/package.json` claims `>=20.12` while
  the containers ship 22; testing only one of those leaves the other a guess.
- **sync check.** `server/npm run sync-check`, the headless version of
  `verify:sync`. Two listeners join a real server over real websockets at
  different times and must compute the same playback position. It takes about
  two seconds and it is the thing that must never regress.
- **docker compose stack.** Builds both images, brings the stack up with
  `--wait` so the Dockerfile healthchecks have to pass, then drives it over the
  published ports: `/health` through nginx and direct, the page plus its hashed
  bundle, `/api/tracks`, and an admin sign-in that has to refuse the wrong
  password before it accepts the right one. This is the only job that sees
  nginx, the native `better-sqlite3` build and the volume.
- **single image.** Builds the root `Dockerfile` and drives it over one port.
  It makes the same front-door assertions the compose job makes of nginx, for
  the reason given under [Deploying](#deploying): those rules exist twice in
  production, and a copy nobody checks is a copy that drifts. It also pins the
  one failure the app-shell fallback could cause: a mistyped API route coming
  back as a page of HTML with a 200 on it.

What CI does not run is the browser QA above: it needs a real Chrome and a
library with a few minutes of audio in it, neither of which a runner has. Those
stay manual, which is worth remembering when a change touches seeking or
reconnection: the suite that would catch it is the one nobody is running for
you.

Dependency updates come in through `.github/dependabot.yml`: weekly for both
lockfiles with minor and patch bumps grouped into a single PR, monthly for the
action versions pinned in the workflow.

## Deploying

There are two supported shapes, and the difference between them is who owns the
front door.

| | Serves the client | Where |
|---|---|---|
| `docker-compose.yml` | nginx, in its own container | your own machine, a VPS, anywhere nothing is in front |
| root `Dockerfile` | Fastify, same process as the API | Railway, or any platform that runs one container behind its own edge |

The application code is identical in both. What switches is `CLIENT_DIR`: unset,
the server is only an API and leaves `/` alone for whatever is in front of it;
set to the built client, it also owns the front door.

### The front door exists three times

`/`, `/?k=<key>` and `/welcome` are decided in three separate places: nginx's
config, Vite's dev middleware, and `server/src/lib/doorway.ts`. That is a real
cost and it is deliberate: each of the three is the only thing listening in the
environment it serves, and none of them can import from the others (the client
image does not contain the server directory, and vice versa).

What keeps them honest is that the compose stack and the single image are both
driven by CI with the same assertions. If you change a rule, change it in all
three, and the two Docker jobs will tell you if you missed one. The dev server's
copy has no such net; that one is on you.

### Railway

`railway.json` points at the root `Dockerfile` and sets three things that are
not defaults and are all load-bearing:

- **`numReplicas: 1`.** Playback state lives in memory, by design. See
  [the queue](#the-queue). Two replicas is two stations disagreeing with each
  other, with listeners randomly split between them. This is the setting to
  re-check first if the station ever starts behaving impossibly.
- **`sleepApplication: false`.** A sleeping instance drops every websocket, and
  the websocket *is* the station.
- **`healthcheckPath: /health`.** So a deploy that comes up broken is rolled
  back rather than served.

The one thing the file cannot do for you is **mount a volume**. Do it in the
Railway dashboard, mounted at `/data`, which is what `AUDIO_STORAGE_DIR` is set
to in the image. Without one the filesystem is ephemeral and every deploy
silently wipes the library *and* `chunky.sqlite`, and because the rows name
files on disk, the two only mean anything together.

Set **both** `ADMIN_PASSWORD` and `STATION_KEY` as service variables. Neither is
required to boot (the station falls back to the code baked into the source for
both) and that is exactly why a deployment on the open internet has to set
them: otherwise the decks are behind a code that ships in this repository, and
behind the same code you hand out to anyone you want to let listen. See
[`/api/listen`](#apilisten--who-may-hear-the-station).
`PORT` is injected by Railway and read straight out of the environment; `HOST`
already defaults to `0.0.0.0`. Leave `TRUST_PROXY` alone: Railway's edge is in
front, so the sign-in throttle has to read the caller through `X-Forwarded-For`
rather than pacing the whole internet as one.

### Trying the single image locally

Worth doing before a deploy, because it is the artifact that actually ships:

```bash
docker build -t chunky-fm/all-in-one .
docker run --rm -e ADMIN_PASSWORD=whatever -p 3000:3000 chunky-fm/all-in-one
```

The station is then at <http://localhost:3000>: landing page at `/`, the
station itself at `/listen`, `/listen#admin` to run it. Add `-v chunky:/data` to
keep the library across runs.
