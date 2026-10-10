import { AbsoluteFill } from 'remotion';
import { RayActor } from './ray/RayActor';
import { RAY_SIZE } from './scenes/types';
import { Wordmark } from './ui/Brand';
import { SpeechBubble } from './ui/Kit';
import { Ocean } from './ui/Ocean';
import { C, FONT } from './theme';

/**
 * The poster the landing page shows before the video plays: Ray waving hello, as he greets
 * people in the app, next to the Fabricator mark. The bottom stays clear for the play button.
 */
export function Poster(): JSX.Element {
  return (
    <AbsoluteFill>
      <Ocean />
      <RayActor size={RAY_SIZE} keys={[{ f: 0, x: 600, y: 520, s: 1.05 }]} moods={[{ f: 0, mood: 'happy' }]} waves={[-10]} seed={5} />
      <SpeechBubble text="Hi, I’m Ray!" x={600} y={330} from={-60} to={100} width={360} size={34} />
      <Wordmark x={1260} y={440} size={118} from={-60} />
      <div style={{ position: 'absolute', left: 1260, top: 560, transform: 'translateX(-50%)', fontFamily: FONT, fontSize: 50, fontWeight: 650, letterSpacing: '-0.02em', color: '#e9f2fb', whiteSpace: 'nowrap' }}>
        Build Rayfin apps by chatting.
      </div>
      <div style={{ position: 'absolute', left: 1260, top: 640, transform: 'translateX(-50%)', fontFamily: FONT, fontSize: 30, color: C.dim, whiteSpace: 'nowrap' }}>
        Chat to build · Preview it live · Ship to Microsoft Fabric
      </div>
    </AbsoluteFill>
  );
}
