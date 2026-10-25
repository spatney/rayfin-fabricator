// Fills the upload dialog's Details step from upload.json: title, description, thumbnail, playlist, audience, paid promotion, AI use, tags and category.
//
//   npm run yt -- details --lesson <n> [--ai yes|no]
//
// AI use comes from lessons/channel.ts (aiUse); --ai overrides it for this video, and only the
// user decides it. The step checks what took, flags what didn't, and leaves the dialog on Details.
import { filesOf, lessonOf, loadChannel, loadUpload, stringArg, uploadsDialog } from '../studio.mjs';

const flat = (s) => s.replace(/\s+/g, ' ').trim();

export default async ({ page, log, shot, args }) => {
  const CHANNEL = await loadChannel();
  const up = await loadUpload(lessonOf(args));
  const files = filesOf(up);
  const ai = stringArg(args, 'ai') ?? CHANNEL.aiUse;
  if (ai !== 'yes' && ai !== 'no') throw new Error('--ai is yes or no.');
  const dialog = uploadsDialog(page).locator('tp-yt-paper-dialog').first(); // its panel: see uploadsDialog
  if (!(await dialog.isVisible())) throw new Error('No upload dialog is open. Run the upload step first.');
  await dialog.locator('#step-badge-0').click();
  await page.waitForTimeout(1500);
  const warnings = [];

  // Title and description: contenteditable boxes. The description starts with the channel's
  // upload default, which fill() replaces.
  const title = dialog.getByRole('textbox').first();
  await title.click();
  await title.fill(up.title);
  const description = dialog.getByRole('textbox').nth(1);
  await description.click();
  await description.fill(up.description);
  await page.waitForTimeout(1000);
  if (flat(await title.innerText()) !== flat(up.title)) throw new Error('The title didn’t take.');
  if (flat(await description.innerText()) !== flat(up.description)) warnings.push('The description reads differently from upload.json; look at it.');
  const note = await dialog.getByText(/external links clickable/).first().innerText().catch(() => null);
  if (note) warnings.push(`${note} (Studio → Settings → Channel → Feature eligibility; only the user can verify.)`);

  // Thumbnail.
  const [thumb] = await Promise.all([page.waitForEvent('filechooser'), dialog.getByText('Upload file', { exact: true }).click()]);
  await thumb.setFiles(files.thumbnail);
  await page.waitForTimeout(5000);

  // Playlist. The picker's checkboxes have no names (and clicks on them land on a wrapper), so
  // click the playlist's name. It toggles, so only when the video isn't in it yet.
  const field = dialog.locator('ytcp-video-metadata-playlists');
  if (!flat(await field.innerText()).includes(up.playlist)) {
    const empty = field.getByText('Select').first();
    await ((await empty.count()) ? empty : field.locator('ytcp-dropdown-trigger').first()).click();
    await page.waitForTimeout(1500);
    const picker = page.locator('ytcp-playlist-dialog');
    await picker.getByText(up.playlist, { exact: true }).click();
    await page.waitForTimeout(700);
    await picker.getByRole('button', { name: 'Done' }).click();
    await page.waitForTimeout(1000);
  }
  if (!flat(await field.innerText()).includes(up.playlist)) throw new Error(`The playlist didn't take: ${flat(await field.innerText())}`);

  // Audience: not made for kids (videos made for kids lose comments and end screens).
  const kids = dialog.getByRole('radio', { name: /not made for kids/ });
  await kids.click();
  if ((await kids.getAttribute('aria-checked')) !== 'true') throw new Error('Couldn’t set “not made for kids”.');

  // The rest is under "Show more".
  const toggle = dialog.locator('#toggle-button').first();
  if (/more/i.test(await toggle.innerText())) {
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await page.waitForTimeout(1500);
  }
  const paid = dialog.getByRole('radio', { name: 'No, my video doesn’t include paid promotion' });
  await paid.click();
  const aiRadio = dialog.getByRole('radio', { name: ai === 'yes' ? 'Yes, AI was used' : 'No, AI wasn’t used' });
  await aiRadio.click();
  await page.waitForTimeout(500);
  if ((await paid.getAttribute('aria-checked')) !== 'true') throw new Error('Couldn’t set paid promotion to No.');
  if ((await aiRadio.getAttribute('aria-checked')) !== 'true') throw new Error(`Couldn’t set AI use to ${ai}.`);

  // Tags: only the ones that aren't there yet (the channel's upload defaults may add some).
  const chips = dialog.locator('ytcp-chip-bar, #tags-container').first();
  const current = (await chips.innerText()).split('\n').map((t) => t.trim()).filter(Boolean);
  const missing = up.tags.filter((t) => !current.some((c) => c.toLowerCase() === t.toLowerCase()));
  if (missing.length) {
    const input = dialog.getByRole('textbox', { name: 'Tags' }).or(dialog.locator('#tags-container input, ytcp-free-text-chip-bar input')).first();
    await input.click();
    await input.pressSequentially(`${missing.join(',')},`, { delay: 15 });
    await page.waitForTimeout(800);
  }
  const tags = flat(await chips.innerText());
  const absent = up.tags.filter((t) => !tags.toLowerCase().includes(t.toLowerCase()));
  if (absent.length) warnings.push(`Tags that didn't take: ${absent.join(', ')}`);

  // Category.
  const category = dialog.locator('#category').first();
  if (!(await category.innerText()).includes(up.category)) {
    await category.click();
    await page.waitForTimeout(800);
    await page.getByRole('option', { name: up.category }).click();
    await page.waitForTimeout(800);
  }
  if (!(await category.innerText()).includes(up.category)) throw new Error(`The category didn't take: ${flat(await category.innerText())}`);

  // The video's language comes from the channel's upload defaults. Captions need it.
  const text = await dialog.innerText();
  const language = /Video language\s*\n\s*([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
  if (language !== up.language) warnings.push(`Video language is ${language ?? 'not set'}; set it to ${up.language} by hand.`);

  for (const w of warnings) log(`! ${w}`);
  const summary = { title: up.title, playlist: up.playlist, madeForKids: false, paidPromotion: 'no', ai, tags: up.tags.length, category: up.category, language };
  log('details:', summary);
  await shot('details');
  return { ...summary, warnings };
};
