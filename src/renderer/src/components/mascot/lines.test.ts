import { afterEach, describe, expect, it } from 'vitest'
import { FactDeck, RAYFIN_FACTS, buildDeck, greeting } from './lines'

/** A repeatable stand-in for Math.random. */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

afterEach(() => localStorage.clear())

describe('what Ray says', () => {
  it('shares every Rayfin fact once per deck, with an aside after every two', () => {
    const deck = buildDeck(seeded(7))
    const facts = deck.filter((c) => c.kind === 'rayfin').map((c) => c.text)
    expect([...facts].sort()).toEqual([...RAYFIN_FACTS].sort())
    expect(new Set(deck.map((c) => c.text)).size).toBe(deck.length)
    deck.forEach((card, i) => {
      // Every third line is an aside; the rest are Rayfin facts.
      expect(card.kind === 'rayfin').toBe(i % 3 !== 2)
    })
  })

  it('never repeats a line until the deck is spent, even across restarts', () => {
    const total = buildDeck(seeded(1)).length
    const said = new Set<string>()
    const before = new FactDeck(seeded(3))
    for (let i = 0; i < 5; i++) said.add(before.next().text)
    // A new deck, as after restarting the app, carries on where the last stopped.
    const after = new FactDeck(seeded(99))
    for (let i = 5; i < total; i++) said.add(after.next().text)
    expect(said.size).toBe(total)
  })

  it('forgets saved lines that a newer version reworded', () => {
    localStorage.setItem(
      'fabricator.mascot.deck',
      JSON.stringify([{ kind: 'rayfin', text: 'A line that no longer exists.' }])
    )
    expect(new FactDeck(seeded(5)).next().text).not.toBe('A line that no longer exists.')
  })

  it('introduces himself only the first time', () => {
    expect(greeting('create', true).text).toMatch(/^Hi, I’m Ray!/)
    expect(greeting('create', false, seeded(2)).text).not.toMatch(/I’m Ray/)
  })
})
