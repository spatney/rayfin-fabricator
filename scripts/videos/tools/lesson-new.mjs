// Starts a new lesson.
//
//   npm run lesson:new -- 2 your-first-app "Your first Rayfin app"
//
// Creates lessons/<NN>-<slug>/ with a script to write (script.ts), its YouTube details
// (youtube.ts), the code it shows (snippets.ts), draft scenes (scenes.tsx) and an empty
// timeline, adds it to lessons/index.ts, and marks it as scripting in SYLLABUS.md. The draft
// scenes play the script as an animatic straight away, in npm run studio.
//
// Every line starts as a TODO, and lesson:voice refuses to voice a TODO.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LESSONS_DIR, loadLesson, lessonFolders } from './lesson.mjs';
import { SERIES } from '../lessons/series.ts';

const scriptTs = ({ n, slug, title, version }) => `/**
 * Lesson ${n}: ${title}. What Ray says, beat by beat. The single source of truth for the
 * lesson's voice, its captions and chapters, and its scenes (scenes.tsx), which find beats
 * and words here by id.
 *
 * Check every claim against Rayfin ${version}: rayfin.ai and the installed packages' own docs
 * for Rayfin, the Fabricator docs for Fabricator. List the pages each line rests on.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

export const SCRIPT = {
  number: ${n},
  slug: '${slug}',
  title: '${title.replace(/'/g, "\\'")}',
  rayfinVersion: '${version}',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'TODO: the hook, as a chapter title',
      lead: 0.3,
      beats: [{ id: 'hook', text: 'TODO: the hook, a question with a visual payoff.', sources: [R] }],
    },
    { id: 'bumper', lead: 0.2, beats: [{ id: 'jingle', hold: 3.4 }] },
    {
      id: 'welcome',
      beats: [
        { id: 'welcome', text: "[delighted] Hi, I'm Ray! Welcome back to Learn Rayfin with Ray." },
        { id: 'today', text: 'TODO: Today: three things, each a few words.' },
      ],
    },
    {
      id: 'concept',
      chapter: 'TODO: the first idea',
      beats: [{ id: 'concept-1', text: 'TODO: one idea per line, each under about 25 words.', sources: [R] }],
    },
    {
      id: 'deep-dive',
      chapter: 'Deep Dive: TODO',
      beats: [
        { id: 'dive', text: "[excited] Time for a deep dive! TODO: what's under the surface." },
        { id: 'dive-1', text: 'TODO', sources: [R] },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [{ id: 'fab-1', text: "TODO: here's the same idea in Fabricator.", sources: [F] }],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: '[excited] Pop quiz! TODO: the question?' },
        { id: 'quiz-options', text: 'TODO: A, … B, … Or C, …' },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        { id: 'quiz-answer', text: "[cheering] It's TODO! TODO: why.", sources: [R] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [{ id: 'recap', text: "Let's recap. TODO: three takeaways." }],
    },
    {
      id: 'challenge',
      beats: [
        { id: 'challenge', text: 'Your challenge: TODO.', sources: [F] },
        { id: 'challenge-2', text: 'Then tell me in the comments: what did you build?' },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: 'Next time: TODO. [excited] See you in the water!' }],
    },
    {
      id: 'stinger',
      beats: [{ id: 'fact', text: '[whispers] Psst… TODO: a true ray fact (see src/renderer/src/components/mascot/lines.ts).' }],
    },
  ],
} satisfies LessonScript;
`;

const youtubeTs = ({ n, title }) => `/** Lesson ${n} on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: '${title.replace(/'/g, "\\'")}: TODO | Learn Rayfin with Ray #${n}',
  summary: 'TODO: the hook, then what the lesson covers, in two or three sentences.',
  challenge: {
    task: 'TODO: what to try in Fabricator.',
    prompt: 'TODO: a prompt to paste into Fabricator’s chat.',
    question: 'What did you build? Tell me in the comments.',
  },
  thumbnail: {
    kicker: '${title.toUpperCase().replace(/'/g, "\\'")}',
    lines: [{ text: 'TODO' }, { text: 'TODO.', accent: true }],
    mood: 'happy',
  },
  next: null,
  tags: [],
} satisfies YouTubeSpec;
`;

const snippetsTs = ({ n }) => `/**
 * The code lesson ${n} shows, and hidden checks behind what it claims. \`npm run
 * lesson:snippets -- ${n}\` type-checks all of it against the real @microsoft/rayfin-* packages.
 */
import type { Snippet } from '../../src/show/snippet.ts';

export const SNIPPETS = {} satisfies Record<string, Snippet>;
`;

const scenesTsx = ({ n }) => `import { draftScenes } from '../../src/show/draft';
import type { LessonScene } from '../../src/show/types';
import { SCRIPT } from './script';

/** Lesson ${n}'s scenes. Draft scenes stand in until the real ones are built. */
export const SCENES: readonly LessonScene[] = draftScenes(SCRIPT);
`;

const indexTs = `import { draftTimeline, isVoiced } from '../../src/show/plan';
import type { Lesson } from '../../src/show/types';
import type { Timeline } from '../../src/timing';
import { SCENES } from './scenes';
import { SCRIPT } from './script';
import timelineJson from './timeline.json';
import { YOUTUBE } from './youtube';

const timeline = timelineJson as Timeline;

export const lesson: Lesson = {
  episode: { script: SCRIPT, timeline: draftTimeline(SCRIPT, timeline), scenes: SCENES },
  youtube: YOUTUBE,
  voiced: isVoiced(SCRIPT, timeline),
};
`;

async function register(n, folder) {
  const file = path.join(LESSONS_DIR, 'index.ts');
  let text = await readFile(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const name = `lesson${String(n).padStart(2, '0')}`;
  const imports = [...text.matchAll(/^import \{ lesson as (lesson\d+) \} from '\.\/([^']+)';\r?$/gm)];
  const entries = [...imports.map((m) => ({ name: m[1], folder: m[2] })), { name, folder }].sort((a, b) => a.folder.localeCompare(b.folder));
  const block = entries.map((e) => `import { lesson as ${e.name} } from './${e.folder}';`).join(eol);
  text = imports.length
    ? text.replace(/(^import \{ lesson as lesson\d+ \} from '[^']+';\r?\n)+/m, `${block}${eol}`)
    : text.replace(/(import type \{ Lesson \}[^\n]*\n)/, `$1${block}${eol}`);
  text = text.replace(/export const LESSONS: readonly Lesson\[\] = \[[^\]]*\];/, `export const LESSONS: readonly Lesson[] = [${entries.map((e) => e.name).join(', ')}];`);
  await writeFile(file, text);
}

async function markSyllabus(n, folder) {
  const file = path.join(LESSONS_DIR, 'SYLLABUS.md');
  const lines = (await readFile(file, 'utf8')).split('\n');
  const i = lines.findIndex((l) => l.startsWith(`| ${n} |`));
  if (i === -1) {
    console.warn(`! SYLLABUS.md's status table has no row for lesson ${n}; add one.`);
    return;
  }
  const cells = lines[i].split('|');
  cells[3] = ` \`lessons/${folder}\` `;
  cells[4] = ' Scripting ';
  lines[i] = cells.join('|');
  await writeFile(file, lines.join('\n'));
}

async function main() {
  const [num, slug, ...titleWords] = process.argv.slice(2);
  const n = Number(num);
  const title = titleWords.join(' ').trim();
  if (!Number.isInteger(n) || n < 1 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug ?? '') || !title) {
    throw new Error('Usage: npm run lesson:new -- <number> <slug> "<title>", for example: npm run lesson:new -- 2 your-first-app "Your first Rayfin app"');
  }
  const folder = `${String(n).padStart(2, '0')}-${slug}`;
  const taken = lessonFolders().find((d) => Number(d.slice(0, 2)) === n);
  if (taken) throw new Error(`Lesson ${n} already has a folder: lessons/${taken}.`);
  const dir = path.join(LESSONS_DIR, folder);
  if (existsSync(dir)) throw new Error(`lessons/${folder} already exists.`);

  // Start from the newest lesson's Rayfin version; check rayfin.ai for a newer one before scripting.
  const newest = lessonFolders().at(-1);
  const version = newest ? (await loadLesson(Number(newest.slice(0, 2)))).script.rayfinVersion : '1.36.2';

  await mkdir(dir, { recursive: true });
  const ctx = { n, slug: folder, title, version };
  await writeFile(path.join(dir, 'script.ts'), scriptTs(ctx));
  await writeFile(path.join(dir, 'youtube.ts'), youtubeTs(ctx));
  await writeFile(path.join(dir, 'snippets.ts'), snippetsTs(ctx));
  await writeFile(path.join(dir, 'scenes.tsx'), scenesTsx(ctx));
  await writeFile(path.join(dir, 'index.ts'), indexTs);
  await writeFile(path.join(dir, 'timeline.json'), `${JSON.stringify({ fps: 30, voice: SERIES.voice, tempo: SERIES.tempo, lines: [] }, null, 2)}\n`);
  await register(n, folder);
  await markSyllabus(n, folder);
  console.log(`lessons/${folder}/ is ready, checked against Rayfin ${version} until you change it. Next: write script.ts, then npm run studio.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
