// ============================================================
// Radar de Vagas — endpoint consolidado (Vercel Hobby: 1 função)
// Sub-rotas via ?__h=  (rewrites no vercel.json):
//   (default)      → CRUD de leads em vaga_radar + ?action=promote
//   ?__h=profile   → GET/PUT do candidate_profile (singleton)
//   ?__h=analysis  → GET (prompt ou auto) / PUT (salva análise) de um lead
// ============================================================
import { requireAdmin, cors } from '../_lib/auth.js';
import { getSupabase } from '../_lib/supabase.js';
import { DEFAULT_STAGES } from '../_lib/stages.js';
import { scoreVaga, detectSuspiciousFlags, computeReverseFit, computeAlignmentScore } from '../_lib/scoring.js';
import { isConfigured, analyze, providerInfo } from '../_lib/ai-provider.js';
import { buildAnalysisPrompt, parseAnalysisJson } from '../_lib/radar-prompt.js';

const TEXT_MAX = { empresa: 200, vaga: 200, link_vaga: 500, descricao: 8000, fonte: 40, nivel: 60, motivo_descarte: 500, localizacao: 120, generic: 160, requires_cnh: 10, fit_analysis: 4000 };
const VALID_MODALIDADE = new Set(['Presencial', 'Híbrida', 'Remota']);
const VALID_TIPO = new Set(['CLT', 'PJ', 'Freelancer', 'Cooperado', 'Temporário', 'Estágio', 'Autônomo']);
const VALID_STATUS = new Set(['novo', 'avaliada', 'promovida', 'descartada', 'arquivada']);

const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const INVISIBLE_CHARS = new RegExp('[\\u200B-\\u200D\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]', 'g');

function clean(str, max) {
    if (typeof str !== 'string') return null;
    return str.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '').trim().slice(0, max) || null;
}

function jsonArr(v, max = 60) {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === 'string').map((x) => clean(x, 120)).filter(Boolean).slice(0, max);
}

async function loadProfile(supabase) {
    const { data } = await supabase
        .from('candidate_profile')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || {};
}

// Aplica o resultado de análise (IA/manual/MCP) a um lead.
async function applyAnalysis(supabase, id, a) {
    const keywords = [...new Set([...(a.required_keywords || []), ...(a.nice_to_have_keywords || [])])];
    const patch = {
        fit_score_ia: a.fit_score,
        fit_score: a.fit_score, // o refinamento da IA passa a ser o valor exibido
        keywords_match: keywords,
        gaps: a.gaps || [],
        positioning: a.positioning || null,
        fit_analysis: a.fit_analysis || null,
        analyzed_at: new Date().toISOString(),
        status: 'avaliada',
        updated_at: new Date().toISOString(),
    };
    if (a.fit_score == null) delete patch.fit_score; // mantém score de regras se IA não devolveu
    const { data, error } = await supabase.from('vaga_radar').update(patch).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return data;
}

export default async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!await requireAdmin(req, res)) return;

    const supabase = getSupabase();
    const h = req.query.__h;

    // ---------------------------------------------------------
    // PERFIL — candidate_profile (singleton)
    // ---------------------------------------------------------
    if (h === 'profile') {
        if (req.method === 'GET') {
            const profile = await loadProfile(supabase);
            return res.status(200).json(profile);
        }
        if (req.method === 'PUT') {
            const b = req.body || {};
            const CNH_CATS = ['A', 'B', 'C', 'D', 'E'];
            const VALID_TIPOS_ARR = ['CLT', 'PJ', 'Freelancer', 'Cooperado', 'Temporário', 'Estágio', 'Autônomo'];
            const row = {
                nivel_alvo: clean(b.nivel_alvo, TEXT_MAX.generic),
                skills_core: jsonArr(b.skills_core),
                skills_evolucao: jsonArr(b.skills_evolucao),
                gaps: jsonArr(b.gaps),
                setores: jsonArr(b.setores),
                modalidade_pref: clean(b.modalidade_pref, 20),
                contratacao_pref: clean(b.contratacao_pref, 20),
                localizacao: clean(b.localizacao, TEXT_MAX.localizacao),
                keywords: jsonArr(b.keywords),
                diferenciais: jsonArr(b.diferenciais),
                updated_at: new Date().toISOString(),
            };
            if (b.cnh && typeof b.cnh === 'object') {
                row.cnh = { has: !!b.cnh.has, categories: Array.isArray(b.cnh.categories) ? b.cnh.categories.filter(c => CNH_CATS.includes(c)) : [] };
            }
            if (Array.isArray(b.contratacao_prefs)) {
                row.contratacao_prefs = b.contratacao_prefs.filter(t => VALID_TIPOS_ARR.includes(t));
            }
            if (Array.isArray(b.search_platforms)) {
                row.search_platforms = b.search_platforms;
            }
            if (Array.isArray(b.quick_searches)) {
                if (b.quick_searches.length > 20) return res.status(400).json({ error: 'máximo 20 buscas rápidas' });
                for (const q of b.quick_searches) {
                    if (!q.label || typeof q.label !== 'string' || q.label.length > 60)
                        return res.status(400).json({ error: 'label inválido (1-60 caracteres)' });
                    if (!q.url_template || typeof q.url_template !== 'string' || !q.url_template.startsWith('https://') || q.url_template.length > 500)
                        return res.status(400).json({ error: 'url_template inválido (deve começar com https:// e ter ≤ 500 caracteres)' });
                }
                row.quick_searches = b.quick_searches;
            }
            const existing = await loadProfile(supabase);
            let result;
            if (existing.id) {
                result = await supabase.from('candidate_profile').update(row).eq('id', existing.id).select().single();
            } else {
                result = await supabase.from('candidate_profile').insert(row).select().single();
            }
            if (result.error) return res.status(500).json({ error: result.error.message });
            return res.status(200).json(result.data);
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---------------------------------------------------------
    // ANÁLISE — gera prompt (manual/MCP) ou roda IA (auto); salva resultado
    // ---------------------------------------------------------
    if (h === 'analysis') {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });

        if (req.method === 'GET') {
            const { data: lead, error } = await supabase.from('vaga_radar').select('*').eq('id', id).single();
            if (error || !lead) return res.status(404).json({ error: 'Lead não encontrado' });
            const profile = await loadProfile(supabase);
            const forcePrompt = req.query.prompt === '1';

            if (!forcePrompt && isConfigured()) {
                try {
                    const analysis = await analyze(lead, profile);
                    const updated = await applyAnalysis(supabase, id, analysis);
                    return res.status(200).json({ mode: 'auto', provider: providerInfo(), lead: updated, analysis });
                } catch (e) {
                    return res.status(502).json({ error: `Falha na IA automática: ${e.message}` });
                }
            }
            return res.status(200).json({ mode: 'manual', prompt: buildAnalysisPrompt(lead, profile) });
        }

        if (req.method === 'PUT') {
            // body: { raw: "<texto colado>" } OU objeto de análise já estruturado
            const b = req.body || {};
            let analysis;
            try {
                analysis = typeof b.raw === 'string' ? parseAnalysisJson(b.raw) : parseAnalysisJson(JSON.stringify(b.analysis ?? b));
            } catch (e) {
                return res.status(400).json({ error: `Análise inválida: ${e.message}` });
            }
            try {
                const updated = await applyAnalysis(supabase, id, analysis);
                return res.status(200).json({ lead: updated, analysis });
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---------------------------------------------------------
    // FILA DE BUSCA — search_requests
    // ---------------------------------------------------------
    if (req.method === 'POST' && req.query.action === 'request-search') {
        const { platforms, keywords, max_results, dry_run } = req.body || {};
        if (!Array.isArray(platforms) || !platforms.length)
            return res.status(400).json({ error: 'platforms obrigatório' });
        const validPlats = new Set(['linkedin', 'gupy', 'maringa', 'indeed', 'infojobs', 'remotive', 'remoteok', 'weworkremotely', 'remotar', 'trampos', 'aijobs', 'jsremotely']);
        const filteredPlats = platforms.filter(p => validPlats.has(p));
        if (!filteredPlats.length)
            return res.status(400).json({ error: 'Nenhuma plataforma válida' });
        const kw = Array.isArray(keywords) ? keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 20) : null;
        const mr = Number.isInteger(max_results) && max_results > 0 ? Math.min(max_results, 50) : null;
        const { data, error } = await supabase.from('search_requests')
            .insert({ platforms: filteredPlats, keywords: kw, max_results: mr, dry_run: !!dry_run })
            .select('id').single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json({ id: data.id });
    }

    if (req.method === 'GET' && req.query.action === 'search-status') {
        if (!req.query.id) return res.status(400).json({ error: 'id obrigatório' });
        const { data, error } = await supabase.from('search_requests')
            .select('id,status,result,error_message,created_at,started_at,finished_at,progress')
            .eq('id', req.query.id).single();
        if (error || !data) return res.status(404).json({ error: 'não encontrado' });
        return res.json(data);
    }

    if (req.method === 'GET' && req.query.action === 'search-history') {
        const { data } = await supabase.from('search_log')
            .select('id,platform,keywords_used,found_count,new_count,ran_at')
            .order('ran_at', { ascending: false }).limit(10);
        return res.json(data || []);
    }

    if (req.method === 'POST' && req.query.action === 'cancel-search') {
        const { request_id } = req.body || {};
        if (!request_id) return res.status(400).json({ error: 'request_id obrigatório' });
        const { data, error } = await supabase.from('search_requests')
            .update({ status: 'cancelled', finished_at: new Date().toISOString() })
            .eq('id', request_id)
            .in('status', ['pending', 'running'])
            .select('id, status')
            .maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Request não encontrado ou já finalizado' });
        return res.json({ ok: true, id: data.id });
    }

    // ---------------------------------------------------------
    // MCP-STATUS — frontend usa pra mostrar se o MCP server está rodando
    // ---------------------------------------------------------
    if (req.method === 'GET' && req.query.action === 'mcp-status') {
        const { data } = await supabase.from('candidate_profile')
            .select('mcp_heartbeat_at')
            .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        const lastSeen = data?.mcp_heartbeat_at || null;
        const secondsAgo = lastSeen
            ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 1000)
            : null;
        const online = secondsAgo !== null && secondsAgo < 45;
        return res.json({ online, seconds_ago: secondsAgo, last_seen: lastSeen });
    }

    // ---------------------------------------------------------
    // STATS — breakdown de contadores no header do radar
    // ---------------------------------------------------------
    if (req.method === 'GET' && req.query.action === 'stats') {
        const { data: rows } = await supabase.from('vaga_radar').select('status,updated_at');
        const byStatus = { novo: 0, avaliada: 0, descartada: 0, promovida: 0, arquivada: 0 };
        const cutoff30d = Date.now() - 30 * 86400000;
        let staleCount = 0;
        for (const r of rows || []) {
            if (r.status in byStatus) byStatus[r.status]++;
            if ((r.status === 'novo' || r.status === 'avaliada') && new Date(r.updated_at).getTime() < cutoff30d) staleCount++;
        }
        return res.json({ total: (rows || []).length, by_status: byStatus, stale_count: staleCount });
    }

    // ---------------------------------------------------------
    // LIMPEZA — preview e execução de presets
    // ---------------------------------------------------------
    const CLEANUP_PRESETS = {
        descartadas_30d: { type: 'delete', status: 'descartada', days: 30 },
        descartadas_60d: { type: 'delete', status: 'descartada', days: 60 },
        descartadas_90d: { type: 'delete', status: 'descartada', days: 90 },
        promovidas_180d: { type: 'delete', status: 'promovida', days: 180 },
        expirar_parados_30d: { type: 'expire', days: 30 },
    };

    async function cleanupCount(preset) {
        const cfg = CLEANUP_PRESETS[preset];
        if (!cfg) return null;
        const cutoff = new Date(Date.now() - cfg.days * 86400000).toISOString();
        if (cfg.type === 'expire') {
            const { count } = await supabase.from('vaga_radar')
                .select('id', { count: 'exact', head: true })
                .in('status', ['novo', 'avaliada'])
                .lt('updated_at', cutoff);
            return count || 0;
        }
        // Delete preview — não consegue facilmente excluir os com app correspondente via PostgREST,
        // então conta direto e aceita pequena imprecisão. Execução real usa SQL function que filtra.
        const { count } = await supabase.from('vaga_radar')
            .select('id', { count: 'exact', head: true })
            .eq('status', cfg.status)
            .lt('updated_at', cutoff);
        return count || 0;
    }

    if (req.method === 'GET' && req.query.action === 'cleanup-preview') {
        const preset = req.query.preset;
        const cfg = CLEANUP_PRESETS[preset];
        if (!cfg) return res.status(400).json({ error: 'preset inválido' });
        const count = await cleanupCount(preset);
        return res.json({ count, type: cfg.type, days: cfg.days });
    }

    if (req.method === 'DELETE' && req.query.action === 'cleanup') {
        const preset = req.query.preset;
        const cfg = CLEANUP_PRESETS[preset];
        if (!cfg) return res.status(400).json({ error: 'preset inválido' });
        if (cfg.type === 'expire') {
            const { data, error } = await supabase.rpc('radar_expire_stale_leads');
            if (error) return res.status(500).json({ error: error.message });
            return res.json({ updated: data });
        }
        const fn = cfg.status === 'descartada' ? 'radar_purge_old_discarded' : 'radar_purge_old_promoted';
        const { data, error } = await supabase.rpc(fn, { min_days: cfg.days });
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ deleted: data });
    }

    // ---------------------------------------------------------
    // CHECK APP LINK — usado pelo botão Excluir para alertar duplicata
    // ---------------------------------------------------------
    if (req.method === 'GET' && req.query.action === 'check-app-link') {
        const link = req.query.link;
        if (!link) return res.json({ has_app: false });
        const { data } = await supabase.from('job_applications')
            .select('id').eq('link_vaga', link).limit(1).maybeSingle();
        return res.json({ has_app: !!data });
    }

    // ---------------------------------------------------------
    // REOPEN FROM APP — escape hatch para "Voltar para Radar"
    // ---------------------------------------------------------
    if (req.method === 'POST' && req.query.action === 'reopen-from-app') {
        const appId = req.query.app_id;
        if (!appId) return res.status(400).json({ error: 'app_id obrigatório' });
        const { data: app, error: e1 } = await supabase.from('job_applications')
            .select('empresa,vaga,link_vaga,observacoes,modalidade,tipo_contratacao')
            .eq('id', appId).single();
        if (e1 || !app) return res.status(404).json({ error: 'application não encontrada' });

        // Se já existe lead com mesmo link_vaga, atualiza para avaliada em vez de criar duplicata
        if (app.link_vaga) {
            const { data: existing } = await supabase.from('vaga_radar')
                .select('id').eq('link_vaga', app.link_vaga).maybeSingle();
            if (existing) {
                const { data, error } = await supabase.from('vaga_radar')
                    .update({ status: 'avaliada', motivo_descarte: null, updated_at: new Date().toISOString() })
                    .eq('id', existing.id).select().single();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ ok: true, lead: data, reused: true });
            }
        }

        const lead = {
            empresa: app.empresa,
            vaga: app.vaga,
            link_vaga: app.link_vaga,
            modalidade: app.modalidade,
            tipo_contratacao: app.tipo_contratacao,
            fonte: 'reaberta',
            status: 'avaliada',
            descricao: app.observacoes ? `Reaberta de candidatura anterior. ${app.observacoes}`.slice(0, TEXT_MAX.descricao) : 'Reaberta de candidatura anterior.',
        };
        const profile = await loadProfile(supabase);
        const r = scoreVaga(lead, profile);
        lead.fit_score_regras = r.score;
        lead.fit_score = r.score;
        lead.keywords_match = r.keywords_match;
        lead.gaps = r.gaps_preliminares;
        const rev = computeReverseFit(lead, profile);
        lead.reverse_fit_score = rev.score;
        lead.reverse_fit_breakdown = rev;

        const { data, error } = await supabase.from('vaga_radar').insert(lead).select().single();
        if (error) return res.status(500).json({ error: error.message });
        return res.json({ ok: true, lead: data, reused: false });
    }

    // ---------------------------------------------------------
    // LEADS — vaga_radar
    // ---------------------------------------------------------
    if (req.method === 'GET') {
        if (req.query.id) {
            const { data, error } = await supabase.from('vaga_radar').select('*').eq('id', req.query.id).single();
            if (error || !data) return res.status(404).json({ error: 'Lead não encontrado' });
            return res.status(200).json(data);
        }
        const includeClosed = req.query.all === '1';
        let q = supabase.from('vaga_radar').select('*');
        if (!includeClosed) q = q.in('status', ['novo', 'avaliada']);
        const { data, error } = await q
            .order('fit_score', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data ?? []);
    }

    if (req.method === 'POST') {
        const b = req.body || {};
        const empresa = clean(b.empresa, TEXT_MAX.empresa);
        if (!empresa) return res.status(400).json({ error: 'empresa obrigatório' });
        if (b.modalidade && !VALID_MODALIDADE.has(b.modalidade)) return res.status(400).json({ error: `modalidade inválida (${b.modalidade})` });
        if (b.tipo_contratacao && !VALID_TIPO.has(b.tipo_contratacao)) return res.status(400).json({ error: `tipo_contratacao inválido (${b.tipo_contratacao})` });

        const lead = {
            empresa,
            vaga: clean(b.vaga, TEXT_MAX.vaga),
            link_vaga: clean(b.link_vaga, TEXT_MAX.link_vaga),
            descricao: clean(b.descricao, TEXT_MAX.descricao),
            fonte: clean(b.fonte, TEXT_MAX.fonte) || 'linkedin',
            modalidade: b.modalidade || null,
            tipo_contratacao: b.tipo_contratacao || null,
            nivel: clean(b.nivel, TEXT_MAX.nivel),
            nivel_alvo: b.nivel_alvo ? clean(b.nivel_alvo, 50) : null,
            faixa_salarial: b.faixa_salarial ? clean(b.faixa_salarial, 100) : null,
            requires_cnh: clean(b.requires_cnh, TEXT_MAX.requires_cnh),
        };

        // Score por regras no momento da captura
        const profile = await loadProfile(supabase);
        const r = scoreVaga(lead, profile);
        lead.fit_score_regras = r.score;
        lead.fit_score = r.score;
        lead.keywords_match = r.keywords_match;
        lead.gaps = r.gaps_preliminares;
        if (!lead.nivel && r.seniority_inferred !== 'unknown') lead.nivel = r.seniority_inferred;
        lead.suspicious_flags = detectSuspiciousFlags(lead);
        const rev = computeReverseFit(lead, profile);
        lead.reverse_fit_score = rev.score;
        lead.reverse_fit_breakdown = rev;
        const aln = computeAlignmentScore(lead, profile);
        lead.alignment_score = aln.score;
        lead.alignment_breakdown = aln;

        const { data, error } = await supabase.from('vaga_radar').insert(lead).select().single();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
        // Ação de lote: não requer ?id= individual
        if (req.query.action === 'bulk-discard') {
            const { ids, motivo_descarte } = req.body || {};
            if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids obrigatório (array)' });
            if (ids.length > 50) return res.status(400).json({ error: 'máximo 50 leads por vez' });
            const motivo = clean(motivo_descarte, TEXT_MAX.motivo_descarte);
            const patch = { status: 'descartada', updated_at: new Date().toISOString() };
            if (motivo) patch.motivo_descarte = motivo;
            const { data, error } = await supabase.from('vaga_radar').update(patch).in('id', ids).select('id,status');
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true, updated: data?.length ?? 0, ids: data?.map(r => r.id) ?? [] });
        }

        const id = req.query.id;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });

        // Ação: promover lead → cria candidatura em job_applications
        if (req.query.action === 'promote') {
            const { data: lead, error: e1 } = await supabase.from('vaga_radar').select('*').eq('id', id).single();
            if (e1 || !lead) return res.status(404).json({ error: 'Lead não encontrado' });
            if (lead.status === 'promovida' && lead.promoted_application_id) {
                return res.status(409).json({ error: 'Lead já promovido', application_id: lead.promoted_application_id });
            }
            const { data: app, error: e2 } = await supabase
                .from('job_applications')
                .insert({
                    empresa: lead.empresa,
                    vaga: lead.vaga,
                    link_vaga: lead.link_vaga,
                    observacoes: lead.positioning ? `Posicionamento (Radar): ${lead.positioning}`.slice(0, 500) : null,
                    modalidade: lead.modalidade || null,
                    tipo_contratacao: lead.tipo_contratacao || null,
                    origin_radar_id: lead.id,
                    platform: req.body?.platform || null,
                    source: 'radar',
                    stages: DEFAULT_STAGES,
                })
                .select()
                .single();
            if (e2) return res.status(500).json({ error: e2.message });

            const { error: e3 } = await supabase
                .from('vaga_radar')
                .update({ status: 'promovida', promoted_application_id: app.id, updated_at: new Date().toISOString() })
                .eq('id', id);
            if (e3) return res.status(500).json({ error: e3.message });
            return res.status(200).json({ ok: true, application: app });
        }

        // Ação: detect-suspicious — analisa lead e seta suspicious_flags
        if (req.query.action === 'detect-suspicious') {
            const { data: lead, error: e1 } = await supabase.from('vaga_radar').select('descricao,vaga,created_at,fonte,faixa_salarial').eq('id', id).single();
            if (e1 || !lead) return res.status(404).json({ error: 'Lead não encontrado' });

            const flags = [];
            // Descrição muito curta (< 200 chars)
            const descLen = (lead.descricao || '').replace(/<[^>]+>/g, '').length;
            if (descLen > 0 && descLen < 200) flags.push('description_too_short');
            // Título genérico
            const vagaLower = (lead.vaga || '').toLowerCase();
            if (['vaga', 'oportunidade', 'profissional', 'analista', 'desenvolvedor'].some(k => vagaLower === k)) flags.push('generic_title');
            // Repostado (lead existe há > 90 dias mas status ainda novo)
            if (lead.created_at) {
                const ageDays = (Date.now() - new Date(lead.created_at).getTime()) / 86400000;
                if (ageDays > 90) flags.push('reposted_90d');
            }

            const { error: e2 } = await supabase.from('vaga_radar').update({ suspicious_flags: flags, updated_at: new Date().toISOString() }).eq('id', id);
            if (e2) return res.status(500).json({ error: e2.message });
            return res.status(200).json({ ok: true, flags });
        }

        // Atualização de campos do lead (inclui descartar com motivo)
        const b = req.body || {};
        const patch = {};
        if (b.empresa !== undefined) { const v = clean(b.empresa, TEXT_MAX.empresa); if (!v) return res.status(400).json({ error: 'empresa não pode ser vazio' }); patch.empresa = v; }
        if (b.vaga !== undefined) patch.vaga = clean(b.vaga, TEXT_MAX.vaga);
        if (b.link_vaga !== undefined) patch.link_vaga = clean(b.link_vaga, TEXT_MAX.link_vaga);
        if (b.descricao !== undefined) patch.descricao = clean(b.descricao, TEXT_MAX.descricao);
        if (b.nivel !== undefined) patch.nivel = clean(b.nivel, TEXT_MAX.nivel);
        if (b.modalidade !== undefined) { if (b.modalidade && !VALID_MODALIDADE.has(b.modalidade)) return res.status(400).json({ error: 'modalidade inválida' }); patch.modalidade = b.modalidade || null; }
        if (b.tipo_contratacao !== undefined) { if (b.tipo_contratacao && !VALID_TIPO.has(b.tipo_contratacao)) return res.status(400).json({ error: 'tipo_contratacao inválido' }); patch.tipo_contratacao = b.tipo_contratacao || null; }
        if (b.status !== undefined) { if (!VALID_STATUS.has(b.status)) return res.status(400).json({ error: `status inválido (${b.status})` }); patch.status = b.status; }
        if (b.motivo_descarte !== undefined) patch.motivo_descarte = clean(b.motivo_descarte, TEXT_MAX.motivo_descarte);

        if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
        patch.updated_at = new Date().toISOString();

        const { data, error } = await supabase.from('vaga_radar').update(patch).eq('id', id).select().single();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Lead não encontrado' });
        return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
        const id = req.query.id;
        if (!id) return res.status(400).json({ error: 'id obrigatório' });
        const { error } = await supabase.from('vaga_radar').delete().eq('id', id);
        if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
