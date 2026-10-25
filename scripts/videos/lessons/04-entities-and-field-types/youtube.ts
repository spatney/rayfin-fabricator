/** Lesson 4 on YouTube: its title, description, thumbnail, challenge and what comes next. */
import type { YouTubeSpec } from '../../src/show/youtube.ts';

export const YOUTUBE = {
  title: 'Entities and field types: why every text needs a max | Learn Rayfin with Ray #4',
  summary:
    'Every field in a Rayfin entity gets a decorator. So what does each one actually do? In lesson 4 of Learn Rayfin with Ray, Ray, the ' +
    'stingray who lives inside Fabricator, writes an entity field by field: the eight field decorators, the options that shape each ' +
    'field, and how to register it in the data and shared packages. Then he dives into why every text field needs a max, and finds it all ' +
    'in Blueprint’s Data model view.',
  challenge: {
    task: 'Send this prompt in Fabricator’s chat, then open Blueprint’s Data model and find your new entity.',
    prompt:
      'Add a Trip entity: a destination (text, at most 100 characters), a start date and an end date, a budget in dollars, a status that’s ' +
      'planned, booked or done, and an optional note. Each person only sees their own trips.',
    question: 'Which decorators did your Trip get? Tell me in the comments.',
  },
  thumbnail: {
    kicker: 'ENTITIES AND FIELD TYPES',
    lines: [{ text: 'EVERY TEXT' }, { text: 'NEEDS A MAX.', accent: true }],
    code: '@text({ max: 200 })',
    mood: 'happy',
  },
  next: { number: 5, title: 'Relationships' },
  tags: ['Rayfin entities', 'Rayfin field types', 'TypeScript decorators', 'Rayfin data model', 'GraphQL schema', 'Rayfin 101'],
} satisfies YouTubeSpec;
