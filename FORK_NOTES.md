# BackIssue_jojo — fork notes

Fork of [BackIssueApp/BackIssue](https://github.com/BackIssueApp/BackIssue).
Primary repo: Gitea on Unraid (`http://192.168.2.44:3939/swkotor/BackIssue_jojo`),
push-mirrored to GitHub (`swkotor/BackIssue_jojo`). No GitHub Actions.

## Watch state — a tri-state view over upstream's monitoring (since 0.8.0)

Upstream 0.8.0 introduced its own monitoring model: `series.monitor` =
`all | new | none`, per-issue exceptions in `issue_picks` (want / skip), and a
single `wanted_issues` view that the Wanted page, search lanes, RSS and
announce watchers all read. The fork's earlier `watch_state` column and
`issue_wants` table were the same idea, so they were **folded onto upstream's**
rather than kept alongside it — one definition of "wanted".

| Fork state | Upstream meaning |
|---|---|
| `watched`   | `monitor` is `all` or `new` |
| `paused`    | `monitor = none` **and** the series has un-owned want picks (the frozen wanted set) |
| `unwatched` | `monitor = none`, no want picks |

`watch_state` is now *derived* (`watchStateOf()` in `db.js`, `PICK_WANTS_SQL`,
`WATCH_STATE_WHERE` for the `?ws=` filter). The bulk setters translate:

- `setSeriesWatchState(ids, 'paused')` — pins what `wanted_issues` says right
  now as want picks (`reason='paused'`), then `setMonitor('none')`.
- `'watched'` — drops the `paused`-reason picks (manual ones stay), `setMonitor('all')`.
- `'unwatched'` — `clearIssuePicks` + `setMonitor('none')` (queue rows are parked by `parkUnwanted`).
- `setIssuesWanted(cvIds, wanted|null)` groups by series and calls upstream's
  `setIssueWants` (minimal picks, queue parked); `dequeueUnwantedIssues` adds the
  number-matched park for queue rows carrying a stale cv id.

**Migration** (one-time, on first boot after the merge): `issue_wants` rows became
`issue_picks` where they disagreed with the new policy (`reason='migrated'`),
paused series were forced to `none`, then the old column/table were dropped.
Verified on Joel's library: 508 watched / 1 paused / 37 unwatched before and
after, `wanted_issues` = 102 = the old `WANTED_SQL` count.

### API (fork routes kept)
- `POST /api/series/watch-state` — `{ ids: [..], state }` (bulk)
- `GET  /api/series/wanted-counts?ids=1,2,3`
- `POST /api/issues/wanted` — `{ cvIssueIds | issueIds, wanted }` or `{ …, clear: true }`
- `?ws=watched|paused|unwatched` on `/api/collection` and `/api/collection/counts`

Upstream's own routes (`/api/collection/:id/monitor`, `/api/collection/:id/wanted`,
bulk `monitor`, `/api/lists/:id/want`) are used by the merged UI as-is.

### UI
- Series page: ▶ / ❚❚ / ▬ buttons next to upstream's policy tag and ⋯ menu
  (which also offers "New issues from #…" and "Forget picks").
- Library: status `<select>` filter and bulk **Status…** beside upstream's **Monitoring…**.
- Wanted page: upstream's (Wanted / All gaps, sorts, bulk selection) plus a
  per-series **Unwant series** button.
- Lists: upstream's **Want all** plus the fork's **Unwant all**.

## Other fork features
Read status (reader plugin's `reader_progress`, per user), the Publishers
browser (`franchise.js`, `/publishers`, separate `publisherCvKey`), derived
`pub_status` (Metron, else CV dates — feeds upstream's Ongoing/Ended chips),
Latest/Next issue sorts, `POST /api/collection/:id/delete-files`
(`library.manage`), reading-list Unwant-all, Back-to-origin on series pages.

## Files owned by this fork
`FORK_NOTES.md`, `src/franchise.js`, `frontend/src/components/PublishersPage.svelte`,
`.gitea/workflows/upstream-sync.yml`. Everything else is upstream code with marked
`fork:` edits — merge-conflict candidates: `src/db.js`, `src/server.js`, `src/index.js`,
`frontend/src/components/{LibraryPage,SeriesDetail,WantedPage,ListsPage,IssueModal,QueuePage}.svelte`,
`frontend/src/lib/{store,router}.svelte.js`, `frontend/src/App.svelte`.

## Ops (on Unraid)
- `/mnt/user/appdata/backissue-jojo/deploy.sh` — test instance on **8790**
  (separate appdata copy).
- `deploy-inplace.sh` — replaces the stock **BackIssue** container in place:
  same name, port 8789, appdata and mounts, so tunnels/settings keep working.
  Previous container is preserved as `BackIssue_stock`; `rollback.sh` reverts.
- `update.sh` — Mondays 05:30 via cron **and** the Gitea button (Actions →
  *Upstream sync* → Run workflow; SSH key in `.ssh/gitea_sync`, pinned to this
  script in root's `authorized_keys`, private half in the repo secret
  `UNRAID_SSH_KEY`): fetch → merge upstream → build-gate → boot-gate on a copy
  of the live DB (port 8791) → push to Gitea → `deploy-inplace.sh`. Aborts and
  notifies on conflict / build / boot failure. Log: `/var/log/backissue-jojo-update.log`.
