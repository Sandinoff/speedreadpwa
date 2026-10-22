import { clampSpeed, isWord, nextIndex, displayToken, focusIndex, readingDuration, sentenceStart, markRead, formatTime, freshState, validateBook, validateState } from './engine.js';
import { openStore } from './storage.js';
import { readEpub } from './epub.js';

const $ = id => document.getElementById(id);
const DEMO = { id: 'demo', title: 'Знакомство с SpeedRead', words: 'Добро пожаловать в SpeedRead. Здесь каждое слово появляется отдельно. Красная буква помогает удерживать взгляд в одной точке. Не нужно двигать глазами: просто смотрите между двумя штрихами. Выберите удобную скорость, нажмите воспроизведение и погрузитесь в чтение. Через пять секунд всё лишнее исчезнет. Нажмите в любом месте, чтобы сделать паузу. — А двойное нажатие на слово откроет полный текст книги. Это демонстрация — она не учитывается в достижениях.'.split(/\s+/u) };
let state = freshState(), library = [], book = DEMO, store = null, index = 0;
let playing = false, elapsed = 0, lastTick = 0, started = 0, frame = 0, weights = [], loading = false;
let page = 0, current = 0, lastTap = -1000, menuOpen = false, promptEvent = null, pendingRestore = null;
const PAGE_SIZE = 400;
let noticeTimer;
let suppressClick = false;
let dirty = false;
function notice(message, sticky = false) { clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false; if (!sticky) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5500); }
function error(e) { console.error(e); notice(e?.message || 'Не удалось выполнить действие.', true); }
function positionState() { if (book.id !== 'demo' && state.positions[book.id] !== index) { state.positions[book.id] = index; dirty = true; } }
async function save() {
  positionState();
  if (!store || !dirty) return;
  dirty = false;
  try { await store.save(state); } catch (e) { dirty = true; pause(false); error(new Error(`Не удалось сохранить данные. Сделайте резервную копию. ${e.message}`)); }
}
function applyTheme() {
  document.body.classList.toggle('night', state.night);
  document.querySelector('meta[name="theme-color"]').content = state.night ? '#000000' : '#faf7ed';
  $('themeButton').textContent = state.night ? '☀' : '◐';
}
function updateSpeed() {
  $('speedNumber').textContent = state.wpm; $('speedRange').value = state.wpm;
  $('remaining').textContent = formatTime((weights[index] || 0) / state.wpm);
}
function setSpeed(value) { state.wpm = clampSpeed(value); dirty = true; started = performance.now(); updateSpeed(); }
function drawWord(animate = false) {
  const words = book.words; let visible = nextIndex(words, index);
  if (visible >= words.length) { visible = words.length - 1; while (visible >= 0 && !isWord(words[visible])) visible--; }
  const token = visible >= 0 ? displayToken(words, visible) : ' ';
  const pivot = focusIndex(token), char = [...token.slice(pivot)][0] || ' ';
  $('before').textContent = token.slice(0, pivot); $('pivot').textContent = char; $('after').textContent = token.slice(pivot + char.length);
  $('word').classList.remove('appear');
  fitWord();
  if (animate) { void $('word').offsetWidth; $('word').classList.add('appear'); }
}
function fitWord() {
  const width = $('stage').clientWidth; if (!width) return;
  let size = Math.min(46, Math.max(28, width / 9)); $('word').style.fontSize = `${size}px`;
  // Measure only when the word/window changes; never on a speed click.
  while (size > 10 && Math.max($('before').getBoundingClientRect().width, $('after').getBoundingClientRect().width) + $('pivot').getBoundingClientRect().width / 2 > width / 2 - 14) { size -= 1; $('word').style.fontSize = `${size}px`; }
}
function renderProgress() {
  $('bookTitle').textContent = book.title;
  $('status').textContent = loading ? 'Открываем книгу…' : index >= book.words.length ? 'Книга прочитана' : playing ? 'Смотрите между двумя штрихами' : 'Пауза';
  $('playButton').innerHTML = playing ? 'Ⅱ <span>Пауза</span>' : '▶ <span>Читать</span>';
  $('playButton').setAttribute('aria-label', playing ? 'Пауза' : 'Начать чтение');
  const p = index / book.words.length;
  $('position').textContent = `${Math.round(p * 100)}%`;
  $('tokenCount').textContent = `${index.toLocaleString('ru-RU')} / ${book.words.length.toLocaleString('ru-RU')}`;
  $('progress').value = p; updateSpeed();
}
async function activate(selected, resume = true) {
  pause(); loading = true; $('playButton').disabled = true;
  book = selected;
  const id = book.id === 'demo' ? null : book.id;
  if (state.current !== id) { state.current = id; dirty = true; }
  const saved = book.id === 'demo' ? 0 : state.positions[book.id] || 0;
  index = resume ? sentenceStart(book.words, saved) : Math.min(book.words.length, saved);
  renderProgress(); drawWord();
  weights = new Float64Array(book.words.length + 1);
  for (let i = book.words.length - 1; i >= 0; i--) {
    weights[i] = weights[i + 1] + readingDuration(book.words, i, 1);
    if (i % 2000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  loading = false; $('playButton').disabled = false; renderProgress(); renderLibrary(); await save();
}
function account(now) {
  if (!playing) return;
  const dt = Math.max(0, now - lastTick); lastTick = now; elapsed += dt;
  if (book.id !== 'demo') { state.seconds += dt / 1000; dirty = true; }
}
function pause(persist = true) {
  if (playing) account(performance.now());
  playing = false; cancelAnimationFrame(frame); elapsed = 0;
  $('app').classList.remove('focused'); renderProgress();
  if (persist) void save();
}
function play() {
  if (loading || menuOpen || !$('fullText').hidden || !$('speedInput').hidden) return;
  if (playing) { pause(); return; }
  if (index >= book.words.length) index = 0;
  index = nextIndex(book.words, index); if (index >= book.words.length) return;
  lastTick = started = performance.now(); elapsed = 0; playing = true;
  drawWord(); renderProgress(); frame = requestAnimationFrame(tick);
}
function tick(now) {
  if (!playing) return;
  account(now);
  if (elapsed >= readingDuration(book.words, index, state.wpm)) {
    if (book.id !== 'demo') { if (isWord(book.words[index])) state.words++; markRead(state, book.id, index, book.words); }
    index = nextIndex(book.words, index + 1); elapsed = 0;
    if (index >= book.words.length) { pause(); drawWord(); return; }
    drawWord(true); renderProgress();
  }
  if (now - started >= 5000) $('app').classList.add('focused');
  frame = requestAnimationFrame(tick);
}
function renderLibrary() {
  $('booksStat').textContent = state.finished.length.toLocaleString('ru-RU');
  $('wordsStat').textContent = state.words.toLocaleString('ru-RU');
  $('speedStat').textContent = state.seconds ? Math.round(state.words * 60 / state.seconds) : 0;
  $('libraryCount').textContent = library.length; $('library').replaceChildren();
  if (!library.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Ваша следующая история начинается здесь. Откройте книгу в формате EPUB.'; $('library').append(p); }
  for (const item of library) {
    const button = document.createElement('button'); button.className = `book-item${item.id === book.id ? ' active' : ''}`;
    const title = document.createElement('strong'); title.textContent = item.title;
    const caption = document.createElement('small'); const pos = Math.min(item.words.length, state.positions[item.id] || 0);
    caption.textContent = `${Math.round(pos / item.words.length * 100)}% · ${item.words.length.toLocaleString('ru-RU')} токенов${state.finished.includes(item.id) ? ' · Прочитана' : ''}`;
    button.append(title, caption); button.addEventListener('click', async () => { if (loading) return; toggleMenu(false); await activate(item); });
    $('library').append(button);
  }
}
function toggleMenu(open) {
  if (open) { pause(); renderLibrary(); }
  menuOpen = open; $('drawer').classList.toggle('open', open); $('drawer').inert = !open; $('scrim').hidden = !open;
  $('reader').inert = open; $('fullText').inert = open;
  if (open) $('closeMenu').focus(); else $('menuButton').focus();
}
function openText() {
  if (loading || menuOpen || !$('fullText').hidden) return;
  pause(); current = Math.min(index, book.words.length - 1); page = Math.floor(current / PAGE_SIZE);
  $('reader').hidden = true; $('fullText').hidden = false; $('fullTitle').textContent = book.title;
  $('pageRange').max = Math.ceil(book.words.length / PAGE_SIZE); renderPage(); $('bookPage').focus();
}
function closeText() { $('fullText').hidden = true; $('reader').hidden = false; drawWord(); renderProgress(); $('stage').focus(); }
function renderPage() {
  const pages = Math.ceil(book.words.length / PAGE_SIZE); page = Math.max(0, Math.min(pages - 1, page));
  const base = page * PAGE_SIZE, end = Math.min(book.words.length, base + PAGE_SIZE);
  const fragment = document.createDocumentFragment(); let paragraph = document.createElement('p'), length = 0;
  for (let i = base; i < end; i++) {
    const span = document.createElement('span'); span.textContent = book.words[i]; span.dataset.index = i;
    if (i === current) span.className = 'current'; paragraph.append(span, ' '); length += book.words[i].length;
    if (length > 220 && /[.!?…][»”’"')\]}]*$/u.test(book.words[i])) { fragment.append(paragraph); paragraph = document.createElement('p'); length = 0; }
  }
  if (paragraph.childNodes.length) fragment.append(paragraph);
  $('bookPage').replaceChildren(fragment); $('bookPage').scrollTop = 0;
  $('pageLabel').textContent = `Страница ${page + 1} из ${pages}`; $('pageRange').value = page + 1;
  $('prevPage').disabled = page === 0; $('nextPage').disabled = page === pages - 1;
  const highlight = $('bookPage').querySelector('.current'); if (highlight) highlight.scrollIntoView({ block: 'center' });
}
function finishInput(cancel = false) {
  if ($('speedInput').hidden) return;
  const value = Number($('speedInput').value);
  if (!cancel && (!Number.isInteger(value) || value < 1 || value > 750)) { $('speedInput').setCustomValidity('Введите целое число от 1 до 750'); $('speedInput').reportValidity(); return; }
  if (!cancel) setSpeed(value);
  $('speedInput').hidden = true; $('speedNumber').hidden = false;
}
async function importEpub(file) {
  if (!file || loading) return; pause(); loading = true; $('importButton').disabled = true;
  try {
    notice('Открываем EPUB…', true);
    const imported = validateBook(await readEpub(file, (n, total) => notice(`Открываем EPUB · ${n} / ${total}`, true)));
    if (!store) throw new Error('Хранилище недоступно. Разрешите хранение данных в браузере.');
    const nextLibrary = [imported, ...library.filter(b => b.id !== imported.id)];
    await store.put([imported], { ...state, current: imported.id }); library = nextLibrary;
    loading = false; toggleMenu(false); await activate(imported); notice(`Открыта книга «${imported.title}»`);
    if (navigator.storage?.persist) void navigator.storage.persist();
  } catch (e) { error(e); } finally { loading = false; $('importButton').disabled = false; $('epubFile').value = ''; renderProgress(); }
}
async function backup() {
  pause(); positionState();
  const blob = new Blob([JSON.stringify({ format: 'SpeedRead-PWA-1', state, books: library })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `SpeedRead-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function readRestore(files) {
  if (!files.length) return; pause();
  try {
    let importedState = null; const books = [];
    for (const file of files) {
      if (file.size > 160 * 1024 * 1024) throw new Error('JSON-файл больше 160 МБ.');
      const value = JSON.parse(await file.text());
      if (value.format === 'SpeedRead-PWA-1') { importedState = validateState(value.state); for (const b of value.books) books.push(validateBook(b)); }
      else if (Array.isArray(value.words)) books.push(validateBook(value));
      else if (Number.isFinite(value.words)) importedState = validateState(value);
      else throw new Error(`Неизвестный формат ${file.name}`);
    }
    pendingRestore = { state: importedState, books };
    $('restoreDialog').showModal();
  } catch (e) { error(e); } finally { $('restoreFiles').value = ''; }
}
async function restore() {
  if (!pendingRestore || !store) return;
  try {
    const imported = pendingRestore; pendingRestore = null; $('restoreDialog').close();
    const newState = imported.state || structuredClone(state);
    const map = new Map(library.map(b => [b.id, b])); for (const b of imported.books) map.set(b.id, b);
    const nextLibrary = [...map.values()];
    for (const b of nextLibrary) {
      newState.positions[b.id] = Math.min(b.words.length, newState.positions[b.id] || 0);
      if ((newState.coverage[b.id] || []).some(([, end]) => end > b.words.length)) throw new Error('Интервалы чтения выходят за пределы книги.');
    }
    await store.put(imported.books, newState);
    state = newState; dirty = false; library = nextLibrary; applyTheme(); toggleMenu(false);
    // Do not persist the pre-import active position over the restored one.
    book = DEMO; index = 0;
    await activate(library.find(b => b.id === state.current) || library[0] || DEMO);
    notice('Книги и прогресс перенесены.');
  } catch (e) { error(e); }
}

$('menuButton').addEventListener('click', () => toggleMenu(true)); $('closeMenu').addEventListener('click', () => toggleMenu(false)); $('scrim').addEventListener('click', () => toggleMenu(false));
$('themeButton').addEventListener('click', () => { state.night = !state.night; dirty = true; applyTheme(); void save(); });
$('slower').addEventListener('click', () => setSpeed(state.wpm - 10)); $('faster').addEventListener('click', () => setSpeed(state.wpm + 10));
$('speedRange').addEventListener('input', e => setSpeed(e.target.value));
$('speedNumber').addEventListener('click', () => { if ($('app').classList.contains('focused')) return; pause(); $('speedNumber').hidden = true; $('speedInput').hidden = false; $('speedInput').value = state.wpm; $('speedInput').focus(); $('speedInput').select(); });
$('speedInput').addEventListener('input', () => $('speedInput').setCustomValidity(''));
$('speedInput').addEventListener('keydown', e => { if (e.key === 'Enter') { finishInput(); e.stopPropagation(); } if (e.key === 'Escape') { finishInput(true); e.stopPropagation(); } });
$('speedInput').addEventListener('change', () => finishInput());
$('playButton').addEventListener('click', play);
$('stage').addEventListener('click', () => { const now = performance.now(); if (now - lastTap < 350) { lastTap = -1000; openText(); } else { lastTap = now; if (playing) pause(); } });
$('stage').addEventListener('dblclick', openText);
$('reader').addEventListener('pointerdown', e => { suppressClick = false; if (playing) { suppressClick = !e.target.closest('#stage'); pause(); } }, { capture: true });
$('reader').addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true });
let swipeStart = null;
$('app').addEventListener('pointerdown', e => { if (e.clientX - $('app').getBoundingClientRect().left < 28 || menuOpen) swipeStart = { x: e.clientX, y: e.clientY }; });
$('app').addEventListener('pointerup', e => { if (!swipeStart) return; const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y; swipeStart = null; if (Math.abs(dx) > 70 && Math.abs(dy) < 70) toggleMenu(dx > 0); });
$('closeText').addEventListener('click', closeText);
$('bookPage').addEventListener('click', e => { const word = e.target.closest('span[data-index]'); if (!word) return; const target = Number(word.dataset.index); if (!isWord(book.words[target])) return; index = target; elapsed = 0; void save(); closeText(); });
$('prevPage').addEventListener('click', () => { page--; renderPage(); }); $('nextPage').addEventListener('click', () => { page++; renderPage(); });
$('pageRange').addEventListener('input', e => { page = Number(e.target.value) - 1; renderPage(); }); $('currentPage').addEventListener('click', () => { page = Math.floor(current / PAGE_SIZE); renderPage(); });
$('importButton').addEventListener('click', () => $('epubFile').click()); $('epubFile').addEventListener('change', e => void importEpub(e.target.files[0]));
$('demoButton').addEventListener('click', () => { if (loading) return; toggleMenu(false); void activate(DEMO); });
$('backupButton').addEventListener('click', backup); $('restoreButton').addEventListener('click', () => $('restoreFiles').click()); $('restoreFiles').addEventListener('change', e => void readRestore([...e.target.files]));
$('cancelRestore').addEventListener('click', () => { pendingRestore = null; $('restoreDialog').close(); }); $('confirmRestore').addEventListener('click', restore);
document.addEventListener('keydown', e => {
  if (e.target.matches('input') || $('restoreDialog').open) return;
  if (e.key === 'Escape') { if (menuOpen) toggleMenu(false); else if (!$('fullText').hidden) closeText(); else pause(); return; }
  if (menuOpen || !$('fullText').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); play(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); setSpeed(state.wpm + 10); }
  if (e.key === 'ArrowDown') { e.preventDefault(); setSpeed(state.wpm - 10); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', () => { pause(); }); window.addEventListener('blur', () => { if (playing) pause(); });
window.addEventListener('resize', () => fitWord());
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptEvent = e; $('installButton').hidden = false; });
$('installButton').addEventListener('click', async () => { if (!promptEvent) return; await promptEvent.prompt(); promptEvent = null; $('installButton').hidden = true; });
setInterval(() => { if (!document.hidden) void save(); }, 5000);
async function boot() {
  try {
    store = await openStore(new URL(location.href).searchParams.has('qa') ? 'SpeedRead-QA' : 'SpeedRead'); const saved = await store.state(); if (saved) state = validateState(saved);
    library = (await store.books()).map(validateBook);
  } catch (e) { error(new Error(`Локальное хранилище недоступно: ${e.message}`)); }
  applyTheme(); await activate(library.find(b => b.id === state.current) || DEMO);
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try { await navigator.serviceWorker.register('./sw.js'); await navigator.serviceWorker.ready; $('offlineStatus').textContent = 'Готово к чтению без интернета · PWA 1.0'; }
    catch { $('offlineStatus').textContent = 'Офлайн-кэш недоступен. Откройте через localhost или HTTPS.'; }
  } else $('offlineStatus').textContent = 'Для установки и офлайн-режима нужен HTTPS или localhost.';
}
void boot().catch(error);
