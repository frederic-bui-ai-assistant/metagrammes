# Mot à Mot

Jeu à deux joueurs : à tour de rôle, chacun change **une seule lettre** du mot courant pour atteindre le mot d'arrivée
(ex. `CHAT → CHAP → CHIP → CHUP → CHUT`). Le premier qui forme le mot d'arrivée gagne.

- Site 100 % statique (HTML/CSS/JS, aucun build) → déployable tel quel sur GitHub Pages
- Comptes, parties, coups et temps réel via **Supabase** (Auth + Postgres + Realtime)
- Les règles (1 lettre exactement, tour de jeu, mot déjà utilisé…) sont vérifiées **côté base de données** : impossible de tricher depuis le navigateur
- Notifications quand c'est ton tour : notification système, toast, bip et compteur dans le titre de l'onglet

## 1. Supabase

1. Crée un projet sur [supabase.com](https://supabase.com).
2. **SQL Editor** → colle le contenu de `supabase/schema.sql` → **Run**.
3. **Project Settings → API** : copie *Project URL* et la clé *anon public* dans `site/config.js`.
4. **Authentication → Providers → Email** : pour tester vite, tu peux désactiver « Confirm email ».
   Sinon, laisse-le activé et renseigne **Authentication → URL Configuration → Site URL** avec l'adresse GitHub Pages.

> La clé `anon` est publique par conception ; la sécurité repose sur les règles RLS et les fonctions du schéma.

## 2. GitHub Pages

1. Pousse ce dépôt sur GitHub (branche `main`).
2. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
3. Le workflow `.github/workflows/pages.yml` publie le dossier `site/` à chaque push.
   L'adresse sera `https://<utilisateur>.github.io/<dépôt>/`.

## 3. Jouer

1. Chaque joueur crée un compte (pseudo, email, mot de passe).
2. Un joueur lance une partie (mot de départ + mot d'arrivée de même longueur), puis envoie le lien d'invitation, ou l'autre joueur la rejoint depuis la liste « Parties à rejoindre ».
3. Le créateur joue en premier. Un mot déjà utilisé dans la partie ne peut pas être rejoué.
4. Clique sur « 🔔 Activer les notifications » pour être prévenu quand c'est ton tour.

## Notifications : ce qui est (et n'est pas) couvert

Les notifications arrivent en temps réel tant que le site est ouvert dans un onglet ou sur mobile en arrière-plan
(le navigateur doit rester actif). Pour recevoir une alerte **navigateur fermé**, il faut du Web Push :
une Edge Function Supabase + clés VAPID + abonnement push. C'est une extension possible, non incluse ici.

## Limites connues

- Aucun dictionnaire : les mots ne sont pas vérifiés (jeu sur la confiance entre joueurs).
- Mots de 2 à 12 lettres, accents français acceptés (é, è, ç, œ…).

## Structure

```
site/                  # le site (déployé sur Pages)
  index.html style.css app.js config.js sw.js icon.svg
supabase/schema.sql    # tables, RLS, fonctions de jeu, realtime
.github/workflows/pages.yml
```
