// Logique pure, sans dépendance : session de paiement, signature des webhooks,
// traduction des événements Kivoo en droits d'accès, calcul de l'accès.
// Copier dans le projet cible (ex : lib/kivoo/core.ts) et adapter les types.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const KIVOO_API_URL = 'https://api.kivoo.africa';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Crée une session de paiement pour UN utilisateur et UNE licence. Serveur uniquement.
 * Renvoie la session ; rediriger l'utilisateur vers `session.url`.
 */
export async function createCheckout({ apiKey, productId, userId, returnUrl, metadata, customer, country, apiUrl = KIVOO_API_URL, fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiUrl}/v1/checkouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      productId,
      externalReference: String(userId),
      returnUrl,
      ...(metadata ? { metadata } : {}),
      ...(customer ? { customer } : {}),
      ...(country ? { country } : {}),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(`Kivoo ${res.status} ${body?.code ?? ''}`.trim());
    error.status = res.status;
    error.code = body?.code;
    error.details = body?.details;
    throw error;
  }
  return body;
}

/**
 * header : valeur de `Kivoo-Signature` (`t=<secondes>,v1=<hex>[,v1=…]`).
 * rawBody : le corps EXACT reçu (string ou Buffer), jamais JSON.stringify(parsed).
 */
export function verifyKivooSignature(secret, header, rawBody, now = Date.now()) {
  if (!secret || !header) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const [key, value = ''] = part.trim().split('=');
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]+$/i.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((signature) => {
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}

/**
 * Traduit une enveloppe de webhook en action métier.
 * planByProductId : { '<uuid produit Kivoo>': 'pro', … } — seule source du plan.
 */
export function toEntitlementAction(event, planByProductId) {
  const data = event?.data ?? {};
  const userId = data.checkout?.externalReference ?? null;
  const plan = planByProductId[data.product?.id] ?? null;
  const key = { keyId: data.id, status: data.status, expiresAt: data.expiresAt ?? null, issuedAt: data.issuedAt ?? null };
  switch (event?.type) {
    case 'license_key.issued':
      return { type: 'grant', userId, plan, ...key, checkoutId: data.checkout?.id ?? null };
    case 'license_key.expiring':
      return { type: 'remind_renewal', userId, plan, ...key, daysUntilExpiry: data.daysUntilExpiry };
    case 'license_key.expired':
      return { type: 'expire', userId, plan, ...key };
    case 'license_key.revoked':
      return { type: 'revoke', userId, plan, ...key, reason: data.reason ?? null };
    case 'order.paid':
    case 'order.refunded':
    case 'order.failed':
      return { type: 'record_order', event: event.type, userId: data.checkout?.externalReference ?? null, orderId: data.id, reference: data.reference };
    case 'ping':
      return { type: 'ping' };
    default:
      return { type: 'ignore' };
  }
}

/** Fail closed : sans utilisateur (achat en boutique) ou sans plan connu, on n'accorde rien. */
export function isActionSafe(action) {
  if (['ignore', 'ping'].includes(action.type)) return true;
  if (action.type === 'record_order') return true;
  return Boolean(action.userId) && Boolean(action.plan) && Boolean(action.keyId);
}

/**
 * L'accès se décide ici, à partir des clés stockées par le SaaS :
 * pour chaque plan, la plus lointaine expiration des clés actives. null = permanent.
 * keys : [{ plan, status, expiresAt }]
 */
export function accessByPlan(keys, now = new Date()) {
  const access = {};
  for (const key of keys) {
    if (key.status !== 'active') continue;
    if (key.expiresAt !== null && new Date(key.expiresAt) <= now) continue;
    if (access[key.plan] === null) continue;
    if (key.expiresAt === null) access[key.plan] = null;
    else if (!access[key.plan] || access[key.plan] < key.expiresAt) access[key.plan] = key.expiresAt;
  }
  return access;
}
