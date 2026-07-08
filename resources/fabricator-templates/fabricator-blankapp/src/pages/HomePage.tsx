import { useEffect, useState } from 'react';

import { LightPull } from '@/components/LightPull';
import { RayfinWordmark } from '@/components/RayfinWordmark';
import { useAuth } from '@/hooks/AuthContext';

type Theme = 'dark' | 'light';

export function HomePage() {
  const { signOut } = useAuth();
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('rayfin-theme');
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('rayfin-theme', theme);
  }, [theme]);

  return (
    <div className="rayfin-hero">
      <LightPull
        on={theme === 'light'}
        onToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      <button
        onClick={() => void signOut()}
        className="rayfin-signout"
        aria-label="Sign out"
      >
        Sign out
      </button>

      <div className="rayfin-hero-inner">
        <RayfinWordmark className="rayfin-wordmark" />
        <p className="rayfin-hint">
          Ask the agent to build something — a page, a chart, anything.
        </p>
      </div>
    </div>
  );
}
