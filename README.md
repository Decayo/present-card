# present-card

The shell for text-only closing cards. An agent writes a short text; this repo turns it
into a mind map with a decision area underneath.

## Files

- `card.js`: the shell. It loads `parse.js`, `card.css`, d3, and markmap-view, then draws
  the card.
- `parse.js`: the parser and the format rules. The same file runs in the browser and in
  node, so a local check and the card agree.
- `card.css`: the look. Colours and fonts come from the host page's theme variables.

## A card

A card's html is its text in `<script type="text/card">`, then one `<script src>` line
that loads `card.js` from a CDN pinned to a commit.

```
# 結論
## 重點
- 理由
  - 細一層
? 題目 | 簡稱 | 單選、多選或是非
- 選項一（建議）
- 選項二
- 選項三
! 細節：證據、出處，預設收起
hook: 回覆用的 webhook，沒有就留空
```

## Rules the parser checks

- A node is a phrase, not a sentence: no sentence punctuation, and a word limit per
  layer (3, 4, 5, then 6; two CJK characters count as one word).
- A root has 3 to 7 branches, and each branch has 2 to 5 children. A deeper node has no
  children, or 2 to 5.
- A map has at most 40 nodes.
- At most 4 questions. Each has 3 or 4 options; a yes-or-no question has exactly 2.
- A card with questions has a `hook:` line.
- The text never contains `</script>` or `<!--`.
