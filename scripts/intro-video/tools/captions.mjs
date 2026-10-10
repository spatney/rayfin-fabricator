// Captions and the transcript, from the voiceover's character timings. Pure functions, so
// they're unit-tested (captions.test.mjs) and shared by voice.mjs and publish.mjs.

const PUNCTUATION_END = /[,.!?…:;]$/;
const SENTENCE_END = /[.!?…]$/;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Words and their timings (ms) from an ElevenLabs character alignment. Audio tags such as
 * `[excited]` are skipped, and punctuation that stands alone joins the word before it.
 * `tempo` scales the timings when the audio was sped up or slowed down afterwards.
 */
export function wordsFromAlignment(alignment, { tempo = 1 } = {}) {
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const words = [];
  let depth = 0;
  let word = null;

  const flush = () => {
    if (!word) return;
    if (HAS_WORD.test(word.text) || words.length === 0) words.push(word);
    else {
      const last = words[words.length - 1];
      last.text += word.text;
      last.endMs = Math.max(last.endMs, word.endMs);
    }
    word = null;
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '[') {
      flush();
      depth++;
      continue;
    }
    if (c === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    const startMs = Math.round((starts[i] * 1000) / tempo);
    const endMs = Math.round((ends[i] * 1000) / tempo);
    if (!word) word = { text: c, startMs, endMs };
    else {
      word.text += c;
      word.endMs = endMs;
    }
  }
  flush();
  return words;
}

const textOf = (words) => words.map((w) => w.text).join(' ');

/**
 * Groups timed words into caption cues of at most `maxChars` characters. A cue ends at a
 * sentence once it's reasonably long, and an overlong cue breaks after its last comma or
 * full stop rather than mid-phrase.
 */
export function buildCues(words, { maxChars = 42 } = {}) {
  const groups = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    if (current.length > 1 && textOf(current).length > maxChars) {
      let cut = current.length - 2;
      for (let k = current.length - 2; k >= 0; k--) {
        if (PUNCTUATION_END.test(current[k].text) && textOf(current.slice(0, k + 1)).length >= maxChars * 0.35) {
          cut = k;
          break;
        }
      }
      groups.push(current.slice(0, cut + 1));
      current = current.slice(cut + 1);
    } else if (SENTENCE_END.test(word.text) && textOf(current).length >= maxChars * 0.5) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups.map((ws) => ({ text: textOf(ws), startMs: ws[0].startMs, endMs: ws[ws.length - 1].endMs }));
}

/**
 * Lets each cue stay up for at least `minMs` (short cues are hard to read) without running
 * into the next one. Cues must be sorted by start time.
 */
export function holdCues(cues, { minMs = 1000, gapMs = 60, maxHoldMs = 700 } = {}) {
  return cues.map((cue, i) => {
    const next = cues[i + 1];
    const limit = next ? next.startMs - gapMs : Infinity;
    const wanted = Math.max(cue.endMs + 250, cue.startMs + minMs);
    const endMs = Math.min(limit, wanted, cue.endMs + maxHoldMs + Math.max(0, minMs - (cue.endMs - cue.startMs)));
    return { ...cue, endMs: Math.max(cue.endMs, Math.min(endMs, limit)) };
  });
}

function stamp(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const msPart = total % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msPart, 3)}`;
}

export function toVtt(cues) {
  const body = cues.map((cue, i) => `${i + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}`).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/**
 * Every cue of the video: each line's words, shifted to where the line starts in the video.
 * `starts` maps a line id to its start in ms.
 */
export function videoCues(lines, starts, options) {
  const cues = [];
  for (const line of lines) {
    const offset = starts[line.id];
    if (offset === undefined) continue;
    const words = line.words.map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset }));
    cues.push(...buildCues(words, options));
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return holdCues(cues);
}
