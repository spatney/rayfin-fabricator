'use client';

import { useEffect, useState } from 'react';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const shots = { light: `${basePath}/screenshots/workbench.light.webp`, dark: `${basePath}/screenshots/workbench.webp` };
const alt = 'The Fabricator workbench: chat on the left builds the app, and the running app appears in the live preview on the right.';
const imageClass = 'h-auto w-full rounded-xl border border-fd-border/70 bg-fd-muted object-cover sm:rounded-2xl';

/** The workbench in the site's theme: the light capture in light mode, the dark one in dark mode. */
export function ProductScreenshot() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(src));
        image.src = src;
      });
    Promise.all([load(shots.light), load(shots.dark)]).then(
      () => !cancelled && setVisible(true),
      () => !cancelled && setVisible(false),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  return (
    <figure className="mx-auto mt-12 w-full max-w-[1100px] overflow-hidden rounded-2xl border border-fd-border bg-fd-card/70 p-2 shadow-[0_20px_70px_rgba(15,108,189,0.18)] backdrop-blur dark:shadow-[0_20px_70px_rgba(53,163,234,0.13)] sm:mt-16 sm:rounded-3xl sm:p-3">
      <img src={shots.light} alt={alt} width={1440} height={900} loading="eager" className={`block dark:hidden ${imageClass}`} />
      <img src={shots.dark} alt={alt} width={1440} height={900} loading="eager" className={`hidden dark:block ${imageClass}`} />
    </figure>
  );
}
