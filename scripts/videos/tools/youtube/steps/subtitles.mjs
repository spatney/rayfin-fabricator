// Uploads the lesson's English captions (the .en.vtt, with timing) in the upload dialog's Video elements step, and checks they're saved.
//
//   npm run yt -- subtitles --lesson <n>
//
// The editor takes the video's language from Details (English, from the channel's defaults).
import { filesOf, lessonOf, loadUpload, uploadsDialog } from '../studio.mjs';

export default async ({ page, log, shot, args }) => {
  const up = await loadUpload(lessonOf(args));
  const files = filesOf(up);
  const dialog = uploadsDialog(page).locator('tp-yt-paper-dialog').first(); // its panel: see uploadsDialog
  if (!(await dialog.isVisible())) throw new Error('No upload dialog is open. Run the upload and details steps first.');
  await dialog.locator('#step-badge-1').click();
  await page.waitForTimeout(1500);
  const before = (await dialog.locator('ytcp-uploads-video-elements').innerText()).replace(/\s+/g, ' ');
  if (/English by you/.test(before)) {
    log('subtitles: English by you, already');
    return { captions: 'English by you' };
  }
  await dialog.locator('#subtitles-button').click();
  await page.waitForTimeout(2500);
  // The editor's modal: `ytve-modal-host` until October 2026, then `ytve-captions-editor-modal`, a
  // host with no height, so its text comes from textContent().
  const editor = page.locator('ytve-captions-editor-modal, ytve-modal-host').first();
  await editor.waitFor({ state: 'attached', timeout: 30000 });
  const said = ((await editor.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  if (!/language of this video is set to English/.test(said)) throw new Error(`The subtitles editor isn't set to English: ${said.slice(0, 200)}. Set the video's language in Details first.`);
  await page.getByText('Upload file', { exact: true }).last().click();
  await page.waitForTimeout(1500);
  const choice = page.locator('tp-yt-paper-dialog, ytcp-dialog').filter({ hasText: /With timing/ }).last();
  await choice.getByRole('radio', { name: /With timing/ }).or(choice.getByText('With timing', { exact: true })).first().click();
  await page.waitForTimeout(500);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), choice.getByRole('button', { name: 'Continue' }).click()]);
  await chooser.setFiles(files.captions);
  await page.waitForTimeout(5000);
  await shot('subtitles-editor');
  // "Done" in the editor's header saves them; it's enabled once the cues load.
  await page.getByRole('button', { name: 'Done', exact: true }).filter({ visible: true }).last().click();
  await page.waitForTimeout(3000);
  const after = (await dialog.locator('ytcp-uploads-video-elements').innerText()).replace(/\s+/g, ' ');
  if (!/English by you/.test(after)) throw new Error(`The captions don't show as saved: ${after.slice(0, 200)}`);
  log('subtitles: English by you');
  await shot('subtitles');
  return { captions: 'English by you' };
};
