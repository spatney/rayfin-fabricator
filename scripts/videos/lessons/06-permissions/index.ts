import { draftTimeline, isVoiced } from '../../src/show/plan';
import type { Lesson } from '../../src/show/types';
import type { Timeline } from '../../src/timing';
import { SCENES } from './scenes';
import { SCRIPT } from './script';
import timelineJson from './timeline.json';
import { YOUTUBE } from './youtube';

const timeline = timelineJson as Timeline;

export const lesson: Lesson = {
  episode: { script: SCRIPT, timeline: draftTimeline(SCRIPT, timeline), scenes: SCENES },
  youtube: YOUTUBE,
  voiced: isVoiced(SCRIPT, timeline),
};
