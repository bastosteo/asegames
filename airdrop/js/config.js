// =====================================================================
//  RÉGLAGES — ASE Airdrop (rempli par le script de déploiement)
// =====================================================================
export default {
  // Adresse du contrat ASE Airdrop. Vide → page « bientôt ».
  CONTRACT: '',
  RPC: ['https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'],
  EXPLORER: 'https://explorer.asentum.com',
  TELEGRAM_API: 'https://wallet.asentum.com',
  DAPP_NAME: 'ASE Airdrop',
  HISTORY_ROUNDS: 12,   // semaines passées affichées
  // Les prix sont envoyés X min après l'heure de tirage du contrat (la liste et le 1er secret
  // se font pendant ce temps) : c'est l'heure affichée aux joueurs.
  RESULT_DELAY_MIN: 60,
  // Anciens contrats des jeux (avant la mise à jour « sans remboursement ») :
  // leurs tickets comptent encore pour la semaine de la migration.
  OLD_LOTO: '', OLD_RAFFLE: '', OLD_TREASURE: '',
};
