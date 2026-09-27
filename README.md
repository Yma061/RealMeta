# RealMeta

Le méta multi-jeux basé sur de vraies statistiques de match, pas sur des votes.

## Jeux

| Jeu | Statut | Source |
|---|---|---|
| Overwatch | ✅ | [Statistiques officielles Blizzard](https://overwatch.blizzard.com/en-us/rates/) : win/pick/ban rate par héros × map × rang × région × plateforme |
| Valorant | à venir | Riot API (clé de production + RSO) |
| League of Legends | à venir | Riot API Match-V5 |
| CS2 | à venir | Démos de match |
| Dota 2 | à venir | OpenDota / STRATZ |

## Structure

- `collector/` : un script par jeu, qui écrit des JSON dans `site/data/<jeu>/`
- `site/` : site statique (HTML/CSS/JS, sans build)
- `site/data/` : données versionnées (collectées en local ; le workflow tente de les rafraîchir)
- `.github/workflows/deploy.yml` : collecte quotidienne + déploiement GitHub Pages

## En local

```sh
# collecte complète (~5 min) ou partielle
python collector/overwatch.py
python collector/overwatch.py --inputs PC --regions Europe --tiers All Grandmaster

# servir le site
python -m http.server -d site 8000
```

Puis ouvrir http://localhost:8000.

## Calcul des tiers

Un héros peu joué a un win rate bruité : on le ramène vers 50 % selon son pick rate
(`wr_ajusté = 50 + (wr − 50) × pr / (pr + 2)`), puis
S ≥ 52 · A ≥ 51 · B ≥ 49,5 · C ≥ 48 · D. Les héros sous 0,5 % de pick rate sont classés « Peu joué ».
