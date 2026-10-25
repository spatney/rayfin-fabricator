/** Lesson 3 on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: 'Inside a Rayfin app: packages, rayfin.yml and how it runs in Fabric | Learn Rayfin with Ray #3',
  summary:
    'A new Rayfin app comes with more than a hundred files. What are they all for? In lesson 3 of Learn Rayfin with Ray, Ray, the stingray ' +
    'who lives inside Fabricator, tours a Rayfin app: its frontend, data and shared packages, rayfin.yml and the services it turns on, and the ' +
    'files that stay out of git. Then he dives into how it all runs as a Fabric app, and finds the same pieces in Fabricator.',
  challenge: {
    task: 'Open your app’s Blueprint in Fabricator, send this prompt, then look at Blueprint again.',
    prompt: 'Add a notes page where each signed-in person can write, edit and delete their own notes. Nobody can see anyone else’s notes.',
    question: 'Which new piece showed up in Blueprint? Tell me in the comments.',
  },
  thumbnail: {
    kicker: 'INSIDE A RAYFIN APP',
    lines: [{ text: '142 FILES.' }, { text: 'ONE TOUR.', accent: true }],
    code: 'rayfin/rayfin.yml',
    mood: 'happy',
  },
  next: { number: 4, title: 'Entities and field types' },
  tags: ['Rayfin project structure', 'rayfin.yml', 'Universal App', 'npm workspaces', 'Microsoft Fabric apps', 'Rayfin 101'],
} satisfies YouTubeSpec;
