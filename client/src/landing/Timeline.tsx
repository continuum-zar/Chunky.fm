import { motion, useScroll, useTransform } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

/**
 * Notes down a line, at the point of the record each one belongs to.
 *
 * A port of Aceternity UI's Timeline
 * (<https://ui.aceternity.com/components/timeline>), which arrives via
 * `npx shadcn add` into a Tailwind + shadcn project. The mechanism is kept —
 * one rail down the left, a dot per entry, and a lit length of rail that grows
 * with the scroll — and every Tailwind value is `.rail*` in landing.css.
 *
 * Why this section has one. `Guide`'s three notes are already timestamps: 2:14,
 * 4:31, 5:02. A timestamp is a position on a line, and the section was drawing
 * them as an ordered list, which is the one shape that says these things happen
 * in sequence but not that they happen at *points*. The rail is the record and
 * the dots are where somebody leaned over and said something, which is what a
 * listening note is. Nothing here is decoration standing in for content: the
 * content was already a timeline and was being drawn as a list.
 *
 * Three departures, and all three are size:
 *
 *  - **It is compact.** The original is a full-page component: `pt-40` between
 *    entries and titles at `text-5xl`, built for a product changelog where each
 *    entry is a screen. These entries are one sentence. At the original's
 *    spacing three notes would be three screens tall, which on a page whose
 *    whole complaint is that it asks too much of a reader would be an odd thing
 *    to add.
 *  - **The title is the timestamp, and it stays small.** In the original the
 *    title is the biggest thing in the row. Here it is a clock reading in the
 *    numeric face, at the size the rest of the page sets a clock, because it is
 *    a position rather than a heading.
 *  - **The rail is white.** The original's lit length runs purple into blue.
 *    Same reason as everywhere else: `tokens.css` allows white and one red that
 *    means on the air.
 *
 * Asked to hold still, the lit rail is simply full: the shape is the content,
 * and a reader who does not want motion should still get the line and the dots.
 */

export interface TimelineItem {
  /** What is on the rail. Here, the second of the record. */
  at: string
  /** What was said at it. */
  says: ReactNode
}

export function Timeline({ items, className = '' }: { items: readonly TimelineItem[]; className?: string }) {
  const frame = useRef<HTMLDivElement>(null)
  const rail = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [still, setStill] = useState(false)

  /* Measured rather than declared, and re-measured on resize: the notes wrap at
     narrow widths and the rail has to be as long as the notes actually are, not
     as long as they were when the page loaded. */
  useEffect(() => {
    const box = rail.current
    if (!box) return

    const measure = () => setHeight(box.offsetHeight)
    const watcher = new ResizeObserver(measure)
    watcher.observe(box)
    measure()

    return () => watcher.disconnect()
  }, [])

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const read = () => setStill(query.matches)

    read()
    query.addEventListener('change', read)
    return () => query.removeEventListener('change', read)
  }, [])

  /* `start 70%` to `end 60%`: the rail starts filling as the first note comes up
     from the bottom of the window and is full about when the last one is read.
     The original's `start 10% / end 50%` is set for entries a screen tall and
     here would leave the rail barely started by the time the section is done. */
  const { scrollYProgress } = useScroll({ target: frame, offset: ['start 70%', 'end 60%'] })
  const lit = useTransform(scrollYProgress, [0, 1], [0, height])
  const showing = useTransform(scrollYProgress, [0, 0.06], [0, 1])

  return (
    <div className={`rail ${className}`} ref={frame}>
      <div className="rail__notes" ref={rail}>
        {items.map((item) => (
          <div className="rail__note" key={item.at}>
            <span className="rail__dot" aria-hidden="true" />
            {/* Not `aria-hidden`, unlike every other clock on this page. The
                others are pictures of a playhead; this is the content, and a
                note without the second it belongs to is a different and much
                worse thing. */}
            <span className="rail__at">{item.at}</span>
            <span className="rail__says">{item.says}</span>
          </div>
        ))}
      </div>

      {/* The rail itself, behind the dots. Faint for its whole length, with the
          lit part growing down it. */}
      <div className="rail__line" style={{ height: height || undefined }} aria-hidden="true">
        {still ? (
          <div className="rail__lit rail__lit--all" />
        ) : (
          <motion.div className="rail__lit" style={{ height: lit, opacity: showing }} />
        )}
      </div>
    </div>
  )
}
