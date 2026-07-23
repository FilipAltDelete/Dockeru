// Shared core for the dockeru web server and CLI: Docker access, connected-repo
// storage, compose-project discovery, and the enriched container listing.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Root under which project folders live; compose projects nested one level
// deeper (e.g. <root>/swedsnus/swedsnus-test) get bundled under their parent.
// Resolution order: settings.json (set from the UI) → REPO_ROOT env → the
// folder this app was cloned into.
const DEFAULT_REPO_ROOT = process.env.REPO_ROOT || path.dirname(__dirname);

const DATA_DIR = path.join(__dirname, 'data');
const REPOS_FILE = path.join(DATA_DIR, 'repos.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Read a JSON file, creating it with the fallback value if it doesn't exist.
// A file that exists but can't be parsed is left untouched and the fallback
// is returned, so a corrupt file is never silently overwritten.
function loadJson(file, fallback) {
  if (!fs.existsSync(file)) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2) + '\n');
    } catch {}
    return fallback;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function loadRepos() {
  return loadJson(REPOS_FILE, []);
}
function saveRepos(repos) {
  fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
}

// Resolve 'up'/'down'/'top'/'bottom' or a 1-based position to a clamped index.
function resolveIndex(from, to, len) {
  let idx;
  if (to === 'up') idx = from - 1;
  else if (to === 'down') idx = from + 1;
  else if (to === 'top') idx = 0;
  else if (to === 'bottom') idx = len - 1;
  else {
    idx = parseInt(to, 10) - 1;
    if (Number.isNaN(idx)) throw new Error(`invalid position "${to}" (use up, down, top, bottom or a number)`);
  }
  return Math.max(0, Math.min(len - 1, idx));
}

// Move one connected repo within the list. `to` is 'up', 'down', 'top',
// 'bottom', or a 1-based position; out-of-range positions clamp.
function moveRepo(name, to) {
  const repos = loadRepos();
  const from = repos.findIndex(r => r.name === name);
  if (from === -1) throw new Error(`no connected repository "${name}"`);
  const [repo] = repos.splice(from, 1);
  repos.splice(resolveIndex(from, to, repos.length + 1), 0, repo);
  saveRepos(repos);
  return repos;
}

// Replace the whole order; `orderedNames` must name every repo exactly once.
function reorderRepos(orderedNames) {
  const repos = loadRepos();
  const byName = new Map(repos.map(r => [r.name, r]));
  if (!Array.isArray(orderedNames)
      || orderedNames.length !== repos.length
      || new Set(orderedNames).size !== repos.length
      || orderedNames.some(n => !byName.has(n))) {
    throw new Error('order must list every connected repository exactly once');
  }
  const next = orderedNames.map(n => byName.get(n));
  saveRepos(next);
  return next;
}

function loadSettings() {
  return loadJson(SETTINGS_FILE, {});
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getRepoRoot() {
  return loadSettings().repoRoot || DEFAULT_REPO_ROOT;
}

// Persist a new repo root (empty/undefined reverts to the default).
function setRepoRoot(dir) {
  const settings = loadSettings();
  if (!dir) {
    delete settings.repoRoot;
    saveSettings(settings);
    return DEFAULT_REPO_ROOT;
  }
  const resolved = path.resolve(String(dir));
  let stat;
  try { stat = fs.statSync(resolved); } catch {}
  if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  settings.repoRoot = resolved;
  saveSettings(settings);
  return resolved;
}

// Editor used by the terminal UI's file explorer ('e' on a file).
// Resolution order: settings.json editor → $EDITOR/$VISUAL → vi.
const DEFAULT_EDITOR = process.env.EDITOR || process.env.VISUAL || 'vi';

function getEditor() {
  return loadSettings().editor || DEFAULT_EDITOR;
}

// Persist a new editor command (empty/undefined reverts to the default).
function setEditor(cmd) {
  const settings = loadSettings();
  const clean = String(cmd || '').trim();
  if (clean) settings.editor = clean;
  else delete settings.editor;
  saveSettings(settings);
  return clean || DEFAULT_EDITOR;
}

// GUI editors detach from the terminal immediately; the edit round-trip
// (copy out → edit → copy back) needs them to block until the file is
// closed, so known ones get their wait flag added automatically.
const GUI_EDITOR_WAIT = {
  code: '--wait', 'code-insiders': '--wait', codium: '--wait',
  vscodium: '--wait', subl: '--wait', zed: '--wait',
};

// The command actually run for editing: { cmd, gui, name }.
function editorCommand() {
  const raw = getEditor();
  const name = path.basename(raw.trim().split(/\s+/)[0] || '');
  const wait = GUI_EDITOR_WAIT[name];
  const cmd = wait && !/(^|\s)(--wait|-w)(=|\s|$)/.test(raw) ? `${raw} ${wait}` : raw;
  return { cmd, gui: wait !== undefined, name };
}

// Comparator for top-level container groups (masters and standalone
// projects): saved order first, then alphabetical; the unnamed group last.
// Groups are discovered at runtime, so names missing from the saved order
// simply sort after the ordered ones.
function groupComparator() {
  const order = loadSettings().groupOrder || [];
  const idx = new Map(order.map((n, i) => [n, i]));
  return (a, b) => {
    if ((a === '') !== (b === '')) return a === '' ? 1 : -1;
    const ia = idx.has(a) ? idx.get(a) : Infinity;
    const ib = idx.has(b) ? idx.get(b) : Infinity;
    return ia - ib || a.localeCompare(b);
  };
}

function getGroupOrder() {
  return loadSettings().groupOrder || [];
}

// Persist a display order for container groups (empty array clears it).
function setGroupOrder(names) {
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) {
    throw new Error('order must be an array of group names');
  }
  const settings = loadSettings();
  const clean = [...new Set(names.filter(Boolean))];
  if (clean.length) settings.groupOrder = clean;
  else delete settings.groupOrder;
  saveSettings(settings);
  return clean;
}

// Move one group within the current display order. `allNames` is the full
// list of top-level group names visible right now (the saved order can't be
// used alone — groups appear and disappear with containers on disk).
function moveGroup(name, to, allNames) {
  const names = [...new Set(allNames.filter(Boolean))].sort(groupComparator());
  const from = names.indexOf(name);
  if (from === -1) throw new Error(`no master or project "${name}"`);
  names.splice(from, 1);
  names.splice(resolveIndex(from, to, names.length + 1), 0, name);
  return setGroupOrder(names);
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

function composeFileIn(dir) {
  return COMPOSE_FILES.find(f => fs.existsSync(path.join(dir, f))) || null;
}

// Compose project name defaults to the directory name; a top-level `name:`
// in the compose file overrides it.
function projectNameFor(dir, fallback) {
  try {
    const file = composeFileIn(dir);
    const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/^name:\s*['"]?([\w.-]+)/m);
    if (m) return m[1];
  } catch {}
  return fallback.toLowerCase();
}

// Scan the repo root for compose projects, one or two levels deep. A project
// two levels deep is bundled under its parent ("master") folder.
function findComposeProjects() {
  const root = getRepoRoot();
  const projects = [];
  const entries = dir => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'));
    } catch { return []; }
  };
  for (const top of entries(root)) {
    const d1 = path.join(root, top.name);
    if (composeFileIn(d1)) {
      projects.push({ name: projectNameFor(d1, top.name), dir: d1, parent: null });
      continue;
    }
    for (const sub of entries(d1)) {
      const d2 = path.join(d1, sub.name);
      if (composeFileIn(d2)) {
        projects.push({ name: projectNameFor(d2, sub.name), dir: d2, parent: top.name });
      }
    }
  }
  return projects;
}

async function listContainers() {
  const repos = loadRepos();
  const root = getRepoRoot();
  const containers = await docker.listContainers({ all: true });
  return containers.map(c => {
    const labels = c.Labels || {};
    // Group by compose project when present, else by connected-repo image name
    const group = labels['com.docker.compose.project']
      || (repos.some(r => r.name === (c.Image || '').split(':')[0])
          ? c.Image.split(':')[0] : null);
    // Master folder: compose project dirs nested under a shared parent
    // inside the repo root (e.g. swedsnus/swedsnus-test → "swedsnus")
    let parent = null;
    const wd = labels['com.docker.compose.project.working_dir'] || '';
    const inRoot = wd.startsWith(root + path.sep);
    if (inRoot) {
      const segs = path.relative(root, wd).split(path.sep);
      if (segs.length > 1) parent = segs[0];
    }
    return {
      group,
      parent,
      inRoot,
      service: labels['com.docker.compose.service'] || null,
      // label format: "php:service_started:false,db:service_healthy:true"
      dependsOn: (labels['com.docker.compose.depends_on'] || '')
        .split(',').map(s => s.split(':')[0]).filter(Boolean),
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: [...new Set((c.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => `${p.PublicPort}→${p.PrivatePort}`))],
      created: c.Created,
    };
  });
}

// First published host port of a container, as reported by listContainers()
// (ports look like "8080→80"). null when nothing is published.
function containerUrl(c) {
  const port = (c.ports || []).map(p => parseInt(p, 10)).filter(Boolean).sort((a, b) => a - b)[0];
  return port ? `http://localhost:${port}` : null;
}

// Open a URL in the system's default browser (CLI/terminal-UI side; the
// Electron app goes through shell.openExternal instead).
function openInBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// Split containers into start waves honouring compose depends_on: each wave
// only depends on containers in earlier waves (or ones already running), so
// e.g. nginx doesn't come up before php's DNS name exists and die.
// Mirrored in public/app.js (the browser can't require this file).
function startWaves(containers) {
  const byKey = new Map();
  for (const c of containers) if (c.service) byKey.set(`${c.group}/${c.service}`, c);
  const depth = new Map();
  const calc = (c, stack) => {
    const key = `${c.group}/${c.service}`;
    if (depth.has(key)) return depth.get(key);
    if (stack.has(key)) return 0; // dependency cycle — don't recurse forever
    stack.add(key);
    let d = 0;
    for (const s of c.dependsOn || []) {
      const dep = byKey.get(`${c.group}/${s}`);
      if (dep) d = Math.max(d, calc(dep, stack) + 1);
    }
    stack.delete(key);
    depth.set(key, d);
    return d;
  };
  const waves = [];
  for (const c of containers) {
    const d = c.service ? calc(c, new Set()) : 0;
    (waves[d] = waves[d] || []).push(c);
  }
  return waves.filter(Boolean);
}

module.exports = {
  docker, DEFAULT_REPO_ROOT,
  getRepoRoot, setRepoRoot,
  DEFAULT_EDITOR, getEditor, setEditor, editorCommand,
  loadRepos, saveRepos, moveRepo, reorderRepos,
  groupComparator, getGroupOrder, setGroupOrder, moveGroup,
  composeFileIn, findComposeProjects,
  listContainers, startWaves,
  containerUrl, openInBrowser,
};
