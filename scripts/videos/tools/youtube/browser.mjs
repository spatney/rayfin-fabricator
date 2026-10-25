// Opens the browser the YouTube tools drive: Microsoft Edge (or Chrome), with a profile of its own
// and DevTools on 127.0.0.1, at YouTube Studio. It keeps running after this exits.
//
//   npm run yt:browser
//
// The user signs in to the channel's Google account in that window; an agent never types a
// password or a code. The profile lives outside the repo (see config.mjs) and keeps them signed
// in for next time. Set YT_BROWSER to use another Chromium browser.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { CDP_PORT, PROFILE, devtools } from './config.mjs';

const BROWSERS = [
  process.env.YT_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function main() {
  const running = await devtools();
  if (running) {
    console.log(`A browser is already listening on 127.0.0.1:${CDP_PORT} (${running.Browser}). Use that window.`);
  } else {
    const exe = BROWSERS.find((b) => existsSync(b));
    if (!exe) throw new Error('No Edge or Chrome found. Set YT_BROWSER to a Chromium browser’s executable.');
    mkdirSync(PROFILE, { recursive: true });
    // A profile of its own: Chromium won't open DevTools on a user's default profile.
    const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', 'https://studio.youtube.com/'];
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      await new Promise((r) => setTimeout(r, 250));
      info = await devtools();
    }
    if (!info) throw new Error(`The browser started, but nothing answers on 127.0.0.1:${CDP_PORT}. Is another copy using the profile?`);
    console.log(`${info.Browser} is open, with DevTools on 127.0.0.1:${CDP_PORT}.`);
    console.log(`Profile: ${PROFILE}`);
  }
  console.log('Have the user sign in to the channel there if Studio asks, then start the driver: npm run yt:driver');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
