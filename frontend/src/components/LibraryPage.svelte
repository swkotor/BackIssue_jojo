<script>
  // The Library: a poster wall of every volume (grid), or a dense table
  // (list) for power flows. Replaces the old side rail as the main '/' view.
  import { navigate, route, setQuery } from '../lib/router.svelte.js';
  import { rail, railSelect, ops, loadCollection, loadMoreCollection } from '../lib/store.svelte.js';
  import { status } from '../lib/status.svelte.js';
  import { apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, humanBytes, windowRange } from '../lib/util.js';
  import Cover from './Cover.svelte';
  import { openAddModal } from './AddModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { isTrusted } from '../lib/auth.svelte.js';
  import { libraryFilterFor } from '../lib/plugins.svelte.js';
  import FiltersModal from './FiltersModal.svelte';
  import Icon from '../lib/Icon.svelte';

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'incomplete', label: 'Incomplete' },
    { key: 'followed', label: 'Followed' },
    { key: 'unmonitored', label: 'Not monitored' },
    { key: 'problems', label: 'Problems' },
    { key: 'unmatched', label: 'Unmatched' },
  ];

  // Grid ⊞ / list ≣ — a device preference, not a URL one.
  let view = $state(localStorage.getItem('libraryView') || 'grid');
  function setView(v) { view = v; localStorage.setItem('libraryView', v); }

  // Home vs. browse. Home ('/') shows only the account's reading rails (a plugin
  // fills #home-plugin-rail); opening a library — or searching — swaps to the
  // poster/list grid. "Browsing" = any URL that names a library, a type lane, a
  // search, or the all-items view. The grid + its toolbar render only then.
  const browsing = $derived.by(() => {
    const p = new URLSearchParams(route.search);
    return !!(p.get('library') || p.get('filter') || p.get('q') || p.get('all') || p.get('collections'));
  });
  const homeMode = $derived(!browsing);
  // "Collections" view: the library grid restricted to multi-volume book/
  // audiobook series (box sets) — driven by ?collections=1 from the sidebar.
  const isCollections = $derived(new URLSearchParams(route.search).get('collections') === '1');

  // Faceted filtering: a plugin can supply filters for a library type
  // (registerLibraryFilters). Core shows a Filters button that opens a modal and
  // narrows the real grid — the selection is an opaque object stored in the URL's
  // ?facet= param, resolved to matching series on the server.
  const currentLibrary = $derived.by(() => {
    const id = new URLSearchParams(route.search).get('library');
    return id ? (status.libraries || []).find((l) => String(l.id) === id) || null : null;
  });
  const currentType = $derived.by(() => {
    if (currentLibrary) return currentLibrary.type;
    const f = new URLSearchParams(route.search).get('filter');
    return f && ['ebook', 'audiobook', 'manga'].includes(f) ? f : null;
  });
  const filterProvider = $derived(currentType ? libraryFilterFor(currentType) : null);
  let filtersOpen = $state(false);
  const facetSelection = $derived.by(() => {
    const f = new URLSearchParams(route.search).get('facet');
    if (!f) return {};
    try { return JSON.parse(f); } catch { return {}; }
  });
  const facetCount = $derived(Object.values(facetSelection).reduce((n, v) => n + (Array.isArray(v) ? v.length : (v ? 1 : 0)), 0));
  function applyFacets(sel) {
    const has = sel && Object.keys(sel).length;
    setQuery({ facet: has ? JSON.stringify(sel) : null });
  }

  function libQuery(filter) {
    const p = new URLSearchParams(route.search);
    if (filter && filter !== 'all') p.set('filter', filter); else p.delete('filter');
    const s = p.toString();
    return s ? '?' + s : '';
  }

  // Carry the library's params (filter/search/sort) onto a volume link so
  // opening a series keeps the active filter when you come Back.
  function libParams() {
    const cur = new URLSearchParams(route.search);
    const p = new URLSearchParams();
    for (const k of ['filter', 'q', 'sort', 'collections']) { const v = cur.get(k); if (v) p.set(k, v); }
    const s = p.toString();
    return s ? '?' + s : '';
  }

  function pickFilter(key) {
    navigate(location.pathname + libQuery(key), { replace: true });
  }

  // fork: short, readable issue dates for the list view ("12 Mar 25").
  function shortDate(d) {
    if (!d) return '';
    const t = new Date(d + 'T00:00:00');
    if (Number.isNaN(t.getTime())) return String(d);
    return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
  }
  // Days until an upcoming issue, for the tooltip.
  function inDays(d) {
    if (!d) return '';
    const n = Math.round((new Date(d + 'T00:00:00') - new Date()) / 86400000);
    return n <= 0 ? 'due' : n === 1 ? 'tomorrow' : `in ${n} days`;
  }

  // fork: remember the last row clicked so shift-click can select a range
  let lastPicked = $state(null);

  function open(s, e) {
    if (!rail.selecting) return navigate('/volume/' + s.id + libParams());
    pickSeries(s, e);
  }

  // Toggle one series, or — with shift held — every series between the last
  // one picked and this one (in the order they're displayed).
  function pickSeries(s, e) {
    const rows = rail.rows || [];
    if (e?.shiftKey && lastPicked != null) {
      const a = rows.findIndex((r) => r.id === lastPicked);
      const b = rows.findIndex((r) => r.id === s.id);
      if (a !== -1 && b !== -1) {
        const [from, to] = a < b ? [a, b] : [b, a];
        const on = !railSelect.has(s.id);
        for (let i = from; i <= to; i++) {
          if (on) railSelect.add(rows[i].id); else railSelect.delete(rows[i].id);
        }
        lastPicked = s.id;
        return;
      }
    }
    if (railSelect.has(s.id)) railSelect.delete(s.id); else railSelect.add(s.id);
    lastPicked = s.id;
  }

  // fork: bulk watch state for the selected series
  async function setWatchState(state) {
    const ids = [...railSelect];
    if (!ids.length) return;
    const r = await apiPost('/api/series/watch-state', { ids, state });
    if (r?.error) { notify(r.error, 'error'); return; }
    for (const row of rail.rows || []) {
      if (railSelect.has(row.id)) { row.watch_state = state; row.followed = state === 'watched' ? 1 : row.followed; }
    }
    rail.rows = [...(rail.rows || [])];
    notify(`${ids.length} series set to ${state}.`, 'ok');
  }

  async function toggleMon(s) {
    const follow = !s.followed;
    s.followed = follow ? 1 : 0; // optimistic — personal follow, not the monitor flag
    const r = await apiPost('/api/collection/' + s.id + '/follow', { follow });
    if (r?.error) { s.followed = follow ? 0 : 1; notify(r.error, 'error'); }
  }

  function toggleSelecting() {
    rail.selecting = !rail.selecting;
    railSelect.clear();
  }

  async function bulk(action) {
    if (!railSelect.size) return notify('Select some series first.', 'info');
    if (action === 'remove' && !(await confirmDialog({
      title: `Remove ${railSelect.size} series?`,
      message: 'They are removed from the collection — their files stay on disk.',
      confirmLabel: 'Remove', danger: true,
    }))) return;
    if (action === 'download-missing' && !(await confirmDialog({
      title: `Download missing issues of ${railSelect.size} series?`,
      message: 'Every missing issue is queued for download.',
      confirmLabel: 'Queue downloads',
    }))) return;
    const r = await apiPost('/api/collection/bulk', { ids: [...railSelect], action });
    if (r.error) return notify(r.error, 'error');
    notify(action === 'download-missing' ? `Queued ${fmt(r.queued)} issue(s).` : `Done — ${fmt(r.done)} series.`, 'ok');
    railSelect.clear();
    loadCollection();
  }

  // Bulk move into a library (or back to the default). The library's type —
  // and its restricted flag — ride along, same as the single-series move.
  async function moveSelected(libraryId) {
    if (!railSelect.size) return notify('Select some series first.', 'info');
    const lib = (status.libraries || []).find((l) => l.id === libraryId);
    const r = await apiPost('/api/collection/bulk', { ids: [...railSelect], action: 'move-library', libraryId });
    if (r.error) return notify(r.error, 'error');
    notify(`Moved ${fmt(r.done)} series to ${lib ? lib.name : 'the default library'}.`, 'ok');
    railSelect.clear();
    loadCollection();
  }

  // --- ComicVine matching (bulk) --- busy state + progress mirror the
  // server's op state (ops store, fed by SSE).
  const cvBusy = $derived(!!ops.cv.running);
  const cvText = $derived(ops.cv.running
    ? 'Matching… ' + fmt(ops.cv.done || 0) + (ops.cv.total ? '/' + fmt(ops.cv.total) : '')
    : 'Match ComicVine');
  let cvTitle = $state('Match owned & followed series to ComicVine');
  async function startCvMatch() {
    if (ops.cv.running) return;
    ops.cv = { running: true, done: 0, total: 0 }; // optimistic until the next SSE tick
    await apiPost('/api/cv/match', {});
  }
  let sawCv = false;
  $effect(() => {
    const st = ops.cv;
    if (st.running) { sawCv = true; return; }
    if (!sawCv) return;
    sawCv = false;
    if (st.error) notify('ComicVine match error: ' + st.error, 'error');
    else if (st.matched != null) {
      cvTitle = st.matched + ' matched, ' + (st.ambiguous || 0) + ' need a manual pick';
      notify(st.matched + ' matched' + (st.ambiguous ? ' — ' + st.ambiguous + ' need a manual pick (see the Unmatched filter)' : '.'), 'ok');
    }
    loadCollection();
  });

  const pct = (s) => (s.total ? Math.min(100, Math.round((s.owned / s.total) * 100)) : 0);
  // "Done" = fully owned. On-demand series (available, un-owned books that fetch
  // on open) have missing===0 too, but they aren't complete — they read as
  // available, not green-done.
  const isDone = (s) => s.total > 0 && s.missing === 0 && !s.on_demand;

  /* ---- Virtualized posters & rows ----
     Same windowing as the volume page (see SeriesDetail): a big library must
     not render a card per series. Above the threshold, only the rows in view
     (+overscan) mount; spacers keep the scrollbar honest. */
  const VIRTUAL_MIN = 200;
  let scroller = $state(null);
  let scrollTop = $state(0);
  let viewH = $state(800);
  let stride = $state(260);      // row height incl. gap, measured
  let cols = $state(1);          // posters per row (1 in list view), measured
  let listTop = $state(0);       // px from scroll-top to the grid (home rail height)

  const virtual = $derived(rail.rows.length > VIRTUAL_MIN);
  const range = $derived.by(() => {
    const n = rail.rows.length;
    if (!virtual) return { start: 0, end: n, padTop: 0, padBottom: 0 };
    return windowRange({ n, cols: view === 'grid' ? cols : 1, stride, viewH, scrollTop, listTop, overscan: 6 });
  });
  // Infinite scroll: when the rendered window nears the end of what's LOADED and
  // more rows exist server-side, pull the next page. The window is virtualized
  // over the loaded prefix (range.end is clamped to rail.rows.length), so this
  // fires as the viewport's bottom overscan reaches the tail — a few rows early.
  $effect(() => {
    void range.end; void rail.rows.length; void rail.total; void rail.loadingMore;
    if (!rail.loaded) return;
    const c = view === 'grid' ? cols : 1;
    if (range.end >= rail.rows.length - c * 4 && rail.rows.length < rail.total) loadMoreCollection();
  });

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (scroller) scrollTop = scroller.scrollTop; });
  }
  function measure() {
    if (!scroller) return;
    viewH = scroller.clientHeight || viewH;
    const items = scroller.querySelectorAll(view === 'grid' ? '.libx-card' : '.libx-row');
    if (items.length >= 2) {
      const top0 = items[0].offsetTop;
      let c = 1;
      while (c < items.length && items[c].offsetTop === top0) c++;
      cols = Math.max(1, c);
      const next = items[c] || items[1];
      const d = next.offsetTop - top0;
      if (d > 10) stride = d;
    }
    const listEl = scroller.querySelector('.libx-grid, .libx-list');
    listTop = listEl ? listEl.offsetTop : 0;
  }
  $effect(() => { void rail.rows; void view; measure(); });
  // The home rail is filled by a plugin (plain DOM), so Svelte can't see it
  // change height or gain shelves — watch it, re-measure listTop when shelves
  // appear/hide, and track whether any shelf rendered (drives the home hint).
  let railHasContent = $state(false);
  // The rails are filled by plugins that fetch asynchronously, so on a fresh
  // load the slot is briefly empty — showing "Welcome back" for a beat before
  // the rails pop in. Suppress the empty state until the rails have had a chance
  // to render: a home that had rails last time waits for them (or a 2s safety
  // cap); a genuinely empty home shows the welcome immediately.
  let railSettled = $state(false);
  const HAD_RAILS_KEY = 'home-had-rails';
  const rememberRails = (has) => { try { localStorage.setItem(HAD_RAILS_KEY, has ? '1' : '0'); } catch { /* private mode */ } };
  $effect(() => {
    if (!homeMode) return;
    let hadBefore = false;
    try { hadBefore = localStorage.getItem(HAD_RAILS_KEY) === '1'; } catch { /* private mode */ }
    // While unsettled a skeleton shows (never a blank or a welcome flash). A
    // home that had rails last time waits generously for them; one that
    // didn't settles quickly to the welcome state — the skeleton just bridges
    // the first paint either way.
    const t = setTimeout(() => { railSettled = true; if (!railHasContent) rememberRails(false); }, hadBefore ? 5000 : 1500);
    return () => clearTimeout(t);
  });
  $effect(() => {
    if (typeof ResizeObserver === 'undefined' || !scroller) return;
    const railEl = scroller.querySelector('#home-plugin-rail');
    if (!railEl) return;
    const sync = () => {
      const has = railEl.children.length > 0;
      railHasContent = has;
      if (has) { railSettled = true; rememberRails(true); }   // rails arrived — reveal, never flash the empty state
      else if (railSettled) rememberRails(false);             // only record "empty" once settled (not mid-fetch)
      measure();
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(railEl);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(sync) : null;
    mo?.observe(railEl, { childList: true });
    return () => { ro.disconnect(); mo?.disconnect(); };
  });
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
  // Filter/search/sort/library changes swap the row set — snap back to the top
  // so the infinite-scroll window restarts from page 1's rows.
  $effect(() => {
    void rail.filter; void rail.search; void rail.sort; void rail.library;
    if (scroller && scroller.scrollTop > 0) { scroller.scrollTop = 0; scrollTop = 0; }
  });
</script>

<section class="librarypage libx" class:is-home={homeMode}>
  {#if !homeMode}
  <!-- toolbar: count · filters (with counts) · sort · view · actions -->
  <div class="libx__bar">
    <span class="libx__count">{isCollections ? 'Collections' : 'Library'} <span id="series-count">{rail.loaded ? fmt(rail.total) : ''}</span></span>
    <div class="libx__filters">
      {#each FILTERS as f (f.key)}
        {@const n = rail.counts?.[f.key]}
        <button class="libx__chip" class:is-active={rail.filter === f.key} onclick={() => pickFilter(f.key)}>
          {f.label}{#if n}<span class="libx__chip-count">{fmt(n)}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="libx__spacer"></div>
    <select id="coll-sort" class="libx__sort" title="Sort the collection" value={rail.sort}
      onchange={(e) => setQuery({ sort: e.currentTarget.value === 'title' ? null : e.currentTarget.value })}>
      <option value="title">A–Z</option>
      <option value="added">Recently added</option>
      <option value="missing">Most missing</option>
      <option value="latest">Latest issue (newest)</option>
      <option value="latest-asc">Latest issue (oldest)</option>
      <option value="next">Next issue (soonest)</option>
      <option value="next-desc">Next issue (latest)</option>
    </select>
    <div class="libx__view" role="group" aria-label="View">
      <button class="libx__viewbtn" class:is-active={view === 'grid'} title="Poster grid" onclick={() => setView('grid')}><Icon name="grid" size={15} /></button>
      <button class="libx__viewbtn" class:is-active={view === 'list'} title="List" onclick={() => setView('list')}><Icon name="list" size={15} /></button>
    </div>
    {#if filterProvider}
      <button class="libx__act" class:is-active={facetCount > 0} title="Filter this library" onclick={() => (filtersOpen = true)}>
        <Icon name="filter" size={14} /> Filters{#if facetCount}<span class="libx__chip-count">{facetCount}</span>{/if}
      </button>
    {/if}
    {#if isTrusted()}
      <button id="coll-select-btn" class="libx__act" class:is-active={rail.selecting} title="Select multiple series for bulk actions" onclick={toggleSelecting}><Icon name="check-square" size={14} /> Select</button>
      <button id="cvmatch-btn" class="libx__act" title={cvTitle} disabled={cvBusy} onclick={startCvMatch}><span class="libx__cvicon"><Icon name="diamond" size={14} /></span>{cvText}</button>
      <button id="add-series-btn" class="libx__add" onclick={() => openAddModal()}><Icon name="plus" size={15} /> Add</button>
    {/if}
  </div>

  {#if rail.selecting}
    <div id="coll-bulkbar" class="libx__bulk">
      <span id="coll-bulk-count" class="libx__bulk-count">{railSelect.size} selected</span>
      <button class="libx__link" onclick={() => bulk('follow')}><Icon name="star" fill size={14} /> Follow</button>
      <button class="libx__link" onclick={() => bulk('unfollow')}><Icon name="star" size={14} /> Unfollow</button>
      <button class="libx__link" onclick={() => bulk('download-missing')}><Icon name="download" size={14} /> Download missing</button>
      <select class="libx__movesel" title="Watched: new issues are wanted automatically. Paused: keep current wants, don't add new ones. Unwatched: want nothing."
        onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v) setWatchState(v); }}>
        <option value="">Status…</option>
        <option value="watched">Watched</option>
        <option value="paused">Paused</option>
        <option value="unwatched">Unwatched</option>
      </select>
      {#if (status.libraries || []).length}
        <select class="libx__movesel" title="Move the selected series into a library"
          onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v !== '') moveSelected(v === 'default' ? null : Number(v)); }}>
          <option value="">Move to…</option>
          {#each status.libraries as lib (lib.id)}<option value={lib.id}>{lib.name}</option>{/each}
        </select>
      {/if}
      <button class="libx__remove" onclick={() => bulk('remove')}>Remove</button>
    </div>
  {/if}
  {/if}

  <div class="libx__scroll" id="series-list" bind:this={scroller} onscroll={onScroll} class:is-browse={!homeMode}>
    <!-- Plugin home rail (reading shelves etc.) injects here — plain DOM, must
         stay mounted (never gate behind {#if}). Its height feeds listTop; it's
         hidden by CSS while browsing so rails are a Home-only surface. -->
    <div id="home-plugin-rail" class="home-rail"></div>
    {#if homeMode}
      {#if railSettled && !railHasContent}
        <div class="libx__empty">
          <div class="libx__empty-art"><Icon name="home" size={26} /></div>
          <div class="libx__empty-title">Welcome back</div>
          <div class="libx__empty-body">Your reading shelves appear here as you read. Pick a library from the sidebar to browse everything in it.</div>
        </div>
      {:else if !railHasContent}
        <!-- Skeleton shelves while the plugin rails fetch — unmounts the moment
             a real rail lands in the slot above. Two rails mirror what usually
             renders: 2:3 comic covers, then square audiobook covers. -->
        <div class="railskel" aria-hidden="true">
          {#each [{ ratio: 'comic', n: 8 }, { ratio: 'square', n: 8 }] as rail, r}
            <div class="railskel__rail">
              <div class="railskel__title" style="animation-delay: {r * 120}ms"></div>
              <div class="railskel__track">
                {#each Array(rail.n) as _, i}
                  <div class="railskel__card railskel__card--{rail.ratio}" style="animation-delay: {(r * 4 + i) * 90}ms"></div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if rail.loaded && !rail.rows.length}
      <div class="libx__empty">
        <div class="libx__empty-art"><Icon name="star" size={26} /></div>
        <div class="libx__empty-title">{rail.search || rail.filter !== 'all' ? 'No matches' : 'Nothing here yet'}</div>
        <div class="libx__empty-body">{rail.search || rail.filter !== 'all' ? 'Try a different search or filter.'
          : isTrusted() ? 'Click Add to pull a series from ComicVine, or Import an existing library.'
          : 'Nothing here yet — a trusted user or admin can add series to the library.'}</div>
      </div>
    {:else if view === 'grid'}
      <div class="libx-grid">
        {#if range.padTop > 0}<div class="libx-grid__pad" style="height:{range.padTop}px"></div>{/if}
        {#each rail.rows.slice(range.start, range.end) as s (s.id)}
          <div class="libx-card ws-{s.watch_state || 'watched'}" class:is-selected={rail.selecting && railSelect.has(s.id)}
            onclick={(e) => open(s, e)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') open(s, e); }}>
            <div class="libx-card__art" class:is-unmatched={!s.matched}>
              <Cover coverUrl={s.matched ? s.cover_url : null} title={s.matched ? s.title : (s.folder || '?')} />
              {#if rail.selecting}
                <input type="checkbox" class="libx-card__cb" checked={railSelect.has(s.id)}
                  title="Select (shift-click to select a range)"
                  onclick={(e) => { e.stopPropagation(); pickSeries(s, e); }} />
              {/if}
              {#if s.watch_state}
                <span class="wsym wsym--{s.watch_state} libx-card__wsym"
                  title={s.watch_state === 'watched' ? 'Watched — new issues are wanted automatically'
                    : s.watch_state === 'paused' ? 'Paused — existing wanted issues kept, new ones not added'
                    : 'Unwatched — nothing in this series is wanted'}>
                  {#if s.watch_state === 'watched'}▶{:else if s.watch_state === 'paused'}❚❚{:else}▬{/if}
                </span>
              {/if}
              {#if s.followed}<span class="libx-card__star" title="Followed"><Icon name="star" fill size={15} /></span>{/if}
              {#if !s.matched}<span class="libx-card__matchchip">match…</span>{/if}
              {#if s.matched}<div class="libx-card__bar"><div class="libx-card__fill" class:is-done={isDone(s)} style="width:{pct(s)}%"></div></div>{/if}
            </div>
            {#if s.matched}
              <div class="libx-card__title" title={s.title}>{s.title}{#if s.year}<span class="libx-card__year"> ({s.year})</span>{/if}</div>
              <div class="libx-card__meta">
                <span class="libx-card__count">{s.owned}/{s.total}</span>
                {#if s.on_demand}<span class="libx-badge libx-badge--avail" title="{fmt(s.available)} available on demand"><Icon name="download" size={11} /> {fmt(s.available)}</span>{/if}
                {#if s.corrupt > 0}<span class="libx-card__flag libx-card__flag--bad" title="{fmt(s.corrupt)} corrupt file(s)">!</span>{/if}
              </div>
            {:else}
              <div class="libx-card__title libx-card__title--unmatched" title={s.folder}>{s.folder || 'Unidentified series'}</div>
              <div class="libx-card__meta">{#if s.files}<span class="libx-card__count">{fmt(s.files)} files</span>{/if}</div>
            {/if}
          </div>
        {/each}
        {#if range.padBottom > 0}<div class="libx-grid__pad" style="height:{range.padBottom}px"></div>{/if}
      </div>
    {:else}
      <div class="libx-list">
        <div class="libx-list__head">
          <span></span><span>Title</span><span>Progress</span>
          <span class="libx-col--wide">Latest</span><span class="libx-col--wide libx-col--right">Size</span><span></span>
        </div>
        {#if range.padTop > 0}<div style="height:{range.padTop}px"></div>{/if}
        {#each rail.rows.slice(range.start, range.end) as s (s.id)}
          <div class="libx-row ws-{s.watch_state || 'watched'}" class:is-selected={rail.selecting && railSelect.has(s.id)}
            onclick={(e) => open(s, e)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') open(s, e); }}>
            {#if rail.selecting}
              <input type="checkbox" class="libx-row__cb" checked={railSelect.has(s.id)}
                title="Select (shift-click to select a range)"
                onclick={(e) => { e.stopPropagation(); pickSeries(s, e); }} />
            {/if}
            {#if s.watch_state}
              <span class="wsym wsym--{s.watch_state} libx-row__wsym"
                title={s.watch_state === 'watched' ? 'Watched — new issues are wanted automatically'
                  : s.watch_state === 'paused' ? 'Paused — existing wanted issues kept, new ones not added'
                  : 'Unwatched — nothing in this series is wanted'}>
                {#if s.watch_state === 'watched'}▶{:else if s.watch_state === 'paused'}❚❚{:else}▬{/if}
              </span>
            {/if}
            <Cover coverUrl={s.matched ? s.cover_url : null} title={s.matched ? s.title : (s.folder || 'Unidentified series')} />
            <div class="libx-row__main">
              <div class="libx-row__title" class:is-unmatched={!s.matched}>{s.matched ? s.title : (s.folder || 'Unidentified series')}{#if s.matched && s.year}<span class="libx-row__year"> ({s.year})</span>{/if}</div>
              <div class="libx-row__badges">
                {#if !s.matched}
                  <span class="libx-badge libx-badge--warn">needs match</span>
                  {#if s.files}<span class="libx-row__pub">{fmt(s.files)} files</span>{/if}
                {:else}
                  {#if s.publisher}<span class="libx-row__pub">{s.publisher}</span>{/if}
                  {#if s.active > 0}<span class="libx-badge libx-badge--busy">{fmt(s.active)} downloading</span>{/if}
                  {#if s.missing > 0}<span class="libx-badge libx-badge--miss">{fmt(s.missing)} missing</span>
                  {:else if s.on_demand}<span class="libx-badge libx-badge--avail"><Icon name="download" size={12} /> {fmt(s.available)} available</span>
                  {:else if s.total > 0}<span class="libx-badge libx-badge--ok">complete</span>{/if}
                  {#if s.untagged > 0}<span class="libx-badge libx-badge--plain">{fmt(s.untagged)} untagged</span>{/if}
                  {#if s.corrupt > 0}<span class="libx-badge libx-badge--warn">{fmt(s.corrupt)} corrupt</span>{/if}
                  {#if s.restricted}<span class="libx-badge libx-badge--plain" title="Mature — hidden from roles without “View mature content”">mature</span>{/if}
                {/if}
              </div>
            </div>
            <div class="libx-row__progress">
              <span class="libx-row__nums">{s.matched ? `${s.owned}/${s.total}` : (s.files ? `${fmt(s.files)} files` : '—')}</span>
              {#if s.matched}<span class="libx-row__track"><span class="libx-row__fill" class:is-done={isDone(s)} style="width:{pct(s)}%"></span></span>{/if}
            </div>
            <span class="libx-row__dim libx-col--wide" title="Newest known issue's cover date">{s.matched ? (s.latest || '—') : '—'}</span>
            <span class="libx-row__dim libx-col--wide libx-col--right">{s.size ? humanBytes(s.size) : '—'}</span>
            {#if isTrusted()}
              {#if s.last_issue_date || s.next_issue_date}
                <span class="libx-row__dates">
                  {#if s.last_issue_date}
                    <span class="libx-row__date" title="Most recent released issue: {s.last_issue_date}">
                      <Icon name="clock" size={11} /> {shortDate(s.last_issue_date)}
                    </span>
                  {/if}
                  {#if s.next_issue_date}
                    <span class="libx-row__date is-next" title="Next issue due: {s.next_issue_date} ({inDays(s.next_issue_date)})">
                      → {shortDate(s.next_issue_date)}
                    </span>
                  {/if}
                </span>
              {/if}

              <button class="libx-row__star" class:is-on={s.followed} title={s.followed ? 'Followed — click to unfollow' : 'Not followed — click to follow'} aria-label={s.followed ? 'Unfollow' : 'Follow'} onclick={(e) => { e.stopPropagation(); toggleMon(s); }}><Icon name="star" fill={!!s.followed} size={15} /></button>
            {:else}<span></span>{/if}
          </div>
        {/each}
        {#if range.padBottom > 0}<div style="height:{range.padBottom}px"></div>{/if}
      </div>
    {/if}
  </div>
</section>

<FiltersModal open={filtersOpen} type={currentType} libraryId={currentLibrary?.id ?? null}
  selection={facetSelection} onapply={applyFacets} onclose={() => (filtersOpen = false)} />

<style>
  .libx { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .libx__bar { display: flex; align-items: center; gap: 8px; padding: 11px 18px; border-bottom: 1px solid var(--line); flex: none; overflow-x: auto; scrollbar-width: none; }
  .libx__bar::-webkit-scrollbar { display: none; }
  .libx__count { font: 13px var(--font-mono); color: var(--faint); white-space: nowrap; flex: none; }
  .libx__count span { color: var(--text); }
  .libx__filters { display: flex; align-items: center; gap: 6px; flex: none; }
  .libx__chip { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .libx__chip.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .libx__chip-count { font: 600 10.5px var(--font-mono); background: var(--panel-2); color: var(--faint); border-radius: 999px; padding: 1px 6px; }
  .libx__chip.is-active .libx__chip-count { background: rgba(255,255,255,.2); color: #fff; }
  .libx__spacer { flex: 1; min-width: 8px; }
  .libx__sort { height: 32px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 12.5px var(--font-body); flex: none; }
  .libx__sort:focus { outline: none; border-color: var(--accent); }
  .libx__view { display: flex; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 2px; flex: none; }
  .libx__viewbtn { width: 30px; height: 28px; display: grid; place-items: center; border: none; border-radius: 6px; cursor: pointer; background: transparent; color: var(--faint); }
  .libx__viewbtn.is-active { background: var(--panel-2); color: var(--text); }
  .libx__act { height: 36px; padding: 0 13px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; flex: none; }
  .libx__act.is-active { border-color: var(--accent); background: rgba(255,45,111,.1); color: var(--accent); }
  .libx__act:disabled { opacity: .7; cursor: default; }
  .libx__cvicon { display: flex; color: var(--cyan); }
  .libx__add { height: 36px; padding: 0 15px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 13px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; flex: none; }

  .libx__bulk { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid var(--line); background: rgba(255,45,111,.06); flex: none; flex-wrap: wrap; }
  .libx__bulk-count { font: 600 12.5px var(--font-body); color: var(--text); }
  .libx__link { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; color: #c4bdd4; font: 600 12.5px var(--font-body); cursor: pointer; }
  .libx__link:hover { color: var(--text); }
  .libx__movesel { height: 30px; padding: 0 9px; background: var(--ink); border: 1px solid var(--line); border-radius: 7px; color: var(--muted); font: 12.5px var(--font-body); }
  .libx__remove { margin-left: auto; height: 30px; padding: 0 13px; border: 1px solid rgba(255,90,82,.3); background: transparent; color: var(--red); border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; }

  .libx__scroll { flex: 1; overflow-y: auto; padding: 18px; position: relative; }
  /* Reading rails are a Home-only surface — the plugin slot stays mounted, but
     hide it while browsing a library so the grid starts at the top. */
  .libx__scroll.is-browse :global(#home-plugin-rail) { display: none; }

  /* grid */
  .libx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px; }
  .libx-grid__pad { grid-column: 1 / -1; }
  .libx-card { cursor: pointer; position: relative; }
  .libx-card__art { aspect-ratio: 2/3; border-radius: 9px; position: relative; overflow: hidden; border: 1px solid var(--line); }
  .libx-card.is-selected .libx-card__art { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 1px; }
  .libx-card__art.is-unmatched { border-color: rgba(255,194,75,.4); }
  .libx-card__art :global(.cover) { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 0; }
  .libx-card__check { position: absolute; top: 7px; left: 7px; z-index: 3; width: 22px; height: 22px; border-radius: 6px; border: 2px solid rgba(255,255,255,.7); background: rgba(0,0,0,.35); display: grid; place-items: center; color: #fff; }
  .libx-card__check.is-on { border-color: var(--accent); background: var(--accent); }
  .libx-card__star { position: absolute; top: 7px; right: 7px; z-index: 3; color: var(--amber); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); display: flex; }
  .libx-card__matchchip { position: absolute; left: 7px; bottom: 12px; z-index: 3; font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--ink); background: var(--amber); border-radius: 5px; padding: 3px 7px; }
  .libx-card__bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 5px; background: rgba(0,0,0,.5); }
  .libx-card__fill { height: 100%; background: var(--accent); }
  .libx-card__fill.is-done { background: var(--green); }
  .libx-card__title { font-size: 12.5px; font-weight: 600; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .libx-card__title--unmatched { color: var(--faint); }
  .libx-card__year { color: var(--faint); font-weight: 400; }
  .libx-card__meta { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
  .libx-card__count { font: 11px var(--font-mono); color: var(--faint); }
  .libx-card__flag { display: flex; align-items: center; color: var(--faint); }
  .libx-card__flag--bad { width: 15px; height: 15px; border-radius: 4px; background: rgba(255,90,82,.15); color: var(--red); font: 700 10px var(--font-body); display: grid; place-items: center; }

  /* list */
  .libx-list { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: rgba(255,255,255,.012); }
  .libx-list__head, .libx-row { display: grid; grid-template-columns: 46px minmax(160px, 1.8fr) 150px 90px 80px 40px; align-items: center; gap: 12px; padding: 9px 14px; }
  .libx-list__head { border-bottom: 1px solid var(--line); font: 600 10.5px var(--font-body); text-transform: uppercase; letter-spacing: .06em; color: var(--faint); background: rgba(255,255,255,.02); }
  .libx-col--right { text-align: right; }
  .libx-row { border-bottom: 1px solid #2a2536; cursor: pointer; }
  .libx-row:last-child { border-bottom: none; }
  .libx-row.is-selected { background: rgba(255,45,111,.08); }
  /* fork: watch-state pill */
  /* fork: watch-state symbols + colour coding.
     ▶ green = watched, ❚❚ amber = paused, ▬ red = unwatched. */
  .wsym {
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0; line-height: 1; font-weight: 700;
    border-radius: 50%;
  }
  .wsym--watched { color: #34d399; }
  .wsym--paused { color: #fbbf24; letter-spacing: -1px; }
  .wsym--unwatched { color: #f87171; }

  .libx-row__wsym {
    width: 30px; height: 30px; font-size: 17px; margin-right: 8px;
    background: rgba(148,163,184,.10);
  }
  .libx-row__wsym.wsym--watched { background: rgba(52,211,153,.14); }
  .libx-row__wsym.wsym--paused { background: rgba(251,191,36,.14); font-size: 13px; }
  .libx-row__wsym.wsym--unwatched { background: rgba(248,113,113,.14); }

  /* whole-row tint + a status stripe down the left edge */
  .libx-row.ws-watched { background: rgba(52,211,153,.055); box-shadow: inset 3px 0 0 #34d399; }
  .libx-row.ws-paused { background: rgba(251,191,36,.06); box-shadow: inset 3px 0 0 #fbbf24; }
  .libx-row.ws-unwatched { background: rgba(248,113,113,.06); box-shadow: inset 3px 0 0 #f87171; }
  .libx-row.ws-watched:hover { background: rgba(52,211,153,.10); }
  .libx-row.ws-paused:hover { background: rgba(251,191,36,.11); }
  .libx-row.ws-unwatched:hover { background: rgba(248,113,113,.11); }

  /* grid: coloured border round the cover + a big symbol badge */
  .libx-card.ws-watched .libx-card__art { border: 2px solid #34d399; }
  .libx-card.ws-paused .libx-card__art { border: 2px solid #fbbf24; }
  .libx-card.ws-unwatched .libx-card__art { border: 2px solid #f87171; }
  .libx-card__wsym {
    position: absolute; left: 6px; bottom: 6px; z-index: 2;
    width: 26px; height: 26px; font-size: 15px;
    background: rgba(0,0,0,.62); backdrop-filter: blur(2px);
    box-shadow: 0 1px 4px rgba(0,0,0,.5);
  }
  .libx-card__wsym.wsym--paused { font-size: 11px; }
  .libx-row__dates { display: inline-flex; align-items: center; gap: 8px; margin-right: 8px; flex-shrink: 0; }
  .libx-row__date { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--muted, #8b90a0); white-space: nowrap; }
  .libx-row__date.is-next { color: #60a5fa; }
  .libx-row__cb, .libx-card__cb { width: 16px; height: 16px; accent-color: var(--accent, #7c5cff); cursor: pointer; flex-shrink: 0; }
  .libx-card__cb { position: absolute; top: 6px; left: 6px; z-index: 3; }

  .libx-row :global(.cover) { width: 38px; height: 52px; }
  .libx-row__main { min-width: 0; }
  .libx-row__title { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .libx-row__title.is-unmatched { color: var(--faint); }
  .libx-row__year { color: var(--faint); font-weight: 400; }
  .libx-row__badges { display: flex; align-items: center; gap: 7px; margin-top: 4px; flex-wrap: wrap; }
  .libx-row__pub { font-size: 11.5px; color: var(--faint); }
  .libx-row__progress { min-width: 0; }
  .libx-row__nums { font: 11px var(--font-mono); color: var(--muted); display: block; margin-bottom: 4px; }
  .libx-row__track { display: block; height: 5px; border-radius: 5px; background: var(--ink); overflow: hidden; max-width: 130px; }
  .libx-row__fill { display: block; height: 100%; background: var(--accent); }
  .libx-row__fill.is-done { background: var(--green); }
  .libx-row__dim { font: 12px var(--font-mono); color: var(--faint); }
  .libx-row__star { width: 30px; height: 30px; display: grid; place-items: center; background: none; border: none; color: #4a4458; cursor: pointer; }
  .libx-row__star.is-on { color: var(--amber); }

  .libx-badge { font: 600 10.5px var(--font-body); border-radius: 5px; padding: 2px 7px; white-space: nowrap; border: 1px solid transparent; }
  .libx-badge--busy { color: var(--cyan); background: rgba(43,212,217,.1); border-color: rgba(43,212,217,.3); }
  .libx-badge--miss { color: var(--amber); background: rgba(255,194,75,.1); border-color: rgba(255,194,75,.3); }
  .libx-badge--ok { color: var(--green); background: rgba(95,211,138,.1); border-color: rgba(95,211,138,.3); }
  .libx-badge--warn { color: var(--red); background: rgba(255,90,82,.1); border-color: rgba(255,90,82,.3); }
  .libx-badge--plain { color: #c4bdd4; background: var(--panel-2); }
  /* On-demand / available: books catalogued but not yet on disk (fetch on open).
     A distinct violet, so it never reads as owned (green) or missing (amber). */
  .libx-badge--avail { color: var(--violet, #b28dff); background: rgba(160,122,255,.12); border-color: rgba(160,122,255,.32); display: inline-flex; align-items: center; gap: 4px; }
  .libx-card__meta .libx-badge--avail { font-size: 10px; padding: 1px 5px; }

  .libx__empty { border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.015); padding: 60px 24px; text-align: center; max-width: 460px; margin: 24px auto; }
  .libx__empty-art { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 15px; background: var(--panel-2); display: grid; place-items: center; color: var(--faint); }
  .libx__empty-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .libx__empty-body { font-size: 13px; color: var(--faint); margin: 0 auto; max-width: 320px; line-height: 1.6; }

  /* Skeleton shelves shown while the plugin home rails fetch. Shapes mirror
     the real rails (title bar + a track of covers) with a soft shimmer, so
     the wait reads as "your shelves are coming" instead of a blank screen. */
  .railskel { display: flex; flex-direction: column; gap: 24px; padding: 14px 18px 6px; }
  .railskel__rail { display: flex; flex-direction: column; gap: 10px; }
  .railskel__title { width: 148px; height: 15px; border-radius: 5px; }
  .railskel__track { display: flex; gap: 12px; overflow: hidden; }
  .railskel__card { flex: 0 0 auto; border-radius: 8px; }
  .railskel__card--comic { width: 104px; height: 156px; }
  .railskel__card--square { width: 116px; height: 116px; }
  .railskel__title, .railskel__card {
    background: linear-gradient(100deg, var(--panel) 38%, var(--panel-2) 50%, var(--panel) 62%);
    background-size: 220% 100%;
    animation: railskel-shimmer 1.4s ease-in-out infinite;
  }
  @keyframes railskel-shimmer {
    from { background-position: 120% 0; }
    to { background-position: -120% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .railskel__title, .railskel__card { animation: none; background: var(--panel); }
  }

  @media (max-width: 760px) {
    .libx-grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 14px; }
    .libx-list__head, .libx-row { grid-template-columns: 46px 1fr auto 40px; }
    .libx-col--wide { display: none; }
  }
</style>
