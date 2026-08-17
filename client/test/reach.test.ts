import { describe, expect, it } from 'vitest'
import type { Listener } from '../src/lib/protocol.js'
import {
  HEALTH,
  type PeerHealth,
  type PeerState,
  hearingCount,
  orderByHealth,
} from '../src/lib/reach.js'

/**
 * Who can hear the mic.
 *
 * What this is for is invisible without it. A listener whose peer connection
 * failed hears the music duck and then nothing at all, which from the decks'
 * side looks exactly like a room that is listening — and the person it happened
 * to has no way to say so, and will assume the decks went quiet on purpose.
 *
 * So the ordering is the feature, not the labels: trouble has to be at the top
 * of a list somebody glances at between records.
 */

const room = (...nicknames: string[]): Listener[] =>
  nicknames.map((nickname, index) => ({ id: index + 1, nickname }))

const at = (id: number, state: PeerHealth): PeerState => ({ id, state })

describe('orderByHealth', () => {
  it('puts trouble first and the people who can hear you last', () => {
    const rows = orderByHealth(room('ana', 'ben', 'cleo', 'dan'), [
      at(1, 'connected'),
      at(2, 'unreachable'),
      at(3, 'connecting'),
      at(4, 'failed'),
    ])
    expect(rows.map((row) => row.listener.nickname)).toEqual(['ben', 'dan', 'cleo', 'ana'])
  })

  it('separates giving up from having failed', () => {
    // `failed` on its own reads as permanent when it usually is not: the
    // console retries it. `unreachable` is the one that will not come back
    // without something changing, so it sorts above.
    const rows = orderByHealth(room('ana', 'ben'), [at(1, 'failed'), at(2, 'unreachable')])
    expect(rows[0]!.listener.nickname).toBe('ben')
  })

  it('treats somebody with no connection yet as connecting, not as missing', () => {
    // The roster moves first: a listener is on it the moment they name
    // themselves, a beat before the decks have offered them anything. Reading
    // that gap as a fault would flash every new arrival up as a problem.
    const rows = orderByHealth(room('ana'), [])
    expect(rows).toEqual([{ listener: { id: 1, nickname: 'ana' }, state: 'new' }])
    expect(HEALTH[rows[0]!.state].tone).not.toBe('bad')
  })

  it('lists everybody, not only the broken ones', () => {
    // A count answers "is anything wrong". A list answers "who do I apologise
    // to", and on a station this size both are worth having.
    const rows = orderByHealth(room('ana', 'ben', 'cleo'), [
      at(1, 'connected'),
      at(2, 'connected'),
      at(3, 'connected'),
    ])
    expect(rows).toHaveLength(3)
  })

  it('is stable, so a list nobody is touching does not shuffle while it is read', () => {
    const listeners = room('ana', 'ben', 'cleo')
    const peers = [at(1, 'connected'), at(2, 'connected'), at(3, 'connected')]
    expect(orderByHealth(listeners, peers).map((row) => row.listener.id)).toEqual([1, 2, 3])
    // Same states, peers reported in a different order: the roster's order wins.
    expect(orderByHealth(listeners, [...peers].reverse()).map((row) => row.listener.id)).toEqual([
      1, 2, 3,
    ])
  })

  it('ignores a connection for somebody who is no longer in the room', () => {
    const rows = orderByHealth(room('ana'), [at(1, 'connected'), at(99, 'failed')])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('connected')
  })

  it('has an answer for an empty room', () => {
    expect(orderByHealth([], [])).toEqual([])
  })
})

describe('hearingCount', () => {
  it('counts only the connections that are actually carrying something', () => {
    const rows = orderByHealth(room('ana', 'ben', 'cleo'), [
      at(1, 'connected'),
      at(2, 'connecting'),
      at(3, 'failed'),
    ])
    expect(hearingCount(rows)).toBe(1)
  })

  it('is nobody before anything has connected', () => {
    expect(hearingCount(orderByHealth(room('ana', 'ben'), []))).toBe(0)
  })
})

describe('HEALTH', () => {
  it('has a word for every state a connection can be in', () => {
    const states: PeerHealth[] = [
      'new',
      'connecting',
      'connected',
      'disconnected',
      'failed',
      'closed',
      'retrying',
      'unreachable',
    ]
    for (const state of states) {
      expect(HEALTH[state]?.label, state).toBeTruthy()
    }
  })

  it('reserves the alarming tone for the states worth acting on', () => {
    expect(HEALTH.connected.tone).toBe('good')
    expect(HEALTH.failed.tone).toBe('bad')
    expect(HEALTH.unreachable.tone).toBe('bad')
    // Connecting is not a problem, it is a moment.
    expect(HEALTH.connecting.tone).toBe('wait')
  })
})
