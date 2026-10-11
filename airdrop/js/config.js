// =====================================================================
//  RÉGLAGES — ASE Airdrop (rempli par le script de déploiement)
// =====================================================================
export default {
  // Adresse du contrat ASE Airdrop. Vide → page « bientôt ».
  CONTRACT: 'ase16ppkfcln47tl5a67kk0axm0ucq9gy5czqjh3fe',
  RPC: ['https://testnet.asentum.com', 'https://explorer.asentum.com/rpc'],
  EXPLORER: 'https://explorer.asentum.com',
  TELEGRAM_API: 'https://wallet.asentum.com',
  DAPP_NAME: 'ASE Airdrop',
  HISTORY_ROUNDS: 12,   // semaines passées affichées
  // Anciens contrats des jeux (avant la mise à jour « sans remboursement ») :
  // leurs tickets comptent encore pour la semaine de la migration.
  OLD_LOTO: 'ase1j6ayfwyqdqjuc57mcjcnznshhl036eny5nktjg', OLD_RAFFLE: 'ase1tqlmck8z5yru4kh2yf7z89gvg9dqrhrwqfd5k4', OLD_TREASURE: 'ase1m3f8nj428glnsg9k5w5clrjts80uks0p6xyxqn',
};
