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
import { scoreVaga } from '../_lib/scoring.js';
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
        const validPlats = new Set(['linkedin', 'gupy', 'maringa', 'indeed']);
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
            .select('id,status,result,error_message,created_at,started_at,finished_at')
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
