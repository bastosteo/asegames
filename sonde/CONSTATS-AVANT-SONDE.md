# Ce qu'on sait déjà, avant la sonde (10/10/2026)

Sources lues : code source on-chain d'AuraSwap (ase1v0myp2de3dhj3crvkhxqlnjaw2mvp64a9efkpl, 20 104 caractères,
lu via eth_getCode sur https://explorer.asentum.com/rpc), paquets npm @asentum/connect 0.1.9 et @asentum/sdk 0.1.0,
RPC /chain et /metadata, doc officielle.

| Question | Doc | Réalité observée | Statut |
|---|---|---|---|
| Format d'un contrat | `export default class` (tuto) / fonctions + globales (guide) | AuraSwap : fonctions utilitaires puis le fichier finit par `({ méthode() {…}, … })` | Tranché par AuraSwap, la sonde confirme |
| Globales | `storage`, `msg`, `emit`, `E` | `storage.get/set`, `msg.sender`, `msg.value`, `msg.contractAddress`, `chain.blockTimestamp`, `emit`, `assert`, `transfer(to, montant)`, `E(…)` | Tranché |
| Format de `msg.sender` | non précisé | hexa `0x…` (20 octets). @asentum/connect convertit les `ase1…` en `0x` minuscule avant l'appel car « les contrats comparent avec msg.sender en hexa » | Tranché, la sonde vérifie la casse |
| Envoi d'ASE natif | non documenté | `transfer(adresse0x, montantWeiEnTexte)` | La sonde vérifie (et le cas ase1) |
| Horloge | « pas d'horloge » (tuto) / `msg.block.timestamp` (guide) / `chain.timestamp` (cron) | `chain.blockTimestamp` (AuraSwap). Les en-têtes de blocs donnent le temps en **millisecondes** | La sonde vérifie l'unité et le n° de bloc |
| Hasard | aucun | aucun (`Math.random`, `Date.now` retirés) | Confirmé : commit-reveal obligatoire |
| Librairies (hash) | « aucune librairie approuvée » | aucun hash fourni connu | SHA-256 écrit à la main, validé NIST |
| Stockage | « toute valeur JSON » | AuraSwap stocke tout en **texte** (BigInt → `.toString()`, objets → `JSON.stringify`) | On fera pareil ; la sonde teste |
| Tâches planifiées | `cron.schedule` existe | AuraSwap utilise le cron (méthode appelée avec `msg.sender` = la chaîne) | Utile pour fermer les ventes à heure fixe |
| Chaîne | — | chainId 1423, ASE 18 décimales, baseFee 1 wei, ~448 000 blocs | Tranché |
