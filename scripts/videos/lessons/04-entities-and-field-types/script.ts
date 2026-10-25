/**
 * Lesson 4: Entities and field types. What Ray says, beat by beat. The single source of truth for
 * the lesson's voice, its captions and chapters, and its scenes (scenes.tsx), which find beats
 * and words here by id.
 *
 * Every claim is checked against Rayfin 1.36.2: rayfin.ai, and the scratch app the lesson tools
 * scaffold with the installed CLI (.cache/rayfin-check/1.36.2/app), whose files and
 * node_modules/@microsoft/rayfin-* docs and types are version-locked. Fabricator's claims come
 * from its docs and source. Each line lists the pages it rests on; where the scratch app says
 * more than the pages, the note beside the line names the file.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

const FIELDS = `${R}/data/field-types`;
const MODELING = `${R}/data/modeling`;
const LIMITS = `${R}/reference/known-limitations`;

/** How Ray says the IDs' type, letter by letter. */
const UUID = 'U U I D';

export const SCRIPT = {
  number: 4,
  slug: '04-entities-and-field-types',
  title: 'Entities and field types',
  rayfinVersion: '1.36.2',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'What does each decorator do?',
      lead: 0.3,
      beats: [
        { id: 'hook', text: '[curious] Every field in a Rayfin entity gets a decorator. So what does each one actually do?', sources: [FIELDS] },
        // `@decimal({ min: 0 }) amount!: number;` becomes a decimal column with two places by
        // default (DECIMAL(18,2) on SQL Server, NUMERIC(18,2) on PostgreSQL), required, with a
        // check that it's at least 0: rayfin-core's dist/analysis/type-inference.js and
        // dialect-config.js. The lesson stays engine-neutral: Rayfin's data service runs on either.
        { id: 'hook-2', text: '[excited] Watch one line become a database column, and the rules your data has to follow.', sources: [FIELDS] },
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
        { id: 'today', text: "[excited] Today: how to write an entity, what each field decorator stores, and how to register it. Let's dive in!" },
      ],
    },
    {
      id: 'entity',
      chapter: 'Write an entity',
      beats: [
        // The Universal App keeps entities in packages/data/src/, one file each (the installed
        // .agents/skills/data-modeling/SKILL.md).
        { id: 'en-1', text: 'An entity is a class with the entity decorator. Your app keeps each one in its own file, in the data package.', sources: [MODELING, `${R}/start/project-structure`] },
        { id: 'en-2', text: 'Every entity has an ID: a UUID primary key named id. Leave it out, and Rayfin adds it for you.', say: { UUID }, sources: [MODELING] },
        { id: 'en-3', text: 'Every other field you want stored gets exactly one field decorator.', sources: [MODELING, FIELDS] },
      ],
    },
    {
      id: 'types',
      chapter: 'Eight field decorators',
      beats: [
        // DECIMAL(18,2) on SQL Server and NUMERIC(18,2) on PostgreSQL: two digits after the point.
        { id: 'ty-1', text: 'Text holds strings. Int holds whole numbers. Decimal holds exact numbers, like money, with two decimal places by default.', sources: [FIELDS] },
        { id: 'ty-2', text: 'Boolean is true or false, date is a date and time, and uuid holds IDs.', say: { uuid: UUID, IDs: "I D's" }, sources: [FIELDS] },
        { id: 'ty-3', text: 'Email is text that has to look like an email address. And set allows only the values you list.', sources: [FIELDS, `${R}/data/validation`] },
      ],
    },
    {
      id: 'options',
      chapter: 'Options shape each field',
      beats: [
        { id: 'op-1', text: 'Fields are required by default. To make one optional, set optional to true, and add a question mark. You need both.', sources: [FIELDS] },
        { id: 'op-2', text: 'Default fills in a value you leave out. Unique stops two records from sharing a value.', sources: [FIELDS] },
        { id: 'op-3', text: "Min and max bound a text's length, or a number's range.", sources: [FIELDS] },
        { id: 'op-4', text: "A set's values go in the decorator, and again as the property's type.", sources: [FIELDS] },
        // "The decorator determines the database column type, the GraphQL scalar, and the
        // constraints Rayfin enforces for you" (/docs/data/field-types); toStandardSchema builds
        // the validator (/docs/data/validation).
        { id: 'op-5', text: 'Rayfin enforces these for you, and can even turn them into a form validator.', sources: [FIELDS, `${R}/data/validation`] },
      ],
    },
    {
      id: 'register',
      chapter: 'Register it',
      beats: [
        // The installed .agents/skills/rayfin/SKILL.md: "An entity that is not registered does not
        // exist as far as the client is concerned."
        { id: 'rg-1', text: "Last step: register the entity. Until you do, it doesn't exist as far as your client's concerned.", sources: [MODELING] },
        // packages/data/src/index.ts: "declare each entity as a decorated class, export it from
        // this package, add it to UniversalAppSchema, and register it in schema".
        { id: 'rg-2', text: "In the data package's index file, export the class, and add it to the schema list.", sources: [MODELING, `${R}/start/project-structure`] },
        // packages/frontend/src/lib/rayfin-client.ts creates RayfinClient<UniversalAppSchema>:
        // "Typed by UniversalAppSchema, so client.data.<Entity> is checked against the entities".
        { id: 'rg-3', text: 'In the shared package, describe its record, and add it to UniversalAppSchema: the type your client is checked against.', say: { UniversalAppSchema: 'Universal App Schema' }, sources: [MODELING, `${R}/start/project-structure`] },
        { id: 'rg-4', text: "And don't name an entity after a GraphQL type, like Date or Query. The CLI rejects it. Try EventDate instead.", sources: [LIMITS] },
      ],
    },
    {
      id: 'deep-dive',
      chapter: 'Deep Dive: why every text needs a max',
      beats: [
        { id: 'dive', text: '[excited] Time for a deep dive! [curious] What happens to a text field with no max?' },
        // A max of 200 is a 200-character column (NVARCHAR(200) on SQL Server, VARCHAR(200) on
        // PostgreSQL: rayfin-core's type-inference.js), and the max is "the maximum number of
        // characters allowed" (its TextFieldOptions).
        { id: 'dd-1', text: "Each field becomes a column in your app's database. Text with a max of two hundred holds up to two hundred characters.", sources: [MODELING, FIELDS] },
        // "If undefined or -1, defaults to the database's maximum length" (TextFieldOptions.max):
        // NVARCHAR(MAX) on SQL Server, TEXT on PostgreSQL.
        { id: 'dd-2', text: "Leave max out, and the column gets the database's maximum length.", sources: [FIELDS] },
        // The pages document the failure for SQL Server's NVARCHAR(MAX), hence "some databases".
        { id: 'dd-3', gap: 0.5, text: 'On some databases, Rayfin can fail to build your GraphQL schema from a column like that.', sources: [FIELDS, LIMITS] },
        { id: 'dd-4', text: '[gasps] Worse, you find out late. rayfin up reports success, then your queries fail with an internal server error.', sources: [FIELDS, `${R}/data/migrations`] },
        { id: 'dd-5', gap: 0.5, text: '[relieved] So give every text a max that fits its data: fifty for a short name, two thousand for a description.', sources: [FIELDS] },
        { id: 'dd-6', text: 'Email, too. It takes the same options as text.', sources: [FIELDS] },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [
        { id: 'fab-1', text: "Here's the same idea in Fabricator. Blueprint's Data model view draws each entity as a card: every field, with its type.", sources: [`${F}/build/data-model`] },
        // src/renderer/src/components/ModelView.tsx: the key icon is "Primary key", and typeChip
        // labels a set field "enum".
        { id: 'fab-2', text: 'A key marks the ID, and a set shows up as enum.', sources: [`${F}/build/data-model`] },
        // ModelView.tsx: each field's mark is titled "Required" or "Optional"; an optional one is
        // drawn hollow (model-field-req--opt).
        { id: 'fab-3', text: 'A filled diamond means required. A hollow one means optional, like the note.', sources: [`${F}/build/data-model`] },
        { id: 'fab-4', text: "And Open takes you to the entity's file, in Code.", sources: [`${F}/build/data-model`] },
      ],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: "[excited] Pop quiz! What's wrong with this field?" },
        { id: 'quiz-options', text: "A, it needs a question mark. B, it has no max. Or C, text can't be required." },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        { id: 'quiz-answer', text: "[cheering] It's B! With no max, your queries can fail after a deploy that looked fine. Give every text a max.", sources: [FIELDS, LIMITS] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [
        { id: 'recap', text: "Let's recap. Each stored field gets one decorator, and its options become rules. Register every entity in the data and shared packages. And give every text a max.", sources: [FIELDS, MODELING] },
      ],
    },
    {
      id: 'challenge',
      beats: [
        { id: 'challenge', text: "Your challenge: send this prompt in Fabricator, then find your new entity in Blueprint's Data model.", sources: [`${F}/build/data-model`] },
        { id: 'challenge-2', text: 'Then tell me in the comments: which decorators did it get?' },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: 'Next time: relationships, and how Rayfin knows a customer has many orders. [excited] See you in the water!' }],
    },
    {
      id: 'stinger',
      // From RAY_FACTS (src/renderer/src/components/mascot/lines.ts). The intro used the fever,
      // lesson 1 the cartilage, lesson 2 the eyes on top, and lesson 3 the electric fields.
      beats: [{ id: 'fact', text: "[whispers] Psst… despite the name, rays aren't ray-finned fish. [giggles] Talk about the wrong type!" }],
    },
  ],
} satisfies LessonScript;
