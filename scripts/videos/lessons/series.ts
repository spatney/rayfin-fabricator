/**
 * The series: its name, Ray's voice, the music and the words every lesson ends with. Pure, so
 * the lesson tools can import it through Node's type stripping.
 */
import { VOICE } from '../script/lines.ts';

export const SERIES = {
  name: 'Learn Rayfin with Ray',
  season: 'Rayfin 101',
  /** Ray's voice: the same as in the intro, so he sounds like himself everywhere. */
  voice: VOICE,
  /**
   * The lessons are read at Ray's natural pace. (The intro speeds him up 6% to fit 90 s; a
   * lesson has room to breathe, and viewers are learning.)
   */
  tempo: 1,
  music: {
    /** The bed under every lesson, in public/. Looped when a lesson runs longer. */
    bed: 'audio/lessons/music/bed.mp3',
    /** Seconds of music to generate: longer than most lessons, so it rarely loops. */
    seconds: 240,
    prompt:
      'Gentle, playful instrumental bed for an animated coding lesson starring a cute cartoon stingray under the sea. ' +
      'Ukulele and marimba melody, soft pizzicato strings, light brushed percussion and bubbly underwater synth plucks. ' +
      '96 BPM, major key, warm and curious, calm enough to talk over. One steady groove from start to finish with gentle ' +
      'variations: no big intro, no drops, no breakdowns and no ending, so it can loop. No vocals.',
  },
  links: {
    channel: 'https://www.youtube.com/@RayfinFabricator',
    fabricator: 'https://spatney.github.io/rayfin-fabricator/',
    rayfin: 'https://rayfin.ai',
  },
  /** On every end screen and in every description. Keep it true. */
  disclaimer: 'A community series by Sachin Patney. Not an official Microsoft channel. Rayfin’s docs live at rayfin.ai.',
  hashtags: ['#Rayfin', '#MicrosoftFabric', '#TypeScript'],
  tags: ['Rayfin', 'Microsoft Fabric', 'TypeScript', 'backend', 'Fabricator', 'GitHub Copilot', 'tutorial', 'Learn Rayfin with Ray'],
} as const;
