'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'] },
  transports: ['websocket', 'polling']
});
app.use(express.json({ limit: '2mb' }));
const PORT = process.env.PORT || 3000;
const ARENA = 'jujutsu-battle-royale';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const players = new Map();
const sessions = new Map();
let accounts = {};

function loadAccounts() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch (e) { accounts = {}; }
}
function persistAccounts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(accounts), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
}
loadAccounts();
app.get('/', (_req, res) => res.status(200).send('Jujutsu-Kaizen multiplayer and account server is running.'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, players: players.size, accounts: Object.keys(accounts).length }));
function cleanText(value, max = 18) { return String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) || 'Feiticeiro'; }
function numberIn(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function publicPlayer(id, p) { return { id, ...p }; }
function sendArenaState() { io.to(ARENA).emit('arena-state', [...players.entries()].map(([id, p]) => publicPlayer(id, p))); }
function normalizeNick(value) { return String(value || '').trim().toLowerCase(); }
function validNick(value) { return typeof value === 'string' && /^[\p{L}\p{N}_-]{3,20}$/u.test(value.trim()); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, derived) => err ? reject(err) : resolve({ salt, hash: derived.toString('hex') })));
}
function safeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (JSON.stringify(value).length > 4_500_000) return null;
  const allowed = ['avatar','stats','level','xp','points','highestMission','completed','selectedMission','mission','missionKills','specialCompleted','simpleCompleted','simpleUnlocked','rctCompleted','rctUnlocked','shadowCooldowns','shadowCooldownStamp'];
  function cleanCharacter(character) {
    if (!character || typeof character !== 'object' || Array.isArray(character) || !character.avatar || typeof character.avatar !== 'object') return null;
    const out = {};
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(character, key)) out[key] = character[key];
    return out;
  }
  if (Array.isArray(value.slots)) {
    const slots = [0, 1, 2].map(i => cleanCharacter(value.slots[i]));
    if (slots.every(slot => slot === null)) return null;
    return { slots, activeSlot: Math.max(0, Math.min(2, Number(value.activeSlot) || 0)) };
  }
  return cleanCharacter(value); // compatibility with older one-character accounts
}
function issueToken(nickKey) { const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, nickKey); return token; }
function requireAccount(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const nickKey = sessions.get(token);
  if (!token || !nickKey || !accounts[nickKey]) return res.status(401).json({ error: 'Sessão inválida. Entre novamente na conta.' });
  req.accountKey = nickKey; next();
}
app.post('/api/account/register', async (req, res) => {
  try {
    const nick = String(req.body?.nick || '').trim();
    const password = req.body?.password;
    if (!validNick(nick)) return res.status(400).json({ error: 'Nick inválido. Use 3–20 letras, números, _ ou -.' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'A senha precisa ter de 8 a 72 caracteres.' });
    const key = normalizeNick(nick);
    if (accounts[key]) return res.status(409).json({ error: 'Esse nick já está cadastrado. Tente entrar na conta.' });
    const credential = await hashPassword(password);
    accounts[key] = { nick, salt: credential.salt, passwordHash: credential.hash, progress: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    persistAccounts();
    return res.status(201).json({ token: issueToken(key), nick, progress: null });
  } catch (e) { console.error('register error', e); return res.status(500).json({ error: 'Erro ao criar a conta.' }); }
});
app.post('/api/account/login', async (req, res) => {
  try {
    const key = normalizeNick(req.body?.nick);
    const password = req.body?.password;
    const account = accounts[key];
    if (!account || typeof password !== 'string' || password.length > 72) return res.status(401).json({ error: 'Nick ou senha incorretos.' });
    const attempted = await hashPassword(password, account.salt);
    const a = Buffer.from(attempted.hash, 'hex'), b = Buffer.from(account.passwordHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Nick ou senha incorretos.' });
    return res.json({ token: issueToken(key), nick: account.nick, progress: account.progress || null });
  } catch (e) { console.error('login error', e); return res.status(500).json({ error: 'Erro ao entrar na conta.' }); }
});
app.get('/api/account/load', requireAccount, (req, res) => res.json({ nick: accounts[req.accountKey].nick, progress: accounts[req.accountKey].progress || null }));
app.put('/api/account/save', requireAccount, (req, res) => {
  const progress = safeProgress(req.body?.progress);
  if (!progress) return res.status(400).json({ error: 'Dados de progresso inválidos.' });
  accounts[req.accountKey].progress = progress;
  accounts[req.accountKey].updatedAt = new Date().toISOString();
  try { persistAccounts(); return res.json({ ok: true, savedAt: accounts[req.accountKey].updatedAt }); }
  catch (e) { console.error('save error', e); return res.status(500).json({ error: 'Não foi possível gravar o progresso no armazenamento.' }); }
});
app.post('/api/account/logout', requireAccount, (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); sessions.delete(token); res.json({ ok: true });
});

io.on('connection', socket => {
  socket.on('join-arena', data => {
    socket.join(ARENA);
    const p = { name: cleanText(data?.name), skin: cleanText(data?.skin, 40) || 'sukuna_megumi', tech: cleanText(data?.tech, 40) || 'limitless', x: numberIn(data?.x, 500, 0, 10000), y: numberIn(data?.y, 400, 0, 10000), hp: numberIn(data?.hp, 100, 0, 10000), maxHp: numberIn(data?.maxHp, 100, 1, 10000), alive: true, face: numberIn(data?.face, 1, -1, 1) };
    players.set(socket.id, p); socket.emit('arena-state', [...players.entries()].map(([id, player]) => publicPlayer(id, player))); socket.to(ARENA).emit('player-joined', publicPlayer(socket.id, p));
  });
  socket.on('player-state', data => { const p = players.get(socket.id); if (!p) return; p.x = numberIn(data?.x, p.x, 0, 10000); p.y = numberIn(data?.y, p.y, 0, 10000); p.hp = numberIn(data?.hp, p.hp, 0, 10000); p.maxHp = numberIn(data?.maxHp, p.maxHp, 1, 10000); p.alive = data?.alive !== false && p.hp > 0; p.name = cleanText(data?.name ?? p.name); p.skin = cleanText(data?.skin ?? p.skin, 40); p.tech = cleanText(data?.tech ?? p.tech, 40); p.face = numberIn(data?.face, p.face, -1, 1); socket.to(ARENA).emit('player-state', publicPlayer(socket.id, p)); });
  socket.on('pvp-melee', data => { const attacker = players.get(socket.id); if (!attacker) return; const x = numberIn(data?.x, attacker.x, 0, 10000), y = numberIn(data?.y, attacker.y, 0, 10000), face = numberIn(data?.face, attacker.face, -1, 1); for (const [targetId, target] of players) { if (targetId === socket.id || !target.alive) continue; const dx = target.x - x, dy = target.y - y; if (Math.hypot(dx, dy) <= 62 && dx * face > -18) io.to(targetId).emit('pvp-hit', { targetId, attackerId: socket.id, damage: 8 }); } });
  socket.on('pvp-technique', data => { const p = players.get(socket.id); if (!p || !data || !['red','blue','purple','dismantle','cleave','fuga','fire_arrow','ten_shadows','innate','innate_area'].includes(data.type)) return; socket.to(ARENA).emit('pvp-technique', { attackerId: socket.id, type: data.type, x: numberIn(data.x, p.x, 0, 10000), y: numberIn(data.y, p.y, 0, 10000), vx: numberIn(data.vx, 0, -1000, 1000), vy: numberIn(data.vy, 0, -1000, 1000), r: numberIn(data.r, 10, 5, 30), life: numberIn(data.life, 1.5, 0.1, 3), damage: numberIn(data.damage, 10, 1, 100) }); });
  socket.on('pvp-area', data => { const p = players.get(socket.id); if (!p || !data) return; socket.to(ARENA).emit('pvp-area', { attackerId: socket.id, type: cleanText(data.type, 32), x: numberIn(data.x, p.x, 0, 10000), y: numberIn(data.y, p.y, 0, 10000), radius: numberIn(data.radius, 100, 10, 300), damage: numberIn(data.damage, 10, 1, 100) }); });
  socket.on('arena-death', () => { const p = players.get(socket.id); if (!p) return; p.hp = 0; p.alive = false; socket.to(ARENA).emit('player-state', publicPlayer(socket.id, p)); });
  socket.on('player-respawn', data => { const p = players.get(socket.id); if (!p) return; p.x = numberIn(data?.x, p.x, 0, 10000); p.y = numberIn(data?.y, p.y, 0, 10000); p.hp = numberIn(data?.hp, p.maxHp, 1, 10000); p.maxHp = numberIn(data?.maxHp, p.maxHp, 1, 10000); p.alive = true; socket.to(ARENA).emit('player-state', publicPlayer(socket.id, p)); });
  socket.on('leave-arena', () => { socket.leave(ARENA); players.delete(socket.id); socket.to(ARENA).emit('player-left', socket.id); });
  socket.on('disconnect', () => { players.delete(socket.id); socket.to(ARENA).emit('player-left', socket.id); sendArenaState(); });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Jujutsu-Kaizen server listening on ${PORT}; account data: ${ACCOUNTS_FILE}`));
