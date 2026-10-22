const letters = /[\p{L}\p{N}]/u;
export const isWord = word => letters.test(word);
export const isDash = word => /^[-‐‑‒–—―−]+$/u.test(word);
export const clampSpeed = n => Math.max(1, Math.min(750, Math.round(Number(n) || 1)));
export function focusIndex(word) {
  const positions = [];
  let offset = 0;
  for (const ch of word) { if (isWord(ch)) positions.push(offset); offset += ch.length; }
  const n = positions.length;
  if (!n) return 0;
  return positions[n <= 2 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4];
}
export function nextIndex(words, index) { while (index < words.length && !isWord(words[index])) index++; return index; }
export function displayToken(words, index) {
  let start = index;
  while (start > 0 && !isWord(words[start - 1])) start--;
  return [...words.slice(start, index).filter(isDash), words[index]].join(' ');
}
export function duration(word, wpm) {
  const count = Math.max(1, word.split(/\s+/u).filter(isWord).length);
  const length = [...word].filter(isWord).length;
  let factor = count + Math.max(0, length - 2 * count) * .065;
  const end = word.replace(/[»”’"')\]}]+$/u, '');
  if (/[.!?…]$/u.test(end)) factor += .8;
  else if (/[,;:]$/u.test(end)) factor += .35;
  else if (/[-‐‑–—]/u.test(word)) factor += .2;
  return 60000 / clampSpeed(wpm) * factor;
}
export function readingDuration(words, index, wpm) {
  if (!isWord(words[index])) return 0;
  let ms = duration(displayToken(words, index), wpm);
  for (let i = index + 1; i < words.length && !isWord(words[i]); i++) {
    if (!isDash(words[i])) ms += Math.max(0, duration(words[i], wpm) - 60000 / clampSpeed(wpm));
  }
  return ms;
}
export function sentenceStart(words, index) {
  index = Math.max(0, Math.min(words.length, Math.trunc(index) || 0));
  if (index === words.length) return index;
  for (let i = index - 1; i >= 0; i--) if (/[.!?…][»”’"')\]}]*$/u.test(words[i])) return nextIndex(words, i + 1);
  return nextIndex(words, 0);
}
export function markRead(state, id, index, words) {
  state.coverage ??= {};
  let start = index, end = index + 1;
  const merged = [];
  for (const [a, b] of state.coverage[id] || []) {
    if (b < start) merged.push([a, b]);
    else if (end < a) { merged.push([start, end]); start = a; end = b; }
    else { start = Math.min(start, a); end = Math.max(end, b); }
  }
  merged.push([start, end]); state.coverage[id] = merged;
  let cursor = 0, complete = true;
  for (const [a, b] of [...merged, [words.length, words.length]]) {
    for (let i = cursor; i < a; i++) if (isWord(words[i])) { complete = false; break; }
    if (!complete) break;
    cursor = b;
  }
  if (complete && !state.finished.includes(id)) state.finished.push(id);
}
function unit(n, forms) { return n % 100 >= 11 && n % 100 <= 14 ? forms[2] : n % 10 === 1 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 ? forms[1] : forms[2]; }
export function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 60000)), h = Math.floor(total / 60), m = total % 60;
  return `≈ ${h} ${unit(h, ['час', 'часа', 'часов'])}, ${m} ${unit(m, ['минута', 'минуты', 'минут'])}`;
}
export function freshState() { return { wpm: 250, night: false, words: 0, seconds: 0, finished: [], positions: {}, books: [], current: null, coverage: {} }; }
export function validateBook(book) {
  if (!book || typeof book.id !== 'string' || !book.id || book.id.length > 128 || typeof book.title !== 'string' || !Array.isArray(book.words) || !book.words.length || !book.words.every(w => typeof w === 'string' && w.length > 0 && w.length < 100000)) throw new Error('Некорректный файл книги.');
  return { id: book.id, title: book.title, words: book.words };
}
export function validateState(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.words) || value.words < 0 || !Number.isFinite(value.seconds) || value.seconds < 0 || !Array.isArray(value.finished) || !value.finished.every(x => typeof x === 'string')) throw new Error('Некорректная статистика.');
  const s = freshState(); s.wpm = clampSpeed(value.wpm); s.night = !!value.night;
  s.words = Math.trunc(value.words); s.seconds = value.seconds; s.finished = [...new Set(value.finished)];
  s.current = typeof value.current === 'string' ? value.current : null;
  s.positions = Object.fromEntries(Object.entries(value.positions || {}).filter(([, n]) => Number.isInteger(n) && n >= 0));
  s.coverage = Object.fromEntries(Object.entries(value.coverage || {}).map(([id, ranges]) => {
    if (!Array.isArray(ranges) || !ranges.every(r => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0])) throw new Error('Некорректные интервалы чтения.');
    const ordered = [...ranges].sort((a, b) => a[0] - b[0]), merged = [];
    for (const range of ordered) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
    return [id, merged];
  }));
  return s;
}
