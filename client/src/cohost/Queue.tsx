import { useMemo, useState } from 'react'
import { formatClock } from '../lib/position.js'
import type { QueueEntry, Track } from '../lib/protocol.js'

/**
 * What plays next, on a phone.
 *
 * Two lists in one card, and only ever one of them on screen: what is queued,
 * and what could be. They are a toggle rather than two sections because a phone
 * held in one hand has room for about six rows, and a page where both lists are
 * half-visible is a page where neither can be scanned.
 *
 * **Reordering is buttons, not dragging.** Drag-and-drop is what the console
 * does, and it is right there: a mouse is precise, and a queue on a wide screen
 * has room to show where a row will land. On a phone the same gesture competes
 * with scrolling the list it is inside, and the failure mode is a record moved
 * somewhere nobody meant while trying to look at the one below it. Up and down
 * arrows are duller and they do not lose.
 */
export function Queue({
  entries,
  tracks,
  busy,
  onAdd,
  onRemove,
  onMove,
}: {
  entries: QueueEntry[]
  tracks: Track[]
  busy: boolean
  onAdd(trackId: number): void
  onRemove(entryId: number): void
  onMove(entryId: number, toIndex: number): void
}) {
  const [showing, setShowing] = useState<'queue' | 'library'>('queue')
  const [search, setSearch] = useState('')

  const found = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return tracks
    return tracks.filter(
      (track) =>
        track.title.toLowerCase().includes(needle) ||
        (track.artist ?? '').toLowerCase().includes(needle),
    )
  }, [tracks, search])

  return (
    <section className="upnext" aria-label="What plays next">
      <div className="upnext__tabs" role="group">
        <button
          type="button"
          className={`upnext__tab${showing === 'queue' ? ' upnext__tab--on' : ''}`}
          data-testid="cohost-tab-queue"
          aria-pressed={showing === 'queue'}
          onClick={() => setShowing('queue')}
        >
          Next up{entries.length > 0 ? ` (${entries.length})` : ''}
        </button>
        <button
          type="button"
          className={`upnext__tab${showing === 'library' ? ' upnext__tab--on' : ''}`}
          data-testid="cohost-tab-library"
          aria-pressed={showing === 'library'}
          onClick={() => setShowing('library')}
        >
          Add a record
        </button>
      </div>

      {showing === 'queue' ? (
        entries.length === 0 ? (
          <p className="upnext__empty" data-testid="cohost-queue-empty">
            Nothing queued. When this record ends the station goes quiet, so put
            something behind it.
          </p>
        ) : (
          <ol className="upnext__list" data-testid="cohost-queue">
            {entries.map((entry, index) => (
              <li key={entry.id} className="upnext__row">
                <span className="upnext__pos">{index + 1}</span>
                <span className="upnext__what">
                  <strong>{entry.track.title}</strong>
                  <em>
                    {entry.track.artist ?? 'unknown'} ·{' '}
                    {formatClock(entry.track.durationMs / 1000)}
                  </em>
                </span>
                <span className="upnext__moves">
                  <button
                    type="button"
                    className="upnext__move"
                    aria-label={`Move ${entry.track.title} up`}
                    disabled={busy || index === 0}
                    onClick={() => onMove(entry.id, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="upnext__move"
                    aria-label={`Move ${entry.track.title} down`}
                    disabled={busy || index === entries.length - 1}
                    onClick={() => onMove(entry.id, index + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="upnext__move upnext__move--drop"
                    aria-label={`Take ${entry.track.title} out`}
                    disabled={busy}
                    onClick={() => onRemove(entry.id)}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )
      ) : (
        <>
          <input
            type="search"
            className="upnext__search"
            data-testid="cohost-search"
            value={search}
            placeholder="Search the library"
            onChange={(event) => setSearch(event.target.value)}
          />
          {found.length === 0 ? (
            <p className="upnext__empty">
              {tracks.length === 0
                ? 'The library is empty. Records are uploaded at the decks.'
                : 'Nothing matches that.'}
            </p>
          ) : (
            <ul className="upnext__list" data-testid="cohost-library">
              {found.map((track) => (
                <li key={track.id} className="upnext__row">
                  <span className="upnext__what">
                    <strong>{track.title}</strong>
                    <em>
                      {track.artist ?? 'unknown'} · {formatClock(track.durationMs / 1000)}
                    </em>
                  </span>
                  <button
                    type="button"
                    className="upnext__add"
                    data-testid={`cohost-add-${track.id}`}
                    disabled={busy}
                    onClick={() => onAdd(track.id)}
                  >
                    Queue
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
