/* ============================================================
   Family Cloud · 前端
   ------------------------------------------------------------
   原生 JS，没有构建步骤、没有框架。改完刷新就生效。
   ------------------------------------------------------------
   分片上传与断点续传：
     1. POST /api/upload/init       服务端回「从第几块开始」
     2. PUT  /api/upload/<id>/part/<n>  逐块上传（用 File.slice，不会把大文件读进内存）
     3. POST /api/upload/<id>/finish    收尾
   任何一步断了，重新调 init 或 GET /api/upload/<id> 就能知道该补哪几块。
   ============================================================ */

'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const S = {
  me: null, members: [], space: null, cfg: {}, crypto: {},
  view: 'files', parent: 0, crumbs: [], items: [],
  filter: { kind: '', category: '' }, query: '',
  uploads: new Map(), encryptedNext: false
};

// ---------------------------------------------------------------- 网络

async function api(path, method = 'GET', body) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      opt.body = body;
      opt.headers['Content-Type'] = 'application/octet-stream';
    } else {
      opt.body = JSON.stringify(body);
      opt.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(path, opt);
  let data = {};
  try { data = await res.json(); } catch (_) { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error(data.error || ('请求失败 ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

async function putBytes(path, blob, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await api(path, 'PUT', blob);
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

// ---------------------------------------------------------------- 小工具

function fmtSize(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000), now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
const pad = n => (n < 10 ? '0' : '') + n;

const CAT_ICON = {
  '照片': '🖼', '视频': '🎬', '音频': '🎵', '文档': '📄',
  '表格': '📊', '压缩包': '🗜', '其他': '📁'
};

function iconFor(n) {
  if (n.kind === 'folder') return '📁';
  const ext = (n.name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', heic: '🖼', webp: '🖼',
    mp4: '🎬', mov: '🎬', m4v: '🎬', avi: '🎬', mkv: '🎬',
    mp3: '🎵', m4a: '🎵', wav: '🎵', flac: '🎵',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
    ppt: '📙', pptx: '📙', zip: '🗜', rar: '🗜', '7z': '🗜',
    txt: '📄', md: '📝', csv: '📊', json: '🧾'
  };
  return map[ext] || CAT_ICON[n.category] || '📄';
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
}

// ---------------------------------------------------------------- 弹层

let sheetOnClose = null;
function openSheet(html, onMount) {
  $('#sheetPanel').innerHTML = '<div class="sheet__grip"></div>' + html;
  $('#sheet').hidden = false;
  document.body.classList.add('lock');
  if (onMount) onMount($('#sheetPanel'));
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetPanel').innerHTML = '';
  document.body.classList.remove('lock');
  if (sheetOnClose) { const f = sheetOnClose; sheetOnClose = null; f(); }
}
$('#sheetScrim').addEventListener('click', closeSheet);

function confirmSheet(title, sub, okText, danger, onOk) {
  openSheet(
    `<h3 class="sheet__title">${esc(title)}</h3>
     <p class="sheet__sub">${esc(sub || '')}</p>
     <div class="sheet__actions">
       <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="cfOk">${esc(okText)}</button>
       <button class="btn btn--ghost" id="cfNo">取消</button>
     </div>`,
    p => {
      $('#cfOk', p).onclick = () => { closeSheet(); onOk(); };
      $('#cfNo', p).onclick = closeSheet;
    });
}

// ================================================================ 启动

async function boot() {
  let b;
  try { b = await api('/api/bootstrap'); }
  catch (e) { $('#gateSub').textContent = '连不上服务器：' + e.message; return; }

  S.cfg = b.config || {};
  S.crypto = b.crypto || {};

  if (!b.initialized) {
    $('#setupForm').hidden = false;
    $('#gateSub').textContent = '第一次使用，先建一个管理员账号';
    $('#setupForm').onsubmit = async ev => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      try {
        await api('/api/setup', 'POST', fd);
        fd.password = '';
        await doLogin(fd.username, fd.password);
      } catch (e) { toast(e.message); }
    };
    return;
  }

  if (b.me) { enterApp(b.me, b.members, b.space); return; }

  $('#loginForm').hidden = false;
  $('#gateSub').textContent = b.space ? '「' + b.space.name + '」· 一家人的文件都在这里' : '一家人的文件都在这里';
  $('#loginForm').onsubmit = async ev => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(ev.target));
    $('#loginErr').textContent = '';
    try { await doLogin(fd.username, fd.password); }
    catch (e) { $('#loginErr').textContent = e.message; }
  };
}

async function doLogin(username, password) {
  const r = await api('/api/login', 'POST', { username, password });
  enterApp(r.me, r.members, r.space);
}

async function enterApp(me, members, space) {
  S.me = me; S.members = members || []; S.space = space;
  mountAI();
  $('#gate').hidden = true;
  $('#app').hidden = false;
  $('#trashDays').textContent = S.cfg.trash_days || 30;
  buildFilterChips();
  await loadHome();
  switchView(S.view);
  loadPendingUploads();
}

async function loadHome() {
  try {
    const h = await api('/api/home');
    S.space = h.space;
    renderQuickbar(h);
  } catch (e) { /* 静默 */ }
}

// ---------------------------------------------------------------- 标签页

function switchView(v) {
  S.view = v;
  $$('.view').forEach(el => { el.hidden = el.id !== 'view' + v[0].toUpperCase() + v.slice(1); });
  $$('.tab').forEach(t => t.classList.toggle('is-on', t.dataset.view === v));
  $('#main').scrollTop = 0;
  if (v === 'files') loadDir(S.parent);
  if (v === 'search') { if (S.query) runSearch(); }
  if (v === 'trash') loadTrash();
  if (v === 'members') loadMembers();
  if (v === 'settings') loadStats();
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
$('#btnSearch').addEventListener('click', () => switchView('search'));
$('#btnHome').addEventListener('click', () => { switchView('files'); });
$('#btnMore').addEventListener('click', openMenu);

// ---------------------------------------------------------------- 快捷分类

function renderQuickbar(home) {
  const cats = (home && home.by_category) || [];
  const total = cats.reduce((a, c) => a + c.count, 0) || 1;
  const bar = $('#quickbar');
  bar.innerHTML = '';
  const mk = (name, icon, count, on) => {
    const b = document.createElement('button');
    b.className = 'quick' + (on ? ' is-on' : '');
    b.innerHTML = `<div class="quick__n">${icon}</div><div class="quick__k">${esc(name)}</div>` +
                  (count != null ? `<div class="quick__k">${count} 个</div>` : '');
    b.onclick = on;
    bar.appendChild(b);
  };
  mk('全部', '🏠', null, S.filter.category === '').onclick = () => {
    S.filter.category = ''; switchView('search'); $('#q').value = ''; S.query = ''; runSearch();
  };
  cats.forEach(c => {
    if (!c.count) return;
    const w = Math.max(12, Math.round(c.bytes / Math.max(1, home.storage.physical_bytes) * 100));
    mk(c.category, CAT_ICON[c.category] || '📁', c.count, S.filter.category === c.category).onclick = () => {
      S.filter.category = c.category;
      S.query = ''; $('#q').value = '';
      switchView('search'); runSearch();
    };
  });
}

// ================================================================ 文件浏览

async function loadDir(parentId) {
  try {
    const r = await api('/api/files?parent=' + parentId);
    S.parent = parentId;
    S.crumbs = r.breadcrumbs;
    S.items = r.items;
    S.space = r.space;
    renderCrumbs();
    renderFiles();
  } catch (e) {
    if (e.status === 401) return location.reload();
    toast(e.message);
  }
}

function renderCrumbs() {
  const box = $('#crumbs');
  box.innerHTML = '';
  S.crumbs.forEach((c, i) => {
    if (i) box.appendChild(Object.assign(document.createElement('i'), { textContent: '›' }));
    const b = document.createElement('button');
    b.textContent = c.name;
    b.onclick = () => loadDir(c.id);
    box.appendChild(b);
  });
  $('#crumbTitle').textContent = S.crumbs.length ? S.crumbs[S.crumbs.length - 1].name : '全部文件';
  $('#crumbPath').textContent = S.crumbs.map(c => c.name).filter(n => n !== '全部文件').join(' / ');
  $('#btnHome').hidden = S.parent === 0;
}

function renderFiles() {
  const grid = $('#grid');
  grid.innerHTML = '';
  const items = S.items;
  $('#emptyFiles').hidden = items.length > 0;

  items.forEach(n => {
    if (n.kind === 'folder') {
      const c = document.createElement('button');
      c.className = 'card';
      c.innerHTML =
        `<div class="card__icon">📁</div>
         <div class="card__name">${esc(n.name)}</div>
         <div class="card__badges">${n.encrypted ? '<span class="badge badge--lock">加密</span>' : ''}</div>
         <div class="card__sub">${n.starred ? '★ ' : ''}点一下进去</div>`;
      c.onclick = () => loadDir(n.id);
      c.oncontextmenu = ev => { ev.preventDefault(); nodeMenu(n, 0); };
      grid.appendChild(c);
      return;
    }
    grid.appendChild(fileCard(n));
  });
}

function fileCard(n, row) {
  const el = document.createElement('button');
  el.className = row ? 'row-item' : 'card';
  const badges =
    (n.encrypted ? '<span class="badge badge--lock">🔒 加密</span>' : '') +
    (n.starred ? '<span class="badge badge--star">★</span>' : '') +
    (n.shares ? '<span class="badge badge--share">👥 ' + n.shares + '</span>' : '');

  if (row) {
    el.innerHTML =
      `<div class="row-item__icon">${iconFor(n)}</div>
       <div class="row-item__body">
         <div class="row-item__name">${esc(n.name)}</div>
         <div class="row-item__sub">${fmtSize(n.size)} · ${esc(n.uploader_name || '')} · ${fmtTime(n.modified_at)}</div>
         ${n.snippet ? `<div class="row-item__snippet">${esc(n.snippet)}</div>` : ''}
       </div>
       <div class="card__badges">${badges}</div>`;
  } else {
    el.innerHTML =
      `<div class="card__icon">${iconFor(n)}</div>
       <div class="card__name">${esc(n.name)}</div>
       <div class="card__badges">${badges}</div>
       <div class="card__sub">${fmtSize(n.size)} · ${fmtTime(n.modified_at)}</div>`;
  }
  el.onclick = () => openNode(n);
  el.oncontextmenu = ev => { ev.preventDefault(); nodeMenu(n, 1); };
  return el;
}

async function openNode(n) {
  if (n.kind === 'folder') return loadDir(n.id);
  await showPreview(n);
}

function nodeMenu(n, evIdx) {
  const isFile = n.kind === 'file';
  const rows = [];
  rows.push(['👁 预览 / 详情', () => showPreview(n)]);
  if (isFile) rows.push(['⬇️ 下载', () => { location.href = '/api/file/' + n.id; }]);
  if (isFile) rows.push(['🔗 复制下载链接', () => copyLink(n)]);
  if (isFile) rows.push(['🕘 版本历史', () => showVersions(n)]);
  if (isFile) rows.push(['👥 共享设置', () => showShares(n)]);
  rows.push([n.starred ? '☆ 取消收藏' : '★ 收藏', async () => {
    await api('/api/node/' + n.id, 'PATCH', { starred: !n.starred });
    refreshCurrent();
  }]);
  rows.push(['📁 新建文件夹', () => newFolder(S.parent)]);
  rows.push(['✏️ 重命名', () => renameNode(n)]);
  rows.push(['🗑 移到回收站', () => {
    confirmSheet('移到回收站？', `「${n.name}」和它里面的东西都会进回收站，${S.cfg.trash_days} 天内可以还原。`,
      '移到回收站', true, async () => {
        await api('/api/node/' + n.id, 'DELETE');
        toast('已移到回收站');
        refreshCurrent();
      });
  }]);

  openSheet(`<h3 class="sheet__title">${esc(n.name)}</h3>
    <p class="sheet__sub">${n.kind === 'folder' ? '文件夹' : fmtSize(n.size) + ' · ' + (n.uploader_name || '')}</p>
    <div class="menu">${rows.map((r, i) =>
      `<button data-i="${i}">${r[0]}</button>`).join('')}</div>`,
    p => {
      $$('.menu button', p).forEach((b, i) => {
        b.onclick = () => { closeSheet(); rows[i][1](); };
      });
    });
}

function copyLink(n) {
  const url = location.origin + '/api/file/' + n.id;
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('链接已复制'), () => toast(url));
  else prompt('复制这个链接：', url);
}

// ---------------------------------------------------------------- 文件操作

async function newFolder(parentId) {
  const name = prompt('新文件夹名字', '新建文件夹');
  if (!name) return;
  try {
    await api('/api/folder', 'POST', { parent_id: parentId, name });
    refreshCurrent();
    toast('已创建');
  } catch (e) { toast(e.message); }
}

async function renameNode(n) {
  const name = prompt('改成什么名字', n.name);
  if (!name || name === n.name) return;
  try {
    await api('/api/node/' + n.id, 'PATCH', { name });
    refreshCurrent();
  } catch (e) { toast(e.message); }
}

function refreshCurrent() {
  if (S.view === 'files') loadDir(S.parent);
  if (S.view === 'search') runSearch();
  if (S.view === 'trash') loadTrash();
}

// ---------------------------------------------------------------- 预览

async function showPreview(n) {
  let pv;
  try { pv = await api('/api/node/' + n.id + '/preview'); }
  catch (e) { toast(e.message); return; }

  if (pv.locked) { unlockThen(() => showPreview(n)); return; }

  let box = '';
  if (pv.kind === 'image') box = `<div class="preview-box"><img src="${pv.url}" alt=""></div>`;
  else if (pv.kind === 'video') box = `<div class="preview-box"><video src="${pv.url}" controls playsinline></video></div>`;
  else if (pv.kind === 'audio') box = `<div class="preview-box"><audio src="${pv.url}" controls></audio></div>`;
  else if (pv.kind === 'pdf') box = `<div class="preview-box"><iframe src="${pv.url}"></iframe></div>`;
  else if (pv.kind === 'text') {
    const t = pv.text || '';
    const more = pv.truncated ? '\n\n……（内容太长，只显示前面一部分）' : '';
    box = `<div class="preview-text">${esc(t + more) || '（空文件）'}</div>`;
  } else box = `<div class="preview-box"><div style="font-size:52px">${iconFor(n)}</div></div>`;

  const v = pv.node;
  openSheet(
    `<h3 class="sheet__title">${esc(v.name)}</h3>
     <p class="sheet__sub">${fmtSize(v.size)} · ${esc(v.uploader_name || '')} 上传 · ${fmtTime(v.modified_at)}</p>
     ${box}
     <dl class="kv">
       <dt>分类</dt><dd>${esc(v.category)}${v.tags ? ' · 标签 ' + esc(v.tags) : ''}</dd>
       ${v.note ? `<dt>备注</dt><dd>${esc(v.note)}</dd>` : ''}
       <dt>加密</dt><dd>${v.encrypted ? '🔒 是（磁盘上存的是密文）' : '否'}</dd>
       <dt>内容块</dt><dd>${v.chunk_count} 块</dd>
       <dt>下载次数</dt><dd>${v.download_count || 0}</dd>
     </dl>
     <div class="sheet__actions">
       <a class="btn btn--primary" href="/api/file/${v.id}" download>下载</a>
       <button class="btn btn--ghost" id="pvNew">上传新版本</button>
     </div>`,
    p => {
      $('#pvNew', p).onclick = () => { closeSheet(); pickFiles({ replace_node_id: v.id, enc: !!v.encrypted }); };
    });
}

// ---------------------------------------------------------------- 版本

async function showVersions(n) {
  let r;
  try { r = await api('/api/node/' + n.id + '/versions'); }
  catch (e) { toast(e.message); return; }

  const items = r.versions.map(v =>
    `<div class="ver-item">
       <div class="ver-item__body">
         <div class="ver-item__n">第 ${v.seq} 版${v.is_current ? ' · 当前' : ''}</div>
         <div class="ver-item__d">${fmtSize(v.size)} · ${fmtTime(v.created_at)} · ${esc(v.author || '')}${v.note ? ' · ' + esc(v.note) : ''}</div>
       </div>
       ${v.is_current ? '' : `<button class="btn btn--sm" data-v="${v.id}">还原</button>`}
     </div>`).join('');

  openSheet(`<h3 class="sheet__title">版本历史</h3>
    <p class="sheet__sub">${esc(n.name)} · 同一份内容只存一份，所以留历史几乎不占空间</p>
    ${items || '<p>没有历史版本</p>'}`,
    p => {
      $$('button[data-v]', p).forEach(b => {
        b.onclick = async () => {
          try {
            await api('/api/node/' + n.id + '/rollback', 'POST', { version_id: Number(b.dataset.v) });
            closeSheet(); toast('已还原到那一版'); refreshCurrent();
          } catch (e) { toast(e.message); }
        };
      });
    });
}

// ---------------------------------------------------------------- 共享

async function showShares(n) {
  const r = await api('/api/node/' + n.id + '/shares');
  const others = S.members.filter(m => m.id !== S.me.id);
  const cur = r.items.map(s =>
    `<div class="ver-item"><div class="ver-item__body">
       <div class="ver-item__n">${esc(s.display_name)}</div>
       <div class="ver-item__d">${esc(s.permission_label)}</div>
     </div>
     <select data-p="${s.grantee_id}">
       <option value="read"${s.permission === 'read' ? ' selected' : ''}>只读</option>
       <option value="write"${s.permission === 'write' ? ' selected' : ''}>可编辑</option>
       <option value="own"${s.permission === 'own' ? ' selected' : ''}>可托管</option>
     </select>
     <button class="btn btn--sm" data-x="${s.grantee_id}">取消</button>
   </div>`).join('');

  openSheet(`<h3 class="sheet__title">共享给家人</h3>
    <p class="sheet__sub">${esc(n.name)}</p>
    ${cur || '<p class="sheet__sub">还没有共享给任何人</p>'}
    <div class="filters__grid">
      <label class="field"><span>成员</span><select id="shWho">
        ${others.map(m => `<option value="${m.id}">${esc(m.display_name)}（${esc(m.role_label)}）</option>`).join('')}
      </select></label>
      <label class="field"><span>权限</span><select id="shPerm">
        <option value="read">只读（能看能下）</option>
        <option value="write">可编辑</option>
        <option value="own">可托管（也能删）</option>
      </select></label>
    </div>
    <div class="row">
      <button class="btn btn--primary" id="shGo">共享</button>
      <button class="btn btn--ghost" id="shTree">连同里面的内容一起共享</button>
    </div>`,
    p => {
      $('#shGo', p).onclick = () => doShare(n, false);
      $('#shTree', p).onclick = () => doShare(n, true);
      $$('button[data-x]', p).forEach(b => b.onclick = async () => {
        await api(`/api/node/${n.id}/share/${b.dataset.x}`, 'DELETE');
        closeSheet(); showShares(n); toast('已取消共享');
      });
      $$('select[data-p]', p).forEach(s => s.onchange = async () => {
        await api('/api/node/' + n.id + '/share', 'POST',
          { grantee_id: Number(s.dataset.p), permission: s.value });
        toast('权限已更新');
      });
    });

  async function doShare(node, withChildren) {
    try {
      await api('/api/node/' + node.id + '/share', 'POST', {
        grantee_id: Number($('#shWho').value),
        permission: $('#shPerm').value,
        with_children: withChildren
      });
      closeSheet(); showShares(node); toast('已共享');
    } catch (e) { toast(e.message); }
  }
}

// ================================================================ 上传

function pickFiles(opts) {
  opts = opts || {};
  const inp = $('#filePick');
  inp.replaceWith(inp.cloneNode(true));
  const fresh = $('#filePick');
  fresh.multiple = !opts.replace_node_id;
  fresh.onchange = () => {
    const list = Array.from(fresh.files || []);
    list.forEach(f => startUpload(f, opts));
    fresh.value = '';
  };
  fresh.click();
}

async function startUpload(file, opts) {
  opts = opts || {};
  const uid = 'u' + Date.now() + Math.random().toString(36).slice(2, 6);
  S.uploads.set(uid, { name: file.name, pct: 0, note: '准备中…', err: '', file, opts });
  renderUploads();

  let up;
  try {
    up = await api('/api/upload/init', 'POST', {
      parent_id: opts.parent_id != null ? opts.parent_id : S.parent,
      name: file.name, total_size: file.size,
      mime: file.type || '', encrypted: !!opts.enc,
      replace_node_id: opts.replace_node_id || null
    });
  } catch (e) {
    const u = S.uploads.get(uid); u.err = e.message; renderUploads();
    toast(e.message);
    return;
  }

  const rec = S.uploads.get(uid);
  rec.upload_id = up.upload_id;
  const have = new Set(up.received);
  rec.note = `分 ${up.total_chunks} 块，已完成 ${have.size} 块`;
  rec.pct = up.percent;
  renderUploads();

  try {
    for (let i = 0; i < up.total_chunks; i++) {
      if (have.has(i)) continue;
      const from = i * up.chunk_size;
      const to = Math.min(file.size, from + up.chunk_size);
      const blob = file.slice(from, to);
      await putBytes(`/api/upload/${up.upload_id}/part/${i}`, blob);
      rec.pct = Math.round((i + 1) / up.total_chunks * 100);
      rec.note = `正在传第 ${i + 1}/${up.total_chunks} 块`;
      renderUploads();
    }
    await api(`/api/upload/${up.upload_id}/finish`, 'POST', {});
    rec.note = '完成'; rec.pct = 100;
    renderUploads();
    setTimeout(() => { S.uploads.delete(uid); renderUploads(); }, 1600);
    toast('「' + file.name + '」已上传');
    refreshCurrent();
  } catch (e) {
    rec.err = e.message + '（重新选同一个文件就能接着传）';
    renderUploads();
  }
}

function renderUploads() {
  const box = $('#uploads');
  const list = Array.from(S.uploads.values());
  box.hidden = list.length === 0;
  box.innerHTML = list.map(u => `
    <div class="up">
      <div class="up__head">
        <span class="up__name">${esc(u.name)}</span>
        <span class="up__pct">${u.pct}%</span>
      </div>
      <div class="up__track"><div class="up__fill" style="width:${u.pct}%"></div></div>
      ${u.err ? `<div class="up__err">${esc(u.err)}</div>` : `<div class="up__note">${esc(u.note)}</div>`}
    </div>`).join('');
}

async function loadPendingUploads() {
  try {
    const r = await api('/api/uploads');
    if (!r.items.length) return;
    openSheet(`<h3 class="sheet__title">有没传完的文件</h3>
      <p class="sheet__sub">重新选一下同一个文件，就会从断掉的地方接着传，已经传过的块不会重传。</p>
      <div class="menu">${r.items.map(u =>
        `<button data-u="${u.upload_id}">📤 ${esc(u.name)}<br>
          <small style="color:var(--ink-3)">${u.got}/${u.total_chunks} 块已传 · ${fmtSize(u.total_size)}</small></button>`).join('')}
      </div>`,
      p => {
        $$('button[data-u]', p).forEach(b => b.onclick = () => {
          closeSheet();
          const inp = $('#filePick');
          inp.replaceWith(inp.cloneNode(true));
          const fresh = $('#filePick');
          fresh.onchange = () => {
            const f = (fresh.files || [])[0];
            fresh.value = '';
            if (f) startUpload(f, {});
          };
          fresh.click();
        });
      });
  } catch (_) {}
}

$('#dropzone').onclick = () => pickFiles({});
$('#filePick').addEventListener('change', function () {
  Array.from(this.files || []).forEach(f => startUpload(f, {}));
  this.value = '';
});

['dragenter', 'dragover'].forEach(ev => $('#dropzone').addEventListener(ev, e => {
  e.preventDefault(); $('#dropzone').classList.add('is-over');
}));
['dragleave', 'drop'].forEach(ev => $('#dropzone').addEventListener(ev, e => {
  e.preventDefault(); $('#dropzone').classList.remove('is-over');
}));
$('#dropzone').addEventListener('drop', e => {
  Array.from(e.dataTransfer.files || []).forEach(f => startUpload(f, {}));
});

// ================================================================ 搜索

function buildFilterChips() {
  const kinds = [['', '全部'], ['file', '文件'], ['folder', '文件夹']];
  $('#chipKind').innerHTML = kinds.map(([k, n]) =>
    `<button class="chip${S.filter.kind === k ? ' is-on' : ''}" data-kind="${k}">${n}</button>`).join('');
  $$('#chipKind .chip').forEach(b => b.onclick = () => {
    S.filter.kind = b.dataset.kind; buildFilterChips(); runSearch();
  });

  const cats = [['照片', '🖼'], ['视频', '🎬'], ['音频', '🎵'], ['文档', '📄'],
                ['表格', '📊'], ['压缩包', '🗜'], ['其他', '📁']];
  $('#chipCat').innerHTML = cats.map(([k, i]) =>
    `<button class="chip${S.filter.category === k ? ' is-on' : ''}" data-cat="${k}">${i} ${k}</button>`).join('');
  $$('#chipCat .chip').forEach(b => b.onclick = () => {
    S.filter.category = S.filter.category === b.dataset.cat ? '' : b.dataset.cat;
    buildFilterChips(); runSearch();
  });

  $('#fUploader').innerHTML = '<option value="">全部成员</option>' +
    S.members.map(m => `<option value="${m.id}">${esc(m.display_name)}</option>`).join('');
}

let searchTimer = null;
$('#q').addEventListener('input', e => {
  S.query = e.target.value;
  $('#qClear').hidden = !S.query;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 260);
});
$('#qClear').addEventListener('click', () => { $('#q').value = ''; S.query = ''; $('#qClear').hidden = true; runSearch(); });
['fSizeMin', 'fSizeMax', 'fUploader', 'fAfter', 'fEnc', 'fStar'].forEach(id =>
  $('#' + id).addEventListener('change', runSearch));

async function runSearch() {
  if (S.view !== 'search') switchView('search');
  const p = new URLSearchParams();
  if (S.query) p.set('q', S.query);
  if (S.filter.kind) p.set('kind', S.filter.kind);
  if (S.filter.category) p.set('category', S.filter.category);
  const mn = $('#fSizeMin').value, mx = $('#fSizeMax').value;
  if (mn) p.set('size_min', mn);
  if (mx) p.set('size_max', mx);
  if ($('#fUploader').value) p.set('uploader', $('#fUploader').value);
  const days = $('#fAfter').value;
  if (days) p.set('after', String(Date.now() / 1000 - Number(days) * 86400));
  if ($('#fEnc').checked) p.set('encrypted', '1');
  if ($('#fStar').checked) p.set('starred', '1');

  try {
    const r = await api('/api/search?' + p.toString());
    const grid = $('#searchGrid');
    grid.innerHTML = '';
    r.items.forEach(n => grid.appendChild(fileCard(n, true)));
    $('#emptySearch').hidden = r.items.length > 0;
    const parts = [];
    if (r.query) parts.push(`「${r.query}」`);
    parts.push(r.total + ' 个结果', r.ms + ' ms');
    if (r.reason) parts.push(r.reason);
    if (S.filter.category) parts.push('分类 ' + S.filter.category);
    $('#searchMeta').textContent = parts.join(' · ');
    if (!r.items.length && S.query && r.suggest && r.suggest.length) {
      $('#searchMeta').innerHTML = '没找到 · 试试：' +
        r.suggest.map(s => `<a href="#" data-s="${esc(s)}" style="color:var(--brand)">${esc(s)}</a>`).join('、');
      $$('#searchMeta a').forEach(a => a.onclick = ev => {
        ev.preventDefault(); $('#q').value = a.dataset.s; S.query = a.dataset.s; runSearch();
      });
    }
  } catch (e) { toast(e.message); }
}

// ================================================================ 回收站

async function loadTrash() {
  try {
    const r = await api('/api/trash');
    const grid = $('#trashGrid');
    grid.innerHTML = '';
    r.items.forEach(n => {
      const el = document.createElement('div');
      el.className = 'row-item';
      el.innerHTML = `<div class="row-item__icon">${n.kind === 'folder' ? '📁' : iconFor(n)}</div>
        <div class="row-item__body">
          <div class="row-item__name">${esc(n.name)}</div>
          <div class="row-item__sub">${fmtSize(n.size)} · ${esc(n.deleted_by_name || '')} 于 ${fmtTime(n.deleted_at)} 删除</div>
        </div>
        <button class="btn btn--sm" data-r="${n.id}">还原</button>
        <button class="btn btn--sm btn--danger" data-p="${n.id}">彻底删除</button>`;
      grid.appendChild(el);
    });
    $('#emptyTrash').hidden = r.items.length > 0;
    $$('[data-r]', grid).forEach(b => b.onclick = async () => {
      try { await api(`/api/node/${b.dataset.r}/restore`, 'POST'); toast('已还原'); loadTrash(); }
      catch (e) { toast(e.message); }
    });
    $$('[data-p]', grid).forEach(b => b.onclick = () => {
      confirmSheet('彻底删除？', '删掉之后数据块会在下次垃圾回收时从磁盘上清掉，无法再找回。',
        '彻底删除', true, async () => {
          try { await api('/api/node/' + b.dataset.p + '?purge=1', 'DELETE'); toast('已彻底删除'); loadTrash(); }
          catch (e) { toast(e.message); }
        });
    });
  } catch (e) { toast(e.message); }
}

$('#btnEmptyTrash').addEventListener('click', () => {
  confirmSheet('清空回收站？', '所有删掉的文件都会被彻底清除，无法找回。', '清空', true, async () => {
    try { await api('/api/trash/empty', 'POST', {}); toast('已清空'); loadTrash(); }
    catch (e) { toast(e.message); }
  });
});

// ================================================================ 成员

async function loadMembers() {
  const grid = $('#memberGrid');
  grid.innerHTML = '';
  S.members.forEach(m => {
    const el = document.createElement('div');
    el.className = 'row-item';
    el.innerHTML = `<div class="avatar" style="background:${esc(m.color)}">${esc(m.initial)}</div>
      <div class="row-item__body">
        <div class="row-item__name">${esc(m.display_name)} ${m.id === S.me.id ? '（我）' : ''}</div>
        <div class="row-item__sub">${esc(m.username)} · ${esc(m.role_label)} · ${m.last_login_at ? '上次登录 ' + fmtTime(m.last_login_at) : '还没登录过'}</div>
      </div>
      ${S.me.can.includes('manage_members') && m.id !== S.me.id ? `<button class="btn btn--sm" data-e="${m.id}">改</button>` : ''}`;
    grid.appendChild(el);
  });
  $$('[data-e]', grid).forEach(b => b.onclick = () => editMember(Number(b.dataset.e)));

  const canManage = S.me.can.includes('manage_members');
  $('#memberForm').hidden = !canManage;
  $('#btnAddMember').onclick = async () => {
    const username = $('#mUser').value.trim(), display_name = $('#mName').value.trim();
    const password = $('#mPass').value, role = $('#mRole').value;
    if (!username || !password) return toast('用户名和密码都要填');
    try {
      await api('/api/members', 'POST', { username, display_name, password, role });
      $('#mUser').value = $('#mName').value = $('#mPass').value = '';
      await reloadMembers();
      toast('已添加成员');
    } catch (e) { toast(e.message); }
  };
}

function editMember(id) {
  const m = S.members.find(x => x.id === id);
  if (!m) return;
  openSheet(`<h3 class="sheet__title">${esc(m.display_name)}</h3>
    <p class="sheet__sub">用户名 ${esc(m.username)}</p>
    <div class="filters__grid">
      <label class="field"><span>显示名字</span><input id="eName" value="${esc(m.display_name)}"></label>
      <label class="field"><span>角色</span><select id="eRole">
        <option value="child"${m.role === 'child' ? ' selected' : ''}>儿童</option>
        <option value="adult"${m.role === 'adult' ? ' selected' : ''}>成人</option>
        <option value="admin"${m.role === 'admin' ? ' selected' : ''}>管理员</option>
      </select></label>
      <label class="field"><span>重设密码（留空不改）</span><input id="ePass" type="password"></label>
    </div>
    <div class="sheet__actions">
      <button class="btn btn--primary" id="eSave">保存</button>
      <button class="btn btn--danger" id="eDel">移除这个成员</button>
    </div>`,
    p => {
      $('#eSave', p).onclick = async () => {
        try {
          await api('/api/member/' + id, 'PATCH', {
            display_name: $('#eName', p).value.trim(),
            role: $('#eRole', p).value,
            password: $('#ePass', p).value || null
          });
          closeSheet(); await reloadMembers(); toast('已保存');
        } catch (e) { toast(e.message); }
      };
      $('#eDel', p).onclick = () => {
        confirmSheet('移除成员？', `「${m.display_name}」将无法再登录，但他创建的文件会保留。`,
          '移除', true, async () => {
            try { await api('/api/member/' + id, 'DELETE'); await reloadMembers(); toast('已移除'); }
            catch (e) { toast(e.message); }
          });
      };
    });
}

async function reloadMembers() {
  const r = await api('/api/members');
  S.members = r.items;
  loadMembers();
}

// ================================================================ 统计与设置

async function loadStats() {
  try {
    const r = await api('/api/stats');
    const st = r.storage;
    $('#stLogical').textContent = fmtSize(st.logical_bytes);
    $('#stPhysical').textContent = fmtSize(st.physical_bytes);
    $('#stSaved').textContent = fmtSize(st.dedup_saved);

    const pct = st.physical_bytes ? Math.min(100, st.dedup_ratio * 100) : 0;
    $('#dedupBar').innerHTML = `
      <h3>去重效果</h3>
      <p>同样的内容只存一份。你家现在有 <b>${st.files}</b> 个文件、<b>${st.versions}</b> 个版本，
      但只占了 <b>${fmtSize(st.physical_bytes)}</b> 磁盘（如果每个文件都单独存要 ${fmtSize(st.logical_bytes)}），
      <b>${st.dedup_ratio} 倍</b>的冗余被省掉了。${st.shared_blobs ? `有 ${st.shared_blobs} 个内容块被多个版本共用。` : ''}</p>
      <div class="bar__track"><div class="bar__fill" style="width:${pct}%"></div></div>
      <p style="margin-top:8px;font-size:12px">回收站里还有 ${st.trash_files} 个文件（${fmtSize(st.trash_bytes)}），
      ${st.encrypted_files} 个加密文件，全库 ${st.blobs} 个内容块。</p>`;

    const maxCat = Math.max(1, ...r.by_category.map(c => c.bytes));
    $('#catBars').innerHTML = r.by_category.map(c => `
      <div class="bar__row">
        <span class="bar__k">${CAT_ICON[c.category] || '📁'} ${esc(c.category)}</span>
        <span class="bar__track"><span class="bar__fill" style="width:${c.bytes / maxCat * 100}%"></span></span>
        <span class="bar__v">${c.count} 个 · ${fmtSize(c.bytes)}</span>
      </div>`).join('');

    const maxMem = Math.max(1, ...r.by_member.map(m => m.bytes));
    $('#memberBars').innerHTML = r.by_member.map(m => `
      <div class="bar__row">
        <span class="bar__k">${esc(m.display_name)}</span>
        <span class="bar__track"><span class="bar__fill" style="width:${m.bytes / maxMem * 100}%"></span></span>
        <span class="bar__v">${m.files} 个 · ${fmtSize(m.bytes)}</span>
      </div>`).join('');

    renderCrypto(r.crypto);
    renderBackups();

    $('#spaceName').value = r.space.name || '';
    $('#spaceQuota').value = r.space.quota_bytes ? (r.space.quota_bytes / 1073741824).toFixed(1) : 0;

    r.audit.items = r.audit.items || [];
    api('/api/audit?limit=40').then(a => {
      $('#auditList').innerHTML = a.items.map(e =>
        `<div class="mini-list__item">
           <time>${fmtTime(e.created_at)}</time>
           <b>${esc(e.actor_name)}</b><span>${esc(e.action_label)}</span>
           <span style="flex:1;color:var(--ink-3);text-align:right">${esc(e.target_name)}</span>
         </div>`).join('') || '<p class="sheet__sub">还没有记录</p>';
    }).catch(() => {});
    renderAISettings();
  } catch (e) { toast(e.message); }
}

// ---------- 小f 设置 ----------
async function renderAISettings() {
  const box = $('#aiBox');
  if (!box) return;
  let st;
  try { st = await api('/api/ai/status'); }
  catch (e) { box.innerHTML = '<p class="sheet__sub">助手模块没加载成功</p>'; return; }

  const canKey = (S.me && S.me.can || []).includes('manage_space');
  box.innerHTML = `
    <p>小f 跑在你自己这台机器上，用的是 OpenRouter 的<b>免费模型</b>，不花钱、不绑卡。
       它能搜索和读你的文件（也可以读图），权限和你本人完全一样 ——
       儿童账号只给只读工具。Key 只存在本机数据库里，不会外发到别处。</p>
    <div class="mini-list">
      <div class="mini-list__item"><span>状态</span><b>${st.configured ? '已配置' : '未配置'}</b></div>
      <div class="mini-list__item"><span>Key</span><span style="color:var(--ink-3)">${esc(st.key_hint || '—')}</span></div>
      <div class="mini-list__item"><span>模型</span><span style="color:var(--ink-3)">${esc(st.model)}</span></div>
      <div class="mini-list__item"><span>你的权限</span><b>${st.can_write ? '可读可改' : '只读'}</b></div>
      <div class="mini-list__item"><span>工具</span><span style="color:var(--ink-3)">${st.tools.length} 个</span></div>
    </div>
    <label class="field" style="margin-top:12px"><span>切换模型（限流时自动换，这里是首选）</span>
      <select id="aiModel">
        ${st.models.map(m => `<option${m === st.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}
      </select></label>
    <button class="btn" id="aiSaveModel"${canKey ? '' : ' disabled'}>保存模型</button>
    ${canKey ? `
    <label class="field" style="margin-top:12px"><span>OpenRouter API Key</span>
      <input id="aiKey" type="password" placeholder="sk-…"></label>
    <div class="row">
      <button class="btn btn--primary" id="aiSaveKey">保存 Key</button>
      <button class="btn btn--ghost" id="aiResetKey">恢复内置</button>
    </div>` : '<p class="sheet__sub" style="margin-top:10px">只有管理员能改 Key。</p>'}
    <button class="btn btn--ghost" id="aiOpen" style="margin-top:12px">打开小f</button>`;

  const saveModel = async () => {
    try { await api('/api/ai/model', 'POST', { model: $('#aiModel').value }); toast('模型已切换'); loadStats(); }
    catch (e) { toast(e.message); }
  };
  $('#aiSaveModel').onclick = saveModel;
  $('#aiOpen').onclick = () => toggleAI(true);
  if (canKey) {
    $('#aiSaveKey').onclick = async () => {
      const k = $('#aiKey').value.trim();
      if (!k) return toast('先填 Key');
      try { await api('/api/ai/key', 'POST', { key: k }); $('#aiKey').value = ''; toast('已保存'); loadStats(); }
      catch (e) { toast(e.message); }
    };
    $('#aiResetKey').onclick = async () => {
      try { await api('/api/ai/key', 'POST', { reset: true }); toast('已恢复内置 Key'); loadStats(); }
      catch (e) { toast(e.message); }
    };
  }
}

function renderCrypto(c) {
  const box = $('#cryptoBox');
  if (!c.configured) {
    box.innerHTML = `<p>还没有设置主口令。设置之后，上传文件时可以勾选「加密」，
      磁盘上存的只有密文，即使别人拿到硬盘也读不出来。</p>
      <button class="btn btn--primary" id="csSet">设置主口令</button>`;
    $('#csSet').onclick = setMaster;
    return;
  }
  if (c.unlocked) {
    box.innerHTML = `<p>主密钥已解锁，现在可以读取和上传加密文件。<br>
      <span style="color:var(--ink-3);font-size:12px">加密后端：${esc(c.note)}</span></p>`;
    return;
  }
  box.innerHTML = `<p>主口令已设置但处于锁定状态。输入主口令后才能看加密文件。</p>
    <div class="row">
      <input id="cuPass" type="password" placeholder="主口令" style="flex:1">
      <button class="btn btn--primary" id="cuGo">解锁</button>
    </div>`;
  $('#cuGo').onclick = async () => {
    try {
      const r = await api('/api/crypto/unlock', 'POST', { passphrase: $('#cuPass').value });
      if (r.ok) { S.crypto = r; loadStats(); toast('已解锁'); }
      else toast('主口令不对');
    } catch (e) { toast(e.message); }
  };
}

function setMaster() {
  openSheet(`<h3 class="sheet__title">设置主口令</h3>
    <p class="sheet__sub">主口令用来派生主密钥，主密钥再加密每一个文件的密钥。
      <b>口令丢了，加密的文件就真的打不开了</b>，没有任何找回的办法。请记牢。
      它不会以明文形式保存，只保存一份 scrypt 派生出来的材料。</p>
    <div class="filters__grid">
      <label class="field"><span>主口令（至少 8 位）</span><input id="mp1" type="password"></label>
      <label class="field"><span>再输一次</span><input id="mp2" type="password"></label>
    </div>
    <button class="btn btn--primary btn--block" id="mpGo">设置</button>`,
    p => {
      $('#mpGo', p).onclick = async () => {
        const a = $('#mp1', p).value, b = $('#mp2', p).value;
        if (a.length < 8) return toast('至少 8 位');
        if (a !== b) return toast('两次输入不一致');
        try {
          S.crypto = await api('/api/crypto/setup', 'POST', { passphrase: a });
          closeSheet(); loadStats(); toast('主口令已设置');
        } catch (e) { toast(e.message); }
      };
    });
}

async function renderBackups() {
  try {
    const r = await api('/api/backup');
    const last = r.last_backup_at ? fmtTime(Number(r.last_backup_at)) : '还没备份过';
    $('#backupList').innerHTML =
      `<div class="mini-list__item"><span>上次备份</span><b>${last}</b></div>` +
      r.items.map(b =>
        `<div class="mini-list__item">
           <span>${esc(b.name)}</span>
           <b>${fmtSize(b.size)}</b>
           <span style="color:var(--ink-3)">${b.age_days} 天前</span>
         </div>`).join('');
  } catch (_) {}
}

$('#btnBackup').onclick = async () => {
  toast('正在打包，可能要一会儿…', 4000);
  try { const r = await api('/api/backup', 'POST', {}); toast('备份完成：' + fmtSize(r.size)); renderBackups(); }
  catch (e) { toast(e.message); }
};
$('#btnGc').onclick = async () => {
  try { const r = await api('/api/gc', 'POST', { dry_run: true }); toast('可以清理 ' + r.blobs + ' 个块，共 ' + fmtSize(r.bytes)); }
  catch (e) { toast(e.message); }
};
$('#btnSaveSpace').onclick = async () => {
  const gb = Number($('#spaceQuota').value || 0);
  try {
    const r = await api('/api/space', 'POST', { name: $('#spaceName').value.trim(), quota_bytes: Math.round(gb * 1073741824) });
    S.space = r.space;
    toast('已保存');
    loadStats();
  } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------- 更多菜单

function openMenu() {
  const rows = [];
  rows.push(['⬆️ 上传文件（可选加密）', () => {
    const inp = $('#filePick');
    inp.replaceWith(inp.cloneNode(true));
    const fresh = $('#filePick');
    fresh.multiple = true;
    fresh.onchange = () => { Array.from(fresh.files || []).forEach(f => startUpload(f, { enc: S.encryptedNext })); fresh.value = ''; };
    fresh.click();
  }]);
  rows.push([S.encryptedNext ? '🔒 下次上传：加密' : '🔓 下次上传：不加密', () => {
    S.encryptedNext = !S.encryptedNext;
    toast(S.encryptedNext ? '接下来的上传会加密' : '接下来的上传不加密');
  }]);
  rows.push(['📦 打包当前文件夹下载', () => {
    location.href = '/api/zip?ids=' + S.parent;
  }]);
  rows.push(['🔄 刷新', () => { refreshCurrent(); loadHome(); }]);
  rows.push(['🚪 退出登录', async () => {
    await api('/api/logout', 'POST', {});
    location.reload();
  }]);
  openSheet('<h3 class="sheet__title">更多</h3><div class="menu">' +
    rows.map((r, i) => `<button data-i="${i}">${r[0]}</button>`).join('') + '</div>',
    p => $$('.menu button', p).forEach((b, i) => b.onclick = () => { closeSheet(); rows[i][1](); }));
}

// ---------------------------------------------------------------- 启动

boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}