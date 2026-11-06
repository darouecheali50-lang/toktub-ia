# Danse Studio

Application web (téléphone et PC) : vous importez une vidéo de danse et l'image d'un personnage ; un moteur IA de transfert de mouvements génère une vidéo où ce personnage reprend la chorégraphie. Le serveur réintègre ensuite automatiquement la musique d'origine (ou votre fichier audio) avec FFmpeg.

> Ce projet est **nouveau** : je n'avais pas accès au code de votre site existant, il n'a donc pas été modifié.

## Personnaliser le site (administrateur)

Connecté avec un e-mail de `ADMIN_EMAILS`, le menu **Personnaliser** permet de changer sans toucher au code : le nom de l'application, la phrase d'accueil, la valeur d'un crédit, et pour chaque carte d'outil l'étiquette, le titre, la description et l'image. Pour l'image : glissez-la sur la carte à l'accueil, choisissez un fichier, ou bouton **Générer avec l'IA** (FLUX schnell, moins d'un centime) à partir du texte de la carte. Réglages dans `data/settings.json`, images dans `data/branding/` (JPEG, PNG ou WebP vérifiés).

## Mode Économique (Mix et Move)

Par défaut, la vidéo envoyée à l'IA est ramenée à **16 images/s** (si elle en a plus). fal facture Wan Animate au nombre d'images (16 images = 1 « seconde vidéo »), donc une vidéo de téléphone à 30 images/s coûte **environ deux fois moins** de crédits et se génère plus vite. La durée et la musique restent identiques (la bande-son d'origine est remise depuis t = 0). Le mode **Fluide** garde la cadence d'origine.

## Modèle économique : comptes, crédits, abonnements

- Chaque client crée un compte (e-mail + mot de passe, haché avec scrypt) et reçoit `FREE_CREDITS` crédits offerts (3 par défaut).
- **1 crédit = 0,09 $ de coût fal** par défaut (≈ 1,3 s de vidéo à partir d'un texte), modifiable dans **Personnaliser** (administrateur). Le nombre de crédits d'une création = coût fal estimé ÷ valeur du crédit, arrondi au-dessus (minimum 1). Une image = 1 crédit. Mix/Move dépendent de la durée et des images par seconde de la vidéo importée ; le nombre exact s'affiche avant de générer.
- Les crédits sont débités au lancement et **recrédités automatiquement si la génération échoue**.
- Formules (modifiables dans `src/config.js` et `.env`) :

| Formule | Mensuel | Annuel | Crédits | Coût fal maximal si tout est utilisé |
|---|---|---|---|---|
| Basique | 6 $ | 60 $ (2 mois offerts) | 50 / mois (600 / an) | ≈ 4,50 $ / mois (à 0,09 $ le crédit) |
| Pro | 9 $ | 90 $ | 80 / mois (960 / an) | ≈ 7,20 $ / mois (à 0,09 $ le crédit) |

  À retirer encore : les frais Stripe (environ 1,5 % + 0,25 € par paiement en Europe pour les cartes européennes, à vérifier sur stripe.com/fr/pricing) et la TVA éventuelle. La marge est faible si un client utilise tout (la page Personnaliser affiche ce calcul et prévient en cas de perte) ; augmentez les prix ou baissez les crédits (`BASIC_CREDITS`, `PRO_CREDITS`) si besoin.
- Les crédits d'abonnement sont **remis au niveau de la formule** à chaque facture payée (ils ne se cumulent pas). L'annuel verse 12 mois d'un coup.
- Les e-mails listés dans `ADMIN_EMAILS` ont des crédits illimités (pour vous).

## Durées des vidéos

Le modèle vidéo produit 5 ou 10 s par appel. Pour 15, 20 ou 30 s, l'application génère un premier morceau, prend sa dernière image, génère la suite à partir de cette image (image → vidéo, même description), puis assemble les morceaux avec FFmpeg. Les raccords peuvent être visibles selon la scène. Mix et Move suivent la durée de la vidéo importée (30 s maximum par défaut).

## Fonctionnalités

| Outil | Ce qu'il fait | Modèle fal.ai | Tarif vérifié (05/11/2026) |
|---|---|---|---|
| **Mix** | Remplace la personne d'une vidéo par votre personnage (même danse, même décor) | `fal-ai/wan/v2.2-14b/animate/replace` | 0,04 $ (480p), 0,06 $ (580p), 0,08 $ (720p) par « seconde vidéo » = 16 images |
| **Move** | Fait danser votre photo avec les mouvements de la vidéo | `fal-ai/wan/v2.2-14b/animate/move` | idem |
| **Vidéo** | Vidéo de 5 ou 10 s à partir d'un texte | `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` | 0,35 $ pour 5 s, + 0,07 $ par seconde |
| **Vidéo + image de départ** | Anime une image selon un texte | `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | non indiqué dans la doc consultée : à vérifier sur fal |
| **Image** | Image ou **personnage** à partir d'un texte | `fal-ai/flux/schnell` | 0,003 $ par mégapixel |
| **Mèmes** | Texte sur une image, dans le navigateur | aucun | gratuit |

Parcours clé : **Image → « Personnage pour Mix / Move » → bouton « Dans Mix » ou « Dans Move » → ajouter la vidéo de danse**. Le personnage créé reprend la danse, et la musique d'origine est remise automatiquement, synchronisée. Une vidéo générée peut aussi servir de danse de référence.

La galerie **Explorer** propose des idées de prompts originales avec « Utiliser ce prompt ». Ses images se créent avec `npm run galerie` (environ 0,05 $ au total, FLUX schnell).

Ce site reprend des fonctions courantes des studios vidéo IA, avec son propre nom, son propre design et ses propres contenus (aucun logo, image ou mème d'un autre service).

Sources : pages officielles fal.ai des modèles (`fal.ai/models/<modèle>/llms.txt`), https://fal.ai/pricing.md, https://fal.ai/docs/model-api-reference/video-generation-api/kling-video-v2.5-turbo-pro.md, https://fal.ai/docs/model-api-reference/image-generation-api/flux-schnell.md, https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace. Pour **Mix**, le schéma complet n'était pas lisible : l'application envoie `video_url`, `image_url` et `resolution` comme pour Move ; si fal exige un autre paramètre, l'erreur exacte s'affiche.

L'application affiche une **estimation** avant chaque génération ; le montant exact facturé est dans votre tableau de bord fal (Usage / Billing).

### Limites

- **Durée des vidéos importées** : limite configurable `MAX_VIDEO_SECONDS` (30 s par défaut). Une vidéo plus longue est refusée avec un message clair, jamais coupée.
- **Formats** : vidéos MP4, MOV, WebM (converties en MP4 H.264 avant l'envoi) ; images JPEG, PNG, WebP (≥ 256 px) ; audio MP3, WAV, M4A, OGG, FLAC.
- **Filtre de sécurité** fal activé : certains contenus peuvent être refusés, l'erreur est affichée telle quelle.
- **Fidélité non garantie** : elle dépend du moteur et des fichiers fournis.

### Musique

La documentation du modèle ne mentionne aucune conservation de l'audio. Le serveur traite donc systématiquement le son :

1. La vidéo envoyée à l'IA est muette (le son reste sur votre serveur).
2. Une fois la vidéo générée téléchargée, FFmpeg copie le flux vidéo **sans le ré-encoder** et ajoute la piste audio d'origine à partir de t = 0, comme dans la vidéo source : la synchronisation est conservée.
3. Si l'IA renvoie une vidéo d'une durée différente de la source, l'application l'indique clairement. La musique d'origine n'est jamais coupée.
4. Une musique de remplacement est arrêtée à la fin de la vidéo ; l'utilisateur en est prévenu avant de lancer la génération.

## Architecture

```
Navigateur ──(code d'accès)──► Serveur Node.js ──► fal.ai (CDN + file d'attente)
   aperçus locaux              │  validation, FFmpeg, suivi des tâches
   états réels (sondage 3 s)   └─ vidéo finale servie avec jetons privés
```

- `server.js` : routes HTTP (Node natif, sans framework).
- `src/providers/fal.js` : intégration fal (envoi, tâche, suivi, résultat, annulation, suppression).
- `src/jobs.js` : déroulement d'une génération et nettoyage.
- `src/uploads.js` : réception des fichiers en flux vers le disque, contrôle des types (signature binaire + FFprobe) et des tailles.
- `src/media.js` : FFprobe / FFmpeg.
- `public/` : interface (HTML, CSS, JS sans dépendance).

États affichés (tous réels) : envoi des fichiers → attente chez fal (avec position dans la file) → génération → réintégration de la musique → terminé, ou erreur avec le message du fournisseur. Aucun pourcentage de génération n'est inventé ; seule la progression d'envoi vers votre serveur affiche un pourcentage, calculé sur les octets réellement transmis.

### Sécurité et coûts

- `FAL_KEY` n'existe que côté serveur ; aucune clé n'est envoyée au navigateur.
- Import et génération exigent un compte connecté (cookie de session HttpOnly, SameSite=Lax, 30 jours) et des crédits ; blocage 15 min après 10 essais de connexion erronés ; requêtes d'un autre site refusées.
- 4 créations en même temps par client, sans limite pour l'admin (`MAX_JOBS_PER_USER`), 20 au total (`MAX_ACTIVE_JOBS_TOTAL`), 30 créations par jour et par client (`DAILY_JOBS_PER_USER`), délai maximal avec annulation chez fal (`MAX_JOB_MINUTES_V2`, 90 min).
- Fichiers importés supprimés dès la fin du traitement (ou après 30 min s'ils ne sont pas utilisés) ; vidéo finale supprimée après `RESULT_TTL_HOURS` (72 h par défaut).
- Côté fal : fichiers avec durée de vie `FAL_FILE_TTL_SECONDS` (en-tête `X-Fal-Object-Lifecycle-Preference`), historique des requêtes désactivé (`X-Fal-Store-IO: 0`), tentative de suppression des fichiers d'entrée (fonctionne si la clé possède la permission `assets:write`, sinon ils expirent).
- En-têtes de sécurité (CSP stricte, `nosniff`, anti-iframe). La vidéo finale n'est accessible qu'avec un jeton aléatoire propre à la création.

**Limite connue** : les tâches sont gardées en mémoire. Un redémarrage du serveur pendant une génération perd son suivi (la tâche peut toutefois être facturée chez fal). Déployez sur **une seule instance**.

## Stripe : encaisser les abonnements

1. Créez un compte sur https://dashboard.stripe.com et restez d'abord en **mode test**.
2. Catalogue de produits → créez deux produits, **Basique** et **Pro**, chacun avec deux prix récurrents : 6 $/mois et 60 $/an, 9 $/mois et 90 $/an. Copiez les 4 identifiants `price_...` dans `.env` (`STRIPE_PRICE_BASIQUE_MOIS`, etc.).
3. Développeurs → Clés API : copiez la **clé secrète** (`sk_test_...`) dans `STRIPE_SECRET_KEY`.
4. Développeurs → Webhooks → ajoutez un point de terminaison `https://VOTRE-SITE/api/stripe/webhook` avec les événements `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`. Copiez le **secret de signature** (`whsec_...`) dans `STRIPE_WEBHOOK_SECRET`.
5. Paramètres → Facturation → Portail client : activez-le (annulation et changement de carte par vos clients).
6. Mettez `PUBLIC_URL` à l'adresse de votre site, redémarrez, testez avec la carte de test Stripe `4242 4242 4242 4242`, puis passez en mode réel (clés `sk_live_...`, nouveau webhook, nouveaux prix).

**Important** : Stripe doit pouvoir joindre votre site pour envoyer les webhooks. Sur votre PC (`localhost`), cela ne marche pas tout seul : pour tester, installez la Stripe CLI et lancez `stripe listen --forward-to localhost:3000/api/stripe/webhook` (elle affiche un `whsec_...` temporaire). Pour de vrais clients, le site doit être **en ligne** (voir « Déploiement »).

Sources : https://docs.stripe.com/api/checkout/sessions/create, https://docs.stripe.com/api/customer_portal/sessions/create, https://docs.stripe.com/subscriptions/webhooks, https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects

## Obtenir l'accès API fal.ai

1. Créez un compte sur https://fal.ai.
2. Ajoutez des crédits dans la section facturation de votre tableau de bord (les modèles sont payants à l'usage).
3. Ouvrez https://fal.ai/dashboard/keys et générez une clé :
   - préréglage **API** (suffisant pour lancer des modèles et envoyer des fichiers) ;
   - recommandé : onglet **Allowed models**, limitez la clé à `fal-ai/wan/v2.2-14b/animate/move` (ce choix n'est plus modifiable ensuite) ;
   - facultatif : une date d'expiration.
4. Copiez la clé (elle n'est affichée qu'une fois) dans `FAL_KEY` de votre fichier `.env` ou des variables d'environnement de votre hébergeur.

## Installation locale

Prérequis : Node.js 20.12 ou plus récent, FFmpeg (`ffmpeg` et `ffprobe` dans le PATH).

```bash
cd danse-studio
npm install
cp .env.example .env      # puis renseignez FAL_KEY et ADMIN_EMAILS (et Stripe pour les abonnements)
npm start                 # http://localhost:3000
```

Sans `FAL_KEY`, la page affiche « Service vidéo non configuré » avec la marche à suivre.

## Déploiement

Le traitement vidéo exige un **serveur Node persistant avec FFmpeg et du disque** : les fonctions « serverless » (Vercel, Netlify Functions) ne conviennent pas (durées limitées, pas de FFmpeg, pas de disque persistant).

### Sur Render (recommandé, fichier `render.yaml` fourni)

1. Mettez ce dossier dans un dépôt GitHub **privé** (sans `.env`, `data/` ni `node_modules/`).
2. Sur [dashboard.render.com](https://dashboard.render.com) : **New → Blueprint**, choisissez le dépôt. Render lit `render.yaml` : service Docker « Starter » (7 $/mois), région Francfort, **disque persistant de 5 Go** monté sur `/app/data` (0,25 $/Go/mois), comptes, crédits, créations, images et réglages y sont conservés entre les redéploiements.
3. Render demande `FAL_KEY`, `ADMIN_EMAILS` et `PUBLIC_URL` : collez votre clé fal, votre e-mail d'administrateur et l'adresse donnée par Render (`https://….onrender.com`, modifiable ensuite).
4. Une fois en ligne : connectez-vous en administrateur → **Mon compte → Brancher Stripe** (le webhook de renouvellement est créé automatiquement grâce à `PUBLIC_URL` en https). Les clés sont enregistrées dans `/app/data/.env` (`ENV_FILE`), sur le disque persistant.
5. Images de la galerie : bouton **Générer toutes les images** (elles sont stockées dans `/app/data/galerie`, `GALLERY_DIR`).

Le conteneur démarre en root uniquement pour attribuer le disque à l'utilisateur `node` (`DROP_TO_USER`), puis abandonne ces droits avant de servir le site.

### Autre hébergeur Docker (Railway, Fly.io, un VPS…)

```bash
docker build -t danse-studio .
docker run -d -p 3000:3000 --env-file .env --name danse-studio danse-studio
```

Points à vérifier chez l'hébergeur :
- variables `FAL_KEY`, `ADMIN_EMAILS`, `PUBLIC_URL` et `STRIPE_*` définies dans son interface (pas dans le dépôt) ;
- `TRUST_PROXY=1` s'il place l'application derrière un proxy (blocage par adresse IP correct) ;
- HTTPS activé (le code d'accès transite dans les requêtes) ;
- taille maximale des requêtes du proxy ≥ `MAX_VIDEO_MB` (sur Nginx : `client_max_body_size 110m;`) ;
- une seule instance, avec un **disque persistant** pour le dossier `data/` (comptes et crédits dans `data/db.json` : sauvegardez-le régulièrement).

## Vérifications

```bash
npm test
```

19 tests (fournisseur IA et Stripe simulés, aucun crédit consommé), dont les comptes, les crédits (débit, refus, remboursement), les webhooks Stripe (signature, doublons, annuel, résiliation), l'enchaînement d'une vidéo de 15 s, et le parcours complet « créer un personnage → Mix / Move → même musique » :

- **Import** : faux fichier vidéo, image envoyée comme vidéo, vidéo trop longue (refusée sans coupure), image trop petite, audio trop lourd, fichiers refusés supprimés, estimation du coût conforme à la formule fal.
- **Génération** : passage réel par les états attente et génération, vidéo envoyée à l'IA en MP4 muet, paramètres exacts transmis, lecture partielle (Range, nécessaire sur iPhone), téléchargement, jeton invalide refusé, limites de concurrence et quotidienne.
- **Erreurs** : erreur du fournisseur affichée avec son type, aucun résultat, fichiers nettoyés, réutilisation impossible.
- **Audio final** : la vidéo de test contient un bip à exactement 2,0 s ; dans la vidéo finale il est mesuré à 2,0 s (± 60 ms), le flux vidéo de l'IA (16 i/s) est conservé tel quel ; musique de remplacement ajustée ; vidéo IA plus courte signalée ; source muette signalée.
- **Intégration fal** (requêtes simulées) : URL de file d'attente, en-tête `Authorization: Key …`, en-têtes de conservation, utilisation des URL de suivi renvoyées, messages d'erreur 401 et 422, annulation.

**Premier essai réel recommandé** : une vidéo de 3 à 5 s en 480p (≈ 0,20 $ à 0,40 $ à 25–30 i/s), pour valider la clé, les crédits et l'envoi avant des vidéos plus longues.
