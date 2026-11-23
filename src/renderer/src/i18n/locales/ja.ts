// One chunk with every Japanese catalog, loaded when Japanese is first shown.
export default import.meta.glob<Record<string, unknown>>('./ja/*.json', {
  eager: true,
  import: 'default'
})
