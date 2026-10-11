// =====================================================================
//  RÉGLAGES DU SITE — à remplir après le déploiement du contrat
// =====================================================================
export default {
  // Adresse du contrat du loto (ase1… ou 0x…). Vide → le site démarre en MODE DÉMO.
  // Tu peux aussi forcer la démo en ajoutant ?demo à l'adresse de la page.
  CONTRACT: 'ase16v5qw8up0x5pdzvdmavmqm8w3dg5at4gftmelf',

  // Nœuds RPC utilisés pour les lectures (le 2e sert de secours).
  RPC: ['https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'],

  EXPLORER: 'https://explorer.asentum.com',
  TELEGRAM_API: 'https://wallet.asentum.com',
  DAPP_NAME: 'ASE Loto',

  // Nombre de tirages passés affichés (résultats, classement, mes grilles)
  HISTORY_ROUNDS: 30,
};
