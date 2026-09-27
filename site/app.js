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

// Tier list : classement relatif, rôle par rôle (le tank a 1 place sur 5, ses pick rates
// ne sont pas comparables à ceux des autres rôles).
const PRIOR_K = 2;          // pick rate (%) pour lequel on fait confiance à moitié au win rate observé
const MIN_PICKRATE = 0.5;
const W = { wr: 0.65, pr: 0.25, br: 0.10 };               // poids du score composite
const Z_CUTS = [["S", 1.0], ["A", 0.35], ["B", -0.35], ["C", -1.0]];
// Blizzard repart de zéro à chaque patch : les premiers jours, peu de parties pour tout le monde.
const FRESH_DAYS = 3;
// Un héros modifié par le patch en cours est en plus « réappris » par les joueurs.
const CHANGED_FRESH_DAYS = 7;
const PATCH_BADGE_DAYS = 30;

const form = document.getElementById("filters");
const statusEl = document.getElementById("status");
const cache = new Map();
let meta = null;
let patches = [];
let view = "tiers";
let heatMode = "abs";
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

function tierOfZ(z) {
  for (const [t, cut] of Z_CUTS) if (z >= cut) return t;
  return "D";
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

// Collecte en cours + celle du patch précédent (si elle existe).
async function loadCombo(f) {
  const combo = await loadJSON(fileFor(f));
  const prev = await loadJSON("previous/" + fileFor(f)).catch(() => null);
  return { ...combo, prev: prev && prev.patch !== combo.patch ? prev : null };
}

function heroRows(combo, mapId, role) {
  const stats = combo.maps[mapId] || {};
  const global = combo.maps["all-maps"] || {};
  const prevStats = combo.prev?.maps[mapId] || {};
  const patchDays = daysSince(combo.patch);
  const rows = Object.entries(stats)
    .filter(([id]) => meta.heroes[id] && (!role || meta.heroes[id].role === role))
    .map(([id, [wr, pr, br]]) => {
      const g = global[id];
      const hasGlobal = mapId !== "all-maps" && g && g[0] != null && g[1] != null;
      const changed = lastChange(id);
      const changedDays = daysSince(changed?.date);
      const changedThisPatch = changed && changed.date === combo.patch;
      const fresh = Math.max(
        freshness(patchDays, FRESH_DAYS),
        changedThisPatch ? freshness(patchDays, CHANGED_FRESH_DAYS) : 1,
      );
      const valid = wr != null && pr != null;
      // Sur une map : prior = win rate global (lissé) du héros. Sur « toutes maps » : 50 %.
      const prior = hasGlobal ? shrink(g[0], g[1], 50) : 50;
      const prevWr = prevStats[id]?.[0];
      return {
        id, ...meta.heroes[id], wr, pr, br: br ?? 0,
        wrAdj: valid ? shrink(wr, pr, prior, PRIOR_K * fresh) : null,
        prLog: valid ? Math.log(Math.max(pr, 0.1)) : null, // pick rate très asymétrique → log
        delta: hasGlobal && wr != null ? wr - g[0] : null,
        trend: wr != null && prevWr != null ? wr - prevWr : null,
        change: changed && changedDays <= PATCH_BADGE_DAYS ? changed.change : null,
        changedDays,
        lowConfidence: fresh > 1.5,
        valid,
        score: -Infinity, tier: null,
      };
    });

  const eligible = rows.filter((r) => r.valid && r.pr >= MIN_PICKRATE);
  for (const group of groupBy(eligible, (r) => r.role).values()) {
    if (group.length < 3) { for (const r of group) { r.score = 0; r.tier = "B"; } continue; }
    zScores(group, "wrAdj"); zScores(group, "prLog"); zScores(group, "br");
    for (const r of group) r.score = W.wr * r.z_wrAdj + W.pr * r.z_prLog + W.br * r.z_br;
    zScores(group, "score");
    for (const r of group) r.tier = tierOfZ(r.z_score);
  }
  return rows;
}

function patchBadge(h) {
  if (!h.change) return "";
  const [icon, label] = CHANGE_LABELS[h.change] || CHANGE_LABELS.change;
  const title = `${label} il y a ${h.changedDays} j` + (h.trend != null ? ` · WR ${signed(h.trend)} vs patch précédent` : "");
  return `<div class="patch ${esc(h.change)}" title="${esc(title)}">${icon} J+${h.changedDays}</div>`;
}

function heroCard(h) {
  const cls = h.wr == null ? "" : h.wr >= 50 ? "up" : "down";
  return `<button class="hero-card ${h.lowConfidence ? "low-conf" : ""}" data-hero="${esc(h.id)}"
      title="${esc(h.name)} — WR ${fmt(h.wr)} · PR ${fmt(h.pr)}${h.lowConfidence ? " · données encore limitées" : ""}">
    ${patchBadge(h)}
    <img src="${esc(h.portrait)}" alt="" loading="lazy">
    <div class="name">${esc(h.name)}</div>
    <div class="wr ${cls}">${h.wr == null ? "–" : h.wr.toFixed(1) + "%"}</div>
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
    ...(hasPrev ? [{ key: "trend", label: "Δ vs patch préc." }] : []),
    { key: "pr", label: "Pick rate" },
    ...(showBan ? [{ key: "br", label: "Ban rate" }] : []),
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
      case "score": return `<td>${h.tier ? `<span class="tier-pill" style="background:${TIER_COLORS[h.tier]}">${h.tier}</span>` : "–"}${h.lowConfidence ? ' <span class="muted" title="Données encore limitées">?</span>' : ""}</td>`;
      case "delta": return diffCell(h.delta);
      case "trend": return diffCell(h.trend);
      case "wr": return `<td class="${h.wr == null ? "" : h.wr >= 50 ? "up" : "down"}">${fmt(h.wr)}</td>`;
      case "changedDays": return `<td>${h.change ? `${(CHANGE_LABELS[h.change] || CHANGE_LABELS.change)[1]} · J+${h.changedDays}` : "–"}</td>`;
      default: return `<td>${fmt(h[c.key])}</td>`;
    }
  };
  document.getElementById("view-table").innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${cols.map((c) => `<th data-sort="${c.key}" class="${c.key === key ? "sorted" : ""}">${c.label}${c.key === key ? (dir < 0 ? " ▼" : " ▲") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((h) => `<tr data-hero="${esc(h.id)}">${cols.map((c) => cell(h, c)).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
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
        ${global ? `<p>Toutes maps : WR ${fmt(global[0])} · PR ${fmt(global[1])}${prevGlobal?.[0] != null && global[0] != null ? ` · ${signed(global[0] - prevGlobal[0])} vs patch préc.` : ""}</p>` : ""}
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
    for (const v of ["tiers", "table", "heatmap"]) document.getElementById("view-" + v).innerHTML = "";
    return;
  }
  const rows = heroRows(combo, f.map, f.role);
  const mapName = f.map === "all-maps" ? "Toutes les maps" : meta.maps.find((m) => m.id === f.map)?.name;
  const patchDays = daysSince(combo.patch);
  const notes = [`${rows.length} héros`];
  if (combo.patch) notes.push(`patch du ${shortDate(combo.patch)} (J+${patchDays})`);
  if (combo.patch && meta.patch && combo.patch !== meta.patch) notes.push("⚠ ces filtres n'ont pas encore été rafraîchis depuis le dernier patch");
  else if (patchDays != null && patchDays < FRESH_DAYS) notes.push("⚠ patch récent : peu de parties, tiers provisoires");
  statusEl.textContent = notes.join(" · ");
  if (view === "tiers") renderTiers(rows, `Tier list — ${mapName}`);
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

  setView(["tiers", "table", "heatmap"].includes(view) ? view : "tiers");
}

init();
