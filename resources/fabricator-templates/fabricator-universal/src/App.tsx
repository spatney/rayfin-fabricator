import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { HomePage } from '@/pages/HomePage';

// No auth gate: this starter renders its home page directly. To require Fabric
// sign-in for a real app, wrap protected routes in an auth guard (and wire
// AuthProvider in main.tsx) — see `.agents/skills/authentication/SKILL.md`.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
