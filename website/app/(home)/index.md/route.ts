import intro from '@/lib/intro-video.json';
import { siteConfig } from '@/lib/site.config';

export const dynamic = 'force-static';
export const revalidate = false;

function minutes(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function GET() {
  return new Response(
    [
      `# ${siteConfig.name}`,
      '',
      siteConfig.description,
      '',
      `- Install: ${siteConfig.baseUrl}/docs/start/install`,
      `- Documentation: ${siteConfig.baseUrl}/docs`,
      `- Docs index for agents: ${siteConfig.baseUrl}/llms.txt`,
      `- Releases: ${siteConfig.releasesUrl}`,
      `- Source: ${siteConfig.repo}`,
      '',
      '## Intro video',
      '',
      `Ray, the stingray who lives in Fabricator, introduces the app (${minutes(intro.durationSeconds)}): ${siteConfig.baseUrl}${intro.src}`,
      `English captions: ${siteConfig.baseUrl}${intro.captions}`,
      '',
      '### Transcript',
      '',
      ...intro.transcript.flatMap((line) => [line, '']),
    ].join('\n'),
    { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } },
  );
}
