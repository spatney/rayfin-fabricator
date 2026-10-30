/**
 * Prompts the Architecture view hands to the Build chat. Each is self-contained
 * and ends the way Fabricator's other hand-offs do: keep the app building and
 * leave publishing to Fabricator.
 */
import { connectorKind, type ConnectorConfig, type TableInfo } from '../../model/architecture'

/** How every hand-off ends: the change shows in the preview and is published when the user publishes. */
export const NO_DEPLOY =
  'Keep the app building, and do not run `rayfin up` or publish the app yourself: the change shows in ' +
  'Fabricator’s preview, and reaches the published app when it’s published.'

export interface ChatPrompt {
  display: string
  prompt: string
  /** Stage it in the composer for the person to finish, rather than sending it. */
  stage?: boolean
}

export function runAsEachPerson(c: ConnectorConfig): ChatPrompt {
  const kind = connectorKind(c.type)
  return {
    display: `Use the user’s identity for ${c.name}`,
    prompt:
      `In this Rayfin app, the \`${c.name}\` connector (${kind.label}) in rayfin/rayfin.yml runs as the app ` +
      '(`auth.type: application`), so everyone sees the same data. Change it to `auth.type: delegated` so ' +
      "each query runs as the signed-in person and Fabric checks their own permissions. Keep any per-person " +
      '`claims` rules on its entities, and tell me who will need access to the source in Fabric. ' +
      NO_DEPLOY
  }
}

export function runAsTheApp(c: ConnectorConfig): ChatPrompt {
  const kind = connectorKind(c.type)
  return {
    display: `Use the app identity for ${c.name}`,
    prompt:
      `In this Rayfin app, the \`${c.name}\` connector (${kind.label}) in rayfin/rayfin.yml runs as each ` +
      'signed-in person (`auth.type: delegated`). Change it to `auth.type: application` so it runs as the ' +
      'app identity (the owner of the Fabric app item) and everyone sees the same data. Per-person `claims` ' +
      "rules on its entities can't tell people apart under application auth, so remove or rework them and " +
      'explain what changes. Tell me which access the app identity needs on the source. ' +
      NO_DEPLOY
  }
}

export function fixConnectorAuth(c: ConnectorConfig): ChatPrompt {
  const kind = connectorKind(c.type)
  const allowed = kind.allowed.includes('app') ? '`delegated` or `application`' : '`delegated`'
  return {
    display: `Fix how ${c.name} signs in`,
    prompt:
      `In this Rayfin app, the \`${c.name}\` connector (\`${c.type}\`) in rayfin/rayfin.yml has ` +
      (c.auth ? `\`auth.type: ${c.auth}\`` : 'no `auth.type`') +
      `, which \`rayfin up\` rejects. ${kind.label} connectors allow ${allowed} (lowercase). Set the right ` +
      'value: `delegated` when each person should only see what they can access in Fabric, `application` ' +
      'when everyone should see the same data through the app. Explain the choice you make. ' +
      NO_DEPLOY
  }
}

export function fixFunctionsAuth(): ChatPrompt {
  return {
    display: 'Fix how functions sign in',
    prompt:
      'In this Rayfin app, Functions are enabled in rayfin/rayfin.yml but `services.functions.auth.type` ' +
      "isn't `application`, which Rayfin 1.36 requires. Set it, and check the functions still build. Calls " +
      'to outside resources through `ctx.Tokens` run as the app identity; reading app data through ' +
      '`ctx.getDataClient()` keeps running as the caller. ' +
      NO_DEPLOY
  }
}

export function hardenTables(tables: TableInfo[]): ChatPrompt {
  const names = tables.map((t) => `\`${t.entity}\` (${t.file}, now "${t.label}")`).join(', ')
  return {
    display: tables.length === 1 ? `Harden access on ${tables[0].entity}` : 'Harden access on loose tables',
    prompt:
      `In this Rayfin app, these entities have loose access: ${names}.\n\n` +
      'Please tighten their access control following Rayfin conventions: add an appropriate ' +
      '`@role`/`@authenticated` decorator with a row-level `policy` that scopes rows to their owner ' +
      '(typically by matching a `*_id` field against `claims.sub`), or keep `@anonymous` only if the data ' +
      'is genuinely public. Explain the changes you make. ' +
      NO_DEPLOY
  }
}

export function connectData(): ChatPrompt {
  return {
    display: 'Connect data from Fabric',
    stage: true,
    prompt:
      'Connect this app to existing data in Microsoft Fabric: ' +
      '<which warehouse, SQL database, lakehouse or semantic model, and what the app should do with it>. ' +
      'Add it as a connector with `npx rayfin connector add` and choose `auth.type` deliberately: ' +
      '`delegated` when each person should only see what they can access in Fabric, `application` when ' +
      'everyone should see the same data through the app. Wire it into the app. ' +
      NO_DEPLOY
  }
}

export function grantAppAccess(who: string, sources: string[]): ChatPrompt {
  return {
    display: 'What access does the app need?',
    stage: true,
    prompt:
      `This Rayfin app reaches ${sources.join(', ')} as the app identity (${who}). For each one, tell me ` +
      'exactly which role or permission the app identity needs and where to grant it, and check the code ' +
      "uses the right audience or connector for it. Don't change any files."
  }
}

export function moveKeysToSecrets(keys: { file: string; name: string }[]): ChatPrompt {
  const list = keys.map((k) => `\`${k.name}\` (${k.file})`).join(', ')
  return {
    display: keys.length === 1 ? `Move ${keys[0].name} into a secret` : 'Move keys into secrets',
    prompt:
      `In this Rayfin app, these values in the functions' code look like keys: ${list}. Move each one into a ` +
      'Rayfin secret: declare it under `secrets:` in rayfin/rayfin.yml with a description of what it is for, ' +
      'read it from `ctx.Secrets.<NAME>` instead, and remove it from the code. Don’t run `rayfin secret set`: ' +
      'I’ll add the values in Fabricator’s Secrets view. Never print a key’s value in the chat. ' +
      NO_DEPLOY
  }
}

export function reachAsTheApp(title: string, audience: string, hosts: string[], files: string[]): ChatPrompt {
  return {
    display: `Reach ${title} with the app identity`,
    prompt:
      `In this Rayfin app, functions call ${title} (${hosts.join(', ')}) with a key or token the code sends. ` +
      'Rayfin can give functions an app-identity token for it instead: declare ' +
      `\`AudienceType.${audience}\` in the handler's \`RayfinContext\` and send \`ctx.Tokens.${audience}\` as a ` +
      'bearer token, with `services.functions.auth.type: application` in rayfin/rayfin.yml. Switch the calls in ' +
      `${files.join(', ')} over, remove the key if nothing else needs it, and tell me which role the app identity ` +
      '(the owner of the Fabric app item) needs on the resource. ' +
      NO_DEPLOY
  }
}

export function readTypedSecrets(names: string[]): ChatPrompt {
  const list = names.map((n) => `\`${n}\``).join(', ')
  return {
    display: names.length === 1 ? `Read ${names[0]} as ctx.Secrets` : 'Read secrets as ctx.Secrets',
    prompt:
      `In this Rayfin app, functions read ${list} with \`ctx.getSecret()\`, which is deprecated in Rayfin 1.36. ` +
      'Switch each read to the typed `ctx.Secrets.<NAME>`. A function can only read a name that is listed ' +
      'under `secrets:` in rayfin/rayfin.yml: add any that are missing with a description, and never put a ' +
      "secret's value in code, the chat or frontend code. Confirm the functions still build. " +
      NO_DEPLOY
  }
}
