// Mini-SaaS de démonstration : vend un abonnement avec une licence Kivoo
// vendue par session de paiement (POST /v1/checkouts). Aucune dépendance.
//
//   node --env-file=.env server.mjs
//
// Voir README.md pour la configuration et le scénario de test.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createCheckout, verifyKivooSignature, toEntitlementAction, isActionSafe, accessByPlan } from '../../scripts/kivoo-core.mjs';

const PORT = Number(process.env.PORT ?? 4000);
const APP_URL = (process.env.APP_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const API_URL = (process.env.KIVOO_API_URL ?? 'https://api.kivoo.africa').replace(/\/$/, '');
const API_KEY = process.env.KIVOO_API_KEY ?? '';
const WEBHOOK_SECRET = process.env.KIVOO_WEBHOOK_SECRET ?? '';
const COUNTRY = process.env.KIVOO_COUNTRY || undefined;
// « pro=<uuid>,team=<uuid> » : un plan par licence réservée à l'application.
const PRODUCT_BY_PLAN = Object.fromEntries(
  (process.env.KIVOO_PLANS ?? '')
    .split(',')
    .map((pair) => pair.trim().split('='))
    .filter(([name, id]) => name && id),
);
const PLAN_BY_PRODUCT = Object.fromEntries(Object.entries(PRODUCT_BY_PLAN).map(([plan, id]) => [id, plan]));
const DB_FILE = new URL('./data.json', import.meta.url);

// Les utilisateurs du SaaS : leur id est la « référence externe » chez Kivoo.
const USERS = {
  42: { email: 'awa@example.com', lastName: 'Diallo', firstName: 'Awa' },
  43: { email: 'moussa@example.com', lastName: 'Traoré', firstName: 'Moussa' },
};

// ---------- Stockage (un fichier JSON suffit pour la démo) ----------

const db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : { keys: {}, events: [], log: [] };
const saveDb = () => writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

function log(message) {
  const line = `${new Date().toISOString()}  ${message}`;
  console.log(line);
  db.log.unshift(line);
  db.log = db.log.slice(0, 50);
  saveDb();
}

// Enregistre l'état d'une clé, tel que Kivoo le donne (PublicLicenseKeyDto).
function upsertKey(key, source) {
  const userId = key.checkout?.externalReference;
  const plan = PLAN_BY_PRODUCT[key.product?.id];
  if (!userId || !plan) return log(`[${source}] clé ${key.keyHint} ignorée : sans session ou plan inconnu`);
  db.keys[key.id] = { userId, plan, status: key.status, expiresAt: key.expiresAt, keyHint: key.keyHint };
  saveDb();
  log(`[${source}] utilisateur ${userId} : clé ${key.keyHint} ${key.status}, expire ${key.expiresAt ?? 'jamais'}`);
}

const accessOf = (userId) => accessByPlan(Object.values(db.keys).filter((k) => k.userId === String(userId)));

// ---------- API Kivoo ----------

async function kivooGet(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`GET ${path} → ${res.status} ${json?.code ?? ''}`), { details: json });
  return json;
}

// ---------- Webhook ----------

function handleEvent(event) {
  if (db.events.includes(event.id)) return log(`événement ${event.id} déjà traité, ignoré`);
  db.events.push(event.id);
  const action = toEntitlementAction(event, PLAN_BY_PRODUCT);
  if (!isActionSafe(action)) return log(`[${event.type}] refusé (fail closed) : utilisateur ou plan inconnu`);
  switch (action.type) {
    case 'grant':
    case 'expire':
    case 'revoke':
      upsertKey(event.data, event.type);
      if (action.reason) log(`  raison : ${action.reason}`);
      break;
    case 'remind_renewal':
      log(`[expiring] utilisateur ${action.userId} : expire dans ${action.daysUntilExpiry} j → relancer`);
      break;
    case 'record_order':
      log(`[${action.event}] commande ${action.reference}, utilisateur ${action.userId ?? '—'}`);
      break;
    case 'ping':
      log('[ping] webhook de test reçu');
      break;
    default:
      log(`[${event.type}] non traité`);
  }
  saveDb();
}

// ---------- Pages ----------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : 'permanent');

function page(title, body) {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem}
.card{border:1px solid #ddd;border-radius:10px;padding:1rem;margin:1rem 0}
button{padding:.5rem .9rem;border-radius:8px;border:0;background:#111;color:#fff;cursor:pointer}
.ok{color:#0a7d32}.no{color:#b00}pre{background:#f5f5f5;padding:.6rem;overflow:auto;font-size:12px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:.3rem;text-align:left;font-size:13px}</style>
<h1>${esc(title)}</h1>${body}</html>`;
}

function home(userId) {
  const access = accessOf(userId);
  const plans = Object.keys(PRODUCT_BY_PLAN)
    .map((plan) => {
      const has = plan in access;
      return `<div class="card"><b>Plan ${esc(plan)}</b> —
        ${has ? `<span class="ok">actif jusqu’au ${esc(fmt(access[plan]))}</span>` : '<span class="no">inactif</span>'}
        <form method="post" action="/subscribe?user=${userId}&plan=${esc(plan)}" style="margin-top:.6rem">
          <button>${has ? 'Renouveler' : `Passer au ${esc(plan)}`}</button></form></div>`;
    })
    .join('');
  const keys = Object.entries(db.keys)
    .filter(([, k]) => k.userId === String(userId))
    .map(([id, k]) => `<tr><td>${esc(k.keyHint)}</td><td>${esc(k.plan)}</td><td>${esc(k.status)}</td><td>${esc(fmt(k.expiresAt))}</td><td>${esc(id.slice(0, 8))}</td></tr>`)
    .join('');
  return page(`Mon SaaS — ${USERS[userId].firstName} (#${userId})`, `
    <p>Utilisateur : ${Object.keys(USERS).map((id) => `<a href="/?user=${id}">#${id}</a>`).join(' · ')}</p>
    ${plans || '<p class="no">Aucun plan : renseigne KIVOO_PLANS dans .env</p>'}
    <form method="post" action="/resync?user=${userId}"><button>Resynchroniser depuis Kivoo</button></form>
    <h3>Clés Kivoo de cet utilisateur</h3>
    <table><tr><th>Indice</th><th>Plan</th><th>État</th><th>Expire</th><th>id</th></tr>${keys || '<tr><td colspan=5>aucune</td></tr>'}</table>
    <h3>Journal</h3><pre>${esc(db.log.join('\n'))}</pre>`);
}

// ---------- Serveur ----------

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

// Dans un vrai SaaS, l'utilisateur vient de la session ; ici, de ?user=.
createServer(async (req, res) => {
  const url = new URL(req.url, APP_URL);
  const userId = USERS[url.searchParams.get('user')] ? url.searchParams.get('user') : '42';
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, home(userId));

    // 1. Le clic « Passer au Pro » : une session par clic, puis redirection.
    if (req.method === 'POST' && url.pathname === '/subscribe') {
      const plan = url.searchParams.get('plan');
      if (!PRODUCT_BY_PLAN[plan]) return send(res, 400, page('Plan inconnu', ''));
      const checkout = await createCheckout({
        apiKey: API_KEY,
        apiUrl: API_URL,
        productId: PRODUCT_BY_PLAN[plan],
        userId,
        returnUrl: `${APP_URL}/billing/return`,
        metadata: { plan, source: 'saas_demo' },
        customer: USERS[userId],
        country: COUNTRY,
      });
      log(`session ${checkout.id} créée pour #${userId} (${plan}), ${checkout.amount} ${checkout.currency}`);
      return send(res, 303, '', { Location: checkout.url });
    }

    // 2. Le retour : il ne prouve rien, on relit la session côté serveur.
    if (req.method === 'GET' && url.pathname === '/billing/return') {
      const checkoutId = url.searchParams.get('checkoutId') ?? '';
      const checkout = await kivooGet(`/v1/checkouts/${encodeURIComponent(checkoutId)}`);
      let note = '';
      if (checkout.status === 'paid' && checkout.licenseKey) {
        try {
          upsertKey(await kivooGet(`/v1/license-keys/${checkout.licenseKey.id}`), 'retour');
        } catch (e) {
          note = `<p class="no">Lecture de la clé impossible (${esc(e.message)}) : ajoute la portée license_keys:read ou attends le webhook.</p>`;
        }
      }
      const uid = checkout.externalReference;
      return send(res, 200, page('Retour de paiement', `
        <p>Session <code>${esc(checkout.id)}</code> pour l’utilisateur #${esc(uid)} : <b>${esc(checkout.status)}</b></p>
        ${checkout.status === 'paid' ? '<p class="ok">Paiement confirmé par l’API Kivoo.</p>' : '<p class="no">Pas (encore) payé.</p>'}
        ${note}<pre>${esc(JSON.stringify(checkout, null, 2))}</pre><a href="/?user=${esc(uid)}">← Mon compte</a>`));
    }

    // 3. Les webhooks : signature, idempotence, puis mise à jour.
    if (req.method === 'POST' && url.pathname === '/webhooks/kivoo') {
      const raw = await readBody(req);
      if (!verifyKivooSignature(WEBHOOK_SECRET, req.headers['kivoo-signature'], raw)) {
        log('webhook refusé : signature invalide');
        return send(res, 400, 'invalid signature');
      }
      send(res, 200, 'ok');
      return handleEvent(JSON.parse(raw));
    }

    // 4. Resynchronisation si des webhooks ont été manqués.
    if (req.method === 'POST' && url.pathname === '/resync') {
      const list = await kivooGet(`/v1/license-keys?externalReference=${encodeURIComponent(userId)}&pageSize=100`);
      list.data.forEach((key) => upsertKey(key, 'resync'));
      log(`resync #${userId} : ${list.total} clé(s)`);
      return send(res, 303, '', { Location: `/?user=${userId}` });
    }

    send(res, 404, page('Introuvable', ''));
  } catch (error) {
    log(`erreur : ${error.message}`);
    send(res, 502, page('Erreur Kivoo', `<p class="no">${esc(error.message)}</p><pre>${esc(JSON.stringify(error.details, null, 2))}</pre><a href="/?user=${userId}">← Retour</a>`));
  }
}).listen(PORT, () => {
  console.log(`Mini-SaaS sur ${APP_URL} — API ${API_URL} — plans : ${Object.keys(PRODUCT_BY_PLAN).join(', ') || 'aucun'}`);
  if (!API_KEY) console.warn('⚠ KIVOO_API_KEY manquante');
  if (!WEBHOOK_SECRET) console.warn('⚠ KIVOO_WEBHOOK_SECRET manquant : tous les webhooks seront refusés');
});
