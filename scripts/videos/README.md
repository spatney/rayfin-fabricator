# Videos

Videos hosted by Ray, Fabricator's stingray, built as code with [Remotion](https://www.remotion.dev).
The voice, music and sound effects come from [ElevenLabs](https://elevenlabs.io). There are two
kinds:

- **The intro**: the video at the top of the docs site's landing page, where Ray introduces
  Fabricator in about 85 seconds. It comes in two cuts, one for each of the docs site's themes,
  and the site plays the one that matches: a dark cut in deep water and a light cut in sunlit
  shallows. They share the script, the timing and the sound; only the colors and the app's
  screenshots change. The published files are in `website/public/video/`.
- **Learn Rayfin with Ray**: a YouTube series where Ray teaches [Rayfin](https://rayfin.ai), one
  3–5 minute lesson at a time, with Fabricator as the harness to build along with. The lesson
  plan and each lesson's status are in [`lessons/SYLLABUS.md`](./lessons/SYLLABUS.md).

They share one studio: Ray's rig, the water, the effects, the sound mix and the ElevenLabs
tools. It's a maintainer tool, like [`../docs-screenshots`](../docs-screenshots/README.md), and
isn't part of the app or of CI.

| Path | What it is |
| --- | --- |
| `src/ray/` | Ray, imported from the app (`src/renderer/src/components/mascot/Ray.tsx`) and driven frame by frame. `lipsync.ts` shapes his mouth to what he says |
| `src/anim.ts`, `src/theme.ts`, `src/fx/`, `src/ui/` | Shared by every video: keyframes and easing, each cut's colors (components read them with `useTheme()`), particle bursts, the water, windows that show the app's screenshots, titles and chips |
| `src/Root.tsx` | Every composition: the intro's, each lesson's, the checks (`RayCheck`, `KitCheck`), and `RayAvatar` |
| `public/audio/` | The voice clips, effects and music. Committed, so a render needs no API calls |
| `tools/` | Node scripts for ElevenLabs, audio, review, rendering and publishing. Nothing in `src/` imports them |
| **The intro** | |
| `script/lines.ts` | What Ray says in the intro, with ElevenLabs audio tags such as `[excited]`: the single source of truth for its voice, captions and transcript. Ray's voice (`VOICE`) is here too, and the lessons use it |
| `src/Intro.tsx`, `src/scenes/` | The intro: `Intro.tsx` assembles the scenes in `src/scenes/`, Ray, the voice, the effects and the ducked music |
| `src/shots.ts` | The screenshots the intro shows, and their sizes |
| `src/timing.ts`, `src/timeline.json` | Where every scene and line sits in time, from `timeline.json`, which `npm run voice` generates: each line's length, word timings and loudness per frame, which drive Ray's lips |
| **The lessons** | |
| `lessons/SYLLABUS.md` | The lesson plan, the format every lesson follows, and each lesson's status |
| `lessons/series.ts` | The series: its name, voice and tempo, music, links and disclaimer |
| `lessons/<NN>-<slug>/` | One lesson: `script.ts` (what Ray says, beat by beat, with sources), `scenes.tsx`, `snippets.ts` (the code it shows), `youtube.ts` (title, thumbnail, challenge), and the generated `timeline.json` and `youtube.md` |
| `src/show/` | The lesson engine: `plan.ts` lays a lesson out in time, `Show.tsx` plays it with Ray, the voice, the effects and the music, and `youtube.ts` writes its description |
| `src/lesson-kit/` | The building blocks of lesson scenes (see [The lesson kit](#the-lesson-kit)) |

## Before you start

- Windows 11, for the app's `Segoe UI Variable Display` font, and Node.js 24, which runs the
  tools' TypeScript imports directly.
- `npm install` here, and in `website/` (the tools borrow its `sharp`).
- For anything that calls ElevenLabs (`audition`, `voice`, `sfx`, `music`, `lesson:voice`,
  `lesson:music`), an API key in `ELEVENLABS_API_KEY`, or as `ElevenLabsKey=<key>` in the
  gitignored `.keys` file at the repository root. The tools never print it, and nothing that
  reaches the browser bundle reads it.

Rendering needs no key: the committed audio is enough. `npm run studio` opens every video in
Remotion Studio.

## The intro video

### The story

Each line in `script/lines.ts` has a scene with the same id, in the same order in `SCENE_IDS`
(`src/timing.ts`) and `SCENES` (`src/Intro.tsx`):

| Scene | What it shows |
| --- | --- |
| `hello` | Ray swims in and says hi |
| `old-way` | The old way, with CLIs, Copilot, git and a browser, until the room spins |
| `one-window` | Fabricator puts it all in one window |
| `describe` | Name the app, then describe it: the first prompt is typed and sent, the agent's work log fills in, and the app comes up in the preview |
| `fabric` | Deploy it: the app's window shrinks into its tile, and Ray swims it into Microsoft Fabric |
| `backend` | Rayfin gives the app the backend it needs, inside the organization's boundary |
| `preview` | The tile grows back into the running app, and Design points at a change |
| `ship` | Fabricator redeploys after a chat turn, and the app is shared |
| `tricks` | Advisor, Blueprint, and Ray digging through the logs |
| `outro` | The end card |
| `stinger` | One last fact from Ray |

The app asks for a first deploy before the first chat; the story leaves that step out. A scene
starts where the one before it left off. Ray's path runs on from scene to scene, and whatever a
scene hands over (a window, a tile, a burst still in the air) it stops drawing at the next
scene's first frame, where the next scene draws it instead. `ctx.at()` finds a word in another
scene's line, for carrying on something the scene before started.

The compositions are `FabricatorIntro` (the dark cut), `FabricatorIntroLight` (the light cut) and
their posters `Poster` and `PosterLight`.

### Render and publish

```powershell
npm run studio          # preview and scrub through it in Remotion Studio
npm run render          # both cuts, with the audio mastered to -16 LUFS
npm run render:dark     # only the dark cut: out/fabricator-intro.mp4
npm run render:light    # only the light cut: out/fabricator-intro.light.mp4
npm run loudness        # length, size, loudness, true peak, fast start, for both cuts
npm run contact-sheet   # out/contact-sheet.jpg; --theme light, --scenes, --frames 120,480 or --count 40
npm run publish         # both cuts, their posters, captions and transcript into the docs site
```

`npm run render` writes `out/fabricator-intro.mp4` and `out/fabricator-intro.light.mp4`. The
cuts have the same sound, mastered the same way; when the two renders' audio is bit for bit
the same, the light cut takes the dark cut's mastered track rather than being mastered again.
`contact-sheet --theme light` writes `out/contact-sheet.light.jpg`.

`publish` writes `website/public/video/fabricator-intro.mp4` and `fabricator-intro.light.mp4`,
their posters `fabricator-intro-poster.webp` and `fabricator-intro-poster.light.webp`, and
`fabricator-intro.en.vtt`, the captions both cuts share. It also writes
`website/lib/intro-video.json`, which holds the files, duration and transcript for the landing
page and its `.md` mirror. Only publish cuts you've watched all the way through.

The dark cut is also on [Fabricator's YouTube channel](https://www.youtube.com/@RayfinFabricator),
with the English captions, and the landing page and README link to it. When you publish a new
cut, upload it there too and update `youtube.intro` in `website/lib/site.config.ts` and the
badge in the repo's `README.md`.

Before it writes anything, `publish` checks that both cuts are rendered and the same length,
that every screenshot the video shows is on the site in both themes (so neither cut was made
with a stand-in), and that none changed after the cuts were rendered. If a check fails, it
says which, and you render again.

### Change what Ray says

1. Edit `script/lines.ts`. Keep every claim true to `README.md`, to Ray's lines in the app
   (`src/renderer/src/components/mascot/lines.ts`) and, for Rayfin, to <https://rayfin.ai>.
2. Run `npm run voice -- <id>` with the ids of the lines you changed, say
   `npm run voice -- tricks`. Only those lines are generated again; the others keep their clips
   and timings. `npm run voice` on its own makes every line again: each request is cached in
   `.cache/` by its content, so with the cache in place only changed lines cost anything, but
   the cache isn't committed, and without it every line comes back as a new take. To retake a
   line without changing its words, give it a new `seed`.
3. Scenes time their beats to words (`ctx.w('fever')`). If a word they use is gone, the
   render stops with an error that names it; update the scene.
4. If the cut's length changed by more than a second, run `npm run music` for a bed of the
   new length.
5. Render, check and publish as above.

Ray's lips follow the new words on their own. `src/ray/lipsync.ts` reads each line's word
timings from `src/timeline.json`, spreads each word's letters across its span, and picks a
mouth shape for each sound: lips shut for m, b and p, rounded for o and u, spread for e and i.
The mouth moves two frames ahead of the voice, opens wider when he's louder, and rests in
pauses, unless the voice carries on without words there (a cheer, a giggle). His mood stays
on his face while he talks.

`npm run audition` reads the first two lines in a few library voices and some voices
designed from a description of Ray. The chosen voice is `VOICE` in `script/lines.ts`.

### Keep it in step with the app

- **The UI changed.** Refresh the screenshots with
  [`../docs-screenshots`](../docs-screenshots/README.md), in both themes, then render and
  publish. `npm run assets` (which `studio` and the renders run first) copies them into
  `public/ui/`: `<id>.webp` feeds the dark cut and `<id>.light.webp` the light one. The scenes
  point at places in the screenshots (the composer, the Redeploy button, the share dialog,
  the Blueprint map), in image pixels shared by both themes, so check both cuts in contact
  sheets. The "Describe it" scene (`src/ui/FirstTurn.tsx`) makes a new project's first chat
  from `chat-working`: it hides the earlier turns, draws the typed prompt's bubble and the
  agent's two narration lines in the app's style, and shows the shot's own work log under them,
  row by row, with the idle composer from `workbench` until the prompt is sent. If the chat's
  layout changes, update the row positions at the top of that file, and keep the two
  screenshots' chat layout the same.
- **A screenshot has no light version yet.** `npm run assets` says so and gives the light cut
  a stand-in, the dark screenshot with its colors inverted, in `public/ui/` only. That's
  enough to check the light cut's timing and layout. `publish` refuses until the site has the
  real one and both cuts are rendered again.
- **Ray changed.** `src/ray/ray-video.css` replaces the time-based animations in the app's
  `mascot.css` by class name, and hides the app's mouth while the video draws its own
  (`src/ray/Mouth.tsx`). Open the `RayCheck` composition in the Studio to see him swim,
  roll, wave and show every mood, and to watch his lips on any line: set its `line` and
  `mood` props. Then render `RayAvatar` again, his 1024×1024 profile picture, centered so a
  circular crop keeps all of him: `npx remotion still src/index.ts RayAvatar out/ray-avatar.png`
  (its `theme` and `mood` props pick the water and his face).

## Learn Rayfin with Ray

The lessons follow the plan in [`lessons/SYLLABUS.md`](./lessons/SYLLABUS.md), which also sets the
rules every lesson keeps: teach Rayfin; show Fabricator, and only Fabricator, as the harness;
give every claim a source; and make sure the code on screen compiles. The
`learn-rayfin-with-ray` skill ([`.github/skills/learn-rayfin-with-ray/`](../../.github/skills/learn-rayfin-with-ray/SKILL.md))
walks an agent through making one.

### Make a lesson

```powershell
npm run lesson:new -- 2 your-first-app "Your first Rayfin app"   # the folder, in lessons/index.ts and SYLLABUS.md
npm run studio                       # Lesson02 plays at once, as an animatic of draft scenes
npm run lesson:snippets -- 2         # type-checks the code it shows against the real Rayfin packages
npm run lesson:voice -- 2 --dry      # what voicing would make and cost
npm run lesson:voice -- 2            # Ray's voice for every new, changed or retaken line
npm run lesson:sheet -- 2 --scenes   # out/contact-sheet-Lesson02.jpg; or --frames 120,480
npm run lesson:render -- 2           # out/lessons/02-your-first-app/02-your-first-app.mp4, at -16 LUFS
npm run lesson:package -- 2          # the YouTube package: video, captions, thumbnail, youtube.md
```

1. Start the lesson with `lesson:new`, then write `script.ts`: scenes of beats, each beat a line
   Ray says, with the pages it rests on, or a silent hold. A scene with a `chapter` starts a
   YouTube chapter.
2. Put the code the lesson shows in `snippets.ts` and run `lesson:snippets`. The first run
   scaffolds a scratch Universal App at the lesson's Rayfin version in `.cache/rayfin-check/`.
   Its `.agents/skills/rayfin/SKILL.md` and its packages' own docs are the version-locked
   reference for the script, too.
3. Have the script approved, then voice it with `lesson:voice`. A line keeps its clip while its
   words, seed and respellings don't change; to retake one, give it a new `seed`. If Ray says a
   word wrong, give the line a respelling for the voice alone, such as `say: { APIs: "API's" }`
   or `say: { 'rayfin.yml': 'rayfin dot yaml' }`: the captions and word cues keep the word as
   written. Write a respelling's words apart, not joined with hyphens, which the voice can read
   as "dash". The tool refuses lines that still say TODO.
4. Build `scenes.tsx` from the kit, timing beats to words (`ctx.w('table')`,
   `ctx.at('quiz-options', 'C')`). A line that isn't voiced yet plays at a stand-in pace, so
   scenes can be built before any credits are spent; the real timings replace it line by line.
5. Check it in the Studio and in contact sheets, render it, package it, and update
   `SYLLABUS.md`. The Studio and contact sheets leave out any voice clip, effect or music that
   isn't made yet, so a lesson can be seen early. `lesson:render` doesn't: it stops and names
   the missing file and the command that makes it (`--draft` renders without them).

### How a lesson is laid out

`src/show/plan.ts` plays the beats one after another, with 0.55 s of quiet before a scene's
first beat and 0.3 s between beats (a beat's `gap` overrides either). A scene starts `lead`
seconds before its first beat and runs 10 frames into the next one, so the next one can
transition in; the first scene starts the video. A scene can darken the water for a Deep Dive
(`depth: 1`), calm it behind busy screens (`dim`), and turn the music up or down (`bed`; the
bumper sets it to 0 under the jingle). The music is the series' bed from `lessons/series.ts`,
made once with `npm run lesson:music`, looped under every lesson and ducked under Ray's voice.

### The lesson kit

| Piece | For |
| --- | --- |
| `SeriesBumper`, `Objectives`, `ChapterTitle`, `ChapterTag` | The bumper, "Today you'll learn", and chapters |
| `CodeCard` | Code in a window like Fabricator's editor, in TypeScript, YAML, JSON or plain text: it types itself out, focuses lines, scrolls a long file, and rings and labels code by character (`locate()` finds it) |
| `DeepDiveTitle`, `DepthGauge`, `Depths`, `Sonar` | The Deep Dive |
| `ArtifactCard`, with `TableBody`, `ApiBody`, `AutocompleteBody`, `RowSecurityBody` or `ValidationBody` | What Rayfin makes |
| `ServiceTiles`, `CommandCard` | What a deploy provides, and a Rayfin CLI command "under the hood", tagged as run by Fabricator |
| `Quiz`, `Recap`, `Challenge`, `EndScreen` | The pop quiz and its countdown, the takeaways, Ray's challenge, and the end screen, which leaves room for YouTube's elements (`END_SLOTS`) |
| `LessonThumbnail` | The thumbnail, as the `LessonNNThumbnail` still |
| `STATIONS`, `at()` | Ray's usual spots |

The intro's pieces work in lessons too: `AppWindow`, `Spotlight` and `FirstTurn` for Fabricator's
screenshots (any screenshot in `website/public/screenshots/`), and `KineticTitle`, `Chip` and
`Burst`. `KitCheck` in the Studio plays the whole kit. New effects go in `tools/sfx.mjs`: make
them with `npm run sfx -- <id>`, naming only the new ones, so other videos' clips never change.

### Publish on YouTube

`lesson:package` refuses a lesson that isn't fully voiced, a render older than the files the
video shows or says (the lesson's `script.ts`, `scenes.tsx`, `snippets.ts`, `youtube.ts` and
`timeline.json`, and `lessons/series.ts`), and a render whose frame count no longer matches the
lesson's timing, since the captions and chapters come from that timing. It writes
`out/lessons/<slug>/youtube/`: the video, English captions (`.en.vtt`), a
1280×720 thumbnail under 2 MB, `youtube.md`, with the title, the description (chapters that
follow YouTube's rules, the sources, the challenge and the disclaimer), tags, a pinned comment,
where the end screen's elements go, and an upload checklist, and `upload.json`, the same for the
YouTube tools. A copy of `youtube.md` stays in the lesson's folder as a record.

The YouTube tools in `tools/youtube/` upload a lesson to
[Fabricator's channel](https://www.youtube.com/@RayfinFabricator) by driving YouTube Studio in a
browser you sign in to:

```powershell
npm run yt:browser                  # Edge, with its own profile (outside the repo) and DevTools on 127.0.0.1
npm run yt:driver                   # left running: stays attached, since Studio closes dialogs when it lets go
npm run yt -- status                # signed in, and on the channel?
npm run yt -- upload --lesson 2     # then details, subtitles, endscreen and visibility --as public
npm run yt -- publish --confirm     # after you've looked at what visibility reports
npm run yt -- comment --lesson 2    # the challenge, as the channel, pinned
npm run yt -- check --lesson 2      # public, captions, links, chapters, end screen, comment, playlist
```

Each step checks its work and saves screenshots to `out/youtube/shots/`; `npm run yt -- --list`
says what each does. `lessons/channel.ts` holds the channel, the playlist and each published
lesson's video id. The `endscreen` step puts YouTube's elements on the slots the lesson draws
(`END_SLOTS` in `src/show/youtube.ts`), in an upload or, with `--video-id <id> --replace`, on a
published video, such as pointing a lesson at the next one once it's up. With `--intro`, it
puts lesson 1 on the Fabricator intro's end screen. The whole procedure,
the rules for it and what Studio does are in the skill's
[`references/youtube-studio.md`](../../.github/skills/learn-rayfin-with-ray/references/youtube-studio.md).

## Costs and licenses

- ElevenLabs bills per character of speech, per sound effect and per minute of music. The
  tools check the account's remaining credits before they spend any, and everything they
  generate is cached in `.cache/` (gitignored). The lessons share one music bed, so a lesson
  costs its voice and any new effects. Audio made on a paid plan, pay-as-you-go included, may
  be used commercially; see ElevenLabs' terms.
- Remotion is free for individuals and small companies, and Fabricator is a personal
  project. Someone rendering this on behalf of a larger company may need a
  [company license](https://www.remotion.dev/license).
