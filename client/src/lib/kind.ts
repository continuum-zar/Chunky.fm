import type { SessionKind } from './protocol.js'

/**
 * What to call a night, in the two registers the pages need.
 *
 * Three places name a kind: the bar across the top of the station, the console
 * where one is chosen, and the poster on the page in front of the station. They
 * are three different codebases' worth of distance apart in practice, and a
 * station that offered "a conversation" on the console and announced "Talk" on
 * the poster would read as two features rather than one. So the words live
 * here, once.
 *
 * The words are deliberately not the values. `talk` is what the wire and the
 * database say, because it is short and stays short; "a conversation" is what a
 * person is told, because nobody turns up to a talk. Keeping the two apart is
 * what lets either change without the other.
 */

/** Sentence case, for a label standing on its own: "Conversation". */
export function kindLabel(kind: SessionKind): string {
  return kind === 'talk' ? 'Conversation' : 'Set'
}

/** With its article, for the middle of a sentence: "a conversation". */
export function kindNoun(kind: SessionKind): string {
  return kind === 'talk' ? 'a conversation' : 'a set'
}

/**
 * What is promised, as a poster says it: "A conversation", "A set of records".
 *
 * A set gets the longer form and a conversation does not, which looks
 * inconsistent and is the point: "a set" on its own is jargon to somebody who
 * has never been to this station, and "a conversation" is not.
 */
export function kindPromise(kind: SessionKind): string {
  return kind === 'talk' ? 'A conversation' : 'A set of records'
}
