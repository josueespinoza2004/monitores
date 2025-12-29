const $ = sel => document.querySelector(sel);
const monList = $('#monList');
const detail = $('#detail');
const detailName = $('#detailName');
const statusBadge = $('#statusBadge');
const lastChecked = $('#lastChecked');
const pingInfo = $('#pingInfo');
const chartEl = document.getElementById('chart');
let chart = null;
let monitors = [];
let activeId = null;
let prevStatuses = {};

async function api(path, opts){
  const r = await fetch('/api' + path, opts);
  return r.json();
}

async function load(){
  monitors = await api('/monitors');
  renderList();
  if(activeId) showDetail(activeId);
  // initialize previous statuses map (no notifications on first load)
  prevStatuses = {};
  monitors.forEach(m=>{ prevStatuses[m.id || m.name] = m.lastStatus || 'unknown' });
}

function showToast(message, type){
  const container = document.getElementById('toastContainer');
  if(!container) return;
  const toastEl = document.createElement('div');
  const icon = (type==='down') ? 'exclamation-triangle-fill' : 'check-circle-fill';
  const variantClass = (type==='down') ? 'bg-danger text-white' : 'bg-success text-dark';
  toastEl.className = 'toast align-items-center '+variantClass+'';
  toastEl.setAttribute('role','alert');
  toastEl.setAttribute('aria-live','assertive');
  toastEl.setAttribute('aria-atomic','true');
  toastEl.innerHTML = `<div class="d-flex"><div class="toast-body"><i class="bi bi-${icon}"></i> ${escapeHtml(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
  container.insertBefore(toastEl, container.firstChild);
  const bsToast = new bootstrap.Toast(toastEl, { delay: 8000 });
  toastEl.addEventListener('hidden.bs.toast', ()=>{ try{ toastEl.remove() }catch(e){} });
  bsToast.show();
}

function renderList(){
  monList.innerHTML = '';
  monitors.forEach(m=>{
    const li = document.createElement('li');
    // build small activity bars from monitor history so states persist visually
    const barsCount = 22;
    let barsHtml = '<div class="mini-bars">';
    const hist = Array.isArray(m.history) ? m.history.slice(-barsCount) : [];
    // pad left with empty entries if history shorter
    const pad = Math.max(0, barsCount - hist.length);
    for(let i=0;i<pad;i++){
      barsHtml += `<span class="mini" style="height:10px"></span>`;
    }
    // render history entries oldest -> newest
    hist.forEach(h => {
      const up = (h.status === 'up');
      let height = 12;
      if (typeof h.ping === 'number') {
        // scale ping to a reasonable bar height (clamp)
        const p = Math.min(h.ping, 400);
        height = 8 + Math.round((p / 400) * 28);
      } else if (!up) {
        height = 14; // visible down bar
      }
      barsHtml += `<span class="mini ${up?'up':'down'}" style="height:${height}px"></span>`;
    });
    barsHtml += '</div>';
    const pct = (typeof m.uptime24 === 'number') ? (m.uptime24.toFixed(0) + '%') : (m.lastStatus==='up' ? '100%' : '--');
    li.innerHTML = `<div><div class="name">${escapeHtml(m.name)}</div><div class="muted">${escapeHtml(m.url||'')}</div>${barsHtml}</div><div><span class="badge">${pct}</span></div>`;
    li.onclick = ()=>{ activeId = m.id; showDetail(m.id); }
    if(activeId === m.id) li.classList.add('active');
    monList.appendChild(li);
  });
}

function escapeHtml(s){ if(!s) return ''; return s.replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function showDetail(id){
  const m = monitors.find(x=>x.id===id);
  if(!m) return;
  detail.classList.remove('empty');
  detailName.textContent = m.name;
  $('#detailTarget').textContent = m.url || m.target || '—';
  // status pill
  const pill = $('#statusPill');
  pill.textContent = (m.lastStatus||'—').toUpperCase();
  if(m.lastStatus==='up'){ pill.style.background = 'var(--accent)'; pill.style.color='#042316' } else if (m.lastStatus==='down'){ pill.style.background = 'var(--danger)'; pill.style.color='#2b0606' } else { pill.style.background = 'rgba(255,255,255,0.03)'; pill.style.color='var(--muted)' }
  $('#mPing').textContent = (typeof m.lastPing === 'number') ? (m.lastPing + ' ms') : '—';
  // compute simple average ping from recent history entries that have ping
  let avg = null;
  if (Array.isArray(m.history)) {
    const pings = m.history.slice(-40).map(h=>h.ping).filter(x=>typeof x==='number');
    if (pings.length) { avg = Math.round(pings.reduce((a,b)=>a+b,0)/pings.length); }
  }
  $('#mAvg').textContent = (avg !== null) ? (avg + ' ms') : '—';
  $('#mUp24').textContent = (typeof m.uptime24 === 'number') ? (m.uptime24 + '%') : '—';
  $('#mUp30').textContent = (typeof m.uptime30 === 'number') ? (m.uptime30 + '%') : '—';
  $('#deleteBtn').onclick = async ()=>{ await api('/monitors/'+m.id,{method:'DELETE'}); activeId=null; await load(); }

  // bars row (30 entries) based on recent history so down markers persist
  const barsRow = $('#barsRow'); barsRow.innerHTML='';
  const detailCount = 30;
  const detailHist = Array.isArray(m.history) ? m.history.slice(-detailCount) : [];
  const padDetail = Math.max(0, detailCount - detailHist.length);
  for(let i=0;i<padDetail;i++){ const b = document.createElement('div'); b.className='bar'; b.style.height='12px'; barsRow.appendChild(b); }
  detailHist.forEach(h=>{
    const b = document.createElement('div');
    const up = (h.status === 'up');
    let hgt = 16;
    if (typeof h.ping === 'number') { const p = Math.min(h.ping, 400); hgt = 10 + Math.round((p/400)*64); }
    b.className = 'bar ' + (up ? 'up' : 'down');
    b.style.height = hgt + 'px';
    barsRow.appendChild(b);
  });

  // chart: use actual history pings; overlay red vertical bars for DOWN events
  const history = Array.isArray(m.history) ? m.history.slice(-60) : [];
  const labels = history.map(h => { try { return new Date(h.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); } catch(e){ return ''; } });
  const data = history.map(h => (typeof h.ping === 'number') ? h.ping : null);
  // compute y max based on recent pings
  const numericPings = data.filter(x=>typeof x==='number');
  const maxPing = numericPings.length ? Math.max(...numericPings) : 200;
  const yMax = Math.max(400, Math.ceil(maxPing * 1.25));
  const downBars = history.map(h => (h.status === 'down' ? yMax : null));
  if(chart) chart.destroy();
  const ctx = chartEl.getContext('2d');
  const gradient = ctx.createLinearGradient(0,0,0,240);
  gradient.addColorStop(0,'rgba(47,232,155,0.12)');
  gradient.addColorStop(0.7,'rgba(47,232,155,0.06)');
  gradient.addColorStop(1,'rgba(47,232,155,0.01)');
  chart = new Chart(ctx, {
    data: {
      labels,
      datasets: [
        { type:'line', label: 'Ping (ms)', data, borderColor: '#2fe89b', backgroundColor: gradient, tension: 0.38, pointRadius: 0, borderWidth: 3, fill: true, order: 2 },
        { type:'bar', label: 'Down', data: downBars, backgroundColor: '#ff6b6b', barThickness: 6, categoryPercentage: 0.8, order: 3 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { display: true, max: yMax, ticks: { color: 'rgba(255,255,255,0.6)', maxTicksLimit: 5 }, grid: { color: 'rgba(255,255,255,0.03)' } },
        x: { display: true, ticks: { color: 'rgba(255,255,255,0.45)' }, grid: { display: false } }
      },
      elements: { line: { cap: 'round' } },
      interaction: { intersect: false, mode: 'index' }
    }
  });
}

// small deterministic PRNG from a seed
function seeded(n){ return Math.abs(Math.sin(n) * 10000) % 1 }
function hashCode(str){ let h=0; for(let i=0;i<str.length;i++){ h = ((h<<5)-h) + str.charCodeAt(i); h = h & h } return Math.abs(h)
}

$('#addBtn').onclick = ()=>$('#modal').classList.remove('hidden');
$('#cancel').onclick = ()=>$('#modal').classList.add('hidden');
$('#saveMonitor').onclick = async ()=>{
  const name = $('#mName').value || 'unnamed';
  const url = $('#mUrl').value || '';
  await api('/monitors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,url,type:'http'})});
  $('#mName').value='';$('#mUrl').value='';$('#modal').classList.add('hidden');
  await load();
}

$('#checkNow').onclick = async ()=>{ await api('/check-now',{method:'POST'}); await load(); }

document.getElementById('search').oninput = function(){ const q=this.value.toLowerCase(); Array.from(monList.children).forEach(li=>{ li.style.display = li.textContent.toLowerCase().includes(q)?'flex':'none'; }) }

window.addEventListener('load', ()=>{
  load();
  if (window.EventSource) {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // detect status transitions and show toasts
        try {
          const newMap = {};
          data.forEach(m=>{ newMap[m.id || m.name] = m.lastStatus || 'unknown' });
          data.forEach(m=>{
            const key = m.id || m.name;
            const prev = prevStatuses[key];
            const cur = newMap[key];
            if(prev && prev !== cur){
              // prepare a message; prefer explicit last message if available
              const msg = (cur==='down') ? (`[${m.name}] [DOWN] ${m.lastMessage||m.lastError||'ping: connect: Network is unreachable'}`) : (`[${m.name}] [UP] Servicio reestablecido`);
              showToast(msg, cur==='down' ? 'down' : 'up');
            }
          });
          // update prevStatuses map
          prevStatuses = {};
          Object.keys(newMap).forEach(k=> prevStatuses[k]=newMap[k]);
        } catch(err){ console.warn('Error processing status changes', err); }

        monitors = data;
        renderList();
        if (activeId) showDetail(activeId);
      } catch (err) { console.error('Invalid SSE payload', err); }
    };
    es.onerror = (err) => {
      console.warn('SSE connection error, falling back to polling', err);
      // fallback: poll every 5s
      setInterval(load, 5000);
    };
  } else {
    setInterval(load, 3000);
  }
});
