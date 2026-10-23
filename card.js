// The closing card's shell. A card's html is its text in <script type="text/card">
// and one <script src> line for this file; the parser, the look, and the mind map
// library all load from here.
(function () {
  'use strict';

  const base = new URL('.', document.currentScript.src).href;
  const MIN_SCALE = 0.8;
  const PAD = 12;
  const PADDING_X = 10; // markmap's space between a node's start and its text
  const FALLBACK_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee'];
  const MAC = navigator.userAgent.includes('Macintosh');
  const NO_HOOK = '沒有接 webhook：先用 list_scheduled_tasks 找這條 thread 的『決策卡送出』，沒有就用 schedule_task 建，再把 webhookUrl 寫在「hook:」後面';

  // Added before the page finishes loading, so T3 measures the card's height only
  // after all of them. async = false keeps their order: d3 before markmap.
  const load = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`載不到 ${src}`));
    document.head.append(script);
  });
  const style = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = base + 'card.css';
    link.onload = link.onerror = resolve;
    document.head.append(link);
  });
  const parserLoaded = load(base + 'parse.js');
  const mapsLoaded = Promise.all([
    load('https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js'),
    load('https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js'),
    style,
  ]);
  // Handled where the maps are drawn; this only keeps a failed parser load from also
  // reporting an unhandled rejection.
  mapsLoaded.catch(() => {});
  const ready = new Promise((resolve) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
    else resolve();
  });

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const code = (html) => html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Escaped text with `code` spans and bare links, for map nodes and detail lines.
  const URL_IN_TEXT = /https?:\/\/[^\s<>"'，。；：！？、）」』]+/g;
  const rich = (text) => {
    let html = '';
    let at = 0;
    for (const m of text.matchAll(URL_IN_TEXT)) {
      html += code(escapeHtml(text.slice(at, m.index))) + `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`;
      at = m.index + m[0].length;
    }
    return html + code(escapeHtml(text.slice(at)));
  };

  Promise.all([ready, parserLoaded]).then(() => {
    const source = document.querySelector('script[type="text/card"]');
    if (!source) throw new Error('找不到 <script type="text/card">');
    const card = window.presentCard.parse(source.textContent.replace(/^\r?\n/, ''));
    for (const { line, message } of card.errors) console.error(`present-card ${line ? `line ${line}: ` : ''}${message}`);

    const main = el('main', 'card');
    const sections = card.maps.map(() => main.appendChild(el('section', 'map')));
    if (card.questions.length) main.append(decisionArea(card));
    if (card.details.length) main.append(detailBlock(card.details));
    document.body.append(main);
    return mapsLoaded.then(() => drawMaps(card.maps, main, sections), (error) => {
      sections.forEach((section) => section.append(el('p', 'fatal', `心智圖畫不出來：${error.message}`)));
      throw error;
    });
  }).catch((error) => {
    console.error('present-card', error.message || error);
    if (!document.querySelector('main.card')) document.body.append(el('p', 'fatal', `卡片載不起來：${error.message || error}`));
  });

  async function drawMaps(roots, main, sections) {
    if (!roots.length) return;
    const css = getComputedStyle(document.documentElement);
    const palette = FALLBACK_COLORS.map((color, i) => css.getPropertyValue(`--chart-${i + 1}`).trim() || color);
    const narrow = main.clientWidth < 560;
    const level = narrow ? 2 : 3;

    const bar = el('div', 'bar');
    const expand = el('button', '', '全部展開');
    const collapse = el('button', '', narrow ? '折疊到第二層' : '折疊到第三層');
    expand.type = collapse.type = 'button';
    bar.append(el('p', 'hint', `點圓點展開收起，${MAC ? '⌘' : 'Ctrl'}+點整個分支；按 e 展開、c 折疊`), expand, collapse);
    main.prepend(bar);

    const maps = await Promise.all(roots.map((root, i) => drawMap(sections[i], root, { level, narrow, palette })));
    // Unfold every node of every map, or fold back to the depth the card opened at.
    const foldAll = (limit) => maps.forEach((mm) => {
      (function walk(node) {
        const fold = limit > 0 && node.state.depth >= limit && (node.children || []).length ? 1 : 0;
        node.payload = { ...node.payload, fold };
        (node.children || []).forEach(walk);
      })(mm.state.data);
      mm.renderData();
    });
    expand.addEventListener('click', () => foldAll(0));
    collapse.addEventListener('click', () => foldAll(level));
    // Single keys stay inside the frame, so they do not reach T3's own shortcuts.
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = (event.key || '').toLowerCase();
      if (key === 'e') foldAll(0);
      else if (key === 'c') foldAll(level);
      else return;
      event.preventDefault();
    });
  }

  async function drawMap(section, root, { level, narrow, palette }) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'markmap');
    section.append(svg);
    const mm = new window.markmap.Markmap(svg, {
      initialExpandLevel: level, zoom: false, pan: false, duration: 0, autoFit: true,
      maxWidth: narrow ? 160 : 230, spacingVertical: 8, spacingHorizontal: narrow ? 32 : 48,
      paddingX: PADDING_X,
      // Colours cycle, so the seventh branch and later still get a line and a dot.
      color: (node) => palette[node.payload.branch % palette.length],
    });
    // Fit by width only: never below MIN_SCALE, with the rest scrolling sideways.
    // The root's text keeps one x at every scale, and an unchanged layout is not
    // moved again.
    const anchor = PAD + PADDING_X;
    let last = '';
    mm.fit = function () {
      const { x1, y1, x2, y2 } = mm.state.rect;
      const room = section.clientWidth;
      const k = Math.max(MIN_SCALE, Math.min(1, (room - anchor - PAD) / (x2 - x1 - PADDING_X)));
      const x = anchor - (x1 + PADDING_X) * k;
      const y = PAD - y1 * k;
      const right = x + x2 * k + PAD;
      svg.style.width = right > room + 0.5 ? `${Math.ceil(right)}px` : '';
      svg.style.height = `${Math.max(80, Math.ceil((y2 - y1) * k + PAD * 2))}px`;
      const key = [x, y, k].join();
      if (key === last) return Promise.resolve();
      last = key;
      const transform = window.d3.zoomIdentity.translate(x, y).scale(k);
      // Zoom about the root's text, so it stays put while the transition runs.
      return mm.transition(mm.svg).call(mm.zoom.transform, transform, [anchor, PAD]).end().catch(() => {});
    };
    // A straight path between two fits. d3's default smooth zoom pulls out and back
    // in when the map only moves down.
    mm.zoom.interpolate(window.d3.interpolate);
    const toData = (node, branch) => ({
      content: rich(node.label),
      payload: { branch },
      children: node.children.map((child, i) => toData(child, node.depth === 0 ? i : branch)),
    });
    await mm.setData(toData(root, 0));
    mm.setOptions({ duration: 180 });
    return mm;
  }

  function detailBlock(details) {
    const block = el('details', 'more');
    const list = el('ul');
    for (const { text } of details) {
      const item = el('li');
      item.innerHTML = rich(text);
      list.append(item);
    }
    block.append(el('summary', '', `細節（${details.length}）`), list);
    return block;
  }

  function decisionArea({ questions, hook }) {
    const area = el('section', 'decide');
    const head = el('div', 'head');
    const status = el('span', 'status', '點選項就會複製整份答案');
    head.append(el('h2', '', '要你決定'), status);
    const list = el('div', 'qs');
    const noteLabel = el('label', 'note', '補充');
    const note = el('textarea');
    note.rows = 2;
    note.placeholder = '選項都不對、或想多說的，寫在這裡';
    noteLabel.append(note);
    const send = el('button', 'send', '送出');
    send.type = 'button';
    send.hidden = true;
    send.disabled = true;
    area.append(head, list, noteLabel, send);

    // Questions with no hook have no 送出 button. Say so at the top of the area,
    // and in the console, so the agent sees it in a preview.
    if (!hook) {
      console.error(NO_HOOK);
      area.prepend(el('p', 'warn', NO_HOOK));
    }

    const picked = questions.map(() => new Set());
    const setStatus = (kind, text) => { status.className = `status ${kind}`; status.textContent = text; };
    let locked = false;
    // 送出 stays off until a choice or some note text is there.
    const refreshSend = () => {
      if (!hook || locked) return;
      send.disabled = !(picked.some((set) => set.size > 0) || note.value.trim());
    };

    const views = questions.map((q, i) => {
      const box = el('section', q.kind === 'multi' ? 'q multi' : 'q');
      const title = el('h3', '', `${i + 1}. ${q.text}`);
      title.append(el('small', '', { single: '單選', multi: '可多選', yesno: '是非' }[q.kind]));
      const opts = el('div', 'opts');
      opts.setAttribute('role', 'group');
      const buttons = q.options.map((option) => {
        const button = el('button', 'opt', option);
        button.type = 'button';
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => pick(i, option));
        opts.append(button);
        return button;
      });
      box.append(title, opts);
      list.append(box);
      return buttons;
    });

    // Choices first. A note, when the field has text, is one more line at the end.
    const compose = () => {
      const lines = questions.map((q, i) => {
        const chosen = q.options.filter((option) => picked[i].has(option));
        return `${i + 1}. ${q.short}：${chosen.length ? chosen.join('、') : '未選'}`;
      }).join('\n');
      const extra = note.value.trim();
      return extra ? `${lines}\n補充：${extra}` : lines;
    };

    // The frame has no clipboard-write permission, so the async API is blocked;
    // execCommand only needs the click's user activation.
    const copy = (text) => {
      const active = document.activeElement;
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(field);
      field.focus({ preventScroll: true });
      field.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      field.remove();
      if (active && active.focus) active.focus({ preventScroll: true });
      return ok;
    };

    const pick = (i, option) => {
      if (locked) return;
      const set = picked[i];
      if (questions[i].kind === 'multi') {
        if (set.has(option)) set.delete(option); else set.add(option);
      } else {
        const had = set.has(option);
        set.clear();
        if (!had) set.add(option);
      }
      views.forEach((buttons, q) => buttons.forEach((button, o) => {
        button.setAttribute('aria-pressed', String(picked[q].has(questions[q].options[o])));
      }));
      const copied = copy(`決策卡回覆\n${compose()}`);
      if (hook) {
        refreshSend();
        setStatus('', copied ? '已複製。按「送出」，或到對話框 Ctrl+V' : '按「送出」');
      } else {
        setStatus(copied ? 'ok' : 'err', copied ? '已複製整份答案，到對話框 Ctrl+V' : '複製失敗');
      }
    };

    note.addEventListener('input', refreshSend);

    if (hook) {
      send.hidden = false;
      setStatus('', '點選項或寫補充，再按「送出」');
      send.addEventListener('click', async () => {
        const answer = compose();
        copy(`決策卡回覆\n${answer}`);
        send.disabled = true;
        setStatus('', '送出中…');
        try {
          // The hook sends no CORS headers, so this is a simple request whose
          // response stays opaque; the answer arriving in the thread is the proof.
          await fetch(hook, {
            method: 'POST', mode: 'no-cors',
            body: JSON.stringify({ answer, sentAt: new Date().toISOString() }),
          });
          locked = true;
          views.forEach((buttons) => buttons.forEach((button) => { button.disabled = true; }));
          note.disabled = true;
          setStatus('ok', '已送出。要改請直接在對話框打');
        } catch (e) {
          refreshSend();
          setStatus('err', `送不出去（${e.name}），到對話框 Ctrl+V`);
        }
      });
    }
    return area;
  }
})();
