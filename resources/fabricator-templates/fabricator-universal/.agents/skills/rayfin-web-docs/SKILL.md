---
name: rayfin-web-docs
description: >
  Use before implementing or troubleshooting Rayfin-specific behavior: entities,
  decorators, queries, mutations, permissions, Fabric SSO, sessions, service
  configuration, functions, storage, connectors, hosting, SDK upgrades, or
  deployment errors. Look up official guidance at https://rayfin.ai/ through
  its llms.txt index and relevant Markdown pages, then reconcile examples with
  the project's installed SDK and CLI versions. Skip purely visual or unrelated
  React changes. Triggers: Rayfin, API, SDK, auth, data, schema, permissions,
  rayfin.yml, functions, storage, connectors, hosting, deployment, troubleshooting.
---

# Rayfin web documentation

Use [rayfin.ai](https://rayfin.ai/) for maintained platform explanations and
examples. This is a documentation skill, not a capability pack: reading it does
not enable services, install packages, or change the app.

## Lookup workflow

1. **Identify the question and project versions.** Narrow the lookup to the
   requested capability or failure. Read the resolved SDK and CLI versions from
   installed packages or the lockfile; a manifest's caret range is not an exact
   version.
2. **Find the relevant pages.** Fetch
   [the documentation index](https://rayfin.ai/llms.txt) with an available
   web-reading tool. Reuse an index already fetched in this conversation when
   appropriate. Select only the pages that answer the question; do not download
   the entire documentation corpus.
3. **Read the guidance, not just the index.** Append `.md` to each selected
   documentation route for a clean Markdown response. For Rayfin implementation
   work, also consult the relevant
   [agent rules](https://rayfin.ai/docs/reference/agent-rules.md) and
   [known limitations](https://rayfin.ai/docs/reference/known-limitations.md).
   The site's [agent entry point](https://rayfin.ai/AGENTS.md) explains its
   documentation formats.
4. **Resolve version differences before coding.** Check each page's
   `sdk_version`, `cli_version`, and `last_updated` metadata. For exact APIs,
   follow the CLI-generated `.agents/skills/rayfin/SKILL.md` when present and
   use the project's Rayfin MCP or `npx rayfin docs` from the project root.
   Consult the [docs command reference](https://rayfin.ai/docs/reference/cli/docs.md)
   for that lookup surface. If hosted examples target another version, confirm
   them against the version-matched sources rather than guessing or upgrading
   dependencies just to copy a snippet. Do not assume the website hosts an MCP
   endpoint.
5. **Apply the guidance to this app.** Reuse its existing schema, client, auth
   helpers, and any selected capability pack. Keep the project-specific rules in
   `AGENTS.md`: generic website commands are not permission to deploy, start a
   dev server, or replace the app's established workflow.

## When a source is unavailable

If a web lookup fails, state that limitation and use permitted, installed,
version-matched documentation instead. Respect access restrictions; do not
switch tools to bypass a denial. If neither source establishes the needed API,
explain what is missing rather than inventing it. Do not claim to have consulted
a page that was not retrieved.

> [!WARNING]
> Functions and storage are experimental and may not
> be available in every Fabric region or tenant. Check the relevant service
> documentation and target availability before designing around them; do not
> enable experimental capabilities merely because they appear in the index.
