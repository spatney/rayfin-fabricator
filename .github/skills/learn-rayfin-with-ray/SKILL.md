---
name: learn-rayfin-with-ray
description: Make, change or plan lessons of "Learn Rayfin with Ray", the YouTube series where Ray, Fabricator's stingray, teaches Rayfin. The lessons are built as code with Remotion and ElevenLabs in scripts/videos. Use when asked to make the next Rayfin lesson or tutorial video, to write, voice, animate, render or package a lesson for YouTube, to upload or publish a lesson to the YouTube channel or update one that's up (end screen, pinned comment, details), to fix a lesson, or to update the series' lesson plan (SYLLABUS.md).
---

# Learn Rayfin with Ray

Ray, the stingray who lives in Fabricator, teaches [Rayfin](https://rayfin.ai) in short YouTube
lessons. The goal is Rayfin itself: its ideas, its code and its commands. Fabricator is the
harness viewers build along with. Each lesson is a Remotion composition. Ray's voice, the music
and the effects come from ElevenLabs, and every claim is checked against one Rayfin release.

Where things live, all under `scripts/videos/` (read its `README.md` before you start):

| Path | What it is |
| --- | --- |
| `lessons/SYLLABUS.md` | The lesson plan: every lesson's topic, hook, Deep Dive, demo, quiz and sources, and the status table |
| `lessons/series.ts` | The series' name, Ray's voice and tempo, the music bed, links and disclaimer |
| `lessons/channel.ts` | The YouTube channel, the playlist, each published lesson's video id, and the channel's AI-use answer |
| `lessons/<NN>-<slug>/` | One lesson: `script.ts`, `snippets.ts`, `youtube.ts`, `scenes.tsx`, and the generated `timeline.json` and `youtube.md` |
| `lessons/01-what-is-rayfin/` | The finished first lesson: the model to follow |
| `src/lesson-kit/` | Scene building blocks (see [references/scene-kit.md](references/scene-kit.md)) |
| `src/show/` | The engine: `plan.ts` (timing), `Show.tsx` (playback and mix), `youtube.ts` (description, upload data, end-screen slots) |
| `tools/lesson-*.mjs`, `tools/sfx.mjs` | The lesson tools, run through the `npm run lesson:*` scripts |
| `tools/youtube/` | The YouTube tools, run through `npm run yt:browser`, `yt:driver` and `yt` (see [references/youtube-studio.md](references/youtube-studio.md)) |

## Rules you never break

1. **Teach Rayfin, show only Fabricator.** Fabricator is the only harness that may appear. Show
   Rayfin CLI commands as "under the hood" cards (`CommandCard`, tagged "Fabricator runs this
   for you"). Never show another agent, IDE, chat tool or terminal workflow as the way to work.
2. **Never write Rayfin facts from memory.** Read them, for the lesson's `rayfinVersion`, from:
   - the rayfin.ai pages for the topic. Append `.md` to any page; `https://rayfin.ai/llms.txt`
     lists them all, and section bundles are at `https://rayfin.ai/llms-full/<section>.txt`.
   - the scratch app at `scripts/videos/.cache/rayfin-check/<version>/app`, which
     `npm run lesson:snippets -- <n>` creates. Its `.agents/skills/rayfin/SKILL.md`, its
     `.agents/skills/*`, and `node_modules/@microsoft/rayfin-*/assets/docs/` are version-locked.
     Where they disagree with rayfin.ai, they win.
   - when neither says what happens (as with lesson 5's deletes), the version's own backend. In
     a separate scratch app, with Docker Desktop running, run
     `$env:RAYFIN_FEATURE_FLAGS='docker-local-dev'; npx rayfin dev --provider docker`, try it
     through the client, and note what you ran beside the line. Afterwards, `rayfin dev --down`
     and remove that app's volumes.

   Every line that makes a claim lists its pages in `sources`.
3. **Fabricator facts come from Fabricator.** Use the docs (`website/content/docs/`), the
   `README.md` and the app's source. Quote UI labels exactly. Fabricator is a personal project;
   never imply Microsoft makes or endorses it, or the series.
4. **Code on screen compiles.** Put every snippet a scene shows in `snippets.ts`, add hidden
   snippets that prove what the scenes claim (for example, that each method in a completion
   list exists), and get `npm run lesson:snippets -- <n>` passing.
5. **The user approves the script before any credits are spent.** Show them the whole script,
   the cost from `npm run lesson:voice -- <n> --dry`, the YouTube title, the thumbnail text, the
   challenge prompt and the disclaimer, using the ask_user tool. Voice only after a yes.
6. **Leave other videos alone.** Don't edit the intro's files (`src/Intro.tsx`, `src/scenes/`,
   `script/lines.ts`, `src/timing.ts`, `src/timeline.json`, `public/audio/vo/`,
   `public/audio/music.mp3`), and don't run the intro's `voice`, `music` or `publish` scripts. A
   shared component can gain an optional prop whose default keeps the intro the same. Make new
   effects with `npm run sfx -- <new ids>` only, never `npm run sfx` on its own.
7. **Keys and credits.** Never print the ElevenLabs key. The tools check credits and keep a
   2,000-credit reserve; if they stop, tell the user rather than working around it.
8. **Ray sounds like Ray.** Follow [references/ray-voice.md](references/ray-voice.md).
9. **On YouTube, the user signs in and says yes.** Never type a password or a code for them, and
   ask before publishing or changing anything viewers see. Follow
   [references/youtube-studio.md](references/youtube-studio.md).

## Make a lesson

Run these from `scripts/videos/`. Track the steps as todos.

### 1. Orient

- Read `lessons/SYLLABUS.md`: the lesson's entry, the format, the ground rules and the status
  table. Then read the README's "Learn Rayfin with Ray" section and skim `lessons/01-what-is-rayfin/`.
- Check the current Rayfin release in `https://rayfin.ai/llms.txt` ("Documented against …").
  Lessons pin a version. If a newer one is out than the last lesson's `rayfinVersion`, ask the
  user whether to move up, and read the changelog for anything the earlier lessons now get wrong.
- Read the syllabus entry's sources, as Markdown, into the session folder. Write down each claim
  the lesson will make, with its page, and note any "New in …" tags or availability caveats.

### 2. Start it

```powershell
npm run lesson:new -- <n> <slug> "<Title>"     # e.g. 2 your-first-app "Your first Rayfin app"
```

This creates `lessons/<NN>-<slug>/` with TODO lines in the lesson format, registers the lesson
in `lessons/index.ts`, and marks it as scripting in `SYLLABUS.md`. `npm run studio` plays it at
once as `Lesson<NN>`, an animatic of draft scenes.

### 3. Write the script

Edit `script.ts`, keeping the scaffold's beat ids for the bumper and the quiz (`jingle`,
`countdown`) so lesson 1's scenes carry over, and fill `youtube.ts` (title, summary, challenge,
thumbnail, next lesson).

- **The format:** cold open (a question and a visual payoff, about 12 s) → bumper (`jingle`,
  hold 3.4, the jingle's length, with `volume: 1` on its cue) → welcome and "today" (three
  objectives) → concept chapters → Deep Dive → See it in Fabricator → Pop quiz (question,
  options, "pause and guess", `countdown` hold 3, answer) → recap → challenge → next up → Ray
  fact. Put a `chapter` on each scene that starts one: at least three, each at least 10 s long.
- **Length:** 3–5 minutes. Ray speaks about 13.5 characters a second, so aim for about
  2,400–3,600 spoken characters.
- **Lines:** one idea each, under about 25 words, so a retake is cheap. Use audio tags for
  delivery, and give each claim its `sources`.
- **Accuracy:** say what the docs say, in plain words. Don't promise what the docs hedge, such
  as Functions availability. (Storage is the exception: it ships soon, so lessons treat it as
  released and don't call it experimental.)
- **Get it approved** (rule 5). Apply the edits, then set the lesson's status to Approved.

### 4. Check the code

Write `snippets.ts`. Shown snippets use the Universal App's paths (entities in
`packages/data/src/<Entity>.ts`). Add hidden checks for each claim a scene makes about the API.

```powershell
npm run lesson:snippets -- <n>
```

### 5. Voice it

```powershell
npm run lesson:voice -- <n> --dry      # lines and characters
npm run lesson:voice -- <n>            # new, changed or retaken lines only
npm run lesson:voice -- <n> <id> ...   # those lines again
```

Scan the printed lengths. A line much longer or shorter than its characters suggest (about
13.5 a second) is probably a bad take: give it a new `seed` in `script.ts` and voice that line
again. If Ray says a word wrong, respell it for the voice with the line's `say` (see
[references/ray-voice.md](references/ray-voice.md#saying-code-out-loud)); the captions keep the
word as written. The music bed already exists (`npm run lesson:music` makes it only once). For a new
effect, add it to `EFFECTS` in `tools/sfx.mjs` and its id to `SfxId` in `src/show/types.ts`,
then run `npm run sfx -- <id>`.

### 6. Build the scenes

Replace `draftScenes(SCRIPT)` in `scenes.tsx` with real scenes, one per script scene and in the
same order. Follow [references/scene-kit.md](references/scene-kit.md). Time every beat to Ray's
words (`ctx.w`, `ctx.at`, `ctx.beat`), hand Ray from scene to scene, and find screenshot
coordinates by cropping the screenshot with `sharp` and looking at it.

```powershell
npx tsc --noEmit; npm test
```

### 7. Look at it

```powershell
npm run lesson:sheet -- <n> --scenes            # every scene's start and middle
npm run lesson:sheet -- <n> --frames 120,480    # the moments that matter
```

View the contact sheets (`out/contact-sheet-Lesson<NN>.jpg`) and the full-size stills in
`out/stills/`. Fix what fails the checklist below, then look again. View the
`Lesson<NN>Thumbnail` still too.

### 8. Render and package

```powershell
npm run lesson:render -- <n>     # refuses until every line is voiced and all its audio exists; masters to -16 LUFS
npm run lesson:package -- <n>    # refuses a stale render; video, captions, thumbnail, youtube.md
```

Read the problems `lesson:package` prints, and the "Check before uploading" list in
`youtube.md`. Set the lesson's status in `SYLLABUS.md` to Rendered, and have the user watch the
whole video before it goes up.

### 9. Publish on YouTube

With the user's go-ahead, upload it with the YouTube tools, following
[references/youtube-studio.md](references/youtube-studio.md):

```powershell
npm run yt:browser                         # Edge with its own profile; the user signs in there
npm run yt:driver                          # in an async shell, left running
npm run yt -- upload --lesson <n>          # then details, subtitles, endscreen, visibility
npm run yt -- publish --confirm            # only after the user says yes to the summary
npm run yt -- comment --lesson <n>         # the challenge, pinned
npm run yt -- check --lesson <n>           # as viewers see it
```

Then record the video id in `lessons/channel.ts`, point the previous lesson's end screen at it,
and set the lesson to Published in `SYLLABUS.md` with its link.

### 10. Commit

Commit the lesson's folder (including `timeline.json` and `youtube.md`),
`public/audio/lessons/<slug>/`, any new effects and kit changes, `lessons/channel.ts` and
`SYLLABUS.md`. Renders stay in `out/`, which is gitignored.

## Review checklist

- [ ] Every claim matches its sources for the lesson's Rayfin version; no claim is from memory.
- [ ] `npm run lesson:snippets -- <n>` passes. On-screen code matches `snippets.ts`.
- [ ] Fabricator is the only harness shown, and its labels match the app.
- [ ] The cold open lands a payoff in its first 10 seconds. Something new happens on screen at
      least every 5 seconds, and no stretch is just Ray on empty water for long.
- [ ] Text is at least about 24 px at 1080p, nothing overlaps or clips (keep the left 260 px
      clear in a Deep Dive, for the depth gauge), and Ray never covers what he's explaining.
- [ ] The quiz has exactly one right answer, and the reveal agrees with the docs.
- [ ] Chapters: the first at 0:00, at least three, each at least 10 s (`lesson:package` checks).
- [ ] The end screen's slots are clear for the last 15–20 s, and the disclaimer shows.
- [ ] `npx tsc --noEmit` and `npm test` pass, and the intro's compositions still render.

## When something goes wrong

| You see | Do this |
| --- | --- |
| `"word" (#n) isn't in …` | A scene points at a word its line doesn't have (after a script edit). Fix the scene's cue. |
| `Line "x" changed since it was voiced` | `npm run lesson:voice -- <n> x` |
| `Finish these lines before voicing them` | A line still says TODO. |
| `Lesson <n> needs audio that public/ doesn't have` | Run the command it names for each file (`lesson:voice`, `sfx -- <id>` or `lesson:music`), then render again. |
| `… changed after the render` or `The render has … frames, but lesson <n> now has …` | `lesson:package` won't package a stale render. Render again, then package. |
| A lesson won't open in the Studio | Its error stays inside its own composition (`calculateMetadata`). Read it in the Studio, or run `npm run lesson:sheet -- <n> --frames 10`. |
| `Not enough ElevenLabs credits` | Tell the user. Don't lower `ELEVENLABS_RESERVE` without asking. |
| `lesson:snippets` fails | Read the error for the named snippet, and check the package docs in the scratch app. Fix the snippet, not the check. |
| A screenshot is missing or stale | Refresh it with `scripts/docs-screenshots`, then `npm run assets`. |
| A word comes out wrong in Ray's voice | Respell it for the voice: `say: { APIs: "API's" }` on the line, then `npm run lesson:voice -- <n> <id>`. |
| `The driver isn't running` | `npm run yt:browser`, then `npm run yt:driver` in an async shell. |
| `A driver is already running` | Use it. To restart it, stop its shell first, when no Studio dialog is open. |
| The `status` step says Studio wants a sign-in | Ask the user to sign in to the channel in the browser window `yt:browser` opened, then run `status` again. |
| A YouTube step fails after Studio changed | Read its error and `out/youtube/shots/error.png`, explore with `npm run yt -- -e "…"`, fix the step, and note what changed in references/youtube-studio.md. |
| `Pinning needs the channel's advanced features` | Ask the user to verify in Studio → Settings → Channel → Feature eligibility. |
