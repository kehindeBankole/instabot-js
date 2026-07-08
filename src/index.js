import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const config = loadConfig();
let store;

function loadConfig() {
  return {
    port: process.env.PORT || '8080',
    verifyToken: process.env.IG_VERIFY_TOKEN || '',
    appSecret: process.env.IG_APP_SECRET || '',
    igUserId: process.env.IG_USER_ID || '',
    igPageId: process.env.IG_PAGE_ID || '',
    igPageAccessToken: process.env.IG_PAGE_ACCESS_TOKEN || '',
    openAIAPIKey: process.env.OPENAI_API_KEY || '',
    openAIModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    systemPrompt: process.env.IG_BOT_SYSTEM_PROMPT || 'You are an Instagram assistant. Be concise, friendly, and helpful. Keep replies under 3 short lines unless asked for more.',
    memoryTurns: parseInt(process.env.MEMORY_TURNS || '12', 10),
    followupDelayMs: parseDurationMs(process.env.FOLLOWUP_DELAY || '2h'),
    followupMaxPerUser: parseInt(process.env.FOLLOWUP_MAX_PER_USER || '1', 10),
    dataFile: process.env.DATA_FILE || 'instabot-js.json',
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

function bootstrap() {
  store = new JsonStore(config.dataFile);
  store.init();

  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));

  app.get('/', handleHome);
  app.get('/health', (_req, res) => res.status(200).send('ok'));
  app.get('/privacy', handlePrivacy);
  app.get('/data-deletion', handleDataDeletion);
  app.all('/ig-webhook', async (req, res) => {
    console.log(`webhook hit method=${req.method} path=${req.path} ua=${JSON.stringify(req.get('user-agent') || '')} remote=${req.ip}`);

    if (req.method === 'GET') {
      return handleVerify(req, res);
    }

    if (req.method !== 'POST') {
      return res.status(405).send('method not allowed');
    }

    return handleMessage(req, res);
  });

  setInterval(() => {
    followupWorker().catch((err) => console.error('followupWorker error:', err));
  }, 60_000);

  app.listen(config.port, () => {
    console.log(`instabot-js listening on :${config.port}`);
  });
}

class JsonStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.state = { threads: {} };
  }

  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.flush();
      return;
    }
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.state.threads || typeof this.state.threads !== 'object') {
        this.state.threads = {};
      }
    } catch {
      this.state = { threads: {} };
      this.flush();
    }
  }

  flush() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  getThread(senderId) {
    return this.state.threads[senderId] || {
      senderId,
      turns: [],
      lastUserAt: null,
      lastBotAt: null,
      followupCount: 0,
      nextFollowupAt: null,
    };
  }

  saveThread(thread) {
    this.state.threads[thread.senderId] = thread;
    this.flush();
  }

  listThreads() {
    return Object.values(this.state.threads);
  }
}

function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`verify attempt mode=${JSON.stringify(mode || '')} token_match=${token === config.verifyToken} challenge_len=${String(challenge || '').length}`);

  if (mode === 'subscribe' && token === config.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('forbidden');
}

async function handleMessage(req, res) {
  const bodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const sig = req.get('X-Hub-Signature-256') || '';

  if (config.appSecret && !verifyMetaSignature(config.appSecret, bodyBuffer, sig)) {
    console.log(`post rejected invalid signature sig_present=${Boolean(sig)} body_len=${bodyBuffer.length}`);
    return res.status(401).send('invalid signature');
  }

  let preview = bodyBuffer.toString('utf8');
  if (preview.length > 2000) preview = `${preview.slice(0, 2000)}...`;
  console.log(`post received sig_present=${Boolean(sig)} body_len=${bodyBuffer.length} payload=${preview}`);

  const incoming = req.body || {};
  const entries = Array.isArray(incoming.entry) ? incoming.entry : [];
  let processed = 0;

  for (const entry of entries) {
    for (const msg of entry.messaging || []) {
      const sender = msg?.sender?.id || '';
      const text = String(msg?.message?.text || '').trim();
      const isEcho = Boolean(msg?.message?.is_echo);
      if (!sender || !text || isEcho) continue;
      processed += 1;
      console.log(`message accepted (messaging) sender=${sender} text_len=${text.length}`);
      processIncoming(sender, text).catch((err) => console.error('processIncoming error:', err));
    }

    for (const change of entry.changes || []) {
      if (change?.field !== 'messages') continue;
      const sender = change?.value?.sender?.id || '';
      const text = String(change?.value?.message?.text || '').trim();
      if (!sender || !text) continue;
      processed += 1;
      console.log(`message accepted (changes) sender=${sender} text_len=${text.length}`);
      processIncoming(sender, text).catch((err) => console.error('processIncoming error:', err));
    }
  }

  if (processed === 0) {
    let rawPreview = JSON.stringify(incoming);
    if (rawPreview.length > 1200) rawPreview = `${rawPreview.slice(0, 1200)}...`;
    console.log(`post parsed entries=${entries.length} processed_messages=${processed} raw_preview=${rawPreview}`);
  } else {
    console.log(`post parsed entries=${entries.length} processed_messages=${processed}`);
  }

  return res.json({ ok: true });
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

async function processIncoming(senderId, userText) {
  const thread = store.getThread(senderId);
  const now = new Date().toISOString();
  thread.senderId = senderId;
  thread.lastUserAt = now;
  thread.turns = trimTurns([
    ...(thread.turns || []),
    { role: 'user', content: userText, timestamp: now },
  ], config.memoryTurns);

  const reply = await generateReply(thread.turns);
  await sendIGMessage(senderId, reply);

  const botTime = new Date().toISOString();
  thread.lastBotAt = botTime;
  thread.nextFollowupAt = new Date(Date.now() + config.followupDelayMs).toISOString();
  thread.followupCount = 0;
  thread.turns = trimTurns([
    ...thread.turns,
    { role: 'assistant', content: reply, timestamp: botTime },
  ], config.memoryTurns);

  store.saveThread(thread);
  console.log(`replied sender=${senderId}`);
}

function trimTurns(turns, n) {
  if (!n || turns.length <= n) return turns;
  return turns.slice(-n);
}

async function generateReply(turns) {
  if (!config.openAIAPIKey) {
    return 'Thanks for your message! I can help with product details, availability, and next steps. What are you looking for today?';
  }

  const messages = [
    { role: 'system', content: config.systemPrompt },
    ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openAIAPIKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openAIModel,
      messages,
      temperature: 0.6,
      max_completion_tokens: 220,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`openai status=${response.status} body=${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('no choices');
  return content;
}

async function sendIGMessage(recipientId, text) {
  if (!config.igPageId || !config.igPageAccessToken) {
    throw new Error('IG_PAGE_ID or IG_PAGE_ACCESS_TOKEN missing');
  }

  const recipient = String(recipientId || '').trim();
  const messageText = String(text || '').trim();
  if (!recipient) throw new Error('recipientID missing');
  if (!messageText) throw new Error('message text missing');

  const url = new URL(`https://graph.facebook.com/v25.0/${config.igPageId}/messages`);
  url.searchParams.set('access_token', config.igPageAccessToken.trim());

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipient },
      message: { text: messageText },
      messaging_type: 'RESPONSE',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`graph status=${response.status} body=${body}`);
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
      console.log(`followup sent sender=${thread.senderId}`);
    } catch (err) {
      console.error('followup send error:', err);
    }
  }
}

function handleHome(req, res) {
  if (req.path !== '/') {
    return res.status(404).send('not found');
  }
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
  <li>Message text and timestamps</li>
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

bootstrap();
