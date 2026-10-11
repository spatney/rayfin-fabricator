import { RAY_MOUTH, RAY_VIEWBOX } from '../../../../src/renderer/src/components/mascot/Ray';
import { openness, type MouthShape } from './lipsync';

/** mascot.css's ink and tongue colors. */
const INK = '#0e2238';
const TONGUE = '#ff7f9c';

/**
 * The mouth the video draws for Ray, in place of the app's (ray-video.css hides it), so it can
 * take the shape of what he says. It lies over his drawing in the drawing's own units, and
 * rises and sinks with his body by `rise`, as the app's .ray-rig does.
 */
export function Mouth({ shape, rise }: { shape: MouthShape; rise: number }): JSX.Element {
  const { w, top, bottom, smile, tongue } = shape;
  const cx = RAY_MOUTH.x * RAY_VIEWBOX.w;
  const cy = RAY_MOUTH.y * RAY_VIEWBOX.h + shape.y;
  const corner = cy - smile;
  // Two curves between the corners: one through the top of the opening, one through its bottom.
  // Shut, they meet in a line, drawn as thick as the app's; open, a thin stroke rounds the
  // corners, except on the happy grin, which matches the app's exactly.
  const lips = `M${cx - w} ${corner}Q${cx} ${2 * (cy - top) - corner} ${cx + w} ${corner}Q${cx} ${2 * (cy + bottom) - corner} ${cx - w} ${corner}Z`;
  const line = Math.max(2.6 * Math.max(0, 1 - openness(shape) / 3), 0.6 * (1 - tongue));
  // The happy grin's tongue (Ray.tsx), hanging from the bottom of the opening.
  const low = cy + bottom;
  const s = tongue;
  const tip = `M${cx - 3.6 * s} ${low + 0.15 * s}Q${cx} ${low + 3.95 * s} ${cx + 3.6 * s} ${low + 0.15 * s}Q${cx} ${low - 1.85 * s} ${cx - 3.6 * s} ${low + 0.15 * s}Z`;
  return (
    <svg viewBox={`0 0 ${RAY_VIEWBOX.w} ${RAY_VIEWBOX.h}`} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible' }}>
      <g transform={`translate(0 ${rise.toFixed(2)})`}>
        <path d={lips} fill={INK} stroke={INK} strokeWidth={line.toFixed(2)} strokeLinejoin="round" />
        {s > 0.02 ? <path d={tip} fill={TONGUE} /> : null}
      </g>
    </svg>
  );
}
