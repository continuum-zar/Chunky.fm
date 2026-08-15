import { AnimatePresence, motion, useMotionValueEvent, useScroll } from 'motion/react'
import { memo, type ReactNode, useState } from 'react'

/**
 * A bar that shrinks into a pill once you have started reading.
 *
 * A port of Aceternity UI's Resizable Navbar
 * (<https://ui.aceternity.com/components/resizable-navbar>). The mechanism is
 * the original's: past 100px of scroll it goes from full width to a floating
 * pill, with width and a 20px drop on a spring (stiffness 200, damping 50) and
 * the blur and the lift arriving with it. The hovered item is a single pill
 * that slides between them on a shared `layoutId` rather than one fading in per
 * item.
 *
 * It replaces two things this page used to have separately: a masthead at the
 * top and a floating bar that came back on scroll-up. This is both of those, and
 * one bar is easier to reason about than two that have to agree about which of
 * them is on screen.
 *
 * Three departures:
 *
 *  - **No `@tabler/icons-react`.** The original imports two icons from it for the
 *    mobile toggle and does not list it as a dependency, so `shadcn add` leaves
 *    you with a build error. Two nine-line SVGs cost less than the package.
 *  - **`useScroll()` with no target.** The original passes `{ target, offset }`,
 *    which only ever affects `scrollYProgress`, and it reads `scrollY`, which
 *    is the window's either way. Dropping them removes a measurement this page
 *    has twice been bitten by and changes nothing.
 *  - **It shrinks further.** The original goes to 40% with an 800px floor, which
 *    on most screens means the floor wins and the bar barely moves. This page is
 *    capped at 1080px, so the floor is lower and the shrink is one you can see.
 *    There is still a floor, in landing.css rather than here, and it is measured
 *    against what is actually in the bar: below it the centred links overflow
 *    their box and are laid over the wordmark. See the note on
 *    `.navbar__body[data-shrunk='true']`, which has to be revisited if a link is
 *    added to `NAV` or one of them is renamed to something longer.
 */

const SPRING = { type: 'spring', stiffness: 200, damping: 50 } as const

/*
 * The shadow and the blur are not animated here, and that is deliberate.
 *
 * The original animates `boxShadow` from `"none"` to a five-part shadow. Two
 * things are wrong with it. The first is fatal: that pair cannot be
 * interpolated, so motion writes one frame and abandons the whole `animate`
 * object: the bar never resizes, never drops and never blurs, because every
 * property in the batch goes down with the shadow.
 *
 * The second is what you see once it does work. A box-shadow is not a
 * composited property: interpolating one repaints the element every frame, and
 * one of its five parts is a 1px white `inset` ring. A hairline being both
 * colour-interpolated and re-rasterised at a new width sixty times a second
 * shimmers along its edge, which reads exactly like a glitchy border, because
 * it is one.
 *
 * So the lift lives on `.navbar__body::after` in landing.css and comes up on
 * opacity, which the compositor can do without repainting anything, and this
 * animates only what has to be laid out: the width and the drop.
 */

export interface NavItem {
  name: string
  link: string
}

/* Memoised: `Landing` re-renders on every scroll frame, and this holds a spring
   that should not be interrupted by a playhead moving. Its props are built once
   at the module. See Landing.tsx. */
export const ResizableNavbar = memo(function ResizableNavbar({
  items,
  action,
  aside,
  brand,
}: {
  items: readonly NavItem[]
  action: { name: string; link: string }
  /** The quiet one that only the person running the decks wants. */
  aside: { name: string; link: string; icon: ReactNode }
  brand: ReactNode
}) {
  const { scrollY } = useScroll()
  const [shrunk, setShrunk] = useState(false)
  const [open, setOpen] = useState(false)

  useMotionValueEvent(scrollY, 'change', (y) => setShrunk(y > 100))

  return (
    <div className="navbar">
      {/* Wide enough for the words: the bar proper. */}
      <motion.nav
        className="navbar__body"
        data-shrunk={shrunk ? 'true' : 'false'}
        animate={{ width: shrunk ? '58%' : '100%', y: shrunk ? 20 : 0 }}
        transition={SPRING}
      >
        {brand}
        <NavItems items={items} />
        <div className="navbar__ways">
          <a className="navbar__aside" href={aside.link} title={aside.name}>
            {aside.icon}
            <span className="navbar__aside-label">{aside.name}</span>
          </a>
          <a className="button" href={action.link}>
            {action.name}
          </a>
        </div>
      </motion.nav>

      {/* Narrow enough that the words have to go: a header and a drawer. */}
      <motion.div
        className="navbar__mobile"
        data-shrunk={shrunk ? 'true' : 'false'}
        /* The radius is CSS, on the same data attribute: one more property
           motion does not have to repaint for. */
        animate={{ width: shrunk ? '92%' : '100%', y: shrunk ? 16 : 0 }}
        transition={SPRING}
      >
        <div className="navbar__mobile-head">
          {brand}
          <div className="navbar__ways">
            <a className="button" href={action.link}>
              {action.name}
            </a>
            <button
              type="button"
              className="navbar__toggle"
              onClick={() => setOpen((was) => !was)}
              aria-expanded={open}
              aria-label={open ? 'Close the menu' : 'Open the menu'}
            >
              {open ? <Cross /> : <Bars />}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {open ? (
            <motion.div
              className="navbar__drawer"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {items.map((item) => (
                <a
                  className="navbar__drawer-link"
                  href={item.link}
                  key={item.link}
                  onClick={() => setOpen(false)}
                >
                  {item.name}
                </a>
              ))}
              <a
                className="navbar__drawer-link navbar__drawer-link--quiet"
                href={aside.link}
                onClick={() => setOpen(false)}
              >
                {aside.name}
              </a>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  )
})

/**
 * The links, and the one pill that moves between them.
 *
 * `layoutId` is what makes it one pill sliding rather than a background fading
 * in under each link, the same trick the original uses, and the reason the
 * hover reads as a thing being pointed at rather than as six separate hovers.
 */
function NavItems({ items }: { items: readonly NavItem[] }) {
  const [over, setOver] = useState<string | null>(null)

  return (
    <div className="navbar__items" onMouseLeave={() => setOver(null)}>
      {items.map((item) => (
        <a
          className="navbar__link"
          href={item.link}
          key={item.link}
          onMouseEnter={() => setOver(item.link)}
        >
          {over === item.link ? (
            <motion.span className="navbar__hover" layoutId="navbar-hover" />
          ) : null}
          <span className="navbar__label">{item.name}</span>
        </a>
      ))}
    </div>
  )
}

/* The two icons the original takes a whole package for. */

function Bars() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <title>Menu</title>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function Cross() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <title>Close</title>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}
