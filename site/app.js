"use strict";

const DATA_DIR = "data/overwatch/";
const TIERS = ["S", "A", "B", "C", "D"];
const TIER_COLORS = { S: "var(--tier-s)", A: "var(--tier-a)", B: "var(--tier-b)", C: "var(--tier-c)", D: "var(--tier-d)" };
const TIER_LABELS_FR = {
  All: "Tous", Bronze: "Bronze", Silver: "Argent", Gold: "Or", Platinum: "Platine",
  Emerald: "Émeraude", Diamond: "Diamant", Master: "Maître", Grandmaster: "Grand maître",
};
const ROLE_LABELS_FR = { TANK: "Tank", DAMAGE: "Dégâts", SUPPORT: "Soutien" };

// Un héros peu joué a un win rate bruité : on le ramène vers 50 % proportionnellement
// à son pick rate. SHRINK_K = pick rate (%) pour lequel on garde la moitié de l'écart.
const SHRINK_K = 2;
const MIN_PICKRATE = 0.5;

const form = document.getElementById("filters");
const statusEl = document.getElementById("status");
const cache = new Map();
let meta = null;
let view = "tiers";
let tableSort = { key: "score", dir: -1 };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (n == null ? "–" : n.toFixed(1) + " %");

function adjustedWinrate(wr, pr) {
  return 50 + (wr - 50) * (pr / (pr + SHRINK_K));
}

function tierOf(score) {
  if (score >= 52) return "S";
  if (score >= 51) return "A";
  if (score >= 49.5) return "B";
  if (score >= 48) return "C";
  return "D";
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

function heroRows(combo, mapId, role) {
  const stats = combo.maps[mapId] || {};
  const global = combo.maps["all-maps"] || {};
  return Object.entries(stats)
    .filter(([id]) => meta.heroes[id] && (!role || meta.heroes[id].role === role))
    .map(([id, [wr, pr, br]]) => {
      const score = adjustedWinrate(wr, pr);
      return {
        id, ...meta.heroes[id], wr, pr, br, score,
        tier: pr >= MIN_PICKRATE ? tierOf(score) : null,
        delta: mapId !== "all-maps" && global[id] ? wr - global[id][0] : null,
      };
    });
}

function heroCard(h) {
  const cls = h.wr >= 50 ? "up" : "down";
  return `<button class="hero-card" data-hero="${esc(h.id)}" title="${esc(h.name)} — WR ${fmt(h.wr)} · PR ${fmt(h.pr)}">
    <img src="${esc(h.portrait)}" alt="" loading="lazy">
    <div class="name">${esc(h.name)}</div>
    <div class="wr ${cls}">${h.wr.toFixed(1)}%</div>
  </button>`;
}

function renderTiers(rows) {
  const groups = Object.fromEntries([...TIERS, "X"].map((t) => [t, []]));
  for (const h of rows) groups[h.tier || "X"].push(h);
  for (const g of Object.values(groups)) g.sort((a, b) => b.score - a.score);
  document.getElementById("view-tiers").innerHTML = [...TIERS, "X"]
    .filter((t) => groups[t].length)
    .map((t) => `<div class="tier-row tier-${t}">
      <div class="tier-label">${t === "X" ? "Peu joué" : t}</div>
      <div class="tier-heroes">${groups[t].map(heroCard).join("")}</div>
    </div>`).join("");
}

function renderTable(rows, f) {
  const showBan = f.mode === "competitive";
  const showDelta = f.map !== "all-maps";
  const cols = [
    { key: "name", label: "Héros" },
    { key: "role", label: "Rôle" },
    { key: "score", label: "Tier" },
    { key: "wr", label: "Win rate" },
    ...(showDelta ? [{ key: "delta", label: "Δ vs toutes maps" }] : []),
    { key: "pr", label: "Pick rate" },
    ...(showBan ? [{ key: "br", label: "Ban rate" }] : []),
  ];
  const { key, dir } = tableSort;
  const sorted = [...rows].sort((a, b) => {
    const va = a[key] ?? -Infinity, vb = b[key] ?? -Infinity;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  const cell = (h, c) => {
    switch (c.key) {
      case "name": return `<td><img class="mini" src="${esc(h.portrait)}" alt="" loading="lazy">${esc(h.name)}</td>`;
      case "role": return `<td>${ROLE_LABELS_FR[h.role] || esc(h.role)}</td>`;
      case "score": return `<td>${h.tier ? `<span class="tier-pill" style="background:${TIER_COLORS[h.tier]}">${h.tier}</span>` : "–"}</td>`;
      case "delta": return `<td class="${h.delta > 0 ? "up" : h.delta < 0 ? "down" : ""}">${h.delta == null ? "–" : (h.delta > 0 ? "+" : "") + h.delta.toFixed(1)}</td>`;
      case "wr": return `<td class="${h.wr >= 50 ? "up" : "down"}">${fmt(h.wr)}</td>`;
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
  const cells = (h) => maps.map((m) => {
    const s = combo.maps[m.id][h.id];
    if (!s || s[1] < MIN_PICKRATE) return `<td class="empty" title="${esc(h.name)} · ${esc(m.name)} : pas assez de parties"></td>`;
    return `<td style="background:${wrColor(s[0])}" title="${esc(h.name)} · ${esc(m.name)} — WR ${fmt(s[0])} · PR ${fmt(s[1])}">${Math.round(s[0])}</td>`;
  }).join("");
  document.getElementById("view-heatmap").innerHTML = `
    <p class="legend">Win rate de chaque héros sur chaque map (vert &gt; 50 %, rouge &lt; 50 %). Case vide = pick rate &lt; ${MIN_PICKRATE} %. Le filtre Map est ignoré ici.</p>
    <div class="table-wrap"><table class="heatmap">
      <thead><tr><th></th>${maps.map((m) => `<th title="${esc(m.mode)}"><span>${esc(m.name)}</span></th>`).join("")}</tr></thead>
      <tbody>${heroes.map((h) => `<tr data-hero="${esc(h.id)}"><th>${esc(h.name)}</th>${cells(h)}</tr>`).join("")}</tbody>
    </table></div>`;
}

async function showHero(id) {
  const f = filters();
  const combo = await loadJSON(fileFor(f));
  const hero = meta.heroes[id];
  const global = combo.maps["all-maps"]?.[id];
  const perMap = meta.maps
    .map((m) => ({ ...m, s: combo.maps[m.id]?.[id] }))
    .filter((m) => m.s && m.s[1] >= MIN_PICKRATE)
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
        ${global ? `<p>Toutes maps : WR ${fmt(global[0])} · PR ${fmt(global[1])}</p>` : ""}
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
    combo = await loadJSON(fileFor(f));
  } catch {
    statusEl.textContent = "Pas de données pour cette combinaison de filtres.";
    for (const v of ["tiers", "table", "heatmap"]) document.getElementById("view-" + v).innerHTML = "";
    return;
  }
  const rows = heroRows(combo, f.map, f.role);
  const mapName = f.map === "all-maps" ? "toutes les maps" : meta.maps.find((m) => m.id === f.map)?.name;
  statusEl.textContent = `${rows.length} héros · ${mapName}`;
  if (view === "tiers") renderTiers(rows);
  if (view === "table") renderTable(rows, f);
  if (view === "heatmap") renderHeatmap(combo, f.role);
}

function populateSelects() {
  const tiers = meta.filters.tiers;
  form.tier.innerHTML = tiers.map((t) => `<option value="${esc(t)}">${TIER_LABELS_FR[t] || esc(t)}</option>`).join("");
  const byMode = Map.groupBy
    ? Map.groupBy(meta.maps, (m) => m.mode)
    : meta.maps.reduce((acc, m) => acc.set(m.mode, [...(acc.get(m.mode) || []), m]), new Map());
  form.map.innerHTML = `<option value="all-maps">Toutes les maps</option>` +
    [...byMode].map(([mode, maps]) => `<optgroup label="${esc(mode)}">${maps.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</optgroup>`).join("");
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
  const updated = new Date(meta.updated_at);
  document.getElementById("updated").textContent = `Mis à jour le ${updated.toLocaleDateString("fr-FR")} à ${updated.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`;
  populateSelects();
  restoreFromHash();

  form.addEventListener("change", render);
  document.querySelector(".tabs").addEventListener("click", (e) => {
    if (e.target.dataset.view) setView(e.target.dataset.view);
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
