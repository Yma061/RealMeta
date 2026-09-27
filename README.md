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

Code : `heroRows` dans `site/app.js`.

1. **Win rate lissé** : un héros peu joué a un win rate bruité. On le rapproche d'un *prior*
   selon son pick rate : `prior + (wr − prior) × pr / (pr + 2)`. Le prior vaut 50 % sur
   « toutes maps », et le win rate global (lissé) du héros sur une map précise.
2. **Score composite** par rôle (le tank a 1 place sur 5, ses pick rates ne sont pas comparables) :
   `0,65 × z(win rate lissé) + 0,25 × z(log pick rate) + 0,10 × z(ban rate)`.
3. **Tier** selon le z-score du score dans le rôle : S ≥ 1 · A ≥ 0,35 · B ≥ −0,35 · C ≥ −1 · D.
   Les héros sous 0,5 % de pick rate sont « Peu joué ».

## Patchs

Blizzard remet ses stats à zéro à chaque patch. Le collecteur lit les
[notes de patch](https://overwatch.blizzard.com/en-us/news/patch-notes/) et tient
`site/data/overwatch/patches.json` à jour (date + héros modifiés, hors Stadium).

- Les héros modifiés sont marqués `"change"`. Remplace à la main par `"buff"`, `"nerf"` ou
  `"rework"` : la valeur est conservée aux collectes suivantes.
- Au changement de patch, la dernière collecte est archivée dans `previous/`. Le site affiche
  alors l'écart de win rate avec le patch précédent.
- Les 3 premiers jours d'un patch (7 pour un héros modifié), le lissage est renforcé et la carte
  du héros est grisée : peu de parties, tier provisoire.
