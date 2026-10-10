// Copies the docs site's screenshots and logo into public/ui/, where the scenes load them.
// The screenshots are scrubbed sample data (see scripts/docs-screenshots); refresh those
// first when the app's UI changes, then rerun this and render again.
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC, REPO } from './paths.mjs';

const site = path.join(REPO, 'website', 'public');
const dest = path.join(PUBLIC, 'ui');
await mkdir(dest, { recursive: true });

const shots = (await readdir(path.join(site, 'screenshots'))).filter((f) => f.endsWith('.webp'));
for (const file of shots) await copyFile(path.join(site, 'screenshots', file), path.join(dest, file));
await copyFile(path.join(site, 'fabricator-logo.png'), path.join(dest, 'fabricator-logo.png'));
console.log(`${shots.length} screenshots and the logo → ${path.relative(process.cwd(), dest)}`);
