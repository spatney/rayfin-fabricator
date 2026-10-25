/** Lesson 1 on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: 'What is Rayfin? One TypeScript class, a whole backend | Learn Rayfin with Ray #1',
  summary:
    'What if your whole backend was one TypeScript class? In lesson 1 of Learn Rayfin with Ray, Ray, the stingray who lives inside Fabricator, ' +
    'shows how Rayfin turns a decorated TypeScript class into a database table, REST and GraphQL APIs, a type-safe client, row-level security ' +
    'and form validation, and how one command, rayfin up, ships it all to Microsoft Fabric. Then we watch Fabricator do it.',
  challenge: {
    task: 'Open Fabricator, describe a tiny app, and find its entity in Blueprint.',
    prompt: "Build a reading list where I can add books with a title, an author and a checkbox for when I've finished. Only I should see my books.",
    question: 'What did you build? Tell me in the comments.',
  },
  thumbnail: {
    kicker: 'WHAT IS RAYFIN?',
    lines: [{ text: 'ONE CLASS.' }, { text: 'WHOLE BACKEND.', accent: true }],
    code: '@entity()',
    mood: 'happy',
  },
  next: { number: 2, title: 'Your first Rayfin app' },
  tags: ['what is Rayfin', 'Rayfin tutorial', 'TypeScript decorators', 'row-level security', 'backend as a service', 'Rayfin 101'],
} satisfies YouTubeSpec;
