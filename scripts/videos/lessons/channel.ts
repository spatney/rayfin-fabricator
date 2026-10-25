/**
 * Where the lessons are published: Fabricator's YouTube channel, the series' playlist, and the
 * video each published lesson became. The YouTube tools (tools/youtube/) read it. It's kept
 * apart from series.ts, which the lessons render from, so recording an upload here never makes
 * a rendered lesson stale.
 */
export interface Channel {
  /** The channel's name, as YouTube shows it beside a comment. */
  name: string;
  id: string;
  handle: string;
  playlist: { id: string; title: string };
  /** The Fabricator intro, first in the playlist. */
  intro: string;
  /**
   * The intro's end screen: one video element, NEXT UP, pointing to lesson 1. The intro was made
   * before the lessons and draws no slots, and YouTube's smallest video element (about 620×349
   * frame px, a third of the width) doesn't fit beside its end card. So the element shows only
   * while the card is dimmed for the stinger, as low and as far left as YouTube's safe area lets
   * it (x from about 45, y from about 141 to 916): a 16:9 box in the 1920×1080 frame, from
   * `start` (Studio's `m:ss:ff`, the first whole second the card is fully dimmed) to `end` (the
   * frame it starts to brighten). It covers the left ends of the dimmed "Runs on…" line and
   * Download button; the channel's owner chose that over covering the bright card (October 2026).
   */
  introEndScreen: { start: string; end: string; video: { x: number; y: number; w: number; h: number } };
  /** Each published lesson's video id, by lesson number. */
  lessons: Readonly<Record<number, string>>;
  /**
   * The answer to YouTube Studio's "AI use" question. YouTube asks whether AI made a real person
   * appear to say or do something, altered footage of a real event or place, generated a
   * realistic scene that didn't happen, or created music that's the main focus. The lessons are
   * animated, Ray is a cartoon, and the music is a bed under his voice, so the channel's owner
   * chose "no" for lesson 1 (October 2026). Ask them again before publishing a lesson that
   * changes any of that.
   */
  aiUse: 'yes' | 'no';
}

export const CHANNEL: Channel = {
  name: 'Fabricator',
  id: 'UCbkqoj2jPG5n81qFgBJjpCA',
  handle: '@RayfinFabricator',
  playlist: { id: 'PLXW2FECmSE6Q', title: 'Learn Rayfin with Ray' },
  intro: '4T1oQmT8Bks',
  introEndScreen: { start: '1:19:00', end: '1:24:13', video: { x: 45, y: 566, w: 620, h: 349 } },
  lessons: {
    1: 'n-VtBCmtn78',
    2: '-PzsntUZT7w',
    3: 'cYkA6CkVJLA',
    4: 'H3jneRn7Mlk',
    5: 'RcK4Tx_f63w',
    6: 'G4HfluMI9iY',
  },
  aiUse: 'no',
};
