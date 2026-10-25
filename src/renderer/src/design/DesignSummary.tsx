import type { ChatDesignSummary, DesignItemKind } from '@shared/design'
import { DesignIcon, PaletteIcon, SparkleIcon } from '../components/icons'
import './design.css'

import type { JSX } from 'react'

function KindIcon({ kind }: { kind: DesignItemKind }): JSX.Element {
  if (kind === 'theme') return <PaletteIcon className="design-card-kind" />
  if (kind === 'suggestion') return <SparkleIcon className="design-card-kind" />
  return <DesignIcon className="design-card-kind" />
}

/** Thumbnail indexes a Design card shows itself (the rest are the user's own screenshots). */
export function designShotIndexes(design: ChatDesignSummary): Set<number> {
  const used = new Set<number>()
  if (design.full != null) used.add(design.full)
  for (const item of design.items) if (item.shot != null) used.add(item.shot)
  return used
}

/**
 * The Design changes a message carried, as a card in the transcript: numbered
 * changes with their element crops and the previewed full view. The structured
 * prompt Copilot received stays behind a disclosure.
 */
export function DesignSummary({
  design,
  thumbs,
  prompt
}: {
  design: ChatDesignSummary
  thumbs?: string[]
  prompt?: string
}): JSX.Element {
  const n = design.items.length
  const full = design.full != null ? thumbs?.[design.full] : undefined
  return (
    <div className="design-card" role="group" aria-label={`Design changes (${n})`}>
      <div className="design-card-head">
        <DesignIcon className="design-card-ico" />
        <span className="design-card-title">
          {n} design change{n === 1 ? '' : 's'}
        </span>
        <span className="design-card-sub">from the live preview</span>
      </div>
      {full && <img className="design-card-full" src={full} alt="The preview with these changes applied" />}
      <ol className="design-card-list">
        {design.items.map((item) => {
          const shot = item.shot != null ? thumbs?.[item.shot] : undefined
          return (
            <li key={item.n} className="design-card-item">
              <span className="design-card-n" aria-hidden="true">
                {item.n}
              </span>
              {shot ? (
                <img className="design-card-shot" src={shot} alt={`Change ${item.n}: ${item.label}`} />
              ) : (
                <span className="design-card-shot design-card-shot--icon" aria-hidden="true">
                  <KindIcon kind={item.kind} />
                </span>
              )}
              <span className="design-card-text">
                <span className="design-card-label">{item.label}</span>
                <span className="design-card-summary">{item.summary}</span>
              </span>
            </li>
          )
        })}
      </ol>
      {prompt && (
        <details className="design-card-details">
          <summary>Details sent to Copilot</summary>
          <pre>{prompt}</pre>
        </details>
      )}
    </div>
  )
}
