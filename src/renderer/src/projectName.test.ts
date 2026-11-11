import { describe, expect, it } from 'vitest'
import { funnyProjectName, projectNameProblem, toProjectName } from './projectName'

describe('projectNameProblem', () => {
  it('accepts what the Rayfin CLI accepts', () => {
    for (const name of ['Trip Logger', 'q4-results_v2', '  Sales 2024  ', 'SalesBenchmark']) {
      expect(projectNameProblem(name)).toBeNull()
    }
    expect(projectNameProblem('   ')).toBeNull()
  })

  it('explains what the Rayfin CLI would reject', () => {
    expect(projectNameProblem('SalesBenchmark (migrated)')).toBe(
      'Use only letters, numbers, spaces, hyphens and underscores.'
    )
    expect(projectNameProblem('Café')).toBe('Use only letters, numbers, spaces, hyphens and underscores.')
    expect(projectNameProblem('- _ -')).toBe('Include at least one letter or number.')
  })
})

describe('toProjectName', () => {
  it('makes any text a valid name', () => {
    expect(toProjectName('SalesBenchmark (migrated)')).toBe('SalesBenchmark migrated')
    expect(toProjectName('Résumé: Q4 & FY25 — Overview')).toBe('Resume Q4 FY25 Overview')
    expect(projectNameProblem(toProjectName('Ventes/Marges [2024]'))).toBeNull()
  })
})

describe('funnyProjectName', () => {
  it('only makes two-word names the Rayfin CLI takes', () => {
    // Stepping through [0, 1) reaches every word of both lists.
    const names = new Set<string>()
    for (let k = 0; k < 1000; k += 1) {
      const name = funnyProjectName(() => (k + 0.5) / 1000)
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
      expect(projectNameProblem(name)).toBeNull()
      names.add(name)
    }
    expect(names.size).toBeGreaterThan(40)
  })
})
