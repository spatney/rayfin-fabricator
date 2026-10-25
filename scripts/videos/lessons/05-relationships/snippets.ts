/**
 * The code lesson 5 shows, and hidden checks behind what it claims. `npm run
 * lesson:snippets -- 5` type-checks all of it against the real @microsoft/rayfin-* packages.
 *
 * The four entities are also the sample app in Fabricator's Data model screenshot
 * (scripts/docs-screenshots/harness, the `model-relations` shot): keep them in step.
 */
import type { Snippet } from '../../src/show/snippet.ts';

const OWNER = `@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})`;

export const SNIPPETS = {
  /** Lesson 4's Expense, filed in a report: the many side gets the one decorator. */
  expense: {
    file: 'packages/data/src/Expense.ts',
    code: `import { date, decimal, entity, one, role, set, text, uuid } from '@microsoft/rayfin-core';
import { Report } from './Report.js';

@entity()
${OWNER}
export class Expense {
  @uuid() id!: string;
  @date() spentOn!: Date;
  @decimal({ min: 0 }) amount!: number;
  @set('Travel', 'Meals', 'Software', 'Office')
  category!: 'Travel' | 'Meals' | 'Software' | 'Office';
  @text({ optional: true, max: 500 }) note?: string;
  @date() createdAt!: Date;
  @one(() => Report, { optional: true }) report?: Report;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /** The one side: many expenses come back through the many decorator. */
  report: {
    file: 'packages/data/src/Report.ts',
    code: `import { entity, many, role, text, uuid } from '@microsoft/rayfin-core';
import { Expense } from './Expense.js';

@entity()
${OWNER}
export class Report {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @many(() => Expense) expenses?: Expense[];
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /** A tag: the other side of the many-to-many. */
  tag: {
    file: 'packages/data/src/Tag.ts',
    code: `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
${OWNER}
export class Tag {
  @uuid() id!: string;
  @text({ max: 50 }) name!: string;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /**
   * The join entity: two one decorators. Its keys are declared, as in /docs/data/relationships'
   * TodoTag, because the app filters by them.
   */
  expenseTag: {
    file: 'packages/data/src/ExpenseTag.ts',
    code: `import { entity, one, role, text, uuid } from '@microsoft/rayfin-core';
import { Expense } from './Expense.js';
import { Tag } from './Tag.js';

@entity()
${OWNER}
export class ExpenseTag {
  @uuid() id!: string;
  @uuid() expense_id!: string;
  @one(() => Expense) expense!: Expense;
  @uuid() tag_id!: string;
  @one(() => Tag) tag!: Tag;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /** All four registered, as lesson 4 showed. */
  register: {
    file: 'packages/data/src/index.ts',
    hidden: true,
    code: `import { Expense } from './Expense.js';
import { ExpenseTag } from './ExpenseTag.js';
import { Report } from './Report.js';
import { Tag } from './Tag.js';

export { Expense, ExpenseTag, Report, Tag };
export const schema = [Expense, Report, Tag, ExpenseTag];`,
  },
  /**
   * Reading and writing across the relationships, typed by the entities. Each call was also run
   * against Rayfin 1.36.2's own backend (see script.ts's Deep Dive note): the update moved an
   * expense, the two selects returned `report: { title }` and `expenses: [{ amount }]`, and the
   * delete failed while the report still had expenses.
   */
  client: {
    file: 'packages/frontend/src/expenses.ts',
    code: `import type { RayfinClient } from '@microsoft/rayfin-client';
import type { Expense } from './Expense.js';
import type { ExpenseTag } from './ExpenseTag.js';
import type { Report } from './Report.js';
import type { Tag } from './Tag.js';

declare const client: RayfinClient<{ Expense: Expense; Report: Report; Tag: Tag; ExpenseTag: ExpenseTag }>;
declare const expense: Expense;
declare const report: Report;

export const file = () => client.data.Expense.update({ id: expense.id }, { report: { id: report.id } });

export const withReports = () => client.data.Expense.select(['amount', 'spentOn', 'report.title']).execute();

export const reportsWithExpenses = () => client.data.Report.select(['title', 'expenses.amount']).execute();

export const tagsOf = () => client.data.ExpenseTag.select(['tag.name']).where({ expense_id: { eq: expense.id } }).execute();

export const removeReport = () => client.data.Report.delete({ id: report.id });`,
  },
  /**
   * The quiz's answer, compiled: students and classes through an Enrollment join entity. Its
   * keys are declared like ExpenseTag's. Not shown since the quiz moved to deletes; kept as a
   * check of the join-entity pattern the lesson teaches.
   */
  enrollment: {
    file: 'packages/data/src/Enrollment.ts',
    hidden: true,
    code: `import { entity, one, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
${OWNER}
export class Student {
  @uuid() id!: string;
  @text({ max: 100 }) name!: string;
  @text({ max: 200 }) owner_id!: string;
}

@entity()
${OWNER}
export class Course {
  @uuid() id!: string;
  @text({ max: 100 }) title!: string;
  @text({ max: 200 }) owner_id!: string;
}

@entity()
${OWNER}
export class Enrollment {
  @uuid() id!: string;
  @uuid() student_id!: string;
  @one(() => Student) student!: Student;
  @uuid() course_id!: string;
  @one(() => Course) course!: Course;
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
