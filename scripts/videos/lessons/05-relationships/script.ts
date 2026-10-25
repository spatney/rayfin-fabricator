/**
 * Lesson 5: Relationships. What Ray says, beat by beat. The single source of truth for the
 * lesson's voice, its captions and chapters, and its scenes (scenes.tsx), which find beats
 * and words here by id.
 *
 * Every claim is checked against Rayfin 1.36.2: rayfin.ai, and the scratch app the lesson tools
 * scaffold with the installed CLI (.cache/rayfin-check/1.36.2/app), whose files and
 * node_modules/@microsoft/rayfin-* docs and types are version-locked. Fabricator's claims come
 * from its docs and source. Each line lists the pages it rests on; where the scratch app says
 * more than the pages, the note beside the line names the file.
 *
 * rayfin.ai doesn't say what a delete does to linked records, so the Deep Dive's claims were
 * checked on Rayfin 1.36.2's own backend (`rayfin dev --provider docker`, the
 * webservice:cli-1.36.2 image), on SQL Server and PostgreSQL alike, through the client with
 * this lesson's four entities. Every one decorator became a foreign key with no delete rule.
 * Deleting a record that others still point at failed, and so did linking to a record that
 * doesn't exist, both with "Cannot complete this operation because other items depend on this
 * record. Remove the dependent items first." Moving the expenses, or deleting them (and a tag's
 * links) first, let the delete through. The notes beside those lines say which check backs them.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

const REL = `${R}/data/relationships`;
const FIELDS = `${R}/data/field-types`;
const MUT = `${R}/data/mutations`;
const QRY = `${R}/data/querying`;
const BLUEPRINT = `${F}/build/data-model`;

/** How Ray says the keys, as separate words (joined with hyphens, the voice reads "dash"). */
const KEYS = { expense_id: 'expense underscore I D' } as const;
/** is-2's owner column. */
const OWNER = { owner_id: 'owner underscore I D' } as const;
/** cl-3's dot path. */
const REPORT_TITLE = { 'report.title': 'report dot title' } as const;
/** cl-4's dot path, through the many side. */
const AMOUNTS = { 'expenses.amount': 'expenses dot amount' } as const;
/** mm-4's key suffix and the IDs' type, letter by letter. */
const SUFFIX = { _id: 'underscore I D', UUID: 'U U I D' } as const;
/** mm-5's key and dot path. */
const TAG_QUERY = { ...KEYS, 'tag.name': 'tag dot name' } as const;

export const SCRIPT = {
  number: 5,
  slug: '05-relationships',
  title: 'Relationships',
  rayfinVersion: '1.36.2',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'How does Rayfin know?',
      lead: 0.3,
      beats: [
        // Lesson 4's next-up line promised "how Rayfin knows a customer has many orders".
        { id: 'hook', text: '[curious] A customer has many orders, and a report has many expenses. How does Rayfin know which ones go together?', sources: [REL] },
        { id: 'hook-2', text: '[excited] Two decorators, one on each side, and Rayfin builds the link for you.', sources: [REL] },
      ],
    },
    {
      id: 'bumper',
      lead: 0.2,
      // The jingle's sound ends about 3.3 s in; holding longer leaves dead air before Ray's hello.
      beats: [{ id: 'jingle', hold: 3.4 }],
    },
    {
      id: 'welcome',
      beats: [
        { id: 'welcome', text: "[delighted] Hi, I'm Ray! Welcome back to Learn Rayfin with Ray." },
        { id: 'today', text: "[excited] Today: when to link your data, the one and many decorators, and what happens when you delete. Let's dive in!" },
      ],
    },
    {
      id: 'islands',
      chapter: 'Islands or links?',
      beats: [
        // Lesson 4's Expense: no relationship decorators, so it links to nothing.
        { id: 'is-1', text: "The Expense we built last time stands alone, like an island. For a lot of data, that's all you need." },
        // @set: "A fixed list of allowed string literals." And "A user_id field populated from
        // claims.sub ... is not a foreign key to another Rayfin entity — it is a plain @text() field."
        { id: 'is-2', text: 'Its category is a fixed list, so the set decorator does the job. And owner_id is plain text from sign-in, not a link.', say: OWNER, sources: [FIELDS, REL] },
        { id: 'is-3', text: '[curious] Reports are different. People create them, rename them, and file many expenses in each.' },
        { id: 'is-4', text: "Store the report's title on each expense, and a rename means editing them all. One typo, and you've got two reports." },
        { id: 'is-5', gap: 0.4, text: 'So when people create something and share it, give it its own entity, and link to it.' },
      ],
    },
    {
      id: 'one-many',
      chapter: 'One and many',
      beats: [
        // `@one(() => Notebook, { optional: true }) notebook?: Notebook; // a note may be unfiled`
        { id: 'om-1', text: 'On the expense, the one decorator points at a single report. A question mark makes it optional: an expense can wait to be filed.', sources: [REL] },
        // "Rayfin auto-generates a {property}_id foreign key column for it": report_id.
        { id: 'om-2', text: "Rayfin adds a column to your expenses for the report's ID: a foreign key. You don't write it yourself.", sources: [REL] },
        // "It does not generate a column — it is a read-only navigation back to the rows whose
        // @one() field points at this record."
        { id: 'om-3', text: "On the report, the many decorator points back at its expenses. It adds no column.", sources: [REL] },
        // The lazy arrow lets two entity files reference each other; `import type` is erased, so
        // "the arrow function would close over a name that no longer exists at runtime".
        { id: 'om-4', text: 'Both take an arrow that returns the class, so the files can import each other. Use a plain import, not import type.', sources: [REL] },
      ],
    },
    {
      id: 'client',
      chapter: 'Write and read across it',
      beats: [
        // "pass the related object — either the full object or an object containing just its id —
        // never the raw foreign key column directly"; the client converts it to report_id.
        { id: 'cl-1', text: "To file an expense, update it with the report's ID, in an object. The client fills in the foreign key.", sources: [MUT] },
        // "@many() fields are the inverse side of a relationship and are read-only in mutations".
        { id: 'cl-2', text: "The many side is read-only. To move an expense, update the expense, not the report.", sources: [MUT] },
        // Dot-paths are select-only, one level past the root entity.
        { id: 'cl-3', text: "To read across it, select a dot path like report.title, and each expense brings its report's title.", say: REPORT_TITLE, sources: [QRY] },
        // The docs' dot paths are all on the one side. This one, through the many side, compiles
        // (snippets.ts's client) and on the 1.36.2 backend returned
        // [{"title":"Q4 travel","expenses":[{"amount":18.2}]}].
        { id: 'cl-4', text: "From the report's side, select expenses.amount, and each report brings its amounts, ready to add up.", say: AMOUNTS, sources: [QRY] },
      ],
    },
    {
      id: 'many-many',
      chapter: 'Many on both sides',
      beats: [
        { id: 'mm-1', text: '[curious] Now tags. An expense can have many tags, and a tag can be on many expenses.', sources: [REL] },
        { id: 'mm-2', text: "Rayfin doesn't do many-to-many directly, so you add a join entity with two one decorators.", sources: [REL] },
        { id: 'mm-3', text: 'Each ExpenseTag is one link: this expense, with that tag.', sources: [REL] },
        // "Define the FK field explicitly only when your application code needs to read or set it
        // directly (for example, filtering by it)", named {property}_id and declared @uuid().
        { id: 'mm-4', gap: 0.4, text: "It declares its keys to filter by them: each property's name plus _id, holding a UUID.", say: SUFFIX, sources: [REL, QRY] },
        // "select TodoTag rows filtered by todo_id, with tag.name in the field selection".
        { id: 'mm-5', text: "To find an expense's tags, query ExpenseTag by expense_id, and select tag.name.", say: TAG_QUERY, sources: [REL, QRY] },
      ],
    },
    {
      id: 'deep-dive',
      chapter: 'Deep Dive: when you delete',
      beats: [
        { id: 'dive', text: '[excited] Time for a deep dive! [curious] What happens when you delete a report that still has expenses?' },
        // Checked on the 1.36.2 backend: FK_Expenses_report_id and the ExpenseTag keys are
        // foreign keys, and creating an expense in a report that doesn't exist failed.
        { id: 'dd-1', text: "Each one decorator is a real foreign key in your database. An expense can't be filed in a report that doesn't exist.", sources: [REL] },
        // Checked: deleting a report with an expense in it failed, with the message the scene
        // shows, and the report stayed. The optional link didn't unfile the expense either.
        { id: 'dd-2', text: "And a report with expenses in it can't be deleted. The delete fails, and tells you why." },
        // `@one()` and `@many()` "accept only { optional?: boolean, unique?: boolean }": no delete
        // rule to set. Checked: the foreign keys have none, so nothing cascaded.
        { id: 'dd-3', gap: 0.4, text: "Rayfin doesn't cascade, and the one decorator has no option to. [relieved] For expenses, that's what you want.", sources: [REL] },
        { id: 'dd-4', text: "They're money someone spent. Deleting a report shouldn't quietly take them with it." },
        // Checked: after moving its expense (update the expense), or deleting it, the report deleted.
        { id: 'dd-5', gap: 0.4, text: 'So you decide: move them to another report, or delete them. Then the report deletes.', sources: [MUT] },
        // Checked: a tag on an expense, and a tagged expense, failed to delete until their
        // ExpenseTag link was deleted first.
        { id: 'dd-6', text: "For tags, delete the ExpenseTag links first." },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [
        { id: 'fab-1', text: "Here's the same model in Fabricator. Blueprint's Data model view draws a line for each relationship.", sources: [BLUEPRINT] },
        // ModelView.tsx: a relation field's type is its target, with [] for @many. The shot's
        // header reads "4 entities · 3 relationships".
        { id: 'fab-2', text: "Report's expenses show Expense with brackets: many. And ExpenseTag sits in the middle, linked to both.", sources: [BLUEPRINT] },
      ],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: '[excited] Pop quiz! You delete a report that still has expenses in it. What happens?' },
        { id: 'quiz-options', text: 'A, its expenses are deleted too. B, they stay, but unfiled. Or C, the delete fails until you move or delete them.' },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        // Checked on the 1.36.2 backend, with the optional link this lesson uses (see dd-2).
        { id: 'quiz-answer', text: "[cheering] It's C! Rayfin doesn't cascade, so the report stays until no expense is filed in it.", sources: [REL] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [
        { id: 'recap', text: "Let's recap. What people create and share gets its own entity, linked with the one and many decorators.", sources: [REL] },
        { id: 'recap-2', text: "Deletes don't cascade, so move or delete what's linked first. And many-to-many takes a join entity.", sources: [REL] },
      ],
    },
    {
      id: 'challenge',
      beats: [
        { id: 'challenge', text: "Your challenge: send this prompt in Fabricator, then follow the lines in Blueprint's Data model.", sources: [BLUEPRINT] },
        { id: 'challenge-2', text: "Then tell me in the comments: what's the entity in the middle called?" },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: "Next time: permissions and row-level security, and how to keep each person's rows their own. [excited] See you in the water!" }],
    },
    {
      id: 'stinger',
      // From RAY_FACTS (src/renderer/src/components/mascot/lines.ts). The intro used the fever,
      // lesson 1 the cartilage, lesson 2 the eyes on top, lesson 3 the electric fields, and
      // lesson 4 the ray-finned fish.
      beats: [{ id: 'fact', text: '[whispers] Psst… manta rays have the biggest brains of any fish. [giggles] Plenty of room for relationships!' }],
    },
  ],
} satisfies LessonScript;
