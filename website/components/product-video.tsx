'use client';

import { useEffect, useRef, useState } from 'react';
import { ProductScreenshot } from '@/components/product-screenshot';
import intro from '@/lib/intro-video.json';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

function minutes(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The intro video, hosted by Ray. It downloads nothing until someone presses play, then plays
 * with sound, native controls and English captions. If it can't load, the workbench
 * screenshot takes its place.
 */
export function ProductVideo() {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const length = minutes(intro.durationSeconds);

  // The play button goes away once it's pressed; keep keyboard focus on the player it reveals.
  useEffect(() => {
    if (started) video.current?.focus();
  }, [started]);

  if (failed) return <ProductScreenshot />;

  const play = () => {
    const el = video.current;
    if (!el) return;
    setStarted(true);
    el.play().catch(() => setStarted(false));
  };

  return (
    <figure className="mx-auto mt-12 w-full max-w-[1100px] overflow-hidden rounded-2xl border border-fd-border bg-fd-card/70 p-2 shadow-[0_20px_70px_rgba(15,108,189,0.18)] backdrop-blur dark:shadow-[0_20px_70px_rgba(53,163,234,0.13)] sm:mt-16 sm:rounded-3xl sm:p-3">
      <div className="relative aspect-video overflow-hidden rounded-xl border border-fd-border/70 bg-[#070b12] sm:rounded-2xl">
        <video
          ref={video}
          className="block h-full w-full"
          poster={`${basePath}${intro.poster}`}
          preload="none"
          playsInline
          controls={started}
          width={intro.width}
          height={intro.height}
          aria-label="Fabricator intro video: Ray the stingray shows how you build, preview and ship a Rayfin app"
          onPlay={() => setStarted(true)}
          onError={() => setFailed(true)}
        >
          <source src={`${basePath}${intro.src}`} type="video/mp4" onError={() => setFailed(true)} />
          <track kind="captions" src={`${basePath}${intro.captions}`} srcLang="en" label="English" />
          <a href={`${basePath}${intro.src}`}>Download the Fabricator intro video</a>
        </video>
        {started ? null : (
          <button
            type="button"
            onClick={play}
            aria-label={`Play the Fabricator intro video (${length})`}
            className="group absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/45 via-transparent to-transparent pb-[5%] focus-visible:outline-none sm:pb-[7%]"
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
