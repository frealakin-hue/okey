const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PLAYERS = 4;

const COLORS = [
  { key: "black", name: "Siyah", rank: 0 },
  { key: "red", name: "Kırmızı", rank: 1 },
  { key: "blue", name: "Mavi", rank: 2 },
  { key: "yellow", name: "Sarı", rank: 3 }
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const rooms = new Map();
const clients = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let requestPath = decodeURIComponent(url.pathname);

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  clients.set(socket, {
    socket,
    buffer: Buffer.alloc(0),
    playerId: null,
    roomCode: null
  });

  socket.on("data", (chunk) => handleSocketData(socket, chunk));
  socket.on("close", () => handleSocketClose(socket));
  socket.on("error", () => handleSocketClose(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Okey Masası hazır: http://localhost:${PORT}`);
});

function handleSocketData(socket, chunk) {
  const client = clients.get(socket);
  if (!client) return;

  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length > 0) {
    const frame = readFrame(client.buffer);
    if (!frame) break;

    client.buffer = client.buffer.subarray(frame.bytes);

    if (frame.opcode === 0x8) {
      socket.end();
      return;
    }

    if (frame.opcode === 0x9) {
      writeFrame(socket, frame.payload, 0xA);
      continue;
    }

    if (frame.opcode !== 0x1) {
      continue;
    }

    try {
      const message = JSON.parse(frame.payload.toString("utf8"));
      handleMessage(socket, message);
    } catch {
      sendToSocket(socket, {
        type: "notice",
        level: "error",
        message: "Mesaj okunamadı."
      });
    }
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) === 0x80;
  let length = secondByte & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(bigLength);
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked && mask) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }

  return {
    opcode,
    payload,
    bytes: offset + length
  };
}

function writeFrame(socket, payload, opcode = 0x1) {
  if (!socket.writable) return;

  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;

  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  socket.write(Buffer.concat([header, body]));
}

function sendToSocket(socket, payload) {
  writeFrame(socket, JSON.stringify(payload));
}

function handleMessage(socket, message) {
  if (message.type === "join") {
    joinRoom(socket, message);
    return;
  }

  if (message.type === "action") {
    handleAction(socket, message);
    return;
  }

  sendToSocket(socket, {
    type: "notice",
    level: "error",
    message: "Bilinmeyen komut."
  });
}

function joinRoom(socket, message) {
  const client = clients.get(socket);
  if (!client) return;

  const name = sanitizeName(message.name);
  if (!name) {
    sendToSocket(socket, {
      type: "notice",
      level: "error",
      message: "Oyuncu adı gir."
    });
    return;
  }

  const requestedCode = sanitizeRoomCode(message.roomCode);
  const roomCode = requestedCode || createRoomCode();
  const room = getOrCreateRoom(roomCode);
  const requestedPlayerId = sanitizeId(message.playerId);
  let player = requestedPlayerId
    ? room.players.find((candidate) => candidate.id === requestedPlayerId)
    : null;

  if (!player) {
    if (room.players.length >= MAX_PLAYERS) {
      sendToSocket(socket, {
        type: "notice",
        level: "error",
        message: "Bu oda dolu. Başka oda kodu dene."
      });
      return;
    }

    player = {
      id: crypto.randomUUID(),
      name,
      score: 0,
      seat: room.players.length,
      connected: true,
      joinedAt: Date.now()
    };
    room.players.push(player);

    if (!room.hostId) {
      room.hostId = player.id;
    }
  } else {
    player.name = name;
    player.connected = true;
  }

  client.playerId = player.id;
  client.roomCode = room.code;

  room.lastSeen = Date.now();
  room.lastMove = `${player.name} odaya katıldı.`;

  if (room.players.length === MAX_PLAYERS && room.game.status === "waiting") {
    startHand(room);
  }

  broadcastRoom(room);
}

function handleAction(socket, message) {
  const client = clients.get(socket);
  if (!client || !client.roomCode || !client.playerId) {
    sendToSocket(socket, {
      type: "notice",
      level: "error",
      message: "Önce odaya katıl."
    });
    return;
  }

  const room = rooms.get(client.roomCode);
  const player = room?.players.find((candidate) => candidate.id === client.playerId);

  if (!room || !player) {
    sendToSocket(socket, {
      type: "notice",
      level: "error",
      message: "Oda bulunamadı."
    });
    return;
  }

  const action = String(message.action || "");

  if (action === "startHand") {
    if (room.players.length !== MAX_PLAYERS) {
      return sendActionError(socket, "Yeni el için 4 oyuncu gerekli.");
    }
    startHand(room);
    broadcastRoom(room);
    return;
  }

  if (action === "adjustScore") {
    adjustScore(room, player, message);
    broadcastRoom(room);
    return;
  }

  if (room.game.status !== "playing") {
    return sendActionError(socket, "El başlamadan bu hamle yapılamaz.");
  }

  if (room.game.activePlayerId !== player.id) {
    return sendActionError(socket, "Sıra sende değil.");
  }

  if (action === "drawWall") {
    drawWall(room, player, socket);
  } else if (action === "takeDiscard") {
    takeDiscard(room, player, socket);
  } else if (action === "discard") {
    discardTile(room, player, message.tileId, socket);
  } else if (action === "finish") {
    finishHand(room, player, message.tileId, socket);
  } else {
    return sendActionError(socket, "Bilinmeyen hamle.");
  }

  broadcastRoom(room);
}

function adjustScore(room, player, message) {
  if (room.hostId !== player.id) {
    return;
  }

  const target = room.players.find((candidate) => candidate.id === sanitizeId(message.playerId));
  const delta = Math.trunc(Number(message.delta || 0));

  if (!target || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 500) {
    return;
  }

  target.score += delta;
  room.scoreEvents.unshift({
    at: Date.now(),
    text: `${player.name}, ${target.name} için ${delta > 0 ? "+" : ""}${delta} puan yazdı.`
  });
  room.scoreEvents = room.scoreEvents.slice(0, 8);
  room.lastMove = room.scoreEvents[0].text;
}

function drawWall(room, player, socket) {
  if (room.game.phase !== "draw") {
    return sendActionError(socket, "Önce taş atmalısın.");
  }

  const hand = room.game.hands[player.id];
  if (!hand || hand.length !== 14) {
    return sendActionError(socket, "Çekme için elde 14 taş olmalı.");
  }

  const tile = room.game.wall.pop();
  if (!tile) {
    room.game.status = "finished";
    room.game.phase = "done";
    room.game.lastMove = "Deste bitti. Yeni el başlatabilirsin.";
    return;
  }

  hand.push(tile);
  room.game.phase = "discard";
  room.game.lastMove = `${player.name} desteden taş çekti.`;
}

function takeDiscard(room, player, socket) {
  if (room.game.phase !== "draw") {
    return sendActionError(socket, "Önce taş atmalısın.");
  }

  const hand = room.game.hands[player.id];
  if (!hand || hand.length !== 14) {
    return sendActionError(socket, "Yerden almak için elde 14 taş olmalı.");
  }

  const tile = room.game.discardPile.pop();
  if (!tile) {
    return sendActionError(socket, "Ortada alınacak taş yok.");
  }

  hand.push(tile);
  room.game.phase = "discard";
  room.game.lastMove = `${player.name} yerden taş aldı.`;
}

function discardTile(room, player, tileId, socket) {
  if (room.game.phase !== "discard") {
    return sendActionError(socket, "Önce taş çekmelisin.");
  }

  const hand = room.game.hands[player.id];
  if (!hand || hand.length !== 15) {
    return sendActionError(socket, "Atmak için elde 15 taş olmalı.");
  }

  const tile = removeTileById(hand, tileId);
  if (!tile) {
    return sendActionError(socket, "Seçili taş elinde yok.");
  }

  room.game.discardPile.push(tile);
  moveToNextPlayer(room);
  room.game.lastMove = `${player.name} taş attı.`;
}

function finishHand(room, player, tileId, socket) {
  if (room.game.phase !== "discard") {
    return sendActionError(socket, "Bitirmek için önce taş çekmelisin.");
  }

  const hand = room.game.hands[player.id];
  if (!hand || hand.length !== 15) {
    return sendActionError(socket, "Bitirmek için elde 15 taş olmalı.");
  }

  const index = hand.findIndex((tile) => tile.id === tileId);
  if (index === -1) {
    return sendActionError(socket, "Bitiş için atılacak taşı seç.");
  }

  const winningTiles = hand.filter((_, tileIndex) => tileIndex !== index);
  if (!isWinningHand(winningTiles, room.game.okey)) {
    return sendActionError(socket, "Bu el henüz per/seri olarak bitmiyor.");
  }

  const [discarded] = hand.splice(index, 1);
  room.game.discardPile.push(discarded);
  room.game.status = "finished";
  room.game.phase = "done";
  room.game.winnerId = player.id;

  for (const candidate of room.players) {
    candidate.score += candidate.id === player.id ? 20 : -10;
  }

  const result = `${player.name} eli bitirdi. +20 puan yazıldı.`;
  room.game.lastMove = result;
  room.scoreEvents.unshift({
    at: Date.now(),
    text: result
  });
  room.scoreEvents = room.scoreEvents.slice(0, 8);
}

function moveToNextPlayer(room) {
  const current = room.players.find((player) => player.id === room.game.activePlayerId);
  const nextSeat = ((current?.seat ?? 0) + 1) % MAX_PLAYERS;
  const next = room.players.find((player) => player.seat === nextSeat) || room.players[0];
  room.game.activePlayerId = next.id;
  room.game.phase = "draw";
}

function sendActionError(socket, message) {
  sendToSocket(socket, {
    type: "notice",
    level: "error",
    message
  });
}

function startHand(room) {
  const deck = shuffle(createDeck());
  let indicator = deck.pop();

  while (indicator?.type !== "normal") {
    deck.unshift(indicator);
    indicator = deck.pop();
  }

  const okey = {
    color: indicator.color,
    colorName: colorName(indicator.color),
    number: indicator.number === 13 ? 1 : indicator.number + 1
  };

  const previousDealer = Number.isInteger(room.game.dealerSeat) ? room.game.dealerSeat : randomInt(0, 3);
  const dealerSeat = (previousDealer + 1) % MAX_PLAYERS;
  const activeSeat = (dealerSeat + 1) % MAX_PLAYERS;
  const active = room.players.find((player) => player.seat === activeSeat) || room.players[0];
  const hands = {};

  for (const player of room.players) {
    hands[player.id] = [];
  }

  for (let round = 0; round < 14; round += 1) {
    for (const player of room.players) {
      hands[player.id].push(deck.pop());
    }
  }

  hands[active.id].push(deck.pop());

  for (const player of room.players) {
    hands[player.id].sort((a, b) => tileSortValue(a, okey) - tileSortValue(b, okey));
  }

  room.game = {
    status: "playing",
    handNumber: (room.game.handNumber || 0) + 1,
    dealerSeat,
    activePlayerId: active.id,
    phase: "discard",
    wall: deck,
    discardPile: [],
    hands,
    indicator,
    okey,
    winnerId: null,
    lastMove: `${active.name} 15 taşla başlıyor.`
  };
}

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (let number = 1; number <= 13; number += 1) {
      for (let copy = 1; copy <= 2; copy += 1) {
        deck.push({
          id: `${color.key}-${number}-${copy}-${crypto.randomUUID()}`,
          type: "normal",
          color: color.key,
          number,
          copy
        });
      }
    }
  }

  deck.push({ id: `fake-1-${crypto.randomUUID()}`, type: "fake", copy: 1 });
  deck.push({ id: `fake-2-${crypto.randomUUID()}`, type: "fake", copy: 2 });
  return deck;
}

function shuffle(items) {
  const deck = [...items];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const target = randomInt(0, index);
    [deck[index], deck[target]] = [deck[target], deck[index]];
  }
  return deck;
}

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function removeTileById(hand, tileId) {
  const index = hand.findIndex((tile) => tile.id === tileId);
  if (index === -1) return null;
  const [tile] = hand.splice(index, 1);
  return tile;
}

function tileSortValue(tile, okey) {
  if (tile.type === "fake") return 500 + tile.copy;
  const colorRank = COLORS.find((color) => color.key === tile.color)?.rank ?? 9;
  const isOkey = tile.color === okey.color && tile.number === okey.number;
  return colorRank * 20 + tile.number + (isOkey ? 300 : 0);
}

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId: null,
      players: [],
      scoreEvents: [],
      lastSeen: Date.now(),
      game: {
        status: "waiting",
        handNumber: 0,
        dealerSeat: null,
        activePlayerId: null,
        phase: "waiting",
        wall: [],
        discardPile: [],
        hands: {},
        indicator: null,
        okey: null,
        winnerId: null,
        lastMove: "4 oyuncu bekleniyor."
      }
    });
  }
  return rooms.get(code);
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 5; index += 1) {
      code += alphabet[randomInt(0, alphabet.length - 1)];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomUUID().slice(0, 5).toUpperCase();
}

function sanitizeRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function sanitizeId(value) {
  const text = String(value || "");
  return /^[a-zA-Z0-9-]{8,80}$/.test(text) ? text : "";
}

function sanitizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .slice(0, 24);
}

function handleSocketClose(socket) {
  const client = clients.get(socket);
  if (!client) return;

  const room = client.roomCode ? rooms.get(client.roomCode) : null;
  const player = room?.players.find((candidate) => candidate.id === client.playerId);
  if (player) {
    const hasOtherConnection = [...clients.values()].some(
      (candidate) =>
        candidate.socket !== socket &&
        candidate.roomCode === room.code &&
        candidate.playerId === player.id &&
        candidate.socket.writable
    );
    player.connected = hasOtherConnection;
    if (!hasOtherConnection) {
      room.lastMove = `${player.name} bağlantıyı kaybetti.`;
    }
  }

  clients.delete(socket);

  if (room) {
    broadcastRoom(room);
  }
}

function broadcastRoom(room) {
  for (const client of clients.values()) {
    if (client.roomCode !== room.code || !client.playerId) continue;
    sendToSocket(client.socket, createStateFor(room, client.playerId));
  }
}

function createStateFor(room, viewerId) {
  const game = room.game;
  const hand = game.hands?.[viewerId] || [];
  const activePlayer = room.players.find((player) => player.id === game.activePlayerId);

  return {
    type: "state",
    you: {
      playerId: viewerId,
      roomCode: room.code,
      hostId: room.hostId,
      isHost: room.hostId === viewerId,
      seat: room.players.find((player) => player.id === viewerId)?.seat ?? 0
    },
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      seat: player.seat,
      connected: player.connected,
      tileCount: game.hands?.[player.id]?.length || 0,
      isHost: room.hostId === player.id
    })),
    game: {
      status: game.status,
      handNumber: game.handNumber,
      phase: game.phase,
      activePlayerId: game.activePlayerId,
      activePlayerName: activePlayer?.name || "",
      wallCount: game.wall?.length || 0,
      discardTop: publicTile(game.discardPile?.at(-1), game.okey),
      discardPile: (game.discardPile || []).slice(-5).map((tile) => publicTile(tile, game.okey)),
      indicator: publicTile(game.indicator, game.okey),
      okey: game.okey,
      winnerId: game.winnerId,
      lastMove: game.lastMove || room.lastMove || "",
      canStart: room.players.length === MAX_PLAYERS,
      waitingFor: Math.max(0, MAX_PLAYERS - room.players.length)
    },
    hand: hand.map((tile) => publicTile(tile, game.okey)),
    scoreEvents: room.scoreEvents
  };
}

function publicTile(tile, okey) {
  if (!tile) return null;

  if (tile.type === "fake") {
    return {
      id: tile.id,
      type: "fake",
      color: okey?.color || "black",
      colorName: okey?.colorName || "Okey",
      number: okey?.number || 0,
      label: "S",
      copy: tile.copy,
      isOkey: false,
      isFake: true
    };
  }

  return {
    id: tile.id,
    type: "normal",
    color: tile.color,
    colorName: colorName(tile.color),
    number: tile.number,
    label: String(tile.number),
    copy: tile.copy,
    isOkey: Boolean(okey && tile.color === okey.color && tile.number === okey.number),
    isFake: false
  };
}

function colorName(key) {
  return COLORS.find((color) => color.key === key)?.name || key;
}

function isWinningHand(tiles, okey) {
  if (!okey || tiles.length !== 14) return false;
  const normalized = normalizeTiles(tiles, okey);
  return canWinAsPairs(normalized) || canWinAsMelds(normalized);
}

function normalizeTiles(tiles, okey) {
  const counts = new Map();
  let wild = 0;

  for (const tile of tiles) {
    if (tile.type === "normal" && tile.color === okey.color && tile.number === okey.number) {
      wild += 1;
      continue;
    }

    const color = tile.type === "fake" ? okey.color : tile.color;
    const number = tile.type === "fake" ? okey.number : tile.number;
    const key = tileKey(color, number);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return { counts, wild };
}

function canWinAsPairs({ counts, wild }) {
  let pairs = 0;
  let singles = 0;

  for (const count of counts.values()) {
    pairs += Math.floor(count / 2);
    singles += count % 2;
  }

  if (singles > wild) return false;
  wild -= singles;
  pairs += singles;
  pairs += Math.floor(wild / 2);
  return pairs >= 7;
}

function canWinAsMelds({ counts, wild }) {
  const memo = new Set();

  function search(currentCounts, currentWild) {
    const first = firstTile(currentCounts);
    if (!first) {
      return currentWild === 0;
    }

    const memoKey = serializeCounts(currentCounts, currentWild);
    if (memo.has(memoKey)) return false;
    memo.add(memoKey);

    for (const option of setOptions(first)) {
      const attempt = consumeOption(currentCounts, currentWild, option);
      if (attempt && search(attempt.counts, attempt.wild)) return true;
    }

    for (const option of runOptions(first)) {
      const attempt = consumeOption(currentCounts, currentWild, option);
      if (attempt && search(attempt.counts, attempt.wild)) return true;
    }

    return false;
  }

  return search(new Map(counts), wild);
}

function firstTile(counts) {
  for (const color of COLORS) {
    for (let number = 1; number <= 13; number += 1) {
      if ((counts.get(tileKey(color.key, number)) || 0) > 0) {
        return { color: color.key, number };
      }
    }
  }
  return null;
}

function setOptions(first) {
  const options = [];
  const colors = COLORS.map((color) => color.key);

  for (const size of [3, 4]) {
    for (const combination of combinations(colors, size)) {
      if (!combination.includes(first.color)) continue;
      options.push(combination.map((color) => ({ color, number: first.number })));
    }
  }

  return options;
}

function runOptions(first) {
  const options = [];

  for (let length = 3; length <= 13; length += 1) {
    const minStart = Math.max(1, first.number - length + 1);
    const maxStart = Math.min(first.number, 14 - length);

    for (let start = minStart; start <= maxStart; start += 1) {
      const run = [];
      for (let number = start; number < start + length; number += 1) {
        run.push({ color: first.color, number });
      }
      options.push(run);
    }
  }

  return options;
}

function consumeOption(counts, wild, option) {
  const next = new Map(counts);
  let missing = 0;

  for (const tile of option) {
    const key = tileKey(tile.color, tile.number);
    const count = next.get(key) || 0;
    if (count > 0) {
      if (count === 1) {
        next.delete(key);
      } else {
        next.set(key, count - 1);
      }
    } else {
      missing += 1;
      if (missing > wild) return null;
    }
  }

  return {
    counts: next,
    wild: wild - missing
  };
}

function combinations(items, size) {
  const result = [];

  function walk(start, picked) {
    if (picked.length === size) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      picked.push(items[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  }

  walk(0, []);
  return result;
}

function serializeCounts(counts, wild) {
  const pieces = [String(wild)];
  for (const color of COLORS) {
    for (let number = 1; number <= 13; number += 1) {
      pieces.push(String(counts.get(tileKey(color.key, number)) || 0));
    }
  }
  return pieces.join("");
}

function tileKey(color, number) {
  return `${color}:${number}`;
}
