// State
let ws = null;
let reqId = 0;
let connected = false;
let currentRunId = null;
let pendingCallbacks = {};
let sessionTokens = { input: 0, output: 0, thinking: 0, cache_read: 0, cache_write: 0 };
let currentModel = '';
let currentSession = 'main';
let streamingMsgEl = null;
let streamingText = '';
let connectSent = false;

// DOM
const $messages = document.getElementById('messages');
const $input = document.getElementById('chat-input');
const $form = document.getElementById('chat-form');
const $sendBtn = document.getElementById('send-btn');
const $abortBtn = document.getElementById('abort-btn');
const $typing = document.getElementById('typing-indicator');
const $sessionSelect = document.getElementById('session-select');
const $modelName = document.getElementById('model-name');
const $connStatus = document.getElementById('conn-status');

// Settings
function getSettings() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const defaultWs = proto + '//' + location.host + '/ws';
  let wsUrl = localStorage.getItem('chat-ws-url') || '';
  // Migrate old cross-origin default to same-origin proxy
  if (!wsUrl || wsUrl === 'wss://openclaw.twray.dev' || wsUrl === 'ws://openclaw.twray.dev') {
    wsUrl = defaultWs;
    localStorage.setItem('chat-ws-url', wsUrl);
  }
  return { wsUrl, token: localStorage.getItem('chat-token') || '' };
}
function saveSettings() {
  const urlVal = document.getElementById('set-ws-url').value.trim();
  // Only store if user changed from default
  if (urlVal) localStorage.setItem('chat-ws-url', urlVal);
  localStorage.setItem('chat-token', document.getElementById('set-token').value.trim());
  reconnect();
}
function loadSettings() {
  const s = getSettings();
  document.getElementById('set-ws-url').value = s.wsUrl;
  document.getElementById('set-token').value = s.token;
}

// Views
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (name === 'usage') loadUsageView();
}

// WebSocket
function nextId() { return 'r' + (++reqId); }

function sendConnectFrame() {
  const s = getSettings();
  const id = nextId();
  ws.send(JSON.stringify({
    type: 'req', id, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'chat-hub', version: '1.0.0', platform: 'web', mode: 'operator' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [], commands: [], permissions: {},
      auth: { token: s.token },
      locale: 'en-US',
      userAgent: 'chat-hub/1.0.0'
    }
  }));
  pendingCallbacks[id] = (res) => {
    if (res.ok) {
      connected = true;
      setConnStatus('Connected', 'connected');
      if (res.payload && res.payload.model) { currentModel = res.payload.model; $modelName.textContent = currentModel; }
      loadHistory();
      loadSessions();
    } else {
      setConnStatus('Auth failed: ' + (res.error?.message || 'unknown'), 'disconnected');
    }
  };
  connectSent = true;
}

function connect() {
  const s = getSettings();
  if (!s.token) { setConnStatus('No token configured', 'disconnected'); return; }
  
  setConnStatus('Connecting...', 'connecting');
  connectSent = false;
  const wsUrl = s.wsUrl.replace(/\/$/, '');
  let url = wsUrl;
  if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
  else if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;

  try { ws = new WebSocket(url); } catch(e) { setConnStatus('Invalid URL', 'disconnected'); return; }
  
  ws.onopen = () => {
    setConnStatus('Handshaking...', 'connecting');
    // Wait for connect.challenge event, or send connect after a short timeout
    // in case the gateway doesn't send a challenge (e.g. allowInsecureAuth)
    setTimeout(() => {
      if (!connectSent && ws && ws.readyState === 1) {
        sendConnectFrame();
      }
    }, 2000);
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    
    // Handle connect.challenge before we've sent connect
    if (msg.type === 'event' && msg.event === 'connect.challenge' && !connectSent) {
      sendConnectFrame();
      return;
    }

    if (msg.type === 'res' && pendingCallbacks[msg.id]) {
      pendingCallbacks[msg.id](msg);
      delete pendingCallbacks[msg.id];
    } else if (msg.type === 'event') {
      handleEvent(msg);
    }
  };

  ws.onclose = (e) => {
    connected = false;
    connectSent = false;
    const reason = e.reason || '';
    const code = e.code || 0;
    if (reason.includes('pairing')) {
      setConnStatus('Pairing required — approve in OpenClaw CLI', 'disconnected');
    } else if (code === 1006) {
      setConnStatus('Connection failed (network/proxy error)', 'disconnected');
    } else {
      setConnStatus('Disconnected' + (code ? ' [' + code + ']' : '') + (reason ? ': ' + reason : ''), 'disconnected');
    }
    setTimeout(reconnect, 5000);
  };
  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
  };
}

function reconnect() {
  if (ws) { try { ws.close(); } catch {} }
  ws = null; connected = false; connectSent = false;
  connect();
}

function sendReq(method, params) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1 || !connected) { resolve({ ok: false, error: { message: 'Not connected' } }); return; }
    const id = nextId();
    pendingCallbacks[id] = resolve;
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => { if (pendingCallbacks[id]) { delete pendingCallbacks[id]; resolve({ ok: false, error: { message: 'Timeout' } }); } }, 30000);
  });
}

function setConnStatus(text, cls) {
  $connStatus.textContent = text;
  $connStatus.className = cls;
}

// Events
function handleEvent(msg) {
  const { event, payload } = msg;
  if (event === 'chat') handleChatEvent(payload);
  else if (event === 'agent') handleAgentEvent(payload);
  else if (event === 'tick') {} // keepalive
}

function handleChatEvent(p) {
  if (!p) return;
  if (p.messages) {
    p.messages.forEach(m => addMessage(m.role, m.content || m.text, m));
  }
}

function handleAgentEvent(p) {
  if (!p) return;
  const stream = p.stream || p.type;
  
  if (stream === 'assistant' || p.kind === 'assistant') {
    const delta = p.delta || p.text || '';
    if (delta) {
      if (!streamingMsgEl) {
        streamingMsgEl = createMsgEl('assistant');
        streamingText = '';
        $typing.classList.add('hidden');
        $sendBtn.classList.add('hidden');
        $abortBtn.classList.remove('hidden');
      }
      streamingText += delta;
      streamingMsgEl.querySelector('.msg-content').textContent = streamingText;
      scrollToBottom();
    }
  } else if (stream === 'tool' || p.kind === 'tool') {
    const toolEl = document.createElement('details');
    toolEl.className = 'tool-card';
    const name = p.name || p.tool || 'tool';
    toolEl.innerHTML = `<summary>🔧 ${esc(name)}</summary><pre>${esc(JSON.stringify(p.args || p.input || p.params || '', null, 2))}</pre>`;
    if (streamingMsgEl) {
      streamingMsgEl.appendChild(toolEl);
    } else {
      $messages.appendChild(toolEl);
    }
    scrollToBottom();
  } else if (stream === 'lifecycle' || p.kind === 'lifecycle') {
    const phase = p.phase || p.action || p.lifecycle || '';
    if (phase === 'start' || phase === 'started') {
      currentRunId = p.runId || null;
      $typing.classList.remove('hidden');
      $sendBtn.classList.add('hidden');
      $abortBtn.classList.remove('hidden');
    } else if (phase === 'end' || phase === 'ended' || phase === 'error') {
      finishStreaming(p);
    }
  }
  
  if (p.usage) updateUsage(p.usage);
  if (p.model) { currentModel = p.model; $modelName.textContent = currentModel; }
}

function finishStreaming(p) {
  currentRunId = null;
  $typing.classList.add('hidden');
  $sendBtn.classList.remove('hidden');
  $abortBtn.classList.add('hidden');

  if (p && p.usage) {
    updateUsage(p.usage);
    if (streamingMsgEl) {
      const u = p.usage;
      const tokDiv = document.createElement('div');
      tokDiv.className = 'msg-tokens';
      tokDiv.textContent = `IN: ${fmt(u.inputTokens||u.input_tokens||0)} | OUT: ${fmt(u.outputTokens||u.output_tokens||0)} | THINK: ${fmt(u.thinkingTokens||u.thinking_tokens||0)} | CACHE: ${fmt(u.cacheReadTokens||u.cache_read_tokens||0)}R/${fmt(u.cacheWriteTokens||u.cache_write_tokens||0)}W`;
      streamingMsgEl.appendChild(tokDiv);
    }
    logUsage(p.usage, p.model || currentModel);
  }
  streamingMsgEl = null;
  streamingText = '';
}

function updateUsage(u) {
  const inp = u.inputTokens || u.input_tokens || 0;
  const out = u.outputTokens || u.output_tokens || 0;
  const think = u.thinkingTokens || u.thinking_tokens || 0;
  const cr = u.cacheReadTokens || u.cache_read_tokens || 0;
  const cw = u.cacheWriteTokens || u.cache_write_tokens || 0;
  sessionTokens.input += inp;
  sessionTokens.output += out;
  sessionTokens.thinking += think;
  sessionTokens.cache_read += cr;
  sessionTokens.cache_write += cw;
  
  setTokenBar('tb-input', sessionTokens.input);
  setTokenBar('tb-output', sessionTokens.output);
  setTokenBar('tb-thinking', sessionTokens.thinking);
  setTokenBar('tb-cache-read', sessionTokens.cache_read);
  setTokenBar('tb-cache-write', sessionTokens.cache_write);
}

function setTokenBar(id, val) {
  const el = document.getElementById(id);
  el.textContent = fmt(val);
  el.className = 'token-val ' + (val > 500000 ? 'red' : val > 100000 ? 'yellow' : 'green');
}

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// Messages
function createMsgEl(role) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = `<div class="msg-sender">${role === 'assistant' ? '🦞 Lobsty' : role}</div><div class="msg-content"></div>`;
  $messages.appendChild(div);
  scrollToBottom();
  return div;
}

function addMessage(role, text, meta) {
  const div = createMsgEl(role);
  div.querySelector('.msg-content').textContent = text || '';
  if (meta && meta.usage) {
    const u = meta.usage;
    const tokDiv = document.createElement('div');
    tokDiv.className = 'msg-tokens';
    tokDiv.textContent = `IN: ${fmt(u.inputTokens||u.input_tokens||0)} | OUT: ${fmt(u.outputTokens||u.output_tokens||0)}`;
    div.appendChild(tokDiv);
  }
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  requestAnimationFrame(() => { $messages.scrollTop = $messages.scrollHeight; });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Send message
$form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $input.value.trim();
  if (!text || !connected) return;
  $input.value = '';
  $input.style.height = 'auto';
  addMessage('user', text);
  
  const res = await sendReq('chat.send', { text, session: currentSession });
  if (!res.ok) {
    addMessage('system', 'Error: ' + (res.error?.message || 'Failed to send'));
  }
});

// Auto-resize textarea
$input.addEventListener('input', () => {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
});
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $form.dispatchEvent(new Event('submit')); }
});

// Abort
function abortRun() {
  if (currentRunId) sendReq('chat.abort', { runId: currentRunId });
  finishStreaming(null);
}

// History
async function loadHistory() {
  const res = await sendReq('chat.history', { limit: 200 });
  if (res.ok && res.payload) {
    $messages.innerHTML = '';
    const msgs = res.payload.messages || res.payload || [];
    (Array.isArray(msgs) ? msgs : []).forEach(m => {
      addMessage(m.role, m.content || m.text, m);
    });
  }
}

// Sessions
async function loadSessions() {
  const res = await sendReq('sessions.list', {});
  if (res.ok && res.payload) {
    const sessions = res.payload.sessions || res.payload || [];
    $sessionSelect.innerHTML = '';
    if (!Array.isArray(sessions) || sessions.length === 0) {
      $sessionSelect.innerHTML = '<option value="main">main</option>';
    } else {
      sessions.forEach(s => {
        const key = s.key || s.id || s.name || 'main';
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = key;
        if (key === currentSession) opt.selected = true;
        $sessionSelect.appendChild(opt);
      });
    }
  }
}
$sessionSelect.addEventListener('change', () => {
  currentSession = $sessionSelect.value;
  sessionTokens = { input: 0, output: 0, thinking: 0, cache_read: 0, cache_write: 0 };
  ['tb-input','tb-output','tb-thinking','tb-cache-read','tb-cache-write'].forEach(id => setTokenBar(id, 0));
  loadHistory();
});

// Usage API
async function logUsage(usage, model) {
  const u = {
    session_key: currentSession,
    model: model || currentModel,
    input_tokens: usage.inputTokens || usage.input_tokens || 0,
    output_tokens: usage.outputTokens || usage.output_tokens || 0,
    thinking_tokens: usage.thinkingTokens || usage.thinking_tokens || 0,
    cache_read_tokens: usage.cacheReadTokens || usage.cache_read_tokens || 0,
    cache_write_tokens: usage.cacheWriteTokens || usage.cache_write_tokens || 0,
    cost_estimate: usage.cost || 0,
    message_preview: (streamingText || '').slice(0, 100)
  };
  try { await fetch('/api/usage/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }); } catch {}
}

async function loadUsageView() {
  try {
    const [summaryRes, dailyRes, recentRes] = await Promise.all([
      fetch('/api/usage/summary').then(r => r.json()),
      fetch('/api/usage/daily?days=30').then(r => r.json()),
      fetch('/api/usage/recent').then(r => r.json())
    ]);

    const t = summaryRes.total || {};
    document.getElementById('usage-summary').innerHTML = `
      <div class="usage-stat"><div class="val">${fmt(parseInt(t.input)||0)}</div><div class="lbl">Total Input</div></div>
      <div class="usage-stat"><div class="val">${fmt(parseInt(t.output)||0)}</div><div class="lbl">Total Output</div></div>
      <div class="usage-stat"><div class="val">${fmt(parseInt(t.thinking)||0)}</div><div class="lbl">Total Thinking</div></div>
      <div class="usage-stat"><div class="val">${fmt(parseInt(t.cache_read)||0)}</div><div class="lbl">Cache Read</div></div>
      <div class="usage-stat"><div class="val">${fmt(parseInt(t.cache_write)||0)}</div><div class="lbl">Cache Write</div></div>
      <div class="usage-stat"><div class="val">${parseInt(t.messages)||0}</div><div class="lbl">Messages</div></div>
    `;

    if (dailyRes && dailyRes.length) {
      renderDailyChart(document.getElementById('usage-chart'), dailyRes);
    }

    const rl = document.getElementById('recent-list');
    rl.innerHTML = (recentRes || []).map(r => `
      <div class="recent-item">
        <span class="tokens">IN:${fmt(r.input_tokens)} OUT:${fmt(r.output_tokens)}</span>
        <span style="margin-left:8px;color:var(--text-dim)">${r.model || ''}</span>
        <div class="preview">${esc(r.message_preview || '')}</div>
      </div>
    `).join('');
  } catch {}
}

// Init
loadSettings();
connect();
showView('chat');
