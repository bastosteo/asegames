// Réveil des croupiers : GitHub saute souvent les passages programmés « toutes les 10 min »
// (dépôts gratuits, heures chargées). Ce petit Worker Cloudflare (gratuit) lance lui-même le
// workflow GitHub toutes les 10 minutes. Il ne contient aucune graine : seulement un jeton
// GitHub (secret Cloudflare GH_TOKEN) qui sert à cliquer « Run workflow » à ta place.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(lancer(env));
  },
  async fetch(req, env) {   // page de contrôle : https://asevegas-reveil.<compte>.workers.dev
    return new Response('Réveil des croupiers ASE Vegas : actif (toutes les 10 minutes).\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
async function lancer(env) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/croupier.yml/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'asevegas-reveil', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref: env.BRANCH || 'main' }),
  });
  if (r.status !== 204) console.log('GitHub a répondu', r.status, await r.text());
}
