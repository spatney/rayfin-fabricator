/** Lesson 5 on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: 'Relationships: when to link, and what a delete does | Learn Rayfin with Ray #5',
  summary:
    'A customer has many orders. How does Rayfin know? In lesson 5 of Learn Rayfin with Ray, Ray, the stingray who lives inside ' +
    'Fabricator, works out when your data needs a link and when an entity can stand alone. He links Rayfin entities with the one ' +
    'and many decorators: the foreign key Rayfin adds for you, the imports they need, and how to write and read across a ' +
    'relationship. He builds many-to-many from a join entity, dives into what happens when you delete a record that others still ' +
    'point at, and follows the lines in Blueprint’s Data model view.',
  challenge: {
    task: 'Send this prompt in Fabricator’s chat, then open Blueprint’s Data model and follow the lines.',
    prompt:
      'Add projects, tasks and labels. A project has many tasks, and each task belongs to one project. A task can have many labels, ' +
      'and a label can be on many tasks. Each person only sees their own projects, tasks and labels.',
    question: 'What’s the entity in the middle called? Tell me in the comments.',
  },
  thumbnail: {
    kicker: 'RELATIONSHIPS',
    lines: [{ text: 'ONE TO MANY.' }, { text: 'MANY TO MANY?', accent: true }],
    code: '@one(() => Report)',
    mood: 'happy',
  },
  next: { number: 6, title: 'Permissions and row-level security' },
  tags: ['Rayfin relationships', 'one-to-many', 'many-to-many', 'join entity', 'foreign keys', 'deletes', 'Rayfin 101'],
} satisfies YouTubeSpec;
