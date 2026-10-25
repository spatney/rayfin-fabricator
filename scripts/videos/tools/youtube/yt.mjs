// Sends a step to the YouTube driver (npm run yt:driver), and prints what it did.
//
//   npm run yt -- <step> [--lesson <n>] [--<option> <value>] [--<flag>]
//   npm run yt -- --list           the steps, and what each does
//   npm run yt -- -e "<code>"      runs code with page, context, shot, log, args, state and studio
//                                  (studio.mjs's helpers) in scope
//
// It exits with 1 when the step fails. Screenshots go to out/youtube/shots/.
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { DRIVER_PORT, TOKEN } from './config.mjs';
import { parseArgs } from './studio.mjs';

const STEPS = new URL('./steps/', import.meta.url);
const NOT_RUNNING = 'The driver isn’t running. Start it: npm run yt:driver (after npm run yt:browser).';

function list() {
  for (const file of readdirSync(STEPS).filter((f) => f.endsWith('.mjs')).sort()) {
    const first = readFileSync(new URL(file, STEPS), 'utf8').split('\n')[0].replace(/^\/\/\s*/, '');
    console.log(`${file.replace(/\.mjs$/, '').padEnd(11)} ${first}`);
  }
}

/** Posts to the driver, and waits for as long as the step takes (fetch would give up after 5 minutes). */
function post(body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: DRIVER_PORT, method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--list') return list();
  let request;
  if (argv[0] === '-e') request = { code: argv[1] ?? '' };
  else {
    const { _, ...args } = parseArgs(argv);
    request = { step: _[0], args };
  }
  let token;
  try {
    token = readFileSync(TOKEN, 'utf8').trim();
  } catch {
    throw new Error(NOT_RUNNING);
  }
  const { status, data } = await post(JSON.stringify(request), token).catch((err) => {
    if (err.code === 'ECONNREFUSED') throw new Error(NOT_RUNNING);
    throw new Error(`Lost the driver during the step (${err.code ?? err.message}). Look at its output. If it stopped, Studio closed any open dialog: start it again, then run the status step.`);
  });
  if (status === 403) throw new Error('The driver refused the token. If it’s starting, wait a moment; otherwise stop it and start it again.');
  const out = JSON.parse(data);
  for (const line of out.logs ?? []) console.log(line);
  if (out.result !== null && out.result !== undefined) console.log('result:', typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2));
  if (!out.ok) {
    console.error(`ERROR: ${out.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
