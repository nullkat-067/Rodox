/*
 * RODOX — provider layer (NullKat Development)
 *
 * A "provider" turns {contents, systemInstruction} into a Gemini-shaped result
 * ({ text, usageMetadata, candidates, promptFeedback }) so the rest of RODOX
 * never needs to know which backend answered. Two kinds are supported:
 *
 *  - gemini:   the official @google/genai SDK (the default, as RODOX v1.0.0
 *              specified — this is not replaced, only wrapped).
 *  - openai:   any provider that implements the OpenAI-compatible
 *              /chat/completions REST API (Groq, Together AI, OpenRouter,
 *              DeepSeek, Mistral, a self-hosted vLLM/Ollama server, etc.).
 *              The user supplies the official base URL and their own key —
 *              RODOX does not ship or recommend any endpoint itself.
 */
'use strict';

class ProviderError extends Error {
  constructor(message, { status = 0, code = '', cause = null, retryAfterSec = null, raw = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.cause = cause;
    this.retryAfterSec = retryAfterSec;
    this.raw = raw || message;
  }
}

/* ───────────────────────────── gemini ───────────────────────────── */

function geminiProvider({ apiKey, model }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  return {
    type: 'gemini',
    label: 'Gemini',
    model,
    async generate({ contents, systemInstruction, signal, maxOutputTokens }) {
      try {
        const config = { abortSignal: signal };
        if (systemInstruction) config.systemInstruction = systemInstruction;
        if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;
        return await ai.models.generateContent({ model, contents, config });
      } catch (e) { throw toProviderError(e); }
    },
    /** Same result shape as generate(), but calls onChunk(deltaText) as text arrives. */
    async generateStream({ contents, systemInstruction, signal, maxOutputTokens }, onChunk) {
      try {
        const config = { abortSignal: signal };
        if (systemInstruction) config.systemInstruction = systemInstruction;
        if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens;
        const stream = await ai.models.generateContentStream({ model, contents, config });
        let text = '';
        let usageMetadata;
        let candidates;
        for await (const chunk of stream) {
          const delta = (chunk && chunk.text) || '';
          if (delta) { text += delta; onChunk(delta); }
          if (chunk && chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
          if (chunk && chunk.candidates) candidates = chunk.candidates;
        }
        return { text, usageMetadata, candidates };
      } catch (e) { throw toProviderError(e); }
    },
    async probe(signal) {
      return this.generate({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], signal, maxOutputTokens: 1 });
    },
    async listModels() {
      const pager = await ai.models.list();
      const names = [];
      for await (const m of pager) {
        const actions = m.supportedActions || [];
        if (actions.length && !actions.includes('generateContent')) continue;
        const n = String(m.name || '').replace(/^models\//, '');
        if (/^gemini/.test(n)) names.push(n);
      }
      return names;
    },
  };
}

function toProviderError(e) {
  if (e instanceof ProviderError) return e;
  const raw = String(e && e.message ? e.message : e);
  let status = Number(e && (e.status || e.code)) || 0;
  let apiMsg = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.error) { apiMsg = parsed.error.message || raw; if (parsed.error.code) status = Number(parsed.error.code) || status; }
  } catch (_) { /* not json */ }
  const delay = (raw.match(/retryDelay"?:\s*"?(\d+)s/) || [])[1];
  return new ProviderError(apiMsg, { status, code: e && e.code, cause: e && e.cause, retryAfterSec: delay ? Number(delay) : null, raw });
}

/* ───────────────────────────── openai-compatible ───────────────────────────── */

function toMessages(contents, systemInstruction) {
  const msgs = [];
  if (systemInstruction) msgs.push({ role: 'system', content: systemInstruction });
  for (const m of contents) {
    msgs.push({ role: m.role === 'model' ? 'assistant' : 'user', content: (m.parts || []).map((p) => p.text || '').join('') });
  }
  return msgs;
}

async function callOpenAI({ baseUrl, apiKey, model, messages, signal, maxOutputTokens }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}) }),
    });
  } catch (e) {
    const err = new ProviderError(e.message, { cause: e.cause, raw: e.message });
    throw err;
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let msg = text || `HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || msg; } catch (_) { /* not json */ }
    const retryAfter = res.headers.get('retry-after');
    throw new ProviderError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
      status: res.status, retryAfterSec: retryAfter ? Number(retryAfter) : null, raw: text,
    });
  }
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new ProviderError('Provider returned a non-JSON response', { status: res.status, raw: text.slice(0, 300) }); }
  const choice = (json.choices && json.choices[0]) || {};
  const finishMap = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };
  return {
    text: (choice.message && choice.message.content) || '',
    usageMetadata: json.usage ? {
      promptTokenCount: json.usage.prompt_tokens || 0,
      candidatesTokenCount: json.usage.completion_tokens || 0,
      totalTokenCount: json.usage.total_tokens || 0,
    } : undefined,
    candidates: [{ finishReason: finishMap[choice.finish_reason] || (choice.finish_reason || 'STOP').toUpperCase() }],
  };
}

const FINISH_MAP = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };

async function callOpenAIStream({ baseUrl, apiKey, model, messages, signal, maxOutputTokens }, onChunk) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}) }),
    });
  } catch (e) {
    throw new ProviderError(e.message, { cause: e.cause, raw: e.message });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text || `HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || msg; } catch (_) { /* not json */ }
    throw new ProviderError(typeof msg === 'string' ? msg : JSON.stringify(msg), { status: res.status, raw: text });
  }
  if (!res.body || !res.body.getReader) {
    // No streaming body support in this runtime/provider — fall back to one shot.
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (_) { throw new ProviderError('Provider returned a non-JSON response', { raw: text.slice(0, 300) }); }
    const choice = (json.choices && json.choices[0]) || {};
    const full = (choice.message && choice.message.content) || '';
    if (full) onChunk(full);
    return { text: full, candidates: [{ finishReason: FINISH_MAP[choice.finish_reason] || 'STOP' }] };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usageMetadata;
  let finishReason = 'STOP';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.replace(/^data:\s*/, '').trim();
      if (!line || line === '[DONE]') continue;
      let json;
      try { json = JSON.parse(line); } catch (_) { continue; }
      const choice = json.choices && json.choices[0];
      const delta = choice && choice.delta && choice.delta.content;
      if (delta) { text += delta; onChunk(delta); }
      if (choice && choice.finish_reason) finishReason = FINISH_MAP[choice.finish_reason] || choice.finish_reason.toUpperCase();
      if (json.usage) {
        usageMetadata = {
          promptTokenCount: json.usage.prompt_tokens || 0,
          candidatesTokenCount: json.usage.completion_tokens || 0,
          totalTokenCount: json.usage.total_tokens || 0,
        };
      }
    }
  }
  return { text, usageMetadata, candidates: [{ finishReason }] };
}

function openaiProvider({ apiKey, baseUrl, model, label }) {
  return {
    type: 'openai',
    label: label || 'OpenAI-compatible',
    model,
    async generate({ contents, systemInstruction, signal, maxOutputTokens }) {
      return callOpenAI({ baseUrl, apiKey, model, messages: toMessages(contents, systemInstruction), signal, maxOutputTokens });
    },
    async generateStream({ contents, systemInstruction, signal, maxOutputTokens }, onChunk) {
      return callOpenAIStream({ baseUrl, apiKey, model, messages: toMessages(contents, systemInstruction), signal, maxOutputTokens }, onChunk);
    },
    async probe(signal) {
      return this.generate({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], signal, maxOutputTokens: 1 });
    },
    async listModels() {
      const url = baseUrl.replace(/\/+$/, '') + '/models';
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, { status: res.status });
      const json = await res.json();
      return (json.data || []).map((m) => m.id).filter(Boolean);
    },
  };
}

/* ───────────────────────────── factory ───────────────────────────── */

function createProvider(cfg) {
  if (cfg.type === 'gemini') return geminiProvider(cfg);
  if (cfg.type === 'openai') return openaiProvider(cfg);
  throw new Error(`Unknown provider type: ${cfg.type}`);
}

module.exports = { createProvider, ProviderError, toProviderError };
