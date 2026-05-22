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
      } },
    async (a) => {
        const keywords = [...new Set([...(a.required_keywords || []), ...(a.nice_to_have_keywords || [])])];
        const patch = {
            fit_score_ia: a.fit_score ?? null,
            keywords_match: keywords,
            gaps: a.gaps || [],
            positioning: a.positioning || null,
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
        const { data } = await supabase.from('vaga_radar').select('id,empresa,vaga,status,fit_score')
            .eq('link_vaga', link_vaga).maybeSingle();
        return ok(data ?? null);
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

await server.connect(new StdioServerTransport());
console.error('[radar-mcp] servidor MCP do Radar pronto (stdio)');
