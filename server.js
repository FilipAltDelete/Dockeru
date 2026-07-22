const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const {
  docker, DEFAULT_REPO_ROOT, getRepoRoot, setRepoRoot,
  loadRepos, saveRepos, reorderRepos,
  getGroupOrder, setGroupOrder,
  composeFileIn, findComposeProjects, listContainers,
} = require('./lib');

const app = express();
const PORT = process.env.PORT || 3300;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Containers ----------

app.get('/api/containers', async (req, res) => {
  try {
    res.json(await listContainers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/:action', async (req, res) => {
  const { action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: `unknown action "${action}"` });
  }
  try {
    const container = docker.getContainer(req.params.id);
    await container[action]();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/containers/:id', async (req, res) => {
  try {
    await docker.getContainer(req.params.id).remove({ force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const buf = await container.logs({ stdout: true, stderr: true, tail: 300 });
    // Strip docker's 8-byte stream-multiplexing headers
    let out = '';
    let i = 0;
    while (i < buf.length) {
      const len = buf.readUInt32BE(i + 4);
      out += buf.slice(i + 8, i + 8 + len).toString('utf8');
      i += 8 + len;
    }
    res.type('text/plain').send(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/run', async (req, res) => {
  const { image, name, ports, env } = req.body;
  if (!image) return res.status(400).json({ error: 'image is required' });
  try {
    const exposed = {};
    const bindings = {};
    for (const mapping of ports || []) {
      const [host, cont] = mapping.split(':');
      const key = `${cont}/tcp`;
      exposed[key] = {};
      bindings[key] = [{ HostPort: String(host) }];
    }
    const container = await docker.createContainer({
      Image: image,
      name: name || undefined,
      Env: env || [],
      ExposedPorts: exposed,
      HostConfig: { PortBindings: bindings },
    });
    await container.start();
    res.json({ ok: true, id: container.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Images ----------

app.get('/api/images', async (req, res) => {
  try {
    const images = await docker.listImages();
    res.json(images.map(img => ({
      id: img.Id.replace('sha256:', '').slice(0, 12),
      tags: (img.RepoTags || []).filter(t => t !== '<none>:<none>'),
      size: img.Size,
      created: img.Created,
    })).filter(img => img.tags.length > 0));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/images/pull', (req, res) => {
  const image = req.query.image;
  if (!image) return res.status(400).end('image is required');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  docker.pull(image, (err, stream) => {
    if (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      return res.end();
    }
    docker.modem.followProgress(
      stream,
      finalErr => {
        res.write(`data: ${JSON.stringify(finalErr ? { error: finalErr.message } : { done: true })}\n\n`);
        res.end();
      },
      event => {
        const line = [event.status, event.id, event.progress].filter(Boolean).join(' ');
        if (line) res.write(`data: ${JSON.stringify({ line })}\n\n`);
      }
    );
  });
});

app.delete('/api/images/:name', async (req, res) => {
  try {
    await docker.getImage(req.params.name).remove();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Compose projects on disk ----------

app.get('/api/projects', (req, res) => {
  try { res.json(findComposeProjects()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// docker compose up -d in a project directory (streams output via SSE)
app.get('/api/projects/up', (req, res) => {
  const dir = path.resolve(String(req.query.dir || ''));
  if (!dir.startsWith(getRepoRoot() + path.sep) || !composeFileIn(dir)) {
    return res.status(400).end('not a compose project inside the repo root');
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.write(`data: ${JSON.stringify({ line: `$ docker compose up -d  (in ${dir})` })}\n\n`);
  const proc = spawn('docker', ['compose', 'up', '-d'], { cwd: dir });
  const forward = chunk => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
  };
  proc.stdout.on('data', forward);
  proc.stderr.on('data', forward);
  proc.on('close', code => {
    res.write(`data: ${JSON.stringify(code === 0 ? { done: true } : { error: `compose up failed (exit code ${code})` })}\n\n`);
    res.end();
  });
  req.on('close', () => proc.kill());
});

// ---------- Settings ----------

app.get('/api/settings', (req, res) => {
  res.json({ repoRoot: getRepoRoot(), defaultRepoRoot: DEFAULT_REPO_ROOT, groupOrder: getGroupOrder() });
});

// Set the repo root scanned for compose projects; empty repoRoot reverts
// to the default (REPO_ROOT env or the folder dockeru was cloned into).
app.put('/api/settings', (req, res) => {
  try {
    const repoRoot = setRepoRoot(req.body.repoRoot);
    res.json({ repoRoot, defaultRepoRoot: DEFAULT_REPO_ROOT });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Persist a new container-group order (drag & drop in the UI);
// body: { order: [group names] }
app.put('/api/groups/order', (req, res) => {
  try {
    res.json({ order: setGroupOrder(req.body.order) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Repositories ----------

app.get('/api/repos', (req, res) => res.json(loadRepos()));

app.post('/api/repos', (req, res) => {
  const { name, url, dockerfile } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) {
    return res.status(400).json({ error: 'name must be lowercase alphanumeric (dots, dashes, underscores allowed)' });
  }
  const repos = loadRepos();
  if (repos.some(r => r.name === name)) {
    return res.status(409).json({ error: `repository "${name}" already exists` });
  }
  const repo = { name, url, dockerfile: dockerfile || 'Dockerfile', addedAt: Date.now(), lastBuilt: null };
  repos.push(repo);
  saveRepos(repos);
  res.json(repo);
});

// Persist a new repo order (drag & drop in the UI); body: { order: [names] }
app.put('/api/repos/order', (req, res) => {
  try {
    res.json(reorderRepos(req.body.order));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/repos/:name', (req, res) => {
  const repos = loadRepos();
  saveRepos(repos.filter(r => r.name !== req.params.name));
  res.json({ ok: true });
});

// Build a connected repo into an image (streams build output via SSE).
// Uses `docker build <git-url>` so the daemon clones the repo itself.
app.get('/api/repos/:name/build', (req, res) => {
  const repo = loadRepos().find(r => r.name === req.params.name);
  if (!repo) return res.status(404).end('unknown repository');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const tag = `${repo.name}:latest`;
  const args = ['build', '-t', tag, '-f', repo.dockerfile, repo.url];
  res.write(`data: ${JSON.stringify({ line: `$ docker ${args.join(' ')}` })}\n\n`);

  const proc = spawn('docker', args);
  const forward = chunk => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
  };
  proc.stdout.on('data', forward);
  proc.stderr.on('data', forward);
  proc.on('close', code => {
    if (code === 0) {
      const repos = loadRepos();
      const r = repos.find(x => x.name === repo.name);
      if (r) { r.lastBuilt = Date.now(); saveRepos(repos); }
      res.write(`data: ${JSON.stringify({ done: true, tag })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: `build failed (exit code ${code})` })}\n\n`);
    }
    res.end();
  });
  req.on('close', () => proc.kill());
});

// Start listening; port 0 picks a free port. Resolves with the actual port.
function start(port = PORT) {
  return new Promise(resolve => {
    const srv = app.listen(port, '127.0.0.1', () => {
      console.log(`dockeru running at http://localhost:${srv.address().port}`);
      resolve(srv.address().port);
    });
  });
}

if (require.main === module) start();
module.exports = { start };
