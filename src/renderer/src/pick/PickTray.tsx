import type { JSX } from 'react'
import type { ChatPickRef } from '@shared/ipc'
import { CloseIcon, PickIcon } from '../components/icons'
import { useTranslation } from '../i18n'
import type { PickedElement } from './useTouchUp'
import './pick.css'

/**
 * The elements picked in the preview, waiting in the composer: one numbered
 * chip each, with a picture of the element. Hovering a chip outlines its
 * element in the preview; its picture opens large, to draw on; × drops it.
 */
export function PickTray({
  picks,
  onRemove,
  onFocus,
  onOpen
}: {
  picks: readonly PickedElement[]
  onRemove: (id: string) => void
  onFocus?: (id: string | null) => void
  /** Show a pick's picture large, to draw on. */
  onOpen?: (id: string) => void
}): JSX.Element | null {
  const { t } = useTranslation('app')
  if (picks.length === 0) return null
  return (
    <ul className="pick-tray" aria-label={t('pick.toSend')}>
      {picks.map((p) => (
        <li
          key={p.id}
          className="pick-chip"
          title={p.target.label}
          onMouseEnter={() => onFocus?.(p.id)}
          onMouseLeave={() => onFocus?.(null)}
        >
          <span className="pick-chip-n" aria-label={t('pick.number', { n: p.n })}>
            {p.n}
          </span>
          {p.shot && onOpen ? (
            <button
              type="button"
              className="pick-chip-shot pick-chip-shot--open"
              onClick={() => onOpen(p.id)}
              aria-label={t('pick.draw', { label: p.target.label })}
              title={t('pick.drawTitle')}
            >
              <img src={p.shot.thumb} alt="" draggable={false} />
            </button>
          ) : (
            <span
              className={`pick-chip-shot${p.capturing ? ' pick-chip-shot--loading' : ''}`}
              aria-hidden="true"
            >
              {p.shot ? <img src={p.shot.thumb} alt="" draggable={false} /> : <PickIcon />}
            </span>
          )}
          <span className="pick-chip-label">{p.target.label}</span>
          <button
            type="button"
            className="pick-chip-x"
            onClick={() => {
              onFocus?.(null)
              onRemove(p.id)
            }}
            aria-label={t('pick.remove', { label: p.target.label })}
            title={t('actions.remove')}
          >
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The indexes of a message's pictures that belong to its picks (their chips show them). */
export function pickShotIndexes(picks: readonly ChatPickRef[] | undefined): Set<number> {
  return new Set((picks ?? []).flatMap((p) => (p.shot == null ? [] : [p.shot])))
}

/** The elements a sent message picked, as chips in the transcript; a picture opens large. */
export function SentPicks({
  picks,
  thumbs,
  onOpen
}: {
  picks: readonly ChatPickRef[]
  thumbs?: readonly string[]
  /** Show the message's picture at this index large. */
  onOpen?: (shot: number) => void
}): JSX.Element {
  const { t } = useTranslation('app')
  return (
    <ul className="msg-picks" aria-label={t('pick.sent')}>
      {picks.map((p) => {
        const thumb = p.shot == null ? undefined : thumbs?.[p.shot]
        return (
          <li key={p.n} className="pick-chip pick-chip--sent" title={p.label}>
            <span className="pick-chip-n" aria-label={t('pick.number', { n: p.n })}>
              {p.n}
            </span>
            {thumb &&
              (onOpen && p.shot != null ? (
                <button
                  type="button"
                  className="pick-chip-shot pick-chip-shot--open"
                  onClick={() => onOpen(p.shot!)}
                  aria-label={t('pick.show', { label: p.label })}
                  title={t('pick.showTitle')}
                >
                  <img src={thumb} alt="" draggable={false} />
                </button>
              ) : (
                <span className="pick-chip-shot" aria-hidden="true">
                  <img src={thumb} alt="" draggable={false} />
                </span>
              ))}
            <span className="pick-chip-label">{p.label}</span>
          </li>
        )
      })}
    </ul>
  )
}
