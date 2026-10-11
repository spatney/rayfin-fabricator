import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { ease, track } from './anim';
import { RayActor, type MoodCue, type RayKey, type Speech } from './ray/RayActor';
import { backend, describe, preview, ship } from './scenes/middle';
import { outro, stinger, tricks } from './scenes/closing';
import { fabric, hello, oldWay, oneWindow } from './scenes/opening';
import { RAY_SIZE, type SceneCtx, type SceneDef, type SfxCue } from './scenes/types';
import { layout, wordAt, type Timeline } from './timing';
import { THEMES, ThemeProvider, type ThemeName } from './theme';
import { Ocean } from './ui/Ocean';
import timelineJson from './timeline.json';

const timeline = timelineJson as Timeline;
export const LAYOUT = layout(timeline);
const FPS = LAYOUT.fps;

const SCENES: SceneDef[] = [hello, oldWay, oneWindow, fabric, backend, describe, preview, ship, tricks, outro, stinger];

function contextFor(def: SceneDef): SceneCtx {
  const line = timeline.lines.find((l) => l.id === def.id);
  if (!line) throw new Error(`No line for scene ${def.id}`);
  const span = LAYOUT.scenes[def.id];
  const lead = LAYOUT.lines[def.id].from - span.from;
  return {
    id: def.id,
    line,
    lead,
    span,
    fps: FPS,
    w: (word, nth = 1) => lead + wordAt(line, FPS, word, { nth }),
    wEnd: (word, nth = 1) => lead + wordAt(line, FPS, word, { nth, edge: 'end' }),
  };
}

const CONTEXTS = SCENES.map(contextFor);

/** Ray's whole performance in absolute frames: each scene's part, until the next scene takes over. */
const PERFORMANCE = (() => {
  const keys: RayKey[] = [];
  const moods: MoodCue[] = [];
  const waves: number[] = [];
  const hops: number[] = [];
  const rolls: number[] = [];
  const squishes: number[] = [];
  const gaze: Array<[number, number, number]> = [];
  SCENES.forEach((def, i) => {
    const ctx = CONTEXTS[i];
    const part = def.ray(ctx);
    const start = ctx.span.from;
    const next = CONTEXTS[i + 1]?.span.from ?? Infinity;
    const keep = (f: number) => start + f < next;
    for (const k of part.keys) if (keep(k.f)) keys.push({ ...k, f: start + k.f });
    for (const m of part.moods ?? []) if (keep(m.f)) moods.push({ ...m, f: start + m.f });
    for (const [list, into] of [
      [part.waves, waves],
      [part.hops, hops],
      [part.rolls, rolls],
      [part.squishes, squishes],
    ] as const) {
      for (const f of list ?? []) if (keep(f)) into.push(start + f);
    }
    for (const [f, x, y] of part.gaze ?? []) if (keep(f)) gaze.push([start + f, x, y]);
  });
  const byFrame = <T extends { f: number }>(a: T, b: T) => a.f - b.f;
  keys.sort(byFrame);
  moods.sort(byFrame);
  gaze.sort((a, b) => a[0] - b[0]);
  const speech: Speech[] = timeline.lines.map((line) => ({ f: LAYOUT.lines[line.id].from, line }));
  return { keys, moods, waves, hops, rolls, squishes, gaze, speech };
})();

/** Where Ray looks: a quick glance to each new target. */
function glance(f: number): { x: number; y: number } {
  let x = 0;
  let y = 0.1;
  for (const [at, gx, gy] of PERFORMANCE.gaze) {
    if (f < at) break;
    const p = ease.inOut(Math.min(1, (f - at) / 6));
    x += (gx - x) * p;
    y += (gy - y) * p;
  }
  return { x, y };
}

const SFX: Array<SfxCue & { at: number }> = SCENES.flatMap((def, i) =>
  (def.sfx?.(CONTEXTS[i]) ?? []).map((cue) => ({ ...cue, at: CONTEXTS[i].span.from + cue.f })),
);

/** How much the water calms down behind busy screens, per scene. */
const WATER_DIM: Record<string, number> = {
  hello: 0,
  'old-way': 0.15,
  'one-window': 0.3,
  fabric: 0.2,
  backend: 0.25,
  describe: 0.35,
  preview: 0.35,
  ship: 0.35,
  tricks: 0.35,
  outro: 0,
  stinger: 0,
};
const DIM_KEYS = SCENES.flatMap((def, i) => {
  const from = CONTEXTS[i].span.from;
  const before = WATER_DIM[SCENES[Math.max(0, i - 1)].id] ?? 0;
  return [[from, before] as const, [from + 15, WATER_DIM[def.id] ?? 0] as const];
});

/* --------------------------------- the mix --------------------------------- */

const VOICE = 0.8;
const MUSIC_BED = 0.26;
const MUSIC_UNDER_VOICE = 0.085;
/** Effects sit under the voice: every cue's volume is scaled by this. */
const SFX_LEVEL = 0.8;

/** The music level per frame: ducked under the voice, with a fast attack and slow release. */
const MUSIC_LEVEL = (() => {
  const speaking = new Array<boolean>(LAYOUT.total + 1).fill(false);
  for (const line of timeline.lines) {
    const from = LAYOUT.lines[line.id].from + Math.round((line.speechStartMs / 1000) * FPS);
    const to = LAYOUT.lines[line.id].from + Math.round((line.speechEndMs / 1000) * FPS);
    for (let f = Math.max(0, from - 3); f <= Math.min(LAYOUT.total, to); f++) speaking[f] = true;
  }
  const level: number[] = [];
  let v = MUSIC_BED;
  for (let f = 0; f <= LAYOUT.total; f++) {
    const target = speaking[f] ? MUSIC_UNDER_VOICE : MUSIC_BED;
    v += (target - v) * (target < v ? 0.35 : 0.08);
    const fadeIn = Math.min(1, f / 12);
    const fadeOut = Math.min(1, (LAYOUT.total - f) / 45);
    level.push(v * fadeIn * fadeOut);
  }
  return level;
})();

function Music(): JSX.Element {
  const frame = useCurrentFrame();
  return <Audio src={staticFile('audio/music.mp3')} volume={MUSIC_LEVEL[Math.min(frame, MUSIC_LEVEL.length - 1)]} />;
}

function SfxClip({ cue }: { cue: SfxCue }): JSX.Element {
  const frame = useCurrentFrame();
  const base = (cue.volume ?? 0.5) * SFX_LEVEL;
  const tail = cue.duration ? Math.min(1, Math.max(0, (cue.duration - frame) / 5)) : 1;
  return <Audio src={staticFile(`audio/sfx/${cue.id}.mp3`)} volume={base * tail} />;
}

/* ------------------------------- the picture ------------------------------- */

export type IntroProps = {
  /** Which cut: the deep-sea dark one or the sunlit light one. The sound is the same. */
  theme: ThemeName;
};

export function Intro({ theme }: IntroProps): JSX.Element {
  const frame = useCurrentFrame();
  return (
    <ThemeProvider value={THEMES[theme]}>
      <AbsoluteFill data-theme={theme} style={{ background: THEMES[theme].base }}>
        <Ocean dim={track(frame, DIM_KEYS)} />

        {SCENES.map((def, i) => {
          const ctx = CONTEXTS[i];
          const View = def.View;
          return (
            <Sequence key={def.id} name={def.id} from={ctx.span.from} durationInFrames={ctx.span.duration}>
              <View ctx={ctx} />
            </Sequence>
          );
        })}

        <RayActor
          size={RAY_SIZE}
          keys={PERFORMANCE.keys}
          moods={PERFORMANCE.moods}
          speech={PERFORMANCE.speech}
          waves={PERFORMANCE.waves}
          hops={PERFORMANCE.hops}
          rolls={PERFORMANCE.rolls}
          squishes={PERFORMANCE.squishes}
          gaze={glance}
          seed={3}
        />

        {timeline.lines.map((line) => (
          <Sequence key={line.id} name={`voice: ${line.id}`} from={LAYOUT.lines[line.id].from} durationInFrames={LAYOUT.lines[line.id].duration + 4}>
            <Audio src={staticFile(line.file)} volume={VOICE} />
          </Sequence>
        ))}
        {SFX.map((cue, i) => (
          <Sequence key={i} name={`sfx: ${cue.id}`} from={cue.at} durationInFrames={cue.duration ?? FPS * 4}>
            <SfxClip cue={cue} />
          </Sequence>
        ))}
        <Sequence name="music" from={0} durationInFrames={LAYOUT.total}>
          <Music />
        </Sequence>
      </AbsoluteFill>
    </ThemeProvider>
  );
}
