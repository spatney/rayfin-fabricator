import { Composition, Still } from 'remotion';
import { Intro, LAYOUT } from './Intro';
import { Poster } from './Poster';
import { RayCheck } from './RayCheck';

export function RemotionRoot(): JSX.Element {
  return (
    <>
      <Composition id="FabricatorIntro" component={Intro} durationInFrames={LAYOUT.total} fps={LAYOUT.fps} width={1920} height={1080} />
      <Still id="Poster" component={Poster} width={1920} height={1080} />
      <Composition id="RayCheck" component={RayCheck} durationInFrames={200} fps={LAYOUT.fps} width={1920} height={1080} />
    </>
  );
}
