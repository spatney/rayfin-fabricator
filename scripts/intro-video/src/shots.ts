/**
 * The docs site's screenshots that the video shows, with their size in pixels. Pure and
 * React-free: the scenes use it, and so do tools/sync-assets.mjs and tools/publish.mjs
 * (through Node's type stripping) to check that every one is there in both themes.
 *
 * Each is website/public/screenshots/<id>.webp in the dark theme and <id>.light.webp in the
 * light one, copied into public/ui by `npm run assets`. The two have the same size and
 * layout, so overlays placed in image pixels fit either.
 */
import type { ThemeName } from './theme';

export interface Shot {
  /** The screenshot's name in website/public/screenshots. */
  id: string;
  w: number;
  h: number;
}

export const SHOTS = {
  workbench: { id: 'workbench', w: 1600, h: 1000 },
  chatWorking: { id: 'chat-working', w: 1600, h: 1000 },
  newProject: { id: 'new-project', w: 1600, h: 422 },
  deployProgress: { id: 'deploy-progress', w: 1140, h: 1080 },
  design: { id: 'design', w: 1080, h: 1290 },
  advisor: { id: 'advisor', w: 1600, h: 1000 },
  blueprint: { id: 'blueprint', w: 1600, h: 1000 },
  help: { id: 'help', w: 1600, h: 756 },
  share: { id: 'share', w: 960, h: 630 },
  deployError: { id: 'deploy-error', w: 1356, h: 201 },
} satisfies Record<string, Shot>;

/** A screenshot's file for a cut: `<id>.webp` in the dark one, `<id>.light.webp` in the light one. */
export function shotFile(shot: Shot, theme: ThemeName): string {
  return `${shot.id}${theme === 'light' ? '.light' : ''}.webp`;
}
