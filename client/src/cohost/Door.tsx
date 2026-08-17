import { type FormEvent, useState } from 'react'
import type { CoHostApi } from '../lib/cohost.js'
import { refusalMessage } from '../lib/cohost.js'

/**
 * The door, for somebody who arrived without a working link.
 *
 * Usually one of two people. A co-host whose seat lapsed — a week, which is
 * long enough that this is a thing that happens on the first evening back — or
 * somebody who was read the code down a phone rather than sent a link, which is
 * how half of everything actually gets shared.
 *
 * A field rather than a dead end, for that second person, and the same choice
 * the station's refused screen makes. What it deliberately does not do is
 * explain what the code looks like or where to get one: this is not a page
 * anybody should arrive at by wandering, and a door that coached a stranger
 * would be a worse door.
 */
export function Door({ api, onIn }: { api: CoHostApi; onIn(): void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const candidate = key.trim()
    if (candidate === '') return
    setBusy(true)
    setError(null)
    try {
      if (await api.redeem(candidate)) {
        onIn()
        return
      }
      setError('that is not a co-host code for this station')
    } catch (err) {
      // The station's own sentence when it wrote one — the throttle says "wait
      // a minute and try again", which is a thing somebody can act on.
      setError(refusalMessage(err) ?? 'could not reach the station')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="seat seat--door">
      <h1 className="seat__title">Co-host</h1>
      <p className="seat__blurb">
        This seat is opened with a link from whoever runs the decks. If you were
        given a code instead, it goes here.
      </p>

      <form className="seat__form" onSubmit={(event) => void submit(event)}>
        <label className="seat__field">
          <span>Code</span>
          <input
            type="password"
            data-testid="cohost-key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <button
          type="submit"
          className="seat__sit"
          data-testid="cohost-redeem"
          disabled={busy || key.trim() === ''}
        >
          {busy ? 'Checking…' : 'Open the seat'}
        </button>
      </form>

      {error && (
        <p className="seat__error" data-testid="cohost-door-error" role="status">
          {error}
        </p>
      )}
    </main>
  )
}
