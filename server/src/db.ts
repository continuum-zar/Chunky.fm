import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

export interface TrackRow {
  id: number
  title: string
  artist: string | null
  album: string | null
  duration_ms: number
  /** Basename inside `<storage>/audio`. Never a client-supplied name. */
  filename: string
  /** Basename inside `<storage>/artwork`, or null when the file had no embedded art. */
  artwork_path: string | null
  content_hash: string
  gain_db: number
  uploaded_at: number
}

/** A track's lyrics as LRCLIB handed them over. See the schema note. */
export interface LyricsRow {
  track_id: number
  /** LRC text, `[mm:ss.xx] line` per line, or null when only plain was found. */
  synced: string | null
  plain: string | null
  fetched_at: number
}

/**
 * What kind of night a session is.
 *
 * `set` is the station as it has always been: records, chosen by whoever is on
 * the decks, with the room around them. `talk` is the same room and the same
 * clock with a conversation in the middle of it instead of a tracklist.
 *
 * Two values rather than a boolean called `isTalk`, because the two are peers:
 * neither is the other one turned off. And a closed set of two rather than free
 * text, because everything downstream switches on it, and a third kind that
 * only the database knew about would reach the listener page as a night that
 * renders as neither.
 *
 * What it does *not* do is decide what may happen. A talk session can put a
 * record on and a set can open the mic; the kind says what the night is for, so
 * the page can lead with the right thing, and nothing about it is a lock.
 */
export type SessionKind = 'set' | 'talk'

/** A stretch of the station being on air. See `openSession`. */
export interface SessionRow {
  id: number
  started_at: number
  /** Null while the session is the current one. */
  ended_at: number | null
  kind: SessionKind
}

/** The next session, as announced. One row at most. See the schema note. */
export interface ScheduleRow {
  id: 1
  starts_at: number
  poster: string | null
  set_at: number
  kind: SessionKind
  /** What the night is called, or null for a time and a poster alone. */
  title: string | null
}

export interface MessageRow {
  id: number
  session_id: number
  /** The nickname as it stood when the message was sent, not a live reference. */
  nick: string
  text: string
  created_at: number
}

export interface WishRow {
  id: number
  session_id: number
  /** The nickname as it stood when the wish was made. Same copy as a message's. */
  nick: string
  text: string
  created_at: number
  /**
   * Where the wish stands with whoever runs the decks. Named `WishStatus` in
   * `wishes.ts`, which is where the values mean anything; the column is here.
   */
  status: 'new' | 'handled'
}

/**
 * A track going on air. PLAN.md's now-playing history, one row per time a track
 * started, so a track played twice in an evening is two rows, not one.
 */
export interface PlayRow {
  id: number
  session_id: number
  track_id: number
  /** Server epoch ms at which the track went on. */
  played_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  artist        TEXT,
  album         TEXT,
  duration_ms   INTEGER NOT NULL,
  filename      TEXT    NOT NULL UNIQUE,
  artwork_path  TEXT,
  content_hash  TEXT    NOT NULL UNIQUE,
  gain_db       REAL    NOT NULL DEFAULT 0,
  uploaded_at   INTEGER NOT NULL
);

-- What LRCLIB knows about a track, written down once so the station asks the
-- internet about each song one time rather than once per listener. One row per
-- track that has been looked up and found; a track nobody could find keeps no
-- row, so a restart gets to ask again.
--
-- Not a foreign key, for the reason a play isn't: the row is written from a
-- background errand after the upload has already answered, and a note about a
-- track must never be able to break the track it is a note about. The wipe
-- that deletes a track deletes its lyrics row alongside.
CREATE TABLE IF NOT EXISTS lyrics (
  track_id    INTEGER PRIMARY KEY,
  -- LRC text: "[mm:ss.xx] line" per line. Null when only plain text was found.
  synced      TEXT,
  plain       TEXT,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  -- What kind of night this was. Constrained here as well as in the type, the
  -- same argument the wishes' status column makes: a kind nothing can render is
  -- a session the listener page would draw as neither one thing nor the other,
  -- and the column outlives every process that wrote to it.
  --
  -- Defaulted, and that is what makes this safe to add to a station that has
  -- been running: every session written before there were two kinds was a set,
  -- which is true rather than a convenient assumption.
  kind        TEXT    NOT NULL DEFAULT 'set' CHECK (kind IN ('set', 'talk'))
);

-- The next session, announced before it happens. One row, ever: the id = 1
-- check is what makes that a rule the database keeps rather than a convention
-- the code remembers. A station is an evening rather than a calendar, so what
-- is being scheduled is the next one, and setting another replaces it.
--
-- Nothing here starts anything. The time is a promise to whoever is reading it;
-- going on air is still a person pressing a button. See the Schedule class.
CREATE TABLE IF NOT EXISTS schedule (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  starts_at   INTEGER NOT NULL,
  -- The poster's filename under the config's posterDir, or null for a time
  -- with no picture behind it.
  poster      TEXT,
  set_at      INTEGER NOT NULL,
  -- What is being announced, on the same two values a session runs under. A
  -- promise about a night has to be able to say which kind of night, or the
  -- page in front of the station advertises every conversation as a set.
  kind        TEXT    NOT NULL DEFAULT 'set' CHECK (kind IN ('set', 'talk')),
  -- What it is called: "Songs that sound like forgiveness", or the name of
  -- whoever is coming on. Null for a time and a picture and nothing else, which
  -- is what an announcement was until now and is still a real one.
  title       TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  nick        TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Chat is only ever read as "the last N of one session", newest first.
CREATE INDEX IF NOT EXISTS messages_session_id ON messages (session_id, id);

CREATE TABLE IF NOT EXISTS wishes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  nick        TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  -- Constrained here as well as in the type: a status nothing can render is a
  -- row the admin panel would show as a blank, and the column outlives the
  -- process that wrote it.
  status      TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled'))
);

-- Read as "this session's wishes, oldest first", which is the order they were
-- asked in and the order they are worked through.
CREATE INDEX IF NOT EXISTS wishes_session_id ON wishes (session_id, id);

CREATE TABLE IF NOT EXISTS plays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  -- A reference rather than a copy of the title, unlike a message's nickname:
  -- nothing deletes a track, and a retagged one should read correctly in the
  -- history as well as in the library.
  --
  -- Deliberately *not* a foreign key, though, which is the one place this table
  -- differs from the others. A play is written from inside playback's change
  -- event, so a constraint that could refuse the insert would throw into
  -- whatever put the track on: an admin command answering 500 after the track
  -- already changed, or the end-of-track timer dying mid-set. A note about what
  -- happened must never be able to break the thing it is a note about, and the
  -- read below drops a row it cannot name rather than failing.
  track_id    INTEGER NOT NULL,
  played_at   INTEGER NOT NULL
);

-- Read as "the last N of this session", newest first, the same shape the chat
-- is read in, and for the same reason.
CREATE INDEX IF NOT EXISTS plays_session_id ON plays (session_id, id);
`

/**
 * Which session the things written down during one belong to.
 *
 * An object rather than a number because the answer changes while the process
 * runs: the admin goes live, and the chat, the wish book and the history all
 * have to start writing to the session that just opened. Handing each of them a
 * number at construction time would pin them to whichever session happened to
 * be open at boot, which is what they used to do back when a session *was* a
 * run of the process.
 *
 * Null while the station is off air. There is no session then, so there is
 * nothing to write to and nothing to read. See the three logs, which all treat
 * it as an empty room rather than reaching for the last one.
 */
export interface SessionRef {
  readonly current: number | null
}

/**
 * Starts a session, and returns its id.
 *
 * PLAN.md's availability story is session-based (you go live, you end it), and
 * the admin controls for that are a later task. What exists now is the part
 * chat needs: something for a message to belong to, so "the chat" means this
 * time on air rather than everything ever said. A run of the process is a
 * session; when the admin can start and end them by hand, messages will scope
 * themselves to those instead, and nothing here has to change to allow it.
 */
export function openSession(db: Db, now = Date.now(), kind: SessionKind = 'set'): number {
  const result = db.prepare('INSERT INTO sessions (started_at, kind) VALUES (?, ?)').run(now, kind)
  return Number(result.lastInsertRowid)
}

/** Marks a session over. Idempotent: a session already ended keeps its time. */
export function closeSession(db: Db, sessionId: number, now = Date.now()): void {
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(
    now,
    sessionId,
  )
}

/**
 * Columns added to tables that already exist somewhere.
 *
 * `CREATE TABLE IF NOT EXISTS` is the whole of the schema above, which is a
 * perfectly good way to build a database and no way at all to change one: the
 * statement is a no-op against a table that is already there, so a column added
 * to the text above simply never appears on the station that has been running
 * since before it was written. The first read after a deploy then fails on a
 * column that exists in every test and in nobody's data directory.
 *
 * So each of these is stated twice on purpose: once in `SCHEMA`, which is what a
 * fresh database is built from and what somebody reads to learn the shape, and
 * once here, which is what an existing one is brought up to. The pair has to
 * agree. If they ever disagree the tests will not notice, because tests start
 * from an empty file where only the first half runs.
 *
 * Idempotent by inspection rather than by catching an error: `ALTER TABLE` is
 * not conditional in SQLite, and a swallowed exception here would hide a
 * genuinely broken migration behind the one it is expected to throw.
 */
const ADDED_COLUMNS: [table: string, column: string, spec: string][] = [
  ['sessions', 'kind', "TEXT NOT NULL DEFAULT 'set' CHECK (kind IN ('set', 'talk'))"],
  ['schedule', 'kind', "TEXT NOT NULL DEFAULT 'set' CHECK (kind IN ('set', 'talk'))"],
  ['schedule', 'title', 'TEXT'],
]

function migrate(db: Db): void {
  for (const [table, column, spec] of ADDED_COLUMNS) {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[]
    if (columns.some((existing) => existing.name === column)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`)
  }
}

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}
