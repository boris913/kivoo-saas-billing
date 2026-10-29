---
name: kivoo-saas-billing
description: Brancher les paiements Kivoo (Mobile Money en Afrique) sur un SaaS pour vendre des abonnements - plans payants vendus comme licences « réservées à l'application », session de paiement (POST /v1/checkouts), webhooks signés (Kivoo-Signature), accès par plan avec renouvellement cumulé. À utiliser quand l'utilisateur veut encaisser des abonnements ou des plans pour son SaaS via Kivoo, gater des fonctionnalités par plan, ou traiter les webhooks license_key.issued, license_key.expiring, license_key.expired, license_key.revoked, order.paid. Use for Kivoo payments, Mobile Money subscriptions, SaaS paywall, Kivoo webhook handling.
---

# Kivoo → abonnements pour un SaaS

```
Ton SaaS                                       Ta boutique Kivoo
Plan Pro    ── productId ─────────────────▶  Licence « Pro — 30 jours »  (réservée à l'application)
Plan Équipe ── productId ─────────────────▶  Licence « Équipe — 30 jours »
  clic « Passer au Pro » ── POST /v1/checkouts (externalReference = id utilisateur) ──▶ url
  utilisateur ─────────── paie en Mobile Money sur l'url ─────────────────────────────▶
           ◀──────── webhook signé license_key.issued (externalReference, expiresAt) ───
           ◀──────── redirection vers returnUrl?checkoutId=… (ne prouve rien) ──────────
```

Chaque plan du SaaS = un produit **Licence** Kivoo. La **durée de validité** de la licence est la période prépayée. Le SaaS crée une **session de paiement** pour un utilisateur précis ; l'utilisateur ne voit jamais de clé (il reçoit un reçu). Source de vérité : le webhook ou la lecture de la session par l'API, jamais la redirection navigateur.

Documentation officielle : https://developer.kivoo.africa/guides/encaisser-depuis-une-application, https://developer.kivoo.africa/webhooks, https://developer.kivoo.africa/webhooks/signature. Base de l'API : `https://api.kivoo.africa`.

## Étape 0 - Lire le projet avant d'écrire du code
Identifier : framework et runtime (Next.js, Express, NestJS, Laravel, Django…), base de données/ORM, système d'auth et identifiant utilisateur, table existante des plans/abonnements, moyen d'exécuter une tâche en arrière-plan. S'aligner dessus, ne pas imposer de stack. `scripts/kivoo-core.mjs` contient la logique pure à porter dans le langage du projet.

## Prérequis côté utilisateur (à lui demander, ne jamais inventer)
1. Le type **Licence** doit être ouvert sur Kivoo (sinon `422 product_type_unavailable`).
2. Un produit **Licence** par plan et par durée, publié, avec : prix fixe (pas de prix libre), **clés automatiques** (le stock de clés est refusé : `422 checkout_license_stock_unsupported`), **durée de validité** = période payée (30, 90, 365 jours ; sans durée = achat à vie), interrupteur **« Vendre seulement depuis mon application »** activé (le produit disparaît de la boutique publique). Récupérer l'`id` (UUID) de chaque produit (`GET /v1/products`, ou dashboard).
3. Une **clé API** `kv_live_…` (dashboard › Paramètres › Clés API) avec **Sessions de paiement : lecture + écriture** (`checkouts:read`, `checkouts:write`) et **Clés de licence : lecture** (`license_keys:read`) → `KIVOO_API_KEY`. Serveur uniquement.
4. Un **webhook** (dashboard › Paramètres › Webhooks, 5 max par boutique) vers `https://<domaine>/api/webhooks/kivoo`, HTTPS public obligatoire (les adresses locales/privées sont refusées), événements : `license_key.issued`, `license_key.expiring`, `license_key.expired`, `license_key.revoked`, `order.paid`, `order.refunded`. Son secret `whsec_…` → `KIVOO_WEBHOOK_SECRET`. Ce n'est PAS la clé API.

## Étape 1 - Config des plans
Une seule table de vérité `productId Kivoo → plan`, en config ou en base. Ne jamais déduire le plan du titre du produit ni des `metadata`.
```ts
export const PLAN_BY_KIVOO_PRODUCT: Record<string, 'pro' | 'team'> = {
  '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b': 'pro',
  '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b': 'team',
};
```
Plusieurs durées (mensuel/annuel) = plusieurs produits pointant vers le même plan.

## Étape 2 - Démarrer un achat (serveur uniquement, au moment du clic)
`POST https://api.kivoo.africa/v1/checkouts`, header `Authorization: Bearer $KIVOO_API_KEY`.
```json
{
  "productId": "<uuid de la licence>",
  "externalReference": "<id de l'utilisateur dans le SaaS, opaque, ≤ 255 car.>",
  "returnUrl": "https://app.example.com/billing/return",
  "metadata": { "plan": "pro", "workspace": "acme" },
  "customer": { "email": "awa@example.com", "lastName": "Diallo", "firstName": "Awa" },
  "country": "CM"
}
```
- Requis : `productId`, `externalReference`, `returnUrl` (`https://` ; `http://localhost` et `http://127.0.0.1` acceptés en dev).
- `metadata` : ≤ 10 clés `^[a-zA-Z0-9_]{1,40}$`, valeurs **texte** ≤ 500 car., pas d'objet ni de nombre. Rendues dans les webhooks.
- `customer` (`email` + `lastName` requis dedans) : la page s'ouvre directement sur le paiement. `country` (ISO alpha-2) : pays présélectionné.
- Pas de montant ni de code promo : le prix est celui de la licence.
- Réponse `201` : rediriger vers `url`. Stocker `id` (checkoutId) côté SaaS si utile.
- Erreurs : `400 validation_failed` (`details`), `404 product_not_found` (inconnu, autre boutique, non publié), `422 checkout_product_not_license`, `422 checkout_license_stock_unsupported`, `422 product_type_unavailable`, `401 api_key_*`, `429 rate_limited` (`Retry-After`).
- **Une session par clic** : Kivoo ne dédoublonne pas, deux sessions peuvent être payées toutes les deux. Une session = une commande, 24 h ; un paiement refusé se retente sur la même page.
Helper prêt : `createCheckout()` dans `scripts/kivoo-core.mjs`.

## Étape 3 - Endpoint webhook (le cœur)
Ordre strict, voir `scripts/kivoo-core.mjs` (testé) :
1. Lire le **corps brut** (`express.raw`, `await request.text()`, `getRawBody`…). Ne jamais re-sérialiser le JSON parsé.
2. Vérifier `Kivoo-Signature: t=<secondes>,v1=<hex>` : HMAC-SHA256 de `"<t>.<corps brut>"` avec le secret complet (`whsec_` compris), comparaison à temps constant, **tolérance 300 s**, plusieurs `v1` possibles (une correspondance suffit). Sinon **400**.
3. Dédupliquer sur `Kivoo-Event-Id` (= `event.id`, stable entre tentatives et renvois) : table avec contrainte d'unicité, dans la même transaction que le traitement, conservée ≥ 30 jours. Doublon → 200 sans retraiter. Pas de `Set` en mémoire.
4. Répondre **2xx en moins de 10 s**, traiter ensuite (file, job). 8 tentatives espacées ; un webhook en échec depuis plus de 3 jours est désactivé automatiquement.
5. `toEntitlementAction(event, PLAN_BY_KIVOO_PRODUCT)` → `isActionSafe` → appliquer, journaliser.

| Événement | Action |
|---|---|
| `license_key.issued` | **accorder** : enregistrer la clé (`data.id`, plan, `data.expiresAt`, `data.status`) pour `data.checkout.externalReference` |
| `license_key.expiring` | relancer l'utilisateur (J-7 au plus, 06:00 UTC) — Kivoo n'envoie **aucun** e-mail d'expiration pour une licence vendue par session |
| `license_key.expired` | marquer la clé expirée (dans l'heure qui suit l'échéance) |
| `license_key.revoked` | marquer la clé révoquée (`reason: "refund"` ou texte du créateur) → retirer ce qu'elle donnait |
| `order.paid` / `order.refunded` | comptabilité (`data.checkout` présent) ; **ne porte pas `expiresAt`** |
| `ping` | bouton « Envoyer un test » : 200, aucun effet |

Rattachement utilisateur : `data.checkout.externalReference` est présent sur toutes les clés vendues par session. Une clé avec `checkout: null` a été achetée en boutique : ne rien accorder. Le webhook ne contient **jamais** la clé complète (seulement `keyHint`), et le SaaS n'en a pas besoin.

## Étape 4 - Contrôle d'accès
Décider côté serveur à partir de **la table des clés du SaaS** (alimentée par les webhooks) : pour chaque plan, **la plus lointaine `expiresAt` des clés `active`**, comparée à l'heure actuelle (`accessByPlan`). `expiresAt: null` = permanent. Ne pas appeler Kivoo à chaque requête, ne jamais se fier à un état côté navigateur.
- **Renouvellement cumulé** : nouvelle session, **même produit + même `externalReference`** → la nouvelle clé expire à la fin de la précédente + la durée. Chaque paiement = une clé distincte ; rembourser le renouvellement ne révoque que lui. Pas de prélèvement automatique (Mobile Money) : le SaaS propose « Renouveler » avant l'échéance.
- **Changement de plan** (Basic → Pro) = achat d'un autre produit, sans prorata, qui court dès le paiement. Le SaaS décide du sort de l'ancien plan.
- **Page de retour** `returnUrl?checkoutId=…` : n'importe qui peut la taper. Lire `GET /v1/checkouts/{id}` côté serveur, vérifier que `externalReference` est l'utilisateur connecté, `status` ∈ `open | paid | expired` ; si `paid`, `licenseKey.id` → `GET /v1/license-keys/{id}` pour l'expiration (webhook peut-être pas encore arrivé). Une session remboursée reste `paid` : la clé dit `revoked`.
- **Resynchronisation** (webhooks manqués, filet quotidien) : `GET /v1/license-keys?externalReference=<id>&pageSize=100` (`data[]`, `page`, `pageSize`, `total`).
- Fail closed : produit inconnu, `externalReference` absente, signature invalide → aucun accès.

## Étape 5 - Vérifier avant de déclarer fini
- `node scripts/selftest.mjs` : signature, rejeu, re-sérialisation, altération, mauvais secret, fail closed, renouvellement cumulé (13 tests, sans réseau).
- Dashboard Kivoo › webhook › **Envoyer un test** (`ping`), puis **Renvoyer** une livraison depuis le journal : le doublon doit être ignoré.
- `examples/node-demo` : rejouer le scénario complet en local avec `simulate-webhook.mjs`.
- **Pas de mode test** chez Kivoo : acheter une licence à petit prix avec son propre numéro Mobile Money (seule la commission est perdue) et suivre : session → paiement → retour → `license_key.issued` → accès → renouvellement (date cumulée) → remboursement → `license_key.revoked` → accès retiré.
- En local, exposer le webhook par un tunnel (`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`).

## Points à signaler à l'utilisateur
- Pas d'abonnement à prélèvement automatique : chaque période est un nouveau paiement confirmé par l'utilisateur.
- Pas de code promo sur une licence ; pour une promotion, baisser le prix ou afficher un prix barré.
- Remboursement : demandé depuis le dashboard par le propriétaire, validé par Kivoo (commande ≥ 1 000 FCFA, payée depuis moins de 2 jours).
- Pays et moyens de paiement disponibles, commission, retraits : dépendent de la boutique Kivoo, hors périmètre technique.
- Ne jamais mettre `kv_live_` ni `whsec_` dans le dépôt, le front ou une app mobile.
