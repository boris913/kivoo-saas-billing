# Mini-SaaS de démonstration

Un faux SaaS avec deux utilisateurs (#42 et #43), qui vend un plan « pro » avec une licence Kivoo réservée à l'application. Node 20+, aucune dépendance. Il réutilise `../../scripts/kivoo-core.mjs`.

| Route | Rôle |
| ----- | ---- |
| `GET /` | Le compte : l'accès par plan, les clés, le journal |
| `POST /subscribe` | Crée la session de paiement (`POST /v1/checkouts`) et redirige vers la page Kivoo |
| `GET /billing/return` | Relit la session par l'API : la redirection ne prouve rien |
| `POST /webhooks/kivoo` | Vérifie la signature, ignore les doublons, met à jour les clés |
| `POST /resync` | `GET /v1/license-keys?externalReference=…`, si des webhooks ont été manqués |

## 1. Test hors ligne (sans payer)

```bash
cp .env.example .env
node --env-file=.env server.mjs
# dans un autre terminal
node --env-file=.env simulate-webhook.mjs issued 42 pro 30
node --env-file=.env simulate-webhook.mjs renew 42 pro 30
node --env-file=.env simulate-webhook.mjs replay
node --env-file=.env simulate-webhook.mjs badsig 42 pro 30
node --env-file=.env simulate-webhook.mjs issued 43 pro 30
node --env-file=.env simulate-webhook.mjs revoked 43
```

Résultat attendu sur http://localhost:4000 :
- #42 est actif 60 jours (l'achat et le renouvellement s'additionnent) ;
- le rejeu est ignoré ;
- la mauvaise signature est refusée (`400`) ;
- #43 est inactif après le remboursement.

## 2. Test réel de bout en bout (petit paiement)

1. Crée une licence « Plan Pro — 30 jours » : petit prix, _clés automatiques_, 30 jours, « Vendre seulement depuis mon application » activé. Copie son id dans `KIVOO_PLANS=pro=<id>`.
2. Crée une clé API avec `checkouts` en lecture et écriture, et `license_keys` en lecture. Mets-la dans `KIVOO_API_KEY`.
3. Ouvre un tunnel : `cloudflared tunnel --url http://localhost:4000` ou `ngrok http 4000`. Mets l'adresse obtenue dans `APP_URL`.
4. Crée un webhook vers `APP_URL/webhooks/kivoo`, avec les événements `license_key.*` et `order.*`. Mets son secret dans `KIVOO_WEBHOOK_SECRET`, relance le serveur, puis clique « Envoyer un test » : le journal doit afficher `[ping]`.
5. Ouvre `APP_URL`, clique « Passer au pro » et paie en Mobile Money.

| # | Étape | Attendu |
| - | ----- | ------- |
| 1 | Clic « Passer au pro » | La page Kivoo s'ouvre au nom de la boutique, directement sur le paiement, avec le contact prérempli |
| 2 | Paiement confirmé | « Paiement reçu », puis redirection en 3 s vers `/billing/return?checkoutId=…`, avec le statut `paid` lu par l'API |
| 3 | Webhook | `license_key.issued` avec `checkout.externalReference = 42` et `expiresAt` ; le plan est actif 30 jours |
| 4 | E-mail | Un reçu, **sans clé** |
| 5 | « Renouveler », puis paiement | La nouvelle clé expire 30 jours **après la première**, pas après aujourd'hui |
| 6 | Rouvrir l'URL de la première session | « Paiement reçu », sans second paiement possible |
| 7 | Boutique publique | La licence n'apparaît nulle part, et sa page répond 404 |
| 8 | Vider `data.json`, puis « Resynchroniser » | L'accès revient |
| 9 | Ouvrir `/billing/return?checkoutId=<id d'une session non payée>` | Statut `open`, aucun accès accordé |
| 10 | Remboursement (≥ 1 000 FCFA, payé depuis moins de 2 jours) | `license_key.revoked` avec la raison `refund` ; seule la clé remboursée tombe |
