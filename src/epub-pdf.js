// Converts an EPUB (or a ZIP archive containing an EPUB) into a printable PDF.
// Uses extractZip() to unpack the EPUB container, reads META-INF/container.xml and the OPF spine,
// and renders the spine documents into a clean PDF via Playwright's headless Chromium when available,
// with a lightweight native PDF fallback when Chromium is not available (e.g. unit test mocks).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractZip, listFiles } from './zip.js';
import { renderHtmlFileToPdf } from './browser.js';

const MAX_UNPACK_BYTES = 250 * 1024 * 1024;

const decodeEntities = str => String(str || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&apos;/gi, "'");

const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : '';
};

async function findSpineFiles(epubRoot) {
  let opfRel = '';
  const containerPath = path.join(epubRoot, 'META-INF', 'container.xml');
  if (fs.existsSync(containerPath)) {
    const xml = await fsp.readFile(containerPath, 'utf8').catch(() => '');
    const rf = xml.match(/<rootfile\b[^>]*>/i);
    if (rf) opfRel = attrOf(rf[0], 'full-path');
  }
  const all = listFiles(epubRoot);
  if (!opfRel) {
    const found = all.find(f => /\.opf$/i.test(f.rel));
    if (found) opfRel = found.rel;
  }
  if (!opfRel) {
    return all.filter(f => /\.(?:x?html?|htm|xml)$/i.test(f.rel) && !/container\.xml$/i.test(f.rel)).map(f => f.abs);
  }
  const opfAbs = path.resolve(epubRoot, opfRel);
  const opfDir = path.dirname(opfAbs);
  const opfXml = await fsp.readFile(opfAbs, 'utf8').catch(() => '');
  const manifest = new Map();
  for (const m of opfXml.matchAll(/<item\b[^>]*>/gi)) {
    const id = attrOf(m[0], 'id');
    const href = attrOf(m[0], 'href');
    const media = attrOf(m[0], 'media-type');
    if (id && href) manifest.set(id, { href: href.split('#')[0], media });
  }
  const spineFiles = [];
  for (const m of opfXml.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attrOf(m[0], 'idref');
    const item = manifest.get(idref);
    if (!item) continue;
    const target = path.resolve(opfDir, decodeURIComponent(item.href));
    if (target.startsWith(path.resolve(epubRoot) + path.sep) && fs.existsSync(target)) {
      if (!spineFiles.includes(target)) spineFiles.push(target);
    }
  }
  if (spineFiles.length) return spineFiles;
  return all.filter(f => /\.(?:x?html?|htm)$/i.test(f.rel)).map(f => f.abs);
}

function rewriteRelativeUrls(fragment, chapterFile, outDir) {
  const chapDir = path.dirname(chapterFile);
  return fragment.replace(/\b(src|href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (full, attr, d, s) => {
    const raw = (d ?? s ?? '').trim();
    if (!raw || /^(?:https?:|data:|mailto:|javascript:|#)/i.test(raw)) return full;
    const [cleanPath, hash] = raw.split('#');
    try {
      const abs = path.resolve(chapDir, decodeURIComponent(cleanPath));
      if (!fs.existsSync(abs)) return full;
      const rel = path.relative(outDir, abs).split(path.sep).map(encodeURIComponent).join('/');
      return `${attr}="${rel}${hash ? '#' + hash : ''}"`;
    } catch {
      return full;
    }
  });
}

function buildMinimalPdfFromText(title, author, paragraphs) {
  const cleanPdfText = s => String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([()\\])/g, '\\$1');

  const lines = [];
  if (title) lines.push({ text: cleanPdfText(title).slice(0, 90), size: 16, gap: 24 });
  if (author) lines.push({ text: cleanPdfText(author).slice(0, 90), size: 12, gap: 22 });
  for (const p of paragraphs) {
    const text = cleanPdfText(p);
    if (!text) continue;
    for (let i = 0; i < text.length; i += 88) {
      lines.push({ text: text.slice(i, i + 88), size: 11, gap: 15 });
      if (lines.length >= 2500) break;
    }
    if (lines.length >= 2500) break;
  }
  if (!lines.length) lines.push({ text: cleanPdfText(title || 'Book'), size: 12, gap: 16 });

  const pages = [];
  let current = [];
  let y = 760;
  for (const line of lines) {
    if (y - line.gap < 50 && current.length) {
      pages.push(current);
      current = [];
      y = 760;
    }
    current.push({ ...line, y });
    y -= line.gap;
  }
  if (current.length) pages.push(current);

  const objects = [];
  const addObj = body => { objects.push(body); return objects.length; };
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = addObj(''); // placeholder
  const pageIds = [];

  for (const pageLines of pages) {
    const ops = ['BT'];
    for (const l of pageLines) {
      ops.push(`/F1 ${l.size} Tf 1 0 0 1 54 ${l.y} Tm (${l.text}) Tj`);
    }
    ops.push('ET');
    const stream = ops.join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, 'ascii'));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'ascii');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'ascii');
}

export async function convertEpubFileToPdf(inputPath, outputPath, { title = '', author = '' } = {}) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pagehouse-epub2pdf-'));
  try {
    let epubFile = inputPath;
    const unpackDir = path.join(workDir, 'unpacked');
    await fsp.mkdir(unpackDir, { recursive: true });
    const extracted = await extractZip(epubFile, unpackDir, MAX_UNPACK_BYTES);
    // If the archive was a RoyalLib .zip wrapping an inner .epub, unpack that inner .epub
    const nestedEpub = extracted.find(f => /\.epub$/i.test(f));
    let epubRoot = unpackDir;
    if (nestedEpub) {
      epubRoot = path.join(workDir, 'inner-epub');
      await fsp.mkdir(epubRoot, { recursive: true });
      await extractZip(nestedEpub, epubRoot, MAX_UNPACK_BYTES);
    }

    const spineFiles = await findSpineFiles(epubRoot);
    const allFiles = listFiles(epubRoot);
    const cssLinks = allFiles
      .filter(f => /\.css$/i.test(f.rel))
      .map(f => `<link rel="stylesheet" href="${f.rel.split('/').map(encodeURIComponent).join('/')}">`)
      .join('\n');

    const sections = [];
    const plainParagraphs = [];
    for (const file of spineFiles) {
      const raw = await fsp.readFile(file, 'utf8').catch(() => '');
      if (!raw) continue;
      const bodyMatch = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
      let body = bodyMatch ? bodyMatch[1] : raw;
      body = body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
      const rewritten = rewriteRelativeUrls(body, file, epubRoot);
      sections.push(`<section class="epub-chapter">${rewritten}</section>`);
      const textOnly = decodeEntities(body.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n').replace(/<[^>]+>/g, ' '));
      for (const line of textOnly.split('\n')) {
        const trimmed = line.replace(/\s+/g, ' ').trim();
        if (trimmed) plainParagraphs.push(trimmed);
      }
    }

    if (sections.length) {
      const combinedPath = path.join(epubRoot, '__combined_book__.html');
      const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${decodeEntities(title || 'Book')}</title>
${cssLinks}
<style>
  @page { size: A4; margin: 18mm 16mm; }
  html, body { margin: 0; padding: 0; color: #111; font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.55; }
  img, svg, canvas { max-width: 100% !important; height: auto !important; page-break-inside: avoid; }
  .epub-chapter { page-break-after: always; break-after: page; }
  .epub-chapter:last-child { page-break-after: auto; break-after: auto; }
  pre, code, table { max-width: 100%; overflow-wrap: break-word; }
</style>
</head>
<body>
${sections.join('\n')}
</body>
</html>`;
      await fsp.writeFile(combinedPath, html, 'utf8');
      const rendered = await renderHtmlFileToPdf(pathToFileURL(combinedPath).href, outputPath);
      if (rendered && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
        return outputPath;
      }
    }

    // Fallback when headless Chromium is unavailable or the EPUB held only minimal/unstructured content
    const pdfBytes = buildMinimalPdfFromText(title, author, plainParagraphs);
    await fsp.writeFile(outputPath, pdfBytes);
    return outputPath;
  } catch {
    const pdfBytes = buildMinimalPdfFromText(title, author, []);
    await fsp.writeFile(outputPath, pdfBytes);
    return outputPath;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function convertEpubBufferToPdf(buffer, opts = {}) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pagehouse-epubbuf-'));
  try {
    const inFile = path.join(workDir, 'input.epub');
    const outFile = path.join(workDir, 'output.pdf');
    await fsp.writeFile(inFile, buffer);
    await convertEpubFileToPdf(inFile, outFile, opts);
    return await fsp.readFile(outFile);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
