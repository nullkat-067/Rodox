#!/usr/bin/env node
/*
 * RODOX v2.0.0 — Intelligent Terminal AI
 * "Think beyond commands."
 * Made by: NullKat Development
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const readline = require('readline');
const chalk = require('chalk');
const { highlight, supportsLanguage } = require('cli-highlight');
const { createProvider } = require('./lib/providers.js');
const builder = require('./lib/builder.js');

// Some hosts advertise IPv6 addresses that are not actually routable (common on
// budget VPS providers). Reordering alone isn't always enough — some HTTP clients
// (including the Gemini SDK's) don't honor it — so dns.lookup() is forced to
// return IPv4 only. This affects this process only, never the OS network config.
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* older Node */ }
const _lookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  else options = { ...options };
  options.family = 4;
  return _lookup(hostname, options, callback);
};

/* ───────────────────────────── constants ───────────────────────────── */

const APP = {
  name: 'RODOX',
  version: '2.0.0',
  dev: 'NullKat Development',
  tagline: 'Think beyond commands.',
};
const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
const PROMPT_PATH = path.join(ROOT, 'config', 'system.prompt.txt');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const DEFAULT_MODEL = 'gemini-3.8-flash';
const LIMITS = {
  timeoutMs: 60000,      // per generation request
  probeMs: 15000,        // key / model checks
  maxRetries: 2,         // network / 5xx only, never infinite
  maxMessages: 24,       // compact history above this many messages
  keepMessages: 10,      // messages kept verbatim after compaction
  maxHistoryChars: 60000 // compact history above this many characters
};
const COMMANDS = {
  '/help': 'Show this command list',
  '/about': 'About RODOX and NullKat Development',
  '/setup': 'Choose a provider and enter your API key  (also: /apikey)',
  '/provider': 'Show / switch AI provider  (/provider switch)',
  '/model': 'Show / list / switch model  (/model list | /model <name>)',
  '/build': 'Generate a new project into projects/<name>/  (/build <description>) — never executes anything',
  '/personality': 'Summary of the loaded system prompt',
  '/stats': 'Session statistics',
  '/prompt': 'Show system prompt  (/prompt reload to re-read the file)',
  '/reset': 'Wipe session memory and reload the system prompt',
  '/clear': 'Clear the screen (memory is kept)',
  '/version': 'Version and runtime info',
  '/exit': 'End the session',
};

const PROMPT_TEMPLATE = `<!--
RODOX SYSTEM PROMPT — NullKat Development

File ini HARUS kamu isi sendiri dengan instruksi utama untuk Gemini
(karakter, gaya bicara, aturan, bahasa, dsb). RODOX tidak menyertakan
persona bawaan.

- Tulis instruksimu di bawah blok komentar ini.
- Teks di dalam blok komentar seperti ini diabaikan.
- Perubahan dipakai pada sesi berikutnya, atau langsung lewat /prompt reload.
-->
`;

/* ───────────────────────────── styling ───────────────────────────── */

const C = {
  red: chalk.hex('#ff2d2d'),
  hot: chalk.hex('#ff5a5a'),
  deep: chalk.hex('#b3001b'),
  blood: chalk.hex('#7a0012'),
  dim: chalk.hex('#7d7d7d'),
  text: chalk.hex('#e6e6e6'),
  white: chalk.hex('#ffffff'),
  ok: chalk.hex('#3ddc84'),
  warn: chalk.hex('#ffb020'),
  err: chalk.hex('#ff4d4d'),
  link: chalk.hex('#6ab7ff').underline,
  code: chalk.bgHex('#2b0b10').hex('#ff9c9c'),
  cyan: chalk.hex('#4dd0e1'),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI_RE, '');
const vlen = (s) => strip(s).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTTY = () => Boolean(process.stdout.isTTY);
const termW = () => process.stdout.columns || 80;
const contentW = () => Math.max(28, Math.min(termW() - 4, 96));

function hsl2rgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/** RGB cycling text: every letter gets its own hue, shifted by `offset`. */
function rgbText(text, offset = 0, step = 30) {
  let out = '';
  let i = 0;
  for (const ch of text) {
    if (ch === ' ') { out += ch; i++; continue; }
    const [r, g, b] = hsl2rgb((offset + i * step) % 360, 100, 60);
    out += chalk.rgb(r, g, b).bold(ch);
    i++;
  }
  return out;
}

const LOGO_LETTERS = {
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  X: ['██╗  ██╗', '╚██╗██╔╝', ' ╚███╔╝ ', ' ██╔██╗ ', '██╔╝ ██╗', '╚═╝  ╚═╝'],
};
const LOGO_ROWS = Array.from({ length: 6 }, (_, r) =>
  ['R', 'O', 'D', 'O', 'X'].map((k) => LOGO_LETTERS[k][r]).join(''));
const LOGO_GRADIENT = ['#ff4545', '#ff2d2d', '#e61e2a', '#c4121f', '#9e0b19', '#7a0612'];
const LOGO_WIDTH = vlen(LOGO_ROWS[0]);

function printLogo() {
  console.log('');
  if (termW() >= LOGO_WIDTH + 4) {
    LOGO_ROWS.forEach((row, i) => console.log('  ' + chalk.hex(LOGO_GRADIENT[i])(row)));
    console.log('  ' + C.blood('━'.repeat(LOGO_WIDTH)));
  } else {
    console.log('  ' + C.deep('▌') + C.red.bold(' R O D O X ') + C.deep('▐'));
    console.log('  ' + C.blood('━'.repeat(Math.max(10, termW() - 6))));
  }
}

async function animateNullkat(frames = 34, ms = 34) {
  const label = 'NULLKAT'.split('').join(' ');
  const dev = C.dim('  D E V E L O P M E N T');
  if (!isTTY()) { console.log('  ' + rgbText(label, 0) + dev); return; }
  process.stdout.write('\x1b[?25l');
  for (let f = 0; f < frames; f++) {
    process.stdout.write('\r  ' + rgbText(label, f * 20) + dev);
    await sleep(ms);
  }
  process.stdout.write('\n\x1b[?25h');
}

function box(title, rows) {
  const width = Math.max(24, Math.min(termW() - 4, 58));
  console.log(C.deep('  ┌─ ') + C.red.bold(title) + ' ' + C.deep('─'.repeat(Math.max(2, width - vlen(title) - 4))));
  const labelW = Math.max(9, ...rows.filter(Array.isArray).map((r) => String(r[0]).length + 1));
  for (const row of rows) {
    if (Array.isArray(row)) console.log(C.deep('  │ ') + C.dim(String(row[0]).padEnd(labelW)) + row[1]);
    else console.log(C.deep('  │ ') + row);
  }
  console.log(C.deep('  └' + '─'.repeat(width - 1)));
}

function note(msg, color = C.dim) { console.log('  ' + color(msg)); }

function printError(c) {
  console.log('');
  console.log('  ' + C.err('✖ ') + C.err.bold(c.title));
  if (c.hint) for (const l of wrap(C.dim(c.hint), contentW() - 2, '    ', '    ')) console.log(l);
  console.log('');
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A boot step: shows a spinner while `fn` really runs, then the real result. */
async function step(tag, text, fn, minMs = 130) {
  const tagStr = C.red.bold(`[${tag}]`);
  const started = Date.now();
  let timer = null;
  let i = 0;
  if (isTTY()) {
    const draw = () => process.stdout.write(`\r\x1b[2K  ${tagStr} ${C.text(text)} ${C.deep(SPIN[i++ % SPIN.length])}`);
    draw();
    timer = setInterval(draw, 80);
  }
  let res;
  try { res = await fn(); } catch (e) { res = { state: 'fail', detail: redact(e && e.message ? e.message : String(e)) }; }
  if (!res || typeof res !== 'object') res = { state: 'ok' };
  const wait = minMs - (Date.now() - started);
  if (wait > 0 && isTTY()) await sleep(wait);
  if (timer) clearInterval(timer);
  const mark = res.state === 'ok' ? C.ok('✔') : res.state === 'warn' ? C.warn('▲') : C.err('✖');
  const detail = res.detail ? ' ' + C.dim(res.detail) : '';
  const line = `  ${tagStr} ${C.text(text.replace(/\.\.\.$/, ''))} ${mark}${detail}`;
  if (isTTY()) process.stdout.write('\r\x1b[2K');
  console.log(line);
  return res;
}

/* ───────────────────────────── config / env ───────────────────────────── */

const state = {
  providerType: 'gemini',   // 'gemini' or a slug for a custom OpenAI-compatible provider
  providerLabel: 'Gemini',
  baseUrl: '',
  apiKey: '',
  model: DEFAULT_MODEL,
  timeoutMs: LIMITS.timeoutMs,
  provider: null,
  online: false,
  verifiedModel: null,
  prompt: { status: 'unknown', text: '', chars: 0, lines: 0 },
  history: [],        // [{ role: 'user' | 'model', parts: [{ text }] }]
  summary: '',
  abort: null,
  startedAt: Date.now(),
  stats: { turns: 0, requests: 0, ok: 0, failed: 0, retries: 0, inTok: 0, outTok: 0, latency: 0, compactions: 0 },
};

function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function loadEnv() {
  try {
    const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
    for (const k of Object.keys(env)) if (process.env[k] === undefined) process.env[k] = env[k];
  } catch (_) { /* no .env yet */ }
}

function saveEnv(updates) {
  let lines;
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/); }
  catch (_) { lines = ['# RODOX configuration (NullKat Development)', '# Never commit this file.']; }
  const seen = new Set();
  lines = lines.map((l) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return l;
  });
  for (const k of Object.keys(updates)) if (!seen.has(k)) lines.push(`${k}=${updates[k]}`);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) { /* e.g. Windows */ }
  for (const k of Object.keys(updates)) process.env[k] = updates[k];
}

const maskKey = (k) => (k ? '••••••••' + k.slice(-4) : '(none)');
function redact(s) {
  let out = String(s);
  if (state.apiKey) out = out.split(state.apiKey).join('[redacted]');
  return out.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[redacted]');
}

/** Loads provider config from process.env (set by loadEnv()). Old GEMINI_* vars
 *  keep working for anyone who set RODOX up before v2.0 added other providers. */
function loadProviderConfig() {
  const hadProviderEnv = Boolean((process.env.RODOX_PROVIDER || '').trim());
  const type = (process.env.RODOX_PROVIDER || 'gemini').trim().toLowerCase();
  state.providerType = type;
  if (type === 'gemini') {
    state.providerLabel = 'Gemini';
    state.apiKey = (process.env.RODOX_API_KEY || process.env.GEMINI_API_KEY || '').trim();
    state.model = (process.env.RODOX_MODEL || process.env.GEMINI_MODEL || '').trim() || DEFAULT_MODEL;
    state.baseUrl = '';
  } else {
    state.providerLabel = (process.env.RODOX_PROVIDER_LABEL || type).trim();
    state.apiKey = (process.env.RODOX_API_KEY || '').trim();
    state.model = (process.env.RODOX_MODEL || '').trim();
    state.baseUrl = (process.env.RODOX_BASE_URL || '').trim();
  }
  return { hadProviderEnv, missingSetup: type !== 'gemini' && (!state.baseUrl || !state.model) };
}

function saveProviderConfig() {
  if (state.providerType === 'gemini') {
    saveEnv({
      RODOX_PROVIDER: 'gemini', RODOX_PROVIDER_LABEL: 'Gemini',
      RODOX_API_KEY: state.apiKey, RODOX_MODEL: state.model,
      GEMINI_API_KEY: state.apiKey, GEMINI_MODEL: state.model,
    });
  } else {
    saveEnv({
      RODOX_PROVIDER: state.providerType, RODOX_PROVIDER_LABEL: state.providerLabel,
      RODOX_BASE_URL: state.baseUrl, RODOX_API_KEY: state.apiKey, RODOX_MODEL: state.model,
    });
  }
}

/** Builds a provider client from current (or overridden) state. */
function makeProvider(model = state.model) {
  return createProvider({
    type: state.providerType === 'gemini' ? 'gemini' : 'openai',
    apiKey: state.apiKey,
    model,
    baseUrl: state.baseUrl,
    label: state.providerLabel,
  });
}

function readSystemPrompt() {
  let raw;
  try { raw = fs.readFileSync(PROMPT_PATH, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      try {
        fs.mkdirSync(path.dirname(PROMPT_PATH), { recursive: true });
        fs.writeFileSync(PROMPT_PATH, PROMPT_TEMPLATE);
      } catch (_) { /* ignore */ }
      return { status: 'empty', text: '', chars: 0, lines: 0, note: 'file was missing; a template was created' };
    }
    return { status: 'unreadable', text: '', chars: 0, lines: 0, note: e.message };
  }
  const text = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return { status: 'empty', text: '', chars: 0, lines: 0 };
  return { status: 'ready', text, chars: text.length, lines: text.split('\n').length };
}

function loadPrompt() { state.prompt = readSystemPrompt(); return state.prompt; }

const PROMPT_REQUIRED_MSG =
  'config/system.prompt.txt is empty. Write your instructions for Gemini in that file, ' +
  'then run /prompt reload (or restart RODOX). No request is sent before it is filled.';

/* ───────────────────────────── errors ───────────────────────────── */

// Errors reaching here are either a plain {rodox:'timeout'|'cancelled'} Error from
// guarded(), or a ProviderError from lib/providers.js (status/message/cause/retryAfterSec
// already normalized for both Gemini and OpenAI-compatible providers).
function classify(err) {
  const label = state.providerLabel || 'the provider';
  if (err && err.rodox === 'timeout') {
    return { kind: 'timeout', title: 'Request timed out', hint: `${label} did not answer within ${Math.round(state.timeoutMs / 1000)}s. Try again, or set RODOX_TIMEOUT_MS in .env.` };
  }
  if (err && err.rodox === 'cancelled') return { kind: 'cancelled', title: 'Request cancelled' };

  const status = Number(err && err.status) || 0;
  const apiMsg = redact(err && err.message ? err.message : String(err));
  const probeText = apiMsg + ' ' + redact(err && err.raw ? String(err.raw) : '');
  const causeCode = err && err.cause && err.cause.code;

  if (/API key not valid|API_KEY_INVALID|API key expired|invalid api key/i.test(probeText) || status === 401) {
    const extra = state.providerType === 'gemini'
      ? ' Create a new one at https://aistudio.google.com/apikey and update it in .env (or delete it to re-run setup).'
      : ' Check the key in .env, or run /provider switch to re-enter it.';
    return { kind: 'auth', title: 'API key is invalid', hint: `${label} rejected the key.${extra}` };
  }
  if (status === 403) {
    return { kind: 'auth', title: 'Access denied (403)', hint: `The key is not allowed to use this model or region. ${apiMsg}` };
  }
  if (status === 404) {
    return { kind: 'model', title: `Model "${state.model}" is not available`, hint: `${apiMsg} — try /model list, then /model <name>.` };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(probeText)) {
    const delay = err && err.retryAfterSec;
    if (/PerDay|per day|daily/i.test(probeText)) {
      return { kind: 'quota', title: 'Daily quota exhausted', hint: `The free tier has usage limits. Wait for the quota to reset, switch model with /model, or check usage with ${label}.` };
    }
    return { kind: 'rate', title: 'Rate limit reached', retryAfter: delay || null, hint: `Too many requests${delay ? ` — try again in about ${delay}s` : ' — wait a moment and try again'}.` };
  }
  if (status >= 500 && status < 600) {
    return { kind: 'server', title: `${label} service error (${status})`, retryable: true, hint: `${label} is temporarily unavailable or overloaded.` };
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH'].includes(causeCode) ||
      ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(err && err.code) ||
      /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i.test(probeText)) {
    return { kind: 'network', title: `Cannot reach ${label}`, retryable: true, hint: 'Check your internet connection (and proxy / VPN) and try again.' };
  }
  if (status === 400) return { kind: 'bad_request', title: `${label} rejected the request (400)`, hint: apiMsg };
  return { kind: 'unknown', title: 'Unexpected error', hint: apiMsg.slice(0, 300) };
}

/* ───────────────────────────── request plumbing ───────────────────────────── */

/** Runs a call with a hard timeout + cancel support, independent of SDK abort support. */
function guarded(makeCall, ms, { cancellable = false } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  if (cancellable) state.abort = ctrl;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  const call = Promise.resolve().then(() => makeCall(ctrl.signal));
  call.catch(() => {});
  const stop = new Promise((_, reject) => {
    ctrl.signal.addEventListener('abort', () => {
      const e = new Error(timedOut ? 'Request timed out' : 'Request cancelled');
      e.rodox = timedOut ? 'timeout' : 'cancelled';
      reject(e);
    }, { once: true });
  });
  stop.catch(() => {});
  return Promise.race([call, stop]).finally(() => {
    clearTimeout(timer);
    if (state.abort === ctrl) state.abort = null;
  });
}

// A real (tiny) generation call, not a model-metadata lookup: metadata only checks
// that the model name exists, not that this key/tier is allowed to generate with
// it — that mismatch is what let boot say "connected" while chat then failed.
const probeProvider = (provider) => guarded((signal) => provider.probe(signal), LIMITS.probeMs);

async function generateWithRetry(contents, systemInstruction) {
  let attempt = 0;
  for (;;) {
    try {
      state.stats.requests++;
      return await guarded(
        (signal) => state.provider.generate({ contents, systemInstruction, signal }),
        state.timeoutMs,
        { cancellable: true },
      );
    } catch (e) {
      const c = classify(e);
      if (c.retryable && attempt < LIMITS.maxRetries) {
        attempt++;
        state.stats.retries++;
        const wait = 1500 * 2 ** (attempt - 1);
        note(`${c.title} — retrying in ${wait / 1000}s (${attempt}/${LIMITS.maxRetries})`, C.warn);
        await sleep(wait);
        continue;
      }
      e.classified = c;
      throw e;
    }
  }
}

/* ───────────────────────────── memory ───────────────────────────── */

const historyChars = () => state.history.reduce((n, m) => n + m.parts.reduce((a, p) => a + (p.text || '').length, 0), 0);

function systemInstruction() {
  let s = state.prompt.text;
  if (state.summary) s += `\n\n---\nSummary of the earlier part of this conversation (for context only):\n${state.summary}`;
  return s;
}

async function compactHistory() {
  if (state.history.length <= LIMITS.maxMessages && historyChars() <= LIMITS.maxHistoryChars) return;
  // cut so the remaining history starts with a user message
  let cut = Math.max(0, state.history.length - LIMITS.keepMessages);
  while (cut < state.history.length && state.history[cut].role !== 'user') cut++;
  if (cut <= 0 || cut >= state.history.length) return;
  const chunk = state.history.slice(0, cut);
  const transcript = chunk
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.parts.map((p) => p.text).join('').slice(0, 4000)}`)
    .join('\n\n');
  const input = (state.summary ? `PREVIOUS SUMMARY:\n${state.summary}\n\n` : '') + `NEW MESSAGES:\n${transcript}`;
  try {
    state.stats.requests++;
    const r = await guarded((signal) => state.provider.generate({
      contents: [{ role: 'user', parts: [{ text: input }] }],
      systemInstruction: 'You compress conversations. Write a concise, factual summary (max 200 words) of the transcript, ' +
        'keeping user goals, decisions, code context, file names, errors and open questions. Output only the summary.',
      signal,
    }), 30000);
    const text = (r && r.text ? r.text : '').trim();
    if (text) { state.summary = text; state.stats.ok++; }
  } catch (_) {
    state.stats.failed++;
    note('(could not summarise older context — dropping it instead)', C.dim);
  }
  state.history = state.history.slice(cut);
  state.stats.compactions++;
}

/* ───────────────────────────── markdown renderer ───────────────────────────── */

const HL_THEME = {
  keyword: chalk.hex('#ff5a5a'), built_in: C.cyan, type: C.cyan, literal: chalk.hex('#ffb020'),
  number: chalk.hex('#ffb020'), regexp: chalk.hex('#ff9c9c'), string: chalk.hex('#3ddc84'),
  subst: C.text, symbol: chalk.hex('#ffb020'), class: C.cyan, function: chalk.hex('#ff8a65'),
  title: chalk.hex('#ff8a65'), params: C.text, comment: chalk.hex('#6b6b6b').italic, doctag: chalk.hex('#6b6b6b'),
  meta: chalk.hex('#b388ff'), 'meta-keyword': chalk.hex('#b388ff'), 'meta-string': chalk.hex('#3ddc84'),
  section: chalk.hex('#ff5a5a').bold, tag: chalk.hex('#ff5a5a'), name: chalk.hex('#ff5a5a'),
  'builtin-name': C.cyan, attr: C.cyan, attribute: C.cyan, variable: C.text, bullet: chalk.hex('#ff5a5a'),
  code: C.text, emphasis: chalk.italic, strong: chalk.bold, formula: C.text, link: C.link, quote: chalk.hex('#6b6b6b'),
  'selector-tag': chalk.hex('#ff5a5a'), 'selector-id': C.cyan, 'selector-class': C.cyan,
  'selector-attr': C.cyan, 'selector-pseudo': C.cyan, 'template-tag': chalk.hex('#ff5a5a'),
  'template-variable': C.text, addition: chalk.hex('#3ddc84'), deletion: chalk.hex('#ff4d4d'), default: C.text,
};

function wrap(text, width, firstIndent = '', restIndent = '') {
  const words = text.split(/ +/).filter((w) => w.length);
  const lines = [];
  let line = firstIndent;
  let len = vlen(firstIndent);
  let empty = true;
  for (const w of words) {
    const wl = vlen(w);
    if (!empty && len + 1 + wl > width) {
      lines.push(line);
      line = restIndent;
      len = vlen(restIndent);
      empty = true;
    }
    if (!empty) { line += ' '; len++; }
    line += w;
    len += wl;
    empty = false;
  }
  lines.push(line);
  return lines;
}

function inline(text) {
  const spans = [];
  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, t, code) => {
    spans.push(code.trim());
    return `\u0000${spans.length - 1}\u0000`;
  });
  const links = [];
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)[^)]*\)/g, (m, t, u) => {
    links.push(C.link(strip(inline(t))) + C.dim(` (${u})`));
    return `\u0001${links.length - 1}\u0001`;
  });
  text = text
    .replace(/\*\*\*(.+?)\*\*\*/g, (m, t) => chalk.bold.italic(t))
    .replace(/\*\*(.+?)\*\*/g, (m, t) => C.white.bold(t))
    .replace(/(^|[^*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?!\*)/g, (m, p, t) => p + chalk.italic(t))
    .replace(/(^|[^\w])_(?![\s_])(.+?)(?<![\s_])_(?!\w)/g, (m, p, t) => p + chalk.italic(t))
    .replace(/~~(.+?)~~/g, (m, t) => chalk.strikethrough(t));
  text = text.replace(/\u0001(\d+)\u0001/g, (m, i) => links[Number(i)]);
  return text.replace(/\u0000(\d+)\u0000/g, (m, i) => C.code(spans[Number(i)]));
}

function renderCode(code, lang, width) {
  const l = (lang || '').toLowerCase();
  let body;
  try {
    body = l && supportsLanguage(l)
      ? highlight(code, { language: l, ignoreIllegals: true, theme: HL_THEME })
      : C.text(code);
  } catch (_) { body = C.text(code); }
  const label = l ? l.toUpperCase() : 'CODE';
  const barW = Math.max(8, Math.min(width, 60));
  const out = [C.deep('┌─ ') + C.red.bold(label) + ' ' + C.deep('─'.repeat(Math.max(2, barW - label.length - 4)))];
  for (const ln of body.replace(/\t/g, '  ').split('\n')) out.push(C.deep('│ ') + ln);
  out.push(C.deep('└' + '─'.repeat(barW - 1)));
  return out;
}

function renderTable(rows, width) {
  const cells = rows.map((r) => r.map((c) => inline(c.trim())));
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((r) => vlen(r[i] || ''))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * cols + 1;
  const out = [];
  if (total > width) {
    const head = cells[0].map(strip);
    for (const r of cells.slice(1)) {
      out.push(C.red('▸ ') + (r[0] || ''));
      for (let j = 1; j < cols; j++) out.push('  ' + C.dim((head[j] || '') + ': ') + (r[j] || ''));
    }
    return out;
  }
  const line = (l, m, r) => C.deep(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (r, header) => C.deep('│') + widths.map((w, i) => {
    const c = r[i] || '';
    return ' ' + (header ? C.red.bold(strip(c)) : c) + ' '.repeat(w - vlen(c)) + ' ';
  }).join(C.deep('│')) + C.deep('│');
  out.push(line('┌', '┬', '┐'), row(cells[0], true), line('├', '┼', '┤'));
  for (const r of cells.slice(1)) out.push(row(r, false));
  out.push(line('└', '┴', '┘'));
  return out;
}

function renderMarkdown(src, width = contentW()) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const pushBlank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)/);
    if (fence) {
      const mark = fence[1][0];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${mark === '`' ? '`' : '~'}{3,}\\s*$`).test(lines[i])) { code.push(lines[i]); i++; }
      i++; // closing fence
      out.push(...renderCode(code.join('\n'), fence[2], width));
      continue;
    }

    if (/^\s*$/.test(line)) { pushBlank(); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      pushBlank();
      const t = h[2].replace(/[*_`]/g, '');
      out.push(h[1].length === 1 ? C.red.bold('▌ ' + t.toUpperCase()) : h[1].length === 2 ? C.red.bold('▸ ' + t) : C.white.bold(t));
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(C.blood('─'.repeat(Math.min(width, 48)))); i++; continue; }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows = [];
      const parse = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      rows.push(parse(line));
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) { rows.push(parse(lines[i])); i++; }
      out.push(...renderTable(rows, width));
      continue;
    }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      const bar = C.deep('▎ ');
      out.push(...wrap(C.dim(inline(q[1])), width, bar, bar));
      i++;
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const lvl = Math.floor(li[1].replace(/\t/g, '  ').length / 2);
      const ordered = /\d/.test(li[2]);
      let marker = ordered ? C.red(li[2]) : C.red(['•', '◦', '▪'][lvl % 3]);
      let body = li[3];
      const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) { marker = task[1] === ' ' ? C.dim('☐') : C.ok('☑'); body = task[2]; }
      const first = '  '.repeat(lvl) + marker + ' ';
      out.push(...wrap(inline(body), width, first, ' '.repeat(vlen(first))));
      i++;
      continue;
    }

    out.push(...wrap(inline(line.trim()), width));
    i++;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/* ───────────────────────────── ui helpers ───────────────────────────── */

function startThinking() {
  if (!isTTY()) return { stop() {} };
  const frames = ['▰▱▱▱', '▰▰▱▱', '▰▰▰▱', '▱▰▰▰', '▱▱▰▰', '▱▱▱▰'];
  const t0 = Date.now();
  let i = 0;
  const draw = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    process.stdout.write(`\r\x1b[2K  ${C.red(frames[i++ % frames.length])} ${C.dim('RODOX is thinking')} ${C.blood(s + 's')}  ${C.blood('(Ctrl+C to cancel)')}`);
  };
  process.stdout.write('\x1b[?25l');
  draw();
  const timer = setInterval(draw, 110);
  return {
    stop() { clearInterval(timer); process.stdout.write('\r\x1b[2K\x1b[?25h'); },
  };
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function sdkVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@google', 'genai', 'package.json'), 'utf8')).version; }
  catch (_) { return 'unknown'; }
}

function statusRows() {
  const p = state.prompt;
  return [
    ['provider', C.white(state.providerLabel)],
    ['model', C.white(state.model)],
    ['api key', maskKey(state.apiKey)],
    ['prompt', p.status === 'ready' ? C.ok(`ready · ${p.chars} chars`) : C.warn(p.status === 'unreadable' ? 'unreadable' : 'EMPTY — fill config/system.prompt.txt')],
    ['memory', `temporary · ${state.history.length}/${LIMITS.maxMessages} msgs`],
    ['link', state.online ? C.ok('connected') : C.warn('not verified')],
    ['runtime', `node ${process.version} · ${os.platform()}`],
  ];
}

/* ───────────────────────────── key input / onboarding ───────────────────────────── */

// The single readline interface driving the whole REPL (set by startRepl()). Every
// in-REPL prompt (setup, /build's project name, ...) reads through THIS SAME
// interface via rl.question() — never a second raw-mode stdin reader. Two
// concurrent readers on one stdin is what previously let typed input (including
// the API key) also leak into the main REPL's line buffer and get replayed as
// chat messages once the prompt finished.
let mainRl = null;

/** Visible line via the shared readline interface. Type /cancel to abort. */
function askVisible(label) {
  return new Promise((resolve) => {
    if (!mainRl) { resolve(null); return; }
    mainRl.question(label, (answer) => resolve(answer));
  });
}

/** Same, but typed characters show as • instead of being echoed — even when the
 *  whole key arrives in one burst (a paste), not just when typed key-by-key.
 *  Works by muting readline's OWN echo at the source (overriding the method it
 *  uses to write to the terminal) instead of racing it with a second listener,
 *  which only masked single keystrokes and still flashed pasted text briefly. */
function askHidden(label) {
  return new Promise((resolve) => {
    if (!mainRl || !process.stdin.isTTY) { resolve(null); return; }
    const originalWrite = mainRl._writeToOutput ? mainRl._writeToOutput.bind(mainRl) : null;
    if (!originalWrite) { // defensive fallback for a readline implementation without this hook
      mainRl.question(label, (answer) => resolve(answer));
      return;
    }
    let muted = false;
    mainRl._writeToOutput = (str) => {
      if (!muted) { originalWrite(str); return; }
      // Keep ANSI/cursor-control sequences and whitespace intact (so redraw/backspace
      // still work); replace only the visible characters readline would have echoed.
      originalWrite(str.replace(/(\x1b\[[0-9;]*[A-Za-z])|([^\s\x1b])/g, (m, esc, ch) => (esc || (ch ? '•' : m))));
    };
    mainRl.question(label, (answer) => {
      mainRl._writeToOutput = originalWrite;
      resolve(answer);
    });
    muted = true; // the label itself was already written synchronously by question() above
  });
}

/** Interactive provider picker: Gemini (official SDK) or a custom OpenAI-compatible
 *  provider the user already has legitimate access to (their own base URL + key).
 *  Returns {type, label, baseUrl, model} or null if the user cancelled. */
async function chooseProviderInteractive() {
  console.log('');
  box('CHOOSE PROVIDER', [
    C.white('1) Gemini') + C.dim('  — official Google SDK (recommended)'),
    C.white('2) Custom provider') + C.dim(' — any OpenAI-compatible API you already have access to'),
    C.dim('Type /cancel to abort.'),
  ]);
  console.log('');
  let choice;
  for (;;) {
    const raw = await askVisible('  ' + C.white('Choice [1]:') + ' ' + C.red('› '));
    if (raw === null || raw.trim().toLowerCase() === '/cancel') return null;
    choice = raw.trim() || '1';
    if (choice === '1' || /^gemini$/i.test(choice)) return { type: 'gemini', label: 'Gemini', baseUrl: '', model: DEFAULT_MODEL };
    if (choice === '2' || /^custom$/i.test(choice)) break;
    note('Type 1 or 2.', C.warn);
  }
  let label;
  for (;;) {
    const raw = await askVisible('  ' + C.white('Provider name (e.g. Groq):') + ' ' + C.red('› '));
    if (raw === null) return null;
    if (raw.trim()) { label = raw.trim().slice(0, 30); break; }
    note('Enter a short name.', C.warn);
  }
  let baseUrl;
  for (;;) {
    const raw = await askVisible('  ' + C.white('API base URL (e.g. https://api.groq.com/openai/v1):') + ' ' + C.red('› '));
    if (raw === null) return null;
    const v = raw.trim().replace(/\/+$/, '');
    if (/^https?:\/\/.+/.test(v)) { baseUrl = v; break; }
    note('Must start with http:// or https://', C.warn);
  }
  let model;
  for (;;) {
    const raw = await askVisible('  ' + C.white('Model name:') + ' ' + C.red('› '));
    if (raw === null) return null;
    if (raw.trim()) { model = raw.trim(); break; }
    note('Enter a model name.', C.warn);
  }
  return { type: builder.slugify(label, 'custom'), label, baseUrl, model };
}

async function onboarding(reason, { reconfigure = false } = {}) {
  if (!process.stdin.isTTY) {
    console.log('');
    note('An API key is required and no interactive terminal is available.', C.err);
    note('Set it in .env (see .env.example) and run again.', C.dim);
    return false;
  }
  if (reconfigure) {
    const picked = await chooseProviderInteractive();
    if (!picked) { console.log(''); note('Setup cancelled.', C.warn); return false; }
    state.providerType = picked.type;
    state.providerLabel = picked.label;
    state.baseUrl = picked.baseUrl;
    state.model = picked.model;
  }
  console.log('');
  box('RODOX SETUP', [
    C.white(`${state.providerLabel} API key is required.`),
    reason ? C.warn(reason) : '',
    state.providerType === 'gemini' ? (C.dim('Get a free key: ') + C.link('https://aistudio.google.com/apikey')) : '',
    C.dim('Input is hidden. Type /cancel or press Esc to abort.'),
  ].filter((x) => x !== ''));
  console.log('');
  for (;;) {
    const raw = await askHidden('  ' + C.white('Enter your API key:') + ' ' + C.red('› '));
    if (raw === null || raw.trim().toLowerCase() === '/cancel') {
      console.log('');
      note('Setup cancelled.', C.warn);
      return false;
    }
    const key = raw.trim().replace(/^["']|["']$/g, '');
    if (!key) { note('Nothing entered. Paste your key, or /cancel.', C.warn); continue; }
    if (/\s/.test(key) || key.length < 8) {
      note('That does not look like a valid API key (too short or contains spaces).', C.err);
      continue;
    }
    state.apiKey = key;
    const res = await step('API', 'Validating key...', async () => {
      try {
        state.provider = makeProvider();
        await probeProvider(state.provider);
        return { state: 'ok', detail: state.model };
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'model') return { state: 'warn', detail: 'key accepted, model unavailable', c };
        return { state: 'fail', detail: c.title, c };
      }
    });
    if (res.state === 'fail') {
      printError(res.c);
      note(res.c.kind === 'auth' ? 'Try again, or /cancel.' : 'Nothing was saved. Try again, or /cancel.', C.dim);
      state.apiKey = '';
      continue;
    }
    saveProviderConfig();
    state.verifiedModel = res.state === 'ok' ? state.model : null;
    console.log('');
    note('[SUCCESS] API key validated.', C.ok);
    note('[SUCCESS] Configuration saved.', C.ok);
    console.log('');
    console.log('  ' + C.red.bold('RODOX IS READY.'));
    console.log('');
    return true;
  }
}

/* ───────────────────────────── chat ───────────────────────────── */

const SETUP_REQUIRED_HINT = 'Type /setup to choose a provider and enter your API key.';

async function ask(text) {
  if (!state.provider || !state.apiKey) {
    printError({ title: 'No API key configured', hint: SETUP_REQUIRED_HINT });
    return;
  }
  if (loadPromptIfNeeded().status !== 'ready') {
    printError({ title: 'System prompt required', hint: PROMPT_REQUIRED_MSG });
    return;
  }
  state.history.push({ role: 'user', parts: [{ text }] });
  const spin = startThinking();
  const t0 = Date.now();
  try {
    await compactHistory();
    const resp = await generateWithRetry(state.history, systemInstruction());
    spin.stop();
    const reply = (resp && resp.text ? resp.text : '').trim();
    const cand = resp && resp.candidates && resp.candidates[0];
    if (!reply) {
      state.history.pop();
      state.stats.failed++;
      const block = resp && resp.promptFeedback && resp.promptFeedback.blockReason;
      printError({
        title: block ? `Prompt blocked by Gemini (${block})` : 'Gemini returned an empty response',
        hint: block ? 'Rephrase your message and try again.' : `Finish reason: ${(cand && cand.finishReason) || 'unknown'}. Try again or rephrase.`,
      });
      return;
    }
    state.history.push({ role: 'model', parts: [{ text: reply }] });
    const ms = Date.now() - t0;
    const um = (resp && resp.usageMetadata) || {};
    state.stats.turns++;
    state.stats.ok++;
    state.stats.latency += ms;
    state.stats.inTok += um.promptTokenCount || 0;
    state.stats.outTok += um.candidatesTokenCount || 0;
    printReply(reply, ms, um.totalTokenCount, cand && cand.finishReason);
  } catch (e) {
    spin.stop();
    state.history.pop();
    const c = e.classified || classify(e);
    if (c.kind === 'cancelled') { note('Request cancelled.', C.warn); return; }
    state.stats.failed++;
    printError(c);
  }
}

function loadPromptIfNeeded() {
  return state.prompt.status === 'ready' ? state.prompt : loadPrompt();
}

function printReply(reply, ms, tokens, finish) {
  const w = contentW();
  console.log('');
  console.log('  ' + C.red.bold('◢ RODOX ') + C.deep('─'.repeat(Math.max(4, Math.min(w, 60) - 9))));
  for (const l of renderMarkdown(reply, w - 2)) console.log('  ' + l);
  if (finish === 'MAX_TOKENS') console.log('  ' + C.warn('▲ response was cut off by the token limit'));
  console.log(C.dim(`  └─ ${(ms / 1000).toFixed(1)}s${tokens ? ` · ${tokens} tok` : ''} · ${state.model}`));
  console.log('');
}

/* ───────────────────────────── commands ───────────────────────────── */

async function listModels() {
  const names = await guarded(() => state.provider.listModels(), LIMITS.probeMs);
  if (state.providerType === 'gemini') names.sort((a, b) => Number(/flash/.test(b)) - Number(/flash/.test(a)) || a.localeCompare(b));
  else names.sort((a, b) => a.localeCompare(b));
  return names;
}

const cmdHandlers = {
  async '/help'() {
    box('COMMANDS', Object.entries(COMMANDS).map(([k, v]) => [k, C.text(v)]));
    note('Tip: end a line with \\ to continue on the next line. Ctrl+C cancels a running request.');
  },

  async '/about'() {
    console.log('');
    const label = 'NULLKAT'.split('').join(' ');
    if (isTTY()) {
      process.stdout.write('\x1b[?25l');
      for (let f = 0; f < 18; f++) { process.stdout.write('\r  ' + rgbText(label, f * 22) + C.dim('  DEVELOPMENT')); await sleep(40); }
      process.stdout.write('\n\x1b[?25h');
    } else console.log('  ' + rgbText(label) + C.dim('  DEVELOPMENT'));
    box('ABOUT', [
      ['app', C.white(`${APP.name} v${APP.version}`)],
      ['tagline', C.red(APP.tagline)],
      ['developer', APP.dev],
      ['engine', `${state.providerLabel} (${state.model})`],
      ['memory', 'temporary, never written to disk'],
    ]);
  },

  async '/setup'() {
    const ok = await onboarding(null, { reconfigure: true });
    if (ok) { state.online = true; note('Type a message to start chatting.'); }
  },

  async '/provider'(arg) {
    const a = (arg || '').trim().toLowerCase();
    if (!a) {
      box('PROVIDER', [
        ['current', C.white(state.providerLabel)],
        ['type', state.providerType],
        ...(state.baseUrl ? [['base url', state.baseUrl]] : []),
        ['model', state.model],
        C.dim('/provider switch  — choose a different provider'),
      ]);
      return;
    }
    if (a === 'switch') { await onboarding(null, { reconfigure: true }); return; }
    printError({ title: `Unknown /provider argument: ${a}`, hint: 'Use /provider or /provider switch.' });
  },

  async '/model'(arg) {
    const a = (arg || '').trim();
    if (!state.apiKey) { printError({ title: 'No API key configured', hint: SETUP_REQUIRED_HINT }); return; }
    if (!a) {
      box('MODEL', [['current', C.white(state.model)], ['stored', 'RODOX_MODEL in .env'], C.dim('/model list  ·  /model <name>')]);
      return;
    }
    if (a === 'list') {
      try {
        const names = await listModels();
        if (!names.length) { note('No models were returned for this key.', C.warn); return; }
        box('AVAILABLE MODELS', names.slice(0, 20).map((n) => (n === state.model ? C.ok('● ') + C.white(n) : '  ' + n)));
        if (names.length > 20) note(`… and ${names.length - 20} more`);
        note(`Availability and limits depend on your ${state.providerLabel} account.`);
      } catch (e) { printError(classify(e)); }
      return;
    }
    const name = a.replace(/^models\//, '');
    if (!/^[\w./:\-]+$/.test(name)) { printError({ title: 'Invalid model name', hint: 'Use a name such as gemini-3.8-flash.' }); return; }
    try {
      const tempProvider = makeProvider(name);
      await probeProvider(tempProvider);
      state.model = name;
      state.provider = tempProvider;
      state.verifiedModel = name;
      saveProviderConfig();
      note(`Model set to ${name} (saved to .env). Memory kept.`, C.ok);
    } catch (e) {
      const prevModel = state.model;
      state.model = name;
      const c = classify(e);
      state.model = prevModel;
      printError(c.kind === 'model' ? { title: `Model "${name}" is not available`, hint: c.hint } : c);
    }
  },

  async '/build'(arg) {
    const desc = (arg || '').trim();
    if (!desc) { printError({ title: 'Describe the project', hint: 'Usage: /build <short description>, e.g. /build CLI todo-list app in Node.js' }); return; }
    if (!state.provider || !state.apiKey) { printError({ title: 'No API key configured', hint: SETUP_REQUIRED_HINT }); return; }
    const suggested = builder.slugify(desc);
    const raw = await askVisible('  ' + C.white('Project folder name') + C.dim(` [${suggested}]`) + ': ' + C.red('› '));
    const name = raw && raw.trim() ? builder.slugify(raw.trim()) : suggested;
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const dir = builder.freshProjectDir(PROJECTS_DIR, name);
    const cleanupEmptyDir = () => { try { fs.rmdirSync(dir); } catch (_) { /* not empty or already gone */ } };

    console.log('');
    note(`Building into ${path.relative(ROOT, dir)}/ …`, C.dim);
    const w = contentW();
    const spin = startThinking();

    try {
      const sys = builder.PROTOCOL_PROMPT + (state.prompt.text
        ? `\n\n---\nStyle/persona notes from the user (follow if relevant, ignore if they conflict with the protocol above):\n${state.prompt.text}`
        : '');
      state.stats.requests++;
      const resp = await guarded((signal) => state.provider.generate({
        contents: [{ role: 'user', parts: [{ text: desc }] }],
        systemInstruction: sys,
        signal,
        maxOutputTokens: 8192,
      }), Math.max(state.timeoutMs, 120000), { cancellable: true });
      spin.stop();

      const text = (resp && resp.text) || '';
      const { plan, files } = builder.parseBuildReply(text);
      if (!files.length) {
        state.stats.failed++;
        cleanupEmptyDir();
        printError({ title: 'No files were generated', hint: 'The model did not follow the file format. Try rephrasing the request, or try again.' });
        return;
      }
      const result = builder.writeFiles(dir, files);
      if (!result.written.length) {
        state.stats.failed++;
        cleanupEmptyDir();
        printError({ title: 'No files could be written', hint: result.skipped.map((s) => `${s.rel}: ${s.reason}`).join('; ').slice(0, 300) || 'Every file was rejected by the safety checks.' });
        return;
      }
      state.stats.ok++;
      if (plan) { note('Plan:', C.dim); for (const l of renderMarkdown(plan, w - 2)) console.log('  ' + l); console.log(''); }
      box('PROJECT BUILT', [
        ['folder', path.relative(ROOT, dir) + '/'],
        ['files', `${result.written.length} written${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`],
        ['size', `${result.totalBytes < 1024 ? result.totalBytes + ' B' : (result.totalBytes / 1024).toFixed(1) + ' KB'}`],
      ]);
      for (const f of result.written) console.log('  ' + C.ok('✔ ') + C.text(f.rel) + C.dim(` (${f.bytes}B)`));
      for (const s of result.skipped) console.log('  ' + C.warn('▲ ') + C.text(s.rel) + C.dim(` — ${s.reason}`));
      console.log('');
      note('RODOX did not run anything — review the code yourself before executing it.', C.dim);
    } catch (e) {
      spin.stop();
      const c = e.classified || classify(e);
      if (c.kind === 'cancelled') { cleanupEmptyDir(); note('Build cancelled.', C.warn); }
      else { state.stats.failed++; cleanupEmptyDir(); printError(c); }
    }
  },

  async '/personality'() {
    const p = loadPrompt();
    if (p.status !== 'ready') { printError({ title: 'No personality loaded', hint: PROMPT_REQUIRED_MSG }); return; }
    const first = p.text.split('\n').find((l) => l.trim()) || '';
    box('PERSONALITY', [
      ['source', 'config/system.prompt.txt'],
      ['size', `${p.lines} lines · ${p.chars} chars`],
      ['starts', C.text(first.length > 90 ? first.slice(0, 87) + '…' : first)],
      C.dim('Defined entirely by you. Edit the file, then /prompt reload.'),
    ]);
  },

  async '/stats'() {
    const s = state.stats;
    box('SESSION STATS', [
      ['uptime', fmtDur(Date.now() - state.startedAt)],
      ['turns', String(s.turns)],
      ['requests', `${s.requests} (${s.ok} ok · ${s.failed} failed · ${s.retries} retries)`],
      ['avg time', s.ok ? `${(s.latency / Math.max(1, s.turns) / 1000).toFixed(1)}s` : '—'],
      ['tokens', `${s.inTok} in · ${s.outTok} out`],
      ['memory', `${state.history.length}/${LIMITS.maxMessages} msgs · ${historyChars()} chars`],
      ['summary', state.summary ? `active (${s.compactions} compaction${s.compactions === 1 ? '' : 's'})` : 'none'],
      ['model', state.model],
    ]);
  },

  async '/prompt'(arg) {
    if ((arg || '').trim() === 'reload') {
      const p = loadPrompt();
      if (p.status === 'ready') note(`System prompt reloaded (${p.chars} chars).`, C.ok);
      else printError({ title: 'System prompt is still empty', hint: PROMPT_REQUIRED_MSG });
      return;
    }
    const p = loadPrompt();
    if (p.status !== 'ready') { printError({ title: p.status === 'unreadable' ? 'Cannot read system prompt' : 'System prompt is empty', hint: p.note || PROMPT_REQUIRED_MSG }); return; }
    box('SYSTEM PROMPT', [['file', PROMPT_PATH], ['size', `${p.lines} lines · ${p.chars} chars`]]);
    const all = p.text.split('\n');
    for (const l of all.slice(0, 40)) console.log('  ' + C.dim('│ ') + C.text(l));
    if (all.length > 40) note(`… ${all.length - 40} more lines`);
  },

  async '/reset'() {
    state.history = [];
    state.summary = '';
    const p = loadPrompt();
    note('Session memory wiped.', C.ok);
    if (p.status !== 'ready') note('System prompt is empty — fill config/system.prompt.txt.', C.warn);
  },

  async '/clear'() {
    if (isTTY()) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    console.log('\n  ' + C.deep('▌') + C.red.bold(` ${APP.name} `) + C.dim(`v${APP.version} · ${state.model} · memory ${state.history.length} msgs`));
    console.log('');
  },

  async '/version'() {
    box('VERSION', [
      ['rodox', C.white(`v${APP.version}`)],
      ['provider', `${state.providerLabel} (${state.providerType})`],
      state.providerType === 'gemini' ? ['sdk', `@google/genai ${sdkVersion()}`] : ['transport', 'fetch (OpenAI-compatible)'],
      ['node', process.version],
      ['platform', `${os.platform()} ${os.arch()}`],
    ]);
  },

  async '/exit'() { shutdown(0); },
};
cmdHandlers['/quit'] = cmdHandlers['/exit'];
cmdHandlers['/apikey'] = cmdHandlers['/setup'];

async function handleInput(raw) {
  const text = raw.trim();
  if (!text) { note('Type a message or /help.', C.dim); return; }
  const [head, ...rest] = text.split(/\s+/);
  const cmd = head.toLowerCase();
  if (text.startsWith('/') && cmdHandlers[cmd]) { await cmdHandlers[cmd](rest.join(' ')); return; }
  if (/^\/[A-Za-z]+$/.test(text)) { printError({ title: `Unknown command: ${text}`, hint: 'Type /help to see all commands.' }); return; }
  await ask(text);
}

/* ───────────────────────────── lifecycle ───────────────────────────── */

function shutdown(code = 0) {
  if (isTTY()) process.stdout.write('\x1b[?25h');
  console.log('');
  console.log('  ' + rgbText('NULLKAT', 40) + C.dim(' · session ended · memory wiped'));
  console.log('');
  process.exit(code);
}

function startRepl() {
  const tty = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty, historySize: 100 });
  mainRl = rl;
  const mainPrompt = C.red.bold('You >') + ' ';
  const contPrompt = C.deep('  … ');
  rl.setPrompt(mainPrompt);

  let pending = 0;
  let queue = Promise.resolve();
  let chunk = [];
  let timer = null;
  let continuing = false;
  let closing = false;
  let lastSigint = 0;

  const flushPrompt = () => { if (!closing && pending === 0 && chunk.length === 0) { rl.setPrompt(mainPrompt); rl.prompt(); } };
  const enqueue = (text) => {
    pending++;
    queue = queue
      .then(() => handleInput(text))
      .catch((e) => printError(classify(e)))
      .then(() => { pending--; flushPrompt(); });
  };

  rl.on('line', (line) => {
    if (continuing || line.endsWith('\\')) {
      chunk.push(line.endsWith('\\') ? line.slice(0, -1) : line);
      continuing = line.endsWith('\\');
      clearTimeout(timer);
      if (continuing) { rl.setPrompt(contPrompt); rl.prompt(); return; }
      const text = chunk.join('\n'); chunk = []; enqueue(text); return;
    }
    if (!tty || (chunk.length === 0 && line.trim().startsWith('/'))) { enqueue(line); return; }
    // coalesce pasted multi-line text into one message
    chunk.push(line);
    clearTimeout(timer);
    timer = setTimeout(() => { const text = chunk.join('\n'); chunk = []; enqueue(text); }, 60);
  });

  rl.on('SIGINT', () => {
    if (state.abort) { state.abort.abort(); return; }
    const now = Date.now();
    if (now - lastSigint < 3000) shutdown(0);
    lastSigint = now;
    console.log('');
    note('Press Ctrl+C again or type /exit to quit.', C.dim);
    rl.prompt();
  });

  rl.on('close', () => {
    closing = true;
    queue.then(() => shutdown(0));
  });

  rl.prompt();
}

async function boot() {
  if (isTTY()) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  printLogo();
  await animateNullkat();
  console.log('  ' + C.red.bold(`v${APP.version}`) + C.dim('  ·  ') + C.text(APP.tagline));
  console.log('');

  await step('BOOT', 'Initializing RODOX...', () => ({ state: 'ok' }), 200);

  let hadProviderEnv = false;
  let missingSetup = false;
  const cfg = await step('CONFIG', 'Checking configuration...', () => {
    loadEnv();
    if (Number(process.versions.node.split('.')[0]) < 18) return { state: 'fail', detail: `Node ${process.version} is too old (need 20+)` };
    const r = loadProviderConfig();
    hadProviderEnv = r.hadProviderEnv;
    missingSetup = r.missingSetup;
    const t = Number(process.env.RODOX_TIMEOUT_MS);
    if (t >= 5000) state.timeoutMs = t;
    return { state: 'ok', detail: `${state.providerLabel} · ${state.model || '(no model set)'}` };
  });
  if (cfg.state === 'fail') return false;

  await step('MEMORY', 'Initializing temporary memory...', () => {
    state.history = []; state.summary = '';
    return { state: 'ok', detail: 'RAM only' };
  });

  await step('PROMPT', 'Reading system prompt...', () => {
    const p = loadPrompt();
    if (p.status === 'ready') return { state: 'ok', detail: `${p.chars} chars` };
    return { state: 'warn', detail: p.status === 'unreadable' ? 'unreadable' : 'empty — you must fill it' };
  });

  const key = await step('KEY', 'Checking API key...', () => (
    state.apiKey ? { state: 'ok', detail: maskKey(state.apiKey) } : { state: 'warn', detail: 'not found' }
  ));

  const core = await step('CORE', 'Loading AI engine...', () => {
    if (state.providerType === 'gemini') {
      try { require('@google/genai'); return { state: 'ok', detail: `@google/genai ${sdkVersion()}` }; }
      catch (e) { return { state: 'fail', detail: 'SDK missing — run npm install' }; }
    }
    if (typeof fetch !== 'function') return { state: 'fail', detail: 'global fetch unavailable — need Node 18+' };
    return { state: 'ok', detail: `${state.providerLabel} (OpenAI-compatible)` };
  });
  if (core.state === 'fail') return false;

  // RODOX never blocks startup waiting for setup — it boots straight to the prompt
  // either way and tells you to run /setup if something is missing. A legacy .env
  // with only GEMINI_API_KEY set (no RODOX_PROVIDER) still counts as configured.
  let needsSetup = missingSetup || key.state !== 'ok';
  if (!needsSetup) {
    try { state.provider = makeProvider(); }
    catch (e) { printError(classify(e)); needsSetup = true; }
  }

  if (!needsSetup) {
    if (state.verifiedModel === state.model) {
      await step('API', `Connecting to ${state.providerLabel}...`, () => ({ state: 'ok', detail: 'verified during setup' }), 60);
      state.online = true;
    } else {
      let c = null;
      const res = await step('API', `Connecting to ${state.providerLabel}...`, async () => {
        try { await probeProvider(state.provider); return { state: 'ok', detail: state.model }; }
        catch (e) { c = classify(e); return { state: c.kind === 'auth' ? 'fail' : 'warn', detail: c.title }; }
      });
      if (c && c.kind === 'auth') { needsSetup = true; printError(c); }
      else { state.online = res.state === 'ok'; if (c && c.hint) note(c.hint, C.dim); }
    }
  }

  console.log('');
  box('SYSTEM STATUS', statusRows());
  console.log('');
  const ready = state.prompt.status === 'ready';
  if (needsSetup) {
    console.log('  ' + C.err.bold('API KEY NOT CONFIGURED.'));
    note('Type /setup to choose a provider and enter your API key.', C.err);
  } else if (state.online && ready) {
    console.log('  ' + C.red.bold('RODOX IS ONLINE.'));
  } else if (state.online) {
    console.log('  ' + C.red.bold('RODOX IS ONLINE') + C.warn(' — system prompt required before chatting.'));
  } else {
    console.log('  ' + C.warn.bold('RODOX IS OFFLINE') + C.dim(` — ${state.providerLabel} could not be verified; requests will retry.`));
  }
  if (!ready && !needsSetup) note('Fill config/system.prompt.txt, then /prompt reload.', C.warn);
  note('Type a message · /help for commands · /exit to quit');
  console.log('');
  return true;
}

async function main() {
  process.on('uncaughtException', (e) => { console.error('  ' + C.err('✖ Unexpected error: ' + redact(e && e.message ? e.message : e))); });
  process.on('unhandledRejection', (e) => { console.error('  ' + C.err('✖ Unexpected error: ' + redact(e && e.message ? e.message : e))); });
  process.on('exit', () => { if (process.stdout.isTTY) process.stdout.write('\x1b[?25h'); });
  const ok = await boot();
  if (!ok) { console.log(''); process.exit(1); }
  startRepl();
}

if (require.main === module) main();

module.exports = { renderMarkdown, classify, parseEnv, readSystemPrompt, inline, wrap, state, LIMITS };
