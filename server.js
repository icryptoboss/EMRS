/**
 * NESTS PDF Scanner — Render.com Web Service
 * ENV VARS: BOT_TOKEN, CHAT_ID, CHAT_IDS (comma-sep), PORT
 */
'use strict';
const express = require('express');
const FormData = require('form-data');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const CHAT_IDS = process.env.CHAT_IDS
    ? process.env.CHAT_IDS.split(',').map(s => s.trim()).filter(Boolean)
    : (CHAT_ID ? [CHAT_ID] : []);

const PDF_BASE = 'https://nests.tribal.gov.in/WriteReadData/RTF1984/';
const CONCURRENCY = 80;

const KNOWN = [
    { id: '1778741996', label: 'Notice #20 - OMR/Answer Key Tier-II', date: '2026-05-14' },
    { id: '1773904899', label: 'Notice #19 - Admit Card Tier-II', date: '2026-03-19' },
    { id: '1772527422', label: 'Notice #18 - Exam City Tier-II', date: '2026-03-03' },
    { id: '1772082408', label: 'Notice #17 - Schedule Tier-II', date: '2026-02-26' },
];
const KNOWN_IDS = new Set(KNOWN.map(k => k.id));

const nowEpoch = () => Math.floor(Date.now() / 1000);

function epochToIST(ts) {
    const d = new Date((Number(ts) + 19800) * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} IST`;
}
function nowIST() { return epochToIST(nowEpoch()); }
function fmtETA(secs) {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
    return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;
}

const clients = new Set();
function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch { } }
}

let job = { status: 'idle', windowSecs: 0, windowLabel: '', startEpoch: 0, endEpoch: 0, cursor: 0, checked: 0, found: [], startedAt: 0, autoSend: true, chatId: CHAT_ID, log: [] };

function addLog(text, type = 'info') {
    const ts = nowIST().slice(11, 19), line = { ts, text, type };
    job.log.push(line); if (job.log.length > 2000) job.log.shift();
    broadcast('log', line);
}

// ── Telegram helpers ──────────────────────────────────────────────────────
async function sendTg(chatId, text, buttons = null) {
    if (!BOT_TOKEN || !chatId) return;
    const body = { chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: false };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    } catch (e) { console.error('sendTg error:', e.message); }
}

async function broadcastTg(text, buttons = null) {
    await Promise.all(CHAT_IDS.map(id => sendTg(id, text, buttons)));
}

/**
 * Download PDF and send to ONE Telegram chat.
 * FIX: Buffer the entire form-data before sending.
 * Node.js fetch cannot set Content-Length on a stream, Telegram rejects with 400.
 * Buffering gives fetch a Buffer with a known size — Telegram accepts it.
 */
async function sendPdfToChat(chatId, pdfUrl, caption) {
    try {
        const dlRes = await fetch(pdfUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nests.tribal.gov.in/' },
            signal: AbortSignal.timeout(30000),
        });
        if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
        const pdfBytes = Buffer.from(await dlRes.arrayBuffer());

        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        form.append('document', pdfBytes, { filename: 'NESTS_Notice.pdf', contentType: 'application/pdf' });

        const formBuffer = await new Promise((resolve, reject) => {
            const chunks = [];
            form.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            form.on('end', () => resolve(Buffer.concat(chunks)));
            form.on('error', reject);
        });

        const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
            method: 'POST', body: formBuffer, headers: form.getHeaders(),
        });
        if (!tgRes.ok) {
            const err = await tgRes.text();
            throw new Error(`Telegram ${tgRes.status}: ${err}`);
        }
    } catch (e) {
        console.error(`sendPdfToChat(${chatId}):`, e.message);
        addLog(`PDF failed (${chatId}): ${e.message}`, 'error');
        await sendTg(chatId, caption + `\n\n PDF upload failed: ${e.message}`);
    }
}

async function broadcastPdf(pdfUrl, caption) {
    await Promise.all(CHAT_IDS.map(id => sendPdfToChat(id, pdfUrl, caption)));
}

async function checkPdf(id) {
    const url = PDF_BASE + id + '.pdf';
    try {
        const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nests.tribal.gov.in/' } });
        const hit = r.status === 200 || r.status === 206;
        const size = parseInt(r.headers.get('content-length') || '0', 10);
        return { id, url, date: epochToIST(id), status: r.status, hit, size, known: KNOWN_IDS.has(id) };
    } catch {
        return { id, url, date: epochToIST(id), status: 0, hit: false, size: 0, known: false };
    }
}

// ── Manual scan engine ────────────────────────────────────────────────────
async function runScan() {
    const { startEpoch, endEpoch } = job;
    const total = startEpoch - endEpoch;
    addLog('='.repeat(52), 'divider');
    addLog('NESTS PDF Scanner started', 'success');
    addLog(`Window  : ${job.windowLabel} (${total.toLocaleString()} IDs)`, 'info');
    addLog(`From    : ${epochToIST(startEpoch)}`, 'info');
    addLog(`To      : ${epochToIST(endEpoch)}`, 'info');
    addLog(`Workers : ${CONCURRENCY} parallel`, 'info');
    addLog('-'.repeat(52), 'divider');

    const startT = Date.now();
    job.cursor = startEpoch;

    while (job.cursor > endEpoch && job.status === 'running') {
        const batchSize = Math.min(CONCURRENCY, job.cursor - endEpoch);
        const ids = Array.from({ length: batchSize }, (_, i) => String(job.cursor - i));
        const results = await Promise.all(ids.map(checkPdf));

        for (const r of results) {
            job.checked++;
            if (r.hit) {
                job.found.push(r);
                const sz = r.size > 0 ? ` [${Math.round(r.size / 1024)}KB]` : '';
                addLog(`${r.known ? 'KNOWN' : 'NEW'}: ${r.id}.pdf  ${r.date}${sz}`, r.known ? 'known' : 'found');
                broadcast('hit', r);
            }
        }
        job.cursor -= batchSize;

        if (job.checked % 500 < CONCURRENCY || job.cursor <= endEpoch) {
            const elapsed = (Date.now() - startT) / 1000;
            const rate = Math.round(job.checked / elapsed);
            const remain = job.cursor - endEpoch;
            const eta = rate > 0 ? Math.round(remain / rate) : 0;
            const pct = Math.round(((startEpoch - job.cursor) / total) * 100);
            addLog(`[${pct}%  ${job.checked.toLocaleString()}/${total.toLocaleString()}  ${rate}/s  ETA:${fmtETA(eta)}]`, 'progress');
            broadcast('stats', { checked: job.checked, total, found: job.found.length, pct, rate, eta, cursor: job.cursor });
        }
    }

    const wasStopped = job.status === 'stopped';
    if (!wasStopped) job.status = 'done';
    addLog('-'.repeat(52), 'divider');
    addLog(wasStopped ? 'Scan STOPPED.' : 'Scan COMPLETE.', wasStopped ? 'warn' : 'success');
    addLog(`Checked : ${job.checked.toLocaleString()} IDs`, 'info');
    addLog(`Found   : ${job.found.length} PDF(s)`, 'info');

    if (!wasStopped && job.autoSend && CHAT_IDS.length > 0 && BOT_TOKEN) {
        addLog('Sending results to Telegram...', 'info');
        await sendScanResults(job.chatId);
        addLog('Results sent to Telegram.', 'success');
    }
    addLog('='.repeat(52), 'divider');
    broadcast('done', { found: job.found, checked: job.checked, stopped: wasStopped });
}

async function sendScanResults(chatId) {
    const { found, checked, windowLabel } = job;
    let msg = `<b>NESTS PDF Scan Complete</b>\n\nWindow  : ${windowLabel}\nChecked : ${checked.toLocaleString()} IDs\nFound   : <b>${found.length} PDF(s)</b>\n\n`;
    if (found.length === 0) {
        msg += 'No new PDFs in this time window.';
        const targets = new Set([chatId, ...CHAT_IDS]);
        await Promise.all([...targets].map(id => sendTg(id, msg)));
        return;
    }
    for (const p of found) {
        msg += `${p.known ? 'KNOWN' : 'NEW'} <code>${p.id}</code>\n`
            + `${p.date}\n`
            + (p.size > 0 ? `${Math.round(p.size / 1024)}KB\n` : '')
            + `<a href="${p.url}">Open PDF</a>\n\n`;
    }
    const targets = new Set([chatId, ...CHAT_IDS]);
    await Promise.all([...targets].map(id => sendTg(id, msg)));
    for (const p of found) {
        const cap = `<b>NESTS Notice</b>\n${p.date}\n${p.url}`;
        await Promise.all([...targets].map(id => sendPdfToChat(id, p.url, cap)));
    }
}

// ── Auto-seen tracker ──────────────────────────────────────────────────────
const autoSeenIds = new Set([...KNOWN_IDS]);

// ── Instant loop: checks every second ─────────────────────────────────────
async function instantLoop() {
    addLog('[AUTO] Instant scanner started', 'success');
    let lastCatchup = nowEpoch();
    while (true) {
        const loopStart = Date.now();
        const now = nowEpoch();

        // Check current second
        if (!autoSeenIds.has(String(now)) && job.status !== 'running') {
            autoSeenIds.add(String(now));
            const result = await checkPdf(String(now));
            addLog(`[${now}] ${epochToIST(now)} checking...`, 'progress');

            if (result.hit && !result.known) {
                const sz = result.size > 0 ? ` [${Math.round(result.size / 1024)}KB]` : '';
                addLog(`[INSTANT] NEW: ${result.id}.pdf  ${result.date}${sz}`, 'found');
                broadcast('hit', result);
                if (BOT_TOKEN && CHAT_IDS.length > 0) {
                    const alertMsg = `<b>NESTS New Notice Found!</b>\n\n<code>${result.id}</code>\n${result.date}\n${result.size > 0 ? Math.round(result.size / 1024) + 'KB\n' : ''}<a href="${result.url}">Open PDF</a>`;
                    await broadcastTg(alertMsg);
                    const cap = `<b>NESTS Notice</b>\n${result.date}\n${result.url}`;
                    await broadcastPdf(result.url, cap);
                    addLog(`[INSTANT] PDF sent to ${CHAT_IDS.length} chat(s)`, 'success');
                }
            } else if (result.hit && result.known) {
                addLog(`[INSTANT] ${result.id}.pdf - known`, 'known');
            }
        }

        // Every 10s: sweep past 10 IDs to catch anything missed
        if (now - lastCatchup >= 10 && job.status !== 'running') {
            lastCatchup = now;
            const missed = Array.from({ length: 10 }, (_, i) => String(now - i - 1)).filter(id => !autoSeenIds.has(id));
            if (missed.length > 0) {
                const results = await Promise.all(missed.map(checkPdf));
                missed.forEach(id => autoSeenIds.add(id));
                for (const r of results) {
                    if (r.hit && !r.known) {
                        addLog(`[CATCHUP] NEW: ${r.id}.pdf  ${r.date}`, 'found');
                        broadcast('hit', r);
                        if (BOT_TOKEN && CHAT_IDS.length > 0) {
                            await broadcastTg(`<b>NESTS New Notice Found!</b>\n\n<code>${r.id}</code>\n${r.date}\n<a href="${r.url}">Open PDF</a>`);
                            await broadcastPdf(r.url, `<b>NESTS Notice</b>\n${r.date}\n${r.url}`);
                            addLog(`[CATCHUP] PDF sent: ${r.id}.pdf`, 'success');
                        }
                    }
                }
            }
        }

        const elapsed = Date.now() - loopStart;
        await new Promise(r => setTimeout(r, Math.max(0, 1000 - elapsed)));
    }
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
    clients.add(res);
    res.write(`event: sync\ndata: ${JSON.stringify({ status: job.status, checked: job.checked, total: job.startEpoch - job.endEpoch || 0, found: job.found, log: job.log.slice(-200), cursor: job.cursor, pct: job.startEpoch > job.endEpoch ? Math.round(((job.startEpoch - job.cursor) / (job.startEpoch - job.endEpoch)) * 100) : 0, windowLabel: job.windowLabel })}\n\n`);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); clients.delete(res); } }, 25000);
    req.on('close', () => { clients.delete(res); clearInterval(hb); });
});

app.post('/start', (req, res) => {
    if (job.status === 'running') return res.json({ ok: false, error: 'Scan already running' });
    const { windowSecs, windowLabel, chatId, autoSend } = req.body;
    const now = nowEpoch();
    job = { status: 'running', windowSecs, windowLabel: windowLabel || `${windowSecs}s`, startEpoch: now, endEpoch: now - windowSecs, cursor: now, checked: 0, found: [], startedAt: now, autoSend: autoSend !== false, chatId: chatId || CHAT_ID, log: [] };
    broadcast('started', { windowLabel: job.windowLabel, total: windowSecs });
    runScan();
    res.json({ ok: true });
});

app.post('/stop', (req, res) => {
    if (job.status === 'running') { job.status = 'stopped'; addLog('Stop requested by user.', 'warn'); }
    res.json({ ok: true });
});

app.get('/status', (req, res) => res.json({ status: job.status, checked: job.checked, total: job.startEpoch - job.endEpoch || 0, found: job.found.length, windowLabel: job.windowLabel, pct: job.startEpoch > job.endEpoch ? Math.round(((job.startEpoch - job.cursor) / (job.startEpoch - job.endEpoch)) * 100) : 0 }));

app.post('/send', async (req, res) => {
    const chatId = req.body.chatId || CHAT_ID;
    if (!chatId) return res.json({ ok: false, error: 'No chat_id' });
    try { await sendScanResults(chatId); res.json({ ok: true }); }
    catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/known', (req, res) => res.json({ known: KNOWN }));

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body;
    if (update.message) {
        const chatId = update.message.chat.id;
        const text = (update.message.text || '').trim();
        if (text.startsWith('/start')) {
            await sendTg(chatId, `<b>NESTS PDF Scanner</b>\n\nScans NESTS exam notice PDFs (latest first).`,
                [[{ text: 'Open Live Scanner', web_app: { url: `https://${req.get('host')}/?cid=${chatId}` } }],
                [{ text: 'Known PDFs', callback_data: 'known' }, { text: 'Status', callback_data: 'status' }]]);
        } else if (text.startsWith('/status')) {
            await sendTg(chatId, `<b>Scanner Status</b>\n\nStatus  : ${job.status}\nWindow  : ${job.windowLabel || '-'}\nChecked : ${job.checked.toLocaleString()}\nFound   : ${job.found.length}\nProgress: ${job.startEpoch > job.endEpoch ? Math.round(((job.startEpoch - job.cursor) / (job.startEpoch - job.endEpoch)) * 100) : 0}%`);
        } else if (text.startsWith('/known')) {
            let msg = `<b>Known PDFs</b>\n\n`;
            KNOWN.forEach(k => msg += `<a href="${PDF_BASE}${k.id}.pdf">${k.id}</a>\n${k.date} - ${k.label}\n\n`);
            await sendTg(chatId, msg);
        }
    }
    if (update.callback_query) {
        const chatId = update.callback_query.from.id;
        if (update.callback_query.data === 'known') {
            let msg = `<b>Known PDFs</b>\n\n`;
            KNOWN.forEach(k => msg += `<a href="${PDF_BASE}${k.id}.pdf">${k.id}</a> - ${k.label}\n`);
            await sendTg(chatId, msg);
        } else if (update.callback_query.data === 'status') {
            await sendTg(chatId, `Status: <b>${job.status}</b> | Found: ${job.found.length} | Checked: ${job.checked}`);
        }
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: update.callback_query.id }) });
    }
});

app.post('/setup', async (req, res) => {
    const host = `${req.protocol}://${req.get('host')}`;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${host}/webhook`, drop_pending_updates: true }) });
    const result = await r.json();
    res.json({ ok: result.ok, webhook: `${host}/webhook` });
});

app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, () => console.log(`NESTS Scanner running on :${PORT}`));
setTimeout(instantLoop, 10 * 1000);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>NESTS PDF Scanner</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--text:#e6edf3;--hint:#7d8590;--green:#3fb950;--blue:#58a6ff;--amber:#d29922;--red:#f85149;--cyan:#79c0ff;--font:'SF Mono','Fira Code','Consolas',monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans)}
.app{display:flex;flex-direction:column;height:100vh;max-width:700px;margin:0 auto;padding:12px;gap:10px}
.hdr{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}
.hdr-title{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.status-dot{width:8px;height:8px;border-radius:50%;background:var(--hint);flex-shrink:0}
.status-dot.running{background:var(--green);animation:pulse 1s infinite}
.status-dot.done{background:var(--blue)}.status-dot.stopped{background:var(--red)}
.clock{font-size:11px;color:var(--hint);font-family:var(--font)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.win-row{display:flex;gap:5px;flex-wrap:wrap}
.win-btn{padding:5px 10px;border-radius:6px;border:1px solid #30363d;background:var(--bg2);color:var(--hint);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s;white-space:nowrap}
.win-btn.active{background:#1f6feb;color:#fff;border-color:#1f6feb}
.win-btn:hover:not(.active){border-color:var(--hint);color:var(--text)}
.custom-row{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid #30363d;border-radius:8px;padding:8px 12px}
.custom-lbl{font-size:11px;color:var(--hint);white-space:nowrap;min-width:54px}
.custom-val{font-size:12px;font-weight:700;color:var(--blue);white-space:nowrap;min-width:60px;text-align:right}
input[type=range]{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:#30363d;outline:none;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#1f6feb;cursor:pointer;border:2px solid #0d1117}
input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px}
.ctrl-row{display:flex;gap:8px}
.btn-start,.btn-stop{padding:9px 18px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s;white-space:nowrap}
.btn-start{background:#238636;color:#fff;flex:1}.btn-start:disabled{opacity:.45;cursor:not-allowed}
.btn-stop{background:#da3633;color:#fff}
.btn-send{background:#1d4ed8;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;display:none}
.stats-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.stat{background:var(--bg2);border-radius:8px;padding:8px 6px;text-align:center;border:1px solid #30363d}
.stat-val{font-size:17px;font-weight:700;font-family:var(--font)}.stat-lbl{font-size:10px;color:var(--hint);margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
.g{color:var(--green)}.b{color:var(--blue)}.a{color:var(--amber)}
.pbar-wrap{height:3px;background:#21262d;border-radius:2px;overflow:hidden}
.pbar{height:100%;background:#1f6feb;width:0%;transition:width .3s;border-radius:2px}.pbar.done{background:var(--green)}
.terminal{flex:1;background:#010409;border-radius:10px;border:1px solid #30363d;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.term-titlebar{background:var(--bg2);padding:8px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #30363d;flex-shrink:0}
.term-dots{display:flex;gap:5px}.term-dot{width:10px;height:10px;border-radius:50%}
.term-lines{flex:1;overflow-y:auto;padding:10px 12px;font-family:var(--font);font-size:12px;line-height:1.6;scroll-behavior:smooth}
.term-lines::-webkit-scrollbar{width:4px}.term-lines::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.tl{display:flex;gap:8px;animation:fadeIn .15s ease}.tl-ts{color:#484f58;flex-shrink:0;user-select:none}.tl-text{word-break:break-all}
.tl.info .tl-text{color:var(--text)}.tl.progress .tl-text{color:var(--hint)}
.tl.found .tl-text{color:var(--green);font-weight:600}.tl.known .tl-text{color:var(--amber)}
.tl.warn .tl-text{color:var(--amber)}.tl.success .tl-text{color:var(--cyan);font-weight:600}
.tl.error .tl-text{color:var(--red)}.tl.divider .tl-text{color:#30363d}
.cursor-blink{display:inline-block;width:7px;height:13px;background:var(--green);animation:blink 1s step-end infinite;vertical-align:text-bottom;margin-left:3px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.found-section{display:none}.found-section.show{display:block}
.found-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:6px}
.found-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto}
.pdf-card{background:var(--bg2);border-radius:8px;padding:10px 12px;border-left:3px solid var(--green)}
.pdf-card.known{border-left-color:var(--amber)}.pdf-tag{font-size:10px;font-weight:700;color:var(--green)}
.pdf-card.known .pdf-tag{color:var(--amber)}.pdf-id{font-family:var(--font);font-size:12px;margin:2px 0}
.pdf-date{font-size:11px;color:var(--hint)}.pdf-link{color:var(--blue);font-size:11px;text-decoration:none;display:inline-block;margin-top:3px}
.autosend-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--hint)}
.toggle{position:relative;display:inline-block;width:32px;height:18px;cursor:pointer}.toggle input{display:none}
.slider{position:absolute;inset:0;background:#21262d;border-radius:10px;transition:.2s}
.slider:before{content:'';position:absolute;width:12px;height:12px;left:3px;top:3px;background:var(--hint);border-radius:50%;transition:.2s}
input:checked+.slider{background:#238636}input:checked+.slider:before{transform:translateX(14px);background:#fff}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(10px);background:#1c2128;border:1px solid #30363d;color:var(--text);padding:9px 18px;border-radius:20px;font-size:12px;z-index:999;opacity:0;transition:all .25s;pointer-events:none;white-space:nowrap}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:400px){.stats-bar{grid-template-columns:repeat(2,1fr)}.hdr-title{font-size:14px}}
</style>
</head>
<body>
<div class="app">
  <div class="hdr">
    <div class="hdr-title"><div class="status-dot" id="statusDot"></div>NESTS PDF Scanner</div>
    <div class="clock" id="clock">-</div>
  </div>
  <div class="win-row" id="winRow">
    <div class="win-btn" data-s="300" data-l="5 min">5 min</div>
    <div class="win-btn" data-s="1800" data-l="30 min">30 min</div>
    <div class="win-btn" data-s="3600" data-l="1 hr">1 hr</div>
    <div class="win-btn" data-s="7200" data-l="2 hours">2 hr</div>
    <div class="win-btn" data-s="21600" data-l="6 hours">6 hr</div>
    <div class="win-btn active" data-s="86400" data-l="1 day">1 day</div>
    <div class="win-btn" data-s="259200" data-l="3 days">3 days</div>
    <div class="win-btn" data-s="604800" data-l="7 days">7 days</div>
  </div>
  <div class="custom-row">
    <span class="custom-lbl">Custom</span>
    <input type="range" id="customSlider" min="1" max="1000" value="500">
    <span class="custom-val" id="customVal">1 day</span>
  </div>
  <div class="ctrl-row">
    <button class="btn-start" id="startBtn" onclick="startScan()">Start Scan</button>
    <button class="btn-stop" id="stopBtn" onclick="stopScan()">Stop</button>
  </div>
  <div class="stats-bar">
    <div class="stat"><div class="stat-val b" id="sChecked">-</div><div class="stat-lbl">Checked</div></div>
    <div class="stat"><div class="stat-val g" id="sFound">-</div><div class="stat-lbl">Found</div></div>
    <div class="stat"><div class="stat-val a" id="sRate">-</div><div class="stat-lbl">Req/s</div></div>
    <div class="stat"><div class="stat-val" id="sETA">-</div><div class="stat-lbl">ETA</div></div>
  </div>
  <div class="pbar-wrap"><div class="pbar" id="pbar"></div></div>
  <div class="terminal">
    <div class="term-titlebar">
      <div class="term-dots">
        <div class="term-dot" style="background:#ff5f57"></div>
        <div class="term-dot" style="background:#ffbd2e"></div>
        <div class="term-dot" style="background:#28c840"></div>
      </div>
      <span style="font-size:11px;color:var(--hint);font-family:var(--font)">nests-scanner</span>
    </div>
    <div class="term-lines" id="termLines">
      <div class="tl info"><span class="tl-ts">--:--:--</span><span class="tl-text">Ready.<span class="cursor-blink" id="cursor"></span></span></div>
    </div>
  </div>
  <div class="found-section" id="foundSection">
    <div class="found-title" id="foundTitle">Found PDFs</div>
    <div class="found-list" id="foundList"></div>
  </div>
  <div class="autosend-row">
    <button class="btn-send" id="sendBtn" onclick="sendToTelegram()">Send to Telegram</button>
    <label class="toggle"><input type="checkbox" id="autoSend" checked><div class="slider"></div></label>
    Auto-send on complete
    <span id="chatLabel" style="margin-left:auto;font-size:11px;color:var(--hint)"></span>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
var up = new URLSearchParams(location.search);
var CHAT_ID = up.get('cid') || (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || '';
if (CHAT_ID) document.getElementById('chatLabel').textContent = 'Chat: ' + CHAT_ID;
var windowSecs=86400, windowLabel='1 day', scanning=false, evtSrc=null;
function epochToIST(ts){var d=new Date((Number(ts)+19800)*1000),p=function(n){return String(n).padStart(2,'0')};return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+':'+p(d.getUTCSeconds())+' IST';}
setInterval(function(){document.getElementById('clock').textContent=epochToIST(Math.floor(Date.now()/1000));},1000);
// Preset buttons
document.getElementById('winRow').addEventListener('click',function(e){var btn=e.target.closest('.win-btn');if(!btn||scanning)return;document.querySelectorAll('.win-btn').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');windowSecs=parseInt(btn.dataset.s);windowLabel=btn.dataset.l;syncSliderToSecs(windowSecs);});
// Custom slider — log scale: slider 1-1000 maps to 60s – 604800s (1min – 7days)
function sliderToSecs(v){var mn=Math.log(60),mx=Math.log(604800);return Math.round(Math.exp(mn+(mx-mn)*(v-1)/999));}
function secsToSlider(s){var mn=Math.log(60),mx=Math.log(604800);return Math.round(1+(Math.log(Math.max(60,Math.min(604800,s)))-mn)/(mx-mn)*999);}
function secsToLabel(s){if(s<120)return s+'s';if(s<3600)return Math.round(s/60)+'m';if(s<86400){var h=Math.floor(s/3600),m=Math.round((s%3600)/60);return h+'h'+(m?m+'m':'');}var d=Math.floor(s/86400),h2=Math.round((s%86400)/3600);return d+'d'+(h2?h2+'h':'');}
function syncSliderToSecs(s){document.getElementById('customSlider').value=secsToSlider(s);document.getElementById('customVal').textContent=secsToLabel(s);}
syncSliderToSecs(86400);
document.getElementById('customSlider').addEventListener('input',function(){if(scanning)return;var s=sliderToSecs(parseInt(this.value));windowSecs=s;windowLabel=secsToLabel(s);document.getElementById('customVal').textContent=windowLabel;document.querySelectorAll('.win-btn').forEach(function(b){b.classList.remove('active');});});
document.getElementById('customSlider').addEventListener('touchstart',function(){},{passive:true});
var termEl=document.getElementById('termLines'),cursorEl=document.getElementById('cursor'),autoScroll=true;
termEl.addEventListener('scroll',function(){autoScroll=termEl.scrollTop+termEl.clientHeight>=termEl.scrollHeight-20;});
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function addLine(text,type,ts){if(cursorEl)cursorEl.remove();var div=document.createElement('div');div.className='tl '+(type||'info');var time=ts||new Date().toTimeString().slice(0,8);div.innerHTML='<span class="tl-ts">'+time+'</span><span class="tl-text">'+escHtml(text)+'</span>';termEl.appendChild(div);if(autoScroll)termEl.scrollTop=termEl.scrollHeight;}
function appendCursor(){var last=termEl.lastElementChild&&termEl.lastElementChild.querySelector('.tl-text');if(last){var c=document.createElement('span');c.className='cursor-blink';c.id='cursor';last.appendChild(c);}}
function connectSSE(){if(evtSrc)evtSrc.close();evtSrc=new EventSource('/sse');
evtSrc.addEventListener('sync',function(e){var d=JSON.parse(e.data);if(d.log&&d.log.length>0){termEl.innerHTML='';d.log.forEach(function(l){addLine(l.text,l.type,l.ts);});}setStatus(d.status);if(d.found)d.found.forEach(addPdfCard);updateStats({checked:d.checked,total:d.total,found:(d.found&&d.found.length)||0,pct:d.pct});if(d.status==='running'){setScanning(true);}else if(d.status==='done'||d.status==='stopped'){setScanning(false);showSendBtn(true);}appendCursor();});
evtSrc.addEventListener('log',function(e){var l=JSON.parse(e.data);addLine(l.text,l.type,l.ts);appendCursor();});
evtSrc.addEventListener('stats',function(e){updateStats(JSON.parse(e.data));});
evtSrc.addEventListener('hit',function(e){addPdfCard(JSON.parse(e.data));});
evtSrc.addEventListener('started',function(){setScanning(true);setStatus('running');document.getElementById('foundList').innerHTML='';document.getElementById('foundSection').classList.remove('show');});
evtSrc.addEventListener('done',function(){setScanning(false);setStatus('done');showSendBtn(true);});
evtSrc.onerror=function(){setTimeout(connectSSE,2000);};}
connectSSE();
async function startScan(){var r=await fetch('/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({windowSecs:windowSecs,windowLabel:windowLabel,chatId:CHAT_ID,autoSend:document.getElementById('autoSend').checked})});var d=await r.json();if(!d.ok)showToast('Error: '+d.error);}
async function stopScan(){await fetch('/stop',{method:'POST'});setStatus('stopped');}
function setScanning(on){scanning=on;document.getElementById('startBtn').disabled=on;document.querySelectorAll('.win-btn').forEach(function(b){b.style.pointerEvents=on?'none':'';});showSendBtn(!on&&document.getElementById('foundList').children.length>0);}
function setStatus(s){document.getElementById('statusDot').className='status-dot '+(s==='running'?'running':s==='done'?'done':s==='stopped'?'stopped':'');}
function updateStats(o){if(o.checked!==undefined)document.getElementById('sChecked').textContent=o.checked.toLocaleString();if(o.found!==undefined)document.getElementById('sFound').textContent=o.found;if(o.rate!==undefined)document.getElementById('sRate').textContent=o.rate+'/s';if(o.eta!==undefined)document.getElementById('sETA').textContent=fmtETA(o.eta);if(o.pct!==undefined){document.getElementById('pbar').style.width=o.pct+'%';if(o.pct>=100)document.getElementById('pbar').classList.add('done');}}
function fmtETA(s){if(!s||s<=0)return'-';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m'+String(s%60).padStart(2,'0')+'s';return Math.floor(s/3600)+'h'+String(Math.floor((s%3600)/60)).padStart(2,'0')+'m';}
function addPdfCard(pdf){document.getElementById('foundSection').classList.add('show');var div=document.createElement('div');div.className='pdf-card'+(pdf.known?' known':'');var sz=pdf.size>0?' - '+Math.round(pdf.size/1024)+'KB':'';div.innerHTML='<div class="pdf-tag">'+(pdf.known?'KNOWN':'NEW FIND')+'</div><div class="pdf-id">'+pdf.id+'</div><div class="pdf-date">'+pdf.date+sz+'</div><a class="pdf-link" href="'+pdf.url+'" target="_blank">Open PDF</a>';document.getElementById('foundList').prepend(div);var n=document.getElementById('foundList').children.length;document.getElementById('foundTitle').textContent='Found '+n+' PDF'+(n!==1?'s':'');}
function showSendBtn(show){document.getElementById('sendBtn').style.display=show?'inline-block':'none';}
async function sendToTelegram(){var btn=document.getElementById('sendBtn');btn.disabled=true;btn.textContent='Sending...';try{var r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId:CHAT_ID})});var d=await r.json();showToast(d.ok?'Sent!':'Error: '+(d.error||'?'));}catch(e){showToast('Network error');}btn.disabled=false;btn.textContent='Send to Telegram';}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},3000);}
<\/script>
</body>
</html>`;
