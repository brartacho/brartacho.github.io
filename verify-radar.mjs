/**
 * Testa os scrapers de busca de vagas (sem salvar no banco).
 * Uso: node verify-radar.mjs
 *
 * Variáveis de ambiente necessárias para o teste de scoring:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * LinkedIn: requer sessão ativa — use search_linkedin via MCP para autenticar.
 */

import { searchGupy }    from './mcp/search/gupy.js';
import { searchMaringa } from './mcp/search/maringa.js';
import { searchIndeed }  from './mcp/search/indeed.js';
import { createClient }  from '@supabase/supabase-js';
import { scoreVaga }     from './api/_lib/scoring.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getProfile() {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('[warn] SUPABASE_URL/SUPABASE_SERVICE_KEY não definidas — scoring desativado\n');
        return null;
    }
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await sb.from('candidate_profile').select('*').single();
    if (error) { console.error('[supabase] Erro ao carregar perfil:', error.message); return null; }
    return data;
}

function printLeads(platform, leads, profile) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${platform.toUpperCase()} — ${leads.length} vagas encontradas`);
    console.log('─'.repeat(60));

    if (leads.length === 0) {
        console.log('  (nenhuma vaga retornada)');
        return;
    }

    for (const lead of leads) {
        const score = profile ? scoreVaga(lead, profile) : null;
        const scoreStr = score !== null ? ` [score: ${score}]` : '';
        console.log(`\n  🏢 ${lead.empresa || '?'}`);
        console.log(`  📌 ${lead.vaga || 'Título não disponível'}${scoreStr}`);
        console.log(`  🔗 ${lead.link_vaga}`);
        if (lead.modalidade)       console.log(`  📍 ${lead.modalidade}`);
        if (lead.tipo_contratacao) console.log(`  📄 ${lead.tipo_contratacao}`);
        if (lead.descricao)        console.log(`  📝 ${lead.descricao.slice(0, 120).replace(/\n/g, ' ')}…`);
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  VERIFY RADAR — Teste de Scrapers (dry_run)');
    console.log(`  ${new Date().toLocaleString('pt-BR')}`);
    console.log('═'.repeat(60));

    const profile = await getProfile();

    const results = { ok: [], fail: [] };

    // ── Gupy ──────────────────────────────────────────────────────
    console.log('\n▶ Testando Gupy...');
    try {
        const leads = await searchGupy({ keywords: ['analista de qa', 'quality assurance'], maxResults: 5 });
        printLeads('gupy', leads, profile);
        results.ok.push(`Gupy: ${leads.length} vagas`);
    } catch (e) {
        console.error(`[gupy] ERRO: ${e.message}`);
        results.fail.push(`Gupy: ${e.message}`);
    }

    // ── Maringá ───────────────────────────────────────────────────
    console.log('\n▶ Testando Maringá...');
    try {
        const leads = await searchMaringa({ keywords: ['qualidade', 'implantação'], maxResults: 5 });
        printLeads('maringa', leads, profile);
        results.ok.push(`Maringá: ${leads.length} vagas`);
    } catch (e) {
        console.error(`[maringa] ERRO: ${e.message}`);
        results.fail.push(`Maringá: ${e.message}`);
    }

    // ── Indeed ────────────────────────────────────────────────────
    console.log('\n▶ Testando Indeed...');
    try {
        const leads = await searchIndeed({ keywords: ['analista de qa', 'qa analyst'], maxResults: 5 });
        printLeads('indeed', leads, profile);
        results.ok.push(`Indeed: ${leads.length} vagas`);
    } catch (e) {
        console.error(`[indeed] ERRO: ${e.message}`);
        results.fail.push(`Indeed: ${e.message}`);
    }

    // ── Resumo ────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  RESUMO');
    console.log('═'.repeat(60));
    for (const ok of results.ok)   console.log(`  ✅ ${ok}`);
    for (const f  of results.fail) console.log(`  ❌ ${f}`);
    console.log('\n  LinkedIn: autenticar via MCP → search_linkedin(dry_run=true)');
    console.log('═'.repeat(60));
}

main().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
