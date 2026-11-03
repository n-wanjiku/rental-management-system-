/* ==========================================================
   Margaret Manager — script.js
   - Works offline on each device; syncs through the owner's Google Drive
   - No app password / login. One-time "Allow" for Google Drive only.
   ========================================================== */

/* >>> OPTIONAL: paste your Google Client ID between the quotes ONCE.
   Every device that opens this app then connects automatically. <<< */
const DEFAULT_CLIENT_ID = '';

/* ================= DATA ================= */
const KEY  = 'margaretManager.v1';
const HKEY = 'margaretManager.history.v1';
const CKEY = 'margaretManager.settings.v1';   // this device only (Client ID, Drive ids)
const TKEY = 'margaretManager.token.v1';      // short-lived Google token (this tab session)
const DATA_FILE = 'margaret-data.json';
const $  = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => 'Ksh ' + Number(n || 0).toLocaleString('en-KE');
const today = () => new Date().toISOString().slice(0, 10);
const curKey = () => today().slice(0, 7);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function monthName(key){ if(!key) return '—'; const [y,m] = key.split('-'); return MONTHS[+m-1] + ' ' + y; }
function keyShift(base, n){ const [y,m] = base.split('-').map(Number); const d = new Date(y, m-1+n, 1);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); }
function monthsFrom(startKey, endKey){ const [a,b]=startKey.split('-').map(Number); const [c,d]=endKey.split('-').map(Number);
  return (c-a)*12 + (d-b) + 1; }
function uid(){ return 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }
function hash(s){ let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function clone(x){ return JSON.parse(JSON.stringify(x)); }
const dShort = d => new Date(d).toLocaleDateString('en-KE', { day:'numeric', month:'short', year:'numeric' });

/* ---------- Settings kept on this device only ---------- */
function cfg(){ try { return JSON.parse(localStorage.getItem(CKEY) || '{}'); } catch(e){ return {}; } }
function setCfg(p){ try { localStorage.setItem(CKEY, JSON.stringify({ ...cfg(), ...p })); } catch(e){} }
function clientId(){ return cfg().driveClientId || DEFAULT_CLIENT_ID || ''; }

/* ---------- State ---------- */
function emptyState(){
  return { properties: [], archive: [], feed: [], unmatched: [], settings: {},
           deleted: { archive: [], unmatched: [], properties: [] }, demo: false };
}
function normalize(s){
  if (s.settings && s.settings.driveClientId && !cfg().driveClientId) setCfg({ driveClientId: s.settings.driveClientId });
  s.settings = {};
  s.properties = s.properties || [];
  s.archive = s.archive || [];
  s.feed = s.feed || [];
  s.unmatched = s.unmatched || [];
  s.deleted = s.deleted || {};
  ['archive','unmatched','properties'].forEach(k => s.deleted[k] = s.deleted[k] || []);
  /* give every tenant / payment a stable id (same ids on every device for older data) */
  const fixPays = (arr, seedKey) => {
    const seen = {};
    (arr || []).forEach(x => {
      if (!x.id){
        const base = [x.date, x.amount, x.method, x.ref || ''].join('|');
        seen[base] = (seen[base] || 0) + 1;
        x.id = 'p_' + hash(seedKey + '|' + base + '|' + seen[base]);
      }
    });
  };
  s.properties.forEach(p => p.units.forEach(u => {
    u.log = u.log || [];
    if (u.tenant){
      if (!u.tenant.id) u.tenant.id = 't_' + hash(u.id + '|' + u.tenant.name + '|' + u.tenant.start);
      u.tenant.payments = u.tenant.payments || [];
      fixPays(u.tenant.payments, u.tenant.id);
    }
  }));
  s.archive.forEach(a => { a.payments = a.payments || []; fixPays(a.payments, a.id); });
  return s;
}
function newPay(date, amount, method, ref){ return { id: 'p' + uid(), date, amount, method, ref: ref || '' }; }

const bundled = window.__MM_BUNDLE || null;
if (bundled && bundled.clientId && !cfg().driveClientId) setCfg({ driveClientId: bundled.clientId });
let state = load();
const hadLocal = !!state;
if (!state) state = (bundled && bundled.data) ? bundled.data : (clientId() ? emptyState() : seed());
normalize(state);
if (hadLocal && bundled && bundled.data){
  try { state = mergeStates(state, normalize(clone(bundled.data))); persistLocal(); } catch(e){}
}

function load(){ try { const d = localStorage.getItem(KEY); return d ? JSON.parse(d) : null; } catch(e){ return null; } }
function persistLocal(){
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch(e){ toast('⚠️ Could not save on this device. Please tap 💾 to download a backup.'); return false; }
}
function save(){ state.demo = false; const ok = persistLocal(); scheduleSync(); return ok; }

/* ---------- Restore points (a copy is kept before every change) ---------- */
function readHistory(){ try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch(e){ return []; } }
function snapshot(label){
  try {
    let h = readHistory();
    h.unshift({ t: new Date().toISOString(), label, data: JSON.stringify(state) });
    h = h.slice(0, 30);
    while (h.length){
      try { localStorage.setItem(HKEY, JSON.stringify(h)); break; }
      catch(e){ h.pop(); }
    }
  } catch(e){}
}
function openHistory(){
  const h = readHistory();
  openModal(`
    <h3>🕘 Restore an earlier version</h3>
    <p style="color:var(--muted); margin-top:0;">A copy is saved before every payment, tenant change, move-out and deletion (the last 30 are kept). Restoring an entry puts everything back exactly as it was <b>just before</b> that change, on all your synced devices. The current version is saved first, so you can undo a restore too.</p>
    ${h.length ? h.map((x, i) => `
      <div class="rowitem">
        <div class="grow"><div class="t1">${esc(x.label)}</div>
        <div class="t2">${new Date(x.t).toLocaleString('en-KE')}</div></div>
        <button class="btn soft" onclick="restoreSnapshot(${i})">Restore</button>
      </div>`).join('')
      : '<div class="empty">Nothing saved yet. Copies appear here as you make changes.</div>'}
    <div class="btnrow"><button class="btn soft block" onclick="closeModal()">Close</button></div>`);
}
function restoreSnapshot(i){
  const h = readHistory();
  const entry = h[i];
  if (!entry) return;
  if (!confirm('Go back to how things were before:\n"' + entry.label + '"\n(' + new Date(entry.t).toLocaleString('en-KE') + ')?\n\nChanges made after that moment will be undone. The current version is saved first.')) return;
  const data = entry.data;
  snapshot('Before restoring an earlier version');
  state = normalize(JSON.parse(data));
  state.reset = { id: uid(), at: Date.now() };
  save(); closeModal(); toast('🕘 Earlier version restored'); go('dashboard');
}

function seed(){
  const cur = curKey();
  const T = (name, phone, rent, startBack, paidMonthsBack) => ({
    name, phone, rent, start: keyShift(cur, -startBack),
    payments: paidMonthsBack.flatMap(item => {
      const isNum = typeof item === 'number';
      const mk = isNum ? item : item.k;
      const parts = isNum ? [rent] : item.parts;
      return parts.map((amount, i) => ({
        date: keyShift(cur, -mk) + '-' + String(isNum ? 5 : 3 + i * 4).padStart(2, '0'),
        amount, method: 'M-Pesa', ref: 'Q' + Math.random().toString(36).slice(2,8).toUpperCase()
      }));
    }),
    deposit: rent,
    log: []
  });
  const unitsOf = (count, tenants) => Array.from({length: count}, (_, i) => ({
    id: uid(), no: 'H' + (i+1), tenant: tenants[i+1] || null, log: []
  }));
  const props = [
    { id: uid(), name: 'Sunrise Apartments', units: unitsOf(12, {
        1: T('John Mwangi','0712 345 678',12000,3,[3,{k:2,parts:[5000,6000]},1]),
        2: T('Mary Njeri','0722 456 789',12000,3,[3,2,1,{k:0,parts:[5000,6000]}]),
        3: T('Peter Otieno','0733 567 890',11500,5,[5,4,{k:3,parts:[5000,5500]},2,1,0]),
        4: T('Grace Achieng','0744 678 901',12000,3,[3,2]),
        5: T('Samuel Kiprop','0755 789 012',12500,8,[8,7,6,5,4,3,2,1,0]),
        6: T('Lucy Wanjiku','0766 890 123',12000,3,[3,2,{k:1,parts:[7000,5000]}]),
        7: T('David Omondi','0777 901 234',12000,4,[4,3,2,1]),
        8: T('Esther Muthoni','0788 012 345',12000,3,[3,1,0]),
        9: T('Brian Kiptoo','0799 123 456',11800,2,[2,1,0])
      })},
    { id: uid(), name: 'Garden Court Bungalows', units: unitsOf(5, {
        1: T('Agnes Wambui','0701 234 567',18000,6,[6,5,{k:4,parts:[10000,6000]},3,2,1]),
        2: T('Joseph Mwangi','0702 345 678',18000,6,[6,5,4,3,2]),
        3: T('Faith Nyambura','0703 456 789',17500,10,[10,9,8,7,6,5,4,3,2,1,0]),
        4: T('Hassan Ali','0704 567 890',18000,3,[3,2,{k:1,parts:[9000,9000]},0])
      })},
    { id: uid(), name: 'Blue Heights Flats', units: unitsOf(20, {
        1: T('Rose Adhiambo','0710 111 222',9000,4,[4,3,{k:2,parts:[3000,3000,2500]},1,{k:0,parts:[4000,4000]}]),
        2: T('Kevin Onyango','0711 222 333',9000,4,[4,3,2]),
        3: T('Sarah Chemutai','0712 333 444',9500,7,[7,6,5,4,3,2,1,0]),
        5: T('Daniel Njoroge','0714 555 666',9000,4,[4,3,2,1]),
        6: T('Mercy Wanjiru','0715 666 777',9000,12,[12,11,10,9,8,7,6,5,4,3,2,1,0]),
        8: T('Stephen Ouma','0717 888 999',9000,4,[4,3]),
        10: T('Janet Kilonzo','0719 000 111',9200,2,[2,1,0])
      })}
  ];
  const s = emptyState();
  s.properties = props;
  s.demo = true;   /* sample data: never overrides real data from another device */
  return s;
}

/* ================= MERGE (what makes syncing safe) =================
   Two devices can each record payments; merging keeps every payment from both.   */
function mergeStates(a, b){
  if (a.demo && !b.demo) return clone(b);
  if (b.demo && !a.demo) return clone(a);
  const ra = (a.reset && a.reset.at) || 0, rb = (b.reset && b.reset.at) || 0;
  if ((a.reset && a.reset.id) !== (b.reset && b.reset.id) && ra !== rb) return clone(ra > rb ? a : b);

  const out = emptyState();
  out.demo = !!(a.demo && b.demo);
  out.reset = a.reset || b.reset;
  ['archive','unmatched','properties'].forEach(k => out.deleted[k] = [...new Set([...(a.deleted[k] || []), ...(b.deleted[k] || [])])]);
  const gone = k => new Set(out.deleted[k]);

  /* former tenants */
  const gA = gone('archive'), am = new Map();
  [...a.archive, ...b.archive].forEach(x => { if (!gA.has(x.id) && !am.has(x.id)) am.set(x.id, clone(x)); });
  out.archive = [...am.values()].sort((x, y) => (y.vacatedOn || '').localeCompare(x.vacatedOn || ''));

  /* properties → units → tenants */
  const gP = gone('properties');
  const pa = new Map(a.properties.map(p => [p.id, p])), pb = new Map(b.properties.map(p => [p.id, p]));
  const order = [...a.properties.map(p => p.id), ...b.properties.filter(p => !pa.has(p.id)).map(p => p.id)];
  out.properties = order.filter(id => !gP.has(id)).map(id => mergeProp(pa.get(id), pb.get(id), out.archive));

  /* unmatched M-Pesa payments */
  const gU = gone('unmatched'), um = new Map();
  [...a.unmatched, ...b.unmatched].forEach(x => { if (!gU.has(x.id) && !um.has(x.id)) um.set(x.id, clone(x)); });
  out.unmatched = [...um.values()].sort((x, y) => String(y.date).localeCompare(String(x.date)));

  /* recently matched feed */
  const fm = new Map();
  [...a.feed, ...b.feed].forEach(f => { const k = [f.date, f.ref, f.amount, f.name].join('|'); if (!fm.has(k)) fm.set(k, clone(f)); });
  out.feed = [...fm.values()].sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 60);
  return out;
}
function isArchived(t, u, p, archive){
  return archive.some(x => x.tenantId ? x.tenantId === t.id
    : (x.name === t.name && x.unitNo === u.no && x.propertyId === p.id && x.start === t.start));
}
function archiveEntry(t, u, p, depBack, note){
  return { id: uid(), tenantId: t.id, name: t.name, phone: t.phone, rent: t.rent,
    deposit: t.deposit || 0, depositReturned: depBack || 0, start: t.start,
    propertyName: p.name, propertyId: p.id, unitNo: u.no, vacatedOn: today(),
    payments: t.payments || [], log: u.log || [], note: note || '' };
}
function mergeProp(x, y, archive){
  if (!x || !y){
    const p = clone(x || y);
    p.units.forEach(u => { if (u.tenant && isArchived(u.tenant, u, p, archive)){ u.tenant = null; u.log = []; } });
    return p;
  }
  const base = (y.updatedAt || 0) > (x.updatedAt || 0) ? y : x;
  const p = { id: x.id, name: base.name, units: [], defaultRent: base.defaultRent, defaultDeposit: base.defaultDeposit, updatedAt: base.updatedAt || 0 };
  const ua = new Map(x.units.map(u => [u.id, u])), ub = new Map(y.units.map(u => [u.id, u]));
  const order = [...x.units.map(u => u.id), ...y.units.filter(u => !ua.has(u.id)).map(u => u.id)];
  p.units = order.map(id => mergeUnit(ua.get(id), ub.get(id), p, archive));
  p.units.forEach(u => { const bu = base.units.find(z => z.id === u.id); if (bu) u.no = bu.no; });   /* house renames follow the newest edit */
  return p;
}
function mergeUnit(u1, u2, p, archive){
  if (!u1 || !u2){
    const u = clone(u1 || u2);
    if (u.tenant && isArchived(u.tenant, u, p, archive)){ u.tenant = null; u.log = []; }
    return u;
  }
  const u = { id: u1.id, no: u1.no, tenant: null, log: [] };
  const t1 = u1.tenant, t2 = u2.tenant;
  const ok = t => !!t && !isArchived(t, u, p, archive);
  if (ok(t1) && ok(t2)){
    if (t1.id === t2.id) u.tenant = mergeTenant(t1, t2);
    else {
      const newer = (t2.updatedAt || t2.createdAt || 0) > (t1.updatedAt || t1.createdAt || 0);
      const w = newer ? t2 : t1, l = newer ? t1 : t2;
      u.tenant = clone(w);
      archive.unshift(archiveEntry(l, newer ? u2 : u1, p, 0, 'Kept from another device'));
    }
  } else if (ok(t1)) u.tenant = clone(t1);
  else if (ok(t2)) u.tenant = clone(t2);
  if (u.tenant){
    const lists = [];
    if (t1 && t1.id === u.tenant.id) lists.push(u1.log || []);
    if (t2 && t2.id === u.tenant.id) lists.push(u2.log || []);
    const seen = new Set();
    lists.flat().forEach(l => { const k = l.date + '|' + l.text; if (!seen.has(k)){ seen.add(k); u.log.push(l); } });
    u.log.sort((m, n) => m.date.localeCompare(n.date));
  }
  return u;
}
function mergeTenant(t1, t2){
  const w = (t2.updatedAt || 0) > (t1.updatedAt || 0) ? t2 : t1;
  const m = clone(w);
  const pm = new Map();
  [...(t1.payments || []), ...(t2.payments || [])].forEach(x => { if (!pm.has(x.id)) pm.set(x.id, clone(x)); });
  m.payments = [...pm.values()].sort((p, q) => p.date.localeCompare(q.date));
  return m;
}

/* ================= HELPERS ================= */
function allUnits(){
  const out = [];
  state.properties.forEach(p => p.units.forEach(u => out.push({p, u})));
  return out;
}
function paidTotal(u){ return (u.tenant?.payments || []).reduce((s, x) => s + (+x.amount || 0), 0); }
function expected(u, upTo){
  if (!u.tenant) return 0;
  const end = u.tenant.start > upTo ? keyShift(u.tenant.start, -1) : upTo;
  if (end < u.tenant.start) return 0;
  return monthsFrom(u.tenant.start, end) * (+u.tenant.rent || 0);
}
function balanceOf(u){ return expected(u, curKey()) - paidTotal(u); }          /* + owing, − overpaid */
function pending(u){ return Math.max(0, balanceOf(u)); }
function statusOf(u){
  if (!u.tenant) return 'vacant';
  if (u.tenant.start > curKey()) return 'paid';
  const p = pending(u);
  if (p <= 0) return 'paid';
  const paidThisMonth = (u.tenant.payments || []).some(x => x.date.slice(0,7) === curKey());
  return paidThisMonth ? 'partial' : 'overdue';
}
const STATUS_LABEL = { paid: ['✔ Paid', 'paid'], partial: ['◑ Part-paid', 'partial'], overdue: ['✖ Behind', 'overdue'], vacant: ['Empty', 'vacant'] };
function monthsBehind(u){
  if (!u.tenant) return 0;
  return Math.max(1, Math.round(pending(u) / u.tenant.rent));
}
function tel(phone){ return 'tel:' + String(phone || '').replace(/[^+\d]/g, ''); }
function sms(phone, msg){ return 'sms:' + String(phone || '').replace(/[^+\d]/g, '') + '?body=' + encodeURIComponent(msg); }
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
}
function openModal(html){ $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#overlay').classList.add('open'); }
function closeModal(){ $('#overlay').classList.remove('open'); }
function modalOpen(){ return $('#overlay').classList.contains('open'); }

/* ================= NAV ================= */
const RENDERERS = () => ({ dashboard: renderDashboard, overdue: renderOverdue,
  statements: renderStatements, archive: renderArchive, mpesa: renderMpesa });
function go(v){
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
  $('#view-' + v).classList.add('active');
  RENDERERS()[v]();
  window.scrollTo({ top: 0 });
}
function currentView(){ return document.querySelector('.tabbar button.active').dataset.v; }
function renderCurrent(){
  const v = currentView();
  if (v === 'mpesa' && document.activeElement && document.activeElement.id === 'smsBox') return; /* don't wipe a pasted SMS */
  RENDERERS()[v]();
}

/* ================= HOME (properties + recent payments) ================= */
function renderDashboard(){
  const cur = curKey();
  const recent = [];
  allUnits().forEach(({p, u}) => {
    if (u.tenant){
      (u.tenant.payments || []).forEach(x => {
        recent.push({ ...x, name: u.tenant.name, unit: u.no, prop: p.name }); });
    }
  });
  recent.sort((a,b) => b.date.localeCompare(a.date));

  $('#view-dashboard').innerHTML = `
    <h3 class="sect">🏘️ Your properties</h3>
    <button class="addcard" onclick="openPropertyForm()">＋ Add a new property</button>
    ${state.properties.map(p => {
      const occ = p.units.filter(u => u.tenant).length;
      const coll = p.units.reduce((s,u) => s + (u.tenant ? (u.tenant.payments||[]).filter(x => x.date.slice(0,7) === cur).reduce((a,x) => a + +x.amount, 0) : 0), 0);
      const due = p.units.reduce((s,u) => s + (u.tenant && u.tenant.start <= cur ? +u.tenant.rent : 0), 0);
      return `<div class="card propcard">
        <div class="prophead">
          <h3>${esc(p.name)}</h3>
          <span class="pill ${occ === p.units.length ? 'paid' : 'partial'}">${occ}/${p.units.length} occupied</span>
          <button class="icbtn" title="Edit property" onclick="event.stopPropagation(); openPropertyEdit('${p.id}')">⚙️</button>
        </div>
        <div class="minibar"><div style="width:${due ? Math.min(100, Math.round(coll/due*100)) : 0}%"></div></div>
        <div class="t2" style="color:var(--muted); font-size:.85rem;">${monthName(cur)}: ${fmt(coll)} of ${fmt(due)} collected</div>
        <div class="units">
          ${p.units.map(u => u.tenant ? `
            <div class="unit ${statusOf(u)}" onclick="openUnit('${p.id}','${u.id}')">
              <div class="no">${esc(u.no)}</div>
              <div class="nm">${esc(u.tenant.name)}</div>
              <div class="ph">${esc(u.tenant.phone)}</div>
              <div style="margin-top:.35rem;">${pending(u) > 0
                ? `<span class="pill ${statusOf(u) === 'overdue' ? 'overdue' : 'partial'}">owes ${fmt(pending(u))}</span>`
                : (balanceOf(u) < 0 ? `<span class="pill paid">✔ credit ${fmt(-balanceOf(u))}</span>` : `<span class="pill paid">✔ clear</span>`)}</div>
            </div>` : `
            <div class="unit vacant" onclick="openTenantForm('${p.id}','${u.id}')">
              <div style="font-size:1.5rem;">＋</div>
              <div class="no" style="font-size:1rem;">${esc(u.no)}</div>
              <div style="font-size:.8rem;">Add tenant</div>
            </div>`).join('')}
        </div>
      </div>`;
    }).join('')}

    <h3 class="sect">💵 Recent payments</h3>
    ${recent.length ? recent.slice(0, 10).map(r => `
      <div class="rowitem">
        <div class="grow"><div class="t1">${esc(r.name)} <span class="t2">· ${esc(r.unit)}, ${esc(r.prop)}</span></div>
        <div class="t2">${dShort(r.date)} · ${esc(r.method)}${r.ref ? ' · ' + esc(r.ref) : ''}</div></div>
        <div class="amt green">${fmt(r.amount)}</div>
      </div>`).join('')
      : '<div class="empty">No payments recorded yet this month.</div>'}`;
}

/* ================= UNIT DETAIL ================= */
function openUnit(pid, uidv){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  const st = statusOf(u), lbl = STATUS_LABEL[st];
  const hist = [...(u.tenant?.payments || [])].sort((a,b) => b.date.localeCompare(a.date));
  const bal = u.tenant ? balanceOf(u) : 0;
  openModal(`
    <h3>🏠 ${esc(p.name)} · Unit ${esc(u.no)}</h3>
    ${u.tenant ? `
      <div class="rowitem" style="box-shadow:none; background:var(--bg);">
        <div class="grow">
          <div class="t1">${esc(u.tenant.name)} <span class="pill ${lbl[1]}">${lbl[0]}</span></div>
          <div class="t2">📞 <a href="${tel(u.tenant.phone)}">${esc(u.tenant.phone)}</a> · Since ${monthName(u.tenant.start)}</div>
          <div class="t2">Rent: <b>${fmt(u.tenant.rent)}</b>/month · Deposit held: <b>${fmt(u.tenant.deposit || 0)}</b></div>
        </div>
      </div>
      <div class="payline"><span>Total paid to date</span><b class="amt green">${fmt(paidTotal(u))}</b></div>
      <div class="payline"><span>Expected to date</span><b>${fmt(expected(u, curKey()))}</b></div>
      <div class="payline" style="border-bottom:2px solid var(--ink);"><span>${bal < 0 ? 'Overpaid (credit carried forward)' : 'Pending balance'}</span><b class="amt ${bal > 0 ? 'red' : 'green'}">${fmt(Math.abs(bal))}</b></div>

      <h3 class="sect">💵 Payment history</h3>
      ${hist.length ? hist.map(x => `
        <div class="payline"><span>${dShort(x.date)} · ${esc(x.method)}${x.ref ? ' · ' + esc(x.ref) : ''}</span><b class="amt green">${fmt(x.amount)}</b></div>`).join('')
        : '<div class="empty">No payments yet.</div>'}

      ${(u.log || []).length ? `<h3 class="sect">📝 Statements & notes</h3>` + u.log.map(l =>
        `<div class="payline"><span>${dShort(l.date)} — ${esc(l.text)}</span></div>`).join('') : ''}

      <div class="btnrow">
        <button class="btn" onclick="openPayment('${pid}','${uidv}')">💵 Record payment</button>
        <button class="btn soft" onclick="openStmtOptions('${pid}','${uidv}')">📄 Statement</button>
        <button class="btn soft" onclick="openTenantForm('${pid}','${uidv}')">✏️ Edit</button>
        <a class="btn soft" style="text-decoration:none; display:inline-flex; align-items:center;" href="${sms(u.tenant.phone, 'Hello ' + u.tenant.name + ', your pending rent at ' + p.name + ' ' + u.no + ' is ' + fmt(pending(u)) + '. Thank you!')}">💬 Message</a>
        <button class="btn warn" onclick="vacate('${pid}','${uidv}')">🚪 Tenant vacated</button>
      </div>` : `
      <div class="empty">This unit is empty.</div>
      <div class="btnrow"><button class="btn block" onclick="openTenantForm('${pid}','${uidv}')">＋ Add a new tenant (fresh record)</button></div>`}
    <div class="btnrow"><button class="btn soft block" onclick="closeModal()">Close</button></div>`);
}

/* ================= PAYMENT ================= */
function openPayment(pid, uidv, preset){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  openModal(`
    <h3>💵 Record payment — ${esc(u.no)}, ${esc(p.name)}</h3>
    <p style="margin:.2rem 0 0; color:var(--muted);">${esc(u.tenant?.name || '')} · pending: <b class="amt red">${fmt(pending(u))}</b></p>
    <label>Amount (Ksh)</label>
    <input type="number" id="payAmt" inputmode="numeric" placeholder="e.g. 12000" value="${preset || ''}">
    <label>Date received</label>
    <input type="date" id="payDate" value="${today()}">
    <label>Method</label>
    <select id="payMethod"><option>M-Pesa</option><option>Cash</option><option>Bank</option><option>Other</option></select>
    <label>Reference (e.g. M-Pesa code)</label>
    <input type="text" id="payRef" placeholder="Optional">
    <div class="btnrow">
      <button class="btn block" onclick="savePayment('${pid}','${uidv}')">✔ Save payment</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
  setTimeout(() => $('#payAmt')?.focus(), 100);
}
function savePayment(pid, uidv){
  const u = state.properties.find(x => x.id === pid).units.find(x => x.id === uidv);
  const amt = +$('#payAmt').value;
  if (!amt || amt <= 0) { toast('Please enter the amount'); return; }
  snapshot('Before payment of ' + fmt(amt) + ' for ' + u.tenant.name);
  u.tenant.payments.push(newPay($('#payDate').value || today(), amt, $('#payMethod').value, $('#payRef').value.trim()));
  (u.log = u.log || []).push({ date: today(), text: 'Payment of ' + fmt(amt) + ' recorded (' + $('#payMethod').value + ').' });
  save(); closeModal(); toast('✔ ' + fmt(amt) + ' saved for ' + u.tenant.name);
  go(currentView());
}

/* ================= MONTH-BY-MONTH LEDGER (balance carried forward / overpayments) ================= */
function effMonth(t, date){ const k = String(date).slice(0, 7); return k < t.start ? t.start : k; }
function ledger(t, upTo){
  const bucket = {};
  (t.payments || []).forEach(x => { const k = effMonth(t, x.date); bucket[k] = (bucket[k] || 0) + (+x.amount || 0); });
  const rows = []; let bal = 0;
  for (let k = t.start; k <= upTo; k = keyShift(k, 1)){
    const rent = +t.rent || 0, paid = bucket[k] || 0, open = bal;
    bal = open + rent - paid;
    rows.push({ k, open, rent, paid, close: bal });
  }
  return rows;
}
const balText = n => n > 0 ? fmt(n) + ' owing' : (n < 0 ? fmt(-n) + ' overpaid (credit)' : fmt(0) + ' — cleared');
const cfText  = n => n > 0 ? fmt(n) + ' owing, carried forward' : (n < 0 ? fmt(-n) + ' overpaid, credit carried forward' : 'cleared');
const CELL = 'padding:6px; border:1px solid #ccc;';
const TH   = 'text-align:left; padding:6px; border:1px solid #ccc; background:#f0ead9;';
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* ================= INDIVIDUAL STATEMENT ================= */
function unitStatementHtml(pid, uidv, monthKey){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  const t = u.tenant;
  const all = [...(t?.payments || [])].sort((a,b) => a.date.localeCompare(b.date));
  const hist = !t ? [] : (monthKey ? all.filter(x => effMonth(t, x.date) === monthKey) : all);
  const upTo = monthKey || curKey();
  const rows = t ? ledger(t, upTo) : [];
  const title = monthKey
    ? 'Tenant statement — ' + monthName(monthKey)
    : 'Entire statement — ' + monthName(t?.start || curKey()) + ' to ' + monthName(curKey());

  let body = '';
  if (monthKey){
    const last = rows.length && rows[rows.length - 1].k === monthKey ? rows[rows.length - 1] : { open: 0, rent: 0, paid: 0, close: 0 };
    const prior = rows.filter(r => r.k < monthKey && (r.close !== 0 || r.rent - r.paid !== 0));
    body = `
      ${prior.length ? `
      <h3 style="margin:1.1rem 0 .3rem;">Earlier months — balance carried forward</h3>
      <table style="width:100%; border-collapse:collapse; font-size:.95rem;">
        <tr><th style="${TH}">Month</th><th style="${TH} text-align:right;">Rent</th><th style="${TH} text-align:right;">Paid</th><th style="${TH} text-align:right;">Carried forward</th></tr>
        ${prior.map(r => `<tr>
          <td style="${CELL}">${monthName(r.k)}</td>
          <td style="${CELL} text-align:right;">${fmt(r.rent)}</td>
          <td style="${CELL} text-align:right;">${fmt(r.paid)}</td>
          <td style="${CELL} text-align:right; font-weight:bold;">${balText(r.close)}</td></tr>`).join('')}
      </table>` : ''}
      <table style="width:100%; border-collapse:collapse; font-size:.95rem; margin-top:.9rem;">
        <tr><td style="${CELL} font-weight:bold;">${last.open > 0 ? 'Balance' : (last.open < 0 ? 'Overpayment (credit)' : 'Balance')} brought forward</td><td style="${CELL} text-align:right; font-weight:bold;">${balText(last.open)}</td></tr>
        <tr><td style="${CELL} font-weight:bold;">Rent for ${monthName(monthKey)}</td><td style="${CELL} text-align:right; font-weight:bold;">${fmt(last.rent)}</td></tr>
        <tr><td style="${CELL} font-weight:bold;">Paid in ${monthName(monthKey)}</td><td style="${CELL} text-align:right; font-weight:bold;">${fmt(last.paid)}</td></tr>
        <tr style="background:#f0ead9;"><td style="${CELL} font-weight:bold;">${last.close < 0 ? 'OVERPAYMENT (CREDIT)' : 'BALANCE'} AT END OF ${monthName(monthKey).toUpperCase()}</td><td style="${CELL} text-align:right; font-weight:bold;">${balText(last.close)}</td></tr>
        ${last.close !== 0 ? `<tr><td colspan="2" style="${CELL} font-size:.85rem; color:#555;">${last.close > 0 ? 'This balance is carried forward to ' + monthName(keyShift(monthKey, 1)) + '.' : 'This overpayment is carried forward as credit towards ' + monthName(keyShift(monthKey, 1)) + '.'}</td></tr>` : ''}
      </table>`;
  } else {
    const fin = rows.length ? rows[rows.length - 1].close : 0;
    body = `
      <h3 style="margin:1.1rem 0 .3rem;">Month by month — balance carried forward</h3>
      <table style="width:100%; border-collapse:collapse; font-size:.95rem;">
        <tr><th style="${TH}">Month</th><th style="${TH} text-align:right;">Rent due</th><th style="${TH} text-align:right;">Paid</th><th style="${TH} text-align:right;">Carried forward to next month</th></tr>
        ${rows.map(r => `<tr>
          <td style="${CELL}">${monthName(r.k)}</td>
          <td style="${CELL} text-align:right;">${fmt(r.rent)}</td>
          <td style="${CELL} text-align:right;">${fmt(r.paid)}</td>
          <td style="${CELL} text-align:right;${r.close !== 0 ? ' font-weight:bold;' : ''}">${balText(r.close)}</td></tr>`).join('')}
      </table>
      <table style="width:100%; border-collapse:collapse; font-size:.95rem; margin-top:.9rem;">
        <tr><td style="${CELL} font-weight:bold;">Total paid to date</td><td style="${CELL} text-align:right; font-weight:bold;">${fmt(paidTotal(u))}</td></tr>
        <tr><td style="${CELL} font-weight:bold;">Expected to date</td><td style="${CELL} text-align:right; font-weight:bold;">${fmt(expected(u, curKey()))}</td></tr>
        <tr style="background:#f0ead9;"><td style="${CELL} font-weight:bold;">${fin < 0 ? 'OVERPAYMENT (CREDIT)' : 'PENDING BALANCE'}</td><td style="${CELL} text-align:right; font-weight:bold;">${balText(fin)}</td></tr>
      </table>`;
  }

  return `
  <div style="font-family:Georgia, 'Times New Roman', serif; max-width:700px; margin:0 auto; color:#1f1a14; padding:10px;">
    <h1 style="font-size:1.5rem; margin:0;">🏡 Margaret Manager</h1>
    <p style="color:#666; margin:.2rem 0 1rem;">${title}</p>
    <hr>
    <p style="font-size:1.05rem; line-height:1.7;">
      <b>Property:</b> ${esc(p.name)}<br>
      <b>Unit:</b> ${esc(u.no)}<br>
      <b>Tenant:</b> ${esc(t?.name || '— vacant —')}<br>
      <b>Phone:</b> ${esc(t?.phone || '—')}<br>
      <b>Lease since:</b> ${monthName(t?.start)} &nbsp;·&nbsp; <b>Monthly rent:</b> ${fmt(t?.rent || 0)} &nbsp;·&nbsp; <b>Deposit held:</b> ${fmt(t?.deposit || 0)}
    </p>
    <h3 style="margin:1.1rem 0 .3rem;">Payments${monthKey ? ' in ' + monthName(monthKey) : ''}</h3>
    <table style="width:100%; border-collapse:collapse; font-size:.95rem;">
      <tr><th style="${TH}">Date</th><th style="${TH}">Method</th><th style="${TH}">Reference</th><th style="${TH} text-align:right;">Amount</th></tr>
      ${hist.length ? hist.map(x => `<tr>
        <td style="${CELL}">${dShort(x.date)}</td>
        <td style="${CELL}">${esc(x.method)}</td>
        <td style="${CELL}">${esc(x.ref || '')}</td>
        <td style="${CELL} text-align:right;">${fmt(x.amount)}</td>
      </tr>`).join('')
      : `<tr><td colspan="4" style="${CELL} text-align:center;">No payments recorded for this period.</td></tr>`}
    </table>
    ${body}
    ${(u.log || []).length ? `<h3 style="margin:1.2rem 0 .4rem;">Statements &amp; notes</h3>` +
      u.log.map(l => `<p style="margin:.3rem 0; font-size:.92rem;">&bull; <b>${dShort(l.date)}</b> — ${esc(l.text)}</p>`).join('') : ''}
    <p style="color:#888; font-size:.8rem; margin-top:1.5rem;">Generated ${new Date().toLocaleString('en-KE')} · Margaret Manager</p>
  </div>`;
}
function unitStatementText(pid, uidv, monthKey){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  const t = u.tenant; if (!t) return '';
  const L = [];
  L.push('*Margaret Manager*');
  L.push(monthKey ? 'Statement — ' + monthName(monthKey) : 'Full statement to ' + monthName(curKey()));
  L.push(p.name + ' · Unit ' + u.no);
  L.push('Tenant: ' + t.name);
  L.push('Monthly rent: ' + fmt(t.rent));
  L.push('');
  const rows = ledger(t, monthKey || curKey());
  if (monthKey){
    const last = rows.length && rows[rows.length - 1].k === monthKey ? rows[rows.length - 1] : { open: 0, rent: 0, paid: 0, close: 0 };
    const prior = rows.filter(r => r.k < monthKey && (r.close !== 0 || r.rent - r.paid !== 0));
    if (prior.length){
      L.push('*Earlier months:*');
      prior.forEach(r => L.push('• ' + monthName(r.k) + ': paid ' + fmt(r.paid) + ' of ' + fmt(r.rent) + ' → ' + cfText(r.close)));
      L.push('');
    }
    L.push('Brought forward: ' + balText(last.open));
    L.push('Rent for ' + monthName(monthKey) + ': ' + fmt(last.rent));
    L.push('Paid in ' + monthName(monthKey) + ': ' + fmt(last.paid));
    L.push('*Balance at end of ' + monthName(monthKey) + ': ' + balText(last.close) + '*');
    const hist = [...t.payments].filter(x => effMonth(t, x.date) === monthKey).sort((a, b) => a.date.localeCompare(b.date));
    if (hist.length){ L.push(''); L.push('Payments:'); hist.forEach(x => L.push('• ' + dShort(x.date) + ' — ' + fmt(x.amount) + ' (' + x.method + (x.ref ? ' ' + x.ref : '') + ')')); }
  } else {
    L.push('*Month by month:*');
    rows.forEach(r => L.push('• ' + monthName(r.k) + ': rent ' + fmt(r.rent) + ', paid ' + fmt(r.paid) + ' → ' + cfText(r.close)));
    L.push('');
    L.push('Total paid: ' + fmt(paidTotal(u)));
    L.push('Expected to date: ' + fmt(expected(u, curKey())));
    L.push('*' + (balanceOf(u) < 0 ? 'Overpayment (credit): ' : 'Pending balance: ') + balText(balanceOf(u)) + '*');
  }
  return L.join('\n');
}

/* ================= TENANT LIST (no payments) ================= */
function tenantListHtml(pid){
  const p = state.properties.find(x => x.id === pid);
  const occ = p.units.filter(u => u.tenant);
  const rentTotal = occ.reduce((s, u) => s + (+u.tenant.rent || 0), 0);
  return `
  <div style="font-family:Georgia, 'Times New Roman', serif; max-width:760px; margin:0 auto; color:#1f1a14; padding:10px;">
    <h1 style="font-size:1.5rem; margin:0;">🏡 Margaret Manager</h1>
    <p style="color:#666; margin:.2rem 0 1rem;">Tenant list — ${esc(p.name)} · ${dShort(today())}</p>
    <hr>
    <table style="width:100%; border-collapse:collapse; font-size:.95rem; margin-top:.8rem;">
      <tr><th style="${TH}">Unit</th><th style="${TH}">Tenant</th><th style="${TH}">Phone</th><th style="${TH} text-align:right;">Monthly rent</th><th style="${TH} text-align:right;">Deposit</th><th style="${TH}">Lease since</th></tr>
      ${p.units.map(u => u.tenant ? `<tr>
        <td style="${CELL} font-weight:bold;">${esc(u.no)}</td>
        <td style="${CELL}">${esc(u.tenant.name)}</td>
        <td style="${CELL}">${esc(u.tenant.phone)}</td>
        <td style="${CELL} text-align:right;">${fmt(u.tenant.rent)}</td>
        <td style="${CELL} text-align:right;">${fmt(u.tenant.deposit || 0)}</td>
        <td style="${CELL}">${monthName(u.tenant.start)}</td></tr>`
        : `<tr><td style="${CELL} font-weight:bold;">${esc(u.no)}</td><td colspan="5" style="${CELL} color:#888;">— vacant —</td></tr>`).join('')}
      <tr style="background:#f0ead9;"><td colspan="3" style="${CELL} font-weight:bold;">${occ.length} occupied of ${p.units.length} units</td>
        <td style="${CELL} text-align:right; font-weight:bold;">${fmt(rentTotal)}</td><td colspan="2" style="${CELL}"></td></tr>
    </table>
    <p style="color:#888; font-size:.8rem; margin-top:1.5rem;">Generated ${new Date().toLocaleString('en-KE')} · Margaret Manager</p>
  </div>`;
}
function tenantListText(pid){
  const p = state.properties.find(x => x.id === pid);
  const L = ['*Margaret Manager*', 'Tenant list — ' + p.name, dShort(today()), ''];
  p.units.forEach(u => L.push(u.tenant ? '• ' + u.no + ' — ' + u.tenant.name + ', ' + u.tenant.phone + ' (rent ' + fmt(u.tenant.rent) + ')' : '• ' + u.no + ' — vacant'));
  L.push(''); L.push(p.units.filter(u => u.tenant).length + ' of ' + p.units.length + ' units occupied');
  return L.join('\n');
}

/* ================= SENDING A STATEMENT: device / Google Drive / WhatsApp ================= */
let outDoc = null;
const wrapDoc = (title, inner) => '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(title) + '</title></head><body>' + inner + '</body></html>';
function unitDoc(pid, uidv, monthKey){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  return {
    title: 'Statement — ' + u.no + (u.tenant ? ', ' + u.tenant.name : ''),
    name: 'statement-' + u.no.replace(/\W+/g, '') + '-' + (u.tenant ? slug(u.tenant.name) : 'vacant') + '-' + (monthKey || 'entire') + '.html',
    html: wrapDoc('Statement - ' + u.no + ' ' + p.name, unitStatementHtml(pid, uidv, monthKey)),
    text: unitStatementText(pid, uidv, monthKey),
    phone: u.tenant ? u.tenant.phone : ''
  };
}
function tenantListDoc(pid){
  const p = state.properties.find(x => x.id === pid);
  return {
    title: 'Tenant list — ' + p.name,
    name: 'tenants-' + slug(p.name) + '-' + today() + '.html',
    html: wrapDoc('Tenant list - ' + p.name, tenantListHtml(pid)),
    text: tenantListText(pid), phone: ''
  };
}
function openStmtOptions(pid, uidv){
  const u = state.properties.find(x => x.id === pid).units.find(x => x.id === uidv);
  const months = [];
  if (u.tenant){ let k = u.tenant.start; while (k <= curKey()){ months.push(k); k = keyShift(k, 1); } }
  openModal(`
    <h3>📄 Statement — ${esc(u.no)}${u.tenant ? ', ' + esc(u.tenant.name) : ''}</h3>
    <label>Which month?</label>
    <select id="stmtMonth">
      <option value="">Entire statement (all months)</option>
      ${months.slice().reverse().map(k => `<option value="${k}">${monthName(k)}</option>`).join('')}
    </select>
    <p class="muted" style="margin-bottom:0;">Shows payments, and any balance or overpayment carried forward from earlier months.</p>
    <label>How should it be delivered?</label>
    <div class="btnrow" style="margin-top:.3rem;">
      <button class="btn block" onclick="sendUnit('local','${pid}','${uidv}')">⬇️ Save on this device</button>
      <button class="btn soft block" onclick="sendUnit('drive','${pid}','${uidv}')">☁️ Save to Google Drive</button>
      <button class="btn wa block" onclick="sendUnit('wa','${pid}','${uidv}')">💬 Send on WhatsApp</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
}
function sendUnit(how, pid, uidv){
  outDoc = unitDoc(pid, uidv, $('#stmtMonth').value || null);
  dispatchSend(how);
}
function openTenantListOptions(pid){
  outDoc = tenantListDoc(pid);
  openModal(`
    <h3>📋 ${esc(outDoc.title)}</h3>
    <p class="muted" style="margin-top:0;">Names, phone numbers, rent and deposits only — no payments.</p>
    <div class="btnrow">
      <button class="btn block" onclick="dispatchSend('local')">⬇️ Save on this device</button>
      <button class="btn soft block" onclick="dispatchSend('drive')">☁️ Save to Google Drive</button>
      <button class="btn wa block" onclick="dispatchSend('wa')">💬 Send on WhatsApp</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
}
function dispatchSend(how){
  if (!outDoc) return;
  if (how === 'local'){ downloadFile(outDoc.name, outDoc.html, 'text/html'); closeModal(); toast('⬇️ Saved on this device'); }
  else if (how === 'drive'){ closeModal(); uploadDocToDrive(); }
  else openWaPrompt();
}
function downloadFile(name, content, mime){
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function uploadDocToDrive(){
  if (!clientId()){ openDrive(); toast('Set up Google Drive first'); return; }
  try {
    toast('☁️ Saving to Google Drive…');
    const tok = await driveAuth(true);
    await driveSave(tok, outDoc.name, outDoc.html, 'text/html');
    toast('☁️ Saved to Google Drive: ' + outDoc.name);
  } catch(e){ toast('⚠️ ' + niceErr(e)); }
}
/* WhatsApp: ask which number should receive it */
function waNumber(raw){
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^\d{11,15}$/.test(d) ? d : null;
}
function openWaPrompt(){
  openModal(`
    <h3>💬 Send on WhatsApp</h3>
    <p class="muted" style="margin-top:0;">${esc(outDoc.title)}</p>
    <label>WhatsApp number to receive it</label>
    <input type="tel" id="waNum" inputmode="tel" value="${esc(outDoc.phone || '')}" placeholder="e.g. 0712 345 678 or +254 712 345 678">
    <div class="btnrow">
      <button class="btn wa block" onclick="sendWaMessage()">💬 Open the chat with the statement typed in</button>
      <button class="btn soft block" onclick="shareDoc()">📎 Send the file itself (pick the chat in WhatsApp)</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>
    <p class="muted" style="font-size:.85rem;">WhatsApp opens this number's chat with the statement ready — just press Send. To attach the file instead, use the second button: WhatsApp then asks you to choose the chat (websites cannot pre-select a chat for a file).</p>`);
  setTimeout(() => $('#waNum')?.focus(), 100);
}
function sendWaMessage(){
  const num = waNumber($('#waNum').value);
  if (!num){ toast('Enter a valid WhatsApp number, e.g. 0712 345 678'); return; }
  let text = outDoc.text;
  if (text.length > 1800) text = text.slice(0, 1750).replace(/\n[^\n]*$/, '') + '\n…(full statement is in the saved file)';
  window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(text), '_blank');
  closeModal();
}
async function shareDoc(){
  try {
    const file = new File([outDoc.html], outDoc.name, { type: 'text/html' });
    if (navigator.canShare && navigator.canShare({ files: [file] })){
      await navigator.share({ files: [file], title: outDoc.title });
      closeModal();
    } else toast('File sharing is not available here — use "Save on this device" and attach it in WhatsApp');
  } catch(e){
    if (e && e.name !== 'AbortError') toast('Could not share the file');
  }
}

/* ================= GOOGLE DRIVE: sync + backup ================= */
let driveTok = null, driveTokExp = 0;
(function restoreToken(){
  try { const t = JSON.parse(sessionStorage.getItem(TKEY) || 'null'); if (t && Date.now() < t.exp){ driveTok = t.tok; driveTokExp = t.exp; } } catch(e){}
})();
function niceErr(e){
  const m = e && e.message ? e.message : String(e || '');
  if (m === 'NOCLIENT') return 'Add your Google Client ID first (☁️ at the top).';
  if (m === 'NEEDAUTH') return 'Tap the sync button to reconnect to Google.';
  return m || 'Could not reach Google Drive';
}
function driveAuth(interactive){
  return new Promise((resolve, reject) => {
    if (driveTok && Date.now() < driveTokExp) return resolve(driveTok);
    const cid = clientId();
    if (!cid) return reject(new Error('NOCLIENT'));
    if (!(window.google && google.accounts && google.accounts.oauth2)) return reject(new Error('Google sign-in did not load. Check the internet connection.'));
    if (!interactive && !cfg().driveLinked) return reject(new Error('NEEDAUTH'));
    let done = false, to = null;
    const fin = (fn, v) => { if (!done){ done = true; clearTimeout(to); fn(v); } };
    to = setTimeout(() => fin(reject, new Error('NEEDAUTH')), interactive ? 120000 : 12000);
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cid,
      scope: 'https://www.googleapis.com/auth/drive.file',
      prompt: interactive ? '' : 'none',
      callback: r => {
        if (r && r.access_token){
          driveTok = r.access_token; driveTokExp = Date.now() + ((+r.expires_in || 3600) * 1000) - 60000;
          try { sessionStorage.setItem(TKEY, JSON.stringify({ tok: driveTok, exp: driveTokExp })); } catch(e){}
          setCfg({ driveLinked: true });
          fin(resolve, driveTok);
        } else fin(reject, new Error(interactive ? 'Google sign-in failed or was cancelled.' : 'NEEDAUTH'));
      },
      error_callback: () => fin(reject, new Error(interactive ? 'Google sign-in was cancelled or blocked.' : 'NEEDAUTH'))
    });
    tc.requestAccessToken();
  });
}
async function dFetch(tok, url, opts){
  opts = opts || {};
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + tok, ...(opts.headers || {}) } });
  if (r.status === 401){ driveTok = null; try { sessionStorage.removeItem(TKEY); } catch(e){} throw new Error('NEEDAUTH'); }
  return r;
}
async function driveFindFile(tok, name){
  const q = encodeURIComponent("name='" + name + "' and trashed=false");
  const r = await dFetch(tok, 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=5');
  if (!r.ok) throw new Error('Google Drive search failed (' + r.status + ').');
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}
async function driveFolder(tok){
  const saved = cfg().driveFolderId;
  if (saved) return saved;
  const q = encodeURIComponent("name='Margaret Manager' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  let r = await dFetch(tok, 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id)&pageSize=1');
  if (!r.ok) throw new Error('Google Drive search failed (' + r.status + ').');
  const j = await r.json();
  if (j.files && j.files[0]){ setCfg({ driveFolderId: j.files[0].id }); return j.files[0].id; }
  r = await dFetch(tok, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Margaret Manager', mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!r.ok) throw new Error('Could not create the Drive folder (' + r.status + ').');
  const f = await r.json();
  setCfg({ driveFolderId: f.id });
  return f.id;
}
function multipart(name, parent, content, mime){
  const b = 'mmboundary' + Date.now();
  const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify({ name, parents: [parent] })
    + '\r\n--' + b + '\r\nContent-Type: ' + mime + '; charset=UTF-8\r\n\r\n' + content
    + '\r\n--' + b + '--';
  return { body, type: 'multipart/related; boundary=' + b };
}
/* create the file, or replace its content if it already exists */
async function driveSave(tok, name, content, mime, knownId){
  const f = knownId ? { id: knownId } : await driveFindFile(tok, name);
  if (f){
    const r = await dFetch(tok, 'https://www.googleapis.com/upload/drive/v3/files/' + f.id + '?uploadType=media', {
      method: 'PATCH', headers: { 'Content-Type': mime + '; charset=UTF-8' }, body: content });
    if (!r.ok) throw new Error('Google Drive did not accept ' + name + ' (' + r.status + ').');
    return f.id;
  }
  let folder = await driveFolder(tok);
  let mp = multipart(name, folder, content, mime);
  let r = await dFetch(tok, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
  if (r.status === 404){
    setCfg({ driveFolderId: '' });
    folder = await driveFolder(tok);
    mp = multipart(name, folder, content, mime);
    r = await dFetch(tok, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
  }
  if (!r.ok) throw new Error('Google Drive did not accept ' + name + ' (' + r.status + ').');
  return (await r.json()).id;
}

/* ---- Full backup file: the app code AND all data in one file (opens on any device) ---- */
async function getSources(){
  const b = window.__MM_BUNDLE;
  if (b && b.index && b.css && b.js) return { index: b.index, css: b.css, js: b.js };
  const get = async u => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(u); return r.text(); };
  let index;
  try { index = await get('index.html'); } catch(e){ index = await get(location.href.split('#')[0]); }
  return { index, css: await get('styles.css'), js: await get('script.js') };
}
function mmLoader(){
  var b = JSON.parse(document.getElementById('mmBundle').textContent);
  var end = '<' + '/script>';
  var h = b.index.replace(/<link[^>]*styles\.css[^>]*>/, function(){ return '<style>' + b.css + '</style>'; })
    .replace(/<script src="script\.js"><\/script>/, function(){
      return '<script>window.__MM_BUNDLE=' + JSON.stringify(b).replace(/</g, '\\u003c') + ';' + end + '<script>' + b.js.replace(/<\/script/gi, '<\\/script') + end;
    });
  document.open(); document.write(h); document.close();
}
async function buildFullBackup(){
  const src = await getSources();
  const bundle = { savedAt: new Date().toISOString(), clientId: clientId(), data: state, index: src.index, css: src.css, js: src.js };
  const json = JSON.stringify(bundle).replace(/</g, '\\u003c');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Margaret Manager — full backup</title></head><body>'
    + '<p style="font-family:sans-serif;padding:1rem">Opening Margaret Manager…</p>'
    + '<script type="application/json" id="mmBundle">' + json + '<\/script>'
    + '<script>(' + mmLoader.toString() + ')();<\/script></body></html>';
}
async function exportData(){
  try {
    const html = await buildFullBackup();
    downloadFile('margaret-manager-FULL-backup-' + today() + '.html', html, 'text/html');
    toast('💾 Full backup saved (app + all data). Keep it somewhere safe.');
  } catch(e){
    downloadFile('margaret-backup-' + today() + '.json', JSON.stringify(state, null, 2), 'application/json');
    toast('💾 Data backup saved. For a backup that also contains the app, open the app from its web address (https://).');
  }
}
async function backupToDrive(tok, withApp){
  const day = today();
  const json = JSON.stringify(state, null, 2);
  await driveSave(tok, 'margaret-backup-' + day + '.json', json, 'application/json');
  if (withApp){
    try { await driveSave(tok, 'margaret-manager-app-' + day + '.html', await buildFullBackup(), 'text/html'); return true; }
    catch(e){ return false; }
  }
  return true;
}
async function driveBackupNow(){
  if (!clientId()){ toast('Save your Google Client ID first'); return; }
  try {
    toast('☁️ Backing up to Google Drive…');
    const tok = await driveAuth(true);
    await driveSave(tok, DATA_FILE, JSON.stringify(state), 'application/json');
    const appOk = await backupToDrive(tok, true);
    setCfg({ lastBackupDay: today() });
    toast(appOk ? '☁️ Backed up: all data + app saved in Google Drive' : '☁️ Data backed up. (App copy needs the app opened from https://)');
  } catch(e){ toast('⚠️ ' + niceErr(e)); }
}

/* ---- Sync engine ---- */
let syncing = false, syncQueued = false, syncT = null, syncState = { s: clientId() ? 'auth' : 'off' };
function scheduleSync(){ if (!clientId()) return; clearTimeout(syncT); syncT = setTimeout(() => syncNow(false), 2500); }
function syncLabel(){
  const s = syncState.s;
  if (s === 'busy') return 'Syncing…';
  if (s === 'ok') return 'Synced ' + new Date(cfg().lastSync || Date.now()).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  if (s === 'auth') return 'Tap to sync';
  if (s === 'err') return 'Sync problem — tap to retry';
  return 'Set up sync';
}
function setSync(s, msg){
  syncState = { s, msg };
  const c = $('#syncChip'); if (c){ c.dataset.s = s; $('#syncTxt').textContent = syncLabel(); }
  const st = $('#driveStatus'); if (st) st.textContent = syncLabel() + (s === 'err' && msg ? ' — ' + msg : '');
}
function chipTap(){ if (clientId()) syncNow(true); else openDrive(); }
async function syncNow(interactive){
  if (!clientId()){ if (interactive) openDrive(); return; }
  if (syncing){ syncQueued = true; return; }
  syncing = true; setSync('busy');
  try {
    const tok = await driveAuth(interactive);
    const f = await driveFindFile(tok, DATA_FILE);
    let push = true;
    if (f){
      const r = await dFetch(tok, 'https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media');
      if (!r.ok) throw new Error('Could not read the data from Google Drive (' + r.status + ').');
      let remote;
      try { remote = normalize(JSON.parse(await r.text())); } catch(e){ throw new Error('The data file in Google Drive could not be read. Nothing was changed.'); }
      const before = JSON.stringify(state);
      state = normalize(mergeStates(state, remote));
      if (JSON.stringify(state) !== before){ persistLocal(); if (!modalOpen()) renderCurrent(); }
      push = JSON.stringify(state) !== JSON.stringify(remote);
    }
    if (push){
      await driveSave(tok, DATA_FILE, JSON.stringify(state), 'application/json', f && f.id);
      await backupToDrive(tok, false);                       /* dated copy: history is never overwritten by later days */
    }
    if (cfg().lastBackupDay !== today()){ await backupToDrive(tok, true); setCfg({ lastBackupDay: today() }); }
    setCfg({ lastSync: Date.now() });
    setSync('ok');
  } catch(e){
    const m = e && e.message;
    if (m === 'NEEDAUTH' || m === 'NOCLIENT') setSync(m === 'NOCLIENT' ? 'off' : 'auth');
    else setSync('err', niceErr(e));
    if (interactive) toast('⚠️ ' + niceErr(e));
  } finally {
    syncing = false;
    if (syncQueued){ syncQueued = false; scheduleSync(); }
  }
}
function openDrive(){
  openModal(`
    <h3>☁️ Sync &amp; backup (Google Drive)</h3>
    <p class="muted" style="margin-top:0;">Your records are kept in your own Google Drive, in a <b>Margaret Manager</b> folder. Open the app on any phone, tablet or computer, allow Drive once, and a payment recorded on one device appears on the others. There is no app password.</p>
    <div class="statusbox" id="driveStatus">${esc(syncLabel())}</div>
    <label>Google Client ID</label>
    <input type="text" id="drClient" value="${esc(clientId())}" placeholder="xxxxxxxx.apps.googleusercontent.com">
    <div class="btnrow">
      <button class="btn block" onclick="saveDriveSettings()">✔ Save &amp; connect</button>
      <button class="btn soft block" onclick="syncNow(true)">🔄 Sync now</button>
      <button class="btn soft block" onclick="driveBackupNow()">☁️ Back up everything to Drive now (data + app)</button>
      <button class="btn soft block" onclick="exportData()">💾 Save a full backup file on this device</button>
      <button class="btn soft block" onclick="closeModal()">Close</button>
    </div>
    <p class="muted" style="font-size:.85rem;">Each day a dated copy of all data is kept in Drive, and older days are never overwritten. If a device is lost: open the app on a new device, enter the same Client ID, tap <b>Save &amp; connect</b> — everything comes back. Works only when the app is opened from a web address (https://).</p>`);
}
function saveDriveSettings(){
  const id = $('#drClient').value.trim();
  if (clientId() !== id){ setCfg({ driveFolderId: '', driveLinked: false }); driveTok = null; try { sessionStorage.removeItem(TKEY); } catch(e){} }
  setCfg({ driveClientId: id });
  setSync(id ? 'auth' : 'off');
  if (id) syncNow(true); else toast('Google Drive details cleared');
}

/* ================= TENANT ADD / EDIT ================= */
function openTenantForm(pid, uidv){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  const t = u.tenant;
  openModal(`
    <h3>${t ? '✏️ Edit tenant' : '＋ New tenant'} — ${esc(p.name)} · ${esc(u.no)}</h3>
    ${t ? '<p style="color:var(--muted); margin:.2rem 0 0;">Editing keeps the payment history.</p>' : '<p style="color:var(--muted); margin:.2rem 0 0;">Starts a fresh record for this unit.</p>'}
    <label>Full name</label>
    <input type="text" id="tName" value="${esc(t?.name || '')}" placeholder="e.g. John Mwangi">
    <label>Phone number (M-Pesa)</label>
    <input type="tel" id="tPhone" value="${esc(t?.phone || '')}" placeholder="e.g. 0712 345 678">
    <label>Monthly rent (Ksh)</label>
    <input type="number" id="tRent" inputmode="numeric" value="${t?.rent || p.defaultRent || ''}" placeholder="e.g. 12000">
    <label>Rent starts from (month)</label>
    <input type="month" id="tStart" value="${t?.start || curKey()}">
    <label>Deposit paid (Ksh)</label>
    <input type="number" id="tDeposit" inputmode="numeric" value="${t?.deposit ?? p.defaultDeposit ?? p.defaultRent ?? ''}" placeholder="e.g. 12000">
    <div class="btnrow">
      <button class="btn block" onclick="saveTenant('${pid}','${uidv}')">✔ Save</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
}
function saveTenant(pid, uidv){
  const u = state.properties.find(x => x.id === pid).units.find(x => x.id === uidv);
  const name = $('#tName').value.trim(), phone = $('#tPhone').value.trim(),
        rent = +$('#tRent').value, start = $('#tStart').value || curKey(),
        deposit = +$('#tDeposit').value || 0;
  if (!name || !phone || !rent) { toast('Please fill name, phone and rent'); return; }
  snapshot((u.tenant ? 'Before editing tenant ' + u.tenant.name : 'Before adding tenant ' + name) + ' (unit ' + u.no + ')');
  if (u.tenant){
    Object.assign(u.tenant, { name, phone, rent, start, deposit, updatedAt: Date.now() });
    (u.log = u.log || []).push({ date: today(), text: 'Tenant details updated.' });
  } else {
    u.tenant = { id: 't' + uid(), name, phone, rent, start, deposit, payments: [], log: [], createdAt: Date.now(), updatedAt: Date.now() };
    u.log = [{ date: today(), text: 'New tenant ' + name + ' moved in. Deposit ' + fmt(deposit) + ' paid. Fresh record started.' }];
  }
  save(); closeModal(); toast('✔ Saved — ' + name); go('dashboard');
}
function vacate(pid, uidv){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  const dep = u.tenant.deposit || 0;
  openModal(`
    <h3>🚪 ${esc(u.tenant.name)} — moving out</h3>
    <p style="color:var(--muted); margin-top:0;">Their payment history and all statements move to the <b>Former</b> tab automatically.</p>
    <div class="payline"><span>Deposit held</span><b>${fmt(dep)}</b></div>
    <label>Deposit returned to tenant (Ksh)</label>
    <input type="number" id="vacDep" inputmode="numeric" value="${dep}">
    <div class="btnrow">
      <button class="btn block" onclick="confirmVacate('${pid}','${uidv}')">✔ Confirm move-out</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
}
function confirmVacate(pid, uidv){
  const p = state.properties.find(x => x.id === pid);
  const u = p.units.find(x => x.id === uidv);
  const depBack = +$('#vacDep').value || 0;
  snapshot('Before moving out ' + u.tenant.name + ' (unit ' + u.no + ')');
  state.archive.unshift(archiveEntry(u.tenant, u, p, depBack));
  u.tenant = null; u.log = [];
  save(); closeModal(); toast('🗂️ Moved to Former with full history'); go(currentView());
}

/* ================= PROPERTY FORM ================= */
function openPropertyForm(){
  openModal(`
    <h3>＋ Add a new property</h3>
    <label>Property name</label>
    <input type="text" id="prName" placeholder="e.g. Palm Villas">
    <label>Number of units</label>
    <input type="number" id="prCount" inputmode="numeric" placeholder="e.g. 10">
    <label>Monthly rent for ALL units (Ksh) — same for every tenant here</label>
    <input type="number" id="prRent" inputmode="numeric" placeholder="e.g. 12000">
    <label>Deposit for ALL units (Ksh) — leave empty to use the rent amount</label>
    <input type="number" id="prDeposit" inputmode="numeric" placeholder="e.g. 12000">
    <label>Unit label style</label>
    <select id="prStyle" onchange="$('#prCustomWrap').hidden = this.value !== 'C'"><option value="H">H1, H2, H3…</option><option value="A">A, B, C…</option><option value="N">1, 2, 3…</option><option value="C">My own names (I will type them)</option></select>
    <div id="prCustomWrap" hidden>
      <label>House names — one per line (or separated by commas)</label>
      <textarea id="prNames" rows="5" placeholder="e.g.&#10;Mango House&#10;Block A - Door 1&#10;Garden Cottage"></textarea>
      <p style="color:var(--muted); font-size:.85rem; margin:.3rem 0 0;">The number of houses is taken from your list, so the "Number of units" above is ignored.</p>
    </div>
    <div class="btnrow">
      <button class="btn block" onclick="saveProperty()">✔ Add property</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
}
function parseHouseNames(txt){ return String(txt || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean); }
function hasDuplicateNames(list){ return new Set(list.map(s => s.toLowerCase())).size !== list.length; }
function saveProperty(){
  const name = $('#prName').value.trim(), count = Math.min(60, Math.max(1, +$('#prCount').value || 0)), style = $('#prStyle').value,
        rent = +$('#prRent').value || 0;
  const dep = $('#prDeposit').value === '' ? rent : (+$('#prDeposit').value || 0);
  if (!name || !count || !rent) { toast('Enter the name, number of units and rent'); return; }
  if (state.properties.some(x => x.name.toLowerCase() === name.toLowerCase())) { toast('A property with that name already exists'); return; }
  let custom = null;
  if (style === 'C'){
    custom = parseHouseNames($('#prNames').value).slice(0, 60);
    if (!custom.length) { toast('Type at least one house name'); return; }
    if (hasDuplicateNames(custom)) { toast('Each house needs a different name'); return; }
  }
  snapshot('Before adding property ' + name);
  const units = (custom ? custom : Array.from({length: count}, (_, i) =>
    style === 'A' ? String.fromCharCode(65 + i) : (style === 'N' ? String(i + 1) : 'H' + (i + 1)))).map(no => ({
    id: uid(), no, tenant: null, log: []
  }));
  state.properties.push({ id: uid(), name, units, defaultRent: rent, defaultDeposit: dep, updatedAt: Date.now() });
  save(); closeModal(); toast('🏘️ ' + name + ' added'); go('dashboard');
}

function openPropertyEdit(pid){
  const p = state.properties.find(x => x.id === pid);
  if (!p) return;
  openModal(`
    <h3>⚙️ Edit property</h3>
    <label>Property name</label>
    <input type="text" id="peName" value="${esc(p.name)}">
    <label>Standard monthly rent for this property (Ksh)</label>
    <input type="number" id="peRent" inputmode="numeric" value="${p.defaultRent ?? ''}" placeholder="e.g. 12000">
    <label>Standard deposit for this property (Ksh)</label>
    <input type="number" id="peDeposit" inputmode="numeric" value="${p.defaultDeposit ?? p.defaultRent ?? ''}" placeholder="e.g. 12000">
    <label>House names — one per line, in the same order as shown</label>
    <textarea id="peNames" rows="${Math.min(10, Math.max(4, p.units.length))}">${esc(p.units.map(u => u.no).join('\n'))}</textarea>
    <p style="color:var(--muted); font-size:.85rem; margin:.3rem 0 0;">Rename any house by editing its line. Keep the same number of lines (${p.units.length}). Tenants and payment history stay with their house.</p>
    <label style="display:flex; gap:.6rem; align-items:flex-start; font-weight:500;">
      <input type="checkbox" id="peApply" style="width:22px; height:22px; padding:0; flex:none; margin-top:.15rem;">
      <span>Also apply this rent and deposit to ALL current tenants here. This recalculates their balances, including past months.</span>
    </label>
    <p style="color:var(--muted); font-size:.85rem; margin:.4rem 0 0;">Leave the box unticked to use these amounts only for new tenants. A single tenant's rent or deposit can always be changed with ✏️ Edit on their unit.</p>
    <div class="btnrow">
      <button class="btn block" onclick="savePropertyEdit('${pid}')">✔ Save</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>
    <h3 class="sect">Delete this property</h3>
    <p style="color:var(--muted); margin-top:0;">Any tenants inside move to the Former tab with their history. To confirm, type the property name below.</p>
    <input type="text" id="peDelName" placeholder="Type the property name">
    <div class="btnrow"><button class="btn warn block" onclick="deleteProperty('${pid}')">Delete property</button></div>`);
}
function savePropertyEdit(pid){
  const p = state.properties.find(x => x.id === pid);
  if (!p) return;
  const name = $('#peName').value.trim();
  const rent = +$('#peRent').value || 0;
  const dep = $('#peDeposit').value === '' ? rent : (+$('#peDeposit').value || 0);
  if (!name) { toast('Please enter the property name'); return; }
  if (state.properties.some(x => x.id !== pid && x.name.toLowerCase() === name.toLowerCase())) { toast('Another property already has that name'); return; }
  const newNos = parseHouseNames($('#peNames').value);
  if (newNos.length !== p.units.length) { toast('House names: please keep exactly ' + p.units.length + ' lines'); return; }
  if (hasDuplicateNames(newNos)) { toast('Each house needs a different name'); return; }
  snapshot('Before editing property ' + p.name);
  const oldName = p.name;
  const renamed = new Map();
  p.units.forEach((u, i) => { if (u.no !== newNos[i]){ renamed.set(u.no, newNos[i]); u.no = newNos[i]; } });
  if (renamed.size){
    state.archive.forEach(a => {
      if ((a.propertyId === p.id || (!a.propertyId && a.propertyName === oldName)) && renamed.has(a.unitNo)) a.unitNo = renamed.get(a.unitNo);
    });
  }
  p.name = name; p.updatedAt = Date.now();
  if (rent) p.defaultRent = rent;
  p.defaultDeposit = dep;
  state.archive.forEach(a => {
    if (a.propertyId === p.id || (!a.propertyId && a.propertyName === oldName)){ a.propertyName = name; a.propertyId = p.id; }
  });
  if ($('#peApply').checked && (rent || dep)){
    p.units.forEach(u => {
      if (u.tenant){
        if (rent) u.tenant.rent = rent;
        if (dep) u.tenant.deposit = dep;
        u.tenant.updatedAt = Date.now();
        (u.log = u.log || []).push({ date: today(), text: 'Rent set to ' + fmt(u.tenant.rent) + ' and deposit to ' + fmt(u.tenant.deposit) + ' (property settings).' });
      }
    });
  }
  save(); closeModal(); toast('✔ Property saved'); go('dashboard');
}
function deleteProperty(pid){
  const p = state.properties.find(x => x.id === pid);
  if (!p) return;
  const typed = ($('#peDelName')?.value || '').trim();
  if (typed.toLowerCase() !== p.name.toLowerCase()) { toast('Type the property name exactly to confirm'); return; }
  snapshot('Before deleting property ' + p.name);
  p.units.forEach(u => { if (u.tenant) state.archive.unshift(archiveEntry(u.tenant, u, p, 0)); });
  state.properties = state.properties.filter(x => x.id !== pid);
  state.deleted.properties.push(pid);
  if (stmtProp === pid) stmtProp = null;
  save(); closeModal(); toast(p.name + ' deleted — its tenants are in Former'); go('dashboard');
}

/* ================= OVERDUE ================= */
function renderOverdue(){
  const list = allUnits().filter(x => pending(x.u) > 0 && x.u.tenant && x.u.tenant.start <= curKey())
    .sort((a,b) => pending(b.u) - pending(a.u));
  $('#view-overdue').innerHTML = `
    <h2 class="viewtitle">🔔 People with overdue payments (${list.length})</h2>
    ${list.length ? list.map(({p,u}) => `
      <div class="rowitem">
        <div class="grow" onclick="openUnit('${p.id}','${u.id}')" style="cursor:pointer;">
          <div class="t1">${esc(u.tenant.name)}</div>
          <div class="t2">🏠 ${esc(u.no)}, ${esc(p.name)} · ${monthsBehind(u)} month(s) behind</div>
          <div class="t2">📞 ${esc(u.tenant.phone)}</div>
        </div>
        <div style="text-align:right;">
          <div class="amt red">${fmt(pending(u))}</div>
          <span class="pill ${statusOf(u) === 'overdue' ? 'overdue' : 'partial'}">${STATUS_LABEL[statusOf(u)][0]}</span>
        </div>
        <a class="icbtn" href="${tel(u.tenant.phone)}" title="Call">📞</a>
        <a class="icbtn sms" href="${sms(u.tenant.phone, 'Hello ' + u.tenant.name + ', your rent for ' + monthName(curKey()) + ' at ' + p.name + ' ' + u.no + ' is pending: ' + fmt(pending(u)) + '. Please pay via M-Pesa. Thank you!')}" title="Send reminder">💬</a>
      </div>`).join('')
    : '<div class="empty">🎉 Nobody owes anything. All clear!</div>'}`;
}

/* ================= STATEMENTS ================= */
let stmtProp = null;
function renderStatements(){
  if ((!stmtProp || !state.properties.some(x => x.id === stmtProp)) && state.properties.length) stmtProp = state.properties[0].id;
  const p = state.properties.find(x => x.id === stmtProp) || state.properties[0];
  const cur = curKey();
  const notes = p ? p.units.flatMap(u => (u.log || []).map(l => ({ date: l.date, text: l.text, unit: u.no, tname: u.tenant?.name || '' })))
                        .sort((a,b) => b.date.localeCompare(a.date)) : [];
  $('#view-statements').innerHTML = `
    <div class="no-print">
      <h2 class="viewtitle">📄 Statements — ${monthName(cur)}</h2>
      <label>Choose property</label>
      <select onchange="stmtProp = this.value; renderStatements()">
        ${state.properties.map(x => `<option value="${x.id}" ${x === p ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>
    </div>
    ${p ? `<div class="card" style="margin-top:1rem;">
      <div class="prophead"><h3>${esc(p.name)} — Statement for ${monthName(cur)}</h3>
      </div>
      <div class="btnrow no-print" style="margin-top:0; margin-bottom:.4rem;">
        <button class="btn soft" onclick="openTenantListOptions('${p.id}')">📋 Download tenant list (no payments)</button>
      </div>
      <div class="tablewrap"><table>
        <tr><th>Unit</th><th>Tenant</th><th>Phone</th><th>Rent</th><th>Pending</th><th>Status</th></tr>
        ${p.units.map(u => {
          const st = statusOf(u);
          return `<tr>
            <td><b>${esc(u.no)}</b></td>
            <td>${esc(u.tenant?.name || '— vacant —')}</td>
            <td>${esc(u.tenant?.phone || '')}</td>
            <td>${u.tenant ? fmt(u.tenant.rent) : '—'}</td>
            <td>${u.tenant ? (pending(u) > 0 ? '<b style="color:var(--red)">' + fmt(pending(u)) + '</b>' : '✔ ' + fmt(0)) : '—'}</td>
            <td>${STATUS_LABEL[st][0]}</td>
          </tr>`;
        }).join('')}
        <tr class="total">
          <td colspan="3">TOTAL — ${p.units.filter(u => u.tenant).length} occupied units</td>
          <td>${fmt(p.units.reduce((s,u) => s + (u.tenant?.rent || 0), 0))}</td>
          <td>${fmt(p.units.reduce((s,u) => s + pending(u), 0))}</td>
          <td></td>
        </tr>
      </table></div>

      <h3 class="sect">📝 Statements &amp; notes — ${esc(p.name)}</h3>
      ${notes.length ? notes.map(n => `
        <div class="payline"><span><b>Unit ${esc(n.unit)}${n.tname ? ' · ' + esc(n.tname) : ''}</b> — ${esc(n.text)}<br>
        <span class="d">${new Date(n.date).toLocaleDateString('en-KE',{weekday:'short', day:'numeric', month:'short', year:'numeric'})}</span></span></div>`).join('')
        : '<div class="empty">No statements for this property yet. Statements appear here automatically whenever a payment is recorded or a tenant moves in or out.</div>'}

      <p style="color:var(--muted); font-size:.85rem; margin-bottom:0;">Generated ${new Date().toLocaleString('en-KE')} · Margaret Manager</p>
    </div>` : '<div class="empty">Add a property first.</div>'}`;
}

/* ================= ARCHIVE ================= */
function renderArchive(){
  $('#view-archive').innerHTML = `
    <h2 class="viewtitle">🗂️ Former tenants (history kept)</h2>
    ${state.archive.length ? state.archive.map(a => `
      <div class="rowitem">
        <div class="grow" style="cursor:pointer;" onclick="openArchive('${a.id}')">
          <div class="t1">${esc(a.name)}</div>
          <div class="t2">🏠 ${esc(a.unitNo)}, ${esc(a.propertyName)} · moved out ${dShort(a.vacatedOn)}</div>
          <div class="t2">${a.payments.length} payment(s) · total paid ${fmt(a.payments.reduce((s,x) => s + +x.amount, 0))} · deposit ${fmt(a.deposit||0)}${'depositReturned' in a ? ' (' + fmt(a.depositReturned) + ' returned)' : ''}</div>
        </div>
        <button class="icbtn" title="View full history" onclick="openArchive('${a.id}')">📜</button>
        <button class="icbtn" style="background:var(--greenbg)" title="Re-open record at this unit" onclick="restoreTenant('${a.id}')">↩️</button>
      </div>`).join('')
    : '<div class="empty">No former tenants yet. When someone moves out, their record comes here — history preserved.</div>'}`;
}
function openArchive(aid){
  const a = state.archive.find(x => x.id === aid);
  if (!a) return;
  openModal(`
    <h3>📜 ${esc(a.name)} — full record</h3>
    <p style="color:var(--muted); margin-top:0;">${esc(a.unitNo)}, ${esc(a.propertyName)} · ${monthName(a.start)} → moved out ${new Date(a.vacatedOn).toLocaleDateString('en-KE')}</p>
    <div class="payline"><span>Total paid while tenant</span><b class="amt green">${fmt(a.payments.reduce((s,x) => s + +x.amount, 0))}</b></div>
    <div class="payline"><span>Deposit held / returned</span><b>${fmt(a.deposit||0)} / ${fmt(a.depositReturned||0)}</b></div>
    <h3 class="sect">💵 Payments</h3>
    ${a.payments.length ? [...a.payments].sort((x,y) => y.date.localeCompare(x.date)).map(x =>
      `<div class="payline"><span>${dShort(x.date)} · ${esc(x.method)}${x.ref ? ' · ' + esc(x.ref) : ''}</span><b class="amt green">${fmt(x.amount)}</b></div>`).join('')
      : '<div class="empty">No payments recorded.</div>'}
    ${(a.log || []).length ? `<h3 class="sect">📝 Statements</h3>` + a.log.map(l =>
      `<div class="payline"><span>${new Date(l.date).toLocaleDateString('en-KE',{day:'numeric',month:'short'})} — ${esc(l.text)}</span></div>`).join('') : ''}
    <div class="btnrow">
      <button class="btn block" onclick="restoreTenant('${a.id}')">↩️ Re-open this record</button>
      <button class="btn warn block" onclick="deleteArchived('${a.id}')">Delete this record permanently</button>
      <button class="btn soft block" onclick="closeModal()">Close</button>
    </div>`);
}
function deleteArchived(aid){
  const a = state.archive.find(x => x.id === aid);
  if (!a) return;
  if (!confirm('Permanently delete the record of ' + a.name + ' (' + a.payments.length + ' payment(s))?\n\nIf you change your mind, it can still be brought back with the 🕘 button at the top.')) return;
  snapshot('Before permanently deleting former tenant ' + a.name);
  state.archive = state.archive.filter(x => x.id !== aid);
  state.deleted.archive.push(aid);
  save(); closeModal(); toast('Former tenant record deleted'); go('archive');
}
function restoreTenant(aid){
  const a = state.archive.find(x => x.id === aid);
  if (!a) return;
  const p = state.properties.find(x => x.id === a.propertyId) || state.properties.find(x => x.name === a.propertyName);
  const u = p && p.units.find(x => x.no === a.unitNo);
  if (!u) { toast('That property/unit no longer exists'); return; }
  if (u.tenant) { toast('That unit now has a new tenant. Vacate them first, or pick another unit.'); return; }
  if (!confirm('Move ' + a.name + ' back into unit ' + u.no + '? Their payment history returns with them.')) return;
  snapshot('Before re-opening record of ' + a.name);
  u.tenant = { id: a.tenantId || 't' + uid(), name: a.name, phone: a.phone, rent: a.rent, start: a.start, deposit: a.deposit || 0,
               payments: a.payments, log: [], createdAt: Date.now(), updatedAt: Date.now() };
  u.log = [];
  state.archive = state.archive.filter(x => x.id !== aid);
  state.deleted.archive.push(aid);
  save(); closeModal(); toast('↩️ ' + a.name + ' restored'); go('dashboard');
}

/* ================= M-PESA ================= */
let mpesaMatch = null;
let mpesaPending = null;
function renderMpesa(){
  $('#view-mpesa').innerHTML = `
    <h2 class="viewtitle">📱 M-Pesa payments</h2>
    <div class="card">
      <h3 style="margin-top:0;">Paste an M-Pesa SMS below</h3>
      <p style="color:var(--muted); margin-top:0;">When a payment SMS arrives, paste it here — the app reads the amount, name and phone number and finds the tenant. Or tap <b>📱 Record payment</b> to type it in yourself.</p>
      <textarea id="smsBox" rows="3" placeholder="e.g. XGR21H5K2Z Confirmed. You have received Ksh 12,000.00 from JOHN MWANGI 254712345678 on 23/9/26 at 2:14 PM …"
        oninput="parseSms(this.value)"></textarea>
      <div id="smsResult" style="margin-top:.6rem;"></div>
      <div class="btnrow no-print">
        <button class="btn" onclick="openMpesaRecord()">📱 Record payment</button>
      </div>
    </div>
    <h3 class="sect">📥 Recently matched payments</h3>
    ${state.feed.length ? state.feed.slice(0, 8).map(f => `
      <div class="rowitem">
        <div class="grow"><div class="t1">${esc(f.name)}</div><div class="t2">${esc(f.unit)} · ${esc(f.ref || 'M-Pesa')} · ${new Date(f.date).toLocaleString('en-KE')}</div></div>
        <div class="amt green">${fmt(f.amount)}</div>
      </div>`).join('') : '<div class="empty">Nothing matched yet.</div>'}

    <h3 class="sect">⚠️ Not matched payments</h3>
    ${(state.unmatched || []).length ? state.unmatched.map(m => `
      <div class="rowitem" style="background:var(--amberbg);" onclick="openUnmatched('${m.id}')">
        <div class="grow"><div class="t1">${fmt(m.amount)} — tap to assign</div>
        <div class="t2">${esc(m.name || 'no name')} · ${esc(m.phone || 'no phone')} · ${new Date(m.date).toLocaleString('en-KE')}</div></div>
        <div>👉</div>
      </div>`).join('')
      : '<div class="empty">No unmatched payments. Everything is assigned. 🎉</div>'}`;
}
function parseSms(text){
  const box = $('#smsResult');
  mpesaMatch = null;
  mpesaPending = null;
  if (!text || text.trim().length < 20){ box.innerHTML = ''; return; }
  const amtM = text.match(/received Ksh\s*([\d,]+\.?\d*)/i) || text.match(/Ksh\s*([\d,]+\.?\d*)/);
  const fromM = text.match(/from\s+([A-Za-z' ]+?)\s+(\d{9,15})/i);
  const refM = text.match(/^([A-Z0-9]{8,12})\b/);
  if (!amtM){ box.innerHTML = '<div class="empty">Hmm — I could not find an amount. Check the message includes “received Ksh …”.</div>'; return; }
  const amount = parseFloat(amtM[1].replace(/,/g, ''));
  const senderName = fromM ? fromM[1].trim() : '';
  const senderPhone = fromM ? fromM[2] : '';
  const ref = refM ? refM[1] : '';
  const matches = allUnits().filter(({u}) => u.tenant && (
    senderName && (u.tenant.name.toLowerCase().includes(senderName.toLowerCase().split(' ')[0]) || senderName.toLowerCase().includes(u.tenant.name.toLowerCase().split(' ')[0])) ||
    senderPhone && (u.tenant.phone.replace(/\D/g, '').includes(senderPhone.slice(-9)) || senderPhone.includes(u.tenant.phone.replace(/\D/g, '').slice(-9)))
  ));
  if (!matches.length){
    mpesaPending = { amount, name: senderName, phone: senderPhone, ref };
    box.innerHTML = `<div class="empty">Found <b>${fmt(amount)}</b> from <b>${esc(senderName || 'unknown')}</b>, but no tenant matches that name/phone. Please choose who this payment belongs to.</div>
      <div class="btnrow"><button class="btn block" onclick="assignPastedSms()">👉 Assign this payment to a tenant</button></div>`;
    return;
  }
  const best = matches[0];
  mpesaMatch = { pid: best.p.id, uid: best.u.id, amount, ref };
  box.innerHTML = `
    <div class="rowitem" style="background:var(--greenbg); box-shadow:none;">
      <div class="grow"><div class="t1">✔ Looks like <b>${esc(best.u.tenant.name)}</b></div>
      <div class="t2">Unit ${esc(best.u.no)}, ${esc(best.p.name)} · pending ${fmt(pending(best.u))}</div></div>
      <div class="amt green">${fmt(amount)}</div>
    </div>
    ${matches.length > 1 ? `<label>Or choose another tenant</label>
      <select onchange="mpesaPick(this.value)">${matches.map(m => `<option value="${m.p.id}|${m.u.id}">${esc(m.u.tenant.name)} — ${esc(m.u.no)}, ${esc(m.p.name)}</option>`).join('')}</select>` : ''}
    <div class="btnrow"><button class="btn block" onclick="confirmMpesa()">✔ Yes, add this payment</button></div>`;
}
function assignPastedSms(){
  const m = mpesaPending; if (!m) return;
  const id = uid();
  state.unmatched.unshift({ id, date: new Date().toISOString(), amount: m.amount, name: m.name, phone: m.phone, ref: m.ref });
  save(); go('mpesa'); openUnmatched(id);
}
function mpesaPick(v){ const [pid, uidv] = v.split('|'); mpesaMatch = { pid, uid: uidv, amount: mpesaMatch.amount, ref: mpesaMatch.ref }; }
function confirmMpesa(){
  const m = mpesaMatch; if (!m) return;
  const {p,u} = allUnits().find(x => x.p.id === m.pid && x.u.id === m.uid);
  snapshot('Before M-Pesa payment of ' + fmt(m.amount) + ' for ' + u.tenant.name);
  u.tenant.payments.push(newPay(today(), m.amount, 'M-Pesa', m.ref || ''));
  (u.log = u.log || []).push({ date: today(), text: 'M-Pesa payment ' + fmt(m.amount) + ' auto-matched from SMS (' + (m.ref || 'no ref') + ').' });
  state.feed.unshift({ name: u.tenant.name, unit: p.name + ' ' + u.no, amount: m.amount, ref: m.ref, date: new Date().toISOString() });
  save(); toast('✔ ' + fmt(m.amount) + ' added to ' + u.tenant.name); go('mpesa');
}
function openMpesaRecord(){
  openModal(`
    <h3>📱 Record M-Pesa payment</h3>
    <p style="color:var(--muted); margin-top:0;">Type what the SMS says. The app matches the phone &amp; name to a tenant and records it automatically. If nobody matches, it is saved under <b>Not matched</b> below for you to assign later.</p>
    <label>Amount (Ksh)</label>
    <input type="number" id="mAmt" inputmode="numeric" placeholder="e.g. 12000">
    <label>Sender phone number</label>
    <input type="tel" id="mPhone" placeholder="e.g. 0712 345 678">
    <label>Sender name</label>
    <input type="text" id="mName" placeholder="e.g. John Mwangi">
    <label>Reference (optional)</label>
    <input type="text" id="mRef" placeholder="e.g. QK7X2H4M1Z">
    <div class="btnrow">
      <button class="btn block" onclick="saveMpesaRecord()">✔ Find tenant &amp; record</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
  setTimeout(() => $('#mAmt')?.focus(), 100);
}
function findTenantBySender(name, phone){
  const digits = String(phone || '').replace(/\D/g, '').slice(-9);
  const first = String(name || '').trim().toLowerCase().split(/\s+/)[0];
  return allUnits().filter(({u}) => u.tenant && (
    (digits && digits.length >= 9 && u.tenant.phone.replace(/\D/g, '').slice(-9) === digits) ||
    (first && first.length > 2 && u.tenant.name.toLowerCase().split(/\s+/).includes(first))
  ));
}
function saveMpesaRecord(){
  const amount = +$('#mAmt').value, phone = $('#mPhone').value.trim(),
        name = $('#mName').value.trim(), ref = $('#mRef').value.trim();
  if (!amount || amount <= 0) { toast('Enter the amount'); return; }
  const matches = findTenantBySender(name, phone);
  if (matches.length){
    const {p,u} = matches[0];
    snapshot('Before M-Pesa payment of ' + fmt(amount) + ' for ' + u.tenant.name);
    u.tenant.payments.push(newPay(today(), amount, 'M-Pesa', ref));
    (u.log = u.log || []).push({ date: today(), text: 'M-Pesa payment ' + fmt(amount) + ' recorded via Record payment.' });
    state.feed.unshift({ name: u.tenant.name, unit: p.name + ' ' + u.no, amount, ref, date: new Date().toISOString() });
    save(); closeModal();
    toast('✔ ' + fmt(amount) + ' matched to ' + u.tenant.name);
  } else {
    state.unmatched.unshift({ id: uid(), date: new Date().toISOString(), amount, name, phone, ref });
    save(); closeModal();
    toast('⚠️ No tenant matched — see Not matched below');
  }
  go('mpesa');
}
function openUnmatched(mid){
  const m = state.unmatched.find(x => x.id === mid);
  if (!m) return;
  openModal(`
    <h3>⚠️ Assign this payment</h3>
    <div class="rowitem" style="background:var(--amberbg); box-shadow:none;">
      <div class="grow"><div class="t1">${fmt(m.amount)}</div>
      <div class="t2">${esc(m.name || 'no name')} · ${esc(m.phone || 'no phone')} · ${new Date(m.date).toLocaleString('en-KE')}</div></div>
    </div>
    <label>Apartment / property</label>
    <select id="unProp" onchange="fillUnUnits()">
      <option value="">— choose property —</option>
      ${state.properties.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
    </select>
    <label>House number (unit)</label>
    <select id="unUnit"><option value="">— choose property first —</option></select>
    <div class="btnrow">
      <button class="btn block" onclick="saveUnmatched('${mid}')">✔ Record to this tenant</button>
      <button class="btn soft block" onclick="closeModal()">Cancel</button>
    </div>`);
}
function fillUnUnits(){
  const p = state.properties.find(x => x.id === $('#unProp').value);
  $('#unUnit').innerHTML = p
    ? p.units.map(u => `<option value="${u.id}">${esc(u.no)}${u.tenant ? ' — ' + esc(u.tenant.name) : ' — (empty)'}</option>`).join('')
    : '<option value="">— choose property first —</option>';
}
function saveUnmatched(mid){
  const m = state.unmatched.find(x => x.id === mid);
  if (!m) { toast('That payment was already assigned'); closeModal(); go('mpesa'); return; }
  const p = state.properties.find(x => x.id === $('#unProp').value);
  const u = p && p.units.find(x => x.id === $('#unUnit').value);
  if (!p || !u) { toast('Choose the property and house number'); return; }
  if (!u.tenant) { toast('That unit is empty — add a tenant first'); return; }
  snapshot('Before assigning ' + fmt(m.amount) + ' to ' + u.tenant.name);
  u.tenant.payments.push(newPay((m.date || '').slice(0,10) || today(), m.amount, 'M-Pesa', m.ref || ''));
  (u.log = u.log || []).push({ date: today(), text: 'M-Pesa payment ' + fmt(m.amount) + ' assigned manually.' });
  state.feed.unshift({ name: u.tenant.name, unit: p.name + ' ' + u.no, amount: m.amount, ref: m.ref, date: m.date });
  state.unmatched = state.unmatched.filter(x => x.id !== mid);
  state.deleted.unmatched.push(mid);
  save(); closeModal(); toast('✔ Assigned to ' + u.tenant.name); go('mpesa');
}

/* ================= LOAD A BACKUP FILE (.json or the full .html backup) ================= */
function importData(ev){
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      let txt = String(r.result), incoming;
      if (txt.trim().charAt(0) === '<'){
        const m = txt.match(/<script type="application\/json" id="mmBundle">([\s\S]*?)<\/script>/);
        if (!m) throw new Error('not a Margaret Manager backup');
        const b = JSON.parse(m[1]);
        incoming = b.data;
        if (b.clientId && !cfg().driveClientId) setCfg({ driveClientId: b.clientId });
      } else incoming = JSON.parse(txt);
      if (!confirm('Load this backup? It replaces what is on this device now (a restore point is saved first), and is then synced to your other devices.')) return;
      snapshot('Before loading a backup file');
      state = normalize(incoming);
      state.demo = false;
      state.reset = { id: uid(), at: Date.now() };
      save(); toast('📥 Backup loaded'); go('dashboard');
    } catch(e){ toast('That file could not be read'); }
  };
  r.readAsText(f);
  ev.target.value = '';
}

/* ================= INIT ================= */
$('#subline').textContent = new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function setBarH(){ document.documentElement.style.setProperty('--appbar-h', document.querySelector('.appbar').offsetHeight + 'px'); }
setBarH(); window.addEventListener('resize', setBarH);
setSync(clientId() ? 'auth' : 'off');
setBarH();
renderDashboard();
setTimeout(() => { if (state.demo) toast('👋 Welcome! This is sample data. Connect Google Drive (☁️) to load your real records.'); }, 600);

/* keep devices in step */
setTimeout(() => syncNow(false), 900);
document.addEventListener('visibilitychange', () => { if (!document.hidden && clientId()) syncNow(false); });
window.addEventListener('online', () => { if (clientId()) syncNow(false); });
setInterval(() => { if (!document.hidden && clientId() && driveTok && Date.now() < driveTokExp) syncNow(false); }, 60000);
