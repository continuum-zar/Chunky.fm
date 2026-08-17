import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { hasAdminCredentials, mayListen } from '../src/lib/auth.js'

describe('loadConfig', () => {
  it('comes up with an admin password of its own when none is set', () => {
    // This used to throw. It now falls back to the house key, which is the one
    // thing an unconfigured station guards: listening is open, driving is not.
    expect(loadConfig({}).adminPassword).toBeTruthy()
  })

  it('takes the admin password it is given', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'chosen' }).adminPassword).toBe('chosen')
  })

  it('ignores an admin password that is only whitespace', () => {
    expect(loadConfig({ ADMIN_PASSWORD: '  ' }).adminPassword).toBe(loadConfig({}).adminPassword)
  })

  it('derives every storage path from AUDIO_STORAGE_DIR', () => {
    const config = loadConfig({ ADMIN_PASSWORD: 'x', AUDIO_STORAGE_DIR: '/srv/media' })

    expect(config.storageDir).toBe('/srv/media')
    expect(config.audioDir).toBe(path.join('/srv/media', 'audio'))
    expect(config.artworkDir).toBe(path.join('/srv/media', 'artwork'))
    expect(config.tmpDir).toBe(path.join('/srv/media', 'tmp'))
    expect(config.dbPath).toBe(path.join('/srv/media', 'chunky.sqlite'))
  })

  it('rejects a nonsense PORT rather than silently defaulting', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'x', PORT: 'eighty' })).toThrow(/PORT/)
  })
})

/**
 * The door.
 *
 * Deliberately no literal in here. The house key is written backwards and in
 * base64 in `config.ts` precisely so it is not sitting in plain text anywhere,
 * and a test that spelled it out would put it back, in a file that gets read
 * far more often than the one it was hidden in. So these pin the *behaviour*:
 * that there is a door, that you can change its lock, and that you have to say
 * so out loud to take the door off.
 */
describe('the station door', () => {
  it('is not there unless somebody puts one on', () => {
    // The default has been both ways round; this is the one that matters to a
    // listener. Nobody is asked for anything on the way in.
    expect(loadConfig({}).stationKey).toBeNull()
  })

  it('goes on when a key is set, with the whole mechanism intact behind it', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'x', STATION_KEY: 'mine' }).stationKey).toBe('mine')
  })

  it('stays off for a STATION_KEY that is only whitespace', () => {
    // Which is what a variable set to nothing in a compose file looks like, and
    // a door whose code is the empty string is not a door.
    expect(loadConfig({ ADMIN_PASSWORD: 'x', STATION_KEY: '   ' }).stationKey).toBeNull()
  })

  it('still takes STATION_OPEN without complaining, though it now says nothing', () => {
    // It is what taking the door off used to need. A compose file that has been
    // carrying it for months should not start failing to mean what it meant.
    for (const value of ['true', '', ' ', 'yes', 'false']) {
      expect(
        loadConfig({ ADMIN_PASSWORD: 'x', STATION_OPEN: value }).stationKey,
        JSON.stringify(value),
      ).toBeNull()
    }
  })

  it('admits a stranger, and still refuses that same stranger the decks', () => {
    // The composition, which is the property this default is actually about:
    // a real config, a caller with no cookie and no key, and the two answers
    // that have to differ. Opening the station means anybody can listen; it has
    // never meant anybody can play anything.
    const config = loadConfig({})
    expect(mayListen(config, {})).toBe(true)
    expect(hasAdminCredentials(config, {})).toBe(false)

    // And the door goes back on for a station that asks for one.
    expect(mayListen(loadConfig({ STATION_KEY: 'sesame' }), {})).toBe(false)
  })

  it('lets an explicit key win over an explicit opening, if both are set', () => {
    // Contradictory configuration, resolved towards the shut door: the mistake
    // you hear about from a friend who cannot get in, rather than from a
    // stranger who could.
    expect(
      loadConfig({ ADMIN_PASSWORD: 'x', STATION_KEY: 'mine', STATION_OPEN: 'true' }).stationKey,
    ).toBe('mine')
  })
})

/**
 * The decks, which the door coming off did not touch.
 *
 * Opening the station means anybody can listen. It has never meant anybody can
 * upload, drive the decks or end the broadcast, and the whole point of keeping
 * these two as separate settings is that moving one leaves the other alone.
 */
describe('the admin password', () => {
  it('is there out of the box, even on a station with no door', () => {
    const config = loadConfig({})
    expect(config.adminPassword).not.toBe('')
    // The listening side is open and the decks are not. That is the shape.
    expect(config.stationKey).toBeNull()
  })

  it('is the same one every time, so a restart does not sign everyone out', () => {
    // The admin cookie is signed from this, so a value that moved between boots
    // would end every session on every deploy.
    expect(loadConfig({}).adminPassword).toBe(loadConfig({}).adminPassword)
  })

  it('is a separate setting from the door, and moving one leaves the other', () => {
    const split = loadConfig({ ADMIN_PASSWORD: 'decks', STATION_KEY: 'door' })
    expect(split.adminPassword).toBe('decks')
    expect(split.stationKey).toBe('door')

    const onlyDecks = loadConfig({ ADMIN_PASSWORD: 'decks' })
    expect(onlyDecks.adminPassword).toBe('decks')
    expect(onlyDecks.stationKey).toBeNull()

    const onlyDoor = loadConfig({ STATION_KEY: 'door' })
    expect(onlyDoor.stationKey).toBe('door')
    expect(onlyDoor.adminPassword).toBe(loadConfig({}).adminPassword)
  })
})

/**
 * The one place this station reaches somewhere it was not configured to.
 *
 * Everything else here is self-hosted on purpose — the audio, the artwork, even
 * the gramophone's decoder is bundled rather than fetched — so a default that
 * points at Google is worth a test that says so out loud rather than leaving it
 * to be discovered by somebody reading a network tab.
 */
describe('finding another browser', () => {
  it('asks a public STUN server by default', () => {
    expect(loadConfig({}).stunUrls).toEqual(['stun:stun.l.google.com:19302'])
  })

  it('asks somewhere else when told to', () => {
    expect(loadConfig({ STUN_URLS: 'stun:one:3478, stun:two:3478' }).stunUrls).toEqual([
      'stun:one:3478',
      'stun:two:3478',
    ])
  })

  it('asks nobody when set to nothing', () => {
    // Not the same as unset. This is a station that works for everybody on the
    // same network and nobody beyond it, which is a real way to run one.
    expect(loadConfig({ STUN_URLS: '' }).stunUrls).toEqual([])
  })

  it('has no relay unless one is configured', () => {
    expect(loadConfig({}).turn).toBeNull()
  })

  it('takes a relay as all three parts', () => {
    expect(
      loadConfig({ TURN_URL: 'turn:relay:3478', TURN_USERNAME: 'sam', TURN_CREDENTIAL: 'pw' }).turn,
    ).toEqual({ urls: ['turn:relay:3478'], username: 'sam', credential: 'pw' })
  })

  it('takes every address a relay offers, which is the point of them', () => {
    // A provider hands you four of these and the differences are the whole
    // reason: UDP is the fast path, TCP survives a network that drops it, and
    // TLS on 443 gets through a firewall that only believes in HTTPS. The
    // listener who needs a relay is usually the one on a phone, which is
    // exactly where the strict networks are.
    expect(
      loadConfig({
        TURN_URL: 'turn:relay:3478, turn:relay:80?transport=tcp, turns:relay:443?transport=tcp',
        TURN_USERNAME: 'sam',
        TURN_CREDENTIAL: 'pw',
      }).turn?.urls,
    ).toEqual(['turn:relay:3478', 'turn:relay:80?transport=tcp', 'turns:relay:443?transport=tcp'])
  })

  it('refuses half a relay at boot rather than in somebody’s ears', () => {
    // A URL with no credentials is a relay that refuses every listener handed
    // to it, and the symptom is one person in six silently not hearing a voice.
    // Better to fail where somebody is looking.
    expect(() => loadConfig({ TURN_URL: 'turn:relay:3478' })).toThrow(/together/)
    expect(() => loadConfig({ TURN_URL: 'turn:relay:3478', TURN_USERNAME: 'sam' })).toThrow(/together/)
    expect(() => loadConfig({ TURN_USERNAME: 'sam', TURN_CREDENTIAL: 'pw' })).toThrow(/together/)
  })
})

describe('how much the station says', () => {
  it('keeps to itself by default', () => {
    expect(loadConfig({}).logLevel).toBe('info')
  })

  it('can be turned up, which is how an unconnectable voice is read', () => {
    // At `debug` every relayed ICE candidate is a line: far too much to keep
    // on, and exactly what is wanted for the ten minutes somebody is trying to
    // find out why two browsers will not meet.
    expect(loadConfig({ LOG_LEVEL: 'debug' }).logLevel).toBe('debug')
  })
})
