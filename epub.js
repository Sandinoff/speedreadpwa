const decoder = new TextDecoder('utf-8', { fatal: true });
export async function unzip(file) {
  if (file.size > 100 * 1024 * 1024) throw new Error('Книга больше 100 МБ.');
  const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error('Это не ZIP/EPUB или файл повреждён.');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Многотомный EPUB не поддерживается.');
  const count = view.getUint16(end + 10, true), entries = new Map(); let cursor = view.getUint32(end + 16, true), total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Повреждён каталог EPUB.');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), size = view.getUint32(cursor + 24, true), packed = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), offset = view.getUint32(cursor + 42, true);
    total += size; if (total > 160 * 1024 * 1024 || size === 0xffffffff) throw new Error('Распакованный EPUB больше 160 МБ или использует ZIP64.');
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLen));
    entries.set(name, { flags, method, size, packed, offset }); cursor += 46 + nameLen + extra + comment;
  }
  return { has: name => entries.has(name), async read(name) {
    const entry = entries.get(name); if (!entry) throw new Error(`В EPUB отсутствует ${name}`);
    const { flags, method, size, packed, offset } = entry;
    if (flags & 1) throw new Error('EPUB защищён паролем или DRM.');
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error('Повреждён EPUB.');
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (start + packed > bytes.length) throw new Error('Повреждён размер раздела EPUB.');
    let data = bytes.slice(start, start + packed);
    if (method === 8) {
      let decompressor;
      try { decompressor = new DecompressionStream('deflate-raw'); } catch { throw new Error('Для импорта EPUB нужен современный Safari, Chrome или Edge с поддержкой deflate-raw.'); }
      const reader = new Blob([data]).stream().pipeThrough(decompressor).getReader();
      const chunks = []; let length = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > size || length > 160 * 1024 * 1024) { await reader.cancel(); throw new Error('Некорректный размер EPUB.'); } chunks.push(value); }
      data = new Uint8Array(length); let pos = 0; for (const chunk of chunks) { data.set(chunk, pos); pos += chunk.length; }
    } else if (method !== 0) throw new Error('Неподдерживаемое сжатие EPUB.');
    if (data.length !== size) throw new Error('Не совпадает размер раздела EPUB.');
    return decoder.decode(data);
  } };
}
function xml(source) { const doc = new DOMParser().parseFromString(source, 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('Повреждён XML в EPUB.'); return doc; }
const tags = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
function resolvePath(base, href) {
  const parts = [];
  for (const part of (base + decodeURIComponent(href.split('#')[0])).split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  return parts.join('/');
}
function extractText(source) {
  // XHTML commonly includes HTML entities not predefined by the XML parser.
  source = source.replace(/&([a-zA-Z][a-zA-Z0-9]+);/gu, (entity, name) => {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return entity;
    const textarea = document.createElement('textarea'); textarea.innerHTML = entity;
    const decoded = textarea.value;
    return decoded === entity ? entity : [...decoded].map(ch => `&#${ch.codePointAt(0)};`).join('');
  });
  // Parse as inert XML, never attach publication markup or resources to the DOM.
  const doc = xml(source), parts = [];
  const blocks = new Set(['p', 'br', 'div', 'h1', 'h2', 'h3', 'li']);
  function visit(node) {
    if (node.nodeType === 3 || node.nodeType === 4) { parts.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const name = node.localName.toLowerCase(); if (name === 'script' || name === 'style') return;
    if (blocks.has(name)) parts.push('\n');
    for (const child of node.childNodes) visit(child);
    if (blocks.has(name) && name !== 'br') parts.push('\n');
  }
  visit(doc.documentElement); return parts.join('');
}
export async function readEpub(file, progress = () => {}) {
  const zip = await unzip(file);
  if (zip.has('META-INF/encryption.xml')) {
    const encryption = xml(await zip.read('META-INF/encryption.xml'));
    for (const method of tags(encryption, 'EncryptionMethod')) if (!['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(method.getAttribute('Algorithm'))) throw new Error('EPUB защищён DRM. Нужна книга без защиты.');
  }
  const container = xml(await zip.read('META-INF/container.xml'));
  const packageName = tags(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!packageName) throw new Error('Не найден OPF в EPUB.');
  const opf = xml(await zip.read(packageName)), base = packageName.includes('/') ? packageName.slice(0, packageName.lastIndexOf('/') + 1) : '';
  const manifest = new Map(tags(opf, 'item').map(item => [item.getAttribute('id'), item]));
  const title = tags(opf, 'title')[0]?.textContent.trim() || file.name.replace(/\.epub$/iu, '');
  const chunks = [], spine = tags(opf, 'itemref');
  for (let i = 0; i < spine.length; i++) {
    const ref = spine[i], item = manifest.get(ref.getAttribute('idref'));
    if (ref.getAttribute('linear') === 'no' || !item || !['application/xhtml+xml', 'text/html'].includes(item.getAttribute('media-type'))) continue;
    chunks.push(extractText(await zip.read(resolvePath(base, item.getAttribute('href')))));
    progress(i + 1, spine.length); await new Promise(resolve => setTimeout(resolve, 0));
  }
  const words = chunks.join('\n').match(/\S+/gu) || [];
  if (!words.length) throw new Error('В EPUB не найден текст в порядке spine.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(words.join('\n')));
  const id = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
  return { id, title, words };
}
