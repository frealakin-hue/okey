const app = document.querySelector("#app");

const icons = {
  users:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="2"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  logIn:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m10 17 5-5-5-5M15 12H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  draw:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="3" width="10" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 21h6M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  take:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  throw:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 12 16-8-5 16-3-7-8-1Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  finish:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  leave:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 17l5-5-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 12H3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 3v18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
};

let socket;
let reconnectTimer;
let connected = false;
let latestState = null;
let selectedTileId = null;
let sortMode = "color";
let notice = null;
let noticeTimer = null;
let intentionallyLeft = false;
const pendingMessages = [];

const savedSession = readSession();

connect();
render();

document.addEventListener("submit", (event) => {
  const joinForm = event.target.closest("#join-form");
  if (joinForm) {
    event.preventDefault();

    intentionallyLeft = false;

    const form = new FormData(joinForm);
    const name = String(form.get("name") || "").trim();
    const roomCode = String(form.get("roomCode") || "").trim();

    if (!name) {
      showNotice("Oyuncu adı gir.", "error");
      return;
    }

    send({
      type: "join",
      name,
      roomCode,
      playerId: savedSession.playerId || ""
    });

    return;
  }

  const scoreForm = event.target.closest("#score-form");
  if (scoreForm) {
    event.preventDefault();

    const form = new FormData(scoreForm);

    send({
      type: "action",
      action: "adjustScore",
      playerId: String(form.get("playerId") || ""),
      delta: Number(form.get("delta") || 0)
    });

    scoreForm.reset();
  }
});

document.addEventListener("click", (event) => {
  const leaveButton = event.target.closest("[data-leave-room]");
  if (leaveButton) {
    leaveRoom();
    return;
  }

  const tileButton = event.target.closest("[data-tile-id]");
  if (tileButton && tileButton.matches("button")) {
    const id = tileButton.getAttribute("data-tile-id");
    selectedTileId = selectedTileId === id ? null : id;
    render();
    return;
  }

  const sortButton = event.target.closest("[data-sort]");
  if (sortButton) {
    sortMode = sortButton.getAttribute("data-sort");
    render();
    return;
  }

  const copyButton = event.target.closest("[data-copy-room]");
  if (copyButton) {
    const code = latestState?.you?.roomCode || "";
    if (!code) return;

    navigator.clipboard?.writeText(code);
    showNotice(`Oda kodu kopyalandı: ${code}`);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton || actionButton.disabled) return;

  const action = actionButton.getAttribute("data-action");

  if (action === "discard" || action === "finish") {
    if (!selectedTileId) {
      showNotice("Önce bir taş seç.", "error");
      return;
    }

    send({
      type: "action",
      action,
      tileId: selectedTileId
    });

    selectedTileId = null;
    return;
  }

  send({ type: "action", action });
});

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("open", () => {
    connected = true;

    if (
      !intentionallyLeft &&
      !pendingMessages.length &&
      savedSession.name &&
      savedSession.roomCode &&
      savedSession.playerId
    ) {
      socket.send(JSON.stringify({
        type: "join",
        name: savedSession.name,
        roomCode: savedSession.roomCode,
        playerId: savedSession.playerId
      }));
    }

    flushPendingMessages();
    render();
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "state") {
      latestState = payload;

      const me = payload.players.find((player) => player.id === payload.you.playerId);

      writeSession({
        playerId: payload.you.playerId,
        roomCode: payload.you.roomCode,
        name: me?.name || savedSession.name || ""
      });

      keepSelectedTileIfPresent(payload.hand);
      render();
      return;
    }

    if (payload.type === "notice") {
      showNotice(payload.message, payload.level);
    }
  });

  socket.addEventListener("close", () => {
    connected = false;
    render();

    clearTimeout(reconnectTimer);

    if (!intentionallyLeft) {
      reconnectTimer = setTimeout(connect, 1300);
    }
  });

  socket.addEventListener("error", () => {
    connected = false;
    render();
  });
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    pendingMessages.push(payload);
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showNotice("Sunucu bağlantısı bekleniyor.", "error");
    return;
  }

  socket.send(JSON.stringify(payload));
}

function flushPendingMessages() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  while (pendingMessages.length) {
    socket.send(JSON.stringify(pendingMessages.shift()));
  }
}

function leaveRoom() {
  if (!latestState) return;

  const ok = confirm("Masadan ayrılmak istiyor musun?");
  if (!ok) return;

  intentionallyLeft = true;
  pendingMessages.length = 0;

  try {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "leave" }));
      socket.close();
    }
  } catch {}

  clearTimeout(reconnectTimer);

  latestState = null;
  selectedTileId = null;

  delete savedSession.roomCode;
  delete savedSession.playerId;
  localStorage.setItem("okeySession", JSON.stringify(savedSession));

  showNotice("Masadan ayrıldın.");
  renderJoin();
}

function render() {
  if (!latestState) {
    renderJoin();
    return;
  }

  renderGame(latestState);
}

function renderJoin() {
  app.innerHTML = `
    <main class="join-screen">
      <section class="join-panel">
        <div class="brand" style="margin-bottom: 18px;">
          <div class="brand-mark">${icons.users}</div>
          <div>
            <h1>Okey Masası</h1>
            <span>4 kişilik online masa</span>
          </div>
        </div>

        <p>İsmini yaz, oda kodu gir veya boş bırakarak yeni masa aç.</p>

        <form id="join-form">
          <div class="field-grid">
            <div class="field">
              <label for="name">Oyuncu adı</label>
              <input id="name" name="name" maxlength="24" autocomplete="name" value="${escapeHtml(savedSession.name || "")}" required />
            </div>

            <div class="field">
              <label for="roomCode">Oda kodu</label>
              <input id="roomCode" name="roomCode" maxlength="8" autocomplete="off" value="${escapeHtml(savedSession.roomCode || "")}" />
            </div>
          </div>

          <div class="join-actions">
            <button class="primary-button" type="submit">${icons.logIn} Odaya Katıl</button>
          </div>
        </form>
      </section>

      ${noticeHtml()}
    </main>
  `;
}

function renderGame(data) {
  const me = data.players.find((player) => player.id === data.you.playerId);
  const hand = sortedHand(data.hand);
  const selectedTile = data.hand.find((tile) => tile.id === selectedTileId);
  const isPlaying = data.game.status === "playing";
  const isYourTurn = isPlaying && data.game.activePlayerId === data.you.playerId;
  const canDraw = isYourTurn && data.game.phase === "draw";
  const canDiscard = isYourTurn && data.game.phase === "discard";
  const canStart = data.game.canStart && data.game.status !== "playing";
  const seatMap = createSeatMap(data);

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">${icons.users}</div>
          <div>
            <h1>Okey Masası</h1>
            <span>${escapeHtml(me?.name || "Oyuncu")} · El ${data.game.handNumber || 0}</span>
          </div>
        </div>

        <div class="room-tools">
          <span class="connection ${connected ? "online" : "offline"}">${connected ? "Bağlı" : "Bağlantı yok"}</span>
          <span class="room-code">Oda ${escapeHtml(data.you.roomCode)}</span>
          <button class="icon-button" type="button" data-copy-room title="Oda kodunu kopyala" aria-label="Oda kodunu kopyala">${icons.copy}</button>
          <button class="ghost-button danger" type="button" data-leave-room>${icons.leave} Masadan Ayrıl</button>
        </div>
      </header>

      <main class="game-layout">
        <section class="table-zone" aria-label="Okey masası">
          <div class="table-surface">
            ${seatHtml(seatMap.top, "top", data)}
            ${seatHtml(seatMap.left, "left", data)}
            ${seatHtml(seatMap.right, "right", data)}
            ${seatHtml(seatMap.bottom, "bottom", data)}

            <div class="center-stacks">
              <div class="stack-card">
                <div class="wall-stack">${data.game.wallCount}</div>
                <strong>Deste</strong>
              </div>

              <div class="stack-card">
                ${data.game.discardTop ? tileHtml(data.game.discardTop, false, true, false) : '<div class="wall-stack">0</div>'}
                <strong>Yer</strong>
              </div>

              <div class="stack-card">
                ${data.game.indicator ? tileHtml(data.game.indicator, false, true, false) : '<div class="wall-stack">?</div>'}
                <strong>Gösterge</strong>
              </div>
            </div>

            ${tableMessage(data)}
          </div>
        </section>

        <aside class="score-panel">
          <section class="panel-section">
            <div class="panel-title">
              <h2>Skor</h2>
              <span>${escapeHtml(data.game.activePlayerName || "Masa")}</span>
            </div>
            ${data.players.map(scoreRowHtml).join("")}
          </section>

          <section class="panel-section">
            <div class="panel-title">
              <h2>Okey</h2>
              <span>${data.game.phase === "discard" ? "Taş at" : data.game.phase === "draw" ? "Taş çek" : "Hazır"}</span>
            </div>

            <div class="score-row">
              <div class="score-player">
                <strong>${data.game.okey ? `${escapeHtml(colorLabel(data.game.okey.color))} ${data.game.okey.number}` : "Belirsiz"}</strong>
                <span>Okey taşı</span>
              </div>
              <div class="score-value">${data.game.waitingFor ? `${4 - data.game.waitingFor}/4` : "4/4"}</div>
            </div>
          </section>

          ${scoreWriterHtml(data)}

          <section class="panel-section">
            <div class="panel-title">
              <h2>Hareket</h2>
              <span>${data.scoreEvents.length}</span>
            </div>

            <ul class="event-list">
              <li>${escapeHtml(data.game.lastMove || "Masa hazır.")}</li>
              ${data.scoreEvents.map((event) => `<li>${escapeHtml(event.text)}</li>`).join("")}
            </ul>
          </section>
        </aside>
      </main>

      <footer class="rack-dock">
        <section class="rack-panel">
          <div class="rack-toolbar">
            <div class="turn-label">
              <strong>${turnTitle(data)}</strong>
              <span>${turnSubtitle(data, selectedTile)}</span>
            </div>

            <div class="sort-tools" aria-label="Taş sıralama">
              <button class="ghost-button ${sortMode === "color" ? "active" : ""}" type="button" data-sort="color">Renk</button>
              <button class="ghost-button ${sortMode === "number" ? "active" : ""}" type="button" data-sort="number">Sayı</button>
              <button class="ghost-button ${sortMode === "hand" ? "active" : ""}" type="button" data-sort="hand">El</button>
            </div>
          </div>

          <div class="rack" aria-label="Taşlığım">
            ${hand.length ? hand.map((tile) => tileHtml(tile, tile.id === selectedTileId, false, true)).join("") : '<div class="empty-rack">Taşlar el başlayınca görünür.</div>'}
          </div>

          <div class="action-bar">
            <div class="selected-readout">${selectedTile ? `${escapeHtml(tileText(selectedTile))} seçili` : "Taş seçilmedi"}</div>

            <div class="action-tools">
              <button class="ghost-button" type="button" data-action="drawWall" ${canDraw ? "" : "disabled"}>${icons.draw} Taş Çek</button>
              <button class="ghost-button" type="button" data-action="takeDiscard" ${canDraw && data.game.discardTop ? "" : "disabled"}>${icons.take} Yerden Al</button>
              <button class="ghost-button" type="button" data-action="discard" ${canDiscard && selectedTileId ? "" : "disabled"}>${icons.throw} Taş At</button>
              <button class="ghost-button danger" type="button" data-action="finish" ${canDiscard && selectedTileId ? "" : "disabled"}>${icons.finish} Bitir</button>
              <button class="primary-button" type="button" data-action="startHand" ${canStart ? "" : "disabled"}>${icons.refresh} Yeni El</button>
            </div>
          </div>
        </section>
      </footer>

      ${noticeHtml()}
    </div>
  `;
}

function createSeatMap(data) {
  const positions = { bottom: null, right: null, top: null, left: null };
  const labels = ["bottom", "right", "top", "left"];

  for (const player of data.players) {
    const offset = (player.seat - data.you.seat + 4) % 4;
    positions[labels[offset]] = player;
  }

  for (let seat = 0; seat < 4; seat += 1) {
    const offset = (seat - data.you.seat + 4) % 4;
    const label = labels[offset];

    if (!positions[label]) {
      positions[label] = { empty: true, seat };
    }
  }

  return positions;
}

function seatHtml(player, position, data) {
  if (!player || player.empty) {
    return `
      <div class="seat ${position} empty">
        <div class="seat-name"><span>Bekleniyor</span><span class="seat-score">0</span></div>
        <div class="seat-meta">Koltuk ${Number(player?.seat ?? 0) + 1}</div>
      </div>
    `;
  }

  const active = data.game.activePlayerId === player.id;

  return `
    <div class="seat ${position} ${active ? "active" : ""}">
      <div class="seat-name">
        <span>${escapeHtml(player.name)}${player.isHost ? " · Oda" : ""}</span>
        <span class="seat-score">${player.score}</span>
      </div>

      <div class="seat-meta">
        <span class="seat-status ${player.connected ? "online" : ""}">${player.connected ? "Online" : "Koptu"}</span>
        <span>${player.tileCount} taş</span>
      </div>

      <div class="backs">${tileBacks(player.tileCount)}</div>
    </div>
  `;
}

function tileBacks(count) {
  const visible = Math.min(12, Math.max(0, Number(count) || 0));
  return Array.from({ length: visible }, () => '<span class="tile-back"></span>').join("");
}

function tableMessage(data) {
  if (data.game.waitingFor > 0) {
    return `
      <div class="table-message">
        <strong>Oda ${escapeHtml(data.you.roomCode)}</strong>
        <span>${data.game.waitingFor} oyuncu bekleniyor</span>
      </div>
    `;
  }

  if (data.game.status === "finished") {
    const winner = data.players.find((player) => player.id === data.game.winnerId);

    return `
      <div class="table-message">
        <strong>${winner ? `${escapeHtml(winner.name)} bitti` : "El tamamlandı"}</strong>
        <span>Yeni El düğmesiyle tekrar dağıt.</span>
      </div>
    `;
  }

  return "";
}

function tileHtml(tile, selected, small, interactive) {
  const classes = [
    "tile",
    `tile-${tile.color}`,
    selected ? "selected" : "",
    small ? "small" : "",
    tile.isOkey ? "is-okey" : "",
    tile.isFake ? "is-fake" : ""
  ]
    .filter(Boolean)
    .join(" ");

  const label = tile.isFake ? "S" : escapeHtml(tile.label);
  const title = escapeHtml(tileText(tile));

  if (interactive) {
    return `
      <button class="${classes}" type="button" data-tile-id="${escapeHtml(tile.id)}" title="${title}" aria-label="${title}">
        <span class="tile-number">${label}</span>
        <span class="tile-color"></span>
      </button>
    `;
  }

  return `
    <div class="${classes}" title="${title}" aria-label="${title}">
      <span class="tile-number">${label}</span>
      <span class="tile-color"></span>
    </div>
  `;
}

function scoreRowHtml(player) {
  return `
    <div class="score-row">
      <div class="score-player">
        <strong>${escapeHtml(player.name)}</strong>
        <span>${player.connected ? "Online" : "Bağlantı yok"}${player.isHost ? " · Oda sahibi" : ""}</span>
      </div>
      <div class="score-value">${player.score}</div>
    </div>
  `;
}

function scoreWriterHtml(data) {
  if (!data.you.isHost) return "";

  return `
    <section class="panel-section">
      <div class="panel-title">
        <h2>Puan Yaz</h2>
        <span>Oda sahibi</span>
      </div>

      <form id="score-form" class="score-writer">
        <div class="writer-grid">
          <div>
            <label for="scorePlayer">Oyuncu</label>
            <select id="scorePlayer" name="playerId">
              ${data.players.map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`).join("")}
            </select>
          </div>

          <div>
            <label for="scoreDelta">Puan</label>
            <input id="scoreDelta" name="delta" type="number" step="1" min="-500" max="500" placeholder="+10" required />
          </div>
        </div>

        <button class="primary-button" type="submit">${icons.plus} Puan Yaz</button>
      </form>
    </section>
  `;
}

function turnTitle(data) {
  if (data.game.status === "waiting") return "4 oyuncu bekleniyor";
  if (data.game.status === "finished") return "El bitti";
  if (data.game.activePlayerId === data.you.playerId) return "Sıra sende";
  return `Sıra ${data.game.activePlayerName || "oyuncuda"}`;
}

function turnSubtitle(data, selectedTile) {
  if (data.game.status === "waiting") return `Oda kodu: ${data.you.roomCode}`;
  if (data.game.status === "finished") return "Skor yazıldı, yeni el başlatılabilir.";
  if (data.game.activePlayerId !== data.you.playerId) return "Diğer oyuncunun hamlesi bekleniyor.";
  if (data.game.phase === "draw") return "Desteden çek veya yerdeki taşı al.";
  if (selectedTile) return `${tileText(selectedTile)} ile hamle yapabilirsin.`;
  return "Atmak veya bitirmek için taş seç.";
}

function sortedHand(hand) {
  const colorRank = { black: 0, red: 1, blue: 2, yellow: 3 };
  const copy = [...hand];

  if (sortMode === "hand") return copy;

  return copy.sort((a, b) => {
    if (sortMode === "number") {
      return (a.number || 99) - (b.number || 99) || (colorRank[a.color] ?? 9) - (colorRank[b.color] ?? 9);
    }

    return (colorRank[a.color] ?? 9) - (colorRank[b.color] ?? 9) || (a.number || 99) - (b.number || 99);
  });
}

function keepSelectedTileIfPresent(hand) {
  if (!selectedTileId) return;

  if (!hand.some((tile) => tile.id === selectedTileId)) {
    selectedTileId = null;
  }
}

function tileText(tile) {
  if (!tile) return "";

  if (tile.isFake) return `Sahte okey (${colorLabel(tile.color)} ${tile.number})`;

  return `${colorLabel(tile.color)} ${tile.number}${tile.isOkey ? " okey" : ""}`;
}

function colorLabel(color) {
  const labels = {
    black: "Siyah",
    red: "Kırmızı",
    blue: "Mavi",
    yellow: "Sarı"
  };

  return labels[color] || color;
}

function showNotice(message, level = "info") {
  notice = { message, level };

  clearTimeout(noticeTimer);

  noticeTimer = setTimeout(() => {
    notice = null;
    render();
  }, 3000);

  render();
}

function noticeHtml() {
  if (!notice) return "";

  return `<div class="toast ${notice.level === "error" ? "error" : ""}" role="status">${escapeHtml(notice.message)}</div>`;
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem("okeySession") || "{}");
  } catch {
    return {};
  }
}

function writeSession(session) {
  Object.assign(savedSession, session);
  localStorage.setItem("okeySession", JSON.stringify(savedSession));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}