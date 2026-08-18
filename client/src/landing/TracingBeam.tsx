import { motion, useScroll, useSpring, useTransform } from 'motion/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

/**
 * A line drawn down the margin, as far as you have read.
 *
 * A port of Aceternity UI's Tracing Beam
 * (<https://ui.aceternity.com/components/tracing-beam>), which arrives via
 * `npx shadcn add` into a Tailwind + shadcn project. This is neither, so the
 * mechanism is kept exactly and the wall of Tailwind arbitrary values is
 * `.beam*` in landing.css.
 *
 * The mechanism, since it is not obvious from looking at it: the path is drawn
 * twice, once faint for its whole length and once in a gradient, and nothing
 * about the *path* animates. What moves is the gradient's `y1` and `y2`, which
 * are tied to how far through the section the page has scrolled and then run
 * through a spring. So the bright part of the line is a window sliding down a
 * line that was always there, and the spring is why it lags and catches up
 * rather than tracking the wheel exactly — which is also, incidentally, what
 * makes it feel like something being drawn rather than a progress bar.
 *
 * The height cannot be known until the children have been laid out, so the
 * `svg` is measured from the content rather than given a size, and re-measured
 * when the content changes shape. The original measures once on mount, which is
 * fine for a page of static prose and is not fine here: the lines in `Creed`
 * wrap differently at every width, and a beam measured at one width and then
 * left alone stops halfway down the section or runs off the end of it.
 *
 * Two departures, both about this page:
 *
 *  - **It is white, not a spectrum.** The original's gradient runs cyan into
 *    violet. `tokens.css` allows one accent, and it is white. A line that
 *    changed colour as it came down would be the only spectrum on a monochrome
 *    page, and it would be saying something (a state? a section?) that it does
 *    not mean.
 *  - **There is no dot at the top.** The original hangs a ring at the head of
 *    the path that fills in once you start scrolling. It is a scroll indicator,
 *    and this section is a long way down a page nobody arrives at without
 *    having scrolled; a thing that lights up to tell you that you have scrolled
 *    is furniture with no reader.
 *
 * Asked to hold still, the bright path is not rendered at all and the faint one
 * remains: the section keeps the line down its margin, and nothing on it moves.
 */
export function TracingBeam({ children, className = '' }: { children: ReactNode; className?: string }) {
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [still, setStill] = useState(false)

  /*
   * The path's length, kept level with the content's.
   *
   * A `ResizeObserver` rather than the original's measure-once, because every
   * line in this section wraps at some width and the whole section changes
   * height when it does. Measured off the content rather than the frame so the
   * beam is as long as what it is beside, not as long as whatever padding the
   * section has.
   */
  useEffect(() => {
    const box = content.current
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

  /*
   * `start start` to `end start`: the beam is full when the *end* of the section
   * reaches the top of the window, not when it leaves the bottom. Which is the
   * original's offset and is the right one — the line should finish as you
   * finish the last line of the section, and an offset measured to the bottom
   * of the window finishes it a screen too early.
   */
  const { scrollYProgress } = useScroll({ target: frame, offset: ['start start', 'end start'] })

  const spring = { stiffness: 500, damping: 90 } as const
  const y1 = useSpring(useTransform(scrollYProgress, [0, 0.8], [50, height]), spring)
  const y2 = useSpring(useTransform(scrollYProgress, [0, 1], [50, height - 200]), spring)

  /* The original's shape: down, a step out to the right, down the long run, a
     step back in, and down to the end. The two 24s are the height of each step
     and the 18 is how far out it goes. */
  const path = `M 1 0 V -36 l 18 24 V ${height * 0.8} l -18 24 V ${height}`

  return (
    <div className={`beam ${className}`} ref={frame}>
      <svg
        className="beam__line"
        viewBox={`0 0 20 ${height}`}
        width="20"
        height={height}
        aria-hidden="true"
      >
        <path className="beam__path" d={path} fill="none" />
        {still ? null : (
          <path className="beam__lit" d={path} fill="none" stroke="url(#beam-gradient)" />
        )}
        <defs>
          <motion.linearGradient
            id="beam-gradient"
            gradientUnits="userSpaceOnUse"
            x1="0"
            x2="0"
            y1={y1}
            y2={y2}
          >
            {/* Out of nothing, up to the reading colour, and back to nothing:
                the lit part has no ends, it fades in and out of the faint line
                it is travelling along. */}
            <stop stopColor="#ffffff" stopOpacity="0" />
            <stop offset="0.28" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="0.72" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </motion.linearGradient>
        </defs>
      </svg>

      {/* Carries whatever layout the section had before it was wrapped: see
          `.creed__beam .beam__content` in landing.css. The frame cannot do it,
          because the frame also holds the line. */}
      <div className="beam__content" ref={content}>
        {children}
      </div>
    </div>
  )
}
