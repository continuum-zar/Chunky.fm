/**
 * Whether somebody is fit to go on air.
 *
 * The thing worth holding on to about this file is what the second half of the
 * check actually detects. It looks like "is your room quiet", and it is not:
 * the guest's music is still playing while it runs, because they have not come
 * up yet, so a microphone that hears anything is a microphone that can hear the
 * station. On headphones it hears nothing. It is a speaker detector wearing a
 * silence test's clothes, and the ordering that makes it one — check first,
 * duck the music later — is a property of the page rather than of this module.
 *
 * The rest is arithmetic, and it is here because a gate that fails an honest
 * caller is worse than no gate: they cannot argue with it, and the only person
 * it inconveniences is the one who did what they were asked.
 */
import { describe, expect, it } from 'vitest'
import {
  CHECK_START,
  type Check,
  QUIET,
  QUIET_BUDGET_MS,
  QUIET_MS,
  SPEAK_MS,
  SPEAKING,
  checkNotice,
  nextCheck,
} from '../src/lib/sound-check.js'

/** A frame at sixty a second, which is what the meter loop actually delivers. */
const FRAME = 16

/** Feed a level for a stretch of time, a frame at a time. */
function feed(check: Check, level: number, ms: number): Check {
  let state = check
  for (let left = ms; left > 0; left -= FRAME) state = nextCheck(state, level, FRAME)
  return state
}

/** Loud enough to be somebody talking, and quiet enough to be nobody. */
const TALKING = SPEAKING * 2
const SILENT = QUIET / 2

describe('saying something', () => {
  it('waits until it hears anything at all', () => {
    // A microphone muted in hardware is the commonest way this fails, and the
    // one somebody would otherwise discover in front of thirty people.
    const check = feed(CHECK_START, SILENT, 5_000)
    expect(check.stage).toBe('speak')
  })

  it('moves on once they have talked for long enough', () => {
    expect(feed(CHECK_START, TALKING, SPEAK_MS + FRAME).stage).toBe('quiet')
  })

  it('counts speech cumulatively, because speech is mostly gaps', () => {
    let check = CHECK_START
    // "hello" — three bursts with air between them, which demanding four
    // hundred unbroken milliseconds would fail.
    for (let i = 0; i < 3; i++) {
      check = feed(check, TALKING, 160)
      check = feed(check, SILENT, 120)
    }
    expect(check.stage).toBe('quiet')
  })

  it('is not fooled by a room', () => {
    // Between the two thresholds on purpose: a fan, a street, a laptop across
    // the room. The gap between them is wide so this is a decision rather than
    // a coin toss.
    const between = (SPEAKING + QUIET) / 2
    expect(feed(CHECK_START, between, 5_000).stage).toBe('speak')
  })

  it('never gives up on its own', () => {
    // Nothing here times out: the invitation's own countdown is what ends a
    // guest who walked away, and a check that expired underneath it would be a
    // second clock saying something different.
    expect(feed(CHECK_START, SILENT, 60_000).stage).toBe('speak')
  })
})

describe('then not saying anything', () => {
  const spoken = () => feed(CHECK_START, TALKING, SPEAK_MS + FRAME)

  it('passes on a stretch of silence', () => {
    expect(feed(spoken(), SILENT, QUIET_MS + FRAME).stage).toBe('passed')
  })

  it('wants the silence unbroken', () => {
    let check = spoken()
    // Nearly there, twice over, with a noise in between. The question is
    // whether there is a stretch of quiet, and a room that is quiet half the
    // time is a room with something in it.
    check = feed(check, SILENT, QUIET_MS - 200)
    check = feed(check, TALKING, FRAME * 2)
    check = feed(check, SILENT, QUIET_MS - 200)
    expect(check.stage).toBe('quiet')
  })

  it('calls it noisy when the quiet never comes', () => {
    // The failure this whole gate exists for: a laptop playing the station out
    // loud, with an open microphone in front of it.
    const check = feed(spoken(), SPEAKING, QUIET_BUDGET_MS + FRAME)
    expect(check.stage).toBe('noisy')
  })

  it('gives them the whole budget before saying so', () => {
    // A passing car must not cost somebody their turn.
    let check = spoken()
    check = feed(check, TALKING, QUIET_BUDGET_MS - QUIET_MS - 200)
    expect(check.stage).toBe('quiet')
    check = feed(check, SILENT, QUIET_MS + FRAME)
    expect(check.stage).toBe('passed')
  })

  it('starts the budget when the quiet half does, not when the check did', () => {
    // Somebody who took twenty seconds to say hello has not used up their
    // silence allowance doing it.
    let check = feed(CHECK_START, SILENT, 20_000)
    check = feed(check, TALKING, SPEAK_MS + FRAME)
    check = feed(check, SILENT, QUIET_MS + FRAME)
    expect(check.stage).toBe('passed')
  })
})

describe('the ends of it', () => {
  it('stays passed', () => {
    const passed = feed(feed(CHECK_START, TALKING, SPEAK_MS + FRAME), SILENT, QUIET_MS + FRAME)
    expect(passed.stage).toBe('passed')
    // Somebody clearing their throat after passing has not un-passed.
    expect(feed(passed, TALKING, 10_000).stage).toBe('passed')
  })

  it('stays noisy until somebody decides otherwise', () => {
    const noisy = feed(feed(CHECK_START, TALKING, SPEAK_MS + FRAME), SPEAKING, QUIET_BUDGET_MS + FRAME)
    expect(noisy.stage).toBe('noisy')
    // Not rescued by a level that happened to dip. Trying again is a fresh
    // `CHECK_START`, which is a decision a person made.
    expect(feed(noisy, SILENT, 10_000).stage).toBe('noisy')
  })

  it('reads a long frame as the time it really was', () => {
    // A backgrounded tab stops painting, so the next frame is one long
    // interval rather than a lot of missing ones. Counting frames instead of
    // milliseconds would have let a tab in a pocket pass a silence test.
    const check = nextCheck(feed(CHECK_START, TALKING, SPEAK_MS + FRAME), SILENT, 30_000)
    expect(check.stage).toBe('passed')
  })
})

describe('what it tells somebody', () => {
  it('has a sentence for every stage', () => {
    for (const stage of ['speak', 'quiet', 'passed', 'noisy'] as const) {
      expect(checkNotice(stage).length, stage).toBeGreaterThan(0)
    }
  })

  it('offers headphones as the fix, because that is the failure it is for', () => {
    // A guest cannot tell which of the two causes it was, and the fix for the
    // one that matters is the same either way.
    expect(checkNotice('noisy')).toMatch(/headphones/i)
  })
})
