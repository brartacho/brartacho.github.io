import { createHash } from 'crypto';
import { requireAdmin, cors } from '../_lib/auth.js';
import { getSupabase, BUCKET } from '../_lib/supabase.js';
import { DEFAULT_STAGES } from '../_lib/stages.js';
import { buildMessagePrompt, parseMessageResponse } from '../_lib/message-prompt.js';
import { calcCLT, calcPJ, calcMEI } from '../_lib/tax-calc.js';

const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1 GB (Supabase free)
const STORAGE_ALERT_THRESHOLD = 0.80;

function storageProjectRef() {
    try { return new URL(process.env.SUPABASE_URL).hostname.split('.')[0]; } catch { return null; }
}

async function listAllStorageObjects(supabase, bucket, prefix = '', acc = []) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`Erro ao listar storage: ${error.message}`);
    for (const item of data || []) {
        if (!item.id) { await listAllStorageObjects(supabase, bucket, prefix ? `${prefix}/${item.name}` : item.name, acc); }
        else { acc.push({ name: item.name, size: item.metadata?.size || 0, created_at: item.created_at }); }
    }
    return acc;
}

function dateRange(from, to) {
    const offset = '-03:00';
    const f = from ? `${from}T00:00:00${offset}` : new Date(Date.now() - 30 * 86400000).toISOString();
    const t = to   ? `${to}T23:59:59.999${offset}` : new Date().toISOString();
    return { f, t };
}

const TEXT_MAX = { empresa: 200, vaga: 200, linkedin_empresa: 300, link_vaga: 500, observacoes: 500, gestor_nome: 100, gestor_email: 120, modalidade: 20, tipo_contratacao: 20 };

const VALID_MODALIDADE       = new Set(['Presencial', 'Híbrida', 'Remota']);
const VALID_TIPO_CONTRATACAO = new Set(['CLT', 'PJ', 'Freelancer']);

const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
// Zero-width, overrides/embeddings/isolates bidi, word joiner e BOM — usados para
// ocultar/ofuscar conteúdo (ex.: payloads de injeção, spoofing).
const INVISIBLE_CHARS = new RegExp('[\\u200B-\\u200D\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]', 'g');

const VALID_STATUSES = new Set(['pending', 'running', 'done', 'rejected']);
const VALID_RESULTS  = new Set(['em_processo', 'aprovado', 'recusado', 'vaga_removida']);

function clean(str, max) {
    if (typeof str !== 'string') return null;
    return str.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '').trim().slice(0, max) || null;
}

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!await requireAdmin(req, res)) return;

    const supabase = getSupabase();

    // Analytics — roteado de /api/admin/analytics via rewrite
    if (req.query.__h === 'analytics') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        if (req.query.scope === 'vagas') {
            const fromStr = req.query.from || '';
            const toStr   = req.query.to   || '';
            const f = fromStr ? `${fromStr}T00:00:00.000Z` : null;
            const t = toStr   ? `${toStr}T23:59:59.999Z`   : null;
            const mode   = ['timeline','dow','wom','dom','moy'].includes(req.query.mode)   ? req.query.mode   : 'dow';
            const bucket = ['day','week','month','year'].includes(req.query.bucket)         ? req.query.bucket : 'week';
            const includeArchived = req.query.include_archived === '1';

            const rpcArgs = { from_ts: f, to_ts: t, include_archived: includeArchived };
            let totalQ = supabase.from('job_applications').select('id', { count: 'exact', head: true });
            if (!includeArchived) totalQ = totalQ.not('archived', 'eq', true);
            if (f) totalQ = totalQ.gte('created_at', f);
            if (t) totalQ = totalQ.lte('created_at', t);

            const chartPromise = mode === 'timeline'
                ? supabase.rpc('vagas_series',       { ...rpcArgs, bucket_size: bucket })
                : supabase.rpc('vagas_distribution', { ...rpcArgs, mode });

            const [totalRes, byResultRes, byModalidadeRes, byTipoRes, chartRes, byStageRes] = await Promise.all([
                totalQ,
                supabase.rpc('vagas_by_result',           rpcArgs),
                supabase.rpc('vagas_by_modalidade',        rpcArgs),
                supabase.rpc('vagas_by_tipo',              rpcArgs),
                chartPromise,
                supabase.rpc('vagas_stages_distribution',  rpcArgs),
            ]);

            res.setHeader('Cache-Control', 'private, max-age=60');
            return res.status(200).json({
                total:         totalRes.count       ?? 0,
                by_result:     byResultRes.data     ?? [],
                by_modalidade: byModalidadeRes.data ?? [],
                by_tipo:       byTipoRes.data       ?? [],
                chart: {
                    mode,
                    bucket: mode === 'timeline' ? bucket : null,
                    points: chartRes.data ?? [],
                },
                by_stage:      byStageRes.data      ?? [],
            });
        }

        const { from = '', to = '' } = req.query;
        const { f, t } = dateRange(from, to);
        const excAdm = req.query.exclude_admin === '1';

        // Janela do período imediatamente anterior (mesma duração) para cálculo de deltas
        const fMs   = Date.parse(f);
        const tMs   = Date.parse(t);
        const span  = Math.max(0, tMs - fMs);
        const fPrev = new Date(fMs - span - 1).toISOString();
        const tPrev = new Date(fMs - 1).toISOString();

        const adminFilter = q => excAdm
            ? q.or('meta->>admin.is.null,meta->>admin.neq.true')
            : q;
        const adminFilterDl = q => excAdm
            ? q.or('is_admin.is.null,is_admin.eq.false')
            : q;

        const [pageviewsRes, uniqueRes, engagedRes, cvClickRes, contactRes, caseRes,
               emailRes, downloadsRes, seriesRes, topPagesRes, referrersRes,
               utmRes, devicesRes, countriesRes, recurringRes,
               latestVisitsRes, latestClicksRes, topRecurringRes,
               projectClicksRes, contactClicksRes, adminLockRes,
               hourlyRes, dowRes, funnelUniqueRes, sessionsRes, refConvRes, retentionRes,
               pvPrevRes, uniquePrevRes, engagedPrevRes, cvClickPrevRes,
               downloadsPrevRes, recurringPrevRes, demoRes, latestDemoRes] = await Promise.all([
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'pageview').gte('occurred_at', f).lte('occurred_at', t)),
            supabase.rpc('analytics_unique_visitors', { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'engaged').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'cv_download_click').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'contact_click').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'case_open').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'email_request').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilterDl(supabase.from('download_logs').select('id', { count: 'exact', head: true }).gte('downloaded_at', f).lte('downloaded_at', t)),
            supabase.rpc('analytics_series',            { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_top_pages',         { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_top_referrers',     { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_utm_sources',       { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_devices',           { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_countries',         { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_recurring_visitors',{ from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_latest_visits',     { from_ts: f, to_ts: t, lim: 50, exclude_admin: excAdm }),
            supabase.rpc('analytics_latest_cv_clicks',  { from_ts: f, to_ts: t, lim: 30, exclude_admin: excAdm }),
            supabase.rpc('analytics_top_recurring',     { from_ts: f, to_ts: t, lim: 10, exclude_admin: excAdm }),
            adminFilter(supabase.from('site_events').select('meta').eq('event', 'project_click').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilter(supabase.from('site_events').select('meta').eq('event', 'contact_click').gte('occurred_at', f).lte('occurred_at', t)),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'admin_lock_click').gte('occurred_at', f).lte('occurred_at', t)),
            // Premium — novas RPCs
            supabase.rpc('analytics_hourly',              { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_dow',                 { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_funnel_unique',       { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_sessions',            { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_referrer_conversion', { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            supabase.rpc('analytics_retention',           { from_ts: f, to_ts: t, exclude_admin: excAdm }),
            // Período anterior (delta) — leve, só counts
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'pageview').gte('occurred_at', fPrev).lte('occurred_at', tPrev)),
            supabase.rpc('analytics_unique_visitors', { from_ts: fPrev, to_ts: tPrev, exclude_admin: excAdm }),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'engaged').gte('occurred_at', fPrev).lte('occurred_at', tPrev)),
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'cv_download_click').gte('occurred_at', fPrev).lte('occurred_at', tPrev)),
            adminFilterDl(supabase.from('download_logs').select('id', { count: 'exact', head: true }).gte('downloaded_at', fPrev).lte('downloaded_at', tPrev)),
            supabase.rpc('analytics_recurring_visitors',  { from_ts: fPrev, to_ts: tPrev, exclude_admin: excAdm }),
            // Demo access (do PR #17 - showcase)
            adminFilter(supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('event', 'demo_access').gte('occurred_at', f).lte('occurred_at', t)),
            // Drill-down de "Acessos demo": últimos 20 eventos
            adminFilter(supabase.from('site_events')
                .select('occurred_at, country, device, browser, meta')
                .eq('event', 'demo_access')
                .gte('occurred_at', f).lte('occurred_at', t)
                .order('occurred_at', { ascending: false })
                .limit(20)),
        ]);

        const aggBy = (rows, key) => Object.entries((rows || []).reduce((acc, r) => {
            const k = (r.meta && r.meta[key]) || 'unknown';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

        const pageviews       = pageviewsRes.count ?? 0;
        const unique_visitors = uniqueRes.data?.[0]?.count ?? 0;
        const engaged         = engagedRes.count ?? 0;
        const cv_clicks       = cvClickRes.count ?? 0;
        const cv_downloads    = downloadsRes.count ?? 0;
        const recurring       = Number(recurringRes.data?.[0]?.count ?? 0);

        // Período anterior (deltas)
        const prev = {
            pageviews:    pvPrevRes.count ?? 0,
            unique:       Number(uniquePrevRes.data?.[0]?.count ?? 0),
            engaged:      engagedPrevRes.count ?? 0,
            cv_clicks:    cvClickPrevRes.count ?? 0,
            cv_downloads: downloadsPrevRes.count ?? 0,
            recurring:    Number(recurringPrevRes.data?.[0]?.count ?? 0),
        };

        const sessionsRow = sessionsRes.data?.[0] ?? {};
        const retentionRow = retentionRes.data?.[0] ?? {};
        const funnelUniqueRow = funnelUniqueRes.data?.[0] ?? {};

        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.status(200).json({
            kpis: {
                pageviews,
                unique_visitors:    Number(unique_visitors),
                engaged_rate:       pageviews > 0 ? Math.round((engaged / pageviews) * 1000) / 10 : 0,
                cv_download_clicks: cv_clicks,
                email_requests:     emailRes.count ?? 0,
                contact_clicks:     contactRes.count ?? 0,
                case_opens:         caseRes.count ?? 0,
                cv_downloads,
                conversion_rate:    pageviews > 0 ? Math.round((cv_downloads / pageviews) * 1000) / 10 : 0,
                recurring_visitors: recurring,
                // Métricas de sessão
                total_sessions:        Number(sessionsRow.total_sessions ?? 0),
                bounce_rate:           Number(sessionsRow.bounce_rate ?? 0),
                pages_per_session:     Number(sessionsRow.pages_per_session ?? 0),
                avg_session_seconds:   Number(sessionsRow.avg_duration_seconds ?? 0),
                // Retenção
                retention_7d_pct:      Number(retentionRow.retention_7d_pct ?? 0),
                retention_30d_pct:     Number(retentionRow.retention_30d_pct ?? 0),
            },
            kpis_prev: prev,
            series:        seriesRes.data    ?? [],
            top_pages:     topPagesRes.data  ?? [],
            top_referrers: referrersRes.data ?? [],
            utm_sources:   utmRes.data       ?? [],
            devices:       devicesRes.data   ?? [],
            countries:     countriesRes.data ?? [],
            hourly:        hourlyRes.data    ?? [],
            dow:           dowRes.data       ?? [],
            referrer_conversion: refConvRes.data ?? [],
            latest_visits:    latestVisitsRes.data ?? [],
            latest_cv_clicks: latestClicksRes.data ?? [],
            top_recurring:    topRecurringRes.data ?? [],
            project_clicks:   aggBy(projectClicksRes.data, 'project'),
            contact_clicks_breakdown: {
                by_target:   aggBy(contactClicksRes.data, 'target'),
                by_location: aggBy(contactClicksRes.data, 'location'),
            },
            cv_page_contacts: aggBy(
                (contactClicksRes.data || []).filter(r => r.meta && r.meta.location === 'cv-page'),
                'target'
            ),
            admin_lock_clicks: adminLockRes.count ?? 0,
            demo_accesses: demoRes.count ?? 0,
            latest_demo_accesses: latestDemoRes.data ?? [],
            retention: {
                total_visitors:    Number(retentionRow.total_visitors    ?? 0),
                returned_in_7d:    Number(retentionRow.returned_in_7d    ?? 0),
                returned_in_30d:   Number(retentionRow.returned_in_30d   ?? 0),
                retention_7d_pct:  Number(retentionRow.retention_7d_pct  ?? 0),
                retention_30d_pct: Number(retentionRow.retention_30d_pct ?? 0),
            },
            funnel: {
                pageview:    pageviews,
                engaged,
                cv_click:    cv_clicks,
                cv_download: cv_downloads,
            },
            funnel_unique: {
                pageview:    Number(funnelUniqueRow.step_pageview ?? 0),
                engaged:     Number(funnelUniqueRow.step_engaged ?? 0),
                cv_click:    Number(funnelUniqueRow.step_cv_click ?? 0),
                cv_download: Number(funnelUniqueRow.step_cv_download ?? 0),
            },
        });
    }

    // Visitor journey — drill-down de timeline de eventos de um visitor (hash7)
    if (req.query.__h === 'visitor-journey') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const hash7 = String(req.query.hash7 || '').toLowerCase();
        if (!/^[a-f0-9]{7}$/.test(hash7)) {
            return res.status(400).json({ error: 'hash7 inválido' });
        }
        const { from = '', to = '' } = req.query;
        const { f, t } = dateRange(from, to);
        const { data, error } = await supabase.rpc('analytics_visitor_journey', {
            visitor_hash7: hash7, from_ts: f, to_ts: t,
        });
        if (error) return res.status(500).json({ error: error.message });
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.status(200).json({ hash7, events: data ?? [] });
    }

    // Login attempts — roteado de /api/admin/login-attempts via rewrite
    if (req.query.__h === 'login-attempts') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const lim = Math.min(Math.max(1, parseInt(req.query.lim || '50', 10)), 200);
        const { data, error } = await supabase.rpc('admin_login_recent', { lim });
        if (error) return res.status(500).json({ error: error.message });

        const attempts = data || [];
        const alertIps = [...new Set(
            attempts
                .filter(a => !a.success && Number(a.recent_failures_from_ip) >= 3)
                .map(a => a.ip_address)
                .filter(Boolean)
        )];
        return res.status(200).json({ attempts, alert_ips: alertIps });
    }

    // Marcar visitas históricas do admin — pontual, por dispositivo
    if (req.query.__h === 'mark-my-visits') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const ip   = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
        const ua   = req.headers['user-agent'] || '';
        const SALT = process.env.ANALYTICS_SALT || 'dev-salt';

        // Gera hashes para os últimos 366 dias (mesmo algoritmo do track.js)
        const hashes = [];
        for (let i = 0; i < 366; i++) {
            const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
            hashes.push(createHash('sha256').update(ip + ua + SALT + d).digest('hex'));
        }

        const { data, error } = await supabase.rpc('mark_admin_visits', { hashes });
        if (error) return res.status(500).json({ error: error.message });

        const browser = /Edg\//i.test(ua) ? 'Edge' : /Firefox\//i.test(ua) ? 'Firefox' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : 'Other';
        const device  = /Mobile|Android.*Mobile|iPhone/i.test(ua) ? 'mobile' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
        return res.status(200).json({ updated: data ?? 0, device, browser });
    }

    // Storage stats — roteado de /api/admin/storage-stats via rewrite
    if (req.query.__h === 'storage-stats') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const bucket = BUCKET();
        try {
            const objects  = await listAllStorageObjects(supabase, bucket);
            const usedBytes    = objects.reduce((s, o) => s + o.size, 0);
            const limitBytes   = Number(process.env.STORAGE_LIMIT_BYTES) || STORAGE_LIMIT_BYTES;
            const usedPercent  = limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0;
            const ref = storageProjectRef();
            return res.status(200).json({
                bucket,
                files_count:             objects.length,
                used_bytes:              usedBytes,
                limit_bytes:             limitBytes,
                used_percent:            Number(usedPercent.toFixed(2)),
                alert_threshold_percent: STORAGE_ALERT_THRESHOLD * 100,
                should_alert:            usedPercent >= STORAGE_ALERT_THRESHOLD * 100,
                dashboard_url: ref ? `https://supabase.com/dashboard/project/${ref}/storage/buckets/${bucket}` : null,
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // Demo settings — roteado de /api/admin/demo-settings via rewrite
    if (req.query.__h === 'demo-settings') {
        const VALID_TABS = new Set(['cvs', 'tokens', 'vagas', 'logs', 'metricas']);
        if (req.method === 'GET') {
            const { data } = await supabase.from('demo_settings').select('value').eq('key', 'enabled_tabs').single();
            const tabs = (data?.value && Array.isArray(data.value)) ? data.value : ['cvs', 'tokens', 'vagas', 'logs', 'metricas'];
            return res.json({ enabled_tabs: tabs });
        }
        if (req.method === 'PUT' || req.method === 'PATCH') {
            const tabs = req.body?.enabled_tabs;
            if (!Array.isArray(tabs)) return res.status(400).json({ error: 'enabled_tabs deve ser um array' });
            const cleaned = tabs.filter(t => VALID_TABS.has(t));
            await supabase.from('demo_settings').upsert(
                { key: 'enabled_tabs', value: cleaned, updated_at: new Date().toISOString() },
                { onConflict: 'key' }
            );
            return res.json({ ok: true, enabled_tabs: cleaned });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── followup-scan ─────────────────────────────────────────
    if (req.query.__h === 'followup-scan') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const profile = await supabase
            .from('candidate_profile')
            .select('stage_drag_thresholds')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        const thresholds = profile.data?.stage_drag_thresholds || {
            'Aplicado': 10, 'Triagem': 14, 'Teste': 7,
            'Entrevista com RH': 10, 'Entrevista Técnica': 10,
            'Entrevista com Gestor': 7, 'Proposta': 5,
        };
        const defaultThreshold = 14;

        const { data: apps } = await supabase
            .from('job_applications')
            .select('id, empresa, vaga, stages, updated_at, result')
            .eq('result', 'em_processo')
            .is('archived', false)
            .order('updated_at', { ascending: true });

        if (!apps?.length) return res.status(200).json({ created: 0, skipped: 0 });

        const now = new Date();
        let created = 0, skipped = 0;

        for (const app of apps) {
            const currentStage = (app.stages || []).find(s => s.status === 'running')?.name
                || (app.stages || []).find(s => !s.done && s.active !== false)?.name
                || 'Aplicado';
            const threshold = thresholds[currentStage] ?? defaultThreshold;
            const daysIdle = Math.floor((now - new Date(app.updated_at)) / 86400000);

            if (daysIdle < threshold) { skipped++; continue; }

            // Verifica se já tem sugestão pendente
            const { data: existing } = await supabase
                .from('followup_suggestions')
                .select('id')
                .eq('application_id', app.id)
                .eq('status', 'pending')
                .maybeSingle();

            if (existing) { skipped++; continue; }

            await supabase.from('followup_suggestions').insert({
                application_id: app.id,
                days_idle: daysIdle,
                current_stage: currentStage,
                suggested_message: `Olá! Gostaria de saber se há atualizações sobre minha candidatura à vaga de ${app.vaga || 'Analista'} na ${app.empresa}. Continuo muito interessado na oportunidade e fico à disposição para qualquer informação adicional.`,
                status: 'pending',
                reason: 'drag',
            });
            created++;
        }

        return res.status(200).json({ created, skipped });
    }

    // ── followup-suggestions ──────────────────────────────────
    if (req.query.__h === 'followup-suggestions') {
        if (req.method === 'GET') {
            const { data, error } = await supabase
                .from('followup_suggestions')
                .select('*, job_applications(empresa, vaga, link_vaga)')
                .in('status', ['pending', 'snoozed'])
                .order('detected_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'PATCH') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { status, sent_via, snoozed_until, suggested_message } = req.body || {};
            const VALID = new Set(['pending', 'sent', 'dismissed', 'snoozed']);
            if (status && !VALID.has(status)) return res.status(400).json({ error: 'status inválido' });
            const patch = {};
            if (status) patch.status = status;
            if (status === 'sent') patch.sent_at = new Date().toISOString();
            if (sent_via) patch.sent_via = String(sent_via).slice(0, 40);
            if (snoozed_until) patch.snoozed_until = snoozed_until;
            if (suggested_message !== undefined) patch.suggested_message = String(suggested_message).slice(0, 2000);
            const { data, error } = await supabase.from('followup_suggestions').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            if (!data) return res.status(404).json({ error: 'Sugestão não encontrada' });
            return res.status(200).json(data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── calc-liquido ──────────────────────────────────────────
    if (req.query.__h === 'calc-liquido') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const b = req.body || {};
        const results = {};
        if (b.clt) results.clt = calcCLT(b.clt);
        if (b.pj)  results.pj  = calcPJ(b.pj);
        if (b.mei) results.mei = calcMEI(b.mei);
        return res.status(200).json(results);
    }

    // ── platform-settings ──────────────────────────────────────
    if (req.query.__h === 'platform-settings') {
        if (req.method === 'GET') {
            const { data, error } = await supabase
                .from('platform_settings')
                .select('*')
                .order('display_name');
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'PUT') {
            const { fonte, char_limit, field_name, message_required, enabled, notes } = req.body || {};
            if (!fonte || typeof fonte !== 'string') return res.status(400).json({ error: 'fonte obrigatório' });
            const patch = { updated_at: new Date().toISOString() };
            if (char_limit !== undefined) patch.char_limit = Math.max(0, parseInt(char_limit, 10) || 0);
            if (field_name !== undefined) patch.field_name = field_name ? String(field_name).slice(0, 120) : null;
            if (message_required !== undefined) patch.message_required = Boolean(message_required);
            if (enabled !== undefined) patch.enabled = Boolean(enabled);
            if (notes !== undefined) patch.notes = notes ? String(notes).slice(0, 500) : null;
            const { data, error } = await supabase.from('platform_settings').update(patch).eq('fonte', fonte).select().single();
            if (error) return res.status(500).json({ error: error.message });
            if (!data) return res.status(404).json({ error: 'Plataforma não encontrada' });
            return res.status(200).json(data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── quick-answers ─────────────────────────────────────────
    if (req.query.__h === 'quick-answers') {
        if (req.method === 'GET') {
            let q = supabase.from('quick_answers').select('*').order('slug');
            if (req.query.area_id) q = q.eq('area_id', req.query.area_id);
            const { data, error } = await q;
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'POST') {
            const { area_id, slug, display_name, value, sensitive } = req.body || {};
            if (!slug || !display_name || !value) return res.status(400).json({ error: 'slug, display_name e value são obrigatórios' });
            const row = {
                slug:         String(slug).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60),
                display_name: String(display_name).slice(0, 100),
                value:        String(value).slice(0, 1000),
                sensitive:    Boolean(sensitive),
                area_id:      area_id || null,
            };
            const { data, error } = await supabase.from('quick_answers').insert(row).select().single();
            if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { display_name, value, sensitive } = req.body || {};
            const patch = { updated_at: new Date().toISOString() };
            if (display_name !== undefined) patch.display_name = String(display_name).slice(0, 100);
            if (value !== undefined) patch.value = String(value).slice(0, 1000);
            if (sensitive !== undefined) patch.sensitive = Boolean(sensitive);
            const { data, error } = await supabase.from('quick_answers').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            if (!data) return res.status(404).json({ error: 'Resposta não encontrada' });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('quick_answers').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── generate-message ──────────────────────────────────────
    if (req.query.__h === 'generate-message') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const { empresa, vaga, descricao, fonte, lead_id } = req.body || {};
        if (!empresa) return res.status(400).json({ error: 'empresa obrigatório' });

        let positioning = null, keywords_match = [], gaps = [];
        if (lead_id) {
            const { data: lead } = await supabase.from('vaga_radar').select('positioning,keywords_match,gaps,descricao,vaga,empresa').eq('id', lead_id).single();
            if (lead) {
                positioning = lead.positioning;
                keywords_match = lead.keywords_match || [];
                gaps = lead.gaps || [];
            }
        }

        const [{ data: profile }, { data: platformRow }, { data: answers }] = await Promise.all([
            supabase.from('candidate_profile').select('*').order('updated_at', { ascending: false }).limit(1).single(),
            fonte ? supabase.from('platform_settings').select('char_limit,field_name,display_name').eq('fonte', fonte).single() : Promise.resolve({ data: null }),
            supabase.from('quick_answers').select('slug,display_name,value').is('area_id', null).order('slug'),
        ]);

        const charLimit = platformRow?.char_limit ?? 0;
        const platformDisplay = platformRow?.display_name ?? fonte ?? null;

        if (!process.env.LLM_API_KEY) {
            return res.status(200).json({
                message_text: null,
                prompt: buildMessagePrompt({ empresa, vaga, descricao, positioning, keywords_match, gaps, fonte, charLimit, platformDisplay, profile: profile || {}, quickAnswers: answers || [] }),
                char_limit: charLimit,
                provider: 'mcp',
            });
        }

        const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const model = process.env.LLM_MODEL || 'gpt-4o-mini';
        const prompt = buildMessagePrompt({ empresa, vaga, descricao, positioning, keywords_match, gaps, fonte, charLimit, platformDisplay, profile: profile || {}, quickAnswers: answers || [] });

        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 45000);
            let resp;
            try {
                resp = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    signal: ctrl.signal,
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
                    body: JSON.stringify({ model, temperature: 0.4, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
                });
            } finally { clearTimeout(timer); }

            if (!resp.ok) { const d = await resp.text().catch(() => ''); throw new Error(`LLM ${resp.status}: ${d.slice(0, 200)}`); }
            const data = await resp.json();
            const raw = data?.choices?.[0]?.message?.content || '';
            const message_text = parseMessageResponse(raw);

            return res.status(200).json({ message_text, char_count: message_text?.length ?? 0, char_limit: charLimit, provider: model, prompt });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // ── duplicate-check ───────────────────────────────────────
    if (req.query.__h === 'duplicate-check') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const empresa = (req.query.empresa || '').trim().toLowerCase();
        if (!empresa) return res.status(400).json({ error: 'empresa obrigatório' });
        const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
        const { data, error } = await supabase
            .from('job_applications')
            .select('id, empresa, vaga, result, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        const matches = (data ?? []).filter(a =>
            a.empresa && a.empresa.toLowerCase().includes(empresa.slice(0, 30))
        );
        return res.status(200).json({ found: matches.length > 0, matches: matches.slice(0, 5) });
    }

    // ── digest ────────────────────────────────────────────────
    if (req.query.__h === 'digest') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        const [radarNew, radarHighFit, followupPending, msgPending, appActive] = await Promise.all([
            supabase.from('vaga_radar').select('id', { count: 'exact', head: true }).eq('status', 'novo'),
            supabase.from('vaga_radar').select('id', { count: 'exact', head: true }).eq('status', 'novo').gte('fit_score', 7),
            supabase.from('followup_suggestions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
            supabase.from('job_applications').select('id', { count: 'exact', head: true })
                .eq('result', 'em_processo').eq('application_message_sent', false).not('application_message_text', 'is', null),
            supabase.from('job_applications').select('id', { count: 'exact', head: true }).eq('result', 'em_processo').eq('archived', false),
        ]);
        return res.status(200).json({
            radar_new:       radarNew.count ?? 0,
            radar_high_fit:  radarHighFit.count ?? 0,
            followup_due:    followupPending.count ?? 0,
            message_pending: msgPending.count ?? 0,
            active_apps:     appActive.count ?? 0,
        });
    }

    // ── auto-archive-scan ─────────────────────────────────────
    if (req.query.__h === 'auto-archive-scan') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { data: profile } = await supabase.from('candidate_profile')
            .select('auto_archive_em_processo_days,auto_archive_recusado')
            .order('updated_at', { ascending: false }).limit(1).single();
        const emProcessoDays = profile?.auto_archive_em_processo_days ?? 60;
        const archiveRecusado = profile?.auto_archive_recusado ?? true;

        const staleEm = new Date(Date.now() - emProcessoDays * 24 * 3600 * 1000).toISOString();
        const results = { archived_em_processo: 0, archived_recusado: 0, errors: [] };

        const { data: staleApps } = await supabase.from('job_applications')
            .select('id').eq('result', 'em_processo').eq('archived', false).lte('updated_at', staleEm);
        if (staleApps?.length) {
            const ids = staleApps.map(a => a.id);
            const { error } = await supabase.from('job_applications').update({ archived: true }).in('id', ids);
            if (error) results.errors.push(error.message);
            else results.archived_em_processo = ids.length;
        }
        if (archiveRecusado) {
            const { data: recusados } = await supabase.from('job_applications')
                .select('id').eq('result', 'recusado').eq('archived', false);
            if (recusados?.length) {
                const ids = recusados.map(a => a.id);
                const { error } = await supabase.from('job_applications').update({ archived: true }).in('id', ids);
                if (error) results.errors.push(error.message);
                else results.archived_recusado = ids.length;
            }
        }
        return res.status(200).json(results);
    }

    // ── batch-promote ─────────────────────────────────────────
    if (req.query.__h === 'batch-promote') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { lead_ids } = req.body || {};
        if (!Array.isArray(lead_ids) || lead_ids.length === 0) return res.status(400).json({ error: 'lead_ids obrigatório' });
        const { data: leads, error: leadsErr } = await supabase
            .from('vaga_radar').select('*').in('id', lead_ids.slice(0, 20));
        if (leadsErr) return res.status(500).json({ error: leadsErr.message });

        const rows = leads.map(l => ({
            empresa:          l.empresa,
            vaga:             l.vaga,
            link_vaga:        l.link_vaga,
            modalidade:       l.modalidade || null,
            tipo_contratacao: l.tipo_contratacao || null,
            platform:         l.fonte || null,
            origin_radar_id:  l.id,
        }));
        const { data: created, error: createErr } = await supabase
            .from('job_applications').insert(rows).select('id, empresa, vaga, origin_radar_id');
        if (createErr) return res.status(500).json({ error: createErr.message });

        // mark leads as promoted
        const promotedIds = leads.map(l => l.id);
        await supabase.from('vaga_radar').update({ status: 'promovida' }).in('id', promotedIds);

        return res.status(201).json({ created: created ?? [], count: (created ?? []).length });
    }

    // ── interview-qa ──────────────────────────────────────────
    if (req.query.__h === 'interview-qa') {
        if (req.method === 'GET') {
            let q = supabase.from('interview_qa').select('*').order('created_at', { ascending: false });
            if (req.query.category) q = q.eq('category', req.query.category);
            if (req.query.tag) q = q.contains('tags', [req.query.tag]);
            const { data, error } = await q.limit(200);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'POST') {
            const { question, answer, category, tags, source_vaga_id, source_application_id } = req.body || {};
            if (!question) return res.status(400).json({ error: 'question obrigatório' });
            const { data, error } = await supabase.from('interview_qa').insert({
                question: String(question).slice(0, 500),
                answer: answer ? String(answer).slice(0, 2000) : null,
                category: ['rh','tecnica','comportamental'].includes(category) ? category : null,
                tags: Array.isArray(tags) ? tags.slice(0, 20) : [],
                source_vaga_id: source_vaga_id || null,
                source_application_id: source_application_id || null,
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { question, answer, category, tags } = req.body || {};
            const patch = { updated_at: new Date().toISOString() };
            if (question !== undefined) patch.question = String(question).slice(0, 500);
            if (answer !== undefined) patch.answer = answer ? String(answer).slice(0, 2000) : null;
            if (category !== undefined) patch.category = ['rh','tecnica','comportamental'].includes(category) ? category : null;
            if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.slice(0, 20) : [];
            const { data, error } = await supabase.from('interview_qa').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            if (!data) return res.status(404).json({ error: 'Pergunta não encontrada' });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('interview_qa').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── link-checker ─────────────────────────────────────────
    if (req.query.__h === 'link-checker') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { data: apps, error } = await supabase
            .from('job_applications')
            .select('id, link_vaga')
            .eq('result', 'em_processo')
            .eq('archived', false)
            .not('link_vaga', 'is', null)
            .not('link_vaga', 'eq', '');
        if (error) return res.status(500).json({ error: error.message });

        const results = { removed: 0, checked: 0, errors: [] };
        const toArchive = [];

        await Promise.allSettled((apps ?? []).map(async app => {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 8000);
                let status;
                try {
                    const resp = await fetch(app.link_vaga, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
                    status = resp.status;
                } finally { clearTimeout(timer); }
                results.checked++;
                if (status === 404 || status === 410 || status === 403) {
                    toArchive.push(app.id);
                }
            } catch { /* network error — skip */ }
        }));

        if (toArchive.length) {
            const { error: archErr } = await supabase
                .from('job_applications')
                .update({ archived: true, result: 'vaga_removida' })
                .in('id', toArchive);
            if (archErr) results.errors.push(archErr.message);
            else results.removed = toArchive.length;
        }

        return res.status(200).json(results);
    }

    // ── gaps-dashboard ────────────────────────────────────────
    if (req.query.__h === 'gaps-dashboard') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const days = parseInt(req.query.days, 10) || 90;
        const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        const { data: leads, error } = await supabase
            .from('vaga_radar').select('gaps').gte('created_at', since).not('gaps', 'is', null);
        if (error) return res.status(500).json({ error: error.message });

        const freq = {};
        for (const lead of leads ?? []) {
            for (const gap of (lead.gaps || [])) {
                const k = String(gap).trim().toLowerCase();
                if (k) freq[k] = (freq[k] || 0) + 1;
            }
        }
        const total = leads?.length || 1;
        const sorted = Object.entries(freq)
            .map(([skill, count]) => ({ skill, count, pct: Math.round(count / total * 100) }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);
        return res.status(200).json({ gaps: sorted, total_leads: total, period_days: days });
    }

    // GET — lista candidaturas ou detalhe individual (?id=)
    if (req.method === 'GET') {
        if (req.query.id) {
            const { data, error } = await supabase
                .from('job_applications')
                .select('*')
                .eq('id', req.query.id)
                .single();
            if (error || !data) return res.status(404).json({ error: 'Candidatura não encontrada' });
            return res.status(200).json(data);
        }

        const { data, error } = await supabase
            .from('job_applications')
            .select('*, cv_versions(id, name, file_name)')
            .order('data_envio', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data ?? []);
    }

    // POST — cria candidatura manual
    if (req.method === 'POST') {
        const { empresa, vaga, linkedin_empresa, link_vaga, observacoes, gestor_nome, gestor_email, gestor_phone, data_envio, modalidade, tipo_contratacao, cv_version_id,
                platform, origin_radar_id, application_message_text, application_message_sent, auto_filled_fields } = req.body || {};

        const emp = clean(empresa, TEXT_MAX.empresa);
        if (!emp) return res.status(400).json({ error: 'empresa obrigatório' });

        if (data_envio && isNaN(new Date(data_envio).getTime())) {
            return res.status(400).json({ error: 'data_envio inválido' });
        }

        if (modalidade && !VALID_MODALIDADE.has(modalidade)) {
            return res.status(400).json({ error: `modalidade inválida (${modalidade})` });
        }
        if (tipo_contratacao && !VALID_TIPO_CONTRATACAO.has(tipo_contratacao)) {
            return res.status(400).json({ error: `tipo_contratacao inválido (${tipo_contratacao})` });
        }

        const { data, error } = await supabase
            .from('job_applications')
            .insert({
                empresa:          emp,
                vaga:             clean(vaga, TEXT_MAX.vaga),
                linkedin_empresa: clean(linkedin_empresa, TEXT_MAX.linkedin_empresa),
                link_vaga:        clean(link_vaga, TEXT_MAX.link_vaga),
                observacoes:      clean(observacoes, TEXT_MAX.observacoes),
                gestor_nome:      clean(gestor_nome, TEXT_MAX.gestor_nome),
                gestor_email:     clean(gestor_email, TEXT_MAX.gestor_email),
                data_envio:       data_envio || null,
                modalidade:       modalidade || null,
                tipo_contratacao: tipo_contratacao || null,
                cv_version_id:    cv_version_id || null,
                gestor_phone:     clean(gestor_phone, 30) || null,
                platform:         platform ? clean(platform, 40) : null,
                origin_radar_id:  origin_radar_id || null,
                application_message_text:  application_message_text ? clean(application_message_text, 5000) : null,
                application_message_sent:  Boolean(application_message_sent),
                auto_filled_fields:        Array.isArray(auto_filled_fields) ? auto_filled_fields : [],
                source:           origin_radar_id ? 'radar' : 'manual',
                stages:           DEFAULT_STAGES,
            })
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }

    // PUT — atualiza candidatura (?id=)
    if (req.method === 'PUT') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });

        const { empresa, vaga, linkedin_empresa, link_vaga, observacoes, gestor_nome, gestor_email, gestor_phone, data_envio, modalidade, tipo_contratacao, archived, stages, result, cv_version_id,
                platform, application_message_text, application_message_sent, auto_filled_fields } = req.body || {};

        const patch = {};
        if (empresa !== undefined) {
            const val = clean(empresa, TEXT_MAX.empresa);
            if (val === null) return res.status(400).json({ error: 'empresa não pode ser vazio' });
            patch.empresa = val;
        }
        if (vaga             !== undefined) patch.vaga             = clean(vaga, TEXT_MAX.vaga);
        if (linkedin_empresa !== undefined) patch.linkedin_empresa = clean(linkedin_empresa, TEXT_MAX.linkedin_empresa);
        if (link_vaga        !== undefined) patch.link_vaga        = clean(link_vaga, TEXT_MAX.link_vaga);
        if (observacoes      !== undefined) patch.observacoes      = clean(observacoes, TEXT_MAX.observacoes);
        if (gestor_nome      !== undefined) patch.gestor_nome      = clean(gestor_nome, TEXT_MAX.gestor_nome);
        if (gestor_email     !== undefined) patch.gestor_email     = clean(gestor_email, TEXT_MAX.gestor_email);
        if (gestor_phone     !== undefined) patch.gestor_phone     = clean(gestor_phone, 30) || null;
        if (cv_version_id    !== undefined) patch.cv_version_id    = cv_version_id || null;
        if (data_envio !== undefined) {
            if (data_envio !== null && data_envio !== '' && isNaN(new Date(data_envio).getTime())) {
                return res.status(400).json({ error: 'data_envio inválido' });
            }
            patch.data_envio = data_envio || null;
        }
        if (stages !== undefined) {
            if (!Array.isArray(stages)) {
                return res.status(400).json({ error: 'stages deve ser array' });
            }
            for (const s of stages) {
                if (typeof s.name !== 'string' || !s.name.trim()) {
                    return res.status(400).json({ error: 'stages: name (string) é obrigatório' });
                }
                if (s.status !== undefined && !VALID_STATUSES.has(s.status)) {
                    return res.status(400).json({ error: `stages: status inválido (${s.status})` });
                }
            }
            const runningCount = stages.filter(s => s.status === 'running' && s.active !== false).length;
            if (runningCount > 1) return res.status(400).json({ error: 'Apenas uma etapa pode estar executando' });
            patch.stages = stages;
        }
        if (modalidade !== undefined) {
            if (modalidade !== null && modalidade !== '' && !VALID_MODALIDADE.has(modalidade)) {
                return res.status(400).json({ error: `modalidade inválida (${modalidade})` });
            }
            patch.modalidade = modalidade || null;
        }
        if (tipo_contratacao !== undefined) {
            if (tipo_contratacao !== null && tipo_contratacao !== '' && !VALID_TIPO_CONTRATACAO.has(tipo_contratacao)) {
                return res.status(400).json({ error: `tipo_contratacao inválido (${tipo_contratacao})` });
            }
            patch.tipo_contratacao = tipo_contratacao || null;
        }
        if (archived !== undefined) {
            if (typeof archived !== 'boolean') {
                return res.status(400).json({ error: 'archived deve ser boolean' });
            }
            patch.archived = archived;
        }
        if (result !== undefined) {
            if (!VALID_RESULTS.has(result)) {
                return res.status(400).json({ error: `result inválido (${result})` });
            }
            patch.result = result;
        }
        if (platform !== undefined) patch.platform = platform ? clean(platform, 40) : null;
        if (application_message_text !== undefined) patch.application_message_text = application_message_text ? clean(application_message_text, 5000) : null;
        if (application_message_sent !== undefined) patch.application_message_sent = Boolean(application_message_sent);
        if (auto_filled_fields !== undefined) patch.auto_filled_fields = Array.isArray(auto_filled_fields) ? auto_filled_fields : [];

        if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

        const { data, error } = await supabase
            .from('job_applications')
            .update(patch)
            .eq('id', id)
            .select('*, cv_versions(id, name, file_name)')
            .single();

        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Candidatura não encontrada' });
        return res.status(200).json(data);
    }

    // DELETE — deleta candidatura (?id=)
    if (req.method === 'DELETE') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });

        const { data, error } = await supabase
            .from('job_applications')
            .delete()
            .eq('id', id)
            .select()
            .single();

        if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
