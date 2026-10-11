// Crops, resizes and compresses a raw window capture into a docs screenshot.
//
//   node optimize.mjs <in.png> <out.webp> [--crop x,y,width,height] [--width 1600]
//
// --crop takes logical (CSS) pixels of the captured window; --scale converts them to the
// capture's physical pixels (default: detected from the image width vs. --window 1440).
// When the capture has a light twin (<in>.light.png, as shoot.mjs writes), it gets the same
// treatment into <out>.light.webp. Uses the `sharp` package that the docs site installs
// (website/node_modules).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'website', 'package.json'));
const sharp = require('sharp');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const crop = opt('crop');
const maxWidth = Number(opt('width', 1600));
const windowWidth = Number(opt('window', 1440));
const quality = Number(opt('quality', 88));
const forcedScale = opt('scale');
const [input, output] = args;
if (!input || !output) {
  console.error('usage: node optimize.mjs <in.png> <out.webp> [--crop x,y,w,h] [--width 1600]');
  process.exit(1);
}

async function optimize(from, to) {
  let image = sharp(from);
  const meta = await image.metadata();
  const scale = Number(forcedScale ?? meta.width / windowWidth);
  if (crop) {
    const [x, y, w, h] = crop.split(',').map((n) => Math.round(Number(n) * scale));
    image = image.extract({
      left: x,
      top: y,
      width: Math.min(w, meta.width - x),
      height: Math.min(h, meta.height - y),
    });
  }
  const info = await image
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality, effort: 6, smartSubsample: true })
    .toFile(to);
  console.log(`${to} ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`);
}

const twin = (file, ext) => file.replace(new RegExp(`\\${ext}$`, 'i'), `.light${ext}`);
await optimize(input, output);
const lightInput = twin(input, path.extname(input));
if (!/\.light\.[^.]+$/i.test(input) && existsSync(lightInput)) await optimize(lightInput, twin(output, path.extname(output)));
