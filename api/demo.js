import { randomBytes } from 'crypto';
import { getSessionId, getSupabaseDemo, cors, clean, hashIP, verifyTurnstile } from './demo/_lib/session.js';
import { checkRateLimit, clientIp } from './_lib/rate-limit.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeFileName(n) {
    return String(n || 'cv-demo.pdf').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100);
}
function genHash() { return randomBytes(6).toString('hex'); }

// Só aceita URLs http(s); bloqueia javascript:/data:/etc. em campos de link.
function safeHttpUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : null;
}

const VALID_MODALIDADE = new Set(['Presencial', 'Híbrida', 'Remota']);
const VALID_TIPO       = new Set(['CLT', 'PJ', 'Freelancer']);
const VALID_RESULTS    = new Set(['em_processo', 'aprovado', 'recusado']);

function sanitizeApp(body) {
    const out = {};
    if ('empresa'          in body) out.empresa          = clean(body.empresa, 200) || 'N/A';
    if ('vaga'             in body) out.vaga             = clean(body.vaga, 200);
    if ('linkedin_empresa' in body) out.linkedin_empresa = safeHttpUrl(clean(body.linkedin_empresa, 300));
    if ('link_vaga'        in body) out.link_vaga        = safeHttpUrl(clean(body.link_vaga, 500));
    if ('observacoes'      in body) out.observacoes      = clean(body.observacoes, 500);
    if ('gestor_nome'      in body) out.gestor_nome      = clean(body.gestor_nome, 100);
    if ('gestor_email'     in body) out.gestor_email     = clean(body.gestor_email, 120);
    if ('gestor_phone'     in body) out.gestor_phone     = clean(body.gestor_phone, 30);
    if ('modalidade'       in body) out.modalidade       = VALID_MODALIDADE.has(body.modalidade) ? body.modalidade : null;
    if ('tipo_contratacao' in body) out.tipo_contratacao = VALID_TIPO.has(body.tipo_contratacao) ? body.tipo_contratacao : null;
    if ('cv_version_id'    in body) out.cv_version_id    = body.cv_version_id || null;
    if ('result'           in body) out.result           = VALID_RESULTS.has(body.result) ? body.result : null;
    if ('archived'         in body) out.archived         = !!body.archived;
    if ('stages'           in body) out.stages           = Array.isArray(body.stages) ? body.stages.slice(0, 20) : null;
    if ('data_envio'       in body) out.data_envio       = body.data_envio || null;
    return out;
}

async function mutRateLimit(req, res) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
    const rl = await checkRateLimit({ req, scope: 'demo-mut', max: 60, windowMs: 60_000 });
    if (!rl.allowed) {
        res.setHeader('Retry-After', rl.retryAfterSec);
        res.status(429).json({ error: 'Muitas requisições. Aguarde.' });
        return false;
    }
    return true;
}

// ─── Resource handlers ───────────────────────────────────────────────────────

async function handleConfig(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({ turnstile_sitekey: process.env.TURNSTILE_SITE_KEY || null });
}

async function handleInit(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const session_id = getSessionId(req);
    if (!session_id) return res.status(400).json({ error: 'session_id inválido' });
    if (req.body?.website) return res.status(403).json({ error: 'forbidden' });

    const rl = await checkRateLimit({ req, scope: 'demo-init', max: 3, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
        res.setHeader('Retry-After', rl.retryAfterSec);
        return res.status(429).json({ error: 'Muitas tentativas. Aguarde antes de iniciar nova sessão demo.' });
    }
    const ip = clientIp(req);
    if (!await verifyTurnstile(req.body?.cf_token, ip)) {
        return res.status(403).json({ error: 'Verificação anti-bot falhou. Recarregue e tente novamente.' });
    }
    const { error } = await getSupabaseDemo().rpc('demo_seed', { p_session_id: session_id });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, session_id });
}

async function handleAuth(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    if (req.body?.website) return res.status(403).json({ error: 'forbidden' });

    const rl = await checkRateLimit({ req, scope: 'demo-auth', max: 10, windowMs: 15 * 60 * 1000 });
    if (!rl.allowed) {
        res.setHeader('Retry-After', rl.retryAfterSec);
        return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    }

    const { username, password } = req.body || {};
    const expectedUser = process.env.DEMO_ADMIN_USER;
    const expectedPass = process.env.DEMO_ADMIN_PASS;

    if (!expectedUser || !expectedPass) return res.status(503).json({ error: 'Demo não configurado.' });
    if (String(username) !== expectedUser || String(password) !== expectedPass) {
        return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const session_id = getSessionId(req);
    if (!session_id) return res.status(400).json({ error: 'session_id inválido' });
    const { error } = await getSupabaseDemo().rpc('demo_seed', { p_session_id: session_id });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
}

async function handleCleanup(req, res) {
    const auth = req.headers['authorization'];
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const supabase = getSupabaseDemo();
    const { data, error } = await supabase.rpc('demo_cleanup_expired');
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[demo:cleanup] deleted ${data} rows`);
    return res.json({ ok: true, deleted: data });
}

async function handleHealth(req, res) {
    const auth = req.headers['authorization'];
    if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const supabase = getSupabaseDemo();
    const { data: total, error } = await supabase.rpc('demo_total_rows');
    if (error) return res.status(500).json({ error: error.message });

    let action = 'ok', deleted = 0;
    if (total > 80000) {
        const { data: d } = await supabase.rpc('demo_full_wipe');
        deleted = d ?? 0; action = 'full_wipe';
        console.error(`[demo:health] PANIC total=${total} wiped ${deleted}`);
    } else if (total > 50000) {
        const { data: d } = await supabase.rpc('demo_emergency_cleanup');
        deleted = d ?? 0; action = 'emergency';
        console.error(`[demo:health] EMERGENCY total=${total} cleaned ${deleted}`);
    } else if (total > 30000) {
        action = 'warn';
        console.warn(`[demo:health] WARN total=${total}`);
    }
    return res.json({ ok: true, total, action, deleted, ts: new Date().toISOString() });
}

async function handleAnalytics(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    const session_id = getSessionId(req);
    if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });

    const period = Math.max(1, Math.min(365, parseInt(req.query.period) || 7));
    const scale = period / 7;
    const base = { pv: 247, uniq: 12, engaged: 86, cv: 18, dl: 11, rec: 8 };
    const kpis = {
        pageviews:          Math.round(base.pv   * scale),
        unique_visitors:    Math.round(base.uniq * scale),
        engaged_rate:       Math.round((base.engaged / base.pv) * 1000) / 10,
        cv_download_clicks: Math.round(base.cv   * scale),
        email_requests:     Math.round(2 * scale),
        contact_clicks:     Math.round(9 * scale),
        case_opens:         Math.round(15 * scale),
        cv_downloads:       Math.round(base.dl   * scale),
        conversion_rate:    Math.round((base.dl / base.pv) * 1000) / 10,
        recurring_visitors: Math.round(base.rec  * scale),
    };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const seed = [34, 51, 28, 67, 43, 89, 57, 41, 62, 38, 71, 49, 55, 83];
    const series = Array.from({ length: period }, (_, i) => {
        const d = new Date(today.getTime() - (period - 1 - i) * 86400000);
        const pv = seed[i % seed.length];
        return { bucket: d.toISOString().slice(0, 10), pageviews: pv, unique_visitors: Math.max(1, Math.round(pv * 0.18)) };
    });
    return res.json({
        kpis, series,
        top_pages: [
            { path: '/', count: Math.round(120 * scale) }, { path: '/cv', count: Math.round(45 * scale) },
            { path: '/case/qa', count: Math.round(28 * scale) }, { path: '/privacidade', count: Math.round(6 * scale) },
        ],
        top_referrers: [
            { host: 'linkedin.com', count: Math.round(68 * scale) }, { host: 'github.com', count: Math.round(34 * scale) },
            { host: 'google.com', count: Math.round(22 * scale) }, { host: '(direto)', count: Math.round(123 * scale) },
        ],
        utm_sources: [
            { source: 'linkedin', count: Math.round(45 * scale) }, { source: 'github', count: Math.round(18 * scale) },
            { source: 'email', count: Math.round(7 * scale) },
        ],
        devices: [
            { name: 'desktop', count: Math.round(178 * scale) }, { name: 'mobile', count: Math.round(59 * scale) }, { name: 'tablet', count: Math.round(10 * scale) },
        ],
        countries: [
            { name: 'BR', count: Math.round(231 * scale) }, { name: 'PT', count: Math.round(8 * scale) }, { name: 'US', count: Math.round(8 * scale) },
        ],
        latest_visits: [
            { occurred_at: new Date(Date.now() - 5  * 60000).toISOString(), browser: 'Chrome',  device: 'desktop', country: 'BR', host: 'linkedin.com', visitor_id_hash: 'a3f2b8c1', is_admin: false },
            { occurred_at: new Date(Date.now() - 22 * 60000).toISOString(), browser: 'Safari',  device: 'mobile',  country: 'BR', host: 'github.com',   visitor_id_hash: 'e5f6g7h8', is_admin: false },
            { occurred_at: new Date(Date.now() - 3600000).toISOString(),    browser: 'Edge',    device: 'desktop', country: 'BR', host: '(direto)',     visitor_id_hash: 'i9j0k1l2', is_admin: false },
            { occurred_at: new Date(Date.now() - 10800000).toISOString(),   browser: 'Firefox', device: 'desktop', country: 'PT', host: 'google.com',   visitor_id_hash: 'm3n4o5p6', is_admin: false },
        ],
        latest_cv_clicks: [
            { occurred_at: new Date(Date.now() - 1800000).toISOString(), browser: 'Chrome', device: 'desktop', country: 'BR', visitor_id_hash: 'a3f2b8c1', is_admin: false },
            { occurred_at: new Date(Date.now() - 14400000).toISOString(), browser: 'Safari', device: 'mobile', country: 'BR', visitor_id_hash: 'e5f6g7h8', is_admin: false },
        ],
        funnel: { pageview: kpis.pageviews, engaged: base.engaged * scale | 0, cv_click: kpis.cv_download_clicks, cv_download: kpis.cv_downloads },
        period_days: period,
    });
}

async function handleApplications(req, res, session_id) {
    if (!await mutRateLimit(req, res)) return;
    const supabase = getSupabaseDemo();

    if (req.method === 'GET') {
        if (req.query.id) {
            const { data, error } = await supabase.from('demo_job_applications')
                .select('*, cv_versions:demo_cv_versions(id, name, file_name)')
                .eq('id', req.query.id).eq('session_id', session_id).single();
            if (error || !data) return res.status(404).json({ error: 'Não encontrado' });
            return res.json(data);
        }
        const { data } = await supabase.from('demo_job_applications')
            .select('*, cv_versions:demo_cv_versions(id, name, file_name)')
            .eq('session_id', session_id).order('updated_at', { ascending: false }).limit(50);
        return res.json(data ?? []);
    }
    if (req.method === 'POST') {
        const { data: qErr } = await supabase.rpc('demo_check_quota', { p_session_id: session_id, p_table: 'demo_job_applications' });
        if (qErr) return res.status(429).json({ error: qErr });
        const patch = sanitizeApp(req.body || {});
        patch.session_id = session_id;
        patch.stages = patch.stages || [];
        patch.data_envio = patch.data_envio || new Date().toISOString();
        const { data, error } = await supabase.from('demo_job_applications')
            .insert(patch).select('*, cv_versions:demo_cv_versions(id, name, file_name)').single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }
    if (req.method === 'PUT') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        const patch = sanitizeApp(req.body || {});
        const { data, error } = await supabase.from('demo_job_applications')
            .update(patch).eq('id', req.query.id).eq('session_id', session_id)
            .select('*, cv_versions:demo_cv_versions(id, name, file_name)').single();
        if (error || !data) return res.status(404).json({ error: 'Não encontrado' });
        return res.json(data);
    }
    if (req.method === 'DELETE') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        await supabase.from('demo_job_applications').delete().eq('id', req.query.id).eq('session_id', session_id);
        return res.status(204).end();
    }
    return res.status(405).end();
}

async function handleStorageStats(req, res, session_id) {
    if (req.method !== 'GET') return res.status(405).end();
    const supabase = getSupabaseDemo();
    const { data, error } = await supabase.from('demo_cv_versions')
        .select('file_name').eq('session_id', session_id);
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];

    // Tamanho determinístico por nome (entre 180KB e 1.4MB) — demo não armazena o PDF real
    const hashSize = (name) => {
        let h = 0;
        for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        return 180_000 + (Math.abs(h) % 1_220_000);
    };
    const used_bytes  = rows.reduce((s, r) => s + hashSize(r.file_name || 'demo.pdf'), 0);
    const limit_bytes = 1_073_741_824; // 1 GB
    const used_percent = limit_bytes > 0 ? Number(((used_bytes / limit_bytes) * 100).toFixed(2)) : 0;
    const alert_threshold = 80;

    return res.json({
        bucket: 'demo-cvs',
        files_count: rows.length,
        used_bytes,
        limit_bytes,
        used_percent,
        alert_threshold_percent: alert_threshold,
        should_alert: used_percent >= alert_threshold,
        dashboard_url: null,
    });
}

async function handleCvVersions(req, res, session_id) {
    if (!await mutRateLimit(req, res)) return;
    const supabase = getSupabaseDemo();

    if (req.method === 'GET') {
        const { data } = await supabase.from('demo_cv_versions').select('*')
            .eq('session_id', session_id).order('created_at', { ascending: false }).limit(100);
        return res.json(data ?? []);
    }
    if (req.method === 'POST') {
        const { data: qErr } = await supabase.rpc('demo_check_quota', { p_session_id: session_id, p_table: 'demo_cv_versions' });
        if (qErr) return res.status(429).json({ error: qErr });
        const body = req.body || {};
        const { data, error } = await supabase.from('demo_cv_versions')
            .insert({ session_id, name: clean(body.name, 100) || 'CV sem nome', description: clean(body.description, 200), file_name: safeFileName(body.file_name || `cv-demo-${Date.now()}.pdf`), active: true })
            .select('*').single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        const body = req.body || {};
        const patch = {};
        if ('name'        in body) patch.name        = clean(body.name, 100);
        if ('description' in body) patch.description = clean(body.description, 200);
        if ('active'      in body) patch.active      = !!body.active;
        const { data, error } = await supabase.from('demo_cv_versions')
            .update(patch).eq('id', req.query.id).eq('session_id', session_id).select('*').single();
        if (error || !data) return res.status(404).json({ error: 'Não encontrado' });
        return res.json(data);
    }
    if (req.method === 'DELETE') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        await supabase.from('demo_cv_versions').delete().eq('id', req.query.id).eq('session_id', session_id);
        return res.status(204).end();
    }
    return res.status(405).end();
}

async function handleTokens(req, res, session_id) {
    if (!await mutRateLimit(req, res)) return;
    const supabase = getSupabaseDemo();

    if (req.method === 'GET') {
        const { data } = await supabase.from('demo_download_tokens')
            .select('*, cv_versions:demo_cv_versions(id, name, file_name, is_sample)')
            .eq('session_id', session_id).order('created_at', { ascending: false }).limit(100);
        const now = new Date();
        const enriched = (data ?? []).map(t => ({
            ...t,
            status: t.revoked ? 'revogado'
                : new Date(t.expires_at) < now ? 'expirado'
                : (t.max_uses !== null && t.use_count >= t.max_uses) ? 'esgotado'
                : 'ativo',
        }));
        return res.json(enriched);
    }
    if (req.method === 'POST' && (req.body || {}).action === 'consume') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        const { data: tk } = await supabase.from('demo_download_tokens')
            .select('*, cv_versions:demo_cv_versions(id, name, file_name, is_sample)')
            .eq('id', req.query.id).eq('session_id', session_id).single();
        if (!tk) return res.status(404).json({ error: 'Token não encontrado' });
        if (tk.revoked) return res.status(409).json({ error: 'Token revogado' });
        if (tk.expires_at && new Date(tk.expires_at) < new Date()) return res.status(409).json({ error: 'Token expirado' });
        if (tk.max_uses != null && tk.use_count >= tk.max_uses) return res.status(409).json({ error: 'Token esgotado' });
        const cv = tk.cv_versions;
        if (!cv || cv.is_sample !== true) return res.status(403).json({ error: 'Consumo disponível apenas para currículos de exemplo' });
        const { data: qErrLog } = await supabase.rpc('demo_check_quota', { p_session_id: session_id, p_table: 'demo_download_logs' });
        if (qErrLog) return res.status(429).json({ error: qErrLog });
        const parts = String(tk.label || '').split('·').map(s => s.trim());
        const { data: updated } = await supabase.from('demo_download_tokens')
            .update({ use_count: tk.use_count + 1 }).eq('id', tk.id).eq('session_id', session_id)
            .select('*, cv_versions:demo_cv_versions(id, name)').single();
        await supabase.from('demo_download_logs').insert({
            session_id, cv_version_id: cv.id, cv_name_snapshot: cv.name,
            ip_address: 'demo-recruiter-access', user_agent: 'Demo · acesso simulado do recrutador',
            empresa: parts[0] || 'Recrutador', vaga: parts[parts.length - 1] || '—',
            downloaded_at: new Date().toISOString(),
        });
        return res.json({ token: updated, pdf: cv.file_name });
    }
    if (req.method === 'POST') {
        const { data: qErr } = await supabase.rpc('demo_check_quota', { p_session_id: session_id, p_table: 'demo_download_tokens' });
        if (qErr) return res.status(429).json({ error: qErr });
        const body = req.body || {};
        if (!body.cv_version_id) return res.status(400).json({ error: 'cv_version_id obrigatório' });
        // Aceita expires_at_date (data ISO) ou expires_in_hours/hours (horas a partir de agora)
        let expiresAt;
        if (body.expires_at_date) {
            const d = new Date(body.expires_at_date);
            if (!isNaN(d.getTime())) expiresAt = d.toISOString();
        }
        if (!expiresAt) {
            const h = Math.max(1, Math.min(720, parseInt(body.expires_in_hours ?? body.hours) || 24));
            expiresAt = new Date(Date.now() + h * 3_600_000).toISOString();
        }
        const max_uses = (body.max_uses === null || body.max_uses === '') ? null : Math.max(1, Math.min(100, parseInt(body.max_uses) || 5));
        const rawToken = genHash();
        const { data, error } = await supabase.from('demo_download_tokens')
            .insert({ session_id, cv_version_id: body.cv_version_id, label: clean(body.label, 100) || 'Token sem label', hash: rawToken, expires_at: expiresAt, max_uses, use_count: 0, revoked: false })
            .select('*, cv_versions:demo_cv_versions(id, name)').single();
        if (error) return res.status(500).json({ error: error.message });
        // Link sandbox: aponta para domínio demo, nunca serve arquivo do usuário real
        const shareUrl = `https://demo.artacho.dev/cv?t=${rawToken}`;
        return res.status(201).json({ ...data, token: rawToken, shareUrl });
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        const body = req.body || {};
        const patch = {};
        if ('revoked' in body)    patch.revoked    = !!body.revoked;
        if ('label'   in body)    patch.label      = clean(body.label, 100);
        if ('expires_at' in body && body.expires_at) {
            const d = new Date(body.expires_at);
            if (!isNaN(d.getTime())) patch.expires_at = d.toISOString();
        }
        const { data, error } = await supabase.from('demo_download_tokens')
            .update(patch).eq('id', req.query.id).eq('session_id', session_id)
            .select('*, cv_versions:demo_cv_versions(id, name)').single();
        if (error || !data) return res.status(404).json({ error: 'Não encontrado' });
        return res.json(data);
    }
    if (req.method === 'DELETE') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        await supabase.from('demo_download_tokens').delete().eq('id', req.query.id).eq('session_id', session_id);
        return res.status(204).end();
    }
    return res.status(405).end();
}

async function handleLogs(req, res, session_id) {
    const supabase = getSupabaseDemo();

    if (req.method === 'GET') {
        const tipo = req.query.tipo || '';
        const search = req.query.search || '';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
        const offset = (page - 1) * limit;

        let query = supabase.from('demo_download_logs')
            .select('*, cv_versions:demo_cv_versions(name), download_tokens:demo_download_tokens(label)', { count: 'exact' })
            .eq('session_id', session_id).order('downloaded_at', { ascending: false });

        if (tipo === 'download')          query = query.not('ip_address', 'like', 'admin-%');
        else if (tipo === 'email')        query = query.eq('ip_address', 'admin-send-email');
        else if (tipo === 'whatsapp-link')   query = query.eq('ip_address', 'admin-send-whatsapp-link');
        else if (tipo === 'whatsapp-attach') query = query.eq('ip_address', 'admin-send-whatsapp');
        else if (tipo === 'whatsapp')     query = query.like('ip_address', 'admin-send-whatsapp%');

        if (req.query.from) query = query.gte('downloaded_at', `${req.query.from}T00:00:00`);
        if (req.query.to)   query = query.lte('downloaded_at', `${req.query.to}T23:59:59.999`);

        if (search) {
            const s = String(search).slice(0, 100)
                .replace(/[%_\\]/g, c => `\\${c}`)  // wildcards LIKE
                .replace(/[(),]/g, ' ');            // metacaracteres de filtro PostgREST
            query = query.or(`cv_name_snapshot.ilike.%${s}%,empresa.ilike.%${s}%,vaga.ilike.%${s}%,user_agent.ilike.%${s}%`);
        }
        query = query.range(offset, offset + limit - 1);
        const { data, count } = await query;
        return res.json({ data: data ?? [], total: count ?? 0, page, limit, pages: Math.ceil((count ?? 0) / limit) });
    }

    if (req.method === 'POST') {
        const rl = await checkRateLimit({ req, scope: 'demo-mut', max: 60, windowMs: 60_000 });
        if (!rl.allowed) { res.setHeader('Retry-After', rl.retryAfterSec); return res.status(429).json({ error: 'Muitas requisições. Aguarde.' }); }
        const { data: qErr } = await supabase.rpc('demo_check_quota', { p_session_id: session_id, p_table: 'demo_download_logs' });
        if (qErr) return res.status(429).json({ error: qErr });

        const body = req.body || {};
        let ip = clean(body.ip_address, 100);
        if (ip && !ip.startsWith('admin-') && !ip.startsWith('ip:')) ip = hashIP(ip);
        if (!ip) ip = hashIP(clientIp(req));

        const { data, error } = await supabase.from('demo_download_logs')
            .insert({ session_id, cv_version_id: body.cv_version_id || null, cv_name_snapshot: clean(body.cv_name_snapshot, 200), cv_id_snapshot: body.cv_id_snapshot || null, token_id: body.token_id || null, ip_address: ip, user_agent: clean(body.user_agent, 500), empresa: clean(body.empresa, 200), vaga: clean(body.vaga, 200), notas: clean(body.notas, 500), contato: clean(body.contato, 200) })
            .select('*, cv_versions:demo_cv_versions(name), download_tokens:demo_download_tokens(label)').single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }

    return res.status(405).end();
}

async function handleCvStorageUrl(req, res, session_id) {
    if (req.method === 'GET') {
        // Demo não armazena PDFs reais — aponta para CV de amostra estático
        const supabase = getSupabaseDemo();
        const { data } = await supabase.from('demo_cv_versions')
            .select('file_name').eq('id', req.query.id).eq('session_id', session_id).single();
        return res.json({ signedUrl: '/admin/assets/cv-amostra-demo.pdf', file_name: data?.file_name || 'cv-demo.pdf' });
    }
    if (req.method === 'POST') {
        // Upload real não existe no demo — interceptado client-side em demo-chrome.js (Fase 3b)
        return res.json({ signedUrl: null, filePath: null, demo: true });
    }
    return res.status(405).end();
}

async function handleSendCvEmail(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    if (!await mutRateLimit(req, res)) return;
    // NUNCA envia e-mail real no demo
    return res.json({ ok: true, demo: true, message: 'E-mail simulado. Nenhum e-mail real foi enviado.' });
}

async function handleLogShare(req, res, session_id) {
    if (req.method !== 'POST') return res.status(405).end();
    if (!await mutRateLimit(req, res)) return;
    const supabase = getSupabaseDemo();
    const { data: qErr } = await supabase.rpc('demo_check_quota', { p_session_id: session_id, p_table: 'demo_download_logs' });
    if (qErr) return res.status(429).json({ error: qErr });
    const body = req.body || {};
    const { data, error } = await supabase.from('demo_download_logs').insert({
        session_id,
        cv_version_id: body.cv_version_id || null,
        cv_name_snapshot: clean(body.cv_name_snapshot, 200),
        cv_id_snapshot: body.cv_id_snapshot || null,
        token_id: body.token_id || null,
        ip_address: 'admin-send-link',
        user_agent: clean(body.user_agent, 500) || 'Demo · Link compartilhado',
        empresa: clean(body.empresa, 200),
        vaga: clean(body.vaga, 200),
        notas: clean(body.notas, 500),
    }).select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
}

async function handleMarkMyVisits(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    // No-op no demo — sem dados de visitas reais para marcar
    return res.json({ ok: true, demo: true });
}

async function handleSessions(req, res, session_id) {
    if (req.method === 'GET') {
        return res.json([{
            jti: `demo-${session_id.slice(0, 8)}`,
            created_at: new Date(Date.now() - 3_600_000).toISOString(),
            last_seen_at: new Date().toISOString(),
            user_agent: 'Demo Browser',
            ip_address: '127.0.0.1',
            is_current: true,
            revoked_at: null,
        }]);
    }
    if (req.method === 'PATCH' || req.method === 'DELETE') {
        return res.json({ ok: true, demo: true });
    }
    return res.status(405).end();
}

async function handleLoginAttempts(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    return res.json([
        { attempted_at: new Date(Date.now() - 86_400_000).toISOString(), ip_address: '177.x.x.x', user_agent: 'Chrome/120 Windows', result: 'failed',  username_fragment: 'admin@', alerts: [] },
        { attempted_at: new Date(Date.now() -  7_200_000).toISOString(), ip_address: '186.x.x.x', user_agent: 'Firefox/121 macOS',  result: 'success', username_fragment: 'adm*',   alerts: [] },
    ]);
}

async function handleVisitorJourney(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    const hash7 = String(req.query.hash7 || '').slice(0, 20);
    return res.json({
        visitor: { hash7, country: 'BR', device: 'desktop', browser: 'Chrome' },
        events: [
            { occurred_at: new Date(Date.now() - 1_800_000).toISOString(), event_type: 'pageview',          path: '/'   },
            { occurred_at: new Date(Date.now() - 1_500_000).toISOString(), event_type: 'engaged',           path: '/'   },
            { occurred_at: new Date(Date.now() -   900_000).toISOString(), event_type: 'cv_download_click', path: '/'   },
            { occurred_at: new Date(Date.now() -   600_000).toISOString(), event_type: 'cv_view',           path: '/cv' },
        ],
    });
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    const resource = req.query.resource || '';

    // Public / cron / no session needed
    if (resource === 'config')  return handleConfig(req, res);
    if (resource === 'auth')    return handleAuth(req, res);
    if (resource === 'init')    return handleInit(req, res);
    if (resource === 'cleanup') return handleCleanup(req, res);
    if (resource === 'health')  return handleHealth(req, res);

    // Session-required resources
    const session_id = getSessionId(req);
    if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });

    // Rate limit per session (200 req/hour)
    const rlSes = await checkRateLimit({ req, scope: `demo-sess-${session_id}`, max: 200, windowMs: 3_600_000 });
    if (!rlSes.allowed) { res.setHeader('Retry-After', rlSes.retryAfterSec); return res.status(429).json({ error: 'Limite da sessão atingido. Aguarde ou recarregue.' }); }

    if (resource === 'analytics')        return handleAnalytics(req, res);
    if (resource === 'applications')     return handleApplications(req, res, session_id);
    if (resource === 'cv-versions')      return handleCvVersions(req, res, session_id);
    if (resource === 'tokens')           return handleTokens(req, res, session_id);
    if (resource === 'logs')             return handleLogs(req, res, session_id);
    if (resource === 'storage-stats')    return handleStorageStats(req, res, session_id);
    if (resource === 'cv-storage-url')   return handleCvStorageUrl(req, res, session_id);
    if (resource === 'send-cv-email')    return handleSendCvEmail(req, res);
    if (resource === 'log-share')        return handleLogShare(req, res, session_id);
    if (resource === 'mark-my-visits')   return handleMarkMyVisits(req, res);
    if (resource === 'sessions')         return handleSessions(req, res, session_id);
    if (resource === 'login-attempts')   return handleLoginAttempts(req, res);
    if (resource === 'visitor-journey')  return handleVisitorJourney(req, res);

    return res.status(404).json({ error: 'Resource not found' });
}
