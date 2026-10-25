// Posts the lesson's challenge as a comment on its video, as the channel, and pins it; skips whatever's already done.
//
//   npm run yt -- comment --lesson <n> [--video-id <id>]
//
// The challenge comes from the lesson's youtube.ts as it is now, and the video id from
// lessons/channel.ts unless you pass one. If the channel already has a different challenge
// comment there, the step stops: delete that one first (with the user's yes). Pinning needs the
// channel's advanced features (Studio → Settings → Channel → Feature eligibility), which only
// the user can turn on.
import { challengeComments, hush, lessonOf, loadChannel, loadComments, loadUpload, sameText, stringArg, watchTab } from '../studio.mjs';

export default async ({ context, state, log, shot, args }) => {
  const CHANNEL = await loadChannel();
  const n = lessonOf(args);
  const up = await loadUpload(n);
  const id = stringArg(args, 'video-id') ?? CHANNEL.lessons[n];
  if (!id) throw new Error(`lessons/channel.ts has no video for lesson ${n}; pass --video-id.`);
  const text = up.pinnedComment;
  const w = await watchTab(context, state);
  await w.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  await w.waitForTimeout(5000);
  await hush(w);
  await loadComments(w);
  const as = await w.locator('ytd-comments #simple-box img').first().getAttribute('alt').catch(() => null);
  if (as !== CHANNEL.name) throw new Error(`YouTube would comment as ${as ?? 'someone else'}, not ${CHANNEL.name}. Switch the account to the channel first.`);

  const ours = async () => (await challengeComments(w, CHANNEL.handle)).find((c) => sameText(c.text, text));
  let mine = await ours();
  if (!mine) {
    const other = (await challengeComments(w, CHANNEL.handle))[0];
    if (other) throw new Error(`The channel already has a different challenge comment here ("${other.text.slice(0, 80)}…"). Delete it in Studio (ask the user first), then run this again.`);
    await w.locator('#simplebox-placeholder').scrollIntoViewIfNeeded();
    await w.locator('#simplebox-placeholder').click();
    await w.waitForTimeout(1200);
    const box = w.locator('#contenteditable-root');
    await box.click();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await w.keyboard.press('Shift+Enter');
      await w.keyboard.insertText(lines[i]);
    }
    await w.waitForTimeout(800);
    if (!sameText(await box.innerText(), text)) throw new Error('The comment box doesn’t hold the challenge as written; not posting it.');
    await w.locator('ytd-commentbox #submit-button').click();
    for (let i = 0; i < 20 && !mine; i++) {
      await w.waitForTimeout(1000);
      mine = await ours();
    }
    if (!mine) throw new Error('Posted the challenge, but it doesn’t show among the comments yet. Reload the page and look before running this again.');
    log('posted the challenge');
  } else log('the challenge is already there');

  const thread = w.locator('ytd-comment-thread-renderer').nth(mine.index);
  if (mine.pinned) {
    log('already pinned');
  } else {
    await thread.scrollIntoViewIfNeeded();
    await thread.hover();
    await thread.getByRole('button', { name: 'Action menu' }).first().click({ force: true });
    await w.waitForTimeout(1200);
    await w.locator('ytd-menu-service-item-renderer, tp-yt-paper-item, yt-list-item-view-model').filter({ hasText: /^\s*Pin\s*$/ }).first().click();
    await w.waitForTimeout(1500);
    const gate = w.locator('yt-confirm-dialog-renderer, tp-yt-paper-dialog').filter({ hasText: 'Get advanced features' }).filter({ visible: true });
    if (await gate.count()) {
      await gate.getByRole('button', { name: 'Cancel' }).first().click();
      throw new Error('Pinning needs the channel’s advanced features. Ask the user to verify in Studio → Settings → Channel → Feature eligibility, then run this again.');
    }
    await w.locator('yt-confirm-dialog-renderer').filter({ hasText: 'Pin this comment?' }).filter({ visible: true }).first().getByRole('button', { name: 'Pin' }).click();
    await w.waitForTimeout(3000);
    if (!(await ours())?.pinned) throw new Error('The comment didn’t pin.');
    log('pinned');
  }
  await w.locator('ytd-comment-thread-renderer').nth((await ours()).index).scrollIntoViewIfNeeded();
  await shot('comment', w);
  return { video: id, pinned: true };
};
