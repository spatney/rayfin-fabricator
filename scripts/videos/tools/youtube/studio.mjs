// What the YouTube steps share: what they know about the channel and a lesson, Studio's tab and
// dialogs, where the end screen's elements go, and a few page helpers.
//
// The driver runs for hours, so the channel and the lessons are read fresh for every step (Node
// would otherwise keep its first copy of each): edits to lessons/channel.ts, lessons/series.ts
// or a lesson's files apply at once, without restarting it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { planLesson } from '../../src/show/plan.ts';
import { uploadSpec } from '../../src/show/youtube.ts';
import { loadLesson } from '../lesson.mjs';
import { REPO } from '../paths.mjs';

export const STUDIO = 'https://studio.youtube.com';
/** The lessons' frame, which END_SLOTS is measured in. */
export const FRAME = { width: 1920, height: 1080 };
/** How every pinned challenge starts (pinnedComment in src/show/youtube.ts). */
export const CHALLENGE = 'Ray’s challenge:';

const LESSONS = new URL('../../lessons/', import.meta.url);
/** A lesson's files that its package is made from, as lesson:package checks them. */
const PACKAGED_FROM = ['script.ts', 'scenes.tsx', 'snippets.ts', 'youtube.ts', 'timeline.json'];

/** Imports a module again, rather than Node's cached copy. */
const fresh = (url) => import(`${url.href}?v=${Date.now()}`);

/** lessons/channel.ts, as it is now. */
export async function loadChannel() {
  return (await fresh(new URL('channel.ts', LESSONS))).CHANNEL;
}

/**
 * `['endscreen', '--lesson', '1', '--replace']` → `{ _: ['endscreen'], lesson: '1', replace: true }`.
 * `--key=value` works too, for values that start with a dash (some video ids do).
 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) out[key] = true;
    else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

/** An option's value, or undefined if it isn't given; an option given without a value is an error. */
export function stringArg(args, key) {
  const value = args[key];
  if (value === true || value === '') throw new Error(`--${key} needs a value.`);
  return value;
}

/** The lesson a step is for, from `--lesson <n>`. */
export function lessonOf(args) {
  const value = args.lesson;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1) throw new Error('Name the lesson: --lesson <n>.');
  return Number(value);
}

/**
 * What a step needs to know about a lesson, from its files as they are now: what
 * `lesson:package` writes to upload.json. `files` holds the packaged video, thumbnail and
 * captions when upload.json is at least as new as the files they're made from; otherwise it's
 * null, and `stale` names the files that changed since. The steps that only change a published
 * video (the end screen, the comment) don't need them.
 */
export async function loadUpload(n) {
  const lesson = await loadLesson(n, { fresh: true });
  const { SERIES } = await fresh(new URL('series.ts', LESSONS));
  const spec = uploadSpec(lesson.youtube, lesson.script, planLesson(lesson.script, lesson.timeline), SERIES);
  delete spec.problems;
  const file = path.join(lesson.out, 'youtube', 'upload.json');
  let files = null;
  let stale = null;
  if (existsSync(file)) {
    const packaged = statSync(file).mtimeMs;
    const sources = [...PACKAGED_FROM.map((f) => path.join(lesson.dir, f)), path.join(lesson.dir, '..', 'series.ts')];
    const newer = sources.filter((f) => existsSync(f) && statSync(f).mtimeMs > packaged);
    if (newer.length) stale = newer.map((f) => path.relative(REPO, f).replace(/\\/g, '/'));
    else files = JSON.parse(readFileSync(file, 'utf8')).files;
  }
  return { ...spec, files, stale };
}

/** The lesson's packaged files, for the steps that upload them. */
export function filesOf(up) {
  if (up.files) return up.files;
  const remake = `npm run lesson:render -- ${up.lesson}, then npm run lesson:package -- ${up.lesson}`;
  if (up.stale) throw new Error(`Lesson ${up.lesson}'s package is older than ${up.stale.join(', ')}. Make it again: ${remake}.`);
  throw new Error(`Lesson ${up.lesson} isn't packaged on this machine: ${remake}.`);
}

/** Text compared the way YouTube shows it: whitespace collapsed. */
export const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * The challenge comments the channel posted on the open watch page, top-level only: where each
 * is in the list of threads, its text, and whether it's pinned. Load the comments first.
 */
export async function challengeComments(page, handle) {
  const all = await page.locator('ytd-comment-thread-renderer').evaluateAll((threads) =>
    threads.map((t) => ({
      author: t.querySelector('#author-text')?.textContent.trim() ?? '',
      text: t.querySelector('#content-text')?.innerText.trim() ?? '',
      // The badge's element is on every comment; a pinned one's says "Pinned by …".
      pinned: Boolean(t.querySelector('#pinned-comment-badge')?.textContent.trim()),
    })),
  );
  return all.map((c, index) => ({ ...c, index })).filter((c) => c.author === handle && c.text.startsWith(CHALLENGE));
}

/** Scrolls a watch page down until its comments load. */
export async function loadComments(page) {
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(900);
  }
  await page.locator('ytd-comments #simple-box, ytd-comments-header-renderer').first().waitFor({ timeout: 30000 });
}

/**
 * Where the end screen's elements go in Studio's end-screen editor, whose preview is the frame
 * scaled by `scale` (the preview's width over 1920): the box for the video or playlist element
 * over the video slot, and the center of the round subscribe slot (null when there's none, as on
 * the intro).
 */
export function endScreenTargets(slots, scale) {
  const v = slots.video;
  const s = slots.subscribe;
  return {
    video: { left: v.x * scale, top: v.y * scale, width: v.w * scale, height: v.h * scale },
    subscribe: s ? { cx: s.x * scale, cy: s.y * scale } : null,
  };
}

/** An end-screen element's box in the editor's preview, from its inline style. */
export function styleBox(style) {
  const px = (key) => Number(new RegExp(`(?:^|;)\\s*${key}:\\s*(-?[\\d.]+)px`).exec(style ?? '')?.[1] ?? Number.NaN);
  return { left: px('left'), top: px('top'), width: px('width'), height: px('height') };
}

/** Studio's tab: the first one on studio.youtube.com, or a new one opened there. */
export async function studioTab(context) {
  const pages = context.pages().filter((p) => !p.url().startsWith('devtools://'));
  const open = pages.find((p) => p.url().startsWith(STUDIO));
  if (open) return open;
  const page = await context.newPage();
  await page.goto(`${STUDIO}/`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** Whether a Studio page is signed in, and which channel it's working on, from its config. */
export async function studioChannel(page) {
  return page.evaluate(() => {
    const get = (key) => {
      try {
        return window.ytcfg?.get?.(key) ?? null;
      } catch {
        return null;
      }
    };
    return { signedIn: get('LOGGED_IN') === true, channelId: get('CHANNEL_ID') };
  });
}

/**
 * Studio's upload dialog, which stays open from the upload step to the publish step. Since
 * October 2026 the element itself has no height, so it never counts as visible: steps check, and
 * work inside, its panel, `.locator('tp-yt-paper-dialog').first()`, which holds every control.
 */
export const uploadsDialog = (page) => page.locator('ytcp-uploads-dialog');

/** Drags with the mouse in small moves, the way Studio's editors expect. */
export async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/**
 * A tab on youtube.com for a step to use: kept between steps, and otherwise one that's open
 * already, or a new one. It becomes the step's active tab, which the driver screenshots if the
 * step fails.
 */
export async function watchTab(context, state) {
  if (!state.watch || state.watch.isClosed()) state.watch = context.pages().find((p) => p.url().startsWith('https://www.youtube.com/')) ?? (await context.newPage());
  await state.watch.bringToFront();
  state.active = state.watch;
  return state.watch;
}

/** Mutes and pauses a watch page's video, so a step never plays it out loud. */
export async function hush(page) {
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      v.pause();
    }
  });
}

/** A public or unlisted video's title and channel, as anyone logged out sees them; null otherwise. */
export async function oembed(id) {
  const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://youtu.be/${id}`)}&format=json`);
  return res.ok ? res.json() : null;
}
