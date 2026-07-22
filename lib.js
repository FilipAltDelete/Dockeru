// Shared core for the dockeru web server and CLI: Docker access, connected-repo
// storage, compose-project discovery, and the enriched container listing.
const fs = require('fs');
const path = require('path');
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

function loadRepos() {
  try { return JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')); }
  catch { return []; }
}
function saveRepos(repos) {
  fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
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

module.exports = {
  docker, DEFAULT_REPO_ROOT,
  getRepoRoot, setRepoRoot,
  loadRepos, saveRepos,
  composeFileIn, findComposeProjects,
  listContainers,
};
