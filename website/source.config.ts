import { defineConfig, defineDocs, frontmatterSchema } from 'fumadocs-mdx/config';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { rehypeGithubAlerts } from './lib/rehype-github-alerts';
import type { LanguageRegistration } from 'shiki';
import { z } from 'zod';

const promptLanguage: LanguageRegistration = {
  name: 'prompt',
  scopeName: 'source.prompt',
  patterns: [],
  repository: {},
};


type MdastLike = { value?: unknown; alt?: unknown; children?: MdastLike[] };

function plainText(node: MdastLike): string {
  const own = typeof node.value === 'string' ? node.value : typeof node.alt === 'string' ? node.alt : '';
  const children = Array.isArray(node.children) ? node.children.map(plainText).join(' ') : '';
  return `${own} ${children}`.replace(/\s+/g, ' ').trim();
}

const docsFrontmatter = frontmatterSchema.extend({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: docsFrontmatter,
  },
});

export default defineConfig({
  mdxOptions: {
    remarkNpmOptions: { persist: { id: 'package-manager' } },
    // Keep images at their /public paths so components/mdx.tsx can find each screenshot's
    // light twin (`<id>.light.webp`) next to it.
    remarkImageOptions: { useImport: false },
    remarkStructureOptions: { stringify: (node) => plainText(node as MdastLike) },
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      themes: { light: 'github-light', dark: 'github-dark' },
      langs: [promptLanguage],
      addLanguageClass: true,
    },
    rehypePlugins: (plugins) => [...plugins, rehypeGithubAlerts],
  },
});
