import onAirIcon from './assets/icons/on-air.svg'
import volumeIcon from './assets/icons/volume.svg'

/**
 * The deck.
 *
 * A record that turns while the station is playing and stops when it is not,
 * which is the whole point of drawing one. Everything on it is the station's:
 * the label in the middle is the track's own artwork, the clock under the title
 * is where this listener actually is in the song, and the platter stops the
 * moment the decks pause. Nothing here animates on its own to look busy.
 */

/**
 * The bars, at the heights the design draws them. Fixed rather than sampled:
 * there is no analyser on this audio element, and a waveform invented from a
 * random number would be a lie about the sound. What it does say truthfully is
 * whether anything is coming out at all: it moves while the station plays and
 * lies flat when it doesn't.
 */
const BARS = [
  8, 14, 20, 12, 26, 18, 30, 22, 16, 28, 12, 20, 24, 14, 30, 18, 10, 22, 16, 26, 14, 20, 12, 28,
  18, 24, 10, 16, 22, 14,
]

export interface DeckProps {
  /** The record's label, or null for a deck with nothing on it. */
  artwork: string | null
  /** True while the audio is actually running; the platter turns on this. */
  spinning: boolean
}

/** The platter, the record and the arm. Nothing here reads any other state. */
export function Deck({ artwork, spinning }: DeckProps) {
  return (
    <div className="deck" data-spinning={spinning}>
      <div className="deck__well">
        <div className="deck__platter">
          <div className="deck__record">
            {artwork ? (
              <img className="deck__label" src={artwork} alt="" />
            ) : (
              <div className="deck__label deck__label--blank" aria-hidden="true" />
            )}
          </div>
          {/*
            The light on the record, and the one part of it that must not turn.
            A highlight painted onto the disc would rotate with the grooves and
            read as a mark *on* the vinyl; a real one stays where the lamp is
            while the record goes round underneath. So it is a sibling of the
            platter rather than a child of the record, which is the whole reason the two
            are separate elements.
          */}
          <div className="deck__sheen" aria-hidden="true" />
          {/* Through the label, so it sits above everything and never spins. */}
          <div className="deck__spindle" aria-hidden="true" />
        </div>
        <Tonearm />
      </div>
    </div>
  )
}

/**
 * The arm.
 *
 * Drawn rather than assembled out of rotated rectangles, because the shape is
 * the point: a counterweight behind the pivot, a tube, and a headshell canted
 * off the tube's line the way a real one is. Those angles are what make it read
 * as a tonearm instead of a stick lying across a circle.
 *
 * It lifts when the decks stop. The rotation is about the pivot, set by `transform-box:
 * view-box` in the stylesheet, so the origin is in the same coordinates these
 * points are written in and survives the whole thing being scaled down on a
 * phone.
 */
function Tonearm() {
  return (
    <svg
      className="deck__tonearm"
      viewBox="0 0 300 300"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="deck__tonearm-swing">
        {/*
          The counterweight: a cylinder on the axis of the tube, behind the
          pivot. Drawn as a rounded rect turned to the arm's angle rather than a
          circle, because a circle beside the round pivot read as two identical donuts
          stacked in the corner, which is what the first attempt looked like.
        */}
        <g transform="rotate(110 284 52)">
          <rect x="270" y="44" width="28" height="16" rx="7" fill="#1c1c1c" stroke="currentColor" strokeWidth="1.8" />
          <line x1="279" y1="45" x2="279" y2="59" stroke="currentColor" strokeWidth="1" opacity="0.45" />
        </g>

        {/*
          The tube, as the gentle S a real arm has. A straight line from pivot to
          stylus is geometrically honest and looks like a stick; the curve is the
          single thing that makes the shape read as a tonearm.

          It runs from the counterweight's centre at (284,52), through the
          pivot, so the weight is carried by the tube rather than floating beside
          it, down to a stylus at (210,202). That end is 79px from the record's
          centre: out on the grooves, between the label at 44 and the rim at 123.

          Three strokes: a dark casing, the metal, and a highlight down one side,
          so the tube has a lit edge instead of being a flat bar.
        */}
        <path d="M284 52 C 264 112, 250 152, 210 202" stroke="#0a0a0a" strokeWidth="7" strokeLinecap="round" />
        <path d="M284 52 C 264 112, 250 152, 210 202" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
        <path
          d="M283 56 C 264 113, 251 152, 212 199"
          stroke="#c8c8c8"
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.45"
        />

        {/* Headshell, canted off the tube the way a real one is, with the stylus
            under its front corner and touching the record. */}
        <g transform="rotate(-38 210 202)">
          <rect x="198" y="196" width="26" height="12" rx="3.5" fill="#1c1c1c" stroke="currentColor" strokeWidth="1.5" />
          <path d="M203 208 L201 214" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      </g>

      {/* The pivot stays put while the arm swings around it, so it is outside
          the rotating group. Sat outside the platter, as a real one is. */}
      <circle cx="270" cy="78" r="12" fill="#2b2b2b" stroke="#454545" strokeWidth="1.5" />
      <circle cx="270" cy="78" r="4" fill="#0a0a0a" />
    </svg>
  )
}

export interface OnAirProps {
  /** False when the decks are paused, or when there is nothing on them. */
  live: boolean
  /** What the badge says instead of LIVE when the station isn't playing. */
  idleLabel: string
  /**
   * Whether somebody is talking over the music right now.
   *
   * Worth saying out loud rather than leaving the listener to infer it from the
   * music having gone quiet, which is the other thing a duck could be: a track
   * that was mastered low, a page that broke, a connection thinning out. The
   * badge is where it goes because the badge is already the answer to "what is
   * this sound", and during a break the answer changes.
   */
  talking?: boolean
  /**
   * Whose voice it is, when it is not the decks'.
   *
   * The badge already answers "what is this sound", and during a call-in the
   * honest answer has a name in it. Null the rest of the time, including while
   * whoever runs the decks is talking: they are the station, and naming them
   * would be the station introducing itself every time it opened its mouth.
   */
  speaker?: string | null
}

/** The LIVE badge and the line beside it. */
export function OnAir({ live, idleLabel, talking = false, speaker = null }: OnAirProps) {
  return (
    <div className="onair">
      <span className={`onair__badge${live ? '' : ' onair__badge--off'}`}>
        <span className="onair__dot" aria-hidden="true" />
        {live ? 'LIVE' : idleLabel}
      </span>
      {/* `status`, so a listener who cannot see the badge is told a break has
          started rather than sitting through unexplained quiet music. */}
      <span
        className={`onair__where${talking ? ' onair__where--mic' : ''}`}
        data-testid="on-mic"
        role="status"
      >
        <img src={onAirIcon} alt="" width={14} height={14} />
        {talking ? (speaker ? `${speaker} is on the mic` : 'On the mic') : live ? 'On air now' : 'Off air'}
      </span>
    </div>
  )
}

export interface WaveformProps {
  /** Bars move while this is true and lie flat while it is false. */
  live: boolean
}

/** The level meter beside the LIVE mark. */
export function Waveform({ live }: WaveformProps) {
  return (
    <div className="levels" data-live={live}>
      <span className={`levels__mark${live ? '' : ' levels__mark--off'}`}>
        ● {live ? 'LIVE' : 'IDLE'}
      </span>
      <div className="levels__bars" aria-hidden="true">
        {BARS.map((height, index) => (
          <span
            // Position is the identity here: these are 30 fixed slots in a
            // meter, not a list of anything that can be reordered.
            key={index}
            className="levels__bar"
            style={{ height: `${height}px`, animationDelay: `${(index % 10) * 90}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

export interface MuteProps {
  muted: boolean
  onToggle(): void
  /** False while there is nothing to mute: no track, or not tuned in. */
  enabled: boolean
}

/** The round button under the deck, and the line that says what it does. */
export function Mute({ muted, onToggle, enabled }: MuteProps) {
  return (
    <div className="mute">
      <button
        type="button"
        className={`mute__button${muted ? ' mute__button--off' : ''}`}
        data-testid="mute"
        onClick={onToggle}
        disabled={!enabled}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        <img src={volumeIcon} alt="" width={20} height={20} />
      </button>
      <span className="mute__hint">
        {!enabled
          ? 'Nothing to hear yet'
          : muted
            ? 'Muted here, the station plays on'
            : 'Streaming live, tap to mute'}
      </span>
    </div>
  )
}
