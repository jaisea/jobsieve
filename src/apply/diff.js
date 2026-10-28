/**
 * Word-level diff of a tailored line against the template line it replaces.
 *
 * The generator rewrites two or three lines out of a hundred, and the change
 * that matters is usually one word. A real run swapped "Azure-based" — the user's
 * actual, provable specialisation — for the vaguer "multi-cloud", and the
 * adversarial reviewer flagged it as an overclaim. Printing the sentence twice
 * buries that word; printing which words moved puts it in front of you before
 * the PDF exists.
 *
 * Plain LCS over whitespace-separated words. The lines are one sentence long,
 * so the quadratic table costs nothing and there is no reason to approximate.
 */

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m',
  del: '\u001b[31m\u001b[1m', add: '\u001b[32m\u001b[1m',
};

const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * Longest common subsequence of two word lists, returned as a token stream of
 * `{ word, kind }` where kind is 'same' | 'del' | 'add'.
 */
export function diffWords(before, after) {
  const a = words(before);
  const b = words(after);

  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ word: a[i], kind: 'same' }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ word: a[i], kind: 'del' }); i++; }
    else { out.push({ word: b[j], kind: 'add' }); j++; }
  }
  while (i < n) out.push({ word: a[i++], kind: 'del' });
  while (j < m) out.push({ word: b[j++], kind: 'add' });
  return out;
}

/**
 * Wrap a token stream to `width` visible columns.
 *
 * Length is measured on the word, never on the rendered string: the colour
 * codes are invisible but would otherwise count toward the margin and wrap the
 * highlighted lines early, exactly where they are hardest to read.
 */
function wrap(tokens, width, indent) {
  const lines = [];
  let line = '';
  let len = 0;
  for (const { word, colour } of tokens) {
    if (len && len + 1 + word.length > width) { lines.push(line); line = ''; len = 0; }
    line += (len ? ' ' : '') + colour;
    len += (len ? 1 : 0) + word.length;
  }
  if (line) lines.push(line);
  return lines.map((l, k) => (k ? indent + '  ' : indent) + l);
}

/**
 * Render one changed line as a −/+ pair.
 *
 * Two lines rather than a single inline diff so it still reads correctly with
 * colour stripped — piped to a file, or in a terminal that drops SGR codes.
 * Colour is the fast path, not the only one.
 */
export function renderEdit({ index, before, after, width = 96, indent = '      ' }) {
  const tokens = diffWords(before, after);
  const paint = (t, kinds, style) => tokens
    .filter((x) => kinds.includes(x.kind))
    .map((x) => ({
      word: x.word,
      colour: x.kind === 'same' ? `${C.dim}${x.word}${C.reset}` : `${style}${x.word}${C.reset}`,
    }));

  const minus = wrap(paint(tokens, ['same', 'del'], C.del), width, indent + '  ');
  const plus = wrap(paint(tokens, ['same', 'add'], C.add), width, indent + '  ');
  const changed = tokens.filter((t) => t.kind !== 'same').length;

  return [
    `${indent}${C.dim}¶${index}${C.reset}`,
    ...minus.map((l, k) => (k ? l : l.replace(indent + '  ', `${indent}${C.del}−${C.reset} `))),
    ...plus.map((l, k) => (k ? l : l.replace(indent + '  ', `${indent}${C.add}+${C.reset} `))),
  ].join('\n') + (changed ? '' : `\n${indent}  ${C.dim}(no textual change)${C.reset}`);
}

export const __testables = { diffWords, wrap };
