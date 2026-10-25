// Stays attached to the browser `npm run yt:browser` opened, and runs the steps `npm run yt` sends.
// YouTube Studio closes its open dialog whenever a DevTools client detaches, so every step runs
// in this one long-lived connection, and the upload dialog stays open from step to step.
//
//   npm run yt:driver
//
// Leave it running (an agent starts it in an async shell). Stop it only when no Studio dialog is
// mid-way, since stopping detaches. Only one runs at a time: a second one stops before it
// touches the browser. It listens on 127.0.0.1 only, and only answers requests that carry the
// token it writes to TOKEN (outside the repo) once it's attached. Steps, lessons/channel.ts and
// the lessons' files are read fresh for every step; restart it (stop it, then start it) only
// after editing this file, studio.mjs or config.mjs.
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CDP_PORT, DRIVER_PORT, SHOTS, STATE, TOKEN } from './config.mjs';
import * as studio from './studio.mjs';

const STEPS = new URL('./steps/', import.meta.url);
const AsyncFunction = (async () => {}).constructor;
/** Known only to this process until it's attached; then written to TOKEN for `npm run yt`. */
const token = randomBytes(16).toString('hex');
/** The browser's context, once attached; requests before then are refused. */
let context = null;
/**
 * Kept from step to step: the tab a step works in (`active`, screenshotted if it fails), tabs a
 * step opened (such as the watch page), and whatever else steps share.
 */
const state = {};
let queue = Promise.resolve();
let count = 0;

/** A value as log text; what JSON can't hold becomes plain text. */
function text(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Sends a step's outcome; a result JSON can't hold (a cycle, a BigInt) is replaced by a note. */
function reply(res, status, out) {
  let body;
  try {
    body = JSON.stringify(out);
  } catch (err) {
    body = JSON.stringify({ ...out, result: `(the result isn't JSON: ${err.message})` });
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);
}

async function run({ step, code, args = {} }, log) {
  const page = await studio.studioTab(context);
  page.setDefaultTimeout(15000);
  // A tab in the background doesn't paint, so screenshots and drags wait on it forever.
  await page.bringToFront();
  state.active = page;
  const shot = async (name = `shot-${++count}`, target = page) => {
    const file = path.join(SHOTS, `${name}.png`);
    await target.bringToFront();
    await target.screenshot({ path: file });
    log('shot:', file);
    return file;
  };
  // Inline code also gets studio.mjs's helpers, such as studio.loadUpload(n).
  const ctx = { page, context, shot, log, args, state, studio };
  if (code) return new AsyncFunction('ctx', `const { page, context, shot, log, args, state, studio } = ctx;\n${code}`)(ctx);
  if (!/^[a-z][a-z0-9-]*$/.test(step ?? '')) throw new Error(`No step named "${step}". npm run yt -- --list shows them.`);
  const mod = await import(`${new URL(`${step}.mjs`, STEPS).href}?v=${Date.now()}`);
  return mod.default(ctx);
}

/** A screenshot of the tab the failed step was working in. */
async function errorShot(logs) {
  const page = state.active && !state.active.isClosed() ? state.active : null;
  if (!page) return;
  const file = path.join(SHOTS, 'error.png');
  await page.bringToFront();
  await page.screenshot({ path: file, timeout: 5000 });
  logs.push(`shot: ${file}`);
}

async function handle(req, res) {
  if (req.method !== 'POST' || !context || req.headers['x-token'] !== token) return res.writeHead(403).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const logs = [];
  const log = (...parts) => logs.push(parts.map(text).join(' '));
  // One step at a time: two at once would fight over the same dialog.
  const job = queue.then(async () => {
    try {
      const result = await run(JSON.parse(body), log);
      return { ok: true, logs, result: result ?? null };
    } catch (err) {
      try {
        await errorShot(logs);
      } catch {
        // The error is what matters.
      }
      return { ok: false, logs, error: String(err?.message ?? err).split('\n').slice(0, 12).join('\n') };
    }
  });
  queue = job.catch(() => {});
  reply(res, 200, await job);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('yt driver:', err);
    if (!res.headersSent) reply(res, 500, { ok: false, logs: [], error: String(err?.message ?? err) });
  });
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `A driver is already running on 127.0.0.1:${DRIVER_PORT}. Use it (npm run yt -- status), or stop it before starting another.` : `yt driver: ${err.message}`);
  process.exit(1);
});

// Take the port first, so a second driver stops before it attaches to the browser.
server.listen(DRIVER_PORT, '127.0.0.1', async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null);
  if (!browser) {
    console.error(`No browser answers on 127.0.0.1:${CDP_PORT}. Open it first: npm run yt:browser`);
    process.exit(1);
  }
  mkdirSync(STATE, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  context = browser.contexts()[0];
  writeFileSync(TOKEN, token, { mode: 0o600 });
  const quit = (message) => {
    rmSync(TOKEN, { force: true });
    if (message) console.log(message);
    process.exit(0);
  };
  browser.on('disconnected', () => quit('yt driver: the browser closed.'));
  process.on('SIGINT', () => quit());
  process.on('SIGTERM', () => quit());
  console.log(`yt driver: attached to the browser on 127.0.0.1:${CDP_PORT}, listening on 127.0.0.1:${DRIVER_PORT}`);
});
