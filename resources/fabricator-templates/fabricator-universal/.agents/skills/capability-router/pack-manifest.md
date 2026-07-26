# Pack manifests — how a capability turns itself on

This universal app grows by **capability packs**. A pack is a skill under
`.agents/skills/<pack>/` that can ship a **`pack.json` manifest** describing,
declaratively, everything needed to turn it on. One command applies it:

```sh
npm run pack:add -- <pack>        # e.g. analytics
```

`scripts/scaffold.mjs` reads `.agents/skills/<pack>/pack.json` and, in one
**idempotent** pass: patches Fabric service flags, merges dependencies + scripts
into `package.json`, copies the pack's kit files into the project, then runs a
single `npm install`. This replaces "copy dozens of files by hand + install
dozens of packages + rewire scripts" — the slow part of a build.

> **This is the general mechanism, not an analytics feature.** New connectors and
> capabilities should ship a `pack.json` so they enable the same fast way.
> `analytics` is just the first pack to adopt it.

## `pack.json` schema

```jsonc
{
  "name": "analytics",
  "description": "One-line summary shown while scaffolding.",

  // 1) Fabric service flags — edits rayfin/rayfin.yml. Only set what changes;
  //    auth + staticHosting are on by default, data is on by default.
  "rayfin": { "services": { "data": { "enabled": false } } },

  // 2) npm packages to ADD. Pin analytics-/pack-specific packages only; the base
  //    template owns the shared toolchain (react, vite, typescript, eslint,
  //    tailwind, graphein, rayfin-*). Don't re-pin those here — it causes churn.
  "dependencies":    { "framer-motion": "^12.40.0" },
  "devDependencies": { "@graphein/node": ">=0.16.0" },

  // 3) package.json scripts to set (overwrites those keys).
  "scripts": { "gallery": "vite" },

  // 4) Files to copy. `from` is relative to the pack dir, `to` to the repo root.
  //    A directory `from` merges recursively (pack-owned files overwrite on
  //    re-run; sibling files are untouched). A file `from` copies to `to`.
  "copy": [
    { "from": "kit/lib", "to": "src/lib" },
    { "from": "kit/global.css", "to": "src/global.css" },

    // Seed files replace the BASE starter once, then never clobber user edits:
    // written only if the destination is missing OR still contains the marker
    // string (i.e. it's the untouched base file).
    { "from": "kit/app/App.tsx", "to": "src/App.tsx", "seedReplaceIfContains": "HomePage" }
  ],

  // 5) Skills to read next, printed after scaffolding (build in this order).
  "next": ["build-workflow", "visuals", "dax"]
}
```

## Guarantees

- **Idempotent.** Re-running `pack:add` sets the same flags, adds no duplicate
  deps, and re-copies pack-owned kit files. Seed files (`seedReplaceIfContains`)
  are preserved once you've edited them.
- **Lean base.** A pack adds only what it needs. The base stays universal; the
  shared toolchain and lockfile live in the base, so pack installs are small and
  deterministic.

## Flags

- `--no-install` — apply everything except `npm install` (install yourself later).
- `--dry-run` — print the planned actions and write nothing.

## Adding a pack manifest

1. Put the pack's copy-in files under `.agents/skills/<pack>/kit/**`.
2. Write `.agents/skills/<pack>/pack.json` per the schema above.
3. Test with `npm run pack:add -- <pack> --dry-run`, then for real on a scratch
   copy. Keep it idempotent.
