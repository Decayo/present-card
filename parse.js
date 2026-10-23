// Parses a closing card's text and checks it against the card rules.
// One file for both sides: the shell loads it in the browser, and check.mjs
// runs it in node before the agent calls html_render.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.presentCard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Sentence punctuation, full-width or ASCII. An ASCII mark counts only before a
  // space or the end, so 1.5, a.js and 10:30 stay words.
  const SENTENCE_MARK = /[，。；：！？]|[,.;:!?](?=\s|$)/;
  // Most words in a node, by layer: root, ## branch, then each bullet level.
  // The rules count English words; two CJK characters count as one word.
  const WORD_LIMITS = [3, 4, 5, 6];
  const WORD = /[\u3400-\u9fff\uf900-\ufaff]+|[A-Za-z0-9][\w.+#\/-]*/g;
  const CJK = /^[\u3400-\u9fff\uf900-\ufaff]/;

  // The text sits inside a <script> element. Either string can end it early.
  const BREAKS_SCRIPT = /<\/script|<!--/i;
  const BRANCHES = [3, 7];
  // A node has no children, or 2 to 5. A single child folds back into its parent.
  const CHILDREN = [2, 5];
  const MAX_NODES = 40;
  const MAX_QUESTIONS = 4;
  const OPTIONS = [3, 4];
  // The optional third field of a question line.
  const KINDS = new Map([['', 'single'], ['單選', 'single'], ['多選', 'multi'], ['是非', 'yesno']]);

  const countWords = (label) => (label.match(WORD) || [])
    .reduce((n, run) => n + (CJK.test(run) ? Math.ceil(run.length / 2) : 1), 0);

  function parse(text) {
    const maps = [];
    const questions = [];
    const details = [];
    const errors = [];
    const fail = (line, message) => errors.push({ line, message });
    let hook = null;     // null: no hook line; '': a hook line left empty
    let root = null;     // the map being written
    let heading = null;  // where an unindented bullet goes: the root, or its last ## branch
    let stack = [];      // indented bullets under the heading: { indent, node }
    let question = null; // the question whose options the bullets are

    const addNode = (parent, label, line) => {
      const node = { label, line, depth: parent ? parent.depth + 1 : 0, children: [] };
      if (parent) parent.children.push(node);
      const plain = label.replace(/`[^`]*`/g, 'x');
      const mark = SENTENCE_MARK.exec(plain);
      const words = countWords(plain);
      const limit = WORD_LIMITS[Math.min(node.depth, WORD_LIMITS.length - 1)];
      if (mark) fail(line, `「${label}」有「${mark[0]}」，是句子。拆成父節點加子節點`);
      else if (words > limit) fail(line, `「${label}」${words} 個詞，第 ${node.depth + 1} 層上限 ${limit}，是句子。拆成父節點加子節點`);
      return node;
    };

    text.split(/\r?\n/).forEach((raw, i) => {
      const line = i + 1;
      const source = raw.replace(/\t/g, '  ').trimEnd();
      if (BREAKS_SCRIPT.test(source)) {
        fail(line, '有「</script>」或「<!--」。卡片的文字放在 <script> 裡，這兩個字串會截斷它，改寫掉');
      }
      if (!source.trim()) return;
      let m;
      if ((m = /^# (.+)$/.exec(source))) {
        root = addNode(null, m[1].trim(), line);
        maps.push(root);
        heading = root;
        stack = [];
        question = null;
      } else if ((m = /^## (.+)$/.exec(source)) && root) {
        heading = addNode(root, m[1].trim(), line);
        stack = [];
        question = null;
      } else if ((m = /^\? (.+)$/.exec(source))) {
        const [title = '', short = '', kind = ''] = m[1].split('|').map((part) => part.trim());
        if (!title) fail(line, '題目是空的。寫成「? 題目 | 簡稱」');
        if (!short) fail(line, `「${title}」缺簡稱。寫成「? 題目 | 簡稱」，簡稱是回覆裡這一題的名字`);
        if (!KINDS.has(kind)) fail(line, `「${kind}」不是題型。第三欄只能寫 單選、多選、是非，或不寫`);
        question = { text: title, short, kind: KINDS.get(kind) || 'single', options: [], line };
        questions.push(question);
        heading = null;
      } else if ((m = /^hook:(.*)$/.exec(source))) {
        const url = m[1].trim();
        if (hook !== null) {
          fail(line, '「hook:」只能有一行');
        } else if (url && !/^https:\/\/\S+$/.test(url)) {
          fail(line, '「hook:」後面要是 https:// 開頭的 webhookUrl，沒有就留空');
          hook = '';
        } else {
          hook = url;
        }
        heading = null;
        question = null;
      } else if ((m = /^ *- (.+)$/.exec(source)) && question) {
        const option = m[1].trim();
        if (question.options.includes(option)) fail(line, `選項「${option}」重複`);
        else question.options.push(option);
      } else if ((m = /^( *)- (.+)$/.exec(source)) && heading) {
        const indent = m[1].length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].node : heading;
        stack.push({ indent, node: addNode(parent, m[2].trim(), line) });
      } else if ((m = /^! (.+)$/.exec(source))) {
        details.push({ text: m[1].trim(), line });
        heading = null;
        question = null;
      } else if (/^#{3,} /.test(source)) {
        fail(line, '心智圖只用 # 和 ##，更深的層用縮排的「- 」');
      } else if (/^## /.test(source)) {
        fail(line, '看不懂這一行：「##」前面要先有一行「# 根節點」');
      } else if (/^ *- /.test(source)) {
        fail(line, '看不懂這一行：「- 」要接在 #、## 或 ? 後面');
      } else {
        fail(line, '看不懂這一行。每行用 #、##、- 、? 、! 或 hook: 開頭');
      }
    });

    if (!maps.length) fail(0, '沒有心智圖。卡片至少要一行「# 結論」');

    const checkShape = (node) => {
      const count = node.children.length;
      if (node.depth === 0 && (count < BRANCHES[0] || count > BRANCHES[1])) {
        fail(node.line, `根節點「${node.label}」下有 ${count} 個分支，要 ${BRANCHES[0]} 到 ${BRANCHES[1]} 個`);
      }
      if (node.depth > 0 && count === 1) {
        fail(node.line, `「${node.label}」只有一個子節點，把它併回這個節點`);
      } else if (node.depth > 0 && count > CHILDREN[1]) {
        fail(node.line, `「${node.label}」有 ${count} 個子節點，要 ${CHILDREN[0]} 到 ${CHILDREN[1]} 個。分成幾組`);
      }
      node.children.forEach(checkShape);
    };
    const size = (node) => node.children.reduce((n, child) => n + size(child), 1);
    for (const map of maps) {
      checkShape(map);
      const nodes = size(map);
      if (nodes > MAX_NODES) fail(map.line, `這張圖 ${nodes} 個節點，最多 ${MAX_NODES} 個。拆成兩張圖，或刪掉細節`);
    }
    for (const q of questions) {
      const count = q.options.length;
      if (q.kind === 'yesno') {
        if (count !== 2) fail(q.line, `「${q.text}」是非題要剛好 2 個選項，現在 ${count} 個`);
      } else if (count === 2) {
        fail(q.line, `「${q.text}」只有 2 個選項。是非題在題目行最後加「| 是非」，不然列 ${OPTIONS[0]} 到 ${OPTIONS[1]} 個`);
      } else if (count < OPTIONS[0] || count > OPTIONS[1]) {
        fail(q.line, `「${q.text}」有 ${count} 個選項，要 ${OPTIONS[0]} 到 ${OPTIONS[1]} 個`);
      }
    }
    if (questions.length && hook === null) {
      fail(questions[0].line, '有題目就要一行「hook:」，填這個 thread 的 webhookUrl；沒有 webhookUrl 就寫「hook:」留空');
    }
    if (questions.length > MAX_QUESTIONS) {
      fail(questions[MAX_QUESTIONS].line, `${questions.length} 題，最多 ${MAX_QUESTIONS} 題`);
    }
    errors.sort((a, b) => a.line - b.line);
    return { maps, questions, details, hook: hook || '', errors };
  }

  return { parse };
});
