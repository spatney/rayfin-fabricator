// One chunk with every Brazilian Portuguese catalog, loaded when it's first shown.
export default import.meta.glob<Record<string, unknown>>('./pt-BR/*.json', {
  eager: true,
  import: 'default'
})
