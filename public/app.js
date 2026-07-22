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

function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' kB';
}

// Streams an SSE endpoint into the log overlay. Returns when the stream ends.
function streamToOverlay(url, title) {
  showOverlay(title, '');
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
  $('#overlay').classList.remove('hidden');
}
$('#overlay-close').onclick = () => $('#overlay').classList.add('hidden');
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
            ${c.ports.map(p => `<span class="badge">${esc(p)}</span>`).join('')}
          </div>
          <div class="card-sub">${esc(c.image)} · ${esc(c.status)} · ${esc(c.shortId)}</div>
        </div>
        <div class="card-actions">
          ${c.state === 'running'
            ? `<button class="btn small" data-act="stop" data-id="${c.id}">Stop</button>
               <button class="btn small" data-act="restart" data-id="${c.id}">Restart</button>`
            : `<button class="btn small primary" data-act="start" data-id="${c.id}">Start</button>`}
          <button class="btn small" data-act="logs" data-id="${c.id}" data-name="${esc(c.name)}">Logs</button>
          <button class="btn small danger" data-act="remove" data-id="${c.id}" data-name="${esc(c.name)}">✕</button>
        </div>
      </div>`;
}

let lastProjects = [];
const expanded = new Set(JSON.parse(localStorage.getItem('dockeru-expanded') || '[]'));

async function loadContainers() {
  const list = $('#containers-list');
  try {
    const [cs, projects] = await Promise.all([
      api('/api/containers'),
      api('/api/projects').catch(() => []),
    ]);
    lastContainers = cs;
    lastProjects = projects;
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
    const groupSection = (key, items) => {
      const running = items.filter(c => c.state === 'running').length;
      const dir = projectDirs.get(key);
      const open = expanded.has('g:' + key);
      return `
      <div class="group">
        <div class="group-head clickable" data-toggle="g:${esc(key)}">
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
    const entries = [
      ...[...masters.keys()].map(name => ({ name, master: true })),
      ...[...standalone.keys()].map(name => ({ name, master: false })),
    ].sort((a, b) => (a.name === '') - (b.name === '') || a.name.localeCompare(b.name));

    list.innerHTML = entries.map(e => {
      if (!e.master) return groupSection(e.name, standalone.get(e.name));
      const projects = masters.get(e.name);
      const all = [...projects.values()].flat();
      const running = all.filter(c => c.state === 'running').length;
      const open = expanded.has('m:' + e.name);
      return `
      <div class="master">
        <div class="group-head master-head clickable" data-toggle="m:${esc(e.name)}">
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
    const results = await Promise.allSettled(targets.map(c =>
      api(`/api/containers/${c.id}/${gact}`, { method: 'POST' })));
    const failures = results
      .map((r, i) => r.status === 'rejected' ? { name: targets[i].name, err: r.reason.message } : null)
      .filter(Boolean);
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

$('#refresh-containers').onclick = loadContainers;
$('#show-stopped').onchange = renderContainers;
$('#only-root').onchange = renderContainers;

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
      <div class="card">
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
