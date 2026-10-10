import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCues, holdCues, toVtt, videoCues, wordsFromAlignment } from './captions.mjs';

/** An alignment where every character takes 50 ms, as ElevenLabs returns it. */
function align(text) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.05),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.05),
  };
}

test('words skip audio tags and keep their timings', () => {
  const words = wordsFromAlignment(align("[excited] Oh, hi! I'm Ray."));
  assert.deepEqual(
    words.map((w) => w.text),
    ['Oh,', 'hi!', "I'm", 'Ray.'],
  );
  assert.equal(words[0].startMs, 500);
  assert.equal(words[0].endMs, 650);
});

test('tags in the middle of a line split words cleanly', () => {
  const words = wordsFromAlignment(align('a browser… [dizzy] whoa.'));
  assert.deepEqual(
    words.map((w) => w.text),
    ['a', 'browser…', 'whoa.'],
  );
});

test('punctuation standing alone joins the word before it', () => {
  const words = wordsFromAlignment(align('Wait … what'));
  assert.deepEqual(
    words.map((w) => w.text),
    ['Wait…', 'what'],
  );
});

test('tempo scales the timings', () => {
  const [word] = wordsFromAlignment(align('Hi'), { tempo: 2 });
  assert.equal(word.startMs, 0);
  assert.equal(word.endMs, 50);
});

test('cues stay short and break after punctuation', () => {
  const words = wordsFromAlignment(align("Oh, hi! I'm Ray, the stingray who lives inside Fabricator."));
  const cues = buildCues(words, { maxChars: 42 });
  assert.deepEqual(
    cues.map((c) => c.text),
    ["Oh, hi! I'm Ray,", 'the stingray who lives inside Fabricator.'],
  );
  for (const cue of cues) assert.ok(cue.text.length <= 42);
});

test('short cues are held longer, but never into the next one', () => {
  const held = holdCues([
    { text: 'One', startMs: 0, endMs: 200 },
    { text: 'Two', startMs: 600, endMs: 900 },
  ]);
  assert.equal(held[0].endMs, 540);
  assert.ok(held[1].endMs >= 1600);
});

test('video cues are offset by where each line starts', () => {
  const lines = [{ id: 'a', words: wordsFromAlignment(align('Hello there.')) }];
  const [cue] = videoCues(lines, { a: 10_000 });
  assert.equal(cue.startMs, 10_000);
  assert.equal(cue.text, 'Hello there.');
});

test('WebVTT output', () => {
  const vtt = toVtt([{ text: 'Hi!', startMs: 1500, endMs: 62_250 }]);
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:01.500 --> 00:01:02.250\nHi!\n');
});
