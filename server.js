Артемий (14:59):
// server.js — Counter Flame Faceit v0.1 — single-file, Upstash Redis storage
// Run local:  node server.js
// Run prod:   UPSTASH_URL=... UPSTASH_TOKEN=... node server.js
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'cf-dev-secret-change-in-prod';
const DB_FILE = './cf-data.json';
const MAPS = ['Dust2','Mirage','Inferno','Nuke','Ancient','Vertigo','Anubis'];
const RANKS = ['Bronze','Silver','Gold','Platinum','Diamond','Master'];
const LANGS = ['RU','EN','KZ','UA'];
const MIN_QUEUE = 10;
const TURN_SEC = 30;
const ADMIN_ID = '1460627';
const isAdmin = u => !!u && u.game_id === ADMIN_ID;

// ============ STORAGE: Upstash Redis (prod) or file (local) ============
const UPSTASH_URL = process.env.UPSTASH_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_KEY = 'cf:data';

async function redisCmd(...args){
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if(!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const j = await r.json();
  if(j.error) throw new Error(j.error);
  return j.result;
}

const blank = () => ({ users:[], lobbies:[], messages:[], confirmations:[], reports:[], sanctions:[], matches:[], queue:[],
  seq:{user:1,lobby:1,message:1,match:1,report:1,sanction:1,confirmation:1} });

let db;

async function loadDB(){
  if(USE_REDIS){
    try {
      const raw = await redisCmd('GET', REDIS_KEY);
      db = raw ? JSON.parse(raw) : blank();
      console.log('✓ Loaded from Upstash Redis · users:', (db.users||[]).length, '· lobbies:', (db.lobbies||[]).length);
    } catch(e){
      console.error('✗ FAILED to load from Upstash Redis:', e.message);
      console.error('  Server will NOT start. Check UPSTASH_URL / UPSTASH_TOKEN and restart.');
      process.exit(1);
    }
  } else {
    if(fs.existsSync(DB_FILE)){
      db = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
      console.log('✓ Loaded from local file · users:', (db.users||[]).length);
    } else {
      db = blank();
      console.log('✓ Starting with blank DB (local file will be created on first save)');
    }
  }
}

let saveInFlight = false;
let saveQueued = false;

async function doSaveRedis(snapshot){
  try { await redisCmd('SET', REDIS_KEY, snapshot); }
  catch(e){ console.error('Redis save failed:', e.message); }
}

function save(){
  if(USE_REDIS){
    if(saveInFlight){ saveQueued = true; return; }
    saveInFlight = true;
    doSaveRedis(JSON.stringify(db)).finally(() => {
      saveInFlight = false;
      if(saveQueued){ saveQueued = false; save(); }
    });
  } else {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
    catch(e){ console.error('File save failed:', e.message); }
  }
}

const next = k => db.seq[k]++;
const nowS = () => Math.floor(Date.now()/1000);

// ============ AUTH ============
function sign(p){
  const d = Buffer.from(JSON.stringify(p)).toString('base64url');
  return d+'.'+crypto.createHmac('sha256',SECRET).update(d).digest('base64url');
}
function verify(t){
  if(!t) return null;
  const [d,s]=t.split('.'); if(!d||!s) return null;
  if(s!==crypto.createHmac('sha256',SECRET).update(d).digest('base64url')) return null;
  try{ const p=JSON.parse(Buffer.from(d,'base64url').toString()); return p.exp>Date.now()?p:null; }catch{ return null; }
}
function cookie(req,name){
  const c=req.headers.cookie||'';
  for(const p of c.split(';')){ const [k,...v]=p.trim().split('='); if(k===name) return v.join('='); }
  return null;
}
function setC(res,name,val,max){ res.setHeader('Set-Cookie',`${name}=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${max}`); }
function me(req){ const p=verify(cookie(req,'sess')); return p ? db.users.find(u=>u.id===p.uid)||null : null; }

Артемий (14:59):
function login(res,u){ setC(res,'sess',sign({uid:u.id,exp:Date.now()+30*86400000}),30*86400); }
function logout(res){ setC(res,'sess','',0); }

// ============ RATE LIMIT ============
const rl = new Map();
function limit(key,max,win){
  const t=Date.now(); const arr=(rl.get(key)||[]).filter(x=>t-x<win);
  if(arr.length>=max) return false;
  arr.push(t); rl.set(key,arr); return true;
}

// ============ HELPERS ============
function json(res,code,obj){ res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); }
function sendHTML(res,code,html){ res.writeHead(code,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); }
function body(req){ return new Promise(r=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d||'{}'))}catch{r({})} }); }); }
const esc = s => String(s||'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
function statusLabel(s){ return {novice:'Новичок',verified:'Проверен',banned:'Забанен'}[s]||s; }

// ============ GAME LOGIC ============
function maybeVerify(nov,ver){
  if(!nov||!ver||nov.verified||!ver.verified||nov.is_disputed) return;
  const opps = nov.verification_opponents||[];
  if(opps.includes(ver.id)) return;
  opps.push(ver.id);
  nov.verification_opponents = opps;
  nov.verification_progress = Math.min(2, opps.length);
  if(nov.verification_progress>=2){
    nov.verified = true; nov.status = 'verified';
    db.users.forEach(u=>{ if(u.id!==nov.id && u.game_id===nov.game_id) u.is_disputed = true; });
  }
  save();
}

function resolveMatch(lobby){
  if(lobby.status!=='playing') return;
  const cs = db.confirmations.filter(c=>c.lobby_id===lobby.id);
  if(cs.length<2){
    if(lobby.final_map_set_at && nowS()-lobby.final_map_set_at>86400){ lobby.status='expired'; save(); }
    return;
  }
  const a = cs.find(c=>c.user_id===lobby.host_id);
  const b = cs.find(c=>c.user_id===lobby.guest_id);
  if(!a||!b) return;
  const dur = Math.min(a.created_at,b.created_at) - (lobby.final_map_set_at||nowS());
  if(a.result==='played' && b.result==='played'){
    const susp = dur<60;
    db.matches.push({id:next('match'),lobby_id:lobby.id,p1:lobby.host_id,p2:lobby.guest_id,map:lobby.final_map,duration:dur,suspicious:susp,created_at:nowS()});
    if(susp){
      [lobby.host_id,lobby.guest_id].forEach(uid=>{
        db.sanctions.push({id:next('sanction'),user_id:uid,type:'warning',reason:'Подозрительно быстрый матч',created_at:nowS()});
        const since = nowS()-86400;
        const cnt = db.matches.filter(m=>(m.p1===uid||m.p2===uid)&&m.suspicious&&m.created_at>since).length;
        if(cnt>=3){ const u=db.users.find(x=>x.id===uid); if(u){ u.banned_until=nowS()+72*3600; u.ban_reason='3 подозрительно быстрых матча за 24ч'; } }
      });
    }
    maybeVerify(db.users.find(x=>x.id===lobby.host_id), db.users.find(x=>x.id===lobby.guest_id));
    maybeVerify(db.users.find(x=>x.id===lobby.guest_id), db.users.find(x=>x.id===lobby.host_id));
  }
  if(a.result==='noshow'||b.result==='noshow'){
    const t = a.result==='noshow'?lobby.host_id:lobby.guest_id;
    const u = db.users.find(x=>x.id===t);
    if(u){ u.no_show_count=(u.no_show_count||0)+1; if(u.no_show_count>=2) u.is_disputed=true; }
  }
  if(a.result==='fake'||b.result==='fake'){
    const rep = a.result==='fake'?lobby.host_id:lobby.guest_id;
    const t   = a.result==='fake'?lobby.guest_id:lobby.host_id;
    db.reports.push({id:next('report'),reporter_id:rep,target_id:t,lobby_id:lobby.id,category:'fake_confirm',created_at:nowS()});
  }
  lobby.status='done'; save();
}

function tickVeto(lobby){
  if(lobby.status!=='veto') return;
  const banned = lobby.banned_maps||[];
  const rem = lobby.maps.filter(m=>!banned.includes(m));
  if(rem.length<=1){ lobby.status='playing'; lobby.final_map=rem[0]; lobby.final_map_set_at=nowS(); save(); return; }
  if(lobby.turn_started_at && nowS()-lobby.turn_started_at>=TURN_SEC){
    const pick = rem[Math.floor(Math.random()*rem.length)];

Артемий (14:59):
banned.push(pick); lobby.banned_maps=banned;
    const left = lobby.maps.filter(m=>!banned.includes(m));
    if(left.length<=1){ lobby.status='playing'; lobby.final_map=left[0]; lobby.final_map_set_at=nowS(); }
    else { lobby.current_turn = lobby.current_turn===lobby.host_id?lobby.guest_id:lobby.host_id; lobby.turn_started_at=nowS(); }
    save();
  }
}

// ============ CSS ============
const CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e12;color:#eaeaf0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh}
a{color:inherit;text-decoration:none}
.header{position:fixed;top:0;left:0;right:0;height:60px;background:rgba(20,20,26,.95);border-bottom:1px solid #2a2a35;display:flex;justify-content:space-between;align-items:center;padding:0 20px;z-index:50;backdrop-filter:blur(8px)}
.brand{display:flex;align-items:center;gap:8px;font-weight:800}
.flame{color:#ff5b2e}
.badge{font-size:10px;padding:2px 6px;border-radius:4px;background:#202028;color:#8b8b9c}
.hdr-r{display:flex;align-items:center;gap:10px}
.nick{font-weight:600}
.pill{font-size:11px;padding:3px 8px;border-radius:20px;font-weight:700}
.pill-novice{background:#2c2c38;color:#b9b9c9}
.pill-verified{background:#173b26;color:#4ac97e}
.pill-banned{background:#3a1414;color:#e14b4b}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;background:#202028;color:#eaeaf0;border:1px solid #2a2a35;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit}
.btn:hover{background:#2a2a35}
.btn-sm{padding:6px 10px;font-size:13px}
.btn-fire{background:linear-gradient(135deg,#ff5b2e,#ff8a3c);border:none;color:#1a0d05}
.btn-fire:hover{filter:brightness(1.1)}
.btn[disabled]{opacity:.4;cursor:not-allowed}
.btn-danger{background:#3a1a1a;border-color:#5a2a2a;color:#ff8888}
.container{max-width:1100px;margin:0 auto;padding:80px 16px 40px}
.panel{background:#17171d;border:1px solid #2a2a35;border-radius:12px;padding:20px;margin-bottom:16px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;color:#8b8b9c;margin-bottom:4px;text-transform:uppercase;letter-spacing:.6px}
.field input,.field select{width:100%;padding:10px 12px;border-radius:8px;background:#202028;color:#eaeaf0;border:1px solid #2a2a35;font-size:14px;font-family:inherit}
.msg-error{color:#e14b4b;font-size:13px;margin:8px 0}
.msg-warn{color:#e8b53a;font-size:13px;margin:8px 0}
.empty{color:#8b8b9c;text-align:center;padding:40px 20px;font-size:14px}
.hero{text-align:center;padding:40px 20px 20px}
.hero h1{font-size:44px;margin-bottom:8px}
.accent{color:#ff5b2e}
.hero p{color:#8b8b9c;margin-bottom:32px}
.big-buttons{display:flex;gap:16px;justify-content:center;flex-wrap:wrap}
.big-btn{flex:0 0 260px;padding:40px 20px;border-radius:16px;background:linear-gradient(180deg,#211a16,#17171d);border:1px solid #2a2a35;text-align:center;font-size:22px;font-weight:800;transition:.15s;position:relative;cursor:pointer}
.big-btn:hover{border-color:#ff5b2e;transform:translateY(-2px)}
.big-btn.primary{background:linear-gradient(135deg,#ff5b2e,#ff8a3c);color:#1a0d05;border:none;box-shadow:0 10px 40px -10px #ff5b2e}
.big-btn.primary:hover{filter:brightness(1.1)}
.big-btn.disabled{opacity:.4;cursor:not-allowed}
.big-btn.disabled:hover{transform:none;border-color:#2a2a35}
.soon-tag{position:absolute;top:8px;right:8px;font-size:10px;padding:3px 6px;border-radius:6px;background:#202028;color:#e8b53a}
.steps{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:40px 0}
.step{background:#17171d;border:1px solid #2a2a35;border-radius:12px;padding:20px}
.step-num{color:#ff5b2e;font-weight:900;font-size:26px}
.step h3{margin:8px 0 4px;font-size:16px}
.step p{color:#8b8b9c;font-size:14px}
.trust{margin-top:24px;padding:20px;border:1px solid #3a2a1a;border-radius:12px;background:#1a150f;color:#d9c9b0;font-size:14px}
.trust b{color:#ff5b2e}
.login-wrap{max-width:420px;margin:40px auto}
.login-wrap h2{font-size:28px;margin-bottom:6px}

Артемий (14:59):
.login-wrap p.sub{color:#8b8b9c;margin-bottom:24px;font-size:14px}
.recovery-box{background:#1f1a0f;border:1px solid #4a3a1a;padding:14px;border-radius:8px;font-family:monospace;font-size:15px;word-break:break-all;margin-top:12px;color:#ff8a3c}
.play-layout{display:grid;grid-template-columns:1fr 320px;gap:20px;margin-top:20px}
@media(max-width:780px){.play-layout{grid-template-columns:1fr}}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.filters select{padding:6px 10px;border-radius:8px;background:#202028;color:#eaeaf0;border:1px solid #2a2a35}
.lobby-list{display:flex;flex-direction:column;gap:12px}
.lobby-card{background:#17171d;border:1px solid #2a2a35;border-radius:10px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.lobby-card .host{font-weight:700}
.lobby-card .meta{font-size:12px;color:#8b8b9c;margin-top:4px}
.map-checks{display:flex;flex-wrap:wrap;gap:6px}
.map-check{padding:5px 10px;border-radius:6px;background:#202028;border:1px solid #2a2a35;font-size:12px;cursor:pointer;user-select:none}
.map-check.active{background:#3a1f10;border-color:#ff5b2e;color:#ff5b2e}
.mm-wrap{text-align:center;padding:60px 20px}
.mm-spinner{width:90px;height:90px;margin:0 auto 24px;border:3px solid #202028;border-top-color:#ff5b2e;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.mm-count{color:#8b8b9c;margin-bottom:16px}
.warn-box{max-width:480px;margin:16px auto;padding:12px 16px;background:#2a2210;border:1px solid #4a3a1a;border-radius:8px;color:#e8b53a;font-size:14px}
.timer{font-size:20px;margin:16px 0;font-weight:700}
.lobby-grid{display:grid;grid-template-columns:1fr 380px;gap:20px;margin-top:20px}
@media(max-width:900px){.lobby-grid{grid-template-columns:1fr}}
.opponent-card{display:flex;align-items:center;gap:12px}
.avatar{width:48px;height:48px;border-radius:10px;background:linear-gradient(135deg,#3a1f10,#201410);display:flex;align-items:center;justify-content:center;font-weight:900;color:#ff5b2e;font-size:18px}
.opponent-card .info{flex:1}
.opponent-card .name{font-weight:700;font-size:16px}
.opponent-card .sub{font-size:12px;color:#8b8b9c}
.veto-pool{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0}
.map-card{padding:20px 10px;text-align:center;background:#202028;border:2px solid #2a2a35;border-radius:10px;font-weight:700;cursor:pointer}
.map-card:hover:not(.banned):not(.locked){border-color:#ff5b2e}
.map-card.banned{opacity:.3;text-decoration:line-through;cursor:not-allowed}
.map-card.locked{cursor:not-allowed}
.final-map{margin-top:20px;padding:30px;text-align:center;background:linear-gradient(135deg,#3a1f10,#1a0d05);border:2px solid #ff5b2e;border-radius:14px}
.final-map .label{font-size:12px;color:#ff5b2e;text-transform:uppercase;letter-spacing:1px}
.final-map .name{font-size:32px;font-weight:900;margin-top:6px}
.chat-panel{display:flex;flex-direction:column;height:560px;background:#17171d;border:1px solid #2a2a35;border-radius:12px;overflow:hidden}
.chat-head{padding:12px 16px;border-bottom:1px solid #2a2a35;font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.chat-body{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.chat-msg{background:#202028;border-radius:8px;padding:8px 12px;max-width:85%}
.chat-msg.mine{align-self:flex-end;background:#3a1f10}
.chat-msg .who{font-size:11px;color:#8b8b9c;margin-bottom:3px}
.chat-msg .body{font-size:14px;word-break:break-word}
.chat-msg.code .body{font-family:monospace;background:#1a1a22;padding:6px 8px;border-radius:6px;display:inline-block;color:#ff8a3c}
.chat-msg .report{font-size:10px;color:#8b8b9c;cursor:pointer;margin-top:4px;text-decoration:underline}
.chat-input{display:flex;gap:8px;padding:12px;border-top:1px solid #2a2a35}

Артемий (14:59):
.chat-input input{flex:1;padding:8px 12px;border-radius:8px;background:#202028;color:#eaeaf0;border:1px solid #2a2a35;font-size:14px}
.confirm-bar{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap}
.confirm-bar .btn{flex:1;min-width:120px}
.profile-hd{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.big-avatar{width:80px;height:80px;border-radius:16px;background:linear-gradient(135deg,#ff5b2e,#ff8a3c);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:900;color:#1a0d05}
.profile-hd h1{font-size:28px}
.profile-hd .sub{color:#8b8b9c;font-size:13px;margin-top:4px}
.stat-row{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:20px 0}
.stat{background:#17171d;border:1px solid #2a2a35;padding:14px;border-radius:10px}
.stat .lbl{font-size:11px;color:#8b8b9c;text-transform:uppercase;letter-spacing:.6px}
.stat .val{font-size:20px;font-weight:800;margin-top:4px}
.verify-bar{height:8px;background:#202028;border-radius:6px;overflow:hidden;margin-top:8px}
.verify-bar>div{height:100%;background:linear-gradient(90deg,#ff5b2e,#ff8a3c)}
.history-table{width:100%;border-collapse:collapse;margin-top:8px}
.history-table th,.history-table td{padding:8px 10px;text-align:left;border-bottom:1px solid #2a2a35;font-size:13px}
.history-table th{color:#8b8b9c;font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100;padding:20px}
.modal{background:#17171d;border:1px solid #2a2a35;border-radius:14px;padding:24px;max-width:400px;width:100%}
.modal h3{margin-bottom:12px;font-size:18px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}`;

// ============ LAYOUT ============
function layout(user, content){
  const right = user
    ? `<span class="nick">${esc(user.nickname)}</span>
       <span class="pill pill-${user.status}">${statusLabel(user.status)}</span>
       ${isAdmin(user) ? '<a class="btn btn-sm" href="/admin" style="background:#3a1f10;border-color:#ff5b2e;color:#ff5b2e">⚙️ Админка</a>' : ''}
       <a class="btn btn-sm" href="/profile">Профиль</a>
       <button class="btn btn-sm" onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.href='/')">Выход</button>`
    : `<a class="btn btn-sm btn-fire" href="/login">Войти</a>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Counter Flame Faceit</title><style>${CSS}</style></head><body>
<header class="header"><a class="brand" href="/"><span class="flame">🔥</span> Counter Flame Faceit <span class="badge">v0.1</span></a><div class="hdr-r">${right}</div></header>
<main class="container">${content}</main></body></html>`;
}

// ============ PAGES ============
function homePage(user){
  return layout(user, `
    <div class="hero">
      <h1>Counter <span class="accent">Flame</span> Faceit</h1>
      <p>Фанатский сайт для дуэлей 1v1 в CounterFlame. Не связан с разработчиками.</p>
      <div class="big-buttons">
        <a class="big-btn primary" href="${user?'/play':'/login'}">Играть</a>
        <div class="big-btn disabled" title="Режим в разработке">
          <span class="soon-tag">Скоро добавится</span>
          Соревновательный
        </div>
      </div>
    </div>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><h3>Зарегистрируйся</h3><p>Игровой ID и ник. Без пароля и email.</p></div>
      <div class="step"><div class="step-num">2</div><h3>Найди соперника</h3><p>Войди в открытое лобби или создай своё. Вето карт по очереди.</p></div>
      <div class="step"><div class="step-num">3</div><h3>Сыграй и подтверди</h3><p>Оба игрока подтверждают исход. Верификация после 2 матчей против проверенных.</p></div>
    </div>

Артемий (14:59):
<div class="trust"><b>Мы не античит.</b> Мы не связаны с разработчиками CounterFlame и не проверяем читы. Мы ловим поведенческие паттерны на сайте: быстрые матчи, жалобы, no-show, сговор. Настоящий античит — только у разработчиков.</div>
  `);
}

function loginPage(){
  return layout(null, `
    <div class="login-wrap panel" id="loginBox">
      <h2 id="title">Регистрация</h2>
      <p class="sub" id="subtitle">Игровой ID + ник. Никаких паролей и email.</p>
      <div class="field"><label>Игровой ID</label><input id="gid" placeholder="flame_king_01" maxlength="32"></div>
      <div class="field" id="nickField"><label>Ник в игре</label><input id="nick" placeholder="как в игре" maxlength="32"></div>
      <div class="field" id="recField" style="display:none"><label>Код восстановления</label><input id="rec" placeholder="16-символьный код"></div>
      <div id="err" class="msg-error"></div>
      <button class="btn btn-fire" style="width:100%" id="submitBtn">Создать аккаунт</button>
      <div style="margin-top:16px;text-align:center;font-size:13px;color:#8b8b9c">
        <span id="switchText">Уже есть аккаунт?</span> <a href="#" id="switchLink" style="color:#ff5b2e">Войти по коду</a>
      </div>
    </div>
    <script>
    let mode='register';
    const $=id=>document.getElementById(id);
    function setMode(m){
      mode=m;
      $('title').textContent=m==='register'?'Регистрация':'Вход по коду';
      $('subtitle').textContent=m==='register'?'Игровой ID + ник. Никаких паролей и email.':'Введи игровой ID и код восстановления.';
      $('nickField').style.display=m==='register'?'':'none';
      $('recField').style.display=m==='recover'?'':'none';
      $('submitBtn').textContent=m==='register'?'Создать аккаунт':'Войти';
      $('switchText').textContent=m==='register'?'Уже есть аккаунт?':'Нет аккаунта?';
      $('switchLink').textContent=m==='register'?'Войти по коду':'Зарегистрироваться';
      $('err').textContent='';
    }
    $('switchLink').onclick=e=>{e.preventDefault();setMode(mode==='register'?'recover':'register');};
    $('submitBtn').onclick=async()=>{
      $('err').textContent='';
      const payload={game_id:$('gid').value.trim()};
      if(mode==='register') payload.nickname=$('nick').value.trim();
      else payload.recovery_code=$('rec').value.trim();
      const url=mode==='register'?'/api/register':'/api/recover';
      $('submitBtn').disabled=true;
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const j=await r.json();
      $('submitBtn').disabled=false;
      if(!r.ok){ $('err').textContent=j.error||'Ошибка'; return; }
      if(j.recovery){
        $('loginBox').innerHTML='<h2>Аккаунт создан 🔥</h2><p class="sub">Сохрани код — единственный способ войти снова.</p><div class="recovery-box" id="rcode"></div><p class="msg-warn" style="margin-top:12px">Показываем один раз. Скопируй в надёжное место.</p><div style="margin-top:20px;display:flex;gap:8px"><button class="btn" id="copyBtn">Скопировать</button><button class="btn btn-fire" id="nextBtn">Дальше →</button></div>';
        $('rcode').textContent=j.recovery;
        $('copyBtn').onclick=()=>navigator.clipboard.writeText(j.recovery);
        $('nextBtn').onclick=()=>location.href='/play';
      } else { location.href='/play'; }
    };
    </script>
  `);
}

function playPage(user){
  const isBanned = user.banned_until && user.banned_until > nowS();
  const canCreate = user.verified && !isBanned;
  return layout(user, `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div>
        <h1 style="font-size:26px">Дуэли 1v1</h1>
        ${isBanned?`<div class="msg-error">⚠️ Временный бан: ${esc(user.ban_reason||'')}</div>`:''}
        ${user.is_disputed?'<div class="msg-error">⚠️ На аккаунте плашка «Неправильный ID / не приходит на игры»</div>':''}
      </div>

Артемий (14:59):
<button class="btn btn-fire" id="quickBtn">🎯 Быстрый поиск</button>
    </div>
    <div class="play-layout">
      <div>
        <div class="filters">
          <select id="fRank"><option value="">Все ранги</option>${RANKS.map(r=>`<option>${r}</option>`).join('')}</select>
          <select id="fLang"><option value="">Все языки</option>${LANGS.map(l=>`<option>${l}</option>`).join('')}</select>
          <select id="fMap"><option value="">Все карты</option>${MAPS.map(m=>`<option>${m}</option>`).join('')}</select>
        </div>
        <div id="err" class="msg-error"></div>
        <div class="lobby-list" id="lobbies"></div>
      </div>
      <div class="panel">
        <h3 style="margin-bottom:12px;font-size:16px">Создать лобби</h3>
        ${!canCreate?'<div class="msg-warn" style="margin-bottom:12px">Сыграй 2 матча против проверенных игроков, чтобы открыть создание лобби.</div>':''}
        <div class="field"><label>Ранг</label><select id="cRank" ${!canCreate?'disabled':''}>${RANKS.map(r=>`<option>${r}</option>`).join('')}</select></div>
        <div class="field"><label>Язык</label><select id="cLang" ${!canCreate?'disabled':''}>${LANGS.map(l=>`<option>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Карты (3–5)</label><div class="map-checks" id="cMaps">${MAPS.map(m=>`<div class="map-check${['Dust2','Mirage','Inferno'].includes(m)?' active':''}" data-m="${m}">${m}</div>`).join('')}</div></div>
        <button class="btn btn-fire" style="width:100%" id="createBtn" ${!canCreate?'disabled':''}>Создать</button>
        <div style="color:#8b8b9c;font-size:12px;margin-top:8px">Доступно только проверенным игрокам.</div>
      </div>
    </div>
    <script>
    const IS_BANNED = ${isBanned?'true':'false'};
    const $=id=>document.getElementById(id);
    const esc=s=>String(s||'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    let maps=['Dust2','Mirage','Inferno'];
    document.querySelectorAll('.map-check').forEach(el=>{
      el.onclick=()=>{ if(!${canCreate?'true':'false'}) return;
        const m=el.dataset.m;
        if(maps.includes(m)){ if(maps.length>3){ maps=maps.filter(x=>x!==m); el.classList.remove('active'); } }
        else if(maps.length<5){ maps.push(m); el.classList.add('active'); }
      };
    });
    $('quickBtn').onclick=async()=>{
      const r=await fetch('/api/queue',{method:'POST'});
      if(r.ok) location.href='/matchmaking';
      else $('err').textContent=(await r.json()).error||'Ошибка';
    };
    $('createBtn').onclick=async()=>{
      const r=await fetch('/api/lobbies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rank:$('cRank').value,language:$('cLang').value,maps})});
      const j=await r.json();
      if(r.ok) location.href='/lobby/'+j.id;
      else $('err').textContent=j.error||'Ошибка';
    };
    async function load(){
      const q=new URLSearchParams();
      if($('fRank').value) q.set('rank',$('fRank').value);
      if($('fLang').value) q.set('language',$('fLang').value);
      if($('fMap').value) q.set('map',$('fMap').value);
      const r=await fetch('/api/lobbies?'+q);
      const j=await r.json();
      if(!j.lobbies.length){ $('lobbies').innerHTML='<div class="empty">Пока нет открытых лобби. Создай своё или нажми «Быстрый поиск».</div>'; return; }
      $('lobbies').innerHTML=j.lobbies.map(l=>
        '<div class="lobby-card"><div><div class="host">'+esc(l.host_nick)+' <span class="pill pill-'+l.host_status+'">'+(l.host_status==='verified'?'Проверен':'Новичок')+'</span></div><div class="meta">'+l.rank+' · '+l.language+' · '+l.maps.join(', ')+'</div></div><button class="btn btn-fire btn-sm" '+(IS_BANNED?'disabled':'')+' onclick="joinLobby('+l.id+')">Войти</button></div>'
      ).join('');
    }
    async function joinLobby(id){
      const r=await fetch('/api/lobbies/'+id+'/join',{method:'POST'});
      const j=await r.json();
      if(r.ok) location.href='/lobby/'+id;

Артемий (14:59):
else $('err').textContent=j.error||'Ошибка';
    }
    $('fRank').onchange=$('fLang').onchange=$('fMap').onchange=load;
    load(); setInterval(load,3000);
    </script>
  `);
}

function matchmakingPage(user){
  return layout(user, `
    <div class="mm-wrap">
      <div class="mm-spinner"></div>
      <h2>Ищем соперника…</h2>
      <div class="mm-count">Сейчас в поиске: <b id="cnt">0</b> игроков</div>
      <div id="warn"></div>
      <div class="timer" id="timer">Вы в поиске: 00:00</div>
      <div id="hint"></div>
      <div style="margin-top:24px"><button class="btn btn-danger" id="cancelBtn">Отменить поиск</button></div>
    </div>
    <script>
    const start=Date.now();
    const $=id=>document.getElementById(id);
    setInterval(()=>{
      const s=Math.floor((Date.now()-start)/1000);
      $('timer').textContent='Вы в поиске: '+String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
      if(s>120) $('hint').innerHTML='<div style="color:#8b8b9c;font-size:13px;margin-top:12px">Можно зайти в открытые лобби или попробовать позже.</div>';
    },1000);
    async function tick(){
      const r=await fetch('/api/queue/status');
      if(!r.ok){ location.href='/login'; return; }
      const j=await r.json();
      if(j.matched){ location.href='/lobby/'+j.lobbyId; return; }
      if(!j.inQueue){ location.href='/play'; return; }
      $('cnt').textContent=j.count||0;
      $('warn').innerHTML=(j.count<10)?'<div class="warn-box">Сейчас мало игроков в поиске. Поиск может занять дольше обычного. Пожалуйста, подождите.</div>':'';
    }
    tick(); setInterval(tick,2000);
    $('cancelBtn').onclick=async()=>{ await fetch('/api/queue',{method:'DELETE'}); location.href='/play'; };
    </script>
  `);
}

function lobbyPage(user, id){
  return layout(user, `
    <h1 style="font-size:24px" id="h1">Лобби #${id}</h1>
    <div id="statusLine" style="color:#8b8b9c;font-size:13px;margin-bottom:12px"></div>
    <div id="err" class="msg-error"></div>
    <div class="lobby-grid">
      <div>
        <div class="panel" id="opponentBox"></div>
        <div id="vetoArea"></div>
        <div id="confirmArea"></div>
      </div>
      <div class="chat-panel">
        <div class="chat-head"><span>Чат лобби</span><button class="btn btn-sm" id="codeBtn">Код карты</button></div>
        <div class="chat-body" id="chatBody"></div>
        <div class="chat-input"><input id="chatInput" placeholder="Сообщение…" maxlength="500"><button class="btn btn-fire btn-sm" id="sendBtn">→</button></div>
      </div>
    </div>
    <div id="modals"></div>
    <script>
    const $=id=>document.getElementById(id);
    const LOBBY_ID=${id};
    let ME_ID=null;
    const esc=s=>String(s||'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    function statusLabel(s){return {open:'ждёт соперника',veto:'вето карт',playing:'матч',confirm:'подтверждение',done:'завершено',expired:'истекло'}[s]||s}
    function render(d){
      if(!d||!d.lobby) return;
      ME_ID=d.me.id;
      $('statusLine').innerHTML='Статус: <b>'+statusLabel(d.lobby.status)+'</b> · '+d.lobby.rank+' · '+d.lobby.language;
      $('opponentBox').innerHTML='<div class="opponent-card"><div class="avatar">'+esc((d.opponent.nickname||'?')[0].toUpperCase())+'</div><div class="info"><div class="name">'+esc(d.opponent.nickname||'???')+' <span class="pill pill-'+(d.opponent.status||'novice')+'">'+(d.opponent.status==='verified'?'Проверен':'Новичок')+'</span></div><div class="sub">No-show: '+(d.opponent.no_show_count||0)+'</div></div></div>';
      let va='';
      if(d.lobby.status==='veto'){
        const rem=30-Math.floor(Date.now()/1000-(d.lobby.turn_started_at||0));
        va='<div class="panel" style="margin-top:16px"><div style="display:flex;justify-content:space-between"><b>Вето карт</b><span style="color:'+(d.isMyTurn?'#ff5b2e':'#8b8b9c')+'">'+(d.isMyTurn?'Ваш ход':'Ход соперника')+'</span></div><div style="color:#8b8b9c;font-size:12px;margin-top:4px">Осталось:

Артемий (14:59):
'+Math.max(0,rem)+' сек</div><div class="veto-pool">'+d.maps.map(m=>{const b=d.banned.includes(m);return '<div class="map-card'+(b?' banned':'')+(!d.isMyTurn?' locked':'')+'" onclick="'+(d.isMyTurn&&!b?'banMap(\''+m+'\')':'')+'">'+m+'</div>'}).join('')+'</div></div>';
      }
      if(d.lobby.final_map) va+='<div class="final-map"><div class="label">Играете на</div><div class="name">'+esc(d.lobby.final_map)+'</div></div>';
      $('vetoArea').innerHTML=va;
      if(d.lobby.status==='playing'){
        $('confirmArea').innerHTML='<div class="panel" style="margin-top:16px"><b>Подтверждение результата</b><div style="color:#8b8b9c;font-size:13px;margin:8px 0">Ваш ответ: '+(d.myConfirm?d.myConfirm.result:'—')+' · Соперник: '+(d.oppConfirm?d.oppConfirm.result:'—')+'</div><div class="confirm-bar"><button class="btn btn-fire" onclick="confirmR(\'played\')" '+(d.myConfirm?'disabled':'')+'>Матч сыгран</button><button class="btn" onclick="confirmR(\'noshow\')" '+(d.myConfirm?'disabled':'')+'>Соперник не пришёл</button><button class="btn btn-danger" onclick="confirmR(\'fake\')" '+(d.myConfirm?'disabled':'')+'>Фейковый матч</button></div></div>';
      } else if(d.lobby.status==='done'){
        $('confirmArea').innerHTML='<div class="panel" style="margin-top:16px"><b style="color:#4ac97e">Матч завершён</b><div style="margin-top:8px"><a href="/profile" style="color:#ff5b2e">Посмотреть профиль →</a></div></div>';
      } else $('confirmArea').innerHTML='';
      $('chatBody').innerHTML=d.messages.map(m=>'<div class="chat-msg'+(m.user_id===ME_ID?' mine':'')+(m.type==='code'?' code':'')+'"><div class="who">'+esc(m.nickname)+(m.type==='code'?' · код карты':'')+'</div><div class="body">'+esc(m.text)+'</div>'+(m.user_id!==ME_ID?'<div class="report" onclick="reportMsg('+m.id+')">пожаловаться</div>':'')+'</div>').join('');
      const cb=$('chatBody'); cb.scrollTop=cb.scrollHeight;
    }
    async function load(){
      const r=await fetch('/api/lobbies/'+LOBBY_ID);
      if(!r.ok){ $('err').textContent=(await r.json()).error||'Ошибка'; return; }
      render(await r.json());
    }
    async function banMap(m){ await fetch('/api/lobbies/'+LOBBY_ID+'/veto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({map:m})}); load(); }
    async function confirmR(res){ await fetch('/api/lobbies/'+LOBBY_ID+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:res})}); load(); }
    async function sendChat(text,type){ if(!text.trim())return; await fetch('/api/lobbies/'+LOBBY_ID+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,type:type||'text'})}); $('chatInput').value=''; load(); }
    $('sendBtn').onclick=()=>sendChat($('chatInput').value);
    $('chatInput').onkeydown=e=>{if(e.key==='Enter')sendChat($('chatInput').value)};
    $('codeBtn').onclick=()=>{
      $('modals').innerHTML='<div class="modal-bg" id="mb"><div class="modal"><h3>Поделиться кодом карты</h3><div class="field"><label>Код из игры</label><input id="codeIn" placeholder="например ABC123" maxlength="64"></div><div class="modal-actions"><button class="btn" id="mCancel">Отмена</button><button class="btn btn-fire" id="mSend">Отправить в чат</button></div></div></div>';
      $('mb').onclick=e=>{if(e.target.id==='mb')$('modals').innerHTML=''};
      $('mCancel').onclick=()=>{$('modals').innerHTML=''};
      $('mSend').onclick=()=>{const v=$('codeIn').value.trim();if(v){sendChat(v,'code');$('modals').innerHTML=''}};
      $('codeIn').focus();
    };
    async function reportMsg(mid){
      $('modals').innerHTML='<div class="modal-bg" id="mb"><div class="modal"><h3>Пожаловаться</h3><div class="field"><label>Категория</label><select id="repCat"><option value="toxicity">Токсичность</option><option value="noshow">No-show</option><option value="impersonation">Impersonation</option><option value="fake_confirm">Фейковое подтверждение</option></select></div><div

Артемий (14:59):
class="modal-actions"><button class="btn" id="mCancel">Отмена</button><button class="btn btn-fire" id="mSend">Отправить</button></div></div></div>';
      $('mb').onclick=e=>{if(e.target.id==='mb')$('modals').innerHTML=''};
      $('mCancel').onclick=()=>{$('modals').innerHTML=''};
      $('mSend').onclick=async()=>{
        await fetch('/api/lobbies/'+LOBBY_ID+'/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:$('repCat').value,target:mid})});
        $('modals').innerHTML=''; alert('Жалоба отправлена');
      };
    }
    load(); setInterval(load,2000);
    </script>
  `);
}

function profilePage(user){
  const matches = db.matches.filter(m=>m.p1===user.id||m.p2===user.id).slice(-20).reverse();
  const sanctions = db.sanctions.filter(s=>s.user_id===user.id).reverse();
  const isBanned = user.banned_until && user.banned_until > nowS();
  const progress = user.verification_progress||0;
  return layout(user, `
    <div class="profile-hd">
      <div class="big-avatar">${esc((user.nickname[0]||'?').toUpperCase())}</div>
      <div>
        <h1>${esc(user.nickname)}</h1>
        <div class="sub">ID: <code>${esc(user.game_id)}</code> · <span class="pill pill-${user.status}">${statusLabel(user.status)}</span> ${user.is_disputed?'<span class="pill pill-banned">Неправильный ID</span>':''}</div>
      </div>
    </div>
    ${!user.verified?`<div class="panel"><b>Верификация:</b> ${progress} из 2 матчей подтверждено<div class="verify-bar"><div style="width:${(progress/2)*100}%"></div></div><div style="color:#8b8b9c;font-size:12px;margin-top:8px">Сыграй с 2 разными проверенными игроками и подтвердите результат обоюдно.</div></div>`:''}
    <div class="stat-row">
      <div class="stat"><div class="lbl">Матчей</div><div class="val">${matches.length}</div></div>
      <div class="stat"><div class="lbl">No-show</div><div class="val">${user.no_show_count||0}</div></div>
      <div class="stat"><div class="lbl">Санкций</div><div class="val">${sanctions.length}</div></div>
    </div>
    ${isBanned?`<div class="panel" style="border-color:#5a2a2a"><b style="color:#e14b4b">Временный бан</b><div>${esc(user.ban_reason||'')}</div><div style="color:#8b8b9c;font-size:12px;margin-top:4px">До: ${new Date(user.banned_until*1000).toLocaleString('ru')}</div><button class="btn" style="margin-top:12px" disabled>Оспорить бан (в разработке)</button></div>`:''}
    <div class="panel">
      <h3 style="margin-bottom:12px;font-size:16px">История матчей</h3>
      ${matches.length===0?'<div class="empty">Матчей пока нет.</div>':`<table class="history-table"><thead><tr><th>Карта</th><th>Длительность</th><th>Флаг</th><th>Дата</th></tr></thead><tbody>${matches.map(m=>`<tr><td>${esc(m.map||'—')}</td><td>${m.duration}с</td><td>${m.suspicious?'<span style="color:#e8b53a">быстрый</span>':'—'}</td><td>${new Date(m.created_at*1000).toLocaleString('ru')}</td></tr>`).join('')}</tbody></table>`}
    </div>
    <div class="panel">
      <h3 style="margin-bottom:12px;font-size:16px">История санкций</h3>
      ${sanctions.length===0?'<div class="empty">Санкций нет.</div>':`<table class="history-table"><thead><tr><th>Тип</th><th>Причина</th><th>Дата</th></tr></thead><tbody>${sanctions.map(s=>`<tr><td>${{warning:'⚠️ Предупреждение',tempban:'⏱ Временный бан',ban:'🚫 Бан'}[s.type]||s.type}</td><td>${esc(s.reason||'')}</td><td>${new Date(s.created_at*1000).toLocaleString('ru')}</td></tr>`).join('')}</tbody></table>`}
    </div>
  `);
}

// ============ ADMIN PAGE ============
function adminPage(user){
  return layout(user, `
    <h1 style="font-size:26px;margin-bottom:6px">⚙️ Консоль разработчика</h1>
    <div style="color:#8b8b9c;font-size:13px;margin-bottom:20px">
      Доступ только для game_id <code style="color:#ff5b2e">${ADMIN_ID}</code>. Действия необратимы.
      · Storage: <b style="color:${USE_REDIS?'#4ac97e':'#e8b53a'}">${USE_REDIS?'Upstash Redis':'local file'}</b>
    </div>
    <div class="panel">

Артемий (14:59):
<div class="field"><label>Поиск по game_id или нику</label>
        <input id="q" placeholder="например flame_king или 1460..." maxlength="64"></div>
      <button class="btn btn-fire" id="searchBtn">Найти</button>
      <button class="btn" id="refreshBtn" style="margin-left:8px">Показать всех</button>
    </div>
    <div id="err" class="msg-error"></div>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table class="history-table" id="userTable"><thead><tr>
        <th>ID</th><th>game_id</th><th>Ник</th><th>Статус</th><th>Вериф.</th>
        <th>No-show</th><th>Диспут</th><th>Бан</th><th>Зарегистрирован</th><th>Действия</th>
      </tr></thead><tbody id="tbody"><tr><td colspan="10" style="text-align:center;color:#8b8b9c;padding:30px">Загрузка…</td></tr></tbody></table>
    </div>
    <div id="modal"></div>
    <script>
    const $=id=>document.getElementById(id);
    const esc=s=>String(s||'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    const fmt=ts=>ts?new Date(ts*1000).toLocaleString('ru'):'—';
    const isBanned=u=>u.banned_until && u.banned_until>Date.now()/1000;

    async function load(q){
      $('err').textContent='';
      const r=await fetch('/api/admin/users'+(q?'?q='+encodeURIComponent(q):''));
      if(!r.ok){ $('err').textContent=(await r.json()).error||'Ошибка'; return; }
      const j=await r.json();
      if(!j.users.length){ $('tbody').innerHTML='<tr><td colspan="10" style="text-align:center;color:#8b8b9c;padding:30px">Никого не найдено</td></tr>'; return; }
      $('tbody').innerHTML=j.users.map(u=>{
        const banned=isBanned(u);
        const acts=[];
        if(!u.verified) acts.push('<button class="btn btn-sm" onclick="verifyUser('+u.id+')">✅ Верифицировать</button>');
        if(u.is_disputed) acts.push('<button class="btn btn-sm" onclick="clearDispute('+u.id+')">Снять диспут</button>');
        if(banned) acts.push('<button class="btn btn-sm" onclick="unbanUser('+u.id+')">Разбанить</button>');
        else acts.push('<button class="btn btn-sm btn-danger" onclick="promptBan('+u.id+',\\''+esc(u.nickname).replace(/'/g,'')+'\\')">Забанить</button>');
        return '<tr>'+
          '<td>'+u.id+'</td>'+
          '<td><code>'+esc(u.game_id)+'</code></td>'+
          '<td>'+esc(u.nickname)+'</td>'+
          '<td><span class="pill pill-'+u.status+'">'+(u.status==='verified'?'Проверен':u.status==='banned'?'Забанен':'Новичок')+'</span></td>'+
          '<td>'+(u.verified?'✅':'—')+'</td>'+
          '<td>'+(u.no_show_count||0)+'</td>'+
          '<td>'+(u.is_disputed?'⚠️':'—')+'</td>'+
          '<td>'+(banned?'<span style="color:#e14b4b;font-size:12px">'+esc(u.ban_reason||'бан')+'</span>':'—')+'</td>'+
          '<td style="font-size:12px;color:#8b8b9c">'+fmt(u.created_at)+'</td>'+
          '<td style="white-space:nowrap">'+acts.join(' ')+'</td>'+
        '</tr>';
      }).join('');
    }

    async function verifyUser(id){
      if(!confirm('Выдать верификацию этому аккаунту?')) return;
      const r=await fetch('/api/admin/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
      if(!r.ok){ $('err').textContent=(await r.json()).error||'Ошибка'; return; }
      load($('q').value);
    }
    async function unbanUser(id){
      if(!confirm('Разбанить этот аккаунт?')) return;
      const r=await fetch('/api/admin/unban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
      if(!r.ok){ $('err').textContent=(await r.json()).error||'Ошибка'; return; }
      load($('q').value);
    }
    async function clearDispute(id){
      if(!confirm('Снять плашку «Неправильный ID»?')) return;
      const r=await fetch('/api/admin/clear-dispute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
      if(!r.ok){ $('err').textContent=(await r.json()).error||'Ошибка'; return; }
      load($('q').value);
    }
    function promptBan(id,nick){

Артемий (14:59):
$('modal').innerHTML='<div class="modal-bg" id="mb"><div class="modal"><h3>Забанить '+esc(nick)+'</h3>'+
        '<div class="field"><label>Причина</label><input id="banReason" value="Забанен администратором" maxlength="200"></div>'+
        '<div class="modal-actions"><button class="btn" id="mCancel">Отмена</button>'+
        '<button class="btn btn-danger" id="mBan">Забанить</button></div></div></div>';
      $('mb').onclick=e=>{if(e.target.id==='mb')$('modal').innerHTML=''};
      $('mCancel').onclick=()=>{$('modal').innerHTML=''};
      $('mBan').onclick=async()=>{
        const reason=$('banReason').value.trim()||'Забанен администратором';
        const r=await fetch('/api/admin/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,reason})});
        $('modal').innerHTML='';
        if(!r.ok){ $('err').textContent=(await r.json()).error||'Ошибка'; return; }
        load($('q').value);
      };
      $('banReason').focus();
    }
    $('searchBtn').onclick=()=>load($('q').value);
    $('refreshBtn').onclick=()=>{ $('q').value=''; load(''); };
    $('q').onkeydown=e=>{if(e.key==='Enter')load($('q').value)};
    load('');
    </script>
  `);
}

// ============ API ============
async function handleAPI(req,res,pathname,method,user){

  // ===== ADMIN =====
  if(pathname.startsWith('/api/admin/')){
    if(!isAdmin(user)) return json(res,403,{error:'Нет доступа'});

    if(pathname==='/api/admin/users' && method==='GET'){
      const u = new URL(req.url,'http://x');
      const q = (u.searchParams.get('q')||'').trim().toLowerCase();
      let list = db.users.slice().sort((a,b)=>b.id-a.id);
      if(q) list = list.filter(x =>
        x.game_id.toLowerCase().includes(q) || x.nickname.toLowerCase().includes(q));
      return json(res,200,{users:list.map(x=>({
        id:x.id, game_id:x.game_id, nickname:x.nickname, status:x.status,
        verified:!!x.verified, no_show_count:x.no_show_count||0,
        is_disputed:!!x.is_disputed,
        banned_until:x.banned_until||0, ban_reason:x.ban_reason||'',
        created_at:x.created_at
      }))});
    }

    if(pathname==='/api/admin/verify' && method==='POST'){
      const b = await body(req);
      const t = db.users.find(x=>x.id===b.id);
      if(!t) return json(res,404,{error:'Не найден'});
      t.verified = true; t.status = 'verified';
      t.verification_progress = 2; t.is_disputed = false;
      db.sanctions.push({id:next('sanction'),user_id:t.id,type:'warning',
        reason:'Верифицирован администратором',created_at:nowS()});
      save(); return json(res,200,{ok:true});
    }

    if(pathname==='/api/admin/clear-dispute' && method==='POST'){
      const b = await body(req);
      const t = db.users.find(x=>x.id===b.id);
      if(!t) return json(res,404,{error:'Не найден'});
      t.is_disputed = false; t.no_show_count = 0;
      save(); return json(res,200,{ok:true});
    }

    if(pathname==='/api/admin/ban' && method==='POST'){
      const b = await body(req);
      const t = db.users.find(x=>x.id===b.id);
      if(!t) return json(res,404,{error:'Не найден'});
      if(t.game_id === ADMIN_ID) return json(res,403,{error:'Нельзя забанить владельца консоли'});
      t.banned_until = 9999999999;
      t.ban_reason = String(b.reason||'Забанен администратором').slice(0,200);
      t.status = 'banned';
      db.sanctions.push({id:next('sanction'),user_id:t.id,type:'ban',
        reason:t.ban_reason,created_at:nowS()});
      save(); return json(res,200,{ok:true});
    }

    if(pathname==='/api/admin/unban' && method==='POST'){
      const b = await body(req);
      const t = db.users.find(x=>x.id===b.id);
      if(!t) return json(res,404,{error:'Не найден'});
      t.banned_until = 0; t.ban_reason = '';
      t.status = t.verified ? 'verified' : 'novice';
      save(); return json(res,200,{ok:true});
    }

    return json(res,404,{error:'Not found'});
  }
  // ===== /ADMIN =====

  if(pathname==='/api/health' && method==='GET'){

Артемий (14:59):
return json(res,200,{ok:true, storage: USE_REDIS?'redis':'file',
      users: db.users.length, lobbies: db.lobbies.length});
  }

  if(pathname==='/api/register' && method==='POST'){
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'l';
    if(!limit('reg:'+ip,5,3600000)) return json(res,429,{error:'Слишком много попыток'});
    const b = await body(req);
    const gid = String(b.game_id||'').trim();
    const nick = String(b.nickname||'').trim();
    if(!gid||!nick) return json(res,400,{error:'Заполните поля'});
    if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(gid)) return json(res,400,{error:'ID: 3–32 символа (буквы, цифры, _ . -)'});
    if(nick.length<2||nick.length>32) return json(res,400,{error:'Ник: 2–32'});
    const existing = db.users.filter(u=>u.game_id===gid);
    if(existing.find(u=>u.verified)) return json(res,400,{error:'ID уже подтверждён другим игроком'});
    if(existing.length>=3) return json(res,400,{error:'На этот ID уже 3 претендента'});
    const recovery = crypto.randomBytes(8).toString('hex');
    const u = { id:next('user'), game_id:gid, nickname:nick, status:'novice', verified:false,
      verification_progress:0, verification_opponents:[], no_show_count:0, is_disputed:false,
      banned_until:0, ban_reason:'', recovery_code:recovery, created_at:nowS() };
    db.users.push(u); save(); login(res,u);
    return json(res,200,{ok:true,recovery});
  }
  if(pathname==='/api/recover' && method==='POST'){
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'l';
    if(!limit('rec:'+ip,5,600000)) return json(res,429,{error:'Слишком много попыток'});
    const b = await body(req);
    const u = db.users.find(x=>x.game_id===b.game_id && x.recovery_code===b.recovery_code);
    if(!u) return json(res,400,{error:'Неверный ID или код'});
    login(res,u); return json(res,200,{ok:true});
  }
  if(pathname==='/api/logout' && method==='POST'){ logout(res); return json(res,200,{ok:true}); }
  if(pathname==='/api/me' && method==='GET') return json(res,200,{user: user?{id:user.id,nickname:user.nickname,status:user.status}:null});

  if(pathname==='/api/lobbies' && method==='GET'){
    const u = new URL(req.url,'http://x');
    const rank=u.searchParams.get('rank'), lang=u.searchParams.get('language'), map=u.searchParams.get('map');
    let list = db.lobbies.filter(l=>l.status==='open' && !l.guest_id);
    if(rank) list = list.filter(l=>l.rank===rank);
    if(lang) list = list.filter(l=>l.language===lang);
    if(map) list = list.filter(l=>l.maps.includes(map));
    const out = list.map(l=>{
      const h = db.users.find(x=>x.id===l.host_id);
      return {id:l.id,rank:l.rank,language:l.language,maps:l.maps,host_nick:h?h.nickname:'?',host_status:h?h.status:'novice'};
    });
    return json(res,200,{lobbies:out});
  }
  if(pathname==='/api/lobbies' && method==='POST'){
    if(!user) return json(res,401,{error:'Войдите'});
    if(!user.verified) return json(res,403,{error:'Только для проверенных'});
    if(user.banned_until && user.banned_until>nowS()) return json(res,403,{error:'Забанены'});
    if(user.is_disputed) return json(res,403,{error:'Плашка «Неправильный ID»'});
    const b = await body(req);
    if(!RANKS.includes(b.rank)) return json(res,400,{error:'Неверный ранг'});
    if(!LANGS.includes(b.language)) return json(res,400,{error:'Неверный язык'});
    if(!Array.isArray(b.maps)||b.maps.length<3||b.maps.length>5) return json(res,400,{error:'3–5 карт'});
    if(!b.maps.every(m=>MAPS.includes(m))) return json(res,400,{error:'Неверная карта'});
    const l = {id:next('lobby'),host_id:user.id,guest_id:null,rank:b.rank,language:b.language,maps:b.maps,
      status:'open',current_turn:null,turn_started_at:null,banned_maps:[],final_map:null,final_map_set_at:null,created_at:nowS()};
    db.lobbies.push(l); save();
    return json(res,200,{id:l.id});
  }

  const m = pathname.match(/^\/api\/lobbies\/(\d+)(?:\/(\w+))?$/);
  if(m){
    const lid = +m[1], action = m[2];

Артемий (14:59):
const lobby = db.lobbies.find(l=>l.id===lid);
    if(!lobby) return json(res,404,{error:'Лобби не найдено'});

    if(!action && method==='GET'){
      if(!user) return json(res,401,{error:'Войдите'});
      if(lobby.host_id!==user.id && lobby.guest_id!==user.id) return json(res,403,{error:'Нет доступа'});
      tickVeto(lobby); resolveMatch(lobby);
      const oppId = lobby.host_id===user.id?lobby.guest_id:lobby.host_id;
      const opp = db.users.find(x=>x.id===oppId);
      const msgs = db.messages.filter(x=>x.lobby_id===lobby.id).sort((a,b)=>a.created_at-b.created_at)
        .map(msg=>({id:msg.id,user_id:msg.user_id,nickname:(db.users.find(x=>x.id===msg.user_id)||{}).nickname||'?',text:msg.text,type:msg.type}));
      const myC = db.confirmations.find(c=>c.lobby_id===lobby.id && c.user_id===user.id);
      const oppC = db.confirmations.find(c=>c.lobby_id===lobby.id && c.user_id===oppId);
      return json(res,200,{
        lobby:{id:lobby.id,status:lobby.status,rank:lobby.rank,language:lobby.language,turn_started_at:lobby.turn_started_at,final_map:lobby.final_map},
        me:{id:user.id,nickname:user.nickname},
        opponent: opp?{nickname:opp.nickname,status:opp.status,no_show_count:opp.no_show_count||0}:{},
        maps:lobby.maps, banned:lobby.banned_maps||[],
        isMyTurn: lobby.current_turn===user.id,
        myConfirm: myC?{result:myC.result}:null,
        oppConfirm: oppC?{result:oppC.result}:null,
        messages: msgs
      });
    }
    if(action==='join' && method==='POST'){
      if(!user) return json(res,401,{error:'Войдите'});
      if(lobby.status!=='open') return json(res,400,{error:'Лобби уже занято'});
      if(lobby.host_id===user.id) return json(res,400,{error:'Это ваше лобби'});
      if(user.banned_until && user.banned_until>nowS()) return json(res,403,{error:'Вы временно забанены'});
      if(user.is_disputed) return json(res,403,{error:'Плашка «Неправильный ID»'});
      lobby.guest_id=user.id; lobby.status='veto'; lobby.current_turn=lobby.host_id; lobby.turn_started_at=nowS();
      save(); return json(res,200,{ok:true});
    }
    if(action==='veto' && method==='POST'){
      if(!user) return json(res,401,{error:'Войдите'});
      if(lobby.status!=='veto') return json(res,400,{error:'Не время вето'});
      if(lobby.current_turn!==user.id) return json(res,400,{error:'Не ваш ход'});
      const b = await body(req);
      if(!lobby.maps.includes(b.map)) return json(res,400,{error:'Нет такой карты'});
      if((lobby.banned_maps||[]).includes(b.map)) return json(res,400,{error:'Уже забанена'});
      lobby.banned_maps=[...(lobby.banned_maps||[]),b.map];
      const rem = lobby.maps.filter(x=>!lobby.banned_maps.includes(x));
      if(rem.length<=1){ lobby.status='playing'; lobby.final_map=rem[0]; lobby.final_map_set_at=nowS(); }
      else { lobby.current_turn = lobby.current_turn===lobby.host_id?lobby.guest_id:lobby.host_id; lobby.turn_started_at=nowS(); }
      save(); return json(res,200,{ok:true});
    }
    if(action==='chat' && method==='POST'){
      if(!user) return json(res,401,{error:'Войдите'});
      if(lobby.host_id!==user.id && lobby.guest_id!==user.id) return json(res,403,{error:'Нет доступа'});
      const b = await body(req);
      const text = String(b.text||'').trim().slice(0,500);
      if(!text) return json(res,400,{error:'Пусто'});
      db.messages.push({id:next('message'),lobby_id:lobby.id,user_id:user.id,text,type:b.type==='code'?'code':'text',created_at:nowS()});
      save(); return json(res,200,{ok:true});
    }
    if(action==='confirm' && method==='POST'){
      if(!user) return json(res,401,{error:'Войдите'});
      if(lobby.status!=='playing') return json(res,400,{error:'Нечего подтверждать'});
      if(lobby.host_id!==user.id && lobby.guest_id!==user.id) return json(res,403,{error:'Нет доступа'});
      const b = await body(req);
      if(!['played','noshow','fake'].includes(b.result)) return json(res,400,{error:'Неверный результат'});

Артемий (14:59):
if(db.confirmations.find(c=>c.lobby_id===lobby.id && c.user_id===user.id)) return json(res,400,{error:'Вы уже подтвердили'});
      db.confirmations.push({id:next('confirmation'),lobby_id:lobby.id,user_id:user.id,result:b.result,created_at:nowS()});
      save(); resolveMatch(lobby);
      return json(res,200,{ok:true});
    }
    if(action==='report' && method==='POST'){
      if(!user) return json(res,401,{error:'Войдите'});
      if(lobby.host_id!==user.id && lobby.guest_id!==user.id) return json(res,403,{error:'Нет доступа'});
      const b = await body(req);
      if(!['toxicity','noshow','impersonation','fake_confirm'].includes(b.category)) return json(res,400,{error:'Неверная категория'});
      const target = lobby.host_id===user.id?lobby.guest_id:lobby.host_id;
      db.reports.push({id:next('report'),reporter_id:user.id,target_id:target,lobby_id:lobby.id,category:b.category,created_at:nowS()});
      const since = nowS()-14*86400;
      const distinct = new Set(db.reports.filter(r=>r.target_id===target&&r.category===b.category&&r.created_at>since).map(r=>r.reporter_id)).size;
      if(distinct>=5){
        const t = db.users.find(u=>u.id===target);
        if(t){ t.banned_until=nowS()+72*3600; t.ban_reason='5 уникальных жалоб ('+b.category+') за 14 дней';
          db.sanctions.push({id:next('sanction'),user_id:target,type:'tempban',reason:t.ban_reason,created_at:nowS()}); }
      }
      save(); return json(res,200,{ok:true});
    }
    return json(res,404,{error:'Not found'});
  }

  if(pathname==='/api/queue' && method==='POST'){
    if(!user) return json(res,401,{error:'Войдите'});
    if(user.banned_until && user.banned_until>nowS()) return json(res,403,{error:'Вы временно забанены'});
    if(user.is_disputed) return json(res,403,{error:'Плашка «Неправильный ID»'});
    db.queue = db.queue.filter(q=>q.user_id!==user.id);
    db.queue.push({user_id:user.id,entered_at:nowS()});
    save(); return json(res,200,{ok:true});
  }
  if(pathname==='/api/queue' && method==='DELETE'){
    if(user){ db.queue = db.queue.filter(q=>q.user_id!==user.id); save(); }
    return json(res,200,{ok:true});
  }
  if(pathname==='/api/queue/status' && method==='GET'){
    if(!user) return json(res,401,{error:'Войдите'});
    db.queue = db.queue.filter(q=>nowS()-q.entered_at<300);
    const mine = db.queue.find(q=>q.user_id===user.id);
    if(!mine){ save(); return json(res,200,{inQueue:false}); }
    const other = db.queue.find(q=>q.user_id!==user.id);
    if(other){
      const hostId = other.entered_at<=mine.entered_at ? other.user_id : mine.user_id;
      const guestId = hostId===mine.user_id ? other.user_id : mine.user_id;
      const l = {id:next('lobby'),host_id:hostId,guest_id:guestId,rank:'Silver',language:'RU',
        maps:['Dust2','Mirage','Inferno'],status:'veto',current_turn:hostId,turn_started_at:nowS(),
        banned_maps:[],final_map:null,final_map_set_at:null,created_at:nowS()};
      db.lobbies.push(l);
      db.queue = db.queue.filter(q=>q.user_id!==user.id && q.user_id!==other.user_id);
      save(); return json(res,200,{matched:true,lobbyId:l.id,inQueue:false});
    }
    save(); return json(res,200,{inQueue:true,count:db.queue.length});
  }

  return json(res,404,{error:'Not found'});
}

// ============ ROUTER ============
const server = http.createServer(async (req,res)=>{
  const u = new URL(req.url,'http://x');
  const pathname = u.pathname, method = req.method;
  const user = me(req);

  if(method==='POST' && req.headers.origin){
    try{ if(new URL(req.headers.origin).host !== req.headers.host) return json(res,403,{error:'CSRF'}); }
    catch{ return json(res,403,{error:'Bad origin'}); }
  }

  try{
    if(pathname.startsWith('/api/')) return await handleAPI(req,res,pathname,method,user);
    if(pathname==='/') return sendHTML(res,200,homePage(user));
    if(pathname==='/login'){ if(user){ res.writeHead(302,{Location:'/play'}); return res.end(); } return sendHTML(res,200,loginPage()); }

Артемий (14:59):
if(pathname==='/play'){ if(!user){ res.writeHead(302,{Location:'/login'}); return res.end(); } return sendHTML(res,200,playPage(user)); }
    if(pathname==='/matchmaking'){ if(!user){ res.writeHead(302,{Location:'/login'}); return res.end(); } return sendHTML(res,200,matchmakingPage(user)); }
    const lm = pathname.match(/^\/lobby\/(\d+)$/);
    if(lm){ if(!user){ res.writeHead(302,{Location:'/login'}); return res.end(); } return sendHTML(res,200,lobbyPage(user,+lm[1])); }
    if(pathname==='/admin'){
      if(!user){ res.writeHead(302,{Location:'/login'}); return res.end(); }
      if(!isAdmin(user)){ res.writeHead(302,{Location:'/'}); return res.end(); }
      return sendHTML(res,200,adminPage(user));
    }
    if(pathname==='/profile'){ if(!user){ res.writeHead(302,{Location:'/login'}); return res.end(); } return sendHTML(res,200,profilePage(user)); }
    sendHTML(res,404,'<div style="padding:40px;font-family:sans-serif;background:#0e0e12;color:#eaeaf0;min-height:100vh"><h1>404</h1><a href="/" style="color:#ff5b2e">Главная</a></div>');
  } catch(e){
    console.error(e);
    json(res,500,{error:'Server error: '+e.message});
  }
});

// ============ BOOT ============
(async () => {
  await loadDB();
  server.listen(PORT, () => {
    console.log('\n  🔥 Counter Flame Faceit → http://localhost:'+PORT);
    console.log('  Storage:', USE_REDIS ? 'Upstash Redis' : 'local file ('+DB_FILE+')');
    console.log('  Admin ID:', ADMIN_ID, '\n');
  });
})();