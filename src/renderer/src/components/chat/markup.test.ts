import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, commit, constrain, isVisible, redo, undo, type Mark } from './markup'

const mark = (tool: Mark['tool'], points: Mark['points']): Mark => ({
  tool,
  color: '#ff3b30',
  width: 4,
  points
})

describe('drawing on a picture', () => {
  it('undoes and redoes marks, Clear included, and a new change drops what was undone', () => {
    const a = mark('pen', [[1, 1]])
    const b = mark('box', [
      [0, 0],
      [40, 30]
    ])
    let history = commit(commit(EMPTY_HISTORY, [a]), [a, b])
    history = undo(history)
    expect(history.present).toEqual([a])
    expect(redo(history).present).toEqual([a, b])

    history = commit(history, [])
    expect(history.present).toEqual([])
    expect(undo(history).present).toEqual([a])
    expect(redo(history)).toBe(history)
    expect(undo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY)
  })

  it('snaps an arrow to 45° steps and squares a box, and needs a drag to draw either', () => {
    const [x, y] = constrain('arrow', [0, 0], [100, 12])
    expect(x).toBeCloseTo(Math.hypot(100, 12))
    expect(y).toBeCloseTo(0)
    const [dx, dy] = constrain('arrow', [0, 0], [50, 60])
    expect(dx).toBeCloseTo(dy)
    expect(constrain('box', [10, 10], [40, -50])).toEqual([70, -50])

    expect(
      isVisible(
        mark('arrow', [
          [0, 0],
          [5, 0]
        ])
      )
    ).toBe(false)
    expect(
      isVisible(
        mark('arrow', [
          [0, 0],
          [20, 0]
        ])
      )
    ).toBe(true)
    // A tap with the pen is a dot.
    expect(isVisible(mark('pen', [[3, 3]]))).toBe(true)
  })
})
