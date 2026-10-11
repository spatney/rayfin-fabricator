'use client';

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { ProductScreenshot } from '@/components/product-screenshot';
import intro from '@/lib/intro-video.json';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const cuts = {
  dark: { src: `${basePath}${intro.src}`, poster: `${basePath}${intro.poster}` },
  light: { src: `${basePath}${intro.light.src}`, poster: `${basePath}${intro.light.poster}` },
};

function minutes(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The intro video, hosted by Ray, in a light and a dark cut that follow the site's theme. It
 * downloads nothing until someone presses play, then plays with sound, native controls and
 * English captions. Switching the theme mid-play carries on in the other cut from the same
 * moment. If it can't load, the workbench screenshot takes its place.
 */
export function ProductVideo() {
  const video = useRef<HTMLVideoElement>(null);
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const [started, setStarted] = useState(false);
  /** The first frame is on screen, so the poster can go. */
  const [rolling, setRolling] = useState(false);
  const [failed, setFailed] = useState(false);
  const { resolvedTheme } = useTheme();
  const cut = resolvedTheme === 'light' ? cuts.light : cuts.dark;
  const length = minutes(intro.durationSeconds);

  // The play button goes away once it's pressed; keep keyboard focus on the player it reveals.
  useEffect(() => {
    if (started) video.current?.focus();
  }, [started]);

  // Load the cut for the current theme. Nothing downloads until someone presses play; once
  // they're watching, the other cut loads at once and carries on from the same moment.
  useEffect(() => {
    const el = video.current;
    if (!el || !resolvedTheme || el.getAttribute('src') === cut.src) return;
    const watching = Boolean(el.currentSrc) && (el.currentTime > 0 || !el.paused);
    const at = { time: el.currentTime, play: !el.paused && !el.ended };
    // With preload="none" a new source would wait for the next press of play.
    if (watching) el.preload = 'auto';
    el.src = cut.src;
    if (!watching) return;
    resume.current = at;
    // Before the new cut's metadata loads, this sets where its playback starts.
    el.currentTime = at.time;
    if (at.play) el.play().catch(() => {});
  }, [cut.src, resolvedTheme]);

  if (failed) return <ProductScreenshot />;

  const play = () => {
    const el = video.current;
    if (!el) return;
    if (!el.getAttribute('src')) el.src = cut.src;
    setStarted(true);
    el.play().catch(() => setStarted(false));
  };

  // For browsers that ignore a seek made before the metadata loaded.
  const pickUp = () => {
    const el = video.current;
    const at = resume.current;
    if (!el || !at) return;
    resume.current = null;
    if (Math.abs(el.currentTime - at.time) > 0.5) el.currentTime = at.time;
  };

  return (
    <figure className="mx-auto mt-12 w-full max-w-[1100px] overflow-hidden rounded-2xl border border-fd-border bg-fd-card/70 p-2 shadow-[0_20px_70px_rgba(15,108,189,0.18)] backdrop-blur dark:shadow-[0_20px_70px_rgba(53,163,234,0.13)] sm:mt-16 sm:rounded-3xl sm:p-3">
      <div className="relative aspect-video overflow-hidden rounded-xl border border-fd-border/70 bg-[#dcefff] dark:bg-[#070b12] sm:rounded-2xl">
        <video
          ref={video}
          className="block h-full w-full"
          preload="none"
          playsInline
          controls={started}
          width={intro.width}
          height={intro.height}
          aria-label="Fabricator intro video: Ray the stingray shows how you build, preview and ship a Rayfin app"
          onPlay={() => setStarted(true)}
          onPlaying={() => setRolling(true)}
          onLoadedMetadata={pickUp}
          onError={() => setFailed(true)}
        >
          <track kind="captions" src={`${basePath}${intro.captions}`} srcLang="en" label="English" />
          <a href={cut.src}>Download the Fabricator intro video</a>
        </video>
        {rolling ? null : (
          <>
            {/* The poster for each theme, until the video's first frame is up. A lazy image that isn't displayed is never fetched. */}
            <img src={cuts.light.poster} alt="" aria-hidden width={intro.width} height={intro.height} loading="lazy" className="pointer-events-none absolute inset-0 block h-full w-full object-cover dark:hidden" />
            <img src={cuts.dark.poster} alt="" aria-hidden width={intro.width} height={intro.height} loading="lazy" className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover dark:block" />
          </>
        )}
        {started ? null : (
          <button
            type="button"
            onClick={play}
            aria-label={`Play the Fabricator intro video (${length})`}
            className="group absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/25 via-transparent to-transparent pb-[5%] focus-visible:outline-none dark:from-black/45 sm:pb-[7%]"
          >
            <span className="flex items-center gap-2 rounded-full bg-fd-primary px-4 py-2 text-sm font-semibold text-fd-primary-foreground shadow-[0_10px_30px_rgba(0,0,0,0.35)] transition-transform group-hover:scale-105 group-focus-visible:ring-4 group-focus-visible:ring-fd-primary/40 sm:gap-3 sm:px-7 sm:py-4 sm:text-lg">
              <svg aria-hidden viewBox="0 0 24 24" className="size-4 fill-current sm:size-6">
                <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
              </svg>
              Meet Fabricator
              <span className="font-normal opacity-80">{length}</span>
            </span>
          </button>
        )}
      </div>
      <figcaption className="px-2 pt-3 text-left text-sm text-fd-muted-foreground sm:px-3">
        <details>
          <summary className="cursor-pointer select-none font-medium text-fd-foreground">Read the transcript</summary>
          <div className="mt-2 space-y-2 leading-6">
            {intro.transcript.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </details>
      </figcaption>
    </figure>
  );
}
