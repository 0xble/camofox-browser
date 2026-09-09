# local-storage-checkpoint

A local, separately maintained Camofox plugin for the standalone Mac Studio deployment.

It adds only:

- `GET /sessions/:userId/storage_state`

The route uses the supported plugin context (`ctx.auth()`, `ctx.sessions`, logging, and persistence storage-state options). It exports the active Playwright context once, checkpoints that exact snapshot through the upstream `lib/persistence.js` helper, and returns JSON only after `persisted === true`.

It does **not** enable, import, or start VNC/noVNC/watchers. It does not bind ports, change Camofox core, or log cookies, storage values, or authorization headers.

## Install/update

Canonical source is this fork directory: `plugins/local-storage-checkpoint/`.
The deployment packages it with the reviewed release source; it does not use the
old standalone `local-plugins` copy as source of truth. To use Camofox's
supported local plugin installer for a separately staged package, set the exact
staged package directory and install from this fork checkout:

```sh
cd "$CAMOFOX_PACKAGE_DIR"
npm run plugin install /Users/brianle/.worktrees/camofox-browser-fork-foundation/plugins/local-storage-checkpoint
```

Reinstall updates should remove the installed plugin first with `npm run plugin remove local-storage-checkpoint`, then run the install command. Do not modify `server.js`, the VNC plugin, or `lib/persistence.js`.

## Test

The test starts a real local HTTP Express route against a copied plugin fixture and real upstream persistence helper. It verifies successful snapshot persistence, persistence-write failure as HTTP 500 without a snapshot response, and unauthorized access as HTTP 401 before `storageState()` runs.

```sh
CAMOFOX_PACKAGE_DIR=/path/to/staged/camofox-browser \
  /Users/brianle/.local/share/mise/installs/node/24.18.0/bin/node --test index.test.js
```
