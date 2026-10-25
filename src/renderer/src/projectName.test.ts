import { describe, expect, it } from 'vitest'
import { projectNameProblem, toProjectName } from './projectName'

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
