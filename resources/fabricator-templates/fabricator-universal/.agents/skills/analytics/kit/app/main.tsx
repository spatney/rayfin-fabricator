import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';

import App from '@/App';

import './global.css';

// Analytics dashboard entry. The bundled demo renders against inlined data, so
// this previews with no backend. When you connect a real Power BI semantic model,
// queries run through the Fabric embed proxy (src/lib/fabric-client.ts) — no
// AuthProvider is needed inside Fabric. If you add app sign-in, wire AuthProvider
// here (see the `authentication` skill).
createRoot(document.getElementById('root')!).render(<App />);
