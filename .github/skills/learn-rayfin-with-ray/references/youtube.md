# Publishing a lesson on YouTube

`npm run lesson:package -- <n>` makes everything YouTube needs in
`scripts/videos/out/lessons/<slug>/youtube/`: the video, captions, thumbnail, `youtube.md` (what
to paste, and an upload checklist) and `upload.json` (the same, for the YouTube tools). These
are the rules it follows. [youtube-studio.md](youtube-studio.md) is how to upload a lesson with
the tools, and how to change it once it's up.

## The title

- At most 100 characters. Lead with what the viewer learns, then the series and number:
  `What is Rayfin? One TypeScript class, a whole backend | Learn Rayfin with Ray #1`.
- Say "Rayfin" early: it's what people search for.

## The description

It's built from the lesson's files, so fix the files rather than the text:

- `youtube.ts` `summary`: the hook and what the lesson covers, in two or three sentences.
- Chapters: from each scene's `chapter` in `script.ts`. YouTube needs the first at 0:00 (forced),
  at least three, and each at least 10 seconds long; shorter ones are folded into the one before.
- "Learn more": every `sources` URL in `script.ts`, once each, in order, with the Rayfin version
  the lesson was checked against.
- A link to Fabricator, Ray's challenge (`youtube.ts` `challenge`), the series' disclaimer, and
  its hashtags.

At most 5,000 characters. Tags come from the series and `youtube.ts` `tags`, at most 500
characters in all.

## The thumbnail

The `Lesson<NN>Thumbnail` still is drawn at 1920×1080 and delivered as a 1280×720 JPEG under
2 MB. It has to read at the size of a postage stamp:

- At most about five words in two or three lines, with one line in the accent gradient
  (`youtube.ts` `thumbnail.lines`), and a short kicker above (usually the lesson's question).
- Ray big, with a mood that fits (`thumbnail.mood`), and optionally one short code chip
  (`thumbnail.code`).
- The series badge and the lesson's number are drawn for you.

## Captions and the end screen

- Upload `<slug>.en.vtt` as English captions. They're timed from Ray's voice, without audio tags.
- The end screen's elements show from the first whole second of the `next` scene, which draws
  their slots, to the end: at most 20 seconds, and at least 5. A **video** element goes over the
  NEXT UP slot on the left (the next lesson, or the playlist until the next lesson is up) and a
  **subscribe** element over the round slot on the right. The slots are `END_SLOTS` in
  `src/show/youtube.ts`, and `youtube.md` gives the start time as Studio's editor takes it
  (`m:ss:ff`). The `endscreen` step places both.
- The intro, which isn't a lesson, has one element: lesson 1, at its lower left, only while its
  end card is dimmed for the stinger (`introEndScreen` in `lessons/channel.ts`; see
  [youtube-studio.md](youtube-studio.md#the-intro)).

## Settings

- **Audience: not made for kids.** Videos made for kids lose comments and end screens, and every
  lesson asks for both.
- **Category:** Education. **Language:** English. **Paid promotion:** none.
- **AI use:** the channel's answer, `aiUse` in `lessons/channel.ts` (see
  [youtube-studio.md](youtube-studio.md#rules)).
- **Playlist:** Learn Rayfin with Ray, in lesson order, after the Fabricator intro.
- **Pinned comment:** the challenge, from `youtube.md`.

## After it's up

Record its video id in `lessons/channel.ts`, point the previous lesson's end screen at it, check
both, and set the lesson to Published in `SYLLABUS.md` with its link: steps 8 to 12 in
[youtube-studio.md](youtube-studio.md#publish-a-new-lesson). This lesson's `youtube.ts` `next`
already names the one after it.
