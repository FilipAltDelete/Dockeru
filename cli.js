#!/usr/bin/env node
// dockeru CLI — manage containers, images and repo builds without the web UI.
const { spawn } = require('child_process');
const {
  docker, DEFAULT_REPO_ROOT, getRepoRoot, setRepoRoot,
  loadRepos, saveRepos, findComposeProjects, listContainers,
} = require('./lib');

const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const tty = process.stdout.isTTY;
const col = (c, s) => (tty ? CODES[c] + s + CODES.reset : s);

function die(msg) {
  console.error(col('red', msg));
  process.exit(1);
}

// Run docker with inherited stdio (live output, progress bars, -f logs, …)
function sh(args, opts = {}) {
  return new Promise(resolve => {
    spawn('docker', args, { stdio: 'inherit', ...opts })
      .on('close', code => resolve(code));
  });
}

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' kB';
}

// ---------- ps ----------

async function cmdPs(args) {
  const runningOnly = args.includes('-r') || args.includes('--running');
  const showAll = args.includes('-a') || args.includes('--all');
  let cs = await listContainers();
  // Like the web UI: only containers whose compose project lives under the
  // repo folder, unless -a/--all
  if (!showAll) cs = cs.filter(c => c.inRoot);
  if (runningOnly) cs = cs.filter(c => c.state === 'running');
  const projects = findComposeProjects();

  const masters = new Map();    // master -> Map(project -> containers)
  const standalone = new Map(); // project ('' = ungrouped) -> containers
  for (const p of projects) {
    if (p.parent) {
      if (!masters.has(p.parent)) masters.set(p.parent, new Map());
      if (!masters.get(p.parent).has(p.name)) masters.get(p.parent).set(p.name, []);
    } else if (!standalone.has(p.name)) {
      standalone.set(p.name, []);
    }
  }
  for (const c of cs) {
    if (c.parent) {
      if (!masters.has(c.parent)) masters.set(c.parent, new Map());
      const m = masters.get(c.parent);
      if (!m.has(c.group)) m.set(c.group, []);
      m.get(c.group).push(c);
    } else {
      const key = c.group || '';
      if (!standalone.has(key)) standalone.set(key, []);
      standalone.get(key).push(c);
    }
  }

  const dot = s => (s === 'running' ? col('green', '●') : col('dim', '○'));
  const printGroup = (name, items, indent) => {
    const running = items.filter(c => c.state === 'running').length;
    const sub = items.length ? `${running}/${items.length} running` : 'not created';
    console.log(`${indent}${col('bold', '📦 ' + (name || 'other'))}  ${col('dim', sub)}`);
    for (const c of items) {
      const ports = c.ports.length ? '  ' + c.ports.join(' ') : '';
      console.log(`${indent}   ${dot(c.state)} ${c.name.padEnd(38)} ${c.state.padEnd(8)} ${col('dim', c.image + ports)}`);
    }
  };

  const entries = [
    ...[...masters.keys()].map(name => ({ name, master: true })),
    ...[...standalone.keys()].map(name => ({ name, master: false })),
  ].sort((a, b) => (a.name === '') - (b.name === '') || a.name.localeCompare(b.name));

  for (const e of entries) {
    if (!e.master) {
      if (runningOnly && !standalone.get(e.name).length) continue;
      printGroup(e.name, standalone.get(e.name), '');
      continue;
    }
    const inner = masters.get(e.name);
    const all = [...inner.values()].flat();
    if (runningOnly && !all.length) continue;
    const running = all.filter(c => c.state === 'running').length;
    console.log(`${col('bold', '🗂  ' + e.name)}  ${col('dim', `${inner.size} projects · ${running}/${all.length} running`)}`);
    for (const p of [...inner.keys()].sort()) {
      if (runningOnly && !inner.get(p).length) continue;
      printGroup(p, inner.get(p), '   ');
    }
  }
}

// ---------- start / stop / restart ----------

async function cmdAction(action, name) {
  if (!name) die(`usage: dockeru ${action} <master|project|container>`);
  const cs = await listContainers();
  let targets = cs.filter(c => c.parent === name);
  if (!targets.length) targets = cs.filter(c => c.group === name);
  if (!targets.length) targets = cs.filter(c => c.name === name || c.id.startsWith(name));
  if (!targets.length) {
    const proj = findComposeProjects().find(p => p.name === name || p.parent === name);
    if (proj) die(`"${name}" has no containers yet — run: dockeru up ${name}`);
    die(`nothing matches "${name}"`);
  }
  if (action === 'start') targets = targets.filter(c => c.state !== 'running');
  if (action === 'stop') targets = targets.filter(c => c.state === 'running');
  if (!targets.length) return console.log(`nothing to ${action}`);

  if (await applyAction(action, targets)) process.exit(1);
}

// Run a container action on all targets in parallel, print per-container
// results, return the number of failures.
async function applyAction(action, targets) {
  const results = await Promise.allSettled(
    targets.map(c => docker.getContainer(c.id)[action]()));
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`${col('green', '✓')} ${action} ${targets[i].name}`);
    } else {
      failed++;
      console.log(`${col('red', '✗')} ${action} ${targets[i].name}\n  ${col('red', r.reason.message.trim())}`);
    }
  });
  return failed;
}

// ---------- switch ----------

// Stop everything running except the target, then bring the target up.
async function cmdSwitch(name) {
  if (!name) die('usage: dockeru switch <master|project|container>');
  const cs = await listContainers();
  const inTarget = c => c.parent === name || c.group === name
    || c.name === name || c.id.startsWith(name);
  const targets = cs.filter(inTarget);
  const projects = findComposeProjects().filter(p => p.name === name || p.parent === name);
  if (!targets.length && !projects.length) die(`nothing matches "${name}"`);

  const toStop = cs.filter(c => c.state === 'running' && !inTarget(c));
  let failed = 0;
  if (toStop.length) {
    console.log(col('cyan', `==> stopping ${toStop.length} running container(s)`));
    failed += await applyAction('stop', toStop);
  } else {
    console.log(col('dim', 'nothing else running'));
  }

  if (targets.length) {
    const toStart = targets.filter(c => c.state !== 'running');
    if (!toStart.length) {
      console.log(col('dim', `${name} is already running`));
    } else {
      console.log(col('cyan', `==> starting ${name}`));
      failed += await applyAction('start', toStart);
    }
  } else {
    // no containers yet — create them from the compose project(s)
    await cmdCompose('up', name);
  }
  if (failed) process.exit(1);
}

// ---------- up / down ----------

async function cmdCompose(sub, name) {
  if (!name) die(`usage: dockeru ${sub} <master|project>`);
  const ps = findComposeProjects();
  let targets = ps.filter(p => p.name === name);
  if (!targets.length) targets = ps.filter(p => p.parent === name);
  if (!targets.length) die(`no compose project "${name}" under the repo root`);
  for (const p of targets) {
    console.log(col('cyan', `==> ${p.name}: docker compose ${sub}${sub === 'up' ? ' -d' : ''}`));
    const code = await sh(['compose', sub, ...(sub === 'up' ? ['-d'] : [])], { cwd: p.dir });
    if (code !== 0) process.exit(code);
  }
}

// ---------- root ----------

// Show or set the repo folder scanned for compose projects (shared with the
// web UI via data/settings.json).
function cmdRoot(args) {
  const [arg] = args;
  if (!arg) {
    const root = getRepoRoot();
    console.log(root + (root === DEFAULT_REPO_ROOT ? col('dim', '  (default)') : ''));
    return;
  }
  if (arg === '--reset') {
    console.log(`${col('green', '✓')} repo folder reset to default: ${setRepoRoot(null)}`);
    return;
  }
  console.log(`${col('green', '✓')} repo folder set to ${setRepoRoot(arg)}`);
}

// ---------- images / repos ----------

async function cmdImages() {
  const images = await docker.listImages();
  for (const img of images) {
    const tags = (img.RepoTags || []).filter(t => t !== '<none>:<none>');
    if (!tags.length) continue;
    console.log(`${tags.join(', ').padEnd(52)} ${col('dim', fmtSize(img.Size))}`);
  }
}

function cmdRepos(args) {
  const [sub, name, url, dockerfile] = args;
  if (!sub) {
    const repos = loadRepos();
    if (!repos.length) return console.log('no repositories connected');
    for (const r of repos) {
      const built = r.lastBuilt ? `built ${new Date(r.lastBuilt).toLocaleString()}` : 'never built';
      console.log(`${col('bold', r.name.padEnd(24))} ${r.url}  ${col('dim', `(${r.dockerfile}, ${built})`)}`);
    }
    return;
  }
  if (sub === 'add') {
    if (!name || !url) die('usage: dockeru repos add <name> <git-url> [dockerfile]');
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) die('name must be lowercase alphanumeric (dots, dashes, underscores allowed)');
    const repos = loadRepos();
    if (repos.some(r => r.name === name)) die(`repository "${name}" already exists`);
    repos.push({ name, url, dockerfile: dockerfile || 'Dockerfile', addedAt: Date.now(), lastBuilt: null });
    saveRepos(repos);
    console.log(`${col('green', '✓')} connected ${name} → ${url}`);
    return;
  }
  if (sub === 'rm') {
    if (!name) die('usage: dockeru repos rm <name>');
    saveRepos(loadRepos().filter(r => r.name !== name));
    console.log(`${col('green', '✓')} disconnected ${name} (built images are kept)`);
    return;
  }
  die(`unknown repos subcommand "${sub}"`);
}

async function cmdBuild(name) {
  if (!name) die('usage: dockeru build <repo-name>');
  const repos = loadRepos();
  const repo = repos.find(r => r.name === name);
  if (!repo) die(`no connected repository "${name}" — see: dockeru repos`);
  const tag = `${repo.name}:latest`;
  const code = await sh(['build', '-t', tag, '-f', repo.dockerfile, repo.url]);
  if (code !== 0) process.exit(code);
  repo.lastBuilt = Date.now();
  saveRepos(repos);
  console.log(`${col('green', '✓')} built ${tag}`);
}

// ---------- main ----------

const HELP = `${col('bold', 'dockeru')} — manage docker containers, images and repo builds

${col('bold', 'Containers')}
  dockeru ps [-r] [-a]               grouped container list, only the repo folder's
                                     projects (-r: running only, -a: everything)
  dockeru start <master|project|container>
  dockeru stop <master|project|container>
  dockeru restart <master|project|container>
  dockeru switch <master|project|container>   stop everything else, start the target
  dockeru logs <container> [-f]      last 300 log lines (-f: follow)
  dockeru run <image> [docker run args…]   e.g. dockeru run nginx:alpine -p 8080:80

${col('bold', 'Compose projects')} (auto-discovered under the repo folder)
  dockeru up <master|project>        docker compose up -d in the project dir
  dockeru down <master|project>      docker compose down (containers removed, volumes kept)

${col('bold', 'Repo folder')} (shared with the web UI)
  dockeru root                       show the folder scanned for compose projects
  dockeru root <path>                set it
  dockeru root --reset               revert to the default (REPO_ROOT env or parent folder)

${col('bold', 'Images')}
  dockeru images
  dockeru pull <image>
  dockeru rmi <image>

${col('bold', 'Connected repositories')}
  dockeru repos                      list
  dockeru repos add <name> <git-url> [dockerfile]
  dockeru repos rm <name>
  dockeru build <name>               build repo into <name>:latest`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'ps': case 'ls': case undefined: await cmdPs(args); break;
    case 'start': case 'stop': case 'restart': await cmdAction(cmd, args[0]); break;
    case 'up': case 'down': await cmdCompose(cmd, args[0]); break;
    case 'switch': await cmdSwitch(args[0]); break;
    case 'logs': {
      if (!args[0]) die('usage: dockeru logs <container> [-f]');
      const follow = args.includes('-f');
      process.exit(await sh(['logs', '--tail', '300', ...(follow ? ['-f'] : []), args.filter(a => a !== '-f')[0]]));
    }
    case 'run': {
      if (!args[0]) die('usage: dockeru run <image> [docker run args…]');
      process.exit(await sh(['run', '-d', ...args]));
    }
    case 'images': await cmdImages(); break;
    case 'pull': case 'rmi': {
      if (!args[0]) die(`usage: dockeru ${cmd} <image>`);
      process.exit(await sh([cmd, args[0]]));
    }
    case 'root': cmdRoot(args); break;
    case 'repos': cmdRepos(args); break;
    case 'build': await cmdBuild(args[0]); break;
    case 'help': case '-h': case '--help': console.log(HELP); break;
    default: console.log(HELP); process.exit(1);
  }
})().catch(err => die(err.message));
