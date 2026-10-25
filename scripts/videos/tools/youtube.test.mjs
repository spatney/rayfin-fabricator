import assert from 'node:assert/strict';
import test from 'node:test';
import { describe, END_SLOTS, endScreenWindow, sourcesOf, studioTime, timestamp, uploadSpec, youtubeChapters } from '../src/show/youtube.ts';

const FPS = 30;

test('timestamps read like YouTube’s', () => {
  assert.equal(timestamp(0), '0:00');
  assert.equal(timestamp(9.9), '0:09');
  assert.equal(timestamp(75), '1:15');
  assert.equal(timestamp(3725), '1:02:05');
});

test('Studio’s editors take times as m:ss:ff', () => {
  assert.equal(studioTime(200, FPS), '3:20:00');
  assert.equal(studioTime(6538 / FPS, FPS), '3:37:28');
  assert.equal(studioTime(59.99, FPS), '1:00:00');
});

test('the end screen starts at the first whole second of the slots, for at most 20 s', () => {
  // Lesson 1: the slots arrive at 3:19.83 in a 3:37.93 video.
  assert.deepEqual(endScreenWindow({ fps: FPS, total: 6538, scenes: { next: { from: 5995, duration: 0, first: 0 } } }), { from: 200, to: 6538 / FPS, problems: [] });
  // Slots that arrive earlier than 20 s from the end wait for the last 20 s.
  assert.equal(endScreenWindow({ fps: FPS, total: FPS * 100, scenes: { next: { from: FPS * 60, duration: 0, first: 0 } } }).from, 80);
  // Too late to be an end screen.
  assert.match(endScreenWindow({ fps: FPS, total: FPS * 100, scenes: { next: { from: FPS * 97, duration: 0, first: 0 } } }).problems[0], /lasts 3\.0 s/);
});

test('the first chapter starts at 0:00, and short chapters fold into the one before', () => {
  const { chapters, problems } = youtubeChapters(
    [
      { title: 'Hook', from: 9 },
      { title: 'Short', from: 30 * 20 },
      { title: 'Middle', from: 30 * 25 },
      { title: 'End', from: 30 * 60 },
    ],
    FPS,
    30 * 90,
  );
  assert.deepEqual(chapters, [
    { title: 'Hook', seconds: 0 },
    { title: 'Middle', seconds: 25 },
    { title: 'End', seconds: 60 },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"Short" is under 10 s/);
});

test('a first chapter under ten seconds takes in the ones after it, rather than voiding them all', () => {
  const { chapters, problems } = youtubeChapters(
    [
      { title: 'Hook', from: 0 },
      { title: 'Welcome', from: 30 * 6 },
      { title: 'Middle', from: 30 * 40 },
      { title: 'End', from: 30 * 80 },
    ],
    FPS,
    30 * 120,
  );
  assert.deepEqual(chapters, [
    { title: 'Hook', seconds: 0 },
    { title: 'Middle', seconds: 40 },
    { title: 'End', seconds: 80 },
  ]);
  assert.deepEqual(problems, ['"Welcome" starts under 10 s in, so it\'s folded into "Hook".']);
  // Every chapter YouTube gets is at least ten seconds long.
  const ends = [...chapters.slice(1).map((c) => c.seconds), 120];
  chapters.forEach((c, i) => assert.ok(ends[i] - c.seconds >= 10, `${c.title} is ${ends[i] - c.seconds} s`));
});

test('fewer than three chapters are not listed', () => {
  const { chapters, problems } = youtubeChapters(
    [
      { title: 'A', from: 0 },
      { title: 'B', from: 30 * 30 },
    ],
    FPS,
    30 * 60,
  );
  assert.deepEqual(chapters, []);
  assert.match(problems.at(-1), /Only 2 chapters/);
});

test('the description has the summary, chapters, each source once, the challenge and the disclaimer', () => {
  const script = {
    number: 1,
    slug: '01-x',
    title: 'X',
    rayfinVersion: '1.2.3',
    scenes: [
      { id: 's', beats: [{ id: 'a', text: 'One.', sources: ['https://rayfin.ai/docs', 'https://rayfin.ai/docs/data'] }, { id: 'b', text: 'Two.', sources: ['https://rayfin.ai/docs'] }] },
    ],
  };
  assert.deepEqual(sourcesOf(script), ['https://rayfin.ai/docs', 'https://rayfin.ai/docs/data']);
  const plan = {
    fps: FPS,
    total: 30 * 100,
    chapters: [
      { title: 'Start', from: 0 },
      { title: 'Middle', from: 30 * 40 },
      { title: 'End', from: 30 * 80 },
    ],
  };
  const spec = { title: 'T', summary: 'The summary.', challenge: { task: 'Do the thing.', prompt: 'Build it.', question: 'What did you build?' }, thumbnail: { kicker: '', lines: [] }, next: null };
  const series = { name: 'S', links: { fabricator: 'https://f', channel: 'https://c' }, disclaimer: 'Not official.', hashtags: ['#A', '#B'] };
  const { text, problems } = describe(spec, script, plan, series);
  assert.deepEqual(problems, []);
  assert.ok(text.startsWith('The summary.\n'));
  assert.match(text, /Chapters\n0:00 Start\n0:40 Middle\n1:20 End\n/);
  assert.match(text, /Learn more \(checked against Rayfin 1\.2\.3\)\n• https:\/\/rayfin\.ai\/docs\n• https:\/\/rayfin\.ai\/docs\/data\n/);
  assert.match(text, /Ray’s challenge: Do the thing\.\nTry this in Fabricator’s chat:\n“Build it\.”\nWhat did you build\?/);
  assert.ok(text.endsWith('Not official.\n\n#A #B'));
});

test('the upload spec: tags once each, the challenge to pin, the end screen in Studio’s time, and YouTube’s limits', () => {
  const script = { number: 3, slug: '03-x', title: 'X', rayfinVersion: '1.2.3', scenes: [{ id: 's', beats: [{ id: 'a', text: 'One.' }] }] };
  const plan = {
    fps: FPS,
    total: 30 * 100,
    chapters: [
      { title: 'Start', from: 0 },
      { title: 'Middle', from: 30 * 40 },
      { title: 'End', from: 30 * 80 },
    ],
    scenes: { next: { from: 30 * 85, duration: 0, first: 0 } },
  };
  const spec = { title: 'T', summary: 'S.', challenge: { task: 'Do it.', prompt: 'Build it.', question: 'What did you build?' }, thumbnail: { kicker: '', lines: [] }, next: { number: 4, title: 'Next' }, tags: ['b', 'c'] };
  const series = { name: 'The series', links: { fabricator: 'https://f', channel: 'https://c' }, disclaimer: 'Not official.', hashtags: ['#A'], tags: ['a', 'b'] };
  const up = uploadSpec(spec, script, plan, series);
  assert.equal(up.lesson, 3);
  assert.deepEqual(up.tags, ['a', 'b', 'c']);
  assert.equal(up.pinnedComment, 'Ray’s challenge: Do it.\nTry this in Fabricator’s chat:\n“Build it.”\nWhat did you build?');
  assert.ok(up.description.includes(up.pinnedComment));
  assert.deepEqual(up.endScreen, { from: 85, to: 100, start: '1:25:00', slots: END_SLOTS });
  assert.equal(up.playlist, 'The series');
  assert.equal(up.madeForKids, false);
  assert.deepEqual(up.problems, []);
  assert.match(uploadSpec({ ...spec, title: 'x'.repeat(101) }, script, plan, series).problems[0], /101 characters/);
});
