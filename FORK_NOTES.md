# BackIssue_jojo — fork notes

Fork of [BackIssueApp/BackIssue](https://github.com/BackIssueApp/BackIssue).
Primary repo: Gitea on Unraid (`http://192.168.2.44:3939/swkotor/BackIssue_jojo`),
push-mirrored to GitHub (`swkotor/BackIssue_jojo`). No GitHub Actions.

## Added: watch state + explicit wanted issues

Upstream computes "wanted" as *every ComicVine issue of a followed-or-owned
series that has no file*, with `series.followed` as a single global on/off. This
fork adds an explicit layer on top.

**`series.watch_state`** — `watched` | `paused` | `unwatched`

| State | New issues | Existing wanted issues |
|---|---|---|
| `watched` | automatically wanted | all missing issues wanted (overrides cleared) |
| `paused` | **not** wanted | kept — the current wanted set is frozen into `issue_wants` |
| `unwatched` | not wanted | none wanted (overrides cleared) |

`series.followed` is kept in sync (1 when watched) so plugins and legacy queries
still work.

**`issue_wants`** — explicit per-issue overrides keyed by ComicVine issue id.
A row always beats the series state, in both directions: cherry-pick one issue
from an unwatched series, or drop one from a watched series.

**Automation** keys off wanted-ness, not `followed` — so a paused series' still
wanted issues continue to be searched and grabbed (`WANTED_SQL` in `db.js` is
the single shared predicate).

### Migration
On first start: `followed=1` → `watched`, everything else → `paused`, and the
backlog of those paused (owned-but-unfollowed) series is frozen into
`issue_wants` so nothing silently stops being wanted.

### API
- `POST /api/series/watch-state` — `{ ids: [..], state }` (bulk)
- `GET  /api/series/wanted-counts?ids=1,2,3`
- `POST /api/issues/wanted` — `{ cvIssueIds: [..], wanted }` or `{ …, clear: true }`

### UI
- **Library page** — select series, then "Status…" in the bulk bar; rows show a
  pill for paused/unwatched.
- **Series page** — ⋯ menu has Watched / Paused / Unwatched.
- **Wanted page** — checkboxes per issue and per series, with a sticky bulk bar
  (Mark wanted / Not wanted / Download selected) and a `wanted` pill.

## Files owned by this fork
`FORK_NOTES.md`. Everything else is upstream code with marked `fork:` edits in
`src/db.js`, `src/server.js`, `frontend/src/components/{LibraryPage,SeriesDetail,WantedPage}.svelte`.

## Ops (on Unraid)
- `/mnt/user/appdata/backissue-jojo/deploy.sh` — test instance on **8790**
  (separate appdata copy).
- `deploy-inplace.sh` — replaces the stock **BackIssue** container in place:
  same name, port 8789, appdata and mounts, so tunnels/settings keep working.
  Previous container is preserved as `BackIssue_stock`; `rollback.sh` reverts.
- `update.sh` — Mondays 05:30 via cron: merge upstream → build-gate → push to
  Gitea → rebuild → redeploy → `/healthz`. Aborts and notifies on conflict or
  build failure. Log: `/var/log/backissue-jojo-update.log`.
