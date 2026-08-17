/**
 * Saying when the station is next on.
 *
 * The same instant means a different sentence depending on when it is read, so
 * every case here fixes both numbers. Times are built with the `Date`
 * constructor rather than as literals, which keeps the suite honest in whatever
 * timezone it runs in: what is being tested is which *evening* the page names,
 * and that is a local question.
 */
import { describe, expect, it } from 'vitest'
import {
  fromLocalInput,
  isUpcoming,
  nextSessionLabel,
  nextSessionShort,
  toLocalInput,
} from '../src/lib/schedule.js'

/** A Wednesday, 18:00 local. */
const NOW = new Date(2024, 0, 10, 18, 0).getTime()
const at = (day: number, hour: number, minute = 0) =>
  new Date(2024, 0, day, hour, minute).getTime()

const HOUR = 3600_000

describe('nextSessionLabel', () => {
  it('names the evening rather than counting down to it', () => {
    // Not "in 3 hours": a station is an evening somebody decides to spend, and
    // a countdown would also be wrong the moment the admin ran late.
    expect(nextSessionLabel(at(10, 21), NOW, 'en-GB')).toBe('Tonight at 21:00')
    expect(nextSessionLabel(at(11, 21), NOW, 'en-GB')).toBe('Tomorrow at 21:00')
  })

  it('uses the weekday inside the week, and the date beyond it', () => {
    expect(nextSessionLabel(at(13, 21), NOW, 'en-GB')).toBe('Saturday at 21:00')
    expect(nextSessionLabel(at(20, 21), NOW, 'en-GB')).toBe('20 January at 21:00')
  })

  it('stops naming a time once it is nearly here', () => {
    expect(nextSessionLabel(at(10, 18, 10), NOW, 'en-GB')).toBe('Starting soon')
  })

  it('still says soon after the hour has passed, because stations run late', () => {
    expect(nextSessionLabel(at(10, 17), NOW, 'en-GB')).toBe('Starting soon')
  })

  it('reads tonight for a time later the same evening, whatever the gap', () => {
    // Just past the "soon" window, so it is still named rather than hurried.
    expect(nextSessionLabel(at(10, 23, 59), NOW, 'en-GB')).toBe('Tonight at 23:59')
  })
})

describe('nextSessionShort', () => {
  it('fits the top bar, which has one line and no room for a sentence', () => {
    expect(nextSessionShort(at(10, 21), NOW, 'en-GB')).toBe('21:00')
    expect(nextSessionShort(at(11, 21), NOW, 'en-GB')).toBe('tomorrow 21:00')
    expect(nextSessionShort(at(13, 21), NOW, 'en-GB')).toBe('Sat 21:00')
    expect(nextSessionShort(at(10, 18, 5), NOW, 'en-GB')).toBe('soon')
  })
})

describe('isUpcoming', () => {
  const announced = (startsAt: number) =>
    ({ startsAt, poster: null, kind: 'set', title: null }) as const

  it('is nothing at all when nothing is announced', () => {
    expect(isUpcoming(null, NOW)).toBe(false)
  })

  it('holds through a late start, because that is the ordinary case', () => {
    expect(isUpcoming(announced(NOW - 2 * HOUR), NOW)).toBe(true)
  })

  it('lets go once the night it named is plainly over', () => {
    // An admin who announced a Saturday and never took it down should not have
    // the page still promising it on Tuesday.
    expect(isUpcoming(announced(NOW - 7 * HOUR), NOW)).toBe(false)
  })
})

describe('the admin field, in both directions', () => {
  it('round-trips an instant through the spelling the input understands', () => {
    const chosen = at(13, 21, 30)
    expect(toLocalInput(chosen)).toBe('2024-01-13T21:30')
    expect(fromLocalInput(toLocalInput(chosen))).toBe(chosen)
  })

  it('is null for a field that is empty or half-typed', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('2024-01-')).toBeNull()
  })
})
