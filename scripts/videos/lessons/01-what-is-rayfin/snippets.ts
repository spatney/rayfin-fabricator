/**
 * The code Lesson 1 shows, and the hidden checks behind what it claims. `npm run
 * lesson:snippets -- 1` type-checks all of it against the real @microsoft/rayfin-* packages.
 */
import type { Snippet } from '../../src/show/snippet.ts';

/** The methods the client's completion list shows on `client.data.Expense.`, in its order. */
export const CLIENT_METHODS = ['create', 'delete', 'findById', 'findMany', 'groupBy', 'orderBy', 'select', 'update', 'where'] as const;

export const SNIPPETS = {
  /** The entity on screen: as Fabricator's agent writes one, after the Universal App's own starter. */
  expense: {
    file: 'packages/data/src/Expense.ts',
    code: `import { date, decimal, entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Expense {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @decimal() amount!: number;
  @date() spentOn!: Date;
  @text({ max: 200 }) owner_id!: string;
}`,
  },
  /** Proof that every method in the completion list is real, and that a typed query compiles. */
  client: {
    file: 'packages/frontend/src/client-check.ts',
    hidden: true,
    code: `import { RayfinClient } from '@microsoft/rayfin-client';
import type { Expense } from './Expense.js';

declare const client: RayfinClient<{ Expense: Expense }>;
const e = client.data.Expense;
export const methods = [${CLIENT_METHODS.map((m) => `e.${m}`).join(', ')}];
export const titles = () => e.select(['title', 'amount']).orderBy({ spentOn: 'desc' }).execute();`,
  },
} satisfies Record<string, Snippet>;
