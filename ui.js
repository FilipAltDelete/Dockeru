// dockeru ui — full-screen terminal UI. Renders the same master → project →
// container tree as `dockeru ps`; arrows move, enter toggles start/stop.
// Plain ANSI + raw stdin, no dependencies (matches the no-framework rule).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { docker, findComposeProjects, listContainers, groupComparator, startWaves, containerUrl, openInBrowser, editorCommand, getEditor } = require('./lib');

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
let logView = null;           // { name, lines, buf, scroll, follow, ended } while viewing logs
let explorer = null;          // { c, path, entries, sel, scroll, err, file } while browsing files
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
  if (!inScreen || logView || explorer) return;
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
  out.push('\x1b[2K' + C.dim + ' ↑↓ move · ←→ fold · ⏎ start/stop · r restart · s switch · u up · d down · l logs · e files/editor · o open · a all · q quit' + C.reset);
  process.stdout.write(out.join(''));
}

// Scrollable log viewer — replaces the tree on the alternate screen while open.
function appendLog(chunk) {
  const lv = logView;
  if (!lv) return;
  lv.buf += chunk.toString().replace(/\r\n?/g, '\n');
  const parts = lv.buf.split('\n');
  lv.buf = parts.pop();
  // Strip ANSI sequences: lines are sliced to the terminal width, and a cut
  // color code would bleed into the rest of the screen.
  for (const l of parts) lv.lines.push(l.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ''));
  const drop = lv.lines.length - 5000;
  if (drop > 0) { lv.lines.splice(0, drop); lv.scroll = Math.max(0, lv.scroll - drop); }
  renderLogs();
}

function renderLogs() {
  if (!inScreen || !logView) return;
  const lv = logView;
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const bodyH = Math.max(1, height - 2); // title + help
  const max = Math.max(0, lv.lines.length - bodyH);
  if (lv.follow) lv.scroll = max;
  lv.scroll = Math.max(0, Math.min(lv.scroll, max));

  const pos = lv.lines.length ? `${Math.min(lv.scroll + bodyH, lv.lines.length)}/${lv.lines.length}` : 'no output';
  const state = lv.ended ? ' · stream ended' : (lv.follow ? ' · following' : '');
  const out = ['\x1b[H'];
  out.push('\x1b[2K' + C.bold + C.cyan + ' logs ' + lv.name + C.reset + C.dim + `  ${pos}${state}` + C.reset + '\r\n');
  for (let i = 0; i < bodyH; i++) {
    const l = lv.lines[lv.scroll + i];
    out.push('\x1b[2K' + (l === undefined ? '' : l.slice(0, width)) + '\r\n');
  }
  out.push('\x1b[2K' + C.dim + ' ↑↓ scroll · PgUp/PgDn page · g/G top/end · q back' + C.reset);
  process.stdout.write(out.join(''));
}

const enterScreen = () => { inScreen = true; process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J'); };
const leaveScreen = () => { inScreen = false; process.stdout.write('\x1b[?1049l\x1b[?25h'); };

// ---------- actions ----------

async function containerAction(action, targets) {
  if (!targets.length) { msg = { ok: false, text: `nothing to ${action}` }; return render(); }
  busy = `${action} ${targets.length === 1 ? targets[0].name : targets.length + ' containers'}…`;
  render();
  // start/restart in depends_on order so e.g. nginx finds php's DNS name
  const waves = action === 'stop' ? [targets] : startWaves(targets);
  let failed = null;
  for (const wave of waves) {
    const results = await Promise.allSettled(wave.map(c => docker.getContainer(c.id)[action]()));
    failed = failed || results.find(r => r.status === 'rejected');
  }
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

// Open the environment in the default browser: the selected container's first
// published port, or — on a group — the first running container that has one.
function openBrowser(r) {
  const candidates = r.type === 'container' ? [r.c]
    : r.items.filter(c => c.state === 'running');
  const url = candidates.map(containerUrl).find(Boolean);
  if (!url) msg = { ok: false, text: 'no published ports to open' };
  else { openInBrowser(url); msg = { ok: true, text: `opened ${url}` }; }
  render();
}

async function showLogs(r) {
  if (r.type !== 'container') { msg = { ok: false, text: 'select a container to view logs' }; return render(); }
  busy = 'logs'; // keeps the periodic refresh() away while the viewer is open
  logView = { name: r.c.name, lines: [], buf: '', scroll: 0, follow: true, ended: false };
  child = spawn('docker', ['logs', '--tail', '300', '-f', r.c.id], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  renderLogs();
  await new Promise(res => child.on('close', res));
  child = null;
  if (logView) { logView.ended = true; renderLogs(); } // -f ended by itself → viewer stays open
  else { busy = null; msg = null; await refresh(); }   // user quit the viewer
}

// ---------- file explorer ----------
// IDE-like read-only browser for a running container's filesystem: directory
// tree navigation plus a file viewer with line numbers. Everything goes
// through `docker exec sh -c`, so it works with whatever the image ships.

const FILE_LIMIT = 500000; // bytes of a file to load (head -c)
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function dockerExec(id, cmd) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', id, 'sh', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit code ${code}`))));
  });
}

const joinPath = (dir, name) => (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;

// 'e' on a master or project row: open its folder on disk in the configured
// editor. Only GUI editors (code, subl, zed…) make sense here — a terminal
// editor can't take over the UI for a whole directory. Spawned detached and
// without --wait: we're not round-tripping a file, just opening a window.
function openFolder(r) {
  let dir = null;
  if (r.type === 'project') dir = r.dir;
  else {
    // the master folder is the parent of any of its project dirs
    const p = [...r.projects.values()].find(v => v.dir);
    if (p) dir = path.dirname(p.dir);
  }
  if (!dir) { msg = { ok: false, text: `no folder on disk for ${r.name}` }; return render(); }
  const editor = editorCommand();
  if (!editor.gui) {
    msg = { ok: false, text: `opening folders needs a GUI editor (dockeru editor code) — current: ${editor.name}` };
    return render();
  }
  spawn('/bin/sh', ['-c', `${getEditor()} ${shq(dir)}`], { stdio: 'ignore', detached: true }).unref();
  msg = { ok: true, text: `opened ${dir} in ${editor.name}` };
  render();
}

async function openExplorer(r) {
  if (r.type === 'master' || r.type === 'project') return openFolder(r);
  if (r.type !== 'container') { msg = { ok: false, text: 'select a container to browse its files' }; return render(); }
  if (r.c.state !== 'running') { msg = { ok: false, text: `${r.c.name} must be running to browse its files` }; return render(); }
  busy = 'files'; // pauses the periodic tree refresh while the explorer is open
  explorer = { c: r.c, path: '/', entries: [], sel: 0, scroll: 0, err: null, file: null };
  // start where the image's WorkingDir points (exec's cwd), usually the app code
  try { explorer.path = (await dockerExec(r.c.id, 'pwd')).trim() || '/'; } catch {}
  await loadDir();
}

// List the current directory (dirs first). selectName re-selects a child
// after navigating up, so ← doesn't lose your place.
async function loadDir(selectName) {
  const ex = explorer;
  if (!ex) return;
  try {
    const names = (await dockerExec(ex.c.id, `ls -1Ap ${shq(ex.path)}`)).split('\n').filter(Boolean);
    if (explorer !== ex) return; // user quit while loading
    ex.entries = [
      ...names.filter(n => n.endsWith('/')).sort(),
      ...names.filter(n => !n.endsWith('/')).sort(),
    ];
    ex.err = null;
  } catch (err) {
    if (explorer !== ex) return;
    ex.entries = [];
    ex.err = err.message.replace(/\s+/g, ' ');
  }
  ex.sel = Math.max(0, selectName ? ex.entries.indexOf(selectName) : 0);
  ex.scroll = 0;
  renderExplorer();
}

async function openFile(name) {
  const ex = explorer;
  const full = joinPath(ex.path, name);
  let text, truncated = false;
  try {
    // symlinked directories aren't marked by ls -p — descend instead of cat'ing
    // ([ -d ] is the only portable test: busybox says "I/O error", GNU differs)
    if ((await dockerExec(ex.c.id, `[ -d ${shq(full)} ] && echo 1 || echo 0`)).trim() === '1') {
      if (explorer !== ex) return;
      ex.path = full;
      return loadDir();
    }
    // `< file` instead of an argument: immune to weird names, same in busybox
    text = await dockerExec(ex.c.id, `head -c ${FILE_LIMIT} < ${shq(full)}`);
    truncated = text.length >= FILE_LIMIT;
  } catch (err) {
    if (explorer !== ex) return;
    text = '✗ ' + err.message;
  }
  if (explorer !== ex) return;
  const lines = text
    .replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·') // binary junk → visible dots
    .split('\n');
  ex.file = { name, lines, scroll: 0, truncated };
  renderExplorer();
}

// Edit a file with the configured editor (`dockeru editor`, falling back to
// $EDITOR): docker cp it out, hand the terminal to the editor, then write
// changes back through `cat > file` inside the container so the file's owner
// and permissions are preserved. GUI editors (VS Code etc.) run with their
// wait flag, so the write-back still happens when the file is closed.
async function editFile(name) {
  const ex = explorer;
  const full = joinPath(ex.path, name);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockeru-edit-'));
  const tmp = path.join(tmpDir, name);
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
  const fail = text => { cleanup(); msg = { ok: false, text }; renderExplorer(); };

  // -L: the listing may show symlinks — edit what they point at
  const pull = await new Promise(resolve => {
    const p = spawn('docker', ['cp', '-L', `${ex.c.id}:${full}`, tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('close', code => resolve({ code, err: err.trim() }));
  });
  if (explorer !== ex) return cleanup();
  if (pull.code !== 0) return fail(pull.err || 'docker cp failed');
  const before = fs.readFileSync(tmp);

  // Hand the tty to the editor: cooked mode, paused stdin (so our key
  // listener doesn't steal input), normal screen. SIGINT is muted for the
  // window before the editor sets its own terminal mode.
  const editor = editorCommand();
  const noop = () => {};
  process.on('SIGINT', noop);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  leaveScreen();
  if (editor.gui) {
    process.stdout.write(C.dim + `waiting for ${editor.name} — save and close ${name} to write it back into the container (Ctrl-C cancels)\n` + C.reset);
  }
  const code = await new Promise(res =>
    spawn('/bin/sh', ['-c', `${editor.cmd} ${shq(tmp)}`], { stdio: 'inherit' }).on('close', res));
  enterScreen();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.removeListener('SIGINT', noop);
  if (explorer !== ex) return cleanup();
  if (code !== 0) return fail(`editor exited with code ${code} — not saved`);
  const after = fs.readFileSync(tmp);
  if (after.equals(before)) { cleanup(); msg = { ok: true, text: `${name} unchanged` }; return renderExplorer(); }

  // `cat > file` keeps the inode (owner/permissions intact). It can fail even
  // as root: fs.protected_regular blocks O_CREAT on another user's file in
  // sticky dirs like /tmp — fall back to recreate + restore owner and mode.
  const script = `f=${shq(full)}
own=$(stat -c %u:%g "$f" 2>/dev/null); mode=$(stat -c %a "$f" 2>/dev/null)
if ! cat > "$f" 2>/dev/null; then
  rm -f "$f" && cat > "$f" || exit 1
  [ -z "$own" ] || chown "$own" "$f" 2>/dev/null || true
  [ -z "$mode" ] || chmod "$mode" "$f" 2>/dev/null || true
fi`;
  const fd = fs.openSync(tmp, 'r');
  const write = await new Promise(resolve => {
    const p = spawn('docker', ['exec', '-i', ex.c.id, 'sh', '-c', script], { stdio: [fd, 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('close', c => resolve({ code: c, err: err.trim() }));
  });
  fs.closeSync(fd);
  cleanup();
  if (explorer !== ex) return;
  if (write.code !== 0) return fail(write.err || `write failed (exit code ${write.code})`);
  msg = { ok: true, text: `saved ${full}` };
  if (ex.file && ex.file.name === name) return openFile(name); // refresh the open view
  renderExplorer();
}

function renderExplorer() {
  if (!inScreen || !explorer) return;
  const ex = explorer;
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows || 24;
  const bodyH = Math.max(1, height - 2); // title + help
  const out = ['\x1b[H'];
  // bottom line doubles as status: save/error messages replace the help text
  const statusLine = help => '\x1b[2K' + (msg
    ? (msg.ok ? C.green + ' ✓ ' : C.red + ' ✗ ') + msg.text.replace(/\s+/g, ' ').slice(0, width - 4) + C.reset
    : C.dim + help + C.reset);

  if (ex.file) {
    const f = ex.file;
    f.scroll = Math.max(0, Math.min(f.scroll, Math.max(0, f.lines.length - bodyH)));
    const pos = `${Math.min(f.scroll + bodyH, f.lines.length)}/${f.lines.length}`;
    out.push('\x1b[2K' + C.bold + C.cyan + ' ' + ex.c.name + C.reset
      + ' ' + joinPath(ex.path, f.name)
      + C.dim + `  ${pos}${f.truncated ? ' · truncated' : ''}` + C.reset + '\r\n');
    const nw = Math.max(4, String(f.lines.length).length);
    for (let i = 0; i < bodyH; i++) {
      const n = f.scroll + i;
      const l = f.lines[n];
      out.push('\x1b[2K' + (l === undefined ? ''
        : C.dim + String(n + 1).padStart(nw) + C.reset + ' ' + l.slice(0, width - nw - 1)) + '\r\n');
    }
    out.push(statusLine(' ↑↓ scroll · PgUp/PgDn page · g/G top/end · e edit · ←/q back'));
    return void process.stdout.write(out.join(''));
  }

  ex.sel = Math.max(0, Math.min(ex.sel, ex.entries.length - 1));
  if (ex.sel < ex.scroll) ex.scroll = ex.sel;
  if (ex.sel >= ex.scroll + bodyH) ex.scroll = ex.sel - bodyH + 1;
  ex.scroll = Math.max(0, Math.min(ex.scroll, Math.max(0, ex.entries.length - bodyH)));
  out.push('\x1b[2K' + C.bold + C.cyan + ' files ' + ex.c.name + C.reset + C.dim + '  ' + ex.path + C.reset + '\r\n');
  for (let i = 0; i < bodyH; i++) {
    const n = ex.scroll + i;
    const name = ex.entries[n];
    let line = '';
    if (name !== undefined) {
      const isDir = name.endsWith('/');
      const text = ` ${isDir ? '📁 ' : '   '}${name}`;
      line = n === ex.sel
        ? C.inv + C.bold + text.slice(0, width) + ' '.repeat(Math.max(0, width - text.length)) + C.reset
        : (isDir ? C.cyan + text + C.reset : text);
    } else if (n === 0 && ex.err) {
      line = ' ' + C.red + '✗ ' + ex.err.slice(0, width - 4) + C.reset;
    } else if (n === 0 && !ex.entries.length) {
      line = ' ' + C.dim + '(empty directory)' + C.reset;
    }
    out.push('\x1b[2K' + line + '\r\n');
  }
  out.push(statusLine(' ↑↓ move · ⏎ open · e edit · ← up · g/G top/end · q back'));
  process.stdout.write(out.join(''));
}

function closeExplorer() {
  explorer = null;
  busy = null;
  msg = null;
  refresh();
}

function onExplorerKey(s) {
  const ex = explorer;
  const bodyH = Math.max(1, (process.stdout.rows || 24) - 2);
  msg = null; // any key clears the status line
  if (ex.file) {
    const f = ex.file;
    if (s === 'q' || s === '\x1b' || s === '\x03' || s === '\x1b[D') { ex.file = null; return renderExplorer(); }
    if (s === 'e') return editFile(f.name);
    if (s === '\x1b[A' || s === 'k') f.scroll--;
    else if (s === '\x1b[B' || s === 'j') f.scroll++;
    else if (s === '\x1b[5~') f.scroll -= bodyH;
    else if (s === '\x1b[6~') f.scroll += bodyH;
    else if (s === 'g') f.scroll = 0;
    else if (s === 'G') f.scroll = Infinity;
    else return;
    return renderExplorer();
  }
  if (s === 'q' || s === '\x1b' || s === '\x03') return closeExplorer();
  if (s === 'e') {
    const name = ex.entries[ex.sel];
    if (name === undefined) return;
    if (name.endsWith('/')) { msg = { ok: false, text: 'select a file to edit' }; return renderExplorer(); }
    return editFile(name);
  }
  if (s === '\x1b[A' || s === 'k') ex.sel--;
  else if (s === '\x1b[B' || s === 'j') ex.sel++;
  else if (s === '\x1b[5~') ex.sel -= bodyH;
  else if (s === '\x1b[6~') ex.sel += bodyH;
  else if (s === 'g') ex.sel = 0;
  else if (s === 'G') ex.sel = Infinity;
  else if (s === '\x1b[D' || s === '\x7f') { // ← / backspace: up one directory
    if (ex.path === '/') return;
    const parts = ex.path.replace(/\/+$/, '').split('/');
    const child = parts.pop();
    ex.path = parts.join('/') || '/';
    return loadDir(child + '/');
  } else if (s === '\r' || s === '\n') {
    const name = ex.entries[ex.sel];
    if (name === undefined) return;
    if (name.endsWith('/')) { ex.path = joinPath(ex.path, name.slice(0, -1)); return loadDir(); }
    return openFile(name);
  } else return;
  renderExplorer();
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

function onLogKey(s) {
  const lv = logView;
  const bodyH = Math.max(1, (process.stdout.rows || 24) - 2);
  if (s === 'q' || s === '\x1b' || s === '\x03') {
    logView = null;
    if (child) return child.kill('SIGINT'); // showLogs resumes after close
    busy = null; msg = null;                // stream had already ended
    return refresh();
  }
  if (s === '\x1b[A' || s === 'k') lv.scroll--;
  else if (s === '\x1b[B' || s === 'j') lv.scroll++;
  else if (s === '\x1b[5~') lv.scroll -= bodyH;
  else if (s === '\x1b[6~') lv.scroll += bodyH;
  else if (s === 'g') lv.scroll = 0;
  else if (s === 'G') lv.scroll = Infinity;
  else return;
  lv.follow = lv.scroll >= lv.lines.length - bodyH; // scrolled to the end → keep following
  renderLogs();
}

function onKey(buf) {
  const s = buf.toString();
  if (logView) return onLogKey(s);
  if (explorer) return onExplorerKey(s);
  if (s === '\x03') {                  // Ctrl-C: kill the docker child if one
    if (child) return child.kill('SIGINT'); // is running (compose), otherwise quit
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
  else if (s === 'e') openExplorer(r);
  else if (s === 'o') openBrowser(r);
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
  process.stdout.on('resize', () => (logView ? renderLogs() : explorer ? renderExplorer() : render()));
  process.on('SIGTERM', quit);
  enterScreen();
  render();
  await refresh();
  timer = setInterval(() => { if (!busy && !child) refresh(); }, 2000);
}

module.exports = { start };
