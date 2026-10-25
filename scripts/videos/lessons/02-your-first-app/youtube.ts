/** Lesson 2 on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: 'Your first Rayfin app: create, run and ship to Microsoft Fabric | Learn Rayfin with Ray #2',
  summary:
    'What does it take to turn an empty folder into an app that’s live in Microsoft Fabric? In lesson 2 of Learn Rayfin with Ray, Ray, the stingray ' +
    'who lives inside Fabricator, creates a Rayfin app with npm create, runs it with npm run dev (which runs rayfin dev, with the backend in Fabric), ' +
    'and ships it with rayfin up. Then we do the same in Fabricator.',
  challenge: {
    task: 'Create a project in Fabricator, deploy it, and send your first prompt.',
    prompt: 'Make the home page welcome whoever is signed in by their email address, and show today’s date.',
    question: 'What’s the first app you’ll build? Tell me in the comments.',
  },
  thumbnail: {
    kicker: 'YOUR FIRST RAYFIN APP',
    lines: [{ text: 'EMPTY FOLDER' }, { text: 'TO LIVE APP.', accent: true }],
    code: 'npx rayfin up',
    mood: 'happy',
    size: 160,
  },
  next: { number: 3, title: 'Inside a Rayfin app' },
  tags: ['Rayfin quickstart', 'rayfin up', 'rayfin dev', 'npm create', 'Microsoft Fabric apps', 'Rayfin 101'],
} satisfies YouTubeSpec;
