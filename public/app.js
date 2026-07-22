const $ = sel => document.querySelector(sel);

// ---------- helpers ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Split containers into start waves honouring compose depends_on — each wave
// only depends on earlier waves. Mirrors startWaves() in lib.js.
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

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' kB';
}

// Streams an SSE endpoint into the log overlay. Returns when the stream ends.
function streamToOverlay(url, title) {
  showOverlay(title, '');
  return streamInto(url);
}

// Append an SSE stream ({line}/{done}/{error}) to the already-open overlay,
// so exec-console runs can share one view.
function streamInto(url) {
  const body = $('#overlay-body');
  return new Promise(resolve => {
    const es = new EventSource(url);
    es.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.line) {
        body.textContent += msg.line + '\n';
        body.scrollTop = body.scrollHeight;
      }
      if (msg.done || msg.error) {
        es.close();
        if (msg.error) {
          body.textContent += '\n✗ ' + msg.error + '\n';
          toast(msg.error, true);
        } else {
          body.textContent += '\n✓ done\n';
        }
        body.scrollTop = body.scrollHeight;
        resolve(!msg.error);
      }
    };
    es.onerror = () => { es.close(); resolve(false); };
  });
}

function showOverlay(title, content) {
  $('#overlay-title').textContent = title;
  $('#overlay-body').textContent = content;
  // Overlays other than the exec console don't get the "$" prompt row
  execConsole = null;
  $('#overlay-exec').classList.add('hidden');
  $('#overlay').classList.remove('hidden');
}
$('#overlay-close').onclick = () => {
  execConsole = null;
  $('#overlay').classList.add('hidden');
};
$('#run-close').onclick = () => $('#run-overlay').classList.add('hidden');

// ---------- tabs ----------

document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p =>
      p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    refresh(btn.dataset.tab);
  };
});

function refresh(tab) {
  if (tab === 'containers') loadContainers();
  if (tab === 'images') loadImages();
  if (tab === 'repos') loadRepos();
}

// ---------- containers ----------

let lastContainers = [];

function containerCard(c) {
  return `
      <div class="card">
        <span class="dot ${esc(c.state)}"></span>
        <div class="card-info">
          <div class="card-title">${esc(c.name)}
            ${c.ports.map(p => {
              const port = parseInt(p, 10); // "8080→80" → host port 8080
              return port
                ? `<a class="badge" href="http://localhost:${port}" target="_blank" rel="noopener" title="Open http://localhost:${port}">${esc(p)}</a>`
                : `<span class="badge">${esc(p)}</span>`;
            }).join('')}
          </div>
          <div class="card-sub">${esc(c.image)} · ${esc(c.status)} · ${esc(c.shortId)}</div>
        </div>
        <div class="card-actions">
          ${c.state === 'running'
            ? `<button class="btn small" data-act="stop" data-id="${c.id}">Stop</button>
               <button class="btn small" data-act="restart" data-id="${c.id}">Restart</button>
               <button class="btn small" data-act="exec" data-id="${c.id}" data-name="${esc(c.name)}" title="Run a script inside the container">&gt;_</button>`
            : `<button class="btn small primary" data-act="start" data-id="${c.id}">Start</button>`}
          <button class="btn small" data-act="logs" data-id="${c.id}" data-name="${esc(c.name)}">Logs</button>
          <button class="btn small danger" data-act="remove" data-id="${c.id}" data-name="${esc(c.name)}">✕</button>
        </div>
      </div>`;
}

let lastProjects = [];
let groupOrder = [];
let draggingGroup = false;
const expanded = new Set(JSON.parse(localStorage.getItem('dockeru-expanded') || '[]'));

async function loadContainers() {
  if (draggingGroup) return;
  const list = $('#containers-list');
  try {
    const [cs, projects, settings] = await Promise.all([
      api('/api/containers'),
      api('/api/projects').catch(() => []),
      api('/api/settings').catch(() => ({})),
    ]);
    lastContainers = cs;
    lastProjects = projects;
    groupOrder = settings.groupOrder || [];
  } catch (err) {
    list.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
    return;
  }
  renderContainers();
}

function renderContainers() {
  const list = $('#containers-list');
  const projects = lastProjects;
    let containers = lastContainers;
    if (!$('#show-stopped').checked) {
      containers = containers.filter(c => c.state === 'running');
    }
    // Hide containers whose compose project lives outside the repo folder
    // (also hides non-compose containers, since they have no project dir)
    if ($('#only-root').checked) {
      containers = containers.filter(c => c.inRoot);
    }
    if (!containers.length && !projects.length) {
      list.innerHTML = '<div class="empty">No containers</div>';
      return;
    }
    // Bundle by compose project, and bundle projects sharing a master folder
    const projectDirs = new Map(projects.map(p => [p.name, p.dir]));
    const groupSection = (key, items, topLevel = false) => {
      const running = items.filter(c => c.state === 'running').length;
      const dir = projectDirs.get(key);
      const open = expanded.has('g:' + key);
      return `
      <div class="group"${topLevel && key ? ` data-gname="${esc(key)}"` : ''}>
        <div class="group-head clickable" data-toggle="g:${esc(key)}">
          ${topLevel && key ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : ''}
          <span class="chev">${open ? '▾' : '▸'}</span>
          <span class="group-title">${key ? '📦 ' + esc(key) : 'Other containers'}</span>
          <span class="group-sub">${items.length ? `${running}/${items.length} running` : 'not created'}</span>
          ${key ? `
          <span class="group-actions">
            ${dir ? `<button class="btn small ${items.length ? '' : 'primary'}" data-up="${esc(dir)}" data-pname="${esc(key)}">Up</button>` : ''}
            ${running < items.length ? `<button class="btn small" data-gact="start" data-group="${esc(key)}">Start all</button>` : ''}
            ${running > 0 ? `<button class="btn small" data-gact="stop" data-group="${esc(key)}">Stop all</button>` : ''}
          </span>` : ''}
        </div>
        ${!open ? ''
          : items.length ? items.map(containerCard).join('')
          : '<div class="empty-note">no containers — press Up to start this project</div>'}
      </div>`;
    };

    // top-level entries: master folders and standalone projects,
    // seeded from compose projects found on disk so empty ones still show
    const masters = new Map();   // master name -> Map(project -> containers)
    const standalone = new Map(); // project ('' = ungrouped) -> containers
    for (const p of projects) {
      if (p.parent) {
        if (!masters.has(p.parent)) masters.set(p.parent, new Map());
        if (!masters.get(p.parent).has(p.name)) masters.get(p.parent).set(p.name, []);
      } else if (!standalone.has(p.name)) {
        standalone.set(p.name, []);
      }
    }
    for (const c of containers) {
      if (c.parent) {
        if (!masters.has(c.parent)) masters.set(c.parent, new Map());
        const projects = masters.get(c.parent);
        if (!projects.has(c.group)) projects.set(c.group, []);
        projects.get(c.group).push(c);
      } else {
        const key = c.group || '';
        if (!standalone.has(key)) standalone.set(key, []);
        standalone.get(key).push(c);
      }
    }
    // Saved drag & drop order first, then alphabetical; unnamed group last
    const gidx = new Map(groupOrder.map((n, i) => [n, i]));
    const rank = n => (gidx.has(n) ? gidx.get(n) : Infinity);
    const entries = [
      ...[...masters.keys()].map(name => ({ name, master: true })),
      ...[...standalone.keys()].map(name => ({ name, master: false })),
    ].sort((a, b) => (a.name === '') - (b.name === '')
      || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

    list.innerHTML = entries.map(e => {
      if (!e.master) return groupSection(e.name, standalone.get(e.name), true);
      const projects = masters.get(e.name);
      const all = [...projects.values()].flat();
      const running = all.filter(c => c.state === 'running').length;
      const open = expanded.has('m:' + e.name);
      return `
      <div class="master" data-gname="${esc(e.name)}">
        <div class="group-head master-head clickable" data-toggle="m:${esc(e.name)}">
          <span class="drag-handle" title="Drag to reorder">⠿</span>
          <span class="chev">${open ? '▾' : '▸'}</span>
          <span class="group-title">🗂️ ${esc(e.name)}</span>
          <span class="group-sub">${projects.size} projects · ${running}/${all.length} running</span>
          <span class="group-actions">
            ${running < all.length ? `<button class="btn small" data-gact="start" data-master="${esc(e.name)}">Start all</button>` : ''}
            ${running > 0 ? `<button class="btn small" data-gact="stop" data-master="${esc(e.name)}">Stop all</button>` : ''}
          </span>
        </div>
        ${open ? [...projects.keys()].sort().map(p => groupSection(p, projects.get(p))).join('') : ''}
      </div>`;
    }).join('');
}

$('#containers-list').onclick = async e => {
  // The drag handle sits inside a clickable group head — releasing a drag
  // (or clicking the handle) must not toggle the fold.
  if (e.target.closest('.drag-handle')) return;
  const ubtn = e.target.closest('button[data-up]');
  if (ubtn) {
    const ok = await streamToOverlay(
      `/api/projects/up?dir=${encodeURIComponent(ubtn.dataset.up)}`,
      `compose up — ${ubtn.dataset.pname}`);
    if (ok) toast(`${ubtn.dataset.pname} is up`);
    loadContainers();
    return;
  }
  const gbtn = e.target.closest('button[data-gact]');
  if (gbtn) {
    const { gact, group, master } = gbtn.dataset;
    const scope = master !== undefined ? master : group;
    const targets = lastContainers.filter(c =>
      (master !== undefined ? c.parent === master : c.group === group) &&
      (gact === 'start' ? c.state !== 'running' : c.state === 'running'));
    gbtn.disabled = true;
    // start in compose depends_on order so e.g. nginx finds php's DNS name;
    // mirrors startWaves() in lib.js
    const waves = gact === 'stop' ? [targets] : startWaves(targets);
    const failures = [];
    for (const wave of waves) {
      const results = await Promise.allSettled(wave.map(c =>
        api(`/api/containers/${c.id}/${gact}`, { method: 'POST' })));
      results.forEach((r, i) => {
        if (r.status === 'rejected') failures.push({ name: wave[i].name, err: r.reason.message });
      });
    }
    if (failures.length) {
      showOverlay(`${scope}: ${failures.length} container(s) failed to ${gact}`,
        failures.map(f => `✗ ${f.name}\n\n${f.err}`).join('\n\n────────\n\n'));
      toast(`${gact} all: ${failures.length}/${targets.length} failed`, true);
    } else {
      toast(`${gact}ed ${targets.length} container(s) in ${scope}`);
    }
    loadContainers();
    return;
  }
  const head = e.target.closest('[data-toggle]');
  if (head) {
    const key = head.dataset.toggle;
    expanded.has(key) ? expanded.delete(key) : expanded.add(key);
    localStorage.setItem('dockeru-expanded', JSON.stringify([...expanded]));
    renderContainers();
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id, name } = btn.dataset;
  try {
    if (act === 'logs') {
      const res = await fetch(`/api/containers/${id}/logs`);
      showOverlay(`Logs — ${name}`, await res.text() || '(no output)');
      return;
    }
    if (act === 'exec') return openExecDialog(id, name);
    if (act === 'remove' && !confirm(`Remove container "${name}"?`)) return;
    btn.disabled = true;
    if (act === 'remove') {
      await api(`/api/containers/${id}`, { method: 'DELETE' });
    } else {
      await api(`/api/containers/${id}/${act}`, { method: 'POST' });
    }
    toast(`${act} ok`);
    loadContainers();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
};

// Reordering of top-level groups (masters and standalone projects). The
// unnamed "Other containers" group has no data-gname and always stays last.
enableDragReorder({
  list: $('#containers-list'),
  itemSel: '[data-gname]',
  endSel: '.group:not([data-gname])',
  onStart: () => { draggingGroup = true; },
  onDrop: async (items, unchanged) => {
    draggingGroup = false;
    if (unchanged) return;
    const order = items.map(el => el.dataset.gname);
    groupOrder = order;
    try {
      await api('/api/groups/order', { method: 'PUT', body: JSON.stringify({ order }) });
    } catch (err) {
      toast(err.message, true);
      loadContainers();
    }
  },
});

$('#refresh-containers').onclick = loadContainers;
$('#show-stopped').onchange = renderContainers;
$('#only-root').onchange = renderContainers;

// ---------- exec dialog ----------

let execTarget = null;
// Last script per container name, so reruns (migrate, clear cache, …) are
// one click. Session-only on purpose — scripts can contain secrets.
const lastExecCmd = {};

function openExecDialog(id, name) {
  execTarget = { id, name };
  $('#exec-title').textContent = `Run script in ${name}`;
  $('#exec-cmd').value = lastExecCmd[name] || '';
  $('#exec-overlay').classList.remove('hidden');
  $('#exec-cmd').focus();
}

$('#exec-close').onclick = () => $('#exec-overlay').classList.add('hidden');

// ⏎ submits, shift-⏎ makes a newline (it's a textarea for multi-line scripts)
$('#exec-cmd').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#exec-form').requestSubmit();
  }
};

$('#exec-form').onsubmit = e => {
  e.preventDefault();
  const cmd = $('#exec-cmd').value.trim();
  if (!cmd || !execTarget) return;
  $('#exec-overlay').classList.add('hidden');
  showOverlay(`Console — ${execTarget.name}`, '');
  execConsole = execTarget;                       // after showOverlay: it resets the console
  $('#overlay-exec').classList.remove('hidden');
  runInConsole(cmd);
};

// The overlay's "$" prompt row: run further scripts in the same container,
// output appended to the same view.
let execConsole = null;

function runInConsole(cmd) {
  const { id, name } = execConsole;
  lastExecCmd[name] = cmd;
  const input = $('#overlay-exec-cmd');
  input.disabled = true;
  streamInto(`/api/containers/${id}/exec?cmd=${encodeURIComponent(cmd)}`).then(() => {
    input.disabled = false;
    if (execConsole) input.focus();
  });
}

$('#overlay-exec').onsubmit = e => {
  e.preventDefault();
  const input = $('#overlay-exec-cmd');
  const cmd = input.value.trim();
  if (!cmd || !execConsole || input.disabled) return;
  input.value = '';
  $('#overlay-body').textContent += '\n';
  runInConsole(cmd);
};

// ---------- run dialog ----------

function openRunDialog(image) {
  $('#run-image').value = image;
  $('#run-name').value = '';
  $('#run-ports').value = '';
  $('#run-env').value = '';
  $('#run-overlay').classList.remove('hidden');
}

$('#run-form').onsubmit = async e => {
  e.preventDefault();
  const split = v => v.split(',').map(s => s.trim()).filter(Boolean);
  try {
    await api('/api/containers/run', {
      method: 'POST',
      body: JSON.stringify({
        image: $('#run-image').value,
        name: $('#run-name').value.trim() || undefined,
        ports: split($('#run-ports').value),
        env: split($('#run-env').value),
      }),
    });
    $('#run-overlay').classList.add('hidden');
    toast('container started');
    document.querySelector('[data-tab="containers"]').click();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- images ----------

async function loadImages() {
  const list = $('#images-list');
  try {
    const images = await api('/api/images');
    if (!images.length) {
      list.innerHTML = '<div class="empty">No images — pull one above</div>';
      return;
    }
    list.innerHTML = images.map(img => `
      <div class="card">
        <div class="card-info">
          <div class="card-title">${esc(img.tags.join(', '))}</div>
          <div class="card-sub">${esc(img.id)} · ${fmtSize(img.size)}</div>
        </div>
        <div class="card-actions">
          <button class="btn small primary" data-act="run" data-tag="${esc(img.tags[0])}">Run</button>
          <button class="btn small danger" data-act="rmi" data-tag="${esc(img.tags[0])}">✕</button>
        </div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

$('#images-list').onclick = async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, tag } = btn.dataset;
  if (act === 'run') return openRunDialog(tag);
  if (act === 'rmi') {
    if (!confirm(`Remove image "${tag}"?`)) return;
    try {
      await api(`/api/images/${encodeURIComponent(tag)}`, { method: 'DELETE' });
      toast('image removed');
      loadImages();
    } catch (err) {
      toast(err.message, true);
    }
  }
};

$('#pull-btn').onclick = async () => {
  const image = $('#pull-input').value.trim();
  if (!image) return;
  const ok = await streamToOverlay(`/api/images/pull?image=${encodeURIComponent(image)}`, `Pulling ${image}`);
  if (ok) { toast('pull complete'); loadImages(); }
};
$('#pull-input').onkeydown = e => { if (e.key === 'Enter') $('#pull-btn').click(); };

$('#refresh-images').onclick = loadImages;

// ---------- repositories ----------

async function loadRepos() {
  const list = $('#repos-list');
  try {
    const repos = await api('/api/repos');
    if (!repos.length) {
      list.innerHTML = '<div class="empty">No repositories connected — add a git URL above</div>';
      return;
    }
    list.innerHTML = repos.map(r => `
      <div class="card" data-name="${esc(r.name)}">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <div class="card-info">
          <div class="card-title">${esc(r.name)}
            ${r.lastBuilt ? `<span class="badge">built ${new Date(r.lastBuilt).toLocaleString()}</span>` : '<span class="badge">never built</span>'}
          </div>
          <div class="card-sub">${esc(r.url)} · ${esc(r.dockerfile)}</div>
        </div>
        <div class="card-actions">
          <button class="btn small primary" data-act="build" data-name="${esc(r.name)}">Build</button>
          ${r.lastBuilt ? `<button class="btn small" data-act="run" data-name="${esc(r.name)}">Run</button>` : ''}
          <button class="btn small danger" data-act="del" data-name="${esc(r.name)}">✕</button>
        </div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

$('#repo-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#repo-name').value.trim().toLowerCase(),
        url: $('#repo-url').value.trim(),
        dockerfile: $('#repo-dockerfile').value.trim() || undefined,
      }),
    });
    e.target.reset();
    toast('repository connected');
    loadRepos();
  } catch (err) {
    toast(err.message, true);
  }
};

// Pointer-based drag-to-reorder on the ⠿ handles (the HTML5 drag-and-drop
// API is unreliable in the Electron/Linux build). Move/up listeners go on
// window — pointer capture on the handle itself is also flaky in Electron
// on Linux/Wayland, and silently failing capture means no move events.
// Items are direct children of `list` matching `itemSel`; the dragged item
// is reinserted as the pointer crosses item midpoints. When dropped below
// everything it lands before `endSel` (if given), keeping that entry last.
function enableDragReorder({ list, itemSel, endSel, onStart, onDrop }) {
  list.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button !== 0) return;
    const item = handle.closest(itemSel);
    if (!item || item.parentElement !== list) return;
    e.preventDefault();
    const order = () => [...list.children].filter(el => el.matches(itemSel));
    const before = order();
    item.classList.add('dragging');
    document.body.classList.add('drag-select-off');
    if (onStart) onStart();

    const onMove = ev => {
      const next = order().find(el => el !== item &&
        ev.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
      list.insertBefore(item, next || (endSel && list.querySelector(':scope > ' + endSel)) || null);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      item.classList.remove('dragging');
      document.body.classList.remove('drag-select-off');
      const after = order();
      onDrop(after, after.every((el, i) => el === before[i]));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

enableDragReorder({
  list: $('#repos-list'),
  itemSel: '.card[data-name]',
  onDrop: async (items, unchanged) => {
    if (unchanged) return;
    try {
      await api('/api/repos/order', {
        method: 'PUT',
        body: JSON.stringify({ order: items.map(el => el.dataset.name) }),
      });
    } catch (err) {
      toast(err.message, true);
      loadRepos();
    }
  },
});

$('#repos-list').onclick = async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, name } = btn.dataset;
  if (act === 'build') {
    const ok = await streamToOverlay(`/api/repos/${encodeURIComponent(name)}/build`, `Building ${name}`);
    if (ok) { toast(`built ${name}:latest`); loadRepos(); }
  }
  if (act === 'run') openRunDialog(`${name}:latest`);
  if (act === 'del') {
    if (!confirm(`Disconnect repository "${name}"? (built images are kept)`)) return;
    await api(`/api/repos/${encodeURIComponent(name)}`, { method: 'DELETE' });
    loadRepos();
  }
};

// ---------- settings ----------

$('#settings-btn').onclick = async () => {
  try {
    const s = await api('/api/settings');
    $('#settings-root').value = s.repoRoot;
    $('#settings-default').textContent = s.defaultRepoRoot;
  } catch (err) {
    toast(err.message, true);
    return;
  }
  $('#settings-overlay').classList.remove('hidden');
};
$('#settings-close').onclick = () => $('#settings-overlay').classList.add('hidden');

$('#settings-form').onsubmit = async e => {
  e.preventDefault();
  try {
    const s = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ repoRoot: $('#settings-root').value.trim() }),
    });
    $('#settings-overlay').classList.add('hidden');
    toast(`repo folder: ${s.repoRoot}`);
    loadContainers();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- init ----------

loadContainers();
setInterval(() => {
  if ($('#tab-containers').classList.contains('active') &&
      $('#overlay').classList.contains('hidden')) {
    loadContainers();
  }
}, 5000);
