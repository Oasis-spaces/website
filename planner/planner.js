// Room planner front end. All geometry checks run on the Python backend (/api/analyze);
// this file draws the plan, handles dragging and keyboard input, and renders results.
(() => {
  const $ = (s) => document.querySelector(s);
  const cv = $('#plan'), ctx = cv.getContext('2d');
  const C = { paper: '#F1F2ED', ink: '#172220', green: '#1E5A4C', bad: '#A3412E', work: '#C2933A', line: 'rgba(23,34,32,.12)' };
  let state = null, presets = {}, selected = null, drag = null, history = [], bad = new Set(), zone = null, nextId = 1;
  let scale = 1, pad = 36, seq = 0, ctl = null;

  // ------------------------------------------------------------ API
  async function api(path, body) {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  const payload = () => ({ room: state.room, door: state.door, windows: state.windows, coats: state.coats, items: state.items });

  let timer;
  const analyze = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
  async function run() {
    const my = ++seq;
    try {
      const a = await api('/api/analyze', payload());
      if (my !== seq) return; // a newer request superseded this one
      render(a);
      $('#conn').textContent = 'Python backend: connected';
    } catch (e) {
      $('#conn').textContent = 'Python backend: ' + e.message;
    }
  }

  // --------------------------------------------------------- results
  const money = (n) => '£' + n.toFixed(0);
  function render(a) {
    const m = a.metrics, l = a.layout;
    const sc = $('#score'); sc.textContent = l.score; sc.className = l.score < 50 ? 'bad' : l.score < 80 ? 'mid' : '';
    $('#metrics').innerHTML = [
      ['Floor area', m.floor_m2 + ' m²'], ['Volume', m.volume_m3 + ' m³'], ['Wall area', m.wall_net_m2 + ' m²'],
      ['Furniture fill', l.fill_pct + '%'], ['Walkable floor reached', l.walkable_pct + '%'],
      ['Paint', m.paint_litres + ' L · ' + money(m.cost.paint)],
      ['Flooring', m.flooring_boxes + ' boxes · ' + money(m.cost.flooring)],
      ['Materials total', money(m.cost.paint + m.cost.flooring)],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const ul = $('#issues'); ul.textContent = '';
    for (const i of l.issues) { const li = document.createElement('li'); li.textContent = i.msg; ul.append(li); }
    if (!l.issues.length) { const li = document.createElement('li'); li.className = 'ok'; li.textContent = 'No problems found.'; ul.append(li); }
    bad = new Set(l.issues.flatMap((i) => i.items)); zone = l.door_zone;
    draw(); save();
  }

  // --------------------------------------------------------- drawing
  const fp = (it) => (it.rot === 90 ? [it.d, it.w] : [it.w, it.d]);
  function fit() {
    const w = cv.parentElement.clientWidth - 32, dpr = window.devicePixelRatio || 1;
    scale = (w - pad * 2) / state.room.width;
    const h = state.room.length * scale + pad * 2;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function draw() {
    if (!state) return;
    fit();
    const { width: W, length: L } = state.room, P = (v) => pad + v * scale;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (let x = 0; x <= W + 1e-6; x += 0.5) { ctx.beginPath(); ctx.moveTo(P(x), P(0)); ctx.lineTo(P(x), P(L)); ctx.stroke(); }
    for (let y = 0; y <= L + 1e-6; y += 0.5) { ctx.beginPath(); ctx.moveTo(P(0), P(y)); ctx.lineTo(P(W), P(y)); ctx.stroke(); }
    ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.strokeRect(P(0), P(0), W * scale, L * scale);
    if (zone) { // door swing zone + door gap
      ctx.fillStyle = 'rgba(30,90,76,.12)'; ctx.fillRect(P(zone[0]), P(zone[1]), (zone[2] - zone[0]) * scale, (zone[3] - zone[1]) * scale);
      ctx.strokeStyle = C.paper; ctx.lineWidth = 5; ctx.beginPath();
      const d = state.door, h = d.width / 2;
      if (d.wall === 'top' || d.wall === 'bottom') { const y = P(d.wall === 'top' ? 0 : L); ctx.moveTo(P(d.pos - h), y); ctx.lineTo(P(d.pos + h), y); }
      else { const x = P(d.wall === 'left' ? 0 : W); ctx.moveTo(x, P(d.pos - h)); ctx.lineTo(x, P(d.pos + h)); }
      ctx.stroke();
    }
    for (const it of state.items) {
      const [w, h] = fp(it), isBad = bad.has(it.id), sel = it.id === selected;
      ctx.fillStyle = isBad ? 'rgba(163,65,46,.22)' : 'rgba(30,90,76,.16)';
      ctx.strokeStyle = isBad ? C.bad : C.green; ctx.lineWidth = sel ? 3 : 1.5;
      ctx.fillRect(P(it.x), P(it.y), w * scale, h * scale); ctx.strokeRect(P(it.x), P(it.y), w * scale, h * scale);
      ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(it.name, P(it.x + w / 2), P(it.y + h / 2), w * scale - 6);
    }
    ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(W.toFixed(1) + ' m', P(W / 2), pad - 12);
    ctx.save(); ctx.translate(pad - 14, P(L / 2)); ctx.rotate(-Math.PI / 2); ctx.fillText(L.toFixed(1) + ' m', 0, 0); ctx.restore();
    $('#remove').disabled = $('#rotate').disabled = !selected;
  }

  // -------------------------------------------------------- interaction
  const toM = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left - pad) / scale, (e.clientY - r.top - pad) / scale]; };
  const snap = (v) => Math.round(v * 10) / 10;
  const hit = (mx, my) => [...state.items].reverse().find((it) => { const [w, h] = fp(it); return mx >= it.x && mx <= it.x + w && my >= it.y && my <= it.y + h; });
  const push = () => { history.push(JSON.stringify(state.items)); if (history.length > 50) history.shift(); $('#undo').disabled = false; };

  cv.addEventListener('pointerdown', (e) => {
    const [mx, my] = toM(e), it = hit(mx, my);
    selected = it ? it.id : null;
    if (it) { push(); drag = { it, dx: mx - it.x, dy: my - it.y }; cv.setPointerCapture(e.pointerId); }
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    const [mx, my] = toM(e);
    if (!drag) { cv.style.cursor = hit(mx, my) ? 'grab' : 'default'; return; }
    cv.style.cursor = 'grabbing';
    const [w, h] = fp(drag.it), W = state.room.width, L = state.room.length;
    drag.it.x = Math.min(Math.max(snap(mx - drag.dx), 0), Math.max(W - w, 0));
    drag.it.y = Math.min(Math.max(snap(my - drag.dy), 0), Math.max(L - h, 0));
    draw(); analyze();
  });
  const end = () => { drag = null; cv.style.cursor = 'default'; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

  function rotate() {
    const it = state.items.find((i) => i.id === selected); if (!it) return;
    push(); it.rot = it.rot === 90 ? 0 : 90;
    const [w, h] = fp(it); it.x = Math.min(it.x, Math.max(state.room.width - w, 0)); it.y = Math.min(it.y, Math.max(state.room.length - h, 0));
    draw(); analyze();
  }
  cv.addEventListener('keydown', (e) => {
    const it = state.items.find((i) => i.id === selected);
    if (e.key === 'Tab' && state.items.length) {
      const i = state.items.findIndex((x) => x.id === selected), n = (i + (e.shiftKey ? -1 : 1) + state.items.length) % state.items.length;
      if (i === -1 || (e.shiftKey ? i > 0 : i < state.items.length - 1)) { selected = state.items[e.shiftKey && i === -1 ? state.items.length - 1 : n].id; e.preventDefault(); draw(); }
      return;
    }
    if (!it) return;
    const mv = { ArrowLeft: [-.1, 0], ArrowRight: [.1, 0], ArrowUp: [0, -.1], ArrowDown: [0, .1] }[e.key];
    if (mv) {
      e.preventDefault(); push(); const [w, h] = fp(it);
      it.x = Math.min(Math.max(snap(it.x + mv[0]), 0), Math.max(state.room.width - w, 0));
      it.y = Math.min(Math.max(snap(it.y + mv[1]), 0), Math.max(state.room.length - h, 0));
      draw(); analyze();
    } else if (e.key.toLowerCase() === 'r') { rotate(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { removeSel(); }
  });
  function removeSel() { if (!selected) return; push(); state.items = state.items.filter((i) => i.id !== selected); selected = null; draw(); analyze(); }
  $('#remove').onclick = removeSel; $('#rotate').onclick = rotate;
  $('#undo').onclick = () => { const h = history.pop(); if (h) { state.items = JSON.parse(h); draw(); analyze(); } $('#undo').disabled = !history.length; };

  // ------------------------------------------------- forms & features
  const roomForm = $('#room');
  function syncForm() { for (const k of ['width', 'length', 'height']) roomForm[k].value = state.room[k]; roomForm.coats.value = state.coats; }
  roomForm.addEventListener('input', () => {
    const v = (n) => parseFloat(roomForm[n].value);
    if ([v('width'), v('length'), v('height'), v('coats')].some(Number.isNaN)) return;
    Object.assign(state.room, { width: v('width'), length: v('length'), height: v('height') }); state.coats = v('coats');
    state.door.pos = Math.min(state.door.pos, (state.door.wall === 'top' || state.door.wall === 'bottom' ? state.room.width : state.room.length) - state.door.width / 2);
    draw(); analyze();
  });
  $('#add').addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target; push();
    const it = { id: 'n' + nextId++, name: f.name.value.trim() || 'Item', w: +f.w.value, d: +f.d.value, x: 0, y: 0, rot: 0 };
    state.items.push(it); selected = it.id; draw(); analyze(); cv.focus();
  });

  // Auto-arrange: POST, then read the Server-Sent Events stream and animate each placement.
  $('#arrange').onclick = async () => {
    if (ctl) ctl.abort(); ctl = new AbortController();
    const btn = $('#arrange'), hint = $('#hint'); btn.disabled = true; push();
    try {
      const r = await fetch('/api/arrange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()), signal: ctl.signal });
      if (!r.ok) throw new Error((await r.json()).error);
      const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2);
          const ev = JSON.parse(line);
          if (ev.event === 'start') { hint.textContent = `Arranging ${ev.total} pieces…`; }
          if (ev.event === 'place') { Object.assign(state.items.find((x) => x.id === ev.item.id), ev.item); draw(); await new Promise((ok) => setTimeout(ok, 220)); }
          if (ev.event === 'skip') { hint.textContent = ev.msg; }
          if (ev.event === 'done') hint.textContent = `Placed ${ev.placed}` + (ev.skipped ? `, ${ev.skipped} would not fit.` : '. Drag to adjust.');
        }
      }
    } catch (e) { if (e.name !== 'AbortError') hint.textContent = 'Auto-arrange failed: ' + e.message; }
    btn.disabled = false; draw(); run();
  };

  $('#export').onclick = () => {
    const rows = [['name', 'width_m', 'depth_m', 'x_m', 'y_m', 'rotation']].concat(state.items.map((i) => [i.name, i.w, i.d, i.x, i.y, i.rot]));
    const esc = (v) => { v = String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; // no CSV formula injection
    const a = Object.assign(document.createElement('a'), { download: 'room-plan.csv', href: URL.createObjectURL(new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' })) });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#share').onclick = async () => {
    const url = location.origin + location.pathname + '#' + btoa(unescape(encodeURIComponent(JSON.stringify(payload()))));
    try { await navigator.clipboard.writeText(url); $('#hint').textContent = 'Link copied. The plan lives in the link itself.'; } catch { location.hash = url.split('#')[1]; $('#hint').textContent = 'Copy the address bar to share this plan.'; }
  };

  // ---------------------------------------------------- persistence
  function save() { try { localStorage.setItem('oasis-plan', JSON.stringify(payload())); } catch {} }
  function load(obj) {
    state = { room: obj.room, door: obj.door, windows: obj.windows || [], coats: obj.coats || 2, items: (obj.items || []).map((i) => ({ rot: 0, ...i })) };
    selected = null; history = []; $('#undo').disabled = true; syncForm(); draw(); run();
  }
  function fromHash() {
    try { return JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1))))); } catch { return null; }
  }
  $('#preset').onchange = (e) => load(structuredClone(presets[e.target.value]));
  window.addEventListener('resize', draw);

  (async () => {
    try {
      presets = await api('/api/presets');
      $('#preset').innerHTML = Object.keys(presets).map((k) => `<option>${k}</option>`).join('');
      let saved = null; try { saved = JSON.parse(localStorage.getItem('oasis-plan')); } catch {}
      load(fromHash() || saved || structuredClone(presets.bedroom));
    } catch {
      $('#conn').textContent = 'Python backend not running. Start it with: python3 server/app.py';
      $('#hint').textContent = 'This page needs the Python server (python3 server/app.py).';
    }
  })();
})();
