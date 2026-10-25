import { Fragment } from 'react';
import { Composition, Still } from 'remotion';
import { Intro, LAYOUT } from './Intro';
import { KIT_CHECK_LENGTH, KitCheck, LessonThumb, LessonVideo, lessonId, lessonLength, type LessonThumbProps, type LessonVideoProps } from './Lessons';
import { LESSONS } from '../lessons';
import { Poster } from './Poster';
import { RayAvatar } from './RayAvatar';
import { RayCheck, rayCheckLength, type RayCheckProps } from './RayCheck';

/**
 * Two cuts of the same video, to match the docs site's theme: FabricatorIntro (dark, deep
 * water) and FabricatorIntroLight (light, sunlit shallows), each with its poster. RayCheck is
 * a maintainer's check of Ray's rig and lip sync; pick its line and mood in the Studio.
 * RayAvatar is Ray on his own, square, for a profile picture.
 *
 * Then the Learn Rayfin with Ray lessons: LessonNN for each one in lessons/index.ts (dark, for
 * YouTube), with its thumbnail LessonNNThumbnail, and KitCheck, which plays every piece of the
 * lesson kit in turn.
 */
export function RemotionRoot(): JSX.Element {
  const check: RayCheckProps = { line: 'hello', mood: 'idle' };
  return (
    <>
      <Composition id="FabricatorIntro" component={Intro} defaultProps={{ theme: 'dark' }} durationInFrames={LAYOUT.total} fps={LAYOUT.fps} width={1920} height={1080} />
      <Composition id="FabricatorIntroLight" component={Intro} defaultProps={{ theme: 'light' }} durationInFrames={LAYOUT.total} fps={LAYOUT.fps} width={1920} height={1080} />
      <Still id="Poster" component={Poster} defaultProps={{ theme: 'dark' }} width={1920} height={1080} />
      <Still id="PosterLight" component={Poster} defaultProps={{ theme: 'light' }} width={1920} height={1080} />
      <Still id="RayAvatar" component={RayAvatar} defaultProps={{ theme: 'dark' as const }} width={1024} height={1024} />
      <Composition
        id="RayCheck"
        component={RayCheck}
        defaultProps={check}
        calculateMetadata={({ props }) => ({ durationInFrames: rayCheckLength(props) })}
        durationInFrames={rayCheckLength(check)}
        fps={LAYOUT.fps}
        width={1920}
        height={1080}
      />
      {LESSONS.map((lesson) => {
        const n = lesson.episode.script.number;
        const video: LessonVideoProps = { lesson: n, theme: 'dark' };
        const thumb: LessonThumbProps = { lesson: n, theme: 'dark' };
        return (
          <Fragment key={n}>
            {/* A lesson that can't be laid out fails on its own, not the whole Studio. */}
            <Composition
              id={lessonId(n)}
              component={LessonVideo}
              defaultProps={video}
              calculateMetadata={({ props }) => ({ durationInFrames: lessonLength(props.lesson) })}
              durationInFrames={300}
              fps={LAYOUT.fps}
              width={1920}
              height={1080}
            />
            <Still id={`${lessonId(n)}Thumbnail`} component={LessonThumb} defaultProps={thumb} width={1920} height={1080} />
          </Fragment>
        );
      })}
      <Composition id="KitCheck" component={KitCheck} defaultProps={{ theme: 'dark' as const }} durationInFrames={KIT_CHECK_LENGTH} fps={LAYOUT.fps} width={1920} height={1080} />
    </>
  );
}
