// ==UserScript==
// @name         GitHub 活跃看板
// @name:en      GitHub Repo Active Board
// @namespace    https://github.com/shiroixw/github-repo-board
// @version      1.0.0
// @description  在 GitHub 仓库页右下角注入可折叠看板，浏览近 30 天活跃的 Issues / Pull Requests，点击即跳转
// @author       shiroixw
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @homepageURL  https://github.com/shiroixw/github-repo-board
// @supportURL   https://github.com/shiroixw/github-repo-board/issues
// @updateURL    https://raw.githubusercontent.com/shiroixw/github-repo-board/main/github-repo-board.user.js
// @downloadURL  https://raw.githubusercontent.com/shiroixw/github-repo-board/main/github-repo-board.user.js
// @license      MIT
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ---------------- 配置 ---------------- */
  const PANEL_ID = 'ghab';
  const API = 'https://api.github.com';
  const ACTIVE_DAYS = 30;          // “活跃” = 最近 N 天内有更新
  const LIST_LIMIT = 80;           // 列表最多渲染条数
  const CACHE_TTL = 5 * 60 * 1000; // sessionStorage 缓存时长
  const SETTINGS_KEY = 'ghab:settings';
  const TOKEN_KEY = 'ghab:token';
  const CACHE_PREFIX = 'ghab:cache:';

  // github.com 下不是「仓库」的一级路径
  const RESERVED = new Set([
    'settings', 'notifications', 'explore', 'marketplace', 'orgs', 'users', 'topics',
    'collections', 'trending', 'new', 'login', 'logout', 'join', 'pricing', 'features',
    'enterprise', 'sponsors', 'dashboard', 'codespaces', 'issues', 'pulls', 'search',
    'apps', 'account', 'site', 'about', 'contact', 'security', 'customer-stories',
    'nonprofit', 'education', 'mobile', 'premium-support', 'github-copilot', 'copilot',
    'readme', 'home', 'watching', 'stars', 'organizations', 'sessions', 'signup',
  ]);

  const SVG_ISSUE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path fill="currentColor" d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0ZM1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0Z"/></svg>';
  const SVG_PR = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.25 2.25 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>';

  /* ---------------- 状态 ---------------- */
  const state = {
    repo: null,        // { owner, repo, key }
    items: [],         // 活跃条目
    updatedAt: 0,
    loading: false,
    error: '',
    tab: 'issues',     // issues | pulls
    q: '',
    sort: 'updated',   // updated | created | comments
    collapsed: false,
    openInNewTab: true,
    token: '',         // 可选 GitHub Token，把额度从 60 次/小时提升到 5000 次/小时
    showToken: false,
  };

  const ui = {};

  /* ---------------- 小工具 ---------------- */
  function readJSON(storage, key) {
    try { return JSON.parse(storage.getItem(key)); } catch (e) { return null; }
  }
  function writeJSON(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function loadSettings() {
    const s = readJSON(localStorage, SETTINGS_KEY);
    if (s && typeof s === 'object') {
      if (typeof s.collapsed === 'boolean') state.collapsed = s.collapsed;
      if (typeof s.openInNewTab === 'boolean') state.openInNewTab = s.openInNewTab;
      if (s.tab === 'issues' || s.tab === 'pulls') state.tab = s.tab;
      if (['updated', 'created', 'comments'].includes(s.sort)) state.sort = s.sort;
    }
    try { state.token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
  }
  function saveToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
    state.token = token;
  }
  function saveSettings() {
    writeJSON(localStorage, SETTINGS_KEY, {
      collapsed: state.collapsed,
      openInNewTab: state.openInNewTab,
      tab: state.tab,
      sort: state.sort,
    });
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    const min = Math.floor(diff / 60000);
    if (min < 60) return min + ' 分钟前';
    const hour = Math.floor(min / 60);
    if (hour < 24) return hour + ' 小时前';
    const day = Math.floor(hour / 24);
    if (day < 30) return day + ' 天前';
    const month = Math.floor(day / 30);
    if (month < 12) return month + ' 个月前';
    return Math.floor(month / 12) + ' 年前';
  }

  function parseRepo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    if (RESERVED.has(owner.toLowerCase())) return null;
    if (!repo || repo === owner) return null;
    return { owner, repo, key: owner + '/' + repo };
  }

  /* ---------------- 数据 ---------------- */
  function mapItem(it) {
    return {
      number: it.number,
      title: it.title || '(无标题)',
      url: it.html_url,
      isPR: !!it.pull_request,
      draft: !!it.draft,
      user: (it.user && it.user.login) || 'ghost',
      comments: it.comments || 0,
      createdAt: new Date(it.created_at).getTime(),
      updatedAt: new Date(it.updated_at).getTime(),
      labels: (it.labels || [])
        .filter((l) => l && l.name)
        .map((l) => ({ name: l.name, color: (l.color || '').replace('#', '') })),
    };
  }

  async function loadData(force) {
    const repo = state.repo;
    if (!repo) return;
    const cacheKey = CACHE_PREFIX + repo.key;

    if (!force) {
      const cached = readJSON(sessionStorage, cacheKey);
      if (cached && Array.isArray(cached.items) && Date.now() - cached.t < CACHE_TTL) {
        state.items = cached.items;
        state.updatedAt = cached.t;
        state.error = '';
        renderAll();
        return;
      }
    }

    state.loading = true;
    state.error = '';
    renderList();

    try {
      const url = API + '/repos/' + repo.owner + '/' + repo.repo +
        '/issues?state=open&sort=updated&direction=desc&per_page=100&page=1';
      const headers = { Accept: 'application/vnd.github+json' };
      if (state.token) headers.Authorization = 'Bearer ' + state.token;
      const res = await fetch(url, { headers });

      if (res.status === 401) throw new Error('Token 无效或已过期，请重新填写');
      if (res.status === 403 || res.status === 429) {
        const left = res.headers.get('x-ratelimit-remaining');
        throw new Error(
          'GitHub API 限流（未登录 60 次/小时' + (left === '0' ? '，已用尽' : '') + '），可填 Token 提升到 5000 次/小时'
        );
      }
      if (res.status === 404) throw new Error('仓库不存在或无权访问');
      if (!res.ok) throw new Error('请求失败 HTTP ' + res.status);

      const data = await res.json();
      const cutoff = Date.now() - ACTIVE_DAYS * 24 * 3600 * 1000;
      const items = (Array.isArray(data) ? data : [])
        .map(mapItem)
        .filter((it) => it.updatedAt >= cutoff);

      state.items = items;
      state.updatedAt = Date.now();
      writeJSON(sessionStorage, cacheKey, { t: state.updatedAt, items });
    } catch (e) {
      state.error = (e && e.message) || String(e);
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  /* ---------------- 视图计算 ---------------- */
  function computeView() {
    const issueCount = state.items.filter((i) => !i.isPR).length;
    const prCount = state.items.filter((i) => i.isPR).length;

    let list = state.items.filter((i) => (state.tab === 'pulls' ? i.isPR : !i.isPR));

    const q = state.q.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) => i.title.toLowerCase().includes(q) || ('#' + i.number).includes(q) || i.user.toLowerCase().includes(q)
      );
    }

    const sorted = list.slice().sort((a, b) => {
      if (state.sort === 'comments') return b.comments - a.comments || b.updatedAt - a.updatedAt;
      if (state.sort === 'created') return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });

    return { issueCount, prCount, list: sorted.slice(0, LIST_LIMIT), total: sorted.length };
  }

  /* ---------------- 渲染 ---------------- */
  function renderAll() {
    if (!ui.panel) return;
    ui.panel.classList.toggle('ghab--collapsed', state.collapsed);
    ui.repo.textContent = state.repo ? state.repo.key : '';
    ui.repo.title = state.repo ? state.repo.key : '';

    const view = computeView();
    ui.tabIssues.querySelector('.ghab__count').textContent = view.issueCount;
    ui.tabPulls.querySelector('.ghab__count').textContent = view.prCount;
    ui.tabIssues.classList.toggle('is-active', state.tab === 'issues');
    ui.tabPulls.classList.toggle('is-active', state.tab === 'pulls');
    ui.badge.textContent = view.issueCount + view.prCount;
    if (state.q !== ui.search.value) ui.search.value = state.q;

    renderList();
  }

  function renderList() {
    if (!ui.list) return;
    const view = computeView();
    ui.list.textContent = '';

    const footerBits = ['近 ' + ACTIVE_DAYS + ' 天活跃'];
    if (state.updatedAt) footerBits.push('更新于 ' + relTime(state.updatedAt));
    footerBits.push('缓存 ' + Math.round(CACHE_TTL / 60000) + ' 分钟');
    ui.footer.textContent = footerBits.join(' · ');

    if (state.loading && !state.items.length) {
      ui.list.appendChild(hint('正在拉取活跃 Issues / PRs…', 'ghab-hint--loading'));
      return;
    }
    if (state.error) {
      const box = hint(state.error, 'ghab-hint--error');
      if (/限流|Token/.test(state.error)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghab__linkbtn';
        btn.textContent = '填写 Token →';
        btn.addEventListener('click', () => {
          state.showToken = true;
          syncTokenRow();
        });
        box.appendChild(document.createElement('br'));
        box.appendChild(btn);
      } else {
        box.textContent += '（点右上 ⟳ 重试）';
      }
      ui.list.appendChild(box);
      return;
    }
    if (!view.list.length) {
      ui.list.appendChild(hint(state.q ? '没有匹配的结果' : '近 ' + ACTIVE_DAYS + ' 天内没有活跃的条目', ''));
      return;
    }

    const frag = document.createDocumentFragment();
    view.list.forEach((it) => frag.appendChild(renderItem(it)));
    ui.list.appendChild(frag);

    if (view.total > view.list.length) {
      ui.list.appendChild(hint('仅显示前 ' + view.list.length + ' 条，共 ' + view.total + ' 条', ''));
    }
  }

  function hint(text, cls) {
    const div = document.createElement('div');
    div.className = 'ghab-hint' + (cls ? ' ' + cls : '');
    div.textContent = text;
    return div;
  }

  function renderItem(it) {
    const a = document.createElement('a');
    a.className = 'ghab-item';
    a.href = it.url;
    a.dataset.type = it.isPR ? 'pr' : 'issue';
    if (state.openInNewTab) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }

    const top = document.createElement('div');
    top.className = 'ghab-item__top';

    const icon = document.createElement('span');
    icon.className = 'ghab-item__icon';
    icon.innerHTML = it.isPR ? SVG_PR : SVG_ISSUE;

    const num = document.createElement('span');
    num.className = 'ghab-item__num';
    num.textContent = '#' + it.number;

    const title = document.createElement('span');
    title.className = 'ghab-item__title';
    title.textContent = it.title;
    title.title = it.title;

    top.appendChild(icon);
    top.appendChild(num);
    top.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'ghab-item__meta';
    meta.appendChild(span(it.user, 'ghab-item__author'));
    meta.appendChild(sep());
    meta.appendChild(span(relTime(it.updatedAt), ''));
    meta.appendChild(sep());
    meta.appendChild(span('💬 ' + it.comments, ''));

    if (it.draft) {
      const draft = span('Draft', 'ghab-chip ghab-chip--draft');
      draft.style.marginLeft = '6px';
      meta.appendChild(draft);
    }

    it.labels.slice(0, 3).forEach((label) => {
      const chip = document.createElement('span');
      chip.className = 'ghab-chip';
      chip.textContent = label.name;
      if (/^[0-9a-f]{6}$/i.test(label.color)) {
        chip.style.borderColor = '#' + label.color + '66';
        chip.style.backgroundColor = '#' + label.color + '1f';
      }
      meta.appendChild(chip);
    });

    a.appendChild(top);
    a.appendChild(meta);
    return a;
  }

  function span(text, cls) {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }
  function sep() {
    const el = document.createElement('span');
    el.className = 'ghab-item__sep';
    el.textContent = '·';
    return el;
  }

  /* ---------------- 面板 ---------------- */
  const TEMPLATE = `
    <div class="ghab__head" data-role="head" title="点击折叠 / 展开（Alt+B）">
      <span class="ghab__dot"></span>
      <span class="ghab__title">活跃看板</span>
      <span class="ghab__repo" data-role="repo"></span>
      <span class="ghab__badge" data-role="badge">0</span>
      <span class="ghab__spacer"></span>
      <button type="button" class="ghab__btn" data-role="refresh" title="刷新（跳过缓存）">⟳</button>
      <button type="button" class="ghab__btn ghab__btn--chev" data-role="toggle" title="折叠 / 展开">▾</button>
    </div>
    <div class="ghab__body" data-role="body">
      <div class="ghab__toolbar">
        <div class="ghab__tabs">
          <button type="button" class="ghab__tab is-active" data-tab="issues">Issues <span class="ghab__count">0</span></button>
          <button type="button" class="ghab__tab" data-tab="pulls">PRs <span class="ghab__count">0</span></button>
        </div>
        <select class="ghab__sort" data-role="sort" title="排序方式">
          <option value="updated">最近更新</option>
          <option value="created">最新创建</option>
          <option value="comments">评论最多</option>
        </select>
      </div>
      <input class="ghab__search" data-role="search" type="search" placeholder="搜索标题 / #编号 / 作者" />
      <div class="ghab__tokenrow" data-role="tokenrow">
        <input class="ghab__tokeninput" data-role="tokeninput" type="password" placeholder="GitHub Token（可选，提升 API 额度）" />
        <button type="button" class="ghab__tokensave" data-role="tokensave">保存</button>
      </div>
      <div class="ghab__list" data-role="list"></div>
      <div class="ghab__foot">
        <span class="ghab__foot-text" data-role="footer"></span>
        <button type="button" class="ghab__footbtn" data-role="tokensetup" title="设置 GitHub Token">Token</button>
        <label class="ghab__switch">
          <input type="checkbox" data-role="newtab" />
          <span>新标签页</span>
        </label>
      </div>
    </div>
  `;

  function mount() {
    if (document.getElementById(PANEL_ID) || !document.body) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = TEMPLATE;

    ui.panel = panel;
    ui.repo = panel.querySelector('[data-role="repo"]');
    ui.badge = panel.querySelector('[data-role="badge"]');
    ui.list = panel.querySelector('[data-role="list"]');
    ui.footer = panel.querySelector('[data-role="footer"]');
    ui.search = panel.querySelector('[data-role="search"]');
    ui.tabIssues = panel.querySelector('[data-tab="issues"]');
    ui.tabPulls = panel.querySelector('[data-tab="pulls"]');
    ui.sort = panel.querySelector('[data-role="sort"]');
    ui.newTab = panel.querySelector('[data-role="newtab"]');
    ui.tokenRow = panel.querySelector('[data-role="tokenrow"]');
    ui.tokenInput = panel.querySelector('[data-role="tokeninput"]');

    ui.sort.value = state.sort;
    ui.newTab.checked = state.openInNewTab;

    /* 事件 */
    panel.querySelector('[data-role="head"]').addEventListener('click', (e) => {
      if (e.target.closest('button[data-role="refresh"]') || e.target.closest('button[data-role="toggle"]')) return;
      toggleCollapse();
    });
    panel.querySelector('[data-role="toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse();
    });
    panel.querySelector('[data-role="refresh"]').addEventListener('click', (e) => {
      e.stopPropagation();
      loadData(true);
    });

    ui.tabIssues.addEventListener('click', () => setTab('issues'));
    ui.tabPulls.addEventListener('click', () => setTab('pulls'));

    ui.sort.addEventListener('change', () => {
      state.sort = ui.sort.value;
      saveSettings();
      renderList();
    });

    let timer = null;
    ui.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = ui.search.value;
        renderList();
      }, 180);
    });
    ui.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ui.search.value = '';
        state.q = '';
        renderList();
      }
      e.stopPropagation();
    });

    ui.newTab.addEventListener('change', () => {
      state.openInNewTab = ui.newTab.checked;
      saveSettings();
    });

    panel.querySelector('[data-role="tokensetup"]').addEventListener('click', () => {
      state.showToken = !state.showToken;
      syncTokenRow();
      if (state.showToken) ui.tokenInput.focus();
    });

    panel.querySelector('[data-role="tokensave"]').addEventListener('click', () => {
      saveToken(ui.tokenInput.value.trim());
      clearCache();
      state.showToken = false;
      syncTokenRow();
      loadData(true);
    });

    ui.tokenInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') panel.querySelector('[data-role="tokensave"]').click();
    });

    syncTokenRow();
    document.body.appendChild(panel);
  }

  function syncTokenRow() {
    if (!ui.panel || !ui.tokenRow) return;
    ui.panel.classList.toggle('ghab--token', !!state.showToken);
    if (state.showToken && state.token && !ui.tokenInput.value) ui.tokenInput.value = state.token;
  }

  function clearCache() {
    try {
      Object.keys(sessionStorage)
        .filter((k) => k.indexOf(CACHE_PREFIX) === 0)
        .forEach((k) => sessionStorage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  function setTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    saveSettings();
    renderAll();
  }

  function toggleCollapse() {
    state.collapsed = !state.collapsed;
    saveSettings();
    if (ui.panel) ui.panel.classList.toggle('ghab--collapsed', state.collapsed);
  }

  /* ---------------- 样式 ---------------- */
  function injectStyle() {
    if (document.getElementById(PANEL_ID + '-style')) return;
    const style = document.createElement('style');
    style.id = PANEL_ID + '-style';
    style.textContent = `
#${PANEL_ID}{
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 348px; max-height: min(70vh, 620px);
  display: flex; flex-direction: column; overflow: hidden;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 12px; line-height: 1.5;
  color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(31,35,40,.14), 0 1px 3px rgba(31,35,40,.10);
}
#${PANEL_ID} *{ box-sizing: border-box; }
#${PANEL_ID}.ghab--collapsed{ width: auto; max-height: none; }
#${PANEL_ID}.ghab--collapsed .ghab__body{ display: none; }
#${PANEL_ID}.ghab--collapsed .ghab__btn--chev{ transform: rotate(-90deg); }

#${PANEL_ID} .ghab__head{
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; cursor: pointer; user-select: none;
  background: var(--bgColor-muted, #f6f8fa);
  border-bottom: 1px solid transparent;
}
#${PANEL_ID}:not(.ghab--collapsed) .ghab__head{ border-bottom-color: var(--borderColor-default, #d1d9e0); }
#${PANEL_ID} .ghab__dot{ width: 7px; height: 7px; border-radius: 50%; background: #1f883d; flex: none; box-shadow: 0 0 0 3px rgba(31,136,61,.16); }
#${PANEL_ID} .ghab__title{ font-weight: 600; font-size: 12px; white-space: nowrap; }
#${PANEL_ID} .ghab__repo{ color: var(--fgColor-muted, #59636e); font-size: 11px; max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .ghab__badge{
  min-width: 18px; height: 16px; padding: 0 5px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 600; color: #0969da;
  background: rgba(9,105,218,.12);
}
#${PANEL_ID} .ghab__spacer{ flex: 1; }
#${PANEL_ID} .ghab__btn{
  width: 22px; height: 22px; padding: 0; margin: 0; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; line-height: 1; color: var(--fgColor-muted, #59636e);
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  cursor: pointer; transition: background .12s, color .12s, transform .12s;
}
#${PANEL_ID} .ghab__btn:hover{ background: var(--bgColor-neutral-muted, rgba(129,139,152,.16)); color: var(--fgColor-default, #1f2328); }
#${PANEL_ID} .ghab__btn--chev{ font-size: 10px; }

#${PANEL_ID} .ghab__body{ display: flex; flex-direction: column; min-height: 0; }
#${PANEL_ID} .ghab__toolbar{ display: flex; align-items: center; gap: 8px; padding: 8px 10px 6px; }
#${PANEL_ID} .ghab__tabs{ display: flex; gap: 2px; background: var(--bgColor-muted, #f6f8fa); border-radius: 8px; padding: 2px; }
#${PANEL_ID} .ghab__tab{
  padding: 3px 9px; margin: 0; font-size: 11px; font-weight: 600;
  color: var(--fgColor-muted, #59636e); background: transparent;
  border: 0; border-radius: 6px; cursor: pointer;
  font-family: inherit; line-height: 1.5;
}
#${PANEL_ID} .ghab__tab:hover{ color: var(--fgColor-default, #1f2328); }
#${PANEL_ID} .ghab__tab.is-active{
  color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  box-shadow: 0 1px 2px rgba(31,35,40,.12);
}
#${PANEL_ID} .ghab__count{ font-weight: 500; color: var(--fgColor-muted, #59636e); font-size: 10px; }
#${PANEL_ID} .ghab__sort{
  margin-left: auto; height: 22px; padding: 0 4px; font-size: 11px; font-family: inherit;
  color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; cursor: pointer;
}
#${PANEL_ID} .ghab__search{
  margin: 0 10px 6px; height: 26px; padding: 0 8px; width: calc(100% - 20px);
  font-size: 11px; font-family: inherit; color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; outline: none;
}
#${PANEL_ID} .ghab__search:focus{ border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,.2); }
#${PANEL_ID} .ghab__tokenrow{ display: none; gap: 6px; padding: 0 10px 6px; }
#${PANEL_ID}.ghab--token .ghab__tokenrow{ display: flex; }
#${PANEL_ID} .ghab__tokeninput{
  flex: 1; height: 26px; padding: 0 8px; min-width: 0;
  font-size: 11px; font-family: inherit; color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; outline: none;
}
#${PANEL_ID} .ghab__tokeninput:focus{ border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,.2); }
#${PANEL_ID} .ghab__tokensave{
  flex: none; height: 26px; padding: 0 10px; font-size: 11px; font-family: inherit;
  color: #ffffff; background: #1f883d; border: 1px solid rgba(31,35,40,.15);
  border-radius: 6px; cursor: pointer; font-weight: 500;
}
#${PANEL_ID} .ghab__tokensave:hover{ background: #1a7f37; }
#${PANEL_ID} .ghab__footbtn{
  flex: none; height: 18px; padding: 0 6px; font-size: 10px; font-family: inherit;
  color: var(--fgColor-muted, #59636e); background: transparent; cursor: pointer;
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 999px;
}
#${PANEL_ID} .ghab__footbtn:hover{ color: #0969da; border-color: #0969da; }
#${PANEL_ID} .ghab__linkbtn{
  margin-top: 6px; padding: 2px 8px; font-size: 11px; font-family: inherit;
  color: #0969da; background: transparent; cursor: pointer;
  border: 1px solid rgba(9,105,218,.4); border-radius: 6px; font-weight: 500;
}
#${PANEL_ID} .ghab__linkbtn:hover{ background: rgba(9,105,218,.1); }
#${PANEL_ID} .ghab__list{ overflow-y: auto; overflow-x: hidden; padding: 0 6px 4px; min-height: 0; flex: 1; }
#${PANEL_ID} .ghab__list::-webkit-scrollbar{ width: 8px; }
#${PANEL_ID} .ghab__list::-webkit-scrollbar-thumb{ background: var(--borderColor-default, #d1d9e0); border-radius: 8px; }

#${PANEL_ID} .ghab-item{
  display: block; padding: 6px 8px; margin-bottom: 2px;
  color: inherit; text-decoration: none; border-radius: 8px;
  border-left: 2px solid transparent;
  transition: background .12s;
}
#${PANEL_ID} .ghab-item:hover{ background: var(--bgColor-muted, #f6f8fa); }
#${PANEL_ID} .ghab-item:hover .ghab-item__title{ color: #0969da; text-decoration: underline; }
#${PANEL_ID} .ghab-item[data-type="issue"]{ border-left-color: #1a7f37; }
#${PANEL_ID} .ghab-item[data-type="pr"]{ border-left-color: #8250df; }
#${PANEL_ID} .ghab-item__top{ display: flex; align-items: flex-start; gap: 5px; }
#${PANEL_ID} .ghab-item__icon{ flex: none; display: inline-flex; margin-top: 2px; }
#${PANEL_ID} .ghab-item[data-type="issue"] .ghab-item__icon{ color: #1a7f37; }
#${PANEL_ID} .ghab-item[data-type="pr"] .ghab-item__icon{ color: #8250df; }
#${PANEL_ID} .ghab-item__num{ flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--fgColor-muted, #59636e); }
#${PANEL_ID} .ghab-item__title{
  font-size: 12px; font-weight: 500; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
#${PANEL_ID} .ghab-item__meta{
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  margin: 3px 0 0 19px; font-size: 10px; color: var(--fgColor-muted, #59636e);
}
#${PANEL_ID} .ghab-item__author{ font-weight: 500; }
#${PANEL_ID} .ghab-item__sep{ opacity: .55; }
#${PANEL_ID} .ghab-chip{
  padding: 0 5px; height: 15px; line-height: 14px; border-radius: 999px;
  font-size: 9px; font-weight: 500;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  background: var(--bgColor-muted, #f6f8fa);
  color: var(--fgColor-muted, #59636e);
  max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#${PANEL_ID} .ghab-chip--draft{ border-color: #d1d9e0; color: #59636e; }

#${PANEL_ID} .ghab-hint{ padding: 10px 8px; font-size: 11px; color: var(--fgColor-muted, #59636e); text-align: center; }
#${PANEL_ID} .ghab-hint--error{ color: #d1242f; }
#${PANEL_ID} .ghab-hint--loading{ animation: ghab-pulse 1.2s ease-in-out infinite; }
@keyframes ghab-pulse{ 0%,100%{opacity:.55} 50%{opacity:1} }

#${PANEL_ID} .ghab__foot{
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-top: 1px solid var(--borderColor-default, #d1d9e0);
  background: var(--bgColor-muted, #f6f8fa);
  font-size: 10px; color: var(--fgColor-muted, #59636e);
}
#${PANEL_ID} .ghab__foot-text{ flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .ghab__switch{ display: inline-flex; align-items: center; gap: 3px; cursor: pointer; white-space: nowrap; }
#${PANEL_ID} .ghab__switch input{ margin: 0; cursor: pointer; }

@media (max-width: 640px){
  #${PANEL_ID}{ right: 8px; left: 8px; bottom: 8px; width: auto; max-height: 60vh; }
  #${PANEL_ID}.ghab--collapsed{ left: auto; width: auto; }
}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------------- 生命周期 ---------------- */
  function onNavigate() {
    const repo = parseRepo();
    if (!repo) {
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
      ui.panel = null;
      state.repo = null;
      return;
    }

    const changed = !state.repo || state.repo.key !== repo.key;
    state.repo = repo;
    injectStyle();
    mount();
    if (!ui.panel) return;

    if (changed) {
      state.items = [];
      state.updatedAt = 0;
      state.error = '';
      state.q = '';
      if (ui.search) ui.search.value = '';
      renderAll();
      loadData(false);
    } else {
      renderAll();
    }
  }

  function boot() {
    loadSettings();
    onNavigate();

    ['turbo:load', 'pjax:end', 'soft-nav:end'].forEach((evt) => {
      document.addEventListener(evt, onNavigate);
    });
    window.addEventListener('popstate', onNavigate);

    // GitHub 是 SPA：兜底检测地址变化与面板被卸载
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNavigate();
        return;
      }
      if (state.repo && !document.getElementById(PANEL_ID)) {
        mount();
        renderAll();
      }
    }, 1000);

    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
        if (!ui.panel) return;
        e.preventDefault();
        toggleCollapse();
      }
    });
  }

  boot();
})();
