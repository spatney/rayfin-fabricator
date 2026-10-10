import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile } from 'remotion';
import { RayActor, type RayMood } from './ray/RayActor';
import { ease } from './anim';
import type { Timeline } from './timing';
import timelineJson from './timeline.json';

const timeline = timelineJson as Timeline;

const MOODS: RayMood[] = ['idle', 'talk', 'happy', 'love', 'surprised', 'blow', 'sleep', 'dizzy', 'worried', 'read'];

/**
 * A maintainer's check of the rig, not part of the video: Ray swims in, rolls, waves and says
 * his hello with lip sync, above a row of every mood. Open it in the Studio after changing
 * Ray.tsx or mascot.css, since ray-video.css depends on their class names.
 */
export function RayCheck(): JSX.Element {
  const hello = timeline.lines.find((l) => l.id === 'hello');
  if (!hello) throw new Error('No hello line in timeline.json');
  return (
    <AbsoluteFill style={{ background: '#0b1524' }}>
      <RayActor
        size={360}
        keys={[
          { f: 0, x: -300, y: 300 },
          { f: 28, x: 960, y: 330, e: ease.out },
        ]}
        rolls={[8]}
        waves={[34]}
        speech={[{ f: 40, line: hello }]}
        seed={3}
      />
      <Sequence from={40}>
        <Audio src={staticFile(hello.file)} />
      </Sequence>
      {MOODS.map((mood, i) => (
        <RayActor
          key={mood}
          size={150}
          keys={[{ f: 0, x: 140 + i * 182, y: 860 }]}
          moods={[{ f: 0, mood, glasses: mood === 'read' }]}
          seed={10 + i}
        />
      ))}
    </AbsoluteFill>
  );
}
