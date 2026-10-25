# Building lesson scenes

A lesson's `scenes.tsx` exports `SCENES`: one `LessonScene` (`src/show/types.ts`) per scene in
`script.ts`, with the same id and in the same order. `lessons/01-what-is-rayfin/scenes.tsx` is
the worked example; copy its patterns.

```tsx
const ship: LessonScene = {
  id: 'ship',                // the script's scene id
  depth: 0,                  // 0…1: 1 is a Deep Dive's dark water
  dim: 0,                    // 0…1: calms the water behind busy screens
  bed: 1,                    // the music bed's level: 0 under the jingle, about 0.8 in the quiz
  ray: (c) => ({ keys: [...], moods: [...], waves: [...], hops: [...], rolls: [...], squishes: [...], gaze: [...] }),
  sfx: (c) => [{ f: c.w('inside'), id: 'shimmer', volume: 0.35 }],
  View: ({ ctx }) => <AbsoluteFill>…</AbsoluteFill>,
};
```

## Time everything to the words

Frames are relative to the scene's start. `ctx` gives you:

| Call | Returns |
| --- | --- |
| `ctx.w('word', nth?)`, `ctx.wEnd(…)` | Where a word starts or ends, searching this scene's lines in order. Case, punctuation and the kind of apostrophe don't matter. |
| `ctx.at('line-id', 'word', nth?)`, `ctx.atEnd(…)` | The same, in one line, from any scene |
| `ctx.beat('id')` | `{ from, to, line }` for any beat, including holds such as `countdown` |
| `ctx.lead` | Where the scene's first beat starts |
| `ctx.span.duration` | The scene's length, including the 10 frames it overlaps the next |

A missing word throws an error that names it, so a script edit can't quietly put a cue out of
step. Until a line is voiced, the draft timeline times its words at a stand-in pace, so you can
build and look at scenes before voicing. Check again after voicing.

Hand-offs: a scene runs 10 frames into the next one. Let things leave by `ctx.span.duration -
14`, or have the next scene draw them from its first frame. Give Ray named spots (a `SPOT`
table, as in lesson 1) and start each scene's `keys` where the last one left him.

## Ray

`ray(c)` returns his part in the scene: `keys` (`{ f, x, y, s, r?, e? }`; `at(f, spot)` from
the kit makes one), `moods` (see [ray-voice.md](ray-voice.md)), `waves`, `hops`, `rolls`
(loop-the-loops), `squishes` and `gaze` (`[frame, x, y]`, each -1…1). Keep him off whatever he's
explaining: small (`s` 0.4–0.5) in a corner while a window or code fills the frame, bigger
(0.8–1) when he's talking to the viewer. He looks at what he talks about.

## The kit (`src/lesson-kit`)

| Piece | Key props | Notes |
| --- | --- | --- |
| `SeriesBumper` | `series, number, title, from, to` | With the `jingle` effect at `volume: 1` and `bed: 0`. The jingle is about 3.3 s of sound, so hold the bumper's beat 3.4 s, or the end is dead air |
| `Objectives` | `items: [{ text, at }], from, to, x, y` | "Today you'll learn" |
| `ChapterTitle`, `ChapterTag` | `title, label` / `text`, `from, to` | A big opening title, or a corner tag for the whole chapter |
| `CodeCard` | `code, file, language, x, y, width, fontSize, from, to, typeFrom/typeTo, focus, marks, firstLine, rows/scroll, scale` | `language` is `typescript` (the default), `yaml`, `json` or `plaintext`. Use `locate(code, text)` for each mark's line and columns; a mark's `line` counts from the first line of the `code` you pass, whatever `firstLine` shows. Labels sit after the line; align them with `labelGap`, or put them `below` or `above`, starting at column `labelFrom`. `rows` gives a long file a fixed height, and `scroll` (in lines) pans it. 26–30 px fonts read well. |
| `DeepDiveTitle`, `DepthGauge`, `Sonar` | `from, to, tuckAt` / `from, to` / `x, y, at` | With `depth: 1` on the scene and the `dive` and `sonar` effects. Keep the left 260 px clear for the gauge. |
| `ArtifactCard` | `x, y, width, icon, title, subtitle, at, until, lit` | Holds `TableBody`, `ApiBody`, `AutocompleteBody` (real method names only), `RowSecurityBody` or `ValidationBody` |
| `ServiceTiles` | `tiles: [{ icon, label, sub, at }], y, boundaryAt, boundaryLabel, until, extra` | What a deploy provides, inside the tenant's boundary |
| `CommandCard` | `command, output, from, to, typeFrom, typeTo, x, y, width, scale, tag, tagAt` | A Rayfin CLI command "under the hood". Its tag says "Fabricator runs this for you", so keep it only on commands Fabricator really runs: `npm create @microsoft/rayfin@latest`, `rayfin login`, `rayfin up`, `rayfin up status`, `rayfin secret set` (check `src-tauri/src` for others). Fabricator never runs `rayfin dev` or `npm run dev`; give those a tag that's true, or none. Output lines are what the installed CLI prints: find them in its `dist/` in the scratch app. |
| `Quiz` | `question, options: [{ text, code?, at }], answer, countdown: { from, step }, revealAt` | With `tick` on each count and `correct` and `confetti` at the reveal |
| `Recap`, `Challenge` | `items` / `prompt, typeFrom, typeTo, cta, ctaAt` | |
| `EndScreen` | `series, next, from, to, fabricator, disclaimer` | Keep `END_SLOTS` clear: the 16:9 slot on the left and the round slot on the right |
| `Icon` | `name` (see `icons.tsx`) | Add an icon to `ICONS` as Lucide-style 24 px strokes |

From the intro's kit: `AppWindow` (a screenshot in a window, with a camera: `zoom`, `fx`, `fy`;
`height` crops it), `Spotlight` and `Patch` (in image pixels), `FirstTurn` (a new project's
first chat turn over `chat-working`), `KineticTitle`, `Chip`, `Burst` (bubbles, confetti, hearts,
sparkles) and `DizzyStars`.

## Fabricator's screenshots

Any screenshot in `website/public/screenshots/` can appear. `npm run assets` copies them into
`public/ui/`. Declare its size where you use it (`{ id: 'chat-diff', w: 1080, h: 1290 }`), and
find the pixels to point at by cropping it:

```powershell
cd website; @'
require('sharp')('public/screenshots/chat-diff.webp').extract({ left: 0, top: 380, width: 1080, height: 680 }).toFile('../scripts/videos/out/crop.png');
'@ | node -
```

Then view the crop. If a lesson needs a screen there's no screenshot of, capture it with
`scripts/docs-screenshots` (with sample data, in both themes) rather than drawing a fake.

## Effects

Ids are in `SfxId` (`src/show/types.ts`). Volumes of about 0.3–0.6 sit under the voice. The
lessons' own effects are `jingle`, `dive`, `surface`, `tick`, `correct` and `sonar`. Shared ones
include `pop`, `chime`, `stamp`, `typing` (give it a `duration`), `click`, `swim-whoosh`,
`sweep`, `bubbles`, `boing`, `dizzy`, `thud`, `shimmer` and `confetti`. The Studio and contact
sheets leave out an effect whose file isn't made yet; `lesson:render` stops and names it, so
make new ones (`npm run sfx -- <id>`) before the final render.

## Look before you render

`npm run lesson:sheet -- <n> --scenes` renders every scene's start and middle. The start is often
a transition, so also render `--frames` at the moments that matter: each card's reveal, each
spotlight, the quiz reveal, and the end screen. View them at full size in `out/stills/` when text
looks small. `KitCheck` in the Studio shows every kit piece in turn.
