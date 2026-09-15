import { FilterStateProvider, SelectionStoreProvider } from '@/components/dashboard';
import { SketchContext } from '@/hooks/sketch.context';
import { ThemeContext } from '@/hooks/theme.context';
import { useAppSketch } from '@/hooks/use-sketch';
import { useAppTheme } from '@/hooks/use-theme';
import { DemoDashboard } from '@/demo/DemoDashboard';

// Analytics dashboard root. Renders the bundled starter dashboard (src/demo) so a
// freshly scaffolded app is never blank — every tile is a Graphein spec over
// inlined data, fully interactive with no backend. The providers below make the
// theme/sketch toggles and the slicer + cross-filter interactivity live.
//
// To ship your own dashboard: point the specs at a real Power BI semantic model
// (see the `build-workflow` skill), then delete `src/demo/**` and replace
// <DemoDashboard /> with your hero visual — keep this provider wrapping.
function App() {
  const theme = useAppTheme();
  const sketch = useAppSketch();

  return (
    <ThemeContext.Provider value={theme}>
      <SketchContext.Provider value={sketch}>
        <SelectionStoreProvider>
          <FilterStateProvider>
            <DemoDashboard />
          </FilterStateProvider>
        </SelectionStoreProvider>
      </SketchContext.Provider>
    </ThemeContext.Provider>
  );
}

export default App;
