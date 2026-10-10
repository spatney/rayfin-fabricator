import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** scripts/intro-video */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The repository root. */
export const REPO = path.resolve(ROOT, '..', '..');
export const PUBLIC = path.join(ROOT, 'public');
export const OUT = path.join(ROOT, 'out');
export const TIMELINE = path.join(ROOT, 'src', 'timeline.json');
export const FPS = 30;
