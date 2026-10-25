// Checks a published lesson as viewers see it: public, captions, chapters, clickable links, the end screen on its slots (and NEXT UP's video, once the next lesson is up), the pinned comment, the playlist.
//
//   npm run yt -- check --lesson <n> [--video-id <id>]
//
// It prints a line per check and fails if any does. The video id comes from lessons/channel.ts
// unless you pass one.
import { FRAME, challengeComments, hush, lessonOf, loadChannel, loadComments, loadUpload, oembed, sameText, stringArg, watchTab } from '../studio.mjs';

/** How far an end-screen element may sit from its slot, as a share of the player's size. */
const TOLERANCE = 0.012;

export default async ({ context, state, log, shot, args }) => {
  const CHANNEL = await loadChannel();
  const n = lessonOf(args);
  const up = await loadUpload(n);
  const id = stringArg(args, 'video-id') ?? CHANNEL.lessons[n];
  if (!id) throw new Error(`lessons/channel.ts has no video for lesson ${n}; pass --video-id.`);
  const results = [];
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    log(`${pass ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
  };

  const info = await oembed(id);
  check('anyone with the link can watch it, logged out', Boolean(info), info ? info.author_name : 'private, or still processing');

  const w = await watchTab(context, state);
  await w.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  await w.waitForTimeout(5000);
  await hush(w);
  const player = await w.evaluate(() => {
    const pr = window.ytInitialPlayerResponse;
    return {
      status: pr?.playabilityStatus?.status,
      unlisted: pr?.microformat?.playerMicroformatRenderer?.isUnlisted,
      title: pr?.videoDetails?.title,
      tracks: (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((t) => ({ lang: t.languageCode, kind: t.kind ?? '' })),
    };
  });
  check('public', player.status === 'OK' && player.unlisted === false, `status ${player.status}, unlisted ${player.unlisted}`);
  check('title', player.title === up.title, player.title);
  check('our English captions', player.tracks.some((t) => t.lang === 'en' && t.kind !== 'asr'), player.tracks.map((t) => `${t.lang}${t.kind ? `/${t.kind}` : ''}`).join(', '));

  await w.locator('#description-inline-expander #expand, tp-yt-paper-button#expand').first().click().catch(() => {});
  await w.waitForTimeout(1500);
  const description = await w.evaluate(() => {
    const links = [...document.querySelectorAll('#description-inline-expander a')].map((a) => {
      try {
        return new URL(a.href).searchParams.get('q');
      } catch {
        return null;
      }
    });
    return { links: [...new Set(links.filter(Boolean))].length, chapters: document.querySelectorAll('ytd-macro-markers-list-item-renderer').length };
  });
  const urls = new Set(up.description.match(/https?:\/\/\S+/g) ?? []).size;
  check('description links are clickable', description.links >= urls, `${description.links} of ${urls}`);
  const chapters = (up.description.match(/^\d+:\d{2} /gm) ?? []).length;
  check('chapters', description.chapters >= chapters && chapters >= 3, `${description.chapters} shown, ${chapters} in the description`);

  // The end screen: play a moment of it, muted, and compare the elements with the slots.
  await w.evaluate(async (at) => {
    window.scrollTo(0, 0);
    const v = document.querySelector('video');
    v.muted = true;
    v.currentTime = at;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    v.pause();
  }, up.endScreen.from + 4);
  const es = await w.evaluate(() => {
    const box = document.querySelector('#movie_player').getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      elements: [...document.querySelectorAll('.ytp-ce-element')].map((e) => ({
        kind: /ytp-ce-(video|playlist|channel|website)\b/.exec(e.className)?.[1],
        href: e.querySelector('a[href]')?.href ?? null,
        left: parseFloat(e.style.left),
        top: parseFloat(e.style.top),
        width: parseFloat(e.style.width),
        height: parseFloat(e.style.height),
      })),
    };
  });
  const { video: v, subscribe: s } = up.endScreen.slots;
  const next = es.elements.find((e) => e.kind === 'video' || e.kind === 'playlist');
  const sub = es.elements.find((e) => e.kind === 'channel');
  const nextOff = next ? Math.max(Math.abs(next.left / es.width - v.x / FRAME.width), Math.abs(next.top / es.height - v.y / FRAME.height), Math.abs(next.width / es.width - v.w / FRAME.width)) : 1;
  const subOff = sub ? Math.max(Math.abs((sub.left + sub.width / 2) / es.width - s.x / FRAME.width), Math.abs((sub.top + sub.height / 2) / es.height - s.y / FRAME.height)) : 1;
  check('end screen: NEXT UP on its slot', nextOff <= TOLERANCE, next ? `${next.kind}, ${(nextOff * 100).toFixed(1)}% off` : 'missing');
  check('end screen: Subscribe on its slot', subOff <= TOLERANCE, sub ? `${(subOff * 100).toFixed(1)}% off` : 'missing');
  // Once the next lesson is up, NEXT UP must be its video. An older cut of it can share its title.
  const nextId = up.next ? CHANNEL.lessons[up.next.number] : undefined;
  if (nextId) {
    const target = next?.href ? new URL(next.href).searchParams.get('v') : null;
    check(`end screen: NEXT UP is lesson ${up.next.number}`, next?.kind === 'video' && target === nextId, next ? `${next.kind}${target ? ` ${target}` : ''}` : 'missing');
  }
  await shot('check-endscreen', w);

  await loadComments(w);
  const challenge = (await challengeComments(w, CHANNEL.handle)).find((c) => sameText(c.text, up.pinnedComment));
  check('the challenge is pinned', Boolean(challenge?.pinned), challenge ? '' : 'no comment from the channel with the current challenge');

  await w.goto(`https://www.youtube.com/playlist?list=${CHANNEL.playlist.id}`, { waitUntil: 'domcontentloaded' });
  await w.waitForTimeout(4000);
  const order = await w.evaluate(() => [...document.querySelectorAll('ytd-playlist-video-renderer a#video-title')].map((a) => new URL(a.href).searchParams.get('v')));
  const known = [CHANNEL.intro, ...Object.keys(CHANNEL.lessons).map(Number).sort((a, b) => a - b).map((k) => CHANNEL.lessons[k])];
  const inOrder = order.filter((x) => known.includes(x));
  check(`in the playlist "${CHANNEL.playlist.title}"`, order.includes(id), `${order.length} videos`);
  check('the playlist is in lesson order', JSON.stringify(inOrder) === JSON.stringify(known.filter((x) => inOrder.includes(x))), inOrder.join(' → '));

  const failed = results.filter((r) => !r.pass);
  if (failed.length) throw new Error(`${failed.length} of ${results.length} checks failed: ${failed.map((f) => f.name).join('; ')}`);
  return { video: `https://youtu.be/${id}`, checks: results.length, passed: results.length };
};
