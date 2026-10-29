# kivoo-saas-billing

Faire payer les abonnements de ton SaaS en **Mobile Money**, avec [Kivoo](https://kivoo.africa). Sans entreprise, sans agrégateur, sans prélèvement automatique.

Ce dépôt contient :

- **`SKILL.md`** : un skill pour [Claude Code](https://claude.com/claude-code) (et tout agent qui lit les skills). L'agent lit ton projet, puis branche Kivoo dessus : plans, session de paiement, webhook signé, contrôle d'accès.
- **`scripts/kivoo-core.mjs`** : la logique à copier dans ton projet. Elle crée la session de paiement, vérifie la signature des webhooks, traduit les événements en droits d'accès et calcule l'accès par plan. Aucune dépendance.
- **`scripts/selftest.mjs`** : 13 tests sans réseau.
- **`examples/node-demo`** : un mini-SaaS complet, qui se teste en local avec des webhooks simulés.

## Le principe

```
Ton SaaS                                       Ta boutique Kivoo
Plan Pro ── productId ──────────────────────▶ Licence « Pro — 30 jours » (réservée à l'application)
  clic « Passer au Pro » ── POST /v1/checkouts ──▶ url de paiement
  l'utilisateur paie en Mobile Money, puis revient sur ton returnUrl
           ◀──── webhook signé license_key.issued (externalReference, expiresAt) ────
```

1. Chaque plan est un produit **Licence** Kivoo. Sa durée de validité est la période payée.
2. Quand l'utilisateur clique, ton serveur crée une **session de paiement**, avec l'identifiant de l'utilisateur chez toi (`externalReference`).
3. L'utilisateur paie sur une page Kivoo aux couleurs de ta boutique, puis revient sur ton application.
4. Tu reçois `license_key.issued` et tu ouvres le plan jusqu'à `expiresAt`. L'utilisateur ne saisit aucune clé : il reçoit un reçu par e-mail.
5. Pour renouveler, tu crées une nouvelle session. **La nouvelle période s'ajoute à celle qui reste**, sans perte de jours.

## Installer le skill

```bash
# pour tous tes projets
git clone https://github.com/boris913/kivoo-saas-billing ~/.claude/skills/kivoo-saas-billing
# ou pour un seul projet
git clone https://github.com/boris913/kivoo-saas-billing .claude/skills/kivoo-saas-billing
```

Puis, dans Claude Code : « Branche les abonnements Kivoo sur mon SaaS, avec un plan Pro à 30 jours. »

## Ce qu'il te faut côté Kivoo

1. Une boutique Kivoo, avec le type de produit **Licence** ouvert.
2. Un produit **Licence** par plan. Pour chacun : prix fixe, _clés automatiques_, durée de validité (par exemple 30 jours), et **« Vendre seulement depuis mon application »** activé.
3. Une **clé API** (Paramètres › Clés API) avec **Sessions de paiement** en lecture et écriture, et **Clés de licence** en lecture.
4. Un **webhook** (Paramètres › Webhooks) en `https://` vers ton serveur, abonné à `license_key.*` et `order.*`.

## Tester

```bash
node scripts/selftest.mjs                 # 13 tests, sans réseau
cd examples/node-demo && cp .env.example .env
node --env-file=.env server.mjs           # http://localhost:4000
node --env-file=.env simulate-webhook.mjs issued 42 pro 30
```

Kivoo n'a pas de **mode test**. Pour un essai de bout en bout, achète ta propre licence à petit prix avec ton numéro Mobile Money : tu ne perds que la commission. Voir [`examples/node-demo/README.md`](examples/node-demo/README.md).

## Bon à savoir

- **Pas de prélèvement automatique**, parce que Mobile Money ne le permet pas. Chaque période est un nouveau paiement : ton application propose « Renouveler » avant l'échéance. Le webhook `license_key.expiring` t'aide à relancer, car Kivoo n'envoie aucun e-mail d'expiration pour ces licences.
- **Pas de prorata** quand on change de plan, ni de code promo sur une licence.
- **Une session par clic**, valable 24 h, pour un seul paiement.
- La redirection vers ton `returnUrl` **ne prouve rien**. Décide à partir du webhook, ou en lisant `GET /v1/checkouts/{id}` côté serveur.

## Documentation

- Guide officiel : [Encaisser depuis ton application](https://developer.kivoo.africa/guides/encaisser-depuis-une-application)
- [Webhooks](https://developer.kivoo.africa/webhooks) et [Vérifier la signature](https://developer.kivoo.africa/webhooks/signature)

## Licence

MIT
