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

/**
 * The two cuts, one per docs site theme: their compositions (src/Root.tsx) and the files they
 * render to in out/ and publish as in website/public/video/.
 */
export const CUTS = {
  dark: { composition: 'FabricatorIntro', poster: 'Poster', video: 'fabricator-intro.mp4', posterFile: 'fabricator-intro-poster.webp' },
  light: { composition: 'FabricatorIntroLight', poster: 'PosterLight', video: 'fabricator-intro.light.mp4', posterFile: 'fabricator-intro-poster.light.webp' },
};
