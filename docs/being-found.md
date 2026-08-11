# Being found

How somebody who has never heard of chunky.fm ends up standing at its front
door, and what they see when they get there.

This is not a growth plan, and it is worth saying that before anything else,
because almost every instinct in this discipline points the wrong way for this
station.

## The thing that makes this awkward

PLAN.md rules out multiple rooms, and `experiments.md` says why in four words:
**the scarcity is the product.** Thirty people in one room listening to one
person's taste is the whole of it. A campaign that delivered ten thousand
visitors would not be a success that needed managing; it would be the thing this
station was built not to be, and most of them would arrive at a page that says
*off the air*.

So the goal is not traffic. It is three much narrower things:

1. **Legibility.** Somebody was told about this in a pub, or handed a link. They
   look it up later. In ten seconds they should know exactly what it is, and be
   sure they have found the real thing rather than a dead project.
2. **The unfurl.** This spreads by a link pasted into WhatsApp, Discord, Slack,
   iMessage. That preview card is the first impression far more often than any
   search result will ever be, and it is currently blank.
3. **Citation.** Somebody asks an answer engine *"is there a radio station where
   everyone hears the same song at the same time?"* — a real question with an
   unusually specific shape. chunky.fm is a correct answer to it, and almost
   nothing else is. That is a small, winnable niche.

Traffic is a by-product of doing those three honestly. None of them is served by
keywords.

## What the address answers with today

Measured against the live deployment, not read off the source.

| | |
|---|---|
| The landing page | **1,288 bytes**, of which the content is a title and one sentence |
| Everything else on it | rendered by JavaScript after ~132 kB (gzipped) of it arrives |
| `/robots.txt` | **200, and an HTML document** — the app shell, not a robots file |
| Any unknown path | the same: 200 and the app shell |
| Open Graph / Twitter card | none |
| Canonical | none |
| Structured data | none |
| Favicon | none |
| `sitemap.xml` | none |
| `/api/schedule` | `null` — nothing announced |
| The address itself | `chunkyfm-production.up.railway.app` |

Four of those are worth taking seriously and the rest follow from them.

### 1. The page says nothing to anything that does not run JavaScript

`landing.html` is a shell. Everything written on that page — *music deserves
more than an algorithm*, the philosophy, the listening guide, the room — lives
inside a React bundle, and the served document contains none of it.

Google renders JavaScript, eventually and imperfectly. The crawlers that matter
for the third goal above largely do not: GPTBot, PerplexityBot, ClaudeBot and
every link unfurler in every chat app fetch the HTML and read what is in it.
What they currently read is a title and a description, and the description is
the only sentence doing any work anywhere in this whole surface.

That is the single biggest gap, and it is not an argument for server-side
rendering. The landing page is a scroll of prose with animation over it, and
prose is the part that needs to be in the document. Put the argument in the HTML
and let the React page render around it.

### 2. `/robots.txt` is an HTML page

The app-shell fallback catches it, as it catches every unknown path, and answers
200. Two consequences, and the second is worse than it sounds:

- No crawler can be told anything — including which paths are pointless, which
  matters here because `/listen` is an application with nothing to index.
- Every wrong URL anybody ever guesses returns 200 with content. That is a soft
  404 at unlimited scale, and it is the kind of thing that quietly costs a small
  site its crawl budget.

### 3. The link has no face

The one surface that is definitely used — somebody pasting the address into a
chat — produces a bare grey rectangle. This is the cheapest fix in the document
and probably the highest return, because it is the moment the station is
recommended by a person, which is the only recommendation it wants.

There is something better than a stock image available here, too. The station
already makes **session posters**: `ScheduledSession.poster`, already served
publicly over HTTP without a key, already the thing the off-air screen draws.
When a session is announced, the poster for it is the right unfurl. When one is
not, a plain card.

### 4. The address is a Railway subdomain

`chunkyfm-production.up.railway.app` says *deployment* rather than *station*. It
cannot carry a brand, it shares a registrable domain with every other Railway
project, and in an unfurl it reads as something temporary — which undercuts the
one thing the page is trying to establish, that this is a real place that
happens on real evenings.

**This is the only item here that costs money**, and it is the largest single
lever. Railway serves custom domains at no charge; the domain is the expense,
and `.fm` is dear — roughly seventy to a hundred a year. Any real domain beats
the current one; the exact one matters less than having it.

## The three visitors

Everything below is aimed at one of these, and it is worth being explicit about
which, because they want different things and one of them is not a person.

**Somebody who was told about it.** Wants: confirmation this is the thing, what
it sounds like, and when the next one is. Arrives on the landing page and
decides in seconds.

**An answer engine.** Wants: plain declarative sentences that answer a question,
in the HTML, near the top, with nothing to infer. Cites what it can quote.

**A crawler.** Wants: a robots file, a sitemap, canonical URLs, no soft 404s, and
a page that does not take four hundred kilobytes of JavaScript to say what it is.

## The plan

Five pieces, ordered by return over effort. The first two are most of the value.

### F1 — make the document say what the page says

Write the station's argument into `landing.html` as real markup: a heading, the
sentence that already exists as the description, and four or five short
paragraphs of the prose that is currently only in the React bundle. Have the
landing app render around or over it.

This is not a `<noscript>` block. A `<noscript>` is a consolation for a browser
without JavaScript; this is the document's actual content, and it should be
served to everybody, indexed, quotable, and true whether or not anything else
loads.

Aim for **the first two hundred words answering the question**. Something close
to what the page already says, in the order an answer engine can use:

> chunky.fm is a live internet radio station where everyone listening hears the
> same second of the same song. One person chooses the records; there is no
> shuffle, no skipping, and no algorithm. Sessions happen on announced evenings
> and end when they end — the station is deliberately off air the rest of the
> time.

Then the paragraphs that make it worth staying for.

**Also here:** `<html lang="en">` is already right, and the description should
stay exactly as it is. It is a good sentence and it is the one thing currently
doing any work.

### F2 — the head, and the face

In `landing.html`:

```html
<link rel="canonical" href="https://chunky.fm/" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="chunky.fm" />
<meta property="og:title" content="chunky.fm — everyone hears the same second" />
<meta property="og:description" content="…the description that already exists…" />
<meta property="og:image" content="https://chunky.fm/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
```

Two decisions worth making deliberately rather than by default:

- **The image is 1200×630 and it is not a screenshot.** A screenshot of a dark
  player is illegible at card size. The gramophone, the wordmark, and the one
  sentence, at a size somebody can read on a phone in a group chat.
- **When a session is announced, the card is its poster.** The schedule already
  carries one and it is already public. That makes the unfurl say *this is
  happening on Saturday* rather than *this exists*, which is a different and
  much better message to receive from a friend.

### F3 — stop the fallback swallowing the crawl files

Three real files, served before the app-shell fallback in `lib/errors.ts` gets
to them:

- **`/robots.txt`** — allow the landing page, disallow `/api/` and `/listen`,
  point at the sitemap. `/listen` is an application: there is nothing in it to
  index, it is behind a door on a private station, and most of the time it says
  *off the air*.
- **`/sitemap.xml`** — two or three URLs. It is not for discovery at this size;
  it is for `lastmod`, which is how a crawler learns the page changed.
- **`/llms.txt`** — an emerging convention and cheap: a short plain-text
  description of what this is and what the important URLs are. This project
  happens to have unusually good raw material for it in `docs/`.

And a decision that should be made on purpose rather than by omission: **whether
to allow the AI crawlers at all.** Allowing them is what makes the third goal
possible. Refusing them is a defensible position for a station whose premise is
scarcity. I would allow them — the answer to *"where can I listen with other
people"* being this station is worth more than the visitors it costs — but it is
a choice, and robots.txt is where it gets made.

Also fix the shape of the fallback: an unknown path should answer **404** with
the shell, not 200. The app already handles unknown routes; the status code is
what tells a crawler the page is not real.

### F4 — the two schemas that earn their place

Not a sweep of every type that could apply. Two:

**On the landing page, `RadioStation`.** Name, url, description, and
`broadcastAffiliateOf`/`sameAs` pointing at the GitHub repository, which is real
corroboration that this is a real thing.

**When a session is announced, `BroadcastEvent`.** This is the one genuinely
time-sensitive, genuinely rich-result-eligible thing the station has:

```json
{
  "@type": "BroadcastEvent",
  "name": "chunky.fm — Saturday",
  "startDate": "…from /api/schedule…",
  "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
  "eventStatus": "https://schema.org/EventScheduled",
  "image": "…the poster…",
  "url": "https://chunky.fm/listen"
}
```

`/api/schedule` is already public and unkeyed precisely so the landing page can
draw it. Rendering it into the served HTML as JSON-LD is the same data through a
second door.

The honest caveat: an event that has passed and was never updated is worse than
no event at all. Whatever writes this has to read the same `schedule` the page
does, and emit nothing when it is null.

### F5 — a page that answers questions

One more document — `/about`, or a section low on the landing page — written as
plain questions and plain answers. This is the AEO play, and it is also just a
good page for a person:

- What is chunky.fm?
- How does everyone hear the same second of the same song?
- Do I need an account? *(No. A nickname, kept in your own browser.)*
- What happens when it is off air?
- Can I request something?
- Who chooses the music?

Answer each in two or three sentences, in the HTML. Mark it up as `FAQPage` if
it stays short. The value is not the rich result; it is that an answer engine
summarising the station has exact sentences to quote rather than prose it has to
interpret.

## What is built

**F1 and F3 are done.** The landing page serves **5.2 kB** of the station's own
argument where it served 1.3 kB of shell, and the three crawl files are files
rather than the app shell wearing a 200.

Two notes on how they came out.

**The prose lives inside `#root`, and React empties it on mount.** That is the
only arrangement where both things are true at once — what a crawler reads is in
the document, and what a person sees is the real page — without a copy hidden
under the other one. Hidden text is the way this is commonly done and is the way
it gets a site penalised. There is a check for both halves, including that the
two headings say the same thing: a reader arriving at one after the other must
not feel they were told different things.

**The crawl files are server routes, on the `/health` precedent.** They have to
carry absolute URLs, and this station's address is about to change — a Railway
subdomain today, a real domain when somebody buys one. Built from the request,
that costs nothing and needs no configuration; written into a file, it is a
wrong hostname sitting in the repository waiting to be noticed. All three front
doors were taught about them, because `lib/doorway.ts` exists to stop exactly
that kind of drift.

One thing from F3 was **considered and deliberately left**: making an unknown
path answer 404 rather than 200. The argument for it is soft 404s at unlimited
scale; the argument against is that "an unknown path is the station" is a stated
invariant in `doorway.ts`, honoured in three places, and changing it costs work
in all three for a benefit that `Disallow` has already taken most of. Nothing
requests garbage paths on a two-URL site. Worth revisiting only if a crawl
report ever says otherwise.

## What not to do

- **Do not chase volume.** No keyword pages, no "best internet radio stations"
  listicle bait, no blog. A station for thirty people does not have a content
  strategy, and pretending otherwise would produce pages that are false about
  what this is.
- **Do not index `/listen`.** It is an app behind a door that is usually shut,
  and a search result reading *off the air* is worse than no result.
- **Do not server-side render the station.** The landing page needs its prose in
  the document; the station needs a socket and a clock. They are different
  problems and only one of them is this.
- **Do not put the schedule in the title.** A title that changes with the
  broadcast is a title nothing can settle on.

## The part that is not on the site at all

Worth saying, because it is probably where most of the actual finding happens:
**citation comes from corroboration.** An answer engine is far more likely to
name a station that appears in a few credible places than one with perfect
markup and nothing pointing at it.

What is available here, roughly in order of honesty:

- **The repository.** The README is already extraordinary and is the best
  argument this project has. It should link the station prominently and the
  station should link it back.
- **Show HN, or one good post about the sync problem.** The interesting thing
  here is not "I built a radio station", it is thirty browsers agreeing on the
  same instant to within tens of milliseconds without any audio touching the
  server. That is a post people would read, and it earns links that no markup
  can.
- **Directories of internet radio**, where they are real and not spam.

None of that is optimisation. It is the ordinary way something small becomes
known, and it is what makes the four items above worth having.

## How to tell if it worked

Not rankings. Three checks that mean something at this size:

1. Paste the link into a group chat. Does the card make somebody want to click?
2. Ask three answer engines *"is there an internet radio station where everyone
   hears the same song at the same time?"* Are we in the answer, and is what
   they say about us true?
3. `curl` the landing page and read what comes back. If the argument for the
   station is not in there, none of the rest matters.

The third is the one to run first, and it is the one that fails today.
