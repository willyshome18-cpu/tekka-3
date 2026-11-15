# Tekka — boutique en ligne

Livraison à domicile ou retrait en boutique, avec un panneau admin pour gérer produits, photos, prix, commandes, boutiques et frais de livraison.

Aucune dépendance : il suffit de Node.js 18 ou plus récent (pas de `npm install`).

## Lancer sur un ordinateur
```
node server.js
```
- Boutique : http://localhost:3000
- Admin : http://localhost:3000/admin.html

Mot de passe admin par défaut : `smallstartup`. Pour en choisir un autre, définissez la variable `ADMIN_PASSWORD` avant de lancer.

## Mettre en ligne (exemple : Railway)
1. Déposer ce dossier dans un dépôt GitHub.
2. Sur railway.com : « New project » → « Deploy from GitHub repo » → choisir le dépôt.
3. Onglet **Variables**, ajouter :
   - `ADMIN_PASSWORD` = votre mot de passe solide
   - `DATA_DIR` = `/data`
   - `UPLOAD_DIR` = `/data/uploads`
   - `TRUST_PROXY` = `1`
4. Ajouter un **Volume** (stockage qui ne s'efface pas) monté sur `/data`.
5. Onglet **Settings** → **Networking** → « Generate Domain » pour obtenir l'adresse publique.

Sans volume, les produits, commandes et photos sont perdus à chaque redémarrage.

## Données
- Tout est enregistré dans `data/` (JSON) et `uploads/` (photos), ou dans `DATA_DIR` / `UPLOAD_DIR` si définis. Sauvegardez-les régulièrement.
- Le paiement se fait à la livraison ou en boutique (pas de paiement en ligne).
