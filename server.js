
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;
const ARENA = 'jujutsu-battle-royale';
const players = new Map();

app.get('/', (_req, res) => {
  res.status(200).send('Jujutsu-Kaizen multiplayer server is running.');
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, players: players.size });
});

function cleanText(value, max = 18) {
  return String(value ?? '')
    .replace(/[<>\u0000-\u001f]/g, '')
    .trim()
    .slice(0, max) || 'Feiticeiro';
}

function numberIn(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(min, Math.min(max, n))
    : fallback;
}

function publicPlayer(id, p) {
  return { id, ...p };
}

function sendArenaState() {
  io.to(ARENA).emit(
    'arena-state',
    [...players.entries()].map(([id, p]) => publicPlayer(id, p))
  );
}

io.on('connection', socket => {
  socket.on('join-arena', data => {
    socket.join(ARENA);

    const p = {
      name: cleanText(data?.name),
      skin: cleanText(data?.skin, 40) || 'sukuna_megumi',
      tech: cleanText(data?.tech, 40) || 'limitless',
      x: numberIn(data?.x, 500, 0, 10000),
      y: numberIn(data?.y, 400, 0, 10000),
      hp: numberIn(data?.hp, 100, 0, 10000),
      maxHp: numberIn(data?.maxHp, 100, 1, 10000),
      alive: true,
      face: numberIn(data?.face, 1, -1, 1)
    };

    players.set(socket.id, p);

    socket.emit(
      'arena-state',
      [...players.entries()].map(([id, player]) =>
        publicPlayer(id, player)
      )
    );

    socket.to(ARENA).emit(
      'player-joined',
      publicPlayer(socket.id, p)
    );
  });

  socket.on('player-state', data => {
    const p = players.get(socket.id);
    if (!p) return;

    p.x = numberIn(data?.x, p.x, 0, 10000);
    p.y = numberIn(data?.y, p.y, 0, 10000);
    p.hp = numberIn(data?.hp, p.hp, 0, 10000);
    p.maxHp = numberIn(data?.maxHp, p.maxHp, 1, 10000);
    p.alive = data?.alive !== false && p.hp > 0;
    p.name = cleanText(data?.name ?? p.name);
    p.skin = cleanText(data?.skin ?? p.skin, 40);
    p.tech = cleanText(data?.tech ?? p.tech, 40);
    p.face = numberIn(data?.face, p.face, -1, 1);

    socket.to(ARENA).emit(
      'player-state',
      publicPlayer(socket.id, p)
    );
  });

  socket.on('pvp-melee', data => {
    const attacker = players.get(socket.id);
    if (!attacker) return;

    const x = numberIn(data?.x, attacker.x, 0, 10000);
    const y = numberIn(data?.y, attacker.y, 0, 10000);
    const face = numberIn(data?.face, attacker.face, -1, 1);

    for (const [targetId, target] of players) {
      if (targetId === socket.id || !target.alive) continue;

      const dx = target.x - x;
      const dy = target.y - y;

      if (Math.hypot(dx, dy) <= 62 && dx * face > -18) {
        io.to(targetId).emit('pvp-hit', {
          targetId,
          attackerId: socket.id,
          damage: 8
        });
      }
    }
  });

  // Transmite projéteis de técnicas especiais aos outros jogadores.
  socket.on('pvp-technique', data => {
    const p = players.get(socket.id);

    const allowed = [
      'red', 'blue', 'purple', 'dismantle',
      'cleave', 'fuga', 'fire_arrow',
      'ten_shadows', 'innate', 'innate_area'
    ];

    if (!p || !data || !allowed.includes(data.type)) return;

    const payload = {
      attackerId: socket.id,
      type: data.type,
      x: numberIn(data.x, p.x, 0, 10000),
      y: numberIn(data.y, p.y, 0, 10000),
      vx: numberIn(data.vx, 0, -1000, 1000),
      vy: numberIn(data.vy, 0, -1000, 1000),
      r: numberIn(data.r, 10, 5, 30),
      life: numberIn(data.life, 1.5, 0.1, 3),
      damage: numberIn(data.damage, 10, 1, 100)
    };

    socket.to(ARENA).emit('pvp-technique', payload);
  });

  // Transmite ataques em área, incluindo expansões de domínio.
  socket.on('pvp-area', data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    socket.to(ARENA).emit('pvp-area', {
      attackerId: socket.id,
      type: cleanText(data.type, 32),
      x: numberIn(data.x, p.x, 0, 10000),
      y: numberIn(data.y, p.y, 0, 10000),
      radius: numberIn(data.radius, 100, 10, 300),
      damage: numberIn(data.damage, 10, 1, 100)
    });
  });

  socket.on('arena-death', () => {
    const p = players.get(socket.id);
    if (!p) return;

    p.hp = 0;
    p.alive = false;

    socket.to(ARENA).emit(
      'player-state',
      publicPlayer(socket.id, p)
    );
  });

  socket.on('player-respawn', data => {
    const p = players.get(socket.id);
    if (!p) return;

    p.x = numberIn(data?.x, p.x, 0, 10000);
    p.y = numberIn(data?.y, p.y, 0, 10000);
    p.hp = numberIn(data?.hp, p.maxHp, 1, 10000);
    p.maxHp = numberIn(data?.maxHp, p.maxHp, 1, 10000);
    p.alive = true;

    socket.to(ARENA).emit(
      'player-state',
      publicPlayer(socket.id, p)
    );
  });

  socket.on('leave-arena', () => {
    socket.leave(ARENA);
    players.delete(socket.id);
    socket.to(ARENA).emit('player-left', socket.id);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    socket.to(ARENA).emit('player-left', socket.id);
    sendArenaState();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Jujutsu-Kaizen server listening on ${PORT}`);
});
