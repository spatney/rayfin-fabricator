import { readFileSync } from 'node:fs';
import path from 'node:path';

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const siteConfig = {
  name: 'Fabricator',
  tagline: 'Chat to build. Preview it live. Ship it to Microsoft Fabric.',
  description:
    'Fabricator is a desktop workbench for building Rayfin apps: chat with GitHub Copilot to build them, watch them run live, and deploy them to Microsoft Fabric.',
  baseUrl: (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://spatney.github.io/rayfin-fabricator').replace(/\/$/, ''),
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
  repo: 'https://github.com/spatney/rayfin-fabricator',
  github: {
    owner: 'spatney',
    name: 'rayfin-fabricator',
    branch: 'master',
    contentDir: 'website/content/docs',
  },
  releasesUrl: 'https://github.com/spatney/rayfin-fabricator/releases/latest',
  /** Fabricator's YouTube channel, and the intro video's dark cut on it. */
  youtube: {
    channel: 'https://www.youtube.com/@RayfinFabricator',
    intro: 'https://www.youtube.com/watch?v=4T1oQmT8Bks',
  },
  appVersion: readAppVersion(),
} as const;

export function absoluteUrl(pathname: string): string {
  return `${siteConfig.baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export function withBasePath(pathname: string): string {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return pathname;
  if (!siteConfig.basePath || pathname.startsWith(`${siteConfig.basePath}/`) || pathname === siteConfig.basePath) {
    return pathname;
  }
  return `${siteConfig.basePath}${pathname}`;
}
