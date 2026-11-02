/*
 * RODOX — project builder (NullKat Development)
 *
 * Turns one natural-language request into a set of files written to a fresh
 * project folder. The AI never runs anything — it only returns a text block
 * in a fixed, machine-readable format, which this module parses and writes
 * to disk. RODOX itself never executes the generated code.
 *
 * Output protocol the AI must follow:
 *
 *   === FILE: relative/path.ext ===
 *   <raw file content, nothing else>
 *   === END FILE ===
 *
 * One block per file, in any order, nothing else outside the blocks is
 * written to disk (it is shown to the user as the AI's notes/plan).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIMITS = {
  maxFiles: 60,
  maxFileBytes: 400 * 1024,   // 400 KB per file
  maxTotalBytes: 3 * 1024 * 1024, // 3 MB total
};

const FILE_RE = /^=== FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n=== END FILE ===\s*$/gm;

const PROTOCOL_PROMPT = `You are RODOX's project-building mode. The user describes a software project.
Respond with a short plan (2-5 lines, plain text, no file content) followed by the complete set of
files for a working, minimal first version of that project.

Output every file using EXACTLY this format, one block per file, nothing else around the blocks:

=== FILE: relative/path/to/file.ext ===
<the complete, raw content of the file — no markdown code fences inside this block>
=== END FILE ===

Rules:
- Paths must be relative (never start with "/", never contain "..", never use a drive letter).
- Include every file needed to run the project (code, package.json / requirements.txt / etc, a short README.md), but do not invent unnecessary files.
- Do not include build output, node_modules, or other generated/vendored files.
- Do not wrap the "=== FILE ===" blocks in markdown code fences.
- Do not execute, download, or ask the user to run anything destructive.`;

/** Parses the model's reply into {plan, files:[{rel, content}]}. */
function parseBuildReply(text) {
  const files = [];
  let m;
  FILE_RE.lastIndex = 0;
  let firstIndex = text.length;
  while ((m = FILE_RE.exec(text))) {
    if (m.index < firstIndex) firstIndex = m.index;
    files.push({ rel: m[1].trim(), content: m[2] });
  }
  const plan = text.slice(0, firstIndex).trim();
  return { plan, files };
}

function sanitizeRel(rel) {
  let p = String(rel).replace(/\\/g, '/').trim();
  if (!p) return null;
  if (/\0/.test(p)) return null;
  if (/^[a-zA-Z]:/.test(p)) return null;    // drive letter (Windows absolute)
  if (p.startsWith('/')) p = p.replace(/^\/+/, '');
  const parts = p.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (parts.some((seg) => seg === '..')) return null;
  if (!parts.length) return null;
  return parts.join('/');
}

/**
 * Writes parsed files under `projectDir` (already resolved, must exist).
 * Every path is re-validated and re-resolved against projectDir so nothing
 * can be written outside it, however the model behaved.
 * Returns { written: [{rel, bytes}], skipped: [{rel, reason}], totalBytes }.
 */
function writeFiles(projectDir, files) {
  const written = [];
  const skipped = [];
  let totalBytes = 0;
  const root = path.resolve(projectDir);
  for (const f of files) {
    if (written.length >= LIMITS.maxFiles) { skipped.push({ rel: f.rel, reason: `over the ${LIMITS.maxFiles}-file limit` }); continue; }
    const rel = sanitizeRel(f.rel);
    if (!rel) { skipped.push({ rel: f.rel, reason: 'unsafe or empty path' }); continue; }
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > LIMITS.maxFileBytes) { skipped.push({ rel, reason: `file too large (${Math.round(bytes / 1024)} KB)` }); continue; }
    if (totalBytes + bytes > LIMITS.maxTotalBytes) { skipped.push({ rel, reason: 'over the total project size limit' }); continue; }
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) { skipped.push({ rel, reason: 'path escapes the project folder' }); continue; }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, 'utf8');
      written.push({ rel, bytes });
      totalBytes += bytes;
    } catch (e) {
      skipped.push({ rel, reason: e.message });
    }
  }
  return { written, skipped, totalBytes };
}

function slugify(text, fallback = 'project') {
  const s = String(text || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

/** Picks a fresh, non-colliding directory under `baseDir` for `slug`. */
function freshProjectDir(baseDir, slug) {
  let name = slug;
  let n = 2;
  while (fs.existsSync(path.join(baseDir, name))) { name = `${slug}-${n}`; n++; }
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { PROTOCOL_PROMPT, parseBuildReply, writeFiles, slugify, freshProjectDir, sanitizeRel, LIMITS };
