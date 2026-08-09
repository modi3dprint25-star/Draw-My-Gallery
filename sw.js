/**
 * sw.js — Service worker minimal pour "Draw My Gallery".
 *
 * Son seul rôle : exister et être enregistré. Chrome/Android exige un
 * service worker avec un handler `fetch` pour considérer un site comme
 * une PWA "installable" (et donc afficher l'icône sur l'écran d'accueil
 * SANS le petit badge du navigateur dessus). On ne fait volontairement
 * aucun cache offline ici pour ne pas risquer de servir une version
 * périmée du jeu (net.js/host-logic.js changent vite) — chaque requête
 * part simplement au réseau, comme si le service worker n'existait pas.
 */

const VERSION = "v1";

self.addEventListener("install", (event) => {
  // Active la nouvelle version tout de suite, sans attendre la fermeture
  // des anciens onglets.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass-through pur : on laisse le réseau gérer, pas de cache.
  // Ce handler doit juste exister pour satisfaire les critères
  // d'installabilité de Chrome.
  event.respondWith(fetch(event.request));
});
