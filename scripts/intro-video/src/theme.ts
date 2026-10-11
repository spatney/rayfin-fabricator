import { createContext, useContext } from 'react';

/**
 * Colors and type. The video comes in two cuts, like the app and the docs site: dark, in deep
 * water, and light, in sunlit shallows. The composition picks the theme (see Root.tsx) and
 * every component reads it with useTheme().
 *
 * The app's tokens come from its main.css (`:root` for dark, `[data-theme='light']` for
 * light), so a patch that hides part of a screenshot blends into it, and anything drawn like
 * the app looks like the app. Where a patch covers a screenshot, the color is sampled from the
 * screenshot itself, which can be a level off the token. The rest is the video's own look.
 */

export type ThemeName = 'dark' | 'light';

export interface Theme {
  name: ThemeName;

  /* The app's tokens. A patch over a screenshot must match the screenshot in each theme. */
  /** The canvas, as behind the chat. */
  bg: string;
  /** Raised surfaces, such as Ray's speech bubble. */
  bgElev: string;
  /** The chat composer's field. */
  composer: string;
  /** Text fields: the project name, the Design card's prompt. */
  field: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  accent2: string;
  brand: string;
  ok: string;

  /* Words on the water. */
  /** Titles and names. */
  ink: string;
  /** Taglines. */
  inkSoft: string;
  /** Secondary lines. */
  inkDim: string;
  /** Fine print. */
  inkFaint: string;

  /** Under everything; the water covers it. */
  base: string;
  /** What the first frames fade in from. */
  fadeIn: string;

  water: {
    background: string;
    /** Shafts of light from the surface. */
    shafts: string;
    grid: string;
    /** The brighter grid near the top, which pulses slowly. */
    charge: string;
    /** A charge pulse running along the grid, and its glow. */
    pulse: string;
    pulseGlow: string;
    bubbleRing: string;
    bubbleFill: string;
    vignette: string;
    /** Calms the water behind busy screens; `amount` is 0…1. */
    calm: (amount: number) => string;
    /** How strongly sunlight ripples near the surface; 0 for not at all. */
    caustics: number;
  };

  shadow: {
    window: string;
    terminal: string;
    browser: string;
    panel: string;
    tile: string;
    bubble: string;
    chip: string;
    pill: string;
    sampleApp: string;
    button: string;
    title: string;
    /** A CSS filter, for the logo. */
    logo: string;
  };
  /** A glow, as one box-shadow. The light cut stays flat, so there it draws nothing. */
  glow: (color: string, blur: number, spread?: number) => string;
  /** Dims everything around a spotlight; `amount` is 0…1. */
  scrim: (amount: number) => string;
  /** Behind the share dialog. */
  backdrop: string;
  /** Washes out a busy screen behind a big title. */
  titleWash: string;
  /** The flash as the montage gets swept into one window. */
  sweep: string;

  chip: { bg: string; text: string };
  /** The end card's three tags. */
  tag: { bg: string; border: string; text: string };
  /** The Rayfin backend: its panel and service tiles. */
  panel: { bg: string; border: string; tile: string; ghost: string };
  keycap: { bg: string; border: string; edge: string; text: string };
  /** The redeploy status. */
  pill: { bg: string; liveBg: string; text: string; track: string };
  /** The sample app, Contoso Expenses: dark in the dark screenshots, light in the light ones. `mark` is its icon's blue. */
  sampleApp: { bg: string; mark: string; title: string; sub: string; live: string; dot: string };
  /** The browser in the "old way" montage, which never finishes loading. */
  browser: { chrome: string; field: string; url: string; icons: string; page: string; ring: string; spinner: string };
  /** The middle of the Fabric portal. */
  portal: string;

  confetti: readonly string[];
  /** Sparkles: every third one in the first color. */
  sparkle: readonly [string, string];
  /** Bubbles that Ray blows. */
  bubble: { ring: string; fill: string };
  /** Hearts. */
  pink: string;
  /** The stars around his head when he's dizzy. */
  star: string;
}

const DARK: Theme = {
  name: 'dark',

  bg: '#0b0e14',
  bgElev: '#12161f',
  composer: '#131620',
  field: '#1b202c',
  border: '#263041',
  text: '#e6edf3',
  dim: '#9aa7b8',
  accent: '#35a3ea',
  accent2: '#46ccb0',
  brand: '#0f6cbd',
  ok: '#3ddc84',

  ink: '#f4f8fc',
  inkSoft: '#e9f2fb',
  inkDim: '#9aa7b8',
  inkFaint: '#617086',

  base: '#070b12',
  fadeIn: '#000000',

  water: {
    background: 'radial-gradient(ellipse 85% 75% at 50% -5%, #123456 0%, #0b1a2d 42%, #070b12 100%)',
    shafts: 'linear-gradient(180deg, rgba(140,210,255,0.10), rgba(140,210,255,0.025) 55%, transparent 80%)',
    grid: 'rgba(120,170,220,0.075)',
    charge: '#35a3ea55',
    pulse: 'linear-gradient(to right, transparent, #46ccb022 45%, #46ccb099 80%, #c9fff1)',
    pulseGlow: '0 0 12px #46ccb088',
    bubbleRing: '#7fd8ee',
    bubbleFill: 'rgba(127,216,238,0.10)',
    vignette: 'radial-gradient(ellipse 75% 70% at 50% 45%, transparent 55%, rgba(0,0,0,0.55))',
    calm: (amount) => `rgba(4,8,14,${amount})`,
    caustics: 0,
  },

  shadow: {
    window: '0 0 0 1px rgba(255,255,255,0.08), 0 30px 90px rgba(0,0,0,0.55), 0 20px 70px rgba(15,108,189,0.22)',
    terminal: '0 0 0 1px rgba(255,255,255,0.09), 0 24px 60px rgba(0,0,0,0.6)',
    browser: '0 0 0 1px rgba(255,255,255,0.1), 0 24px 60px rgba(0,0,0,0.6)',
    panel: '0 30px 80px rgba(0,0,0,0.45)',
    tile: '0 14px 40px rgba(0,0,0,0.45)',
    bubble: '0 14px 40px rgba(0,0,0,0.45)',
    chip: '0 10px 30px rgba(0,0,0,0.4)',
    pill: '0 10px 24px rgba(0,0,0,0.5)',
    sampleApp: '0 0 0 1px rgba(255,255,255,0.12), 0 18px 50px rgba(0,0,0,0.45)',
    button: '0 16px 50px #0f6cbd77',
    title: '0 8px 30px rgba(0,0,0,0.5)',
    logo: 'drop-shadow(0 6px 22px rgba(0,0,0,0.45))',
  },
  glow: (color, blur, spread = 0) => `0 0 ${blur}px ${spread}px ${color}`,
  scrim: (amount) => `rgba(3,7,13,${amount})`,
  backdrop: 'rgba(3,6,12,0.55)',
  titleWash: 'rgba(4,8,14,0.6)',
  sweep: '#35a3ea',

  chip: { bg: 'rgba(12,18,28,0.88)', text: '#f4f8fc' },
  tag: { bg: 'rgba(14,20,30,0.85)', border: '#263041', text: '#e6edf3' },
  panel: { bg: 'rgba(12,19,30,0.92)', border: '#263041', tile: 'linear-gradient(180deg, #1a2940, #121c2c)', ghost: '#152033' },
  keycap: { bg: '#2b3445', border: '#46536a', edge: '#161c26', text: '#f4f8fc' },
  pill: { bg: '#131a26', liveBg: '#0f2a1d', text: '#f4f8fc', track: '#26303d' },
  sampleApp: { bg: '#292929', mark: '#115ea4', title: '#ffffff', sub: '#c2beb8', live: '#4ade80', dot: '#22c55e' },
  browser: { chrome: '#2b2b2b', field: '#1c1c1c', url: '#d6d6d6', icons: '#a3a3a3', page: '#202020', ring: '#3d3d3d', spinner: '#35a3ea' },
  portal: 'radial-gradient(circle, #46ccb055 0%, #35a3ea33 45%, transparent 70%)',

  confetti: ['#35a3ea', '#46ccb0', '#1d92e2', '#ffb547', '#ff7fa3', '#b8e8fb', '#41c795'],
  sparkle: ['#ffb547', '#e9fbff'],
  bubble: { ring: '#7fd8ee', fill: 'rgba(127,216,238,0.18)' },
  pink: '#ff7fa3',
  star: '#ffb547',
};

/** Soft neutral shadows, as in the app's light theme: things sit on the water without glowing. */
const LIFT = '0 0 0 1px rgba(16,24,40,0.10), 0 18px 44px rgba(16,24,40,0.16)';
const SOFT = '0 8px 24px rgba(16,24,40,0.10)';

const LIGHT: Theme = {
  name: 'light',

  bg: '#eceff5',
  bgElev: '#ffffff',
  composer: '#ffffff',
  field: '#e8ebf3',
  border: '#d5dce6',
  text: '#12161d',
  dim: '#4a5361',
  accent: '#0f6cbd',
  accent2: '#1aa1be',
  brand: '#0f6cbd',
  ok: '#1a8a54',

  ink: '#0b2540',
  inkSoft: '#14324f',
  inkDim: '#3b5873',
  inkFaint: '#4d6579',

  base: '#cdeaf6',
  fadeIn: '#ffffff',

  water: {
    background: 'radial-gradient(ellipse 85% 75% at 50% -5%, #ffffff 0%, #dcf2fb 40%, #b3e0f2 100%)',
    shafts: 'linear-gradient(180deg, rgba(255,255,255,0.7), rgba(255,255,255,0.2) 55%, transparent 85%)',
    grid: 'rgba(15,108,189,0.07)',
    charge: '#0f6cbd33',
    pulse: 'linear-gradient(to right, transparent, #1aa1be1a 45%, #1aa1be80 80%, #1aa1be)',
    pulseGlow: 'none',
    bubbleRing: '#86cbe6',
    bubbleFill: 'rgba(255,255,255,0.8)',
    vignette: 'radial-gradient(ellipse 75% 70% at 50% 45%, transparent 55%, rgba(30,120,170,0.16))',
    calm: (amount) => `rgba(214,237,247,${amount})`,
    caustics: 0.5,
  },

  shadow: {
    window: '0 0 0 1px rgba(16,24,40,0.10), 0 24px 64px rgba(16,24,40,0.16)',
    terminal: LIFT,
    browser: LIFT,
    panel: LIFT,
    tile: SOFT,
    bubble: SOFT,
    chip: SOFT,
    pill: SOFT,
    sampleApp: '0 0 0 1px rgba(16,24,40,0.10), 0 12px 32px rgba(16,24,40,0.14)',
    button: '0 10px 28px rgba(16,24,40,0.16)',
    title: 'none',
    logo: 'none',
  },
  glow: () => '0 0 0 0 transparent',
  scrim: (amount) => `rgba(12,44,72,${(amount * 0.5).toFixed(3)})`,
  backdrop: 'rgba(12,44,72,0.18)',
  titleWash: 'rgba(240,249,253,0.72)',
  sweep: '#ffffff',

  chip: { bg: '#ffffff', text: '#0b2540' },
  tag: { bg: '#ffffff', border: '#cbd8e4', text: '#12161d' },
  panel: { bg: 'rgba(255,255,255,0.92)', border: '#d5dce6', tile: '#ffffff', ghost: '#eef4f9' },
  keycap: { bg: '#ffffff', border: '#c3ccd8', edge: '#a9b4c3', text: '#12161d' },
  pill: { bg: '#ffffff', liveBg: '#e8f6ee', text: '#12161d', track: '#e3e8ef' },
  sampleApp: { bg: '#ffffff', mark: '#0f6cbf', title: '#0a0e12', sub: '#4a5160', live: '#15803d', dot: '#22c55e' },
  browser: { chrome: '#dfe3e8', field: '#ffffff', url: '#3a414b', icons: '#5b6470', page: '#f3f4f6', ring: '#c9d2dc', spinner: '#0f6cbd' },
  portal: 'radial-gradient(circle 150px, rgba(255,255,255,0.75) 0 80%, transparent 80.5%)',

  confetti: ['#0f6cbd', '#1aa1be', '#1d92e2', '#f5a524', '#ff7fa3', '#35a3ea', '#41c795'],
  sparkle: ['#f5a524', '#1d92e2'],
  bubble: { ring: '#7cc7e4', fill: 'rgba(255,255,255,0.85)' },
  pink: '#ff7fa3',
  star: '#f5a524',
};

export const THEMES: Record<ThemeName, Theme> = { dark: DARK, light: LIGHT };

const ThemeContext = createContext<Theme>(DARK);

/** Gives everything inside it a cut's theme. */
export const ThemeProvider = ThemeContext.Provider;

/** The theme of the cut being rendered; dark outside a ThemeProvider. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** `#rrggbb` at an opacity, as rgba(). */
export function alpha(hex: string, opacity: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
}

export const FONT = "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif";
export const MONO = "'Cascadia Code', 'Consolas', ui-monospace, monospace";

export const W = 1920;
export const H = 1080;
