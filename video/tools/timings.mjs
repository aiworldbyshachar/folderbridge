// Turns the ElevenLabs character alignment into line and word timings, so
// every beat of the film can start on the word that says it.
//   node tools/timings.mjs narration.json assets/audio/voiceover.alignment.json > timings.json
import fs from 'node:fs';

const [specFile, alignFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const { alignment } = JSON.parse(fs.readFileSync(alignFile, 'utf8'));
const chars = alignment.characters;
const starts = alignment.character_start_times_seconds;
const ends = alignment.character_end_times_seconds;
const spoken = chars.join('');

// Words with times, from the alignment itself.
const words = [];
let cur = null;
for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  if (/\s/.test(c)) {
    if (cur) words.push(cur);
    cur = null;
    continue;
  }
  if (!cur) cur = { text: '', start: starts[i], end: ends[i], index: i };
  cur.text += c;
  cur.end = ends[i];
}
if (cur) words.push(cur);

// Each line is found in the spoken text in order (audio tags such as [sighs] may be dropped).
const clean = (s) => s.replace(/\[[^\]]*\]\s*/g, '').trim();
let from = 0;
const lines = spec.lines.map((line) => {
  const text = clean(line.text);
  const at = spoken.indexOf(text.slice(0, 12), from);
  if (at < 0) throw new Error(`line not found in alignment: ${line.id}`);
  const last = at + text.length - 1;
  from = last + 1;
  const lineWords = words.filter((w) => w.index >= at && w.index <= last).map(({ text: t, start, end }) => ({ text: t, start: +start.toFixed(3), end: +end.toFixed(3) }));
  return { id: line.id, text, start: +starts[at].toFixed(3), end: +ends[last].toFixed(3), words: lineWords };
});

console.log(JSON.stringify({ duration: +ends[ends.length - 1].toFixed(3), lines }, null, 1));
