const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET'] },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 10000;
const ARENA = 'jujutsu-battle-royale';
const players = new Map();
const lastAttack = new Map();

app.get('/', (_req, res) => res.send('Jujutsu RPG multiplayer server is online.'));
app.get('/health', (_req, res) => res.json({ status: 'ok', players: players.size }));

function cleanNumber(value, fallback = 0, min = -10000, max = 10000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function publicPlayer(id, p) { return { id, ...p }; }
function broadcastPlayer(id) {
  const p = players.get(id);
  if (p) io.to(ARENA).emit('player-state', publicPlayer(id, p));
}
function removePlayer(id) {
  if (!players.has(id)) return;
  players.delete(id);
  lastAttack.delete(id);
  io.to(ARENA).emit('player-left', id);
}

io.on('connection', (socket) => {
  socket.on('join-arena', (data = {}) => {
    if (socket.data.inArena) return;
    socket.join(ARENA);
    socket.data.inArena = true;
    const p = {
      name: String(data.name || 'Feiticeiro').slice(0, 18),
      skin: String(data.skin || 'sukuna_megumi').slice(0, 40),
      tech: String(data.tech || 'limitless').slice(0, 40),
      x: cleanNumber(data.x, 500, 0, 10000),
      y: cleanNumber(data.y, 500, 0, 10000),
      hp: cleanNumber(data.hp, 100, 0, 10000),
      maxHp: cleanNumber(data.hp, 100, 1, 10000),
      face: 1,
      alive: true,
    };
    players.set(socket.id, p);
    socket.emit('arena-state', [...players.entries()].map(([id, player]) => publicPlayer(id, player)));
    socket.to(ARENA).emit('player-joined', publicPlayer(socket.id, p));
  });

  socket.on('player-state', (data = {}) => {
    if (!socket.data.inArena || !players.has(socket.id)) return;
    const p = players.get(socket.id);
    p.x = cleanNumber(data.x, p.x, 0, 10000);
    p.y = cleanNumber(data.y, p.y, 0, 10000);
    p.hp = cleanNumber(data.hp, p.hp, 0, p.maxHp);
    p.maxHp = cleanNumber(data.maxHp, p.maxHp, 1, 10000);
    p.alive = Boolean(data.alive) && p.hp > 0;
    p.name = String(data.name || p.name).slice(0, 18);
    p.skin = String(data.skin || p.skin).slice(0, 40);
    p.tech = String(data.tech || p.tech).slice(0, 40);
    p.face = cleanNumber(data.face, p.face, -1, 1) || 1;
    broadcastPlayer(socket.id);
  });

  socket.on('pvp-melee', (data = {}) => {
    if (!socket.data.inArena || !players.has(socket.id)) return;
    const attacker = players.get(socket.id);
    if (!attacker.alive) return;
    const now = Date.now();
    if (now - (lastAttack.get(socket.id) || 0) < 300) return;
    lastAttack.set(socket.id, now);
    const ax = cleanNumber(data.x, attacker.x, 0, 10000);
    const ay = cleanNumber(data.y, attacker.y, 0, 10000);
    const face = cleanNumber(data.face, attacker.face, -1, 1) || 1;
    for (const [targetId, target] of players) {
      if (targetId === socket.id || !target.alive) continue;
      const dx = target.x - ax;
      const dy = target.y - ay;
      if (Math.hypot(dx, dy) <= 62 && dx * face >= -12) {
        io.to(targetId).emit('pvp-hit', { targetId, attackerId: socket.id, damage: 12 });
        break;
      }
    }
  });

  socket.on('arena-death', () => {
    const p = players.get(socket.id);
    if (!p) return;
    p.alive = false;
    p.hp = 0;
    broadcastPlayer(socket.id);
  });

  socket.on('player-respawn', (data = {}) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = cleanNumber(data.x, p.x, 0, 10000);
    p.y = cleanNumber(data.y, p.y, 0, 10000);
    p.maxHp = cleanNumber(data.maxHp, p.maxHp, 1, 10000);
    p.hp = cleanNumber(data.hp, p.maxHp, 1, p.maxHp);
    p.alive = true;
    broadcastPlayer(socket.id);
  });

  socket.on('leave-arena', () => {
    removePlayer(socket.id);
    socket.leave(ARENA);
    socket.data.inArena = false;
  });
  socket.on('disconnect', () => removePlayer(socket.id));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Jujutsu multiplayer server listening on ${PORT}`));
