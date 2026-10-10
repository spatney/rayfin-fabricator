// Checks a rendered cut against its delivery targets: length, file size, loudness, true peak,
// and whether it can start playing before it has fully downloaded (moov before mdat).
//
//   node tools/loudness.mjs [file]      defaults to out/fabricator-intro.mp4
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { durationSeconds, loudness } from './audio.mjs';
import { OUT } from './paths.mjs';

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

async function main() {
  const file = path.resolve(process.argv[2] ?? path.join(OUT, 'fabricator-intro.mp4'));
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
  if (checks.some(([, , ok]) => !ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
