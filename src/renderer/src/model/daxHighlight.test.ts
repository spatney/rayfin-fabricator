import { describe, it, expect } from 'vitest'
import { tokenizeDax, type DaxToken } from './daxHighlight'

/** Collect the tokens of a given kind. */
const of = (tokens: DaxToken[], kind: DaxToken['kind']): string[] =>
  tokens.filter((t) => t.kind === kind).map((t) => t.text)

describe('tokenizeDax', () => {
  it('round-trips: concatenated tokens equal the source', () => {
    const src = `VAR x = SUM ( Sales[Amount] ) // total\nRETURN x + 1`
    const tokens = tokenizeDax(src)
    expect(tokens.map((t) => t.text).join('')).toBe(src)
  })

  it('classifies a function, table and column reference', () => {
    const tokens = tokenizeDax('SUM(Sales[Amount])')
    expect(of(tokens, 'fn')).toEqual(['SUM'])
    expect(of(tokens, 'table')).toEqual(['Sales'])
    expect(of(tokens, 'col')).toEqual(['[Amount]'])
    expect(of(tokens, 'paren')).toEqual(['(', ')'])
  })

  it('treats an identifier as a function even with whitespace before the paren', () => {
    const tokens = tokenizeDax('CALCULATE ()')
    expect(of(tokens, 'fn')).toEqual(['CALCULATE'])
  })

  it('recognises single-quoted table names with spaces', () => {
    const tokens = tokenizeDax(`'Sales Order'[Qty]`)
    expect(of(tokens, 'table')).toEqual([`'Sales Order'`])
    expect(of(tokens, 'col')).toEqual(['[Qty]'])
  })

  it('classifies keywords VAR / RETURN / IN', () => {
    const tokens = tokenizeDax('VAR a = 1 RETURN a IN { 1 }')
    expect(of(tokens, 'kw')).toEqual(['VAR', 'RETURN', 'IN'])
  })

  it('handles string literals with "" escapes', () => {
    const tokens = tokenizeDax('IF([x] = "a""b", 1, 0)')
    expect(of(tokens, 'str')).toEqual(['"a""b"'])
  })

  it('captures numbers including decimals', () => {
    const tokens = tokenizeDax('DIVIDE(1, 2.5)')
    expect(of(tokens, 'num')).toEqual(['1', '2.5'])
  })

  it('captures line and block comments', () => {
    const tokens = tokenizeDax('// hi\nSUM(x) /* mid */')
    expect(of(tokens, 'comment')).toEqual(['// hi', '/* mid */'])
  })

  it('does not misclassify a bare identifier as a function or table', () => {
    const tokens = tokenizeDax('TRUE')
    expect(of(tokens, 'fn')).toEqual([])
    expect(of(tokens, 'table')).toEqual([])
    expect(of(tokens, 'text')).toContain('TRUE')
  })
})
