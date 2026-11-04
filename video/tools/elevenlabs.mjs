// Voiceover, music and sound effects from ElevenLabs, with the API key read
// from the project's .env (never committed, never printed).
//
//   node tools/elevenlabs.mjs voices
//   node tools/elevenlabs.mjs tts <narration.json> <out.mp3>   (also writes <out>.alignment.json)
//   node tools/elevenlabs.mjs music "<prompt>" <seconds> <out.mp3>
//   node tools/elevenlabs.mjs sfx "<prompt>" <seconds> <out.mp3>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.elevenlabs.io/v1';

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  for (const file of [path.join(here, '..', '.env'), path.join(here, '..', '..', '.env')]) {
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  throw new Error('ELEVENLABS_API_KEY not found in the environment or .env');
}

async function call(urlPath, { method = 'GET', body, json = true } = {}) {
  const res = await fetch(API + urlPath, {
    method,
    headers: { 'xi-api-key': apiKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return json ? res.json() : Buffer.from(await res.arrayBuffer());
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'voices') {
  const { voices } = await call('/voices');
  for (const v of voices) {
    const l = v.labels || {};
    console.log([v.voice_id, v.name, v.category, l.gender, l.age, l.accent, l.description || l.descriptive, l.use_case].filter(Boolean).join(' | '));
  }
} else if (cmd === 'tts') {
  const [specFile, out] = args;
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const text = spec.lines.map((l) => l.text).join(spec.joiner || ' ');
  const result = await call(`/text-to-speech/${spec.voice_id}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    body: { text, model_id: spec.model_id, voice_settings: spec.voice_settings, seed: spec.seed },
  });
  fs.writeFileSync(out, Buffer.from(result.audio_base64, 'base64'));
  fs.writeFileSync(out.replace(/\.mp3$/, '.alignment.json'), JSON.stringify({ text, alignment: result.alignment }, null, 1));
  console.log('wrote', out);
} else if (cmd === 'music') {
  const [prompt, seconds, out] = args;
  const audio = await call('/music?output_format=mp3_44100_128', {
    method: 'POST',
    json: false,
    body: { prompt, music_length_ms: Math.round(Number(seconds) * 1000), model_id: 'music_v1', force_instrumental: true },
  });
  fs.writeFileSync(out, audio);
  console.log('wrote', out);
} else if (cmd === 'sfx') {
  const [prompt, seconds, out] = args;
  const audio = await call('/sound-generation?output_format=mp3_44100_128', {
    method: 'POST',
    json: false,
    body: { text: prompt, duration_seconds: Number(seconds), prompt_influence: 0.5 },
  });
  fs.writeFileSync(out, audio);
  console.log('wrote', out);
} else {
  console.log('usage: voices | tts <narration.json> <out.mp3> | music "<prompt>" <seconds> <out.mp3> | sfx "<prompt>" <seconds> <out.mp3>');
}
