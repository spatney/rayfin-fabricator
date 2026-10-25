import path from 'node:path';

/**
 * Ray is imported from the app (../../src/renderer). Resolve React for his files from this
 * project too, so the bundle holds exactly one React. Shared by remotion.config.ts (the CLI)
 * and tools/contact-sheet.mjs (the Node API), which takes no config file.
 */
export function webpackOverride(root) {
  return (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...(config.resolve?.alias ?? {}),
        react: path.join(root, 'node_modules', 'react'),
        'react-dom': path.join(root, 'node_modules', 'react-dom'),
      },
    },
  });
}
