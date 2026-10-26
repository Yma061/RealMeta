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

Code : `heroRows` dans `site/app.js`. Deux axes séparés, calculés **au sein de chaque rôle**
(le tank a 1 place sur 5, ses pick rates ne sont pas comparables aux autres rôles).

1. **Pick rate effectif** : un héros banni dans X % des parties ne peut pas y être joué,
   donc `pr_eff = pr / (1 − ban rate)`.
2. **Force = win rate lissé** : un héros peu joué a un win rate bruité, on le rapproche d'un
   *prior* : `prior + (wr − prior) × pr_eff / (pr_eff + 2)`. Le prior vaut 50 % sur
   « toutes maps », et le win rate global (lissé) du héros sur une map précise.
3. **Tier = force seule**, hybride relatif + absolu (évite des S « obligatoires » sur un méta plat) :

   | Tier | z-score de la force dans le rôle | et win rate lissé |
   |---|---|---|
   | S | ≥ 1 | ≥ 51 % |
   | A | ≥ 0,35 | ≥ 50,3 % |
   | C | ≤ −0,35 | ≤ 49,7 % |
   | D | ≤ −1 | ≤ 49 % |
   | B | le reste | |

   Les héros sous 0,5 % de pick rate sont « Peu joué ».
4. **Popularité = log du pick rate effectif**, affichée à part : badge « très joué » / « niche »
   (|z| ≥ 1) et graphique force × popularité en 4 zones (méta, pépites, surcotés, à éviter).

## Patchs et remises à zéro

Blizzard cumule ses stats depuis sa dernière remise à zéro. D'après l'historique de nos
collectes, **seuls les gros patchs remettent à zéro** (ex. 6 octobre 2026, 20+ héros modifiés) ;
les patchs hebdomadaires ne le font pas. Blizzard ne rafraîchit d'ailleurs ses chiffres que
tous les 1 à 3 jours.

- Le collecteur détecte la remise à zéro **dans les données** : l'écart moyen de win rate avec
  la collecte précédente dépasse 1 point pour la majorité des combinaisons d'un mode. La
  collecte précédente est alors archivée dans `previous/` (colonne « Δ vs période préc. »).
- Chaque fichier indique `window_start` (début de la période cumulée) et `collected_at`.
- `patches.json` (lu sur les [notes de patch](https://overwatch.blizzard.com/en-us/news/patch-notes/))
  sert aux badges : héros marqués `"change"`, à remplacer à la main par `"buff"`, `"nerf"` ou
  `"rework"` (valeur conservée aux collectes suivantes).
- Un héros modifié **en cours de période** a des stats qui mélangent avant et après la
  modification : sa carte est grisée tant que moins de la moitié de la période est postérieure.
- Les 3 premiers jours après une remise à zéro (7 pour un héros modifié à ce moment-là), le
  lissage est renforcé : peu de parties, tier provisoire.

## Fiabilité de la source

Blizzard renvoie parfois les stats d'une autre combinaison que celle demandée (constaté sur
12 jours de collecte sur 33 avant correction). Le collecteur vérifie que chaque page affiche
bien les filtres demandés, puis écarte toute combinaison dont les chiffres sont identiques à
ceux d'une autre ; ses données précédentes sont alors conservées.
