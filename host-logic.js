/**
 * host-logic.js — Logique de jeu qui tournait auparavant sur le serveur
 * Express/Socket.io (server.js), portée pour s'exécuter dans le navigateur
 * du joueur qui HÉBERGE la partie. `Net` (voir net.js) fait office de
 * couche de transport : `Net.broadcast` / `Net.sendTo` remplacent
 * `io.to(...).emit(...)`, et chaque action d'un invité (ou de l'hôte
 * lui-même) arrive ici via `HostLogic.handle(playerId, event, payload, cb)`.
 *
 * Comme un seul salon existe par onglet-hôte, plus besoin de Map de salons
 * indexée par code : `room` est simplement l'état du salon en cours.
 *
 * Vie privée : rien n'est jamais envoyé à un serveur ni persisté sur disque
 * — tout vit en mémoire dans l'onglet du navigateur hôte, et est détruit
 * dès que les albums sont révélés ou que le salon se ferme.
 */

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const EXTRA_TRANSMISSION_ROUNDS_FOR_DUO = 3; // avec 2 joueurs : Dessin -> B -> A -> B

const GAME_MODES = ["normal", "blind", "upside_down", "wobbly", "giant_brush", "mystery_color", "manege", "derive"];

const PHASES = {
  LOBBY: "lobby",
  PHOTO_VALIDATION: "photo_validation",
  ROUND: "round",
  REVEAL: "reveal",
  SCOREBOARD: "scoreboard",
};

const DESCRIPTION_DURATION_SEC = 45;
const ALBUM_REVEAL_DURATION_SEC = 10;
const ALBUM_REVEAL_DURATION_SEC_QUALITY_VOTE = 16; // laisse le temps de voter en plus de lire
const VOTE_DURATION_SEC = 12;
const PARTICIPATION_POINTS = 10;
const VOTE_POINTS = 15;
const QUALITY_VOTE_POINTS = 8;
const CONSTRAINED_DESCRIPTION_MAX_WORDS = 5;

function sanitizeName(name) {
  return String(name || "Joueur").trim().slice(0, 20).replace(/[<>]/g, "");
}
function sanitizeText(text) {
  return String(text || "").trim().slice(0, 140).replace(/[<>]/g, "");
}
/** Mode "Description en 5 mots" : on ne garde que les 5 premiers mots. */
function clampToWords(text, maxWords) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const HostLogic = (() => {
  let room = null;
  let timer = null;

  function activePlayers() {
    return Array.from(room.players.values()).filter((p) => p.connected);
  }

  function publicPlayerList() {
    return Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.connected,
      photoValidated: !!room.photos.get(p.id),
      isHost: p.id === room.hostId,
    }));
  }

  function roomStateForClient() {
    return {
      code: room.code,
      phase: room.phase,
      settings: {
        drawDuration: room.settings.drawDuration,
        modes: Array.from(room.settings.modes),
        descriptionMode: room.settings.descriptionMode,
        impostorMode: room.settings.impostorMode,
        loopbackMode: room.settings.loopbackMode,
        constrainedDescription: room.settings.constrainedDescription,
        qualityVoteMode: room.settings.qualityVoteMode,
      },
      // Préférences affichées sous forme d'avatars sur les cartes du lobby :
      // uniquement indicatif, ça ne change pas les réglages réels (seul
      // l'hôte les modifie) — ça sert juste à montrer ce que veulent les invités.
      modeVotes: Object.fromEntries(room.modeVotes || []),
      effectVotes: Object.fromEntries(room.effectVotes || []),
      players: publicPlayerList(),
      hostId: room.hostId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }
  function broadcastRoomState() {
    Net.broadcast("room_state", roomStateForClient());
  }

  function clearTimer() {
    if (timer?.intervalId) clearInterval(timer.intervalId);
    timer = null;
    clearGrace();
  }

  // Petit délai de grâce avant de clôturer un round quand le minuteur arrive à 0 :
  // sur une connexion P2P, un dessin peut être fini à temps par le joueur mais
  // encore en train de transiter (gros payload) au moment exact où le minuteur
  // sonne. Sans ce délai, la manche avance avec un contenu vide pour ce joueur.
  const SUBMISSION_GRACE_MS = 6000;
  let graceTimeoutId = null;
  function clearGrace() {
    if (graceTimeoutId) { clearTimeout(graceTimeoutId); graceTimeoutId = null; }
  }
  function scheduleRoundFinalization() {
    clearGrace();
    graceTimeoutId = setTimeout(() => {
      graceTimeoutId = null;
      advanceRound();
    }, SUBMISSION_GRACE_MS);
  }
  function startTimer(seconds, phaseLabel, onComplete) {
    clearTimer();
    let remaining = seconds;
    timer = { remaining, phase: phaseLabel, onComplete };
    Net.broadcast("timer_tick", { phase: phaseLabel, remaining });
    timer.intervalId = setInterval(() => {
      remaining -= 1;
      Net.broadcast("timer_tick", { phase: phaseLabel, remaining });
      if (remaining <= 0) {
        clearTimer();
        onComplete();
      }
    }, 1000);
  }

  function destroyRoomMedia() {
    room.photos?.clear();
    room.chains?.forEach((chain) => chain.fill(null));
  }

  // ---------------- Logique de chaîne (Gartic Phone) ----------------
  function getTotalRounds(playerCount) {
    if (playerCount === 2) return 1 + EXTRA_TRANSMISSION_ROUNDS_FOR_DUO;
    return playerCount;
  }
  function typeForRound(round, descriptionModeOn) {
    if (round === 0) return "drawing";
    if (!descriptionModeOn) return "drawing";
    return round % 2 === 1 ? "description" : "drawing";
  }
  function chainIndexForPlayer(playerIndex, round, n) {
    return (((playerIndex - round) % n) + n) % n;
  }
  function computeRoundAssignments(round) {
    const order = room.playerOrder;
    const n = order.length;
    const isLastRound = round === room.totalRounds - 1;
    const assignments = new Map();
    order.forEach((playerId, idx) => {
      const player = room.players.get(playerId);
      if (!player || !player.connected) return;
      const chainIndex = chainIndexForPlayer(idx, round, n);
      const ownerId = order[chainIndex];
      const type = typeForRound(round, room.settings.descriptionMode);
      let input;
      let loopback = false;
      if (round === 0) {
        input = { kind: "photo", content: room.photos.get(ownerId) };
      } else if (room.settings.loopbackMode && isLastRound && round > 0 && type === "drawing") {
        // Mode "Retour en arrière" : le dernier tour de chaque chaîne redonne
        // la photo de départ à redessiner, sans le dire — effet boucle à la révélation.
        input = { kind: "photo", content: room.photos.get(ownerId) };
        loopback = true;
      } else {
        const prev = room.chains.get(chainIndex)[round - 1];
        input = prev ? { kind: prev.type, content: prev.content } : { kind: "text", content: "(rien à voir)" };
      }
      assignments.set(playerId, { chainIndex, ownerId, type, input, loopback, isImpostor: false });
    });

    // Mode "Imposteur" : un joueur tiré au sort parmi ceux qui dessinent ce
    // tour reçoit la mission secrète d'ajouter un détail inventé.
    if (room.settings.impostorMode) {
      const drawers = Array.from(assignments.entries()).filter(([, a]) => a.type === "drawing");
      if (drawers.length > 0) {
        const [chosenId] = drawers[Math.floor(Math.random() * drawers.length)];
        assignments.get(chosenId).isImpostor = true;
      }
    }

    return assignments;
  }

  // ---------------- Dispatch (équivalent des handlers io.on) ----------------
  function handle(playerId, event, payload, cb) {
    switch (event) {
      case "join_room": return onJoinRoom(playerId, payload, cb);
      case "update_settings": return onUpdateSettings(playerId, payload);
      case "vote_mode": return onVoteMode(playerId, payload);
      case "vote_effect": return onVoteEffect(playerId, payload);
      case "start_game": return onStartGame(playerId);
      case "validate_photo": return onValidatePhoto(playerId, payload, cb);
      case "draw_step": return onDrawStep(playerId, payload);
      case "submit_round_contribution": return onSubmitContribution(playerId, payload, cb);
      case "submit_vote": return onSubmitVote(playerId, payload, cb);
      case "submit_quality_vote": return onSubmitQualityVote(playerId, payload, cb);
      case "leave_room": return onLeave(playerId);
      case "disconnect": return onLeave(playerId);
      case "play_again": return onPlayAgain(playerId);
      default: console.warn("[host-logic] événement inconnu:", event);
    }
  }

  /** Appelé directement par app.js (pas via le réseau) quand on devient hôte. */
  function createRoom(code, hostId, { name, avatar }) {
    room = {
      code,
      hostId,
      phase: PHASES.LOBBY,
      createdAt: Date.now(),
      settings: {
        drawDuration: 60,
        modes: new Set(["normal"]),
        descriptionMode: false,
        impostorMode: false,
        loopbackMode: false,
        constrainedDescription: false,
        qualityVoteMode: false,
      },
      modeVotes: new Map(),   // playerId -> mode choisi (préférence, lobby uniquement)
      effectVotes: new Map(), // playerId -> effet spécial choisi (préférence, lobby uniquement)
      players: new Map(),
      photos: new Map(),
      playerOrder: [],
      totalRounds: 0,
      currentRound: -1,
      chains: new Map(),
      currentAssignments: new Map(),
      revealQueue: [],
      currentRevealIndex: -1,
      revealSubPhase: null,
      currentAlbumOwnerId: null,
      currentVotes: new Map(),
      currentQualityVotes: new Map(),
    };
    room.players.set(hostId, { id: hostId, name: sanitizeName(name), avatar: avatar || "🙂", score: 0, connected: true });
    return { ok: true, room: roomStateForClient() };
  }

  function onJoinRoom(playerId, { name, avatar } = {}, cb) {
    if (!room) return cb?.({ ok: false, error: "Salon introuvable." });
    if (room.phase !== PHASES.LOBBY) return cb?.({ ok: false, error: "La partie a déjà commencé." });
    if (activePlayers().length >= MAX_PLAYERS) return cb?.({ ok: false, error: `Salon complet (max ${MAX_PLAYERS} joueurs).` });

    room.players.set(playerId, { id: playerId, name: sanitizeName(name), avatar: avatar || "🙂", score: 0, connected: true });
    cb?.({ ok: true, room: roomStateForClient() });
    broadcastRoomState();
  }

  function onUpdateSettings(playerId, { drawDuration, modes, descriptionMode, impostorMode, loopbackMode, constrainedDescription, qualityVoteMode } = {}) {
    if (!room || room.hostId !== playerId || room.phase !== PHASES.LOBBY) return;
    if (Number.isFinite(drawDuration)) room.settings.drawDuration = Math.min(180, Math.max(20, drawDuration));
    if (Array.isArray(modes)) {
      const valid = modes.filter((m) => GAME_MODES.includes(m));
      room.settings.modes = new Set(valid.length ? valid : ["normal"]);
    }
    if (typeof descriptionMode === "boolean") room.settings.descriptionMode = descriptionMode;
    if (typeof impostorMode === "boolean") room.settings.impostorMode = impostorMode;
    if (typeof loopbackMode === "boolean") room.settings.loopbackMode = loopbackMode;
    if (typeof constrainedDescription === "boolean") room.settings.constrainedDescription = constrainedDescription;
    if (typeof qualityVoteMode === "boolean") room.settings.qualityVoteMode = qualityVoteMode;
    // Un seul effet spécial exclusif actif à la fois (garde-fou côté serveur,
    // au cas où un client enverrait plusieurs booléens à true d'un coup).
    // "Description en 5 mots" est exempté : il peut se cumuler avec
    // "Tours de description", mais n'a de sens que si ce dernier est actif.
    const EXCLUSIVE_EFFECT_KEYS = ["descriptionMode", "impostorMode", "loopbackMode", "qualityVoteMode"];
    const justEnabled = EXCLUSIVE_EFFECT_KEYS.find(
      (k) => k === "descriptionMode" ? descriptionMode === true
        : k === "impostorMode" ? impostorMode === true
        : k === "loopbackMode" ? loopbackMode === true
        : qualityVoteMode === true
    );
    if (justEnabled) {
      for (const k of EXCLUSIVE_EFFECT_KEYS) if (k !== justEnabled) room.settings[k] = false;
    }
    if (!room.settings.descriptionMode) room.settings.constrainedDescription = false;
    broadcastRoomState();
  }

  // ---------------- Préférences des invités (lobby) ----------------
  // Les invités ne peuvent pas changer les réglages directement : cliquer sur
  // une carte pose juste leur avatar dessus, pour montrer à l'hôte ce qu'ils
  // aimeraient. Un joueur ne peut avoir son avatar que sur UNE carte de mode
  // ET UNE carte d'effet à la fois (reclique sur la même carte = retire son
  // vote). C'est à l'hôte de décider s'il en tient compte.
  const SPECIAL_EFFECT_KEYS = ["descriptionMode", "impostorMode", "loopbackMode", "constrainedDescription", "qualityVoteMode"];

  function onVoteMode(playerId, { mode } = {}) {
    if (!room || room.phase !== PHASES.LOBBY) return;
    if (playerId === room.hostId) return; // l'hôte choisit directement, il ne vote pas
    if (!GAME_MODES.includes(mode)) return;
    if (room.modeVotes.get(playerId) === mode) {
      room.modeVotes.delete(playerId);
    } else {
      room.modeVotes.set(playerId, mode);
    }
    broadcastRoomState();
  }

  function onVoteEffect(playerId, { effect } = {}) {
    if (!room || room.phase !== PHASES.LOBBY) return;
    if (playerId === room.hostId) return;
    if (!SPECIAL_EFFECT_KEYS.includes(effect)) return;
    if (room.effectVotes.get(playerId) === effect) {
      room.effectVotes.delete(playerId);
    } else {
      room.effectVotes.set(playerId, effect);
    }
    broadcastRoomState();
  }

  function onStartGame(playerId) {
    if (!room || room.hostId !== playerId || room.phase !== PHASES.LOBBY) return;
    const active = activePlayers();
    if (active.length < MIN_PLAYERS) return Net.sendTo(playerId, "error_message", `Il faut au moins ${MIN_PLAYERS} joueurs.`);
    if (active.length > MAX_PLAYERS) return Net.sendTo(playerId, "error_message", `Maximum ${MAX_PLAYERS} joueurs.`);

    room.playerOrder = shuffle(active.map((p) => p.id));
    room.totalRounds = getTotalRounds(room.playerOrder.length);
    room.chains = new Map(room.playerOrder.map((_, i) => [i, new Array(room.totalRounds).fill(null)]));
    room.photos.clear();
    room.currentRound = -1;

    room.phase = PHASES.PHOTO_VALIDATION;
    room.modeVotes.clear();
    room.effectVotes.clear();
    broadcastRoomState();
    Net.broadcast("phase_photo_validation_start");
  }

  function onValidatePhoto(playerId, { dataUrl } = {}, cb) {
    if (!room || room.phase !== PHASES.PHOTO_VALIDATION) return cb?.({ ok: false });
    if (typeof dataUrl !== "string" || dataUrl.length > 6 * 1024 * 1024) return cb?.({ ok: false, error: "Image trop lourde." });

    room.photos.set(playerId, dataUrl);
    cb?.({ ok: true });
    broadcastRoomState();

    const active = activePlayers();
    if (active.length >= MIN_PLAYERS && active.every((p) => room.photos.has(p.id))) beginRound(0);
  }

  function onDrawStep(playerId, stroke) {
    if (!room || room.phase !== PHASES.ROUND) return;
    Net.broadcastExcept(playerId, "draw_step_broadcast", { contributorId: playerId, stroke });
  }

  function onSubmitContribution(playerId, { content, round } = {}, cb) {
    if (!room || room.phase !== PHASES.ROUND) return cb?.({ ok: false });

    const order = room.playerOrder;
    const idx = order.indexOf(playerId);
    if (idx === -1) return cb?.({ ok: false });
    const n = order.length;

    // On se fie au numéro de manche envoyé par le client (celui pour lequel il a
    // reçu son sujet), pas seulement à room.currentRound : si cet envoi arrive
    // juste après que la manche suivante a démarré (connexion lente, gros
    // dessin), on doit quand même l'appliquer à LA BONNE manche, sinon il
    // écrase par erreur les données de la nouvelle manche.
    const targetRound = Number.isInteger(round) && round >= 0 && round < room.totalRounds
      ? round
      : room.currentRound;

    const chainIndex = chainIndexForPlayer(idx, targetRound, n);
    const type = typeForRound(targetRound, room.settings.descriptionMode);
    const chain = room.chains.get(chainIndex);
    if (!chain) return cb?.({ ok: false });

    const existing = chain[targetRound];
    // Refusé seulement si une VRAIE soumission existe déjà (pas un contenu vide
    // auto-généré à l'expiration du timer, qu'on peut encore réparer).
    if (existing && !existing.auto) return cb?.({ ok: false });
    // Si cette entrée était vide (contenu de secours posé parce que le délai de
    // grâce a expiré avant que cet envoi P2P n'arrive), la manche suivante a pu
    // démarrer entre-temps avec une référence vide chez le joueur qui l'attend :
    // on le détecte ici pour lui renvoyer la vraie référence juste après.
    const isLateRecovery = !!existing?.auto;

    let cleanContent;
    if (type === "description") {
      cleanContent = sanitizeText(content);
      if (room.settings.constrainedDescription) cleanContent = clampToWords(cleanContent, CONSTRAINED_DESCRIPTION_MAX_WORDS);
    } else {
      cleanContent = String(content || "");
    }
    const assignment = room.currentAssignments.get(playerId);
    chain[targetRound] = {
      round: targetRound,
      contributorId: playerId,
      type,
      content: cleanContent,
      impostor: !!assignment?.isImpostor,
      loopback: !!assignment?.loopback,
    };

    const player = room.players.get(playerId);
    if (player) player.score += PARTICIPATION_POINTS;

    cb?.({ ok: true });
    broadcastRoomState();

    // Réparation en direct : si un contenu vide pour (chainIndex, targetRound)
    // avait déjà été distribué comme référence à un joueur qui dessine/décrit
    // LA MANCHE SUIVANTE en ce moment même, on lui pousse la vraie référence
    // récupérée sans attendre la fin de sa manche.
    if (isLateRecovery && room.phase === PHASES.ROUND && room.currentRound === targetRound + 1) {
      const freshInput = { kind: type, content: cleanContent };
      for (const [pid, a] of room.currentAssignments.entries()) {
        if (a.chainIndex !== chainIndex) continue;
        a.input = freshInput; // garde l'état interne cohérent pour la suite
        Net.sendTo(pid, "reference_recovered", { input: freshInput });
      }
    }

    if (targetRound !== room.currentRound) return; // manche déjà terminée, rien d'autre à faire

    const active = activePlayers();
    const done = active.every((p) => {
      const a = room.currentAssignments.get(p.id);
      return !a || room.chains.get(a.chainIndex)[room.currentRound];
    });
    if (done) { clearTimer(); advanceRound(); }
  }

  function onLeave(playerId) {
    if (!room) return;
    const player = room.players.get(playerId);
    if (player) player.connected = false;
    Net.connections.delete(playerId);

    if (playerId === room.hostId) {
      // L'hôte ferme la partie : on prévient tout le monde puis on efface le salon.
      Net.broadcast("host_disconnected");
      clearTimer();
      room = null;
      return;
    }

    const stillActive = activePlayers();
    if (stillActive.length === 0) { clearTimer(); room = null; return; }
    room.modeVotes.delete(playerId);
    room.effectVotes.delete(playerId);
    broadcastRoomState();

    if (room.phase === PHASES.ROUND) {
      const active = activePlayers();
      const done = active.every((p) => {
        const a = room.currentAssignments.get(p.id);
        return !a || room.chains.get(a.chainIndex)[room.currentRound];
      });
      if (done) { clearTimer(); advanceRound(); }
    }

    if (room.phase === PHASES.REVEAL && room.revealSubPhase === "vote") {
      const voters = activePlayers().filter((p) => p.id !== room.currentAlbumOwnerId);
      if (voters.length === 0 || voters.every((p) => room.currentVotes.has(p.id))) {
        clearTimer();
        beginAlbumAnswer();
      }
    }
  }

  function onPlayAgain(playerId) {
    if (!room || room.hostId !== playerId || room.phase !== PHASES.SCOREBOARD) return;
    room.phase = PHASES.LOBBY;
    room.photos.clear();
    room.chains.clear();
    room.currentAssignments.clear();
    room.playerOrder = [];
    room.currentRound = -1;
    room.revealQueue = [];
    room.currentRevealIndex = -1;
    room.revealSubPhase = null;
    room.currentAlbumOwnerId = null;
    room.currentVotes = new Map();
    room.currentQualityVotes = new Map();
    room.modeVotes = new Map();
    room.effectVotes = new Map();
    for (const p of room.players.values()) p.score = 0;
    broadcastRoomState();
    // room_state seul ne fait pas changer d'écran côté client (il ne fait que
    // mettre à jour l'écran actif s'il s'agit déjà du lobby/de la galerie) :
    // on envoie donc un événement dédié pour forcer tout le monde à revenir
    // sur l'écran du lobby, comme au tout premier chargement.
    Net.broadcast("phase_lobby_start", roomStateForClient());
  }

  // ---------------- Transitions de manche ----------------
  function beginRound(round) {
    room.phase = PHASES.ROUND;
    room.currentRound = round;
    room.currentAssignments = computeRoundAssignments(round);

    const modes = Array.from(room.settings.modes);
    const roundVisualMode = modes[Math.floor(Math.random() * modes.length)] || "normal";

    for (const [playerId, assignment] of room.currentAssignments.entries()) {
      Net.sendTo(playerId, "phase_round_start", {
        round: round + 1,
        roundIndex: round,
        totalRounds: room.totalRounds,
        type: assignment.type,
        input: assignment.input,
        visualMode: assignment.type === "drawing" ? roundVisualMode : null,
        modesPool: assignment.type === "drawing" ? modes : null,
        duration: assignment.type === "drawing" ? room.settings.drawDuration : DESCRIPTION_DURATION_SEC,
        isImpostor: !!assignment.isImpostor,
        impostorModeActive: !!room.settings.impostorMode,
        loopback: !!assignment.loopback,
      });
    }
    broadcastRoomState();

    const anyDrawing = Array.from(room.currentAssignments.values()).some((a) => a.type === "drawing");
    const duration = anyDrawing ? room.settings.drawDuration : DESCRIPTION_DURATION_SEC;
    startTimer(duration, "round", () => scheduleRoundFinalization());
  }

  function advanceRound() {
    clearGrace();
    for (const [playerId, assignment] of room.currentAssignments.entries()) {
      const chain = room.chains.get(assignment.chainIndex);
      if (!chain[room.currentRound]) {
        console.warn(
          `[host-logic] Manche ${room.currentRound + 1} : soumission absente à temps pour ${room.players.get(playerId)?.name || playerId} ` +
          `(chaîne ${assignment.chainIndex}) — contenu de secours vide posé. Si ça arrive souvent, augmente SUBMISSION_GRACE_MS.`
        );
        chain[room.currentRound] = {
          round: room.currentRound,
          contributorId: playerId,
          type: assignment.type,
          content: assignment.type === "description" ? "(pas de réponse)" : "",
          auto: true, // contenu de secours : pas une vraie soumission du joueur
          impostor: !!assignment.isImpostor,
          loopback: !!assignment.loopback,
        };
      }
    }
    const next = room.currentRound + 1;
    if (next >= room.totalRounds) beginRevealPhase(); else beginRound(next);
  }

  function beginRevealPhase() {
    room.phase = PHASES.REVEAL;
    room.revealQueue = room.playerOrder.map((_, i) => i);
    room.currentRevealIndex = -1;
    broadcastRoomState();
    advanceToNextAlbum();
  }

  function advanceToNextAlbum() {
    room.currentRevealIndex += 1;
    if (room.currentRevealIndex >= room.revealQueue.length) return beginScoreboard();
    beginAlbumVote();
  }

  /** Étape 1 : on montre le résultat final de la chaîne, tout le monde vote pour deviner le propriétaire. */
  function beginAlbumVote() {
    const chainIndex = room.revealQueue[room.currentRevealIndex];
    const ownerId = room.playerOrder[chainIndex];
    const chain = room.chains.get(chainIndex);
    const finalEntry = chain[chain.length - 1] || { type: "photo", content: room.photos.get(ownerId) };

    room.revealSubPhase = "vote";
    room.currentAlbumOwnerId = ownerId;
    room.currentVotes = new Map();

    const candidates = activePlayers().map((p) => ({ id: p.id, name: p.name, avatar: p.avatar }));

    for (const p of activePlayers()) {
      Net.sendTo(p.id, "phase_album_vote", {
        index: room.currentRevealIndex + 1,
        total: room.revealQueue.length,
        finalItem: { type: finalEntry.type, content: finalEntry.content },
        candidates,
        isOwner: p.id === ownerId,
      });
    }
    broadcastRoomState();
    startTimer(VOTE_DURATION_SEC, "reveal_vote", () => beginAlbumAnswer());
  }

  function onSubmitVote(playerId, { guessedOwnerId } = {}, cb) {
    if (!room || room.phase !== PHASES.REVEAL || room.revealSubPhase !== "vote") return cb?.({ ok: false });
    if (playerId === room.currentAlbumOwnerId) return cb?.({ ok: false, error: "C'est ton propre album !" });
    if (room.currentVotes.has(playerId)) return cb?.({ ok: false });

    room.currentVotes.set(playerId, guessedOwnerId);
    cb?.({ ok: true });

    const voters = activePlayers().filter((p) => p.id !== room.currentAlbumOwnerId);
    if (voters.length > 0 && voters.every((p) => room.currentVotes.has(p.id))) {
      clearTimer();
      beginAlbumAnswer();
    }
  }

  /** Étape 2 : on révèle toute la chaîne, le vrai propriétaire, et qui avait deviné juste. */
  function beginAlbumAnswer() {
    clearTimer();
    room.revealSubPhase = "answer";
    room.currentQualityVotes = new Map();
    const chainIndex = room.revealQueue[room.currentRevealIndex];
    const ownerId = room.currentAlbumOwnerId;
    const owner = room.players.get(ownerId);
    const chain = room.chains.get(chainIndex);

    const items = [{ type: "photo", content: room.photos.get(ownerId), contributorId: ownerId, contributorName: owner?.name, impostor: false, loopback: false }];
    chain.forEach((entry) => {
      const contributor = room.players.get(entry.contributorId);
      items.push({
        type: entry.type,
        content: entry.content,
        contributorId: entry.contributorId,
        contributorName: contributor?.name,
        impostor: !!entry.impostor,
        loopback: !!entry.loopback,
      });
    });

    const votes = [];
    for (const [voterId, guessedOwnerId] of room.currentVotes.entries()) {
      const voter = room.players.get(voterId);
      const correct = guessedOwnerId === ownerId;
      if (correct && voter) voter.score += VOTE_POINTS;
      votes.push({
        voterName: voter?.name,
        voterAvatar: voter?.avatar,
        guessedName: room.players.get(guessedOwnerId)?.name || "quelqu'un d'autre",
        correct,
      });
    }

    const qualityVoteEnabled = !!room.settings.qualityVoteMode;

    Net.broadcast("phase_album_answer", {
      ownerId,
      ownerName: owner?.name,
      ownerAvatar: owner?.avatar,
      items,
      votes,
      index: room.currentRevealIndex + 1,
      total: room.revealQueue.length,
      scores: publicPlayerList(),
      qualityVoteEnabled,
    });
    broadcastRoomState();

    const duration = qualityVoteEnabled ? ALBUM_REVEAL_DURATION_SEC_QUALITY_VOTE : ALBUM_REVEAL_DURATION_SEC;
    startTimer(duration, "reveal_answer", () => {
      if (qualityVoteEnabled) tallyQualityVotes(items);
      advanceToNextAlbum();
    });
  }

  function onSubmitQualityVote(playerId, { itemIndex } = {}, cb) {
    if (!room || room.phase !== PHASES.REVEAL || room.revealSubPhase !== "answer") return cb?.({ ok: false });
    if (!room.settings.qualityVoteMode) return cb?.({ ok: false });
    if (!Number.isInteger(itemIndex) || itemIndex < 0) return cb?.({ ok: false });
    room.currentQualityVotes.set(playerId, itemIndex);
    cb?.({ ok: true });
  }

  /** Dépouille le "vote qualité" de cet album et donne un bonus au chouchou. */
  function tallyQualityVotes(items) {
    if (room.currentQualityVotes.size === 0) return;
    const tally = new Map(); // itemIndex -> nb de votes
    for (const itemIndex of room.currentQualityVotes.values()) {
      tally.set(itemIndex, (tally.get(itemIndex) || 0) + 1);
    }
    let bestIndex = -1, bestCount = 0;
    for (const [itemIndex, count] of tally.entries()) {
      if (count > bestCount) { bestCount = count; bestIndex = itemIndex; }
    }
    if (bestIndex === -1) return;
    const winningItem = items[bestIndex];
    const contributor = winningItem && room.players.get(winningItem.contributorId);
    if (!contributor) return;
    contributor.score += QUALITY_VOTE_POINTS;
    Net.broadcast("quality_vote_result", {
      winnerName: contributor.name,
      winnerAvatar: contributor.avatar,
      itemIndex: bestIndex,
      votes: bestCount,
      points: QUALITY_VOTE_POINTS,
    });
    broadcastRoomState();
  }

  function beginScoreboard() {
    room.phase = PHASES.SCOREBOARD;
    Net.broadcast("phase_scoreboard", { scores: publicPlayerList() });
    broadcastRoomState();
    destroyRoomMedia(); // vie privée : on efface photos & dessins/textes de la mémoire
  }

  return { handle, createRoom, get room() { return room; } };
})();
