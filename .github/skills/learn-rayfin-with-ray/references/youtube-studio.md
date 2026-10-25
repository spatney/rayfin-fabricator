# Uploading and updating lessons on YouTube

The YouTube tools in `scripts/videos/tools/youtube/` drive YouTube Studio in a real browser that
the user signs in to. They were built while publishing lesson 1 (October 2026). Each step checks
its own work and saves screenshots to `scripts/videos/out/youtube/shots/`; look at them. Studio
changes its pages without notice, so when a step stops working, fix the step rather than working
around it.

What goes on YouTube (title, description, thumbnail, captions, the end screen's layout) is in
[youtube.md](youtube.md). This file is how to get it there, and how to change it later.

## The channel

`scripts/videos/lessons/channel.ts` holds what the tools need to know:

| | |
| --- | --- |
| Channel | Fabricator, `@RayfinFabricator`, `UCbkqoj2jPG5n81qFgBJjpCA` |
| Playlist | "Learn Rayfin with Ray", `PLXW2FECmSE6Q`: public, sorted by date published (oldest first), with the Fabricator intro (`4T1oQmT8Bks`) first |
| `introEndScreen` | Where and when the intro's one end-screen element, lesson 1, shows (see [The intro](#the-intro)) |
| `lessons` | Each published lesson's video id, by number |
| `aiUse` | The channel owner's answer to Studio's "AI use" question: `no` |

The channel has YouTube's advanced features (October 2026), so links in descriptions are
clickable and comments can be pinned.

## Rules

- **The user signs in.** Never type a password, a code or a phone number, and never read the
  browser profile's cookies. When Studio asks for a sign-in or a verification, ask the user to do
  it in the browser window, and wait.
- **Ask before anything viewers see.** Publishing (subscribers are notified), changing a video's
  visibility, deleting anything, and changing a published video's title, description, thumbnail
  or captions all need the user's yes through ask_user, with a summary of what changes. Pointing
  the previous lesson's end screen at a new one is part of publishing that lesson.
- **AI use** is `CHANNEL.aiUse`. YouTube wants a "yes" for AI that makes a real person appear to
  say or do something, alters footage of a real event or place, makes a realistic scene that
  didn't happen, or makes music that's the main focus. The lessons are animated, Ray is a
  cartoon and the music is a bed under his voice, so the owner chose "no". If a lesson changes
  any of that, ask them again.
- **Comments go out as the channel.** The comment step checks that YouTube will post as
  "Fabricator" first.
- **Nothing from the browser goes in the repo.** The browser profile and the driver's token live
  in `%LOCALAPPDATA%\fabricator-videos\youtube\` (`~/.cache/fabricator-videos/youtube/` elsewhere,
  or `YT_STATE`). Screenshots go to `out/`, which git ignores.
- **Don't stop the driver while a Studio dialog is open.** Studio closes the dialog when the
  driver lets go of the browser. A draft is saved as it goes, so nothing is lost, but the dialog
  has to be opened again from Content. Only one driver runs at a time: a second one stops before
  it touches the browser, so to restart it, stop the running one first.

## Set up

Run these from `scripts/videos/`:

```powershell
npm run yt:browser          # Edge, with its own profile and DevTools on 127.0.0.1:9333
npm run yt:driver           # in an async shell, left running: it stays attached to the browser
npm run yt -- status        # signed in? on Fabricator? is a dialog open?
```

The first time on a machine the profile is new: ask the user to sign in to the channel's Google
account in the window `yt:browser` opened, then run `status` again. `npm run yt -- --list` lists
the steps.

## Publish a new lesson

Package it first (`npm run lesson:package -- <n>`). The steps that upload take the video,
thumbnail and captions from `out/lessons/<slug>/youtube/upload.json`, and refuse a package
older than the lesson's files; everything else, every step reads from the lesson's files as
they are. Then, in order:

| # | Run | What it does |
| --- | --- | --- |
| 1 | `npm run yt -- upload --lesson <n>` | Opens Studio's upload dialog and uploads the video. YouTube saves it as a private draft at once; the step logs its link. |
| 2 | `npm run yt -- details --lesson <n>` | Sets and checks the title, the description (replacing the channel's default), the thumbnail, the playlist, "not made for kids", no paid promotion, AI use, tags and category. It warns about anything it couldn't confirm, such as the video language. |
| 3 | `npm run yt -- subtitles --lesson <n>` | Uploads the `.en.vtt` with timing, and checks for "English by you". |
| 4 | `npm run yt -- endscreen --lesson <n>` | Puts the playlist over NEXT UP (the next lesson isn't up yet) and Subscribe over the round slot, from `upload.json`'s `endScreen.start` to the end. |
| 5 | `npm run yt -- visibility --as public` | Picks Public, and reports each step's state and YouTube's checks. It doesn't publish. |
| 6 | ask_user | Show the user the title, playlist, thumbnail, captions, audience, AI use, end screen, visibility and checks, and remind them that subscribers will be notified. |
| 7 | `npm run yt -- publish --confirm` | Publishes, and closes the "Video published" dialog. Only after their yes. |
| 8 | `lessons/channel.ts` | Add the video id to `lessons`. The steps read it fresh each time. |
| 9 | `npm run yt -- comment --lesson <n>` | Posts the challenge as the channel, and pins it. |
| 10 | `npm run yt -- endscreen --lesson <n-1> --video-id <its id> --replace` | Points the previous lesson's NEXT UP at this lesson. |
| 11 | `npm run yt -- check --lesson <n>`, then `--lesson <n-1>` | Checks both as viewers see them: public, title, captions, clickable links, chapters, the end screen on its slots (and, once the next lesson is up, that NEXT UP is its video), the pinned comment, and the playlist's order. |
| 12 | `lessons/SYLLABUS.md` | Set the lesson to Published with its link, and commit it with `channel.ts`. |

Look at each step's screenshot before running the next. If a step fails, read its error and
`error.png`. The steps skip what's already done where they can (`subtitles`, `comment`), so after
a fix you can run the step again.

## Update a published lesson

- **The end screen:** `npm run yt -- endscreen --lesson <n> --video-id <id> --replace`, with
  `--next <video id>` to choose the NEXT UP video yourself. It opens the video's details page,
  deletes the elements there, adds them again and saves; the editor's Save is all it needs. Add
  `--no-save` to look first; to drop that, click Discard changes and reload the page, because the
  editor keeps discarded elements until a reload.
- **The pinned comment:** change the challenge in the lesson's `youtube.ts`, delete the old
  comment in Studio (with the user's yes), and run `comment`. It stops, rather than posting a
  second one, while a different challenge from the channel is still there.
- **Title, description or tags:** change the lesson's files (`youtube.ts`; the description also
  takes the script's chapters and sources), so the repo stays the record. Then, with the user's
  yes, set them on the video's details page (`https://studio.youtube.com/video/<id>/edit`), which
  has the same Title and Description boxes as the upload dialog, with `npm run yt -- -e "…"`. In
  that code, `await studio.loadUpload(<n>)` gives the title, description and tags as the files
  say now. Look at the screenshot, and click the page's Save (`#save`). The lesson's `youtube.md`
  is remade by `lesson:package` after its next render (the video shows parts of `youtube.ts`, so
  packaging waits for one).
- **Chapters gone, description intact:** in October 2026 lesson 4's chapters stopped showing
  after its end screen was replaced, though its description still had every chapter line, and
  `check` failed on "chapters". Re-saving the description brought them back within minutes. On
  the details page the description box is the textbox named "Tell viewers about your video (type
  @ to mention a channel)". Studio ignores trailing whitespace and keeps Save disabled for an
  unchanged text, so, with the user's yes, add a second space inside the last line, Save, remove
  it, and Save again. Check the text before each step, and reload at the end to confirm it reads
  exactly as before.
- **The thumbnail:** it's drawn from `youtube.ts`, so render and package the lesson again, then
  upload the new `thumbnail.jpg` on the details page.
- **Captions:** not scripted yet. In Studio, open the video's subtitles, remove the English
  track, and upload the new `.vtt` with timing.
- **A new cut of the video:** YouTube can't replace a video's file. Upload it as a new video and
  decide with the user what happens to the old one, which keeps its views, comments and links.
  Publish the new cut like a new lesson (steps 1–12), putting its id in `lessons/channel.ts`
  before `comment`, and point the previous lesson's end screen at it. Then, with the user's yes,
  retire the old one on its details page with `npm run yt -- -e "…"`, after checking that
  `page.url()` is that video's: open Visibility (`ytcp-video-metadata-visibility`), pick the
  `tp-yt-paper-radio-button` named `PRIVATE` or `UNLISTED` and click Done; untick the playlist
  in `ytcp-video-metadata-playlists` (the same picker as the upload dialog's); then Save, and
  reload to check. Lesson 2's first cut (`1zYRA5gTwcs`) was made private this way in October
  2026, when the GitHub CLI came out of its prerequisites. If the new cut is lesson 1's, point
  the intro's end screen at it too: `npm run yt -- endscreen --intro --replace`.

## The intro

The Fabricator intro (`CHANNEL.intro`) is first in the playlist, but it isn't a lesson: it was
made before them, its files are off limits, and it draws no end-screen slots. YouTube's smallest
video element is about 620×349 frame px, which doesn't fit beside the intro's end card, so its
end screen is one video element, lesson 1, shown only while the card is dimmed for the stinger:
1:19:00 to 1:24:13, as low and as far left as YouTube allows. It covers the left ends of the
dimmed "Runs on…" line and Download button. The channel's owner chose that over covering the
bright card (October 2026). `introEndScreen` in `lessons/channel.ts` holds the place and times.

```powershell
npm run yt -- endscreen --intro             # lesson 1 (CHANNEL.lessons[1]) on the intro
npm run yt -- endscreen --intro --replace   # again, after lesson 1's video changes
```

`check` doesn't cover the intro. To check it as viewers see it, read
`ytInitialPlayerResponse.endscreen` on its watch page with `npm run yt -- -e "…"`: one `VIDEO`
element for lesson 1's id, from 79000 to 84434 ms.

## How the tools work

- `yt:browser` starts Edge (or Chrome, or `YT_BROWSER`) with `--remote-debugging-port=9333` and a
  profile of its own; Chromium won't open DevTools on a default profile.
- `yt:driver` connects with Playwright (`playwright-core`, pinned) over the DevTools protocol, and
  stays connected. It takes 127.0.0.1:9334 before it attaches, so a second driver stops without
  touching the browser. It answers only requests that carry the token it writes next to the
  profile once it's attached, and runs one step at a time.
- `npm run yt -- <step>` sends a step. `steps/<step>.mjs` exports
  `async ({ page, context, shot, log, args, state }) => …`; `page` is Studio's tab, and `state`
  keeps things between steps, such as the watch-page tab. Steps, `lessons/channel.ts`,
  `lessons/series.ts` and the lessons' files are read fresh on every run. Restart the driver only
  after editing `driver.mjs`, `studio.mjs` or `config.mjs`: stop it (when no Studio dialog is
  open), then start it. `npm run yt -- -e "<code>"` runs code with the same names in scope, and
  `studio` (the helpers in `studio.mjs`), for looking around and one-off changes; a result that
  isn't JSON comes back as a note.
- The steps that don't upload files (`endscreen`, `comment`, `check`) work from the lesson's
  files alone, so they also run where it isn't packaged.

## What Studio does

Things learned the hard way, for when a step needs fixing:

- A tab in the background doesn't paint, so screenshots and drags wait on it forever. The driver
  brings a step's tab to the front.
- Right after a dialog or an editor closes (publishing, or saving an end screen), a
  `page.goto()` can leave the tab where it was, on the Content list or the last video's details
  page, without an error. Check `page.url()` before changing anything on a video's page. The
  `endscreen` step checks, and tries again.
- Every Studio page knows its account and channel: `ytcfg.get('LOGGED_IN')` and
  `ytcfg.get('CHANNEL_ID')`. The sidebar's text changes from page to page.
- The title and description are contenteditable boxes: `getByRole('textbox')` and `fill()` work.
- Clicks on Studio's checkboxes land on a wrapper, and the playlist picker's boxes have no names:
  click the label's text.
- The thumbnail and captions open a file chooser (wait for `filechooser`); the video takes
  `input[type=file]` directly. Handing a lesson (about 27 MB) to that input can take longer
  than Playwright's 15 s default, though Studio still takes it (lesson 3, October 2026), so the
  upload step waits up to 3 minutes.
- The upload dialog's steps are `#step-badge-0` to `#step-badge-3`. Its buttons are
  `#next-button`, `#back-button`, `#done-button` (Publish, or Save), `#subtitles-button` and
  `#endscreens-button`. The AI-use and paid-promotion answers are under "Show more"
  (`#toggle-button`).
- Since October 2026 several of Studio's hosts have no height, so Playwright never counts them as
  visible and `innerText()` reads nothing, while what's in them shows:
  - The upload dialog `ytcp-uploads-dialog`: steps check and work in its panel,
    `ytcp-uploads-dialog tp-yt-paper-dialog` (the first).
  - The "Video published" dialog `ytcp-video-share-dialog`: wait on its `tp-yt-paper-dialog`.
  - The editors' modals, which were both `ytve-modal-host`: now `ytve-captions-editor-modal`
    and `ytve-endscreen-modal`. Read their text with `textContent()`.
- The captions editor's header has `#save-draft-button`, `#publish-button` (Done) and
  `#close-button`.
- The end-screen editor (`ytve-endscreen-modal`; `ytve-modal-host` before October 2026):
  - Its preview (`ytve-endscreen-editor-preview-overlay`) is the frame scaled to its width, about
    480 px. Each element (`ytve-endscreen-editor-preview-overlay-item`) sits where its inline
    `left`, `top`, `width` and `height` say, in preview pixels.
  - Video and playlist elements keep 16:9 and resize from `div.drag.bottom-right`, down to about
    a third of the preview's width (155 of its 480 px, 620×349 in the frame). The subscribe
    element is a fixed circle, about 74 px.
  - Elements stay inside a safe area, about 45 frame px from the left edge and between about
    y 141 and 916, clear of the player's top bar and controls. A drag past it stops at its edge.
  - A drag can land a few pixels off (Subscribe, 4 px low on lesson 3's): drag again from where
    it landed. The `endscreen` step does.
  - The preview moves when the options panel changes height, so measure it again before each
    drag.
  - Times are `m:ss:ff`, typed into the options panel's two inputs: from and to. An element can
    end before the video does (the intro's does).
  - A click on an element in the preview selects it; its row in the timeline is covered by a time
    handle. `#delete` deletes the selected element.
  - Deleted and discarded elements stay in the page until a reload: rows at opacity 0, and items
    without their `visible` class.
  - Elements that overlap, or sit too close, get "End Screen elements cannot overlap…", and
    won't save.
  - On a published video, the editor opens from `#endscreen-editor-link` on its details page.
- The Verify link in a "Get advanced features" dialog lands on the dashboard. Verification lives
  in Settings → Channel → Feature eligibility.
- A comment's ⋮ is the button named "Action menu", and Pin asks "Pin this comment?" to confirm.
  In a comment thread, `#author-text` is the author's handle and `#content-text` the text as
  written. `#pinned-comment-badge` is on every comment, empty; a pinned one's says "Pinned by …".
