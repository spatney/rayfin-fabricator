/**
 * The code lesson 6 shows, and hidden checks behind what it claims. `npm run
 * lesson:snippets -- 6` type-checks all of it against the real @microsoft/rayfin-* packages.
 *
 * What the Deep Dive says the backend does with this code was checked on Rayfin 1.36.2's own
 * backend: see script.ts.
 */
import type { Snippet } from '../../src/show/snippet.ts';

/** Lesson 4's categories. */
export const CATEGORIES = ['Travel', 'Meals', 'Software', 'Office'] as const;
const union = CATEGORIES.map((c) => `'${c}'`).join(' | ');

/** Lesson 4's Expense from `@entity()` down, after `head` (its import line and permission). */
const expenseBody = (name: string) => `export class ${name} {
  @uuid() id!: string;
  @date() spentOn!: Date;
  @decimal({ min: 0 }) amount!: number;
  @set(${CATEGORIES.map((c) => `'${c}'`).join(', ')})
  category!: ${union};
  @text({ optional: true, max: 500 }) note?: string;
  @date() createdAt!: Date;
  @text({ max: 200 }) owner_id!: string;
}`;

export const SNIPPETS = {
  /** Lesson 4's Expense, with the authenticated shorthand and an owner policy. */
  expense: {
    file: 'packages/data/src/Expense.ts',
    code: `import { authenticated, date, decimal, entity, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
${expenseBody('Expense')}`,
  },
  /**
   * The same rule as lessons 4 and 5 wrote it, with the role decorator: the shorthand stands for
   * this. Shown as Expense.ts, checked as RoleExpense.ts.
   */
  roleForm: {
    file: 'packages/data/src/Expense.ts',
    checkAs: 'RoleExpense.ts',
    code: `import { date, decimal, entity, role, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
${expenseBody('Expense')}`,
  },
  /**
   * The Deep Dive's Expense: no permission decorator at all. It compiles; that's the trouble. Shown
   * as Expense.ts, checked as BareExpense.ts beside the lesson's other Expense.
   */
  bare: {
    file: 'packages/data/src/Expense.ts',
    checkAs: 'BareExpense.ts',
    code: `import { date, decimal, entity, set, text, uuid } from '@microsoft/rayfin-core';

@entity()
${expenseBody('Expense')}`,
  },
  /** wd-2 and wd-3's grants: some actions, or all four; and wd-4's anonymous read. */
  grants: {
    file: 'packages/data/src/grants.ts',
    code: `import { anonymous, authenticated, entity, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*')
export class Everything {
  @uuid() id!: string;
  @text({ max: 100 }) name!: string;
}

@entity()
@authenticated('read')
export class ReadOnly {
  @uuid() id!: string;
  @text({ max: 100 }) name!: string;
}

@entity()
@authenticated(['create', 'read'])
export class AddAndRead {
  @uuid() id!: string;
  @text({ max: 100 }) name!: string;
}

@entity()
@anonymous('read')
export class Notice {
  @uuid() id!: string;
  @text({ max: 100 }) title!: string;
}`,
  },
  /**
   * ro-4's claims and composition, and its compile-time check: a misspelled field in a policy, or
   * a claim the DSL doesn't have, is an error. The scene shows the misspelled line.
   */
  claims: {
    file: 'packages/data/src/claims.ts',
    code: `import { authenticated, boolean, entity, text, uuid } from '@microsoft/rayfin-core';

@entity()
@authenticated('*', {
  policy: (claims, item) => claims.role.eq('admin').or(claims.sub.eq(item.owner_id)),
})
export class Ticket {
  @uuid() id!: string;
  @text({ max: 200 }) owner_id!: string;
}

@entity()
@authenticated('read', {
  policy: (claims, item) => claims.email.eq(item.contact).and(item.archived.eq(false)),
})
export class Lead {
  @uuid() id!: string;
  @text({ max: 254 }) contact!: string;
  @boolean({ default: false }) archived!: boolean;
}

@entity()
@authenticated('*', {
  // @ts-expect-error: item has no field named ownr_id
  policy: (claims, item) => claims.sub.eq(item.ownr_id),
})
export class Typo {
  @uuid() id!: string;
  @text({ max: 200 }) owner_id!: string;
}

@entity()
@authenticated('*', {
  // @ts-expect-error: there's no tenant claim
  policy: (claims, item) => claims.tenant.eq(item.owner_id),
})
export class NoTenant {
  @uuid() id!: string;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /**
   * Creating a row: the policy checks owner_id but doesn't fill it in, so the app sets it from the
   * session (rayfin-core's assets/docs/permissions.md shows the same session check).
   */
  create: {
    file: 'packages/frontend/src/expenses.ts',
    code: `import type { RayfinClient } from '@microsoft/rayfin-client';
import type { Expense } from './Expense.js';

declare const client: RayfinClient<{ Expense: Expense }>;

export async function addExpense(amount: number) {
  const session = client.auth.getSession();
  if (!session.isAuthenticated || !session.user) throw new Error('Not signed in.');

  return client.data.Expense.create({
    spentOn: new Date(),
    amount,
    category: 'Travel',
    createdAt: new Date(),
    owner_id: session.user.id,
  });
}`,
  },
  /** The Deep Dive's two questions: the app's filtered one, and anyone's unfiltered one. */
  filter: {
    file: 'packages/frontend/src/my-expenses.ts',
    code: `import type { RayfinClient } from '@microsoft/rayfin-client';
import type { Expense } from './BareExpense.js';

declare const client: RayfinClient<{ Expense: Expense }>;
declare const me: string;

export const mine = () => client.data.Expense.select(['note', 'amount']).where({ owner_id: { eq: me } }).execute();

export const everyone = () => client.data.Expense.select(['note', 'amount', 'owner_id']).execute();`,
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
