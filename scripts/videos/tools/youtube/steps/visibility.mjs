// Moves the upload dialog to Visibility and picks who can watch, without publishing; reports what's set, for the user to confirm.
//
//   npm run yt -- visibility --as public|unlisted|private
//
// Show the user the result (and the details step's summary) with ask_user, then publish.
import { uploadsDialog } from '../studio.mjs';

export default async ({ page, log, shot, args }) => {
  const as = String(args.as ?? '').toUpperCase();
  if (!['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(as)) throw new Error('Say who can watch: --as public, unlisted or private.');
  const dialog = uploadsDialog(page).locator('tp-yt-paper-dialog').first(); // its panel: see uploadsDialog
  if (!(await dialog.isVisible())) throw new Error('No upload dialog is open.');
  await dialog.locator('#step-badge-3').click();
  await page.waitForTimeout(2500);
  const radio = dialog.locator(`tp-yt-paper-radio-button[name=${as}]`);
  await radio.click();
  await page.waitForTimeout(1200);
  if ((await radio.getAttribute('aria-checked')) !== 'true') throw new Error(`Couldn't pick ${as.toLowerCase()}.`);
  const steps = await dialog.locator('[id^=step-badge-]').evaluateAll((els) => els.map((e) => `${e.innerText.trim() || e.id}: ${e.getAttribute('state')}`));
  const text = await dialog.innerText();
  const checks = /Checks? [^\n]*|Checking[^\n]*|Processing[^\n]*|Uploading[^\n]*/.exec(text)?.[0]?.trim() ?? null;
  const link = await dialog.locator('a[href*="youtu.be/"]').first().getAttribute('href').catch(() => null);
  const button = (await dialog.locator('#done-button').innerText()).trim();
  const summary = { visibility: as.toLowerCase(), button, link, checks, steps };
  log('visibility:', summary);
  await shot('visibility');
  return summary;
};
