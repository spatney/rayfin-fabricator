/**
 * The code lesson 2 shows. It shows no TypeScript, so `npm run lesson:snippets -- 2` has nothing
 * to compile: the lesson's code is its terminals, below.
 *
 * Each terminal was checked against Rayfin 1.36.2 in the scratch app
 * (.cache/rayfin-check/1.36.2/app): every `rayfin` command against the installed CLI's `--help`,
 * and every line it prints against the CLI's own source, named beside the line. Check them
 * again when the lesson moves to another Rayfin version.
 */
import type { Snippet } from '../../src/show/snippet.ts';

export const SNIPPETS = {} satisfies Record<string, Snippet>;

/** A terminal on screen: the command typed at the prompt, then what it prints. "…" stands for lines left out. */
export interface Terminal {
  command: string;
  output: readonly string[];
}

/** The project's name in every terminal: the quickstart's own example. */
export const APP = 'my-app';

/** The sample app's address, as in Fabricator's screenshots (preview-toolbar). */
export const HOSTING_URL = 'https://rusty-cape-195ef2e475-westus.webapp.fabricapps.net';

export const TERMINALS = {
  create: {
    command: `npm create @microsoft/rayfin@latest ${APP}`,
    output: [
      // The prompt is "Select a template:" (dist/utils/template-scaffold.js); the default's display
      // name is "✨ Use default template" (/docs/reference/cli/templates).
      '? Select a template: ✨ Use default template',
      '…',
      // printNextStepsBanner (dist/utils/scaffold-pipeline.js), after it installs the packages.
      '🎉 Project created successfully!',
    ],
  },
  login: { command: 'npx rayfin login', output: [] },
  dev: {
    command: 'npm run dev',
    output: [
      // npm echoes the script it runs: the Universal App's package.json has "dev": "rayfin dev".
      `> ${APP}@0.0.0 dev`,
      '> rayfin dev',
      '…',
      // Vite 8's banner (vite/dist/node); 5173 is Rayfin's preferred frontend port (/docs/start/develop-locally).
      '  ➜  Local:   http://localhost:5173/',
    ],
  },
  up: {
    command: 'npx rayfin up',
    output: [
      '…',
      // renderSuccess (dist/commands/up/render.js), which names the project by rayfin.yml's id.
      `🎉 Project "${APP}" is now deployed to Fabric!`,
      '   • Open in Fabric portal: https://app.fabric.microsoft.com/…',
      `   • Your app is live at: ${HOSTING_URL}`,
    ],
  },
  status: { command: 'npx rayfin up status', output: [] },
} as const satisfies Record<string, Terminal>;
