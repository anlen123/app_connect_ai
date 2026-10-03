const $ = id => document.getElementById(id);
const emptyState = $('emptyState'), emptyNew = $('emptyNew');
const running = new Set(['starting', 'running', 'waiting']);
const statusNames = { idle: '就绪', starting: '正在启动 agent', running: '正在处理', waiting: '等待你的选择', completed: '已完成', cancelled: '已停止', error: '出现错误', offline: '进程已关闭 · 历史只读' };
function stored(key, local = false) { try { return (local ? localStorage : sessionStorage).getItem(key) || ''; } catch { return ''; } }
function store(key, value, local = false) { try { const storage = local ? localStorage : sessionStorage; if (value) storage.setItem(key, value); else storage.removeItem(key); } catch { /* Storage can be disabled; the current tab still works. */ } }
let token = stored('pairToken') || stored('pairToken', true);
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (fragmentToken) { token = fragmentToken; history.replaceState(null, '', location.pathname); }
let ws, connected = false, retry, authTimer, retryCount = 0, selected = stored('selectedSession');
let sessions = [], agents = [], root = '', requestIndex = 0, selectionGeneration = 0, renderedSeq = 0, modelSignature = '', createBusy = false, deleteTarget, renameTarget, pairInfo, pairMode = 'web';
// Request IDs only correlate messages on one socket. They are NOT credentials.
// Date + counter works on ordinary LAN HTTP, where crypto.randomUUID is unavailable.
const requestPrefix = Date.now().toString(36);
const requests = new Map(), histories = new Map(), rows = new Map(), choiceNodes = new Map(), drafts = new Map(), inflight = new Set(), tombstones = new Set();
$('rememberToken').checked = Boolean(stored('pairToken', true));
$('currentAddress').textContent = location.origin;
function toast(text) { $('toast').textContent = String(text); $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500); }
function formError(id, error) { $(id).textContent = error || ''; $(id).hidden = !error; }
function current() { return sessions.find(s => s.id === selected); }
function historyFor(id) { if (!histories.has(id)) histories.set(id, { events: new Map(), choices: new Map(), loaded: false }); return histories.get(id); }
function closeDialog(id) { if ($(id).open) $(id).close(); }
function api(type, fields = {}) {
  if (!connected || ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('服务尚未连接，请等待连接恢复'));
  const id = `${requestPrefix}-${++requestIndex}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('操作尚未确认，请查看会话状态，不要重复发送任务')); }, 65000);
    requests.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ type, id, ...fields }));
  });
}
function rejectRequests(message) { for (const p of requests.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } requests.clear(); }
async function action(type, fields = {}) {
  const sessionId = fields.sessionId || selected, key = `${sessionId}:${type}`;
  if (inflight.has(key)) throw new Error('该操作正在处理，请稍候');
  inflight.add(key); renderControls();
  try { return await api(type, { ...fields, sessionId }); }
  finally { inflight.delete(key); renderControls(); }
}
function connect() {
  clearTimeout(retry); clearTimeout(authTimer); connected = false;
  rejectRequests('连接已重新建立，未确认的操作不会自动重发');
  const old = ws; ws = null; old?.close();
  $('connection').textContent = '○ 连接中'; $('loginButton').disabled = true; renderControls();
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); ws = socket;
  authTimer = setTimeout(() => { if (ws === socket && !connected) { formError('loginError', '连接超时，请确认 Linux 服务可访问、配对码正确'); socket.close(); } }, 12000);
  socket.onopen = () => { if (ws === socket) socket.send(JSON.stringify({ type: 'auth', token })); };
  socket.onmessage = ({ data }) => {
    if (ws !== socket) return;
    let record; try { record = JSON.parse(data); } catch { toast('服务器返回了无法解析的消息'); return; }
    try { receive(record); } catch (e) { toast(`处理服务器消息失败：${e.message}`); }
  };
  socket.onerror = () => { if (ws === socket && !connected) formError('loginError', '无法连接 Linux 服务，请检查网址、端口和网络'); };
  socket.onclose = e => {
    if (ws !== socket) return;
    clearTimeout(authTimer); connected = false; $('loginButton').disabled = false;
    rejectRequests('连接已断开，未确认的操作不会自动重发'); renderControls();
    if (e.code === 1008) {
      const invalid = e.reason === 'Invalid pairing token';
      if (invalid) { token = ''; store('pairToken', ''); store('pairToken', '', true); }
      $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true;
      formError('loginError', invalid ? '配对码不正确或已失效，请输入 Linux 终端显示的新配对码' : `服务拒绝连接：${e.reason || '请检查访问地址'}`);
      $('connection').textContent = '○ 未连接'; return;
    }
    $('connection').textContent = '○ 断开 · 重连中';
    if (token) retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retryCount++, 4)));
  };
}
function receive(r) {
  if (r.type === 'hello') {
    connected = true; retryCount = 0; clearTimeout(authTimer); $('loginButton').disabled = false; formError('loginError', '');
    store('pairToken', token); if ($('rememberToken').checked) store('pairToken', token, true);
    agents = r.agents || [{ id: 'pi', name: 'Pi', available: true }, { id: 'codex', name: 'Codex', available: true }]; root = r.root;
    $('root').textContent = `Linux 根目录 · ${root}`; $('version').textContent = `LAN Agent ${r.version}`;
    $('connection').textContent = '● 已连接'; $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    $('apkDownload').hidden = !r.apkAvailable; $('notify').hidden = !(window.isSecureContext && 'Notification' in window);
    populateAgents(); updateSessions(r.sessions); const id = selected;
    if (id) selectSession(id).catch(e => { if (connected) toast(e.message); }); else renderEmpty();
  } else if (r.type === 'sessions') updateSessions(r.sessions);
  else if (r.type === 'session_deleted') {
    tombstones.add(r.sessionId); histories.delete(r.sessionId); drafts.delete(r.sessionId);
    updateSessions(sessions.filter(s => s.id !== r.sessionId));
    if (deleteTarget === r.sessionId) closeDialog('deleteDialog');
  } else if (r.type === 'response') {
    const p = requests.get(r.id); if (!p) return;
    clearTimeout(p.timer); requests.delete(r.id);
    if (r.ok) p.resolve(r.data); else p.reject(new Error(r.error || '操作失败'));
  } else if (r.type === 'event' && !tombstones.has(r.sessionId)) {
    const h = historyFor(r.sessionId); if (h.events.has(r.seq)) return;
    h.events.set(r.seq, r); if (h.events.size > 10000) h.events.delete(h.events.keys().next().value);
    applyChoice(h, r);
    if (r.sessionId === selected) { renderEvent(r); renderChoices(); }
    if (r.event === 'choice' || r.event === 'completed') announce(r);
  }
}
function updateSessions(next) {
  sessions = next || [];
  const exists = sessions.some(s => s.id === selected);
  if (!exists) {
    if (selected) { drafts.set(selected, $('prompt').value); selectionGeneration++; }
    selected = [...sessions].reverse().find(s => s.ready)?.id || sessions.at(-1)?.id || '';
    store('selectedSession', selected); resetTimeline(); $('prompt').value = drafts.get(selected) || '';
    if (selected && connected) selectSession(selected).catch(e => { if (connected) toast(e.message); });
    else renderEmpty();
  }
  renderSessions(); renderControls();
}
function populateAgents() {
  const saved = $('agent').value || stored('lastAgent'); $('agent').replaceChildren();
  for (const a of agents) { const option = document.createElement('option'); option.value = a.id; option.textContent = `${a.name || a.id} · ${a.available ? 'Linux 已安装' : '未安装'}`; option.disabled = !a.available; $('agent').append(option); }
  $('agent').value = agents.some(a => a.id === saved && a.available) ? saved : agents.find(a => a.available)?.id || '';
  agentHint();
}
function agentHint() {
  const a = agents.find(a => a.id === $('agent').value);
  $('agentHint').textContent = a?.available ? `${a.description || a.name}。请确保已在运行此服务的 Linux 用户下登录/配置模型。` : 'Linux 服务未发现可用 agent。安装 pi 或 codex、确认 PATH 后重启服务。';
  $('createButton').disabled = createBusy || !connected || !a?.available;
}
function renderSessions() {
  const query = $('sessionSearch').value.toLowerCase(), scroll = $('sessions').scrollTop;
  $('sessions').replaceChildren(); $('sessionCount').textContent = `${sessions.length} 个会话 · ${sessions.filter(s => s.active).length}/8 个进程`;
  for (const s of [...sessions].reverse().filter(s => `${s.title} ${s.agent}`.toLowerCase().includes(query))) {
    const row = document.createElement('div'); row.className = `session-row ${s.id === selected ? 'active' : ''}`;
    const b = document.createElement('button'); b.className = 'session'; b.dataset.sessionId = s.id;
    const title = document.createElement('span'); title.className = 'session-title'; title.textContent = s.title;
    const meta = document.createElement('small'); meta.textContent = `${s.agent.toUpperCase()} · ${statusNames[s.status] || s.status} · ${s.turns || 0} 轮`;
    b.append(title, meta); b.onclick = () => selectSession(s.id).catch(e => toast(e.message));
    const remove = document.createElement('button'); remove.className = 'session-delete'; remove.textContent = '×'; remove.dataset.sessionId = s.id; remove.setAttribute('aria-label', `删除会话 ${s.title}`); remove.disabled = !connected; remove.onclick = () => showDelete(s.id);
    row.append(b, remove); $('sessions').append(row);
  }
  $('sessions').scrollTop = scroll;
}
function renderControls() {
  const s = current(), busy = s && running.has(s.status), ready = connected && s?.ready;
  $('pair').disabled = !connected; $('newSession').disabled = !connected; emptyNew.disabled = !connected;
  $('title').textContent = s?.title || '选择或新建一个会话'; $('sessionAgent').textContent = s?.agent.toUpperCase() || 'LINUX';
  $('status').textContent = s ? `${statusNames[s.status] || s.status} · ${s.turns || 0} 轮 · ${s.tools || 0} 次工具调用` : '电脑和手机打开同一个网址，操作同一组会话';
  $('workingDirectory').textContent = s ? `目录 · ${s.cwd}` : ''; $('workingDirectory').title = s?.cwd || '';
  $('stop').disabled = !connected || !s?.active || !busy || inflight.has(`${selected}:abort`);
  $('renameSession').disabled = !connected || !s; $('deleteSession').disabled = !connected || !s || inflight.has(`${selected}:delete`);
  $('closeSession').disabled = !connected || !s?.active || inflight.has(`${selected}:close`);
  const hasModels = Boolean(s?.models?.length);
  $('prompt').disabled = !s?.ready; $('send').disabled = !ready || busy || !hasModels || inflight.has(`${selected}:prompt`);
  $('prompt').placeholder = !s ? '先新建一个 pi / Codex 会话' : !s.ready ? '进程已停止或未就绪，请新建会话继续' : busy ? '可以先写下一条消息，任务结束后发送' : '输入问题或任务…';
  $('model').disabled = !ready || busy || !hasModels || inflight.has(`${selected}:model`); $('modelSearch').disabled = $('model').disabled;
  const warning = s && !s.ready ? (s.status === 'starting' ? '正在启动 agent 并加载模型，请稍候。启动失败时请检查 Linux CLI 登录与服务日志。' : '会话进程已停止或启动失败。这里可查看历史，重新聊天请新建会话；也可以删除这条记录。') : s && !hasModels ? '该 agent 没有配置可用模型，请在 Linux 终端登录或配置后重新创建会话。' : '';
  $('sessionWarning').textContent = warning; $('sessionWarning').hidden = !warning;
  $('pending').textContent = inflight.has(`${selected}:model`) ? '正在切换模型…' : inflight.has(`${selected}:prompt`) ? '正在提交…' : '';
  const signature = `${s?.id}:${s?.model}:${s?.models?.length}:${$('modelSearch').value}`;
  if (signature !== modelSignature) {
    modelSignature = signature; const query = $('modelSearch').value.toLowerCase(); $('model').replaceChildren();
    const models = (s?.models || []).filter(m => m.id === s.model || `${m.id} ${m.name}`.toLowerCase().includes(query));
    if (!models.length) { const option = document.createElement('option'); option.textContent = s ? '没有可用模型' : '新建会话后加载模型'; $('model').append(option); }
    for (const m of models) { const option = document.createElement('option'); option.value = m.id; option.textContent = m.name || m.id; $('model').append(option); }
    if (s?.model) $('model').value = s.model;
  }
  agentHint();
}
function resetTimeline() { rows.clear(); choiceNodes.clear(); renderedSeq = 0; $('timeline').replaceChildren(); $('choices').replaceChildren(); $('plan').hidden = true; $('plan').textContent = ''; }
function renderEmpty() { resetTimeline(); $('timeline').append(emptyState); renderControls(); }
function applyChoice(h, e) { if (e.event === 'choice') h.choices.set(e.requestId, e); if (e.event === 'choice_closed') h.choices.delete(e.requestId); }
function applySnapshot(data) {
  if (tombstones.has(data.id)) return;
  const h = historyFor(data.id); for (const e of data.events || []) if (!h.events.has(e.seq)) h.events.set(e.seq, e);
  h.events = new Map([...h.events].sort(([a], [b]) => a - b));
  h.choices = new Map((data.choices || []).map(c => [c.requestId, c]));
  for (const e of h.events.values()) if (e.seq > data.seq) applyChoice(h, e);
  h.loaded = true;
}
async function selectSession(id, snapshot) {
  if (!sessions.some(s => s.id === id)) throw new Error('该会话已删除');
  if (selected && selected !== id) drafts.set(selected, $('prompt').value);
  selected = id; store('selectedSession', id); $('prompt').value = drafts.get(id) || ''; $('modelSearch').value = ''; modelSignature = '';
  setSidebar(false); const generation = ++selectionGeneration;
  if (snapshot) applySnapshot(snapshot);
  renderHistory(); renderSessions(); renderControls();
  if (!snapshot) {
    const data = await api('subscribe', { sessionId: id });
    if (selected !== id || generation !== selectionGeneration || tombstones.has(id)) return;
    applySnapshot(data); renderHistory(); renderControls();
  }
}
function renderHistory() {
  resetTimeline(); const h = histories.get(selected);
  if (!h?.events.size) $('timeline').append(emptyState);
  else for (const e of h.events.values()) renderEvent(e, true);
  if (!$('timeline').children.length) $('timeline').append(emptyState);
  renderChoices(); $('timeline').scrollTop = $('timeline').scrollHeight;
}
function renderEvent(e, replay = false) {
  if (e.seq <= renderedSeq) return; renderedSeq = e.seq;
  if (['choice', 'choice_closed', 'model', 'status'].includes(e.event)) return;
  if (e.event === 'plan') { $('plan').hidden = false; $('plan').textContent = (e.steps || []).map(s => `${s.status === 'completed' ? '✓' : ['inProgress', 'in_progress'].includes(s.status) ? '◉' : '○'} ${s.step}`).join('\n'); return; }
  if (emptyState.parentNode === $('timeline')) emptyState.remove();
  const channel = e.channel || e.event, key = e.key ? `${channel}:${e.key}` : `event:${e.seq}`;
  let row = rows.get(key); const nearBottom = $('timeline').scrollHeight - $('timeline').scrollTop - $('timeline').clientHeight < 100;
  if (!row) {
    const collapsible = ['tool', 'tool_output', 'progress', 'diagnostic'].includes(channel), el = document.createElement(collapsible ? 'details' : 'div'); el.className = `entry ${channel}`;
    const label = document.createElement(collapsible ? 'summary' : 'span'); label.className = 'label'; label.textContent = `${channel.toUpperCase()} / ${new Date(e.timestamp).toLocaleTimeString()}`;
    const body = document.createElement('div'); body.className = 'entry-body'; el.append(label, body); $('timeline').append(el); row = { body, el, label }; rows.set(key, row);
  }
  const text = e.text ?? (e.event === 'completed' ? `任务 ${statusNames[e.status] || e.status}${e.error ? '\n' + JSON.stringify(e.error) : ''}` : e.event === 'tool' ? `${e.name} · ${e.status}\n${JSON.stringify(e.detail, null, 2)}` : JSON.stringify(e.detail ?? e));
  if (e.event === 'delta' || e.event === 'tool_output') row.body.textContent += text; else row.body.textContent = text;
  if (e.event === 'tool') {
    let state = '更新';
    if (e.status === 'start') state = '运行中';
    else if (e.status === 'end') state = e.isError ? '失败' : '完成';
    row.el.open = e.status === 'start'; row.label.textContent = `${e.name} · ${state}`;
  }
  if (nearBottom || replay) $('timeline').scrollTop = $('timeline').scrollHeight;
}
function renderChoices() {
  const pending = histories.get(selected)?.choices || new Map();
  for (const [id, node] of choiceNodes) if (!pending.has(id)) { node.remove(); choiceNodes.delete(id); }
  for (const [id, c] of pending) {
    if (choiceNodes.has(id)) continue;
    const box = document.createElement('div'); box.className = 'choice'; box.dataset.requestId = id;
    const title = document.createElement('h3'); title.textContent = c.title || '需要你的选择'; box.append(title);
    if (c.message) { const detail = document.createElement('pre'); detail.textContent = c.message; box.append(detail); }
    const questionSession = selected;
    const answer = async value => {
      const buttons = [...box.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
      try { await action('answer', { sessionId: questionSession, requestId: id, answer: value }); }
      catch (e) { toast(e.message); buttons.forEach(b => b.disabled = false); }
    };
    const button = (text, value) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = () => answer(value); box.append(b); };
    if (c.kind === 'confirm') { button('确认', { value: true }); button('拒绝', { value: false }); }
    else if (c.kind === 'questions') {
      const fields = [];
      for (const q of c.questions || []) {
        const label = document.createElement('label'); label.textContent = q.question; const input = document.createElement('input'); input.type = q.isSecret ? 'password' : 'text'; input.placeholder = '填写回答或点选下方选项'; label.append(input); box.append(label); fields.push([q.id, input]);
        for (const option of q.options || []) { const b = document.createElement('button'); b.type = 'button'; b.textContent = `${option.label} · ${option.description}`; b.onclick = () => input.value = option.label; box.append(b); }
      }
      const b = document.createElement('button'); b.textContent = '提交答案'; b.onclick = () => { if (fields.some(([, input]) => !input.value.trim())) { toast('请回答所有问题'); return; } answer({ answers: Object.fromEntries(fields.map(([key, input]) => [key, [input.value]])) }); }; box.append(b);
    } else if (['input', 'editor', 'elicitation'].includes(c.kind)) {
      const input = document.createElement('textarea'); input.value = c.prefill || ''; input.placeholder = c.kind === 'elicitation' ? '输入符合请求 schema 的 JSON 对象' : '输入回答'; box.append(input);
      const b = document.createElement('button'); b.textContent = '提交'; b.onclick = () => { try { answer(c.kind === 'elicitation' ? { content: JSON.parse(input.value) } : { value: input.value }); } catch (e) { toast(`输入格式错误：${e.message}`); } }; box.append(b);
    } else {
      const labels = { accept: '允许本次', decline: '拒绝', cancel: '取消任务' };
      for (const option of c.options || []) button(c.kind === 'approval' ? labels[option] || option : option, { value: option });
    }
    if (!['approval', 'questions'].includes(c.kind)) button('放弃回答', { cancelled: true });
    choiceNodes.set(id, box); $('choices').append(box);
  }
}
function announce(e) {
  const s = sessions.find(s => s.id === e.sessionId); if (!s) return;
  const title = e.event === 'choice' ? '需要你的选择' : e.status === 'completed' ? '任务已完成' : '任务已结束';
  document.title = `${e.event === 'choice' ? '⏳' : '✓'} ${title} · ${s.title}`;
  if (window.isSecureContext && 'Notification' in window && Notification.permission === 'granted') {
    try { const n = new Notification(title, { body: s.title, tag: `${s.id}:${e.event}` }); n.onclick = () => { window.focus(); selectSession(s.id).catch(err => toast(err.message)); n.close(); }; } catch { /* Mobile browsers can restrict system notifications; in-page state remains visible. */ }
  }
}
function setSidebar(open) { $('sidebar').classList.toggle('open', open); $('sidebarBackdrop').hidden = !open; $('sidebarToggle').setAttribute('aria-expanded', String(open)); }
function openCreate() { formError('createError', ''); $('cwdHint').textContent = `相对根目录 ${root}；“.” 表示根目录，也可填写其中现有文件夹的绝对路径。`; agentHint(); setSidebar(false); $('createDialog').showModal(); }
function showDelete(id) {
  const s = sessions.find(s => s.id === id); if (!s) return;
  deleteTarget = id; $('deleteTitle').textContent = `${s.agent.toUpperCase()} / ${s.title}`; formError('deleteError', ''); $('confirmDelete').disabled = false; $('confirmDelete').textContent = '确认删除'; $('deleteDialog').showModal();
}
async function copy(value) {
  if (window.isSecureContext && navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(value); toast('已复制'); return; } catch { /* Use the LAN HTTP fallback. */ } }
  const field = document.createElement('textarea'); field.value = value; field.setAttribute('aria-hidden', 'true'); document.body.append(field); field.select();
  const ok = document.execCommand('copy'); field.remove(); toast(ok ? '已复制' : '浏览器限制复制，请长按连接地址手动复制');
}
function displayPair(mode) {
  pairMode = mode; $('pairWebTab').classList.toggle('active', mode === 'web'); $('pairAppTab').classList.toggle('active', mode === 'app');
  $('pairWebTab').setAttribute('aria-pressed', String(mode === 'web')); $('pairAppTab').setAttribute('aria-pressed', String(mode === 'app'));
  $('qr').src = mode === 'web' ? pairInfo.webQr : pairInfo.qr;
  $('pairUrl').value = mode === 'web' ? pairInfo.browserUrl : pairInfo.url;
  $('pairHelp').textContent = mode === 'web' ? '手机相机扫码，直接打开同一个网页并登录。可选择 agent、新建聊天、切换模型、删除会话，不需要 APK。' : '可选 Android APP 扫描此二维码连接同一个 Linux 服务。APP 可使用系统前台监听和后台通知。';
}
$('loginForm').onsubmit = e => { e.preventDefault(); token = $('token').value.trim(); if (!$('rememberToken').checked) store('pairToken', '', true); formError('loginError', ''); connect(); };
$('logout').onclick = () => { token = ''; connected = false; clearTimeout(retry); clearTimeout(authTimer); const old = ws; ws = null; old?.close(); rejectRequests('已退出登录'); store('pairToken', ''); store('pairToken', '', true); sessions = []; histories.clear(); selected = ''; $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('connection').textContent = '未连接'; $('loginButton').disabled = false; for (const id of ['createDialog', 'deleteDialog', 'pairDialog', 'renameDialog']) closeDialog(id); renderControls(); };
$('sidebarToggle').onclick = () => setSidebar(!$('sidebar').classList.contains('open')); $('sidebarBackdrop').onclick = () => setSidebar(false);
$('newSession').onclick = openCreate; emptyNew.onclick = openCreate; $('closeCreate').onclick = () => closeDialog('createDialog'); $('cancelCreate').onclick = () => closeDialog('createDialog');
$('agent').onchange = () => { store('lastAgent', $('agent').value); agentHint(); };
$('createForm').onsubmit = async e => {
  e.preventDefault(); if (createBusy) return; createBusy = true; agentHint(); formError('createError', ''); $('createButton').textContent = '启动 agent、加载模型…';
  try { const s = await api('create', { agent: $('agent').value, cwd: $('cwd').value.trim() || '.', title: $('sessionName').value.trim() }); await selectSession(s.id, s); closeDialog('createDialog'); $('sessionName').value = ''; }
  catch (e) { formError('createError', e.message); }
  finally { createBusy = false; $('createButton').textContent = '创建并开始聊天 ↗'; agentHint(); }
};
$('sessionSearch').oninput = renderSessions; $('modelSearch').oninput = renderControls;
$('model').onchange = async () => { const id = selected, model = $('model').value; try { await action('model', { sessionId: id, model }); } catch (e) { toast(e.message); } finally { modelSignature = ''; renderControls(); } };
$('prompt').oninput = () => { if (selected) drafts.set(selected, $('prompt').value); };
$('promptForm').onsubmit = async e => {
  e.preventDefault(); const id = selected, text = $('prompt').value; if (!text.trim() || $('send').disabled) return;
  try { await action('prompt', { sessionId: id, text }); if (selected === id && $('prompt').value === text) { $('prompt').value = ''; drafts.delete(id); } }
  catch (e) { toast(e.message); }
};
$('prompt').onkeydown = e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey && matchMedia('(pointer:fine)').matches)) { e.preventDefault(); $('promptForm').requestSubmit(); } };
$('stop').onclick = async () => { try { await action('abort'); } catch (e) { toast(e.message); } };
$('closeSession').onclick = async () => { try { await action('close'); } catch (e) { toast(e.message); } };
$('deleteSession').onclick = () => showDelete(selected); $('cancelDelete').onclick = () => closeDialog('deleteDialog');
$('confirmDelete').onclick = async () => { const id = deleteTarget; $('confirmDelete').disabled = true; $('confirmDelete').textContent = '停止进程并删除…'; formError('deleteError', ''); try { await action('delete', { sessionId: id }); closeDialog('deleteDialog'); toast('会话和本服务的历史记录已删除'); } catch (e) { formError('deleteError', e.message); $('confirmDelete').disabled = false; $('confirmDelete').textContent = '确认删除'; } };
$('renameSession').onclick = () => { renameTarget = selected; $('renameTitle').value = current()?.title || ''; formError('renameError', ''); $('renameDialog').showModal(); }; $('cancelRename').onclick = () => closeDialog('renameDialog');
$('renameForm').onsubmit = async e => { e.preventDefault(); try { await action('rename', { sessionId: renameTarget, title: $('renameTitle').value.trim() }); closeDialog('renameDialog'); } catch (e) { formError('renameError', e.message); } };
$('pair').onclick = async () => { $('pair').disabled = true; try { pairInfo = await api('pair'); displayPair('web'); $('pairDialog').showModal(); } catch (e) { toast(e.message); } finally { $('pair').disabled = !connected; } };
$('pairWebTab').onclick = () => displayPair('web'); $('pairAppTab').onclick = () => displayPair('app'); $('closePair').onclick = () => closeDialog('pairDialog'); $('copyPair').onclick = () => copy(pairMode === 'web' ? pairInfo.browserUrl : pairInfo.payload);
$('notify').onclick = async () => { try { const permission = await Notification.requestPermission(); toast(permission === 'granted' ? '已允许浏览器通知' : '浏览器未允许通知，仍可在网页中查看状态'); } catch (e) { toast(e.message); } };
window.addEventListener('online', () => { if (token && !connected) connect(); }); window.addEventListener('focus', () => document.title = 'LAN Agent · Linux AI 控制台');
if (token) connect();
