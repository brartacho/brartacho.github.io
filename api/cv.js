// Dispatcher único de endpoints públicos de CV (consolidado para reduzir
// contagem de Vercel Functions: download + request-by-email em 1 só).
import { createHash } from 'crypto';
import { getSupabase, BUCKET } from './_lib/supabase.js';
import { notifyDownload } from './_lib/notify.js';
import { normalizeFileName } from './_lib/filename.js';
import { sendEmail } from './_lib/email.js';
import { checkRateLimit, clientIp } from './_lib/rate-limit.js';

// ─── DOWNLOAD ────────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

async function handleDownload(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Allow', 'GET');
        return res.status(204).end();
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { t: rawToken } = req.query;
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 10) {
        return res.status(400).json({ error: 'Token inválido' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    let supabase;
    try { supabase = getSupabase(); }
    catch { return res.status(503).json({ error: 'Serviço temporariamente indisponível.' }); }

    const { data: rl } = await supabase
        .from('rate_limits')
        .select('attempts, window_start')
        .eq('ip_address', ip)
        .single();

    if (rl) {
        const windowAge = Date.now() - new Date(rl.window_start).getTime();
        if (windowAge < RATE_LIMIT_WINDOW_MS && rl.attempts >= RATE_LIMIT_MAX) {
            return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
        }
        if (windowAge >= RATE_LIMIT_WINDOW_MS) {
            await supabase.from('rate_limits').update({ attempts: 1, window_start: new Date().toISOString() }).eq('ip_address', ip);
        } else {
            await supabase.from('rate_limits').update({ attempts: rl.attempts + 1 }).eq('ip_address', ip);
        }
    } else {
        await supabase.from('rate_limits').insert({ ip_address: ip, attempts: 1, window_start: new Date().toISOString() });
    }

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const { data: token, error: tokenErr } = await supabase
        .from('download_tokens')
        .select('id, cv_version_id, label, expires_at, max_uses, use_count, revoked, cv_versions(name, file_path, file_name)')
        .eq('token_hash', tokenHash)
        .single();

    if (tokenErr || !token) return res.status(404).json({ error: 'Link inválido ou não encontrado.' });
    if (token.revoked) return res.status(410).json({ error: 'Este link foi revogado.' });
    if (new Date(token.expires_at) < new Date()) return res.status(410).json({ error: 'Este link expirou.' });
    if (token.max_uses !== null && token.use_count >= token.max_uses) {
        return res.status(410).json({ error: 'Este link já atingiu o número máximo de usos.' });
    }

    const cv = token.cv_versions;
    if (!cv) return res.status(500).json({ error: 'Currículo não encontrado.' });

    const { error: updateErr } = await supabase
        .from('download_tokens')
        .update({ use_count: token.use_count + 1 })
        .eq('id', token.id)
        .lte('use_count', token.max_uses !== null ? token.max_uses - 1 : 999999);

    if (updateErr) return res.status(410).json({ error: 'Este link já atingiu o número máximo de usos.' });

    await supabase.from('download_logs').insert({
        token_id: token.id,
        cv_version_id: token.cv_version_id,
        cv_name_snapshot: cv.name,
        cv_id_snapshot: token.cv_version_id,
        ip_address: ip,
        user_agent: req.headers['user-agent'] || '',
    });

    const { data: fileData, error: fileErr } = await supabase
        .storage
        .from(BUCKET())
        .download(cv.file_path);

    if (fileErr || !fileData) return res.status(500).json({ error: 'Erro ao buscar o arquivo.' });

    notifyDownload({
        label: token.label,
        cvName: cv.name,
        ip,
        useCount: token.use_count + 1,
        maxUses: token.max_uses,
        expiresAt: token.expires_at,
    }).catch(() => {});

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const safeFileName = normalizeFileName(cv.file_name);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(buffer);
}

// ─── REQUEST BY EMAIL ────────────────────────────────────────────────────────
const LIMITS = {
    name:    { min: 2,  max: 100 },
    company: { min: 2,  max: 100 },
    role:    { min: 2,  max: 100 },
    email:   { min: 5,  max: 120 },
    message: { min: 10, max: 1000 },
};
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const CONTROL_CHARS   = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const INVISIBLE_CHARS = new RegExp('[\\u200B-\\u200D\\u202A-\\u202E\\u2060\\uFEFF]', 'g');

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '').trim();
}

async function handleRequestByEmail(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const rl = await checkRateLimit({ req, scope: 'cv-request', max: 3, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
        res.setHeader('Retry-After', rl.retryAfterSec);
        return res.status(429).json({ error: `Muitas solicitações. Aguarde ${Math.ceil(rl.retryAfterSec / 60)} minuto(s).` });
    }

    const body = req.body || {};
    if (body.website) return res.status(200).json({ message: 'Solicitação recebida.' });

    const name    = sanitizeText(body.name);
    const company = sanitizeText(body.company);
    const role    = sanitizeText(body.role);
    const email   = sanitizeText(body.email).toLowerCase();
    const message = sanitizeText(body.message);

    const errors = [];
    if (name.length    < LIMITS.name.min    || name.length    > LIMITS.name.max)    errors.push(`Nome inválido (${LIMITS.name.min}-${LIMITS.name.max} chars).`);
    if (company.length < LIMITS.company.min || company.length > LIMITS.company.max) errors.push('Informe o nome da empresa.');
    if (role.length    < LIMITS.role.min    || role.length    > LIMITS.role.max)    errors.push('Informe o cargo da vaga.');
    if (email.length   < LIMITS.email.min   || email.length   > LIMITS.email.max || !EMAIL_RE.test(email)) errors.push('Email inválido.');
    if (message.length < LIMITS.message.min || message.length > LIMITS.message.max) errors.push(`Mensagem inválida (${LIMITS.message.min}-${LIMITS.message.max} chars).`);
    if (/[\r\n]/.test(email) || /[\r\n]/.test(name) || /[\r\n]/.test(company) || /[\r\n]/.test(role)) errors.push('Caracteres inválidos.');

    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const ip = clientIp(req);
    const ua = (req.headers['user-agent'] || '').slice(0, 200);
    const ts = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const baseUrl = process.env.PUBLIC_SHARE_URL || process.env.NEXT_PUBLIC_BASE_URL || 'https://artacho.dev';
    const adminParams = new URLSearchParams({
        to_name: name,
        to_email: email,
        ...(company ? { to_company: company } : {}),
        ...(role    ? { to_role: role }       : {}),
    }).toString();
    const adminReplyUrl = `${baseUrl}/admin?${adminParams}`;

    const text = [
        '═══ Nova solicitação de CV ═══',
        '',
        `Nome:    ${name}`,
        `Empresa: ${company || '—'}`,
        `Cargo:   ${role || '—'}`,
        `Email:   ${email}`,
        '',
        'Mensagem:',
        message,
        '',
        '─────────────────────────────',
        `Responder no painel admin (já pré-preenchido):`,
        adminReplyUrl,
        '',
        `IP: ${ip}`,
        `UA: ${ua}`,
        `Quando: ${ts}`,
    ].join('\n');

    const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #0f172a; margin-bottom: 16px;">📩 Nova solicitação de CV</h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr><td style="padding: 6px 0; color: #64748b; width: 90px;">Nome</td><td style="padding: 6px 0; color: #0f172a;"><strong>${escHtml(name)}</strong></td></tr>
                <tr><td style="padding: 6px 0; color: #64748b;">Empresa</td><td style="padding: 6px 0; color: #0f172a;">${escHtml(company || '—')}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b;">Cargo</td><td style="padding: 6px 0; color: #0f172a;">${escHtml(role || '—')}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b;">Email</td><td style="padding: 6px 0;"><a href="mailto:${escHtml(email)}" style="color: #0891b2;">${escHtml(email)}</a></td></tr>
            </table>
            <h3 style="color: #0f172a; margin: 24px 0 8px; font-size: 14px;">Mensagem</h3>
            <div style="background: #f1f5f9; border-left: 3px solid #22d3ee; padding: 14px 16px; border-radius: 6px; color: #334155; font-size: 14px; line-height: 1.55; white-space: pre-wrap;">${escHtml(message)}</div>

            <div style="margin: 28px 0 8px; text-align: center;">
                <a href="${escHtml(adminReplyUrl)}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">
                    📨 Abrir no painel para responder
                </a>
            </div>
            <p style="color: #64748b; font-size: 12px; text-align: center; margin-top: 8px;">
                Já com o destinatário pré-preenchido — escolhe a versão e envia.
            </p>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            <p style="color: #94a3b8; font-size: 12px; line-height: 1.5;">
                IP: <code>${escHtml(ip)}</code><br>
                User-Agent: <code>${escHtml(ua)}</code><br>
                ${escHtml(ts)}
            </p>
        </div>
    `;

    try {
        await sendEmail({
            to: process.env.NOTIFY_EMAIL,
            subject: `[CV] ${name}${company ? ' · ' + company : ''}${role ? ' · ' + role : ''}`,
            text,
            html,
        });
    } catch (e) {
        if (e.code === 'EMAIL_NOT_CONFIGURED') {
            return res.status(503).json({ error: 'Envio de email indisponível no momento. Tente pelo WhatsApp.' });
        }
        return res.status(500).json({ error: 'Falha ao enviar. Tente novamente em alguns minutos.' });
    }

    return res.status(200).json({ message: 'Solicitação enviada! Vou te responder em poucas horas no email informado.' });
}

// ─── TRACK ───────────────────────────────────────────────────────────────────
const ALLOWED_EVENTS = new Set([
    'pageview', 'cv_download_click', 'email_request',
    'contact_click', 'case_open', 'engaged', 'demo_access',
    'project_click', 'admin_lock_click',
    'scroll_depth', 'time_on_page', 'outbound_click',
    'print_attempt', 'cv_view',
]);
const BOT_RE = /bot|crawl|spider|preview|slack|telegram|whatsapp|facebook|twitter|linkedinbot|google-structured|bytespider|headless|puppet|playwright|cypress/i;
const RL_MAP = new Map();
const RL_WINDOW_MS = 60_000;
const RL_MAX = 60;
function trackRateLimit(hash) {
    const now = Date.now();
    const e = RL_MAP.get(hash);
    if (!e || now - e.start > RL_WINDOW_MS) { RL_MAP.set(hash, { start: now, count: 1 }); return true; }
    if (e.count >= RL_MAX) return false;
    e.count++;
    return true;
}
function parseDevice(ua) {
    if (!ua) return { device: 'unknown', browser: 'unknown', os: 'unknown' };
    const device = /Mobile|Android.*Mobile|iPhone|Windows Phone/i.test(ua) ? 'mobile' : /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : 'desktop';
    const browser = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Firefox\//i.test(ua) ? 'Firefox' : /SamsungBrowser\//i.test(ua) ? 'Samsung' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : 'Other';
    const os = /Windows NT/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Linux/i.test(ua) ? 'Linux' : 'Other';
    return { device, browser, os };
}
function parseReferrerHost(referrer) {
    if (!referrer) return null;
    try { const { hostname } = new URL(referrer); return hostname.replace(/^www\./, '') || null; }
    catch { return null; }
}

async function handleTrack(req, res) {
    if (req.method === 'GET') {
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret && req.headers['authorization'] !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const supabase = getSupabase();
        const cutoff365 = new Date(Date.now() - 365 * 86400000).toISOString();
        const cutoff730 = new Date(Date.now() - 730 * 86400000).toISOString();
        const [pingRes, cleanEventsRes, cleanLogsRes] = await Promise.allSettled([
            supabase.from('site_events').select('id', { count: 'exact', head: true }).gte('occurred_at', new Date(Date.now() - 86400000).toISOString()),
            supabase.from('site_events').delete({ count: 'exact' }).lt('occurred_at', cutoff365),
            supabase.from('download_logs').delete({ count: 'exact' }).lt('downloaded_at', cutoff730),
        ]);
        return res.status(200).json({
            ok: true, ts: new Date().toISOString(),
            events_24h:     pingRes.status       === 'fulfilled' ? (pingRes.value.count       ?? 0) : null,
            cleaned_events: cleanEventsRes.status === 'fulfilled' ? (cleanEventsRes.value.count ?? 0) : null,
            cleaned_logs:   cleanLogsRes.status   === 'fulfilled' ? (cleanLogsRes.value.count   ?? 0) : null,
        });
    }
    res.setHeader('Access-Control-Allow-Origin', 'https://artacho.dev');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).end();
    const ua = req.headers['user-agent'] || '';
    if (!ua || BOT_RE.test(ua)) return res.status(204).end();
    const body = req.body || {};
    const { event, path, referrer, utm_source, utm_medium, utm_campaign, meta, session_id, time_on_page_ms, scroll_max_pct } = body;
    if (!ALLOWED_EVENTS.has(event)) return res.status(400).end();
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const country = req.headers['x-vercel-ip-country'] || null;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const salt = (process.env.ANALYTICS_SALT || 'dev-salt') + today;
    const visitor_id_hash = createHash('sha256').update(ip + ua + salt).digest('hex');
    if (!trackRateLimit(visitor_id_hash)) return res.status(429).end();
    const { device, browser, os } = parseDevice(ua);
    const referrer_host = parseReferrerHost(referrer);
    try {
        const supabase = getSupabase();
        const top = Number.isFinite(Number(time_on_page_ms)) ? Math.max(0, Math.min(Math.floor(Number(time_on_page_ms)), 86_400_000)) : null;
        const smp = Number.isFinite(Number(scroll_max_pct)) ? Math.max(0, Math.min(Math.floor(Number(scroll_max_pct)), 100)) : null;
        const sid = typeof session_id === 'string' && /^[a-zA-Z0-9\-_]{8,64}$/.test(session_id) ? session_id : null;
        await supabase.from('site_events').insert({
            event, path: path ? String(path).slice(0, 500) : null,
            visitor_id_hash, referrer_host,
            utm_source: utm_source ? String(utm_source).slice(0, 200) : null,
            utm_medium: utm_medium ? String(utm_medium).slice(0, 200) : null,
            utm_campaign: utm_campaign ? String(utm_campaign).slice(0, 200) : null,
            device, browser, os, country,
            meta: meta && typeof meta === 'object' ? meta : null,
            session_id: sid, time_on_page_ms: top, scroll_max_pct: smp,
        });
    } catch { /* tracking nunca quebra o site */ }
    return res.status(204).end();
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    const action = req.query.action || '';
    if (action === 'download')         return handleDownload(req, res);
    if (action === 'request-by-email') return handleRequestByEmail(req, res);
    if (action === 'track')            return handleTrack(req, res);
    return res.status(404).json({ error: 'Action not found' });
}
