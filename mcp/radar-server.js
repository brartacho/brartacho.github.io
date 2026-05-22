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
          fit_score: z.number().int().min(0).max(10).nullable().optional(),
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

await server.connect(new StdioServerTransport());
console.error('[radar-mcp] servidor MCP do Radar pronto (stdio)');
