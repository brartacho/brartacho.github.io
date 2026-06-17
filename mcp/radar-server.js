#!/usr/bin/env node
// ============================================================
// Radar de Vagas — servidor MCP (stdio) para o Claude Code
// ============================================================
// Expõe os leads do Radar e o perfil ao Claude Code, eliminando o
// copia-e-cola: "analise os leads novos do Radar" → o Claude lê a vaga,
// pontua e grava o resultado de volta via save_analysis.
//
// Fala direto com o Supabase (service key) — não depende do app no ar.
// Roda LOCAL, junto ao Claude Code (não consome runtime do Vercel).
//
// Config (ver mcp/README.md): registrar no .mcp.json com as env vars
//   SUPABASE_URL e SUPABASE_SERVICE_KEY.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scoreVaga } from '../api/_lib/scoring.js';
import { buildAnalysisPrompt } from '../api/_lib/radar-prompt.js';
import { searchLinkedin } from './search/linkedin.js';
import { searchGupy } from './search/gupy.js';
import { searchMaringa } from './search/maringa.js';
import { searchIndeed } from './search/indeed.js';
import { searchInfojobs } from './search/infojobs.js';
import { searchRemotive } from './search/remotive.js';
import { searchRemoteOK } from './search/remoteok.js';
import { searchWeWorkRemotely } from './search/weworkremotely.js';
import { searchRemotar } from './search/remotar.js';
import { searchTrampos } from './search/trampos.js';
import { searchAiJobs } from './search/aijobs.js';
import { searchJsRemotely } from './search/jsremotely.js';
import { searchVagas } from './search/vagas.js';
import { searchCatho } from './search/catho.js';
import { searchJooble } from './search/jooble.js';
import { searchWorkana } from './search/workana.js';
import { searchFreelas99 } from './search/freelas99.js';
import { clearSession } from './search/session.js';

const SCRAPERS = {
    linkedin:       (cfg) => searchLinkedin({ keywords: cfg.keywords || ['analista de qa'], timeFilter: cfg.time_filter || 'r86400', maxResults: cfg.max_results || 30 }),
    gupy:           (cfg) => searchGupy({ keywords: cfg.keywords || ['analista de qa'], maxResults: cfg.max_results || 20 }),
    maringa:        (cfg) => searchMaringa({ keywords: cfg.keywords || ['qa'], maxResults: cfg.max_results || 15 }),
    indeed:         (cfg) => searchIndeed({ keywords: cfg.keywords || ['analista de qa'], maxResults: cfg.max_results || 20 }),
    infojobs:       (cfg) => searchInfojobs({ keywords: cfg.keywords || ['analista de qa'], maxResults: cfg.max_results || 20 }),
    remotive:       (cfg) => searchRemotive({ keywords: cfg.keywords || ['qa engineer'], maxResults: cfg.max_results || 20 }),
    remoteok:       (cfg) => searchRemoteOK({ keywords: cfg.keywords || ['qa', 'test'], maxResults: cfg.max_results || 20 }),
    weworkremotely: (cfg) => searchWeWorkRemotely({ keywords: cfg.keywords || ['qa', 'test'], maxResults: cfg.max_results || 20, categories: cfg.categories }),
    remotar:        (cfg) => searchRemotar({ keywords: cfg.keywords || ['qa', 'analista'], maxResults: cfg.max_results || 20 }),
    trampos:        (cfg) => searchTrampos({ keywords: cfg.keywords || ['qa', 'analista de qa'], maxResults: cfg.max_results || 20 }),
    aijobs:         (cfg) => searchAiJobs({ keywords: cfg.keywords || ['qa engineer', 'test automation'], maxResults: cfg.max_results || 20 }),
    jsremotely:     (cfg) => searchJsRemotely({ keywords: cfg.keywords || ['qa', 'test'], maxResults: cfg.max_results || 20 }),
    vagas:          (cfg) => searchVagas({ keywords: cfg.keywords || ['analista de qa'], maxResults: cfg.max_results || 20 }),
    catho:          (cfg) => searchCatho({ keywords: cfg.keywords || ['analista de qa'], maxResults: cfg.max_results || 20 }),
    jooble:         (cfg) => searchJooble({ keywords: cfg.keywords || ['analista de qa'], location: cfg.location || 'Brasil', maxResults: cfg.max_results || 20 }),
    workana:        (cfg) => searchWorkana({ keywords: cfg.keywords || ['qa', 'testes'], maxResults: cfg.max_results || 20 }),
    '99freelas':    (cfg) => searchFreelas99({ keywords: cfg.keywords || ['qa', 'testes'], maxResults: cfg.max_results || 20 }),
};

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
    console.error('[radar-mcp] defina SUPABASE_URL e SUPABASE_SERVICE_KEY');
    process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function getProfile() {
    const { data } = await supabase.from('candidate_profile').select('*')
        .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    return data || {};
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

const server = new McpServer({ name: 'radar-vagas', version: '1.0.0' });

server.registerTool('list_leads',
    { title: 'Listar leads do Radar', description: 'Lista vagas em status novo/avaliada (ou todas com all=true).',
      inputSchema: { all: z.boolean().optional() } },
    async ({ all }) => {
        let q = supabase.from('vaga_radar').select('id, empresa, vaga, nivel, modalidade, fit_score, status, analyzed_at');
        if (!all) q = q.in('status', ['novo', 'avaliada']);
        const { data, error } = await q.order('fit_score', { ascending: false, nullsFirst: false });
        return error ? fail(error.message) : ok(data ?? []);
    });

server.registerTool('get_lead',
    { title: 'Detalhe do lead', description: 'Retorna um lead completo (inclui descrição).',
      inputSchema: { id: z.string() } },
    async ({ id }) => {
        const { data, error } = await supabase.from('vaga_radar').select('*').eq('id', id).single();
        return error ? fail(error.message) : ok(data);
    });

server.registerTool('get_profile',
    { title: 'Perfil do candidato', description: 'Retorna o candidate_profile usado na pontuação.', inputSchema: {} },
    async () => ok(await getProfile()));

server.registerTool('get_analysis_prompt',
    { title: 'Prompt de análise', description: 'Monta o prompt de análise (vaga + perfil) para um lead.',
      inputSchema: { id: z.string() } },
    async ({ id }) => {
        const { data: lead, error } = await supabase.from('vaga_radar').select('*').eq('id', id).single();
        if (error || !lead) return fail('Lead não encontrado');
        return { content: [{ type: 'text', text: buildAnalysisPrompt(lead, await getProfile()) }] };
    });

server.registerTool('save_analysis',
    { title: 'Salvar análise', description: 'Grava o resultado da análise em um lead (status → avaliada).',
      inputSchema: {
          id: z.string(),
          fit_score: z.number().min(0).max(10).nullable().optional(),
          required_keywords: z.array(z.string()).optional(),
          nice_to_have_keywords: z.array(z.string()).optional(),
          gaps: z.array(z.string()).optional(),
          positioning: z.string().optional(),
          fit_analysis: z.string().optional(),
      } },
    async (a) => {
        const keywords = [...new Set([...(a.required_keywords || []), ...(a.nice_to_have_keywords || [])])];
        const patch = {
            fit_score_ia: a.fit_score ?? null,
            keywords_match: keywords,
            gaps: a.gaps || [],
            positioning: a.positioning || null,
            fit_analysis: a.fit_analysis || null,
            analyzed_at: new Date().toISOString(),
            status: 'avaliada',
            updated_at: new Date().toISOString(),
        };
        if (a.fit_score != null) patch.fit_score = a.fit_score;
        const { data, error } = await supabase.from('vaga_radar').update(patch).eq('id', a.id).select().single();
        return error ? fail(error.message) : ok(data);
    });

server.registerTool('score_preview',
    { title: 'Score por regras', description: 'Calcula o fit_score por regras para um texto de vaga, sem salvar.',
      inputSchema: { vaga: z.string().optional(), descricao: z.string(), modalidade: z.string().optional(), tipo_contratacao: z.string().optional(), nivel: z.string().optional() } },
    async (v) => ok(scoreVaga(v, await getProfile())));

server.registerTool('check_duplicate',
    { title: 'Verificar duplicata', description: 'Verifica se já existe um lead com esse link_vaga. Retorna o lead existente ou null.',
      inputSchema: { link_vaga: z.string() } },
    async ({ link_vaga }) => {
        const { data, error } = await supabase.from('vaga_radar').select('id,empresa,vaga,status,fit_score')
            .eq('link_vaga', link_vaga).maybeSingle();
        return error ? fail(error.message) : ok(data ?? null);
    });

server.registerTool('create_lead',
    { title: 'Criar lead', description: 'Insere uma nova vaga no Radar com score calculado automaticamente. Use check_duplicate antes para evitar duplicatas.',
      inputSchema: {
          empresa:          z.string(),
          vaga:             z.string().optional(),
          link_vaga:        z.string().optional(),
          descricao:        z.string().optional(),
          fonte:            z.string().optional(),
          modalidade:       z.enum(['Presencial','Híbrida','Remota']).optional(),
          tipo_contratacao: z.enum(['CLT','PJ','Freelancer','Cooperado','Temporário','Estágio','Autônomo']).optional(),
          nivel:            z.string().optional(),
          requires_cnh:     z.string().optional(),
      } },
    async (input) => {
        const profile = await getProfile();
        const lead = {
            empresa:          input.empresa,
            vaga:             input.vaga             ?? null,
            link_vaga:        input.link_vaga        ?? null,
            descricao:        input.descricao        ?? null,
            fonte:            input.fonte            ?? 'radar-mcp',
            modalidade:       input.modalidade       ?? null,
            tipo_contratacao: input.tipo_contratacao ?? null,
            nivel:            input.nivel            ?? null,
            requires_cnh:     input.requires_cnh     ?? null,
        };
        const r = scoreVaga(lead, profile);
        lead.fit_score_regras = r.score;
        lead.fit_score        = r.score;
        lead.keywords_match   = r.keywords_match;
        lead.gaps             = r.gaps_preliminares;
        if (!lead.nivel && r.seniority_inferred !== 'unknown') lead.nivel = r.seniority_inferred;

        const { data, error } = await supabase.from('vaga_radar').insert(lead).select().single();
        return error ? fail(error.message) : ok(data);
    });

server.registerTool('list_cv_versions',
    { title: 'Listar versões de CV', description: 'Retorna CVs ativos com target_role e search_keywords para uso como base de busca.',
      inputSchema: {} },
    async () => {
        const { data, error } = await supabase.from('cv_versions')
            .select('id,name,description,target_role,search_keywords,search_platforms,active')
            .eq('active', true)
            .order('created_at', { ascending: false });
        return error ? fail(error.message) : ok(data ?? []);
    });

server.registerTool('update_search_timestamp',
    { title: 'Atualizar timestamp de busca', description: 'Registra quando uma plataforma foi pesquisada pela última vez (busca incremental).',
      inputSchema: { platform_id: z.string() } },
    async ({ platform_id }) => {
        const now = new Date().toISOString();
        const profile = await getProfile();
        if (!profile.id) return fail('Perfil não encontrado');
        const platforms = Array.isArray(profile.search_platforms) ? profile.search_platforms : [];
        const updated = platforms.map(p =>
            p.id === platform_id ? { ...p, last_searched_at: now } : p
        );
        if (!updated.some(p => p.id === platform_id)) {
            return fail(`Plataforma '${platform_id}' não encontrada no perfil`);
        }
        const { data, error } = await supabase.from('candidate_profile')
            .update({ search_platforms: updated, updated_at: now })
            .eq('id', profile.id).select('search_platforms').single();
        return error ? fail(error.message) : ok({ platform_id, updated_at: now, platforms: data.search_platforms });
    });

server.registerTool('recalculate_scores',
    { title: 'Recalcular scores', description: 'Recalcula fit_score de todos os leads em status novo usando o perfil atual. Retorna resumo.',
      inputSchema: { dry_run: z.boolean().optional() } },
    async ({ dry_run }) => {
        const profile = await getProfile();
        const { data: leads, error } = await supabase.from('vaga_radar')
            .select('id, vaga, descricao, nivel, modalidade, tipo_contratacao, requires_cnh, fit_score')
            .eq('status', 'novo');
        if (error) return fail(error.message);

        let improved = 0, dropped = 0, unchanged = 0;
        const now = new Date().toISOString();

        for (const lead of (leads ?? [])) {
            const r = scoreVaga(lead, profile);
            const oldScore = lead.fit_score ?? null;
            const newScore = r.score;

            if (oldScore === null || newScore > oldScore) improved++;
            else if (newScore < oldScore) dropped++;
            else unchanged++;

            if (!dry_run) {
                const { error: updateError } = await supabase.from('vaga_radar').update({
                    fit_score: newScore,
                    fit_score_regras: newScore,
                    keywords_match: r.keywords_match,
                    updated_at: now,
                }).eq('id', lead.id);
                if (updateError) return fail(updateError.message);
            }
        }

        return ok({ recalculated: (leads ?? []).length, improved, dropped, unchanged });
    });

server.registerTool('cleanup_leads',
    { title: 'Limpeza de leads', description: 'Deleta descartadas antigas e arquiva leads parados. dry_run=true apenas lista sem executar.',
      inputSchema: { dry_run: z.boolean().optional() } },
    async ({ dry_run }) => {
        const profile = await getProfile();
        const autoDeleteDiscardedDays = profile.auto_delete_discarded_days ?? 30;
        const autoDeleteStaleDays = profile.auto_delete_stale_days ?? 90;

        const discardedCutoff = new Date(Date.now() - autoDeleteDiscardedDays * 86400000).toISOString();
        const staleCutoff = new Date(Date.now() - autoDeleteStaleDays * 86400000).toISOString();

        const { data: toDelete, error: e1 } = await supabase.from('vaga_radar')
            .select('id, updated_at')
            .eq('status', 'descartada')
            .lt('updated_at', discardedCutoff);
        if (e1) return fail(e1.message);

        const { data: toArchive, error: e2 } = await supabase.from('vaga_radar')
            .select('id, updated_at')
            .in('status', ['novo', 'avaliada'])
            .lt('updated_at', staleCutoff);
        if (e2) return fail(e2.message);

        const deleteList = toDelete ?? [];
        const archiveList = toArchive ?? [];

        if (dry_run) {
            const oldestDelete = deleteList.length
                ? deleteList.reduce((a, b) => a.updated_at < b.updated_at ? a : b).updated_at
                : null;
            const oldestArchive = archiveList.length
                ? archiveList.reduce((a, b) => a.updated_at < b.updated_at ? a : b).updated_at
                : null;
            return ok({ would_delete: deleteList.length, would_archive: archiveList.length, oldest_to_delete: oldestDelete, oldest_to_archive: oldestArchive });
        }

        const now = new Date().toISOString();
        let deleted = 0, archived = 0;

        if (deleteList.length > 0) {
            const ids = deleteList.map(r => r.id);
            const { error: delError } = await supabase.from('vaga_radar').delete().in('id', ids);
            if (delError) return fail(delError.message);
            deleted = deleteList.length;
        }

        if (archiveList.length > 0) {
            const ids = archiveList.map(r => r.id);
            const { error: archError } = await supabase.from('vaga_radar')
                .update({ status: 'arquivada', updated_at: now })
                .in('id', ids);
            if (archError) return fail(archError.message);
            archived = archiveList.length;
        }

        return ok({ deleted, archived });
    });

server.registerTool('get_cv_adaptation_prompt',
    { title: 'Prompt de adaptação de CV',
      description: 'Monta o prompt para Claude sugerir adaptações de apresentação do CV para uma vaga específica, sem inventar dados.',
      inputSchema: { vaga_id: z.string(), cv_id: z.string() } },
    async ({ vaga_id, cv_id }) => {
        const { data: lead, error: e1 } = await supabase.from('vaga_radar').select('*').eq('id', vaga_id).single();
        if (e1 || !lead) return fail('Vaga não encontrada');

        const { data: cv, error: e2 } = await supabase.from('cv_versions')
            .select('id, name, description, target_role, adaptation_notes')
            .eq('id', cv_id).single();
        if (e2 || !cv) return fail('CV não encontrado');

        const prompt = `Você é um consultor de carreira. Sugira adaptações de APRESENTAÇÃO para este currículo se encaixar melhor nesta vaga.

REGRAS IMPORTANTES:
- Não invente skills, experiências, projetos ou certificações que não existam no currículo base
- Não aumente a senioridade artificialmente
- Apenas sugira: reordenar seções/itens, ajustar linguagem/framing, destacar experiências mais relevantes
- As sugestões devem ser específicas e aplicáveis ao currículo base

# Vaga
Empresa: ${lead.empresa}
Título: ${lead.vaga || '—'}
Nível: ${lead.nivel || '—'} | Modalidade: ${lead.modalidade || '—'} | Contratação: ${lead.tipo_contratacao || '—'}
Descrição:
"""
${(lead.descricao || '').slice(0, 4000)}
"""
Keywords identificadas: ${(lead.keywords_match || []).join(', ') || '—'}
Gaps identificados: ${(lead.gaps || []).join(', ') || '—'}

# Currículo Base
Nome do modelo: ${cv.name}
Descrição: ${cv.description || '—'}
Perfil-alvo atual: ${cv.target_role || '—'}
${cv.adaptation_notes ? `\nNotas anteriores de adaptação:\n${cv.adaptation_notes}` : ''}

# Tarefa
Retorne SOMENTE um objeto JSON válido com EXATAMENTE estas chaves:
{
  "adaptation_notes": "sugestões detalhadas de adaptação (texto livre, parágrafos)",
  "suggested_target_role": "título ideal para este modelo adaptado",
  "suggested_search_keywords": ["keyword1", "keyword2", ...]
}

Regras do JSON: adaptation_notes deve ser texto detalhado (não array); suggested_search_keywords devem ser extraídas da vaga e alinhadas ao perfil real do candidato.`;

        return { content: [{ type: 'text', text: prompt }] };
    });

server.registerTool('save_cv_adaptation',
    { title: 'Salvar adaptação de CV',
      description: 'Cria nova cv_version baseada em um modelo existente com sugestões de adaptação para uma vaga. Vincula ao lead.',
      inputSchema: {
          vaga_id:                   z.string(),
          base_cv_id:                z.string(),
          name:                      z.string(),
          adaptation_notes:          z.string().optional(),
          suggested_target_role:     z.string().optional(),
          suggested_search_keywords: z.array(z.string()).optional(),
      } },
    async (input) => {
        const { data: base, error: e1 } = await supabase.from('cv_versions').select('*').eq('id', input.base_cv_id).single();
        if (e1 || !base) return fail('CV base não encontrado');

        const { data: newCv, error: e2 } = await supabase.from('cv_versions').insert({
            name:             input.name,
            description:      `Adaptado de "${base.name}" para vaga ${input.vaga_id}`,
            file_path:        base.file_path,
            file_name:        base.file_name,
            active:           true,
            target_role:      input.suggested_target_role || base.target_role || null,
            search_keywords:  input.suggested_search_keywords || base.search_keywords || [],
            source_vaga_id:   input.vaga_id,
            adaptation_notes: input.adaptation_notes || null,
        }).select().single();
        if (e2 || !newCv) return fail(e2?.message ?? 'Erro ao criar CV');

        const { error: e3 } = await supabase.from('vaga_radar')
            .update({ adapted_cv_id: newCv.id, updated_at: new Date().toISOString() })
            .eq('id', input.vaga_id);
        if (e3) return fail(e3.message);

        return ok(newCv);
    });

// ============================================================
// Ferramentas de busca automática de vagas
// ============================================================

async function getSearchPlatformConfig(platformId) {
    const profile = await getProfile();
    const platforms = Array.isArray(profile.search_platforms) ? profile.search_platforms : [];
    return platforms.find(p => p.id === platformId) || null;
}

async function logSearch(platform, keywordsUsed, foundCount, newCount, duplicateCount, belowMinScore, errorNote = null) {
    const row = {
        platform,
        keywords_used:         keywordsUsed,
        found_count:           foundCount,
        new_count:             newCount,
        duplicate_count:       duplicateCount,
        below_min_score_count: belowMinScore,
    };
    if (errorNote) row.error_note = errorNote;
    await supabase.from('search_log').insert(row);
}

async function updatePlatformTimestamp(platformId) {
    const now = new Date().toISOString();
    const profile = await getProfile();
    if (!profile.id) return;
    const platforms = Array.isArray(profile.search_platforms) ? profile.search_platforms : [];
    const updated = platforms.map(p => p.id === platformId ? { ...p, last_searched_at: now } : p);
    await supabase.from('candidate_profile')
        .update({ search_platforms: updated, updated_at: now })
        .eq('id', profile.id);
}

// Cooldown padrão para re-ingestão de vagas com candidatura prévia (dias).
const RETRY_COOLDOWN_DAYS = 30;

// Camada 1 — Dedup ampliado:
// - já existe em vaga_radar → bloqueia sempre
// - já existe em job_applications:
//     - em_processo + não arquivada → bloqueio permanente (você está ativo no funil)
//     - qualquer outro estado dentro do cooldown → bloqueia
//     - fora do cooldown → permite re-ingestão (contexto pode ter mudado)
async function isAlreadyTracked(linkVaga) {
    if (!linkVaga) return false;

    const { data: inRadar } = await supabase.from('vaga_radar')
        .select('id').eq('link_vaga', linkVaga).maybeSingle();
    if (inRadar) return true;

    const { data: apps } = await supabase.from('job_applications')
        .select('id,result,archived,updated_at')
        .eq('link_vaga', linkVaga);
    if (!apps?.length) return false;

    const cutoff = Date.now() - RETRY_COOLDOWN_DAYS * 86400000;
    return apps.some(app => {
        if (app.result === 'em_processo' && !app.archived) return true;
        const updatedMs = new Date(app.updated_at).getTime();
        return updatedMs > cutoff;
    });
}

async function ingestLeads(leads, profile, dryRun, filters = null) {
    let newCount = 0, duplicateCount = 0, belowMinScore = 0, filteredOut = 0;
    const filteredByField = {};
    const minScore = (filters?.min_score ?? profile.search_min_score) ?? 5;
    const created = [];

    for (const lead of leads) {
        if (!lead.link_vaga) { duplicateCount++; continue; }

        if (await isAlreadyTracked(lead.link_vaga)) { duplicateCount++; continue; }

        const r = scoreVaga(lead, profile);
        if (r.score < minScore) { belowMinScore++; continue; }

        const mismatchField = filters ? matchFilters(lead, r, filters) : null;

        if (!dryRun) {
            const row = {
                empresa:          lead.empresa,
                vaga:             lead.vaga             ?? null,
                link_vaga:        lead.link_vaga,
                descricao:        lead.descricao        ?? null,
                fonte:            lead.fonte            ?? 'radar-search',
                modalidade:       lead.modalidade       ?? null,
                tipo_contratacao: lead.tipo_contratacao ?? null,
                nivel:            lead.nivel            ?? r.seniority_inferred !== 'unknown' ? r.seniority_inferred : null,
                requires_cnh:     null,
                fit_score_regras: r.score,
                fit_score:        r.score,
                keywords_match:   r.keywords_match,
                gaps:             r.gaps_preliminares,
            };
            if (mismatchField) {
                row.status          = 'descartada';
                row.motivo_descarte = `filtro:${mismatchField}`;
            }
            const { error } = await supabase.from('vaga_radar').insert(row);
            if (error) continue;
            if (mismatchField) {
                filteredOut++;
                filteredByField[mismatchField] = (filteredByField[mismatchField] || 0) + 1;
            } else {
                newCount++;
                created.push({ empresa: lead.empresa, vaga: lead.vaga, score: r.score });
            }
        } else {
            if (mismatchField) {
                filteredOut++;
                filteredByField[mismatchField] = (filteredByField[mismatchField] || 0) + 1;
            } else {
                newCount++;
                created.push({ empresa: lead.empresa, vaga: lead.vaga, score: r.score, dry_run: true });
            }
        }
    }

    return { newCount, duplicateCount, belowMinScore, filteredOut, filteredByField, created };
}

// Compara um lead com os filtros opcionais da requisição.
// Retorna o nome do primeiro campo que não bate (string) ou null se passa.
// Hard: location (substring case-insensitive em lead.location ou descricao).
// Soft: modalidade, tipo_contratacao, nivel, requires_cnh — só descarta
// quando o valor inferido EXISTE e diverge; null/unknown passa.
function matchFilters(lead, scoreResult, filters) {
    if (filters.location) {
        const target = String(filters.location).toLowerCase();
        const haystack = `${lead.location ?? ''} ${lead.descricao ?? ''}`.toLowerCase();
        if (!haystack.includes(target)) return 'location';
    }
    if (filters.modalidade && lead.modalidade && lead.modalidade !== filters.modalidade) {
        return 'modalidade';
    }
    if (Array.isArray(filters.tipo_contratacao) && filters.tipo_contratacao.length
        && lead.tipo_contratacao && !filters.tipo_contratacao.includes(lead.tipo_contratacao)) {
        return 'tipo_contratacao';
    }
    if (Array.isArray(filters.nivel) && filters.nivel.length) {
        const inferredNivel = lead.nivel
            || (scoreResult.seniority_inferred && scoreResult.seniority_inferred !== 'unknown'
                ? scoreResult.seniority_inferred
                : null);
        if (inferredNivel) {
            const lvl = String(inferredNivel).toLowerCase();
            const wanted = filters.nivel.map(n => String(n).toLowerCase());
            if (!wanted.some(w => lvl.includes(w) || w.includes(lvl))) return 'nivel';
        }
    }
    if (typeof filters.requires_cnh === 'boolean' && lead.requires_cnh != null) {
        const raw = String(lead.requires_cnh).toLowerCase().trim();
        const leadBool = ['true', 'sim', 'yes', '1', 'exige', 'necessária', 'obrigatória']
            .includes(raw);
        if (leadBool !== filters.requires_cnh) return 'requires_cnh';
    }
    return null;
}

server.registerTool('search_linkedin',
    { title: 'Buscar vagas no LinkedIn',
      description: 'Raspa vagas do LinkedIn Jobs com Playwright. Requer sessão (cookie file). Na primeira execução, abre browser para login.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          time_filter: z.string().optional(),
          max_results: z.number().int().min(1).max(50).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, time_filter, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('linkedin');
        const kw      = keywords || config?.keywords || ['analista de qa', 'qa engineer'];
        const tf      = time_filter || config?.time_filter || 'r86400';
        const mr      = max_results || config?.max_results || 30;

        let leads;
        try {
            leads = await searchLinkedin({ keywords: kw, timeFilter: tf, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('linkedin', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('linkedin');

        return ok({ platform: 'linkedin', found: leads.length, ...result });
    });

server.registerTool('search_gupy',
    { title: 'Buscar vagas no Gupy',
      description: 'Consulta a API pública do Gupy (portal.gupy.io). Sem autenticação necessária.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(50).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('gupy');
        const kw      = keywords || config?.keywords || ['analista de qa', 'quality assurance'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchGupy({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('gupy', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('gupy');

        return ok({ platform: 'gupy', found: leads.length, ...result });
    });

server.registerTool('search_maringa',
    { title: 'Buscar vagas no Empregos Maringá',
      description: 'Raspa vagas do empregos.maringa.com (área TI, categoria 18). Sem autenticação.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('maringa');
        const kw      = keywords || config?.keywords || ['qa', 'testes', 'implantação'];
        const mr      = max_results || config?.max_results || 15;

        let leads;
        try {
            leads = await searchMaringa({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('maringa', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('maringa');

        return ok({ platform: 'maringa', found: leads.length, ...result });
    });

server.registerTool('search_indeed',
    { title: 'Buscar vagas no Indeed',
      description: 'Consulta o RSS feed público do Indeed Brasil. Sem autenticação necessária.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(40).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('indeed');
        const kw      = keywords || config?.keywords || ['analista de qa', 'quality assurance'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchIndeed({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('indeed', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('indeed');

        return ok({ platform: 'indeed', found: leads.length, ...result });
    });

server.registerTool('search_infojobs',
    { title: 'Buscar vagas no InfoJobs',
      description: 'Raspa vagas do InfoJobs Brasil (www.infojobs.com.br). Usa Playwright + stealth para contornar Cloudflare.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('infojobs');
        const kw      = keywords || config?.keywords || ['analista de qa', 'quality assurance'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchInfojobs({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('infojobs', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('infojobs');

        return ok({ platform: 'infojobs', found: leads.length, ...result });
    });

server.registerTool('search_remotive',
    { title: 'Buscar vagas no Remotive',
      description: 'Consulta API pública do Remotive (remote-only, internacional, predominantemente inglês). Sem autenticação.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('remotive');
        const kw      = keywords || config?.keywords || ['qa engineer'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchRemotive({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('remotive', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('remotive');

        return ok({ platform: 'remotive', found: leads.length, ...result });
    });

server.registerTool('search_remoteok',
    { title: 'Buscar vagas no RemoteOK',
      description: 'Consulta API pública do RemoteOK (remote-only, internacional). Filtra por keyword no título/descrição/tags.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('remoteok');
        const kw      = keywords || config?.keywords || ['qa', 'test'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchRemoteOK({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('remoteok', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('remoteok');

        return ok({ platform: 'remoteok', found: leads.length, ...result });
    });

server.registerTool('search_weworkremotely',
    { title: 'Buscar vagas no We Work Remotely',
      description: 'Consulta feeds RSS públicos do We Work Remotely (5 categorias: programming, devops, customer-support, design, all-other). Remote-only, internacional.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          categories:  z.array(z.string()).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, categories, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('weworkremotely');
        const kw      = keywords || config?.keywords || ['qa', 'test'];
        const mr      = max_results || config?.max_results || 20;
        const cats    = categories || config?.categories;

        let leads;
        try {
            leads = await searchWeWorkRemotely({ keywords: kw, maxResults: mr, categories: cats });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('weworkremotely', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('weworkremotely');

        return ok({ platform: 'weworkremotely', found: leads.length, ...result });
    });

server.registerTool('search_remotar',
    { title: 'Buscar vagas no Remotar',
      description: 'Scraper do Remotar.com.br via Playwright (100% remoto, Brasil). Usa Vue.js — requer renderização JS.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('remotar');
        const kw      = keywords || config?.keywords || ['qa', 'analista'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchRemotar({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('remotar', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('remotar');

        return ok({ platform: 'remotar', found: leads.length, ...result });
    });

server.registerTool('search_trampos',
    { title: 'Buscar vagas no Trampos.co',
      description: 'Scraper do Trampos.co via Cheerio (vagas tech/criativas Brasil). Server-side rendered.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('trampos');
        const kw      = keywords || config?.keywords || ['qa', 'analista de qa'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchTrampos({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('trampos', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('trampos');

        return ok({ platform: 'trampos', found: leads.length, ...result });
    });

server.registerTool('search_aijobs',
    { title: 'Buscar vagas no AI Jobs Board',
      description: 'Scraper do TheAIJobBoard.com via Cheerio (WordPress + WP Job Manager). Vagas de IA/ML, remoto, internacional.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('aijobs');
        const kw      = keywords || config?.keywords || ['qa engineer', 'test automation'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchAiJobs({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('aijobs', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('aijobs');

        return ok({ platform: 'aijobs', found: leads.length, ...result });
    });

server.registerTool('search_jsremotely',
    { title: 'Buscar vagas no JS Remotely',
      description: 'Scraper do JSRemotely.com via Cheerio (vagas JS remote, internacional). Site estático.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('jsremotely');
        const kw      = keywords || config?.keywords || ['qa', 'test'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchJsRemotely({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('jsremotely', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('jsremotely');

        return ok({ platform: 'jsremotely', found: leads.length, ...result });
    });

server.registerTool('search_vagas',
    { title: 'Buscar vagas no Vagas.com.br',
      description: 'Scraper do Vagas.com.br via Playwright + stealth (maior board BR). Cloudflare bypass automático.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('vagas');
        const kw      = keywords || config?.keywords || ['analista de qa'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchVagas({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('vagas', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('vagas');

        return ok({ platform: 'vagas', found: leads.length, ...result });
    });

server.registerTool('search_catho',
    { title: 'Buscar vagas no Catho',
      description: 'Scraper do Catho.com.br via Playwright + stealth. Tenta RSS antes de Playwright. 2º maior board BR.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('catho');
        const kw      = keywords || config?.keywords || ['analista de qa'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchCatho({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('catho', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('catho');

        return ok({ platform: 'catho', found: leads.length, ...result });
    });

server.registerTool('search_jooble',
    { title: 'Buscar vagas no Jooble',
      description: 'Scraper do Jooble via API (chave gratuita necessária). Requer JOOBLE_API_KEY no ambiente. Cadastro: https://jooble.org/api/about',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          location:    z.string().optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, location, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('jooble');
        const kw      = keywords || config?.keywords || ['analista de qa'];
        const loc     = location || config?.location || 'Brasil';
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchJooble({ keywords: kw, location: loc, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('jooble', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('jooble');

        return ok({ platform: 'jooble', found: leads.length, ...result });
    });

server.registerTool('search_workana',
    { title: 'Buscar projetos no Workana',
      description: 'Scraper do Workana.com via Cheerio (freelance TI, Brasil/LATAM). Retorna projetos na categoria it-programming.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('workana');
        const kw      = keywords || config?.keywords || ['qa', 'testes'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchWorkana({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('workana', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('workana');

        return ok({ platform: 'workana', found: leads.length, ...result });
    });

server.registerTool('search_99freelas',
    { title: 'Buscar projetos no 99Freelas',
      description: 'Scraper do 99Freelas.com.br via Cheerio (freelance 100% brasileiro). Retorna projetos de tecnologia.',
      inputSchema: {
          keywords:    z.array(z.string()).optional(),
          max_results: z.number().int().min(1).max(30).optional(),
          dry_run:     z.boolean().optional(),
      } },
    async ({ keywords, max_results, dry_run = false }) => {
        const profile = await getProfile();
        const config  = await getSearchPlatformConfig('99freelas');
        const kw      = keywords || config?.keywords || ['qa', 'testes'];
        const mr      = max_results || config?.max_results || 20;

        let leads;
        try {
            leads = await searchFreelas99({ keywords: kw, maxResults: mr });
        } catch (e) {
            return fail(e.message);
        }

        const result = await ingestLeads(leads, profile, dry_run);
        await logSearch('99freelas', kw, leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
        if (!dry_run) await updatePlatformTimestamp('99freelas');

        return ok({ platform: '99freelas', found: leads.length, ...result });
    });

server.registerTool('search_all',
    { title: 'Buscar vagas em todas as plataformas',
      description: 'Orquestra a busca em todas as plataformas habilitadas no perfil (17 plataformas: LinkedIn, Gupy, Maringá, Indeed, InfoJobs, Remotive, RemoteOK, We Work Remotely, Remotar, Trampos.co, AI Jobs, JS Remotely, Vagas.com.br, Catho, Jooble, Workana, 99Freelas). Deduplica e salva leads acima do score mínimo. Aceita filtros opcionais (modalidade, tipo_contratacao, nivel, requires_cnh, location, min_score) aplicados no ingest — leads que não batem são salvos com status=descartada e motivo_descarte=filtro:<campo>.',
      inputSchema: {
          platforms: z.array(z.string()).optional(),
          dry_run:   z.boolean().optional(),
          filters:   z.object({
              modalidade:       z.enum(['Presencial','Híbrida','Remota']).optional(),
              tipo_contratacao: z.array(z.string()).optional(),
              nivel:            z.array(z.string()).optional(),
              requires_cnh:     z.boolean().optional(),
              location:         z.string().optional(),
              min_score:        z.number().int().min(0).max(100).optional(),
          }).optional(),
      } },
    async ({ platforms, dry_run = false, filters = null }) => {
        const profile  = await getProfile();
        const allPlats = Array.isArray(profile.search_platforms) ? profile.search_platforms : [];
        const enabled  = allPlats.filter(p => p.enabled && (!platforms || platforms.includes(p.id)));

        if (enabled.length === 0) return fail('Nenhuma plataforma habilitada no perfil.');

        const summary = {
            total_found: 0, total_new: 0, total_duplicates: 0, total_below_min: 0,
            total_filtered_out: 0, filtered_by_field: {}, by_platform: {},
        };

        for (const plat of enabled) {
            const scraper = SCRAPERS[plat.id];
            if (!scraper) { console.error(`[search_all] Scraper desconhecido: ${plat.id}`); continue; }

            let leads = [];
            let result = { newCount: 0, duplicateCount: 0, belowMinScore: 0, filteredOut: 0, filteredByField: {} };

            // --- Busca primária ---
            try {
                leads = await scraper(plat);
            } catch (e) {
                console.error(`[search_all] Erro em ${plat.id}: ${e.message}`);
                summary.by_platform[plat.id] = { error: e.message };
                await logSearch(plat.id, plat.keywords || [], 0, 0, 0, 0, e.message);
                if (!dry_run) await updatePlatformTimestamp(plat.id);
                continue;
            }

            result = await ingestLeads(leads, profile, dry_run, filters);
            await logSearch(plat.id, plat.keywords || [], leads.length, result.newCount, result.duplicateCount, result.belowMinScore);

            // --- Expansão: se poucos leads novos encontrados, tenta keywords mais amplos ---
            const expandThreshold = plat.min_new_before_expand ?? 3;
            const expansionKeywords = Array.isArray(plat.expansion_keywords) ? plat.expansion_keywords : [];
            if (result.newCount < expandThreshold && expansionKeywords.length > 0) {
                console.error(`[search_all] ${plat.id}: poucos leads (${result.newCount}), expandindo busca…`);
                try {
                    const expandLeads = await scraper({ ...plat, keywords: expansionKeywords, max_results: plat.max_results || 15 });
                    const expandResult = await ingestLeads(expandLeads, profile, dry_run, filters);
                    await logSearch(plat.id + '_expand', expansionKeywords, expandLeads.length, expandResult.newCount, expandResult.duplicateCount, expandResult.belowMinScore);
                    leads = [...leads, ...expandLeads];
                    result.newCount       += expandResult.newCount;
                    result.duplicateCount += expandResult.duplicateCount;
                    result.belowMinScore  += expandResult.belowMinScore;
                    result.filteredOut    += expandResult.filteredOut;
                    for (const [k, v] of Object.entries(expandResult.filteredByField || {})) {
                        result.filteredByField[k] = (result.filteredByField[k] || 0) + v;
                    }
                    console.error(`[search_all] ${plat.id} expandido: +${expandResult.newCount} novos`);
                } catch (e) {
                    console.error(`[search_all] Erro na expansão de ${plat.id}: ${e.message}`);
                }
            }

            if (!dry_run) await updatePlatformTimestamp(plat.id);

            summary.total_found        += leads.length;
            summary.total_new          += result.newCount;
            summary.total_duplicates   += result.duplicateCount;
            summary.total_below_min    += result.belowMinScore;
            summary.total_filtered_out += result.filteredOut;
            for (const [k, v] of Object.entries(result.filteredByField || {})) {
                summary.filtered_by_field[k] = (summary.filtered_by_field[k] || 0) + v;
            }
            summary.by_platform[plat.id] = {
                found:        leads.length,
                new:          result.newCount,
                duplicates:   result.duplicateCount,
                below_min:    result.belowMinScore,
                filtered_out: result.filteredOut,
            };
        }

        return ok(summary);
    });

server.registerTool('ingest_leads',
    { title: 'Ingerir leads manualmente',
      description: 'Deduplica e salva um array de leads brutos. Útil para testar ou importar resultados externos.',
      inputSchema: {
          leads:   z.array(z.object({
              empresa:          z.string(),
              vaga:             z.string().optional(),
              link_vaga:        z.string(),
              descricao:        z.string().optional(),
              fonte:            z.string().optional(),
              modalidade:       z.string().optional(),
              tipo_contratacao: z.string().optional(),
              nivel:            z.string().optional(),
          })).min(1),
          dry_run: z.boolean().optional(),
      } },
    async ({ leads, dry_run = false }) => {
        const profile = await getProfile();
        const result  = await ingestLeads(leads, profile, dry_run);
        return ok(result);
    });

server.registerTool('clear_linkedin_session',
    { title: 'Limpar sessão LinkedIn',
      description: 'Remove o cookie file do LinkedIn. A próxima busca pedirá login interativo.',
      inputSchema: {} },
    async () => {
        const removed = clearSession();
        return ok({ removed, message: removed ? 'Sessão removida. Próxima busca abrirá browser para login.' : 'Nenhuma sessão encontrada.' });
    });

server.registerTool('sync_application_status',
    { title: 'Sincronizar status de candidatura',
      description: 'Verifica o status atual de uma candidatura na plataforma e registra a mudança. Use application_id para sincronizar uma candidatura específica, ou deixe em branco para varrer todas com auto_sync_enabled=true.',
      inputSchema: {
          application_id: z.string().optional(),
          fonte:          z.string().optional(),
          dry_run:        z.boolean().optional(),
      } },
    async ({ application_id, fonte, dry_run = false }) => {
        // Busca candidaturas a sincronizar
        let query = supabase
            .from('job_applications')
            .select('id, empresa, vaga, link_vaga, platform, external_status, last_synced_at, auto_sync_enabled, platform_application_id');

        if (application_id) {
            query = query.eq('id', application_id);
        } else {
            query = query
                .eq('auto_sync_enabled', true)
                .eq('result', 'em_processo')
                .not('platform', 'is', null)
                .order('last_synced_at', { ascending: true, nullsFirst: true })
                .limit(20);
            if (fonte) query = query.eq('platform', fonte);
        }

        const { data: apps, error: appErr } = await query;
        if (appErr) return fail(appErr.message);
        if (!apps?.length) return ok({ message: 'Nenhuma candidatura para sincronizar.', synced: 0 });

        // Busca status_mapping de todas as plataformas presentes
        const platforms = [...new Set(apps.map(a => a.platform).filter(Boolean))];
        const { data: psettings } = await supabase
            .from('platform_settings')
            .select('fonte, status_mapping')
            .in('fonte', platforms);
        const mappings = Object.fromEntries((psettings || []).map(p => [p.fonte, p.status_mapping || {}]));

        const results = [];

        for (const app of apps) {
            if (!app.link_vaga && !app.platform_application_id) {
                results.push({ id: app.id, empresa: app.empresa, skipped: true, reason: 'sem link_vaga' });
                continue;
            }

            let externalStatus = null;
            let syncError = null;

            try {
                // Tenta verificar status via fetch (Gupy tem API pública para status de candidatura)
                if (app.platform === 'gupy' && app.link_vaga) {
                    // URL de candidatura Gupy: https://company.gupy.io/job/12345/apply
                    // Status endpoint: https://company.gupy.io/api/v1/jobs/{jobId}/applications (requer auth)
                    // Fallback: verificar se a vaga ainda está listada
                    const jobUrl = app.link_vaga;
                    const match = jobUrl.match(/gupy\.io\/([^/]+)\/(\d+)/);
                    if (match) {
                        const jobId = match[2];
                        const company = match[1];
                        const apiUrl = `https://${company}.gupy.io/api/v1/jobs/${jobId}`;
                        const resp = await fetch(apiUrl, {
                            headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0' },
                            signal: AbortSignal.timeout(15_000),
                        });
                        if (resp.status === 404) {
                            externalStatus = 'vaga removida';
                        } else if (resp.ok) {
                            const json = await resp.json();
                            externalStatus = json?.status || json?.situacao || 'ativa';
                        } else {
                            externalStatus = `http_${resp.status}`;
                        }
                    }
                } else if (app.link_vaga) {
                    // Verificação simples de disponibilidade (HEAD request)
                    const resp = await fetch(app.link_vaga, {
                        method: 'HEAD',
                        headers: { 'user-agent': 'Mozilla/5.0' },
                        signal: AbortSignal.timeout(10_000),
                        redirect: 'follow',
                    });
                    if (resp.status === 404 || resp.status === 410) {
                        externalStatus = 'vaga removida';
                    } else if (resp.ok) {
                        externalStatus = 'ativa';
                    } else {
                        externalStatus = `http_${resp.status}`;
                    }
                }
            } catch (e) {
                syncError = e.message;
                console.error(`[radar-mcp] [sync] erro em ${app.id}: ${e.message}`);
            }

            // Mapear status externo → interno
            const mapping = mappings[app.platform] || {};
            const normalizedExternal = (externalStatus || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            let newResult = null;
            for (const [extKey, intVal] of Object.entries(mapping)) {
                if (normalizedExternal.includes(extKey.toLowerCase())) {
                    newResult = intVal;
                    break;
                }
            }
            // Detecção simples sem mapeamento configurado
            if (!newResult && externalStatus) {
                if (normalizedExternal.includes('remov') || normalizedExternal.includes('404') || normalizedExternal.includes('410')) {
                    newResult = 'vaga_removida';
                }
            }

            const entry = { id: app.id, empresa: app.empresa, external_status: externalStatus, mapped_result: newResult, sync_error: syncError };
            results.push(entry);

            if (!dry_run) {
                const apiBase = process.env.API_BASE_URL || `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}`;
                const adminKey = process.env.ADMIN_KEY;
                await fetch(`${apiBase}/api/admin/applications?__h=sync-status`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-admin-key': adminKey || '',
                    },
                    body: JSON.stringify({
                        application_id: app.id,
                        fonte:          app.platform || fonte || 'unknown',
                        external_status: externalStatus,
                        new_result:     newResult,
                        error:          syncError,
                    }),
                    signal: AbortSignal.timeout(15_000),
                }).catch(e => console.error(`[radar-mcp] [sync] falha ao gravar resultado: ${e.message}`));
            }
        }

        const changed = results.filter(r => r.mapped_result && !r.skipped).length;
        return ok({ synced: results.length, changed, dry_run, results });
    });

server.registerTool('list_platform_sessions',
    { title: 'Listar sessões de plataformas',
      description: 'Lista as sessões ativas armazenadas por plataforma (sem expor o session_data).',
      inputSchema: {} },
    async () => {
        const { data, error } = await supabase
            .from('platform_sessions')
            .select('id, fonte, display_name, session_type, expires_at, last_used_at, is_valid, created_at')
            .order('fonte');
        return error ? fail(error.message) : ok(data ?? []);
    });

await server.connect(new StdioServerTransport());
console.error('[radar-mcp] servidor MCP do Radar pronto (stdio)');

// ============================================================
// Daemon: heartbeat, Realtime subscriber, graceful shutdown, recovery
// ============================================================

const HEARTBEAT_INTERVAL_MS = 15_000;
const SAFETY_POLL_INTERVAL_MS = 60_000;     // Realtime já notifica; safety net pega o que escapar
const ORPHAN_JOB_THRESHOLD_MS = 10 * 60_000; // 10min em 'running' = órfão

let _heartbeatTimer = null;
let _safetyPollTimer = null;
let _realtimeChannel = null;
let _shuttingDown = false;
let _activeJobId = null;
let _processingLock = false;

async function writeHeartbeat() {
    if (_shuttingDown) return;
    try {
        await supabase.from('candidate_profile')
            .update({ mcp_heartbeat_at: new Date().toISOString() })
            .not('id', 'is', null);
    } catch (_) { /* silencioso — não interrompe loop */ }
}

async function recoverOrphanedJobs() {
    const cutoff = new Date(Date.now() - ORPHAN_JOB_THRESHOLD_MS).toISOString();
    const { data } = await supabase.from('search_requests')
        .update({
            status: 'error',
            error_message: 'Job órfão recuperado no startup (servidor reiniciou)',
            finished_at: new Date().toISOString(),
        })
        .eq('status', 'running')
        .lt('started_at', cutoff)
        .select('id');
    if (data?.length) {
        console.error(`[radar-mcp] [recovery] ${data.length} job(s) órfão(s) marcados como error: ${data.map(d => d.id).join(', ')}`);
    }
}

// Processa um search_request específico (chamado pelo Realtime ou pelo safety poll)
async function processSearchRequest(reqId) {
    if (_shuttingDown || _processingLock) return;
    _processingLock = true;

    try {
        // Buscar e travar o request (CAS via update + select)
        const { data, error } = await supabase.from('search_requests')
            .update({
                status: 'running',
                started_at: new Date().toISOString(),
                progress: { current: null, done: [], total: 0, platforms: [] },
            })
            .eq('id', reqId)
            .eq('status', 'pending')  // só processa se ainda estiver pendente (CAS)
            .select('*')
            .maybeSingle();

        if (error || !data) return; // já foi processado por outro worker ou não existe

        // popula progress correto agora que sabemos as plataformas
        await supabase.from('search_requests')
            .update({ progress: { current: null, done: [], total: data.platforms.length, platforms: data.platforms } })
            .eq('id', data.id);

        _activeJobId = data.id;
        console.error(`[radar-mcp] processando search_request ${data.id} (${data.platforms.join(',')})${data.filters ? ' [com filtros]' : ''}`);

        const profile = await getProfile();
        const reqFilters = data.filters && typeof data.filters === 'object' ? data.filters : null;
        const summary = {
            total_found: 0, total_new: 0, total_duplicates: 0, total_below_min: 0,
            total_filtered_out: 0, filtered_by_field: {}, by_platform: {},
        };
        const donePlatforms = [];

        let _cancelledByUser = false;
        try {
            for (const platId of data.platforms) {
                if (_shuttingDown) break;

                const { data: cur } = await supabase.from('search_requests')
                    .select('status').eq('id', data.id).maybeSingle();
                if (cur?.status === 'cancelled') { _cancelledByUser = true; break; }

                await supabase.from('search_requests')
                    .update({ progress: { current: platId, done: [...donePlatforms], total: data.platforms.length, platforms: data.platforms } })
                    .eq('id', data.id);

                const scraper = SCRAPERS[platId];
                if (!scraper) {
                    console.error(`[radar-mcp] scraper desconhecido: ${platId}`);
                    donePlatforms.push(platId);
                    continue;
                }
                const cfg = {
                    keywords:    data.keywords?.length ? data.keywords : undefined,
                    max_results: data.max_results || undefined,
                };
                let leads = [];
                try {
                    leads = await scraper(cfg);
                } catch (e) {
                    console.error(`[radar-mcp] erro em ${platId}: ${e.message}`);
                    summary.by_platform[platId] = { error: e.message };
                    donePlatforms.push(platId);
                    continue;
                }
                const result = await ingestLeads(leads, profile, data.dry_run, reqFilters);
                await logSearch(platId, cfg.keywords || [], leads.length, result.newCount, result.duplicateCount, result.belowMinScore);
                summary.by_platform[platId] = {
                    found:        leads.length,
                    new:          result.newCount,
                    duplicates:   result.duplicateCount,
                    below_min:    result.belowMinScore,
                    filtered_out: result.filteredOut,
                };
                summary.total_found        += leads.length;
                summary.total_new          += result.newCount;
                summary.total_duplicates   += result.duplicateCount;
                summary.total_below_min    += result.belowMinScore;
                summary.total_filtered_out += result.filteredOut;
                for (const [k, v] of Object.entries(result.filteredByField || {})) {
                    summary.filtered_by_field[k] = (summary.filtered_by_field[k] || 0) + v;
                }
                donePlatforms.push(platId);
            }

            let finalStatus, errorMessage;
            if (_cancelledByUser) {
                finalStatus  = 'cancelled';
                errorMessage = 'Cancelado pelo usuário';
            } else if (_shuttingDown) {
                finalStatus  = 'error';
                errorMessage = 'Interrompido por shutdown do servidor';
            } else {
                finalStatus  = 'done';
                errorMessage = null;
            }
            if (!_cancelledByUser) {
                await supabase.from('search_requests')
                    .update({
                        status: finalStatus,
                        result: summary,
                        error_message: errorMessage,
                        finished_at: new Date().toISOString(),
                        progress: { current: null, done: donePlatforms, total: data.platforms.length, platforms: data.platforms },
                    })
                    .eq('id', data.id);
            }
            console.error(`[radar-mcp] search_request ${data.id} ${finalStatus}: ${summary.total_new} novas vagas`);
        } catch (e) {
            await supabase.from('search_requests')
                .update({ status: 'error', error_message: e.message, finished_at: new Date().toISOString() }).eq('id', data.id);
            console.error(`[radar-mcp] search_request ${data.id} falhou: ${e.message}`);
        }
    } finally {
        _activeJobId = null;
        _processingLock = false;
    }
}

// Safety net: varre pedidos pending eventualmente perdidos (ex: reconexão de WS)
async function processPendingFromQueue() {
    if (_shuttingDown || _processingLock) return;
    const { data } = await supabase.from('search_requests')
        .select('id').eq('status', 'pending').order('created_at').limit(1).maybeSingle();
    if (data) await processSearchRequest(data.id);
}

function startRealtimeSubscriber() {
    _realtimeChannel = supabase
        .channel('search_requests_inserts')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'search_requests', filter: 'status=eq.pending' },
            payload => {
                console.error(`[radar-mcp] [realtime] novo pedido: ${payload.new.id}`);
                processSearchRequest(payload.new.id).catch(e => console.error('[radar-mcp] error:', e.message));
            })
        .subscribe(status => console.error(`[radar-mcp] [realtime] status: ${status}`));
}

async function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.error(`[radar-mcp] [shutdown] sinal ${signal} recebido`);
    clearInterval(_heartbeatTimer);
    clearInterval(_safetyPollTimer);
    if (_realtimeChannel) supabase.removeChannel(_realtimeChannel).catch(() => {});

    if (_activeJobId) {
        console.error(`[radar-mcp] [shutdown] aguardando job ${_activeJobId} terminar (max 30s)...`);
        const deadline = Date.now() + 30_000;
        while (_activeJobId && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (_activeJobId) {
            await supabase.from('search_requests')
                .update({ status: 'error', error_message: 'Interrompido por shutdown', finished_at: new Date().toISOString() })
                .eq('id', _activeJobId);
            console.error(`[radar-mcp] [shutdown] job ${_activeJobId} forçado para error`);
        }
    }
    console.error('[radar-mcp] [shutdown] OK');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Startup
await recoverOrphanedJobs();
writeHeartbeat();
_heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
startRealtimeSubscriber();
_safetyPollTimer = setInterval(() => processPendingFromQueue().catch(e => console.error('[radar-mcp] safety poll:', e.message)), SAFETY_POLL_INTERVAL_MS);
// Primeira varredura imediata para pegar qualquer pendente acumulado
processPendingFromQueue().catch(() => {});
