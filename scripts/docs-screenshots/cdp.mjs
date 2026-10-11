// Minimal Chrome DevTools Protocol driver for capturing documentation screenshots of a
// Fabricator instance started with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>
// (see launch.ps1). Uses Node's built-in fetch and WebSocket (Node 22+); no dependencies.
//
// CLI:
//   node cdp.mjs targets                         list debuggable pages
//   node cdp.mjs eval "<js>"                     evaluate in the app window (prints JSON)
//   node cdp.mjs click "<css or text:Label>"     click an element in the app window
//   node cdp.mjs press "<css>"                   click it with real mouse events (no focus ring)
//   node cdp.mjs type "<css>" <text...>          type into an input (replaces its value)
//   node cdp.mjs scrub <replacements.json>       replace personal details in the DOM
//   node cdp.mjs shot <out.png> [css]            screenshot the page, or one element
// Options: --port <n> (default 9333), --url <substring> to pick a target other than the
// app window (for example the preview webview).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_URL = /^(tauri|http:\/\/tauri\.localhost|https?:\/\/localhost:1420)/;

export async function listTargets(port = 9333) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`DevTools endpoint on port ${port} returned ${res.status}`);
  return (await res.json()).filter((t) => t.type === 'page');
}

/** Connect to the app window (default), the target with id `id`, or the first page whose URL contains `url`. */
export async function connect({ port = 9333, url, id } = {}) {
  const targets = await listTargets(port);
  const target = id
    ? targets.find((t) => t.id === id)
    : url
      ? targets.find((t) => t.url.includes(url))
      : (targets.find((t) => APP_URL.test(t.url)) ?? targets[0]);
  if (!target) throw new Error(`No page target${id ? ` with id ${id}` : url ? ` matching ${url}` : ''} on port ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method) {
      for (const listener of listeners.get(msg.method) ?? []) listener(msg.params);
      return;
    }
    const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else waiter.resolve(msg.result);
  });

  /** The next `method` event's params, or null after `timeout` ms. */
  const once = (method, timeout = 10000) =>
    new Promise((resolve) => {
      const list = listeners.get(method) ?? new Set();
      listeners.set(method, list);
      const done = (params) => {
        list.delete(done);
        clearTimeout(timer);
        resolve(params);
      };
      const timer = setTimeout(() => done(null), timeout);
      list.add(done);
    });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  /** Screenshot the viewport, or the bounding box of `selector` plus `pad` CSS pixels. */
  const screenshot = async (file, { selector, pad = 0 } = {}) => {
    let clip;
    if (selector) {
      const box = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      })()`);
      if (!box) throw new Error(`No element matches ${selector}`);
      clip = {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: box.height + pad * 2,
        scale: 1,
      };
    }
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    });
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  };

  /** Click by CSS selector, or by visible text with a `text:` prefix. */
  const click = (what) =>
    evaluate(`(() => {
      const want = ${JSON.stringify(what)};
      let el;
      if (want.startsWith('text:')) {
        const label = want.slice(5).trim();
        const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], summary, label')];
        el = candidates.find((c) => c.textContent.trim() === label)
          ?? candidates.find((c) => c.getAttribute('aria-label') === label || c.title === label)
          ?? candidates.find((c) => c.textContent.trim().startsWith(label));
      } else {
        el = document.querySelector(want);
      }
      if (!el) throw new Error('Nothing to click for ' + want);
      el.scrollIntoView({ block: 'center' });
      el.click();
      return el.textContent.trim().slice(0, 80);
    })()`);

  /**
   * Click `selector` with real mouse events at its center. Menus that focus their first item
   * then don't draw a keyboard focus ring, as they would after a scripted click.
   */
  const press = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`No element matches ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return selector;
  };

  /** Focus `selector` and type `text` as real keyboard input (works with React inputs). */
  const type = async (selector, text, { clear = true } = {}) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('No element matches ${selector.replace(/'/g, "\\'")}');
      el.focus();
      if (${clear} && 'select' in el) el.select();
    })()`);
    await send('Input.insertText', { text });
  };

  /** Replace personal details using a { "find": "replace" } map (see scrub.js). */
  const scrub = async (replacements) => {
    const source = (await readFile(path.join(HERE, 'scrub.js'), 'utf8')).trim().replace(/;$/, '');
    return evaluate(`(${source}\n)(${JSON.stringify(replacements)})`);
  };

  return { target, send, once, evaluate, screenshot, click, press, type, scrub, close: () => ws.close() };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const port = Number(opt('port', 9333));
  const url = opt('url');
  const [command, ...rest] = args;

  if (command === 'targets') {
    for (const t of await listTargets(port)) console.log(`${t.id}  ${t.url}`);
    return;
  }

  const page = await connect({ port, url });
  try {
    if (command === 'eval') console.log(JSON.stringify(await page.evaluate(rest.join(' ')), null, 2));
    else if (command === 'click') console.log(await page.click(rest.join(' ')));
    else if (command === 'press') console.log(await page.press(rest.join(' ')));
    else if (command === 'type') await page.type(rest[0], rest.slice(1).join(' '));
    else if (command === 'scrub') console.log(await page.scrub(JSON.parse(await readFile(rest[0], 'utf8'))));
    else if (command === 'shot') console.log(await page.screenshot(rest[0], { selector: rest[1] }));
    else throw new Error(`Unknown command ${command ?? '(none)'}`);
  } finally {
    page.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
