// =====================================================================
//  RÉGLAGES — ASE Treasure (rempli par le script de déploiement)
// =====================================================================
export default {
  // Adresse du contrat ASE Treasure. Vide → MODE DÉMO (ou ?demo dans l'adresse).
  CONTRACT: 'ase1syq98uqqphcjhggep78a54hpetkw9mtkxf4zw3',
  RPC: ['https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'],
  EXPLORER: 'https://explorer.asentum.com',
  TELEGRAM_API: 'https://wallet.asentum.com',
  DAPP_NAME: 'ASE Treasure',
  API: '../api/treasure',   // service de réponses (Cloudflare Pages Function)
  HISTORY: 10,              // grilles passées affichées
};
