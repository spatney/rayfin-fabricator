import { AbsoluteFill } from 'remotion';
import { RayActor, type RayMood } from './ray/RayActor';
import { RAY_SIZE } from './scenes/types';
import { THEMES, ThemeProvider, alpha, type ThemeName } from './theme';
import { Ocean } from './ui/Ocean';

/**
 * Ray on his own, square, for a profile picture: centered, so a circular crop keeps all of
 * him, and looking at you. Render it with `npx remotion still src/index.ts RayAvatar
 * out/ray-avatar.png` (the repo root's ray-profile.png); pass a `mood` in `--props` for another.
 */
export function RayAvatar({ theme = 'dark', mood = 'idle' }: { theme?: ThemeName; mood?: RayMood }): JSX.Element {
  const C = THEMES[theme];
  return (
    <ThemeProvider value={C}>
      <AbsoluteFill style={{ background: C.base }}>
        <Ocean />
        <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, ${alpha(C.accent, 0.45)}, ${alpha(C.accent, 0.12)} 45%, transparent 70%)` }} />
        <RayActor size={RAY_SIZE} keys={[{ f: 0, x: 512, y: 518, s: 2.1, r: -6 }]} moods={[{ f: 0, mood }]} gaze={() => ({ x: 0, y: 0.1 })} seed={5} />
      </AbsoluteFill>
    </ThemeProvider>
  );
}
