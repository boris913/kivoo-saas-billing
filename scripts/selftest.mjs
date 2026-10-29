// node scripts/selftest.mjs -> signature, mapping, accès, cas hostiles. Aucun appel réseau.
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { verifyKivooSignature, toEntitlementAction, isActionSafe, accessByPlan, createCheckout } from './kivoo-core.mjs';

const secret = 'whsec_test_123';
const now = Date.parse('2026-10-18T09:14:05Z');
const t = Math.floor(now / 1000);
const sign = (raw, at = t, s = secret) => `t=${at},v1=${createHmac('sha256', s).update(`${at}.${raw}`).digest('hex')}`;

const PRO = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const plans = { [PRO]: 'pro' };
const issued = {
  id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
  type: 'license_key.issued',
  createdAt: '2026-10-18T09:14:05.000Z',
  data: {
    id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    keyHint: 'K7M2-…-Q4RT', status: 'active', isActive: true,
    issuedAt: '2026-10-18T09:14:03.000Z', expiresAt: '2026-11-17T09:14:03.000Z',
    product: { id: PRO, title: 'Plan Pro — 30 jours' },
    customer: { id: 'c1', email: 'awa@example.com' },
    checkout: { id: '7a8b9c0d', externalReference: '42', metadata: { plan: 'pro' } },
  },
};
const raw = JSON.stringify(issued); // corps tel que reçu

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok  -', name); };

await ok('signature valide acceptée', () => assert.equal(verifyKivooSignature(secret, sign(raw), raw, now), true));
await ok('plusieurs v1 : une seule correspondance suffit', () => {
  const header = `${sign(raw)},v1=${'0'.repeat(64)}`;
  assert.equal(verifyKivooSignature(secret, header, raw, now), true);
});
await ok('corps re-sérialisé (indentation) rejeté', () => {
  const reser = JSON.stringify(JSON.parse(raw), null, 2);
  assert.equal(verifyKivooSignature(secret, sign(raw), reser, now), false);
});
await ok('corps altéré rejeté', () => assert.equal(verifyKivooSignature(secret, sign(raw), raw.replace('"42"', '"43"'), now), false));
await ok('mauvais secret rejeté', () => assert.equal(verifyKivooSignature(secret, sign(raw, t, 'whsec_autre'), raw, now), false));
await ok('horodatage hors tolérance (rejeu) rejeté', () => assert.equal(verifyKivooSignature(secret, sign(raw, t - 301), raw, now), false));
await ok('en-tête absent, vide ou malformé rejeté sans exception', () => {
  for (const h of [undefined, '', 't=abc,v1=zz', `v1=${'a'.repeat(64)}`, `t=${t},v1=abc`]) assert.equal(verifyKivooSignature(secret, h, raw, now), false);
  assert.equal(verifyKivooSignature('', sign(raw), raw, now), false);
});
await ok('license_key.issued -> grant (utilisateur, plan, expiration)', () => {
  const a = toEntitlementAction(issued, plans);
  assert.deepEqual([a.type, a.userId, a.plan, a.expiresAt], ['grant', '42', 'pro', '2026-11-17T09:14:03.000Z']);
  assert.equal(isActionSafe(a), true);
});
await ok('produit inconnu -> refus (fail closed)', () => {
  const a = toEntitlementAction({ ...issued, data: { ...issued.data, product: { id: 'autre' } } }, plans);
  assert.equal(isActionSafe(a), false);
});
await ok('clé achetée en boutique (sans checkout) -> refus', () => {
  const a = toEntitlementAction({ ...issued, data: { ...issued.data, checkout: null } }, plans);
  assert.equal(isActionSafe(a), false);
});
await ok('expiring / expired / revoked / ping / inconnu', () => {
  const ev = (type, extra = {}) => toEntitlementAction({ type, data: { ...issued.data, ...extra } }, plans);
  assert.equal(ev('license_key.expiring', { daysUntilExpiry: 7 }).daysUntilExpiry, 7);
  assert.equal(ev('license_key.expired', { status: 'expired' }).type, 'expire');
  assert.equal(ev('license_key.revoked', { status: 'revoked', reason: 'refund' }).reason, 'refund');
  assert.equal(toEntitlementAction({ type: 'ping' }, plans).type, 'ping');
  assert.equal(toEntitlementAction({ type: 'event.created' }, plans).type, 'ignore');
});
await ok('accès : renouvellement cumulé, expirée, révoquée, permanente', () => {
  const at = new Date('2026-11-20T00:00:00Z');
  assert.deepEqual(accessByPlan([
    { plan: 'pro', status: 'active', expiresAt: '2026-11-17T09:14:03.000Z' },
    { plan: 'pro', status: 'active', expiresAt: '2026-12-17T09:14:03.000Z' },
  ], at), { pro: '2026-12-17T09:14:03.000Z' });
  assert.deepEqual(accessByPlan([{ plan: 'pro', status: 'active', expiresAt: '2026-11-17T09:14:03.000Z' }], at), {});
  assert.deepEqual(accessByPlan([{ plan: 'pro', status: 'revoked', expiresAt: '2027-01-01T00:00:00Z' }], at), {});
  assert.deepEqual(accessByPlan([
    { plan: 'lifetime', status: 'active', expiresAt: null },
    { plan: 'lifetime', status: 'active', expiresAt: '2027-01-01T00:00:00Z' },
  ], at), { lifetime: null });
});
await ok('createCheckout envoie externalReference en texte et remonte le code d’erreur', async () => {
  let sent;
  const fetchOk = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ id: 'c1', url: 'https://x' }), { status: 201 }); };
  const s = await createCheckout({ apiKey: 'kv_live_x', productId: PRO, userId: 42, returnUrl: 'https://app/retour', fetchImpl: fetchOk });
  assert.equal(s.url, 'https://x');
  assert.equal(sent.url, 'https://api.kivoo.africa/v1/checkouts');
  assert.equal(JSON.parse(sent.init.body).externalReference, '42');
  const fetchKo = async () => new Response(JSON.stringify({ code: 'checkout_product_not_license' }), { status: 422 });
  await assert.rejects(createCheckout({ apiKey: 'k', productId: PRO, userId: 1, returnUrl: 'https://a', fetchImpl: fetchKo }), { code: 'checkout_product_not_license', status: 422 });
});
console.log(`\n${n}/${n} tests passés`);
