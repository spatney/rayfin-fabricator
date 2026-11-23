// One chunk with every German catalog, loaded when German is first shown.
export default import.meta.glob<Record<string, unknown>>('./de/*.json', {
  eager: true,
  import: 'default'
})
