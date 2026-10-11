# Loto ASE — guide de déploiement (testnet, PC Windows + WSL Debian)

Ce guide se suit dans l'ordre. Les étapes marquées ⚠️ envoient une transaction sur la chaîne :
lis la commande avant de la lancer. Personne ne te demandera jamais ta clé privée ni ta phrase secrète.

Rappels mesurés sur la chaîne (voir `sonde/RESULTATS-SONDE.md`) :
- une transaction met 10 à 60 s à passer ; attends sa confirmation avant d'en lancer une autre
  (sinon : « duplicate nonce », sans gravité, il suffit de relancer) ;
- le contrat ne comprend que les adresses `0x…` : le site, le croupier et le contrat convertissent
  les `ase1…` tout seuls.

---

## 0. Installer les fichiers dans WSL

Place `loto-ase.zip` dans `Téléchargements\Loto ASE`, puis dans WSL :

```bash
cd ~ && unzip -o "/mnt/c/Users/basts/Downloads/Loto ASE/loto-ase.zip" && cd ~/loto-ase && ls
```

Vérifie que tout fonctionne chez toi (rien n'est envoyé sur la chaîne) :

```bash
node contrat/loto.test.mjs          # doit finir par "177 réussis, 0 échoués"
node contrat/simulation.mjs 100     # 100 tirages simulés, conservation de l'argent vérifiée
node croupier/e2e.test.mjs          # croupier sur une fausse chaîne : "22 réussis, 0 échoués"
```

## 1. Le compte du croupier

Le croupier signe ses transactions avec un compte CLI **dédié**, qui n'a besoin d'aucun droit :
il ne lui faut que quelques ASE pour le gas.

```bash
asentum account new croupier
asentum faucet --to croupier --amount 5           # ⚠️ (ou : asentum send --from main --to croupier --amount 5)
asentum balance croupier
```

## 2. Les deux chaînes de secrets

**Toi (owner)** :

```bash
cd ~/loto-ase/croupier
cp .env.exemple .env
nano .env        # ROLE=owner, ACCOUNT=croupier ; CONTRACT reste vide pour l'instant
node croupier.mjs chain-new
```

La commande affiche le **bout de ta chaîne** (64 caractères). Note-le. Le fichier `data/owner-chain.json`
est ton secret : **sauvegarde-le** (clé USB) et ne le donne à personne.

**Le collaborateur** fait exactement la même chose sur SA machine, avec `ROLE=collab`, et t'envoie
uniquement le bout de SA chaîne (le bout se partage sans risque : il ne permet pas de deviner les secrets).

> Pour un premier essai seul sur ton PC, tu peux créer la chaîne "collab" toi-même dans un autre dossier
> (`DATA_DIR=./data-collab ROLE=collab node croupier.mjs chain-new`). Le loto marche, mais tu détiens
> alors les deux secrets : avant d'ouvrir à de vrais joueurs, le collaborateur crée sa propre chaîne
> et l'enregistre avec `setTipCollab` (depuis le compte COLLAB_ADMIN), entre deux tirages ;
> puis `setCollabAdmin` pour lui transmettre ce droit.

## 3. Déployer le contrat ⚠️

**Quel fichier ?** `contrat/loto.deploy.js` : c'est `contrat/loto.js` compacté (sans commentaires, noms
internes raccourcis), testé avec les mêmes tests. Pourquoi : la CLI fixe la limite de gas d'un
déploiement à **1 000 × la taille du fichier**, et un déploiement au-dessus d'environ 13 M de gas reste
bloqué dans la file d'attente (mesuré le 10/10/2026). Pour le régénérer après une modification :
`node outils/compacter-contrat.mjs <chemin vers esbuild>`.

**Adresses en 0x** : le contrat n'accepte que des adresses `0x…`. Pour convertir une adresse `ase1…` :

```bash
node -e "import('./site/js/lotomath.js').then(L=>console.log(L.toHex('ase1...')))"
```

Il te faut : `PAY_OWNER` (80 %), `PAY_COLLAB` (20 %), `COLLAB_ADMIN` (wallet qui pourra renouveler
la chaîne du collaborateur), `BOUT_OWNER`, `BOUT_COLLAB`. Le compte qui déploie devient **l'admin**.

On déploie SANS `--init-args`, puis on appelle `init` une fois le déploiement confirmé (sinon la CLI
envoie `init` trop tôt et il est refusé avec « duplicate nonce ») :

```bash
cd ~/loto-ase
asentum deploy contrat/loto.deploy.js --from main
# attendre que le déploiement soit inclus (voir l'explorateur, ou : asentum view <adresse> getConfig
# doit répondre "null" et plus "target is not a contract")
asentum call <ADRESSE_DU_CONTRAT> init --from main --args '["PAY_OWNER","PAY_COLLAB","COLLAB_ADMIN","BOUT_OWNER","BOUT_COLLAB"]'
```

Vérifie (lectures gratuites) :

```bash
C=ase1...      # adresse du contrat
asentum view $C getConfig
asentum view $C info
```

## 4. Lancer le croupier (redémarrage automatique)

Mets l'adresse du contrat dans `croupier/.env` (`CONTRACT=ase1…`), puis teste-le à la main :

```bash
cd ~/loto-ase/croupier
node croupier.mjs status      # doit afficher "maChaine: OK, 3650 secrets restants"
node croupier.mjs test-alert  # si Telegram est configuré
```

Puis installe-le comme service (il se relance tout seul et démarre avec WSL) :

```bash
sudo cp ~/loto-ase/croupier/wsl/loto-croupier.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now loto-croupier
journalctl -u loto-croupier -f          # journal en direct (Ctrl+C pour quitter)
```

Commandes utiles : `sudo systemctl restart loto-croupier`, `sudo systemctl stop loto-croupier`.

**Alertes Telegram** : crée un bot avec @BotFather (il te donne un *token*), envoie-lui un message,
puis ouvre `https://api.telegram.org/bot<TOKEN>/getUpdates` pour lire ton `chat id`.
Mets les deux dans `.env` et redémarre le service.
Tu reçois : démarrage, résultat de chaque tirage, retard d'un secret (15 min après la fermeture),
annulation, erreurs répétées, chaîne bientôt épuisée.
Si le PC est éteint à 21h, personne ne révèle : au bout de 2 h le tirage est annulé et les joueurs
remboursés (sans perte pour eux). Pour un fonctionnement 24 h/24, on passera le croupier sur Fly.io.

## 3 bis. Passer au contrat v2 (5 numéros sur 20, gains fixes + bonus)

Règles du contrat v2 : grille de 5 numéros sur 20 à 2 ASE (4 bons = 50 ASE, 3 bons = 5 ASE) ; commission 20 % (75 % owner, 25 %
collaborateur) ; jackpot 35 % des mises + report ; caisse des gains fixes 45 % (4 bons = 25 mises,
3 bons = 2,5 mises, réduits ensemble si la caisse ne suffit pas) ; sans gagnant à 5 bons, la moitié
des 35 % du tirage est versée en bonus aux 4 et 3 bons ; un 4 bons touche au plus 80 % d'un 5 bons ;
plafond de 3 000 grilles par tirage ; gains envoyés automatiquement (événement « Paid » avec le
nombre de bons numéros, message « Tu as gagné… » sur le site).

Double-clique sur `Deployer-nouveau-loto.bat` (après avoir mis le nouveau zip dans tes Téléchargements).
Le script lit l'ancien contrat, puis te demande (o/n) avant chacune des 3 transactions ⚠️ :
1. `setPaused(true)` sur l'ancien contrat (plus d'achats dessus) ;
2. le déploiement de `contrat/loto.deploy.js` ;
3. `init` du nouveau contrat, avec les mêmes chaînes de secrets, le même wallet owner et le wallet
   du collaborateur `ase1ludcdjwrnfdfl6wujdahvkrsxst6vtve7qs3kw`.

Ensuite il met à jour le site, les croupiers du PC et GitHub, puis remet le site en ligne.
Il peut être relancé sans risque : il ne redéploie jamais un contrat déjà en place.
L'ancien contrat garde son jackpot de test (aucune fonction de retrait, par sécurité).

## 3 ter. ASE Raffle (tombola hebdomadaire)

Règles : ticket à 5 ASE, 10 maximum par wallet ; tirage chaque dimanche à 21h (Paris), ventes
fermées 10 min avant ; commission 20 % (75 % owner, 25 % collaborateur) ; cagnotte = 80 % des
ventes, partagée 50 / 30 / 20 % entre 3 wallets différents ; moins de 3 participants → tombola
prolongée d'une semaine ; prix à réclamer (bouton Claim) sans limite de temps ; secrets non
révélés en 2 h → annulation et remboursement.

Installation : double-clique sur `Deployer-tombola.bat` (nouveau zip dans les Téléchargements).
Il crée deux nouvelles chaînes de secrets propres à la tombola (`croupier/data-tombola` et
`croupier/data-tombola-collab`, **à sauvegarder**), puis te demande (o/n) avant les 2 transactions ⚠️
(déploiement et `init`), range les secrets dans GitHub (`RAFFLE_OWNER_CHAIN_SEED`,
`RAFFLE_COLLAB_CHAIN_SEED`, variable `RAFFLE_CONTRACT`) et met le site en ligne. Les croupiers
GitHub gèrent ensuite le loto et la tombola dans le même passage.

## 3 quater. ASE Airdrop + commission 15 % (loto v3, tombola v2)

Nouvelles règles : commission **15 %** sur le loto et la tombola. La moitié (7,5 % des ventes) va à
l'équipe (75 % owner, 25 % collaborateur), l'autre moitié est envoyée au contrat **ASE Airdrop**
après chaque tirage réussi. Loto : jackpot 35 % des ventes, caisse des gains fixes 50 % (4 bons =
25 mises = 50 ASE, 3 bons = 2,5 mises = 5 ASE, + bonus). Tombola : cagnotte 85 %.

ASE Airdrop (`/airdrop`) : chaque lundi à 21h (Paris), lendemain de la grosse tombola, la cagnotte de la semaine est tirée au sort
entre les joueurs : 1 grille de loto ou 1 ticket de tombola = 1 chance, pour les tickets joués de la tombola
d'un dimanche à la tombola du dimanche suivant (lotos du lundi au dimanche + tombola du dimanche) ;
le site affiche des montants estimés (*) qui comptent déjà les tirages pas encore faits ;
3 wallets différents gagnent 50 / 30 / 20 % ; prix envoyés directement ; moins de 3 joueurs → la part
non attribuée est reportée. Le croupier owner GitHub (« opérateur ») calcule la liste des joueurs à
partir des deux jeux et l'enregistre dans le contrat, puis les deux secrets sont révélés (chaînes
propres à l'Airdrop). Le site recalcule la liste (bouton Verify). Tirage non fait en 6 h → annulé, la
semaine est reprise au tirage suivant.

Installation : double-clique sur `Deployer-ASE-Airdrop.bat` (nouveau zip dans les Téléchargements).
Chaque transaction est demandée (o/n) avant d'être envoyée ⚠️ :
1. anciens loto et tombola : pause, annulation + remboursement du tirage en cours s'il a des
   joueurs, envoi aux gagnants des gains pas encore réclamés (si un tirage est en train d'être fait,
   le script s'arrête et demande de relancer 30 min plus tard) ;
2. chaînes de secrets de l'Airdrop (`croupier/data-airdrop` et `croupier/data-airdrop-collab`,
   **à sauvegarder**) ; déploiement + `init` de l'Airdrop ;
3. déploiement + `init` du loto v3 et de la tombola v2 (mêmes wallets, mêmes chaînes de secrets) ;
4. site, GitHub (variables `CONTRACT`, `RAFFLE_CONTRACT`, `AIRDROP_CONTRACT`, secrets
   `AIRDROP_OWNER_CHAIN_SEED`, `AIRDROP_COLLAB_CHAIN_SEED`), croupiers du PC, mise en ligne.

Les anciens contrats gardent le jackpot de test du loto (aucune fonction de retrait, par sécurité).
Le script peut être relancé sans risque (fichiers `.migre-*`, `.airdrop-fait`, `.loto-v3-fait`,
`.tombola-v2-fait` gardés sur le PC).

## 3 quinquies. ASE Treasure (chasse au trésor)

Règles : carte de 20 × 20 (400 cases), un trésor caché ; 0,5 ASE la fouille, 5 fouilles par wallet
et par carte, une case ne se fouille qu'une fois ; réponse 🔥 chaud (trésor à 3 cases ou moins,
diagonales comprises) ou ❄️ froid ; le trésor = 85 % des fouilles jusqu'à celle du trésor ; 15 % de
commission (moitié équipe 75/25, moitié Airdrop) ; 1 fouille = 1 chance à l'Airdrop ; environ 13
fouilles en moyenne avant de trouver, soit un trésor de ~5 ASE.

Fonctionnement : une graine secrète (`croupier/data-tresor/seed.txt`, **à sauvegarder**, aussi rangée
dans GitHub `TREASURE_SEED` et dans Cloudflare) fixe chaque carte. Le croupier GitHub publie l'empreinte
(racine de Merkle) des 400 réponses avant la 1re fouille. Le service `/api/treasure` (Cloudflare Pages
Function, dossier `functions/`) donne la réponse et sa preuve dès qu'une fouille est confirmée, et
seulement pour une case fouillée. Le gagnant réclame le trésor depuis le site (sinon le croupier le
fait au passage suivant) ; les fouilles faites juste après sont remboursées ; carte suivante au
passage suivant (10 min au plus). Carte non trouvée en 30 jours → annulée et remboursée.

Installation : double-clique sur `Deployer-ASE-Treasure.bat` (après l'Airdrop). 2 transactions
demandées (o/n) ⚠️ : déploiement et `init`. Il range la graine dans GitHub et Cloudflare, puis met le
site en ligne.

## 4 bis. Les croupiers sur GitHub (gratuit, PC éteint possible)

GitHub lance les deux croupiers toutes les 10 minutes sur ses propres serveurs (gratuit pour un dépôt
public). Chaque passage : owner (fermeture, secret owner), collaborateur (secret collab), puis owner
(comptage, tirage, paiements). Le fichier `.github/workflows/croupier.yml` décrit ce travail.

Installation : place le nouveau `loto-ase.zip` dans tes Téléchargements, puis double-clique sur
`Installer-croupiers-GitHub.bat`. Le script :
1. installe `git` et `gh` si besoin (mot de passe Linux demandé) ;
2. vérifie que les chaînes du PC correspondent au contrat ;
3. te connecte à GitHub : un code s'affiche, ouvre https://github.com/login/device, tape-le, *Authorize* ;
4. crée deux comptes signataires (ils ne paient que les frais, aucun droit sur le contrat) ;
5. ⚠️ te demande (o/n) avant d'envoyer 2 ASE depuis `main` vers chacun ;
6. crée le dépôt public `asegames` et y envoie le code (jamais les chaînes, graines ni `.env` :
   le script vérifie et s'arrête sinon) ;
7. range les graines et les débuts de chaîne dans les **secrets** du dépôt (illisibles, même par toi) ;
8. lance un premier passage.

Suivi : `https://github.com/<ton-pseudo>/asegames/actions` (une ligne verte par passage). Un passage
en rouge = GitHub t'envoie un e-mail ; tu reçois aussi les alertes Telegram si elles sont configurées.

À savoir :
- GitHub peut retarder un passage de quelques minutes : sans conséquence (le délai de révélation est de 2 h).
- GitHub met en pause les tâches planifiées d'un dépôt public sans activité pendant 60 jours :
  si cela arrive (e-mail de GitHub), clique sur *Enable workflow* dans l'onglet Actions.
- Les croupiers du PC peuvent continuer en secours : s'ils agissent en même temps, l'un des deux est
  simplement refusé, sans perte.
- Sauvegarde `croupier/data/gh-signers.json` avec tes chaînes.
- Quand le vrai collaborateur aura sa chaîne, il faudra mettre à jour le secret `COLLAB_CHAIN_SEED`
  (ou faire tourner son croupier chez lui et retirer l'étape « collaborateur » du workflow).

## 5. Le site

Mets l'adresse du contrat dans `site/js/config.js` (`CONTRACT: 'ase1…'`), puis :

```bash
cd ~/loto-ase/site && python3 -m http.server 8080
```

Ouvre **http://localhost:8080** dans ton navigateur Windows (celui où est installée l'extension
Asentum Wallet). `http://localhost:8080/?demo` force le mode démo.

### Mise en ligne : ASE Vegas sur Cloudflare Pages

Le site complet est organisé ainsi : `asevegas.pages.dev/` (accueil, liste des jeux), `/loto/` (ASE Loto),
`/slot/` (ASE Slot, bientôt). Pour ajouter un jeu plus tard, on ajoute un dossier.

1. Assemble le dossier à mettre en ligne :
   ```bash
   cd ~/loto-ase && ./outils/assembler-asegame.sh
   ```
   Il crée `~/loto-ase/asegame` (visible dans Windows : `\\wsl$\Debian\home\bastos\loto-ase\asegame`).
2. Sur **dash.cloudflare.com** (compte gratuit) : **Workers & Pages → Créer → Pages → Importer des fichiers
   (Upload assets)**. Nom du projet : `asegame` (l'adresse sera `asevegas.pages.dev`).
3. Glisse le **contenu** du dossier `asegame` (ou le dossier lui-même), puis **Déployer**.
4. Pour une mise à jour : relance le script, puis dans le projet **Créer un nouveau déploiement** et
   glisse à nouveau le dossier.

Le site en ligne ne dépend plus de ton PC. Seuls les croupiers doivent tourner (PC allumé à l'heure du
tirage, ou Fly.io plus tard).

---

## Checklist après déploiement

Lectures (gratuites) :
- [ ] `asentum view $C getConfig` : `admin` = ton compte de déploiement (en 0x), `payOwner` / `payCollab` corrects, `price` = 5000000000000000000, `drawH` 21, `closeMin` 10, `maxRound` 3000.
- [ ] `asentum view $C info` : `drawTs` correspond à ce soir 21h00 (heure de Paris).
- [ ] `node croupier.mjs status` (owner) : chaîne OK. Idem côté collaborateur.
- [ ] Site : jackpot, compte à rebours et « Tirage n°1 » s'affichent ; l'onglet Admin n'apparaît qu'avec le wallet admin.

Premier achat :
- [ ] Achète 2 grilles avec le compte `test` depuis le site : elles apparaissent dans « Mes grilles ».
- [ ] Une grille invalide est impossible depuis le site ; via la CLI elle est refusée par le contrat.

Premier tirage (après 20h50) :
- [ ] Journal du croupier : `poke`, `reveal` (owner puis collab), `tally`, `settle` confirmés.
- [ ] Message Telegram « Tirage n°1 : … ».
- [ ] Site → Résultats → « Vérifier » : toutes les lignes en ✓.
- [ ] Les wallets owner et collaborateur ont reçu 15 % et 5 % des ventes (75/25 de 20 %).
- [ ] Les gagnants ont été payés (« Payé » dans Mes grilles) ; `getState` → `owed` revient à 0.
- [ ] `getState` → `jackpot` = report affiché dans Résultats.

Sécurité :
- [ ] Un compte non admin qui appelle `setConfig` est refusé.
- [ ] La pause depuis le site bloque les achats ; la reprise les rouvre.
- [ ] `data/owner-chain.json` est sauvegardé hors du PC.
