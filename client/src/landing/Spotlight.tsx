/**
 * A light thrown across a section, from off the top corner.
 *
 * A port of Aceternity UI's Spotlight
 * (<https://ui.aceternity.com/components/spotlight>), which arrives via
 * `npx shadcn add` into a Tailwind project and carries its keyframe in the
 * Tailwind theme. There is no Tailwind here, so the ellipse and its blur are
 * this file and the keyframe is `.spotlight` in landing.css.
 *
 * It is one blurred ellipse, turned, at a low opacity, and that is the whole
 * effect. The numbers in the `viewBox` and the transform are the original's and
 * are kept exactly: they are the shape of a beam falling from a source outside
 * the frame, and rounding them off flattens it into a smudge.
 *
 * One departure, and it is the palette. The original takes a `fill` and its
 * demo passes white; every other example in the wild passes a colour. This one
 * cannot: `tokens.css` allows the page one accent, which is white, and one
 * signal, which is red and means the station is on the air right now. A blue or
 * violet wash across a section would be the page inventing a third meaning it
 * has nowhere else, so the fill is fixed at white here rather than left as a
 * prop somebody could pass a colour to.
 *
 * Why this section has one. `Talks` is the page saying that some nights are a
 * person on a microphone and a room listening in on it. A light thrown on the
 * one who is talking is what that looks like anywhere it happens, which is the
 * test everything decorative on this page has to pass: it is the argument in the
 * one register the page has that is not words.
 *
 * Inside `aria-hidden` like every other instrument here. It reports nothing; it
 * is a light.
 */
export function Spotlight({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`spotlight ${className}`}
      viewBox="0 0 3787 2842"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g filter="url(#spotlight-blur)">
        <ellipse
          cx="1924.71"
          cy="273.501"
          rx="1924.71"
          ry="273.501"
          transform="matrix(-0.822377 -0.568943 -0.568943 0.822377 3631.88 2291.09)"
          fill="#ffffff"
          fillOpacity="0.12"
        />
      </g>
      <defs>
        <filter
          id="spotlight-blur"
          x="0.860352"
          y="0.838989"
          width="3785.16"
          height="2840.26"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="151" result="effect1_foregroundBlur" />
        </filter>
      </defs>
    </svg>
  )
}
