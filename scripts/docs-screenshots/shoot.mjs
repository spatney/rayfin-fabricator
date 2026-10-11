// Captures one screen in both themes. Fabricator's theme (<html data-theme>) and the preview's
// color scheme (prefers-color-scheme, emulated over DevTools) switch together, so the app
// and the sample app in the preview always match.
//
//   node shoot.mjs <out> --pid <app process id> [--scrub <map.json>] [--themes dark,light]
//                  [--width 1440 --height 900] [--settle 1500] [--port 9333] [--settings-theme]
//                  [--open <css> [--open-wait 1200] [--close <css>]]
//
// Writes <out>.png (dark) and <out>.light.png (light) with capture-window.ps1, then puts the
// app back in the theme it was in. With --scrub, every page is scrubbed before each capture.
// --settings-theme switches with the Theme buttons of the open Settings dialog instead, so
// the dialog shows the selected theme.
//
// While a menu, popover or dialog covers part of the preview, Fabricator shows a still frame
// of the preview taken when it opened, which a later theme switch can't change. For those
// screens pass --open with the element that opens it: each theme is applied first, then the
// element is clicked (real mouse events) and given --open-wait ms to load. After the capture
// it's closed by clicking --close (often the same element), or with Escape. Prefer --close:
// after a key press, a menu that focuses its first item draws a keyboard focus ring.
//
// --freeze pauses the app window's JavaScript (DevTools debugger) once the first theme is on
// screen, so a screen that keeps changing, such as a chat turn in progress, looks the same in
// every capture. Themes then switch through the DOM, so only screens styled by CSS alone
// follow (not the code editor), and it can't be combined with --open or --settings-theme.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_URL, connect, listTargets } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const port = Number(opt('port', 9333));
const pid = Number(opt('pid', 0));
const scrubFile = opt('scrub');
const themes = opt('themes', 'dark,light').split(',').map((t) => t.trim());
const width = Number(opt('width', 1440));
const height = Number(opt('height', 900));
// The preview's webview doesn't always repaint promptly after its color scheme changes; give
// it time, or a capture can show the app still in the other theme.
const settle = Number(opt('settle', 1500));
const viaSettings = flag('settings-theme');
const opener = opt('open');
const openWait = Number(opt('open-wait', 1200));
const closer = opt('close');
const freeze = flag('freeze');
const [out] = args;
if (!out || !pid || themes.some((t) => t !== 'dark' && t !== 'light')) {
  console.error('usage: node shoot.mjs <out> --pid <app process id> [--scrub map.json] [--themes dark,light]');
  process.exit(1);
}
if (freeze && (opener || viaSettings)) {
  console.error('--freeze can’t be combined with --open or --settings-theme');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'pwsh' : 'powershell.exe';
const replacements = scrubFile ? JSON.parse(await readFile(scrubFile, 'utf8')) : null;

const app = await connect({ port });
// Every other web page is a preview of the sample app (deployed or local).
const pages = (await listTargets(port)).filter((t) => t.id !== app.target.id && /^https?:/.test(t.url) && !APP_URL.test(t.url));
const previews = await Promise.all(pages.map((t) => connect({ port, id: t.id })));
const before = await app.evaluate('document.documentElement.dataset.theme');

/** While the page's JavaScript is paused (--freeze), the theme is switched through the DOM. */
let frozen = false;
let htmlNode = null;

const setTheme = async (theme) => {
  if (frozen) {
    await app.send('DOM.setAttributeValue', { nodeId: htmlNode, name: 'data-theme', value: theme });
    return;
  }
  if (viaSettings) {
    await app.evaluate(`(() => {
        const label = ${JSON.stringify(theme === 'dark' ? 'Dark' : 'Light')};
        const button = [...document.querySelectorAll('[aria-label="Theme"] .seg-btn')].find((b) => b.textContent.trim() === label);
        if (!button) throw new Error('No ' + label + ' button: open Settings first');
        button.click();
      })()`);
    return;
  }
  await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
};

/** Pause the app window's JavaScript, so nothing on screen changes until it resumes. */
const pause = async () => {
  const { root } = await app.send('DOM.getDocument', { depth: 0 });
  htmlNode = (await app.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'html' })).nodeId;
  await app.send('Debugger.enable');
  const paused = app.once('Debugger.paused', 8000);
  await app.send('Debugger.pause');
  // The pause lands on the next statement that runs; give it one. Not awaited: it only
  // returns once the page resumes.
  app.send('Runtime.evaluate', { expression: '0' }).catch(() => {});
  if (!(await paused)) throw new Error('The app window didn’t pause for --freeze');
  frozen = true;
};

const resume = async () => {
  if (!frozen) return;
  await app.send('Debugger.resume').catch(() => {});
  frozen = false;
  await app.send('Debugger.disable').catch(() => {});
};

const escape = async () => {
  for (const type of ['keyDown', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
};

try {
  for (const theme of themes) {
    await setTheme(theme);
    for (const page of previews) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    }
    await sleep(settle);
    if (opener) {
      await app.press(opener);
      await sleep(openWait);
    }
    if (replacements) {
      // A frozen app window can't change, so it was scrubbed before it paused.
      if (!frozen) await app.scrub(replacements);
      for (const page of previews) await page.scrub(replacements);
      await sleep(150);
    }
    if (freeze && !frozen) await pause();
    const file = path.resolve(theme === 'dark' ? `${out}.png` : `${out}.${theme}.png`);
    const capture = spawnSync(
      shell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'capture-window.ps1'), '-ProcessId', String(pid), '-Out', file, '-Width', String(width), '-Height', String(height)],
      { stdio: 'inherit' },
    );
    if (capture.status !== 0) throw new Error(`capture-window.ps1 failed for the ${theme} capture`);
    if (opener) {
      if (closer) await app.press(closer);
      else await escape();
      await sleep(600);
    }
  }
} finally {
  if (before === 'dark' || before === 'light') await setTheme(before).catch(() => {});
  await resume();
  // Closing a DevTools session drops its emulation, so the preview follows the OS again.
  for (const page of previews) page.close();
  app.close();
}
console.log(`previews themed: ${pages.map((t) => new URL(t.url).host).join(', ') || 'none'}`);
