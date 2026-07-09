import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';

const config = loadConfig();
let store;
let catalog;

function loadConfig() {
  return {
    port: process.env.PORT || '8081',
    verifyToken: process.env.IG_VERIFY_TOKEN || '',
    appSecret: process.env.IG_APP_SECRET || '',
    igUserId: process.env.IG_USER_ID || '',
    igPageId: process.env.IG_PAGE_ID || '',
    igPageAccessToken: process.env.IG_PAGE_ACCESS_TOKEN || '',
    userAccessToken: process.env.IG_USER_ACCESS_TOKEN || '',
    openAIAPIKey: process.env.OPENAI_API_KEY || '',
    openAIModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    systemPrompt: process.env.IG_BOT_SYSTEM_PROMPT || 'You are an Instagram assistant. Be concise, friendly, and helpful. Keep replies under 3 short lines unless asked for more.',
    memoryTurns: parseInt(process.env.MEMORY_TURNS || '12', 10),
    followupDelayMs: parseDurationMs(process.env.FOLLOWUP_DELAY || '2h'),
    followupMaxPerUser: parseInt(process.env.FOLLOWUP_MAX_PER_USER || '1', 10),
    dataFile: process.env.DATA_FILE || 'data/instabot.db',
    productSheetPath: process.env.PRODUCT_SHEET_PATH || '',
    productSheetReloadMs: parseInt(process.env.PRODUCT_SHEET_RELOAD_MS || '300000', 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
    logPayloads: String(process.env.LOG_PAYLOADS || 'false').toLowerCase() === 'true',
    dedupeWindowHours: parseInt(process.env.DEDUPE_WINDOW_HOURS || '72', 10),
    sendProductImages: String(process.env.SEND_PRODUCT_IMAGES || 'true').toLowerCase() === 'true',
  };
}

function parseDurationMs(input) {
  const value = String(input || '').trim();
  const match = value.match(/^(\d+)(ms|s|m|h|d)$/i);
  if (!match) return 2 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * factors[unit];
}

class SqliteStore {
  constructor(file) {
    this.file = path.resolve(file);
  }

  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        sender_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        sender_id TEXT,
        seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_messages_seen_at ON processed_messages(seen_at);
    `);

    this.getThreadStmt = this.db.prepare('SELECT state_json FROM threads WHERE sender_id = ?');
    this.saveThreadStmt = this.db.prepare(`
      INSERT INTO threads(sender_id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(sender_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `);
    this.listThreadsStmt = this.db.prepare('SELECT state_json FROM threads');
    this.seenMessageStmt = this.db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?');
    this.markMessageStmt = this.db.prepare('INSERT INTO processed_messages(message_id, sender_id, seen_at) VALUES (?, ?, ?)');
    this.pruneMessagesStmt = this.db.prepare('DELETE FROM processed_messages WHERE seen_at < ?');
  }

  getThread(senderId) {
    const row = this.getThreadStmt.get(senderId);
    if (!row) {
      return {
        senderId,
        turns: [],
        lastUserAt: null,
        lastBotAt: null,
        followupCount: 0,
        nextFollowupAt: null,
        escalated: false,
      };
    }
    return JSON.parse(row.state_json);
  }

  saveThread(thread) {
    this.saveThreadStmt.run(thread.senderId, JSON.stringify(thread), new Date().toISOString());
  }

  listThreads() {
    return this.listThreadsStmt.all().map((row) => JSON.parse(row.state_json));
  }

  hasProcessedMessage(messageId) {
    return Boolean(this.seenMessageStmt.get(messageId));
  }

  markMessageProcessed(messageId, senderId) {
    this.markMessageStmt.run(messageId, senderId, new Date().toISOString());
  }

  pruneProcessedMessages(windowHours) {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
    this.pruneMessagesStmt.run(cutoff);
  }
}

class ProductCatalog {
  constructor(sheetPath) {
    this.sheetPath = sheetPath;
    this.products = [];
    this.lastLoadedAt = null;
  }

  async load() {
    if (!this.sheetPath) {
      this.products = [];
      return;
    }

    const rows = await loadSheetRows(this.sheetPath);
    this.products = rows.map(normalizeProductRow).filter(Boolean);
    this.lastLoadedAt = new Date().toISOString();
    logInfo(`product catalog loaded count=${this.products.length}`);
  }

  search(query, limit = 5) {
    const q = normalizeFreeText(query);
    if (!q) return [];
    const scored = this.products.map((product) => ({
      product,
      score: scoreProduct(product, q),
    }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((item) => item.product);
  }

  getById(id) {
    const needle = String(id || '').trim().toLowerCase();
    if (!needle) return null;
    return this.products.find((product) => [product.id, product.sku, product.name]
      .filter(Boolean)
      .some((value) => String(value).trim().toLowerCase() === needle)) || null;
  }
}

async function loadSheetRows(sheetPath) {
  const isUrl = /^https?:\/\//i.test(sheetPath);
  let buffer;
  let text;

  if (isUrl) {
    const response = await fetchWithTimeout(sheetPath, {}, config.requestTimeoutMs);
    if (!response.ok) throw new Error(`product sheet fetch failed status=${response.status}`);
    const arr = await response.arrayBuffer();
    buffer = Buffer.from(arr);
    text = buffer.toString('utf8');
  } else {
    const abs = path.resolve(sheetPath);
    buffer = fs.readFileSync(abs);
    text = buffer.toString('utf8');
  }

  const lower = sheetPath.toLowerCase();
  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.rows || [];
  }

  if (lower.endsWith('.csv') || lower.includes('/export?format=csv')) {
    const wb = XLSX.read(text, { type: 'string' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function normalizeProductRow(row) {
  if (!row || typeof row !== 'object') return null;
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeKey(key)] = String(value ?? '').trim();
  }

  const name = normalized.productname || normalized.name || normalized.title;
  if (!name) return null;

  const imageUrls = [
    normalized.imageurl,
    normalized.imageurl2,
    normalized.imageurl3,
    normalized.variantimageurl,
    normalized.image,
  ].filter(Boolean);

  return {
    id: normalized.id || normalized.productid || normalized.sku || name,
    sku: normalized.sku || normalized.productcode || '',
    name,
    description: normalized.description || normalized.productdescription || '',
    price: normalized.price || normalized.amount || '',
    stock: normalized.stock || normalized.availability || normalized.instock || '',
    variant: normalized.variant || normalized.variants || normalized.size || normalized.color || '',
    category: normalized.category || '',
    imageUrls,
    primaryImageUrl: imageUrls[0] || '',
    raw: normalized,
    searchText: normalizeFreeText([
      normalized.id,
      normalized.sku,
      name,
      normalized.description,
      normalized.price,
      normalized.stock,
      normalized.variant,
      normalized.category,
    ].filter(Boolean).join(' ')),
  };
}

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeFreeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreProduct(product, query) {
  if (!query) return 0;
  const terms = query.split(' ').filter((term) => term.length > 1);
  let score = 0;

  for (const term of terms) {
    if (product.name.toLowerCase().includes(term)) score += 8;
    if (product.sku.toLowerCase().includes(term)) score += 10;
    if (product.variant.toLowerCase().includes(term)) score += 5;
    if (product.category.toLowerCase().includes(term)) score += 2;
    if (product.searchText.includes(term)) score += 1;
  }

  if (product.searchText.includes(query)) score += 12;
  return score;
}

function bootstrap() {
  store = new SqliteStore(config.dataFile);
  store.init();
  store.pruneProcessedMessages(config.dedupeWindowHours);

  catalog = new ProductCatalog(config.productSheetPath);
  catalog.load().catch((err) => logError('initial product catalog load error', err));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));

  app.get('/', handleHome);
  app.get('/health', (_req, res) => res.status(200).send('ok'));
  app.get('/privacy', handlePrivacy);
  app.get('/data-deletion', handleDataDeletion);
  app.all('/ig-webhook', async (req, res) => {
    logInfo(`webhook hit method=${req.method} path=${req.path} ua=${JSON.stringify(req.get('user-agent') || '')} remote=${req.ip}`);

    if (req.method === 'GET') return handleVerify(req, res);
    if (req.method !== 'POST') return res.status(405).send('method not allowed');
    return handleMessage(req, res);
  });

  setInterval(() => {
    try {
      store.pruneProcessedMessages(config.dedupeWindowHours);
    } catch (err) {
      logError('pruneProcessedMessages error', err);
    }
    if (config.productSheetPath) {
      catalog.load().catch((err) => logError('scheduled product catalog load error', err));
    }
    followupWorker().catch((err) => logError('followupWorker error', err));
  }, Math.max(60_000, config.productSheetReloadMs));

  app.listen(Number(config.port), () => {
    logInfo(`instabot-js listening on :${config.port}`);
  });
}

function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  logInfo(`verify attempt mode=${JSON.stringify(mode || '')} token_match=${token === config.verifyToken} challenge_len=${String(challenge || '').length}`);

  if (mode === 'subscribe' && token === config.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('forbidden');
}

async function handleMessage(req, res) {
  const bodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const sig = req.get('X-Hub-Signature-256') || '';

  if (config.appSecret && !verifyMetaSignature(config.appSecret, bodyBuffer, sig)) {
    logInfo(`post rejected invalid signature sig_present=${Boolean(sig)} body_len=${bodyBuffer.length}`);
    return res.status(401).send('invalid signature');
  }

  if (config.logPayloads) {
    let preview = bodyBuffer.toString('utf8');
    if (preview.length > 2000) preview = `${preview.slice(0, 2000)}...`;
    logInfo(`post received sig_present=${Boolean(sig)} body_len=${bodyBuffer.length} payload=${preview}`);
  } else {
    logInfo(`post received sig_present=${Boolean(sig)} body_len=${bodyBuffer.length}`);
  }

  const incoming = req.body || {};
  const entries = Array.isArray(incoming.entry) ? incoming.entry : [];
  let processed = 0;

  for (const entry of entries) {
    for (const msg of entry.messaging || []) {
      const sender = msg?.sender?.id || '';
      const isEcho = Boolean(msg?.message?.is_echo);
      const messageId = msg?.message?.mid || '';
      const parsed = parseIncomingMessage(msg?.message || {});
      if (!sender || isEcho || (!parsed.text && parsed.imageUrls.length === 0)) continue;
      if (messageId && store.hasProcessedMessage(messageId)) {
        logInfo(`message skipped duplicate sender=${sender} message_id=${messageId}`);
        continue;
      }
      if (messageId) store.markMessageProcessed(messageId, sender);
      processed += 1;
      logInfo(`message accepted (messaging) sender=${sender} text_len=${parsed.text.length} image_count=${parsed.imageUrls.length}`);
      processIncoming(sender, parsed).catch((err) => logError('processIncoming error', err));
    }

    for (const change of entry.changes || []) {
      if (change?.field !== 'messages') continue;
      const sender = change?.value?.sender?.id || '';
      const messageId = change?.value?.message?.mid || '';
      const parsed = parseIncomingMessage(change?.value?.message || {});
      if (!sender || (!parsed.text && parsed.imageUrls.length === 0)) continue;
      if (messageId && store.hasProcessedMessage(messageId)) {
        logInfo(`message skipped duplicate sender=${sender} message_id=${messageId}`);
        continue;
      }
      if (messageId) store.markMessageProcessed(messageId, sender);
      processed += 1;
      logInfo(`message accepted (changes) sender=${sender} text_len=${parsed.text.length} image_count=${parsed.imageUrls.length}`);
      processIncoming(sender, parsed).catch((err) => logError('processIncoming error', err));
    }
  }

  logInfo(`post parsed entries=${entries.length} processed_messages=${processed}`);
  return res.json({ ok: true });
}

function parseIncomingMessage(message) {
  const text = String(message?.text || '').trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const imageUrls = attachments
    .filter((item) => item?.type === 'image' && item?.payload?.url)
    .map((item) => item.payload.url);

  return {
    text,
    imageUrls,
    attachments,
  };
}

function verifyMetaSignature(appSecret, body, sigHeader) {
  if (!appSecret || !sigHeader) return false;
  const [algo, value] = sigHeader.split('=', 2);
  if (algo !== 'sha256' || !value) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const gotBuffer = Buffer.from(value, 'hex');
  if (expectedBuffer.length !== gotBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, gotBuffer);
}

async function processIncoming(senderId, incoming) {
  const thread = store.getThread(senderId);
  const now = new Date().toISOString();
  const userText = incoming.text || '[Image received]';
  const matchedProducts = catalog.search(`${incoming.text} ${incoming.imageUrls.join(' ')}`, 5);

  thread.senderId = senderId;
  thread.lastUserAt = now;
  thread.turns = trimTurns([
    ...(thread.turns || []),
    {
      role: 'user',
      content: userText,
      timestamp: now,
      imageUrls: incoming.imageUrls,
      matchedProductIds: matchedProducts.map((product) => product.id),
    },
  ], config.memoryTurns);

  const decision = await generateDecision(thread.turns, incoming, matchedProducts);

  if (decision.sendImage && decision.imageUrl) {
    await sendIGImage(senderId, decision.imageUrl, decision.reply);
  } else {
    await sendIGMessage(senderId, decision.reply);
  }

  const botTime = new Date().toISOString();
  thread.lastBotAt = botTime;
  thread.nextFollowupAt = new Date(Date.now() + config.followupDelayMs).toISOString();
  thread.followupCount = 0;
  thread.escalated = decision.escalate;
  thread.turns = trimTurns([
    ...thread.turns,
    {
      role: 'assistant',
      content: decision.reply,
      timestamp: botTime,
      imageUrl: decision.sendImage ? decision.imageUrl : '',
      escalate: decision.escalate,
    },
  ], config.memoryTurns);

  store.saveThread(thread);
  logInfo(`replied sender=${senderId} escalate=${decision.escalate} send_image=${decision.sendImage}`);
}

function trimTurns(turns, n) {
  if (!n || turns.length <= n) return turns;
  return turns.slice(-n);
}

async function generateDecision(turns, incoming, matchedProducts) {
  const fallbackReply = 'Thanks for your message! I can help with product details, availability, and next steps. What are you looking for today?';
  if (!config.openAIAPIKey) {
    return { reply: fallbackReply, escalate: false, sendImage: false, imageUrl: '' };
  }

  const localImageDataUrls = [];
  for (const url of incoming.imageUrls.slice(0, 2)) {
    try {
      localImageDataUrls.push(await downloadImageAsDataUrl(url));
    } catch (err) {
      logError(`image download failed url=${url}`, err);
    }
  }

  const shouldEscalate = heuristicEscalation(incoming.text);
  const system = `${config.systemPrompt}
You are powering an Instagram sales bot.
Rules:
- Reply naturally and humanly.
- Use the supplied product catalog context instead of inventing products.
- If the customer asks about payment, delivery, returns, refunds, or anything sensitive/unclear, set escalate=true and hand off politely.
- If one product is a strong match and has an image URL, you may set sendImage=true.
- Return strict JSON only with keys: reply, escalate, sendImage, chosenProductId.
- Keep reply short (1-3 lines).
`;

  const catalogContext = matchedProducts.length
    ? matchedProducts.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description,
        price: product.price,
        stock: product.stock,
        variant: product.variant,
        category: product.category,
        imageUrl: product.primaryImageUrl,
      }))
    : [];

  const messages = [
    { role: 'system', content: system },
    ...turns.flatMap((turn) => toModelMessages(turn)),
    {
      role: 'user',
      content: buildUserContent(incoming, catalogContext, shouldEscalate, localImageDataUrls),
    },
  ];

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openAIAPIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openAIModel,
      messages,
      temperature: 0.4,
      max_completion_tokens: 350,
      response_format: { type: 'json_object' },
    }),
  }, config.requestTimeoutMs);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`openai status=${response.status} body=${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('no choices');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { reply: content, escalate: shouldEscalate, sendImage: false, imageUrl: '' };
  }

  const chosen = catalog.getById(parsed.chosenProductId) || matchedProducts[0] || null;
  const sendImage = Boolean(config.sendProductImages && parsed.sendImage && chosen?.primaryImageUrl);
  return {
    reply: String(parsed.reply || fallbackReply).trim(),
    escalate: Boolean(parsed.escalate || shouldEscalate),
    sendImage,
    imageUrl: sendImage ? chosen.primaryImageUrl : '',
  };
}

function toModelMessages(turn) {
  if (turn.role !== 'user' || !Array.isArray(turn.imageUrls) || turn.imageUrls.length === 0) {
    return [{ role: turn.role, content: turn.content }];
  }

  const parts = [{ type: 'text', text: turn.content }];
  for (const url of turn.imageUrls.slice(0, 2)) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return [{ role: 'user', content: parts }];
}

function buildUserContent(incoming, catalogContext, shouldEscalate, localImageDataUrls = []) {
  const parts = [
    { type: 'text', text: `Customer message: ${incoming.text || '[Image only]'}\nPotential escalation by heuristic: ${shouldEscalate}\nCatalog matches: ${JSON.stringify(catalogContext)}` },
  ];

  for (const url of localImageDataUrls.slice(0, 2)) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

function heuristicEscalation(text) {
  const q = normalizeFreeText(text);
  if (!q) return false;
  const triggers = [
    'refund', 'return', 'payment', 'pay', 'bank transfer', 'card issue', 'delivery delay', 'where is my order',
    'complaint', 'cancel order', 'speak to human', 'agent', 'representative', 'problem with order',
  ];
  return triggers.some((term) => q.includes(term));
}

async function downloadImageAsDataUrl(url) {
  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 InstaBotJS/1.0',
    },
  }, config.requestTimeoutMs);

  if (!response.ok) {
    throw new Error(`image download status=${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const tempDir = path.join(os.tmpdir(), 'instabot-js-images');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${Date.now()}-${crypto.randomUUID()}`);
  fs.writeFileSync(tempPath, buffer);
  try {
    const base64 = buffer.toString('base64');
    return `data:${contentType};base64,${base64}`;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

async function sendIGMessage(recipientId, text) {
  if (!config.igPageId || !config.igPageAccessToken) throw new Error('IG_PAGE_ID or IG_PAGE_ACCESS_TOKEN missing');
  const recipient = String(recipientId || '').trim();
  const messageText = String(text || '').trim();
  if (!recipient) throw new Error('recipientID missing');
  if (!messageText) throw new Error('message text missing');

  await callGraphApi({
    recipient: { id: recipient },
    message: { text: messageText },
    messaging_type: 'RESPONSE',
  });
}

async function sendIGImage(recipientId, imageUrl, caption = '') {
  if (!config.igPageId || !config.igPageAccessToken) throw new Error('IG_PAGE_ID or IG_PAGE_ACCESS_TOKEN missing');
  const recipient = String(recipientId || '').trim();
  if (!recipient) throw new Error('recipientID missing');
  if (!imageUrl) throw new Error('image url missing');

  await callGraphApi({
    recipient: { id: recipient },
    message: {
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: false },
      },
    },
    messaging_type: 'RESPONSE',
  });

  if (caption && caption.trim()) {
    await sendIGMessage(recipientId, caption);
  }
}

async function callGraphApi(payload) {
  const url = new URL(`https://graph.facebook.com/v25.0/${config.igPageId}/messages`);
  url.searchParams.set('access_token', config.igPageAccessToken.trim());

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, config.requestTimeoutMs);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`graph status=${response.status} body=${body}`);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function followupWorker() {
  const threads = store.listThreads().sort((a, b) => {
    const aTime = a.nextFollowupAt ? new Date(a.nextFollowupAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.nextFollowupAt ? new Date(b.nextFollowupAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });

  const now = Date.now();
  for (const thread of threads) {
    if (!thread.senderId || !thread.nextFollowupAt) continue;
    if (thread.escalated) continue;
    if (new Date(thread.nextFollowupAt).getTime() > now) continue;
    if ((thread.followupCount || 0) >= config.followupMaxPerUser) continue;
    if (thread.lastUserAt && thread.lastBotAt && new Date(thread.lastUserAt) > new Date(thread.lastBotAt)) continue;

    const msg = 'Hey — just checking in. Want me to help with anything else?';
    try {
      await sendIGMessage(thread.senderId, msg);
      const nowIso = new Date().toISOString();
      thread.followupCount = (thread.followupCount || 0) + 1;
      thread.lastBotAt = nowIso;
      thread.nextFollowupAt = new Date(Date.now() + config.followupDelayMs).toISOString();
      thread.turns = trimTurns([
        ...(thread.turns || []),
        { role: 'assistant', content: msg, timestamp: nowIso },
      ], config.memoryTurns);
      store.saveThread(thread);
      logInfo(`followup sent sender=${thread.senderId}`);
    } catch (err) {
      logError('followup send error', err);
    }
  }
}

function handleHome(req, res) {
  if (req.path !== '/') return res.status(404).send('not found');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>InstaBot JS</title></head>
<body style="font-family:Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.6;padding:0 16px;">
<h1>InstaBot JS</h1>
<p>Instagram DM automation service.</p>
<ul>
  <li><a href="/health">Health</a></li>
  <li><a href="/privacy">Privacy Policy</a></li>
  <li><a href="/data-deletion">Data Deletion Instructions</a></li>
</ul>
</body></html>`);
}

function handlePrivacy(_req, res) {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>InstaBot JS Privacy Policy</title></head>
<body style="font-family:Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.6;padding:0 16px;">
<h1>Privacy Policy — InstaBot JS</h1>
<p>Effective date: 2026-07-08</p>
<p>InstaBot JS is an automation service that responds to Instagram direct messages for the connected business account.</p>
<h2>Data we process</h2>
<ul>
  <li>Instagram sender ID</li>
  <li>Message text, image URLs, and timestamps</li>
  <li>Webhook metadata required for message delivery and security verification</li>
</ul>
<h2>Purpose of processing</h2>
<ul>
  <li>Generate and send automated replies</li>
  <li>Maintain short conversation memory for context continuity</li>
  <li>Send optional follow-up messages if enabled</li>
</ul>
<h2>Storage and retention</h2>
<p>Conversation data is stored only as needed for bot operation and troubleshooting.</p>
<h2>Third-party processors</h2>
<ul>
  <li>Meta Platforms (Instagram Graph API / Webhooks)</li>
  <li>OpenAI (only when AI-generated replies are enabled)</li>
</ul>
<h2>Your rights</h2>
<p>You may request access, correction, or deletion of your data via the data deletion instructions below.</p>
<h2>Contact</h2>
<p>Email: bankolek1@gmail.com</p>
<p>Data deletion instructions: <a href="/data-deletion">/data-deletion</a></p>
</body></html>`);
}

function handleDataDeletion(_req, res) {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>InstaBot JS Data Deletion</title></head>
<body style="font-family:Arial,sans-serif;max-width:760px;margin:40px auto;line-height:1.6;padding:0 16px;">
<h1>Data Deletion Instructions — InstaBot JS</h1>
<p>To request deletion of your Instagram conversation data processed by InstaBot JS:</p>
<ol>
  <li>Send an email to <strong>bankolek1@gmail.com</strong> with subject: <em>Data Deletion Request</em>.</li>
  <li>Include your Instagram handle and approximate date/time of your last message.</li>
  <li>We will process and confirm deletion within 7 business days.</li>
</ol>
<p>If you are contacting from within Instagram, you may also send: <strong>DELETE MY DATA</strong> in DM to trigger manual review.</p>
</body></html>`);
}

function logInfo(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function logError(message, err) {
  console.error(`${new Date().toISOString()} ${message}:`, err instanceof Error ? err.message : err);
}

bootstrap();
