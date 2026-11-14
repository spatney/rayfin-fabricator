// One chunk with every Spanish catalog, loaded when Spanish is first shown.
export default import.meta.glob<Record<string, unknown>>('./es/*.json', {
  eager: true,
  import: 'default'
})
