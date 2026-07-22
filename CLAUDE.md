# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start            # web UI on http://localhost:3300 (PORT=xxxx to override)
npm run app          # same UI as an Electron desktop window (embedded server, random port)
./cli.js <cmd>       # CLI; also symlinked as `dockeru` into ~/.local/bin
```

There are no tests, no linter, and no build step. The frontend is plain
JS/HTML/CSS served statically from `public/` — reload the browser to see
changes; restart the server for backend changes.

Requires access to `/var/run/docker.sock` and the `docker` CLI on PATH
(compose up and git-URL builds shell out to `docker`; everything else goes
through dockerode).

## Architecture

Three frontends share one core, `lib.js`:

- `server.js` — Express API + static `public/` (web UI). `start(port)` is
  exported and also used by `electron/main.js`, which embeds the server on a
  random port. Port 3300 binds to 127.0.0.1 only — the API has **no auth** and
  exposes full Docker control, so it must never listen on a network interface.
- `cli.js` — same functionality without the server, calling `lib.js` directly.
- `public/app.js` — single-file vanilla-JS frontend; no framework, no bundler.
  Renders HTML strings (always escape user data with `esc()`), uses event
  delegation on list containers.

### Core concepts in lib.js

- **Repo root**: the folder scanned for compose projects. Resolution order:
  `data/settings.json` `repoRoot` (set from the UI's ⚙ dialog or
  `PUT /api/settings`) → `REPO_ROOT` env var → parent directory of this repo.
  Always read it per-call via `getRepoRoot()` — it can change at runtime;
  don't cache it at module load.
- **Grouping hierarchy**: containers are bundled into *projects* (compose
  project label, falling back to connected-repo image name), and projects
  whose directory sits two levels below the repo root are bundled under a
  *master* folder (e.g. `<root>/swedsnus/swedsnus-test` → master `swedsnus`).
  `findComposeProjects()` scans one and two levels deep for compose files;
  `listContainers()` attaches `group` (project) and `parent` (master) to each
  container using the compose working_dir label. The web UI and CLI `ps`
  build the same master → project → container tree independently — a change
  to grouping logic usually needs mirroring in `public/app.js` and `cli.js`.
- **Connected repos**: git URLs stored in `data/repos.json`, built with
  `docker build <git-url>` (the daemon clones; the repo never exists on disk
  here). Tagged `<name>:latest`.

### Conventions

- `data/` is gitignored runtime state (`repos.json`, `settings.json`);
  read/write only through the load/save helpers in `lib.js`.
- Long-running operations (image pull, compose up, repo build) stream to the
  browser as SSE (`text/event-stream`) with JSON lines
  `{line}` / `{done}` / `{error}`; the frontend consumes them via
  `streamToOverlay()`. Follow this pattern for any new streaming endpoint,
  and kill spawned processes on `req.on('close')`.
- Compose file detection accepts `docker-compose.yml|yaml` and
  `compose.yml|yaml` (`COMPOSE_FILES` in `lib.js`).
