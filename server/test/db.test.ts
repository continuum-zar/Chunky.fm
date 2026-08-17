import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb, openSession } from '../src/db.js'

/**
 * Opening a database that already exists.
 *
 * The whole schema is `CREATE TABLE IF NOT EXISTS`, which builds a station and
 * cannot change one: against a table that is already there the statement does
 * nothing at all, so a column added to the schema text appears in every test and
 * in nobody's data directory. Every test in this suite starts from `:memory:`,
 * which is exactly the case that cannot catch it.
 *
 * So this is the other case, written the only way that is honest about it: an
 * old database built by hand from the schema as it stood, opened by the code as
 * it stands now.
 */

/** The two tables as they were before a session had a kind. */
const BEFORE = `
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE schedule (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  starts_at   INTEGER NOT NULL,
  poster      TEXT,
  set_at      INTEGER NOT NULL
);
`

describe('opening a database written by an older station', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** An old database with a session and an announcement already in it. */
  function aged(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunky-db-'))
    made.push(dir)
    const file = path.join(dir, 'station.db')
    const old = new Database(file)
    old.exec(BEFORE)
    old.prepare('INSERT INTO sessions (started_at, ended_at) VALUES (?, ?)').run(1000, 2000)
    old
      .prepare('INSERT INTO schedule (id, starts_at, poster, set_at) VALUES (1, ?, ?, ?)')
      .run(3000, 'a.png', 1000)
    old.close()
    return file
  }

  it('adds the columns the schema has grown since', () => {
    const db = openDb(aged())
    const columns = (table: string) =>
      (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)

    expect(columns('sessions')).toContain('kind')
    expect(columns('schedule')).toEqual(
      expect.arrayContaining(['kind', 'title']),
    )
    db.close()
  })

  it('reads a night from before there were two kinds as the kind it was', () => {
    const db = openDb(aged())
    // Not a guess dressed as a default: every session written before this
    // existed was a set, because a set was the only thing the station did.
    expect(db.prepare('SELECT kind FROM sessions').get()).toEqual({ kind: 'set' })
    expect(db.prepare('SELECT kind, title FROM schedule').get()).toEqual({
      kind: 'set',
      title: null,
    })
    db.close()
  })

  it('leaves everything else exactly as it found it', () => {
    const db = openDb(aged())
    expect(db.prepare('SELECT started_at, ended_at FROM sessions').get()).toEqual({
      started_at: 1000,
      ended_at: 2000,
    })
    expect(db.prepare('SELECT starts_at, poster FROM schedule').get()).toEqual({
      starts_at: 3000,
      poster: 'a.png',
    })
    db.close()
  })

  it('is safe to open twice, because a deploy is not the first one', () => {
    const file = aged()
    openDb(file).close()
    expect(() => openDb(file).close()).not.toThrow()
  })

  it('writes new sessions with their kind on the migrated table', () => {
    const db = openDb(aged())
    openSession(db, 4000, 'talk')
    expect(db.prepare('SELECT kind FROM sessions WHERE started_at = 4000').get()).toEqual({
      kind: 'talk',
    })
    db.close()
  })

  it('holds the check constraint the fresh schema states', () => {
    const db = openDb(aged())
    // Added with the column rather than left off it, so a station that has been
    // running is under the same rule as one built today.
    expect(() =>
      db.prepare('INSERT INTO sessions (started_at, kind) VALUES (?, ?)').run(5000, 'karaoke'),
    ).toThrow(/CHECK/i)
    db.close()
  })
})
