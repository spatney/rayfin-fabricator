/**
 * What Ray says in the intro video, in order. This file is the single source of truth for the
 * voiceover (tools/voice.mjs), the captions and transcript (tools/captions.mjs) and the scenes
 * (src/scenes), which look lines up by `id`.
 *
 * Text in square brackets is an ElevenLabs audio tag: it steers the delivery and is never
 * spoken, captioned or transcribed. Every claim is checked against README.md, against Ray's
 * own lines in src/renderer/src/components/mascot/lines.ts and, for Rayfin itself, against
 * https://rayfin.ai; keep them true when those change. No hype words ("simply", "easy",
 * "powerful", "seamless").
 */

export interface ScriptLine {
  /** Stable id: names the audio file and lets scenes find the line's timing. */
  id: string;
  /** What Ray says, with audio tags. */
  text: string;
  /** Overrides VOICE.seed for a retake of this line. */
  seed?: number;
}

/** Ray's voice: chosen from the auditions (`npm run audition`). */
export const VOICE = {
  name: 'Hale v3',
  voiceId: 'wWWn96OtTHu1sn8SRGEr',
  modelId: 'eleven_v4',
  /** A fixed seed keeps retakes of unchanged lines stable. */
  seed: 4242,
} as const;

export const LINES: readonly ScriptLine[] = [
  {
    id: 'hello',
    text: "[excited] Oh, hi! I'm Ray, the stingray who lives inside Fabricator.",
  },
  {
    id: 'old-way',
    text: 'Building a Rayfin app usually means juggling CLIs, Copilot, git and a browser… [dizzy] whoa. The room is spinning.',
  },
  {
    id: 'one-window',
    text: '[relieved] Fabricator puts it all in one window.',
  },
  {
    id: 'fabric',
    text: "Name your app, and I'll swim it over to Microsoft Fabric. [delighted] Hey, that's me! Fins crossed.",
  },
  {
    id: 'backend',
    text: "[impressed] And on deploy, Rayfin sets up your whole backend, automatically: database, APIs, auth, storage, functions and hosting. Scalable, governed, and inside your organization's boundary. [proudly] You didn't lift a fin.",
  },
  {
    id: 'describe',
    text: 'Then describe what you want, in plain English. GitHub Copilot writes the code… [cheering] and I cheer!',
  },
  {
    id: 'preview',
    text: 'Your app runs live, right next to the chat. See something to change? Point at it in Design, and ask.',
  },
  {
    id: 'ship',
    text: "After every successful chat turn, Fabricator redeploys your app. [gasps] It's live! Then share it with people in your organization.",
  },
  {
    id: 'tricks',
    text: "The Advisor grades your app's health. History keeps every change. [whispering] And if something breaks, I'll dig through the logs with you.",
  },
  {
    id: 'outro',
    text: 'It runs on the GitHub Copilot account you already have. [excited] Download Fabricator, and come say hi!',
  },
  {
    id: 'stinger',
    text: "[whispers] Psst… a group of stingrays is called a fever. [giggles] I'm not making that up.",
  },
];

/** The text as spoken and captioned: audio tags removed, spacing tidied. */
export function spokenText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
