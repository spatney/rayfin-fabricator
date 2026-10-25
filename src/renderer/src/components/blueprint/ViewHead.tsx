import { createContext, useContext, type ReactNode, type JSX } from 'react'
import { createPortal } from 'react-dom'

/**
 * The Blueprint tab's header row. Each view (Architecture, Data model, Semantic
 * model) puts its summary and legend there, beside the view switcher, instead
 * of stacking a header of its own under it.
 */
export const BlueprintHeadSlot = createContext<HTMLElement | null>(null)

/**
 * A view's title, summary and legend: rendered into the Blueprint header when
 * the view sits inside it, or as the view's own header when it stands alone.
 */
export function ViewHead({
  title,
  subtitle,
  legend
}: {
  title: string
  subtitle: ReactNode
  legend?: ReactNode
}): JSX.Element {
  const slot = useContext(BlueprintHeadSlot)
  if (slot) {
    return createPortal(
      <>
        <span className="model-subtitle">{subtitle}</span>
        {legend}
      </>,
      slot
    )
  }
  return (
    <div className="model-head">
      <div className="model-head-titles">
        <h2 className="model-title">{title}</h2>
        <span className="model-subtitle">{subtitle}</span>
      </div>
      {legend}
    </div>
  )
}
