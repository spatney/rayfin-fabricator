import assert from 'node:assert/strict';
import test from 'node:test';
import { GAP_LINE, GAP_SCENE, LEAD, checkScript, draftTimeline, findWord, isVoiced, planLesson, sayText, unsayWords } from '../src/show/plan.ts';
import { OVERLAP } from '../src/timing.ts';

const FPS = 30;
const f = (s) => Math.round(s * FPS);

const script = {
  number: 9,
  slug: '09-test',
  title: 'Test',
  rayfinVersion: '1.0.0',
  endHold: 1,
  scenes: [
    { id: 'one', chapter: 'First', beats: [{ id: 'a', text: '[excited] Hello there, friend.' }, { id: 'b', text: 'Hello again.' }] },
    { id: 'two', lead: 0.5, beats: [{ id: 'pause', hold: 2 }] },
    { id: 'three', chapter: 'Last', beats: [{ id: 'c', text: 'Goodbye, friend.', gap: 1 }] },
  ],
};

const line = (id, caption, durationMs, words) => ({ id, file: `audio/x/${id}.mp3`, durationMs, speechStartMs: 0, speechEndMs: durationMs, caption, words, envelope: [] });
const timeline = {
  fps: FPS,
  tempo: 1,
  voice: { name: 'v', voiceId: 'v', modelId: 'm', seed: 1 },
  lines: [
    line('a', 'Hello there, friend.', 2000, [
      { text: 'Hello', startMs: 0, endMs: 400 },
      { text: 'there,', startMs: 500, endMs: 900 },
      { text: 'friend.', startMs: 1000, endMs: 1500 },
    ]),
    line('b', 'Hello again.', 1000, [
      { text: 'Hello', startMs: 0, endMs: 400 },
      { text: 'again.', startMs: 500, endMs: 900 },
    ]),
    line('c', 'Goodbye, friend.', 1500, [
      { text: 'Goodbye,', startMs: 100, endMs: 600 },
      { text: 'friend.', startMs: 700, endMs: 1200 },
    ]),
  ],
};

test('beats play in order, each after its gap; holds take their own length', () => {
  const plan = planLesson(script, timeline);
  const a = f(GAP_SCENE);
  assert.equal(plan.beats.a.from, a);
  assert.equal(plan.beats.a.duration, 60);
  const b = a + 60 + f(GAP_LINE);
  assert.equal(plan.beats.b.from, b);
  const pause = b + 30 + f(GAP_SCENE);
  assert.equal(plan.beats.pause.from, pause);
  assert.equal(plan.beats.pause.duration, 60);
  assert.equal(plan.beats.pause.line, undefined);
  const c = pause + 60 + 30;
  assert.equal(plan.beats.c.from, c);
  assert.equal(plan.total, c + 45 + 30);
  assert.deepEqual(plan.order, ['a', 'b', 'pause', 'c']);
});

test('a scene starts its lead before its first beat and runs into the next by OVERLAP; the first starts the video', () => {
  const plan = planLesson(script, timeline);
  assert.equal(plan.scenes.one.from, 0);
  assert.equal(plan.scenes.one.first, plan.beats.a.from);
  // Scene two sets its own lead; scene three takes the default.
  assert.equal(plan.scenes.two.from, plan.beats.pause.from - f(0.5));
  assert.equal(plan.scenes.three.from, plan.beats.c.from - f(LEAD));
  assert.equal(plan.scenes.one.from + plan.scenes.one.duration, plan.scenes.two.from + OVERLAP);
  assert.equal(plan.scenes.three.from + plan.scenes.three.duration, plan.total);
  assert.deepEqual(
    plan.chapters.map((c) => c.title),
    ['First', 'Last'],
  );
  assert.equal(plan.chapters[1].from, plan.scenes.three.from);
});

test('a line without a clip, or one whose words changed, is caught', () => {
  assert.throws(() => planLesson(script, { ...timeline, lines: timeline.lines.slice(1) }), /no line "a"/);
  const changed = { ...timeline, lines: [line('a', 'Something else.', 1000, []), ...timeline.lines.slice(1)] };
  assert.throws(() => planLesson(script, changed), /"a" changed since it was voiced/);
});

test('scripts with duplicate ids, or beats both said and held, are refused', () => {
  const dup = { ...script, scenes: [...script.scenes, { id: 'four', beats: [{ id: 'a', text: 'Again.' }] }] };
  assert.throws(() => checkScript(dup), /"a" appears twice/);
  const both = { ...script, scenes: [{ id: 'x', beats: [{ id: 'x1', text: 'Hi.', hold: 1 }] }] };
  assert.throws(() => checkScript(both), /not both/);
  const neither = { ...script, scenes: [{ id: 'x', beats: [{ id: 'x1' }] }] };
  assert.throws(() => checkScript(neither), /not neither/);
});

test('a draft timeline keeps voiced lines and drafts the rest', () => {
  const partial = { ...timeline, lines: [timeline.lines[0]] };
  const draft = draftTimeline(script, partial);
  assert.equal(draft.lines.length, 3);
  assert.equal(draft.lines[0], timeline.lines[0]);
  assert.equal(draft.lines[1].file, '');
  assert.equal(draft.lines[1].caption, 'Hello again.');
  assert.deepEqual(
    draft.lines[1].words.map((w) => w.text),
    ['Hello', 'again.'],
  );
  assert.ok(draft.lines[1].words[1].startMs > draft.lines[1].words[0].endMs);
  assert.equal(isVoiced(script, partial), false);
  assert.equal(isVoiced(script, timeline), true);
  // A drafted lesson lays out like a voiced one.
  assert.ok(planLesson(script, draft).total > 0);
});

test('words are found across a scene’s beats, in order', () => {
  const plan = planLesson(script, timeline);
  const beats = [plan.beats.a, plan.beats.b];
  assert.equal(findWord(beats, FPS, 'hello'), plan.beats.a.from);
  assert.equal(findWord(beats, FPS, 'Hello', { nth: 2 }), plan.beats.b.from);
  assert.equal(findWord(beats, FPS, 'friend', { edge: 'end' }), plan.beats.a.from + f(1.5));
  assert.throws(() => findWord(beats, FPS, 'Goodbye'), /"Goodbye" \(#1\) isn't in a, b/);
});

test('a typographic apostrophe matches a straight one', () => {
  const curly = { ...timeline.lines[0], words: [{ text: 'Let’s', startMs: 0, endMs: 300 }, { text: 'go.', startMs: 400, endMs: 700 }] };
  const beat = { id: 'x', scene: 's', from: 100, duration: 30, line: curly };
  assert.equal(findWord([beat], FPS, "Let's"), 100);
  assert.equal(findWord([beat], FPS, 'go', { edge: 'end' }), 100 + f(0.7));
});

test('a respelling changes what the voice reads, and maps back onto the written word', () => {
  const say = { APIs: "API's" };
  const text = 'Rayfin makes your table, APIs, typed client and security. RESTAPIs stay.';
  assert.equal(sayText(text, say), "Rayfin makes your table, API's, typed client and security. RESTAPIs stay.");
  assert.equal(sayText(text), text);
  const words = [
    { text: 'table,', startMs: 0, endMs: 300 },
    { text: "API's,", startMs: 380, endMs: 1200 },
    { text: 'typed', startMs: 1300, endMs: 1600 },
    { text: 'API’s', startMs: 1700, endMs: 2300 },
  ];
  assert.deepEqual(
    unsayWords(words, say).map((w) => w.text),
    ['table,', 'APIs,', 'typed', 'APIs'],
  );
  assert.equal(unsayWords(words, say)[1].endMs, 1200);
  assert.deepEqual(unsayWords(words), words);
});

test('a respelling can be several words, and maps back onto the word as written', () => {
  const say = { 'rayfin.yml': 'rayfin dot yaml', '.env': 'dot env' };
  const text = 'The rayfin folder holds rayfin.yml: and .env.';
  assert.equal(sayText(text, say), 'The rayfin folder holds rayfin dot yaml: and dot env.');
  const words = [
    { text: 'The', startMs: 0, endMs: 100 },
    { text: 'rayfin', startMs: 120, endMs: 400 },
    { text: 'folder', startMs: 420, endMs: 700 },
    { text: 'holds', startMs: 720, endMs: 900 },
    { text: 'rayfin', startMs: 950, endMs: 1200 },
    { text: 'dot', startMs: 1220, endMs: 1400 },
    { text: 'yaml:', startMs: 1420, endMs: 1800 },
    { text: 'and', startMs: 1900, endMs: 2000 },
    { text: 'dot', startMs: 2050, endMs: 2200 },
    { text: 'env.', startMs: 2220, endMs: 2500 },
  ];
  assert.deepEqual(unsayWords(words, say), [
    { text: 'The', startMs: 0, endMs: 100 },
    { text: 'rayfin', startMs: 120, endMs: 400 },
    { text: 'folder', startMs: 420, endMs: 700 },
    { text: 'holds', startMs: 720, endMs: 900 },
    { text: 'rayfin.yml:', startMs: 950, endMs: 1800 },
    { text: 'and', startMs: 1900, endMs: 2000 },
    { text: '.env.', startMs: 2050, endMs: 2500 },
  ]);
  // Punctuation inside a respelling's run means the voice didn't read it as one word.
  const broken = [
    { text: 'rayfin,', startMs: 0, endMs: 300 },
    { text: 'dot', startMs: 320, endMs: 500 },
    { text: 'yaml', startMs: 520, endMs: 800 },
  ];
  assert.deepEqual(unsayWords(broken, say), broken);
});

test('a respelling has to say something, of a word the line has', () => {
  const scene = (beat) => ({ ...script, scenes: [{ id: 'x', beats: [{ id: 'x1', text: 'Fabric hosts the APIs.', ...beat }] }] });
  assert.doesNotThrow(() => checkScript(scene({ say: { APIs: "API's" } })));
  assert.doesNotThrow(() => checkScript(scene({ say: { APIs: 'A P Is' } })));
  assert.throws(() => checkScript(scene({ say: { APIs: ' ' } })), /as nothing/);
  assert.throws(() => checkScript(scene({ say: { SQL: 'sequel' } })), /doesn't have that word/);
});
