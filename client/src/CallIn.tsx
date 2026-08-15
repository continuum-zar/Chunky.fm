import { useEffect, useRef, useState } from 'react'
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
  /**
   * How this listener's microphone is getting to the decks, or null when it is
   * not going anywhere.
   *
   * The whole state rather than a boolean, because "not yet" and "not at all"
   * are different things to say to somebody who is on air in front of a room
   * that has gone quiet for them. Getting that wrong means telling a caller
   * their voice is on its way while it is not, and the only thing they can do
   * about it is wait.
   */
  talking: RTCPeerConnectionState | null
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
  talking,
  invited,
  speaking,
  expiresAt,
  serverNow,
}: CallInProps) {
  const [now, setNow] = useState(() => serverNow())
  /**
   * Whether this page was on the mic a moment ago.
   *
   * A call can end without the person on it doing anything: the decks stand
   * them down, the broadcast finishes, or their own socket drops and comes back
   * as a new listener — the capability was granted to a socket, and a reconnect
   * is a different one. All three look identical from here, which is a banner
   * disappearing mid-sentence, and somebody left wondering whether they are
   * still being heard is worse off than somebody who has been told.
   */
  const [ended, setEnded] = useState(false)
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

  // On the *transition* out of being up, not on being down. This component is
  // rendered by every listener all evening, and almost none of them have ever
  // been on the mic: keyed on the state rather than the change, it would open
  // by telling the whole room a turn they never had was over.
  const was = useRef(speaking)
  useEffect(() => {
    const leaving = was.current && !speaking
    was.current = speaking
    if (speaking) {
      setEnded(false)
      return
    }
    if (!leaving) return
    setEnded(true)
    const clear = window.setTimeout(() => setEnded(false), ENDED_MS)
    return () => window.clearTimeout(clear)
  }, [speaking])

  const send = (action: 'accept' | 'lower') => connection?.send({ type: 'hand', action })
  const left = expiresAt === null ? 0 : secondsLeft(expiresAt, now)

  if (speaking) {
    return (
      <div className="called called--up" data-testid="on-the-mic" role="status">
        <div className="called__head">
          <span className="called__lamp called__lamp--live">on the mic</span>
          <p className="called__headline">You're on the mic.</p>
        </div>

        <p className="called__detail" data-testid="on-the-mic-detail">
          {reaching(talking)}
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

  // Behind the invitation, not in front of it. Somebody stood down and asked
  // back up inside the same few seconds — which is exactly what happens when a
  // connection failed and the decks tried again — must be shown the offer
  // rather than an explanation of the turn they are being given another go at.
  if (ended && !invited) {
    return (
      <div className="called" data-testid="turn-over" role="status">
        <div className="called__head">
          <span className="called__lamp">off the mic</span>
          <p className="called__headline">You're off the mic.</p>
        </div>
        <p className="called__detail">
          The music is back. Put your hand up again if there is more to say.
        </p>
      </div>
    )
  }

  if (!invited) return null

  const status = guest.input.status

  return (
    <div className="called" data-testid="called-up" role="status">
      {/* The headline and the clock on one line, and the clock is the reason
          this row exists: what is being offered runs out, and a countdown
          buried at the end of a sentence is a countdown nobody reads. It is
          tabular so the digits do not shuffle the headline sideways once a
          second. */}
      <div className="called__head">
        <span className="called__lamp">asked up</span>
        <p className="called__headline">The decks have asked you up.</p>
        <span className={`called__left${left === 0 ? ' called__left--gone' : ''}`}>
          {left > 0 ? `${left}s left` : 'run out'}
        </span>
      </div>

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

/** How long "you're off the mic" stays up. Long enough to be read once. */
const ENDED_MS = 8_000

/**
 * What to tell somebody who is on air about whether they are being heard.
 *
 * The honest version of a boolean. Somebody whose own music has gone silent,
 * who can hear nothing of themselves by design, and whose meter only proves
 * their microphone works has no other evidence at all — so this is the only
 * thing on the page that answers the question they are actually asking.
 */
function reaching(state: RTCPeerConnectionState | null): string {
  if (state === 'connected') {
    return 'The room can hear you. The music has come down for it, and yours has gone quiet so it cannot get back into your microphone.'
  }
  if (state === 'failed' || state === 'closed') {
    // Said plainly rather than left as an optimistic "on its way". They cannot
    // fix it and should not keep talking into it; whoever runs the decks can
    // see the same thing from the other end.
    return 'Your voice is not getting through. Whoever runs the decks can see that too.'
  }
  return 'The music has come down for you across the room. Your microphone is on its way to the decks.'
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
