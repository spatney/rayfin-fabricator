// Checks rendered cuts against their delivery targets: length, file size, loudness, true peak,
// and whether each can start playing before it has fully downloaded (moov before mdat).
//
//   node tools/loudness.mjs [file...]      defaults to both cuts in out/
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { durationSeconds, loudness } from './audio.mjs';
import { CUTS, OUT, ROOT } from './paths.mjs';

const TARGETS = { minSeconds: 60, maxSeconds: 90, maxMB: 15, lufs: -16, lufsTolerance: 1.5, maxTruePeak: -1 };

/** The MP4's top-level box types, in file order. */
async function topLevelBoxes(file) {
  const fh = await open(file);
  try {
    const { size } = await fh.stat();
    const types = [];
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size && types.length < 16) {
      await fh.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - offset;
      types.push(type);
      if (boxSize < 8) break;
      offset += boxSize;
    }
    return types;
  } finally {
    await fh.close();
  }
}

/** Prints the checks for one file; resolves with its length, or null if a check failed. */
async function check(file) {
  console.log(path.relative(ROOT, file));
  if (!existsSync(file)) {
    console.log('✗ missing         render it first (npm run render)');
    return null;
  }
  const seconds = await durationSeconds(file);
  const mb = (await stat(file)).size / 1024 / 1024;
  const level = await loudness(file);
  const boxes = await topLevelBoxes(file);
  const faststart = boxes.indexOf('moov') !== -1 && boxes.indexOf('moov') < boxes.indexOf('mdat');

  const checks = [
    ['length', `${seconds.toFixed(1)} s`, seconds >= TARGETS.minSeconds && seconds <= TARGETS.maxSeconds],
    ['size', `${mb.toFixed(1)} MB`, mb <= TARGETS.maxMB],
    ['loudness', `${level.integrated.toFixed(1)} LUFS`, Math.abs(level.integrated - TARGETS.lufs) <= TARGETS.lufsTolerance],
    ['true peak', `${level.truePeak.toFixed(1)} dBTP`, level.truePeak <= TARGETS.maxTruePeak],
    ['loudness range', `${level.range.toFixed(1)} LU`, true],
    ['streams early', faststart ? 'yes (moov before mdat)' : `no (${boxes.join(' ')})`, faststart],
  ];
  for (const [name, value, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name.padEnd(15)} ${value}`);
  return checks.every(([, , ok]) => ok) ? seconds : null;
}

async function main() {
  const args = process.argv.slice(2);
  const files = (args.length ? args : Object.values(CUTS).map((cut) => path.join(OUT, cut.video))).map((f) => path.resolve(f));
  const lengths = [];
  for (const file of files) {
    lengths.push(await check(file));
    console.log('');
  }
  if (lengths.some((s) => s === null)) process.exitCode = 1;
  else if (lengths.length > 1 && Math.max(...lengths) - Math.min(...lengths) > 0.05) {
    console.log(`✗ the cuts differ in length (${lengths.map((s) => `${s.toFixed(2)} s`).join(', ')}); render them again`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
