import bellIcon from './assets/icons/bell.svg'
import broadcastSmallIcon from './assets/icons/broadcast-sm.svg'
import micStageIcon from './assets/icons/microphone-stage.svg'
import slidersSmallIcon from './assets/icons/sliders-sm.svg'
import usersIcon from './assets/icons/users.svg'
import type { Standing } from './lib/availability.js'
import { statusLabel } from './lib/availability.js'
import { kindLabel } from './lib/kind.js'
import type { SessionKind } from './lib/protocol.js'

export interface TopbarProps {
  /** What the page can see of the station. See lib/availability.ts. */
  reach: Standing
  /**
   * What kind of night is on, or null when there is none on.
   *
   * Drawn only for a conversation, which looks like favouritism and is the
   * design: a set is what this station is when nobody says otherwise, so a
   * badge saying so on every ordinary evening would be a permanent label
   * carrying no information. The one that changes what you are looking at is
   * the one worth a mark, and it is carried from every view because somebody
   * who wandered to `#chat` mid-conversation should not have to go back to the
   * deck to find out why nothing is playing.
   */
  kind: SessionKind | null
  /** Null before the first roster frame: a count nobody has sent is not zero. */
  listeners: number | null
  /** True on the decks, which is what the segmented control is switching. */
  admin: boolean
  /**
   * When the station is next on, short enough for one line, or null.
   *
   * Only ever passed while the station is off air: on air it would be a page
   * advertising next Saturday over tonight. See where it is built in App.
   */
  nextSession: string | null
  /**
   * Whether this browser is already signed in to the console.
   *
   * The way in is shown only to somebody who has been through it. That is not
   * a lock (every route that does anything is gated on the server, and typing
   * the address still reaches the sign-in form) but the page declining to
   * advertise a door to the hundred per cent of visitors it would refuse.
   */
  showConsole: boolean
}

/**
 * The bar across the top: who this is, who else is here, and whether there is
 * a station on the other end.
 *
 * There is no search field, on either side of the station. The listener page
 * carried one over the queue, the evening, the wishes and the room, four short
 * lists already on the screen, and the console carried the same one over its
 * library. Neither was narrowing a haystack: a station is one evening's worth
 * of records, and a field that saves you a dozen rows of scrolling is not worth
 * the width it takes across the top of a phone. What is on the page is the
 * whole of what there is, so the page just shows it.
 */
export function Topbar({ reach, kind, listeners, admin, nextSession, showConsole }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        {/* Still the page's heading, and a link, because the wordmark is what
            everyone tries first to get back to the deck. */}
        <h1 className="wordmark">
          <a href="#" aria-label="chunky.fm, on air">
            chunky<span className="wordmark__tld">.fm</span>
          </a>
        </h1>
      </div>

      <div className="topbar__right">
        {/* Two links rather than a toggle with state of its own: which side you
            are on is the address, and the address is the only thing that
            decides what renders. */}
        {showConsole && (
        <div className="segmented" role="group" aria-label="Which side of the station">
          <a
            className={`segmented__side${admin ? '' : ' segmented__side--on'}`}
            href="#"
            aria-current={admin ? undefined : 'page'}
          >
            <img src={broadcastSmallIcon} alt="" width={14} height={14} />
            Listener
          </a>
          <a
            className={`segmented__side${admin ? ' segmented__side--on' : ''}`}
            href="#admin"
            aria-current={admin ? 'page' : undefined}
          >
            <img src={slidersSmallIcon} alt="" width={14} height={14} />
            Admin
          </a>
        </div>
        )}

        {/* What kind of night this is, when it is the kind worth saying. See
            the prop: a set says nothing, because a set is what the station is
            by default and a label on every ordinary evening is furniture. */}
        {kind === 'talk' && (
          <p className="airkind" data-testid="air-kind">
            <img src={micStageIcon} alt="" width={14} height={14} />
            <span className="airkind__word">{kindLabel(kind)}</span>
          </p>
        )}

        {/* Off air only, and quiet. The off-air screen says this properly,
            with the poster and a whole sentence; this is the same fact carried
            from every other view, so somebody who wandered to #history does not
            have to go back to the deck to find out when to return. */}
        {nextSession && (
          <p className="nextline" data-testid="next-line">
            <span className="nextline__label">next</span>
            <span className="nextline__when">{nextSession}</span>
          </p>
        )}

        <p className="headcount">
          <img src={usersIcon} alt="" width={16} height={16} />
          <span className="headcount__number" data-testid="listener-count">
            {listeners === null ? '—' : listeners.toLocaleString()}
          </span>
          <span className="headcount__word">listening</span>
        </p>

        {/* Not a notification tray: there are no notifications. The bell is
            where the design puts the one thing that is worth an alert on this
            page, which is whether there is a station on the other end at all. */}
        <p
          className={`signal status status--${reach}`}
          title={statusLabel(reach)}
          aria-label={statusLabel(reach)}
          role="status"
        >
          <img src={bellIcon} alt="" width={18} height={18} />
          <span className="signal__dot" aria-hidden="true" />
          <span className="signal__label">{statusLabel(reach)}</span>
        </p>
      </div>
    </header>
  )
}
