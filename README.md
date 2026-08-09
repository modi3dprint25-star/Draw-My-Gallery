# Draw My Gallery — version pair-à-pair (WebRTC / PeerJS)

Le jeu est maintenant **100% client** : plus de serveur Express/Socket.io.
`server.js` n'est plus utilisé (tu peux le supprimer).

## Comment ça marche

- Le joueur qui **crée** une partie devient l'**hôte** : son navigateur fait
  tourner toute la logique de jeu (auparavant dans `server.js`, maintenant
  dans `host-logic.js`) et joue le rôle du serveur.
- Les autres joueurs se connectent **directement** au navigateur de l'hôte
  via une connexion WebRTC (`net.js`, basé sur [PeerJS](https://peerjs.com)).
- Le seul service externe utilisé est le **broker de signalisation public**
  de PeerJS (`cloud.peerjs.com`, gratuit) : il sert uniquement à mettre les
  navigateurs en relation au tout début. Ensuite, toutes les données de jeu
  (photos, dessins, textes) transitent **en direct entre navigateurs**, sans
  jamais passer par un serveur intermédiaire.
- Le code de salon à 6 caractères affiché dans le lobby est littéralement
  l'identifiant PeerJS de l'hôte (préfixé `dmg-`) : rejoindre une partie,
  c'est se connecter directement à ce pair.

## Fichiers ajoutés / modifiés

- `net.js` (nouveau) — couche réseau qui imite l'API socket.io
  (`socket.on` / `socket.emit`) par-dessus PeerJS, pour que le reste du
  code change le moins possible.
- `host-logic.js` (nouveau) — portage quasi 1:1 de la logique métier de
  `server.js`, exécutée dans l'onglet de l'hôte au lieu d'un serveur.
- `app.js` — quasi inchangé ; seuls les points de connexion (création /
  rejoindre un salon, déconnexion) ont été adaptés.
- `index.html` — le script `socket.io.js` est remplacé par PeerJS (CDN) +
  `net.js` + `host-logic.js`.
- `package.json` — plus de dépendances serveur ; le site est statique.

## Lancer en local

Comme c'est un site statique, n'importe quel serveur de fichiers suffit :

```bash
npm start          # ou : npx http-server . -p 8080
```

Puis ouvre `http://localhost:8080`.

## Déployer

Le dossier entier (`index.html`, `app.js`, `net.js`, `host-logic.js`,
`style.css`) peut être hébergé tel quel sur n'importe quel hébergeur
statique : GitHub Pages, Netlify, Vercel, Cloudflare Pages, etc. — aucun
backend à déployer.

## Limites à connaître

- **L'hôte doit garder son onglet ouvert** pendant toute la partie : c'est
  lui qui fait tourner la partie. S'il ferme l'onglet ou perd sa connexion,
  la partie s'arrête pour tout le monde (pas de migration d'hôte).
- **Traversée NAT** : la config par défaut utilise seulement des serveurs
  STUN publics (Google). Ça suffit dans la grande majorité des cas
  (réseaux domestiques, 4G/5G), mais certains réseaux très restrictifs
  (proxy d'entreprise, NAT symétrique strict) peuvent bloquer la connexion
  directe. Pour fiabiliser à 100 %, ajoute un serveur **TURN** (ex : offres
  gratuites Twilio ou Metered.ca) dans `PEERJS_OPTIONS.config.iceServers`
  en haut de `net.js`.
- **Pas de reconnexion automatique** si un invité perd temporairement sa
  connexion : il doit rejoindre à nouveau avec le code du salon (le lobby
  actuel gère la reprise ; en pleine manche, mieux vaut rester connecté).
- **Le broker PeerJS public est partagé** avec tous les utilisateurs de
  PeerJS dans le monde ; le préfixe `dmg-` limite fortement le risque de
  collision de code de salon, mais pour un usage intensif tu peux
  héberger [ton propre serveur PeerJS](https://github.com/peers/peerjs-server)
  (léger, open-source) et pointer `net.js` dessus.
