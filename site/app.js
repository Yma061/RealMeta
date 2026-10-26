"use strict";

const DATA_DIR = "data/overwatch/";
const TIERS = ["S", "A", "B", "C", "D"];
const TIER_COLORS = { S: "var(--tier-s)", A: "var(--tier-a)", B: "var(--tier-b)", C: "var(--tier-c)", D: "var(--tier-d)" };
const TIER_LABELS_FR = {
  All: "Tous", Bronze: "Bronze", Silver: "Argent", Gold: "Or", Platinum: "Platine",
  Emerald: "Émeraude", Diamond: "Diamant", Master: "Maître", Grandmaster: "Grand maître",
};
const ROLE_LABELS_FR = { TANK: "Tank", DAMAGE: "Dégâts", SUPPORT: "Soutien" };
const CHANGE_LABELS = { buff: ["▲", "buff"], nerf: ["▼", "nerf"], rework: ["⟳", "rework"], change: ["✎", "modifié"] };

// Deux axes séparés, calculés rôle par rôle (le tank a 1 place sur 5, ses pick rates ne
// sont pas comparables à ceux des autres rôles) :
//   force      = win rate lissé            → détermine le tier
//   popularité = log du pick rate effectif → badge et graphique, pas dans le tier
const PRIOR_K = 2;          // pick rate (%) pour lequel on fait confiance à moitié au win rate observé
const MIN_PICKRATE = 0.5;
// Tier hybride : il faut à la fois se détacher du rôle (z) et s'écarter vraiment de 50 %,
// sinon un méta plat (tous les tanks entre 49 et 51 %) produirait quand même des S.
const HIGH_TIERS = [["S", 1.0, 51], ["A", 0.35, 50.3]];     // z ≥ seuil ET win rate lissé ≥ min
const LOW_TIERS = [["D", -1.0, 49], ["C", -0.35, 49.7]];    // z ≤ seuil ET win rate lissé ≤ max
const POPULARITY_Z = 1;     // |z| au-delà duquel un héros est « très joué » ou « niche »
const ROLE_SHAPES = { TANK: "square", DAMAGE: "triangle", SUPPORT: "circle" };
// Les stats sont cumulées depuis la dernière remise à zéro (gros patchs seulement, pas les
// patchs hebdomadaires) : les premiers jours de la période, peu de parties pour tout le monde.
const FRESH_DAYS = 3;
// Un héros modifié au moment de la remise à zéro est en plus « réappris » par les joueurs.
const CHANGED_FRESH_DAYS = 7;
// Un héros modifié en cours de période a des stats qui mélangent avant et après : on le
// signale tant que moins de la moitié de la période est postérieure à la modification.
const MIXED_SHARE = 0.5;
const MAX_BAN_FOR_PR = 90;     // au-delà, corriger le pick rate par les bans l'exploserait
const PATCH_BADGE_DAYS = 14;   // Overwatch patche chaque semaine : au-delà, le badge devient du bruit
const VIEWS = ["tiers", "scatter", "table", "heatmap"];

const form = document.getElementById("filters");
const statusEl = document.getElementById("status");
const cache = new Map();
let meta = null;
let patches = [];
let view = "tiers";
let heatMode = "abs";
let lastRows = [];
let tableSort = { key: "score", dir: -1 };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null ? "–" : n.toFixed(1) + " %");
const signed = (n) => (n == null ? "–" : (n > 0 ? "+" : "") + n.toFixed(1));
const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso + "T00:00:00Z")) / 86400000) : null);
const shortDate = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

// Rapproche le win rate observé d'un « prior » selon le volume de jeu (pick rate comme proxy).
function shrink(wr, pr, prior, k = PRIOR_K) {
  return prior + (wr - prior) * (pr / (pr + k));
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) m.set(fn(x), [...(m.get(fn(x)) || []), x]);
  return m;
}

function zScores(rows, key) {
  const mean = rows.reduce((a, r) => a + r[key], 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((a, r) => a + (r[key] - mean) ** 2, 0) / rows.length) || 1;
  for (const r of rows) r["z_" + key] = (r[key] - mean) / sd;
}

function tierOf(z, wrAdj) {
  for (const [t, cut, min] of HIGH_TIERS) if (z >= cut && wrAdj >= min) return t;
  for (const [t, cut, max] of LOW_TIERS) if (z <= cut && wrAdj <= max) return t;
  return "B";
}

// Un héros banni dans X % des parties ne peut pas être joué dans ces parties-là :
// pick rate « quand il est disponible ».
function effectivePickrate(pr, br) {
  return br > 0 ? pr / (1 - Math.min(br, MAX_BAN_FOR_PR) / 100) : pr;
}

function popularityLabel(r) {
  if (r.z_pop == null) return null;
  if (r.z_pop >= POPULARITY_Z) return "Très joué";
  if (r.z_pop <= -POPULARITY_Z) return "Niche";
  return null;
}

// Quadrant force × popularité (relatifs au rôle).
function profileOf(r) {
  if (r.z_wrAdj == null) return null;
  if (r.z_wrAdj >= 0) return r.z_pop >= 0 ? "Méta" : "Pépite";
  return r.z_pop >= 0 ? "Surcoté" : "À éviter";
}

// Dernier patch ayant modifié le héros : { date, change } ou null.
function lastChange(id) {
  const p = patches.find((p) => p.changes[id]);
  return p ? { date: p.date, change: p.changes[id] } : null;
}

// Multiplicateur de PRIOR_K : ×3 le jour du patch, ×1 une fois la fenêtre passée.
function freshness(days, window) {
  return days != null && days < window ? 1 + 2 * (1 - days / window) : 1;
}

// Couleur divergente : rouge sous 50 %, vert au-dessus, saturée à ±6 points.
function wrColor(wr) {
  const t = Math.max(-1, Math.min(1, (wr - 50) / 6));
  const hue = t >= 0 ? 145 : 0;
  const light = 88 - Math.abs(t) * 30;
  return `hsl(${hue} 65% ${light}%)`;
}

function filters() {
  return Object.fromEntries(new FormData(form));
}

function fileFor(f) {
  const tier = f.mode === "quickplay" ? "All" : f.tier;
  return `${f.mode}_${f.input}_${f.region}_${tier}`.toLowerCase() + ".json";
}

async function loadJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(DATA_DIR + path).then((r) => {
      if (!r.ok) throw new Error(`${path} : HTTP ${r.status}`);
      return r.json();
    }));
  }
  try {
    return await cache.get(path);
  } catch (err) {
    cache.delete(path);
    throw err;
  }
}

// Collecte en cours + celle d'avant la dernière remise à zéro (si elle existe).
async function loadCombo(f) {
  const combo = await loadJSON(fileFor(f));
  const prev = await loadJSON("previous/" + fileFor(f)).catch(() => null);
  return { ...combo, prev: prev && prev.window_start !== combo.window_start ? prev : null };
}

function heroRows(combo, mapId, role) {
  const stats = combo.maps[mapId] || {};
  const global = combo.maps["all-maps"] || {};
  const prevStats = combo.prev?.maps[mapId] || {};
  const windowDays = daysSince(combo.window_start);
  const rows = Object.entries(stats)
    .filter(([id]) => meta.heroes[id] && (!role || meta.heroes[id].role === role))
    .map(([id, [wr, pr, br]]) => {
      const g = global[id];
      const hasGlobal = mapId !== "all-maps" && g && g[0] != null && g[1] != null;
      const changed = lastChange(id);
      const changedDays = daysSince(changed?.date);
      // Modifié en cours de période : part approximative des parties jouées après la modification.
      const postChangeShare = changed && combo.window_start && changed.date > combo.window_start && windowDays
        ? Math.min(1, changedDays / windowDays) : null;
      const changedAtReset = changed && changed.date === combo.window_start;
      const fresh = Math.max(
        freshness(windowDays, FRESH_DAYS),
        changedAtReset ? freshness(windowDays, CHANGED_FRESH_DAYS) : 1,
      );
      const valid = wr != null && pr != null;
      const prEff = valid ? effectivePickrate(pr, br ?? 0) : null;
      // Sur une map : prior = win rate global (lissé) du héros. Sur « toutes maps » : 50 %.
      const prior = hasGlobal ? shrink(g[0], effectivePickrate(g[1], g[2] ?? 0), 50) : 50;
      const prevWr = prevStats[id]?.[0];
      return {
        id, ...meta.heroes[id], wr, pr, br: br ?? 0, prEff,
        wrAdj: valid ? shrink(wr, prEff, prior, PRIOR_K * fresh) : null,
        pop: valid ? Math.log(Math.max(prEff, 0.1)) : null, // pick rate très asymétrique → log
        delta: hasGlobal && wr != null ? wr - g[0] : null,
        trend: wr != null && prevWr != null ? wr - prevWr : null,
        change: changed && changedDays <= PATCH_BADGE_DAYS ? changed.change : null,
        changedDays,
        postChangeShare,
        mixed: postChangeShare != null && postChangeShare < MIXED_SHARE,
        lowConfidence: fresh > 1.5 || (postChangeShare != null && postChangeShare < MIXED_SHARE),
        valid,
        score: -Infinity, tier: null, z_wrAdj: null, z_pop: null,
      };
    });

  const eligible = rows.filter((r) => r.valid && r.pr >= MIN_PICKRATE);
  for (const group of groupBy(eligible, (r) => r.role).values()) {
    if (group.length < 3) {
      for (const r of group) { r.z_wrAdj = 0; r.z_pop = 0; r.score = 0; r.tier = "B"; }
      continue;
    }
    zScores(group, "wrAdj"); zScores(group, "pop");
    for (const r of group) {
      r.score = r.z_wrAdj;
      r.tier = tierOf(r.z_wrAdj, r.wrAdj);
    }
  }
  for (const r of rows) {
    r.popularity = popularityLabel(r);
    r.profile = profileOf(r);
  }
  return rows;
}

function patchBadge(h) {
  if (!h.change) return "";
  const [icon, label] = CHANGE_LABELS[h.change] || CHANGE_LABELS.change;
  const title = `${label} il y a ${h.changedDays} j` + (h.mixed ? ` · ${mixedNote(h)}` : "");
  return `<div class="patch ${esc(h.change)}" title="${esc(title)}">${icon} J+${h.changedDays}</div>`;
}

function mixedNote(h) {
  return `stats encore surtout d'avant la modification (≈${Math.round(h.postChangeShare * 100)} % de la période après)`;
}

function confidenceNote(h) {
  if (h.mixed) return mixedNote(h);
  return h.lowConfidence ? "données encore limitées" : "";
}

function heroCard(h) {
  const cls = h.wr == null ? "" : h.wr >= 50 ? "up" : "down";
  const note = confidenceNote(h);
  return `<button class="hero-card ${h.lowConfidence ? "low-conf" : ""}" data-hero="${esc(h.id)}"
      title="${esc(h.name)} — WR ${fmt(h.wr)} · PR ${fmt(h.pr)} · BR ${fmt(h.br)}${note ? " · " + esc(note) : ""}">
    ${patchBadge(h)}
    <img src="${esc(h.portrait)}" alt="" loading="lazy">
    <div class="name">${esc(h.name)}</div>
    <div class="wr ${cls}">${h.wr == null ? "–" : h.wr.toFixed(1) + "%"}</div>
    ${h.popularity ? `<div class="pop">${h.popularity}</div>` : ""}
    ${h.delta != null && Math.abs(h.delta) >= 1
      ? `<div class="delta ${h.delta > 0 ? "up" : "down"}" title="Écart vs son win rate toutes maps">${signed(h.delta)}</div>` : ""}
  </button>`;
}

function renderTiers(rows, title) {
  const groups = Object.fromEntries([...TIERS, "X"].map((t) => [t, []]));
  for (const h of rows) groups[h.tier || "X"].push(h);
  for (const g of Object.values(groups)) g.sort((a, b) => b.score - a.score || (b.pr ?? 0) - (a.pr ?? 0));
  document.getElementById("view-tiers").innerHTML = `<h2 class="view-title">${esc(title)}</h2>` + [...TIERS, "X"]
    .filter((t) => groups[t].length)
    .map((t) => `<div class="tier-row tier-${t}">
      <div class="tier-label">${t === "X" ? "Peu joué" : t}</div>
      <div class="tier-heroes">${groups[t].map(heroCard).join("")}</div>
    </div>`).join("");
}

function renderTable(rows, f, hasPrev) {
  const showBan = f.mode === "competitive";
  const showDelta = f.map !== "all-maps";
  const cols = [
    { key: "name", label: "Héros" },
    { key: "role", label: "Rôle" },
    { key: "score", label: "Tier" },
    { key: "wr", label: "Win rate" },
    ...(showDelta ? [{ key: "delta", label: "Δ vs toutes maps" }] : []),
    ...(hasPrev ? [{ key: "trend", label: "Δ vs période préc." }] : []),
    { key: "pr", label: "Pick rate" },
    ...(showBan ? [{ key: "br", label: "Ban rate" }] : []),
    { key: "z_pop", label: "Popularité" },
    { key: "profile", label: "Profil" },
    { key: "changedDays", label: "Dernier patch" },
  ];
  const { key, dir } = tableSort;
  const sorted = [...rows].sort((a, b) => {
    const va = a[key] ?? -Infinity, vb = b[key] ?? -Infinity;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  const diffCell = (v) => `<td class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${signed(v)}</td>`;
  const cell = (h, c) => {
    switch (c.key) {
      case "name": return `<td><img class="mini" src="${esc(h.portrait)}" alt="" loading="lazy">${esc(h.name)}</td>`;
      case "role": return `<td>${ROLE_LABELS_FR[h.role] || esc(h.role)}</td>`;
      case "score": return `<td>${h.tier ? `<span class="tier-pill" style="background:${TIER_COLORS[h.tier]}">${h.tier}</span>` : "–"}${h.lowConfidence ? ` <span class="muted" title="${esc(confidenceNote(h))}">?</span>` : ""}</td>`;
      case "delta": return diffCell(h.delta);
      case "trend": return diffCell(h.trend);
      case "wr": return `<td class="${h.wr == null ? "" : h.wr >= 50 ? "up" : "down"}">${fmt(h.wr)}</td>`;
      case "z_pop": return `<td title="Pick rate effectif (hors bans) : ${fmt(h.prEff)}">${h.popularity || (h.z_pop == null ? "–" : "Moyenne")}</td>`;
      case "profile": return `<td>${h.profile || "–"}</td>`;
      case "changedDays": return `<td>${h.change ? `${(CHANGE_LABELS[h.change] || CHANGE_LABELS.change)[1]} · J+${h.changedDays}` : "–"}</td>`;
      default: return `<td>${fmt(h[c.key])}</td>`;
    }
  };
  document.getElementById("view-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${cols.map((c) => `<th data-sort="${c.key}" class="${c.key === key ? "sorted" : ""}">${c.label}${c.key === key ? (dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((h) => `<tr data-hero="${esc(h.id)}">${cols.map((c) => cell(h, c)).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

// Nuage force × popularité : les deux axes sont des z-scores dans le rôle, ce qui permet
// d'afficher tanks, dégâts et soutiens sur le même graphique.
const QUADRANTS = [
  { name: "Méta", hint: "fort et très joué", x: 1, y: 1 },
  { name: "Pépites", hint: "fort mais peu joué", x: -1, y: 1 },
  { name: "Surcotés", hint: "très joué mais faible", x: 1, y: -1 },
  { name: "À éviter", hint: "faible et peu joué", x: -1, y: -1 },
];

function shapePath(shape, x, y, r) {
  if (shape === "square") return `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" rx="1.5"`;
  if (shape === "triangle") {
    const h = r * 1.2;
    return `<path d="M${x} ${y - h}L${x + h} ${y + h * 0.8}L${x - h} ${y + h * 0.8}Z"`;
  }
  return `<circle cx="${x}" cy="${y}" r="${r}"`;
}

function renderScatter(rows) {
  const W = 800, H = 520, PAD = { l: 48, r: 16, t: 16, b: 44 }, LIM = 2.6;
  const points = rows.filter((r) => r.z_wrAdj != null);
  const sx = (z) => PAD.l + ((Math.max(-LIM, Math.min(LIM, z)) + LIM) / (2 * LIM)) * (W - PAD.l - PAD.r);
  const sy = (z) => PAD.t + (1 - (Math.max(-LIM, Math.min(LIM, z)) + LIM) / (2 * LIM)) * (H - PAD.t - PAD.b);
  const x0 = sx(0), y0 = sy(0);
  const quadLabels = QUADRANTS.map((q) => {
    const x = q.x > 0 ? W - PAD.r - 8 : PAD.l + 8;
    const y = q.y > 0 ? PAD.t + 18 : H - PAD.b - 22;
    const anchor = q.x > 0 ? "end" : "start";
    return `<text class="quad-name" x="${x}" y="${y}" text-anchor="${anchor}">${q.name}</text>
      <text class="quad-hint" x="${x}" y="${y + 15}" text-anchor="${anchor}">${q.hint}</text>`;
  }).join("");
  // Étiquettes seulement pour les héros qui se détachent, en commençant par les plus
  // excentrés ; une étiquette qui chevaucherait une autre est essayée à gauche, sinon omise.
  const placed = [];
  const labels = new Map();
  const overlaps = (b) => placed.some((p) => b.x1 < p.x2 && b.x2 > p.x1 && b.y1 < p.y2 && b.y2 > p.y1);
  for (const r of [...points].sort((a, b) => Math.hypot(b.z_wrAdj, b.z_pop) - Math.hypot(a.z_wrAdj, a.z_pop))) {
    if (Math.abs(r.z_wrAdj) < 1.2 && Math.abs(r.z_pop) < 1.4) continue;
    const x = sx(r.z_pop), y = sy(r.z_wrAdj), w = r.name.length * 6.6;
    for (const [lx, anchor] of [[x + 9, "start"], [x - 9, "end"]]) {
      const box = { x1: anchor === "start" ? lx : lx - w, x2: anchor === "start" ? lx + w : lx, y1: y - 8, y2: y + 6 };
      if (!overlaps(box)) { placed.push(box); labels.set(r.id, { lx, anchor }); break; }
    }
  }
  const marks = points.map((r) => {
    const x = sx(r.z_pop), y = sy(r.z_wrAdj), l = labels.get(r.id);
    return `<g class="pt role-${r.role.toLowerCase()}" data-hero="${esc(r.id)}">
      <circle class="hit" cx="${x}" cy="${y}" r="12"/>
      ${shapePath(ROLE_SHAPES[r.role], x, y, 5.5)} class="mark"/>
      ${l ? `<text class="pt-label" x="${l.lx}" y="${y + 4}" text-anchor="${l.anchor}">${esc(r.name)}</text>` : ""}
    </g>`;
  }).join("");
  const roles = [...new Set(points.map((r) => r.role))];
  const legend = roles.map((role) => `<span class="legend-item role-${role.toLowerCase()}">
      <svg width="14" height="14" viewBox="0 0 14 14">${shapePath(ROLE_SHAPES[role], 7, 7, 5)} class="mark"/></svg>
      ${ROLE_LABELS_FR[role] || esc(role)}</span>`).join("");
  document.getElementById("view-scatter").innerHTML = `
    <div class="scatter-legend">${legend}</div>
    <p class="legend">Chaque héros est comparé aux autres héros de son rôle. Vers le haut : il gagne plus
      (win rate lissé). Vers la droite : il est plus joué (pick rate hors bans). Survole un point pour le détail.</p>
    <div class="scatter-wrap">
      <svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="Force et popularité des héros">
        <line class="axis-mid" x1="${x0}" x2="${x0}" y1="${PAD.t}" y2="${H - PAD.b}"/>
        <line class="axis-mid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y0}" y2="${y0}"/>
        ${quadLabels}
        <text class="axis-title" x="${(PAD.l + W - PAD.r) / 2}" y="${H - 12}" text-anchor="middle">Popularité →</text>
        <text class="axis-title" transform="translate(16 ${(PAD.t + H - PAD.b) / 2}) rotate(-90)" text-anchor="middle">Force →</text>
        ${marks}
      </svg>
      <div class="tooltip" hidden></div>
    </div>`;
}

function showScatterTooltip(e) {
  const wrap = e.target.closest(".scatter-wrap");
  const tip = wrap?.querySelector(".tooltip");
  if (!tip) return;
  const pt = e.target.closest("[data-hero]");
  if (!pt) { tip.hidden = true; return; }
  const r = lastRows.find((x) => x.id === pt.dataset.hero);
  if (!r) return;
  tip.innerHTML = `<strong>${esc(r.name)}</strong> · ${ROLE_LABELS_FR[r.role] || esc(r.role)}
    ${r.tier ? `<span class="tier-pill" style="background:${TIER_COLORS[r.tier]}">${r.tier}</span>` : ""}<br>
    Win rate ${fmt(r.wr)} (lissé ${fmt(r.wrAdj)})<br>
    Pick rate ${fmt(r.pr)} · hors bans ${fmt(r.prEff)}<br>
    Ban rate ${fmt(r.br)} · <em>${esc(r.profile || "")}</em>`;
  const box = wrap.getBoundingClientRect();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  tip.hidden = false;
  tip.style.left = Math.min(x + 14, box.width - tip.offsetWidth - 4) + "px";
  tip.style.top = Math.max(y - tip.offsetHeight - 10, 4) + "px";
}

function renderHeatmap(combo, role) {
  const heroes = heroRows(combo, "all-maps", role).sort((a, b) => b.score - a.score);
  const maps = meta.maps.filter((m) => combo.maps[m.id]);
  const global = combo.maps["all-maps"] || {};
  const cells = (h) => maps.map((m) => {
    const s = combo.maps[m.id][h.id];
    if (!s || s[0] == null || s[1] == null || s[1] < MIN_PICKRATE) {
      return `<td class="empty" title="${esc(h.name)} · ${esc(m.name)} : pas assez de parties"></td>`;
    }
    const g = global[h.id]?.[0];
    const diff = g != null ? s[0] - g : null;
    // En mode écart, 50 = neutre pour réutiliser la même échelle de couleur.
    const val = heatMode === "delta" && diff != null ? 50 + diff : s[0];
    const label = heatMode === "delta" ? (diff == null ? "–" : (diff > 0 ? "+" : "") + Math.round(diff)) : Math.round(s[0]);
    return `<td style="background:${wrColor(val)}" title="${esc(h.name)} · ${esc(m.name)} — WR ${fmt(s[0])} (${signed(diff)} vs toutes maps) · PR ${fmt(s[1])}">${label}</td>`;
  }).join("");
  document.getElementById("view-heatmap").innerHTML = `
    <div class="heat-controls">
      <label>Couleur
        <select id="heat-mode">
          <option value="abs" ${heatMode === "abs" ? "selected" : ""}>Win rate</option>
          <option value="delta" ${heatMode === "delta" ? "selected" : ""}>Écart vs toutes maps (spécialistes)</option>
        </select>
      </label>
    </div>
    <p class="legend">${heatMode === "abs"
      ? "Win rate de chaque héros sur chaque map (vert &gt; 50 %, rouge &lt; 50 %)."
      : "Points de win rate gagnés (vert) ou perdus (rouge) sur la map par rapport à la moyenne du héros sur toutes les maps."}
      Case vide = pick rate &lt; ${MIN_PICKRATE} %. Le filtre Map est ignoré ici.</p>
    <div class="table-wrap"><table class="heatmap">
      <thead><tr><th></th>${maps.map((m) => `<th title="${esc(m.mode)}"><span>${esc(m.name)}</span></th>`).join("")}</tr></thead>
      <tbody>${heroes.map((h) => `<tr data-hero="${esc(h.id)}"><th>${esc(h.name)}</th>${cells(h)}</tr>`).join("")}</tbody>
    </table></div>`;
}

async function showHero(id) {
  const f = filters();
  const combo = await loadCombo(f);
  const hero = meta.heroes[id];
  const global = combo.maps["all-maps"]?.[id];
  const prevGlobal = combo.prev?.maps["all-maps"]?.[id];
  const changed = lastChange(id);
  const perMap = meta.maps
    .map((m) => ({ ...m, s: combo.maps[m.id]?.[id] }))
    .filter((m) => m.s && m.s[0] != null && m.s[1] >= MIN_PICKRATE)
    .sort((a, b) => b.s[0] - a.s[0]);
  const bar = (wr) => {
    const off = Math.max(-10, Math.min(10, wr - 50)) * 5; // ±10 pts = demi-barre
    const left = off >= 0 ? 50 : 50 + off;
    return `<i style="left:${left}%;width:${Math.abs(off)}%;background:${off >= 0 ? "var(--good)" : "var(--bad)"}"></i>`;
  };
  document.getElementById("hero-detail").innerHTML = `
    <div class="hero-head">
      <img src="${esc(hero.portrait)}" alt="">
      <div>
        <h2>${esc(hero.name)}</h2>
        <p>${ROLE_LABELS_FR[hero.role] || esc(hero.role)} · ${esc(hero.subrole || "")}</p>
        ${global ? `<p>Toutes maps : WR ${fmt(global[0])} · PR ${fmt(global[1])}${prevGlobal?.[0] != null && global[0] != null ? ` · ${signed(global[0] - prevGlobal[0])} vs période préc.` : ""}</p>` : ""}
        ${changed ? `<p>Dernière modification : ${(CHANGE_LABELS[changed.change] || CHANGE_LABELS.change)[1]} le ${shortDate(changed.date)}</p>` : ""}
      </div>
    </div>
    <h3>Meilleures et pires maps</h3>
    ${perMap.length ? `<ul class="map-bars">${perMap.map((m) => `
      <li title="PR ${fmt(m.s[1])}"><span>${esc(m.name)}</span><span class="bar">${bar(m.s[0])}</span><span class="${m.s[0] >= 50 ? "up" : "down"}">${m.s[0].toFixed(1)}%</span></li>`).join("")}
    </ul>` : "<p>Pas assez de parties sur les maps pour ces filtres.</p>"}`;
  document.getElementById("hero-dialog").showModal();
}

async function render() {
  const f = filters();
  form.tier.disabled = f.mode === "quickplay";
  history.replaceState(null, "", "#" + new URLSearchParams({ ...f, view }));
  statusEl.textContent = "Chargement…";
  let combo;
  try {
    combo = await loadCombo(f);
  } catch {
    statusEl.textContent = "Pas de données pour cette combinaison de filtres.";
    for (const v of VIEWS) document.getElementById("view-" + v).innerHTML = "";
    return;
  }
  const rows = heroRows(combo, f.map, f.role);
  lastRows = rows;
  const mapName = f.map === "all-maps" ? "Toutes les maps" : meta.maps.find((m) => m.id === f.map)?.name;
  const windowDays = daysSince(combo.window_start);
  const notes = [`${rows.length} héros`];
  if (combo.window_start) notes.push(`stats cumulées depuis le ${shortDate(combo.window_start)} (J+${windowDays})`);
  if (combo.collected_at && daysSince(combo.collected_at) > 2) notes.push(`⚠ ces filtres n'ont pas pu être rafraîchis depuis le ${shortDate(combo.collected_at)}`);
  else if (windowDays != null && windowDays < FRESH_DAYS) notes.push("⚠ remise à zéro récente : peu de parties, tiers provisoires");
  statusEl.textContent = notes.join(" · ");
  if (view === "tiers") renderTiers(rows, `Tier list — ${mapName}`);
  if (view === "scatter") renderScatter(rows);
  if (view === "table") renderTable(rows, f, !!combo.prev);
  if (view === "heatmap") renderHeatmap(combo, f.role);
}

function populateSelects() {
  const tiers = meta.filters.tiers;
  form.tier.innerHTML = tiers.map((t) => `<option value="${esc(t)}">${TIER_LABELS_FR[t] || esc(t)}</option>`).join("");
  form.map.innerHTML = `<option value="all-maps">Toutes les maps</option>` +
    [...groupBy(meta.maps, (m) => m.mode)].map(([mode, maps]) => `<optgroup label="${esc(mode)}">${maps.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</optgroup>`).join("");
}

function restoreFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of params) {
    if (k === "view") view = v;
    else if (form.elements[k] && [...form.elements[k].options].some((o) => o.value === v)) form.elements[k].value = v;
  }
}

function setView(v) {
  view = v;
  for (const btn of document.querySelectorAll(".tabs button")) btn.setAttribute("aria-selected", btn.dataset.view === v);
  for (const sec of document.querySelectorAll(".view")) sec.hidden = sec.id !== "view-" + v;
  render();
}

async function init() {
  try {
    meta = await loadJSON("meta.json");
  } catch {
    statusEl.textContent = "Données introuvables. Lance d'abord : python collector/overwatch.py";
    return;
  }
  patches = await loadJSON("patches.json").catch(() => []);
  const updated = new Date(meta.updated_at);
  document.getElementById("updated").textContent = `Mis à jour le ${updated.toLocaleDateString("fr-FR")} à ${updated.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`;
  populateSelects();
  restoreFromHash();

  form.addEventListener("change", render);
  document.querySelector(".tabs").addEventListener("click", (e) => {
    if (e.target.dataset.view) setView(e.target.dataset.view);
  });
  document.getElementById("view-heatmap").addEventListener("change", (e) => {
    if (e.target.id === "heat-mode") { heatMode = e.target.value; render(); }
  });
  const scatterView = document.getElementById("view-scatter");
  scatterView.addEventListener("pointermove", showScatterTooltip);
  scatterView.addEventListener("pointerleave", () => {
    const tip = scatterView.querySelector(".tooltip");
    if (tip) tip.hidden = true;
  });
  document.querySelector("main").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const key = th.dataset.sort;
      tableSort = { key, dir: tableSort.key === key ? -tableSort.dir : key === "name" || key === "role" ? 1 : -1 };
      return render();
    }
    const heroEl = e.target.closest("[data-hero]");
    if (heroEl && !e.target.closest("dialog")) showHero(heroEl.dataset.hero);
  });

  setView(VIEWS.includes(view) ? view : "tiers");
}

init();
