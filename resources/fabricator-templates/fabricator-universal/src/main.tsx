import { createRoot } from 'react-dom/client';

import App from '@/App';

import './main.css';

// This starter renders a no-auth "hello world" page, so it previews locally
// (`npm run preview`) with no backend or sign-in. When you build a real app
// that needs Fabric authentication, re-enable it — the auth scaffolding is
// still here; see `.agents/skills/authentication/SKILL.md`. In short:
//
//   import { AuthProvider } from '@/hooks/AuthContext';
//   import { bootstrapAuth } from '@/services/bootstrap';
//   const authService = bootstrapAuth();
//   createRoot(document.getElementById('root')!).render(
//     <AuthProvider authService={authService}>
//       <App />
//     </AuthProvider>
//   );
createRoot(document.getElementById('root')!).render(<App />);
