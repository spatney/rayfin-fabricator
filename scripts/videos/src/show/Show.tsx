import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, getStaticFiles, staticFile, useCurrentFrame } from 'remotion';
import { ease, track } from '../anim';
import { Depths } from '../lesson-kit/Depths';
import { RayActor, type MoodCue, type RayKey, type Speech } from '../ray/RayActor';
import { RAY_SIZE } from '../scenes/types';
import { THEMES, ThemeProvider, type ThemeName } from '../theme';
import { Ocean } from '../ui/Ocean';
import { findWord, planLesson, type Plan } from './plan';
import type { Episode, LessonCtx, LessonScene, SfxCue } from './types';

/* The mix. The lessons talk for minutes, so the bed sits a little lower than the intro's. */
const VOICE = 0.8;
const MUSIC_BED = 0.2;
const MUSIC_UNDER_VOICE = 0.065;
/** Effects sit under the voice: every cue's volume is scaled by this. */
const SFX_LEVEL = 0.8;
/** Frames the water takes to change depth or calm between scenes. */
const WATER_RAMP = 20;

/** The files in public/, so a lesson still previews before its voice, music or effects exist. */
function publicFiles(): Set<string> {
  return new Set(getStaticFiles().map((f) => f.name.replace(/\\/g, '/')));
}

export interface Built {
  plan: Plan;
  contexts: LessonCtx[];
  scenes: readonly LessonScene[];
  performance: {
    keys: RayKey[];
    moods: MoodCue[];
    waves: number[];
    hops: number[];
    rolls: number[];
    squishes: number[];
    gaze: Array<[number, number, number]>;
    speech: Speech[];
  };
  sfx: Array<SfxCue & { at: number }>;
  music: number[];
  depth: Array<readonly [number, number]>;
  dim: Array<readonly [number, number]>;
}

function contextFor(plan: Plan, scene: LessonScene): LessonCtx {
  const span = plan.scenes[scene.id];
  if (!span) throw new Error(`scenes.tsx has a scene "${scene.id}" that script.ts doesn't.`);
  const own = plan.order.map((id) => plan.beats[id]).filter((b) => b.scene === scene.id);
  const beatOf = (id: string) => {
    const beat = plan.beats[id];
    if (!beat) throw new Error(`No beat "${id}" in this lesson (asked for by scene "${scene.id}").`);
    return beat;
  };
  const fps = plan.fps;
  return {
    id: scene.id,
    span: { from: span.from, duration: span.duration },
    fps,
    lead: span.first - span.from,
    beat: (id) => {
      const b = beatOf(id);
      return { from: b.from - span.from, to: b.from + b.duration - span.from, line: b.line };
    },
    w: (word, nth = 1) => findWord(own, fps, word, { nth }) - span.from,
    wEnd: (word, nth = 1) => findWord(own, fps, word, { nth, edge: 'end' }) - span.from,
    at: (id, word, nth = 1) => findWord([beatOf(id)], fps, word, { nth }) - span.from,
    atEnd: (id, word, nth = 1) => findWord([beatOf(id)], fps, word, { nth, edge: 'end' }) - span.from,
  };
}

const cache = new WeakMap<Episode, Built>();

/** Lays out an episode and works out Ray's whole performance, the effects and the mix. */
export function build(episode: Episode): Built {
  const hit = cache.get(episode);
  if (hit) return hit;
  const plan = planLesson(episode.script, episode.timeline);
  const missing = episode.script.scenes.filter((s) => !episode.scenes.some((d) => d.id === s.id));
  if (missing.length) throw new Error(`scenes.tsx has no scene for ${missing.map((s) => `"${s.id}"`).join(', ')}.`);
  // Scenes play in the script's order.
  const scenes = episode.script.scenes.map((s) => episode.scenes.find((d) => d.id === s.id) as LessonScene);
  const contexts = scenes.map((scene) => contextFor(plan, scene));

  const keys: RayKey[] = [];
  const moods: MoodCue[] = [];
  const waves: number[] = [];
  const hops: number[] = [];
  const rolls: number[] = [];
  const squishes: number[] = [];
  const gaze: Array<[number, number, number]> = [];
  scenes.forEach((scene, i) => {
    const ctx = contexts[i];
    const part = scene.ray(ctx);
    const start = ctx.span.from;
    const next = contexts[i + 1]?.span.from ?? Infinity;
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
  const speech: Speech[] = plan.order
    .map((id) => plan.beats[id])
    .filter((b) => b.line)
    .map((b) => ({ f: b.from, line: b.line! }));

  const sfx = scenes.flatMap((scene, i) => (scene.sfx?.(contexts[i]) ?? []).map((cue) => ({ ...cue, at: contexts[i].span.from + cue.f })));

  // The bed: ducked under the voice with a fast attack and a slow release, and scaled per
  // scene (silent under the jingle), easing between scenes.
  const fps = plan.fps;
  const speaking = new Array<boolean>(plan.total + 1).fill(false);
  for (const s of speech) {
    const from = s.f + Math.round((s.line.speechStartMs / 1000) * fps);
    const to = s.f + Math.round((s.line.speechEndMs / 1000) * fps);
    for (let f = Math.max(0, from - 3); f <= Math.min(plan.total, to); f++) speaking[f] = true;
  }
  const bedKeys = scenes.flatMap((scene, i) => {
    const from = contexts[i].span.from;
    const before = scenes[Math.max(0, i - 1)].bed ?? 1;
    return [[from, before] as const, [from + 12, scene.bed ?? 1] as const];
  });
  const music: number[] = [];
  let v = MUSIC_BED;
  for (let f = 0; f <= plan.total; f++) {
    const target = speaking[f] ? MUSIC_UNDER_VOICE : MUSIC_BED;
    v += (target - v) * (target < v ? 0.35 : 0.08);
    const fadeIn = Math.min(1, f / 12);
    const fadeOut = Math.min(1, (plan.total - f) / 45);
    music.push(v * fadeIn * fadeOut * track(f, bedKeys));
  }

  const water = (pick: (s: LessonScene) => number | undefined) =>
    scenes.flatMap((scene, i) => {
      const from = contexts[i].span.from;
      const before = pick(scenes[Math.max(0, i - 1)]) ?? 0;
      return [[from, before] as const, [from + WATER_RAMP, pick(scene) ?? 0] as const];
    });

  const built: Built = {
    plan,
    contexts,
    scenes,
    performance: { keys, moods, waves, hops, rolls, squishes, gaze, speech },
    sfx,
    music,
    depth: water((s) => s.depth),
    dim: water((s) => s.dim),
  };
  cache.set(episode, built);
  return built;
}

function Music({ src, level }: { src: string; level: number[] }): JSX.Element {
  const frame = useCurrentFrame();
  return <Audio src={staticFile(src)} loop volume={level[Math.min(frame, level.length - 1)]} />;
}

function SfxClip({ cue }: { cue: SfxCue }): JSX.Element {
  const frame = useCurrentFrame();
  const base = (cue.volume ?? 0.5) * SFX_LEVEL;
  const tail = cue.duration ? Math.min(1, Math.max(0, (cue.duration - frame) / 5)) : 1;
  return <Audio src={staticFile(`audio/sfx/${cue.id}.mp3`)} volume={base * tail} />;
}

export interface ShowProps {
  episode: Episode;
  theme: ThemeName;
  /** The series' music bed in public/, looped under the whole lesson. */
  music?: string;
  /**
   * A final render: audio that's missing from public/ is an error. Otherwise (the Studio, contact
   * sheets, drafts) it's left out, so a lesson can be seen before its voice and effects exist.
   */
  strict?: boolean;
}

/** The audio a lesson needs that public/ doesn't have, with the command that makes each. */
export function missingAudio(built: Built, files: ReadonlySet<string>, music?: string): string[] {
  const missing = new Set<string>();
  for (const id of built.plan.order) {
    const line = built.plan.beats[id].line;
    if (line && !line.file) missing.add(`the voice for "${id}" (npm run lesson:voice)`);
    else if (line && !files.has(line.file)) missing.add(`${line.file} (npm run lesson:voice)`);
  }
  for (const cue of built.sfx) if (!files.has(`audio/sfx/${cue.id}.mp3`)) missing.add(`audio/sfx/${cue.id}.mp3 (npm run sfx -- ${cue.id})`);
  if (music && !files.has(music)) missing.add(`${music} (npm run lesson:music)`);
  return [...missing];
}

/** A lesson: its scenes over the water, Ray, his voice, the effects and the ducked music. */
export function Show({ episode, theme, music, strict = false }: ShowProps): JSX.Element {
  const frame = useCurrentFrame();
  const built = build(episode);
  const { plan, contexts, scenes, performance } = built;
  const files = publicFiles();
  if (strict) {
    const missing = missingAudio(built, files, music);
    if (missing.length) throw new Error(`Lesson ${episode.script.number} needs audio that public/ doesn't have:\n${missing.join('\n')}`);
  }
  const glance = (f: number) => {
    let x = 0;
    let y = 0.1;
    for (const [at, gx, gy] of performance.gaze) {
      if (f < at) break;
      const p = ease.inOut(Math.min(1, (f - at) / 6));
      x += (gx - x) * p;
      y += (gy - y) * p;
    }
    return { x, y };
  };
  return (
    <ThemeProvider value={THEMES[theme]}>
      <AbsoluteFill data-theme={theme} style={{ background: THEMES[theme].base }}>
        <Ocean dim={track(frame, built.dim)} />
        <Depths depth={track(frame, built.depth)} />

        {scenes.map((scene, i) => {
          const ctx = contexts[i];
          const View = scene.View;
          return (
            <Sequence key={scene.id} name={scene.id} from={ctx.span.from} durationInFrames={ctx.span.duration}>
              <View ctx={ctx} />
            </Sequence>
          );
        })}

        <RayActor
          size={RAY_SIZE}
          keys={performance.keys}
          moods={performance.moods}
          speech={performance.speech}
          waves={performance.waves}
          hops={performance.hops}
          rolls={performance.rolls}
          squishes={performance.squishes}
          gaze={glance}
          seed={3}
        />

        {plan.order.map((id) => {
          const beat = plan.beats[id];
          if (!beat.line?.file || !files.has(beat.line.file)) return null;
          return (
            <Sequence key={id} name={`voice: ${id}`} from={beat.from} durationInFrames={beat.duration + 4}>
              <Audio src={staticFile(beat.line.file)} volume={VOICE} />
            </Sequence>
          );
        })}
        {built.sfx.map((cue, i) =>
          files.has(`audio/sfx/${cue.id}.mp3`) ? (
            <Sequence key={i} name={`sfx: ${cue.id}`} from={cue.at} durationInFrames={cue.duration ?? plan.fps * 4}>
              <SfxClip cue={cue} />
            </Sequence>
          ) : null,
        )}
        {music && files.has(music) ? (
          <Sequence name="music" from={0} durationInFrames={plan.total}>
            <Music src={music} level={built.music} />
          </Sequence>
        ) : null}
      </AbsoluteFill>
    </ThemeProvider>
  );
}
