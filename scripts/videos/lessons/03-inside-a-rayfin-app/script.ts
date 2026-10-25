/**
 * Lesson 3: Inside a Rayfin app. What Ray says, beat by beat. The single source of truth for the
 * lesson's voice, its captions and chapters, and its scenes (scenes.tsx), which find beats
 * and words here by id.
 *
 * Every claim is checked against Rayfin 1.36.2: rayfin.ai, and the scratch app the lesson tools
 * scaffold with the installed CLI (.cache/rayfin-check/1.36.2/app), whose files and
 * node_modules/@microsoft/rayfin-guide docs are version-locked. Fabricator's claims come from
 * its docs and source. Each line lists the pages it rests on; where the scratch app says more
 * than the pages, the note beside the line names the file.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

/**
 * How Ray says the file names, as separate words: joined with hyphens, the voice read them as
 * "dash". The captions keep the names as written.
 */
const YML = { 'rayfin.yml': 'rayfin dot yaml' } as const;
const DEPLOYMENTS = { '.deployments.json': 'dot deployments dot JSON' } as const;

export const SCRIPT = {
  number: 3,
  slug: '03-inside-a-rayfin-app',
  title: 'Inside a Rayfin app',
  rayfinVersion: '1.36.2',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'What’s inside a Rayfin app?',
      lead: 0.3,
      beats: [
        // The scratch app has 142 files outside node_modules, 66 of them skills in .agents.
        { id: 'hook', text: '[curious] A new Rayfin app comes with more than a hundred files. What are they all for?', sources: [`${R}/start/project-structure`] },
        { id: 'hook-2', text: '[excited] Your code lives in three packages… and one small file tells Fabric what to run.', sources: [`${R}/start/project-structure`] },
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
        { id: 'today', text: "[excited] Today: what each package does, what rayfin.yml turns on, and the building blocks your app can grow. Let's dive in!", say: YML },
      ],
    },
    {
      id: 'packages',
      chapter: 'Three packages, one app',
      beats: [
        { id: 'pk-1', text: 'Your new app is an npm workspace: one project that holds a few packages, each with its own job.', sources: [`${R}/start/project-structure`] },
        { id: 'pk-2', text: 'The frontend package is your website: React and Vite, sign-in, and the pages people see.', sources: [`${R}/start/project-structure`] },
        // packages/data/src/index.ts exports `schema`, the list each entity is registered in.
        { id: 'pk-3', text: 'The data package holds your entities, the classes from lesson one, and registers each one in its schema.', sources: [`${R}/start/project-structure`, `${R}/data/modeling`] },
        { id: 'pk-4', text: 'The shared package holds the types that your frontend, your data and your functions all agree on.', sources: [`${R}/start/project-structure`] },
        { id: 'pk-5', text: 'And when your app needs functions, a functions package joins them.', sources: [`${R}/start/project-structure`] },
      ],
    },
    {
      id: 'config',
      chapter: 'rayfin.yml: your app’s services',
      beats: [
        // "rayfin/rayfin.yml is the entrypoint for the Rayfin backend configuration"
        // (@microsoft/rayfin-guide getting-started/project-structure.md).
        { id: 'yml-1', text: "Beside the packages sits the rayfin folder, and in it, rayfin.yml: your backend's configuration.", say: YML, sources: [`${R}/start/project-structure`, `${R}/reference/config/rayfin-yml`] },
        { id: 'yml-2', text: "It lists your app's services, and rayfin dev and rayfin up sync it to Fabric.", sources: [`${R}/start/project-structure`] },
        { id: 'yml-3', text: 'Auth turns on sign-in with Microsoft Entra ID, through Fabric.', sources: [`${R}/reference/config/rayfin-yml`] },
        { id: 'yml-4', text: 'Static hosting serves your frontend. Its asset access starts protected, so pages load only after sign-in.', sources: [`${R}/reference/config/rayfin-yml`, `${R}/hosting`] },
        // packages/data/src/index.ts: "the data service ships disabled … When the app needs to own
        // records … set services.data.enabled: true".
        { id: 'yml-5', text: 'Data is your database. It starts off, and turns on when your app needs records of its own.', sources: [`${R}/start/project-structure`, `${R}/reference/config/rayfin-yml`] },
        { id: 'yml-6', text: 'Functions and storage are services too. Connectors and secrets each get a list of their own.', sources: [`${R}/reference/config/rayfin-yml`] },
      ],
    },
    {
      id: 'files',
      chapter: 'What to commit, and what not',
      beats: [
        // "After running npx rayfin dev or npx rayfin up, the CLI records deployment metadata in
        // rayfin/.deployments.json and merges the corresponding RAYFIN_PUBLIC_* variables into
        // rayfin/.env" (@microsoft/rayfin-guide auth/fabric.md).
        { id: 'git-1', text: 'rayfin dev and rayfin up also write two files of their own into the rayfin folder.', sources: [`${R}/start/develop-locally`, `${R}/deploy/environments`] },
        { id: 'git-2', text: ".env holds values your frontend needs, like your backend's address.", say: { '.env': 'dot env' }, sources: [`${R}/start/project-structure`, `${R}/deploy/environments`] },
        { id: 'git-3', text: 'And .deployments.json records each place you deployed: its workspace, its Fabric app and its address.', say: DEPLOYMENTS, sources: [`${R}/start/project-structure`] },
        // The Universal App's .gitignore lists rayfin/.env and rayfin/.deployments.json.
        { id: 'git-4', text: 'Both are about where you deployed, not what you built, so git leaves them out. rayfin.yml is the one you commit.', say: YML, sources: [`${R}/deploy/environments`] },
      ],
    },
    {
      id: 'deep-dive',
      chapter: 'Deep Dive: how a Fabric app runs',
      beats: [
        { id: 'dive', text: '[excited] Time for a deep dive! [curious] What does your app become, inside Fabric?' },
        { id: 'dive-1', text: "rayfin up packages your project and sets it up as a Fabric app, inside your organization's tenant.", sources: [R, `${R}/deploy/fabric-apps`] },
        { id: 'dive-2', gap: 0.5, text: 'Your frontend is served as static content. Behind it, a web service and Data API Builder sit in front of a SQL database.', sources: [R, `${R}/deploy/fabric-apps`] },
        { id: 'dive-3', gap: 0.5, text: "Functions run beside them, on the server, and blob storage holds your app's files.", sources: [R, `${R}/functions`, `${R}/storage`] },
        // Sign-in is the Fabric app's own Auth service (/docs/deploy/fabric-apps), so it's drawn
        // inside the app. The series calls it Fabric brokered auth (rayfin.yml's `fabric.enabled`
        // "Enables Fabric brokered auth"); /docs/auth/fabric-sso calls it Fabric SSO.
        { id: 'dive-4', gap: 0.5, text: 'Sign-in is built in, too. Fabric brokers it, so people sign in with the Microsoft Entra account they already use for Fabric.', sources: [`${R}/auth`, `${R}/auth/fabric-sso`, `${R}/deploy/fabric-apps`] },
        // /docs/auth: "No separate identity provider to run". That the app needs no Entra app
        // registration of its own, so no tenant admin has to approve one, is from the series'
        // author (October 2026); Fabricator's Blueprint docs say it too.
        { id: 'dive-4b', text: "[relieved] There's no identity provider to run, and no Entra app of your own for a tenant admin to approve.", sources: [`${R}/auth`, `${F}/build/data-model`] },
        { id: 'dive-5', gap: 0.5, text: 'Connectors reach outside the app, to data already in Fabric: a warehouse, a SQL database, a Lakehouse SQL endpoint, or a semantic model.', sources: [R, `${R}/connectors`] },
        { id: 'dive-6', gap: 0.5, text: "And functions reach the rest: Microsoft resources, with the app's own identity, and any web API, with a secret.", sources: [R, `${R}/functions/connections`, `${R}/functions/secrets`] },
        { id: 'dive-7', gap: 0.6, text: '[proudly] And rayfin.yml decides which of these pieces your app gets.', say: YML, sources: [`${R}/deploy/fabric-apps`] },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [
        { id: 'fab-1', text: "Here's the same tour in Fabricator. The Code view shows your project's files, packages and all.", sources: [`${F}/build/code-and-history`] },
        { id: 'fab-2', text: "Its Skills tab shows the skills in .agents. Rayfin's own are always on, and teach Copilot to build with Rayfin.", say: { '.agents': 'dot agents' }, sources: [`${F}/build/skills`, `${R}/reference/cli/ai-files`] },
        { id: 'fab-3', text: 'And Blueprint draws your app from rayfin.yml and your code: Website, Sign-in, Database, File storage, Connectors, Functions and Secrets.', say: YML, sources: [`${F}/build/data-model`] },
        { id: 'fab-4', text: 'Lines show what each piece connects to, and which identity it uses.', sources: [`${F}/build/data-model`] },
      ],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: '[excited] Pop quiz! Which file records where you deployed, and stays out of git?' },
        { id: 'quiz-options', text: 'A, .deployments.json. B, rayfin.yml. Or C, package.json.', say: { ...DEPLOYMENTS, ...YML, 'package.json': 'package dot JSON' } },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        { id: 'quiz-answer', text: "[cheering] It's A, .deployments.json! It's about where you deployed, so git leaves it out. You commit rayfin.yml.", say: { ...DEPLOYMENTS, ...YML }, sources: [`${R}/start/project-structure`, `${R}/deploy/environments`] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [
        { id: 'recap', text: "Let's recap. Your code lives in packages: frontend, data and shared. rayfin.yml lists your services. And Fabric runs them all as one Fabric app.", say: YML, sources: [`${R}/start/project-structure`, R] },
      ],
    },
    {
      id: 'challenge',
      beats: [
        // Blueprint draws Database once the data service is on or an entity exists
        // (src/renderer/src/model/architecture.ts), so the prompt below makes it appear.
        { id: 'challenge', text: 'Your challenge: open Blueprint in Fabricator, send this prompt, and then look again.', sources: [`${F}/build/data-model`] },
        { id: 'challenge-2', text: 'Then tell me in the comments: which new piece showed up?' },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: 'Next time: entities and field types, and what every decorator means. [excited] See you in the water!' }],
    },
    {
      id: 'stinger',
      // From RAY_FACTS (src/renderer/src/components/mascot/lines.ts). The intro used the fever,
      // lesson 1 the cartilage, and lesson 2 the eyes on top.
      beats: [{ id: 'fact', text: "[whispers] Psst… rays can sense the faint electric fields of prey hiding in the sand. [giggles] So hidden files can't hide from me!" }],
    },
  ],
} satisfies LessonScript;
