// =====================================================================
//  RÉGLAGES — ASE Treasure (rempli par le script de déploiement)
// =====================================================================
export default {
  // Adresse du contrat ASE Treasure. Vide → MODE DÉMO (ou ?demo dans l'adresse).
  CONTRACT: 'ase1znfss8jyag09x9c570cjn5cyxk3v6zta3z27lr',
  RPC: ['https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'],
  EXPLORER: 'https://explorer.asentum.com',
  TELEGRAM_API: 'https://wallet.asentum.com',
  DAPP_NAME: 'ASE Treasure',
  API: '../api/treasure',   // service de réponses (Cloudflare Pages Function)
  HISTORY: 10,              // grilles passées affichées
};
