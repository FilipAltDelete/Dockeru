// dockeru ui — full-screen terminal UI. Renders the same master → project →
// container tree as `dockeru ps`; arrows move, enter toggles start/stop.
// Plain ANSI + raw stdin, no dependencies (matches the no-framework rule).
const { spawn } = require('child_process');
const { docker, findComposeProjects, listContainers, groupComparator } = require('./lib');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', inv: '\x1b[7m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};

let containers = [];
let projects = [];
let rows = [];                // flattened visible tree
let sel = 0;
let scroll = 0;
let expanded = new Set();     // 'm:<name>' / 'p:<parent>/<name>' — folded by default
let showAll = false;
let busy = null;              // status text while an action runs (input ignored)
let msg = null;               // { ok, text } from the last action
let child = null;             // spawned docker process (compose / logs)
let inScreen = false;         // alternate screen active → safe to render
let timer = null;

// ---------- data ----------

async function refresh() {
  try {
    containers = await listContainers();
    projects = findComposeProjects();
  } catch (err) {
    msg = { ok: false, text: err.message };
  }
  rebuild();
}

// Same grouping as cmdPs in cli.js / the web UI: masters wrap projects two
// levels below the repo root, everything else is a standalone project.
function rebuild() {
  const cs = showAll ? containers : containers.filter(c => c.inRoot);
  const masters = new Map();    // master -> Map(project -> {dir, items})
  const standalone = new Map(); // project ('' = ungrouped) -> {dir, items}
  for (const p of projects) {
    if (p.parent) {
      if (!masters.has(p.parent)) masters.set(p.parent, new Map());
      if (!masters.get(p.parent).has(p.name)) masters.get(p.parent).set(p.name, { dir: p.dir, items: [] });
    } else if (!standalone.has(p.name)) {
      standalone.set(p.name, { dir: p.dir, items: [] });
    }
  }
  for (const c of cs) {
    if (c.parent) {
      if (!masters.has(c.parent)) masters.set(c.parent, new Map());
      const m = masters.get(c.parent);
      if (!m.has(c.group)) m.set(c.group, { dir: null, items: [] });
      m.get(c.group).items.push(c);
    } else {
      const key = c.group || '';
      if (!standalone.has(key)) standalone.set(key, { dir: null, items: [] });
      standalone.get(key).items.push(c);
    }
  }

  const prevKey = rows[sel] && rows[sel].key;
  rows = [];
  const pushProject = (name, meta, parent, indent) => {
    const key = `p:${parent || ''}/${name}`;
    rows.push({ key, type: 'project', name, parent, dir: meta.dir, items: meta.items, indent });
    if (expanded.has(key)) {
      for (const c of meta.items) rows.push({ key: 'c:' + c.id, type: 'container', c, indent: indent + 1 });
    }
  };
  const cmp = groupComparator();
  const entries = [
    ...[...masters.keys()].map(name => ({ name, master: true })),
    ...[...standalone.keys()].map(name => ({ name, master: false })),
  ].sort((a, b) => cmp(a.name, b.name));
  for (const e of entries) {
    if (!e.master) { pushProject(e.name, standalone.get(e.name), null, 0); continue; }
    const inner = masters.get(e.name);
    const key = 'm:' + e.name;
    rows.push({ key, type: 'master', name: e.name, projects: inner, items: [...inner.values()].flatMap(v => v.items), indent: 0 });
    if (expanded.has(key)) {
      for (const p of [...inner.keys()].sort()) pushProject(p, inner.get(p), e.name, 1);
    }
  }

  if (prevKey) {
    const i = rows.findIndex(r => r.key === prevKey);
    if (i >= 0) sel = i;
  }
  sel = Math.max(0, Math.min(sel, rows.length - 1));
  render();
}

// ---------- rendering ----------

function rowLine(r, isSel, width) {
  // Selected rows are drawn plain and inverted as one block, so the paint
  // helper becomes a no-op there (nested resets would break the highlight).
  const p = isSel ? (c, s) => s : (c, s) => C[c] + s + C.reset;
  let text;
  if (r.type === 'container') {
    const c = r.c;
    const dot = c.state === 'running' ? p('green', '●') : p('dim', '○');
    const ports = c.ports.length ? '  ' + c.ports.join(' ') : '';
    text = `${'   '.repeat(r.indent)}  ${dot} ${c.name.padEnd(30)} ${c.state.padEnd(8)} ${p('dim', c.image + ports)}`;
  } else {
    const running = r.items.filter(c => c.state === 'running').length;
    const arrow = expanded.has(r.key) ? '▾' : '▸';
    const sub = r.type === 'master'
      ? `${r.projects.size} projects · ${running}/${r.items.length} running`
      : (r.items.length ? `${running}/${r.items.length} running` : 'not created');
    const icon = r.type === 'master' ? '🗂 ' : '📦';
    text = `${'   '.repeat(r.indent)}${arrow} ${icon} ${p('bold', r.name || 'other')}  ${p('dim', sub)}`;
  }
  if (isSel) {
    const t = (' ' + text).slice(0, width - 1);
    return C.inv + C.bold + t + ' '.repeat(Math.max(0, width - 1 - t.length)) + C.reset;
  }
  return ' ' + text;
}

function render() {
  if (!inScreen) return;
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const bodyH = Math.max(1, height - 3); // title + status + help
  if (sel < scroll) scroll = sel;
  if (sel >= scroll + bodyH) scroll = sel - bodyH + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - bodyH)));

  const out = ['\x1b[H'];
  out.push('\x1b[2K' + C.bold + C.cyan + ' dockeru' + C.reset
    + C.dim + (showAll ? '  all containers' : '  repo folder projects') + C.reset + '\r\n');
  for (let i = 0; i < bodyH; i++) {
    const r = rows[scroll + i];
    out.push('\x1b[2K' + (r ? rowLine(r, scroll + i === sel, width) : '') + '\r\n');
  }
  if (!rows.length) out[2] = '\x1b[2K ' + C.dim + 'no projects or containers found' + C.reset + '\r\n';

  let status = '';
  if (busy) status = C.yellow + ' ' + busy + C.reset;
  else if (msg) status = (msg.ok ? C.green + ' ✓ ' : C.red + ' ✗ ') + msg.text.replace(/\s+/g, ' ').slice(0, width - 4) + C.reset;
  out.push('\x1b[2K' + status + '\r\n');
  out.push('\x1b[2K' + C.dim + ' ↑↓ move · ←→ fold · ⏎ start/stop · r restart · s switch · u up · d down · l logs · a all · q quit' + C.reset);
  process.stdout.write(out.join(''));
}

const enterScreen = () => { inScreen = true; process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J'); };
const leaveScreen = () => { inScreen = false; process.stdout.write('\x1b[?1049l\x1b[?25h'); };

// ---------- actions ----------

async function containerAction(action, targets) {
  if (!targets.length) { msg = { ok: false, text: `nothing to ${action}` }; return render(); }
  busy = `${action} ${targets.length === 1 ? targets[0].name : targets.length + ' containers'}…`;
  render();
  const results = await Promise.allSettled(targets.map(c => docker.getContainer(c.id)[action]()));
  const failed = results.find(r => r.status === 'rejected');
  msg = failed
    ? { ok: false, text: `${action}: ${failed.reason.message.trim()}` }
    : { ok: true, text: `${action} ${targets.map(c => c.name).join(', ')}` };
  busy = null;
  await refresh();
}

// Compose needs live output: drop back to the normal screen, run docker with
// inherited stdio, then return to the UI.
async function composeRun(sub, list) {
  if (!list.length) { msg = { ok: false, text: 'no compose file found for this entry' }; return render(); }
  busy = `compose ${sub}`;
  leaveScreen();
  let code = 0;
  for (const p of list) {
    process.stdout.write(C.cyan + `==> ${p.name}: docker compose ${sub}${sub === 'up' ? ' -d' : ''}\n` + C.reset);
    child = spawn('docker', ['compose', sub, ...(sub === 'up' ? ['-d'] : [])], { cwd: p.dir, stdio: ['ignore', 'inherit', 'inherit'] });
    code = await new Promise(res => child.on('close', res));
    child = null;
    if (code !== 0) break;
  }
  msg = code === 0
    ? { ok: true, text: `compose ${sub} ${list.map(p => p.name).join(', ')}` }
    : { ok: false, text: `compose ${sub} exited with code ${code}` };
  busy = null;
  enterScreen();
  await refresh();
}

function composeTargets(r) {
  if (r.type === 'project') return r.dir ? [{ name: r.name, dir: r.dir }] : [];
  if (r.type === 'master') {
    return [...r.projects.entries()].filter(([, v]) => v.dir).map(([name, v]) => ({ name, dir: v.dir }));
  }
  return [];
}

// Reveal a group's containers when it gets started.
function expandTree(r) {
  if (r.type === 'container') return;
  expanded.add(r.key);
  if (r.type === 'master') for (const name of r.projects.keys()) expanded.add(`p:${r.name}/${name}`);
}

// Enter: running → stop, stopped → start, nothing created yet → compose up.
async function toggle(r) {
  if (r.type === 'container') {
    return containerAction(r.c.state === 'running' ? 'stop' : 'start', [r.c]);
  }
  const running = r.items.filter(c => c.state === 'running');
  if (running.length) return containerAction('stop', running);
  expandTree(r);
  if (r.items.length) return containerAction('start', r.items);
  return composeRun('up', composeTargets(r));
}

// Like `dockeru switch`: stop everything else, then start the target.
async function doSwitch(r) {
  const targets = r.type === 'container' ? [r.c] : r.items;
  const ids = new Set(targets.map(c => c.id));
  const toStop = containers.filter(c => c.state === 'running' && !ids.has(c.id));
  if (toStop.length) await containerAction('stop', toStop);
  expandTree(r);
  const toStart = targets.filter(c => c.state !== 'running');
  if (toStart.length) return containerAction('start', toStart);
  if (!targets.length) return composeRun('up', composeTargets(r));
}

async function showLogs(r) {
  if (r.type !== 'container') { msg = { ok: false, text: 'select a container to view logs' }; return render(); }
  busy = 'logs';
  leaveScreen();
  process.stdout.write(C.cyan + `==> logs ${r.c.name} — Ctrl-C to return\n` + C.reset);
  child = spawn('docker', ['logs', '--tail', '300', '-f', r.c.id], { stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise(res => child.on('close', res));
  child = null;
  busy = null;
  msg = null;
  enterScreen();
  await refresh();
}

// ---------- input ----------

function fold(r, close) {
  if (r.type === 'container' || (close && !expanded.has(r.key))) {
    // ← on a container (or an already-folded group) jumps to the parent row
    for (let i = sel - 1; i >= 0; i--) {
      if (rows[i].indent < (r.indent || 1)) { sel = i; break; }
    }
    return render();
  }
  if (close) expanded.delete(r.key); else expanded.add(r.key);
  rebuild();
}

function onKey(buf) {
  const s = buf.toString();
  if (s === '\x03') {                  // Ctrl-C: kill the docker child if one
    if (child) return child.kill('SIGINT'); // is running, otherwise quit
    return quit();
  }
  if (busy) return;
  if (s === 'q' || s === '\x1b') return quit();
  if (!rows.length) return;
  const r = rows[sel];
  if (s === '\x1b[A' || s === 'k') { sel = Math.max(0, sel - 1); render(); }
  else if (s === '\x1b[B' || s === 'j') { sel = Math.min(rows.length - 1, sel + 1); render(); }
  else if (s === '\x1b[D') fold(r, true);
  else if (s === '\x1b[C') fold(r, false);
  else if (s === '\r' || s === '\n') toggle(r);
  else if (s === 'r') containerAction('restart', r.type === 'container' ? [r.c] : r.items);
  else if (s === 's') doSwitch(r);
  else if (s === 'u') { expandTree(r); composeRun('up', composeTargets(r)); }
  else if (s === 'd') composeRun('down', composeTargets(r));
  else if (s === 'l') showLogs(r);
  else if (s === 'a') { showAll = !showAll; rebuild(); }
}

function quit() {
  clearInterval(timer);
  leaveScreen();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

async function start() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('dockeru ui needs an interactive terminal');
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', render);
  process.on('SIGTERM', quit);
  enterScreen();
  render();
  await refresh();
  timer = setInterval(() => { if (!busy && !child) refresh(); }, 2000);
}

module.exports = { start };
