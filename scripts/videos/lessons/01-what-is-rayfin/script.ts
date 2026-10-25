/**
 * Lesson 1: What is Rayfin? What Ray says, beat by beat. The single source of truth for the
 * lesson's voice (tools/lesson-voice.mjs), its captions and chapters, and its scenes
 * (scenes.tsx), which find beats and words here by id.
 *
 * Every claim is checked against Rayfin 1.36.2: rayfin.ai and the installed packages' own
 * docs for Rayfin, the Fabricator docs for Fabricator. Each line lists the pages it rests on.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

export const SCRIPT = {
  number: 1,
  slug: '01-what-is-rayfin',
  title: 'What is Rayfin?',
  rayfinVersion: '1.36.2',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'What if your backend was one class?',
      lead: 0.3,
      beats: [
        { id: 'hook', text: '[curious] What if your whole backend… was one TypeScript class?', sources: [R] },
        { id: 'hook-2', text: '[excited] No tricks. Watch it turn into a database, an API, a typed client and security rules.', sources: [R] },
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
        { id: 'welcome', text: "[delighted] Hi, I'm Ray! Welcome to Learn Rayfin with Ray." },
        { id: 'today', text: '[excited] Today: what Rayfin is, how one class becomes a whole backend, and how it ships to Microsoft Fabric. Let’s dive in!' },
      ],
    },
    {
      id: 'problem',
      chapter: 'What is Rayfin?',
      beats: [
        { id: 'problem', text: 'A backend usually means a database, migrations, APIs, sign-in, hosting and security rules… [dizzy] all kept in sync by hand.', sources: [`${R}/data`] },
        { id: 'rayfin-is', text: '[relieved] Rayfin is a backend platform for TypeScript developers. You describe your data once, in TypeScript, and Rayfin generates the backend and runs it on Microsoft Fabric.', sources: [R] },
      ],
    },
    {
      id: 'entity',
      chapter: 'Meet the entity',
      beats: [
        { id: 'entity-1', text: "Rayfin's data starts with an entity: a TypeScript class with decorators.", sources: [`${R}/data/modeling`] },
        { id: 'entity-2', text: 'The entity decorator marks the class as data that Rayfin stores and serves.', sources: [`${R}/data/modeling`] },
        { id: 'entity-3', text: 'Each field gets a decorator too: text with a maximum length, a decimal for the amount, and a date for when you spent it.', sources: [`${R}/data/field-types`] },
        { id: 'entity-4', text: 'And the role decorator decides who can touch it. Its policy says: signed-in people only see their own expenses.', sources: [`${R}/data/permissions`] },
      ],
    },
    {
      id: 'deep-dive',
      chapter: 'Deep Dive: one class, a whole backend',
      beats: [
        { id: 'dive', text: "[excited] Time for a deep dive! Let's see what Rayfin makes from that one class." },
        { id: 'gifts-1', text: 'A database table to store your expenses, and REST and GraphQL APIs to read and write them.', sources: [`${R}/data/modeling`] },
        { id: 'gifts-2', text: 'A type-safe client, so your editor knows every field. Row-level security, so people only see their own rows. [impressed] Even form validation!', sources: [`${R}/data`, `${R}/data/permissions`, `${R}/data/validation`] },
        { id: 'no-sql', text: 'No SQL to write, no schema file, and no API contract to keep in sync by hand. [proudly] Just one class.', sources: [`${R}/data`] },
      ],
    },
    {
      id: 'ship',
      chapter: 'Ship it to Microsoft Fabric',
      beats: [
        { id: 'ship-1', text: 'Then one command, rayfin up, deploys it all to Microsoft Fabric, as a Fabric app.', sources: [R, `${R}/start/deploy-to-fabric`] },
        { id: 'ship-2', text: "Fabric hosts the database, the APIs, sign-in with Microsoft Entra ID, and your app's frontend, inside your organization's tenant. [proudly] You didn't lift a fin.", sources: [R] },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [
        { id: 'fab-1', text: "Here's the same idea in Fabricator. Describe your app in plain English…", sources: [`${F}/build/chat`] },
        { id: 'fab-2', text: "…and Fabricator's agent writes the entity for you. See? The entity decorator, and a role with its policy.", sources: [`${F}/build/chat`] },
        { id: 'fab-3', text: 'Blueprint draws it as a diagram: every field, its type, and who can see it.', sources: [`${F}/build/data-model`] },
        { id: 'fab-4', text: 'And Fabricator runs rayfin up for you, then redeploys after every successful chat turn.', sources: [`${F}/ship/deploy`] },
      ],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: '[excited] Pop quiz! Which part of an entity decides who can see each row?' },
        { id: 'quiz-options', text: 'A, the entity decorator. B, the text decorator. Or C, the role decorator, with its policy.' },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        { id: 'quiz-answer', text: "[cheering] It's C! The role decorator's policy keeps each person's rows their own.", sources: [`${R}/data/permissions`] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [
        { id: 'recap', text: "Let's recap. An entity is a TypeScript class with decorators. From it, Rayfin makes your table, APIs, typed client and security. And rayfin up ships it all to Microsoft Fabric.", say: { APIs: "API's" }, sources: [`${R}/data`, R] },
      ],
    },
    {
      id: 'challenge',
      beats: [
        { id: 'challenge', text: 'Your challenge: open Fabricator, describe a tiny app, and find its entity in Blueprint.', sources: [`${F}/build/data-model`] },
        { id: 'challenge-2', text: 'Then tell me in the comments: what did you build?' },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: 'Next time: your first Rayfin app, from an empty folder to live in Fabric. [excited] See you in the water!' }],
    },
    {
      id: 'stinger',
      beats: [{ id: 'fact', text: '[whispers] Psst… rays are cousins of sharks. Our skeletons are cartilage, not bone. [giggles] Bendy!' }],
    },
  ],
} satisfies LessonScript;
