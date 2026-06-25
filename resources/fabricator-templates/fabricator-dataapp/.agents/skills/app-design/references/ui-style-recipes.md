---
name: ui-style-recipes
description: Use when generating UI components (buttons, cards, inputs, dialogs, menus, tabs, tooltips, tables, etc.). Provides styling constraints — not templates — so every app looks cohesive but unique.
---

# UI Style Recipes

This file provides styling guidance for UI components — buttons, cards, inputs, dialogs, tabs, tooltips, tables, and more. The goal is cohesive, polished UI that adapts to light and dark mode, without making every app look identical.

When generating or modifying UI components, follow these principles and use the patterns below as your vocabulary of choices.

---

## Core Principles

### Design tokens

All styling should reference the tokens from `src/global.css` — colors, spacing, radii, fonts, and icon sizes. No hardcoded values. Use each color token for its intended surface — don't mix them interchangeably. See `global.css` for the full list, usage, and which surfaces each token applies to.

### Focus & accessibility

All form and input elements must have focus, disabled, and error/invalid states.

### Dark mode

- Use the `.dark` class variant via `@custom-variant dark (&:is(.dark *))`.
- Opacity adjustments for dark mode are common: `dark:bg-input/30`, `dark:hover:bg-input/50`.

### `cn()` for class merging

Use `cn()` from `@/lib/utils` to combine classes, especially when accepting className props. Avoid concatenating class strings manually.

### Form element consistency

Native form controls can diverge from token-driven styles unless normalized. Keep filter bars and form groups visually consistent by applying all of the following:

1. Ensure base styles set `font-family: inherit` for `select`, `input`, `textarea`, and `button`.
2. When combining font size and text color in `cn()`, prefer explicit length syntax for font size (such as `text-[length:var(--text-300)]`) to avoid merge conflicts.
3. Set explicit, consistent control heights (for example around 36px) so inputs, selects, and buttons align.
4. After composing a toolbar/form row, visually verify matching font family, font size, text color, and height across controls.

### Overflow + rounded corners

Containers with rounded corners that hold scrollable or overflowing content (tables, grids, lists) should use `overflow-hidden` to prevent visual bleed past the rounded corners.

---

## Soft Guidance (adapt per context)

These are patterns that work well. Deviate when the design direction calls for it.

### Surface hierarchy

Use fill color to communicate depth — lighter surfaces sit higher:
- **Page** → lowest layer (darkest in light mode, darkest in dark mode)
- **Cards** → float above with lighter fill
- **Popovers/dialogs** → highest elevation, lightest fill

Reinforce with shadows from the shadow scale (`shadow-2` through `shadow-64`). Higher elevation = larger shadow.

> **Make it yours:** Flat `bg-background` is the safe default, but consider what sits behind the content — a subtle dot grid, gradient mesh, noise texture, or contrasting panel. This one choice defines the app's atmosphere.

### Radius nesting rule

When nesting rounded containers, step down the radius scale so inner corners don't look flat against outer curves. Adjust the starting point to match your aesthetic — sharp designs start lower, soft designs start higher. Baseline defaults:
- Outer: `rounded-xl`
- Inner: `rounded-lg`
- Deeply nested: `rounded-md`

### Spacing rhythm

Use the 4px baseline grid (`spacing-xs`, `spacing-s`, `spacing-m`, `spacing-l`, etc.). Within a component, be consistent — don't mix spacing scales arbitrarily.

### Horizontal bar alignment

Toolbars, filter bars, and header rows with mixed-height elements (icons, stacked label+control pairs, standalone text) should share a consistent alignment edge — typically vertical center or bottom baseline — so the row reads as a unified strip rather than items floating at different levels.

### Contextual weight of repeated elements

Elements that repeat in dense contexts (table rows, lists, toolbars) must be styled lighter than the same element in a spacious context (cards, hero sections). A badge that looks right in a card header will overwhelm a table when it appears on every row. After placing a styled element in a dense context, check whether it competes with the primary data — if it does, reduce its visual weight (padding, fill, font weight) until it supports the data instead of dominating it.

### Typography scale

Use the 100-based scale (`text-100` through `text-hero-1000`). Pair sizes with matching line heights (`leading-100` through `leading-hero-1000`). Scale your type hierarchy to match the aesthetic direction — a bold direction might use `text-500`+ for headings, while a dense or utilitarian direction stays compact with `text-300`/`text-400`. Baseline defaults if no direction is set:
- Body text: `text-300 leading-300`
- Small / secondary: `text-200 leading-200`
- Section headings: `text-400 font-semibold`
- Hero metrics: `text-hero-900 font-bold`

### Animation patterns

- **Transitions** for state changes: `transition-all`, `transition-colors`, `transition-[color,box-shadow]`
- **Animate in/out** for appearing/disappearing elements:
  - Open: `animate-in fade-in-0 zoom-in-95`
  - Close: `data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95`
- **Positional slides** for dropdowns/popovers:
  - `data-[side=bottom]:slide-in-from-top-2`
  - `data-[side=top]:slide-in-from-bottom-2`
  - `data-[side=left]:slide-in-from-right-2`
  - `data-[side=right]:slide-in-from-left-2`

> **Make it yours:** A single well-choreographed moment beats many small effects. Consider a staggered page-load reveal (CSS `animation-delay` on cards), a meaningful hover transform on interactive elements, or a smooth tab-switch transition. Pick one high-impact moment and execute it well.

### Radix primitives

Use Radix UI primitives for interactive components that need accessibility, keyboard navigation, or managed state — dialogs, dropdowns, selects, tabs, tooltips, etc. Style them with Tailwind; never use Radix's default styles.

### Data attributes for variant tracking

Use `data-slot`, `data-variant`, `data-size`, `data-state` attributes for semantic identification and conditional styling. This enables parent-aware styling via `has-data-[slot=...]` selectors.

---

## Element Vocabulary

Starting points per element type — not rigid specs. This list is not exhaustive.

**Every UI element you create — whether listed here or not — must be styled to match the app's aesthetic direction.** If you create a component and it still looks like a browser default or a generic library output, it hasn't been designed yet. After setting the theme in `global.css`, review every element: does its radius, color, weight, spacing, and hover/focus behavior reflect the chosen tone? If not, adjust it.

For each element, ask: what makes this feel like it belongs in *this* app? The answer might be a radius change, a color accent, a hover animation, a border style, or a weight shift. Apply the same creative thinking uniformly — don't style some elements and leave others untouched.

### Group consistency

Any cluster of related interactive elements — form fields, filter panels, toolbar controls, command bars — should share a cohesive size, radius, and text scale. Labels should feel proportional to their controls, not drastically smaller or detached. Pick values that fit the aesthetic direction and apply them uniformly across the group. If the group has a compact variant, step all elements down together.

### Buttons

- **Radius**: match the app's radius scale — `rounded-md`, `rounded-lg`, `rounded-full` are all valid
- **Height scale**: pick from ~24px (`h-6`), ~32px (`h-8`), ~36px (`h-9`), ~40px (`h-10`) — align with the app's density
- **Variants to support**: primary (default), secondary, destructive, outline, ghost, link — at minimum
- **Smart padding**: reduce horizontal padding when only an icon is present (`has-[>svg]:px-*`)
- **Typography**: match the form text scale chosen for the app

### Cards

- **Background**: `bg-card text-card-foreground`
- **Elevation**: choose shadow, border, or both to separate cards from the page. `shadow-4` + `border` is the baseline default; shadow-only, border-only, or borderless designs are all valid depending on the aesthetic direction.
- **Internal spacing**: use `px-*` / `py-*` on content areas, `gap-*` between sections
- **Structure**: compose from header, content, footer sections — don't enforce rigid slots

### Inputs

- **Height**: align with the app's density — `h-9` standard, `h-8` compact
- **Background**: adapt to the aesthetic — `bg-transparent`, tinted, or filled are all valid
- **Border**: `border border-input` is the baseline; borderless with an underline, inset shadow, or filled background are alternatives
- **Placeholder**: `placeholder:text-muted-foreground`
- **Selection highlight**: `selection:bg-primary selection:text-primary-foreground`

### Checkboxes, Radios & Switches

These are often left unstyled — don't. They should match the aesthetic direction like any other element.

- **Checkboxes / Radios**: style the indicator to match the app's radius, colors, and weight. Use `bg-primary` for the checked state with a crisp check/dot icon. Size them proportionally to the adjacent label text.
- **Switches / Toggles**: match the track and thumb to the app's color palette. The track should clearly communicate on/off states.
- **Focus**: all variants need visible focus rings consistent with other interactive elements.

### Dropdowns / Selects / Menus

- **Surface**: `bg-popover text-popover-foreground`
- **Shadow**: `shadow-8`
- **Item focus**: `focus:bg-accent focus:text-accent-foreground`
- **Item spacing**: keep compact — `py-s-nudge px-s` range
- **Item typography**: `text-300`
- **Max height**: respect Radix's available-height variable for viewport-aware sizing

### Tabs

- **Variants**: filled (items against `bg-muted`) or line (underline indicator) — pick what fits the design
- **Active indicator**: filled uses `bg-background shadow-sm`; line uses a pseudo-element underline
- **Typography**: `text-sm font-medium`, inactive color at reduced opacity (`text-foreground/60`)
- **Orientation**: support both horizontal and vertical when using Radix Tabs

### Dialogs / Modals

- **Overlay**: `bg-black/50` with fade animation is the baseline; tint or adjust opacity to match the aesthetic
- **Surface**: `bg-background` with `shadow-64` (highest elevation)
- **Radius**: match the app's radius scale (baseline: `rounded-xl`)
- **Width**: responsive — full width on mobile with max-width on larger screens
- **Close button**: positioned `absolute top-4 right-4`, subtle opacity treatment

### Tables

- **Typography**: compact text for data density — adapt to the app's type scale
- **Row borders**: `border-b` between rows, or use alternating row fills for a different look
- **Hover**: subtle background shift on hover
- **Selected**: `data-[state=selected]:bg-muted`
- **Head cells**: `font-medium text-muted-foreground`

### Tooltips

- **Surface**: inverted (`bg-foreground text-background`) by default; adapt to match your aesthetic
- **Radius**: match the app's radius scale
- **Typography**: `text-xs`, use `text-balance` for wrapping
- **Arrow**: small rotated square matching tooltip background
- **Delay**: 0ms default for immediate feedback

### Badges

- **Shape**: `rounded-full` for pill shape by default; use the app's radius scale for angular aesthetics
- **Typography**: `text-xs font-medium`
- **Spacing**: tight — `px-2 py-0.5`

### Skeletons / Loading

- **Animation**: `animate-pulse`
- **Background**: `bg-accent` (matches muted surfaces)
- **Radius**: match the shape of the element being loaded

### Separators

- **Color**: `bg-border`
- **Size**: `h-px w-full` (horizontal) or `w-px h-full` (vertical)

### Scrollbars

Use thin, theme-aware scrollbars globally, using the border color token for the thumb and a transparent track.

Apply the same on any scrollable container (DataGrid wrappers, sidebars, etc.).

### Any element not listed

This list doesn't cover every possible component. If you create a sidebar, breadcrumb, progress bar, avatar, alert, accordion, or anything else — apply the same principle: match the app's radius, colors, spacing, and weight. No element gets a free pass to look generic.