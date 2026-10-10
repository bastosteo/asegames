# Résultats de la sonde — testnet Asentum (10/10/2026)

Contrat sonde : `ase19nmsl8v3mm38kymrmhzu8x22aj8h7xkl57vjj8` (0x2cf70f9d91dee27b1363ddc5c3994aec8f7f1adf), déployé avec le compte CLI `test`.
Toutes les valeurs ci-dessous viennent des reçus réels (RPC https://explorer.asentum.com/rpc).

## Format et environnement
- **Format de contrat** : fonctions utilitaires, puis le fichier se termine par `({ méthode() {…} })` (comme AuraSwap). Pas de `export default class`.
- **CLI** : `asentum deploy <f.js> --from <compte> [--init-args '<json>']` (sans `--init-args`, `init` n'est PAS appelé) ; `asentum call <c> <m> --from <compte> --args '<json>' --value <ase>` ; `asentum view <c> <m> --args '<json>'`. Pas de `--network`, pas de `asentum test`.
- **Globales** : `storage` (get/set/has/delete), `msg` = {sender, value, contractAddress}, `chain` = {blockNumber, blockTimestamp, chainId}, `emit`, `assert`, `transfer`, `E`. Aucun `cron`, aucun hash (`sha256`, `blake3`… absents), pas de `TextEncoder`. `Uint8Array`, `Uint32Array`, `Math.imul` disponibles.
- **msg.sender** : texte `0x…` en minuscules. **msg.value** : BigInt en wei (0,01 ASE = 10 000 000 000 000 000).
- **chain.blockNumber** : BigInt. **chain.blockTimestamp** : BigInt en **millisecondes**.
- **Hasard / horloge système** : `Math.random()` et `Date.now()` lèvent une erreur (« secure mode »).
- **Arguments** : gardent leur type JSON (`"1"` texte, `2` nombre, `[3]` tableau).

## Stockage
- Tout est converti en texte : `42n` → `"42"`, `{a:1}` → `"[object Object]"` (perdu !). Clé absente → `undefined`.
  → Toujours stocker `JSON.stringify(...)` ou `.toString()`.

## ASE natif
- `transfer(adresse0x, montantWeiTexte)` fonctionne (renvoie `undefined`, émet automatiquement un événement `Transfer`).
- Une adresse `ase1…` est refusée (« invalid address ») → toujours convertir en `0x…` minuscules.
- Un envoi supérieur au solde n'échoue pas tout de suite : le contrôle est fait **à la fin** (« would end with a negative balance ») et toute la transaction est annulée.

## Annulation (atomicité)
- Exception → toutes les écritures annulées (vérifié). Une exception consomme **tout le gas de la transaction (1 000 000)**.

## Gas (limite par transaction envoyée par la CLI : 1 000 000)
| Opération | Gas |
|---|---|
| Base d'une transaction | 21 000 |
| Lecture d'une clé (view) | ~800 |
| Écriture d'une **nouvelle** clé | ~20 000 (50 nouvelles clés = dépassement de la limite) |
| Réécriture d'une clé existante | ~2 900, **quelle que soit la taille** (100 Ko = 26 800 gas au total) |
| `transfer` + événement | ~8 000–11 000 |
| Calcul (boucles, SHA-256) | **non facturé** : 100 000 SHA-256 = 23 900 gas, ~1,3 s |
| Déploiement de 12,9 Ko | 2 615 000 |

→ Le coût est dans le **nombre de nouvelles clés**, pas dans la taille ni dans le calcul.

## Réseau
- ~8 s par bloc (pas 2 s). Une transaction met de 10 s à ~60 s à être incluse (réseau chargé).
- La CLI numérote les transactions à partir de la dernière **confirmée** : deux appels trop rapprochés → « duplicate nonce ». Attendre la confirmation entre deux envois.

## Événements
- Visibles dans le reçu (`events: [{name, data}]`) et via `eth_getLogs` (topic 0 = empreinte du nom, `data` = JSON en hexa).

## SHA-256 maison
- Validé on-chain (vecteurs NIST vide, "abc", 448 bits) et en local (1 million de "a", 60 entrées aléatoires comparées à node:crypto).

## Déploiement (constaté le 10/10/2026 au déploiement du loto)
- La CLI fixe la **limite de gas d'un déploiement à 1 000 × la taille du fichier** (sonde : 12 981 octets → 12 915 000).
- Un fichier de 32 Ko (limite 32 M > limite d'un bloc de 30 M) n'est jamais inclus ; 19,6 Ko est resté bloqué aussi.
  12,9 Ko est passé. On déploie donc une version compactée de moins de 12,9 Ko (`contrat/loto.deploy.js`).
- Une transaction bloquée empêche toutes les suivantes du même compte (ordre des nonces) jusqu'à ce que la file d'attente l'abandonne (constaté : environ 15 min).
- `asentum deploy … --init-args` envoie `init` sans attendre le reçu du déploiement → « duplicate nonce ». Déployer, attendre, puis `asentum call … init`.
