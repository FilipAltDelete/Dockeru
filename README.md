# dockeru

A minimal web UI for managing Docker on this machine: containers, images, and
git repositories you build into images.

## Run

```bash
npm install
npm start          # http://localhost:3300  (or PORT=xxxx npm start)
```

Requires access to `/var/run/docker.sock` and the `docker` CLI (used for git builds).

## Desktop app

`npm run app` opens the same UI as an Electron window with the server embedded
(random local port — no standalone webserver needed, and no conflict with one).
A launcher is installed at `~/.local/share/applications/dockeru.desktop`, so
"dockeru" also appears in the system application menu.

The launcher passes `--no-sandbox` only when Electron's `chrome-sandbox` helper
lacks its setuid permissions; to run fully sandboxed:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## CLI

The same functionality is available without the web server via `dockeru`
(symlinked into `~/.local/bin`, or run `./cli.js`). Run `dockeru help` for all
commands; highlights:

```bash
dockeru ps               # grouped container list (same bundling as the UI)
dockeru start repo   # start a master folder, project, or single container
dockeru up repo # docker compose up -d in the project dir
dockeru logs <name> -f   # follow logs
dockeru repos add app https://github.com/user/app.git && dockeru build app
```

## Features

- **Containers** — list running and stopped containers, start / stop / restart /
  remove, view the last 300 log lines. The list auto-refreshes every 5 s.
- **Images** — list local images, pull from Docker Hub or any registry
  (e.g. `nginx:alpine`, `ghcr.io/org/app:tag`) with live progress, remove,
  and run a container from an image (with optional name, port mappings
  `host:container`, and `KEY=val` environment variables).
- **Repositories** — connect a git repository by URL. **Build** runs
  `docker build <git-url>` (the Docker daemon clones the repo itself, so the
  repo needs a Dockerfile) and tags the result `<name>:latest`, streaming the
  build output live. After a build you can launch containers from it.
  Private repos work with URLs that embed credentials or over ssh if the
  daemon host has keys set up. Connected repos are stored in `data/repos.json`.

## Notes

- The server has **no authentication** — it exposes full Docker control.
  Keep it bound to localhost; don't expose the port to a network.
