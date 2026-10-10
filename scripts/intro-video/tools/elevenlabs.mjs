// A small ElevenLabs client for the intro video's maintainer scripts.
//
// Node only. Nothing in src/ imports this file, so the API key can never end up in the
// Remotion bundle. The key comes from ELEVENLABS_API_KEY or from `ElevenLabsKey=…` in the
// repository's gitignored .keys file. It is never printed: error messages are redacted.
//
// Every request is cached in .cache/ by a hash of what was asked, so rerunning a script
// after a failure, or after tweaking an unrelated line, doesn't spend credits twice.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO, ROOT } from './paths.mjs';

export { REPO, ROOT };

const API = 'https://api.elevenlabs.io';
const CACHE = path.join(ROOT, '.cache', 'elevenlabs');
/** Credits a script must leave untouched. Override with ELEVENLABS_RESERVE. */
const RESERVE = Number(process.env.ELEVENLABS_RESERVE ?? 2000);

let key;

function readKey() {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(REPO, '.keys');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*ElevenLabsKey\s*[=:]\s*(.+?)\s*$/.exec(line);
      if (match) return match[1].replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error(
    'No ElevenLabs API key. Set ELEVENLABS_API_KEY, or add ElevenLabsKey=<key> to the .keys file at the repository root.',
  );
}

function redact(text) {
  return key ? String(text).split(key).join('[redacted]') : String(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, route, { json, query } = {}) {
  key ??= readKey();
  const url = new URL(route, API);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'xi-api-key': key, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : undefined,
      });
    } catch (err) {
      if (attempt < 4) {
        await sleep(1500 * attempt);
        continue;
      }
      throw new Error(redact(`ElevenLabs ${method} ${url.pathname} failed: ${err.message}`));
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2000 * attempt * attempt);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(redact(`ElevenLabs ${method} ${url.pathname} returned ${res.status}: ${body.slice(0, 800)}`));
      error.status = res.status;
      throw error;
    }
    return res;
  }
}

function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/** Runs `produce` once per distinct `request`; later calls read the cached result. */
async function cached(request, ext, produce) {
  const file = path.join(CACHE, `${hashOf(request)}.${ext}`);
  if (existsSync(file)) return { file, data: await readFile(file), fresh: false };
  const data = await produce();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, data);
  return { file, data, fresh: true };
}

export async function subscription() {
  const s = await (await call('GET', '/v1/user/subscription')).json();
  return { tier: s.tier, used: s.character_count, limit: s.character_limit, left: s.character_limit - s.character_count };
}

/** Throws unless `estimate` credits can be spent while keeping the reserve. */
export async function ensureCredits(estimate, what) {
  const { left } = await subscription();
  if (left - estimate < RESERVE) {
    throw new Error(
      `Not enough ElevenLabs credits for ${what}: about ${estimate} needed, ${left} left, ${RESERVE} kept in reserve.`,
    );
  }
  return left;
}

export async function listVoices() {
  const res = await call('GET', '/v2/voices', { query: { page_size: 100 } });
  return (await res.json()).voices;
}

/**
 * Speech with character timings. `eleven_v4` is served by the dialogue endpoint (one turn,
 * one voice); other models use text to speech. Returns the MP3 and the alignment of the
 * text as written (audio tags included, with zero-length timings).
 */
export async function speak({ voiceId, text, modelId = 'eleven_v4', seed, settings, outputFormat = 'mp3_44100_128' }) {
  const dialogue = modelId.startsWith('eleven_v4');
  const route = dialogue ? '/v1/text-to-dialogue/with-timestamps' : `/v1/text-to-speech/${voiceId}/with-timestamps`;
  const body = dialogue
    ? { inputs: [{ text, voice_id: voiceId }], model_id: modelId, seed, settings }
    : { text, model_id: modelId, seed, voice_settings: settings };
  const query = { output_format: outputFormat };
  const { data, fresh } = await cached({ route, body, query }, 'json', async () => {
    const res = await call('POST', route, { json: body, query });
    const json = await res.json();
    json.request_id = res.headers.get('request-id') ?? undefined;
    return Buffer.from(JSON.stringify(json));
  });
  const json = JSON.parse(data.toString('utf8'));
  return {
    audio: Buffer.from(json.audio_base64, 'base64'),
    alignment: json.alignment ?? null,
    normalizedAlignment: json.normalized_alignment ?? null,
    requestId: json.request_id,
    fresh,
  };
}

export async function soundEffect({ text, durationSeconds, promptInfluence = 0.45, loop = false }) {
  const body = {
    text,
    model_id: 'eleven_text_to_sound_v2',
    duration_seconds: durationSeconds,
    prompt_influence: promptInfluence,
    loop,
  };
  const query = { output_format: 'mp3_44100_128' };
  const { data, fresh } = await cached({ route: '/v1/sound-generation', body, query }, 'mp3', async () =>
    Buffer.from(await (await call('POST', '/v1/sound-generation', { json: body, query })).arrayBuffer()),
  );
  return { audio: data, fresh };
}

export async function music({ prompt, lengthMs, modelId = 'music_v2_5' }) {
  const body = { prompt, music_length_ms: lengthMs, model_id: modelId, force_instrumental: true };
  const { data, fresh } = await cached({ route: '/v1/music', body }, 'mp3', async () =>
    Buffer.from(await (await call('POST', '/v1/music', { json: body })).arrayBuffer()),
  );
  return { audio: data, fresh };
}

/** Voice Design: previews for a described voice. Each preview has an id and an MP3. */
export async function designVoice({ description, text, modelId = 'eleven_ttv_v3', seed, guidanceScale }) {
  const body = {
    voice_description: description,
    model_id: modelId,
    text,
    seed,
    guidance_scale: guidanceScale,
    auto_generate_text: false,
  };
  const { data, fresh } = await cached({ route: '/v1/text-to-voice/design', body }, 'json', async () =>
    Buffer.from(JSON.stringify(await (await call('POST', '/v1/text-to-voice/design', { json: body })).json())),
  );
  const json = JSON.parse(data.toString('utf8'));
  return {
    previews: (json.previews ?? []).map((p) => ({
      id: p.generated_voice_id,
      audio: Buffer.from(p.audio_base_64 ?? p.audio_base64 ?? '', 'base64'),
      durationSecs: p.duration_secs,
    })),
    fresh,
  };
}

/** Saves a Voice Design preview as a voice in the account, so text to speech can use it. */
export async function saveDesignedVoice({ name, description, generatedVoiceId }) {
  const body = { voice_name: name, voice_description: description, generated_voice_id: generatedVoiceId };
  const res = await call('POST', '/v1/text-to-voice', { json: body });
  return (await res.json()).voice_id;
}
