# Shared persistent identity maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream identity routing, cookie restoration, and handoff behavior with this patch. Adopt changes only when the recorded unit and disposable-browser proofs preserve the shared lifecycle.

### CAMOFOX-002: shared persistent identity lifecycle

- **Status:** Active; managed installation is authorized only from the landed fork SHA.
- **Stable subject:** `Add shared persistent identity lifecycle` (`85d2f3f`).
- **Behavior:** native Hermes opaque IDs and optional local aliases resolve to one profile; session-only cookies restore only after a clean close; human handoff serializes with tab work and blocks agent operations.
- **Surfaces:** `server.js`, `lib/shared-identity.js`, `lib/config.js`, `docs/shared-persistent-browser-spec.md`
- **Upstream issue/PR:** None after checked 2026-09-10.
- **Regression:** `npm run test:unit` plus the disposable shared-browser acceptance harness.
- **Rollback:** `git revert <CAMOFOX-002 commit>`; do not delete preserved profiles.
- **Retire when:** upstream ships equivalent lifecycle and identity-routing semantics.
