/**
 * Lesson 6: Permissions and row-level security. What Ray says, beat by beat. The single source of
 * truth for the lesson's voice, its captions and chapters, and its scenes (scenes.tsx), which find
 * beats and words here by id.
 *
 * Every claim is checked against Rayfin 1.36.2: rayfin.ai, and the scratch app the lesson tools
 * scaffold with the installed CLI (.cache/rayfin-check/1.36.2/app), whose files and
 * node_modules/@microsoft/rayfin-* docs and types are version-locked. Fabricator's claims come
 * from its docs and source. Each line lists the pages it rests on; where the scratch app says
 * more than the pages, the note beside the line names the file.
 *
 * What the backend does with a policy, and without one, was also checked on Rayfin 1.36.2's own
 * backend (`rayfin dev --provider docker`, the webservice:cli-1.36.2 image), on SQL Server and
 * PostgreSQL alike, with two signed-in people (Avery and Blake) and a client that never signed in.
 * With no permission decorator, Blake's unfiltered query returned Avery's rows too, and he could
 * edit and delete them. With `@authenticated('*', { policy: claims.sub.eq(item.owner_id) })`, his
 * queries (unfiltered, by her owner_id, by her row's id) returned none of hers, editing or deleting
 * her row failed, and creating a row with her owner_id was refused ("Could not insert row with
 * given values."). Without a sign-in, both entities refused to answer. The notes beside those lines
 * say which check backs them.
 *
 * Left out on purpose: field visibility (`include` and `exclude`). rayfin.ai says a field excluded
 * from reads stays writable on create and update, but on the 1.36.2 backend it was gone from
 * creates too ("The specified input object field `secret` does not exist."). And the docs' public
 * read with an owner-scoped write: there, signed-in people saw only their own rows, not "every"
 * row as the page says.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

const PERM = `${R}/data/permissions`;
const MUT = `${R}/data/mutations`;
const BLUEPRINT = `${F}/build/data-model`;

/** How Ray says the owner column, as separate words (joined with hyphens, the voice reads "dash"). */
const OWNER = { owner_id: 'owner underscore I D' } as const;
/** ro-3's claim and column. */
const CLAIM_AND_OWNER = { 'claims.sub': 'claims dot sub', ...OWNER } as const;
/** recap-2's claim. */
const CLAIM = { 'claims.sub': 'claims dot sub' } as const;

export const SCRIPT = {
  number: 6,
  slug: '06-permissions',
  title: 'Permissions and row-level security',
  rayfinVersion: '1.36.2',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'Whose expenses are these?',
      lead: 0.3,
      beats: [
        { id: 'hook', text: '[curious] Avery and Blake both use your expense app. How does Rayfin make sure each of them only sees their own expenses?', sources: [PERM] },
        // "Pass a policy callback ... to restrict which rows a role can act on"; checked on the
        // backend for reads, edits, deletes and creates.
        { id: 'hook-2', text: '[excited] One rule on the entity, and the server checks it on every request, row by row.', sources: [PERM] },
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
        { id: 'today', text: "[excited] Today: who can do what, the policy that keeps each person's rows their own, and why a filter in your app isn't security. Let's dive in!" },
      ],
    },
    {
      id: 'who',
      chapter: 'Who can do what',
      beats: [
        // "Rayfin recognizes two built-in roles: anonymous ... authenticated". rayfin-core's
        // assets/docs/permissions.md: "Only the two built-in roles are supported".
        { id: 'wd-1', text: 'A permission decorator on an entity says who can use it. Rayfin has two built-in roles: authenticated and anonymous.', sources: [PERM] },
        { id: 'wd-2', text: 'The authenticated decorator is for people who are signed in. It takes the actions they get: create, read, update or delete.', sources: [PERM] },
        // "'*' means all four"; the shorthands are for @role('authenticated', ...), which lessons 4
        // and 5 wrote. "Prefer the shorthands — they read better".
        { id: 'wd-3', text: "A star means all four. The authenticated decorator is shorthand for the role decorator from lessons four and five: same rule, easier to read.", sources: [PERM] },
        // "Anonymous access requires a tenant admin to enable the 'Enable anonymous data access for
        // Fabric Apps' switch for your tenant." Checked: without a sign-in, entities with no
        // anonymous grant answered "The current user is not authorized to access this resource."
        { id: 'wd-4', text: "The anonymous decorator is for people who aren't signed in. On Fabric, a tenant admin has to allow anonymous data access first.", sources: [PERM] },
      ],
    },
    {
      id: 'rows',
      chapter: "Your rows, nobody else's",
      beats: [
        // `@authenticated('*')` alone: "full access to authenticated users", every row.
        { id: 'ro-1', text: "But a star alone lets every signed-in person reach every row. Expenses are money people spent: Blake shouldn't see Avery's taxi rides.", sources: [PERM] },
        // "The callback receives a typed claims object and a proxy for the entity's own fields (item)".
        { id: 'ro-2', text: 'So the decorator gets a policy: a function that compares the person asking with each row.', sources: [PERM] },
        // `claims.sub`: "Subject identifier — the signed-in user's ID."
        { id: 'ro-3', text: "claims.sub is the signed-in person's ID. It has to equal the row's owner_id, or the row is out of reach.", say: CLAIM_AND_OWNER, sources: [PERM] },
        // Supported claims: sub, email and role. "renaming a field is a compile-time error
        // everywhere it's referenced"; snippets.ts's claims check proves both kinds of typo fail.
        { id: 'ro-4', text: "Both sides are typed. Claims has sub, email and role, and item has your entity's fields, so a typo won't compile.", sources: [PERM] },
        // rayfin-core's assets/docs/permissions.md: "Policies validate access but do not populate
        // owner fields. Set the owner field from the authenticated session when creating a row".
        // The mutations page creates with `user_id: session.user.id`.
        { id: 'ro-5', text: "The policy checks owner_id, but doesn't fill it in. When your app creates an expense, it sets owner_id from the session.", say: OWNER, sources: [MUT] },
      ],
    },
    {
      id: 'deep-dive',
      chapter: "Deep Dive: what a filter can't protect",
      beats: [
        { id: 'dive', text: '[excited] Time for a deep dive! [curious] What if an entity has no permission decorator at all?' },
        // "it silently receives authenticated: *, meaning full create/read/update/delete access for
        // any signed-in user, with no row-level restriction."
        { id: 'dd-1', text: "It isn't locked. Rayfin gives it a default: anyone signed in can create, read, update and delete every row.", sources: [PERM] },
        // Checked: Avery's query filtered by her owner_id returned only her note.
        { id: 'dd-2', gap: 0.4, text: "Say your app only asks for the signed-in person's expenses. Avery sees just hers. It looks private." },
        // Checked: Blake's unfiltered query returned Avery's row as well as his. The Universal App's
        // data-modeling skill: "A client-side filter still leaves the rows fetchable."
        { id: 'dd-3', text: "But that filter lives in your app. Blake can ask the same question without it, and get everyone's rows.", sources: [PERM] },
        // Checked: Blake's update and delete of Avery's row both succeeded.
        { id: 'dd-4', text: "He can edit Avery's taxi ride, or delete it, and the server says yes.", sources: [PERM] },
        // Checked: with the owner policy, Blake's queries returned only his rows; editing or deleting
        // Avery's failed, and creating one with her owner_id was refused.
        { id: 'dd-5', gap: 0.4, text: "[relieved] Now add the policy. Blake gets only his own rows. Editing or deleting Avery's fails, and so does creating one in her name." },
        { id: 'dd-6', text: 'A filter in your app picks which rows to show. A policy on the server decides which rows anyone can reach.', sources: [PERM] },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [
        // The legend: "Row-scoped", "Any signed-in", "Public".
        { id: 'fab-1', text: "In Fabricator, Blueprint's Data model view gives every entity an access dot: row-scoped, any signed-in, or public.", sources: [BLUEPRINT] },
        // The model-access screenshot: lesson 5's model with Report's decorator left out. ModelView.tsx
        // shows Harden on every level but row-scoped.
        { id: 'fab-2', text: 'Here, Report has no permission decorator. Its card says no explicit roles, its dot is any signed-in, and it offers Harden.', sources: [BLUEPRINT] },
        // "Select Harden to send a ready prompt to Copilot asking it to tighten the entity's access
        // control with Rayfin decorators and row-level policy ... the normal chat turn and redeploy
        // flow applies."
        { id: 'fab-3', text: 'Harden asks Copilot to add a row-level policy. After the chat turn, Fabricator redeploys, as always.', sources: [BLUEPRINT] },
      ],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: "[excited] Pop quiz! Your app filters out other people's expenses, so nobody sees them. Are they private?" },
        { id: 'quiz-options', text: 'A, yes: the app never shows them. B, yes, as long as everyone has to sign in. Or C, no: only a policy on the server keeps them private.' },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        { id: 'quiz-answer', text: "[cheering] It's C! Anyone signed in can ask without your filter. The policy is what the server checks.", sources: [PERM] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [
        { id: 'recap', text: "Let's recap. Give every entity a permission decorator: who, and which actions.", sources: [PERM] },
        { id: 'recap-2', text: 'Keep personal rows private with a policy on claims.sub. And filter in your app to show rows, never to protect them.', say: CLAIM, sources: [PERM] },
      ],
    },
    {
      id: 'challenge',
      beats: [
        { id: 'challenge', text: "Your challenge: send this prompt in Fabricator, then find the new entity's access dot in Blueprint's Data model.", sources: [BLUEPRINT] },
        { id: 'challenge-2', text: 'Then tell me in the comments: which access does its dot show?' },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: 'Next time: reading and writing your data, from the query chain to create, update and delete. [excited] See you in the water!' }],
    },
    {
      id: 'stinger',
      // Not in RAY_FACTS: the Florida Museum's skate and ray biology page says rays' "eyes and
      // spiracles are positioned on the top of the head which allows them to take in water for gill
      // ventilation (respiration) while partially buried in the sand." Earlier lessons used the
      // fever, the cartilage, the eyes on top, the electric fields, the ray-finned fish and the
      // manta's brain.
      beats: [{ id: 'fact', text: "[whispers] Psst… a ray can lie half-buried in the sand and keep breathing, through openings on top of its head. [giggles] Out of sight, like other people's rows!" }],
    },
  ],
} satisfies LessonScript;
