// Auditions for Ray's voice: the first two lines of the script read by a few library voices
// and by voices designed from a description of Ray. Writes MP3s to out/auditions/ and opens
// the folder. Put the chosen voice in VOICE in script/lines.ts; a designed voice is saved to
// the account first with `node tools/audition.mjs --save <designed-id> "<name>"`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, designVoice, ensureCredits, saveDesignedVoice, speak } from './elevenlabs.mjs';
import { LINES } from '../script/lines.ts';

const OUT = path.join(ROOT, 'out', 'auditions');

/** Expressive young voices from the account's library. */
const CANDIDATES = [
  { name: 'Hale v3 (expressive)', voiceId: 'wWWn96OtTHu1sn8SRGEr' },
  { name: 'Alex (upbeat)', voiceId: 'yl2ZDV1MzN4HbQJbMihG' },
  { name: 'Liam (energetic)', voiceId: 'TX3LPaxmHKxFdv7VOQHJ' },
  { name: 'Ed (comedic)', voiceId: '3IwIPyXc0WRkgKBE8KXP' },
];

export const RAY_DESCRIPTION =
  'A bubbly, cheerful cartoon sidekick: a small stingray with a bright, youthful, slightly high-pitched male voice. ' +
  'Playful, warm and animated, with quick comic timing and a smile you can hear. American accent. Clean studio recording.';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function audition() {
  const text = LINES.slice(0, 2)
    .map((line) => line.text)
    .join(' ');
  await mkdir(OUT, { recursive: true });
  // Each library read costs about one credit per character; a design call returns three
  // previews of the same text.
  await ensureCredits(text.length * (CANDIDATES.length + 3), 'the auditions');

  const files = [];
  for (const [i, voice] of CANDIDATES.entries()) {
    const { audio } = await speak({ voiceId: voice.voiceId, text, modelId: 'eleven_v4' });
    const file = path.join(OUT, `${String(i + 1).padStart(2, '0')}-${slug(voice.name)}.mp3`);
    await writeFile(file, audio);
    files.push(file);
  }

  const { previews } = await designVoice({ description: RAY_DESCRIPTION, text });
  const designed = [];
  for (const [i, preview] of previews.entries()) {
    const file = path.join(OUT, `${String(CANDIDATES.length + i + 1).padStart(2, '0')}-designed-ray-${i + 1}.mp3`);
    await writeFile(file, preview.audio);
    designed.push({ file: path.basename(file), generatedVoiceId: preview.id });
    files.push(file);
  }
  await writeFile(path.join(OUT, 'designed.json'), JSON.stringify(designed, null, 2));

  for (const file of files) console.log(path.relative(ROOT, file));
  if (process.platform === 'win32') spawn('explorer.exe', [OUT], { detached: true, stdio: 'ignore' }).unref();
}

async function save(file, name) {
  const designed = JSON.parse(await readFile(path.join(OUT, 'designed.json'), 'utf8'));
  const pick = designed.find((d) => d.file === file || d.file.startsWith(file));
  if (!pick) throw new Error(`No designed audition matches ${file}`);
  const voiceId = await saveDesignedVoice({ name, description: RAY_DESCRIPTION, generatedVoiceId: pick.generatedVoiceId });
  console.log(`Saved "${name}" as voice ${voiceId}. Put it in VOICE in script/lines.ts.`);
}

const [flag, ...rest] = process.argv.slice(2);
(flag === '--save' ? save(rest[0], rest[1] ?? 'Ray (Fabricator)') : audition()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
