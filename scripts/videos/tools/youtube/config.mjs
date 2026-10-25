// Where the YouTube tools keep their state, and how they reach the browser and the driver.
import os from 'node:os';
import path from 'node:path';
import { OUT } from '../paths.mjs';

/** The browser's DevTools port, on 127.0.0.1. */
export const CDP_PORT = Number(process.env.YT_CDP_PORT ?? 9333);
/** The driver's port, on 127.0.0.1. */
export const DRIVER_PORT = Number(process.env.YT_DRIVER_PORT ?? 9334);
/**
 * Outside the repo, because the browser profile holds a signed-in Google session: the profile,
 * and the token that lets `npm run yt` talk to the driver.
 */
export const STATE = process.env.YT_STATE ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'fabricator-videos', 'youtube');
export const PROFILE = path.join(STATE, 'browser-profile');
export const TOKEN = path.join(STATE, 'driver.token');
/** The screenshots the steps take, to look at after each step. */
export const SHOTS = path.join(OUT, 'youtube', 'shots');

/** The browser's DevTools version info, or null when no browser is listening. */
export async function devtools() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
