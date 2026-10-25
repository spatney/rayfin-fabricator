import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { track } from './anim';
import { LESSONS } from '../lessons';
import { SERIES } from '../lessons/series';
import {
  ApiBody,
  ArtifactCard,
  AutocompleteBody,
  Challenge,
  ChapterTag,
  ChapterTitle,
  CodeCard,
  CommandCard,
  DeepDiveTitle,
  DepthGauge,
  Depths,
  EndScreen,
  LessonThumbnail,
  Objectives,
  Quiz,
  Recap,
  RowSecurityBody,
  SeriesBumper,
  ServiceTiles,
  TableBody,
  ValidationBody,
  locate,
} from './lesson-kit';
import { RayActor } from './ray/RayActor';
import { RAY_SIZE } from './scenes/types';
import { Show, build } from './show/Show';
import type { Lesson } from './show/types';
import { THEMES, ThemeProvider, type ThemeName } from './theme';
import { Ocean } from './ui/Ocean';

/** A lesson's composition id, such as `Lesson01`. */
export const lessonId = (n: number): string => `Lesson${String(n).padStart(2, '0')}`;

export function lessonByNumber(n: number): Lesson {
  const found = LESSONS.find((l) => l.episode.script.number === n);
  if (!found) throw new Error(`No lesson ${n} in lessons/index.ts.`);
  return found;
}

/** Frames in a lesson, for its composition's metadata. */
export function lessonLength(n: number): number {
  return build(lessonByNumber(n).episode).plan.total;
}

export type LessonVideoProps = {
  lesson: number;
  theme: ThemeName;
  /** A final render (lesson:render): missing audio is an error rather than silence. */
  strict?: boolean;
};

export function LessonVideo({ lesson, theme, strict = false }: LessonVideoProps): JSX.Element {
  return <Show episode={lessonByNumber(lesson).episode} theme={theme} music={SERIES.music.bed} strict={strict} />;
}

export type LessonThumbProps = { lesson: number; theme: ThemeName };

export function LessonThumb({ lesson, theme }: LessonThumbProps): JSX.Element {
  const l = lessonByNumber(lesson);
  return <LessonThumbnail series={SERIES.name} number={l.episode.script.number} spec={l.youtube.thumbnail} theme={theme} />;
}

/* ------------------------------------------------------------------------------------------ */

const SAMPLE = `import { entity, role, text, uuid } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.owner_id),
})
export class Note {
  @uuid() id!: string;
  @text({ max: 200 }) title!: string;
  @text({ max: 200 }) owner_id!: string;
}`;

/** Every piece of the lesson kit, one after another, for checking how they look. */
export const KIT_CHECK_LENGTH = 1420;

export function KitCheck({ theme }: { theme: ThemeName }): JSX.Element {
  const frame = useCurrentFrame();
  const depth = track(frame, [
    [470, 0],
    [500, 1],
    [700, 1],
    [730, 0],
  ]);
  const dec = locate(SAMPLE, "@role('authenticated', '*', {");
  return (
    <ThemeProvider value={THEMES[theme]}>
      <AbsoluteFill style={{ background: THEMES[theme].base }}>
        <Ocean dim={frame > 330 && frame < 470 ? 0.3 : 0} />
        <Depths depth={depth} />
        <SeriesBumper series={SERIES.name} number={1} title="What is Rayfin?" from={0} to={100} />
        <Objectives items={[{ text: 'What Rayfin is', at: 125 }, { text: 'How one class becomes a backend', at: 140 }, { text: 'How it ships to Microsoft Fabric', at: 155 }]} from={110} to={210} />
        <ChapterTitle label="Chapter 1" title="Meet the entity" from={220} to={300} />
        <ChapterTag text="Meet the entity" from={300} to={470} />
        <CodeCard code={SAMPLE} file="packages/data/src/Note.ts" badge="NEW FILE" x={900} y={560} width={1300} fontSize={30} from={320} to={700} typeFrom={325} typeTo={380} focus={[{ lines: [4, 5, 6], from: 395, to: 460 }]} marks={[{ line: dec.line, from: dec.from, to: dec.to - 3, at: 400, until: 460, label: 'Who can touch it' }]} />
        <DeepDiveTitle from={470} to={700} tuckAt={520} />
        <DepthGauge from={470} to={700} />
        <ArtifactCard x={520} y={420} width={620} icon="table" title="A database table" subtitle="notes" at={540} until={700} lit={0.6}>
          <TableBody columns={['id', 'title', 'owner_id']} rows={[['3f2a…', 'Buy coral', 'avery'], ['9c1d…', 'Feed fish', 'jordan']]} rowsFrom={550} />
        </ArtifactCard>
        <ArtifactCard x={1300} y={330} width={620} icon="api" title="REST and GraphQL APIs" at={560} until={700}>
          <ApiBody rest="Read and write notes" graphql="Ask for just the fields you need" />
        </ArtifactCard>
        <ArtifactCard x={1300} y={700} width={620} icon="client" title="A type-safe client" at={580} until={700}>
          <AutocompleteBody prefix="client.data.Note" items={['create', 'delete', 'findById', 'findMany', 'select', 'update']} from={590} pick={4} />
        </ArtifactCard>
        <ArtifactCard x={520} y={790} width={620} icon="lock" title="Row-level security" at={600} until={700}>
          <RowSecurityBody people={[{ name: 'Avery', color: '#35a3ea' }, { name: 'Jordan', color: '#46ccb0' }]} rows={[{ text: 'Buy coral', owner: 0 }, { text: 'Feed fish', owner: 1 }, { text: 'Paint shell', owner: 0 }]} split={620} />
        </ArtifactCard>
        <ArtifactCard x={960} y={560} width={560} icon="form" title="Form validation" at={710} until={760}>
          <ValidationBody fields={[{ label: 'Title', value: 'Buy coral' }, { label: 'Owner', value: 'x'.repeat(40), error: 'At most 200 characters' }]} failAt={725} />
        </ArtifactCard>
        <ServiceTiles tiles={[{ icon: 'database', label: 'Database', sub: 'In Fabric', at: 775 }, { icon: 'api', label: 'APIs', sub: 'REST and GraphQL', at: 782 }, { icon: 'signin', label: 'Sign-in', sub: 'Microsoft Entra ID', at: 789 }, { icon: 'hosting', label: 'Hosting', sub: 'Your frontend', at: 796 }]} y={560} boundaryAt={770} boundaryLabel="Microsoft Fabric · inside your organization’s tenant" until={860} extra={{ text: '+ Functions and storage, when you turn them on', at: 810 }} />
        <CommandCard command="npx rayfin up" output={[{ text: '✓ Deployed', at: 905, color: '#3ddc84' }]} from={870} to={960} typeFrom={878} typeTo={895} x={960} y={540} tagAt={900} />
        <Quiz question="Which part of an entity decides who can see each row?" options={[{ text: '@entity()', code: true, at: 975 }, { text: '@text({ max: 200 })', code: true, at: 985 }, { text: 'The permission decorator', at: 995 }]} answer={2} countdown={{ from: 1005, step: 15 }} revealAt={1055} from={965} to={1090} />
        <Recap items={[{ text: 'An entity is a decorated TypeScript class', at: 1105 }, { text: 'One class becomes a table, APIs and a typed client', at: 1115 }, { text: 'rayfin up ships it to Fabric', at: 1125 }]} from={1095} to={1180} />
        <Challenge prompt="Build a reading list where I can add books with a title, an author and a finished checkbox. Only I should see my books." from={1185} to={1270} typeFrom={1192} typeTo={1240} cta="What did you build? Tell me in the comments" ctaAt={1245} />
        <EndScreen series={SERIES.name} next={{ number: 2, title: 'Your first Rayfin app' }} from={1275} to={1420} fabricator="Build along with Fabricator · spatney.github.io/rayfin-fabricator" disclaimer={SERIES.disclaimer} />
        <RayActor size={RAY_SIZE} keys={[{ f: 0, x: 1700, y: 900, s: 0.5 }, { f: 1275, x: 1700, y: 900, s: 0.5 }, { f: 1300, x: 1500, y: 300, s: 0.5 }]} moods={[{ f: 0, mood: 'happy' }]} seed={2} />
      </AbsoluteFill>
    </ThemeProvider>
  );
}
