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
2. **Force = win rate lissé**.
   - **Toutes maps** : un héros peu joué a un win rate bruité, on le rapproche de 50 % :
     `50 + (wr − 50) × pr_eff / (pr_eff + 2)`.
   - **Sur une map** : `win rate global lissé + r × (wr_map − wr_global)`. `r` est la part de
     signal dans l'écart map, mesurée à chaque collecte (`map_reliability` dans `meta.json`) :
     corrélation de cet écart entre les 3 régions, par mode, plateforme et rang. Le vrai effet
     d'une map est commun aux régions, le bruit est indépendant. Mesures du 27/10/2026 :
     ~0,8 tous rangs confondus (PC), 0,4 à 0,6 d'Argent à Émeraude, ~0,3 en Diamant, ~0,1 en
     Bronze et Maître, ~0,02 en Grand maître. En dessous de 0,3, le site prévient que les
     écarts par map sont surtout du bruit.
     Une régression `Var(écart) ≈ a + b / pick rate` a été essayée d'abord : instable (K de
     1 à 750 selon la combinaison), et la fiabilité ne dépend presque pas du pick rate.
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

Blizzard a renuméroté ses modes (compétitif : `rq=2`, puis `rq=1`), en alternant entre les
deux numérotations pendant plusieurs semaines. Avec une valeur périmée, la page retombe sur
la partie rapide et ignore le rang : 12 jours de collecte sur 33 en ont été faussés. Depuis :

- la valeur de chaque mode est lue dans le menu de Blizzard (par son libellé) à chaque collecte ;
- chaque page doit afficher les filtres demandés, sinon elle est redemandée puis écartée ;
- toute combinaison dont les chiffres sont identiques à ceux d'une autre est écartée.

Une combinaison écartée garde ses données précédentes.
