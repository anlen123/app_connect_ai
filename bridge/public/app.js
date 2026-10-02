const $ = id => document.getElementById(id);
let ws, sessionId, sessions = [], retry, token = sessionStorage.getItem('pairToken') || '';
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (fragmentToken) { token = fragmentToken; history.replaceState(null, '', location.pathname); }
const requests = new Map(), rows = new Map(), sequences = new Map(), choices = new Map();
function toast(text) { $('toast').textContent = text; $('toast').style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').style.display = 'none', 6500); }
function command(type, fields = {}) {
  if (ws?.readyState !== 1) return Promise.reject(new Error('尚未连接'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('请求超时')); }, 60000);
    requests.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ type, id, sessionId, ...fields }));
  });
}
function connect() {
  clearTimeout(retry); ws?.close();
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token }));
  socket.onmessage = async ({ data }) => {
    let r; try { r = JSON.parse(data); } catch { return; }
    if (r.type === 'hello') { $('connection').textContent = '● 已连接'; $('login').hidden = true; $('workspace').hidden = false; sessionStorage.setItem('pairToken', token); sessions = r.sessions; renderSessions(); if (sessionId) await selectSession(sessionId); }
    if (r.type === 'sessions') { sessions = r.sessions; renderSessions(); }
    if (r.type === 'response') { const p = requests.get(r.id); if (p) { clearTimeout(p.timer); requests.delete(r.id); if (r.ok) p.resolve(r.data); else p.reject(new Error(r.error)); } }
    if (r.type === 'event' && r.sessionId === sessionId) renderEvent(r);
  };
  socket.onclose = e => {
    if (socket !== ws) return;
    $('connection').textContent = '○ 已断开'; for (const p of requests.values()) { clearTimeout(p.timer); p.reject(new Error('连接已断开')); } requests.clear();
    if (e.code === 1008) { token = ''; sessionStorage.removeItem('pairToken'); $('login').hidden = false; $('workspace').hidden = true; toast('配对码无效，请重新输入'); }
    else if (token) retry = setTimeout(connect, 2500);
  };
}
function renderSessions() {
  $('sessions').replaceChildren();
  for (const s of sessions) { const b = document.createElement('button'); b.className = `session ${s.id === sessionId ? 'active' : ''}`; b.textContent = s.title; const t = document.createElement('small'); t.textContent = `${s.agent.toUpperCase()} / ${s.status} · ${s.turns || 0} 轮 · ${s.tools || 0} 工具`; b.append(t); b.onclick = () => selectSession(s.id).catch(e => toast(e.message)); $('sessions').append(b); }
  const s = sessions.find(s => s.id === sessionId); if (!s) return;
  $('title').textContent = s.title; $('status').textContent = `${s.status} · ${s.cwd}`;
  const old = $('model').value; $('model').replaceChildren();
  for (const m of s.models) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; $('model').append(o); }
  $('model').value = s.model || old; $('model').disabled = ['running', 'waiting', 'starting', 'offline'].includes(s.status);
  $('send').disabled = ['running', 'waiting', 'starting', 'offline'].includes(s.status);
}
async function selectSession(id) {
  sessionId = id; const data = await command('subscribe'); if (sessionId !== id) return;
  rows.clear(); choices.clear(); sequences.set(id, 0); $('timeline').replaceChildren(); $('choices').replaceChildren(); $('plan').textContent = '';
  for (const e of data.events) renderEvent(e, true);
  choices.clear(); for (const c of data.choices) choices.set(c.requestId, c); renderChoices(); renderSessions();
}
function renderEvent(e, replay = false) {
  if (e.seq <= (sequences.get(e.sessionId) || 0)) return; sequences.set(e.sessionId, e.seq);
  if (e.event === 'choice') { choices.set(e.requestId, e); renderChoices(); return; }
  if (e.event === 'choice_closed') { choices.delete(e.requestId); renderChoices(); return; }
  if (e.event === 'plan') { $('plan').textContent = (e.steps || []).map(s => `${s.status === 'completed' ? '✓' : s.status === 'inProgress' ? '◉' : '○'} ${s.step}`).join('\n'); return; }
  if (['status', 'model'].includes(e.event)) return;
  const channel = e.channel || e.event;
  const key = e.key ? `${channel}-${e.key}` : `event-${e.seq}`;
  let row = rows.get(key);
  const nearBottom = $('timeline').scrollHeight - $('timeline').scrollTop - $('timeline').clientHeight < 80;
  if (!row) { const el = document.createElement('div'); el.className = `entry ${channel}`; const label = document.createElement('span'); label.className = 'label'; label.textContent = `${channel.toUpperCase()} / ${new Date(e.timestamp).toLocaleTimeString()}`; const body = document.createElement('span'); el.append(label, body); $('timeline').append(el); row = { body }; rows.set(key, row); }
  const text = e.text ?? (e.event === 'completed' ? `任务 ${e.status}` : e.event === 'tool' ? `${e.name} · ${e.status}\n${JSON.stringify(e.detail, null, 2)}` : JSON.stringify(e.detail ?? e));
  if (e.event === 'delta' || e.event === 'tool_output') row.body.textContent += text; else row.body.textContent = text;
  if (nearBottom || replay) $('timeline').scrollTop = $('timeline').scrollHeight;
}
function renderChoices() {
  $('choices').replaceChildren();
  for (const c of choices.values()) {
    const box = document.createElement('div'); box.className = 'choice'; const title = document.createElement('strong'); title.textContent = c.title || '需要你的选择'; box.append(title);
    const detail = document.createElement('p'); detail.textContent = c.message || ''; box.append(detail);
    const answer = a => command('answer', { requestId: c.requestId, answer: a }).catch(e => toast(e.message));
    const button = (text, a) => { const b = document.createElement('button'); b.textContent = text; b.onclick = () => answer(a); box.append(b); };
    if (c.kind === 'confirm') { button('确认', { value: true }); button('拒绝', { value: false }); }
    else if (c.kind === 'questions') {
      const fields = [];
      for (const q of c.questions) { const label = document.createElement('label'); label.textContent = q.question; const input = document.createElement('input'); input.placeholder = (q.options || []).map(o => `${o.label}: ${o.description}`).join(' / '); if (q.isSecret) input.type = 'password'; label.append(input); box.append(label); fields.push([q.id, input]); }
      const b = document.createElement('button'); b.textContent = '提交答案'; b.onclick = () => answer({ answers: Object.fromEntries(fields.map(([id, input]) => [id, [input.value]])) }); box.append(b);
    } else if (c.kind === 'input' || c.kind === 'editor' || c.kind === 'elicitation') {
      const input = document.createElement('textarea'); input.value = c.prefill || ''; input.placeholder = c.kind === 'elicitation' ? 'JSON 对象（遵循上方 schema）' : '输入回答'; box.append(input);
      const b = document.createElement('button'); b.textContent = '提交'; b.onclick = () => { try { answer(c.kind === 'elicitation' ? { content: JSON.parse(input.value) } : { value: input.value }); } catch (e) { toast(e.message); } }; box.append(b);
    } else for (const option of c.options || []) button(option, { value: option });
    if (!['approval', 'questions'].includes(c.kind)) button('放弃回答', { cancelled: true }); $('choices').append(box);
  }
}
$('loginForm').onsubmit = e => { e.preventDefault(); token = $('token').value.trim(); connect(); };
$('createForm').onsubmit = async e => { e.preventDefault(); const b = e.submitter; b.disabled = true; try { const s = await command('create', { agent: $('agent').value, cwd: $('cwd').value }); await selectSession(s.id); } catch (e) { toast(e.message); } finally { b.disabled = false; } };
$('promptForm').onsubmit = async e => { e.preventDefault(); const text = $('prompt').value; try { await command('prompt', { text }); $('prompt').value = ''; } catch (e) { toast(e.message); } };
$('prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('promptForm').requestSubmit(); } };
$('model').onchange = async () => { try { await command('model', { model: $('model').value }); } catch (e) { toast(e.message); renderSessions(); } };
$('stop').onclick = () => command('abort').catch(e => toast(e.message));
$('closeSession').onclick = () => { if (confirm('停止此 agent 进程？历史记录仍可查看。')) command('close').catch(e => toast(e.message)); };
$('pair').onclick = async () => { try { const p = await command('pair'); $('qr').src = p.qr; $('pairUrl').textContent = p.url; $('pairDialog').showModal(); } catch (e) { toast(e.message); } };
$('closePair').onclick = () => $('pairDialog').close();
if (token) connect();
