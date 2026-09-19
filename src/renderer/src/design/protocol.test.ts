import { describe, expect, it } from 'vitest'
import { designAssetIds } from './protocol'
import { designTransaction } from './testFixtures'

describe('persisted design asset references', () => {
  it('recovers canonical and earlier nested references without duplicating asset reads', () => {
    const transaction = designTransaction()
    transaction.edits = [{
      ...transaction.edits[0],
      kind: 'image',
      property: 'asset',
      before: { value: { assetId: 'old-image' } },
      after: { assetId: 'new-image', value: { assetId: 'new-image', alt: 'A landscape' } }
    }]
    expect(designAssetIds([transaction])).toEqual(['old-image', 'new-image'])
  })

  it('does not request assets for alt text or ordinary text that happens to contain an assetId', () => {
    const transaction = designTransaction()
    transaction.edits = [
      { ...transaction.edits[0], kind: 'image', property: 'alt', before: { value: '' }, after: { value: 'A landscape' } },
      { ...transaction.edits[0], kind: 'text', after: { assetId: 'not-an-asset-reference' } }
    ]
    expect(designAssetIds([transaction])).toEqual([])
  })
})
