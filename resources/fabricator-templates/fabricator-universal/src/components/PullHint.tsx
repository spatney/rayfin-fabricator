/**
 * A quiet, hand-drawn nudge that points at the light-bulb pull-chain, hinting
 * that you can give it a tug to toggle the theme. It fades away for good the
 * first time the chain is pulled — see {@link ../pages/HomePage}.
 */
export function PullHint({ dismissed }: { dismissed: boolean }) {
  return (
    <div
      className={`rayfin-nudge${dismissed ? ' rayfin-nudge--gone' : ''}`}
      aria-hidden="true"
    >
      <svg
        className="rayfin-nudge-arrow"
        viewBox="0 0 72 60"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* curved shaft with a little loop-de-loop, sweeping from the label down
            toward the knob (but stopping just short of it) */}
        <path
          className="rayfin-nudge-stroke"
          d="M66 14 C 57 12 49 15 44 21 C 51 22 52 32 43 32 C 36 32 36 23 45 23 C 41 27 30 36 11 44"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* arrowhead at the tip, barbs opening back up the shaft */}
        <path
          className="rayfin-nudge-stroke"
          d="M11 44 L 21 44 M11 44 L 14 34"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="rayfin-nudge-label">pull me</span>
    </div>
  );
}
