/**
 * Lesson 2: Your first Rayfin app. What Ray says, beat by beat. The single source of truth for the
 * lesson's voice, its captions and chapters, and its scenes (scenes.tsx), which find beats
 * and words here by id.
 *
 * Every claim is checked against Rayfin 1.36.2: rayfin.ai, and the installed CLI and guide in
 * the scratch app (.cache/rayfin-check/1.36.2/app) for Rayfin; the Fabricator docs and source
 * for Fabricator. Each line lists the pages it rests on. Where the installed packages say more
 * than the pages, the note beside the line names the file.
 */
import type { LessonScript } from '../../src/show/plan.ts';

const R = 'https://rayfin.ai/docs';
const F = 'https://spatney.github.io/rayfin-fabricator/docs';

export const SCRIPT = {
  number: 2,
  slug: '02-your-first-app',
  title: 'Your first Rayfin app',
  rayfinVersion: '1.36.2',
  endHold: 3,
  scenes: [
    {
      id: 'cold-open',
      chapter: 'From an empty folder to a live app',
      lead: 0.3,
      beats: [
        { id: 'hook', text: "[curious] What does it take to turn an empty folder… into an app that's live in Microsoft Fabric?", sources: [`${R}/start/quickstart`] },
        { id: 'hook-2', text: '[excited] One command creates it, one runs it while you build, and one ships it. Watch!', sources: [`${R}/start/quickstart`] },
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
        { id: 'today', text: "[excited] Today: how to create a Rayfin app, how to run it while you build, and how to ship it to Fabric. Let's dive in!" },
      ],
    },
    {
      id: 'prereqs',
      chapter: 'Before you start',
      beats: [
        { id: 'gear', text: 'First, what you need: Node.js 20 or later and a Microsoft Fabric account.', say: { 'Node.js': 'NodeJS' }, sources: [`${R}/start/installation`] },
        { id: 'tenant', text: "Fabric apps also have to be turned on in your tenant. A Fabric tenant admin flips that switch, so ask yours if it's off.", sources: [`${R}/start/deploy-to-fabric`] },
      ],
    },
    {
      id: 'create',
      chapter: 'Create your app',
      beats: [
        { id: 'create-1', text: "One command creates your app: npm create, with Rayfin's package and your app's name.", sources: [`${R}/start/quickstart`] },
        // The installed CLI installs the packages itself, then prints "Next steps: cd my-app, npx
        // rayfin dev" (@microsoft/rayfin-cli dist/utils/scaffold-pipeline.js), so there's no
        // npm install to show.
        { id: 'create-2', text: 'Keep the default template, the Universal App, and it installs your packages too.', sources: [`${R}/start/quickstart`, `${R}/reference/cli/templates`] },
        { id: 'create-3', text: 'Your app starts small: a website and sign-in. Its database stays off until your app needs one.', sources: [`${R}/start/project-structure`] },
        { id: 'create-4', text: 'As it grows, add what it needs: your own data, connectors to data already in Fabric, functions, and file storage.', sources: [R, `${R}/connectors`, `${R}/functions`, `${R}/storage`] },
      ],
    },
    {
      id: 'run',
      chapter: 'Sign in and run it',
      beats: [
        { id: 'login', text: 'Next, sign in. rayfin login opens your browser, and you sign in with Microsoft Entra ID.', sources: [`${R}/start/quickstart`] },
        { id: 'dev-1', text: 'Then run npm run dev. In a Rayfin app, that runs rayfin dev.', sources: [`${R}/start/develop-locally`] },
        // "When the frontend starts, it will output the page to visit" (@microsoft/rayfin-guide
        // getting-started/create-app-with-cli.md); Vite prints its Local address.
        { id: 'dev-2', text: "When your frontend starts, it prints a local address. Open it, and there's your app.", sources: [`${R}/start/develop-locally`] },
      ],
    },
    {
      id: 'deep-dive',
      chapter: 'Deep Dive: where is the backend?',
      beats: [
        { id: 'dive', text: "[excited] Time for a deep dive! [curious] Your app is running… but where's its backend?" },
        { id: 'dive-1', text: 'When rayfin dev starts, it finds your app’s backend in Fabric, or creates one the first time.', sources: [`${R}/start/develop-locally`] },
        { id: 'dive-2', gap: 0.6, seed: 101, text: "It applies your app's settings and data schema there, so the backend matches your code.", sources: [`${R}/start/develop-locally`] },
        { id: 'dive-3', gap: 0.6, seed: 101, text: "It writes the backend's address into your environment files, so the frontend knows where to call.", sources: [`${R}/start/develop-locally`] },
        { id: 'dive-4', gap: 0.6, seed: 101, text: 'Then it starts your frontend, and any functions, right here on your machine.', sources: [`${R}/start/develop-locally`] },
        { id: 'dive-5', gap: 0.6, text: "[proudly] So your backend lives in Fabric the whole time. There's no backend to run yourself.", sources: [R] },
        { id: 'dive-6', gap: 0.6, text: 'And one thing rayfin dev never does is publish your frontend. That’s a job for rayfin up.', sources: [`${R}/start/develop-locally`] },
      ],
    },
    {
      id: 'ship',
      chapter: 'Ship it with rayfin up',
      beats: [
        { id: 'up-1', text: "When you're ready to share, run rayfin up.", sources: [`${R}/start/quickstart`] },
        { id: 'up-2', gap: 0.5, seed: 101, text: 'It builds your frontend for production, applies your settings and schema, deploys any functions, and publishes it all to Fabric.', sources: [`${R}/start/quickstart`] },
        { id: 'up-3', text: 'The first time, it picks a workspace, checks its capacity, and creates your Fabric app there.', sources: [`${R}/start/deploy-to-fabric`] },
        // The success message ends "Your app is live at: <hosting URL>" (@microsoft/rayfin-cli
        // dist/commands/up/render.js).
        { id: 'up-4', text: 'At the end, it tells you where your app is live. rayfin up status shows that address again, any time.', sources: [`${R}/start/quickstart`, `${R}/start/deploy-to-fabric`] },
      ],
    },
    {
      id: 'fabricator',
      chapter: 'See it in Fabricator',
      beats: [
        // Fabricator runs `npm create @microsoft/rayfin@latest -- <folder> -t universal-app`
        // (src-tauri/src/commands/projects_impl.rs).
        { id: 'fab-1', text: "Here's the same journey in Fabricator. Choose New project, give it a name, and Fabricator runs npm create for you.", sources: [`${F}/start/first-app`] },
        { id: 'fab-2', text: 'Next, deploy your app: sign in to Fabric, pick a workspace, and choose Deploy app.', sources: [`${F}/start/first-app`] },
        // Sign in to Fabric runs `rayfin login` (src-tauri/src/commands/auth.rs).
        { id: 'fab-3', text: "Under the hood, that's rayfin login and rayfin up. [giggles] And I talk you through it while it deploys.", sources: [`${F}/ship/deploy`] },
        { id: 'fab-4', text: "When it's done, your app is live in the preview, and chat unlocks, so you can start building.", sources: [`${F}/ship/deploy`, `${F}/start/first-app`] },
      ],
    },
    {
      id: 'quiz',
      chapter: 'Pop quiz',
      beats: [
        { id: 'quiz-q', text: "[excited] Pop quiz! Which command publishes your app's frontend to Fabric?" },
        { id: 'quiz-options', text: 'A, rayfin dev. B, rayfin up. Or C, rayfin login.' },
        { id: 'quiz-pause', text: '[whispering] Pause the video, and guess…' },
        { id: 'countdown', hold: 3 },
        { id: 'quiz-answer', text: "[cheering] It's B, rayfin up! rayfin dev runs your frontend on your machine, but never publishes it.", sources: [`${R}/start/develop-locally`] },
      ],
    },
    {
      id: 'recap',
      chapter: 'Recap and your challenge',
      beats: [
        { id: 'recap', text: "Let's recap. npm create starts your app from the Universal App. npm run dev runs it, with the backend in Fabric. And rayfin up ships it.", sources: [`${R}/start/quickstart`] },
      ],
    },
    {
      id: 'challenge',
      beats: [
        { id: 'challenge', text: 'Your challenge: create a project in Fabricator, deploy it, and send this as your first prompt.', sources: [`${F}/start/first-app`] },
        { id: 'challenge-2', text: "Then tell me in the comments: what's the first app you'll build?" },
      ],
    },
    {
      id: 'next',
      chapter: 'Next up',
      beats: [{ id: 'next', text: 'Next time: a tour inside a Rayfin app, and the building blocks it can grow. [excited] See you in the water!' }],
    },
    {
      id: 'stinger',
      // From RAY_FACTS (src/renderer/src/components/mascot/lines.ts). The intro used the fever, and lesson 1 the cartilage.
      beats: [{ id: 'fact', text: '[whispers] Psst… my eyes are on top, and my mouth is underneath. [giggles] So I can watch while I eat!' }],
    },
  ],
} satisfies LessonScript;
