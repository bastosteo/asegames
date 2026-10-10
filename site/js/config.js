// =====================================================================
//  RÉGLAGES DU SITE — à remplir après le déploiement du contrat
// =====================================================================
export default {
  // Adresse du contrat du loto (ase1… ou 0x…). Vide → le site démarre en MODE DÉMO.
  // Tu peux aussi forcer la démo en ajoutant ?demo à l'adresse de la page.
  CONTRACT: 'ase15nquypra8kvqkkkaj4k2umje2d9sa0s0jyaxlm',

  // Nœuds RPC utilisés pour les lectures (le 2e sert de secours).
  RPC: ['https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'],

  EXPLORER: 'https://explorer.asentum.com',
  TELEGRAM_API: 'https://wallet.asentum.com',
  DAPP_NAME: 'ASE Loto',

  // Nombre de tirages passés affichés (résultats, classement, mes grilles)
  HISTORY_ROUNDS: 30,
};
