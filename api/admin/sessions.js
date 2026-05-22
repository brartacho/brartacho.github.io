import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { cors, requireAdmin } from '../_lib/auth.js';
import { getSupabase } from '../_lib/supabase.js';
import { parseCookies, serializeSessionCookie } from '../_lib/cookies.js';
import { clientIp } from '../_lib/rate-limit.js';

const CLEAR_COOKIE = 'admin_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h hard limit
const REFRESH_THRESHOLD_SEC = 15 * 60;           // renovar se TTL < 15min

async function handleLogout(req, res) {
    const cookies = parseCookies(req);
    const token = cookies['admin_session'];
    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
            if (decoded.jti) {
                const supabase = getSupabase();
                await supabase.from('admin_sessions').update({
                    revoked_at: new Date().toISOString(),
                    revoke_reason: 'logout',
                }).eq('jti', decoded.jti);
            }
        } catch { /* token inválido — limpa o cookie de qualquer forma */ }
    }
    res.setHeader('Set-Cookie', CLEAR_COOKIE);
    return res.status(200).json({ ok: true });
}

async function handleRefresh(req, res) {
    const cookies = parseCookies(req);
    const token = cookies['admin_session'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Token inválido ou expirado' });
    }

    if (!decoded.jti) return res.status(204).end(); // service token — sem refresh

    let supabase;
    try { supabase = getSupabase(); } catch {
        return res.status(503).json({ error: 'Serviço indisponível' });
    }

    const { data: session } = await supabase
        .from('admin_sessions')
        .select('created_at, revoked_at')
        .eq('jti', decoded.jti)
        .maybeSingle();

    if (!session || session.revoked_at) {
        return res.status(401).json({ error: 'Sessão inválida' });
    }

    // Hard limit 24h a partir do login original
    const age = Date.now() - new Date(session.created_at).getTime();
    if (age > SESSION_MAX_AGE_MS) {
        await supabase.from('admin_sessions').update({
            revoked_at: new Date().toISOString(),
            revoke_reason: 'max_age_exceeded',
        }).eq('jti', decoded.jti);
        res.setHeader('Set-Cookie', CLEAR_COOKIE);
        return res.status(401).json({ error: 'Sessão expirou (24h). Faça login novamente.' });
    }

    // Só renova se TTL restante < 15min
    const ttlRemainingSec = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttlRemainingSec > REFRESH_THRESHOLD_SEC) {
        return res.status(204).end(); // ainda tem tempo — sem nova cookie
    }

    const newJti = randomUUID();
    const newToken = jwt.sign(
        { role: 'admin', jti: newJti, dfp: decoded.dfp },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    await Promise.all([
        supabase.from('admin_sessions').update({
            revoked_at: new Date().toISOString(),
            revoke_reason: 'refresh',
        }).eq('jti', decoded.jti),
        supabase.from('admin_sessions').insert({
            jti: newJti,
            device_fingerprint: decoded.dfp || '',
            ip_address: clientIp(req),
            user_agent: (req.headers['user-agent'] || '').slice(0, 500),
            country_code: req.headers['cf-ipcountry'] || null,
            created_at: session.created_at, // herda criação original — 24h é absoluto
        }),
    ]);

    // Cleanup fire-and-forget: remove rotações de refresh com mais de 24h
    supabase.from('admin_sessions')
        .delete()
        .eq('revoke_reason', 'refresh')
        .lt('revoked_at', new Date(Date.now() - 86_400_000).toISOString())
        .then(() => {});

    res.setHeader('Set-Cookie', serializeSessionCookie(newToken));
    return res.status(200).json({ ok: true });
}

async function listSessions(req, res) {
    const cookies = parseCookies(req);
    const token = cookies['admin_session'];
    const decoded = token ? jwt.decode(token) : null;
    const currentJti = decoded?.jti ?? null;

    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('admin_sessions')
        .select('jti, ip_address, user_agent, country_code, created_at, last_seen_at, revoked_at, revoke_reason')
        .not('revoke_reason', 'eq', 'refresh')
        .order('last_seen_at', { ascending: false })
        .limit(50);
    if (error) return res.status(500).json({ error: error.message });

    const sessions = (data ?? []).map(s => ({
        ...s,
        is_current: s.jti === currentJti,
    }));
    return res.status(200).json(sessions);
}

async function revokeSession(req, res, jti) {
    const supabase = getSupabase();
    const { error } = await supabase.from('admin_sessions').update({
        revoked_at: new Date().toISOString(),
        revoke_reason: 'manual_revoke',
    }).eq('jti', jti).is('revoked_at', null);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    // Logout e refresh validam cookie internamente (não precisam de requireAdmin)
    if (req.method === 'DELETE' && !req.query.jti) return handleLogout(req, res);
    if (req.method === 'PATCH') return handleRefresh(req, res);

    if (!await requireAdmin(req, res)) return;

    if (req.method === 'GET') return listSessions(req, res);
    if (req.method === 'DELETE' && req.query.jti) return revokeSession(req, res, req.query.jti);

    return res.status(405).json({ error: 'Method not allowed' });
}
