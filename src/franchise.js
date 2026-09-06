// fork: the Publishers browser — a publisher → franchise → volume drilldown.
//
// BackIssue models a "series" as a single ComicVine VOLUME ("Batman (2016)"),
// so there is no concept of the franchise a volume belongs to. This module
// derives one from the titles themselves and lets the user correct it, which is
// the only workable split: a purely automatic grouping is wrong often enough to
// be annoying (Batman vs Batgirl vs Batman/Catwoman), and a purely manual one
// is hours of work on a 500-volume library.
//
// The derivation is a small fixed-point over the titles of ONE publisher:
//   1. strip edition noise ("Omnibus", "The Complete Collection", "by <creator>",
//      "2022 Annual", ": The Deluxe Edition") and any subtitle after ':'
//   2. repeatedly strip a leading line adjective ("Absolute", "Uncanny",
//      "Mighty", …) as long as the shorter form is ALSO a base title somewhere
//      in that publisher — so "Absolute Batman" collapses onto "Batman" (which
//      exists) while "Absolute Catwoman" stays put (no plain "Catwoman")
//   3. if the pre-colon part is unique but the post-colon part names a known
//      base, prefer the post-colon one ("Alan Scott: The Green Lantern" →
//      "Green Lantern", "Miles Morales: Spider-Man" → "Spider-Man")
//
// Step 2's "only if the target already exists" guard is what keeps this honest:
// it never invents a franchise, it only merges into one the library already has.

import { readCountsForSeries, watchStateOf, PICK_WANTS_SQL } from './db.js';

export function initFranchiseTables(db) {
  db.exec(`
    -- Per-series manual grouping override. Absent row = follow the derivation.
    CREATE TABLE IF NOT EXISTS franchise_overrides (
      series_id INTEGER PRIMARY KEY,
      franchise TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    -- Per-group display metadata: a rename, and the ComicVine character art the
    -- card uses. Keyed by publisher + the group's CURRENT key.
    CREATE TABLE IF NOT EXISTS franchise_meta (
      publisher TEXT NOT NULL,
      franchise TEXT NOT NULL,
      display_name TEXT,
      image_url TEXT,
      cv_character_id INTEGER,
      checked_at TEXT,
      PRIMARY KEY (publisher, franchise)
    );
    -- Publisher logos, looked up once from ComicVine and then hot-linked (the
    -- app already hot-links covers, so there's no local image cache to feed).
    CREATE TABLE IF NOT EXISTS cv_publishers (
      name TEXT PRIMARY KEY,
      cv_id INTEGER,
      image_url TEXT,
      site_detail_url TEXT,
      checked_at TEXT
    );
  `);
}

// ---------------------------------------------------------------------------
// title → base title
// ---------------------------------------------------------------------------

// Edition/format noise that never identifies a franchise.
const NOISE = [
  /\bthe\s+complete\s+collection\b.*$/i,
  /\bomnibus\b.*$/i,
  /\bthe\s+deluxe\s+edition\b.*$/i,
  /\b(deluxe|noir|director'?s\s+cut|facsimile|treasury|absolute)\s+edition\b.*$/i,
  /\binfinity\s+comic\b.*$/i,
  /\b(hc|tpb|gn)\b.*$/i,
  /\s+by\s+[A-Z][\w.'-]+(\s+[A-Z][\w.'-]+)*.*$/i,  // "… by Jonathan Hickman …"
  /\b(19|20)\d{2}\s+annual\b.*$/i,
  /\bannual\b.*$/i,
  /\b-\s*red\s+band\b.*$/i,
  /\badaptation\b.*$/i,
];

// Line adjectives that decorate an existing franchise rather than naming a new
// one. Only ever stripped when the remainder is itself a known base title.
const LINE_WORDS = new Set([
  'absolute', 'ultimate', 'amazing', 'spectacular', 'sensational', 'superior',
  'uncanny', 'astonishing', 'immortal', 'immoral', 'savage', 'mighty',
  'incredible', 'invincible', 'unbeatable', 'unstoppable', 'all-new', 'all-star',
  'new', 'young', 'classic', 'essential', 'marvel', 'dc', 'the',
]);

const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Title → its base form: subtitle and edition noise removed. */
export function baseTitle(title) {
  let t = strip(title);
  // A parenthetical is always a qualifier, never the name.
  t = t.replace(/\s*\([^)]*\)\s*/g, ' ');
  // Drop a trailing volume year ("Batman 1999", "Batman Vol. 2").
  t = t.replace(/\s+(vol\.?|volume)\s*\d+\s*$/i, '');
  t = t.replace(/\s+(19|20)\d{2}\b/g, ' ');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = strip(t).replace(/[\s:,\-–—/]+$/, '');
  return strip(t);
}

/** The part before the first ':' (or ' - '), which is where the franchise sits. */
export function headOf(title) {
  const t = baseTitle(title);
  const cut = t.split(/\s*[:–—]\s*| - /)[0];
  return strip(cut) || t;
}

/** The part after the first ':' — sometimes the real franchise. */
export function tailOf(title) {
  const t = baseTitle(title);
  const m = t.split(/\s*[:–—]\s*| - /);
  return m.length > 1 ? strip(m.slice(1).join(': ')) : '';
}

const norm = (s) => strip(s).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9\s'-]/g, '');

/**
 * Group one publisher's volumes into franchises.
 * @param rows [{ id, title, ... }]
 * @param overrides Map<series_id, franchise>
 * @returns Map<franchiseKey, series_id[]>  (key is the display-cased name)
 */
export function groupByFranchise(rows, overrides = new Map()) {
  // Pass 1: every volume's head, and how many volumes share each normalized head.
  const headFor = new Map();   // series_id → head string
  const known = new Map();     // normalized head → display head
  for (const r of rows) {
    const h = headOf(r.title);
    headFor.set(r.id, h);
    const n = norm(h);
    if (n && !known.has(n)) known.set(n, h);
  }

  // Pass 2: peel line adjectives while the remainder is a head we already know.
  // Iterated to a fixed point so "All-New Uncanny X-Men" reaches "X-Men".
  const resolve = (head) => {
    // The article is dropped up front: peeling it as if it were a line word
    // stalls the loop, because norm() already ignores it ("The Mighty Thor"
    // would resolve to itself and never reach "Thor").
    let cur = strip(head).replace(/^the\s+/i, '') || head;
    for (let i = 0; i < 4; i++) {
      const words = strip(cur).split(' ');
      if (words.length < 2) break;
      if (!LINE_WORDS.has(words[0].toLowerCase())) break;
      const shorter = words.slice(1).join(' ');
      if (norm(shorter) === norm(cur)) break;          // no progress — bail
      const hit = known.get(norm(shorter));
      if (!hit) break;
      cur = strip(hit).replace(/^the\s+/i, '') || hit;
    }
    // Back to the canonical spelling so the group reads "The Authority", not
    // the article-stripped working form.
    return known.get(norm(cur)) || cur;
  };

  // Pass 3: a unique head with a recognised tail belongs to the tail's franchise
  // ("Alan Scott: The Green Lantern" → Green Lantern).
  const headCount = new Map();
  for (const h of headFor.values()) headCount.set(norm(h), (headCount.get(norm(h)) || 0) + 1);

  const out = new Map();
  for (const r of rows) {
    const manual = overrides.get(r.id);
    let key;
    if (manual) {
      key = manual;
    } else {
      let head = resolve(headFor.get(r.id));
      if (headCount.get(norm(headFor.get(r.id))) === 1) {
        const tail = tailOf(r.title);
        if (tail) {
          const th = resolve(strip(tail.split(/\s*[:–—]\s*| - /)[0]));
          const hit = known.get(norm(th));
          // Only move when the tail's franchise is a REAL group (more than one
          // volume), otherwise every one-off subtitle becomes its own franchise.
          if (hit && norm(hit) !== norm(head) && (headCount.get(norm(hit)) || 0) > 1) head = hit;
        }
      }
      key = head;
    }
    key = strip(key) || 'Unknown';
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

/** Series rows that count as "in the library" (owns a file, or is followed). */
const MEMBER_SQL = `(s.followed = 1
    OR EXISTS (SELECT 1 FROM library_files lf WHERE lf.series_id = s.id AND lf.valid = 1))`;

function libraryRows(db, { publisher = null, includeRestricted = true, userId = null } = {}) {
  const rows = db.prepare(`
    SELECT s.id, s.title, s.year, s.cover_url, s.monitor, ${PICK_WANTS_SQL} pick_wants, s.cv_id,
           COALESCE(NULLIF(cv.publisher,''), 'Unknown') publisher,
           cv.image_url cv_cover, cv.start_year,
           (SELECT COUNT(*) FROM library_files lf WHERE lf.series_id = s.id AND lf.valid = 1) owned,
           (SELECT COUNT(*) FROM cv_issues ci WHERE ci.cv_series_id = s.cv_id) total
      FROM series s
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     WHERE ${MEMBER_SQL}
       ${includeRestricted ? '' : 'AND s.restricted = 0'}
       ${publisher ? `AND COALESCE(NULLIF(cv.publisher,''), 'Unknown') = @publisher` : ''}
     ORDER BY s.title`).all(publisher ? { publisher } : {});
  // fork: finished-issue counts, so the Publishers browser can show progress
  // the same way the Library does. Plugin-owned table, hence the guard inside.
  const readBy = readCountsForSeries(db, rows.map((r) => r.id), userId);
  for (const r of rows) r.read = readBy.get(r.id) || 0;
  return rows;
}

const overrideMap = (db) => new Map(
  db.prepare('SELECT series_id, franchise FROM franchise_overrides').all().map((r) => [r.series_id, r.franchise]));

/** Publisher cards: one per publisher we own something from, newest cover as a
 *  fallback when ComicVine has no logo for it. */
export function listPublishers(db, { includeRestricted = true, userId = null } = {}) {
  const rows = libraryRows(db, { includeRestricted, userId });
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.publisher)) by.set(r.publisher, { name: r.publisher, series: 0, owned: 0, read: 0, total: 0, covers: [] });
    const p = by.get(r.publisher);
    p.series++; p.owned += r.owned; p.read += r.read || 0; p.total += r.total;
    if (p.covers.length < 3 && (r.cover_url || r.cv_cover)) p.covers.push(r.cover_url || r.cv_cover);
  }
  const logos = new Map(db.prepare('SELECT name, cv_id, image_url, site_detail_url FROM cv_publishers').all()
    .map((r) => [r.name, r]));
  // Franchise count needs the grouping, which is per publisher.
  const ovr = overrideMap(db);
  for (const [name, p] of by) {
    p.franchises = groupByFranchise(rows.filter((r) => r.publisher === name), ovr).size;
    const l = logos.get(name);
    p.logo = l?.image_url || null;
    p.cv_id = l?.cv_id || null;
    p.site_url = l?.site_detail_url || null;
  }
  return [...by.values()].sort((a, b) => b.series - a.series || a.name.localeCompare(b.name));
}

/** Franchise cards for one publisher. */
export function listFranchises(db, publisher, { includeRestricted = true, userId = null } = {}) {
  const rows = libraryRows(db, { publisher, includeRestricted, userId });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = groupByFranchise(rows, overrideMap(db));
  const meta = new Map(db.prepare('SELECT franchise, display_name, image_url, cv_character_id FROM franchise_meta WHERE publisher = ?')
    .all(publisher).map((r) => [r.franchise, r]));
  const out = [];
  for (const [key, ids] of groups) {
    const vols = ids.map((id) => byId.get(id)).filter(Boolean);
    // Card art falls back to the newest volume's cover when there's no
    // character image yet (or the lookup found nothing).
    const newest = [...vols].sort((a, b) => (b.year || b.start_year || 0) - (a.year || a.start_year || 0))[0];
    const m = meta.get(key) || {};
    out.push({
      key,
      name: m.display_name || key,
      renamed: !!m.display_name,
      image: m.image_url || null,
      cv_character_id: m.cv_character_id || null,
      cover: newest?.cover_url || newest?.cv_cover || null,
      covers: vols.slice(0, 3).map((v) => v.cover_url || v.cv_cover).filter(Boolean),
      volumes: vols.length,
      owned: vols.reduce((n, v) => n + v.owned, 0),
      total: vols.reduce((n, v) => n + v.total, 0),
      read: vols.reduce((n, v) => n + (v.read || 0), 0),
      years: [Math.min(...vols.map((v) => v.year || v.start_year || 9999)), Math.max(...vols.map((v) => v.year || v.start_year || 0))],
    });
  }
  return out.sort((a, b) => b.volumes - a.volumes || a.name.localeCompare(b.name));
}

/** Every volume in one franchise, newest first. */
export function franchiseVolumes(db, publisher, key, { includeRestricted = true, userId = null } = {}) {
  const rows = libraryRows(db, { publisher, includeRestricted, userId });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const groups = groupByFranchise(rows, overrideMap(db));
  const ids = groups.get(key) || [];
  const meta = db.prepare('SELECT display_name, image_url FROM franchise_meta WHERE publisher=? AND franchise=?').get(publisher, key);
  return {
    key,
    name: meta?.display_name || key,
    image: meta?.image_url || null,
    volumes: ids.map((id) => byId.get(id)).filter(Boolean)
      .map((v) => ({
        id: v.id, title: v.title, year: v.year || v.start_year || null,
        cover: v.cover_url || v.cv_cover || null,
        owned: v.owned, total: v.total, read: v.read || 0, watch_state: watchStateOf(v.monitor, v.pick_wants), cv_id: v.cv_id,
      }))
      .sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title)),
  };
}

/** Move volumes into a franchise (merge/split). Passing null clears the
 *  override so they fall back to the derived grouping. */
export function setFranchise(db, seriesIds, franchise) {
  const ids = (Array.isArray(seriesIds) ? seriesIds : [seriesIds]).map(Number).filter(Boolean);
  if (!ids.length) return 0;
  const tx = db.transaction(() => {
    if (franchise == null || franchise === '') {
      db.prepare(`DELETE FROM franchise_overrides WHERE series_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } else {
      const ins = db.prepare(`INSERT INTO franchise_overrides (series_id, franchise)
        VALUES (?, ?) ON CONFLICT(series_id) DO UPDATE SET franchise=excluded.franchise,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
      for (const id of ids) ins.run(id, String(franchise));
    }
  });
  tx();
  return ids.length;
}

/** Rename a franchise for display (the grouping key itself is unchanged, so
 *  new volumes still land in it). */
export function renameFranchise(db, publisher, key, name) {
  db.prepare(`INSERT INTO franchise_meta (publisher, franchise, display_name)
    VALUES (?, ?, ?) ON CONFLICT(publisher, franchise) DO UPDATE SET display_name=excluded.display_name`)
    .run(publisher, key, name ? String(name) : null);
  return true;
}

export function setFranchiseArt(db, publisher, key, { imageUrl = null, characterId = null } = {}) {
  db.prepare(`INSERT INTO franchise_meta (publisher, franchise, image_url, cv_character_id, checked_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(publisher, franchise) DO UPDATE SET image_url=excluded.image_url,
      cv_character_id=excluded.cv_character_id, checked_at=excluded.checked_at`)
    .run(publisher, key, imageUrl, characterId);
  return true;
}

export function savePublisherLogo(db, name, { cvId = null, imageUrl = null, siteUrl = null } = {}) {
  db.prepare(`INSERT INTO cv_publishers (name, cv_id, image_url, site_detail_url, checked_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(name) DO UPDATE SET cv_id=excluded.cv_id, image_url=excluded.image_url,
      site_detail_url=excluded.site_detail_url, checked_at=excluded.checked_at`)
    .run(name, cvId, imageUrl, siteUrl);
  return true;
}

/** Publishers/franchises still missing art — the backfill job's work list. */
export function artBacklog(db, { includeRestricted = true, maxAgeDays = 30 } = {}) {
  const rows = libraryRows(db, { includeRestricted });
  const pubs = [...new Set(rows.map((r) => r.publisher))].filter((p) => p && p !== 'Unknown');
  const seen = new Map(db.prepare('SELECT name, checked_at, image_url FROM cv_publishers').all().map((r) => [r.name, r]));
  const cutoff = Date.now() - maxAgeDays * 864e5;
  const publishers = pubs.filter((p) => {
    const s = seen.get(p);
    return !s || (!s.image_url && Date.parse(s.checked_at || 0) < cutoff);
  });
  const ovr = overrideMap(db);
  const franchises = [];
  for (const p of pubs) {
    const groups = groupByFranchise(rows.filter((r) => r.publisher === p), ovr);
    const meta = new Map(db.prepare('SELECT franchise, image_url, checked_at FROM franchise_meta WHERE publisher=?')
      .all(p).map((r) => [r.franchise, r]));
    for (const [key, ids] of groups) {
      if (ids.length < 2) continue;             // one-off volumes use their cover
      const m = meta.get(key);
      if (m && (m.image_url || Date.parse(m.checked_at || 0) >= cutoff)) continue;
      franchises.push({ publisher: p, key });
    }
  }
  return { publishers, franchises };
}
