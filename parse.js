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
  // Each branch of the root has 2 to 5 children; a deeper node has none, or 2 to 5.
  // A single child folds back into its parent.
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
      if (mark) fail(line, `"${label}" is a sentence: it has "${mark[0]}". Split it into a parent and its child`);
      else if (words > limit) fail(line, `"${label}" is a sentence: ${words} words, and layer ${node.depth + 1} allows ${limit}. Split it into a parent and its child`);
      return node;
    };

    text.split(/\r?\n/).forEach((raw, i) => {
      const line = i + 1;
      const source = raw.replace(/\t/g, '  ').trimEnd();
      if (BREAKS_SCRIPT.test(source)) {
        fail(line, 'has "</script>" or "<!--". The text sits inside a <script> element, and either string ends it early. Reword it');
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
        if (!title) fail(line, 'the question is empty. Write "? 題目 | 簡稱"');
        if (!short) fail(line, `"${title}" has no short name. Write "? 題目 | 簡稱"; the short name names this question in the answer`);
        if (!KINDS.has(kind)) fail(line, `"${kind}" is not a question kind. The third field is 單選, 多選, 是非, or nothing`);
        question = { text: title, short, kind: KINDS.get(kind) || 'single', options: [], line };
        questions.push(question);
        heading = null;
      } else if ((m = /^hook:(.*)$/.exec(source))) {
        const url = m[1].trim();
        if (hook !== null) {
          fail(line, 'a card has one "hook:" line');
        } else if (url && !/^https:\/\/\S+$/.test(url)) {
          fail(line, '"hook:" takes an https:// webhookUrl, or nothing');
          hook = '';
        } else {
          hook = url;
        }
        heading = null;
        question = null;
      } else if ((m = /^ *- (.+)$/.exec(source)) && question) {
        const option = m[1].trim();
        if (question.options.includes(option)) fail(line, `option "${option}" appears twice`);
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
        fail(line, 'a map uses only # and ##. Go deeper with indented "- " lines');
      } else if (/^## /.test(source)) {
        fail(line, 'cannot read this line: "##" needs a "# root" line above it');
      } else if (/^ *- /.test(source)) {
        fail(line, 'cannot read this line: a "- " line belongs under a #, ##, or ? line');
      } else {
        fail(line, 'cannot read this line. Start each line with #, ##, - , ? , ! or hook:');
      }
    });

    if (!maps.length) fail(0, 'no mind map. A card needs at least one "# 結論" line');

    const checkShape = (node) => {
      const count = node.children.length;
      if (node.depth === 0 && (count < BRANCHES[0] || count > BRANCHES[1])) {
        fail(node.line, `root "${node.label}" has ${count} branches; it needs ${BRANCHES[0]} to ${BRANCHES[1]}`);
      }
      if (node.depth === 1 && count === 0) {
        fail(node.line, `"${node.label}" has no children; a branch of the root needs ${CHILDREN[0]} to ${CHILDREN[1]}`);
      } else if (node.depth > 0 && count === 1) {
        fail(node.line, `"${node.label}" has a single child. Fold the child into it`);
      } else if (node.depth > 0 && count > CHILDREN[1]) {
        fail(node.line, `"${node.label}" has ${count} children; a node takes ${CHILDREN[0]} to ${CHILDREN[1]}. Group them`);
      }
      node.children.forEach(checkShape);
    };
    const size = (node) => node.children.reduce((n, child) => n + size(child), 1);
    for (const map of maps) {
      checkShape(map);
      const nodes = size(map);
      if (nodes > MAX_NODES) fail(map.line, `this map has ${nodes} nodes; at most ${MAX_NODES}. Split it by topic, or drop detail`);
    }
    for (const q of questions) {
      const count = q.options.length;
      if (q.kind === 'yesno') {
        if (count !== 2) fail(q.line, `"${q.text}" is a yes-or-no question: it takes exactly 2 options, not ${count}`);
      } else if (count === 2) {
        fail(q.line, `"${q.text}" has 2 options. End a yes-or-no question's line with "| 是非"; otherwise list ${OPTIONS[0]} or ${OPTIONS[1]}`);
      } else if (count < OPTIONS[0] || count > OPTIONS[1]) {
        fail(q.line, `"${q.text}" has ${count} options; it takes ${OPTIONS[0]} or ${OPTIONS[1]}`);
      }
    }
    if (questions.length && hook === null) {
      fail(questions[0].line, 'a card with questions needs a "hook:" line: this thread\'s webhookUrl, or "hook:" with nothing after it');
    }
    if (questions.length > MAX_QUESTIONS) {
      fail(questions[MAX_QUESTIONS].line, `${questions.length} questions; at most ${MAX_QUESTIONS}`);
    }
    errors.sort((a, b) => a.line - b.line);
    return { maps, questions, details, hook: hook || '', errors };
  }

  return { parse };
});
