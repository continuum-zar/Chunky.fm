import chatIcon from '../assets/icons/chat.svg'
import scheduleIcon from '../assets/icons/schedule.svg'
import slidersIcon from '../assets/icons/sliders.svg'
import { memo, useEffect, useRef, useState } from 'react'
import { stationUrl } from '../lib/routes.js'
import { Waveform } from '../Turntable.js'
import { DraggableCard, DraggableCardStage } from './DraggableCard.js'
import { FeyCards } from './FeyCards.js'
import { FlipBoard } from './FlipBoard.js'
import { GlareCard } from './GlareCard.js'
import { Globe } from './Globe.js'
import { Gramophone } from './Gramophone.js'
import { ResizableNavbar } from './ResizableNavbar.js'
import { Spotlight } from './Spotlight.js'
import { SquigglyText } from './SquigglyText.js'
import { Timeline } from './Timeline.js'
import { TracingBeam } from './TracingBeam.js'
import { InfiniteMovingCards } from './InfiniteMovingCards.js'
import { ListenerView } from './ListenerView.js'
import { NextSession } from './NextSession.js'
import { MacbookScroll } from './MacbookScroll.js'
import { MaskContainer } from './MaskContainer.js'
import { MovingColumns } from './MovingColumns.js'
import { StickyScroll } from './StickyScroll.js'
import {
  clock,
  initial,
  ROOM,
  saidBy,
  SESSION,
  SLEEVES,
  WISHES,
} from './session.js'
import { useOneByOne } from './useOneByOne.js'
import { useOnScreen } from './useOnScreen.js'
import { useScrubbedSession } from './useScrubbedSession.js'

/**
 * The page in front of the station.
 *
 * It is a separate document from the station itself (see landing.html) and it
 * knows nothing about a socket, a clock or a listener. Everything on it is
 * fixed, so it renders the same whether the station is on the air, off it, or
 * not deployed yet. That is the point: it has to answer "what is this" for
 * somebody who cannot get in, and a page that needed the station to be up in
 * order to describe the station would be down exactly when it was needed.
 *
 * It is arranged as one question at a time (what is this, why does it exist,
 * how does it work, what else is it, what is it not, who is running it) because
 * a visitor who has to hold six ideas at once puts the page down. The philosophy
 * is meant to arrive by the end rather than in the first screen.
 *
 * The one thing it does not invent is the design. The deck and the level meter
 * here are the station's own components imported unchanged, and every colour
 * comes from tokens.css, so what a visitor sees before tuning in is the thing
 * they get afterwards, not an artist's impression of it.
 *
 * And one thing it does that a page of prose could not: the whole document is
 * scrubbed through a song. See `useScrubbedSession`. By the time somebody
 * reaches the bottom they have moved through five and a half minutes with a
 * room talking around them, which is the product, felt rather than described.
 */
export function Landing() {
  const at = useScrubbedSession(SESSION.duration)

  return (
    <div className="landing">
      {/* One bar that is both: full width at the top of the page, and a floating
          pill once you have started reading. See ResizableNavbar. */}
      <ResizableNavbar items={NAV} action={TUNE_IN_ACTION} aside={DECKS_ASIDE} brand={WORDMARK} />
      <main>
        <Hero />
        {/* The one true thing on this page, and only when there is one. See
            NextSession: everything else here is an invented evening, because
            the page in front of the station cannot ask it anything. This can,
            because a poster is for the people who have not been let in. */}
        <NextSession />
        <Moment />
        <Creed />
        <Works />
        <Guide />
        <Room at={at} />
        <Talks />
        <Wishes />
        <Live />
        <BeenOn />
        <Dj />
        <Limits />
        <Call />
      </main>
      <Foot />
    </div>
  )
}

/** The two ways off this page, named once. See STATION_PATH in lib/routes.ts. */
const TUNE_IN = stationUrl()
const DECKS = stationUrl('admin')

/** Where the bar can take you. The same four the foot repeats. */
const NAV = [
  { name: 'The room', link: '#room' },
  { name: 'Conversations', link: '#talks' },
  { name: 'What has been on', link: '#been-on' },
  { name: 'The DJ', link: '#dj' },
]

/**
 * The station's name, and the bar's other two props.
 *
 * Built once at the module rather than per render. `Landing` re-renders on every
 * scroll frame (the playhead moves) and a fresh object literal here would
 * re-render the bar with it, throwing away the spring it is in the middle of.
 */
const WORDMARK = (
  <p className="wordmark navbar__brand">
    chunky<span className="wordmark__tld">.fm</span>
  </p>
)
const TUNE_IN_ACTION = { name: 'Tune in', link: TUNE_IN }
const DECKS_ASIDE = {
  name: 'Run the decks',
  link: DECKS,
  icon: <img src={slidersIcon} alt="" width={16} height={16} />,
}

/**
 * The top of the page.
 *
 * A claim, the line that backs it, a paragraph, and one thing to press.
 * Everything else that could go here is somewhere below it, and the reason it is
 * almost empty is that the job of this screen is not to explain the station: it
 * is to make somebody want to hear it, and then to get out of the way.
 *
 * The claim is about the alternative rather than about loneliness. "Music wasn't
 * meant to be heard alone" named a feeling the visitor may not have; an
 * algorithm is the thing they are actually being offered everywhere else, and
 * this is the page saying what it is instead of that. What follows is the DJ's
 * own sentence (the same one the section at the bottom of the page opens with,
 * said twice on purpose) and then the mechanism, in the order it happens: the
 * room asks, somebody spends the day on it, and then everybody is in the same
 * second of it together.
 *
 * The gramophone behind the words is inside `aria-hidden` and is not a report on
 * anything: it turns because a gramophone turns, on a page with no station
 * behind it to ask. Shown as an object, in the place a reader takes as a
 * picture, it is honest; shown as a live instrument it would be claiming
 * something the page cannot know. See `Gramophone`: until the model arrives,
 * and forever on a machine that cannot draw it, this is the flat deck instead.
 */
const Hero = memo(function Hero() {
  return (
    <section className="hero">
      <div className="hero__stage" aria-hidden="true">
        <Gramophone />
      </div>

      <div className="hero__copy">
        <h1 className="hero__headline">Music deserves more than an algorithm.</h1>
        <p className="hero__line">Every session begins with a question.</p>
        <p className="hero__blurb">
          The room chooses the theme. I spend the day curating the story. When the broadcast begins,
          everyone hears the same song at the same moment. With context, annotations, and the
          chance to discover something they would never have searched for themselves.
        </p>
        {/* The other half of what the station is, said once at the top and
            argued properly further down. See `Talks`: an evening here is not
            always records, and a page that only ever said "music" would be
            describing half of the thing somebody is about to walk into. */}
        <p className="hero__blurb hero__blurb--also">
          Other nights there is somebody on the mic instead, and the room listens in on the
          conversation.
        </p>
        <a className="button button--large" href={TUNE_IN}>
          Join tonight’s session
        </a>
      </div>

    </section>
  )
})

/**
 * The product, in five seconds.
 *
 * Before any explanation, because the thing is easier to see than to describe:
 * a globe with every listener's arc landing on the one station, the sentence
 * beside it, under them the evening's records in a pile across the whole width,
 * and under those the level meter. The pile gets the whole width because there
 * are nine records: four sat in a column beside the sentence, and nine want a
 * table.
 *
 * They can be picked up and thrown; see DraggableCard, a port of Aceternity
 * UI's. Which is not decoration: the argument of this whole page is that a
 * station is a person putting records on rather than a queue running, and a
 * pile of sleeves you can shove around says that in a way a rectangle with a
 * progress bar in it does not.
 *
 * Every sleeve is the same sleeve. The one that is on is the one at the front
 * of the pile and nothing else: no badge on it, no clock, no head count. It is
 * a record, and a record does not report anything; the LIVE mark beside the
 * sentence is where this page says what is happening, and saying it twice
 * would be the pile pretending to be an interface rather than a stack of
 * records on a table.
 *
 * The records are `SLEEVES`, the same evening the list further down draws.
 */

/**
 * Where each sleeve lies on the table, and how far it is turned.
 *
 * By hand rather than at random: a random scatter has to be re-rolled until it
 * looks like a pile, and this one is the roll that did. Newest first, so the
 * record that is on is the one on top and nearest the middle, with the rest of
 * the evening spread out under it, which is the only thing on the page that
 * says which one is playing.
 *
 * Positions are percentages of the table rather than pixels, so the whole
 * arrangement holds its shape from a phone to a wide monitor instead of being
 * three separate scatters in three media queries.
 *
 * Falls back to square-on rather than to nothing, so a tenth sleeve added to the
 * evening lands on the table instead of at a rotation of `undefined`.
 */
const SQUARE_ON = { top: '22%', left: '40%', turn: 0, z: 1 }
const PILE = [
  { top: '22%', left: '37%', turn: -3, z: 9 },
  { top: '2%', left: '20%', turn: -8, z: 8 },
  { top: '6%', left: '52%', turn: 6, z: 7 },
  { top: '48%', left: '44%', turn: 4, z: 6 },
  { top: '44%', left: '24%', turn: -6, z: 5 },
  { top: '4%', left: '70%', turn: 9, z: 4 },
  { top: '50%', left: '64%', turn: -4, z: 3 },
  { top: '0%', left: '2%', turn: 5, z: 2 },
  { top: '50%', left: '5%', turn: -9, z: 1 },
]

const Moment = memo(function Moment() {
  // Drag on a touch screen swallows the gesture that started on it, and a pile
  // covering half a column would be a pile that stops the page scrolling under
  // a thumb. On a phone it is a pile of records to look at.
  const canDrag =
    typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches

  return (
    <section className="moment" id="moment">
      <div className="moment__top">
        {/* Twelve listeners, one station, and every arc landing on it. See
            Globe: nothing arrives until the page is readable, and on a machine
            that cannot draw it the sentence stands on its own. */}
        <Globe />

        <div className="moment__said">
          <p className="moment__lead">Everyone is hearing this exact moment.</p>
          <ul className="moment__nots">
            <li>No skips.</li>
            <li>No shuffle.</li>
            <li>No algorithm.</li>
          </ul>
        </div>
      </div>

      {/* The flag is on the stage rather than each card so the CSS can drop the
          grab cursor for the whole pile in one rule. */}
      <DraggableCardStage className="pile" dragEnabled={canDrag}>
        {SLEEVES.map((play, index) => {
          const where = PILE[index] ?? SQUARE_ON
          return (
            <DraggableCard
              key={play.title}
              className="sleeve"
              dragEnabled={canDrag}
              style={{ top: where.top, left: where.left, zIndex: where.z, rotate: where.turn }}
            >
              <img
                className="sleeve__art"
                src={play.cover.src}
                alt={`${play.cover.album} by ${play.artist}`}
                width={640}
                height={640}
                draggable={false}
                // The one on top is above the fold and is the first thing to
                // draw; the three under it can wait their turn.
                loading={index === 0 ? 'eager' : 'lazy'}
              />
              <p className="sleeve__what">
                <span className="sleeve__album">{play.cover.album}</span>
                <span className="sleeve__artist">{play.artist}</span>
              </p>
            </DraggableCard>
          )
        })}
      </DraggableCardStage>

      {/* The station's own level meter, centred under the table.
          Inside `aria-hidden` like every other instrument on this page: it moves
          because the page says sound is coming out, not because any is. */}
      <div className="moment__levels" aria-hidden="true">
        <Waveform live />
      </div>
    </section>
  )
})

/**
 * What is wrong, and what the station is for. One section, not two.
 *
 * This used to be two consecutive screens: `Why` (the case against the
 * algorithm) and `Creed` (the philosophy), in the same first-person voice and
 * the same setting, arguing the same thing at two different lengths. Read one
 * after the other they were not two halves of an argument, they were the
 * argument and then the argument again, and the second one was better. So the
 * general claim keeps its opening line and the rest of it goes: everything
 * `Why` spent eleven lines arriving at is said here in two, and this half has
 * the only concrete thing either of them had.
 *
 * Between `Moment` and `Works`, which is the order the page argues in: here is
 * the thing, here is why it should exist, and only then here is how an evening
 * runs. Put after `Works` it would be a philosophy appended to a product; put
 * here it is the reason the product is shaped the way the next section shows.
 *
 * It is the first section in the first person, and the only one before the
 * bottom of the page. That is not the DJ introducing himself; see `Dj`, which is
 * deliberately last but one and is a person saying who they are. This is an
 * argument that happens to be told through something that happened to somebody,
 * which is a different thing and can be read by a stranger.
 *
 * The record is not chosen at random. Pink Floyd's Wish You Were Here is the
 * session this whole page is scrubbing through (see SESSION in session.ts)
 * so the album named as the thing somebody once explained is the album playing
 * along the bottom of the screen while you read about it.
 *
 * One thought a line, in groups, with the spacing doing the work. The claim,
 * the thesis, what happened, what was said, what changed, and then the one line
 * that is about the station.
 */
const Creed = memo(function Creed() {
  return (
    <section className="creed">
      <h2 className="section__title section__title--quiet">The philosophy</h2>

      {/* A line drawn down the margin as far as the reader has got. See
          `TracingBeam`. It is here rather than anywhere else on the page because
          this section is the one continuous argument on it: five groups that
          only work read in order, and a line being drawn beside them is that
          said without a word. Anywhere the page is making a list instead, the
          same beam would be claiming a thread that is not there. */}
      <TracingBeam className="creed__beam">
        <p className="creed__claim">
          {/* One word wriggles, and it is the word the section is against: this
              is a page that does not trust `optimizing`, and a word that will
              not hold still is that said before the sentence gets to it.
              Squiggling the whole line would just be a wobbly headline. */}
          We stopped discovering music. We started <SquigglyText>optimizing</SquigglyText> it.
        </p>

        <div className="creed__stack">
          <p className="creed__line">Some songs don’t need better recommendations.</p>
          <p className="creed__line">They need better introductions.</p>
        </div>

        <div className="creed__stack">
          <p className="creed__said">
            I didn’t fall in love with Pink Floyd because an algorithm recommended them.
          </p>
          <p className="creed__said">I fell in love because someone explained who they were.</p>
        </div>

        <div className="creed__stack">
          <p className="creed__said creed__said--quiet">The philosophy behind their albums.</p>
          <p className="creed__said creed__said--quiet">The loss of Syd Barrett.</p>
          <p className="creed__said creed__said--quiet">The choices hidden inside the music.</p>
        </div>

        <div className="creed__stack">
          <p className="creed__said">When I listened again, I wasn’t hearing different sounds.</p>
          <p className="creed__said">I was hearing different meaning.</p>
        </div>

        <p className="creed__turn">That’s what chunky.fm is built to do.</p>
      </TracingBeam>
    </section>
  )
})

/**
 * What a session is, in five steps.
 *
 * Each one is a heading and a few fragments under it. It is the setting `Creed`
 * uses, applied five times. The page has settled on one thought a line for
 * anything that is an argument rather than a description, and this is the
 * argument for the shape of an evening rather than a description of a feature.
 *
 * Each step used to close with a line saying what its fragments were for, and
 * every one of those lines is said better elsewhere on the page: step 3's was
 * `Moment`, step 4's was `Guide`, step 5's was `Creed`, and step 2's was the
 * heading standing directly over the row. A card that states its own moral is
 * the page reading itself out, and five of them in a row is why this section
 * felt like homework. The heading carries the step; the fragments are what it
 * is made of; nothing here needs a verdict under it.
 */
const STEPS = [
  {
    title: 'The room chooses the question.',
    lines: ['Not songs.', 'A theme.'],
    /* The two examples, which are the only place this section says what a theme
       actually sounds like. Quoted, like the wishes further down the page, and
       for the same reason: they are things somebody would type. */
    like: ['Songs that sound like forgiveness.', 'Albums that changed music forever.'],
  },
  {
    title: 'I curate the journey.',
    lines: ['Hours of listening.', 'Research.', 'Context.'],
  },
  {
    title: 'We listen together.',
    lines: ['One room.', 'One broadcast.', 'One timeline.'],
  },
  {
    title: 'Follow the Listening Guide.',
    lines: [
      'Open the notes whenever you want.',
      'See why a lyric matters.',
      'Why a guitar solo hurts.',
      'Why this song comes before the next one.',
    ],
  },
  {
    title: 'Leave with something.',
    lines: ['Export the playlist.', 'Keep the annotations.', 'Take your own notes.'],
  },
]

/**
 * The five of them, going past.
 *
 * The same row the six shorter steps were in: `InfiniteMovingCards`, holding a
 * `GlareCard` each. A row rather than a column because they are a sequence and a
 * column of five reads as a feature list, and because below the width five fit
 * in, a row keeps the order that a reflowing grid would quietly lose by putting
 * step 4 under step 1.
 *
 * The card is up to 320 wide and has no ratio: the row is a flex row and every
 * card comes out as tall as the tallest, so the shape follows the longest step
 * rather than being declared. See `.scroller__item` in landing.css.
 */
const Works = memo(function Works() {
  return (
    <section className="works">
      <h2 className="section__title">Every session tells a story.</h2>

      {/* The five of them, going past forever. Slow, because they are steps to
          be read rather than a row of logos, and paused the moment a pointer, a
          finger or a keyboard lands on one, which is the only way a card that
          reveals itself on hover can be looked at at all. */}
      <InfiniteMovingCards
        className="works__row"
        speed="slow"
        items={STEPS.map((step, index) => ({
          key: step.title,
          node: (
            <GlareCard>
              <span className="step__n" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="step__title">{step.title}</h3>

              <div className="step__stack">
                {step.lines.map((line) => (
                  <p className="step__line" key={line}>
                    {line}
                  </p>
                ))}
              </div>

              {step.like ? (
                <div className="step__stack">
                  <p className="step__line">Something like:</p>
                  <p className="step__like">“{step.like[0]}”</p>
                  <p className="step__or">or</p>
                  <p className="step__like">“{step.like[1]}”</p>
                </div>
              ) : null}
            </GlareCard>
          ),
        }))}
      />
    </section>
  )
})

/**
 * Three notes, at the second of the record they belong to.
 *
 * Written as timestamps rather than as bullet points because the timestamp is
 * half of what a note is: the same sentence at no particular moment is a review,
 * and at 2:14 it is somebody leaning over and telling you to listen to the next
 * bit. The three of them are also a shape (one about the playing, one about the
 * writing, one about why it is on tonight) which is the range the guide covers
 * said without a sentence saying it.
 */
const NOTES = [
  { at: '2:14', says: 'Listen to how the guitar hesitates before resolving.' },
  { at: '4:31', says: 'This lyric was written after…' },
  { at: '5:02', says: 'This is why I chose this song tonight.' },
]

/**
 * What the notes are, and what they are not.
 *
 * Straight after `Works`, which is where the guide is named: step 04 says to
 * follow it and this is the section that says what following it is like. The two
 * denials come first on purpose: everybody arriving at the phrase "listening
 * guide" is already imagining commentary over the top of the record, and the
 * section has to get rid of that before it can say what it means.
 *
 * The timestamps are not `aria-hidden`, unlike every other clock on this page.
 * The others are pictures of a playhead; these are the content, and a note without
 * the second it belongs to is a different and much worse thing.
 *
 * The notes are on a rail rather than in a list. See `Timeline`: they were
 * always three positions in a record and an `ol` is the one shape that says
 * they are in order without saying they are at points, which is half of what a
 * listening note is.
 */
const Guide = memo(function Guide() {
  return (
    <section className="guide">
      <h2 className="section__title">The Listening Guide</h2>

      <div className="guide__stack">
        <p className="guide__line">Not commentary.</p>
        <p className="guide__line">Not analysis.</p>
      </div>

      <p className="guide__close">Just small pieces of context that make you hear differently.</p>

      <p className="guide__label">Example</p>

      <Timeline className="guide__rail" items={NOTES} />
    </section>
  )
})

/**
 * The room, talking, and the one section that moves.
 *
 * The lines arrive as the page's playhead reaches them, so a reader who has
 * scrolled this far is somewhere in particular in a song and the room is
 * somewhere in particular with them. That is the entire product in one panel,
 * and it is doing it rather than saying it.
 *
 * Every line is in the DOM from the first render and only its appearance is
 * withheld, so a screen reader gets the conversation whole rather than a
 * transcript that depends on how far somebody scrolled. The playhead chip is
 * `aria-hidden` for the same reason the bar at the bottom is: it is a picture of
 * a clock, not a clock.
 *
 * The three of them are a `StickyScroll`, so what is beside the words changes as
 * you read down them: a name, then the room talking, then the room disagreeing.
 */
function Room({ at }: { at: number }) {
  return (
    <section className="room" id="room">
      <div className="section__head">
        <span className="section__mark" aria-hidden="true">
          <img src={chatIcon} alt="" width={18} height={18} />
        </span>
        <h2 className="section__title">And the room around it</h2>
      </div>

      {/* The framing, before any of the mechanics below it. What the panels show
          is a chat window, and a chat window is what everybody has already
          decided this is by the time they get here, so the section says what
          the talking is for before it shows any of it. The claim is not that
          people talk during the music; it is that there is only one point in the
          record for all of them, which is what makes a sentence about the next
          eight bars worth typing at all.

          Two stacks, where there were four. The two that went were the worked
          examples — somebody calling the second guitar, the room going quiet —
          and both of them are demonstrated rather than described a few inches
          below, in a panel that fills with the room saying exactly that kind of
          thing as you scroll. Telling a reader what they are about to be shown
          is the one thing this section can afford least. */}
      <div className="room__creed">
        <div className="room__stack">
          <p className="room__line">You’re not listening beside people.</p>
          <p className="room__line room__line--said">You’re listening with them.</p>
        </div>

        <div className="room__stack">
          <p className="room__line">The conversation isn’t happening around the music.</p>
          <p className="room__line room__line--said">It’s happening inside it.</p>
        </div>
      </div>

      <StickyScroll
        className="room__reveal"
        items={[
          {
            title: 'Just a nickname',
            description: (
              <p>
                No account, no profile, nothing kept once the tab closes. You type what everyone
                should call you, you press one thing, and you are in the room.
              </p>
            ),
            panel: <JoinPanel />,
          },
          {
            title: 'The room, talking',
            description: (
              <>
                <p>
                  Everything anyone says lands at the same point in the song for everyone, because
                  there is only one point in the song.
                </p>
                <p>
                  Which you can watch happen. That conversation is arriving as you scroll the page,
                  each line at the second of the record it was said at. Some of it had already been
                  said when you got here, which is what walking into a station mid-song is like.
                </p>
              </>
            ),
            panel: <TalkPanel at={at} />,
          },
        ]}
      />
    </section>
  )
}

/** What joining looks like: a name, and one thing to press. */
const JoinPanel = memo(function JoinPanel() {
  return (
    <div className="panel panel--join" aria-hidden="true">
      <p className="panel__label">What should everyone call you?</p>
      <p className="panel__field">thandi</p>
      <span className="button button--large panel__go">Tune in</span>
      <p className="panel__note">Nothing else is asked for, and nothing is kept.</p>
    </div>
  )
})

/**
 * The conversation, filling as the page's playhead advances.
 *
 * Mounted for as long as the section is, whichever item is active. See the
 * note in StickyScroll about not unmounting the panels. A conversation that
 * started again every time somebody scrolled past it would not be one.
 */
function TalkPanel({ at }: { at: number }) {
  /*
   * Due, and then said.
   *
   * The playhead says how many lines have been reached; `useOneByOne` lets them
   * land one at a time. Arriving here with the record already at 2:13 makes five
   * of them due in the same frame, and five bubbles appearing together is a
   * transcript rather than a conversation.
   */
  const due = saidBy(ROOM, at).length
  const shown = useOneByOne(due)
  const lines = useRef<HTMLOListElement>(null)

  /*
   * Follow the conversation down, the way a chat window does.
   *
   * In bubbles the nine lines are taller than the panel, so without this the one
   * that just arrived lands below the fold and the whole effect happens where
   * nobody can see it. Keyed on how many have been said rather than on the
   * playhead, so it only moves when there is actually something new: a panel
   * that re-scrolled every second of the song would fight anyone reading back
   * through it.
   *
   * Watching the rows rather than waiting a fixed time. A line arrives by
   * opening from `0fr` to `1fr`, so at the moment a new one is said the row is
   * still flat and `scrollHeight` does not include it yet, so scrolling to the
   * bottom lands at a bottom that has not happened. A timer set to the length of
   * that transition works until somebody changes it in the stylesheet. A
   * `ResizeObserver` on the rows fires when they have actually finished opening,
   * whatever the CSS says, and costs nine observations.
   */
  useEffect(() => {
    const box = lines.current
    if (!box) return

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const toBottom = () =>
      box.scrollTo({ top: box.scrollHeight, behavior: still ? 'auto' : 'smooth' })

    const watcher = new ResizeObserver(toBottom)
    for (const row of box.children) watcher.observe(row)
    toBottom()

    return () => watcher.disconnect()
  }, [])

  return (
    <div className="talk">
      <div className="talk__top">
        <span className="talk__where" aria-hidden="true">
          {clock(at)}
        </span>
        <span className="talk__of">{SESSION.title}</span>
      </div>

      <ol className="talk__lines" ref={lines}>
        {ROOM.map((line, index) => {
          // Two in a row from the same person is one person still talking, so
          // the second does not get their name and face again.
          const same = ROOM[index - 1]?.who === line.who
          return (
            <li className="line" key={line.at} data-said={index < shown ? 'true' : 'false'}>
              {/* The wrapper collapses to nothing rather than the line being
                  removed, so the panel fills like a chat window instead of
                  standing half empty from the start, and the conversation is
                  still whole in the DOM for anything not reading it by eye. */}
              <span className="line__inner" data-run={same ? 'true' : 'false'}>
                <span className="line__face" aria-hidden="true">
                  {same ? '' : initial(line.who)}
                </span>
                <span className="line__bubble">
                  {same ? null : (
                    <span className="line__top">
                      <span className="line__who">{line.who}</span>
                      <span className="line__at" aria-hidden="true">
                        {clock(line.at)}
                      </span>
                    </span>
                  )}
                  <span className="line__says">{line.says}</span>
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The other kind of session.
 *
 * Straight after `Room`, which is where the talking is established, because
 * this is the same claim carried one step further: if a room hearing the same
 * second of a record is worth building, then a room hearing the same second of
 * somebody answering a question is the same thing with the record turned down.
 * Put anywhere earlier it would read as a second product bolted on; put here it
 * reads as what the room was always for.
 *
 * It describes nothing that is not already built. A guest arrives on an invite
 * link like any other listener (see lib/invite.ts), asks for the mic, passes a
 * sound check and is brought up onto the air by whoever is on the decks (see
 * CallIn.tsx and the floor controls in AdminPanel.tsx). So this section is the
 * page finally saying out loud what that machinery is for, rather than a
 * promise about something that might get written later.
 *
 * The note at the end is the only place on the page that says what the whole
 * thing is rather than what it does, and it is deliberately the quietest block
 * in the section. It is also the one honest word about how far along this is.
 * A landing page that opened with "it is still early" would be apologising; one
 * that never said it at all would be overselling. Said here, after somebody has
 * read enough to want it, it is a person telling you where you have arrived.
 *
 * Set like `Why` and `Creed`: one thought a line, in groups, faint for the
 * setup and the reading colour for the line that answers it.
 */
const Talks = memo(function Talks() {
  return (
    <section className="talks" id="talks">
      {/* A light thrown across the section from off the top corner. See
          `Spotlight`. This is the section about somebody being brought up onto
          the air while the room listens in, and a light on whoever is talking
          is what that looks like in every room it has ever happened in. */}
      <Spotlight />

      <h2 className="section__title talks__title">Not only records</h2>

      <div className="talks__stack">
        <p className="talks__line">Some sessions are a record and a room.</p>
        <p className="talks__line talks__line--said">
          Some are a conversation, and the room is still there for it.
        </p>
      </div>

      <div className="talks__stack">
        <p className="talks__line">A guest gets a link and turns up like anybody else.</p>
        <p className="talks__line">I bring them up onto the air.</p>
        <p className="talks__line talks__line--said">
          Then it is two people talking, with the records still to hand.
        </p>
      </div>

      <div className="talks__stack">
        <p className="talks__line">Anyone listening can ask for the mic.</p>
        <p className="talks__line">If it is the right moment, it gets opened.</p>
        <p className="talks__line talks__line--said">
          The question and the answer land at the same second for everybody.
        </p>
      </div>

      <p className="talks__turn">Music, ideas, and the people behind them.</p>

      {/* The plainest words on the page, and set that way on purpose: the rest
          of this section argues, and this one just says what the thing is.

          One line, where there were three. The first of them opened "an
          independent project exploring music, ideas and the people behind
          them", which is the turn directly above it said again in longer words,
          and the other two are one thought that was punctuated as two. */}
      <div className="talks__note">
        <p>
          It’s still early, which is part of the point: a place where interesting conversations can
          happen without everything needing to become content.
        </p>
      </div>
    </section>
  )
})

/**
 * What the room asks for.
 *
 * The section that would be genres on any other music page, and is not one here.
 * These are wishes (free text, straight to whoever is on the decks) and shown
 * as themselves because the shape of the sentences *is* the argument: nobody
 * types "indie folk, 1970s" into a box like this.
 *
 * Nothing is around them. The wall used to stand inside a panel that tilted
 * upright as the reader arrived at it, and every wish sat on its own card; both
 * were the page presenting the sentences: one announcing them, the other
 * putting a surface under each to say it was an item.
 * They are neither. They are things people typed, and the way to show that is to
 * put them on the page and let them go past: no panel, no card, no frame telling
 * the reader how to take them. The section is the same shape as every other one
 * here now, which is the point: the wishes are the surprising thing, not the
 * furniture around them.
 */
const Wishes = memo(function Wishes() {
  return (
    <section className="wishes">
      {/* Kept in the document and out of the picture, the same idiom as
          `.limits__spoken`. There is nothing here that reads as this section's
          heading the way the question does in `Live`, so rather than leave the
          page's outline with a hole in it where a section used to be, the title
          stays for anything reading structure and goes for anything reading by
          eye. */}
      <h2 className="section__title section__title--quiet">What the room asks for</h2>

      {/* Two stacks said this: "Ask for a feeling. / Not a song." and "Instead
          of searching for tracks… / Describe the moment." They are the same
          instruction twice, and the wall underneath demonstrates it better than
          either. One line, and on to the half that is not obvious. */}
      <div className="wishes__stack">
        <p className="wishes__line wishes__line--said">Ask for a feeling, not a song.</p>
      </div>

      {/* The honest half, and the reason the section exists. The line above is
          about what you may ask; this is about what happens to it, which on any
          other music page is a queue and here is a person reading it. */}
      <div className="wishes__stack">
        <p className="wishes__line">I don’t promise I’ll play your request.</p>
        <p className="wishes__line wishes__line--said">I promise I’ll consider it.</p>
      </div>

      <p className="wishes__turn">That’s the point of having someone behind the decks.</p>

      <WishWall />
    </section>
  )
})

/**
 * The wall, moving.
 *
 * Sentences, going past. Nothing under them: the card they used to sit on was a
 * surface grading into the sheet with graph paper in one corner, which is a
 * good-looking card and was doing the wrong job: it made each wish an entry in
 * something. Set on the page with only the quotation marks around them, they are
 * what they are, and the reader is looking at the words rather than at a wall of
 * tiles that happen to have words on.
 *
 * They go past rather than sit still, and the two columns disagree about which
 * way: the left falls, the right rises. See `MovingColumns`. There is nothing
 * else here: no heading over them and no line under them, because a caption
 * explaining that these are wishes would be the section reading itself out.
 */
function WishWall() {
  return (
    <MovingColumns
      items={WISHES.map((wish) => ({
        key: wish.says,
        node: <p className="wish">“{wish.says}”</p>,
      }))}
    />
  )
}

/**
 * Why it has to be live.
 *
 * The question every page like this forgets: what stops me just playing the same
 * songs tomorrow. The answer is not a feature, so this section has no cards in
 * it and now has nothing under the mask but the one paragraph that answers it.
 *
 * It used to carry a second paragraph, on the station being off more often than
 * it is on. That is worth admitting to and is still admitted to, in `Call`, in
 * three short sentences at the point where somebody is deciding whether to press
 * the button — which is the only place the state of the station is actually
 * load-bearing. Said here as well it was a fifth paragraph in a row about the
 * same evening, and it took the section away from the question it is named for.
 *
 * The question is on a panel you have to look under. Aceternity UI's SVG Mask
 * Effect (see `MaskContainer`) with the section's own two lines in it: the
 * question on the page, and the answer to it lit underneath, found with the
 * cursor. It is the one section on the page where that device is not decoration.
 * The whole argument here is that hearing a song and being in the room while it
 * plays are different things, and one of them cannot be had by reading about it;
 * a sentence you have to go and uncover is that, in the one register the page
 * has that is not words.
 *
 * The answer is repeated in the prose below, which is not redundancy but the
 * point: nothing in this section is only behind the mask. On a phone there is no
 * cursor and no panel either, and the two lines simply read in order.
 *
 * It is the only section with no title over it. "Why it has to be live" was a
 * label on a section whose first line is already the question it was labelling,
 * and reading the two in a row was being told the subject and then asked about
 * it. So the question is the heading, the same `h2` every other section has,
 * set as the pull-quote it looks like, which is what keeps this section in the
 * document's outline rather than leaving a hole in it.
 */
const Live = memo(function Live() {
  return (
    <section className="live">
      {/* 480 rather than the demo's 600: the hole has to open wide enough to
          clear the whole answer and stay inside a panel that is not 40rem tall.
          See the note on `.mask` in landing.css, where the two are kept in
          proportion. */}
      <MaskContainer
        revealSize={480}
        revealText={
          <h2 className="live__ask">“Why can’t I just play these songs myself tomorrow?”</h2>
        }
      >
        <p className="live__answer">Being in the room while it plays is the thing.</p>
      </MaskContainer>

      <p className="section__lede live__after">
        You can. You would hear the same notes and none of the evening: nobody going quiet at the
        same moment as you, nobody asking for the next one, nothing at stake in a song ending.
      </p>
    </section>
  )
})

/**
 * The evening so far.
 *
 * Deliberately not billed as an archive. The station keeps this for as long as
 * it is up and no longer. It is what a person arriving at eleven scrolls to
 * see, not a back catalogue, and the note under the grid says so, because a
 * page implying there are past sessions to browse would be selling one.
 */
/** What the journal keeps, in the order it accumulates over an evening. */
const HOLDS = ['Theme', 'Songs', 'Annotations', 'Listener notes', 'Playlist export']

const BeenOn = memo(function BeenOn() {
  return (
    <section className="been" id="been-on">
      <MacbookScroll
        title={
          <>
            <div className="section__head section__head--mid">
              <span className="section__mark" aria-hidden="true">
                <img src={scheduleIcon} alt="" width={18} height={18} />
              </span>
              <h2 className="section__title">The Listening Journal</h2>
            </div>
            <p className="section__lede section__lede--mid">
              Arrive at eleven and the evening is still there to read backwards.
            </p>
          </>
        }
        screen={<ListenerView />}
      />

      <p className="section__body been__after">
        That is the whole of it: the deck and the room on the left, the words beside them, and
        everything else (the chat, the wishes, the evening so far) one mark away on the rail.
      </p>

      {/* What the journal holds, as a list rather than a sentence: five things
          named plainly is the difference between a tracklist and a record of an
          evening, and running them together into prose would bury the two that
          are not obvious. */}
      <ul className="been__holds">
        {HOLDS.map((held) => (
          <li className="been__holds-item" key={held}>
            {held}
          </li>
        ))}
      </ul>

      <p className="section__body been__after">
        Not a tracklist. What the evening was, kept in the shape it happened in.
      </p>
    </section>
  )
})

/**
 * Whoever is on the decks.
 *
 * Last but one, and not a word earlier: by the time somebody reaches this they
 * have already decided whether they want the thing, and a person introducing
 * themselves before that is asking for trust they have not been given yet.
 *
 * These are Ndamulelo's own lines, kept as written and broken where they were
 * written, one thought a line. Do not run them together into paragraphs. It is
 * the only section on the page in a voice that is not the product's, and the
 * whole reason it works is that it sounds like a person rather than like the
 * rest of the page.
 *
 * They come in four groups and the spacing in landing.css is what says so: the
 * name, what he thinks music is, what he does about it, and the line the whole
 * page has been walking toward. The group breaks are `nth-child` rules, so
 * adding or reordering a line here silently moves them; they are counted from
 * the top of this list and nothing checks that they still land between thoughts.
 *
 * Line five is long enough to wrap, and that is allowed now where it was not
 * before. It used to be true that the longest of these fitted on one line; at
 * eighty-seven characters this one cannot at any size the section could use, and
 * a measure narrow enough to force the point would just be re-punctuating him.
 */
const DJ = [
  'Hi, I’m Ndamulelo.',
  'I don’t think music is something we consume.',
  'I think it’s something we learn to hear.',
  'Every session begins with a question.',
  'Then I spend hours listening, reading, researching, and connecting songs that answer it.',
  'Sometimes the best music isn’t the song you were looking for.',
  'It’s the song someone convinced you to stay with.',
]

const Dj = memo(function Dj() {
  return (
    <section className="dj" id="dj">
      {/* The same gramophone as the hero, at the other end of the page, and
          stopped. The station is off more than it is on, and beside the person
          that depends on is the one place saying so is comfortable. See
          `Gramophone`: one component that draws the model when it can and keeps
          the flat deck when it cannot, so this is not a second thing to
          maintain, and still or off screen, it is not drawing. */}
      <div className="dj__mark" aria-hidden="true">
        <Gramophone still />
      </div>
      <div className="dj__words">
        {DJ.map((line, index) => (
          // Position is the identity: these are the lines of one short
          // statement in order, not a list of anything that can be reordered.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <p className="dj__line" key={index}>
            {line}
          </p>
        ))}
      </div>
    </section>
  )
})

/**
 * What it is not.
 *
 * Kept on the page rather than left for somebody to discover after an evening of
 * setting it up. A landing page that hid them would just be selling a different
 * product.
 *
 * These used to be the constraints as a specification would list them: a head
 * count, no uploads, no accounts, no schedule. They are the reasons for those
 * constraints now, which is a different and better claim: `No autoplay` and `No
 * pressure to maximize listening time` are the same decision said as a fact and
 * said as a position, and only the second one tells a stranger why they should
 * care. The last line is not a limit at all. It is what is left when you take
 * all of them away, and it is the one the section is really for.
 *
 * Said on a split-flap board (see `FlipBoard`) one at a time, the way the
 * board at a station tells you what is not running. Each of these used to carry
 * a line of explanation under it and no longer does: eight statements, on the
 * wall, turning over. The reasons are all further up the page anyway, in the
 * sections that spend a screen each on them.
 *
 * The board is 4 rows of 22 and word-wraps, so 88 characters is the ceiling and
 * the longest of these is 55. Anything much longer would be silently cut (see
 * the `slice(0, rows)` in FlipBoard) rather than overflowing where you could
 * see it.
 */
const LIMITS = [
  'Deliberately small.',
  'One station.',
  'One DJ.',
  'No endless feed.',
  'No autoplay.',
  'No algorithm deciding what’s next.',
  'No pressure to maximize listening time.',
  'Just people showing up to hear something worth sharing.',
]

/**
 * How long each one stays up.
 *
 * It was 4200ms, which was long enough to read twice when the longest of these
 * was `Around thirty listeners`. They are sentences now and the last is
 * fifty-five characters over three rows of the board, and none of it is legible
 * until the flaps have finished turning, which is itself most of a second. This
 * is long enough to read the longest one twice and the short ones several times,
 * which is the right way round: nobody minds a short line lingering.
 */
const ON_THE_BOARD = 5600

const Limits = memo(function Limits() {
  const section = useRef<HTMLElement>(null)
  const near = useOnScreen(section)
  const [showing, setShowing] = useState(0)

  /*
   * Round the six of them, while the board is somewhere near the window.
   *
   * Parked rather than merely unticked when it is not: `FlipBoard` empties
   * itself when it stops, so a reader who scrolls back finds a blank board that
   * fills in, which is what a board does. The interval is cleared with it, so
   * nothing is running for the other eleven twelfths of the page.
   */
  useEffect(() => {
    if (!near) return
    const round = setInterval(() => setShowing((index) => (index + 1) % LIMITS.length), ON_THE_BOARD)
    return () => clearInterval(round)
  }, [near])

  return (
    <section className="limits" ref={section}>
      <h2 className="limits__title">What it deliberately is not</h2>

      <FlipBoard className="limits__board" text={LIMITS[showing] ?? ''} running={near} />

      {/* The board spells these one letter to a box, which is a way of writing
          that only exists by eye. Here they are as sentences, for anything not
          reading the page by looking at it. */}
      <ul className="limits__spoken">
        {LIMITS.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
    </section>
  )
})

/** The last thing on the page, and the only thing on its screen. */
const Call = memo(function Call() {
  return (
    <section className="call">
      <h2 className="call__headline">Join the room.</h2>

      {/* The evening's records, fanned. See FeyCards. The last thing above the
          button is the thing the button gets you: not a picture of a product, a
          hand of sleeves somebody put on. */}
      <FeyCards sleeves={SLEEVES.map((play) => play.cover)} />

      <a className="button button--large" href={TUNE_IN}>
        Tune in
      </a>
      <p className="call__note">
        The station is on when somebody is running it. If it isn’t, the page will say so. Leave it
        open and it will come back on by itself.
      </p>
    </section>
  )
})

const Foot = memo(function Foot() {
  return (
    <footer className="foot">
      <p className="wordmark">
        chunky<span className="wordmark__tld">.fm</span>
      </p>
      <p className="foot__line">One link. One song. Everyone on the same second.</p>
      <nav className="foot__ways">
        <a className="foot__way" href={TUNE_IN}>
          Tune in
        </a>
        <a className="foot__way" href="#room">
          The room
        </a>
        <a className="foot__way" href="#talks">
          Conversations
        </a>
        <a className="foot__way" href="#dj">
          The DJ
        </a>
        <a className="foot__way" href={DECKS}>
          Run the decks
        </a>
      </nav>
    </footer>
  )
})

