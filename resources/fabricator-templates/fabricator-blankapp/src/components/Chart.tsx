import type { CSSProperties } from 'react';

import type {
  ChartSpec,
  SelectionChangeListener,
  SelectionStore,
} from 'graphein';

import { useChart } from './useChart';

/**
 * Declarative React wrapper around the Graphein runtime — `<Chart spec={…} />`.
 *
 * The published `graphein` package ships the framework-agnostic core, so the
 * app owns this thin binding. Renders a container `<div>` that fills its parent
 * (override via `style`/`className`) and draws `spec` into it; pass a new spec
 * to update.
 *
 * Author specs as plain JSON — a `type`, a tidy `data` array, and an `encoding`
 * that names the columns. Graphein owns axes, tooltip, legend, number/date
 * formatting, responsive sizing, animation, and dark mode.
 *
 * For cross-chart interactivity, create a `SelectionStore` with
 * `createSelectionStore()` and pass the *same* store to several charts.
 */
export interface ChartProps {
  /** The Graphein chart spec to render. */
  spec: ChartSpec;
  /** Shared selection bus linking this chart with others (cross-interaction). */
  store?: SelectionStore;
  /** Fired whenever a selection this chart publishes or consumes changes. */
  onSelectionChange?: SelectionChangeListener;
  className?: string;
  style?: CSSProperties;
}

const FILL: CSSProperties = { width: '100%', height: '100%' };

export function Chart({
  spec,
  store,
  onSelectionChange,
  className,
  style,
}: ChartProps) {
  const ref = useChart<HTMLDivElement>(spec, { store, onSelectionChange });
  return (
    <div
      ref={ref}
      className={className}
      style={style ? { ...FILL, ...style } : FILL}
    />
  );
}
