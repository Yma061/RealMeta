"""Collecte les statistiques officielles de héros Overwatch publiées par Blizzard.

Source : https://overwatch.blizzard.com/en-us/rates/ — la page embarque en JSON le
win rate, pick rate et ban rate de chaque héros pour une combinaison de filtres
(mode, plateforme, région, rang, map).

Les stats sont cumulées depuis la dernière remise à zéro de Blizzard. D'après l'historique
de nos collectes, seuls les gros patchs (début de saison) remettent à zéro, pas les patchs
hebdomadaires : on détecte donc la remise à zéro dans les données (saut brutal des win
rates), et non à partir des notes de patch.

Blizzard renvoie parfois les stats d'une autre combinaison de filtres que celle demandée.
Chaque page est donc vérifiée (filtres affichés = filtres demandés), puis l'ensemble de la
collecte (deux combinaisons ne peuvent pas avoir exactement les mêmes chiffres) ; une
combinaison suspecte est écartée et ses données précédentes sont conservées.

Sortie (dans site/data/overwatch/) :
  meta.json                              héros, maps, filtres, date de mise à jour
  patches.json                           [{date, title, changes: {hero_id: "change"}}], le plus récent
                                         en premier ; "change" peut être remplacé à la main par
                                         "buff" / "nerf" / "rework" (conservé aux collectes suivantes)
  {mode}_{input}_{region}_{tier}.json    {"window_start": date, "collected_at": date,
                                          "maps": {map_id: {hero_id: [wr, pr, br]}}}
  previous/{même nom}.json               même format, dernière collecte avant la remise à zéro
"""

import argparse
import html
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

BASE_URL = "https://overwatch.blizzard.com/en-us/rates/"
PATCH_NOTES_URL = "https://overwatch.blizzard.com/en-us/news/patch-notes/"
USER_AGENT = "RealMeta/0.1 (+https://github.com/Yma061/RealMeta)"
OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data" / "overwatch"
PREV_DIR = OUT_DIR / "previous"

# Remise à zéro : écart moyen de win rate (toutes maps) avec la collecte précédente. Les
# variations normales restent sous 0,5 point ; les remises à zéro observées dépassent 1,5.
RESET_JUMP = 1.0
# Une remise à zéro touche tout un mode en même temps : on l'exige pour la majorité des
# combinaisons du mode, et pas dans les jours qui suivent la précédente (données encore maigres).
RESET_MIN_SHARE = 0.5
RESET_MIN_DAYS = 3
FILTER_CHECK_RETRIES = 3

MODES = {"competitive": "2", "quickplay": "0"}
INPUTS = ["PC", "Console"]
REGIONS = ["Americas", "Asia", "Europe"]
TIERS = ["All", "Bronze", "Silver", "Gold", "Platinum", "Emerald", "Diamond", "Master", "Grandmaster"]


# Blizzard renvoie 403/429 quand on enchaîne trop de requêtes depuis la même IP.
# On patiente de plus en plus longtemps ; si ça persiste, on arrête toute la collecte
# (les fichiers déjà présents restent en place).
THROTTLE_CODES = {403, 429}
THROTTLE_WAITS = [30, 90, 180]
blocked = threading.Event()


def fetch(params, retries=3, base=BASE_URL):
    url = base + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    throttled = 0
    attempt = 0
    while True:
        if blocked.is_set():
            raise RuntimeError("collecte interrompue : Blizzard bloque les requêtes")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return html.unescape(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code in THROTTLE_CODES:
                if throttled == len(THROTTLE_WAITS):
                    blocked.set()
                    raise RuntimeError(f"bloqué ({exc.code}) sur {url}") from exc
                time.sleep(THROTTLE_WAITS[throttled])
                throttled += 1
                continue
            attempt += 1
            if attempt == retries:
                raise RuntimeError(f"échec {url}: {exc}") from exc
            time.sleep(2 ** attempt)
        except Exception as exc:  # réseau instable, timeout, etc.
            attempt += 1
            if attempt == retries:
                raise RuntimeError(f"échec {url}: {exc}") from exc
            time.sleep(2 ** attempt)


def error(msg):
    # Format "::error::" : affiché comme annotation dans GitHub Actions.
    print(f"::error::{msg}" if os.environ.get("GITHUB_ACTIONS") else f"ERREUR {msg}", file=sys.stderr)


def parse_rows(page):
    match = re.search(r'allrows="(\[.*?\])"', page, re.S)
    if not match:
        raise ValueError("tableau de stats introuvable dans la page")
    return json.loads(match.group(1))


def num(value):
    # Blizzard affiche "--" quand il n'y a pas assez de données.
    return value if isinstance(value, (int, float)) else None


def parse_maps(page):
    maps = []
    for mode, body in re.findall(r'<optgroup[^>]*label="([^"]+)"(.*?)</optgroup>', page, re.S):
        for map_id, name in re.findall(r'value="([^"]+)">([^<]+)<', body):
            maps.append({"id": map_id, "name": name.strip(), "mode": mode})
    return maps


def selected_filters(page):
    """Filtres que la page déclare appliqués : {label: valeur}."""
    selected = {}
    for label, body in re.findall(r'<select[^>]*data-label="([^"]+)"[^>]*>(.*?)</select>', page, re.S):
        match = re.search(r'<option[^>]*selected="selected"[^>]*value="([^"]+)"', body)
        if match:
            selected[label] = match.group(1)
    return selected


def fetch_stats(params):
    """Page de stats dont les filtres affichés correspondent bien à ceux demandés."""
    for attempt in range(FILTER_CHECK_RETRIES):
        page = fetch(params)
        shown = selected_filters(page)
        wrong = {k: shown[k] for k in ("input", "region", "rq", "tier", "map") if k in shown and shown[k] != params[k]}
        if not wrong:
            return page
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"filtres non appliqués par Blizzard (demandé {params}, affiché {wrong})")


def params_for(mode, input_, region, tier, map_id):
    return {"input": input_, "map": map_id, "region": region, "role": "All",
            "rq": MODES[mode], "tier": tier}


def parse_patches(page, hero_ids_by_name):
    """Patchs listés sur la page, avec les héros modifiés hors mode Stadium et corrections de bugs."""
    patches = []
    for block in re.split(r'class="PatchNotes-patch ', page)[1:]:
        raw_date = re.search(r'PatchNotes-date"[^>]*>([^<]+)', block)
        title = re.search(r'PatchNotes-patchTitle"[^>]*>([^<]+)', block)
        if not raw_date:
            continue
        changes = {}
        context = ""
        for section in re.split(r'class="PatchNotes-section ', block)[1:]:
            kind = section.split('"')[0]
            if kind.endswith("generic_update"):
                heading = re.search(r'PatchNotes-sectionTitle"[^>]*>([^<]*)', section)
                context = heading.group(1).lower() if heading else ""
            elif kind.endswith("hero_update") and "stadium" not in context and "bug" not in context:
                for name in re.findall(r'PatchNotesHeroUpdate-name"[^>]*>([^<]+)', section):
                    hero_id = hero_ids_by_name.get(name.strip().lower())
                    if hero_id:
                        changes[hero_id] = "change"
        patches.append({
            "date": datetime.strptime(raw_date.group(1).strip(), "%B %d, %Y").date().isoformat(),
            "title": title.group(1).strip() if title else "",
            "changes": changes,
        })
    return patches


def update_patches(heroes):
    """Fusionne les patchs publiés avec patches.json, sans écraser les tags posés à la main."""
    path = OUT_DIR / "patches.json"
    known = {p["date"]: p for p in json.loads(path.read_text(encoding="utf-8"))} if path.exists() else {}
    try:
        by_name = {h["name"].lower(): hero_id for hero_id, h in heroes.items()}
        for patch in parse_patches(fetch(None, base=PATCH_NOTES_URL), by_name):
            old = known.get(patch["date"])
            if old:
                patch["changes"] = {**patch["changes"], **old["changes"]}
            known[patch["date"]] = patch
    except Exception as exc:
        error(f"notes de patch : {exc}")
    patches = sorted(known.values(), key=lambda p: p["date"], reverse=True)
    path.write_text(json.dumps(patches, ensure_ascii=False, indent=1), encoding="utf-8")
    return patches


def reset_start(patches, today):
    """Début de la nouvelle fenêtre : le patch qui l'explique s'il est récent, sinon aujourd'hui."""
    for p in patches:
        days = (today - date.fromisoformat(p["date"])).days
        if 0 <= days <= RESET_MIN_DAYS:
            return p["date"]
    return today.isoformat()


def collect_combo(mode, input_, region, tier, map_ids, delay):
    maps = {}
    for map_id in map_ids:
        rows = parse_rows(fetch_stats(params_for(mode, input_, region, tier, map_id)))
        maps[map_id] = {
            r["id"]: [num(r["cells"].get("winrate")), num(r["cells"].get("pickrate")), num(r["cells"].get("banrate"))]
            for r in rows
        }
        time.sleep(delay)
    return maps


def mean_wr_gap(a, b):
    common = [h for h in a if h in b and a[h][0] is not None and b[h][0] is not None]
    return sum(abs(a[h][0] - b[h][0]) for h in common) / len(common) if common else 0.0


def drop_duplicates(results):
    """Écarte les combinaisons dont les chiffres sont identiques à ceux d'une autre."""
    groups = defaultdict(list)
    for name, (_, maps) in results.items():
        overview = maps.get("all-maps", {})
        if any(v[0] is not None for v in overview.values()):
            groups[json.dumps(overview, sort_keys=True)].append(name)
    for names in groups.values():
        if len(names) > 1:
            error(f"chiffres identiques, écartés : {', '.join(names)}")
            for name in names:
                del results[name]


def write_results(results, today, patches):
    """Écrit les combinaisons validées en détectant les remises à zéro, mode par mode."""
    olds, gaps = {}, {}
    for name, (mode, maps) in results.items():
        path = OUT_DIR / f"{name}.json"
        if path.exists():
            olds[name] = json.loads(path.read_text(encoding="utf-8"))
            gaps[name] = mean_wr_gap(olds[name]["maps"].get("all-maps", {}), maps.get("all-maps", {}))

    resets = set()
    for mode in {mode for mode, _ in results.values()}:
        names = [n for n, (m, _) in results.items() if m == mode and n in gaps]
        jumped = [n for n in names if gaps[n] >= RESET_JUMP]
        if names and len(jumped) / len(names) >= RESET_MIN_SHARE:
            resets.update(jumped)
            print(f"remise à zéro détectée ({mode}) : {len(jumped)}/{len(names)} combinaisons")

    for name, (mode, maps) in results.items():
        old = olds.get(name)
        window_start = old.get("window_start") if old else None
        young = window_start and (today - date.fromisoformat(window_start)).days < RESET_MIN_DAYS
        path = OUT_DIR / f"{name}.json"
        if name in resets and not young:
            PREV_DIR.mkdir(exist_ok=True)
            path.replace(PREV_DIR / path.name)
            window_start = reset_start(patches, today)
        payload = {"window_start": window_start, "collected_at": today.isoformat(), "maps": maps}
        path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--modes", nargs="+", default=list(MODES), choices=list(MODES))
    parser.add_argument("--inputs", nargs="+", default=INPUTS, choices=INPUTS)
    parser.add_argument("--regions", nargs="+", default=REGIONS, choices=REGIONS)
    parser.add_argument("--tiers", nargs="+", default=TIERS, choices=TIERS)
    parser.add_argument("--maps", nargs="+", help="limiter à certaines maps (ids)")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--delay", type=float, default=1.0, help="pause entre requêtes d'un worker (s)")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Page de référence : liste des maps et fiche de chaque héros.
    try:
        page = fetch(params_for("competitive", "PC", "Europe", "All", "all-maps"))
    except Exception as exc:
        error(exc)
        sys.exit(1)
    maps = parse_maps(page)
    heroes = {
        r["id"]: {k: r["hero"].get(k) for k in ("name", "role", "subrole", "portrait", "color")}
        for r in parse_rows(page)
    }
    patches = update_patches(heroes)
    today = datetime.now(timezone.utc).date()
    map_ids = ["all-maps"] + [m["id"] for m in maps if not args.maps or m["id"] in args.maps]

    # La partie rapide n'a pas de rang : seul "All" a du sens.
    combos = [
        (mode, input_, region, tier)
        for mode in args.modes
        for input_ in args.inputs
        for region in args.regions
        for tier in (args.tiers if mode == "competitive" else ["All"])
    ]
    print(f"{len(combos)} combinaisons × {len(map_ids)} maps = {len(combos) * len(map_ids)} requêtes")

    results = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {f"{m}_{i}_{r}_{t}".lower(): (m, pool.submit(collect_combo, m, i, r, t, map_ids, args.delay))
                   for m, i, r, t in combos}
        for n, (name, (mode, future)) in enumerate(futures.items(), 1):
            try:
                results[name] = (mode, future.result())
                print(f"[{n}/{len(combos)}] {name}")
            except Exception as exc:
                error(f"[{n}/{len(combos)}] {name} : {exc}")

    drop_duplicates(results)
    write_results(results, today, patches)
    failures = len(combos) - len(results)

    meta = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": BASE_URL,
        "heroes": heroes,
        "maps": [m for m in maps if m["id"] in map_ids],
        "filters": {
            "modes": args.modes,
            "inputs": args.inputs,
            "regions": args.regions,
            "tiers": args.tiers,
        },
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    if failures:
        sys.exit(f"{failures} combinaison(s) en échec")


if __name__ == "__main__":
    main()
