/**
 * A lesson's YouTube description: its chapters, its sources and its challenge. Pure and
 * React-free, so the packaging tool (through Node's type stripping) and the tests can use it.
 */
import type { ThumbnailSpec } from '../lesson-kit/Thumbnail';
import { beatsOf, type Chapter, type LessonScript, type Plan } from './plan.ts';

export interface YouTubeSpec {
  /** At most 100 characters. Lead with what the viewer learns. */
  title: string;
  /** The description's opening: the hook, and what the lesson covers. */
  summary: string;
  /** Ray's challenge: what to try, a prompt to paste into Fabricator's chat, and a question for the comments. */
  challenge: { task: string; prompt: string; question: string };
  thumbnail: ThumbnailSpec;
  /** The next lesson, for the end screen; null for the last one. */
  next: { number: number; title: string } | null;
  /** Tags on top of the series' own. */
  tags?: readonly string[];
}

export interface SeriesInfo {
  name: string;
  links: { fabricator: string; channel: string };
  disclaimer: string;
  hashtags: readonly string[];
}

/** YouTube's chapter rules: the first at 0:00, at least three, each at least ten seconds long. */
export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;

/**
 * Where a lesson's end screen leaves room for YouTube's elements, in frame pixels (1920×1080).
 * `EndScreen` draws the slots; the YouTube tools put the elements on them.
 */
export const END_SLOTS = {
  /** A 16:9 video element: the next lesson. */
  video: { x: 170, y: 330, w: 760, h: 428 },
  /** A round subscribe element. */
  subscribe: { x: 1500, y: 545, r: 120 },
} as const;

/** YouTube's end screens run for 5–20 seconds at the end of a video. */
export const END_SCREEN_MIN = 5;
export const END_SCREEN_MAX = 20;

/**
 * When the end screen's elements show, in seconds: from the first whole second of the `next`
 * scene, which draws the slots (or 20 s before the end, if that's later), to the end.
 */
export function endScreenWindow(plan: Pick<Plan, 'fps' | 'total' | 'scenes'>): { from: number; to: number; problems: string[] } {
  const to = plan.total / plan.fps;
  const slots = (plan.scenes.next?.from ?? plan.total) / plan.fps;
  const from = Math.ceil(Math.max(to - END_SCREEN_MAX, slots));
  const problems = to - from < END_SCREEN_MIN ? [`The end screen lasts ${(to - from).toFixed(1)} s; YouTube needs at least ${END_SCREEN_MIN}.`] : [];
  return { from, to, problems };
}

/** A time as YouTube Studio's editors take it: `m:ss:ff`, where `ff` is frames. */
export function studioTime(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  const s = Math.floor(frames / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${String(frames % fps).padStart(2, '0')}`;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function timestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * The chapters as YouTube wants them: the first moved to 0:00, and any shorter than ten
 * seconds folded into the one before it. `problems` says what had to change, and is non-empty
 * when there are too few chapters to list at all.
 */
export function youtubeChapters(chapters: readonly Chapter[], fps: number, totalFrames: number): { chapters: Array<{ title: string; seconds: number }>; problems: string[] } {
  const problems: string[] = [];
  const list = chapters.map((c) => ({ title: c.title, seconds: Math.floor(c.from / fps) }));
  if (list.length && list[0].seconds !== 0) {
    problems.push(`"${list[0].title}" moved from ${timestamp(list[0].seconds)} to 0:00.`);
    list[0].seconds = 0;
  }
  const total = totalFrames / fps;
  for (let i = list.length - 1; i >= 1; i--) {
    const end = i + 1 < list.length ? list[i + 1].seconds : total;
    if (end - list[i].seconds < MIN_CHAPTER_SECONDS) {
      problems.push(`"${list[i].title}" is under ${MIN_CHAPTER_SECONDS} s, so it's folded into "${list[i - 1].title}".`);
      list.splice(i, 1);
    }
  }
  // Nothing comes before the first chapter, so it takes in the ones after it until it's long enough.
  while (list.length >= 2 && list[1].seconds < MIN_CHAPTER_SECONDS) {
    problems.push(`"${list[1].title}" starts under ${MIN_CHAPTER_SECONDS} s in, so it's folded into "${list[0].title}".`);
    list.splice(1, 1);
  }
  if (list.length < MIN_CHAPTERS) problems.push(`Only ${list.length} chapters; YouTube needs at least ${MIN_CHAPTERS}, so none are listed.`);
  return { chapters: list.length >= MIN_CHAPTERS ? list : [], problems };
}

/** Every source the lesson's lines cite, in the order they're first cited. */
export function sourcesOf(script: LessonScript): string[] {
  const seen = new Set<string>();
  for (const beat of beatsOf(script)) for (const url of beat.sources ?? []) seen.add(url);
  return [...seen];
}

/** The full description, ready to paste into YouTube Studio. */
export function describe(spec: YouTubeSpec, script: LessonScript, plan: Plan, series: SeriesInfo): { text: string; problems: string[] } {
  const { chapters, problems } = youtubeChapters(plan.chapters, plan.fps, plan.total);
  const out: string[] = [spec.summary.trim(), ''];
  if (chapters.length) {
    out.push('Chapters');
    for (const c of chapters) out.push(`${timestamp(c.seconds)} ${c.title}`);
    out.push('');
  }
  const sources = sourcesOf(script);
  if (sources.length) {
    out.push(`Learn more (checked against Rayfin ${script.rayfinVersion})`);
    for (const url of sources) out.push(`• ${url}`);
    out.push('');
  }
  out.push(`Build along with Fabricator, a free, open-source desktop app for building Rayfin apps with GitHub Copilot: ${series.links.fabricator}`);
  out.push('');
  out.push(`Ray’s challenge: ${spec.challenge.task}`);
  out.push('Try this in Fabricator’s chat:');
  out.push(`“${spec.challenge.prompt}”`);
  out.push(spec.challenge.question);
  out.push('');
  out.push(series.disclaimer);
  out.push('');
  out.push(series.hashtags.join(' '));
  return { text: out.join('\n'), problems };
}

/** The comment to pin under a lesson: Ray's challenge, with the prompt to paste into Fabricator. */
export function pinnedComment(spec: YouTubeSpec): string {
  return `Ray’s challenge: ${spec.challenge.task}\nTry this in Fabricator’s chat:\n“${spec.challenge.prompt}”\n${spec.challenge.question}`;
}

/**
 * All YouTube needs to know about a lesson but its files: what `lesson:package` writes to
 * upload.json, and what the YouTube tools (tools/youtube/) read.
 */
export interface UploadSpec {
  lesson: number;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  pinnedComment: string;
  playlist: string;
  category: 'Education';
  language: 'English';
  madeForKids: false;
  next: YouTubeSpec['next'];
  fps: number;
  /** In seconds; `start` as Studio's editor takes it. */
  endScreen: { from: number; to: number; start: string; slots: typeof END_SLOTS };
  /** What breaks YouTube's limits or rules, to fix before uploading. */
  problems: string[];
}

export function uploadSpec(spec: YouTubeSpec, script: LessonScript, plan: Plan, series: SeriesInfo & { tags: readonly string[] }): UploadSpec {
  const { text: description, problems } = describe(spec, script, plan, series);
  if (spec.title.length > 100) problems.push(`The title is ${spec.title.length} characters; YouTube allows 100.`);
  if (description.length > 5000) problems.push(`The description is ${description.length} characters; YouTube allows 5,000.`);
  const tags = [...new Set([...series.tags, ...(spec.tags ?? [])])];
  if (tags.join(',').length > 500) problems.push('The tags run over YouTube’s 500 characters.');
  const end = endScreenWindow(plan);
  problems.push(...end.problems);
  return {
    lesson: script.number,
    slug: script.slug,
    title: spec.title,
    description,
    tags,
    pinnedComment: pinnedComment(spec),
    playlist: series.name,
    category: 'Education',
    language: 'English',
    madeForKids: false,
    next: spec.next,
    fps: plan.fps,
    endScreen: { from: end.from, to: end.to, start: studioTime(end.from, plan.fps), slots: END_SLOTS },
    problems,
  };
}
