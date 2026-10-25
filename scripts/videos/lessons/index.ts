/**
 * The lessons, in order. Each one is a folder here (see SYLLABUS.md); `npm run lesson:new`
 * creates the folder and adds it to this list.
 */
import type { Lesson } from '../src/show/types';
import { lesson as lesson01 } from './01-what-is-rayfin';
import { lesson as lesson02 } from './02-your-first-app';
import { lesson as lesson03 } from './03-inside-a-rayfin-app';
import { lesson as lesson04 } from './04-entities-and-field-types';
import { lesson as lesson05 } from './05-relationships';
import { lesson as lesson06 } from './06-permissions';

export const LESSONS: readonly Lesson[] = [lesson01, lesson02, lesson03, lesson04, lesson05, lesson06];
