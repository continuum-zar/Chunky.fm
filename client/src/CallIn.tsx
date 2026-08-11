import { useEffect, useState } from 'react'
import type { GuestVoice } from './hooks/useGuestVoice.js'
import { secondsLeft } from './lib/hand.js'
import type { StationConnection } from './lib/station.js'
import { checkNotice } from './lib/sound-check.js'

/**
 * Being asked up, getting ready, and being up.
 *
 * Above every view at every width, which is the whole point of it. An
 * invitation is time-limited and an open microphone is the one thing on this
 * page somebody must never have to go looking for: a notice tucked inside a
 * panel behind a route is a microphone somebody forgot was open.
 *
 * Rendered always, and drawing nothing most of the time, which looks wasteful
 * and is load bearing. This is where the microphone is handed back when a call
 * ends, and a component that the page stopped rendering at that moment would be
 * unmounted before it could notice — leaving a caller who has come down with an
 * open capture, a recording light and a browser that thinks they are still on
 * a station they left.
 *
 * It is also the only place either of those can be acted on. The panel beside
 * the wishes shows the same states and offers no buttons, because two controls
 * that can accept or come down are two controls that can disagree with each
 * other, with a live microphone as the thing they disagree about.
 *
 * The order here is the argument. Somebody who has been asked up cannot reach
 * *go up* until the sound check has passed, and the sound check runs while the
 * station is still playing on their machine — which is what makes it a speaker
 * detector rather than a formality. See `lib/sound-check.ts`.
 */

export interface CallInProps {
  connection: StationConnection | null
  /**
   * This listener's microphone. Held by the page rather than by this panel,
   * because the talk channel needs the track before there is anything on
   * screen to draw. See `App`.
   */
  guest: GuestVoice
  /** Whether the voice is actually reaching the decks, not merely open. */
  heard: boolean
  invited: boolean
  speaking: boolean
  /** Station epoch ms the invitation lapses at, or null when there is none. */
  expiresAt: number | null
  /**
   * The station's clock.
   *
   * `expiresAt` is a point on it, so subtracting this browser's `Date.now()`
   * would put the countdown wherever the two machines happen to disagree — and
   * on a page whose clock is a minute out, would offer a button that had
   * already stopped working, or take one away that had not.
   */
  serverNow(): number
}

export function CallIn({
  connection,
  guest,
  heard,
  invited,
  speaking,
  expiresAt,
  serverNow,
}: CallInProps) {
  const [now, setNow] = useState(() => serverNow())
  const { begin, end } = guest
  // Destructured, and that is not tidiness. `guest.input` is a fresh object on
  // every render, so an effect that depended on it would run on every render —
  // and the one below would put `talking` back to whatever `speaking` says a
  // frame after somebody pressed mute, which is a mute button that does not
  // mute. `setTalking` is a `useState` setter and is stable.
  const { setTalking } = guest.input

  // Only while there is something counting down. A timer left running behind an
  // open microphone would be a render a second for the rest of the call.
  useEffect(() => {
    if (expiresAt === null) return
    setNow(serverNow())
    const tick = window.setInterval(() => setNow(serverNow()), 500)
    return () => window.clearInterval(tick)
  }, [expiresAt, serverNow])

  // The microphone goes back the moment this page is neither being asked nor
  // talking — an invitation that lapsed, a decks that changed their mind, a
  // broadcast that ended. Nobody should be left holding an open microphone and
  // a recording light because a station moved on without them.
  useEffect(() => {
    if (!invited && !speaking) end()
  }, [invited, speaking, end])

  // Open on the way up and shut on the way down, and untouched in between:
  // what happens while somebody is up is the mute button's business, and an
  // effect that kept asserting an answer would be arguing with them.
  useEffect(() => {
    setTalking(speaking)
  }, [speaking, setTalking])

  const send = (action: 'accept' | 'lower') => connection?.send({ type: 'hand', action })
  const left = expiresAt === null ? 0 : secondsLeft(expiresAt, now)

  if (speaking) {
    return (
      <div className="outage called called--up" data-testid="on-the-mic" role="status">
        <p className="outage__headline">You're on the mic.</p>
        <p className="outage__detail" data-testid="on-the-mic-detail">
          {heard
            ? 'The room can hear you. The music has come down for it, and yours has gone quiet so it cannot get back into your microphone.'
            : 'The music has come down for you across the room. Your microphone is on its way to the decks.'}
        </p>

        <Meter guest={guest} />

        <div className="called__actions">
          <button
            type="button"
            className="button"
            data-testid="guest-mute"
            aria-pressed={!guest.input.talking}
            onClick={() => guest.input.setTalking(!guest.input.talking)}
          >
            {guest.input.talking ? 'Mute' : 'Unmute'}
          </button>
          <button
            type="button"
            className="button button--quiet"
            data-testid="come-down"
            onClick={() => send('lower')}
          >
            Come down
          </button>
        </div>
      </div>
    )
  }

  if (!invited) return null

  const status = guest.input.status

  return (
    <div className="outage called" data-testid="called-up" role="status">
      <p className="outage__headline">The decks have asked you up.</p>
      <p className="outage__detail">
        {left > 0
          ? `The offer is open for another ${left} second${left === 1 ? '' : 's'}.`
          : 'The offer has run out.'}
      </p>

      {status === 'idle' ? (
        // Headphones first, and before the microphone is asked for rather than
        // after: the check below is largely a test of whether this sentence was
        // read, and somebody who reads it afterwards has already failed it.
        <p className="called__hint">
          Put headphones on. The station is playing where you are, and an open
          microphone next to a speaker sends the room a copy of the record it is
          already playing.
        </p>
      ) : status === 'asking' ? (
        <p className="called__hint">Your browser is asking about the microphone…</p>
      ) : status === 'live' ? (
        <>
          <p className="called__hint" data-testid="check-notice">
            {checkNotice(guest.stage)}
          </p>
          <Meter guest={guest} />
        </>
      ) : (
        <p className="called__hint" data-testid="mic-refused">
          {guest.input.error ?? 'the microphone did not open'}
        </p>
      )}

      <div className="called__actions">
        {guest.ready ? (
          <button
            type="button"
            className="button"
            data-testid="go-up"
            onClick={() => send('accept')}
            disabled={left === 0}
          >
            Go up
          </button>
        ) : (
          <button
            type="button"
            className="button"
            data-testid="sound-check"
            onClick={begin}
            disabled={left === 0 || status === 'asking'}
          >
            {status === 'idle' ? 'Sound check' : 'Start again'}
          </button>
        )}
        <button
          type="button"
          className="button button--quiet"
          data-testid="not-now"
          onClick={() => send('lower')}
        >
          Not now
        </button>
      </div>
    </div>
  )
}

/**
 * The guest's own level, and larger than the console's.
 *
 * The console has one because the only other way to know you are live is to
 * hear yourself, and hearing yourself is the thing causing the feedback. A
 * guest needs it more: they have no lamp, no reach list and no second screen,
 * and this is the only evidence they have that anything is happening at all.
 */
function Meter({ guest }: { guest: GuestVoice }) {
  return (
    <div className="called__meter" data-testid="guest-meter" role="presentation">
      <div className="called__meter-fill" ref={guest.input.meterRef} data-clip="false" />
    </div>
  )
}
