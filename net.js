/**
 * net.js — Couche réseau pair-à-pair (WebRTC via PeerJS) qui imite l'API
 * socket.io utilisée par app.js : `socket.on(event, handler)` et
 * `socket.emit(event, payload, cb)`. Grâce à ça, app.js n'a presque pas
 * changé par rapport à la version client/serveur.
 *
 * Principe :
 *  - L'HÔTE de la partie fait tourner toute la logique de jeu localement,
 *    dans son propre onglet (voir host-logic.js), et joue le rôle du
 *    "serveur" : il accepte les connexions entrantes des autres joueurs
 *    (DataConnection PeerJS) et leur pousse les mises à jour.
 *  - Les INVITÉS envoient leurs actions à l'hôte en pair-à-pair, avec un
 *    accusé de réception (comme le callback de socket.io), et reçoivent
 *    les événements du jeu en retour.
 *
 * Aucun serveur applicatif (Express/Socket.io) n'est nécessaire : seul le
 * "peer broker" public de PeerJS (cloud.peerjs.com, gratuit) sert à la
 * signalisation initiale (échange des identifiants réseau pour établir la
 * connexion WebRTC). Une fois connectés, les navigateurs s'échangent
 * ensuite les données de jeu (photos, dessins, textes) EN DIRECT, sans
 * repasser par un serveur.
 */

const ID_PREFIX = "dmg-";
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I (ambigus)

function randomRoomCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return s;
}

const RPC_TIMEOUT_MS = 15000;

// Config PeerJS : broker public par défaut (cloud.peerjs.com) + STUN Google
// pour la traversée NAT. Sur des réseaux très restrictifs (entreprise,
// certains 4G), le STUN seul peut ne pas suffire : ajoute alors un serveur
// TURN (ex: Twilio Network Traversal, Metered.ca — offres gratuites
// disponibles) dans `config.iceServers` ci-dessous.
const PEERJS_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      // { urls: "turn:VOTRE_SERVEUR_TURN", username: "...", credential: "..." },
    ],
  },
};

class Network {
  constructor() {
    this.handlers = new Map();
    this.isHost = false;
    this.peer = null;
    this.myId = null;
    this.roomCode = null; // code à 6 caractères affiché aux joueurs
    this.connections = new Map(); // peerId -> DataConnection (côté hôte uniquement)
    this.hostConn = null; // côté invité uniquement
    this._reqId = 0;
    this._pending = new Map();
  }

  get id() { return this.myId; }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  _fire(event, payload) {
    (this.handlers.get(event) || []).forEach((h) => {
      try { h(payload); } catch (e) { console.error("[net] erreur handler", event, e); }
    });
  }

  /** Équivalent de socket.emit : appel "serveur" (RPC) avec accusé de réception optionnel. */
  emit(event, payload, cb) {
    if (this.isHost) {
      // L'hôte est son propre serveur : traitement local synchrone/async direct.
      HostLogic.handle(this.myId, event, payload, cb);
    } else {
      if (!this.hostConn || !this.hostConn.open) {
        cb?.({ ok: false, error: "Connexion à l'hôte perdue." });
        return;
      }
      const reqId = ++this._reqId;
      if (cb) {
        // Filet de sécurité : si l'accusé de réception de l'hôte n'arrive jamais
        // (message perdu, connexion P2P qui vacille sur un gros envoi comme une
        // photo), on ne reste jamais bloqué en silence — on prévient l'appelant
        // après RPC_TIMEOUT_MS pour qu'il puisse réessayer.
        const timeoutId = setTimeout(() => {
          if (this._pending.has(reqId)) {
            this._pending.delete(reqId);
            cb({ ok: false, error: "L'hôte ne répond pas, réessaie." });
          }
        }, RPC_TIMEOUT_MS);
        this._pending.set(reqId, (response) => {
          clearTimeout(timeoutId);
          cb(response);
        });
      }
      this.hostConn.send({ k: "rpc", event, payload, reqId, ack: !!cb });
    }
  }

  // ---- Diffusion (utilisées côté hôte, depuis host-logic.js) ----
  /** Envoie à TOUS les joueurs (y compris l'hôte lui-même, comme io.to(room).emit). */
  broadcast(event, payload) {
    this._fire(event, payload);
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send({ k: "evt", event, payload });
    }
  }
  /** Envoie à tous SAUF un joueur donné (comme socket.to(room).emit). */
  broadcastExcept(exceptId, event, payload) {
    for (const [peerId, conn] of this.connections.entries()) {
      if (peerId === exceptId) continue;
      if (conn.open) conn.send({ k: "evt", event, payload });
    }
    if (exceptId !== this.myId) this._fire(event, payload);
  }
  /** Envoie à un seul joueur (comme io.to(playerId).emit). */
  sendTo(peerId, event, payload) {
    if (peerId === this.myId) { this._fire(event, payload); return; }
    const conn = this.connections.get(peerId);
    if (conn?.open) conn.send({ k: "evt", event, payload });
  }

  // ---- Cycle de vie côté hôte ----
  /** Ouvre un salon : crée un Peer avec un ID = code de salon, et attend les connexions. */
  startHosting(onReady, onFatalError) {
    const tryOpen = (attemptsLeft) => {
      const code = randomRoomCode();
      const peer = new Peer(ID_PREFIX + code, PEERJS_OPTIONS);
      let settled = false;

      peer.on("open", (id) => {
        settled = true;
        this.peer = peer;
        this.isHost = true;
        this.myId = id;
        this.roomCode = code;
        peer.on("connection", (conn) => this._acceptGuest(conn));
        peer.on("error", (err) => console.error("[net] erreur peer (hôte):", err));
        peer.on("disconnected", () => console.warn("[net] déconnecté du broker de signalisation"));
        onReady(id, code);
      });
      peer.on("error", (err) => {
        if (settled) return;
        peer.destroy();
        if (err.type === "unavailable-id" && attemptsLeft > 0) {
          tryOpen(attemptsLeft - 1); // collision de code, on retire un autre code
        } else {
          onFatalError(err);
        }
      });
    };
    tryOpen(5);
  }

  _acceptGuest(conn) {
    conn.on("open", () => {
      this.connections.set(conn.peer, conn);
      console.log("[net] invité connecté :", conn.peer);
    });
    conn.on("data", (msg) => {
      if (msg?.k === "rpc") {
        HostLogic.handle(conn.peer, msg.event, msg.payload, (response) => {
          if (msg.ack) conn.send({ k: "ack", reqId: msg.reqId, response });
        });
      }
    });
    const onGone = () => {
      if (this.connections.get(conn.peer) === conn) {
        console.warn("[net] invité déconnecté :", conn.peer);
        this.connections.delete(conn.peer);
        HostLogic.handle(conn.peer, "disconnect", null, () => {});
      }
    };
    conn.on("close", onGone);
    conn.on("error", (err) => { console.error("[net] erreur connexion invité:", conn.peer, err); onGone(); });
  }

  // ---- Cycle de vie côté invité ----
  /** Rejoint un salon existant en se connectant directement au pair hôte. */
  connectToHost(code, onOpen, onError) {
    const targetId = ID_PREFIX + code.trim().toUpperCase();
    const peer = new Peer(PEERJS_OPTIONS);

    peer.on("open", () => {
      this.peer = peer;
      this.isHost = false;
      this.myId = peer.id;
      this.roomCode = code.trim().toUpperCase();

      const conn = peer.connect(targetId, { reliable: true });
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          onError("Salon introuvable ou hôte injoignable.");
          try { conn.close(); } catch {}
        }
      }, 12000);

      conn.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.hostConn = conn;
        conn.on("data", (msg) => this._onHostMessage(msg));
        conn.on("close", () => this._fire("host_disconnected"));
        conn.on("error", () => this._fire("host_disconnected"));
        onOpen();
      });
      conn.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        onError("Impossible de rejoindre ce salon.");
      });
    });

    peer.on("error", (err) => {
      onError(
        err.type === "peer-unavailable"
          ? "Aucun salon ouvert avec ce code."
          : "Erreur réseau : " + (err.type || err.message || "inconnue")
      );
    });
  }

  _onHostMessage(msg) {
    if (msg?.k === "evt") {
      this._fire(msg.event, msg.payload);
    } else if (msg?.k === "ack") {
      const cb = this._pending.get(msg.reqId);
      if (cb) { this._pending.delete(msg.reqId); cb(msg.response); }
    }
  }

  teardown() {
    this.connections.forEach((c) => { try { c.close(); } catch {} });
    this.connections.clear();
    try { this.hostConn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
  }
}

const Net = new Network();
