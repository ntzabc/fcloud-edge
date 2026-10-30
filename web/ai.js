/* ============================================================
   小f · 前端对话面板
   ------------------------------------------------------------
   原生 JS，独立文件。挂一个悬浮按钮 + 全屏面板。

   为什么用 fetch + 手写 SSE 解析而不用 EventSource：
   EventSource 只能 GET，不能带请求体（我们的历史和图片都在 body 里），
   所以用 fetch 读 ReadableStream，按行解析 data:。

   为什么不用 WebSocket：局域网自用，HTTP 够；WS 要额外握手和心跳，
   收益只有"双向"，我们实际只有"服务端→前端"这一向。
   ============================================================ */

'use strict';

const A = {
  open: false, busy: false, msgs: [], images: [],
  status: null, model: null, abort: null, node: null
};

// ---------------------------------------------------------------- 挂载

function mountAI() {
  if ($('#aiFab')) return;
  const btn = document.createElement('button');
  btn.id = 'aiFab';
  btn.className = 'aifab';
  btn.setAttribute('aria-label', '小f 助手');
  btn.innerHTML = '<span class="aifab__face">f</span><span class="aifab__dot"></span>';
  btn.onclick = () => toggleAI(true);
  document.body.appendChild(btn);

  const el = document.createElement('div');
  el.id = 'aiPanel';
  el.className = 'aipanel';
  el.hidden = true;
  el.innerHTML = `
    <div class="aipanel__bar">
      <button class="iconbtn" id="aiClose" aria-label="关闭">✕</button>
      <div class="aipanel__title"><b>小f</b><span id="aiState">连接中…</span></div>
      <button class="iconbtn" id="aiNew" aria-label="新对话" title="新对话">＋</button>
    </div>
    <div class="aipanel__log" id="aiLog"></div>
    <div class="aipanel__chips" id="aiChips"></div>
    <div class="aipanel__foot">
      <div class="aipanel__imgs" id="aiImgs" hidden></div>
      <button class="iconbtn iconbtn--sm" id="aiPick" aria-label="加图片" title="加一张云盘里的图片">🖼</button>
      <textarea id="aiInput" rows="1" placeholder="问问小f：把去年的体检报告找出来"></textarea>
      <button class="aipanel__send" id="aiSend" aria-label="发送">↑</button>
    </div>`;
  document.body.appendChild(el);

  $('#aiClose').onclick = () => toggleAI(false);
  $('#aiNew').onclick = newChat;
  $('#aiSend').onclick = () => send();
  $('#aiPick').onclick = pickImage;
  const ta = $('#aiInput');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el.addEventListener('click', e => {
    if (e.target === el) toggleAI(false);
  });
}

// ---------------------------------------------------------------- 开关

function toggleAI(on) {
  A.open = on;
  const p = $('#aiPanel');
  if (!p) return;
  p.hidden = !on;
  $('#aiFab').classList.toggle('is-hidden', on);
  if (on) {
    loadAIStatus();
    if (!A.msgs.length) greet();
    setTimeout(() => $('#aiInput').focus(), 120);
  } else {
    stopStream();
  }
}

async function loadAIStatus() {
  try {
    const st = await api('/api/ai/status');
    A.status = st;
    A.model = st.model;
    const bits = [];
    bits.push(st.configured ? '已就绪' : '缺少 API Key');
    bits.push(st.can_write ? '可读可改' : '只读模式');
    $('#aiState').textContent = bits.join(' · ');
    if (!st.configured) {
      addAI('小f', '还没配置 API Key。到「统计」页底部填一个 OpenRouter 的 Key，' +
        '或者我先用不了。', 'warn');
    }
  } catch (e) {
    $('#aiState').textContent = '不可用';
  }
}

// ---------------------------------------------------------------- 消息

function addAI(who, text, kind) {
  const log = $('#aiLog');
  const d = document.createElement('div');
  d.className = 'aimsg aimsg--' + (who === '我' ? 'me' : 'ai') + (kind ? ' is-' + kind : '');
  const av = document.createElement('div');
  av.className = 'aimsg__av';
  av.textContent = who === '我' ? (S.me ? S.me.initial : '我') : 'f';
  const b = document.createElement('div');
  b.className = 'aimsg__bubble';
  b.innerHTML = mdText(text);
  d.appendChild(av);
  d.appendChild(b);
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return b;
}

function addToolNote(txt, ok) {
  const log = $('#aiLog');
  const d = document.createElement('div');
  d.className = 'aitool' + (ok === false ? ' is-bad' : '');
  d.textContent = '⚙ ' + txt;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function greet() {
  addAI('小f',
    '我是小f，能帮你找文件、读内容、整理空间、建文件夹和写笔记。\n' +
    '直接说人话就行，比如「去年的体检报告在哪」「把桌面上的图片归到照片/2026」。');
  const chips = [
    '空间用了多少',
    '最近谁加了文件',
    '帮我建个「2026 旅行」文件夹',
    '回收站里有什么'
  ];
  const box = $('#aiChips');
  box.innerHTML = '';
  chips.forEach(c => {
    const b = document.createElement('button');
    b.textContent = c;
    b.onclick = () => { $('#aiInput').value = c; send(); };
    box.appendChild(b);
  });
}

function newChat() {
  stopStream();
  A.msgs = [];
  A.images = [];
  $('#aiLog').innerHTML = '';
  renderAIImgs();
  greet();
}

// ---------------------------------------------------------------- 图片（多模态）

function pickImage() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (f.size > 12 * 1024 * 1024) { toast('这张图太大了，换一张'); return; }
    if (A.images.length >= 3) { toast('最多 3 张'); return; }
    // 先选目的地，取消就直接退出，别让 Promise 挂在那儿干等
    let box;
    try {
      box = await pickDestination();
    } catch (e) { toast(e.message); return; }
    if (box === null) return;
    try {
      toast('上传中…');
      const up = await uploadBytes(new File([f], f.name, { type: f.type }), box);
      A.images.push(up.id);
      renderAIImgs();
      toast('已附上这张图');
    } catch (e) { toast(e.message); }
  };
  inp.click();
}

/** 小文件直传：走和主页上传一样的三段接口，但不进上传队列、不刷进度条。 */
async function uploadBytes(file, parentId) {
  const up = await api('/api/upload/init', 'POST', {
    parent_id: parentId || 0,
    name: file.name,
    total_size: file.size,
    mime: file.type || '',
    encrypted: false
  });
  for (let i = 0; i < up.total_chunks; i++) {
    const from = i * up.chunk_size;
    const to = Math.min(file.size, from + up.chunk_size);
    await api(`/api/upload/${up.upload_id}/part/${i}`, 'PUT', file.slice(from, to));
  }
  return api(`/api/upload/${up.upload_id}/finish`, 'POST', {});
}

/** 上传前的目标文件夹弹窗：返回 parent_id，取消返回 null。
 *  之前这个 Promise 只在「点中某个按钮」时 resolve，用户点背景关掉弹层就永远
 *  挂着 —— await 永不返回，也不报错，看起来就是「上传没反应」。 */
function pickDestination() {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    // 弹层被关掉（含点背景）时兜底成取消
    sheetOnClose = () => finish(null);

    (async () => {
      const list = [['云盘根目录', 0]];
      try {
        const d = await api('/api/files', 'GET');
        (d.items || [])
          .filter(n => n.kind === 'folder')
          .forEach(f => list.push([f.name, f.id]));
      } catch (e) {
        toast(e.message);
        closeSheet();
        return finish(null);
      }
      if (done) return;
      const html = '<h3 class="sheet__title">图片存到哪里？</h3>' +
        '<div class="menu">' +
        list.map((n, i) => `<button data-i="${i}">📁 ${esc(n[0])}</button>`).join('') +
        '</div><p class="mini">先放到这里，之后可以在文件页里移动。</p>';
      openSheet(html, p => {
        $$('.menu button', p).forEach((b, i) => {
          b.onclick = () => { closeSheet(); finish(list[i][1]); };
        });
      });
      // openSheet 会清掉上一次的 closeSheet 钩子，这里重设一次
      sheetOnClose = () => finish(null);
    })();
  });
}

function renderAIImgs() {
  const box = $('#aiImgs');
  box.hidden = !A.images.length;
  box.innerHTML = '';
  A.images.forEach((id, i) => {
    const b = document.createElement('div');
    b.className = 'aiimg';
    b.innerHTML = `<img src="/api/file/${id}?inline=1" alt="">` +
      `<button aria-label="移除">✕</button>`;
    b.querySelector('button').onclick = () => { A.images.splice(i, 1); renderAIImgs(); };
    box.appendChild(b);
  });
}

// ---------------------------------------------------------------- 发消息

function stopStream() {
  if (A.abort) { try { A.abort.abort(); } catch (_) {} A.abort = null; }
  A.busy = false;
  $('#aiSend').textContent = '↑';
  $('#aiSend').classList.remove('is-stop');
}

async function send() {
  if (A.busy) { stopStream(); return; }
  const ta = $('#aiInput');
  const text = ta.value.trim();
  if (!text && !A.images.length) return;

  // 字段名必须和 push 时一致 —— 之前这里写的是 m.text，
  // 结果每轮历史都是 undefined，被后端 _brief_history 全当成空内容丢掉，
  // 表现就是「小f 每次都失忆」，但不报任何错。
  const history = A.msgs.slice(-20).map(m => ({ role: m.role, content: m.content }));
  const images = A.images.slice();
  addAI('我', text || '（看这张图）');
  A.msgs.push({ role: 'user', content: text });
  ta.value = '';
  ta.style.height = 'auto';
  A.images = [];
  renderAIImgs();
  $('#aiChips').innerHTML = '';

  A.busy = true;
  $('#aiSend').textContent = '■';
  $('#aiSend').classList.add('is-stop');
  const bubble = addAI('小f', '');
  // is-typing 没有 has-text 时显示三点动画；一旦有正文就只留光标
  bubble.classList.add('is-typing');

  const ac = new AbortController();
  A.abort = ac;
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history, images }),
      signal: ac.signal
    });
    if (!res.ok) {
      let err = 'HTTP ' + res.status;
      try { err = (await res.json()).error || err; } catch (_) {}
      throw new Error(err);
    }
    let out = '';
    for await (const ev of readSSE(res.body)) {
      if (ev.ev === 'delta') {
        out += ev.data.text || '';
        bubble.classList.add('has-text');
        bubble.innerHTML = mdText(out) + '<span class="cursor">▍</span>';
        const lg = $('#aiLog');
        lg.scrollTop = lg.scrollHeight;
      } else if (ev.ev === 'tool') {
        // 工具跑的时候已经出过字了，点动画不再显示，只提示正在做什么
        bubble.classList.remove('is-typing');
        addToolNote(ev.data.summary || ev.data.name, ev.data.ok);
        if (!out) bubble.classList.add('is-typing');
      } else if (ev.ev === 'done') {
        out = ev.data.text || out;
      } else if (ev.ev === 'error') {
        throw new Error(ev.data.error || '未知错误');
      }
    }
    bubble.classList.remove('is-typing');
    if (out.trim()) {
      bubble.innerHTML = mdText(out);
      A.msgs.push({ role: 'assistant', content: out });
    } else {
      bubble.innerHTML = '<span class="dim">（没说话）</span>';
    }
  } catch (e) {
    bubble.classList.remove('is-typing');
    if (e.name === 'AbortError') {
      bubble.innerHTML = '<span class="dim">（已停止）</span>';
    } else {
      bubble.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
    }
  } finally {
    stopStream();
  }
}

/** 解析 SSE 流。返回异步迭代器。 */
async function* readSSE(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev = '', data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { yield { ev, data: JSON.parse(data) }; } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------- 极简 Markdown

function mdText(s) {
  const lines = String(s == null ? '' : s).split('\n');
  let html = '', inList = '', listTag = '';
  const inline = t => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((node:)(\d+)\)/g,
      '<a href="#" data-node="$3">$1</a>');
  for (let ln of lines) {
    const li = ln.match(/^\s*[-*·]\s+(.*)$/);
    const ol = ln.match(/^\s*(\d+)[.、]\s+(.*)$/);
    if (li || ol) {
      // 记下这次开的到底是 ul 还是 ol：闭合时必须原样还回去。
      // 之前闭合写死 '</ul>'，遇到有序列表就会输出 <ol>…</ul>。
      if (!inList) { listTag = ol ? 'ol' : 'ul'; html += '<' + listTag + '>'; inList = '1'; }
      html += '<li>' + inline((li ? li[1] : ol[2])) + '</li>';
      continue;
    }
    if (inList) { html += '</' + listTag + '>'; inList = ''; }
    if (!ln.trim()) continue;
    html += '<p>' + inline(ln) + '</p>';
  }
  if (inList) html += '</' + listTag + '>';
  return html;
}

// 点消息里的文件引用 → 直接跳到那个文件
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[data-node]');
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.node;
  toggleAI(false);
  openSheet(`<h3 class="sheet__title">文件</h3><div id="aiFile">载入中…</div>`, async p => {
    try {
      const r = await api('/api/node/' + id + '/preview');
      const n = r.node;
      p.querySelector('#aiFile').innerHTML =
        `<div class="mini"><b>${esc(n.name)}</b></div>` +
        (r.kind === 'text'
          ? `<pre class="mini-pre">${esc((r.text || '').slice(0, 4000))}</pre>`
          : `<div class="mini">这是一个 ${esc(r.kind)} 文件</div>`);
    } catch (err) {
      p.querySelector('#aiFile').innerHTML = `<div class="bad">${esc(err.message)}</div>`;
    }
  });
});