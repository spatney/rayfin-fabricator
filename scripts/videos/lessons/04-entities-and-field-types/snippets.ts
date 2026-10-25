/**
 * The code lesson 4 shows, and hidden checks behind what it claims. `npm run
 * lesson:snippets -- 4` type-checks all of it against the real @microsoft/rayfin-* packages.
 *
 * Scenes that show a line or two of a file take them from these snippets with `lines()`, so
 * every line on screen is a line that compiles.
 */
import type { Snippet } from '../../src/show/snippet.ts';

/** A set's values: the categories of the expense tracker in Fabricator's docs screenshots. */
export const CATEGORIES = ['Travel', 'Meals', 'Software', 'Office'] as const;

const union = CATEGORIES.map((c) => `'${c}'`).join(' | ');

export const SNIPPETS = {
  /**
   * The lesson's entity, after the Universal App's starter (data-modeling kit's Item.ts): its
   * fields are those of the Expense card in Fabricator's Data model screenshot, in its order.
   */
  expense: {
    file: 'packages/data/src/Expense.ts',
    code: `import { date, decimal, entity, role, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Expense {
  @uuid() id!: string;
  @date() spentOn!: Date;
  @decimal({ min: 0 }) amount!: number;
  @set(${CATEGORIES.map((c) => `'${c}'`).join(', ')})
  category!: ${union};
  @text({ optional: true, max: 500 }) note?: string;
  @date() createdAt!: Date;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /** Two more options, default and unique, on the decorators Expense doesn't use. */
  teammate: {
    file: 'packages/data/src/Teammate.ts',
    code: `import { boolean, email, entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Teammate {
  @uuid() id!: string;
  @email({ unique: true, max: 254 }) email!: string;
  @boolean({ default: false }) canApprove!: boolean;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /**
   * Registering it in the data package, as the data-modeling pack seeds the file
   * (kit/data/schema.ts: `export { Item };` and `export const schema = [Item];`).
   */
  register: {
    file: 'packages/data/src/index.ts',
    code: `import { Expense } from './Expense.js';

export { Expense };
export const schema = [Expense];`,
  },
  /** Its record in the shared package, as the pack seeds it (kit/shared/index.ts). */
  shared: {
    file: 'packages/shared/src/index.ts',
    checkAs: 'shared-index.ts',
    code: `export interface ExpenseRecord {
  id: string;
  spentOn: Date;
  amount: number;
  category: ${union};
  note?: string;
  createdAt: Date;
  owner_id: string;
}

export type UniversalAppSchema = {
  Expense: ExpenseRecord;
};`,
  },
  /**
   * Proof that the record and the entity agree field for field, and that UniversalAppSchema is
   * what types the client (packages/frontend/src/lib/rayfin-client.ts: RayfinClient<UniversalAppSchema>).
   */
  typed: {
    file: 'packages/frontend/src/typed-check.ts',
    hidden: true,
    code: `import type { RayfinClient } from '@microsoft/rayfin-client';
import type { Expense } from './Expense.js';
import type { ExpenseRecord, UniversalAppSchema } from './shared-index.js';

export const toRecord = (e: Expense): ExpenseRecord => e;
export const toEntity = (r: ExpenseRecord): Expense => r;

declare const client: RayfinClient<UniversalAppSchema>;
export const recent = () =>
  client.data.Expense.select(['amount', 'category', 'note', 'spentOn']).orderBy({ spentOn: 'desc' }).execute();
// @ts-expect-error: a field the entity doesn't have
export const typo = () => client.data.Expense.select(['amout']).execute();`,
  },
  /** The quiz's field, and the Deep Dive's: text with no max. It compiles; it's the deploy that hurts. */
  task: {
    file: 'packages/data/src/Task.ts',
    code: `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Task {
  @uuid() id!: string;
  @text() title!: string;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /** The Deep Dive's fix. */
  taskFixed: {
    file: 'packages/data/src/TaskFixed.ts',
    hidden: true,
    code: `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity('Task')
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class TaskFixed {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /**
   * dd-5's "a max that fits its data": fifty for a short name, two thousand for a description,
   * the field-types page's own examples.
   */
  project: {
    file: 'packages/data/src/Project.ts',
    code: `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Project {
  @uuid() id!: string;
  @text({ max: 50 }) name!: string;
  @text({ max: 2000 }) description!: string;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /**
   * The validator op-5 mentions, built from the entity (/docs/data/validation). The id is left out
   * for you; the omit list names the fields the app fills in itself. Its messages, such as
   * "Field 'amount' must be >= 0", are in rayfin-core's dist/standard-schema.js.
   */
  validator: {
    file: 'packages/data/src/expenseForm.ts',
    hidden: true,
    code: `import { toStandardSchema } from '@microsoft/rayfin-core';
import { Expense } from './Expense.js';

export const expenseForm = toStandardSchema(Expense, { omit: ['createdAt', 'owner_id'] as const });

const result = expenseForm.validate({ spentOn: new Date(), amount: -5, category: 'Travel' });
export const messages = result.issues?.map((issue) => issue.message) ?? [];`,
  },
  /** The reserved-name workaround the known-limitations page gives: keep the class, rename the entity. */
  eventDate: {
    file: 'packages/data/src/EventDate.ts',
    hidden: true,
    code: `import { date, entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity('EventDate')
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class EventDate {
  @uuid() id!: string;
  @date() on!: Date;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
} satisfies Record<string, Snippet>;

/** Lines `from` to `to` (1-based, inclusive) of a snippet, as a scene shows them. */
export function lines(key: keyof typeof SNIPPETS, from: number, to = from): string {
  return SNIPPETS[key].code.split('\n').slice(from - 1, to).join('\n');
}

/** The one line of a snippet that contains `text`, without its indent: for a scene that shows a single line. */
export function lineWith(key: keyof typeof SNIPPETS, text: string): string {
  const line = SNIPPETS[key].code.split('\n').find((l) => l.includes(text));
  if (!line) throw new Error(`"${text}" isn't in snippet ${key}.`);
  return line.trim();
}
