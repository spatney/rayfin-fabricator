import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { RayActor, type RayMood } from './ray/RayActor';
import { ease } from './anim';
import { FONT } from './theme';
import { wordFrames, type Timeline, type TimelineLine } from './timing';
import timelineJson from './timeline.json';

const timeline = timelineJson as Timeline;

const MOODS: RayMood[] = ['idle', 'talk', 'happy', 'love', 'surprised', 'blow', 'sleep', 'dizzy', 'worried', 'read'];

/** The frame he starts to speak. */
export const RAY_CHECK_SPEAKS = 40;

export type RayCheckProps = {
  /** The line he says, by its id in script/lines.ts. */
  line: string;
  /** His mood while he says it. */
  mood: RayMood;
};

function lineOf(id: string): TimelineLine {
  const line = timeline.lines.find((l) => l.id === id);
  if (!line) throw new Error(`No line "${id}" in timeline.json`);
  return line;
}

/** Long enough for him to swim in, say the line and settle. */
export function rayCheckLength({ line }: RayCheckProps): number {
  return RAY_CHECK_SPEAKS + Math.ceil((lineOf(line).durationMs / 1000) * timeline.fps) + 30;
}

/**
 * A maintainer's check of the rig, not part of the video: Ray swims in, rolls, waves and says
 * a line with lip sync, with the word he's saying underneath, above a row of every mood. Open
 * it in the Studio after changing Ray.tsx or mascot.css, since ray-video.css depends on their
 * class names, or after changing the lip sync (src/ray/lipsync.ts).
 */
export function RayCheck({ line: id, mood }: RayCheckProps): JSX.Element {
  const frame = useCurrentFrame();
  const line = lineOf(id);
  const at = frame - RAY_CHECK_SPEAKS;
  const words = wordFrames(line, timeline.fps);
  const now = words.findIndex((w) => at >= w.start && at < w.end);
  return (
    <AbsoluteFill style={{ background: '#0b1524' }}>
      <RayActor
        size={360}
        keys={[
          { f: 0, x: -300, y: 300 },
          { f: 28, x: 960, y: 330, e: ease.out },
        ]}
        moods={[{ f: 0, mood }]}
        rolls={[8]}
        waves={[34]}
        speech={[{ f: RAY_CHECK_SPEAKS, line }]}
        seed={3}
      />
      <Sequence from={RAY_CHECK_SPEAKS}>
        <Audio src={staticFile(line.file)} />
      </Sequence>
      <div style={{ position: 'absolute', left: 160, right: 160, top: 560, textAlign: 'center', fontFamily: FONT, fontSize: 32, lineHeight: 1.4, color: '#5f6f86' }}>
        {words.map((w, i) => (
          <span key={i} style={{ color: i === now ? '#f4f8fc' : undefined }}>
            {w.text}{' '}
          </span>
        ))}
      </div>
      {MOODS.map((m, i) => (
        <RayActor
          key={m}
          size={150}
          keys={[{ f: 0, x: 140 + i * 182, y: 860 }]}
          moods={[{ f: 0, mood: m, glasses: m === 'read' }]}
          seed={10 + i}
        />
      ))}
    </AbsoluteFill>
  );
}
