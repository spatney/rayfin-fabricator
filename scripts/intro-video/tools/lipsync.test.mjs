import assert from 'node:assert/strict';
import test from 'node:test';
import { LEAD, lipTrack, soundsOf } from '../src/ray/lipsync.ts';

const FPS = 30;

/** A line of `words` ([text, startMs, endMs]), loud while they're spoken and silent between. */
function line(words) {
  const envelope = Array.from({ length: 90 }, (_, f) => (words.some(([, s, e]) => (f * 1000) / FPS >= s && (f * 1000) / FPS < e) ? 0.8 : 0));
  return {
    id: 'test',
    file: '',
    durationMs: 3000,
    speechStartMs: words[0][1],
    speechEndMs: words[words.length - 1][2],
    caption: words.map(([text]) => text).join(' '),
    words: words.map(([text, startMs, endMs]) => ({ text, startMs, endMs })),
    envelope,
  };
}

/** The viseme at frame `f` of the line. */
const at = (track, f) => track.visemes[f - track.start];

test('spelling picks the mouth shapes: lips shut for m, b and p, rounded for oo and ue', () => {
  assert.deepEqual(soundsOf('maps').map((s) => s.v), ['closed', 'open', 'closed', 'mid']);
  assert.deepEqual(soundsOf('Blue').map((s) => s.v), ['closed', 'mid', 'round']);
  assert.deepEqual(soundsOf('food.').map((s) => s.v), ['teeth', 'round', 'mid']);
});

test('lips stay shut for at least two frames, however quick the word', () => {
  const track = lipTrack(line([['mama', 300, 520]]), FPS);
  const runs = track.visemes.join(' ').match(/(closed ?)+/g) ?? [];
  assert.equal(runs.length, 2);
  for (const run of runs) assert.ok(run.trim().split(' ').length >= 2, run);
});

test('the mouth moves ahead of the sound', () => {
  const track = lipTrack(line([['ah', 1000, 1300]]), FPS);
  const first = track.visemes.findIndex((v) => v !== 'rest') + track.start;
  assert.equal(first, 30 - LEAD);
});

test('it rests in a pause, and holds through a short gap', () => {
  const pause = lipTrack(line([['hi', 300, 500], ['there', 800, 1100]]), FPS);
  assert.equal(at(pause, 20), 'rest');
  const gap = lipTrack(line([['hi', 300, 500], ['there', 560, 800]]), FPS);
  for (let f = 9 - LEAD; f < 23 - LEAD; f++) assert.notEqual(at(gap, f), 'rest', `frame ${f}`);
});
