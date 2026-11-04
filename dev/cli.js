'use strict';
// FolderBridge without the app window: syncs one folder from the terminal.
// Used to try the engine before the Electron shell exists.
//
//   node dev/cli.js --name Mac --folder dev/sandbox/Mac --port 47811 --peer 127.0.0.1:47821
//   node dev/cli.js --name PC  --folder dev/sandbox/PC  --port 47821 --peer 127.0.0.1:47811 --code <same code>
//
// Then drop files into either folder. Type "help" for commands.
const path = require('path');
const readline = require('readline');
const { FolderSync } = require('../src/main/folder');
const { generateCode, formatCode, isValidCode } = require('../src/main/code');

function parseArgs(argv) {
  const out = { peer: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (key === 'peer') out.peer.push(val);
    else out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.folder || args.help) {
  console.log('Usage: node dev/cli.js --folder <path> [--name <device name>] [--code <code>] [--port <n>] [--peer host:port] [--data <path>] [--verbose]');
  process.exit(args.help ? 0 : 1);
}
const name = args.name || require('os').hostname();
const folder = path.resolve(args.folder);
const dataDir = path.resolve(args.data || path.join(__dirname, 'sandbox', `.data-${name}`));
const code = args.code && isValidCode(args.code) ? formatCode(args.code) : generateCode();

const time = () => new Date().toTimeString().slice(0, 8);
const say = (line) => console.log(`[${time()}] ${line}`);
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

const sync = new FolderSync({
  root: folder,
  dataDir,
  deviceName: name,
  code,
  port: args.port ? Number(args.port) : undefined,
  manualPeers: args.peer,
  createRoot: true,
  log: args.verbose ? (...a) => say(`(log) ${a.join(' ')}`) : () => {},
});

const STATES = {
  'up-to-date': () => 'Up to date',
  syncing: (s) => `Syncing ${s.pending} ${s.pending === 1 ? 'file' : 'files'}${s.bytesLeft ? ` - ${size(s.bytesLeft)} left` : ''}`,
  alone: () => 'Other computer not found',
  paused: () => 'Paused',
  conflicts: (s) => `${s.conflicts} ${s.conflicts === 1 ? 'conflict needs' : 'conflicts need'} your choice - type "conflicts"`,
  'confirm-delete': (s) => `${s.holdDeletes} files would be deleted - type "approve" or "keep"`,
  unavailable: () => 'Folder not available',
};

let lastStatus = '';
sync.on('status', (s) => {
  const line = `${STATES[s.state](s)} · ${s.files} ${s.files === 1 ? 'file' : 'files'}`;
  if (line !== lastStatus) say(`Status: ${line}`);
  lastStatus = line;
});

let lastPeers = '';
sync.on('peers', (peers, foreign) => {
  const now = peers.filter((p) => p.online).map((p) => `${p.name} (${p.address})`).join(', ');
  if (now !== lastPeers) say(now ? `Connected: ${now}` : 'No other computer connected');
  lastPeers = now;
  for (const f of foreign) say(`Found "${f.name}" with a different code`);
});

// Print new activity as it happens (not the history from earlier runs).
const startedAt = Date.now();
let seen = 0;
setInterval(() => {
  const items = sync.activity.items;
  for (; seen < items.length; seen++) {
    const e = items[seen];
    if (e.ts < startedAt) continue;
    const where = e.local ? 'this computer' : `from ${e.device}`;
    const mark = { added: '+', changed: '~', deleted: '-', moved: '>', conflict: '!', restored: '<' }[e.action];
    const extra = e.action === 'moved' ? ` (was ${e.from})` : e.action === 'deleted' && !e.local ? ' - kept in the trash' : '';
    say(`${mark} ${e.path}${extra} (${where})`);
  }
}, 300).unref();

const help = `Commands:
  status                 where things stand
  conflicts              list conflicts waiting for a choice
  keep <n> mine|theirs|both   settle conflict n
  mode ask|both|newest   how conflicts are handled (for all computers)
  trash                  list the trash
  restore <n>            put trash item n back
  approve | keep         answer "many files would be deleted"
  pause | resume
  quit`;

async function command(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case '':
        return;
      case 'help':
        return console.log(help);
      case 'status': {
        const s = sync.getStatus();
        console.log(`${STATES[s.state](s)} · ${s.files} files · conflicts: ${s.conflictMode}`);
        for (const p of s.peers) console.log(`  ${p.online ? 'online ' : 'offline'} ${p.name} ${p.address || ''}:${p.port || ''}`);
        for (const p of s.problems) console.log(`  problem: ${p.type} ${p.path || ''}`);
        return;
      }
      case 'conflicts': {
        const list = sync.getConflicts();
        if (!list.length) return console.log('No conflicts.');
        list.forEach((c, i) => console.log(`  ${i + 1}. ${c.path} - mine ${c.local ? size(c.local.size) : 'deleted'}, ${c.remote.device}'s ${size(c.remote.size)}`));
        return;
      }
      case 'keep': {
        if (rest.length === 0) return sync.keepFiles();
        const c = sync.getConflicts()[Number(rest[0]) - 1];
        const choice = { mine: 'local', theirs: 'remote', both: 'both' }[rest[1]];
        if (!c || !choice) return console.log('Usage: keep <n> mine|theirs|both');
        await sync.resolveConflict(c.id, choice);
        return say(`Settled: ${c.path}`);
      }
      case 'mode':
        sync.setConflictMode(rest[0]);
        return say(`Conflicts: ${rest[0]}`);
      case 'trash': {
        const items = sync.getTrash();
        if (!items.length) return console.log('The trash is empty.');
        items.slice(0, 30).forEach((t, i) => console.log(`  ${i + 1}. ${t.path} (${t.reason}, ${new Date(t.at).toLocaleString()})`));
        return;
      }
      case 'restore': {
        const t = sync.getTrash()[Number(rest[0]) - 1];
        if (!t) return console.log('Usage: restore <n> (see "trash")');
        return say(`Restored as ${await sync.restoreFromTrash(t.id)}`);
      }
      case 'approve':
        return sync.approveDeletes();
      case 'pause':
        return sync.setPaused(true);
      case 'resume':
        return sync.setPaused(false);
      case 'quit':
      case 'exit':
        sync.stop();
        return process.exit(0);
      default:
        console.log(`Unknown command. ${help}`);
    }
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
}

(async () => {
  console.log(`FolderBridge (dev CLI) - ${name}`);
  console.log(`  Folder: ${folder}`);
  console.log(`  Code:   ${code}`);
  await sync.start();
  console.log(`  Port:   ${sync.engine.port}${args.peer.length ? `  (peers: ${args.peer.join(', ')})` : ''}`);
  console.log('Type "help" for commands.');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', command);
  rl.on('close', () => {
    // No terminal (e.g. started in the background): keep running.
  });
  process.on('SIGINT', () => {
    sync.stop();
    process.exit(0);
  });
})();
