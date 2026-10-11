import { Composition, Still } from 'remotion';
import { Intro, LAYOUT } from './Intro';
import { Poster } from './Poster';
import { RayCheck, rayCheckLength, type RayCheckProps } from './RayCheck';

/**
 * Two cuts of the same video, to match the docs site's theme: FabricatorIntro (dark, deep
 * water) and FabricatorIntroLight (light, sunlit shallows), each with its poster. RayCheck is
 * a maintainer's check of Ray's rig and lip sync; pick its line and mood in the Studio.
 */
export function RemotionRoot(): JSX.Element {
  const check: RayCheckProps = { line: 'hello', mood: 'idle' };
  return (
    <>
      <Composition id="FabricatorIntro" component={Intro} defaultProps={{ theme: 'dark' }} durationInFrames={LAYOUT.total} fps={LAYOUT.fps} width={1920} height={1080} />
      <Composition id="FabricatorIntroLight" component={Intro} defaultProps={{ theme: 'light' }} durationInFrames={LAYOUT.total} fps={LAYOUT.fps} width={1920} height={1080} />
      <Still id="Poster" component={Poster} defaultProps={{ theme: 'dark' }} width={1920} height={1080} />
      <Still id="PosterLight" component={Poster} defaultProps={{ theme: 'light' }} width={1920} height={1080} />
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
    </>
  );
}
