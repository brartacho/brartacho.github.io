import { createHash } from 'crypto';
import { requireAdmin, cors } from '../_lib/auth.js';
import { getSupabase, BUCKET } from '../_lib/supabase.js';
import { DEFAULT_STAGES } from '../_lib/stages.js';
import { buildMessagePrompt, parseMessageResponse } from '../_lib/message-prompt.js';
import { calcCLT, calcPJ, calcMEI } from '../_lib/tax-calc.js';
import { providerStats } from '../_lib/llm-router.js';

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

        const prompt = buildMessagePrompt({ empresa, vaga, descricao, positioning, keywords_match, gaps, fonte, charLimit, platformDisplay, profile: profile || {}, quickAnswers: answers || [] });

        // Tenta roteamento multi-provider; fallback para prompt-only (MCP)
        try {
            const { routeChat } = await import('../_lib/llm-router.js');
            const result = await routeChat({
                taskType: 'message',
                messages: [{ role: 'user', content: prompt }],
                maxTokens: 800,
                temperature: 0.4,
                refId: lead_id || null,
            });
            const message_text = parseMessageResponse(result.content);
            return res.status(200).json({ message_text, char_count: message_text?.length ?? 0, char_limit: charLimit, provider: result.provider, model: result.model, prompt });
        } catch (_routeErr) {
            // Nenhum provider configurado → retorna prompt para uso via MCP
            return res.status(200).json({
                message_text: null,
                prompt,
                char_limit: charLimit,
                provider: 'mcp',
                note: 'Nenhum provider LLM configurado. Configure pelo menos uma env var (GROQ_API_KEY, GEMINI_API_KEY, etc.) para geração automática.',
            });
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

    // ── llm-providers ────────────────────────────────────────
    if (req.query.__h === 'llm-providers') {
        if (req.method === 'GET') {
            try {
                const stats = await providerStats();
                return res.status(200).json(stats);
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { enabled, priority } = req.body || {};
            const patch = { updated_at: new Date().toISOString() };
            if (enabled !== undefined) patch.enabled = Boolean(enabled);
            if (priority !== undefined) patch.priority = Math.max(0, parseInt(priority, 10) || 0);
            const { data, error } = await supabase.from('llm_providers').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── llm-usage ─────────────────────────────────────────────
    if (req.query.__h === 'llm-usage') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data, error } = await supabase
            .from('llm_usage_log')
            .select('provider_id, task_type, tokens_in, tokens_out, status, latency_ms, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(500);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data ?? []);
    }

    // ── platform-sessions ────────────────────────────────────
    // Armazena cookies/tokens de sessão por plataforma (gravados pelo MCP local)
    if (req.query.__h === 'platform-sessions') {
        if (req.method === 'GET') {
            const { data, error } = await supabase
                .from('platform_sessions')
                .select('id, fonte, display_name, session_type, expires_at, last_used_at, is_valid, created_at')
                .order('fonte');
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'POST') {
            const { fonte, session_data, session_type, expires_at, display_name } = req.body || {};
            if (!fonte || !session_data) return res.status(400).json({ error: 'fonte e session_data obrigatórios' });
            const safeSource = String(fonte).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
            const row = {
                fonte:        safeSource,
                display_name: display_name ? String(display_name).slice(0, 100) : safeSource,
                session_data: String(session_data).slice(0, 65536),
                session_type: ['cookie', 'token', 'credentials'].includes(session_type) ? session_type : 'cookie',
                expires_at:   expires_at || null,
                is_valid:     true,
                last_used_at: new Date().toISOString(),
            };
            const { data, error } = await supabase
                .from('platform_sessions')
                .upsert(row, { onConflict: 'fonte' })
                .select('id, fonte, display_name, session_type, expires_at, is_valid').single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'DELETE') {
            const { fonte } = req.query;
            if (!fonte) return res.status(400).json({ error: 'fonte obrigatório' });
            const { error } = await supabase.from('platform_sessions').delete().eq('fonte', fonte);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── sync-status ───────────────────────────────────────────
    // Registra resultado de sync e grava histórico de status
    if (req.query.__h === 'sync-status') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { application_id, fonte, external_status, new_result, platform_application_id, error: syncError } = req.body || {};
        if (!application_id || !fonte) return res.status(400).json({ error: 'application_id e fonte obrigatórios' });

        // Busca status atual para comparar
        const { data: app } = await supabase
            .from('job_applications').select('result, external_status').eq('id', application_id).single();

        const patch = {
            last_synced_at: new Date().toISOString(),
            sync_error:     syncError ? String(syncError).slice(0, 500) : null,
        };
        if (external_status !== undefined) patch.external_status = String(external_status).slice(0, 100);
        if (platform_application_id !== undefined) patch.platform_application_id = String(platform_application_id).slice(0, 200);
        if (new_result && VALID_RESULTS.has(new_result)) patch.result = new_result;

        await supabase.from('job_applications').update(patch).eq('id', application_id);

        // Registra no histórico apenas se houve mudança de status
        const oldResult = app?.result || null;
        if (new_result && new_result !== oldResult) {
            await supabase.from('application_status_history').insert({
                application_id,
                fonte,
                previous_status: oldResult,
                new_status:      new_result,
                external_status: external_status || null,
                change_source:   'auto_sync',
            });
        }

        // Marca sessão como usada
        await supabase.from('platform_sessions')
            .update({ last_used_at: new Date().toISOString(), is_valid: !syncError })
            .eq('fonte', fonte);

        return res.status(200).json({ ok: true, status_changed: new_result && new_result !== oldResult });
    }

    // ── status-history ────────────────────────────────────────
    if (req.query.__h === 'status-history') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { application_id } = req.query;
        if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
        const { data, error } = await supabase
            .from('application_status_history')
            .select('*')
            .eq('application_id', application_id)
            .order('changed_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data ?? []);
    }

    // ── interview-sessions ────────────────────────────────────
    if (req.query.__h === 'interview-sessions') {
        if (req.method === 'GET') {
            const { application_id, id } = req.query;
            if (id) {
                const { data, error } = await supabase
                    .from('interview_sessions')
                    .select('*, interview_analyses(*)')
                    .eq('id', id).single();
                if (error || !data) return res.status(404).json({ error: 'Sessão não encontrada' });
                return res.status(200).json(data);
            }
            if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
            const { data, error } = await supabase
                .from('interview_sessions')
                .select('*, interview_analyses(id, overall_score, generated_at)')
                .eq('application_id', application_id)
                .order('interview_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'POST') {
            const { application_id, stage_name, interview_at, interviewer_name, interviewer_email, notes_before } = req.body || {};
            if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
            const { data, error } = await supabase.from('interview_sessions').insert({
                application_id,
                stage_name:        stage_name ? String(stage_name).slice(0, 80) : null,
                interview_at:      interview_at || null,
                interviewer_name:  interviewer_name ? String(interviewer_name).slice(0, 100) : null,
                interviewer_email: interviewer_email ? String(interviewer_email).slice(0, 120) : null,
                notes_before:      notes_before ? String(notes_before).slice(0, 2000) : null,
                status:            'planned',
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { stage_name, interview_at, interviewer_name, interviewer_email, notes_before, notes_after, status, recording_available } = req.body || {};
            const patch = { updated_at: new Date().toISOString() };
            if (stage_name !== undefined)          patch.stage_name = stage_name ? String(stage_name).slice(0, 80) : null;
            if (interview_at !== undefined)        patch.interview_at = interview_at || null;
            if (interviewer_name !== undefined)    patch.interviewer_name = interviewer_name ? String(interviewer_name).slice(0, 100) : null;
            if (interviewer_email !== undefined)   patch.interviewer_email = interviewer_email ? String(interviewer_email).slice(0, 120) : null;
            if (notes_before !== undefined)        patch.notes_before = notes_before ? String(notes_before).slice(0, 2000) : null;
            if (notes_after !== undefined)         patch.notes_after = notes_after ? String(notes_after).slice(0, 2000) : null;
            if (recording_available !== undefined) patch.recording_available = Boolean(recording_available);
            if (status && ['planned', 'in_progress', 'done', 'cancelled'].includes(status)) patch.status = status;
            const { data, error } = await supabase.from('interview_sessions').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('interview_sessions').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── interview-analyze ─────────────────────────────────────
    // Gera análise IA a partir de transcrição/notas pós-entrevista
    if (req.query.__h === 'interview-analyze') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { session_id, transcript, notes_after } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });
        if (!transcript && !notes_after) return res.status(400).json({ error: 'transcript ou notes_after obrigatório' });

        const { data: session } = await supabase
            .from('interview_sessions')
            .select('*, job_applications(empresa, vaga)')
            .eq('id', session_id).single();

        const empresa = session?.job_applications?.empresa || '';
        const vagoName = session?.job_applications?.vaga || '';

        const analysisPrompt = `Você é um coach de carreira experiente. Analise esta entrevista e forneça feedback estruturado em JSON.

Vaga: ${vagoName} @ ${empresa}
Etapa: ${session?.stage_name || 'não informada'}
${transcript ? `\nTranscrição:\n${String(transcript).slice(0, 4000)}` : ''}
${notes_after ? `\nNotas do candidato:\n${String(notes_after).slice(0, 1000)}` : ''}

Retorne APENAS JSON válido com esta estrutura:
{
  "overall_score": <0-10>,
  "communication": <0-10>,
  "technical": <0-10>,
  "behavioral": <0-10>,
  "strengths": ["ponto forte 1", "ponto forte 2"],
  "improvements": ["melhoria 1", "melhoria 2"],
  "red_flags": ["alerta 1 se houver"],
  "next_steps": "próximos passos recomendados",
  "full_feedback": "feedback completo em 2-3 parágrafos"
}`;

        try {
            const { routeChat } = await import('../_lib/llm-router.js');
            const result = await routeChat({
                taskType: 'analysis',
                messages: [{ role: 'user', content: analysisPrompt }],
                maxTokens: 1200,
                temperature: 0.3,
                refId: session_id,
            });

            let analysisData;
            try {
                const jsonMatch = result.content.match(/\{[\s\S]*\}/);
                analysisData = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result.content);
            } catch (_) {
                analysisData = { full_feedback: result.content };
            }

            const { data: saved, error: saveErr } = await supabase.from('interview_analyses').insert({
                session_id,
                analysis_type:  'full',
                overall_score:  analysisData.overall_score ?? null,
                communication:  analysisData.communication ?? null,
                technical:      analysisData.technical ?? null,
                behavioral:     analysisData.behavioral ?? null,
                questions_asked: analysisData.questions_asked ?? null,
                strengths:      analysisData.strengths ?? [],
                improvements:   analysisData.improvements ?? [],
                red_flags:      analysisData.red_flags ?? [],
                next_steps:     analysisData.next_steps ?? null,
                full_feedback:  analysisData.full_feedback ?? null,
                raw_transcript: transcript ? String(transcript).slice(0, 10000) : null,
                provider:       result.provider,
            }).select().single();

            if (saveErr) return res.status(500).json({ error: saveErr.message });

            // Marca sessão como concluída
            await supabase.from('interview_sessions').update({ status: 'done', notes_after: notes_after || session?.notes_after || null }).eq('id', session_id);

            return res.status(201).json(saved);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // ── context-notes ─────────────────────────────────────────
    if (req.query.__h === 'context-notes') {
        if (req.method === 'GET') {
            const { entity_type, entity_id } = req.query;
            let q = supabase.from('context_notes').select('*').order('importance', { ascending: false }).order('created_at', { ascending: false });
            if (entity_type) q = q.eq('entity_type', entity_type);
            if (entity_id)   q = q.eq('entity_id', entity_id);
            const { data, error } = await q.limit(50);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'POST') {
            const { entity_type, entity_id, note, tags, importance } = req.body || {};
            if (!entity_type || !note) return res.status(400).json({ error: 'entity_type e note obrigatórios' });
            const { data, error } = await supabase.from('context_notes').insert({
                entity_type: String(entity_type).slice(0, 30),
                entity_id:   entity_id ? String(entity_id).slice(0, 100) : null,
                note:        String(note).slice(0, 3000),
                tags:        Array.isArray(tags) ? tags.map(t => String(t).slice(0, 50)) : [],
                importance:  Math.min(5, Math.max(1, parseInt(importance, 10) || 2)),
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('context_notes').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── context-summary ────────────────────────────────────────
    // Gera ou busca resumo de contexto para um período/escopo
    if (req.query.__h === 'context-summary') {
        if (req.method === 'GET') {
            const { scope, scope_ref } = req.query;
            let q = supabase.from('context_summaries').select('*').order('generated_at', { ascending: false });
            if (scope)     q = q.eq('scope', scope);
            if (scope_ref) q = q.eq('scope_ref', scope_ref);
            const { data, error } = await q.limit(10);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data ?? []);
        }
        if (req.method === 'POST') {
            const { scope = 'month', scope_ref } = req.body || {};

            // Busca candidaturas do período
            let appQuery = supabase.from('job_applications')
                .select('id, empresa, vaga, result, data_envio, observacoes, stages')
                .order('created_at', { ascending: false })
                .limit(30);
            if (scope === 'month' && scope_ref) {
                const [y, m] = scope_ref.split('-').map(Number);
                const from = new Date(y, m - 1, 1).toISOString();
                const to   = new Date(y, m, 0, 23, 59, 59).toISOString();
                appQuery = appQuery.gte('created_at', from).lte('created_at', to);
            }
            const { data: apps } = await appQuery;

            // Busca notas do período
            const { data: notes } = await supabase.from('context_notes')
                .select('entity_type, entity_id, note, importance, tags')
                .order('importance', { ascending: false }).limit(50);

            if (!apps?.length && !notes?.length) {
                return res.status(200).json({ summary_md: 'Nenhum dado encontrado para o período.', highlights: [] });
            }

            const appsText = (apps || []).map(a =>
                `- ${a.empresa}${a.vaga ? ` (${a.vaga})` : ''}: ${a.result || 'em_processo'}${a.observacoes ? ` — ${a.observacoes.slice(0, 100)}` : ''}`
            ).join('\n');

            const notesText = (notes || []).filter(n => n.importance >= 3).map(n =>
                `[${n.entity_type}${n.entity_id ? ':' + n.entity_id.slice(0, 8) : ''}] (imp:${n.importance}) ${n.note.slice(0, 200)}`
            ).join('\n');

            const summaryPrompt = `Você é um coach de carreira. Gere um resumo conciso do período de busca de emprego em Markdown.

Candidaturas:
${appsText || 'Nenhuma'}

Notas de contexto:
${notesText || 'Nenhuma'}

Retorne JSON com:
{
  "title": "Resumo de [período]",
  "summary_md": "## Resumo\\n\\n[2-3 parágrafos em markdown]",
  "highlights": ["ponto 1", "ponto 2", "ponto 3"],
  "keywords": ["keyword1", "keyword2"]
}`;

            try {
                const { routeChat } = await import('../_lib/llm-router.js');
                const result = await routeChat({ taskType: 'analysis', messages: [{ role: 'user', content: summaryPrompt }], maxTokens: 800, temperature: 0.3 });
                let parsed;
                try { const m = result.content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : JSON.parse(result.content); }
                catch (_) { parsed = { title: 'Resumo', summary_md: result.content, highlights: [], keywords: [] }; }

                const { data: saved } = await supabase.from('context_summaries').insert({
                    scope, scope_ref: scope_ref || null,
                    title:      parsed.title || 'Resumo',
                    summary_md: parsed.summary_md || '',
                    highlights: parsed.highlights || [],
                    keywords:   parsed.keywords || [],
                    entity_ids: (apps || []).map(a => a.id),
                    provider:   result.provider,
                    valid_until: new Date(Date.now() + 30 * 86400000).toISOString(),
                }).select().single();
                return res.status(201).json(saved || parsed);
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── star-stories (N6) ─────────────────────────────────────
    if (req.query.__h === 'star-stories') {
        if (req.method === 'GET') {
            const { q, id } = req.query;
            if (id) {
                const { data, error } = await supabase.from('star_stories').select('*').eq('id', id).single();
                if (error) return res.status(404).json({ error: error.message });
                return res.status(200).json({ stories: [data] });
            }
            let query = supabase.from('star_stories').select('*').order('importance', { ascending: false }).order('created_at', { ascending: false });
            if (q) {
                const s = String(q).toLowerCase();
                query = query.or(`title.ilike.%${s}%,competencies.cs.{${s}},themes.cs.{${s}}`);
            }
            const { data, error } = await query.limit(50);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ stories: data ?? [] });
        }
        if (req.method === 'POST') {
            const { title, situation, task, action, result, competencies, themes, empresa_context, empresa_id, date_occurred, importance, result_metrics, area_id } = req.body || {};
            if (!title || !situation || !task || !action || !result) return res.status(400).json({ error: 'Campos obrigatórios: title, situation, task, action, result' });
            const { data, error } = await supabase.from('star_stories').insert({
                title:          String(title).slice(0,200),
                situation:      String(situation).slice(0,2000),
                task:           String(task).slice(0,2000),
                action:         String(action).slice(0,2000),
                result:         String(result).slice(0,2000),
                result_metrics: result_metrics || null,
                competencies:   Array.isArray(competencies) ? competencies.map(c=>String(c).slice(0,50)) : [],
                themes:         Array.isArray(themes) ? themes.map(t=>String(t).slice(0,50)) : [],
                empresa_context: (empresa_id || empresa_context) ? String(empresa_id || empresa_context).slice(0,100) : null,
                date_occurred:  date_occurred || null,
                importance:     typeof importance === 'number' ? Math.min(1, Math.max(0, importance)) : 0.5,
                area_id: area_id || null,
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const allowed = ['title','situation','task','action','result','result_metrics','competencies','themes','empresa_context','empresa_id','date_occurred','importance'];
            const patch = {};
            for (const k of allowed) { if (req.body?.[k] !== undefined) patch[k] = req.body[k]; }
            const { data, error } = await supabase.from('star_stories').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('star_stories').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── study-plan (N16) ──────────────────────────────────────
    if (req.query.__h === 'study-plan') {
        if (req.method === 'GET') {
            const { data, error } = await supabase.from('study_plan_items').select('*, study_sessions(hours, session_date)').order('priority', { ascending: false, nullsFirst: false }).order('created_at');
            if (error) return res.status(500).json({ error: error.message });
            const items = (data || []).map(item => {
                const totalHours = (item.study_sessions || []).reduce((s, ss) => s + (ss.hours || 0), 0);
                return { ...item, hours_completed: totalHours, study_sessions: undefined };
            });
            return res.status(200).json({ items });
        }
        if (req.method === 'POST') {
            const { skill, hours_planned, course_url, course_title, course_provider, priority, demand_pct, area_id, study_plan_item_id, hours, notes, session_date } = req.body || {};
            // Se tem study_plan_item_id → registra sessão de estudo
            if (study_plan_item_id) {
                if (!hours || hours <= 0) return res.status(400).json({ error: 'hours obrigatório e > 0' });
                const { data, error } = await supabase.from('study_sessions').insert({ study_plan_item_id, hours: parseFloat(hours), notes: notes||null, session_date: session_date || new Date().toISOString().slice(0,10) }).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.status(201).json(data);
            }
            if (!skill) return res.status(400).json({ error: 'skill obrigatório' });
            const { data, error } = await supabase.from('study_plan_items').insert({
                skill: String(skill).slice(0,100), hours_planned: hours_planned ? parseInt(hours_planned,10) : null,
                course_url: course_url ? String(course_url).slice(0,500) : null,
                course_title: course_title ? String(course_title).slice(0,200) : null,
                course_provider: course_provider ? String(course_provider).slice(0,100) : null,
                priority: priority ? parseFloat(priority) : null,
                demand_pct: demand_pct ? parseFloat(demand_pct) : null,
                area_id: area_id || null, status: 'planned',
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const allowed = ['skill','status','hours_planned','course_url','course_title','course_provider','priority','demand_pct','started_at','completed_at'];
            const patch = {};
            for (const k of allowed) { if (req.body?.[k] !== undefined) patch[k] = req.body[k]; }
            if (req.body?.status === 'in_progress' && !patch.started_at) patch.started_at = new Date().toISOString();
            if (req.body?.status === 'done' && !patch.completed_at) patch.completed_at = new Date().toISOString();
            const { data, error } = await supabase.from('study_plan_items').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('study_plan_items').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── search-alerts (N17) ────────────────────────────────────
    if (req.query.__h === 'search-alerts') {
        if (req.method === 'GET') {
            const { data, error } = await supabase.from('search_alerts').select('*').order('created_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ alerts: data ?? [] });
        }
        if (req.method === 'POST') {
            const { name, keywords, excludes, fontes, min_fit_score = 6, modalidade, frequencia_horas = 6, notification_mode = 'daily_digest', area_id } = req.body || {};
            if (!name || !keywords?.length) return res.status(400).json({ error: 'name e keywords obrigatórios' });
            const { data, error } = await supabase.from('search_alerts').insert({
                name: String(name).slice(0,100),
                keywords: Array.isArray(keywords) ? keywords.map(k => String(k).slice(0,80)) : [],
                excludes:  Array.isArray(excludes)  ? excludes.map(k => String(k).slice(0,80)) : [],
                fontes:    Array.isArray(fontes) ? fontes : ['gupy','linkedin','indeed'],
                min_fit_score: parseFloat(min_fit_score) || 6,
                modalidade: modalidade || null,
                frequencia_horas: parseInt(frequencia_horas,10) || 6,
                notification_mode: notification_mode || 'daily_digest',
                area_id: area_id || null,
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const allowed = ['name','keywords','excludes','fontes','min_fit_score','modalidade','frequencia_horas','notification_mode','active'];
            const patch = {};
            for (const k of allowed) { if (req.body?.[k] !== undefined) patch[k] = req.body[k]; }
            const { data, error } = await supabase.from('search_alerts').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('search_alerts').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── weekly-goals (N31) ────────────────────────────────────
    if (req.query.__h === 'weekly-goals') {
        if (req.method === 'GET') {
            const { data: prof } = await supabase.from('candidate_profile').select('weekly_goals').single();
            const goals = prof?.weekly_goals || { candidaturas_semana: 3, followups_semana: 1 };
            // Progresso desta semana (seg-dom)
            const now = new Date();
            const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1; // 0=seg
            const weekStart = new Date(now); weekStart.setDate(now.getDate() - dayOfWeek); weekStart.setHours(0,0,0,0);
            const [appsRes, followupRes] = await Promise.allSettled([
                supabase.from('job_applications').select('id', { count: 'exact', head: true }).gte('created_at', weekStart.toISOString()),
                supabase.from('followup_suggestions').select('id', { count: 'exact', head: true }).eq('status','sent').gte('sent_at', weekStart.toISOString()),
            ]);
            return res.status(200).json({
                goals,
                progress: {
                    candidaturas: appsRes.status === 'fulfilled' ? (appsRes.value.count ?? 0) : 0,
                    followups: followupRes.status === 'fulfilled' ? (followupRes.value.count ?? 0) : 0,
                },
                week_start: weekStart.toISOString(),
            });
        }
        if (req.method === 'PUT') {
            const { candidaturas_semana, followups_semana } = req.body || {};
            const goals = {
                candidaturas_semana: Math.min(30, Math.max(1, parseInt(candidaturas_semana, 10) || 3)),
                followups_semana:    Math.min(10, Math.max(0, parseInt(followups_semana, 10) || 1)),
            };
            const { error } = await supabase.from('candidate_profile').update({ weekly_goals: goals, updated_at: new Date().toISOString() }).not('id', 'is', null);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true, goals });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── briefing-build (N11) ──────────────────────────────────
    if (req.query.__h === 'briefing-build') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { application_id } = req.query;
        if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });

        const [appRes, interviewRes, notesRes, qaRes, profileRes, starsRes] = await Promise.allSettled([
            supabase.from('job_applications').select('*, vaga_radar(fit_score, gaps, suspicious_flags, nivel, nivel_alvo, modalidade, faixa_salarial, descricao)').eq('id', application_id).single(),
            supabase.from('interview_sessions').select('*').eq('application_id', application_id).eq('status', 'planned').gte('interview_at', new Date().toISOString()).order('interview_at').limit(1),
            supabase.from('context_notes').select('*').eq('application_id', application_id).order('created_at', { ascending: false }).limit(5),
            supabase.from('interview_qa').select('question,answer,category,difficulty').order('use_count', { ascending: false }).limit(10),
            supabase.from('candidate_profile').select('nome,nivel_atual,skills_core,skills_evolucao,candidate_areas(nome,descricao)').single(),
            supabase.from('star_stories').select('id,title,competencies,themes,result,importance').order('importance', { ascending: false }).limit(6),
        ]);

        const app      = appRes.status === 'fulfilled' ? appRes.value.data : null;
        if (!app) return res.status(404).json({ error: 'Candidatura não encontrada' });

        const interview = interviewRes.status === 'fulfilled' ? (interviewRes.value.data?.[0] || null) : null;
        const notes     = notesRes.status === 'fulfilled' ? (notesRes.value.data ?? []) : [];
        const qa        = qaRes.status === 'fulfilled' ? (qaRes.value.data ?? []) : [];
        const profile   = profileRes.status === 'fulfilled' ? profileRes.value.data : null;
        const radar     = app.vaga_radar || {};
        const stars     = starsRes.status === 'fulfilled' ? (starsRes.value.data ?? []) : [];

        const stages = (app.stages || []).filter(s => s.active !== false);
        const completedStages = stages.filter(s => s.completed_at || s.notes);

        return res.status(200).json({
            app: { id: app.id, empresa: app.empresa, vaga: app.vaga, data_envio: app.data_envio, result: app.result, gestor_nome: app.gestor_nome, gestor_email: app.gestor_email, link_vaga: app.link_vaga },
            interview,
            stages: completedStages,
            notes,
            qa,
            stars,
            radar: { fit_score: radar.fit_score, gaps: radar.gaps, suspicious_flags: radar.suspicious_flags, nivel_alvo: radar.nivel_alvo, modalidade: radar.modalidade, faixa_salarial: radar.faixa_salarial },
            profile: profile ? { nome: profile.nome, nivel: profile.nivel_atual, skills_core: profile.skills_core, skills_evolucao: profile.skills_evolucao } : null,
        });
    }

    // ── advance-confidence (N2) ────────────────────────────────
    if (req.query.__h === 'advance-confidence') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { radar_id } = req.query;
        if (!radar_id) return res.status(400).json({ error: 'radar_id obrigatório' });

        const { data: lead } = await supabase.from('vaga_radar').select('fit_score, gaps, suspicious_flags, empresa, vaga, nivel_alvo').eq('id', radar_id).single();
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        // Histórico de candidaturas com origin_radar_id (tem fit_score correlato)
        const { data: history } = await supabase.from('job_applications').select('result, origin_radar_id, vaga_radar(fit_score)').not('origin_radar_id', 'is', null).order('created_at', { ascending: false }).limit(50);
        const concluded = (history || []).filter(a => a.result && a.result !== 'em_processo');
        const advanced  = concluded.filter(a => !['recusado', 'desistência', 'ghost'].includes(a.result));
        const rate = concluded.length > 0 ? Math.round((advanced.length / concluded.length) * 100) : null;

        // Fator de ajuste pelo fit_score da vaga atual vs média das avançadas
        const fitScore = lead.fit_score || 0;
        const confidenceAdjusted = rate !== null ? Math.min(95, Math.max(5, Math.round(rate * (0.5 + fitScore / 20)))) : null;

        return res.status(200).json({
            fit_score:          fitScore,
            gaps:               lead.gaps || [],
            suspicious_flags:   lead.suspicious_flags || [],
            total_concluded:    concluded.length,
            total_advanced:     advanced.length,
            historical_rate:    rate,
            advance_confidence: confidenceAdjusted,
            empresa:            lead.empresa,
            vaga:               lead.vaga,
        });
    }

    // ── inbox ─────────────────────────────────────────────────
    // N7 — Smart Inbox: agrega todos os itens pendentes por prioridade
    if (req.query.__h === 'inbox') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const now = new Date();
        const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
        const in2h = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();

        const [radarRes, followupRes, msgPendingRes, interviewTodayRes, emailUnreadRes, contactTouchRes] = await Promise.allSettled([
            // Novos leads com fit alto
            supabase.from('vaga_radar').select('id,empresa,vaga,fit_score,created_at,status').eq('status','novo').gte('fit_score', 7).order('fit_score', { ascending: false }).limit(5),
            // Follow-ups pendentes
            supabase.from('followup_suggestions').select('id,application_id,days_idle,current_stage,suggested_message,detected_at').eq('status','pending').order('days_idle', { ascending: false }).limit(10),
            // Candidaturas com mensagem não enviada
            supabase.from('job_applications').select('id,empresa,vaga,application_message_text').eq('result','em_processo').eq('application_message_sent', false).not('application_message_text','is',null).limit(5),
            // Entrevistas hoje
            supabase.from('interview_sessions').select('id,application_id,stage_name,interview_at,interviewer_name,job_applications(empresa,vaga)').eq('status','planned').lte('interview_at', todayEnd.toISOString()).gte('interview_at', now.toISOString()).limit(5),
            // Emails não lidos vinculados
            supabase.from('email_thread_links').select('id,application_id,subject_snippet,sender_name,last_email_at').gt('unread_count', 0).order('last_email_at', { ascending: false }).limit(5),
            // Contatos com touch atrasado
            supabase.from('contacts').select('id,name,empresa,role,next_touch_at,last_contact_at').lte('next_touch_at', now.toISOString()).not('next_touch_at','is',null).order('next_touch_at').limit(5),
        ]);

        const items = [];

        for (const s of interviewTodayRes.status === 'fulfilled' ? (interviewTodayRes.value.data ?? []) : []) {
            const dt = new Date(s.interview_at);
            const minLeft = Math.round((dt - now) / 60000);
            items.push({ priority: 'critico', category: 'entrevista_hoje', id: s.id, title: `Entrevista${s.stage_name ? ' ' + s.stage_name : ''} com ${s.interviewer_name || 'recrutador'}`, subtitle: `${s.job_applications?.empresa || ''} — em ${minLeft}min`, ts: s.interview_at, entity_type: 'interview', entity_id: s.id, application_id: s.application_id, actions: [{ type:'open_application', id: s.application_id, label:'Abrir candidatura' }, { type:'dismiss', label:'Dispensar' }] });
        }
        for (const e of emailUnreadRes.status === 'fulfilled' ? (emailUnreadRes.value.data ?? []) : []) {
            items.push({ priority: 'alto', category: 'email_nao_lido', id: e.id, title: `E-mail: ${e.subject_snippet || 'nova mensagem'}`, subtitle: `De: ${e.sender_name || '—'}`, ts: e.last_email_at, entity_type: 'email_thread', entity_id: e.id, application_id: e.application_id, actions: [{ type:'open_application', id: e.application_id, label:'Ver candidatura' }, { type:'dismiss', label:'Marcar lido' }] });
        }
        for (const r of radarRes.status === 'fulfilled' ? (radarRes.value.data ?? []) : []) {
            items.push({ priority: 'alto', category: 'lead_alto_fit', id: r.id, title: `Novo lead: ${r.vaga || r.empresa}`, subtitle: `${r.empresa} — fit ${r.fit_score}`, ts: r.created_at, entity_type: 'lead', entity_id: r.id, actions: [{ type:'dismiss', label:'Dispensar' }] });
        }
        for (const f of followupRes.status === 'fulfilled' ? (followupRes.value.data ?? []) : []) {
            items.push({ priority: 'medio', category: 'followup_due', id: f.id, title: `Follow-up: ${f.current_stage || 'candidatura parada'}`, subtitle: `${f.days_idle} dias sem atualização`, ts: f.detected_at, entity_type: 'followup', entity_id: f.id, application_id: f.application_id, suggested_message: f.suggested_message, actions: [{ type:'open_application', id: f.application_id, label:'Ver candidatura' }, { type:'snooze', label:'+1d' }, { type:'dismiss', label:'Dispensar' }] });
        }
        for (const m of msgPendingRes.status === 'fulfilled' ? (msgPendingRes.value.data ?? []) : []) {
            items.push({ priority: 'medio', category: 'mensagem_pendente', id: m.id, title: `Mensagem pronta: ${m.empresa}`, subtitle: m.vaga || 'Candidatura com mensagem não enviada', ts: null, entity_type: 'application', entity_id: m.id, application_id: m.id, actions: [{ type:'open_application', id: m.id, label:'Abrir' }, { type:'dismiss', label:'Dispensar' }] });
        }
        for (const c of contactTouchRes.status === 'fulfilled' ? (contactTouchRes.value.data ?? []) : []) {
            items.push({ priority: 'baixo', category: 'contact_touch', id: c.id, title: `Manter contato: ${c.name}`, subtitle: `${c.role || ''}${c.empresa ? ' @ ' + c.empresa : ''}`, ts: c.next_touch_at, entity_type: 'contact', entity_id: c.id, actions: [{ type:'dismiss', label:'Dispensar' }, { type:'snooze', label:'+1d' }] });
        }

        const ORDER = { critico: 0, alto: 1, medio: 2, baixo: 3 };
        items.sort((a, b) => (ORDER[a.priority] ?? 9) - (ORDER[b.priority] ?? 9));
        return res.status(200).json({ items });
    }

    // ── vault (N4) ────────────────────────────────────────────
    if (req.query.__h === 'vault-list') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { data, error } = await supabase.from('personal_documents').select('id,doc_type,display_name,filename,mime_type,size_bytes,validade,tags,notes,use_count,uploaded_at,last_used_at').order('doc_type').order('uploaded_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ docs: data ?? [] });
    }

    if (req.query.__h === 'vault-register') {
        // Recebe base64_content + metadados, faz upload no Storage e registra na tabela
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { doc_type, display_name, filename, mime_type, size_bytes, validade, notes, base64_content } = req.body || {};
        if (!doc_type || !display_name || !filename || !mime_type || !base64_content) return res.status(400).json({ error: 'Campos obrigatórios: doc_type, display_name, filename, mime_type, base64_content' });
        const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
        const storage_path = `docs/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const fileBuffer = Buffer.from(base64_content, 'base64');
        const { error: upErr } = await supabase.storage.from('vault').upload(storage_path, fileBuffer, { contentType: mime_type, upsert: false });
        if (upErr) return res.status(500).json({ error: `Storage: ${upErr.message}` });
        const { data, error } = await supabase.from('personal_documents').insert({
            doc_type:     String(doc_type).slice(0, 30),
            display_name: String(display_name).slice(0, 100),
            filename:     String(filename).slice(0, 200),
            storage_path,
            mime_type:    String(mime_type).slice(0, 80),
            size_bytes:   size_bytes ? parseInt(size_bytes, 10) : fileBuffer.length,
            validade:     validade || null,
            notes:        notes ? String(notes).slice(0, 500) : null,
        }).select().single();
        if (error) { await supabase.storage.from('vault').remove([storage_path]); return res.status(500).json({ error: error.message }); }
        return res.status(201).json(data);
    }

    if (req.query.__h === 'vault-download-url') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });
        const { data: doc } = await supabase.from('personal_documents').select('storage_path, display_name').eq('id', id).single();
        if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
        const { data: urlData, error } = await supabase.storage.from('vault').createSignedUrl(doc.storage_path, 120);
        if (error) return res.status(500).json({ error: error.message });
        await supabase.from('personal_documents').update({ last_used_at: new Date().toISOString() }).eq('id', id);
        return res.status(200).json({ url: urlData.signedUrl, filename: doc.display_name });
    }

    if (req.query.__h === 'vault-delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });
        const { data: doc } = await supabase.from('personal_documents').select('storage_path').eq('id', id).single();
        if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
        await supabase.storage.from('vault').remove([doc.storage_path]);
        const { error } = await supabase.from('personal_documents').delete().eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(204).end();
    }

    // ── email-threads (N8) ────────────────────────────────────
    if (req.query.__h === 'email-threads') {
        if (req.method === 'GET') {
            const { application_id } = req.query;
            if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
            const { data, error } = await supabase.from('email_thread_links').select('*').eq('application_id', application_id).order('last_email_at', { ascending: false });
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ threads: data ?? [] });
        }
        if (req.method === 'POST') {
            const { thread_id, application_id, subject_snippet, sender_name, sender_email, link_method = 'manual', link_confidence = 1.0 } = req.body || {};
            if (!thread_id || !application_id) return res.status(400).json({ error: 'thread_id e application_id obrigatórios' });
            const { data, error } = await supabase.from('email_thread_links').upsert({
                thread_id, application_id,
                link_method, link_confidence,
                subject_snippet: subject_snippet ? String(subject_snippet).slice(0, 200) : null,
                sender_name:     sender_name ? String(sender_name).slice(0, 100) : null,
                sender_email:    sender_email ? String(sender_email).slice(0, 120) : null,
                status: 'confirmed',
                last_email_at: new Date().toISOString(),
            }, { onConflict: 'thread_id' }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('email_thread_links').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── contacts (N25) ────────────────────────────────────────
    if (req.query.__h === 'contacts') {
        if (req.method === 'GET') {
            const { id } = req.query;
            if (id) {
                const { data, error } = await supabase.from('contacts').select('*, contact_interactions(*)').eq('id', id).single();
                if (error || !data) return res.status(404).json({ error: 'Contato não encontrado' });
                return res.status(200).json(data);
            }
            const search = req.query.q ? String(req.query.q).trim() : '';
            let q = supabase.from('contacts').select('*').order('next_touch_at', { ascending: true, nullsFirst: false }).order('name');
            if (search) q = q.or(`name.ilike.%${search}%,empresa.ilike.%${search}%,role.ilike.%${search}%`);
            const { data, error } = await q.limit(100);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ contacts: data ?? [] });
        }
        if (req.method === 'POST') {
            const { name, role, empresa, email, phone, linkedin_url, source, source_ref, relationship_strength = 3, notes, tags, preferred_contact_method, contact_frequency_months = 6 } = req.body || {};
            if (!name) return res.status(400).json({ error: 'name obrigatório' });
            const row = {
                name:                     String(name).slice(0, 100),
                role:                     role ? String(role).slice(0, 100) : null,
                empresa:                  empresa ? String(empresa).slice(0, 200) : null,
                email:                    email ? String(email).slice(0, 120) : null,
                phone:                    phone ? String(phone).slice(0, 30) : null,
                linkedin_url:             linkedin_url ? String(linkedin_url).slice(0, 300) : null,
                source:                   source ? String(source).slice(0, 100) : 'manual',
                source_ref:               source_ref ? String(source_ref).slice(0, 200) : null,
                relationship_strength:    Math.min(5, Math.max(1, parseInt(relationship_strength, 10) || 3)),
                notes:                    notes ? String(notes).slice(0, 2000) : null,
                tags:                     Array.isArray(tags) ? tags.map(t => String(t).slice(0, 50)) : [],
                preferred_contact_method: preferred_contact_method ? String(preferred_contact_method).slice(0, 20) : null,
                contact_frequency_months: Math.min(24, Math.max(1, parseInt(contact_frequency_months, 10) || 6)),
            };
            const { data, error } = await supabase.from('contacts').insert(row).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const allowed = ['name','role','empresa','email','phone','linkedin_url','notes','tags','relationship_strength','preferred_contact_method','contact_frequency_months','next_touch_at','last_contact_at','last_contact_via'];
            const patch = { updated_at: new Date().toISOString() };
            for (const k of allowed) {
                if (req.body?.[k] !== undefined) patch[k] = req.body[k];
            }
            const { data, error } = await supabase.from('contacts').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('contacts').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── contact-interactions (N25) ────────────────────────────
    if (req.query.__h === 'contact-interactions') {
        if (req.method === 'POST') {
            const { contact_id, channel, direction = 'outbound', summary, topics } = req.body || {};
            if (!contact_id) return res.status(400).json({ error: 'contact_id obrigatório' });
            const { data, error } = await supabase.from('contact_interactions').insert({
                contact_id, channel: channel || null, direction,
                summary: String(summary).slice(0, 1000),
                topics: Array.isArray(topics) ? topics : [],
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            // Atualiza last_contact_at e recalcula next_touch_at
            const { data: contact } = await supabase.from('contacts').select('contact_frequency_months').eq('id', contact_id).single();
            const freqMonths = contact?.contact_frequency_months || 6;
            const nextTouch = new Date(); nextTouch.setMonth(nextTouch.getMonth() + freqMonths);
            await supabase.from('contacts').update({ last_contact_at: new Date().toISOString(), last_contact_via: channel || null, next_touch_at: nextTouch.toISOString(), updated_at: new Date().toISOString() }).eq('id', contact_id);
            return res.status(201).json(data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── market-trends (N18) ───────────────────────────────────────
    if (req.query.__h === 'market-trends') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        const since = new Date(); since.setMonth(since.getMonth() - 6);
        const [radarRes, appsRes] = await Promise.allSettled([
            supabase.from('vaga_radar').select('status,fit_score,modalidade,tipo_contratacao,nivel,fonte,created_at,faixa_salarial,keywords_match').gte('created_at', since.toISOString()),
            supabase.from('job_applications').select('result,created_at,empresa,stages').gte('created_at', since.toISOString()),
        ]);

        const leads = radarRes.status === 'fulfilled' ? (radarRes.value.data ?? []) : [];
        const apps  = appsRes.status === 'fulfilled'  ? (appsRes.value.data  ?? []) : [];

        // Modalidade distribution
        const modalidade = {};
        leads.forEach(l => { const k = l.modalidade || 'Não informado'; modalidade[k] = (modalidade[k]||0)+1; });

        // Status distribution
        const status = {};
        leads.forEach(l => { const k = l.status || 'novo'; status[k] = (status[k]||0)+1; });

        // Fit score buckets
        const fitBuckets = { '0-4': 0, '5-6': 0, '7-8': 0, '9-10': 0 };
        leads.forEach(l => {
            const s = l.fit_score || 0;
            if (s <= 4) fitBuckets['0-4']++;
            else if (s <= 6) fitBuckets['5-6']++;
            else if (s <= 8) fitBuckets['7-8']++;
            else fitBuckets['9-10']++;
        });

        // Top keywords
        const kwFreq = {};
        leads.forEach(l => (l.keywords_match || []).forEach(k => { kwFreq[k] = (kwFreq[k]||0)+1; }));
        const topKeywords = Object.entries(kwFreq).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>({ skill: k, count: v }));

        // Leads per month
        const monthlyLeads = {};
        leads.forEach(l => { const m = l.created_at?.slice(0,7); if (m) monthlyLeads[m] = (monthlyLeads[m]||0)+1; });

        // Apps per month + results
        const monthlyApps = {};
        apps.forEach(a => {
            const m = a.created_at?.slice(0,7);
            if (!m) return;
            if (!monthlyApps[m]) monthlyApps[m] = { total: 0, aprovado: 0, recusado: 0 };
            monthlyApps[m].total++;
            if (a.result === 'aprovado') monthlyApps[m].aprovado++;
            if (a.result === 'recusado') monthlyApps[m].recusado++;
        });

        // Fonte distribution
        const fonte = {};
        leads.forEach(l => { const k = l.fonte || 'manual'; fonte[k] = (fonte[k]||0)+1; });

        // Conversion rate
        const concluded = apps.filter(a => a.result && a.result !== 'em_processo');
        const advanced  = apps.filter(a => a.result === 'aprovado');
        const convRate  = concluded.length > 0 ? Math.round(advanced.length / apps.length * 100) : null;

        return res.status(200).json({
            total_leads: leads.length,
            total_apps:  apps.length,
            conversion_rate_pct: convRate,
            modalidade,
            status,
            fit_buckets: fitBuckets,
            top_keywords: topKeywords,
            monthly_leads: monthlyLeads,
            monthly_apps: monthlyApps,
            fonte,
            period_months: 6,
        });
    }

    // ── career-journal (N15) ──────────────────────────────────────
    if (req.query.__h === 'career-journal') {
        if (req.method === 'GET') {
            const { scope, scope_ref } = req.query;
            let q = supabase.from('career_journal').select('*').order('generated_at', { ascending: false });
            if (scope)     q = q.eq('scope', scope);
            if (scope_ref) q = q.eq('scope_ref', scope_ref);
            const { data, error } = await q.limit(20);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ entries: data ?? [] });
        }
        if (req.method === 'POST') {
            const { scope = 'manual', scope_ref, title, content_markdown, highlights, applications_included } = req.body || {};
            // Se scope='month' e scope_ref não fornecido, usa mês atual
            const ref = scope_ref || (scope === 'month' ? new Date().toISOString().slice(0,7) : null);
            if (!content_markdown && scope === 'manual') return res.status(400).json({ error: 'content_markdown obrigatório para entradas manuais' });

            let finalContent = content_markdown || '';
            let generated_by = 'manual';

            if (!content_markdown && scope === 'month') {
                // Agrega candidaturas do mês e gera resumo simples
                const [startDate] = ref ? [new Date(ref + '-01')] : [new Date()];
                const endDate = new Date(startDate); endDate.setMonth(endDate.getMonth() + 1);
                const { data: apps } = await supabase.from('job_applications')
                    .select('empresa,vaga,result,stages,created_at')
                    .gte('created_at', startDate.toISOString())
                    .lt('created_at', endDate.toISOString())
                    .order('created_at');
                const total = (apps || []).length;
                const aprovadas = (apps || []).filter(a => a.result === 'aprovado').length;
                const recusadas = (apps || []).filter(a => a.result === 'recusado').length;
                const emProcesso = (apps || []).filter(a => a.result === 'em_processo' || !a.result).length;
                const empresas = [...new Set((apps || []).map(a => a.empresa).filter(Boolean))].slice(0, 8).join(', ');
                finalContent = `# Diário de ${ref || 'mês atual'}\n\n` +
                    `## Resumo\n\n` +
                    `- **Total de candidaturas:** ${total}\n` +
                    `- **Em processo:** ${emProcesso}\n` +
                    `- **Aprovadas:** ${aprovadas}\n` +
                    `- **Recusadas:** ${recusadas}\n\n` +
                    (empresas ? `## Empresas\n\n${empresas}\n\n` : '') +
                    `## Notas\n\n*(adicione suas reflexões aqui)*`;
                generated_by = 'auto';
            }

            const { data, error } = await supabase.from('career_journal').insert({
                scope, scope_ref: ref, title: title || `Diário ${ref || scope}`,
                content_markdown: finalContent,
                highlights: highlights || null,
                applications_included: applications_included || null,
                generated_by,
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const allowed = ['title','content_markdown','highlights'];
            const patch = {};
            for (const k of allowed) { if (req.body?.[k] !== undefined) patch[k] = req.body[k]; }
            const { data, error } = await supabase.from('career_journal').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('career_journal').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(204).end();
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── email-detect-rejection (N10) ──────────────────────────────
    if (req.query.__h === 'email-detect-rejection') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { application_id, thread_id, subject, body_snippet, sender_email } = req.body || {};
        if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });

        const REJECTION_KW = ['infelizmente','não avançou','não seguiremos','another direction','we decided','regrettably','agradecemos','we will not','optamos por','outro perfil','não avançar','encerramos','não continuar'];
        const text = ((subject || '') + ' ' + (body_snippet || '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const isRejection = REJECTION_KW.some(kw => text.includes(kw.normalize('NFD').replace(/[̀-ͯ]/g, '')));

        if (!isRejection) return res.status(200).json({ detected: false });

        // Marca candidatura como recusada
        const { data: app } = await supabase.from('job_applications').select('result,empresa,vaga').eq('id', application_id).single();
        if (app && app.result === 'em_processo') {
            await supabase.from('job_applications').update({ result: 'recusado', updated_at: new Date().toISOString() }).eq('id', application_id);
        }

        // Cria sugestão de follow-up (agradecimento + porta aberta)
        const { data: existing } = await supabase.from('followup_suggestions')
            .select('id').eq('application_id', application_id).eq('reason', 'rejection_acknowledgement').eq('status', 'pending').maybeSingle();

        if (!existing) {
            const message = `Olá,\n\nObrigado pela consideração e pelo tempo investido no processo seletivo da ${app?.empresa || 'empresa'}.\n\nApreciaria muito um feedback sobre o processo, caso seja possível compartilhar. Sigo disponível e animado com o trabalho que vocês fazem — espero que possamos colaborar no futuro.\n\nAtenciosamente`;
            await supabase.from('followup_suggestions').insert({
                application_id,
                days_idle: 0,
                current_stage: 'Recusado',
                suggested_message: message,
                status: 'pending',
                reason: 'rejection_acknowledgement',
            });
        }

        return res.status(200).json({ detected: true, created_followup: !existing });
    }

    // ── values-weights (N42) ──────────────────────────────────────
    if (req.query.__h === 'values-weights') {
        if (req.method === 'GET') {
            const { data: prof } = await supabase.from('candidate_profile').select('values_weights,expected_salary_min,expected_salary_max').single();
            return res.status(200).json({
                weights: prof?.values_weights || { salario: 0.30, proposito: 0.10, wlb: 0.20, growth: 0.20, seguranca: 0.10, autonomia: 0.10 },
                expected_salary_min: prof?.expected_salary_min || null,
                expected_salary_max: prof?.expected_salary_max || null,
            });
        }
        if (req.method === 'PUT') {
            const { weights, expected_salary_min, expected_salary_max } = req.body || {};
            const patch = { updated_at: new Date().toISOString() };
            if (weights && typeof weights === 'object') patch.values_weights = weights;
            if (expected_salary_min != null) patch.expected_salary_min = Math.max(0, parseInt(expected_salary_min, 10) || 0);
            if (expected_salary_max != null) patch.expected_salary_max = Math.max(0, parseInt(expected_salary_max, 10) || 0);
            const { error } = await supabase.from('candidate_profile').update(patch).not('id', 'is', null);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── notification-settings (N29/N30) ──────────────────────────
    if (req.query.__h === 'notification-settings') {
        if (req.method === 'GET') {
            const { data: prof } = await supabase.from('candidate_profile').select('notification_settings').single();
            return res.status(200).json({ settings: prof?.notification_settings || {} });
        }
        if (req.method === 'PUT') {
            const { settings } = req.body || {};
            if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings obrigatório' });
            const { error } = await supabase.from('candidate_profile').update({ notification_settings: settings, updated_at: new Date().toISOString() }).not('id', 'is', null);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── linkedin-update (N14) ─────────────────────────────────────
    if (req.query.__h === 'linkedin-update') {
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { linkedin_update_status, linkedin_update_applied_at } = req.body || {};
            const patch = {};
            if (linkedin_update_status) patch.linkedin_update_status = String(linkedin_update_status).slice(0,20);
            if (linkedin_update_applied_at) patch.linkedin_update_applied_at = linkedin_update_applied_at;
            const { data, error } = await supabase.from('job_applications').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── onboarding (N33) ──────────────────────────────────────────
    if (req.query.__h === 'onboarding') {
        if (req.method === 'GET') {
            const { id, application_id } = req.query;
            if (id) {
                const { data, error } = await supabase.from('onboarding_processes').select('*').eq('id', id).single();
                if (error) return res.status(404).json({ error: error.message });
                return res.status(200).json({ onboarding: data });
            }
            if (application_id) {
                const { data, error } = await supabase.from('onboarding_processes').select('*').eq('application_id', application_id).order('created_at', { ascending: false }).limit(1);
                if (error) return res.status(500).json({ error: error.message });
                return res.status(200).json({ onboarding: data?.[0] || null });
            }
            const { data, error } = await supabase.from('onboarding_processes').select('*, job_applications(empresa,vaga)').eq('status', 'in_progress').order('created_at', { ascending: false }).limit(20);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ items: data ?? [] });
        }
        if (req.method === 'POST') {
            const { application_id, start_date, company, role, documents_due_date, exam_date, first_day_at, notes } = req.body || {};
            if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
            const DEFAULT_CHECKLIST = [
                { id: 'rg', label: 'RG', done: false, category: 'docs' },
                { id: 'cpf', label: 'CPF', done: false, category: 'docs' },
                { id: 'comprov_end', label: 'Comprovante de endereço', done: false, category: 'docs' },
                { id: 'ctps', label: 'Carteira de Trabalho', done: false, category: 'docs' },
                { id: 'diploma', label: 'Diploma / comprovante escolaridade', done: false, category: 'docs' },
                { id: 'foto', label: 'Foto 3x4', done: false, category: 'docs' },
                { id: 'exame_adm', label: 'Exame admissional agendado', done: false, category: 'health' },
                { id: 'calendar', label: 'Primeiro dia marcado no Calendar', done: false, category: 'prep' },
                { id: 'linkedin', label: 'LinkedIn atualizado com nova empresa', done: false, category: 'prep' },
                { id: 'setup', label: 'Setup de ambiente solicitado', done: false, category: 'prep' },
            ];
            const { data, error } = await supabase.from('onboarding_processes').insert({
                application_id,
                start_date: start_date || null,
                company: company ? String(company).slice(0,200) : null,
                role: role ? String(role).slice(0,200) : null,
                checklist: DEFAULT_CHECKLIST,
                documents_due_date: documents_due_date || null,
                exam_date: exam_date || null,
                first_day_at: first_day_at || null,
                notes: notes ? String(notes).slice(0,2000) : null,
                status: 'in_progress',
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'PUT') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const allowed = ['start_date','company','role','checklist','documents_due_date','exam_date','first_day_at','notes','status'];
            const patch = { updated_at: new Date().toISOString() };
            for (const k of allowed) { if (req.body?.[k] !== undefined) patch[k] = req.body[k]; }
            const { data, error } = await supabase.from('onboarding_processes').update(patch).eq('id', id).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json(data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ─── N26 — Mensagem de relacionamento para contato ───────────────────────
    if (req.query.__h === 'contact-message') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
        const { contact_id, reason } = req.body || {};
        if (!contact_id) return res.status(400).json({ error: 'contact_id obrigatório' });

        const { data: contact, error: cErr } = await supabase.from('contacts').select('*').eq('id', contact_id).single();
        if (cErr || !contact) return res.status(404).json({ error: 'Contato não encontrado' });

        const { data: interactions } = await supabase.from('contact_interactions')
            .select('*').eq('contact_id', contact_id).order('interaction_at', { ascending: false }).limit(3);

        const ctxStr = (interactions || []).map(i => `- ${i.interaction_at?.slice(0,10)}: ${i.channel} — ${i.summary || '(sem resumo)'}`).join('\n');
        const reasonStr = reason ? `Motivo: ${reason}` : 'Touch regular de manutenção de rede';

        const prompt = `Gere 3 mensagens profissionais em pt-BR para enviar a ${contact.name || 'este contato'}, ${contact.role || ''}${contact.empresa ? ' na empresa ' + contact.empresa : ''}.
${reasonStr}
Histórico de interações recentes:
${ctxStr || '(sem interações anteriores)'}

Estilos:
1. Formal: profissional e respeitoso
2. Casual: amigável, tom de colega
3. Informal: descontraído, próximo

Cada mensagem: máx 150 palavras, sem bajulação, sem tom desesperado. JSON:
{"formal":"...","casual":"...","informal":"..."}`;

        try {
            const { routeChat } = await import('../_lib/llm-router.js');
            const r = await routeChat({ taskType: 'message', messages: [{ role: 'user', content: prompt }], maxTokens: 600, temperature: 0.7 });
            const txt = r.content.trim();
            const jsonStart = txt.indexOf('{');
            const jsonEnd = txt.lastIndexOf('}');
            if (jsonStart === -1) return res.status(200).json({ messages: { formal: txt, casual: txt, informal: txt } });
            const parsed = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
            return res.status(200).json({ messages: parsed });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // ─── N34 — Plano 30/60/90 dias ──────────────────────────────────────────
    if (req.query.__h === 'plan-30-60-90') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
        const { application_id } = req.body || {};
        if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });

        const { data: app } = await supabase.from('job_applications').select('empresa,vaga,nivel,descricao,tipo_contratacao').eq('id', application_id).single();
        if (!app) return res.status(404).json({ error: 'Candidatura não encontrada' });

        const prompt = `Gere um plano 30-60-90 dias para ${app.vaga || 'novo cargo'} na empresa ${app.empresa || 'empresa'}${app.nivel ? ', nível ' + app.nivel : ''}.
Tipo de contratação: ${app.tipo_contratacao || 'não informado'}.
Descrição resumida: ${(app.descricao || '').slice(0, 300)}

Formato JSON com 3 blocos. Cada bloco: 4 objetivos concisos e acionáveis.
{
  "dias_30": {"foco":"...", "objetivos":["...","...","...","..."]},
  "dias_60": {"foco":"...", "objetivos":["...","...","...","..."]},
  "dias_90": {"foco":"...", "objetivos":["...","...","...","..."]}
}`;

        try {
            const { routeChat } = await import('../_lib/llm-router.js');
            const r = await routeChat({ taskType: 'analysis', messages: [{ role: 'user', content: prompt }], maxTokens: 700, temperature: 0.3 });
            const txt = r.content.trim();
            const jsonStart = txt.indexOf('{');
            const jsonEnd = txt.lastIndexOf('}');
            if (jsonStart === -1) throw new Error('LLM não retornou JSON');
            const plan = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
            return res.status(200).json({ plan });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // ─── N35 — Manter rede aquecida pós-contratação ──────────────────────────
    if (req.query.__h === 'warm-network') {
        if (req.method === 'GET') {
            const { application_id } = req.query;
            if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
            // Candidaturas avançadas (chegaram a entrevista+) mas não aprovadas
            const { data: apps } = await supabase.from('job_applications')
                .select('id,empresa,vaga,recruiter_name,recruiter_email,stages')
                .neq('id', application_id)
                .in('result', ['recusado', 'desistiu'])
                .order('updated_at', { ascending: false })
                .limit(50);

            const suggestions = (apps || []).filter(a => {
                const stages = Array.isArray(a.stages) ? a.stages : [];
                return stages.some(s => ['entrevista','tecnica','proposta','rh','gestor'].some(k => (s.label||s.stage||'').toLowerCase().includes(k)));
            }).slice(0, 10).map(a => ({
                application_id: a.id,
                empresa: a.empresa,
                vaga: a.vaga,
                recruiter_name: a.recruiter_name || null,
                recruiter_email: a.recruiter_email || null,
                suggested_notes: `Candidato para ${a.vaga} em ${a.empresa} — chegou à etapa avançada`,
            }));

            return res.status(200).json({ suggestions });
        }
        if (req.method === 'POST') {
            // Cria contatos em massa
            const { contacts: toCreate } = req.body || {};
            if (!Array.isArray(toCreate) || !toCreate.length) return res.status(400).json({ error: 'contacts[] obrigatório' });
            const now = new Date();
            const rows = toCreate.map(c => ({
                name:   String(c.name || c.recruiter_name || 'Recrutador').slice(0, 200),
                empresa: c.empresa ? String(c.empresa).slice(0, 200) : null,
                role:   c.role || null,
                email:  c.email || c.recruiter_email || null,
                source: c.application_id ? `vaga:${c.application_id}` : 'warm-network',
                source_ref: c.application_id || null,
                notes:  c.suggested_notes || null,
                relationship_strength: 2,
                contact_frequency_months: 6,
                next_touch_at: new Date(now.getTime() + 180 * 86400000).toISOString(),
            }));
            const { data, error } = await supabase.from('contacts').insert(rows).select('id');
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json({ created: data?.length || 0 });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ─── N13 — Interviewer intel ─────────────────────────────────────────────
    if (req.query.__h === 'interviewer-intel') {
        if (req.method === 'GET') {
            const { name } = req.query;
            if (!name) return res.status(400).json({ error: 'name obrigatório' });
            const normalized = String(name).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').slice(0,100);
            const { data } = await supabase.from('interviewer_intel').select('*').eq('name_normalized', normalized).single();
            if (data) {
                const ageMs = Date.now() - new Date(data.fetched_at).getTime();
                if (ageMs < 14 * 86400000) return res.status(200).json({ intel: data, source: 'cache' });
            }
            return res.status(200).json({ intel: data || null, source: 'cache_stale' });
        }
        if (req.method === 'POST') {
            const { name, display_name, email, linkedin_url, company_at_match, role_title, years_in_role, bio_summary, recent_posts, topics_of_interest } = req.body || {};
            if (!name) return res.status(400).json({ error: 'name obrigatório' });
            const normalized = String(name).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').slice(0,100);
            const row = {
                name_normalized: normalized,
                display_name: display_name || name,
                email: email || null,
                linkedin_url: linkedin_url || null,
                company_at_match: company_at_match || null,
                role_title: role_title || null,
                years_in_role: parseInt(years_in_role)||null,
                bio_summary: bio_summary ? String(bio_summary).slice(0,2000) : null,
                recent_posts: Array.isArray(recent_posts) ? recent_posts : null,
                topics_of_interest: Array.isArray(topics_of_interest) ? topics_of_interest : null,
                fetched_at: new Date().toISOString(),
            };
            const { data, error } = await supabase.from('interviewer_intel').upsert(row, { onConflict: 'name_normalized' }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ intel: data });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ─── N28 — Mensagens da candidatura (timeline unificado) ─────────────────
    if (req.query.__h === 'application-messages') {
        const { application_id, id } = req.query;
        if (req.method === 'GET') {
            if (!application_id) return res.status(400).json({ error: 'application_id obrigatório' });
            const { data, error } = await supabase.from('application_messages')
                .select('*')
                .eq('application_id', application_id)
                .order('message_at', { ascending: false })
                .limit(50);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ messages: data ?? [] });
        }
        if (req.method === 'POST') {
            const { application_id: appId, channel, direction, sender_name, sender_email, subject, body: msgBody, message_at } = req.body || {};
            if (!appId || !channel) return res.status(400).json({ error: 'application_id e channel obrigatórios' });
            const { data, error } = await supabase.from('application_messages').insert({
                application_id: appId,
                channel: String(channel).slice(0,50),
                direction: direction || 'outbound',
                sender_name: sender_name ? String(sender_name).slice(0,200) : null,
                sender_email: sender_email ? String(sender_email).slice(0,200) : null,
                subject: subject ? String(subject).slice(0,500) : null,
                body: msgBody ? String(msgBody).slice(0,10000) : null,
                message_at: message_at || new Date().toISOString(),
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'DELETE') {
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('application_messages').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ─── N41 — Mapa de carreira ──────────────────────────────────────────────
    if (req.query.__h === 'career-paths') {
        if (req.method === 'GET') {
            const { from_role } = req.query;
            let q = supabase.from('career_paths').select('*').order('horizon_years').order('transition_difficulty');
            if (from_role) q = q.ilike('from_role', `%${from_role}%`);
            const { data, error } = await q.limit(50);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ paths: data ?? [] });
        }
        if (req.method === 'POST') {
            const { from_role, to_role, horizon_years, required_skills, skills_gap, median_salary_brl, transition_difficulty, notes } = req.body || {};
            if (!from_role || !to_role) return res.status(400).json({ error: 'from_role e to_role obrigatórios' });
            const { data, error } = await supabase.from('career_paths').insert({
                from_role: String(from_role).slice(0,200), to_role: String(to_role).slice(0,200),
                horizon_years: parseInt(horizon_years)||2,
                required_skills: Array.isArray(required_skills) ? required_skills : [],
                skills_gap: Array.isArray(skills_gap) ? skills_gap : [],
                median_salary_brl: parseInt(median_salary_brl)||null,
                transition_difficulty: Math.min(5, Math.max(1, parseInt(transition_difficulty)||3)),
                notes: notes ? String(notes).slice(0,500) : null,
            }).select().single();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(201).json(data);
        }
        if (req.method === 'DELETE') {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'id obrigatório' });
            const { error } = await supabase.from('career_paths').delete().eq('id', id);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ─── N3 — Company intel (Receita Federal + cache) ───────────────────────
    if (req.query.__h === 'company-intel') {
        const { empresa, cnpj } = req.query;
        if (!empresa && !cnpj) return res.status(400).json({ error: 'empresa ou cnpj obrigatório' });
        const supabaseClient = supabase;

        // Verificar cache (tabela company_intel se existir)
        try {
            const lookup = cnpj
                ? supabaseClient.from('company_intel').select('*').eq('cnpj', cnpj)
                : supabaseClient.from('company_intel').select('*').ilike('display_name', `%${empresa}%`).limit(1);
            const { data: cached } = await lookup.single();
            if (cached && cached.fetched_at) {
                const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
                if (ageMs < 30 * 86400000) return res.status(200).json({ intel: cached, source: 'cache' });
            }
        } catch(_) { /* tabela pode não existir ainda */ }

        // Busca na Receita Federal (API gratuita receitaws)
        const cnpjClean = cnpj ? cnpj.replace(/\D/g, '') : null;
        let rfData = null;
        if (cnpjClean && cnpjClean.length === 14) {
            try {
                const rfResp = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpjClean}`, {
                    headers: { 'Accept': 'application/json' },
                    signal: AbortSignal.timeout(10000),
                });
                if (rfResp.ok) rfData = await rfResp.json();
            } catch(_) {}
        }

        const intel = {
            display_name: rfData?.nome || empresa,
            cnpj: cnpjClean || null,
            situacao: rfData?.situacao || null,
            date_abertura: rfData?.abertura ? rfData.abertura.split('/').reverse().join('-') : null,
            size_employees: null,
            glassdoor_rating: null,
            red_flags: [],
            fetch_status: rfData ? 'success' : 'partial',
            fetched_at: new Date().toISOString(),
        };

        // Detectar red flags simples
        if (rfData?.situacao && rfData.situacao !== 'ATIVA') intel.red_flags.push('cnpj_inativo');
        if (rfData?.abertura) {
            const years = (Date.now() - new Date(intel.date_abertura).getTime()) / (365 * 86400000);
            if (years < 1) intel.red_flags.push('empresa_nova');
        }

        // Tentar salvar no cache
        try {
            await supabaseClient.from('company_intel').upsert({
                ...intel,
                empresa_normalized: (empresa || rfData?.nome || '').toLowerCase().replace(/\s+/g, '-').slice(0, 100),
            }, { onConflict: 'cnpj' });
        } catch(_) {}

        return res.status(200).json({ intel, source: 'api' });
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
