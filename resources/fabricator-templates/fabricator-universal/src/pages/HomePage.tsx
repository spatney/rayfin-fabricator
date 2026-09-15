import { useEffect, useState } from 'react';

import { LightPull } from '@/components/LightPull';
import { PullHint } from '@/components/PullHint';
import { RayfinWordmark } from '@/components/RayfinWordmark';

type Theme = 'dark' | 'light';

export function HomePage() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('rayfin-theme');
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  });
  const [pulled, setPulled] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('rayfin-theme', theme);
  }, [theme]);

  return (
    <div className="rayfin-hero">
      <LightPull
        on={theme === 'light'}
        onToggle={() => {
          setPulled(true);
          setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
        }}
      />
      <PullHint dismissed={pulled} />

      <div className="rayfin-hero-inner">
        <RayfinWordmark className="rayfin-wordmark" />
        <p className="rayfin-hint">
          Ask the agent to build something — a page, a chart, anything.
        </p>
      </div>
    </div>
  );
}
