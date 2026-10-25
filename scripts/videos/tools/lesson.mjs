// Finds a lesson by its number, and everything the lesson tools need to know about it: its
// folder, script, YouTube spec, snippets and timeline, and where its audio and outputs go.
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT, PUBLIC, ROOT } from './paths.mjs';

export const LESSONS_DIR = path.join(ROOT, 'lessons');

/** Lesson folders, such as `01-what-is-rayfin`, in order. */
export function lessonFolders() {
  return readdirSync(LESSONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{2}-[a-z0-9-]+$/.test(d.name))
    .map((d) => d.name)
    .sort();
}

/** `Lesson01` for lesson 1. */
export const compositionOf = (n) => `Lesson${String(n).padStart(2, '0')}`;

/** Reads the lesson number from the command line: the first argument that is one. */
export function lessonArg(argv = process.argv.slice(2)) {
  const n = Number(argv.find((a) => /^\d+$/.test(a)));
  if (!Number.isInteger(n) || n < 1) throw new Error('Name the lesson by its number, for example: npm run lesson:voice -- 1');
  return n;
}

/**
 * The lesson's files and where its outputs go. `fresh` imports its files again rather than from
 * Node's module cache, for long-running tools (the YouTube driver) that must see edits.
 */
export async function loadLesson(n, { fresh = false } = {}) {
  const slug = lessonFolders().find((d) => Number(d.slice(0, 2)) === n);
  if (!slug) throw new Error(`lessons/ has no folder for lesson ${n}. Start one with npm run lesson:new -- ${n} <slug> "<title>".`);
  const dir = path.join(LESSONS_DIR, slug);
  const version = fresh ? `?v=${Date.now()}` : '';
  const load = (file) => import(pathToFileURL(path.join(dir, file)).href + version);
  const { SCRIPT } = await load('script.ts');
  const { YOUTUBE } = await load('youtube.ts');
  const snippets = existsSync(path.join(dir, 'snippets.ts')) ? ((await load('snippets.ts')).SNIPPETS ?? {}) : {};
  const timelinePath = path.join(dir, 'timeline.json');
  const timeline = JSON.parse(await readFile(timelinePath, 'utf8'));
  if (SCRIPT.number !== n || SCRIPT.slug !== slug) throw new Error(`lessons/${slug}/script.ts says it's lesson ${SCRIPT.number} (${SCRIPT.slug}).`);
  return {
    number: n,
    slug,
    dir,
    script: SCRIPT,
    youtube: YOUTUBE,
    snippets,
    timeline,
    timelinePath,
    composition: compositionOf(n),
    thumbnail: `${compositionOf(n)}Thumbnail`,
    /** Where the voice clips go, on disk and as the video loads them. */
    voDir: path.join(PUBLIC, 'audio', 'lessons', slug, 'vo'),
    voPublic: `audio/lessons/${slug}/vo`,
    out: path.join(OUT, 'lessons', slug),
    video: path.join(OUT, 'lessons', slug, `${slug}.mp4`),
  };
}
