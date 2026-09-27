"""Collecte les statistiques officielles de héros Overwatch publiées par Blizzard.

Source : https://overwatch.blizzard.com/en-us/rates/ — la page embarque en JSON le
win rate, pick rate et ban rate de chaque héros pour une combinaison de filtres
(mode, plateforme, région, rang, map).

Sortie (dans site/data/overwatch/) :
  meta.json                              héros, maps, filtres, date de mise à jour
  {mode}_{input}_{region}_{tier}.json    {"maps": {map_id: {hero_id: [wr, pr, br]}}}
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
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "https://overwatch.blizzard.com/en-us/rates/"
USER_AGENT = "RealMeta/0.1 (+https://github.com/Yma061/RealMeta)"
OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data" / "overwatch"

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


def fetch(params, retries=3):
    url = BASE_URL + "?" + urllib.parse.urlencode(params)
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


def parse_maps(page):
    maps = []
    for mode, body in re.findall(r'<optgroup[^>]*label="([^"]+)"(.*?)</optgroup>', page, re.S):
        for map_id, name in re.findall(r'value="([^"]+)">([^<]+)<', body):
            maps.append({"id": map_id, "name": name.strip(), "mode": mode})
    return maps


def params_for(mode, input_, region, tier, map_id):
    return {"input": input_, "map": map_id, "region": region, "role": "All",
            "rq": MODES[mode], "tier": tier}


def collect_combo(mode, input_, region, tier, map_ids, delay):
    maps = {}
    for map_id in map_ids:
        rows = parse_rows(fetch(params_for(mode, input_, region, tier, map_id)))
        maps[map_id] = {
            r["id"]: [r["cells"]["winrate"], r["cells"]["pickrate"], r["cells"].get("banrate", 0)]
            for r in rows
        }
        time.sleep(delay)
    name = f"{mode}_{input_}_{region}_{tier}".lower()
    (OUT_DIR / f"{name}.json").write_text(json.dumps({"maps": maps}, separators=(",", ":")), encoding="utf-8")
    return name


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

    failures = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(collect_combo, *c, map_ids, args.delay) for c in combos]
        for i, future in enumerate(futures, 1):
            try:
                print(f"[{i}/{len(combos)}] {future.result()}")
            except Exception as exc:
                failures += 1
                error(f"[{i}/{len(combos)}] {exc}")

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
