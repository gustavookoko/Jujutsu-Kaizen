const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET'] },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 10000;
const DB_FILE = process.env.JUJUTSU_DB_FILE || path.join(process.cwd(), 'jujutsu-accounts.json');
const accounts = new Map();
const sessions = new Map();
const parties = new Map();
const lastRaidHit = new Map();
const RANKS = [{min:65,name:'Grau Especial'},{min:50,name:'Grau 1'},{min:35,name:'Semi-Grau 1'},{min:20,name:'Grau 2'},{min:10,name:'Grau 3'},{min:1,name:'Grau 4'}];
function rankForLevel(level){const n=Math.max(1,Math.min(100,Number(level)||1));return (RANKS.find(r=>n>=r.min)||RANKS[RANKS.length-1]).name;}
function bossName(level){return ({5:'Útero Amaldiçoado',10:'Mahito',15:'Jogo',20:'Dagon',25:'Toji Fushiguro',30:'Sukuna Heian'})[level]||`Maldição Especial Nv. ${level}`;}
function stopRaidTimer(room){if(room?.raidTimer){clearInterval(room.raidTimer);room.raidTimer=null;}}
function partyPublic(room){return {id:room.id,name:room.name,boss:room.boss,locked:Boolean(room.password),players:room.players.size,host:room.host,started:Boolean(room.raid?.started&&!room.raid?.defeated)};}
function loadAccounts(){ try { const raw=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); for(const [k,v] of Object.entries(raw||{})) accounts.set(k,v); } catch(e) {} }
function persistAccounts(){ const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(accounts)), {mode:0o600}); fs.renameSync(tmp,DB_FILE); }
function normNick(n){ return String(n||'').trim().toLowerCase(); }
function publicAccount(a){ return {nick:a.nick,progress:a.progress||null}; }
function hashPassword(password,salt){ return crypto.scryptSync(password,salt,64).toString('hex'); }
function authAccount(req){ const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); const nick=sessions.get(token); return nick?accounts.get(nick):null; }
loadAccounts();
const ARENA = 'jujutsu-battle-royale';
const players = new Map();
const lastAttack = new Map();
const lastArea = new Map();
const allowedTechniques = new Set([
  'red', 'blue', 'purple', 'dismantle', 'cleave', 'fuga', 'fire_arrow',
  'ten_shadows', 'innate', 'innate_area', 'pure_love', 'sword_atack',
  'domain-gojo', 'domain-sukuna', 'rika', 'shadow_mahoraga', 'shadow_nue',
  'shadow_bansho', 'shadow_orochi', 'shadow_dogs', 'shadow_gama', 'shadow_datto',
  'shadow_madoka', 'shadow_kangyu'
]);

app.get('/', (_req, res) => res.send('Jujutsu RPG multiplayer server is online.'));
app.get('/health', (_req, res) => res.json({ status: 'ok', players: players.size, accounts: accounts.size, parties: parties.size }));
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');if(req.method==='OPTIONS')return res.sendStatus(204);next()});
app.use(express.json({limit:'256kb'}));
app.post('/api/account/register',(req,res)=>{
  const nick=String(req.body?.nick||'').trim(); const password=String(req.body?.password||'');
  if(nick.length<3||nick.length>20) return res.status(400).json({error:'O nick precisa ter entre 3 e 20 caracteres.'});
  if(!/^[\p{L}\p{N}_ -]+$/u.test(nick)) return res.status(400).json({error:'Use apenas letras, números, espaço, hífen ou underline no nick.'});
  if(password.length<8||password.length>200) return res.status(400).json({error:'A senha precisa ter de 8 a 200 caracteres.'});
  const key=normNick(nick); if(accounts.has(key)) return res.status(409).json({error:'Esse nick já está em uso.'});
  const salt=crypto.randomBytes(16).toString('hex'); const account={nick,salt,passwordHash:hashPassword(password,salt),progress:null,createdAt:Date.now()}; accounts.set(key,account); persistAccounts();
  const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,key); return res.status(201).json({token,nick:account.nick,progress:null});
});
app.post('/api/account/login',(req,res)=>{
  const key=normNick(req.body?.nick); const password=String(req.body?.password||''); const account=accounts.get(key);
  if(!account||hashPassword(password,account.salt)!==account.passwordHash) return res.status(401).json({error:'Nick ou senha incorretos.'});
  const token=crypto.randomBytes(32).toString('hex'); sessions.set(token,key); return res.json({token,nick:account.nick,progress:account.progress||null});
});
app.put('/api/account/save',(req,res)=>{
  const account=authAccount(req); if(!account) return res.status(401).json({error:'Sessão inválida. Entre novamente.'});
  const progress=req.body?.progress; if(!progress||typeof progress!=='object') return res.status(400).json({error:'Dados de progresso inválidos.'});
  const rawSlots=Array.isArray(progress.slots)?progress.slots.slice(0,3):[];
  const slots=rawSlots.map(slot=>{ if(!slot||typeof slot!=='object'||!slot.avatar) return null; return { ...slot, level:Math.max(1,Math.min(100,Number(slot.level)||1)), yen:Math.max(0,Math.min(1e12,Number(slot.yen)||0)) }; });
  account.progress={slots,activeSlot:Math.max(0,Math.min(2,Number(progress.activeSlot)||0)),updatedAt:Date.now()}; persistAccounts(); return res.json({ok:true,updatedAt:account.progress.updatedAt});
});
app.get('/api/party/list',(_req,res)=>res.json({rooms:[...parties.values()].map(partyPublic)}));
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
  lastArea.delete(id);
  io.to(ARENA).emit('player-left', id);
}
function sendConfirmedHit(attackerId, targetId, damage, blackFlash = false) {
  const payload = { attackerId, targetId, damage, blackFlash };
  io.to(targetId).emit('pvp-hit', payload);
}

io.on('connection', (socket) => {
  socket.on('party-create',(data={})=>{
    const boss=Number(data.boss);
    if(![5,10,15,20,25,30].includes(boss)) return socket.emit('party-error','Nível de chefe inválido.');
    if(socket.data.partyId){const old=parties.get(socket.data.partyId);if(old){old.players.delete(socket.id);old.nickBySocket.delete(socket.id);if(!old.players.size){stopRaidTimer(old);parties.delete(old.id)}else io.to('party:'+old.id).emit('party-members',{id:old.id,players:[...old.nickBySocket.values()],boss:old.boss});}}
    const id=crypto.randomBytes(5).toString('hex');
    const nick=String(data.nick||'Feiticeiro').slice(0,20);
    const room={id,name:String(data.name||'Raid').slice(0,24),boss,password:String(data.password||'').slice(0,32),host:nick,players:new Set([socket.id]),nickBySocket:new Map([[socket.id,nick]]),raid:null,raidTimer:null};
    parties.set(id,room);socket.data.partyId=id;socket.join('party:'+id);
    socket.emit('party-created',{id,name:room.name,boss,players:[...room.nickBySocket.values()],host:room.host});
    socket.emit('party-joined',{id,name:room.name,boss,players:[...room.nickBySocket.values()],host:room.host,isHost:true});
    io.to('party:'+id).emit('party-members',{id,players:[...room.nickBySocket.values()],boss:room.boss,host:room.host});io.emit('party-list-update');
  });
  socket.on('party-join',(data={})=>{
    const room=parties.get(String(data.id||''));if(!room)return socket.emit('party-error','Sala não encontrada.');
    const lvl=Math.max(1,Math.min(100,Number(data.level)||1));if(lvl<room.boss)return socket.emit('party-error',`Nível ${room.boss} necessário para esta raid.`);
    if(room.raid?.started&&!room.raid?.defeated)return socket.emit('party-error','A raid já começou. Aguarde a próxima tentativa.');
    if(room.password&&String(data.password||'')!==room.password)return socket.emit('party-error','Senha incorreta.');
    if(room.players.has(socket.id)){socket.emit('party-joined',{id:room.id,name:room.name,boss:room.boss,players:[...room.nickBySocket.values()],host:room.host,isHost:[...room.players][0]===socket.id});return;}
    if(room.players.size>=4)return socket.emit('party-error','A party já está cheia (máximo de 4 jogadores).');
    if(socket.data.partyId){const old=parties.get(socket.data.partyId);if(old){old.players.delete(socket.id);old.nickBySocket.delete(socket.id);if(!old.players.size){stopRaidTimer(old);parties.delete(old.id)}else io.to('party:'+old.id).emit('party-members',{id:old.id,players:[...old.nickBySocket.values()],boss:old.boss});socket.leave('party:'+old.id);}}
    const nick=String(data.nick||'Feiticeiro').slice(0,20);room.players.add(socket.id);room.nickBySocket.set(socket.id,nick);socket.data.partyId=room.id;socket.join('party:'+room.id);
    const payload={id:room.id,name:room.name,boss:room.boss,players:[...room.nickBySocket.values()],host:room.host,isHost:[...room.players][0]===socket.id};
    socket.emit('party-joined',payload);io.to('party:'+room.id).emit('party-members',payload);io.emit('party-list-update');
  });
  socket.on('party-leave',()=>{const id=socket.data.partyId;const room=parties.get(id);if(!room)return;room.players.delete(socket.id);room.nickBySocket.delete(socket.id);socket.leave('party:'+id);socket.data.partyId=null;if(!room.players.size){stopRaidTimer(room);parties.delete(id)}else io.to('party:'+id).emit('party-members',{id,players:[...room.nickBySocket.values()],boss:room.boss,host:room.host});io.emit('party-list-update')});
  socket.on('party-start-raid',()=>{
    const room=parties.get(socket.data.partyId);if(!room)return socket.emit('party-error','Entre em uma party antes de iniciar.');
    if([...room.players][0]!==socket.id)return socket.emit('party-error','Somente o líder pode iniciar a raid.');
    if(room.raid?.started&&!room.raid?.defeated)return socket.emit('party-error','Esta raid já está em andamento.');
    stopRaidTimer(room);
    const maxHp=1800+room.boss*420;
    room.raid={started:true,defeated:false,hp:maxHp,maxHp,startedAt:Date.now(),lastAttack:0};
    const startPayload={id:room.id,boss:room.boss,bossName:bossName(room.boss),bossHp:maxHp,maxHp,players:[...room.nickBySocket.values()],xpMultiplier:3,yenMultiplier:3};
    io.to('party:'+room.id).emit('party-raid-start',startPayload);
    room.raidTimer=setInterval(()=>{
      if(!parties.has(room.id)||!room.raid?.started||room.raid.defeated||!room.players.size){stopRaidTimer(room);return;}
      const ids=[...room.players];const targetId=ids[Math.floor(Math.random()*ids.length)];
      const targetNick=room.nickBySocket.get(targetId)||'Feiticeiro';
      const damage=12+Math.floor(room.boss*.75);
      io.to(targetId).emit('party-raid-player-hit',{damage,targetNick,bossName:bossName(room.boss),pattern:Math.random()<.5?'Golpe de energia amaldiçoada':'Ataque de área'});
      io.to('party:'+room.id).emit('party-raid-attack',{targetNick,damage,pattern:'Ataque do chefe'});
    },5200);
  });
  socket.on('party-raid-damage',(data={})=>{
    const room=parties.get(socket.data.partyId);if(!room||!room.raid?.started||room.raid.defeated||!room.players.has(socket.id))return;
    const now=Date.now(),last=lastRaidHit.get(socket.id)||0;if(now-last<75)return;lastRaidHit.set(socket.id,now);
    const damage=Math.max(1,Math.min(300,Math.floor(Number(data.damage)||1)));
    room.raid.hp=Math.max(0,room.raid.hp-damage);
    io.to('party:'+room.id).emit('party-boss-state',{id:room.id,hp:room.raid.hp,maxHp:room.raid.maxHp,lastDamage:damage,attacker:room.nickBySocket.get(socket.id)||'Feiticeiro'});
    if(room.raid.hp<=0&&!room.raid.defeated){room.raid.defeated=true;room.raid.started=false;stopRaidTimer(room);const baseXp=30+room.boss*3;const baseYen=100+room.boss*50;io.to('party:'+room.id).emit('party-raid-boss-defeated',{id:room.id,boss:room.boss,bossName:bossName(room.boss),xp:baseXp*3,yen:baseYen*3,xpMultiplier:3,yenMultiplier:3});io.emit('party-list-update');}
  });
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

  // Soco físico: 5% de chance de Black Flash. O dano usa Força + Liberação de Energia, vezes 2.
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
    const melee = cleanNumber(data.melee, 0, 0, 100);
    const liberacao = cleanNumber(data.liberacao, 0, 0, 100);
    for (const [targetId, target] of players) {
      if (targetId === socket.id || !target.alive) continue;
      const dx = target.x - ax;
      const dy = target.y - ay;
      if (Math.hypot(dx, dy) <= 62 && dx * face >= -12) {
        const blackFlash = Math.random() < 0.05;
        const damage = Math.round(blackFlash ? (2 + melee + liberacao) * 2 : 2 + melee);
        sendConfirmedHit(socket.id, targetId, damage, blackFlash);
        break;
      }
    }
  });

  // Replica os projéteis para os outros clientes; cada cliente mostra a colisão visual local.
  socket.on('pvp-technique', (data = {}) => {
    if (!socket.data.inArena || !players.has(socket.id) || !players.get(socket.id).alive) return;
    if (!allowedTechniques.has(String(data.type || ''))) return;
    const packet = {
      attackerId: socket.id,
      type: String(data.type).slice(0, 32),
      x: cleanNumber(data.x, 0, 0, 10000),
      y: cleanNumber(data.y, 0, 0, 10000),
      vx: cleanNumber(data.vx, 0, -1200, 1200),
      vy: cleanNumber(data.vy, 0, -1200, 1200),
      r: cleanNumber(data.r, 10, 3, 180),
      life: cleanNumber(data.life, 1.5, 0.1, 4),
      damage: cleanNumber(data.damage, 10, 0, 100),
    };
    socket.to(ARENA).emit('pvp-technique', packet);
  });

  // Replica áreas (Pure Love, cortes, domínios e golpes de área).
  socket.on('pvp-area', (data = {}) => {
    if (!socket.data.inArena || !players.has(socket.id) || !players.get(socket.id).alive) return;
    const now = Date.now();
    if (now - (lastArea.get(socket.id) || 0) < 55) return;
    lastArea.set(socket.id, now);
    const type = String(data.type || 'cleave').slice(0, 32);
    if (!allowedTechniques.has(type)) return;
    const packet = {
      attackerId: socket.id,
      type,
      x: cleanNumber(data.x, players.get(socket.id).x, 0, 10000),
      y: cleanNumber(data.y, players.get(socket.id).y, 0, 10000),
      radius: cleanNumber(data.radius, 50, 10, 300),
      damage: cleanNumber(data.damage, 10, 0, 100),
    };
    socket.to(ARENA).emit('pvp-area', packet);
  });

  // O cliente atingido confirma o dano visual ao atacante, para ambos verem os números.
  socket.on('pvp-hit-confirm', (data = {}) => {
    if (!socket.data.inArena || !players.has(socket.id)) return;
    const attackerId = String(data.attackerId || '');
    const targetId = String(data.targetId || '');
    if (targetId !== socket.id || !players.has(attackerId) || !players.get(attackerId).alive) return;
    const damage = cleanNumber(data.damage, 0, 0, 100);
    io.to(attackerId).emit('pvp-hit-confirm', {
      attackerId,
      targetId,
      damage,
      blackFlash: Boolean(data.blackFlash),
    });
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
  socket.on('disconnect', () => { const id=socket.data.partyId; const room=parties.get(id); if(room){room.players.delete(socket.id);room.nickBySocket.delete(socket.id);if(!room.players.size){stopRaidTimer(room);parties.delete(id)}else io.to('party:'+id).emit('party-members',{id,players:[...room.nickBySocket.values()],boss:room.boss,host:room.host});io.emit('party-list-update')}lastRaidHit.delete(socket.id);removePlayer(socket.id); });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Jujutsu RPG multiplayer server listening on ${PORT}`));
