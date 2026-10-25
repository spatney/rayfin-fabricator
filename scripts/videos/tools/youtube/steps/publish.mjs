// Publishes the upload (Publish, or Save for a private video) and closes the dialog that follows. Only with --confirm, after the user says yes.
//
//   npm run yt -- publish --confirm
//
// Run the visibility step first and show the user what it reports. A public video notifies the
// channel's subscribers, and that can't be taken back.
import { uploadsDialog } from '../studio.mjs';

export default async ({ page, log, shot, args }) => {
  if (args.confirm !== true) throw new Error('Ask the user first (show them what the visibility step reports), then run publish --confirm.');
  const dialog = uploadsDialog(page).locator('tp-yt-paper-dialog').first(); // its panel: see uploadsDialog
  if (!(await dialog.isVisible())) throw new Error('No upload dialog is open.');
  const done = dialog.locator('#done-button');
  log('clicking:', (await done.innerText()).trim());
  await done.click();
  // A published video gets a share dialog; a private save just closes the upload dialog. Like the
  // upload dialog, the share dialog's element has no height, so wait on its panel.
  const share = page.locator('ytcp-video-share-dialog tp-yt-paper-dialog').first();
  await Promise.race([share.waitFor({ state: 'visible', timeout: 120000 }), dialog.waitFor({ state: 'hidden', timeout: 120000 })]);
  let link = null;
  if (await share.isVisible()) {
    const text = (await share.innerText()).replace(/\s+/g, ' ');
    link = /https:\/\/youtu\.be\/[\w-]+/.exec(text)?.[0] ?? null;
    log(text.slice(0, 140));
    await shot('published');
    await share.getByRole('button', { name: /close/i }).first().click();
  }
  log('done:', link ?? 'saved');
  return { link };
};
