/**
 * Draw My Gallery — app.js (v2, chaîne façon Gartic Phone)
 * ------------------------------------------------------------
 * Le tirage aléatoire + accepter/refuser de la photo est géré ici,
 * côté client, tant que la photo n'est pas acceptée (rien n'est
 * envoyé au serveur avant validation -> confidentialité du tirage).
 *
 * Dessin tactile/souris : Pointer Events (pointerdown/move/up/cancel)
 * qui couvrent nativement touchstart/touchmove/touchend ET la souris
 * en un seul code path, avec `touch-action: none` en CSS.
 * ------------------------------------------------------------
 */

const socket = Net; // couche réseau P2P (voir net.js) — même API que socket.io

// Enregistre le service worker : nécessaire pour que Chrome/Android
// propose une vraie installation PWA (icône sur l'écran d'accueil sans
// le petit badge du navigateur dans le coin). Voir sw.js.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("[pwa] échec d'enregistrement du service worker :", err);
    });
  });
}

const AVATARS = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐵", "🦄", "🐙", "🦖", "🐧", "🐝", "🦋"];
const SWATCH_COLORS = ["#1a1a1a", "#ffffff", "#ff5b5b", "#ff8a3d", "#ffcb3d", "#3ddc84", "#22d3c9", "#7c4dff", "#ff4fa3"];

const state = {
  me: { name: "", avatar: AVATARS[0] },
  room: null,
  isHost: false,
  drawing: {
    strokes: [], currentStroke: null, tool: "pen", color: "#1a1a1a", size: 8, mode: "normal", rafId: null, modeStart: null,
  },
  gallery: { pool: [], shown: [], candidateFile: null, candidateObjectUrl: null },
};

// ------------------------------------------------------------------
// Navigation / utilitaires
// ------------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ------------------------------------------------------------------
// ECRAN ACCUEIL
// ------------------------------------------------------------------
const avatarPicker = document.getElementById("avatar-picker");
AVATARS.forEach((a, i) => {
  const btn = document.createElement("button");
  btn.className = "avatar-option" + (i === 0 ? " selected" : "");
  btn.textContent = a;
  btn.type = "button";
  btn.addEventListener("click", () => {
    state.me.avatar = a;
    document.querySelectorAll(".avatar-option").forEach((el) => el.classList.remove("selected"));
    btn.classList.add("selected");
  });
  avatarPicker.appendChild(btn);
});

function readNameInput() {
  const val = document.getElementById("input-name").value.trim();
  state.me.name = val || `Joueur${Math.floor(Math.random() * 1000)}`;
  return state.me.name;
}

// ------------------------------------------------------------------
// INSTALLATION PWA — bouton "📲 Installer l'app" qui n'apparaît que si le
// navigateur propose l'installation (Chrome/Edge/Android via
// `beforeinstallprompt`), et qui disparaît dès que l'app est installée
// (événement `appinstalled`) ou qu'on la lance déjà en mode standalone
// (l'utilisateur est déjà dans l'app installée, pas besoin du bouton).
// Sur iPhone/Safari, qui ne déclenche jamais `beforeinstallprompt`, le
// bouton reste simplement caché (l'installation s'y fait via le partage
// natif "Ajouter à l'écran d'accueil", pas via un bouton in-app).
// ------------------------------------------------------------------
(function setupInstallPrompt() {
  const btn = document.getElementById("btn-install-app");

  function isStandalone() {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.navigator.standalone === true // iOS Safari, si jamais lancé via l'icône
    );
  }
  if (isStandalone()) return; // déjà installée et ouverte comme app : bouton inutile

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.classList.remove("hidden");
  });
  btn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    btn.disabled = true;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } finally {
      deferredPrompt = null;
      btn.disabled = false;
    }
  });
  window.addEventListener("appinstalled", () => {
    btn.classList.add("hidden");
    deferredPrompt = null;
  });
})();

// ------------------------------------------------------------------
// TUTORIEL ANIMÉ "Comment jouer ?"
// ------------------------------------------------------------------
(function setupTutorial() {
  const overlay = document.getElementById("tutorial-overlay");
  const track = document.getElementById("tutorial-slides");
  const dotsWrap = document.getElementById("tutorial-dots");
  const slides = Array.from(track.children);
  const btnPrev = document.getElementById("btn-tutorial-prev");
  const btnNext = document.getElementById("btn-tutorial-next");
  const btnClose = document.getElementById("btn-tutorial-close");
  const btnOpen = document.getElementById("btn-how-to-play");
  let step = 0;

  slides.forEach((_, i) => {
    const dot = document.createElement("span");
    dot.className = "tutorial-dot" + (i === 0 ? " active" : "");
    dotsWrap.appendChild(dot);
  });
  const dots = Array.from(dotsWrap.children);

  function render() {
    track.style.transform = `translateX(-${step * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle("active", i === step));
    btnPrev.disabled = step === 0;
    btnNext.textContent = step === slides.length - 1 ? "C'est parti ! 🎨" : "Suivant ➡️";
  }

  function open() {
    step = 0;
    render();
    overlay.classList.remove("hidden");
    try { localStorage.setItem("dmg_seen_tutorial", "1"); } catch {}
  }
  function close() {
    overlay.classList.add("hidden");
  }

  btnOpen.addEventListener("click", open);
  btnClose.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
  btnPrev.addEventListener("click", () => { if (step > 0) { step -= 1; render(); } });
  btnNext.addEventListener("click", () => {
    if (step < slides.length - 1) { step += 1; render(); } else { close(); }
  });

  // Ouverture automatique une seule fois, au tout premier lancement sur cet appareil.
  try {
    if (!localStorage.getItem("dmg_seen_tutorial")) open();
  } catch {}
})();

// ------------------------------------------------------------------
// LIEN D'INVITATION (?join=CODE) — pré-remplit le code au chargement
// ------------------------------------------------------------------
(function prefillJoinCodeFromUrl() {
  const params = new URLSearchParams(location.search);
  const joinCode = params.get("join");
  if (!joinCode) return;
  const codeInput = document.getElementById("input-code");
  codeInput.value = joinCode.trim().toUpperCase().slice(0, 6);
  document.getElementById("input-name").focus();
  toast("Code de salon rempli, entre ton pseudo et rejoins !");
})();

function inviteLinkFor(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("join", code);
  return url.toString();
}

document.getElementById("btn-copy-invite").addEventListener("click", async () => {
  const code = state.room?.code;
  if (!code) return;
  const link = inviteLinkFor(code);
  try {
    await navigator.clipboard.writeText(link);
    toast("Lien d'invitation copié !");
  } catch {
    window.prompt("Copie ce lien :", link);
  }
});

document.getElementById("btn-create").addEventListener("click", () => {
  readNameInput();
  const btn = document.getElementById("btn-create");
  btn.disabled = true;
  toast("Ouverture du salon…");
  Net.startHosting(
    (peerId, code) => {
      const res = HostLogic.createRoom(code, peerId, { name: state.me.name, avatar: state.me.avatar });
      btn.disabled = false;
      if (!res.ok) return toast(res.error || "Erreur");
      enterLobby(res.room);
    },
    (err) => {
      btn.disabled = false;
      console.error(err);
      toast("Impossible d'ouvrir un salon (réseau P2P indisponible).");
    }
  );
});
document.getElementById("input-code").addEventListener("input", (e) => {
  const el = e.target;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.toUpperCase();
  // On remet le curseur où il était : sans ça, la conversion en majuscule
  // renvoie le curseur en fin de champ à chaque frappe sur certains navigateurs.
  if (start !== null) el.setSelectionRange(start, end);
});
document.getElementById("btn-join").addEventListener("click", () => {
  readNameInput();
  const code = document.getElementById("input-code").value.trim().toUpperCase();
  if (!code) return toast("Entre un code de salon");
  const btn = document.getElementById("btn-join");
  btn.disabled = true;
  toast("Connexion au salon…");
  Net.connectToHost(
    code,
    () => {
      socket.emit("join_room", { name: state.me.name, avatar: state.me.avatar }, (res) => {
        btn.disabled = false;
        if (!res.ok) return toast(res.error || "Erreur");
        enterLobby(res.room);
      });
    },
    (errMsg) => {
      btn.disabled = false;
      toast(errMsg);
    }
  );
});

// ------------------------------------------------------------------
// ECRAN LOBBY
// ------------------------------------------------------------------
function enterLobby(room) {
  state.room = room;
  showScreen("screen-lobby");
  renderLobby();
}

document.getElementById("btn-leave-lobby").addEventListener("click", () => {
  socket.emit("leave_room");
  Net.teardown();
  location.reload();
});

document.querySelectorAll("#duration-options .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (!state.isHost) return;
    socket.emit("update_settings", { drawDuration: Number(chip.dataset.duration) });
  });
});
document.querySelectorAll("#mode-options .mode-card").forEach((card) => {
  card.addEventListener("click", () => {
    if (!state.isHost) {
      // Invité : pas de contrôle sur les réglages réels, on pose juste son
      // avatar sur la carte pour montrer à l'hôte ce qu'on aimerait.
      socket.emit("vote_mode", { mode: card.dataset.mode });
      return;
    }
    const mode = card.dataset.mode;
    const current = new Set(state.room?.settings?.modes || ["normal"]);
    if (current.has(mode)) {
      if (current.size > 1) current.delete(mode);
    } else {
      current.add(mode);
    }
    socket.emit("update_settings", { modes: Array.from(current) });
  });
});
// Cases "modes spéciaux" : chacune bascule un simple booléen dans les réglages,
// en s'appuyant sur data-toggle pour retrouver la bonne clé de settings.
// Cases "modes spéciaux" : un seul actif à la fois par partie, à l'exception
// de "Description en 5 mots" qui peut toujours se cumuler avec "Tours de
// description" (ils vont ensemble). Cliquer un effet déjà actif l'éteint ;
// cliquer un autre effet remplace l'ancien.
const EXCLUSIVE_EFFECT_KEYS = ["descriptionMode", "impostorMode", "loopbackMode", "qualityVoteMode"];
document.querySelectorAll("#special-options .mode-card[data-toggle]").forEach((card) => {
  card.addEventListener("click", () => {
    if (!state.isHost) {
      socket.emit("vote_effect", { effect: card.dataset.toggle });
      return;
    }
    const key = card.dataset.toggle;
    if (key === "constrainedDescription") {
      // Exception : indépendant de l'exclusivité, se cumule avec descriptionMode.
      socket.emit("update_settings", { constrainedDescription: !(state.room?.settings?.constrainedDescription) });
      return;
    }
    const turningOn = !(state.room?.settings?.[key]);
    const payload = {};
    for (const k of EXCLUSIVE_EFFECT_KEYS) payload[k] = k === key ? turningOn : false;
    // "Description en 5 mots" n'a de sens que si "Tours de description" reste actif.
    if (key === "descriptionMode" && !turningOn) payload.constrainedDescription = false;
    socket.emit("update_settings", payload);
  });
});

// ---- Avatars de préférence des invités sur les cartes de mode/effet ----
// state.room.modeVotes / effectVotes : { playerId: cardKey }.
// On regroupe par carte, puis on aligne les avatars des votants sur chaque
// carte concernée (et on nettoie les cartes qui n'en ont plus).
function renderModeVoteAvatars() {
  const room = state.room;
  document.querySelectorAll(".mode-card").forEach((card) => {
    let row = card.querySelector(".mode-card-votes");
    if (!row) {
      row = document.createElement("div");
      row.className = "mode-card-votes";
      card.appendChild(row);
    }
    row.innerHTML = "";
  });
  if (!room) return;
  const modeVotes = room.modeVotes || {};
  const effectVotes = room.effectVotes || {};
  const playersById = new Map((room.players || []).map((p) => [p.id, p]));

  // Regroupe puis pose les avatars, carte par carte.
  function fill(votesObj, cardFor) {
    const byCard = new Map();
    for (const [playerId, key] of Object.entries(votesObj)) {
      const player = playersById.get(playerId);
      if (!player || !key) continue;
      if (!byCard.has(key)) byCard.set(key, []);
      byCard.get(key).push(player);
    }
    byCard.forEach((players, key) => {
      const card = cardFor(key);
      if (!card) return;
      const row = card.querySelector(".mode-card-votes");
      players.forEach((p) => {
        const el = document.createElement("span");
        el.className = "mode-card-vote-avatar";
        el.textContent = p.avatar || "🙂";
        el.title = p.name || "";
        row.appendChild(el);
      });
    });
  }
  fill(modeVotes, (mode) => document.querySelector(`#mode-options .mode-card[data-mode="${mode}"]`));
  fill(effectVotes, (effect) => document.querySelector(`#special-options .mode-card[data-toggle="${effect}"]`));
}
document.getElementById("btn-start-game").addEventListener("click", () => {
  socket.emit("start_game");
});

// Petits boutons "i" sur les cartes de mode : affichent/masquent la description
// au tap, sans déclencher la sélection du mode (le clic ne doit pas remonter
// jusqu'au bouton .mode-card parent).
function closeAllModeInfo(except) {
  document.querySelectorAll(".mode-card-desc.open").forEach((d) => {
    if (d !== except) d.classList.remove("open");
  });
}
document.querySelectorAll(".mode-card-info").forEach((info) => {
  const toggleInfo = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const desc = info.closest(".mode-card").querySelector(".mode-card-desc");
    const willOpen = !desc.classList.contains("open");
    closeAllModeInfo(willOpen ? desc : null);
    desc.classList.toggle("open", willOpen);
  };
  info.addEventListener("click", toggleInfo);
  info.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggleInfo(e);
  });
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".mode-card")) closeAllModeInfo();
});

function renderLobby() {
  const room = state.room;
  if (!room) return;

  document.getElementById("lobby-room-code").textContent = room.code;
  state.isHost = room.hostId === socket.id;

  const list = document.getElementById("lobby-player-list");
  list.innerHTML = "";
  room.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="p-avatar">${p.avatar}</span>
      <span>${escapeHtml(p.name)}</span>
      ${p.isHost ? '<span class="host-badge">HÔTE</span>' : ""}
      <span class="p-status">${p.connected ? "🟢" : "🔴"}</span>
    `;
    list.appendChild(li);
  });
  document.getElementById("lobby-player-count").textContent = `(${room.players.length}/${room.maxPlayers || 12})`;

  document.querySelectorAll("#duration-options .chip").forEach((chip) => {
    chip.classList.toggle("selected", Number(chip.dataset.duration) === room.settings.drawDuration);
    chip.disabled = !state.isHost;
  });
  document.querySelectorAll("#mode-options .mode-card").forEach((card) => {
    card.classList.toggle("selected", room.settings.modes.includes(card.dataset.mode));
    // Les invités restent cliquables : ça leur sert à voter (poser leur avatar),
    // pas à changer le réglage réel (réservé à l'hôte, géré dans le handler de clic).
  });
  document.querySelectorAll("#special-options .mode-card[data-toggle]").forEach((card) => {
    const key = card.dataset.toggle;
    card.classList.toggle("selected", !!room.settings[key]);
  });
  // "Description en 5 mots" n'a de sens qu'avec les tours de description activés
  // — ce verrou ne s'applique qu'à l'action de l'hôte, pas au vote des invités.
  const constrainedCard = document.getElementById("chip-constrained-description");
  constrainedCard.disabled = state.isHost && !room.settings.descriptionMode;

  document.getElementById("btn-start-game").classList.toggle("hidden", !state.isHost);
  document.getElementById("lobby-not-host").classList.toggle("hidden", state.isHost);
  document.getElementById("lobby-hint").classList.toggle("hidden", !state.isHost);
  renderModeVoteAvatars();
}

socket.on("room_state", (room) => {
  state.room = room;
  if (document.getElementById("screen-lobby").classList.contains("active")) renderLobby();
  if (document.getElementById("screen-gallery").classList.contains("active")) renderGalleryWaitList(room);
  if (room.phase === "scoreboard") {
    document.getElementById("btn-play-again").classList.toggle("hidden", room.hostId !== socket.id);
  }
});
// "room_state" seul ne fait que rafraîchir l'écran actif s'il s'agit déjà du
// lobby ou de la galerie : il ne fait jamais revenir en arrière depuis le
// tableau des scores. Après un clic sur "Rejouer", l'hôte envoie cet
// événement dédié pour que tout le monde retourne vraiment au lobby.
socket.on("phase_lobby_start", (room) => {
  enterLobby(room);
});
socket.on("error_message", (msg) => toast(msg));
socket.on("host_disconnected", () => {
  toast("L'hôte a quitté la partie. Retour à l'accueil…");
  setTimeout(() => { Net.teardown(); location.reload(); }, 1800);
});

function renderGalleryWaitList(room) {
  const list = document.getElementById("gallery-wait-list");
  list.innerHTML = "";
  room.players.filter((p) => p.connected).forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="p-avatar">${p.avatar}</span>
      <span>${escapeHtml(p.name)}${p.id === socket.id ? " (toi)" : ""}</span>
      <span class="p-status">${p.photoValidated ? "✅" : "⏳"}</span>
    `;
    list.appendChild(li);
  });
}

// ------------------------------------------------------------------
// ECRAN TIRAGE & VALIDATION DE LA PHOTO
// ------------------------------------------------------------------
socket.on("phase_photo_validation_start", () => {
  state.gallery = { pool: [], shown: [], candidateFile: null, candidateObjectUrl: null };
  document.getElementById("draw-photo-zone").classList.add("hidden");
  document.getElementById("gallery-status").textContent = "";
  document.getElementById("btn-pick-gallery").disabled = false;
  document.getElementById("btn-pick-gallery").classList.remove("hidden");
  document.getElementById("btn-pick-gallery").textContent = "📂 Ouvrir ma galerie";
  document.getElementById("gallery-pool-count").classList.add("hidden");
  if (state.room) renderGalleryWaitList(state.room);
  showScreen("screen-gallery");
});

document.getElementById("btn-pick-gallery").addEventListener("click", () => {
  document.getElementById("gallery-input").click();
});
document.getElementById("gallery-input").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
  e.target.value = ""; // permet de resélectionner les mêmes fichiers plus tard si besoin
  if (files.length === 0) return toast("Choisis au moins une image.");
  // On ajoute au pool existant : le joueur donne juste accès à un lot de photos,
  // c'est le jeu qui pioche seul dedans au hasard (voir drawRandomCandidate) —
  // le joueur ne choisit jamais laquelle sort, il ne fait que dire oui/non.
  state.gallery.pool.push(...files);
  document.getElementById("btn-pick-gallery").textContent = "📂 Ajouter encore plus de photos";
  updateGalleryPoolCount();
  drawRandomCandidate();
});

function updateGalleryPoolCount() {
  const g = state.gallery;
  const total = g.pool.length + g.shown.length;
  const countEl = document.getElementById("gallery-pool-count");
  document.getElementById("gallery-pool-count-num").textContent = String(total);
  countEl.classList.toggle("hidden", total === 0);
}

function drawRandomCandidate(skippedCount = 0) {
  const g = state.gallery;
  if (g.pool.length === 0) {
    if (g.shown.length === 0) {
      document.getElementById("gallery-status").textContent = "Choisis au moins une photo pour continuer.";
      return;
    }
    // Tout a été refusé : on remet en jeu les photos déjà vues (sauf la dernière montrée)
    g.pool = g.shown.slice(0, -1);
    g.shown = g.shown.slice(-1);
    if (g.pool.length === 0) g.pool = g.shown.slice(); // 1 seule photo dispo au total
  }
  const idx = Math.floor(Math.random() * g.pool.length);
  const file = g.pool.splice(idx, 1)[0];
  g.shown.push(file);
  g.candidateFile = file;

  if (g.candidateObjectUrl) URL.revokeObjectURL(g.candidateObjectUrl);
  g.candidateObjectUrl = URL.createObjectURL(file);

  const previewEl = document.getElementById("draw-photo-preview");
  document.getElementById("draw-photo-zone").classList.remove("hidden");
  document.getElementById("gallery-status").textContent = "";
  document.getElementById("btn-refuse-photo").disabled = false;
  updateGalleryPoolCount();

  // Certaines photos (ex : HEIC prises sur iPhone) ne se décodent pas dans une
  // balise <img> sur certains navigateurs — l'aperçu resterait vide sans qu'on
  // le sache. On le détecte ici et on repioche automatiquement à la place.
  previewEl.onerror = () => {
    if (skippedCount >= 8) {
      document.getElementById("gallery-status").textContent =
        "Ces photos ne peuvent pas s'afficher sur cet appareil (format non supporté). Essaie d'en ajouter d'autres.";
      document.getElementById("draw-photo-zone").classList.add("hidden");
      return;
    }
    toast("Cette photo ne s'affiche pas sur cet appareil, on en tire une autre…");
    drawRandomCandidate(skippedCount + 1);
  };
  previewEl.src = g.candidateObjectUrl;
}

document.getElementById("btn-refuse-photo").addEventListener("click", () => {
  const g = state.gallery;
  if (g.pool.length === 0 && g.shown.length <= 1) {
    toast("Ajoute d'autres photos pour pouvoir en refuser une.");
    document.getElementById("gallery-input").click();
    return;
  }
  drawRandomCandidate();
});

document.getElementById("btn-accept-photo").addEventListener("click", async () => {
  const g = state.gallery;
  if (!g.candidateFile) return;
  document.getElementById("btn-accept-photo").disabled = true;
  document.getElementById("btn-refuse-photo").disabled = true;
  document.getElementById("gallery-status").textContent = "Préparation de l'image…";
  try {
    // Compression forcée sous un plafond de poids : une image trop lourde qui passe
    // "parfois" et "parfois pas" sur la connexion P2P est la cause la plus fréquente
    // d'une photo qui ne s'affiche jamais chez les autres joueurs.
    const dataUrl = await compressImageToDataUrl(g.candidateFile, 1024, 0.75, 700 * 1024);
    socket.emit("validate_photo", { dataUrl }, (res) => {
      if (!res.ok) {
        toast(res.error || "Envoi impossible, réessaie.");
        document.getElementById("btn-accept-photo").disabled = false;
        document.getElementById("btn-refuse-photo").disabled = false;
        document.getElementById("gallery-status").textContent = "";
        return;
      }
      document.getElementById("gallery-status").textContent = "✅ Photo validée ! En attente des autres joueurs…";
      document.getElementById("draw-photo-zone").classList.add("hidden");
    });
  } catch {
    toast("Image illisible, réessaie.");
    document.getElementById("btn-accept-photo").disabled = false;
    document.getElementById("btn-refuse-photo").disabled = false;
    document.getElementById("gallery-status").textContent = "";
  }
});

/**
 * Redimensionne + compresse une image côté client avant envoi, en réduisant
 * qualité puis résolution tant que le résultat dépasse `maxBytes`. Garantit
 * un envoi léger et fiable sur la connexion P2P (WebRTC).
 */
function compressImageToDataUrl(file, maxDim, quality, maxBytes = 700 * 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        try {
          resolve(downscaleToDataUrl(img, img.width, img.height, maxDim, quality, maxBytes));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Même logique que ci-dessus, mais à partir d'un <canvas> déjà dessiné (dessins de manche). */
function canvasToSafeDataUrl(sourceCanvas, maxDim = 900, quality = 0.85, maxBytes = 700 * 1024) {
  return downscaleToDataUrl(sourceCanvas, sourceCanvas.width, sourceCanvas.height, maxDim, quality, maxBytes);
}

function downscaleToDataUrl(source, srcWidth, srcHeight, maxDim, quality, maxBytes) {
  let width = srcWidth, height = srcHeight;
  if (width > height && width > maxDim) {
    height = Math.round((height * maxDim) / width); width = maxDim;
  } else if (height > maxDim) {
    width = Math.round((width * maxDim) / height); height = maxDim;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const c2d = canvas.getContext("2d");
  c2d.fillStyle = "#ffffff";
  c2d.fillRect(0, 0, width, height);
  c2d.drawImage(source, 0, 0, width, height);

  let q = quality;
  let dataUrl = canvas.toDataURL("image/jpeg", q);
  let attempts = 0;
  while (dataUrl.length > maxBytes && attempts < 6) {
    attempts += 1;
    if (q > 0.4) {
      q -= 0.15;
    } else {
      canvas.width = Math.round(canvas.width * 0.8);
      canvas.height = Math.round(canvas.height * 0.8);
      c2d.fillStyle = "#ffffff";
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      c2d.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    dataUrl = canvas.toDataURL("image/jpeg", q);
  }
  return dataUrl;
}

/**
 * Affiche un contenu de secours propre quand une image reçue via le réseau
 * P2P n'arrive pas ou ne se décode pas, au lieu de l'icône d'image cassée
 * du navigateur (c'est ce qui donne l'impression que "l'image ne s'affiche pas").
 */
function setImageWithFallback(imgEl, src, fallbackText) {
  hideInlineFallback(imgEl);
  if (!src) {
    imgEl.removeAttribute("src");
    imgEl.style.display = "none";
    showInlineFallback(imgEl, fallbackText);
    return;
  }
  imgEl.style.display = "";
  imgEl.onerror = () => {
    imgEl.style.display = "none";
    showInlineFallback(imgEl, fallbackText);
  };
  imgEl.src = src;
}
function showInlineFallback(imgEl, text) {
  let ph = imgEl.nextElementSibling;
  if (!ph || !ph.classList?.contains("img-fallback")) {
    ph = document.createElement("div");
    ph.className = "img-fallback";
    imgEl.insertAdjacentElement("afterend", ph);
  }
  ph.textContent = "🖼️ " + (text || "Image indisponible");
  ph.classList.remove("hidden");
}
function hideInlineFallback(imgEl) {
  const ph = imgEl.nextElementSibling;
  if (ph && ph.classList?.contains("img-fallback")) ph.classList.add("hidden");
}

// ------------------------------------------------------------------
// ROUND : dispatch dessin / description
// ------------------------------------------------------------------
const MODE_LABELS = {
  normal: "✏️ Normal",
  blind: "🙈 Les yeux fermés",
  upside_down: "🙃 Tête à l'envers",
  wobbly: "🫨 Tremblote",
  giant_brush: "🖍️ Pinceau XXL",
  mystery_color: "🎨 Couleur mystère",
  manege: "🎠 Manège",
  derive: "🌊 Dérive",
};
// Couleurs "mystère" possibles pour le mode mystery_color (on évite le blanc, invisible sur fond blanc).
const MYSTERY_COLORS = SWATCH_COLORS.filter((c) => c !== "#ffffff");
let currentRoundType = null;
let currentRoundIndex = null;

const MODE_ICONS = {
  normal: "✏️", blind: "🙈", upside_down: "🙃", wobbly: "🫨",
  giant_brush: "🖍️", mystery_color: "🎨", manege: "🎠", derive: "🌊",
};
const MODE_SHORT_LABELS = {
  normal: "Normal", blind: "Yeux fermés", upside_down: "Tête à l'envers",
  wobbly: "Tremblote", giant_brush: "Pinceau XXL", mystery_color: "Couleur mystère",
  manege: "Manège", derive: "Dérive",
};

// ---- Roulette de mode : une VRAIE roue qui tourne façon roulette de
// casino, au début d'une manche de dessin, uniquement quand plusieurs
// modes sont actifs (sinon rien à tirer, pas de suspense). Se joue sur
// l'écran de TOUS les dessinateurs, avec le MÊME résultat (tiré une
// seule fois côté hôte).
const MODE_WHEEL_COLORS = {
  normal: "var(--teal)", blind: "var(--purple)", upside_down: "var(--pink)",
  wobbly: "var(--orange)", giant_brush: "var(--red)", mystery_color: "var(--yellow)",
  manege: "var(--green)", derive: "var(--blue)",
};
let modeRouletteTimeouts = [];
function clearModeRouletteTimeouts() {
  modeRouletteTimeouts.forEach(clearTimeout);
  modeRouletteTimeouts = [];
}
function scheduleRoulette(fn, ms) {
  modeRouletteTimeouts.push(setTimeout(fn, ms));
}

// -- Reproduit en JS la même courbe cubic-bezier que la transition CSS de
// la roue, pour savoir EXACTEMENT à quel angle elle se trouve à chaque
// instant (sans ça, impossible de faire "cliquer" le pointeur pile au
// passage de chaque case). Algorithme standard (Newton-Raphson). --
function makeCubicBezierEase(p1x, p1y, p2x, p2y) {
  const A = (a1, a2) => 1 - 3 * a2 + 3 * a1;
  const B = (a1, a2) => 3 * a2 - 6 * a1;
  const C = (a1) => 3 * a1;
  const calc = (t, a1, a2) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
  const slope = (t, a1, a2) => 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
  return function ease(x) {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, p1x, p2x);
      if (Math.abs(s) < 1e-6) break;
      t -= (calc(t, p1x, p2x) - x) / s;
    }
    return calc(t, p1y, p2y);
  };
}
const ROULETTE_EASE = makeCubicBezierEase(0.12, 0.72, 0.15, 1);

// -- Petit "tic" synthétisé (aucun fichier audio requis). Best-effort :
// si l'audio est bloqué par le navigateur (pas encore d'interaction),
// on échoue silencieusement, ça reste purement cosmétique. --
function playRouletteTick() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!window.__rouletteAudioCtx) window.__rouletteAudioCtx = new Ctx();
    const ctx = window.__rouletteAudioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 920;
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.04);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  } catch (e) { /* audio indisponible, tant pis */ }
}

// -- Fait "clic" le petit pointeur (comme le cliquet d'une vraie roue de
// loterie qui tape contre chaque case). --
function flickRoulettePointer(pointer) {
  if (!pointer) return;
  pointer.classList.remove("clicking");
  void pointer.offsetWidth; // force le redémarrage de l'animation
  pointer.classList.add("clicking");
  playRouletteTick();
}

// -- Boucle qui suit (en JS, avec la même courbe d'accélération que la
// roue) le passage de chaque séparation de case sous le pointeur pendant
// le spin, et déclenche un "clic" à chaque fois. `spinId` permet
// d'abandonner proprement si une nouvelle roulette démarre entre-temps. --
let rouletteSpinCounter = 0;
function runRouletteClicks(pointer, targetDeg, step, durationMs, spinId) {
  const start = performance.now();
  let lastCrossed = 0;
  function frame(now) {
    if (spinId !== rouletteSpinCounter) return; // une autre roulette a démarré
    const t = Math.min(1, (now - start) / durationMs);
    const angle = ROULETTE_EASE(t) * targetDeg;
    const crossed = Math.floor(angle / step);
    if (crossed > lastCrossed) {
      lastCrossed = crossed;
      flickRoulettePointer(pointer);
    }
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Construit les tranches colorées (dégradé conique) + les icônes
// disposées en rayons, comme sur une vraie roue.
function buildRouletteWheel(modesPool) {
  const wheel = document.getElementById("mode-roulette-wheel");
  const slices = document.getElementById("mode-roulette-slices");
  const n = modesPool.length;
  const step = 360 / n;

  const colorStops = modesPool
    .map((m, i) => `${MODE_WHEEL_COLORS[m] || "var(--purple)"} ${i * step}deg ${(i + 1) * step}deg`)
    .join(", ");
  // Fines lignes de séparation entre les tranches, en plus du dégradé de couleurs.
  const dividerStops = `var(--ink) 0deg 0.6deg, transparent 0.6deg ${step}deg`;
  wheel.style.backgroundImage =
    `repeating-conic-gradient(from 0deg, ${dividerStops}), conic-gradient(from 0deg, ${colorStops})`;

  // Rayon de placement des icônes : dépend de la taille réellement rendue.
  const radius = wheel.getBoundingClientRect().width / 2;
  const iconRadius = Math.max(30, radius * 0.66);

  slices.innerHTML = "";
  modesPool.forEach((m, i) => {
    const centerAngle = i * step + step / 2;
    const label = document.createElement("div");
    label.className = "mode-roulette-slice-label";
    label.style.transform = `rotate(${centerAngle}deg)`;
    const inner = document.createElement("span");
    inner.className = "mode-roulette-slice-inner";
    inner.style.transform = `translate(-50%, ${-iconRadius}px)`;
    inner.textContent = MODE_ICONS[m] || "✏️";
    label.appendChild(inner);
    slices.appendChild(label);
  });

  return step;
}

function setWheelRotation(wheel, deg, transitionCss) {
  wheel.style.transition = transitionCss;
  wheel.style.transform = `rotate(${deg}deg)`;
}

function showModeRoulette(modesPool, winningMode, onDone) {
  const overlay = document.getElementById("mode-roulette");
  const card = overlay.querySelector(".mode-roulette-card");
  const label = document.getElementById("mode-roulette-label");
  const wheelWrap = document.getElementById("mode-roulette-wheel-wrap");
  const wheel = document.getElementById("mode-roulette-wheel");
  const slices = document.getElementById("mode-roulette-slices");
  const pointer = document.getElementById("mode-roulette-pointer");
  const spinId = ++rouletteSpinCounter;

  clearModeRouletteTimeouts();

  // Reset complet pour pouvoir rejouer l'animation à l'identique à chaque tour.
  overlay.className = "mode-roulette hidden";
  card.className = "mode-roulette-card";
  wheelWrap.className = "mode-roulette-wheel-wrap";
  pointer.classList.remove("clicking");
  slices.classList.remove("spinning");
  label.textContent = "🎲 Mode du tour…";
  void overlay.offsetWidth;

  setWheelRotation(wheel, 0, "none");

  overlay.classList.remove("hidden");
  overlay.classList.add("show");

  // Construite une fois visible : getBoundingClientRect() a besoin que
  // l'overlay soit affiché (pas "display:none") pour donner une vraie taille.
  const step = buildRouletteWheel(modesPool);

  // -- 1) Entrée en tournant --
  requestAnimationFrame(() => card.classList.add("mode-roulette-card-enter"));

  // -- 2) Phase principale : la roue tourne vite (plusieurs tours), avec
  // flou de vitesse sur les icônes et un clic du pointeur à chaque case
  // qui passe dessous. Ne couvre que 90% de l'angle total. --
  const MAIN_SPIN_MS = 3200;
  // -- 3) Phase finale : les 10% d'angle restants, étirés sur un temps
  // plus long avec une décélération très marquée → petite pause
  // dramatique juste avant que le pointeur ne se pose. --
  const FINAL_APPROACH_MS = 750;
  const TOTAL_SPIN_MS = MAIN_SPIN_MS + FINAL_APPROACH_MS;
  const SPIN_TURNS = 6;

  scheduleRoulette(() => {
    const winningIndex = modesPool.indexOf(winningMode);
    const centerAngle = winningIndex * step + step / 2;
    const jitter = (Math.random() - 0.5) * step * 0.6;
    const targetDeg = SPIN_TURNS * 360 - (centerAngle + jitter);
    const mainDeg = targetDeg * 0.9;

    slices.style.setProperty("--roulette-spin-ms", `${MAIN_SPIN_MS}ms`);
    slices.classList.add("spinning");
    setWheelRotation(wheel, mainDeg, `transform ${MAIN_SPIN_MS}ms cubic-bezier(0.12, 0.72, 0.15, 1)`);
    runRouletteClicks(pointer, mainDeg, step, MAIN_SPIN_MS, spinId);

    // Enchaîne directement sur la petite approche finale, lente et
    // silencieuse (le suspense se joue dans le ralenti, pas dans le bruit).
    scheduleRoulette(() => {
      setWheelRotation(wheel, targetDeg, `transform ${FINAL_APPROACH_MS}ms cubic-bezier(0.1, 0.4, 0.15, 1)`);
    }, MAIN_SPIN_MS);
  }, 380);

  // -- 4) Résultat : halo lumineux de la couleur du mode + pop --
  scheduleRoulette(() => {
    wheelWrap.classList.add(`mode-roulette-glow-${winningMode}`, "mode-roulette-landed");
    overlay.classList.add(`mode-roulette-bg-${winningMode}`);
    label.textContent = `${MODE_ICONS[winningMode] || "✏️"} ${MODE_SHORT_LABELS[winningMode] || winningMode} !`;
  }, 380 + TOTAL_SPIN_MS);

  // -- 5) Sortie propre --
  scheduleRoulette(() => {
    card.classList.remove("mode-roulette-landed");
    card.classList.add("mode-roulette-card-exit");
    overlay.classList.add("exit");
  }, 380 + TOTAL_SPIN_MS + 900);

  scheduleRoulette(() => {
    overlay.classList.add("hidden");
    overlay.className = "mode-roulette hidden";
    card.className = "mode-roulette-card";
    wheelWrap.className = "mode-roulette-wheel-wrap";
    slices.classList.remove("spinning");
    onDone?.();
  }, 380 + TOTAL_SPIN_MS + 900 + 450);
}

socket.on("phase_round_start", ({ round, roundIndex, totalRounds, type, input, visualMode, modesPool, duration, isImpostor, impostorModeActive, loopback }) => {
  currentRoundType = type;
  currentRoundIndex = roundIndex;
  if (type === "drawing") {
    setupDrawingRound(round, totalRounds, input, visualMode, duration, isImpostor, loopback);
    const afterRoulette = () => { if (impostorModeActive) showImpostorReveal(isImpostor); };
    if (modesPool && modesPool.length > 1) {
      showModeRoulette(modesPool, visualMode, afterRoulette);
    } else {
      afterRoulette();
    }
  } else {
    setupDescribeRound(round, totalRounds, input, duration);
  }
});

// La référence reçue au début de la manche était parfois vide : le joueur
// précédent avait soumis trop tard (connexion P2P lente), après l'expiration
// du délai de grâce côté hôte. L'hôte vient de récupérer le vrai contenu et
// nous le pousse ici, sans réinitialiser le minuteur ni le reste de l'écran.
let impostorRevealTimeoutId = null;
function showImpostorReveal(isImpostor) {
  const overlay = document.getElementById("impostor-reveal");
  const text = document.getElementById("impostor-reveal-text");
  clearTimeout(impostorRevealTimeoutId);

  // Reset complet pour pouvoir rejouer l'animation à l'identique à chaque tour.
  overlay.classList.remove("show", "is-safe", "is-impostor");
  overlay.classList.add("hidden");
  void overlay.offsetWidth; // force le reflow pour repartir de zéro

  text.textContent = isImpostor ? "IMPOSTEUR" : "Tu n'es pas l'imposteur";
  overlay.classList.remove("hidden");
  overlay.classList.add(isImpostor ? "is-impostor" : "is-safe");
  void overlay.offsetWidth;
  overlay.classList.add("show");

  impostorRevealTimeoutId = setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.classList.remove("show");
  }, 3000);
}
socket.on("reference_recovered", ({ input }) => {
  if (currentRoundType === "drawing") {
    const imgWrap = document.getElementById("drawing-reference-image-wrap");
    const textWrap = document.getElementById("drawing-reference-text-wrap");
    if (input.kind === "text") {
      textWrap.classList.remove("hidden");
      imgWrap.classList.add("hidden");
      document.getElementById("reference-text").textContent = input.content || "(aucune description reçue)";
    } else {
      imgWrap.classList.remove("hidden");
      textWrap.classList.add("hidden");
      setImageWithFallback(document.getElementById("reference-photo"), input.content, "Image de référence indisponible");
    }
    toast("Référence récupérée !");
  } else if (currentRoundType === "description") {
    setImageWithFallback(document.getElementById("describe-image"), input.content, "Dessin indisponible");
    toast("Référence récupérée !");
  }
});

// ---- Tour de dessin ----
const canvas = document.getElementById("draw-canvas");
const ctx = canvas.getContext("2d");
const canvasWrap = document.getElementById("canvas-wrap");
let drawSubmitted = false;

function setupDrawingRound(round, totalRounds, input, visualMode, duration, isImpostor, loopback) {
  state.drawing.strokes = [];
  state.drawing.currentStroke = null;
  state.drawing.mode = visualMode || "normal";
  state.drawing.modeStart = Date.now();
  drawSubmitted = false;
  const mode = state.drawing.mode;
  // ---- Modes "🎠 Manège" / "🌊 Dérive" : la surface de dessin tourne ou
  // glisse toute seule. On repart d'une transformation neutre à chaque tour
  // (sinon le canvas resterait tourné/décalé d'un tour précédent).
  canvas.style.transform = "";

  document.getElementById("drawing-round-label").textContent = `Tour ${round}/${totalRounds}`;
  document.getElementById("drawing-mode-label").textContent = MODE_LABELS[mode] || "✏️ Normal";
  document.getElementById("drawing-timer").textContent = duration;
  document.getElementById("btn-submit-drawing").disabled = false;

  // Mode "Imposteur" : mission secrète visible uniquement par le joueur tiré au sort.
  document.getElementById("impostor-hint").classList.toggle("hidden", !isImpostor);

  const imgWrap = document.getElementById("drawing-reference-image-wrap");
  const textWrap = document.getElementById("drawing-reference-text-wrap");
  if (input.kind === "text") {
    textWrap.classList.remove("hidden");
    imgWrap.classList.add("hidden");
    document.getElementById("reference-text").textContent = input.content || "(aucune description reçue)";
  } else {
    imgWrap.classList.remove("hidden");
    textWrap.classList.add("hidden");
    setImageWithFallback(document.getElementById("reference-photo"), input.content, "Image de référence indisponible");
    // Mode "Retour en arrière" : on ne révèle jamais au joueur que c'est sa
    // propre photo de départ — le libellé reste générique pour garder la surprise.
    document.getElementById("drawing-reference-label").textContent =
      input.kind === "photo" ? "Ta photo à reproduire" : "Le dessin reçu à reproduire";
  }

  // ---- Mode "🙃 Tête à l'envers" : on retourne visuellement la référence et la zone
  // de dessin (le rendu final reste droit, seule la vue à l'écran est piégée). ----
  canvasWrap.classList.toggle("mode-upside-down", mode === "upside_down");
  imgWrap.classList.toggle("mode-upside-down", mode === "upside_down");
  textWrap.classList.toggle("mode-upside-down", mode === "upside_down");

  // ---- Mode "🙈 Les yeux fermés" : un voile cache le dessin pendant qu'on le trace. ----
  document.getElementById("blind-overlay").classList.toggle("hidden", mode !== "blind");

  // ---- Mode "🖍️ Pinceau XXL" : taille de pinceau imposée, réglage verrouillé. ----
  const brushSlider = document.getElementById("brush-size");
  if (mode === "giant_brush") {
    state.drawing.size = 34;
    brushSlider.value = "34";
    brushSlider.disabled = true;
  } else {
    state.drawing.size = Number(brushSlider.value) || 8;
    brushSlider.disabled = false;
  }

  // ---- Mode "🎨 Couleur mystère" : une seule couleur imposée, palette verrouillée. ----
  const colorPicker = document.getElementById("color-picker");
  if (mode === "mystery_color") {
    const mysteryColor = MYSTERY_COLORS[Math.floor(Math.random() * MYSTERY_COLORS.length)];
    state.drawing.color = mysteryColor;
    colorPicker.value = mysteryColor;
    colorPicker.disabled = true;
    swatchWrap.classList.add("locked");
  } else {
    colorPicker.disabled = false;
    swatchWrap.classList.remove("locked");
  }
  setTool("pen");

  showScreen("screen-drawing");
  setupCanvasSize();
  startRenderLoop();
}

function setupCanvasSize() {
  const rect = canvasWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => {
  if (document.getElementById("screen-drawing").classList.contains("active")) setupCanvasSize();
});

const swatchWrap = document.getElementById("color-swatches");
SWATCH_COLORS.forEach((c, i) => {
  const el = document.createElement("button");
  el.className = "swatch" + (i === 0 ? " selected" : "");
  el.style.background = c;
  el.type = "button";
  el.addEventListener("click", () => {
    state.drawing.color = c;
    document.getElementById("color-picker").value = c;
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
    el.classList.add("selected");
    setTool("pen");
  });
  swatchWrap.appendChild(el);
});
document.getElementById("color-picker").addEventListener("input", (e) => {
  state.drawing.color = e.target.value;
  setTool("pen");
});
document.getElementById("brush-size").addEventListener("input", (e) => {
  state.drawing.size = Number(e.target.value);
});
function setTool(tool) {
  state.drawing.tool = tool;
  document.getElementById("tool-pen").classList.toggle("active", tool === "pen");
  document.getElementById("tool-eraser").classList.toggle("active", tool === "eraser");
}
document.getElementById("tool-pen").addEventListener("click", () => setTool("pen"));
document.getElementById("tool-eraser").addEventListener("click", () => setTool("eraser"));
document.getElementById("btn-undo").addEventListener("click", () => { state.drawing.strokes.pop(); });
document.getElementById("btn-clear").addEventListener("click", () => { state.drawing.strokes = []; });

// ---- Modes "🎠 Manège" / "🌊 Dérive" : le <canvas> lui-même est animé via
// CSS transform (rotation continue / glissement), pendant que canvas-wrap
// reste fixe et sert de repère stable. getModeTransform() calcule, à un
// instant donné, l'angle et le décalage courants — utilisés à la fois pour
// positionner visuellement le canvas ET pour retrouver, par transformation
// inverse, la vraie position sur la surface de dessin sous le doigt/la
// souris (sinon le trait ne tomberait pas là où l'œil le voit).
const MANEGE_PERIOD_MS = 16000; // ms pour un tour complet, rotation douce
const DERIVE_AMP_X = 46, DERIVE_AMP_Y = 32; // px d'amplitude du glissement
const DERIVE_FREQ_X = (Math.PI * 2) / 1500; // rad/ms — assez rapide pour perturber
const DERIVE_FREQ_Y = (Math.PI * 2) / 1150;
function getModeTransform() {
  const mode = state.drawing.mode;
  if (mode !== "manege" && mode !== "derive") return null;
  const elapsed = Date.now() - (state.drawing.modeStart || Date.now());
  if (mode === "manege") {
    return { angle: (elapsed / MANEGE_PERIOD_MS) * Math.PI * 2, dx: 0, dy: 0 };
  }
  return {
    angle: 0,
    dx: Math.sin(elapsed * DERIVE_FREQ_X) * DERIVE_AMP_X,
    dy: Math.cos(elapsed * DERIVE_FREQ_Y) * DERIVE_AMP_Y,
  };
}
function getCanvasCoords(evt) {
  const rect = canvasWrap.getBoundingClientRect();
  let x = evt.clientX - rect.left;
  let y = evt.clientY - rect.top;
  // La zone est retournée à l'écran (CSS rotate 180°) : on retourne aussi le
  // point capté pour que le trait tombe où l'œil le voit visuellement.
  if (state.drawing.mode === "upside_down") { x = rect.width - x; y = rect.height - y; }
  const t = getModeTransform();
  if (t) {
    const cx = rect.width / 2, cy = rect.height / 2;
    let px = x - t.dx - cx;
    let py = y - t.dy - cy;
    if (t.angle) {
      const cos = Math.cos(-t.angle), sin = Math.sin(-t.angle);
      const rx = px * cos - py * sin;
      const ry = px * sin + py * cos;
      px = rx; py = ry;
    }
    x = px + cx;
    y = py + cy;
  }
  return { x, y };
}
const WOBBLE_AMOUNT = 7; // px de tremblement ajouté à chaque point en mode "wobbly"
function applyWobble({ x, y }) {
  if (state.drawing.mode !== "wobbly") return { x, y };
  return {
    x: x + (Math.random() - 0.5) * WOBBLE_AMOUNT,
    y: y + (Math.random() - 0.5) * WOBBLE_AMOUNT,
  };
}
let isPointerDown = false;
canvas.addEventListener("pointerdown", (evt) => {
  if (drawSubmitted) return;
  isPointerDown = true;
  canvas.setPointerCapture(evt.pointerId);
  const { x, y } = applyWobble(getCanvasCoords(evt));
  state.drawing.currentStroke = {
    points: [{ x, y, ts: Date.now() }],
    color: state.drawing.color,
    size: state.drawing.tool === "eraser" ? state.drawing.size * 2.2 : state.drawing.size,
    tool: state.drawing.tool,
    ts: Date.now(),
  };
});
canvas.addEventListener("pointermove", (evt) => {
  if (!isPointerDown || !state.drawing.currentStroke) return;
  const { x, y } = applyWobble(getCanvasCoords(evt));
  state.drawing.currentStroke.points.push({ x, y, ts: Date.now() });
});
function endStroke() {
  if (state.drawing.currentStroke && state.drawing.currentStroke.points.length > 0) {
    state.drawing.strokes.push(state.drawing.currentStroke);
  }
  state.drawing.currentStroke = null;
  isPointerDown = false;
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);
canvas.addEventListener("pointerleave", () => { if (isPointerDown) endStroke(); });

function startRenderLoop() {
  cancelAnimationFrame(state.drawing.rafId);
  const loop = () => {
    if (!document.getElementById("screen-drawing").classList.contains("active")) return;
    const t = getModeTransform();
    canvas.style.transform = t ? `translate(${t.dx}px, ${t.dy}px) rotate(${t.angle}rad)` : "";
    renderCanvas();
    // En mode "yeux fermés", la traînée doit continuer à s'effacer même sans
    // nouveau point (le temps passe), donc on ne s'arrête jamais tant que
    // l'écran est actif — contrairement aux autres modes on pourrait arrêter
    // dès que rien ne bouge, mais garder la boucle simple reste plus sûr.
    state.drawing.rafId = requestAnimationFrame(loop);
  };
  loop();
}

// Durée de vie de la traînée en mode "yeux fermés" : au-delà, le trait est
// totalement invisible — seul un petit bout récent reste visible à l'écran,
// mais le VRAI dessin (celui envoyé au groupe) reste bien complet.
const BLIND_TRAIL_FADE_MS = 850;

function renderCanvas(opts = {}) {
  const forceFull = !!opts.forceFull;
  const rect = canvasWrap.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const allStrokes = [...state.drawing.strokes];
  if (state.drawing.currentStroke) allStrokes.push(state.drawing.currentStroke);
  const blind = state.drawing.mode === "blind" && !forceFull;
  const now = Date.now();

  for (const stroke of allStrokes) {
    if (stroke.points.length < 1) continue;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = stroke.size;

    if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color;
    }

    if (!blind) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y + 0.1);
      ctx.stroke();
    } else {
      // Mode "yeux fermés" : on ne dessine à l'écran qu'une petite traînée qui
      // s'efface — chaque segment garde une opacité qui décroît avec son âge.
      // Le tableau `strokes` en mémoire, lui, reste complet et intact : c'est
      // bien le dessin ENTIER qui sera envoyé aux autres joueurs à la fin.
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        const age = now - (p.ts || now);
        const alpha = Math.max(0, 1 - age / BLIND_TRAIL_FADE_MS);
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(stroke.points[i - 1].x, stroke.points[i - 1].y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      if (stroke.points.length === 1) {
        const p = stroke.points[0];
        const age = now - (p.ts || now);
        const alpha = Math.max(0, 1 - age / BLIND_TRAIL_FADE_MS);
        if (alpha > 0) {
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + 0.1, p.y + 0.1);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

document.getElementById("btn-submit-drawing").addEventListener("click", () => {
  if (drawSubmitted) return;
  drawSubmitted = true;
  document.getElementById("btn-submit-drawing").disabled = true;
  // On force un rendu complet (sans traînée qui s'efface) juste avant la capture :
  // le mode "yeux fermés" ne cache que ce que le joueur VOIT pendant qu'il dessine,
  // le dessin envoyé aux autres doit rester entier.
  renderCanvas({ forceFull: true });
  // Sur un écran haute résolution (devicePixelRatio élevé), un PNG brut du canvas
  // peut peser plusieurs Mo : on le compresse pour fiabiliser l'envoi P2P.
  const dataUrl = canvasToSafeDataUrl(canvas, 900, 0.85, 700 * 1024);
  socket.emit("submit_round_contribution", { content: dataUrl, round: currentRoundIndex }, (res) => {
    if (!res?.ok) {
      toast("Erreur d'envoi du dessin, réessaie.");
      drawSubmitted = false;
      document.getElementById("btn-submit-drawing").disabled = false;
    } else {
      toast("Dessin envoyé ! En attente des autres…");
    }
  });
});

// ---- Tour de description ----
const CLIENT_DESCRIPTION_MAX_WORDS = 5;
function isConstrainedDescriptionOn() {
  return !!state.room?.settings?.constrainedDescription;
}
function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
function setupDescribeRound(round, totalRounds, input, duration) {
  document.getElementById("describe-round-label").textContent = `Tour ${round}/${totalRounds}`;
  document.getElementById("describe-timer").textContent = duration;
  setImageWithFallback(document.getElementById("describe-image"), input.content, "Dessin indisponible");
  const ta = document.getElementById("describe-textarea");
  ta.value = "";
  ta.disabled = false;
  updateDescribeCounter();
  document.getElementById("btn-submit-description").disabled = false;
  showScreen("screen-describe");
}
function updateDescribeCounter() {
  const ta = document.getElementById("describe-textarea");
  const counterEl = document.getElementById("describe-char-count");
  if (isConstrainedDescriptionOn()) {
    counterEl.textContent = `✂️ ${countWords(ta.value)}/${CLIENT_DESCRIPTION_MAX_WORDS} mots max`;
  } else {
    counterEl.textContent = `${ta.value.length}/140`;
  }
}
document.getElementById("describe-textarea").addEventListener("input", (e) => {
  if (isConstrainedDescriptionOn()) {
    const words = e.target.value.trim().split(/\s+/).filter(Boolean);
    if (words.length > CLIENT_DESCRIPTION_MAX_WORDS) {
      // On coupe direct au 5e mot (en gardant l'espace final si le joueur tapait un 6e mot).
      e.target.value = words.slice(0, CLIENT_DESCRIPTION_MAX_WORDS).join(" ");
    }
  }
  updateDescribeCounter();
});
document.getElementById("btn-submit-description").addEventListener("click", () => {
  const ta = document.getElementById("describe-textarea");
  const text = ta.value.trim();
  if (!text) return toast("Écris une petite description avant de valider.");
  ta.disabled = true;
  document.getElementById("btn-submit-description").disabled = true;
  socket.emit("submit_round_contribution", { content: text, round: currentRoundIndex }, (res) => {
    if (!res?.ok) {
      toast("Erreur d'envoi");
      ta.disabled = false;
      document.getElementById("btn-submit-description").disabled = false;
    } else {
      toast("Description envoyée ! En attente des autres…");
    }
  });
});

// ------------------------------------------------------------------
// TIMER (partagé dessin / description / reveal)
// ------------------------------------------------------------------
socket.on("timer_tick", ({ phase, remaining }) => {
  if (phase === "round") {
    if (currentRoundType === "drawing" && document.getElementById("screen-drawing").classList.contains("active")) {
      document.getElementById("drawing-timer").textContent = remaining;
      if (remaining <= 0) document.getElementById("btn-submit-drawing").disabled = true;
    } else if (currentRoundType === "description" && document.getElementById("screen-describe").classList.contains("active")) {
      document.getElementById("describe-timer").textContent = remaining;
      if (remaining <= 0) document.getElementById("btn-submit-description").disabled = true;
    }
  } else if (phase === "reveal_vote") {
    document.getElementById("vote-timer").textContent = remaining;
  } else if (phase === "reveal_answer") {
    document.getElementById("album-timer").textContent = remaining;
  }
});

// ------------------------------------------------------------------
// VOTE : à qui appartient cette photo ?
// ------------------------------------------------------------------
function renderFinalItem(container, item) {
  container.innerHTML = "";
  if (item.type === "description") {
    const div = document.createElement("div");
    div.className = "album-text";
    div.textContent = `"${item.content || "…"}"`;
    container.appendChild(div);
  } else {
    const img = document.createElement("img");
    container.appendChild(img);
    setImageWithFallback(img, item.content, "Image indisponible");
  }
}

let voteSubmitted = false;
socket.on("phase_album_vote", ({ index, total, finalItem, candidates, isOwner }) => {
  voteSubmitted = false;
  document.getElementById("vote-index").textContent = index;
  document.getElementById("vote-total").textContent = total;
  document.getElementById("vote-timer").textContent = "";
  renderFinalItem(document.getElementById("vote-final-item"), finalItem);

  document.getElementById("vote-owner-hint").classList.toggle("hidden", !isOwner);
  document.getElementById("vote-submitted-hint").classList.add("hidden");

  const candWrap = document.getElementById("vote-candidates");
  candWrap.innerHTML = "";
  candWrap.classList.toggle("hidden", isOwner);

  if (!isOwner) {
    candidates
      .filter((c) => c.id !== socket.id)
      .forEach((c) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "vote-candidate-btn";
        btn.innerHTML = `<span>${c.avatar}</span><span>${escapeHtml(c.name)}</span>`;
        btn.addEventListener("click", () => {
          if (voteSubmitted) return;
          voteSubmitted = true;
          document.querySelectorAll(".vote-candidate-btn").forEach((b) => (b.disabled = true));
          btn.classList.add("chosen");
          socket.emit("submit_vote", { guessedOwnerId: c.id }, (res) => {
            if (!res?.ok) {
              toast("Vote non pris en compte, réessaie.");
              voteSubmitted = false;
              document.querySelectorAll(".vote-candidate-btn").forEach((b) => (b.disabled = false));
              btn.classList.remove("chosen");
              return;
            }
            document.getElementById("vote-submitted-hint").classList.remove("hidden");
          });
        });
        candWrap.appendChild(btn);
      });
  }

  showScreen("screen-album-vote");
});

// ------------------------------------------------------------------
// REVELATION DE L'ALBUM (réponse + qui a deviné juste)
// ------------------------------------------------------------------
let qualityVoteSubmitted = false;
let albumStripCards = []; // cartes de la manche d'album en cours, indexées comme "items", pour le highlight du vote qualité
socket.on("phase_album_answer", ({ ownerName, ownerAvatar, items, votes, index, total, qualityVoteEnabled }) => {
  document.getElementById("album-index").textContent = index;
  document.getElementById("album-total").textContent = total;
  document.getElementById("album-owner-avatar").textContent = ownerAvatar || "🙂";
  document.getElementById("album-owner-title").textContent = ownerName || "?";
  qualityVoteSubmitted = false;
  albumStripCards = [];

  const guesserList = document.getElementById("album-guesser-list");
  guesserList.innerHTML = "";
  if (!votes || votes.length === 0) {
    const li = document.createElement("li");
    li.className = "guesser-empty";
    li.textContent = "Personne n'a voté sur ce coup-ci…";
    guesserList.appendChild(li);
  } else {
    votes.forEach((v, vi) => {
      const li = document.createElement("li");
      li.className = v.correct ? "correct" : "wrong";
      li.style.setProperty("--i", vi);
      li.innerHTML = `
        <span class="guesser-avatar">${v.voterAvatar || "🙂"}</span>
        <span class="guesser-text"><b>${escapeHtml(v.voterName || "?")}</b> a dit <i>${escapeHtml(v.guessedName || "?")}</i></span>
        <span class="guesser-result">${v.correct ? "✅ +15" : "❌"}</span>
      `;
      guesserList.appendChild(li);
    });
  }

  const strip = document.getElementById("album-strip");
  strip.innerHTML = "";

  const buildAlbumStrip = () => {
    items.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "album-item" + (item.impostor ? " impostor-item" : "") + (i % 2 === 0 ? " tilt-left" : " tilt-right");
      card.style.setProperty("--i", i);
      const label = item.type === "photo" ? "📸 Photo de départ" : item.type === "description" ? "📝 Description" : "✏️ Dessin";
      card.innerHTML = `
        <span class="album-item-badge">${i === 0 ? "🏁" : i}</span>
        <div class="album-item-media"></div>
        <div class="album-item-footer">
          <span class="album-caption-label">${label}</span>
          <span class="album-caption-author">${escapeHtml(item.contributorName || "")}</span>
        </div>
      `;
      const media = card.querySelector(".album-item-media");
      if (item.type === "description") {
        media.innerHTML = `<div class="album-text">"${escapeHtml(item.content || "…")}"</div>`;
      } else {
        const img = document.createElement("img");
        img.alt = label;
        media.appendChild(img);
        setImageWithFallback(img, item.content, "Image indisponible");
      }
      // Mode "Imposteur" : le twist est révélé ici, au moment de l'album complet.
      if (item.impostor) {
        const flag = document.createElement("span");
        flag.className = "impostor-flag";
        flag.textContent = "🎭 Détail secret ajouté par l'imposteur !";
        card.appendChild(flag);
      }
      // Mode "Vote qualité" : une étoile par étape (sauf la photo de départ) pour voter son coup de cœur.
      if (qualityVoteEnabled && item.type !== "photo") {
        const starBtn = document.createElement("button");
        starBtn.type = "button";
        starBtn.className = "quality-star-btn";
        starBtn.innerHTML = "⭐ Coup de cœur";
        starBtn.addEventListener("click", () => {
          if (qualityVoteSubmitted) return;
          qualityVoteSubmitted = true;
          document.querySelectorAll(".quality-star-btn").forEach((b) => (b.disabled = true));
          starBtn.classList.add("chosen");
          starBtn.innerHTML = "⭐ Voté !";
          socket.emit("submit_quality_vote", { itemIndex: i }, (res) => {
            if (!res?.ok) {
              qualityVoteSubmitted = false;
              document.querySelectorAll(".quality-star-btn").forEach((b) => (b.disabled = false));
              starBtn.classList.remove("chosen");
              starBtn.innerHTML = "⭐ Coup de cœur";
            }
          });
        });
        card.appendChild(starBtn);
      }
      strip.appendChild(card);
      albumStripCards[i] = card;
      if (i < items.length - 1) {
        const arrow = document.createElement("div");
        arrow.className = "album-arrow";
        arrow.style.setProperty("--i", i);
        arrow.innerHTML = `<span>➡️</span>`;
        strip.appendChild(arrow);
      }
    });
  };

  showScreen("screen-album");
  // D'abord un aperçu accéléré (façon flipbook) des dessins/photos de la
  // chaîne, puis la bande complète se révèle carte par carte comme avant.
  playAlbumFlipbook(items, buildAlbumStrip);
});

// Défile rapidement à travers les images (dessins/photos, pas les
// descriptions texte) de la chaîne avant la révélation détaillée, façon
// petit montage accéléré. Appelle `onDone` une fois terminé (ou aussitôt
// s'il n'y a aucune image à montrer).
let albumFlipbookTimer = null;
function playAlbumFlipbook(items, onDone) {
  const flipbook = document.getElementById("album-flipbook");
  const img = document.getElementById("album-flipbook-img");
  clearInterval(albumFlipbookTimer);

  const imageItems = items.filter((it) => it.type !== "description" && it.content);
  if (imageItems.length === 0) {
    flipbook.classList.add("hidden");
    onDone();
    return;
  }

  const FRAME_MS = 110;
  // Au moins deux passages complets de la chaîne pour bien sentir l'effet
  // "accéléré", même sur des chaînes courtes.
  const totalFrames = Math.max(imageItems.length * 2, 8);
  let frame = 0;

  flipbook.classList.remove("hidden");
  setImageWithFallback(img, imageItems[0].content, "");

  albumFlipbookTimer = setInterval(() => {
    frame++;
    if (frame >= totalFrames) {
      clearInterval(albumFlipbookTimer);
      flipbook.classList.add("hidden");
      onDone();
      return;
    }
    setImageWithFallback(img, imageItems[frame % imageItems.length].content, "");
  }, FRAME_MS);
}

socket.on("quality_vote_result", ({ winnerName, winnerAvatar, itemIndex, votes, points }) => {
  toast(`⭐ ${winnerAvatar || ""} ${winnerName} a le plus de coups de cœur (${votes}) : +${points} pts !`);
  const card = albumStripCards[itemIndex];
  if (card) {
    card.classList.add("quality-winner");
    const trophy = document.createElement("span");
    trophy.className = "quality-winner-badge";
    trophy.textContent = `🏆 Coup de cœur (${votes})`;
    card.appendChild(trophy);
  }
});

// ------------------------------------------------------------------
// SCOREBOARD
// ------------------------------------------------------------------
socket.on("phase_scoreboard", ({ scores }) => {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const list = document.getElementById("scoreboard-list");
  list.innerHTML = "";
  sorted.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="rank-num">${i + 1}</span>
      <span>${p.avatar}</span>
      <span>${escapeHtml(p.name)}</span>
      <span class="score-val">${p.score} pts</span>
    `;
    list.appendChild(li);
  });
  document.getElementById("btn-play-again").classList.toggle("hidden", state.room?.hostId !== socket.id);
  showScreen("screen-scoreboard");
});
document.getElementById("btn-play-again").addEventListener("click", () => socket.emit("play_again"));
document.getElementById("btn-back-home").addEventListener("click", () => {
  socket.emit("leave_room");
  Net.teardown();
  location.reload();
});
