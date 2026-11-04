'use strict';
// Renders the product shots in dev/stage.html with headless Chrome and saves
// them as 1600x900 JPGs in docs/media (the website and README use them).
// Needs the preview server running (node dev/serve.js) and ffmpeg on PATH.
//   node dev/shots.js [shot ...]
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ALL = ['hero', 'pair', 'activity', 'conflict', 'safety', 'trash', 'paused', 'languages'];
const shots = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const out = path.join(__dirname, '..', 'docs', 'media');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folderbridge-shots-'));
fs.mkdirSync(out, { recursive: true });

for (const shot of shots) {
  const png = path.join(tmp, `${shot}.png`);
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=1600,900',
    '--virtual-time-budget=6000',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--screenshot=${png}`,
    `http://localhost:5179/dev/stage.html?shot=${shot}`,
  ], { stdio: 'ignore' });
  const jpg = path.join(out, `${shot}.jpg`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-vf', 'scale=1600:900:flags=lanczos', '-q:v', '3', jpg]);
  console.log('wrote', path.relative(process.cwd(), jpg));
}
