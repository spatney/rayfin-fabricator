import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import { PromptCard } from '@/components/prompt-card';
import { Mermaid } from '@/components/mermaid';
import { withBasePath } from '@/lib/site.config';

const DefaultPre = defaultMdxComponents.pre;

function Pre(props: ComponentProps<'pre'> & { title?: string }) {
  const lang = fenceLanguage(props.children);
  if (lang === 'prompt') return <PromptCard title={props.title}>{props.children}</PromptCard>;
  if (lang === 'mermaid') return <Mermaid chart={extractCode(props.children)} />;
  return DefaultPre ? <DefaultPre {...props} /> : <pre {...props} />;
}

/** A screenshot page authors link to: the dark capture. Its light twin is `<id>.light.webp`. */
const SCREENSHOT = /^\/screenshots\/([\w-]+)\.webp$/;

function Img(props: ComponentProps<'img'>) {
  const imported = props.src && typeof props.src === 'object' && 'src' in props.src ? (props.src as { src: string; width?: number; height?: number }) : undefined;
  const path = imported?.src ?? (typeof props.src === 'string' ? props.src : '');
  const width = props.width ?? imported?.width;
  const height = props.height ?? imported?.height;
  const shot = SCREENSHOT.exec(path);
  if (!shot) return <img {...props} src={withBasePath(path)} width={width} height={height} />;
  // Both captures, one per site theme; a lazy image that isn't displayed is never fetched.
  const classes = (theme: string) => [props.className, theme].filter(Boolean).join(' ');
  return (
    <>
      <img {...props} src={withBasePath(`/screenshots/${shot[1]}.light.webp`)} width={width} height={height} loading="lazy" decoding="async" className={classes('dark:hidden')} />
      <img {...props} src={withBasePath(path)} width={width} height={height} loading="lazy" decoding="async" className={classes('hidden dark:block')} />
    </>
  );
}

function fenceLanguage(children: ReactNode): string | undefined {
  if (!isValidElement<{ className?: string }>(children)) return undefined;
  return children.props.className?.split(/\s+/).find((c) => c.startsWith('language-'))?.slice('language-'.length);
}

function extractCode(node: ReactNode): string {
  const lines: string[] = [];
  let sawLine = false;
  let buffer = '';
  const text = (current: ReactNode): string => {
    if (current === null || current === undefined || typeof current === 'boolean') return '';
    if (typeof current === 'string' || typeof current === 'number') return String(current);
    if (Array.isArray(current)) return current.map(text).join('');
    if (isValidElement<{ children?: ReactNode }>(current)) return text(current.props.children);
    return '';
  };
  const walk = (current: ReactNode) => {
    if (Array.isArray(current)) return current.forEach(walk);
    if (isValidElement<{ children?: ReactNode; className?: string }>(current)) {
      if (current.props.className?.split(/\s+/).includes('line')) {
        sawLine = true;
        lines.push(text(current.props.children).replace(/\n+$/, ''));
        return;
      }
      walk(current.props.children);
      return;
    }
    buffer += text(current);
  };
  walk(node);
  return (sawLine ? lines.join('\n') : buffer).trim();
}

export function getMDXComponents(components?: MDXComponents) {
  return { ...defaultMdxComponents, pre: Pre, img: Img, ...components } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;
