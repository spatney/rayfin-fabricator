/** Lesson 6 on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: 'Permissions and row-level security: your rows, nobody else’s | Learn Rayfin with Ray #6',
  summary:
    'Your data, your rows. Nobody else’s. In lesson 6 of Learn Rayfin with Ray, Ray, the stingray who lives inside Fabricator, ' +
    'secures an expense app with Rayfin’s permission decorators: who can create, read, update and delete, and a row-level policy ' +
    'on claims.sub that keeps each person’s expenses their own. Then he dives into an entity with no permission decorator at all, ' +
    'shows why a filter in your app isn’t security, and finds the access dots and the Harden button in Blueprint’s Data model view.',
  challenge: {
    task: 'Send this prompt in Fabricator’s chat, then open Blueprint’s Data model and find the new entity’s access dot.',
    prompt: 'Add a journal where each person writes private entries. Only the person who wrote an entry can read, edit or delete it.',
    question: 'Which access does its dot show? Tell me in the comments.',
  },
  thumbnail: {
    kicker: 'PERMISSIONS',
    lines: [{ text: 'YOUR ROWS.' }, { text: 'NOBODY ELSE’S.', accent: true }],
    code: 'claims.sub.eq(…)',
    mood: 'happy',
  },
  next: { number: 7, title: 'Reading and writing your data' },
  tags: ['Rayfin permissions', 'row-level security', 'access control', 'claims', 'authorization', 'Rayfin 101'],
} satisfies YouTubeSpec;
