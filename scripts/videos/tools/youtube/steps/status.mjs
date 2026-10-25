// Where things stand: the browser's tabs, whether Studio is signed in to the channel, and which Studio dialog is open. Run it first.
//
//   npm run yt -- status
//
// It only reads: it opens Studio if no tab is on it, and otherwise leaves the page alone, so it's
// safe in the middle of an upload.
import { STUDIO, loadChannel, studioChannel, uploadsDialog } from '../studio.mjs';

export default async ({ page, context, log }) => {
  const CHANNEL = await loadChannel();
  log('tabs:', context.pages().map((p) => p.url()));
  if (!page.url().startsWith(STUDIO)) await page.goto(`${STUDIO}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const { signedIn, channelId } = /accounts\.google\.com/.test(page.url()) ? { signedIn: false, channelId: null } : await studioChannel(page);
  if (!signedIn) {
    log('Studio wants a sign-in. Ask the user to sign in to the channel’s Google account in the browser window.');
    return { signedIn: false };
  }
  const onChannel = channelId === CHANNEL.id;
  log(`Studio: signed in, on ${onChannel ? `${CHANNEL.name} (${CHANNEL.handle})` : `another channel, ${channelId}: switch to ${CHANNEL.name} with the account menu`}`);
  const upload = uploadsDialog(page).locator('tp-yt-paper-dialog').first(); // its panel: see uploadsDialog
  let dialog = null;
  if (await upload.isVisible()) {
    const steps = await upload.locator('[id^=step-badge-]').evaluateAll((els) => els.map((e) => `${e.innerText.trim() || e.id}: ${e.getAttribute('state')}`));
    const title = (await upload.locator('#dialog-title, .dialog-title').first().innerText().catch(() => '')).trim();
    dialog = { upload: title, steps };
    log('upload dialog open:', dialog);
  }
  if (await page.locator('ytve-endscreen-editor-options-panel').isVisible()) {
    dialog = { ...dialog, endScreenEditor: true };
    log('the end-screen editor is open');
  }
  return { signedIn: true, channelId, onChannel, dialog };
};
