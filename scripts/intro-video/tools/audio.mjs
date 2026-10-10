// Audio helpers on top of the ffmpeg build that ships with Remotion, so nothing else needs
// installing. That build is trimmed: it has loudnorm, volume, atempo, silencedetect, the
// WAV muxer and the MP3/AAC encoders, which is all these tools use.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

function binary(name) {
  const dir = path.join(ROOT, 'node_modules', '@remotion');
  const compositor = existsSync(dir) ? readdirSync(dir).find((d) => d.startsWith('compositor-')) : undefined;
  if (!compositor) throw new Error('Remotion is not installed. Run npm install in scripts/intro-video.');
  const exe = path.join(dir, compositor, process.platform === 'win32' ? `${name}.exe` : name);
  if (!existsSync(exe)) throw new Error(`${name} is missing from ${compositor}.`);
  return { exe, dir: path.dirname(exe) };
}

/** Runs ffmpeg or ffprobe. Resolves with stdout as a Buffer and stderr as text. */
export function run(name, args) {
  const { exe, dir } = binary(name);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: { ...process.env, LD_LIBRARY_PATH: dir, DYLD_LIBRARY_PATH: dir },
      windowsHide: true,
    });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${name} exited with ${code}: ${err.slice(-1500)}`));
    });
  });
}

export async function durationSeconds(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.toString().trim());
}

/** EBU R128 numbers from loudnorm's analysis pass: integrated LUFS, true peak, range. */
export async function loudness(file, { i = -16, tp = -1.5, lra = 11 } = {}) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-vn', '-sn',
    '-af', `loudnorm=I=${i}:TP=${tp}:LRA=${lra}:print_format=json`,
    '-f', 'null', '-',
  ]);
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
  const m = JSON.parse(json);
  return {
    integrated: Number(m.input_i),
    truePeak: Number(m.input_tp),
    range: Number(m.input_lra),
    threshold: Number(m.input_thresh),
    offset: Number(m.target_offset),
  };
}

/**
 * Two-pass loudness normalization to `i` LUFS (linear gain when the peak allows it), with an
 * optional pitch-preserving tempo change, encoded as MP3.
 */
export async function normalize(input, output, { i = -16, tp = -1.5, lra = 11, tempo = 1, bitrate = '192k', channels = 1 } = {}) {
  const m = await loudness(input, { i, tp, lra });
  const filters = [];
  if (tempo !== 1) filters.push(`atempo=${tempo}`);
  filters.push(
    `loudnorm=I=${i}:TP=${tp}:LRA=${lra}:measured_I=${m.integrated}:measured_TP=${m.truePeak}` +
      `:measured_LRA=${m.range}:measured_thresh=${m.threshold}:offset=${m.offset}:linear=true`,
  );
  await run('ffmpeg', [
    '-hide_banner', '-y', '-i', input,
    '-af', filters.join(','),
    '-ar', '44100', '-ac', String(channels), '-c:a', 'libmp3lame', '-b:a', bitrate,
    output,
  ]);
}

/** Decodes to mono 16-bit PCM at `sampleRate` and returns the samples. */
export async function pcm(file, sampleRate = 44100) {
  const { stdout } = await run('ffmpeg', [
    '-hide_banner', '-v', 'error', '-i', file,
    '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
  ]);
  // Skip the RIFF header: find the "data" chunk. Piped WAVs may leave its size unset.
  let offset = 12;
  while (offset + 8 <= stdout.length) {
    const id = stdout.toString('ascii', offset, offset + 4);
    const size = stdout.readUInt32LE(offset + 4);
    if (id === 'data') {
      offset += 8;
      break;
    }
    offset += 8 + size;
  }
  const count = Math.floor((stdout.length - offset) / 2);
  const samples = new Int16Array(count);
  for (let n = 0; n < count; n++) samples[n] = stdout.readInt16LE(offset + n * 2);
  return { samples, sampleRate };
}

/**
 * How open Ray's mouth should be on each video frame: RMS loudness per frame, mapped from
 * `floorDb`…`ceilDb` onto 0…1, with a quick attack and a slower release so it reads as talk
 * rather than flicker.
 */
export async function mouthEnvelope(file, fps, { floorDb = -42, ceilDb = -14 } = {}) {
  const { samples, sampleRate } = await pcm(file, 22050);
  const per = sampleRate / fps;
  const frames = Math.ceil(samples.length / per);
  const out = [];
  let level = 0;
  for (let f = 0; f < frames; f++) {
    const from = Math.floor(f * per);
    const to = Math.min(samples.length, Math.floor((f + 1) * per));
    let sum = 0;
    for (let n = from; n < to; n++) sum += (samples[n] / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    const db = 20 * Math.log10(rms + 1e-9);
    const target = Math.min(1, Math.max(0, (db - floorDb) / (ceilDb - floorDb)));
    level = target > level ? level + (target - level) * 0.75 : level + (target - level) * 0.45;
    out.push(Math.round(level * 100) / 100);
  }
  return out;
}
