import assert from 'node:assert/strict';
import test from 'node:test';
import { END_SLOTS } from '../../src/show/youtube.ts';
import { endScreenTargets, lessonOf, parseArgs, sameText, stringArg, styleBox } from './studio.mjs';

test('step arguments: words, options with values, flags and --key=value', () => {
  assert.deepEqual(parseArgs(['endscreen', '--lesson', '1', '--replace', '--video-id', 'n-VtBCmtn78', '--no-save']), {
    _: ['endscreen'],
    lesson: '1',
    replace: true,
    'video-id': 'n-VtBCmtn78',
    'no-save': true,
  });
  assert.deepEqual(parseArgs(['endscreen', '--next=-dashFirst1']), { _: ['endscreen'], next: '-dashFirst1' });
});

test('a lesson is a number; --lesson without one is an error, not lesson 1', () => {
  assert.equal(lessonOf(parseArgs(['comment', '--lesson', '12'])), 12);
  for (const argv of [['comment'], ['comment', '--lesson'], ['comment', '--lesson', '--video-id', 'abc'], ['comment', '--lesson', '0'], ['comment', '--lesson', '1.5'], ['comment', '--lesson=']]) {
    assert.throws(() => lessonOf(parseArgs(argv)), /Name the lesson/, argv.join(' '));
  }
});

test('an option given without its value is an error; a missing one is undefined', () => {
  assert.equal(stringArg(parseArgs(['x', '--video-id', 'abc']), 'video-id'), 'abc');
  assert.equal(stringArg(parseArgs(['x']), 'video-id'), undefined);
  assert.throws(() => stringArg(parseArgs(['x', '--video-id', '--replace']), 'video-id'), /--video-id needs a value/);
  assert.throws(() => stringArg(parseArgs(['x', '--next=']), 'next'), /--next needs a value/);
});

test('comments compare as YouTube shows them: whitespace collapsed', () => {
  assert.ok(sameText('Ray’s challenge: A.\nTry this:\n“B.”', ' Ray’s challenge: A. Try this:  “B.” '));
  assert.ok(!sameText('Ray’s challenge: A.\nTry this:\n“B.”', 'Ray’s challenge: A.\nTry this:\n“C.”'));
});

test('end-screen targets scale the frame’s slots to the editor’s preview', () => {
  // The preview was 480 px wide for lesson 1: a quarter of the frame.
  const t = endScreenTargets(END_SLOTS, 480 / 1920);
  assert.deepEqual(t.video, { left: 42.5, top: 82.5, width: 190, height: 107 });
  assert.deepEqual(t.subscribe, { cx: 375, cy: 136.25 });
  // The intro's end screen has a video element only.
  const intro = endScreenTargets({ video: { x: 45, y: 566, w: 620, h: 349 } }, 480 / 1920);
  assert.deepEqual(intro.video, { left: 11.25, top: 141.5, width: 155, height: 87.25 });
  assert.equal(intro.subscribe, null);
});

test('an element’s box comes from its inline style', () => {
  assert.deepEqual(styleBox('top: 83.3271px; left: 42.215px; height: 107.432px; width: 190.766px;'), { left: 42.215, top: 83.3271, width: 190.766, height: 107.432 });
  assert.ok(Number.isNaN(styleBox(null).left));
});
