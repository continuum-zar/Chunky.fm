import { useEffect, useState } from 'react'
import { isUpcoming, nextSessionLabel } from '../lib/schedule.js'
import { posterUrl, type ScheduledSession } from '../lib/protocol.js'
import { stationUrl } from '../lib/routes.js'

/**
 * The next session, on the page in front of the station.
 *
 * This is the only thing on the landing page that is *true*. Everything else
 * here is an invented evening: a sample session, nine sleeves the station has
 * never played, a room saying things nobody said. That is deliberate and
 * documented, because the page in front of the station cannot ask the station
 * anything.
 *
 * Except this. A poster is an advertisement, which means the people it is for
 * are exactly the people who have not been let in yet, so `GET /api/schedule`
 * is open where every other read on this API is gated. See `scheduleRoutes` for
 * why that is safe: a time and a picture, and no track, nickname or word
 * anybody said.
 *
 * **It renders nothing when nothing is announced**, and nothing when the ask
 * fails. A landing page whose job is to work on the days the station does not
 * must not grow a section that can break: no station, no error, no empty box,
 * just the page it was before.
 */

/** The one fetch this page makes. Anything other than an answer is silence. */
async function fetchSchedule(signal: AbortSignal): Promise<ScheduledSession | null> {
  try {
    const response = await fetch('/api/schedule', { signal })
    if (!response.ok) return null
    const body = (await response.json()) as { schedule?: ScheduledSession | null }
    return body.schedule ?? null
  } catch {
    return null
  }
}

export function NextSession() {
  const [next, setNext] = useState<ScheduledSession | null>(null)

  useEffect(() => {
    const stop = new AbortController()
    void fetchSchedule(stop.signal).then(setNext)
    return () => stop.abort()
  }, [])

  if (!isUpcoming(next, Date.now())) return null

  const art = posterUrl(next)
  const when = nextSessionLabel(next.startsAt, Date.now())

  return (
    <section className="upcoming" id="next-session">
      <div className="section__head section__head--mid">
        <h2 className="section__title">The next one</h2>
      </div>

      {/* The one image on this page that is carrying information rather than
          decorating: it is the announcement, drawn by whoever is running the
          session, and it is often the only place the theme is written down. An
          empty alt on it told a screen reader there was nothing there. The date
          is repeated from the line below because the poster is what a sighted
          reader reads first, and the alt has to stand where the picture does. */}
      {art && (
        <img className="upcoming__poster" src={art} alt={`Poster for the next session, ${when}`} />
      )}

      <p className="upcoming__when">
        <time dateTime={new Date(next.startsAt).toISOString()}>{when}</time>
      </p>
      {/* Not "tune in now": the station is not on, and a button that opened a
          dark room would be the page overselling. Somebody who presses this is
          deciding to come back, and the listener page will tell them the same
          thing this section just did. */}
      <p className="section__body upcoming__after">
        Nothing is playing yet. The address is the same one it always is.
      </p>
      <a className="button" href={stationUrl()}>
        Take me there
      </a>
    </section>
  )
}
