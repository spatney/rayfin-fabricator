//! Skills catalog (list/toggle/source) and the per-project agent operating
//! contract. Faithful port of `src/main/services/skills.ts`.
//!
//! Add-on skills live on disk as `.agents/skills/<id>/SKILL.md`. CLI-managed
//! (locked) skills carry a `rayfin-managed: true` frontmatter sigil and cannot
//! be removed. Toggling a skill writes/deletes its folder and commits just that
//! folder so the change shows up in History.
//!
//! Catalog copies are stamped `metadata.author: Fabricator` and the catalog
//! entry's `version`. That stamp tells a catalog copy apart from a different
//! skill that happens to use the same folder name (a template's own
//! `data-modeling`, say), and flags copies written by an older Fabricator.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use crate::services::{exec, git, store};
use crate::types::{CustomSkillInfo, SkillActionResult, SkillInfo, SkillSource};

/// A curated add-on skill the user can toggle on/off.
struct SkillDef {
  id: &'static str,
  title: &'static str,
  description: &'static str,
  icon: &'static str,
  category: &'static str,
  /// Bump when `trigger` or `body` change, so apps with an older copy are offered the update.
  version: &'static str,
  trigger: &'static str,
  body: &'static str,
}

const LOOK: &str = "Look & feel";
const EXPERIENCE: &str = "Experience";
const DATA: &str = "Data";
const QUALITY: &str = "Quality";

/// The curated catalog of optional skills, grouped by category in the UI.
static CATALOG: &[SkillDef] = &[
  SkillDef {
    id: "polished-ui",
    title: "Polished, modern UI",
    description: "A clean, consistent look: spacing, type, color and components that match.",
    icon: "✨",
    category: LOOK,
    version: "2.0.0",
    trigger: r#"Make the app look clean, modern and consistent. Use when building screens or components, restyling or theming, or when the user asks to make the app look better, nicer or more professional. Triggers: UI, design, styling, layout, theme, colors, spacing, typography, components, look and feel, redesign, polish, make it pretty, modern, dark mode, light mode"#,
    body: r#"Give the app a calm, modern and consistent look.

## Start from what's there
- Reuse the project's theme, CSS variables, utility classes and components before adding new ones. If a design skill (for example `app-design`) is active, follow it; this skill fills the gaps.
- Keep one source of truth for design tokens (color, radius, spacing, type) and use them everywhere instead of one-off values.

## Layout and spacing
- Use a 4px spacing scale (4, 8, 12, 16, 24, 32, 48) and the same gaps between similar elements.
- Align content to a clear grid and give each screen one obvious main area. Keep reading width under about 70 characters.
- Group related things with whitespace and a subtle surface or 1px border, not with heavy boxes, glows or gradients.

## Type
- At most two font families. Use a small type scale (for example 12, 14, 16, 20, 24 and 32px) with clear weights: about 600 for headings and 400 for body text.
- Body text is at least 14px with a line height of 1.4 to 1.6. Use sentence case for headings, labels and buttons.

## Color
- Neutral surfaces and text, plus one accent color for primary actions, links and focus. Keep red, amber and green for status.
- Build light and dark themes from the same tokens, and meet WCAG AA contrast in both.

## Components
- Buttons, inputs, selects and cards share heights, corner radius and border style. Every interactive element has hover, focus-visible, active and disabled states.
- One primary button per view; other actions are secondary or quiet.
- Use one icon set at consistent sizes, with text labels unless the icon's meaning is universal.

## Avoid
- Several accent colors, shadow styles or corner radii on one screen.
- Centered paragraphs, walls of borders, and decorative effects that compete with the content.

## Before you finish
- Review each changed screen's markup and styles: tokens instead of one-off values, consistent spacing, both themes covered, and long or empty content handled."#,
  },
  SkillDef {
    id: "buttery-animations",
    title: "Buttery animations",
    description: "Quick, purposeful motion that never gets in the way.",
    icon: "🎬",
    category: LOOK,
    version: "2.0.0",
    trigger: r#"Add smooth, purposeful motion and micro-interactions. Use when adding transitions or hover and press feedback, or when animating content that appears, changes or leaves. Triggers: animation, transition, motion, animate, hover effect, fade, slide, spring, easing, micro-interaction, smooth, 60fps, framer motion, reduced motion"#,
    body: r#"Use motion to show what changed. Never use it to decorate or to make people wait.

## When to animate
- Things that enter, leave or move: dialogs, menus, toasts, list items being added or removed, panels expanding.
- Feedback on direct interaction: hover, press, toggle, drag.
- Skip motion for whole pages, actions people repeat all the time, and anything that would delay reading or typing.

## How
- Animate only `transform` and `opacity`. Don't animate `width`, `height`, `top`, `left` or large shadows.
- Durations: 100 to 150ms for hover and press, 150 to 250ms for small elements entering, up to 300ms for large panels. Exits are a little faster than entrances.
- Easing: ease-out (for example `cubic-bezier(0.2, 0, 0, 1)`) for entrances, ease-in for exits, ease-in-out for moves.
- Move short distances (4 to 16px) while fading. Stagger list items by 20 to 40ms and cap the total stagger.
- Use CSS transitions for simple state changes. Use an animation library only if the project already has one or layout animations really need it.

## Respect the user
- Honor `prefers-reduced-motion: reduce`: swap movement for a fade, or no animation.
- Never block input while something animates, and never loop motion nobody asked for.

## Before you finish
- Review each animation: it has a clear reason, takes 300ms or less, moves only transform or opacity, and has a reduced-motion fallback."#,
  },
  SkillDef {
    id: "responsive-layout",
    title: "Responsive on every screen",
    description: "Layouts that work on phones, tablets and wide desktops.",
    icon: "📱",
    category: LOOK,
    version: "2.0.0",
    trigger: r#"Make layouts adapt to every screen, from phones to wide desktops. Use when building page layouts, navigation, tables, grids or anything that has to fit a small screen. Triggers: responsive, mobile, tablet, desktop, breakpoint, media query, fluid, grid, flexbox, viewport, small screen, adapt, mobile-first, overflow"#,
    body: r#"Every screen should work from a 360px phone to a 1440px desktop and wider.

## Layout
- Build mobile-first: one column by default, with more columns added through `min-width` media queries or container queries.
- Use flexbox and grid with `fr`, `minmax()`, `auto-fit` and `clamp()` instead of fixed pixel widths. Cap content width on large screens so lines and cards don't stretch.
- Use the project's breakpoints. If it has none, use about 640, 1024 and 1280px.

## Content
- Nothing scrolls sideways: long words and URLs wrap, images and media use `max-width: 100%`, and wide tables scroll inside their own container or become stacked cards on phones.
- On small screens, fold secondary navigation into a menu and keep the main action in reach.
- Size text in `rem`, with body text at least 16px on phones.

## Touch
- Tap targets are at least 44 by 44px with space between them. Don't hide essential actions behind hover.
- Use the right input types (`email`, `tel`, `number`, `date`) so phones show the right keyboard.

## Before you finish
- Review each changed screen at 360, 768 and 1280px: no sideways scrolling, nothing clipped or overlapping, and the main action stays visible."#,
  },
  SkillDef {
    id: "easy-navigation",
    title: "Easy navigation",
    description: "Clear menus and page titles, and links you can share.",
    icon: "🧭",
    category: EXPERIENCE,
    version: "1.0.0",
    trigger: r#"Make the app easy to find your way around. Use when adding pages or routes, menus, tabs, sidebars or breadcrumbs, or when people get lost or can't get back. Triggers: navigation, nav, menu, sidebar, tabs, routes, routing, pages, breadcrumbs, back button, deep link, URL, header, information architecture, where am I"#,
    body: r#"People should always know where they are, what they can do next and how to get back.

## Structure
- Keep top-level destinations few (about 3 to 7), named for what people do or find there rather than for internal concepts.
- Use one navigation pattern throughout: a top bar or sidebar on desktop that folds into a menu or bottom bar on phones.
- Mark the current destination clearly, with styling and `aria-current="page"`.

## Pages
- Every page has a clear title (also set `document.title`) and one obvious main action.
- Detail pages link back to their list. Add breadcrumbs when content is more than two levels deep.

## URLs
- Each meaningful view has its own URL, including the selected item, tab, search and filters, so links can be shared and the browser's back button works. Use the project's router rather than switching views with state alone.
- Unknown URLs show a friendly not-found page that links home.
- Coming back restores what people left: scroll position, filters and the selected tab, where it helps.

## Avoid
- Key destinations hidden behind unlabeled icons, or menus nested more than one level.
- Navigation that changes from page to page or jumps around while content loads.

## Before you finish
- Review: every route is reachable from the navigation or a clear link, the current location is highlighted, and reloading a page keeps you on the same view."#,
  },
  SkillDef {
    id: "clear-copy",
    title: "Clear, friendly wording",
    description: "Plain-language labels, buttons, messages and empty states.",
    icon: "💬",
    category: EXPERIENCE,
    version: "1.0.0",
    trigger: r#"Write the app's words in plain, friendly and consistent language. Use when writing or changing labels, buttons, headings, help text, empty states, confirmations, notifications or error messages. Triggers: copy, wording, text, microcopy, labels, button text, error message, empty state, tone, voice, help text, placeholder, confirmation, terminology"#,
    body: r#"Words are most of the interface. Keep them short, specific and kind.

## Voice
- Plain language that a 13-year-old could follow. Talk to the user as "you".
- Use the user's own words for things, and use each term the same way everywhere ("Projects" never turns into "Workspaces").
- Sentence case for headings, labels and buttons. No exclamation marks in errors and no jokes when something went wrong.

## Buttons and labels
- Buttons say what happens, starting with a verb: "Save changes", "Create invoice", "Delete 3 files". Avoid "OK", "Submit" and "Yes" when the action has a name.
- Labels are short nouns ("Email", "Due date"). Put formats and examples in hint text below the field, not in placeholders.

## Messages
- Errors say what happened and how to fix it, in a sentence or two: "That date has passed. Pick today or a later date." Never show raw error codes or stack traces; log them instead.
- Confirmations name the thing and the outcome: "Delete “Q3 budget”? You can't undo this."
- Success messages are brief, and only shown when the result isn't already visible.
- Empty states say what will appear and offer the first step: "No invoices yet. Create your first invoice."

## Avoid
- Jargon and internal names in the UI: IDs, null, 500, API, database table names.
- Long paragraphs. Lead with the point and cut words that don't change the meaning.

## Before you finish
- Reread every new or changed string: it's specific, matches the app's other terms, and tells people what to do next."#,
  },
  SkillDef {
    id: "loading-empty-states",
    title: "Loading & empty states",
    description: "Every screen handles loading, empty, error and success.",
    icon: "⏳",
    category: EXPERIENCE,
    version: "2.0.0",
    trigger: r#"Handle every state of async data: loading, empty, error and success. Use when fetching or saving data, showing lists, or adding retries, skeletons or optimistic updates. Triggers: loading, spinner, skeleton, empty state, error state, retry, placeholder, no data, fetching, async, optimistic update, offline, saving"#,
    body: r#"Design every data-driven view for all of its states, not only the happy path.

## The four states
- **Loading:** skeletons shaped like the content for pages and lists; a small spinner only for short local waits, such as inside a button. Wait about 300ms before showing a loader so fast responses don't flicker.
- **Empty:** say what will appear here and offer the first action. Tell "nothing yet" apart from "no results for this filter", and offer to clear the filter.
- **Error:** say what failed in plain words, keep whatever already loaded on screen, and offer "Try again". Details go to the console, not the user.
- **Success:** show the result in place, with a brief confirmation only when the change isn't visible.

## Saving
- While a save is in flight, disable its button and show progress ("Saving…") so nothing is sent twice.
- Use optimistic updates for quick, reversible actions such as toggling, renaming or reordering, and roll back with a message if the save fails.
- Keep what the user typed when a save fails.

## Rayfin data
- Reads and writes can fail when a session expires or the connection drops, so handle errors on every call.
- A collection read returns one page (100 records by default). Lists that can grow page through their results, as the `rayfin` skill describes, so they're never silently cut short.

## Before you finish
- Review each view that loads or saves data: loading, empty, error and success are all covered, and no button can be pressed twice while saving."#,
  },
  SkillDef {
    id: "friendly-forms",
    title: "Friendly forms & validation",
    description: "Forms that guide people, check input early and never lose it.",
    icon: "📝",
    category: EXPERIENCE,
    version: "2.0.0",
    trigger: r#"Build forms that are quick to fill in and forgiving. Use when building forms, inputs, editors or any data entry, and when adding validation or error messages. Triggers: form, input, validation, error message, required field, submit, field, placeholder, autofocus, helper text, data entry, edit form, create form, wizard"#,
    body: r#"Forms should be quick to fill in, hard to get wrong and impossible to lose.

## Layout
- One column, labels above fields, and related fields grouped under short headings. Ask only for what's needed now.
- Every field has a visible `<label>`. Mark the few optional fields "(optional)" instead of starring every required one.
- Use the right control: `type="email"`, `tel`, `number` or `date`, a select or radio buttons for a short fixed list, a checkbox or switch for yes or no.
- Prefill sensible defaults and focus the first field when the form opens.

## Validation
- Check a field when the user leaves it and the whole form on submit. Clear an error as soon as it's fixed.
- Show each error next to its field, linked with `aria-describedby`, and move focus to the first invalid field on submit.
- Messages explain the fix: "Enter an email like name@example.com", not "Invalid input".
- Validate with the same rules as the data model. For Rayfin entities, build the validator from the entity with `toStandardSchema` and read limits for hints with `getFieldConstraints` (both from `@microsoft/rayfin-core`) instead of repeating the rules.

## Submitting
- Disable the submit button and show progress while saving. If saving fails, keep everything the user typed and say what to do next.
- After success, say so or take the user to the result. Warn before leaving a form with unsaved changes.

## Before you finish
- Review: the form works with only a keyboard, errors are announced and fixable, and nothing typed is lost after an error."#,
  },
  SkillDef {
    id: "data-modeling",
    title: "Solid data modeling",
    description: "Well-shaped Rayfin entities, relationships and queries.",
    icon: "🗃️",
    category: DATA,
    version: "2.1.0",
    trigger: r#"Design the app's data as well-shaped Rayfin entities with clear relationships, ownership and efficient queries. Use when adding or changing entities, fields, relationships or queries. Triggers: data model, schema, entity, table, field, relationship, foreign key, query, Rayfin data, migration, normalization, one-to-many, many-to-many, schema.ts, rayfin/data, packages/data"#,
    body: r#"The app's data lives in Rayfin: decorated entity classes registered in the app's schema. Most apps keep them in `rayfin/data/`, registered in `rayfin/data/schema.ts`. When `rayfin/rayfin.yml` names a data package (`services.data.path`, such as `packages/data`), they live in that package's `src/` and are registered in its `src/index.ts`. Follow the `rayfin` skill for the exact decorators and client calls; this skill covers the design.

## Entities
- One entity per real thing the app tracks (Project, Task, Comment), named with a singular noun. Fields are camelCase with clear names and the narrowest type that fits: `@int`, `@decimal`, `@boolean`, `@date`, `@email`, or `@set` for a fixed list of values.
- Give every `@text()` field a `max` length. Make a field optional only when a missing value means something.
- Add `createdAt` and `updatedAt` to records people edit, and an owner field (such as `user_id`) to records that belong to someone.
- Register every new entity in the schema file, and use `.js` extensions in relative imports between entity files.

## Relationships
- Use `@one()` and `@many()` instead of copying data between entities or storing lists in text fields.
- Many-to-many isn't supported. Model it as a join entity with two `@one()` relationships, such as ProjectMember between Project and Member.
- Declare foreign key fields only when the code needs them, named `{property}_id`.

## Access
- Decide who can read and change each entity when you create it, and express that as role rules with a row-level policy. The "Secure by default" skill covers this in depth.

## Queries
- Select only the fields a screen shows. Filter and sort in the query with `where` and `orderBy`, not in the browser.
- A collection read returns one page (100 records by default), so page through anything that can grow.
- There's no `count()`. Keep counted lists small, or store a running total when a count is needed often.

## Changing the model
- Prefer adding fields to renaming or removing them. Renames and removals can delete data in the deployed app, so call them out in your summary.

## Before you finish
- Review: every entity is registered, every text field has a `max`, relationships use `@one` and `@many`, and every list query is bounded or paged."#,
  },
  SkillDef {
    id: "search-and-filter",
    title: "Search, sort & filter",
    description: "Find records fast in long lists, with filtering done in the query.",
    icon: "🔎",
    category: DATA,
    version: "1.0.0",
    trigger: r#"Help people find records in long lists with search, filters, sorting and paging. Use when building lists, tables, directories or any screen with more than a handful of records. Triggers: search, filter, sort, sorting, list, table, data grid, pagination, paging, load more, infinite scroll, find, lookup, facets"#,
    body: r#"Long lists need a fast way to find things. Do the work in the query, not in the browser.

## Search and filters
- Put a search box above any list that can grow past about 20 items. Wait about 300ms after typing stops before querying (debounce), and keep the previous results on screen until new ones arrive.
- Offer filters only for the fields people actually narrow by, such as status, owner or a date range. Show active filters as removable chips with "Clear all".
- Filter and sort in the Rayfin query with `where` and `orderBy`, so results are correct across every page.
- Keep the search, filters, sort and page in the URL, so a view can be shared and survives a reload.

## Sorting
- Default to the most useful order, often newest first or due soonest. Let people sort table columns, and show the current sort and its direction.
- Keep the order stable (add `id` as a tie-breaker) so paging never skips or repeats records.

## Paging
- A Rayfin collection read returns one page (100 records by default). Page with `first`, `after` and `executePaginated`, as the `rayfin` skill describes, behind "Load more" or infinite scroll.
- Don't promise totals you don't have. There's no `count()`, so say "Showing 50" rather than "50 of 1,204".

## Results
- Highlight what matched and keep the number shown visible. "No results" gets its own message with a way to clear the search.

## Before you finish
- Review: searching and filtering never download the whole table, the URL restores the same view, and an empty result explains how to widen the search."#,
  },
  SkillDef {
    id: "data-viz",
    title: "Beautiful charts & dashboards",
    description: "The right chart for each question, with the key numbers first.",
    icon: "📊",
    category: DATA,
    version: "2.0.0",
    trigger: r#"Present data clearly with the right charts, KPI cards and dashboard layout. Use when adding charts, graphs, metrics, summaries or dashboards. Triggers: chart, graph, dashboard, visualization, KPI, metric, line chart, bar chart, donut, analytics, summary card, data viz, trends, report"#,
    body: r#"Charts answer questions. Start from the question, then pick the chart.

## Fit the project
- If the project already has a charting library or a visuals skill (such as `graphein-visuals` or `visuals`), use it and follow that skill for the mechanics. This skill covers what to show and how to lay it out.

## Choose the chart
- Change over time: line or area. Comparing categories: bars sorted by value, horizontal when labels are long. Parts of a whole: a stacked bar, or a donut with five slices or fewer. Relationships: scatter. Exact values: a table.
- Avoid 3D, dual axes, and pies with many slices.

## Dashboards
- Lead with three to five headline numbers (KPI cards): the value, a label, and the change against a clear comparison ("+12% vs last month").
- Supporting charts follow, the most important first, on a simple grid that stacks on small screens.
- Every chart has a title that states the question or the takeaway, with units in the labels.

## Readability
- Bar axes start at zero. Use few gridlines, readable ticks and formatted numbers (1.2K, $3.4M, 12%).
- One accent color for the main series and muted colors for the rest. Don't rely on color alone: label series directly where you can.
- Tooltips show exact values, and each chart has a text summary or table view for screen readers.

## Data
- Fetch only the fields and records a chart needs. Rayfin reads return one page at a time, so page through larger sets before aggregating, and compute aggregates once (memoized), not on every render.
- Every chart has loading, empty ("No sales yet this month") and error states.

## Before you finish
- Review each chart: it answers a clear question, its numbers are formatted, and it works in light and dark themes and on small screens."#,
  },
  SkillDef {
    id: "accessibility",
    title: "Accessible to everyone",
    description: "Works with a keyboard and screen readers, with readable contrast.",
    icon: "♿",
    category: QUALITY,
    version: "2.0.0",
    trigger: r#"Make the app usable by everyone, including keyboard and screen-reader users. Use when building any UI, especially forms, dialogs, menus, custom controls, icons, images and color choices. Triggers: accessibility, a11y, screen reader, keyboard, focus, aria, contrast, WCAG, semantic HTML, alt text, tab order, accessible, color blind"#,
    body: r#"Aim for WCAG 2.2 AA. Most of it comes from using the right HTML.

## Structure
- Use semantic elements: `button` for actions, `a` for navigation, `nav`, `main`, `header` and `footer` for regions, and real lists and tables.
- One `h1` per page, with headings in order. Set the page `lang` and a meaningful title.

## Keyboard
- Everything that works with a mouse works with a keyboard, in a logical tab order. Never remove focus outlines without a clear `:focus-visible` style.
- Dialogs move focus inside, keep it there, close on Escape and return focus to what opened them. Menus and tabs support the arrow keys.
- Add a "Skip to content" link when navigation comes before the main content.

## Screen readers
- Every input has a label, every icon-only button has an `aria-label`, and meaningful images have `alt` text (decorative ones use `alt=""`).
- Announce changes that happen out of view (saved, failed, results updated) through an `aria-live` region.
- Prefer native elements to ARIA. A custom control needs the right role, name and state (`aria-expanded`, `aria-selected`, `aria-checked`).

## Visuals
- Contrast of at least 4.5:1 for text, and 3:1 for large text, icons and input borders, in both themes.
- Never use color alone to carry meaning: add text or an icon.
- Text can grow to 200% without breaking the layout. Targets are at least 24 by 24px (44px on touch screens).
- Respect `prefers-reduced-motion`.

## Before you finish
- Review each changed screen: it can be completed with only a keyboard, every control has an accessible name, and status changes and errors are announced."#,
  },
  SkillDef {
    id: "secure-by-default",
    title: "Secure by default",
    description: "Per-user data rules, signed-in pages and no secrets in the browser.",
    icon: "🔒",
    category: QUALITY,
    version: "1.0.0",
    trigger: r#"Keep the app's data and users safe by default. Use when adding sign-in, entities, permissions, sharing or admin features, or anything that reads or writes people's data. Triggers: security, secure, permissions, access control, row-level security, RLS, policy, private data, owner, sign in, authentication, authorization, secrets, API key, admin, sharing, roles"#,
    body: r#"Assume any request can come from anyone. The browser can't enforce security; Rayfin's data rules can.

## Data access
- Give every entity explicit role rules. Start closed: grant `@authenticated()` access with a row-level policy, and add `@anonymous()` access only for data that's meant to be public. Follow the `rayfin` skill for the exact syntax.
- For per-user data, store the owner (such as `user_id`) and scope reads and writes with a policy like `claims.sub.eq(item.user_id)`. Policies can use the `sub`, `email` and `role` claims.
- Hide sensitive fields from roles that don't need them with `exclude`.
- Hiding a button or a page isn't protection. Anything the UI prevents must also be prevented by a policy.

## Sign-in
- Pages that show or change personal data require sign-in. Gate them on the session and show a friendly sign-in prompt instead of an empty page.
- Use Rayfin auth; never build your own password storage or tokens. Deployed Fabric apps sign people in with Microsoft Entra ID.
- Never trust identity sent from the browser, such as a user id, email or role in a form field. Rely on the claims in the session.

## Secrets
- Anything in frontend code, `VITE_` variables or the repository is public. Keys belong on the server: Rayfin functions can read secrets set with `npx rayfin secret set` (functions aren't available in every Fabric region or tenant).

## Input and output
- Validate input against the data model. Render user content as text; never inject it as HTML (`dangerouslySetInnerHTML`, `innerHTML`) without sanitizing it.
- Show friendly errors, and keep stack traces and internal details out of the UI.

## Before you finish
- Review every entity you touched: who can read, create, update and delete it, and whether a signed-in user could reach someone else's records."#,
  },
  SkillDef {
    id: "performance",
    title: "Fast & snappy",
    description: "Quick to load and smooth to use as the app grows.",
    icon: "⚡",
    category: QUALITY,
    version: "2.0.0",
    trigger: r#"Keep the app fast to load and smooth to use as data and features grow. Use when the app feels slow, lists get long, pages load a lot of data, or when adding heavy libraries, images or charts. Triggers: performance, speed, fast, slow, bundle size, lazy load, code splitting, memoization, re-render, cache, debounce, throttle, virtualization, optimize, images"#,
    body: r#"Fast apps load little, fetch little and render little.

## Loading
- Split code by route, and lazy-load heavy or rarely used parts (editors, charts, maps, dialogs) with dynamic `import()` and `React.lazy`.
- Weigh what a new dependency adds before installing it. Prefer small libraries or what the platform offers (`Intl`, `fetch`, CSS).
- Size images for where they're shown, use modern formats, lazy-load images below the fold, and set width and height to prevent layout shifts.

## Data
- Fetch only the fields and records a view needs, filtering and sorting in the query. Page through long lists instead of loading everything.
- Run independent requests in parallel, reuse data you already have, and refresh in the background where that's safe.
- Debounce search and other rapid input (about 300ms), and throttle scroll and resize handlers.

## Rendering
- Keep state close to where it's used so updates re-render less. Memoize expensive calculations and callbacks passed to large lists.
- Virtualize lists and tables longer than a few hundred rows.
- Prefer CSS for animation and layout over measuring elements in JavaScript.

## Avoid
- One request per row, chains of requests that wait on each other, and work during render that could happen once.

## Before you finish
- Review your changes for the biggest costs first: the number and size of requests, what's added to the bundle, and how many items render at once."#,
  },
];

/// The CLI-managed (locked) skills Fabricator knows, in display order.
const MANAGED_ORDER: &[&str] = &["rayfin", "rayfin-functions", "rayfin-connectors", "rayfin-storage"];

/// Friendly presentation for known CLI-managed (locked) skills found on disk.
fn managed_presentation(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
  match id {
    "rayfin" => Some((
      "Rayfin essentials",
      "Core Rayfin knowledge: data models, sign-in, deploys and the CLI.",
      "◆",
    )),
    "rayfin-functions" => Some(("Rayfin Functions", "Server-side functions your app can call.", "λ")),
    "rayfin-connectors" => Some((
      "Rayfin Connectors",
      "Use existing Fabric data: lakehouses, warehouses, SQL databases, semantic models and KQL.",
      "⇄",
    )),
    "rayfin-storage" => Some(("Rayfin Storage", "File storage for your app. Experimental.", "▤")),
    _ => None,
  }
}

/// The Fabricator operating contract written to `.github/copilot-instructions.md`.
const AGENT_INSTRUCTIONS: &str = r#"# Fabricator — agent guidance

This is a **Rayfin app** (a Microsoft Fabric Backend-as-a-Service app). You are the
coding agent running inside **Fabricator**, a desktop app that drives you plus the
Rayfin CLI to build and deploy this app.

## Rules
- **Make the requested code changes only.** Edit files to implement what the user asks.
- **Do NOT run `rayfin up` or otherwise deploy**, even when the user, `AGENTS.md` or a skill
  (such as `app-deployment` or `rayfin`) says to deploy. Fabricator runs the full `rayfin up`
  automatically after your changes and shows the deployed app in its preview, so don't ask the
  user which workspace to deploy to either.
- Do **not** start dev servers or run the app locally — it is only ever run via deploy.
- Keep the project building; prefer small, correct changes.
- Only use what Rayfin natively provides (data, auth, file storage, functions, static
  hosting). Do **not** add external services like payment processors or email senders.
- Detailed Rayfin SDK/CLI guidance lives in the `rayfin` skill (`.agents/skills/rayfin`);
  additional enabled skills live alongside it under `.agents/skills/`.

When you finish editing, briefly summarize what you changed — Fabricator handles the deploy.
"#;

const GENERATED_MARKER: &str = "Generated by Rayfin Fabricator";

fn skills_root(dir: &str) -> PathBuf {
  Path::new(dir).join(".agents").join("skills")
}

fn skill_dir(dir: &str, id: &str) -> PathBuf {
  skills_root(dir).join(id)
}

fn catalog_by_id(id: &str) -> Option<&'static SkillDef> {
  CATALOG.iter().find(|s| s.id == id)
}

/// True when `id` is reserved by a built-in catalog add-on or a known
/// CLI-managed skill, and therefore can't be used for a custom library skill.
pub(crate) fn is_reserved_id(id: &str) -> bool {
  CATALOG.iter().any(|s| s.id == id) || MANAGED_ORDER.contains(&id)
}

/// The block between the leading `---` fences (BOM-tolerant).
static FM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---").unwrap());

/// Extract the YAML block between the leading `---` fences.
fn frontmatter(raw: &str) -> Option<&str> {
  let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
  FM_RE.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str())
}

/// The markdown after the frontmatter.
fn skill_body(raw: &str) -> &str {
  let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
  match FM_RE.find(text) {
    Some(m) => &text[m.end()..],
    None => text,
  }
}

/// True when a SKILL.md is CLI-managed (`rayfin-managed: true` sigil).
fn is_managed(raw: &str) -> bool {
  static MANAGED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*rayfin-managed:\s*true\s*$").unwrap());
  frontmatter(raw)
    .map(|fm| MANAGED_RE.is_match(fm))
    .unwrap_or(false)
}

/// Names Fabricator has stamped catalog copies with (before and after the rename).
const FABRICATOR_AUTHORS: &[&str] = &["Fabricator", "Rayfin Fabricator"];

/// Build a SKILL.md file body for one of our add-on skills.
fn render_skill_file(def: &SkillDef) -> String {
  // Kept inside a double-quoted YAML string.
  let description = def.trigger.replace('\\', "\\\\").replace('"', "'");
  format!(
    "---\nname: {id}\ndescription: \"{description}\"\nmetadata:\n  author: {author}\n  version: {version}\n---\n# {title}\n\n{body}\n",
    id = def.id,
    description = description,
    author = FABRICATOR_AUTHORS[0],
    version = def.version,
    title = def.title,
    body = def.body.trim(),
  )
}

#[derive(Deserialize, Default)]
struct SkillFrontmatter {
  #[serde(default)]
  description: Option<String>,
  #[serde(default)]
  metadata: Option<SkillMetadata>,
}

#[derive(Deserialize, Default)]
struct SkillMetadata {
  #[serde(default)]
  author: Option<serde_yaml::Value>,
  #[serde(default)]
  version: Option<serde_yaml::Value>,
}

/// A YAML scalar as text (`version: 2` and `version: "2.0.0"` both count).
fn yaml_text(value: &serde_yaml::Value) -> Option<String> {
  let text = match value {
    serde_yaml::Value::String(s) => s.trim().to_string(),
    serde_yaml::Value::Number(n) => n.to_string(),
    _ => return None,
  };
  (!text.is_empty()).then_some(text)
}

/// What an installed `SKILL.md` says about itself.
#[derive(Clone, Default)]
struct OnDisk {
  /// CLI-managed (`rayfin-managed: true`).
  managed: bool,
  /// A catalog copy Fabricator wrote (`metadata.author`).
  fabricator: bool,
  /// `metadata.version`.
  version: Option<String>,
  /// The first `# ` heading of the body.
  heading: Option<String>,
  /// The frontmatter `description`.
  description: Option<String>,
}

fn read_skill(raw: &str) -> OnDisk {
  let parsed: SkillFrontmatter = frontmatter(raw)
    .and_then(|fm| serde_yaml::from_str(fm).ok())
    .unwrap_or_default();
  let metadata = parsed.metadata.unwrap_or_default();
  let author = metadata.author.as_ref().and_then(yaml_text);
  OnDisk {
    managed: is_managed(raw),
    fabricator: author.as_deref().is_some_and(|a| FABRICATOR_AUTHORS.contains(&a)),
    version: metadata.version.as_ref().and_then(yaml_text),
    heading: first_heading(skill_body(raw)),
    description: parsed.description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()),
  }
}

/// The text of the first `# ` heading outside code fences.
fn first_heading(body: &str) -> Option<String> {
  let mut fenced = false;
  for line in body.lines() {
    let line = line.trim();
    if line.starts_with("```") || line.starts_with("~~~") {
      fenced = !fenced;
    } else if !fenced {
      if let Some(heading) = line.strip_prefix("# ") {
        let heading = heading.trim();
        if !heading.is_empty() {
          return Some(heading.to_string());
        }
      }
    }
  }
  None
}

/// A short card title from a heading: "Build Workflow — Ship fast" → "Build Workflow".
fn heading_title(heading: &str) -> Option<String> {
  let plain: String = heading.chars().filter(|c| *c != '`' && *c != '*').collect();
  let short = [" — ", " – ", " - ", ": "]
    .iter()
    .fold(plain.as_str(), |text, sep| text.split(sep).next().unwrap_or(text))
    .trim();
  (2..=48).contains(&short.chars().count()).then(|| short.to_string())
}

/// `text` cut to `max` characters, with an ellipsis when cut.
fn clip(text: &str, max: usize) -> String {
  if text.chars().count() <= max {
    return text.to_string();
  }
  let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
  out = out.trim_end().to_string();
  out.push('…');
  out
}

/// A one-line card summary from a skill's description: its first sentence,
/// without any trigger list.
fn summary(description: &str) -> Option<String> {
  static TRIGGERS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\btriggers?:").unwrap());
  static SENTENCE_END: Lazy<Regex> = Lazy::new(|| Regex::new(r#"[.!?](\s+[A-Z"'`(“]|$)"#).unwrap());
  let flat = description.split_whitespace().collect::<Vec<_>>().join(" ");
  let lead = TRIGGERS.find(&flat).map_or(flat.as_str(), |m| &flat[..m.start()]).trim();
  let first = SENTENCE_END.find(lead).map_or(lead, |m| &lead[..=m.start()]).trim();
  (!first.is_empty()).then(|| clip(first, 160))
}

/// Card title and summary for a `SKILL.md` without a `meta.json`: its heading
/// (else the title-cased id) and the first sentence of its description.
pub(crate) fn derived_presentation(raw: &str, id: &str) -> (String, Option<String>) {
  let disk = read_skill(raw);
  let title = disk.heading.as_deref().and_then(heading_title).unwrap_or_else(|| title_case(id));
  (title, disk.description.as_deref().and_then(summary))
}

/// `a < b` for dotted versions such as `1.0.0` (missing or odd parts count as 0).
fn version_lt(a: &str, b: &str) -> bool {
  let parts = |v: &str| -> Vec<u64> {
    v.trim()
      .trim_start_matches('v')
      .split('.')
      .map(|p| p.trim().parse().unwrap_or(0))
      .collect()
  };
  let (a, b) = (parts(a), parts(b));
  for i in 0..a.len().max(b.len()) {
    let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
    if x != y {
      return x < y;
    }
  }
  false
}

/// Read installed skills: id → what each `.agents/skills/<id>/SKILL.md` says.
fn read_installed(dir: &str) -> BTreeMap<String, OnDisk> {
  let mut out = BTreeMap::new();
  let root = skills_root(dir);
  let entries = match std::fs::read_dir(&root) {
    Ok(e) => e,
    Err(_) => return out,
  };
  for entry in entries.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    let file = root.join(&name).join("SKILL.md");
    if let Ok(raw) = std::fs::read_to_string(&file) {
      out.insert(name, read_skill(&raw));
    }
  }
  out
}

/// Title-case a bare skill id for an unknown custom skill (`my_skill` → `My Skill`).
pub(crate) fn title_case(id: &str) -> String {
  let spaced: String = id
    .chars()
    .map(|c| if c == '-' || c == '_' { ' ' } else { c })
    .collect();
  spaced
    .split(' ')
    .map(|word| {
      let mut chars = word.chars();
      match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

/// Card presentation (title, description, icon) for a skill installed in the
/// project that isn't a catalog copy: its `meta.json` (skills added through
/// Fabricator), a known Rayfin presentation, else what its `SKILL.md` says.
fn installed_presentation(dir: &str, id: &str, disk: Option<&OnDisk>) -> (String, String, String) {
  if let Some(presentation) = crate::commands::custom_skills::project_skill_presentation(dir, id) {
    return presentation;
  }
  if let Some((t, d, i)) = managed_presentation(id) {
    return (t.to_string(), d.to_string(), i.to_string());
  }
  let title = disk
    .and_then(|d| d.heading.as_deref())
    .and_then(heading_title)
    .unwrap_or_else(|| title_case(id));
  let description = disk
    .and_then(|d| d.description.as_deref())
    .and_then(summary)
    .unwrap_or_else(|| "A skill in this app.".to_string());
  (title, description, "🧩".to_string())
}

/// The name a skill goes by in History's commit messages. `def` is the catalog
/// skill the id refers to here (see [`catalog_target`]).
fn display_title(dir: &str, id: &str, disk: Option<&OnDisk>, def: Option<&SkillDef>) -> String {
  if let Some(def) = def {
    return def.title.to_string();
  }
  if let Some(title) = crate::commands::custom_skills::library_title(id) {
    return title;
  }
  installed_presentation(dir, id, disk).0
}

/// The built-in skill `id` refers to in this app, if any. What's installed decides:
/// a folder Fabricator didn't write (a template's own `data-modeling`, say) is a
/// different skill. With nothing installed, a library skill that already uses the
/// name wins: it was the user's before Fabricator shipped a skill called that.
fn catalog_target(id: &str, on_disk: Option<&OnDisk>, in_library: bool) -> Option<&'static SkillDef> {
  let def = catalog_by_id(id)?;
  match on_disk {
    Some(disk) => disk.fabricator.then_some(def),
    None => (!in_library).then_some(def),
  }
}

/// Compose the project's skill list: locked managed skills, catalog add-ons, then extras.
fn build_list(dir: &str) -> Vec<SkillInfo> {
  build_list_with(dir, crate::commands::custom_skills::list_library())
}

/// Core of [`build_list`], with the global custom-skill `library` injected so it
/// can be exercised deterministically in tests.
fn build_list_with(dir: &str, library: Vec<CustomSkillInfo>) -> Vec<SkillInfo> {
  let installed = read_installed(dir);
  let library_ids: HashSet<String> = library.iter().map(|lib| lib.id.clone()).collect();
  let mut list: Vec<SkillInfo> = Vec::new();
  let mut used: HashSet<String> = HashSet::new();

  // 1) CLI-managed (locked) skills first, in a stable, friendly order.
  let mut managed_ids: Vec<&String> = MANAGED_ORDER
    .iter()
    .filter_map(|id| installed.get_key_value(*id).filter(|(_, d)| d.managed).map(|(k, _)| k))
    .collect();
  managed_ids.extend(
    installed
      .iter()
      .filter(|(id, d)| d.managed && !MANAGED_ORDER.contains(&id.as_str()))
      .map(|(id, _)| id),
  );
  for id in managed_ids {
    let (title, description, icon) = installed_presentation(dir, id, installed.get(id));
    list.push(SkillInfo {
      id: id.clone(),
      title,
      description,
      icon,
      base: true,
      active: true,
      category: None,
      custom: None,
      library: None,
      outdated: None,
      promotable: None,
    });
    used.insert(id.clone());
  }

  // 2) Our curated add-on catalog, active when Fabricator's copy is installed.
  //    A same-named skill Fabricator didn't write is listed with the library or
  //    the app's skills below instead (see `catalog_target`).
  for def in CATALOG {
    if used.contains(def.id) {
      continue;
    }
    let on_disk = installed.get(def.id);
    if catalog_target(def.id, on_disk, library_ids.contains(def.id)).is_none() {
      continue;
    }
    let outdated = on_disk.is_some_and(|d| version_lt(d.version.as_deref().unwrap_or("0"), def.version));
    list.push(SkillInfo {
      id: def.id.to_string(),
      title: def.title.to_string(),
      description: def.description.to_string(),
      icon: def.icon.to_string(),
      category: Some(def.category.to_string()),
      base: false,
      active: on_disk.is_some(),
      custom: None,
      library: None,
      outdated: outdated.then_some(true),
      promotable: None,
    });
    used.insert(def.id.to_string());
  }

  // 3) Global custom-skill library — reusable skills the user can toggle into
  //    this project. Active when a copy is installed under `.agents/skills/`.
  for lib in library {
    if used.contains(&lib.id) {
      continue;
    }
    let on_disk = installed.get(&lib.id);
    if on_disk.map(|d| d.managed).unwrap_or(false) {
      continue;
    }
    list.push(SkillInfo {
      id: lib.id.clone(),
      title: lib.title,
      description: lib.description,
      icon: lib.icon,
      base: false,
      active: on_disk.is_some(),
      category: None,
      custom: Some(true),
      library: Some(true),
      outdated: None,
      promotable: None,
    });
    used.insert(lib.id);
  }

  // 4) Any other installed unmanaged skills not in the catalog or library
  //    (e.g. a template's skills, skills added to just this app, or ones the
  //    agent wrote directly).
  for (id, d) in &installed {
    if used.contains(id) || d.managed {
      continue;
    }
    let (title, description, icon) = installed_presentation(dir, id, Some(d));
    list.push(SkillInfo {
      id: id.clone(),
      title,
      description,
      icon,
      base: false,
      active: true,
      category: None,
      custom: Some(true),
      library: None,
      outdated: None,
      promotable: crate::commands::custom_skills::can_save_to_library(id).then_some(true),
    });
  }

  list
}

fn write_skill_file(dir: &str, def: &SkillDef) -> std::io::Result<()> {
  let target = skill_dir(dir, def.id);
  std::fs::create_dir_all(&target)?;
  std::fs::write(target.join("SKILL.md"), render_skill_file(def))
}

#[derive(Deserialize)]
struct LegacyManifest {
  #[serde(default)]
  active: Option<Vec<String>>,
}

/// Ensure the Fabricator operating contract exists and clean up artifacts from the
/// earlier (manifest-based) skills implementation. Best-effort; called on scaffold/open.
pub fn ensure_project_skills(dir: &str) {
  let _ = ensure_agent_instructions(dir);
  let _ = migrate_legacy_manifest(dir);
}

/// Write `.github/copilot-instructions.md`, healing the old generated variant.
fn ensure_agent_instructions(dir: &str) -> std::io::Result<()> {
  let file = Path::new(dir).join(".github").join("copilot-instructions.md");
  if let Ok(existing) = std::fs::read_to_string(&file) {
    // Keep a user-authored or new-style file; only overwrite the old generated one.
    if !existing.contains(GENERATED_MARKER) {
      return Ok(());
    }
  }
  let gh_dir = Path::new(dir).join(".github");
  std::fs::create_dir_all(&gh_dir)?;
  std::fs::write(&file, AGENT_INSTRUCTIONS)
}

/// Migrate the earlier `.github/rayfin-skills.json` manifest into on-disk skills,
/// then remove the stray manifest.
fn migrate_legacy_manifest(dir: &str) -> std::io::Result<()> {
  let manifest = Path::new(dir).join(".github").join("rayfin-skills.json");
  let raw = match std::fs::read_to_string(&manifest) {
    Ok(r) => r,
    Err(_) => return Ok(()),
  };
  if let Ok(parsed) = serde_json::from_str::<LegacyManifest>(&raw) {
    let installed = read_installed(dir);
    for id in parsed.active.unwrap_or_default() {
      if let Some(def) = catalog_by_id(&id) {
        if !installed.contains_key(&id) {
          let _ = write_skill_file(dir, def);
        }
      }
    }
  }
  let _ = std::fs::remove_file(&manifest);
  Ok(())
}

fn git_opts(dir: &str, ms: u64) -> exec::RunOptions {
  exec::RunOptions {
    cwd: Some(PathBuf::from(dir)),
    timeout_ms: Some(ms),
    ..Default::default()
  }
}

/// Ensure a local git identity exists so commits don't fail on a fresh machine.
async fn ensure_git_identity(dir: &str) {
  let email = git::run(&["config", "user.email"], git_opts(dir, 15_000)).await;
  if email.stdout.trim().is_empty() {
    let _ = git::run(&["config", "user.email", "fabricator@rayfin.local"], git_opts(dir, 15_000)).await;
    let _ = git::run(&["config", "user.name", "Fabricator"], git_opts(dir, 15_000)).await;
  }
}

/// Stage and commit just one skill's `.agents/skills/<id>` folder (best-effort) so
/// the change shows up in History. Shared by the catalog toggle and the
/// custom-skill library (see [`crate::commands::custom_skills`]).
pub(crate) async fn commit_skill_change(dir: &str, skill_id: &str, message: &str) {
  let rel = format!(".agents/skills/{skill_id}");
  commit_paths(dir, &[rel.as_str()], message).await;
}

/// Stage and commit only `paths` (relative to `dir`), best-effort, so a change
/// Fabricator made shows up in History without sweeping in anything else.
pub(crate) async fn commit_paths(dir: &str, paths: &[&str], message: &str) {
  if paths.is_empty() {
    return;
  }
  ensure_git_identity(dir).await;
  let mut add = vec!["add", "-A", "--"];
  add.extend_from_slice(paths);
  let _ = git::run(&add, git_opts(dir, 30_000)).await;
  let mut commit = vec!["commit", "-m", message, "--"];
  commit.extend_from_slice(paths);
  let _ = git::run(&commit, git_opts(dir, 30_000)).await;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// The project's skill list (locked managed skills + add-on catalog + extras).
#[tauri::command]
pub fn skills_list(id: String) -> Vec<SkillInfo> {
  match store::find_project(&id) {
    Some(project) => build_list(&project.path),
    None => vec![],
  }
}

/// Read the raw SKILL.md behind a skill for the read-only preview.
#[tauri::command]
pub fn skills_source(id: String, skill_id: String) -> SkillSource {
  let project = match store::find_project(&id) {
    Some(p) => p,
    None => {
      return SkillSource {
        ok: false,
        installed: false,
        content: None,
        error: Some("Project not found.".to_string()),
      }
    }
  };
  let file = skill_dir(&project.path, &skill_id).join("SKILL.md");
  match std::fs::read_to_string(&file) {
    Ok(content) => SkillSource {
      ok: true,
      installed: true,
      content: Some(content),
      error: None,
    },
    // Not in the app yet: show the copy turning it on would add (a library skill
    // wins over a built-in skill of the same name, as in the list).
    Err(_) => match crate::commands::custom_skills::read_library_source(&skill_id) {
      Some(content) => SkillSource {
        ok: true,
        installed: false,
        content: Some(content),
        error: None,
      },
      None => match catalog_by_id(&skill_id) {
        Some(def) => SkillSource {
          ok: true,
          installed: false,
          content: Some(render_skill_file(def)),
          error: None,
        },
        None => SkillSource {
          ok: false,
          installed: false,
          content: None,
          error: Some("This skill has no preview.".to_string()),
        },
      },
    },
  }
}

/// Turn a skill on or off for a project: create or delete its
/// `.agents/skills/<id>/SKILL.md` and commit just that folder.
#[tauri::command]
pub async fn skills_set(id: String, skill_id: String, active: bool) -> SkillActionResult {
  let project = match store::find_project(&id) {
    Some(p) => p,
    None => {
      return SkillActionResult {
        ok: false,
        skills: vec![],
        error: Some("Project not found.".to_string()),
      }
    }
  };
  let dir = project.path;
  let installed = read_installed(&dir);
  let on_disk = installed.get(&skill_id).cloned();
  let is_library = crate::commands::custom_skills::library_skill_exists(&skill_id);
  // The skill this id is in the app's list: Fabricator's built-in one, or else the
  // library's (or, for turning off, whatever is installed).
  let def = catalog_target(&skill_id, on_disk.as_ref(), is_library);

  if active {
    if def.is_none() && !is_library {
      // Never overwrite a different skill that uses a built-in skill's folder name.
      let error = if catalog_by_id(&skill_id).is_some() && on_disk.is_some() {
        "This app already has its own skill with that name."
      } else {
        "Unknown skill."
      };
      return SkillActionResult {
        ok: false,
        skills: build_list(&dir),
        error: Some(error.to_string()),
      };
    }
    if on_disk.as_ref().map(|d| d.managed).unwrap_or(false) {
      return SkillActionResult {
        ok: false,
        skills: build_list(&dir),
        error: Some("That skill is managed by Rayfin.".to_string()),
      };
    }
  } else {
    if on_disk.as_ref().map(|d| d.managed).unwrap_or(false) {
      return SkillActionResult {
        ok: false,
        skills: build_list(&dir),
        error: Some("That skill is managed by Rayfin and can't be removed.".to_string()),
      };
    }
    if on_disk.is_none() {
      return SkillActionResult {
        ok: true,
        skills: build_list(&dir),
        error: None,
      };
    }
  }

  // Turning on a skill the app already has writes the latest version.
  let updating = active && on_disk.is_some();
  let title = display_title(&dir, &skill_id, on_disk.as_ref(), def);
  let io_result: std::io::Result<()> = if active {
    match def {
      Some(def) => write_skill_file(&dir, def),
      // A library skill: copy its folder (SKILL.md + references/) into the project.
      None => crate::commands::custom_skills::install_into_project(&skill_id, &dir),
    }
  } else {
    let target = skill_dir(&dir, &skill_id);
    if target.exists() {
      std::fs::remove_dir_all(&target)
    } else {
      Ok(())
    }
  };

  if let Err(err) = io_result {
    return SkillActionResult {
      ok: false,
      skills: build_list(&dir),
      error: Some(format!("Could not update skills: {err}")),
    };
  }

  // Commit just the skill folder (best-effort) so the change shows in History.
  let verb = if !active {
    "Remove"
  } else if updating {
    "Update"
  } else {
    "Add"
  };
  let message = format!("{verb} skill: {title}");
  commit_skill_change(&dir, &skill_id, &message).await;

  SkillActionResult {
    ok: true,
    skills: build_list(&dir),
    error: None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn frontmatter_extracts_block() {
    let raw = "---\nname: x\nrayfin-managed: true\n---\n# Title\nbody";
    let fm = frontmatter(raw).unwrap();
    assert!(fm.contains("name: x"));
    assert!(fm.contains("rayfin-managed: true"));
  }

  #[test]
  fn frontmatter_strips_bom() {
    let raw = "\u{feff}---\nname: x\n---\nbody";
    assert_eq!(frontmatter(raw), Some("name: x"));
  }

  #[test]
  fn frontmatter_absent_returns_none() {
    assert_eq!(frontmatter("no frontmatter here"), None);
  }

  #[test]
  fn is_managed_detects_sigil() {
    assert!(is_managed("---\nname: rayfin\nrayfin-managed: true\n---\nx"));
    assert!(is_managed("---\nrayfin-managed:   true  \nname: y\n---\nx"));
    assert!(!is_managed("---\nname: polished-ui\n---\nx"));
    assert!(!is_managed("---\nrayfin-managed: false\n---\nx"));
  }

  #[test]
  fn render_skill_file_has_frontmatter_and_title() {
    let def = catalog_by_id("polished-ui").unwrap();
    let out = render_skill_file(def);
    assert!(out.starts_with("---\nname: polished-ui\n"));
    assert!(out.contains("author: Fabricator"));
    assert!(out.contains("# Polished, modern UI"));
    // The rendered file must not itself look managed.
    assert!(!is_managed(&out));
  }

  #[test]
  fn render_skill_file_downgrades_quotes() {
    // friendly-forms body has double quotes, but trigger does not; craft a check on
    // the description line: it must be wrapped in double quotes with no inner ones.
    let def = catalog_by_id("friendly-forms").unwrap();
    let out = render_skill_file(def);
    let desc_line = out.lines().find(|l| l.starts_with("description:")).unwrap();
    let inner = desc_line
      .trim_start_matches("description: \"")
      .trim_end_matches('"');
    assert!(!inner.contains('"'));
  }

  #[test]
  fn title_case_humanizes_ids() {
    assert_eq!(title_case("my_custom-skill"), "My Custom Skill");
    assert_eq!(title_case("rayfin"), "Rayfin");
  }

  #[test]
  fn is_reserved_id_covers_catalog_and_managed() {
    assert!(is_reserved_id("polished-ui"));
    assert!(is_reserved_id("secure-by-default"));
    assert!(is_reserved_id("rayfin"));
    assert!(is_reserved_id("rayfin-functions"));
    assert!(is_reserved_id("rayfin-connectors"));
    assert!(is_reserved_id("rayfin-storage"));
    assert!(!is_reserved_id("my-custom-skill"));
  }

  /// A throwaway project folder, removed when dropped.
  struct TempProject(PathBuf);

  impl TempProject {
    fn new() -> Self {
      let dir = std::env::temp_dir().join(format!("fab-skills-{}", uuid::Uuid::new_v4()));
      std::fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn path(&self) -> String {
      self.0.to_string_lossy().to_string()
    }

    fn skill(&self, id: &str, raw: &str) {
      let dir = skill_dir(&self.path(), id);
      std::fs::create_dir_all(&dir).unwrap();
      std::fs::write(dir.join("SKILL.md"), raw).unwrap();
    }
  }

  impl Drop for TempProject {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn new_projects_get_the_operating_contract_that_keeps_deploys_with_fabricator() {
    let project = TempProject::new();
    ensure_project_skills(&project.path());
    let file = project.0.join(".github").join("copilot-instructions.md");
    let written = std::fs::read_to_string(&file).unwrap();
    assert_eq!(written, AGENT_INSTRUCTIONS);
    // Templates (like the Rayfin CLI's Universal App) and the `rayfin` skill
    // describe a terminal deploy; the contract overrides them.
    for marker in ["Do NOT run `rayfin up`", "`AGENTS.md`", "`app-deployment`", "which workspace to deploy to"] {
      assert!(written.contains(marker), "operating contract should mention {marker}");
    }
    // A file the user wrote themselves is kept.
    std::fs::write(&file, "# Our own rules\n").unwrap();
    ensure_project_skills(&project.path());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Our own rules\n");
  }

  #[test]
  fn a_templates_own_skill_with_a_catalog_name_is_listed_as_the_apps() {
    let project = TempProject::new();
    project.skill(
      "data-modeling",
      "---\nname: data-modeling\ndescription: >\n  Use when the app needs to store or read data. This app's data\n  layer is Rayfin's.\n  Triggers: data, database\n---\n\n# Data modeling — entities, schema, and row-level security\n\nbody\n",
    );
    let list = build_list_with(&project.path(), vec![]);
    let matching: Vec<&SkillInfo> = list.iter().filter(|s| s.id == "data-modeling").collect();
    assert_eq!(matching.len(), 1, "listed once, as the template's skill");
    let skill = matching[0];
    assert!(skill.active);
    assert_eq!(skill.custom, Some(true));
    assert_eq!(skill.category, None);
    assert_eq!(skill.title, "Data modeling");
    assert_eq!(skill.description, "Use when the app needs to store or read data.");
    // The library can't take it under a built-in skill's name.
    assert_eq!(skill.promotable, None);
    // The rest of the catalog is still offered.
    let polished = list.iter().find(|s| s.id == "polished-ui").unwrap();
    assert!(!polished.active);
    assert_eq!(polished.category.as_deref(), Some(LOOK));
  }

  #[test]
  fn skills_added_in_an_app_can_be_saved_to_the_library() {
    let project = TempProject::new();
    project.skill("team-glossary", "---\nname: team-glossary\ndescription: Our terms.\n---\n# Team glossary\n");
    project.skill("odd.name", "---\nname: odd.name\ndescription: x\n---\n# Odd\n");
    let list = build_list_with(&project.path(), vec![]);
    assert_eq!(list.iter().find(|s| s.id == "team-glossary").unwrap().promotable, Some(true));
    assert_eq!(list.iter().find(|s| s.id == "odd.name").unwrap().promotable, None);
    assert!(list.iter().filter(|s| s.custom.is_none()).all(|s| s.promotable.is_none()));
  }

  #[test]
  fn a_library_skill_keeps_a_name_fabricator_later_built_in() {
    let library = vec![crate::types::CustomSkillInfo {
      id: "secure-by-default".to_string(),
      title: "Our security rules".to_string(),
      description: "Written before Fabricator had one.".to_string(),
      icon: "🛡️".to_string(),
      has_references: false,
    }];
    let project = TempProject::new();
    let list = build_list_with(&project.path(), library.clone());
    let matching: Vec<&SkillInfo> = list.iter().filter(|s| s.id == "secure-by-default").collect();
    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0].library, Some(true), "the user's skill, not the built-in one");
    assert_eq!(matching[0].title, "Our security rules");
    assert_eq!(catalog_target("secure-by-default", None, true).map(|d| d.id), None);
    assert_eq!(catalog_target("secure-by-default", None, false).map(|d| d.id), Some("secure-by-default"));

    // An app that already has Fabricator's copy keeps showing (and updating) that one.
    project.skill("secure-by-default", &render_skill_file(catalog_by_id("secure-by-default").unwrap()));
    let list = build_list_with(&project.path(), library);
    let matching: Vec<&SkillInfo> = list.iter().filter(|s| s.id == "secure-by-default").collect();
    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0].category.as_deref(), Some(QUALITY));
    assert!(matching[0].active);
    let disk = read_skill(&render_skill_file(catalog_by_id("secure-by-default").unwrap()));
    assert!(catalog_target("secure-by-default", Some(&disk), true).is_some());
  }

  #[test]
  fn older_catalog_copies_are_flagged_for_an_update() {
    let project = TempProject::new();
    // Written by an older Fabricator, before the product was renamed.
    project.skill(
      "polished-ui",
      "---\nname: polished-ui\ndescription: \"old\"\nmetadata:\n  author: Rayfin Fabricator\n  version: 1.0.0\n---\n# Polished, modern UI\n\nold body\n",
    );
    project.skill("performance", &render_skill_file(catalog_by_id("performance").unwrap()));
    let list = build_list_with(&project.path(), vec![]);
    let polished = list.iter().find(|s| s.id == "polished-ui").unwrap();
    assert!(polished.active);
    assert_eq!(polished.custom, None, "still the catalog skill");
    assert_eq!(polished.outdated, Some(true));
    let performance = list.iter().find(|s| s.id == "performance").unwrap();
    assert!(performance.active);
    assert_eq!(performance.outdated, None, "the current version is up to date");
    assert_eq!(list.iter().filter(|s| s.id == "polished-ui").count(), 1);
  }

  #[test]
  fn rayfin_managed_skills_come_first_and_read_well() {
    let project = TempProject::new();
    let managed = |id: &str, description: &str| {
      format!("---\nname: {id}\ndescription: \"{description}\"\nrayfin-managed: true\n---\n# Something new\n")
    };
    project.skill("rayfin-storage", &managed("rayfin-storage", "Storage."));
    project.skill("rayfin", &managed("rayfin", "Core."));
    project.skill("rayfin-connectors", &managed("rayfin-connectors", "Connect."));
    project.skill("rayfin-zeta", &managed("rayfin-zeta", "Use for the new thing. Triggers: new"));
    let list = build_list_with(&project.path(), vec![]);
    let base: Vec<&str> = list.iter().filter(|s| s.base).map(|s| s.id.as_str()).collect();
    assert_eq!(base, ["rayfin", "rayfin-connectors", "rayfin-storage", "rayfin-zeta"]);
    assert!(list.iter().take(4).all(|s| s.base && s.active));
    let connectors = list.iter().find(|s| s.id == "rayfin-connectors").unwrap();
    assert_eq!(connectors.title, "Rayfin Connectors");
    // A managed skill Fabricator doesn't know yet describes itself.
    let zeta = list.iter().find(|s| s.id == "rayfin-zeta").unwrap();
    assert_eq!(zeta.title, "Something new");
    assert_eq!(zeta.description, "Use for the new thing.");
  }

  #[test]
  fn summaries_take_the_first_sentence_without_triggers() {
    assert_eq!(
      summary("Use to check how a chart looks against REAL data. `npm run preview` renders it.").as_deref(),
      Some("Use to check how a chart looks against REAL data.")
    );
    assert_eq!(
      summary("Write and test DAX queries\n  against semantic models.").as_deref(),
      Some("Write and test DAX queries against semantic models.")
    );
    assert_eq!(
      summary("Use when doing ANY task involving Rayfin. Triggers: rayfin, rayfin init").as_deref(),
      Some("Use when doing ANY task involving Rayfin.")
    );
    assert_eq!(summary("Use it e.g. for charts and tables").as_deref(), Some("Use it e.g. for charts and tables"));
    assert_eq!(summary("Triggers: a, b"), None);
    assert!(summary(&"word ".repeat(80)).unwrap().ends_with('…'));

    assert_eq!(heading_title("Build Workflow — Ship fast, then iterate").as_deref(), Some("Build Workflow"));
    assert_eq!(heading_title("Graphein visuals — author a spec, drop it in `<Chart>`").as_deref(), Some("Graphein visuals"));
    assert_eq!(heading_title("DAX: Discover, Design, Author").as_deref(), Some("DAX"));
    assert_eq!(heading_title("x"), None);
    assert_eq!(first_heading("```sh\n# not a heading\n```\n# Real one\n").as_deref(), Some("Real one"));
  }

  #[test]
  fn versions_compare_by_number() {
    assert!(version_lt("1.0.0", "2.0.0"));
    assert!(version_lt("1.9", "1.10"));
    assert!(version_lt("0", "1.0.0"));
    assert!(!version_lt("2.0.0", "2.0.0"));
    assert!(!version_lt("2.1.0", "2.0.0"));
    assert!(!version_lt("v2.0", "2.0.0"));
  }

  #[test]
  fn build_list_includes_library_skills_active_when_installed() {
    let dir = std::env::temp_dir().join(format!("rayfin-skills-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dir_str = dir.to_string_lossy().to_string();

    let library = vec![
      crate::types::CustomSkillInfo {
        id: "team-brand".to_string(),
        title: "Team brand".to_string(),
        description: "Our house style.".to_string(),
        icon: "🎨".to_string(),
        has_references: false,
      },
      crate::types::CustomSkillInfo {
        id: "installed-one".to_string(),
        title: "Installed one".to_string(),
        description: "Already on disk.".to_string(),
        icon: "📦".to_string(),
        has_references: false,
      },
    ];

    // Install only the second library skill into the project.
    let installed_dir = skill_dir(&dir_str, "installed-one");
    std::fs::create_dir_all(&installed_dir).unwrap();
    std::fs::write(
      installed_dir.join("SKILL.md"),
      "---\nname: installed-one\ndescription: d\n---\n# x",
    )
    .unwrap();

    let list = build_list_with(&dir_str, library);
    let brand = list.iter().find(|s| s.id == "team-brand").unwrap();
    assert_eq!(brand.custom, Some(true));
    assert_eq!(brand.library, Some(true));
    assert!(!brand.active, "uninstalled library skill is inactive");
    assert_eq!(brand.title, "Team brand");

    let installed = list.iter().find(|s| s.id == "installed-one").unwrap();
    assert!(installed.active, "installed library skill is active");
    assert_eq!(installed.library, Some(true));

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn catalog_ids_are_unique_and_render_valid_fabricator_copies() {
    let mut seen = HashSet::new();
    for def in CATALOG {
      assert!(seen.insert(def.id), "duplicate id {}", def.id);
      assert!([LOOK, EXPERIENCE, DATA, QUALITY].contains(&def.category), "{} category", def.id);
      assert!(def.description.chars().count() <= 80, "{} card text is short", def.id);
      assert!(def.trigger.contains("Triggers:"), "{} lists its triggers", def.id);
      let file = render_skill_file(def);
      // Every catalog skill renders a non-managed SKILL.md.
      assert!(!is_managed(&file));
      // Its frontmatter is valid YAML that agents read back unchanged.
      let fm: serde_yaml::Value = serde_yaml::from_str(frontmatter(&file).unwrap()).unwrap();
      assert_eq!(fm["name"].as_str(), Some(def.id));
      assert_eq!(fm["description"].as_str(), Some(def.trigger), "{} description", def.id);
      let disk = read_skill(&file);
      assert!(disk.fabricator, "{} is stamped as Fabricator's", def.id);
      assert_eq!(disk.version.as_deref(), Some(def.version));
      assert_eq!(disk.heading.as_deref(), Some(def.title));
    }
  }
}
