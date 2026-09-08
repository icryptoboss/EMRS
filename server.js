/**
 * NESTS PDF Scanner — Render.com Web Service
 * ===========================================
 * Persistent server-side scan (survives page refresh / back button)
 * Live terminal progress via SSE
 * Auto-sends to Telegram on completion
 *
 * Deploy on Render:
 *   1. Push to GitHub
 *   2. New Web Service → connect repo → Runtime: Node
 *   3. Start command: node server.js
 *   4. Add env vars: BOT_TOKEN, CHAT_ID
 */

const express  = require('express');
const app      = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID   = process.env.CHAT_ID   || '';
// Support multiple chat IDs — comma separated in env var CHAT_IDS
// e.g. CHAT_IDS=123456789,-1001234567890,987654321
// Falls back to single CHAT_ID if CHAT_IDS not set
const CHAT_IDS  = process.env.CHAT_IDS
  ? process.env.CHAT_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : (CHAT_ID ? [CHAT_ID] : []);

// Helper: send to ALL configured chats
async function broadcastTg(token, text, buttons = null) {
  const results = await Promise.all(CHAT_IDS.map(id => sendTg(token, id, text, buttons)));
  return results;
}

// ── PDF watermark + send as file ───────────────────────────────────────────
async function watermarkAndSendPdf(token, chatId, pdfUrl, caption) {
  try {
    const { PDFDocument, rgb, degrees } = require('pdf-lib');

    // Download original PDF
    const res      = await fetch(pdfUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nests.tribal.gov.in/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const pdfBytes = Buffer.from(await res.arrayBuffer());

    // Load and watermark every page
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages  = pdfDoc.getPages();

    for (const page of pages) {
      const { width, height } = page.getSize();
      const fontSize = Math.min(width, height) * 0.07;

      // Draw watermark diagonally across the page (repeated grid)
      const text   = 'BY PATEL';
      const cols   = 3;
      const rows   = 4;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          page.drawText(text, {
            x:        (width  / cols) * c + fontSize,
            y:        (height / rows) * r + fontSize,
            size:     fontSize,
            color:    rgb(0.75, 0.75, 0.75),  // light grey
            opacity:  0.35,
            rotate:   degrees(45),
          });
        }
      }
    }

    const watermarked = await pdfDoc.save();

    // Send as document via Telegram multipart/form-data
    const FormData = require('form-data');
    const form     = new FormData();
    form.append('chat_id',  chatId);
    form.append('caption',  caption, { contentType: 'text/plain' });
    form.append('parse_mode', 'HTML');
    form.append('document', Buffer.from(watermarked), {
      filename:    'NESTS_Notice.pdf',
      contentType: 'application/pdf',
    });

    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body:   form,
      headers: form.getHeaders(),
    });
  } catch (e) {
    // Fallback: send link-only message if PDF processing fails
    console.error('watermarkAndSendPdf error:', e.message);
    await sendTg(token, chatId, caption + `\n\n⚠ <i>PDF attachment failed: ${e.message}</i>`);
  }
}

// Broadcast watermarked PDF to all CHAT_IDS
async function broadcastPdf(token, pdfUrl, caption) {
  await Promise.all(CHAT_IDS.map(id => watermarkAndSendPdf(token, id, pdfUrl, caption)));
}
const PORT      = process.env.PORT      || 3000;

const KNOWN = [
  { id: '1778741996', label: 'Notice #20 – OMR/Answer Key Tier-II', date: '2026-05-14' },
  { id: '1773904899', label: 'Notice #19 – Admit Card Tier-II',     date: '2026-03-19' },
  { id: '1772527422', label: 'Notice #18 – Exam City Tier-II',      date: '2026-03-03' },
  { id: '1772082408', label: 'Notice #17 – Schedule Tier-II',       date: '2026-02-26' },
];
const KNOWN_IDS = new Set(KNOWN.map(k => k.id));
const PDF_BASE  = 'https://nests.tribal.gov.in/WriteReadData/RTF1984/';
const CONCURRENCY = 80;

// ── Global scan state (persists across client disconnects) ─────────────────
let job = {
  status:     'idle',       // idle | running | done | stopped
  windowSecs: 0,
  windowLabel:'',
  startEpoch: 0,            // newest (scan starts here)
  endEpoch:   0,            // oldest
  cursor:     0,            // current position (goes backward)
  checked:    0,
  found:      [],           // all found PDFs
  startedAt:  0,
  autoSend:   true,
  chatId:     CHAT_ID,
  log:        [],           // terminal lines (last 2000)
};

// ── SSE broadcast ──────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}

function addLog(text, type = 'info') {
  const ts  = nowIST().slice(11, 19);
  const line = { ts, text, type };
  job.log.push(line);
  if (job.log.length > 2000) job.log.shift();
  broadcast('log', line);
}

// ── Utilities ──────────────────────────────────────────────────────────────
const nowEpoch = () => Math.floor(Date.now() / 1000);

function epochToIST(ts) {
  const d = new Date((Number(ts) + 19800) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`;
}
function nowIST() { return epochToIST(nowEpoch()); }

async function checkPdf(id) {
  const url = PDF_BASE + id + '.pdf';
  try {
    const r    = await fetch(url, {
      method: 'HEAD', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nests.tribal.gov.in/' },
    });
    const hit  = r.status === 200 || r.status === 206;
    const size = parseInt(r.headers.get('content-length') || '0', 10);
    return { id, url, date: epochToIST(id), status: r.status, hit, size, known: KNOWN_IDS.has(id) };
  } catch {
    return { id, url, date: epochToIST(id), status: 0, hit: false, size: 0, known: false };
  }
}

async function sendTg(token, chatId, text, buttons = null) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

// ── Core scan engine ────────────────────────────────────────────────────────
async function runScan() {
  const { startEpoch, endEpoch } = job;
  const total = startEpoch - endEpoch;

  addLog(`${'═'.repeat(52)}`, 'divider');
  addLog(`NESTS PDF Scanner started`, 'success');
  addLog(`Window  : ${job.windowLabel} (${total.toLocaleString()} IDs)`, 'info');
  addLog(`From    : ${epochToIST(startEpoch)}`, 'info');
  addLog(`To      : ${epochToIST(endEpoch)}`, 'info');
  addLog(`Workers : ${CONCURRENCY} parallel`, 'info');
  addLog(`${'─'.repeat(52)}`, 'divider');

  const startT = Date.now();
  job.cursor   = startEpoch;

  // Walk backward in batches
  while (job.cursor > endEpoch && job.status === 'running') {
    const batchSize = Math.min(CONCURRENCY, job.cursor - endEpoch);
    const ids = Array.from({ length: batchSize }, (_, i) => String(job.cursor - i));

    const results = await Promise.all(ids.map(checkPdf));

    for (const r of results) {
      job.checked++;
      if (r.hit) {
        job.found.push(r);
        const sizeStr = r.size > 0 ? ` [${Math.round(r.size/1024)}KB]` : '';
        const tag     = r.known ? 'KNOWN' : '★ NEW ★';
        addLog(`${tag}: ${r.id}.pdf  ${r.date}${sizeStr}`, r.known ? 'known' : 'found');
        broadcast('hit', r);
      }
    }

    job.cursor -= batchSize;

    // Progress broadcast every 500 IDs
    if (job.checked % 500 < CONCURRENCY || job.cursor <= endEpoch) {
      const elapsed  = (Date.now() - startT) / 1000;
      const rate     = Math.round(job.checked / elapsed);
      const remain   = (job.cursor - endEpoch);
      const etaSecs  = rate > 0 ? Math.round(remain / rate) : 0;
      const pct      = Math.round(((startEpoch - job.cursor) / total) * 100);

      addLog(
        `↓ ${epochToIST(job.cursor)}  [${pct}%  ${job.checked.toLocaleString()}/${total.toLocaleString()}  ${rate}/s  ETA:${fmtETA(etaSecs)}]`,
        'progress'
      );

      broadcast('stats', {
        checked:  job.checked,
        total,
        found:    job.found.length,
        pct,
        rate,
        eta:      etaSecs,
        cursor:   job.cursor,
        cursorIST: epochToIST(job.cursor),
      });
    }
  }

  // Finalize
  const wasStopped = job.status === 'stopped';
  if (!wasStopped) job.status = 'done';

  addLog(`${'─'.repeat(52)}`, 'divider');
  addLog(wasStopped ? 'Scan STOPPED by user.' : 'Scan COMPLETE.', wasStopped ? 'warn' : 'success');
  addLog(`Checked : ${job.checked.toLocaleString()} IDs`, 'info');
  addLog(`Found   : ${job.found.length} PDF(s)`, 'info');

  if (!wasStopped && job.autoSend && job.chatId) {
    addLog('Sending results to Telegram...', 'info');
    await sendScanResults(job.chatId);
    addLog('✅ Results sent to Telegram.', 'success');
  }

  addLog(`${'═'.repeat(52)}`, 'divider');
  broadcast('done', { found: job.found, checked: job.checked, stopped: wasStopped });
}

function fmtETA(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m${String(secs%60).padStart(2,'0')}s`;
  return `${Math.floor(secs/3600)}h${String(Math.floor((secs%3600)/60)).padStart(2,'0')}m`;
}

// ── Send results to Telegram ───────────────────────────────────────────────
async function sendScanResults(chatId) {
  const { found, checked, windowLabel } = job;

  let msg = `📋 <b>NESTS PDF Scan Complete</b>\n\n`
          + `⏱ Window  : ${windowLabel}\n`
          + `🔍 Checked : ${checked.toLocaleString()} IDs\n`
          + `📄 Found   : <b>${found.length} PDF(s)</b>\n\n`;

  if (found.length === 0) {
    msg += `✅ No new PDFs in this time window.`;
  } else {
    for (const p of found) {
      msg += `${p.known ? '🔖' : '🆕'} <code>${p.id}</code>\n`
           + `📅 ${p.date}\n`
           + (p.size > 0 ? `📦 ${Math.round(p.size/1024)}KB\n` : '')
           + `🔗 <a href="${p.url}">Open PDF</a>\n\n`;
    }
  }

  // Send text summary to requesting chatId + all configured chats
  const targets = new Set([chatId, ...CHAT_IDS]);
  await Promise.all([...targets].map(id => sendTg(BOT_TOKEN, id, msg)));

  // Attach each found PDF with watermark
  for (const p of found) {
    const cap = `📄 <b>NESTS Notice</b>\n📅 ${p.date}\n🔗 ${p.url}`;
    await Promise.all([...targets].map(id => watermarkAndSendPdf(BOT_TOKEN, id, p.url, cap)));
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

// SSE — client connects here for live updates
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  clients.add(res);

  // Send full current state immediately on connect (resume on refresh)
  res.write(`event: sync\ndata: ${JSON.stringify({
    status:    job.status,
    checked:   job.checked,
    total:     job.startEpoch - job.endEpoch || 0,
    found:     job.found,
    log:       job.log.slice(-200),   // last 200 lines
    cursor:    job.cursor,
    pct:       job.startEpoch > job.endEpoch
               ? Math.round(((job.startEpoch - job.cursor) / (job.startEpoch - job.endEpoch)) * 100)
               : 0,
    windowLabel: job.windowLabel,
  })}\n\n`);

  // Heartbeat
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); clients.delete(res); }
  }, 25000);

  req.on('close', () => { clients.delete(res); clearInterval(hb); });
});

// Start scan
app.post('/start', async (req, res) => {
  if (job.status === 'running') return res.json({ ok: false, error: 'Scan already running' });

  const { windowSecs, windowLabel, chatId, autoSend } = req.body;
  const now = nowEpoch();

  job = {
    status:      'running',
    windowSecs,
    windowLabel: windowLabel || `${windowSecs}s`,
    startEpoch:  now,
    endEpoch:    now - windowSecs,
    cursor:      now,
    checked:     0,
    found:       [],
    startedAt:   now,
    autoSend:    autoSend !== false,
    chatId:      chatId || CHAT_ID,
    log:         [],
  };

  broadcast('started', { windowLabel: job.windowLabel, total: windowSecs });
  runScan(); // fire and forget — persists even if client disconnects
  res.json({ ok: true });
});

// Stop scan
app.post('/stop', (req, res) => {
  if (job.status === 'running') {
    job.status = 'stopped';
    addLog('⛔ Stop requested by user.', 'warn');
  }
  res.json({ ok: true });
});

// Status
app.get('/status', (req, res) => {
  res.json({
    status:      job.status,
    checked:     job.checked,
    total:       job.startEpoch - job.endEpoch || 0,
    found:       job.found.length,
    windowLabel: job.windowLabel,
    pct:         job.startEpoch > job.endEpoch
                 ? Math.round(((job.startEpoch - job.cursor) / (job.startEpoch - job.endEpoch)) * 100)
                 : 0,
  });
});

// Manual send
app.post('/send', async (req, res) => {
  const chatId = req.body.chatId || CHAT_ID;
  if (!chatId) return res.json({ ok: false, error: 'No chat_id' });
  const saved = job.chatId;
  job.chatId = chatId;
  await sendScanResults(chatId);
  job.chatId = saved;
  res.json({ ok: true });
});

// Known list
app.get('/known', (req, res) => res.json({ known: KNOWN }));

// Telegram webhook
app.post('/webhook', async (req, res) => {
  const update = req.body;
  res.sendStatus(200);

  const host = `${req.protocol}://${req.get('host')}`;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text   = (update.message.text || '').trim();

    if (text.startsWith('/start')) {
      await sendTg(BOT_TOKEN, chatId,
        `👋 <b>NESTS PDF Scanner</b>\n\n`
      + `Scans NESTS exam notice PDFs in reverse (latest first).\n\n`
      + `Tap below to open the live scanner:`,
        [[{ text: '🔍 Open Live Scanner', web_app: { url: `https://${req.get('host')}/?cid=${chatId}` } }],
         [{ text: '📋 Known PDFs', callback_data: 'known' },
          { text: '📊 Status',    callback_data: 'status' }]]
      );
    } else if (text.startsWith('/status')) {
      const s = job;
      await sendTg(BOT_TOKEN, chatId,
        `📊 <b>Scanner Status</b>\n\n`
      + `Status  : ${s.status}\n`
      + `Window  : ${s.windowLabel || '—'}\n`
      + `Checked : ${s.checked.toLocaleString()}\n`
      + `Found   : ${s.found.length}\n`
      + `Progress: ${s.startEpoch > s.endEpoch
          ? Math.round(((s.startEpoch - s.cursor) / (s.startEpoch - s.endEpoch)) * 100) : 0}%`
      );
    } else if (text.startsWith('/known')) {
      let msg = `📋 <b>Known PDFs</b>\n\n`;
      KNOWN.forEach(k => msg += `📄 <a href="${PDF_BASE}${k.id}.pdf">${k.id}</a>\n${k.date} — ${k.label}\n\n`);
      await sendTg(BOT_TOKEN, chatId, msg);
    }
  }

  if (update.callback_query) {
    const chatId = update.callback_query.from.id;
    if (update.callback_query.data === 'known') {
      let msg = `📋 <b>Known PDFs</b>\n\n`;
      KNOWN.forEach(k => msg += `<a href="${PDF_BASE}${k.id}.pdf">${k.id}</a> — ${k.label}\n`);
      await sendTg(BOT_TOKEN, chatId, msg);
    } else if (update.callback_query.data === 'status') {
      await sendTg(BOT_TOKEN, chatId, `Status: <b>${job.status}</b> | Found: ${job.found.length} | Checked: ${job.checked}`);
    }
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: update.callback_query.id }),
    });
  }
});

// Setup webhook
app.post('/setup', async (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${host}/webhook`, drop_pending_updates: true }),
  });
  const result = await r.json();
  res.json({ ok: result.ok, webhook: `${host}/webhook` });
});

// ── HTML Web App ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send(HTML));

// ══════════════════════════════════════════════════════════════════════════
// ── AUTO-SCAN (added below — nothing above this line was changed) ─────────
// ══════════════════════════════════════════════════════════════════════════

// Tracks IDs already notified via auto-scan so we never send duplicates.
// Pre-seeded with all KNOWN_IDS so those never trigger an alert.
const autoSeenIds = new Set([...KNOWN_IDS]);

async function runAutoScan() {
  // If a manual scan is running, skip this tick to avoid server overload.
  // Auto-scan will resume on the next 30-second tick automatically.
  if (job.status === 'running') {
    addLog('[AUTO] Tick skipped — manual scan in progress', 'progress');
    return;
  }

  const now        = nowEpoch();
  const windowSecs = 60; // ← CHANGED: scan last 60s each tick (covers 30s interval with overlap)
  const startEp    = now;
  const endEp      = now - windowSecs;

  // Build IDs in reverse (newest first), skip already-seen and already-found-by-manual
  const manualFoundIds = new Set(job.found.map(f => f.id));
  const ids = Array.from({ length: windowSecs }, (_, i) => String(startEp - i))
                   .filter(id => !autoSeenIds.has(id) && !manualFoundIds.has(id));

  if (ids.length === 0) return; // all already seen, nothing to do

  addLog(`${'─'.repeat(52)}`, 'divider');
  addLog(`[AUTO] Scanning last 60s (${ids.length} IDs) ...`, 'progress');

  const startT = Date.now();
  const hits   = [];

  // Run in batches of CONCURRENCY — same engine as manual scan
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch   = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(checkPdf));

    for (const r of results) {
      if (r.hit) {
        hits.push(r);
        const sizeStr = r.size > 0 ? ` [${Math.round(r.size / 1024)}KB]` : '';
        const tag     = r.known ? '[AUTO] KNOWN' : '[AUTO] ★ NEW ★';
        addLog(`${tag}: ${r.id}.pdf  ${r.date}${sizeStr}`, r.known ? 'known' : 'found');
        if (!r.known) broadcast('hit', r); // show in Found PDFs panel
      }
    }

    // Progress line every 200 IDs
    if ((i + CONCURRENCY) % 200 < CONCURRENCY || i + CONCURRENCY >= ids.length) {
      const done    = Math.min(i + CONCURRENCY, ids.length);
      const elapsed = (Date.now() - startT) / 1000 || 0.001;
      const rate    = Math.round(done / elapsed);
      const pct     = Math.round((done / ids.length) * 100);
      addLog(
        `[AUTO] ↓ ${epochToIST(startEp - done)}  [${pct}%  ${done}/${ids.length}  ${rate}/s]`,
        'progress'
      );
    }
  }

  // Mark all scanned IDs as seen so next tick skips them
  ids.forEach(id => autoSeenIds.add(id));

  // Only new (non-known) PDFs that weren't already reported
  const newFinds = hits.filter(r => !r.known);

  const elapsed = ((Date.now() - startT) / 1000).toFixed(1);
  addLog(
    `[AUTO] Done — ${ids.length} checked in ${elapsed}s — ${newFinds.length} new PDF(s) found`,
    newFinds.length > 0 ? 'success' : 'progress'
  );

  // Send Telegram alert ONLY if new PDFs were found
  if (newFinds.length > 0) {
    if (CHAT_IDS.length > 0 && BOT_TOKEN) {
      let msg = `🔔 <b>NESTS Auto-Scan Alert</b>\n\n`
              + `🆕 Found <b>${newFinds.length}</b> new PDF(s):\n\n`;

      for (const p of newFinds) {
        const sizeStr = p.size > 0 ? `📦 ${Math.round(p.size / 1024)}KB\n` : '';
        msg += `📄 <code>${p.id}</code>\n`
             + `📅 ${p.date}\n`
             + sizeStr
             + `🔗 <a href="${p.url}">Open PDF</a>\n\n`;
      }

      // Send text alert first, then attach each PDF with watermark
      await broadcastTg(BOT_TOKEN, msg);
      for (const p of newFinds) {
        const cap = `📄 <b>NESTS Notice</b>\n📅 ${p.date}\n🔗 ${p.url}`;
        await broadcastPdf(BOT_TOKEN, p.url, cap);
        addLog(`[AUTO] 📎 PDF sent: ${p.id}.pdf (watermarked)`, 'success');
      }
      addLog(`[AUTO] ✅ Alert + PDF(s) sent to ${CHAT_IDS.length} chat(s)`, 'success');

      // Also push to Found PDFs panel on any connected clients
      broadcast('stats', {
        checked:  ids.length,
        total:    ids.length,
        found:    newFinds.length,
        pct:      100,
        rate:     0,
        eta:      0,
      });
    } else {
      addLog('[AUTO] ⚠ No CHAT_IDS set — Telegram alert skipped', 'warn');
    }
  }

  addLog(`${'─'.repeat(52)}`, 'divider');
}

// ── Instant continuous loop — checks current epoch every second ──────────────
// Replaces old setInterval. Persistent async loop:
//   1. Checks THIS exact second the moment it ticks
//   2. Found PDF → sends text alert + uploads watermarked PDF INSTANTLY
//   3. Every 10s: sweeps last 10 IDs to catch anything missed
//   4. Sleeps until next wall-clock second to stay in sync

async function instantLoop() {
  addLog('[AUTO] Instant scanner started — checking every second', 'success');

  let lastCatchup = nowEpoch();

  while (true) {
    const loopStart = Date.now();
    const now       = nowEpoch();

    // ── 1. Check THIS exact second immediately ───────────────────────────
    if (!autoSeenIds.has(String(now)) && job.status !== 'running') {
      autoSeenIds.add(String(now));
      const result = await checkPdf(String(now));

      if (result.hit && !result.known) {
        const sizeStr = result.size > 0 ? ` [${Math.round(result.size / 1024)}KB]` : '';
        addLog(`[INSTANT] ★ NEW ★ ${result.id}.pdf  ${result.date}${sizeStr}`, 'found');
        broadcast('hit', result);

        const msg = `🚨 <b>NESTS New Notice Found!</b>\n\n`
                  + `📄 <code>${result.id}</code>\n`
                  + `📅 ${result.date}\n`
                  + (result.size > 0 ? `📦 ${Math.round(result.size / 1024)}KB\n` : '')
                  + `🔗 <a href="${result.url}">Open PDF</a>`;
        await broadcastTg(BOT_TOKEN, msg);

        const cap = `📄 <b>NESTS Notice</b>\n📅 ${result.date}\n🔗 ${result.url}`;
        await broadcastPdf(BOT_TOKEN, result.url, cap);
        addLog(`[INSTANT] 📎 Sent + PDF uploaded to ${CHAT_IDS.length} chat(s)`, 'success');

      } else if (result.hit && result.known) {
        addLog(`[INSTANT] ${result.id}.pdf — known`, 'known');
      }
    }

    // ── 2. Every 10s: sweep last 10s to catch any missed IDs ────────────
    if (now - lastCatchup >= 10 && job.status !== 'running') {
      lastCatchup = now;
      const missed = Array.from({ length: 10 }, (_, i) => String(now - i - 1))
                         .filter(id => !autoSeenIds.has(id));
      if (missed.length > 0) {
        const results = await Promise.all(missed.map(checkPdf));
        missed.forEach(id => autoSeenIds.add(id));
        for (const r of results) {
          if (r.hit && !r.known) {
            addLog(`[CATCHUP] ★ NEW ★ ${r.id}.pdf  ${r.date}`, 'found');
            broadcast('hit', r);
            const msg = `🚨 <b>NESTS New Notice Found!</b>\n\n`
                      + `📄 <code>${r.id}</code>\n`
                      + `📅 ${r.date}\n`
                      + `🔗 <a href="${r.url}">Open PDF</a>`;
            await broadcastTg(BOT_TOKEN, msg);
            const cap = `📄 <b>NESTS Notice</b>\n📅 ${r.date}\n🔗 ${r.url}`;
            await broadcastPdf(BOT_TOKEN, r.url, cap);
            addLog(`[CATCHUP] 📎 Sent ${r.id}.pdf`, 'success');
          }
        }
      }
    }

    // ── 3. Sleep until next wall-clock second ────────────────────────────
    const elapsed = Date.now() - loopStart;
    const sleep   = Math.max(0, 1000 - elapsed);
    await new Promise(r => setTimeout(r, sleep));
  }
}

// Boot: wait 10s for server to fully start, then launch instant loop
setTimeout(instantLoop, 10 * 1000);

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`NESTS Scanner running on :${PORT}`));

// ── HTML ──────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>NESTS PDF Scanner</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --bg:    #0d1117; --bg2: #161b22; --bg3: #1c2128;
  --text:  #e6edf3; --hint: #7d8590; --green: #3fb950;
  --blue:  #58a6ff; --amber: #d29922; --red: #f85149;
  --cyan:  #79c0ff; --purple: #d2a8ff; --white: #ffffff;
  --font:  'SF Mono', 'Fira Code', 'Consolas', monospace;
  --sans:  -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); }
.app { display: flex; flex-direction: column; height: 100vh; max-width: 700px; margin: 0 auto; padding: 12px; gap: 10px; }

/* Header */
.hdr { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
.hdr-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hint); flex-shrink: 0; }
.status-dot.running { background: var(--green); animation: pulse 1s infinite; }
.status-dot.done    { background: var(--blue); }
.status-dot.stopped { background: var(--red); }
.clock { font-size: 11px; color: var(--hint); font-family: var(--font); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

/* Window buttons */
.win-row { display: flex; gap: 5px; flex-wrap: wrap; }
.win-btn {
  padding: 5px 10px; border-radius: 6px; border: 1px solid #30363d;
  background: var(--bg2); color: var(--hint); font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all .15s; white-space: nowrap;
}
.win-btn.active  { background: #1f6feb; color: #fff; border-color: #1f6feb; }
.win-btn:hover:not(.active) { border-color: var(--hint); color: var(--text); }

/* Control row */
.ctrl-row { display: flex; gap: 8px; }
.btn-start, .btn-stop {
  padding: 9px 18px; border-radius: 8px; border: none; font-size: 13px;
  font-weight: 600; cursor: pointer; transition: opacity .15s; white-space: nowrap;
}
.btn-start          { background: #238636; color: #fff; flex: 1; }
.btn-start:disabled { opacity: .45; cursor: not-allowed; }
.btn-stop           { background: #da3633; color: #fff; }
.btn-send {
  background: #1d4ed8; color: #fff; border: none; border-radius: 6px;
  padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
  white-space: nowrap; transition: opacity .15s; display: none;
}

/* Stats bar */
.stats-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.stat { background: var(--bg2); border-radius: 8px; padding: 8px 6px; text-align: center; border: 1px solid #30363d; }
.stat-val { font-size: 17px; font-weight: 700; font-family: var(--font); }
.stat-lbl { font-size: 10px; color: var(--hint); margin-top: 2px; text-transform: uppercase; letter-spacing: .04em; }
.g { color: var(--green); } .b { color: var(--blue); } .a { color: var(--amber); }

/* Progress bar */
.pbar-wrap { height: 3px; background: #21262d; border-radius: 2px; overflow: hidden; }
.pbar      { height: 100%; background: #1f6feb; width: 0%; transition: width .3s; border-radius: 2px; }
.pbar.done { background: var(--green); }

/* Terminal */
.terminal {
  flex: 1; background: #010409; border-radius: 10px; border: 1px solid #30363d;
  overflow: hidden; display: flex; flex-direction: column; min-height: 0;
}
.term-titlebar {
  background: var(--bg2); padding: 8px 12px; display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid #30363d; flex-shrink: 0;
}
.term-dots { display: flex; gap: 5px; }
.term-dot  { width: 10px; height: 10px; border-radius: 50%; }
.term-lines {
  flex: 1; overflow-y: auto; padding: 10px 12px; font-family: var(--font);
  font-size: 12px; line-height: 1.6; scroll-behavior: smooth;
}
.term-lines::-webkit-scrollbar { width: 4px; }
.term-lines::-webkit-scrollbar-track { background: transparent; }
.term-lines::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
.tl          { display: flex; gap: 8px; animation: fadeIn .15s ease; }
.tl-ts       { color: #484f58; flex-shrink: 0; user-select: none; }
.tl-text     { word-break: break-all; }
.tl.info     .tl-text { color: var(--text); }
.tl.progress .tl-text { color: var(--hint); }
.tl.found    .tl-text { color: var(--green); font-weight: 600; }
.tl.known    .tl-text { color: var(--amber); }
.tl.warn     .tl-text { color: var(--amber); }
.tl.success  .tl-text { color: var(--cyan); font-weight: 600; }
.tl.divider  .tl-text { color: #30363d; }
.tl.error    .tl-text { color: var(--red); }
.cursor-blink { display: inline-block; width: 7px; height: 13px; background: var(--green); animation: blink 1s step-end infinite; vertical-align: text-bottom; margin-left: 3px; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
@keyframes fadeIn { from{opacity:0;transform:translateY(3px)} to{opacity:1;transform:none} }

/* Found PDF list */
.found-section { display: none; }
.found-section.show { display: block; }
.found-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--hint); margin-bottom: 6px; }
.found-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
.pdf-card { background: var(--bg2); border-radius: 8px; padding: 10px 12px; border-left: 3px solid var(--green); }
.pdf-card.known { border-left-color: var(--amber); }
.pdf-tag  { font-size: 10px; font-weight: 700; color: var(--green); }
.pdf-card.known .pdf-tag { color: var(--amber); }
.pdf-id   { font-family: var(--font); font-size: 12px; margin: 2px 0; }
.pdf-date { font-size: 11px; color: var(--hint); }
.pdf-link { color: var(--blue); font-size: 11px; text-decoration: none; display: inline-block; margin-top: 3px; }

/* Auto-send toggle */
.autosend-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--hint); }
.toggle { position: relative; display: inline-block; width: 32px; height: 18px; cursor: pointer; }
.toggle input { display: none; }
.slider { position: absolute; inset: 0; background: #21262d; border-radius: 10px; transition: .2s; }
.slider:before { content: ''; position: absolute; width: 12px; height: 12px; left: 3px; top: 3px; background: var(--hint); border-radius: 50%; transition: .2s; }
input:checked + .slider { background: #238636; }
input:checked + .slider:before { transform: translateX(14px); background: #fff; }

/* Toast */
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(10px); background: #1c2128; border: 1px solid #30363d; color: var(--text); padding: 9px 18px; border-radius: 20px; font-size: 12px; z-index: 999; opacity: 0; transition: all .25s; pointer-events: none; white-space: nowrap; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (max-width: 400px) {
  .stats-bar { grid-template-columns: repeat(2, 1fr); }
  .hdr-title  { font-size: 14px; }
}
</style>
</head>
<body>
<div class="app">

  <!-- Header -->
  <div class="hdr">
    <div class="hdr-title">
      <div class="status-dot" id="statusDot"></div>
      NESTS PDF Scanner
    </div>
    <div class="clock" id="clock">—</div>
  </div>

  <!-- Window selector -->
  <div class="win-row" id="winRow">
    <div class="win-btn" data-s="300"    data-l="5 min">5 min</div>
    <div class="win-btn" data-s="1800"   data-l="30 min">30 min</div>
    <div class="win-btn" data-s="3600"   data-l="1 hour">1 hr</div>
    <div class="win-btn" data-s="21600"  data-l="6 hours">6 hr</div>
    <div class="win-btn active" data-s="86400"  data-l="1 day">1 day</div>
    <div class="win-btn" data-s="259200" data-l="3 days">3 days</div>
    <div class="win-btn" data-s="432000" data-l="5 days">5 days</div>
  </div>

  <!-- Controls -->
  <div class="ctrl-row">
    <button class="btn-start" id="startBtn" onclick="startScan()">▶ Start Scan</button>
    <button class="btn-stop"  id="stopBtn"  onclick="stopScan()">■ Stop</button>
  </div>

  <!-- Stats -->
  <div class="stats-bar">
    <div class="stat"><div class="stat-val b" id="sChecked">—</div><div class="stat-lbl">Checked</div></div>
    <div class="stat"><div class="stat-val g" id="sFound">—</div><div class="stat-lbl">Found</div></div>
    <div class="stat"><div class="stat-val a" id="sRate">—</div><div class="stat-lbl">Req/s</div></div>
    <div class="stat"><div class="stat-val"   id="sETA">—</div><div class="stat-lbl">ETA</div></div>
  </div>
  <div class="pbar-wrap"><div class="pbar" id="pbar"></div></div>

  <!-- Terminal -->
  <div class="terminal">
    <div class="term-titlebar">
      <div class="term-dots">
        <div class="term-dot" style="background:#ff5f57"></div>
        <div class="term-dot" style="background:#ffbd2e"></div>
        <div class="term-dot" style="background:#28c840"></div>
      </div>
      <span style="font-size:11px;color:var(--hint);font-family:var(--font)">nests-scanner — bash</span>
    </div>
    <div class="term-lines" id="termLines">
      <div class="tl info"><span class="tl-ts">--:--:--</span><span class="tl-text">Ready. Select window and press Start Scan.<span class="cursor-blink" id="cursor"></span></span></div>
    </div>
  </div>

  <!-- Found PDFs -->
  <div class="found-section" id="foundSection">
    <div class="found-title" id="foundTitle">Found PDFs</div>
    <div class="found-list" id="foundList"></div>
  </div>

  <!-- Send + auto-send -->
  <div class="autosend-row">
    <button class="btn-send" id="sendBtn" onclick="sendToTelegram()">📨 Send</button>
    <label class="toggle"><input type="checkbox" id="autoSend" checked><div class="slider"></div></label>
    Auto-send to Telegram when scan completes
    <span id="chatLabel" style="margin-left:auto;font-size:11px;color:var(--hint)"></span>
  </div>

</div>
<div class="toast" id="toast"></div>

<script>
const tg     = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const urlParams = new URLSearchParams(location.search);
const CHAT_ID   = urlParams.get('cid') || tg?.initDataUnsafe?.user?.id || '';
if (CHAT_ID) document.getElementById('chatLabel').textContent = 'Chat: ' + CHAT_ID;

let windowSecs  = 86400;
let windowLabel = '1 day';
let scanning    = false;
let evtSrc      = null;

// ── Clock ──────────────────────────────────────────────────────────────────
function epochToIST(ts) {
  const d = new Date((Number(ts) + 19800) * 1000);
  const p = n => String(n).padStart(2,'0');
  return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+
         p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+' IST';
}
setInterval(() => {
  document.getElementById('clock').textContent = epochToIST(Math.floor(Date.now()/1000));
}, 1000);

// ── Window buttons ─────────────────────────────────────────────────────────
document.getElementById('winRow').addEventListener('click', e => {
  const btn = e.target.closest('.win-btn');
  if (!btn || scanning) return;
  document.querySelectorAll('.win-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  windowSecs  = parseInt(btn.dataset.s);
  windowLabel = btn.dataset.l;
});

// ── Terminal helpers ───────────────────────────────────────────────────────
const termEl     = document.getElementById('termLines');
const cursorEl   = document.getElementById('cursor');
let autoScroll   = true;

termEl.addEventListener('scroll', () => {
  autoScroll = termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 20;
});

function addLine(text, type = 'info', ts = null) {
  if (cursorEl) cursorEl.remove();
  const div  = document.createElement('div');
  div.className = 'tl ' + type;
  const time = ts || new Date().toTimeString().slice(0,8);
  div.innerHTML = \`<span class="tl-ts">\${time}</span><span class="tl-text">\${escHtml(text)}</span>\`;
  termEl.appendChild(div);
  if (autoScroll) termEl.scrollTop = termEl.scrollHeight;
}

function appendCursor() {
  const last = termEl.lastElementChild?.querySelector('.tl-text');
  if (last) { const c = document.createElement('span'); c.className = 'cursor-blink'; c.id = 'cursor'; last.appendChild(c); }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── SSE connection (auto-reconnects) ───────────────────────────────────────
function connectSSE() {
  if (evtSrc) evtSrc.close();
  evtSrc = new EventSource('/sse');

  evtSrc.addEventListener('sync', e => {
    const d = JSON.parse(e.data);

    // Replay last 200 log lines
    if (d.log && d.log.length > 0) {
      termEl.innerHTML = '';
      d.log.forEach(l => addLine(l.text, l.type, l.ts));
    }

    // Restore UI state
    setStatus(d.status);
    if (d.found) d.found.forEach(addPdfCard);
    updateStats({ checked: d.checked, total: d.total, found: d.found?.length || 0, pct: d.pct });

    if (d.status === 'running') {
      setScanning(true);
    } else if (d.status === 'done' || d.status === 'stopped') {
      setScanning(false);
      showSendBtn(true);
    }
    appendCursor();
  });

  evtSrc.addEventListener('log', e => {
    const l = JSON.parse(e.data);
    addLine(l.text, l.type, l.ts);
    appendCursor();
  });

  evtSrc.addEventListener('stats', e => {
    updateStats(JSON.parse(e.data));
  });

  evtSrc.addEventListener('hit', e => {
    addPdfCard(JSON.parse(e.data));
  });

  evtSrc.addEventListener('started', e => {
    setScanning(true);
    setStatus('running');
    document.getElementById('foundList').innerHTML = '';
    document.getElementById('foundSection').classList.remove('show');
  });

  evtSrc.addEventListener('done', e => {
    setScanning(false);
    setStatus('done');
    showSendBtn(true);
  });

  evtSrc.onerror = () => {
    setTimeout(connectSSE, 2000); // auto-reconnect
  };
}

connectSSE();

// ── Scan controls ──────────────────────────────────────────────────────────
async function startScan() {
  const res = await fetch('/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowSecs, windowLabel, chatId: CHAT_ID, autoSend: document.getElementById('autoSend').checked }),
  });
  const data = await res.json();
  if (!data.ok) showToast('⚠ ' + data.error);
}

async function stopScan() {
  await fetch('/stop', { method: 'POST' });
  setStatus('stopped');
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function setScanning(on) {
  scanning = on;
  document.getElementById('startBtn').disabled = on;
  document.querySelectorAll('.win-btn').forEach(b => b.style.pointerEvents = on ? 'none' : '');
  showSendBtn(!on && document.getElementById('foundList').children.length > 0);
}

function setStatus(s) {
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot ' + (s === 'running' ? 'running' : s === 'done' ? 'done' : s === 'stopped' ? 'stopped' : '');
}

function updateStats({ checked, total, found, pct, rate, eta }) {
  if (checked !== undefined) document.getElementById('sChecked').textContent = checked.toLocaleString();
  if (found   !== undefined) document.getElementById('sFound').textContent   = found;
  if (rate    !== undefined) document.getElementById('sRate').textContent    = rate + '/s';
  if (eta     !== undefined) document.getElementById('sETA').textContent     = fmtETA(eta);
  if (pct     !== undefined) {
    document.getElementById('pbar').style.width = pct + '%';
    if (pct >= 100) document.getElementById('pbar').classList.add('done');
  }
}

function fmtETA(secs) {
  if (!secs || secs <= 0) return '—';
  if (secs < 60)   return secs + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm' + String(secs%60).padStart(2,'0') + 's';
  return Math.floor(secs/3600) + 'h' + String(Math.floor((secs%3600)/60)).padStart(2,'0') + 'm';
}

function addPdfCard(pdf) {
  document.getElementById('foundSection').classList.add('show');
  const div  = document.createElement('div');
  div.className = 'pdf-card' + (pdf.known ? ' known' : '');
  const sizeStr = pdf.size > 0 ? \` · \${Math.round(pdf.size/1024)}KB\` : '';
  div.innerHTML = \`<div class="pdf-tag">\${pdf.known ? '🔖 KNOWN' : '★ NEW FIND'}</div>
    <div class="pdf-id">\${pdf.id}</div>
    <div class="pdf-date">\${pdf.date}\${sizeStr}</div>
    <a class="pdf-link" href="\${pdf.url}" target="_blank">📄 Open PDF →</a>\`;
  document.getElementById('foundList').prepend(div);
  const n = document.getElementById('foundList').children.length;
  document.getElementById('foundTitle').textContent = \`Found \${n} PDF\${n!==1?'s':''}\`;
}

function showSendBtn(show) {
  document.getElementById('sendBtn').style.display = show ? 'inline-block' : 'none';
}

async function sendToTelegram() {
  const btn = document.getElementById('sendBtn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const r = await fetch('/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chatId: CHAT_ID}) });
    const d = await r.json();
    showToast(d.ok ? '✅ Sent to Telegram!' : '❌ ' + (d.error || 'Error'));
  } catch { showToast('❌ Network error'); }
  btn.disabled = false; btn.textContent = '📨 Send';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
</script>
</body>
</html>`;
