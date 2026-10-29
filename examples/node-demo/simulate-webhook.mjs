// Envoie au mini-SaaS un webhook signé comme Kivoo le ferait, sans paiement réel.
//
//   node --env-file=.env simulate-webhook.mjs issued  42 pro 30   # achat, 30 jours
//   node --env-file=.env simulate-webhook.mjs renew   42 pro 30   # renouvellement cumulé
//   node --env-file=.env simulate-webhook.mjs revoked 42          # remboursement de la dernière clé
//   node --env-file=.env simulate-webhook.mjs replay              # rejoue le dernier événement
//   node --env-file=.env simulate-webhook.mjs badsig  42 pro 30   # signature fausse → 400
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [kind = 'issued', userId = '42', plan = 'pro', days = '30'] = process.argv.slice(2);
const target = `${(process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, '')}/webhooks/kivoo`;
const secret = process.env.KIVOO_WEBHOOK_SECRET ?? '';
const plans = Object.fromEntries((process.env.KIVOO_PLANS ?? '').split(',').map((p) => p.trim().split('=')));
const stateFile = new URL('./.simulate-state.json', import.meta.url);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { keys: [], last: null };

function keyEvent(type, key, extra = {}) {
  return { id: randomUUID(), type, createdAt: new Date().toISOString(), store: { id: randomUUID(), slug: 'demo' }, data: { ...key, ...extra } };
}

function newKey(expiresAt) {
  const checkoutId = randomUUID();
  const hint = Math.random().toString(36).slice(2, 6).toUpperCase();
  return {
    id: randomUUID(), keyHint: `DEMO-…-${hint}`, status: 'active', isActive: true,
    issuedAt: new Date().toISOString(), expiresAt, revokedAt: null,
    activations: { count: 0, max: 1, remaining: 1 },
    product: { id: plans[plan] ?? randomUUID(), title: `Plan ${plan}` },
    customer: { id: randomUUID(), email: 'awa@example.com' },
    order: { id: randomUUID(), reference: `KV-${hint}SIM` },
    checkout: { id: checkoutId, externalReference: userId, metadata: { plan, source: 'simulate' } },
  };
}

let event;
const ms = Number(days) * 86_400_000;
if (kind === 'issued' || kind === 'badsig') {
  const key = newKey(new Date(Date.now() + ms).toISOString());
  state.keys.push(key);
  event = keyEvent('license_key.issued', key);
} else if (kind === 'renew') {
  // Comme Kivoo : même produit, même référence externe → expire à la fin de la précédente + durée.
  const previous = state.keys.filter((k) => k.checkout.externalReference === userId && k.status === 'active').at(-1);
  const base = previous && new Date(previous.expiresAt) > new Date() ? new Date(previous.expiresAt).getTime() : Date.now();
  const key = newKey(new Date(base + ms).toISOString());
  state.keys.push(key);
  event = keyEvent('license_key.issued', key);
} else if (kind === 'revoked') {
  const key = state.keys.filter((k) => k.checkout.externalReference === userId && k.status === 'active').at(-1);
  if (!key) throw new Error('aucune clé active à révoquer');
  Object.assign(key, { status: 'revoked', isActive: false, revokedAt: new Date().toISOString() });
  event = keyEvent('license_key.revoked', key, { reason: 'refund' });
} else if (kind === 'replay') {
  event = state.last;
  if (!event) throw new Error('rien à rejouer');
} else {
  throw new Error(`type inconnu : ${kind}`);
}

const body = JSON.stringify(event);
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', kind === 'badsig' ? 'mauvais-secret' : secret).update(`${t}.${body}`).digest('hex');
const res = await fetch(target, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Kivoo-Signature': `t=${t},v1=${v1}`, 'Kivoo-Event-Id': event.id },
  body,
});
console.log(`${event.type} (${kind}) → ${res.status} ${await res.text()}  expiresAt=${event.data.expiresAt}`);
if (kind !== 'badsig') {
  state.last = event;
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
