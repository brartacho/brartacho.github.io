import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { cors } from '../_lib/auth.js';
import { serializeSessionCookie } from '../_lib/cookies.js';
import { getSupabase } from '../_lib/supabase.js';
import { checkLoginRateLimit, recordLoginFailure, clientIp } from '../_lib/rate-limit.js';
import { notifySecurityEvent } from '../_lib/notify.js';
import {
    checkContentType,
    checkPayloadSize,
    checkUserAgent,
    checkHoneypot,
    checkFillTime,
    verifyTurnstile,
} from '../_lib/bot-detection.js';

function computeDfp(req) {
    const ua = req.headers['user-agent'] || '';
    const lang = req.headers['accept-language'] || '';
    return createHash('sha256').update(`${ua}|${lang}`).digest('hex');
}

// Quantos dias olhar pra trás ao decidir se um IP é "novo"
const NEW_IP_LOOKBACK_DAYS = 30;

async function isIpNew(supabase, ip) {
    if (!ip) return false;
    try {
        const since = new Date(Date.now() - NEW_IP_LOOKBACK_DAYS * 86400_000).toISOString();
        const { data } = await supabase
            .from('admin_login_attempts')
            .select('id')
            .eq('ip_address', ip)
            .eq('success', true)
            .gte('created_at', since)
            .limit(1);
        return !data || data.length === 0;
    } catch { return false; }
}

const GENERIC_AUTH_ERROR = 'Usuário ou senha incorretos.';

function normalizeUsername(input) {
    if (typeof input !== 'string') return { email: '', phoneDigits: '' };
    const trimmed = input.trim();
    return {
        email: trimmed.toLowerCase(),
        phoneDigits: trimmed.replace(/\D/g, ''),
    };
}

function isUsernameValid(input) {
    if (!input) return false;
    const { email, phoneDigits } = normalizeUsername(input);
    const adminEmail = (process.env.ADMIN_EMAIL || process.env.NOTIFY_EMAIL || '').toLowerCase().trim();
    const adminPhone = (process.env.ADMIN_PHONE || '').replace(/\D/g, '');

    if (adminEmail && email && email === adminEmail) return true;
    if (adminPhone && phoneDigits && phoneDigits.length >= 10 && phoneDigits === adminPhone) return true;
    return false;
}

async function logAttempt(req, supabase, success, usernameHint) {
    try {
        const fwd = req.headers['x-forwarded-for'];
        const ip  = fwd ? fwd.split(',')[0].trim() : (req.headers['x-real-ip'] || null);
        const ua  = (req.headers['user-agent'] || '').slice(0, 300) || null;
        await supabase.from('admin_login_attempts').insert({
            ip_address:    ip,
            user_agent:    ua,
            success,
            username_hint: usernameHint ? String(usernameHint).slice(0, 4) : null,
        });
    } catch { /* fire-and-forget — nunca bloqueia o fluxo de auth */ }
}

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    // Config pública — roteado de /api/admin/config via rewrite
    if (req.query.__h === 'config') {
        if (req.method !== 'GET') return res.status(405).end();
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.json({ turnstile_sitekey: process.env.TURNSTILE_SITE_KEY || null });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Guards anti-bot (header-only, sem custo de DB). Falha = 401 genérico
    // (NÃO 403, pra não dar feedback útil sobre qual heurística pegou).
    const ctGuard = checkContentType(req);
    if (!ctGuard.ok) return res.status(401).json({ error: GENERIC_AUTH_ERROR });
    const sizeGuard = checkPayloadSize(req);
    if (!sizeGuard.ok) return res.status(413).json({ error: 'Payload muito grande.' });
    const uaGuard = checkUserAgent(req);
    if (!uaGuard.ok) return res.status(401).json({ error: GENERIC_AUTH_ERROR });

    // Rate limit em 2 janelas (burst 15min + diária 24h). Peek-only — só conta
    // falhas reais lá embaixo, então login bem-sucedido não consome slot.
    const rl = await checkLoginRateLimit(req);
    if (!rl.allowed) {
        // Alerta na PRIMEIRA bloqueada do burst (15min), não na diária (24h, baixo sinal)
        if (rl.scope === 'login') {
            notifySecurityEvent({
                kind: 'rate_limit_blocked',
                ip: clientIp(req),
                ua: req.headers['user-agent'],
                country: req.headers['cf-ipcountry'],
            }); // fire-and-forget
        }
        res.setHeader('Retry-After', rl.retryAfterSec);
        return res.status(429).json({ error: `Muitas tentativas. Aguarde ${Math.ceil(rl.retryAfterSec / 60)} minuto(s).` });
    }

    // Guards de corpo (honeypot + fillTime). Body só é parseado aqui.
    const hpGuard = checkHoneypot(req.body);
    const ftGuard = checkFillTime(req.body);
    if (!hpGuard.ok || !ftGuard.ok) {
        // Loga como tentativa falha pra ver padrões. Não revela qual guard pegou.
        // Conta como falha no rate limit (bots devem ser bloqueados igual).
        await recordLoginFailure(req);
        notifySecurityEvent({
            kind: 'bot_detected',
            ip: clientIp(req),
            ua: req.headers['user-agent'],
            country: req.headers['cf-ipcountry'],
            details: hpGuard.reason || ftGuard.reason,
        });
        try {
            const supabase = getSupabase();
            await logAttempt(req, supabase, false, (req.body && req.body.username) || 'bot');
        } catch { /* ignora */ }
        return res.status(401).json({ error: GENERIC_AUTH_ERROR });
    }

    // Validação Turnstile (cf_token enviado pelo widget na tela de login)
    const cfOk = await verifyTurnstile(req.body?.cf_token, clientIp(req));
    if (!cfOk) {
        await recordLoginFailure(req);
        return res.status(401).json({ error: GENERIC_AUTH_ERROR });
    }

    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });

    // Validação do usuário (email ou telefone). Erro genérico pra não revelar
    // qual dos dois está errado (mitiga enumeração de credenciais).
    const userOk = isUsernameValid(username);

    // Prefer DB-backed credentials (set via password reset). Fallback to env hash.
    let hash = null;
    const supabase = getSupabase();
    try {
        const { data } = await supabase
            .from('admin_credentials')
            .select('password_hash')
            .order('updated_at', { ascending: false })
            .limit(1)
            .single();
        if (data && data.password_hash) hash = data.password_hash;
    } catch {
        // Supabase indisponível ou tabela não existe — segue para env fallback
    }
    if (!hash) hash = process.env.ADMIN_PASSWORD_HASH;
    if (!hash) return res.status(500).json({ error: 'Configuração de autenticação ausente.' });

    // Sempre faz bcrypt.compare (mesmo se username inválido) pra evitar
    // timing attack que diferencia usuário válido vs inválido.
    const passOk = await bcrypt.compare(password, hash);

    if (!userOk || !passOk) {
        await recordLoginFailure(req);
        await logAttempt(req, supabase, false, username);
        return res.status(401).json({ error: GENERIC_AUTH_ERROR });
    }

    await logAttempt(req, supabase, true, username);

    // Alerta se for um IP nunca-visto antes (consulta últimos 30d de sucessos).
    // Fire-and-forget: não atrasa o login.
    const ip = clientIp(req);
    isIpNew(supabase, ip).then(isNew => {
        if (isNew) {
            notifySecurityEvent({
                kind: 'login_new_ip',
                ip,
                ua: req.headers['user-agent'],
                country: req.headers['cf-ipcountry'],
            });
        }
    }).catch(() => { /* swallow */ });

    const jti = randomUUID();
    const dfp = computeDfp(req);
    const token = jwt.sign(
        { role: 'admin', jti, dfp },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    try {
        await supabase.from('admin_sessions').insert({
            jti,
            device_fingerprint: dfp,
            ip_address: ip,
            user_agent: (req.headers['user-agent'] || '').slice(0, 500),
            country_code: req.headers['cf-ipcountry'] || null,
        });
    } catch { /* Supabase indisponível — degradação aceitável no login */ }

    res.setHeader('Set-Cookie', serializeSessionCookie(token));
    return res.status(200).json({ ok: true });
}
