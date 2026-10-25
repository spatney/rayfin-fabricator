# Learn Rayfin with Ray: the lesson plan

**Learn Rayfin with Ray** is a YouTube series where Ray, Fabricator's stingray, teaches
[Rayfin](https://rayfin.ai) one short lesson at a time. The goal is Rayfin itself: its ideas,
its code and its commands. Fabricator is the harness the lessons build along with. Whenever a
lesson shows a harness, it is Fabricator and nothing else.

This file is the series' source of truth: what each lesson teaches, in what order, and how far
along it is. The `learn-rayfin-with-ray` skill (`.github/skills/learn-rayfin-with-ray/`)
reads it before making a lesson and updates the status table when a lesson ships.

- **Audience:** makers, analysts and developers who are new to Rayfin. Some TypeScript helps
  but isn't required; Ray explains the code he shows.
- **Length:** 3–5 minutes. One idea per lesson, with a demo and a quiz.
- **Rayfin version:** every lesson is checked against one Rayfin release, named in its
  `script.ts` and in its YouTube description. Season 1 is checked against **1.36.2**.
- **Playlist:** [Learn Rayfin with Ray](https://www.youtube.com/playlist?list=PLXW2FECmSE6Q) on
  [Fabricator's channel](https://www.youtube.com/@RayfinFabricator): the Fabricator intro ("meet
  your guide"), then the lessons in the order below.

## Status

| # | Lesson | Folder | Status |
| --- | --- | --- | --- |
| 1 | What is Rayfin? | `lessons/01-what-is-rayfin` | Published: [youtu.be/n-VtBCmtn78](https://youtu.be/n-VtBCmtn78) |
| 2 | Your first Rayfin app | `lessons/02-your-first-app` | Published: [youtu.be/-PzsntUZT7w](https://youtu.be/-PzsntUZT7w) |
| 3 | Inside a Rayfin app | `lessons/03-inside-a-rayfin-app` | Published: [youtu.be/cYkA6CkVJLA](https://youtu.be/cYkA6CkVJLA) |
| 4 | Entities and field types | `lessons/04-entities-and-field-types` | Published: [youtu.be/H3jneRn7Mlk](https://youtu.be/H3jneRn7Mlk) |
| 5 | Relationships | `lessons/05-relationships` | Published: [youtu.be/RcK4Tx_f63w](https://youtu.be/RcK4Tx_f63w) |
| 6 | Permissions and row-level security | `lessons/06-permissions` | Published: [youtu.be/G4HfluMI9iY](https://youtu.be/G4HfluMI9iY) |
| 7 | Reading and writing your data | | Planned |
| 8 | Connectors: your Fabric data, in your app | | Planned |
| 9 | Functions and secrets | | Planned |
| 10 | Storage | | Planned |
| 11 | Aggregations | | Planned |
| 12 | Auth: sign-in, sessions and identity | | Planned |
| 13 | Capstone: build and ship an app | | Planned |

Statuses: Planned → Scripted → Approved → Voiced → Rendered → Published (with the YouTube link).

## The format of every lesson

Every lesson has the same shape, so viewers know where they are. Each beat is a scene in the
studio's lesson kit (`src/lesson-kit/`):

1. **Cold open** (about 12 s). A question and a visual payoff that make the lesson worth
   watching. No title card first.
2. **Bumper** (about 3.5 s). The "Learn Rayfin with Ray" jingle, with the lesson's number and
   title.
3. **Today you'll learn.** Three short objectives.
4. **Concept chapters.** Code cards, diagrams and big titles. Each chapter is a YouTube chapter.
5. **Deep Dive.** The water darkens, a depth gauge ticks down, and Ray shows what Rayfin
   generates or does under the surface. Every lesson has one.
6. **See it in Fabricator.** The same idea in Fabricator, from the docs screenshots, animated.
7. **Pop Quiz.** One question with three answers. Ray says "pause and guess", the bubbles count
   down, then he reveals the answer with confetti.
8. **Recap.** Three takeaways.
9. **Ray's challenge.** A prompt to paste into Fabricator's chat, and a question for the
   comments.
10. **Next up.** The next lesson, with room for YouTube's end-screen elements (15–20 s). A
    Ray fact comes last.

### Ground rules

- **Teach Rayfin.** Fabricator appears only to build along. Show what Fabricator does for
  you ("Fabricator runs `rayfin up` for you"), and show Rayfin CLI commands as "under the hood"
  cards. Never show another agent harness, IDE or chat tool.
- **Every Rayfin claim has a source.** Each line in a lesson's `script.ts` lists the rayfin.ai
  pages it rests on. Where those pages and the installed packages' own docs differ, the
  installed docs win. Those sources become the "Learn more" links in the description.
- **Code on screen compiles.** `npm run lesson:snippets -- <n>` type-checks every snippet a
  lesson shows against the real `@microsoft/rayfin-*` packages.
- **Ray stays Ray.** Short lines, his moods, at most two ocean puns per lesson, and no hype
  words ("simply", "easy", "powerful", "seamless").
- **Not official.** Each lesson's end card says the series is a community project, not an
  official Microsoft channel.

## Season 1: Rayfin 101

### Module 1: Get your fins wet

#### 1. What is Rayfin?

**YouTube title:** What is Rayfin? One TypeScript class, a whole backend | Learn Rayfin with Ray #1

- **Hook:** "What if your whole backend… was one TypeScript class?"
- **You'll learn:** what Rayfin is; how one class becomes a backend; how it ships to
  Microsoft Fabric.
- **Concepts:** Rayfin is a backend platform for TypeScript developers. An entity is a
  decorated TypeScript class: `@entity()`, field decorators such as `@text({ max })`, and a
  permission decorator with a row-level policy. One command, `rayfin up`, deploys the app as a
  Fabric app inside your organization's tenant.
- **Deep Dive:** from one class, Rayfin generates a database table, REST and GraphQL APIs, a
  type-safe client, row-level security and form validation, with no SQL, schema file or API
  contract to keep in sync by hand.
- **In Fabricator:** you describe the app, the agent writes `Expense.ts`, and Blueprint draws
  it as an entity with its access rules.
- **Pop Quiz:** Which part of an entity decides who can see each row? **The permission
  decorator and its policy.**
- **Challenge:** describe a tiny app in Fabricator, then find its entity in Blueprint.
- **Sources:** [/docs](https://rayfin.ai/docs), [/docs/data](https://rayfin.ai/docs/data),
  [/docs/data/modeling](https://rayfin.ai/docs/data/modeling),
  [/docs/data/permissions](https://rayfin.ai/docs/data/permissions)

#### 2. Your first Rayfin app

- **Hook:** from an empty folder to an app running in Fabric.
- **You'll learn:** how to scaffold a project; the dev loop; how to deploy.
- **Concepts:** `npm create @microsoft/rayfin@latest` with the default `blankapp` template (the
  Universal App); `rayfin login` (Microsoft Entra ID in the browser); `npm run dev` runs
  `rayfin dev`; `rayfin up` and `rayfin up status`. Prerequisites: Node.js 20+ and a Fabric
  account, and Fabric apps turned on in the tenant. The GitHub CLI isn't needed. The new app
  starts small, with sign-in and a website and the data service off. Data, functions,
  connectors and storage are added when the app needs them; lesson 3 maps them, and Module 3
  teaches them.
- **Deep Dive:** `rayfin dev` provisions or reuses the backend in Fabric and runs only the
  frontend (and any Functions) on your machine. There is no backend to run yourself.
  `rayfin dev` doesn't publish; `rayfin up` does.
- **In Fabricator:** New project → the first deploy → the preview.
- **Pop Quiz:** Which command publishes your frontend to Fabric: `rayfin dev`, `rayfin up` or
  `rayfin login`? **`rayfin up`.**
- **Sources:** [/docs/start/quickstart](https://rayfin.ai/docs/start/quickstart),
  [/docs/start/develop-locally](https://rayfin.ai/docs/start/develop-locally),
  [/docs/start/deploy-to-fabric](https://rayfin.ai/docs/start/deploy-to-fabric),
  [/docs/start/project-structure](https://rayfin.ai/docs/start/project-structure)

#### 3. Inside a Rayfin app

- **Hook:** "A new Rayfin app comes with more than a hundred files. What are they all for?"
- **You'll learn:** the Universal App's packages; `rayfin.yml` and its services; the building
  blocks an app can add: data, connectors, functions and storage.
- **Concepts:** `packages/frontend`, `packages/data`, `packages/shared` (and
  `packages/functions` when added). `rayfin/rayfin.yml` declares the services (`auth`, `data`,
  `staticHosting`, `functions` and `storage`), plus top-level `connectors` and
  `secrets` lists. The Universal App starts with the data service off. `assetAccess` is
  `protected` or `public`. Which generated files stay out of git. Rayfin projects ship skills
  for coding agents in `.agents/skills`.
- **Deep Dive:** how a Fabric app runs. Your frontend is static content in front of a
  WebService, Data API Builder and an MSSQL database, with Functions and blob storage beside
  them. Sign-in is part of the app too: Fabric brokered auth signs people in with the Microsoft
  Entra account they use for Fabric, with no identity provider to run and no Entra app of your
  own to approve. Outside the app sit data already in Fabric (reached through connectors),
  Microsoft resources (through function connections) and any HTTPS API (through a function and
  a secret). `rayfin dev` and `rayfin up` sync `rayfin.yml` to Fabric.
- **In Fabricator:** the Code view's file tree; the Skills tab's always-on Rayfin skills;
  Blueprint's Architecture view, with its **Website**, **Sign-in**, **Database**, **File
  storage**, **Connectors**, **Functions** and **Secrets** pieces.
- **Pop Quiz:** Which file records your deployments and shouldn't be committed?
  **`rayfin/.deployments.json`.**
- **Challenge:** open Blueprint, send a prompt that adds a notes page with per-person notes,
  and find the new **Database** piece.
- **Sources:** [/docs](https://rayfin.ai/docs),
  [/docs/start/project-structure](https://rayfin.ai/docs/start/project-structure),
  [/docs/reference/config/rayfin-yml](https://rayfin.ai/docs/reference/config/rayfin-yml)

### Module 2: Data, the heart of Rayfin

#### 4. Entities and field types

- **Hook:** "Every field gets a decorator, and every decorator means something."
- **You'll learn:** how to define an entity; the field types; how to register it.
- **Concepts:** `@entity()`; the `id` UUID primary key, which Rayfin adds if you leave it out;
  `@text`, `@int`, `@decimal`, `@boolean`, `@date`, `@email` and `@set`; options such as
  `optional` (with a `?` on the property), `default`, `unique`, `min` and `max`, which Rayfin
  enforces. In the Universal App you register the entity in `packages/data/src/index.ts` and
  add its record to `UniversalAppSchema` in `packages/shared`, which types the client. Names
  GraphQL already uses, such as `Date`, are rejected. Rayfin can build a form validator from an
  entity (`toStandardSchema()`), but the Universal App's frontend doesn't import entity
  classes, so the lesson only mentions it.
- **Keep it engine-neutral.** Rayfin's data service runs on SQL Server or PostgreSQL, and not
  having to care which is part of the point. Say "database" and "column", not engine types
  such as `NVARCHAR`.
- **Deep Dive:** why every `@text` needs a `max`. Without one, the column gets the database's
  maximum length, and on some databases (SQL Server, per the docs) Rayfin can fail to build the
  GraphQL schema from it, after a deploy that looked fine.
- **In Fabricator:** Blueprint's Data model view shows each field's type; a set shows as
  `enum`, a key marks the primary key, and filled and hollow marks show required and optional.
- **Pop Quiz:** What's wrong with `@text() title!: string`? **It has no `max`.**
- **Sources:** [/docs/data/modeling](https://rayfin.ai/docs/data/modeling),
  [/docs/data/field-types](https://rayfin.ai/docs/data/field-types),
  [/docs/data/validation](https://rayfin.ai/docs/data/validation),
  [/docs/reference/known-limitations](https://rayfin.ai/docs/reference/known-limitations)

#### 5. Relationships

- **Hook:** "A customer has many orders. How does Rayfin know?"
- **You'll learn:** when your data needs a link, and when an entity can stand alone; `@one` and
  `@many`; foreign keys; many-to-many; what happens when you delete.
- **Concepts:** Lesson 4's Expense is an island: its category is a `@set` (a fixed list), and
  its `owner_id` is plain text from sign-in, not a foreign key. Something people create and
  share across records, such as a report, gets its own entity and a link.
  `@one(() => Report)` and `@many(() => Expense)`, with lazy callbacks and runtime imports.
  Rayfin generates the foreign-key columns; a key you declare follows the `{property}_id`
  naming. Writes set a relationship with `{ report: { id } }`, and the `@many` side is
  read-only. Dot paths read across it both ways (`report.title`, `expenses.amount`).
  Many-to-many isn't supported, so you use a join entity with two `@one()`.
- **Deep Dive:** what a delete does to linked records. rayfin.ai doesn't say, so the lesson
  checked Rayfin 1.36.2's own backend (`rayfin dev --provider docker`, on SQL Server and on
  PostgreSQL): every `@one` is a real foreign key with no delete rule. Linking to a record that
  doesn't exist fails, and so does deleting a record that others still point at ("Cannot
  complete this operation because other items depend on this record. Remove the dependent items
  first."). Nothing cascades, and `@one` has no option to, so you move or delete the expenses
  first, and a tag's links.
- **In Fabricator:** the lines between entities in the Data model view, `Expense[]` on the many
  side, and the join entity in the middle.
- **Pop Quiz:** You delete a report that still has expenses. What happens? **The delete fails
  until you move or delete them.**
- **Sources:** [/docs/data/relationships](https://rayfin.ai/docs/data/relationships),
  [/docs/data/mutations](https://rayfin.ai/docs/data/mutations),
  [/docs/data/querying](https://rayfin.ai/docs/data/querying),
  [/docs/data/field-types](https://rayfin.ai/docs/data/field-types)

#### 6. Permissions and row-level security

- **Hook:** "Your data, your rows. Nobody else's."
- **You'll learn:** the permission decorators; row-level policies; why the UI isn't security.
- **Concepts:** the two built-in roles, `authenticated` and `anonymous`. `@authenticated()`
  and `@anonymous()` are shorthands for `@role()` (lessons 4 and 5 used `@role`). Actions
  (`'*'`, create, read, update, delete). A policy on claims (`sub`, `email`, `role`), such as
  `claims.sub.eq(item.owner_id)`, typed on both sides. The policy checks `owner_id` but
  doesn't fill it in: the app sets it from the session when it creates a row. Anonymous data
  on Fabric needs a tenant admin switch.
- **Deep Dive:** an entity with no permission decorator gives any signed-in user full CRUD.
  A filter in the app shapes what one query asks for; anyone signed in can ask without it.
  Checked on Rayfin 1.36.2's own backend (`rayfin dev --provider docker`, on SQL Server and
  on PostgreSQL), with two signed-in people: without a decorator, Blake read, edited and
  deleted Avery's rows; with the owner policy, he couldn't reach them at all, and creating a
  row with her `owner_id` was refused.
- **Left out:** field visibility (`include` and `exclude`). The 1.36.2 backend dropped an
  excluded-from-read field from creates as well, where rayfin.ai says it stays writable. And
  public read with an owner-scoped write: signed-in people saw only their own rows there.
- **In Fabricator:** Blueprint's access dots (**Row-scoped**, **Any signed-in**, **Public**)
  and **Harden**, on the `model-access` screenshot: lesson 5's model with Report's decorator
  left out.
- **Pop Quiz:** A filter in the app hides other people's rows. Are they private? **No. Only a
  policy on the server keeps them private.**
- **Sources:** [/docs/data/permissions](https://rayfin.ai/docs/data/permissions),
  [/docs/data/mutations](https://rayfin.ai/docs/data/mutations)

#### 7. Reading and writing your data

- **Hook:** "Ask your data a question, in TypeScript. Then change the answer."
- **You'll learn:** the query chain; create, update and delete; pagination.
- **Concepts:** `client.data.<Entity>` with `select([...])`, `where({ field: { eq } })`,
  `orderBy({ createdAt: 'desc' })` and `execute()`; `findById` and `findFirst`. Writes:
  `create(data)`, where `id` is optional; `update(filter, data)`; `delete(filter)`;
  relationship fields as `{ id }`. Every call is typed from the entity, and the entity's
  policies still decide which rows it touches.
- **Deep Dive:** `execute()` returns one page (100 records by default) and doesn't say whether
  there are more. Use `first(n)`, `executePaginated()` and `after(cursor)`.
- **In Fabricator:** the preview listing and adding data.
- **Pop Quiz:** Your list stops at 100 items. Why? **`execute()` returns a single page.**
- **Sources:** [/docs/data/querying](https://rayfin.ai/docs/data/querying),
  [/docs/data/mutations](https://rayfin.ai/docs/data/mutations)

### Module 3: Beyond your own tables

Rayfin isn't only your own database. This module comes straight after the data client, so
viewers meet the rest of the platform while the client is fresh: data that already lives in
Fabric, code that runs on the server, and files. Where a feature isn't available everywhere,
such as Functions, say so on screen.

#### 8. Connectors: your Fabric data, in your app

- **Hook:** "Your company's data already lives in Fabric. Use it in your app."
- **You'll learn:** what a connector is; its two kinds; which identity a connector uses.
- **Concepts:** a connector points at data your app doesn't own: a Warehouse, a SQL database,
  a Lakehouse SQL analytics endpoint or a semantic model. `rayfin connector search` finds
  sources, and `rayfin connector add` writes the entry to `rayfin.yml`; then you install the
  version-pinned packages it prints. SQL sources become typed entities with `@role()` policies,
  read with the same query chain at `client.connectors.<name>.<Entity>`. Semantic models run
  DAX with `client.connectors.<name>.executeQuery(...)`. A Lakehouse SQL endpoint is read-only,
  and Rayfin 1.36.2 holds back new KQL database connectors.
- **Deep Dive:** whose identity a connector uses. `connector add` sets SQL connectors to the
  app identity (the owner of the Fabric app item), so everyone sees the same data; `delegated`
  gives each user their own access. Semantic models always run as the signed-in user. The
  source's IDs stay in `rayfin.yml` and are added on the server, so the browser sends only the
  query.
- **In Fabricator:** **Connect a semantic model** in the chat composer's add menu, Blueprint's
  **Semantic model** view, and the Architecture view's **Uses user’s identity** and **Uses app
  identity** labels.
- **Pop Quiz:** Which identity does a semantic model connector use? **The signed-in user's.**
- **Sources:** [/docs/connectors](https://rayfin.ai/docs/connectors),
  [/docs/connectors/adding](https://rayfin.ai/docs/connectors/adding),
  [/docs/connectors/sql-sources](https://rayfin.ai/docs/connectors/sql-sources),
  [/docs/connectors/semantic-models](https://rayfin.ai/docs/connectors/semantic-models),
  [/docs/auth/delegated-access](https://rayfin.ai/docs/auth/delegated-access)

#### 9. Functions and secrets

- **Hook:** "Some code should never run in the browser."
- **You'll learn:** when to use a function; how to write and call one; how to keep a secret.
- **Concepts:** a function is server-side TypeScript that runs in Fabric, for trusted logic,
  secrets and calls to outside services. `rayfin functions init` adds them, and
  `services.functions.auth.type: application` is required. Register a handler with
  `udf.func(name, handler, [])` in `function_app.ts`, and call it from the app with
  `client.functions.<name>.invoke(...)`, typed by the generated `AppFunctionsSchema`.
  `rayfin secret set` stores a value with the deployed app, and a function reads it as
  `ctx.Secrets.<NAME>`. `rayfin dev` runs functions on your machine; `rayfin up` deploys them.
  For plain reads and writes, use `client.data`, not a function.
- **Deep Dive:** a function has two identities. `ctx.getDataClient()` runs as the signed-in
  caller, so your entity policies still apply. `ctx.Tokens.<Audience>` runs as the app identity,
  which needs access at each resource. Locally, the functions host uses your own sign-in, so a
  call can work on your machine and fail after `rayfin up`.
- **In Fabricator:** Code → **Secrets**, with **New secret** and **Ask Copilot to use it**;
  Blueprint's **Functions** and **Secrets** pieces.
- **Pop Quiz:** Where can your app read an API key safely? **In a function, with
  `ctx.Secrets`.**
- **Availability:** Functions aren't available in every Fabric region or tenant.
- **Sources:** [/docs/functions](https://rayfin.ai/docs/functions),
  [/docs/functions/writing-functions](https://rayfin.ai/docs/functions/writing-functions),
  [/docs/functions/calling-functions](https://rayfin.ai/docs/functions/calling-functions),
  [/docs/functions/secrets](https://rayfin.ai/docs/functions/secrets),
  [/docs/auth/delegated-access](https://rayfin.ai/docs/auth/delegated-access)

#### 10. Storage

- **Hook:** "Where do the receipts go?"
- **You'll learn:** what Storage is; how to declare a folder; how to upload, list and download
  files.
- **Concepts:** turn it on with `services.storage.enabled: true`. Declare a folder in
  `rayfin/storage/` with `@blob({ name, maxSize: mb(5), allowedContentTypes })` and a `@role()`
  policy, then register it in the storage schema. Call `client.storage['<folder>']` with
  `upload()`, `list()`, `download()` and `delete()`.
- **Deep Dive:** files get the same permission model as rows, such as
  `claims.sub.eq(item.owner_id)`. Every folder needs an authenticated rule, and anonymous
  storage isn't supported. The service enforces the size and content-type limits.
- **In Fabricator:** Blueprint's **File storage** piece.
- **Pop Quiz:** Can a signed-out visitor upload to a Storage folder? **No. Anonymous storage
  permissions aren't supported.**
- **Availability:** treat Storage as released; don't call it experimental. It's experimental
  in Rayfin 1.36.2 and due to ship soon, so script this lesson against the release where it
  ships, and check its import path and API again then.
- **Sources:** [/docs/storage](https://rayfin.ai/docs/storage),
  [/docs/reference/sdk/rayfin-storage](https://rayfin.ai/docs/reference/sdk/rayfin-storage),
  [/docs/reference/known-limitations](https://rayfin.ai/docs/reference/known-limitations)

### Module 4: Bring it together

#### 11. Aggregations

- **Hook:** "Totals for a dashboard, without downloading every row."
- **You'll learn:** `groupBy()`, `aggregate()` and grand totals.
- **Concepts:** `groupBy([...])`, then `aggregate({ alias: { sum: 'amount' } })`, then
  `execute()`; filtering with `where()`; skipping `groupBy()` for one total row. SQL connector
  entities from lesson 8 aggregate the same way.
- **Deep Dive:** the server computes the numbers, so only the totals travel.
- **In Fabricator:** the Contoso Expenses chart by category.
- **Sources:** [/docs/data/aggregations](https://rayfin.ai/docs/data/aggregations)

#### 12. Auth: sign-in, sessions and identity

- **Hook:** "Who's there? Microsoft Entra ID knows."
- **You'll learn:** how people sign in; sessions; which identity each part of your app uses.
- **Concepts:** Microsoft Entra ID is the only identity provider for Rayfin Fabric apps; email
  and password sign-in is for local development only. Sign-in is Fabric brokered auth (say
  that; rayfin.ai also calls it Fabric SSO): Fabric signs people in with the Microsoft Entra
  account they use for Fabric, so the app has no identity provider to run and no app
  registration of its own for a tenant admin to approve. It has a popup flow in a browser
  (`ensureSignedInWithFabric()` from a user gesture) and an embedded flow inside the Fabric
  portal. Sessions are opaque: read `getSession()` and watch
  `onSessionChange`. The React integration adds `AuthProvider`, `useAuth` and a route guard.
  `assetAccess` decides whether pages load before sign-in. The session's claims (`sub`,
  `email`, `role`) drive lesson 6's policies. Direct Entra token sign-in and embedding in your
  own portal cover other hosts.
- **Deep Dive:** who's asking? Your own data runs as the signed-in user, even inside a
  function. Function connections run as the app identity, and each connector chooses its own.
  Public pages don't make data public: entity permissions still apply.
- **In Fabricator:** Blueprint's **People**, the **Sign-in** piece and the identity labels; the
  **Website** piece's **Pages load after sign-in**.
- **Pop Quiz:** Your pages load before sign-in (`assetAccess: public`). Is your data public
  now? **No. APIs and data permissions still apply.**
- **Sources:** [/docs/auth](https://rayfin.ai/docs/auth),
  [/docs/auth/fabric-sso](https://rayfin.ai/docs/auth/fabric-sso),
  [/docs/auth/sessions](https://rayfin.ai/docs/auth/sessions),
  [/docs/auth/react](https://rayfin.ai/docs/auth/react),
  [/docs/auth/delegated-access](https://rayfin.ai/docs/auth/delegated-access),
  [/docs/hosting](https://rayfin.ai/docs/hosting)

#### 13. Capstone: build and ship an app

- **Hook:** "Everything you've learned, in one app."
- **You'll learn:** how the pieces fit together, from start to finish.
- **Concepts:** Contoso Expenses from start to finish: an entity with an owner policy, a
  dashboard with an aggregation, a connector or a function where the app needs one, sign-in,
  a deploy, an Advisor check and sharing.
- **Sources:** [/docs/recipes/todo-app](https://rayfin.ai/docs/recipes/todo-app) and the
  [Fabricator docs](https://spatney.github.io/rayfin-fabricator/docs)

## Season 2: Rayfin 201 (planned)

Season 1 introduces connectors, functions and storage. Season 2 goes deeper:

- Changing your schema safely: `rayfin up` and `rayfin up db apply`, and destructive changes
  with `--force`
- Fabric apps, workspaces, capacity and billing
- Environments, deployment targets and Fabric deployment pipelines
- Function connections in depth: Fabric REST, OneLake, SQL, Azure AI Foundry and Azure DevOps
- Semantic models and DAX in depth
- KQL databases, once Rayfin brings back new KQL connectors (held back in 1.36.2)
- Seeding data
- Hosting: redirect URIs and deep links
- Testing a Rayfin app
- Signing in with an Entra token, and embedding an app in your own portal
- Bringing your own identity provider through OIDC, once Rayfin supports it (Microsoft Entra ID,
  through Fabric brokered auth, is the only provider in 1.36.2)

Check each topic's availability notes on rayfin.ai before scripting it. For example, Functions
aren't in every Fabric region or tenant.
