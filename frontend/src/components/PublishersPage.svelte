<script>
  // fork: browse the library the way a shelf is arranged — publisher, then the
  // franchise, then that franchise's volumes. Three tiers driven off ?pub= and
  // ?fr= so every level is linkable and Back works.
  import { apiGet, apiPost } from '../lib/api.js';
  import { route, setQuery, navigate } from '../lib/router.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import { fmt, initials } from '../lib/util.js';
  import Icon from '../lib/Icon.svelte';
  import Cover from './Cover.svelte';

  let { active = false } = $props();

  const pub = $derived(new URLSearchParams(route.search).get('pub') || '');
  const fr = $derived(new URLSearchParams(route.search).get('fr') || '');

  let publishers = $state([]);
  let franchises = $state([]);
  let detail = $state(null);
  let loading = $state(false);
  let artBusy = $state(false);
  let artNote = $state('');
  let picked = $state(new Set());   // series ids selected for a merge/split
  // Volume tier view mode — a device preference, matching the Library page.
  let vview = $state(localStorage.getItem('publisherVolView') || 'grid');
  function setVview(v) { vview = v; localStorage.setItem('publisherVolView', v); }
  // The franchise tier keeps its own preference — a wall of character art and a
  // scannable list of volume counts are useful at different moments.
  let fview = $state(localStorage.getItem('publisherFrView') || 'grid');
  function setFview(v) { fview = v; localStorage.setItem('publisherFrView', v); }

  // Volume ordering. The server returns newest-first; this re-sorts client-side
  // (a franchise is tens of rows at most, so there's nothing to gain from a
  // round trip). Volumes with no known year sort last in both directions rather
  // than clumping at one end as year 0.
  const VSORTS = [
    ['year-desc', 'Year (newest)'],
    ['year-asc', 'Year (oldest)'],
    ['title', 'Title A–Z'],
    ['read', 'Most read'],
    ['issues', 'Most issues'],
  ];
  let vsort = $state(localStorage.getItem('publisherVolSort') || 'year-desc');
  function setVsort(v) { vsort = v; localStorage.setItem('publisherVolSort', v); }
  const sortedVolumes = $derived.by(() => {
    const v = [...(detail?.volumes || [])];
    const byTitle = (a, b) => a.title.localeCompare(b.title);
    const yr = (x) => (x.year == null ? null : x.year);
    if (vsort === 'title') return v.sort(byTitle);
    if (vsort === 'read') return v.sort((a, b) => (b.read || 0) - (a.read || 0) || byTitle(a, b));
    if (vsort === 'issues') return v.sort((a, b) => (b.total || 0) - (a.total || 0) || byTitle(a, b));
    const dir = vsort === 'year-asc' ? 1 : -1;
    return v.sort((a, b) => {
      const ya = yr(a), yb = yr(b);
      if (ya == null && yb == null) return byTitle(a, b);
      if (ya == null) return 1;          // unknown year always trails
      if (yb == null) return -1;
      return (ya - yb) * dir || byTitle(a, b);
    });
  });
  // fork: read progress, same definition as the Library — finished issues over
  // the full ComicVine issue count.
  const rpct = (x) => (x.total ? Math.round(((x.read || 0) / x.total) * 100) : 0);

  // One effect per tier: the URL is the state, so each level refetches only
  // when its own key changes.
  $effect(() => {
    if (!active) return;
    void pub; void fr;
    load();
  });

  async function load() {
    loading = true;
    picked = new Set();
    try {
      if (!pub) {
        publishers = (await apiGet('/api/publishers')).publishers || [];
        franchises = []; detail = null;
      } else if (!fr) {
        franchises = (await apiGet('/api/publishers/' + encodeURIComponent(pub))).franchises || [];
        detail = null;
      } else {
        detail = await apiGet(`/api/publishers/${encodeURIComponent(pub)}/${encodeURIComponent(fr)}`);
      }
    } catch (e) {
      notify(String(e?.message || e), 'error');
    }
    loading = false;
  }

  async function fetchArt() {
    artBusy = true;
    const r = await apiPost('/api/publishers/art', {});
    artBusy = false;
    if (r?.error) return notify(r.error, 'error');
    if (!r.started) {
      if (r.reason === 'nothing to fetch') return notify('Artwork is already up to date.', 'ok');
      // No key = no logos, which is a config gap rather than a failure — say so
      // once, plainly, instead of leaving the button looking broken.
      artNote = r.reason;
      return notify(r.reason, 'error');
    }
    artNote = '';
    notify(`Fetching artwork for ${fmt(r.publishers)} publisher(s) and ${fmt(r.franchises)} franchise(s) — check Jobs for progress.`, 'ok');
  }

  function toggle(id, e) {
    e?.stopPropagation();
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    picked = next;
  }

  async function moveTo(target) {
    if (!picked.size) return;
    const r = await apiPost('/api/publishers/franchise', { seriesIds: [...picked], franchise: target });
    if (r?.error) return notify(r.error, 'error');
    notify(target ? `Moved ${fmt(r.updated)} volume(s) into “${target}”.` : `Reset ${fmt(r.updated)} volume(s) to automatic grouping.`, 'ok');
    load();
  }

  async function mergeInto() {
    const target = prompt('Move the selected volumes into which franchise?', detail?.name || fr || '');
    if (target === null) return;
    moveTo(target.trim() || null);
  }

  async function splitOut() {
    const target = prompt('Name the new franchise for the selected volumes:', '');
    if (!target?.trim()) return;
    moveTo(target.trim());
  }

  async function renameGroup() {
    const name = prompt('Display name for this franchise:', detail?.name || fr);
    if (name === null) return;
    const r = await apiPost(`/api/publishers/${encodeURIComponent(pub)}/${encodeURIComponent(fr)}/rename`, { name: name.trim() || null });
    if (r?.error) return notify(r.error, 'error');
    load();
  }
</script>

{#if active}
<section class="page pubx publishers-page">
  <div class="pubx__bar">
    <button class="pubx__crumb" class:is-cur={!pub} onclick={() => setQuery({ pub: null, fr: null })}>
      <Icon name="layers" size={15} /> Publishers
    </button>
    {#if pub}
      <span class="pubx__sep">/</span>
      <button class="pubx__crumb" class:is-cur={!fr} onclick={() => setQuery({ fr: null })}>{pub}</button>
    {/if}
    {#if pub && fr}
      <span class="pubx__sep">/</span>
      <button class="pubx__crumb is-cur">{detail?.name || fr}</button>
      {#if isTrusted()}
        <button class="pubx__mini" title="Rename this franchise" onclick={renameGroup}><Icon name="edit" size={13} /></button>
      {/if}
    {/if}
    <span class="pubx__spacer"></span>
    {#if pub && fr}
      <select class="pubx__sort" title="Sort volumes" aria-label="Sort volumes"
        value={vsort} onchange={(e) => setVsort(e.currentTarget.value)}>
        {#each VSORTS as [k, label] (k)}<option value={k}>{label}</option>{/each}
      </select>
    {/if}
    {#if pub}
      {@const cur = fr ? vview : fview}
      {@const set = fr ? setVview : setFview}
      <div class="pubx__view" role="group" aria-label="View">
        <button class="pubx__viewbtn" class:is-active={cur === 'grid'} title="Poster grid" aria-label="Poster grid"
          onclick={() => set('grid')}><Icon name="grid" size={15} /></button>
        <button class="pubx__viewbtn" class:is-active={cur === 'list'} title="List" aria-label="List"
          onclick={() => set('list')}><Icon name="list" size={15} /></button>
      </div>
    {/if}
    {#if !pub && can('library.manage')}
      <button class="pubx__act" disabled={artBusy} title="Look up publisher logos and franchise character art on ComicVine"
        onclick={fetchArt}><Icon name="refresh" size={14} /> {artBusy ? 'Starting…' : 'Fetch artwork'}</button>
    {/if}
  </div>

  <div class="pubx__scroll">
    {#if artNote}
      <div class="pubx__warn">
        <Icon name="alert-triangle" size={15} />
        <span>{artNote}</span>
        <button class="pubx__link" onclick={() => (artNote = '')}>Dismiss</button>
      </div>
    {/if}
    {#if loading}
      <div class="pubx__note">Loading…</div>

    <!-- tier 1: publishers -->
    {:else if !pub}
      {#if !publishers.length}
        <div class="pubx__note">Nothing in the library yet.</div>
      {/if}
      <div class="pubx__grid">
        {#each publishers as p (p.name)}
          <button class="pcard" onclick={() => setQuery({ pub: p.name, fr: null })}>
            <div class="pcard__art">
              {#if p.logo}
                <img src={p.logo} alt="" loading="lazy" referrerpolicy="no-referrer" />
              {:else}
                <span class="pcard__mark">{initials(p.name)}</span>
              {/if}
            </div>
            <div class="pcard__name">{p.name}</div>
            <div class="pcard__meta">{fmt(p.franchises)} series · {fmt(p.series)} volumes</div>
            {#if p.total}<div class="pcard__meta pcard__meta--read">{fmt(p.read || 0)}/{fmt(p.total)} read · {rpct(p)}%</div>{/if}
          </button>
        {/each}
      </div>

    <!-- tier 2: franchises within a publisher -->
    {:else if !fr}
      {#if !franchises.length}
        <div class="pubx__note">Nothing from {pub}.</div>
      {/if}
      {#if fview === 'list'}
        <div class="frlist">
          <div class="frlist__head">
            <span></span><span>Series</span><span class="frlist__num">Volumes</span>
            <span class="frlist__num">Issues</span><span class="frlist__num">Read</span><span>Progress</span>
          </div>
          {#each franchises as f (f.key)}
            <button class="frrow" onclick={() => setQuery({ fr: f.key })}>
              <span class="frrow__art">
                {#if f.image}<img src={f.image} alt="" loading="lazy" referrerpolicy="no-referrer" />
                {:else if f.cover}<img src={f.cover} alt="" loading="lazy" referrerpolicy="no-referrer" />
                {:else}<span class="frrow__mark">{initials(f.name)}</span>{/if}
              </span>
              <span class="frrow__name">{f.name}</span>
              <span class="frrow__num frrow__vols">{fmt(f.volumes)}</span>
              <span class="frrow__num">{fmt(f.owned)}/{fmt(f.total)}</span>
              <span class="frrow__num" class:is-done={(f.read || 0) >= f.total && f.total > 0}>{fmt(f.read || 0)}/{fmt(f.total)}</span>
              <span class="frrow__prog">
                <span class="frrow__bar"><span class="frrow__fill" class:is-done={(f.read || 0) >= f.total && f.total > 0} style="width:{rpct(f)}%"></span></span>
                <span class="frrow__pct">{rpct(f)}%</span>
              </span>
            </button>
          {/each}
        </div>
      {:else}
      <div class="pubx__grid pubx__grid--fr">
        {#each franchises as f (f.key)}
          <button class="fcard" onclick={() => setQuery({ fr: f.key })}>
            <div class="fcard__art">
              {#if f.image}
                <img src={f.image} alt="" loading="lazy" referrerpolicy="no-referrer" />
              {:else if f.cover}
                <img class="is-cover" src={f.cover} alt="" loading="lazy" referrerpolicy="no-referrer" />
              {:else}
                <span class="pcard__mark">{initials(f.name)}</span>
              {/if}
              {#if f.volumes > 1}<span class="fcard__count">{fmt(f.volumes)}</span>{/if}
            </div>
            <div class="fcard__name">{f.name}</div>
            <div class="fcard__meta">{fmt(f.owned)}/{fmt(f.total)} issues</div>
            {#if f.total}
              <div class="fcard__read">
                <span class="fcard__readbar"><span class="fcard__readfill" class:is-done={(f.read || 0) >= f.total} style="width:{rpct(f)}%"></span></span>
                <span class="fcard__readnum" class:is-done={(f.read || 0) >= f.total}>{fmt(f.read || 0)}/{fmt(f.total)} · {rpct(f)}%</span>
              </div>
            {/if}
          </button>
        {/each}
      </div>
      {/if}

    <!-- tier 3: the volumes -->
    {:else if detail}
      {#if picked.size && isTrusted()}
        <div class="pubx__bulk">
          <span class="pubx__bulk-n">{fmt(picked.size)} selected</span>
          <button class="pubx__link" onclick={mergeInto}><Icon name="layers" size={14} /> Move to franchise…</button>
          <button class="pubx__link" onclick={splitOut}><Icon name="plus" size={14} /> Split into new…</button>
          <button class="pubx__link" onclick={() => moveTo(null)}><Icon name="refresh" size={14} /> Reset to automatic</button>
          <button class="pubx__link" onclick={() => (picked = new Set())}>Clear</button>
        </div>
      {/if}
      {#if vview === 'grid'}
        <div class="pubx__vgrid">
          {#each sortedVolumes as v (v.id)}
            <div class="vcard ws-{v.watch_state || 'watched'}" class:is-picked={picked.has(v.id)}>
              {#if isTrusted()}
                <input type="checkbox" class="vcard__cb" checked={picked.has(v.id)} onclick={(e) => toggle(v.id, e)} />
              {/if}
              <button class="vcard__open" onclick={() => navigate('/volume/' + v.id)}>
                <span class="vcard__art"><Cover coverUrl={v.cover} title={v.title} /></span>
                <span class="vcard__title">{v.title}</span>
                <span class="vcard__meta">{v.year || '—'} · {fmt(v.owned)}/{fmt(v.total)}</span>
                {#if v.total}<span class="vcard__meta vcard__meta--read" class:is-done={(v.read || 0) >= v.total}>{fmt(v.read || 0)}/{fmt(v.total)} read · {rpct(v)}%</span>{/if}
              </button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="pubx__vols">
          {#each sortedVolumes as v (v.id)}
            <div class="vrow ws-{v.watch_state || 'watched'}">
              {#if isTrusted()}
                <input type="checkbox" class="vrow__cb" checked={picked.has(v.id)} onclick={(e) => toggle(v.id, e)} />
              {/if}
              <button class="vrow__open" onclick={() => navigate('/volume/' + v.id)}>
                <Cover coverUrl={v.cover} title={v.title} />
                <span class="vrow__main">
                  <span class="vrow__title">{v.title}{#if v.year}<span class="vrow__year"> ({v.year})</span>{/if}</span>
                  <span class="vrow__meta">{fmt(v.owned)}/{fmt(v.total)} issues{#if v.total} · <span class="vrow__read" class:is-done={(v.read || 0) >= v.total}>{fmt(v.read || 0)}/{fmt(v.total)} read ({rpct(v)}%)</span>{/if}</span>
                </span>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>
{/if}

<style>
  .pubx { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .pubx__bar { display: flex; align-items: center; gap: 8px; padding: 11px 18px; border-bottom: 1px solid var(--line); flex: none; }
  .pubx__crumb {
    background: none; border: none; cursor: pointer; padding: 4px 2px;
    display: inline-flex; align-items: center; gap: 7px;
    color: var(--muted); font: 600 13px var(--font-body);
  }
  .pubx__crumb:hover { color: var(--text); }
  .pubx__crumb.is-cur { color: var(--text); }
  .pubx__sep { color: var(--faint); }
  .pubx__spacer { flex: 1; }
  .pubx__mini { background: none; border: none; color: var(--faint); cursor: pointer; padding: 2px; }
  .pubx__mini:hover { color: var(--text); }
  .pubx__act {
    height: 32px; padding: 0 13px; border: 1px solid var(--line); background: transparent;
    color: var(--muted); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer;
    display: inline-flex; align-items: center; gap: 7px;
  }
  .pubx__act:disabled { opacity: .6; cursor: default; }
  .pubx__scroll { flex: 1; overflow-y: auto; padding: 18px; }
  .pubx__note { color: var(--faint); font-size: 13px; padding: 20px 2px; }
  .pubx__warn {
    display: flex; align-items: center; gap: 10px; margin-bottom: 16px;
    padding: 10px 14px; border-radius: 10px; font-size: 12.5px; line-height: 1.45;
    border: 1px solid rgba(255,194,75,.32); background: rgba(255,194,75,.08); color: #fbbf24;
  }
  .pubx__warn span { flex: 1; }

  .pubx__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 18px; }
  .pubx__grid--fr { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }

  /* Publisher card: a wide letterbox, because logos are wordmarks, not posters. */
  .pcard, .fcard { background: none; border: none; padding: 0; cursor: pointer; text-align: left; }
  .pcard__art {
    display: grid; place-items: center; aspect-ratio: 3 / 2;
    border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; padding: 16px;
    /* ComicVine ships most publisher logos as JPEGs with a baked-in WHITE
       background, and the rest as dark-on-transparent PNGs. Both only read
       correctly on a light plate, so the tile is white rather than following
       the dark UI — a logo wall, not a poster grid. */
    background: #fff;
  }
  .pcard:hover .pcard__art { border-color: var(--accent); }
  /* Explicit width+height, not max-*: as a grid item with an aspect-ratio
     parent, `max-height: 100%` resolves against the item's own content box and
     stops constraining, so a square logo overflowed a 16/9 tile and got
     clipped. Sizing the box and letting object-fit do the letterboxing is the
     only reliable way round it. */
  .pcard__art img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .pcard__art:has(.pcard__mark) { background: var(--panel-2); }
  .pcard__mark { font: 700 26px var(--font-body); color: var(--faint); letter-spacing: .04em; }
  .pcard__name { margin-top: 9px; font: 600 13.5px var(--font-body); color: var(--text); }
  .pcard__meta { margin-top: 2px; font: 11.5px var(--font-mono); color: var(--faint); }

  /* Franchise card: portrait, because character art and covers both are. */
  .fcard__art {
    position: relative; aspect-ratio: 2 / 3; border-radius: 12px; overflow: hidden;
    background: var(--panel-2); border: 1px solid var(--line);
    display: grid; place-items: center;
  }
  .fcard:hover .fcard__art { border-color: var(--accent); }
  .fcard__art img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
  /* A borrowed cover is art for a DIFFERENT thing, so it reads dimmer than
     real character art — the card shouldn't claim it's the franchise's own. */
  .fcard__art img.is-cover { opacity: .82; }
  .fcard__count {
    position: absolute; right: 6px; bottom: 6px;
    background: rgba(0,0,0,.72); color: #fff; border-radius: 20px;
    font: 700 11px var(--font-mono); padding: 2px 8px;
  }
  .fcard__name { margin-top: 8px; font: 600 13px var(--font-body); color: var(--text); }
  .fcard__meta { margin-top: 2px; font: 11px var(--font-mono); color: var(--faint); }

  .pubx__bulk {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 10px 14px; margin-bottom: 14px;
    border: 1px solid rgba(255,45,111,.25); background: rgba(255,45,111,.06); border-radius: 10px;
  }
  .pubx__bulk-n { font: 600 12.5px var(--font-body); color: var(--text); }
  .pubx__link {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: none; color: #c4bdd4; font: 600 12.5px var(--font-body); cursor: pointer;
  }
  .pubx__link:hover { color: var(--text); }

  .pubx__vols { display: flex; flex-direction: column; gap: 4px; }
  .vrow {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border: 1px solid transparent; border-radius: 10px;
  }
  .vrow:hover { background: var(--panel); }
  .vrow.ws-watched { box-shadow: inset 3px 0 0 #34d399; }
  .vrow.ws-paused { box-shadow: inset 3px 0 0 #fbbf24; }
  .vrow.ws-unwatched { box-shadow: inset 3px 0 0 #f87171; }
  .vrow__cb { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; flex: none; }
  .vrow__open {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px;
    background: none; border: none; padding: 0; cursor: pointer; text-align: left;
  }
  .vrow :global(.cover) { width: 38px; height: 52px; flex: none; }
  .vrow__main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .vrow__title { font: 600 13.5px var(--font-body); color: var(--text); }
  .vrow__year { color: var(--faint); font-weight: 400; }
  .vrow__meta { font: 11px var(--font-mono); color: var(--faint); }

  /* fork: read progress. Blue while in progress, green once finished — the
     same language the Library and series pages use. */
  .pcard__meta--read { color: #60a5fa; }
  .fcard__read { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .fcard__readbar { flex: 1; height: 4px; border-radius: 4px; background: var(--ink); overflow: hidden; }
  .fcard__readfill { display: block; height: 100%; background: #60a5fa; }
  .fcard__readfill.is-done { background: var(--green); }
  .fcard__readnum { font: 10px var(--font-mono); color: #60a5fa; white-space: nowrap; }
  .fcard__readnum.is-done { color: var(--green); }
  .vcard__meta--read { color: #60a5fa; }
  .vcard__meta--read.is-done { color: var(--green); }
  .vrow__read { color: #60a5fa; }
  .vrow__read.is-done { color: var(--green); }

  /* fork: franchise LIST view — the grid is for browsing art, this is for
     scanning counts (how many volumes of each, how much read). */
  .frlist { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: rgba(255,255,255,.012); }
  .frlist__head, .frrow {
    display: grid; grid-template-columns: 42px minmax(160px, 1fr) 76px 96px 96px 150px;
    align-items: center; gap: 12px; padding: 8px 14px;
  }
  .frlist__head {
    border-bottom: 1px solid var(--line); background: rgba(255,255,255,.02);
    font: 600 10.5px var(--font-body); text-transform: uppercase; letter-spacing: .06em; color: var(--faint);
  }
  .frlist__num { text-align: right; }
  .frrow {
    width: 100%; background: none; border: none; border-bottom: 1px solid #2a2536;
    cursor: pointer; text-align: left; color: inherit;
  }
  .frrow:last-child { border-bottom: none; }
  .frrow:hover { background: var(--panel); }
  .frrow__art {
    width: 42px; height: 56px; border-radius: 6px; overflow: hidden;
    background: var(--panel-2); display: grid; place-items: center;
  }
  .frrow__art img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
  .frrow__mark { font: 700 12px var(--font-body); color: var(--faint); }
  .frrow__name { font: 600 13.5px var(--font-body); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .frrow__num { font: 12px var(--font-mono); color: var(--muted); text-align: right; }
  .frrow__num.is-done { color: var(--green); }
  .frrow__vols { color: var(--text); font-weight: 600; }
  .frrow__prog { display: flex; align-items: center; gap: 8px; }
  .frrow__bar { flex: 1; height: 5px; border-radius: 5px; background: var(--ink); overflow: hidden; }
  .frrow__fill { display: block; height: 100%; background: #60a5fa; }
  .frrow__fill.is-done { background: var(--green); }
  .frrow__pct { font: 11px var(--font-mono); color: var(--faint); width: 34px; text-align: right; }
  @media (max-width: 860px) {
    .frlist__head, .frrow { grid-template-columns: 42px 1fr 60px 80px; }
    .frlist__head span:nth-child(5), .frlist__head span:nth-child(6),
    .frrow > span:nth-child(5), .frrow > span:nth-child(6) { display: none; }
  }

  .pubx__sort {
    height: 32px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line);
    border-radius: 8px; color: var(--text); font: 12.5px var(--font-body); flex: none;
  }
  .pubx__sort:focus { outline: none; border-color: var(--accent); }

  .pubx__view { display: flex; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 2px; flex: none; }
  .pubx__viewbtn { width: 30px; height: 28px; display: grid; place-items: center; border: none; border-radius: 6px; cursor: pointer; background: transparent; color: var(--faint); }
  .pubx__viewbtn.is-active { background: var(--panel-2); color: var(--text); }

  .pubx__vgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px; }
  .vcard { position: relative; }
  .vcard__cb { position: absolute; top: 7px; left: 7px; z-index: 3; width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
  .vcard__open { display: block; width: 100%; background: none; border: none; padding: 0; cursor: pointer; text-align: left; }
  .vcard__art {
    display: block; position: relative; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden;
    border: 2px solid transparent; background: var(--panel-2);
  }
  .vcard.ws-watched .vcard__art { border-color: #34d399; }
  .vcard.ws-paused .vcard__art { border-color: #fbbf24; }
  .vcard.ws-unwatched .vcard__art { border-color: #f87171; }
  .vcard.is-picked .vcard__art { border-color: var(--accent); }
  .vcard__art :global(.cover) { width: 100%; height: 100%; }
  .vcard__title {
    display: block; margin-top: 8px; font: 600 12.5px var(--font-body); color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .vcard__meta { display: block; margin-top: 2px; font: 11px var(--font-mono); color: var(--faint); }
</style>
