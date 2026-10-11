# ASE Vegas : ASE Loto, ASE Raffle, ASE Airdrop et ASE Treasure

Loto à numéros sur le testnet Asentum : 5 numéros sur 20, une grille = 2 ASE, un tirage par jour à 21h
(heure de Paris), jackpot partagé + gains fixes (4 et 3 bons) avec bonus, 85 % redistribués, commission
15 % (moitié équipe 75/25, moitié ASE Airdrop), gains à réclamer, hasard par double chaîne de secrets
owner + collaborateur. ASE Airdrop : tirage hebdomadaire des frais, 1 ticket = 1 chance.

| Dossier | Contenu |
|---|---|
| `contrat/loto.js` | Le contrat, lisible et commenté (source de référence) |
| `contrat/loto.deploy.js` | Le même contrat compacté : **c'est lui qu'on déploie** (limite de taille) |
| `outils/compacter-contrat.mjs` | Regénère `loto.deploy.js` à partir de `loto.js` |
| `contrat/loto.test.mjs` | 178 tests automatiques |
| `contrat/simulation.mjs` | Simulation de nombreux tirages (conservation de l'argent au wei près) |
| `contrat/ref.mjs` | Implémentation de référence indépendante (tests, vérification) |
| `croupier/croupier.mjs` | Le croupier (révélations, comptage, paiements, alertes Telegram) |
| `croupier/e2e.test.mjs` | Test du croupier sur une fausse chaîne locale (CLI et mode GitHub) |
| `croupier/wsl/` | Service systemd pour WSL |
| `.github/workflows/croupier.yml` | Les croupiers sur GitHub Actions (toutes les 10 min, gratuit) |
| `outils/installer-github.sh` + `.bat` | Installation des croupiers sur GitHub en un double-clic |
| `contrat/tombola.js` (+ `.deploy.js`, `tombola.test.mjs`) | ASE Raffle : tombola hebdomadaire (82 tests) |
| `tombola/` | Page du site ASE Raffle (servie sur `/raffle/`) |
| `croupier/e2e-tombola.test.mjs` | Croupier + tombola sur une fausse chaîne |
| `outils/deployer-tombola.sh` + `Deployer-tombola.bat` | Installation de la tombola (chaînes, contrat, GitHub, site) |
| `outils/deployer-loto-v2.sh` + `.bat` | Passage au contrat v2 (pause de l'ancien, déploiement, init, mise à jour) |
| `site/` | ASE Loto, le site du loto (statique ; `?demo` pour la démo) |
| `accueil/` | ASE Vegas : page d'accueil avec la liste des jeux, et `slot/` (bientôt) |
| `outils/assembler-asegame.sh` | Assemble `asegame/` (accueil + `loto/` + `raffle/` + `airdrop/` + `slot/`) à mettre sur Cloudflare Pages |
| `contrat/airdrop.js` (+ `.deploy.js`, `airdrop.test.mjs`) | ASE Airdrop : tirage hebdomadaire (lundi) des frais (72 tests) |
| `airdrop/` | Page du site ASE Airdrop (`/airdrop/`) ; `airdrop/js/liste.mjs` calcule la liste des joueurs (site et croupier) |
| `croupier/e2e-airdrop.test.mjs` | Croupier + Airdrop + loto + tombola sur une fausse chaîne |
| `outils/deployer-airdrop.sh` + `Deployer-ASE-Airdrop.bat` | Airdrop + loto v3 + tombola v2 (fin propre des anciens contrats) |
| `outils/migration.mjs` | Ce qu'il reste à faire sur un ancien contrat (lecture seule) |
| `contrat/tresor.js` (+ `.deploy.js`, `tresor.test.mjs`) | ASE Treasure : chasse au trésor 20 × 20 (48 tests) |
| `functions/` | Service de réponses d'ASE Treasure (Cloudflare Pages Function `/api/treasure`) et `_lib/board.mjs` (grille secrète, preuves) |
| `tresor/` | Page du site ASE Treasure (`/treasure/`, `?demo` pour la démo) |
| `croupier/e2e-tresor.test.mjs` | Croupier + service de réponses sur une fausse chaîne |
| `outils/deployer-tresor.sh` + `Deployer-ASE-Treasure.bat` | Installation d'ASE Treasure |
| `outils/deployer-v4.sh` + `Mettre-a-jour-ASE-Vegas-v4.bat` | Sans remboursement : loto v4, tombola v3, trésor v2 (fin propre des anciens contrats) |
| `sim/` | Simulateur de la machine virtuelle Asentum + faux nœud local |
| `sonde/` | Résultats de la sonde (ce qui a été vérifié sur la vraie chaîne) |
| `GUIDE.md` | Déploiement pas à pas + checklist |

Commencer par `GUIDE.md`.
