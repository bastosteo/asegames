# Guide — déployer et interroger la sonde (testnet Asentum)

Durée : ~15 min. Coût : quelques fractions d'ASE de test.
Tout se fait dans **WSL Debian**, dans le dossier où tu as mis `sonde.js`.
Tu ne me donnes jamais de clé ni de phrase secrète : seul le **nom du compte CLI** apparaît (`--from <compte>`).

À chaque étape : copie la commande, remplace `<compte>` et `<SONDE>`, lance-la, et **colle-moi la réponse complète**.
Si une commande a une syntaxe différente sur ta CLI, regarde l'étape 0 et adapte (ou colle-moi l'erreur).

---

## Étape 0 — Confirmer la CLI (aucune action on-chain)

```bash
asentum --help
asentum deploy --help
asentum call --help
asentum view --help
```
→ Colle-moi les 4 sorties.

## Étape 1 — Déployer la sonde ⚠️ action on-chain

```bash
asentum deploy sonde.js --from <compte>
```
→ Note l'adresse du contrat (`ase1…`) : c'est `<SONDE>` dans la suite. Colle-moi toute la sortie.

## Étape 2 — Initialiser ⚠️ action on-chain

```bash
asentum call <SONDE> init --from <compte> --args '[]'
```
Si la réponse dit « déjà initialisé », c'est que la CLI l'a lancé toute seule au déploiement : c'est une information utile, continue.

```bash
asentum view <SONDE> getSnap --args '["init"]'
asentum view <SONDE> owner
```

## Étape 3 — Environnement d'une transaction avec 0,01 ASE ⚠️ action on-chain

```bash
asentum call <SONDE> inspect --from <compte> --args '[]' --value 0.01
asentum view <SONDE> getSnap --args '["tx"]'
asentum view <SONDE> inspectView
```

## Étape 4 — Types des arguments et du stockage

```bash
asentum view <SONDE> echo --args '["1", 2, [3]]'
asentum call <SONDE> storeTypes --from <compte> --args '[]'      # ⚠️ on-chain
asentum view <SONDE> readTypes
```

## Étape 5 — Envoi d'ASE natif depuis le contrat ⚠️ actions on-chain

Remplace `<MON_ASE1>` par l'adresse `ase1…` de ton compte CLI. On renvoie 0,001 ASE deux fois :
une fois avec l'adresse au format `ase1…`, une fois au format `0x…` (qu'on lit dans le résultat de l'étape 2, champ `owner`).

```bash
asentum call <SONDE> payout --from <compte> --args '["<MON_ASE1>", "1000000000000000"]'
asentum call <SONDE> payout --from <compte> --args '["<MON_0X>", "1000000000000000"]'
```
Puis regarde ton solde dans l'explorateur avant/après (ou `asentum --help` doit avoir une commande de solde).

## Étape 6 — Échecs volontaires (doivent ÉCHOUER) ⚠️ on-chain

```bash
asentum call <SONDE> payoutTooMuch --from <compte> --args '[]'
asentum call <SONDE> failAfterWrite --from <compte> --args '[]'
asentum view <SONDE> readRollback
```
On veut voir : les 2 transactions échouent, et `readRollback` ne contient **rien** d'écrit.

## Étape 7 — Hachage SHA-256 maison

```bash
asentum view <SONDE> hashSelfTest                                   # doit afficher 3 × true
asentum call <SONDE> hashBench --from <compte> --args '["10"]'      # ⚠️ on-chain
asentum call <SONDE> hashBench --from <compte> --args '["200"]'     # ⚠️ on-chain
```
→ Note le **gas utilisé** de chaque transaction (dans la sortie ou sur l'explorateur).

## Étape 8 — Limite des boucles (on cherche où ça casse) ⚠️ on-chain

```bash
asentum call <SONDE> loop --from <compte> --args '["10000"]'
asentum call <SONDE> loop --from <compte> --args '["200000"]'
asentum call <SONDE> loop --from <compte> --args '["2000000"]'
```
Arrête-toi à la première qui échoue. Note le gas de chacune.

## Étape 9 — Limite du stockage ⚠️ on-chain

```bash
asentum call <SONDE> bulkWrite --from <compte> --args '["200", "100"]'     # 200 cases de 100 caractères
asentum call <SONDE> bulkWrite --from <compte> --args '["1", "100000"]'    # 1 case de 100 Ko
asentum call <SONDE> bulkWrite --from <compte> --args '["1", "1000000"]'   # 1 case de 1 Mo
asentum view <SONDE> readBulk --args '["0"]'
```
Arrête-toi à la première qui échoue.

## Étape 10 — Événements ⚠️ on-chain

```bash
asentum call <SONDE> events --from <compte> --args '[]'
```
→ Colle-moi la sortie et, si possible, le lien de la transaction dans l'explorateur.

---

## Ensuite
Colle-moi toutes les sorties (même les erreurs : elles sont aussi instructives).
Je t'écris le résumé des résultats, puis le vrai contrat du loto.

Le contrat sonde peut rester sur le testnet sans risque : il ne contient que les petites sommes de test,
et seul ton compte peut les retirer (`payout`).
