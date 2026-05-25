#!/usr/bin/env node
/**
 * JobSync CLI — acesso rápido ao Radar de Vagas via terminal.
 *
 * Configuração inicial:
 *   node cli/jobsync.mjs config --url https://seusite.vercel.app --token SEU_TOKEN
 *
 * Comandos:
 *   inbox                       Lista itens pendentes de ação
 *   status                      Candidaturas em andamento
 *   leads [--min-score N]       Leads no Radar (padrão: score >= 6)
 *   followup [--due-today]      Follow-ups sugeridos
 *   apply <lead_id>             Registra candidatura a um lead
 *   note <app_id> <texto>       Adiciona observação a uma candidatura
 *   trends                      Tendências de mercado pessoal
 *   export [--since YYYY-MM-DD] [--type TYPE] [--anon]  Exporta dados
 *   config --url <url> --token <token>  Salva configuração local
 *   config --show               Exibe configuração atual
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), '.jobsync.json');

function loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
        die('Configuração não encontrada. Execute primeiro:\n  node cli/jobsync.mjs config --url <url> --token <token>');
    }
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        die('Arquivo de configuração corrompido. Reconfigure com: config --url ... --token ...');
    }
}

function saveConfig(cfg) {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function apiFetch(config, path, opts = {}) {
    const url = `${config.url}${path}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        die(`Erro na API (${res.status}): ${body}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
}

// ── Helpers visuais ───────────────────────────────────────────────────────────

const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

const b = s  => `${BOLD}${s}${RESET}`;
const c = s  => `${CYAN}${s}${RESET}`;
const g = s  => `${GREEN}${s}${RESET}`;
const y = s  => `${YELLOW}${s}${RESET}`;
const r = s  => `${RED}${s}${RESET}`;
const d = s  => `${DIM}${s}${RESET}`;

function die(msg) {
    console.error(r('✗ ') + msg);
    process.exit(1);
}

function header(title) {
    const line = '─'.repeat(Math.max(0, 50 - title.length - 4));
    console.log('\n' + b(c(`── ${title} `) + c(line)));
}

function fmtDate(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function scoreColor(n) {
    const s = String(n ?? '–');
    if (n >= 8) return g(s);
    if (n >= 6) return y(s);
    return r(s);
}

function priorityIcon(p) {
    if (p === 'critico') return r('🔴');
    if (p === 'alto')    return y('🟡');
    return d('⚪');
}

// ── Comandos ──────────────────────────────────────────────────────────────────

async function cmdConfig(args) {
    if (args.includes('--show')) {
        const cfg = loadConfig();
        console.log(b('Configuração atual:'));
        console.log(`  URL:   ${c(cfg.url)}`);
        console.log(`  Token: ${d(cfg.token.slice(0, 8) + '…')}`);
        return;
    }

    const urlIdx   = args.indexOf('--url');
    const tokenIdx = args.indexOf('--token');
    if (urlIdx === -1 || tokenIdx === -1) die('Use: config --url <base_url> --token <admin_token>');

    const url   = args[urlIdx + 1];
    const token = args[tokenIdx + 1];
    if (!url || !token) die('URL e token são obrigatórios.');

    saveConfig({ url: url.replace(/\/$/, ''), token });
    console.log(g('✓ Configuração salva em ') + d(CONFIG_PATH));
}

async function cmdInbox(config) {
    header('Inbox');
    // __h=inbox retorna { items: [...] }
    const data  = await apiFetch(config, '/api/admin/applications?__h=inbox');
    const items = data?.items ?? [];

    if (!items.length) { console.log(d('  Nenhum item pendente.\n')); return; }

    for (const item of items) {
        const icon = priorityIcon(item.priority);
        console.log(`\n${icon} ${b(item.title || item.category)}`);
        if (item.subtitle) console.log(`   ${d(item.subtitle)}`);
        const acts = (item.actions || []).map(a => a.label).join(' · ');
        if (acts) console.log(`   ${d('↳ ' + acts)}`);
    }
    console.log('');
}

async function cmdStatus(config) {
    header('Candidaturas em andamento');
    // GET default retorna array; filtramos client-side por result
    const all  = await apiFetch(config, '/api/admin/applications');
    const apps = (Array.isArray(all) ? all : []).filter(a => !a.result || a.result === 'em_processo');

    if (!apps.length) { console.log(d('  Nenhuma candidatura em processo.\n')); return; }

    const W = [26, 20, 16, 12];
    console.log(d(
        'Empresa'.padEnd(W[0]) + 'Vaga'.padEnd(W[1]) +
        'Etapa'.padEnd(W[2]) + 'Atualiz.'
    ));
    console.log(d('─'.repeat(W.reduce((a, v) => a + v, 0))));

    for (const app of apps) {
        const currentStage = Array.isArray(app.stages)
            ? (app.stages.find(s => s.status === 'running' || s.active)?.name ?? '–')
            : '–';
        console.log(
            c((app.empresa || '–').slice(0, W[0]-2).padEnd(W[0])) +
            (app.vaga || '–').slice(0, W[1]-2).padEnd(W[1]) +
            y(currentStage.slice(0, W[2]-2).padEnd(W[2])) +
            d(fmtDate(app.last_update || app.data_envio || app.created_at))
        );
    }
    console.log('');
}

async function cmdLeads(config, args) {
    const scoreIdx = args.indexOf('--min-score');
    const minScore = scoreIdx !== -1 ? parseInt(args[scoreIdx + 1] || '6', 10) : 6;
    header(`Leads — score ≥ ${minScore}`);

    // GET /api/admin/radar retorna array ordenado por fit_score desc
    const all   = await apiFetch(config, '/api/admin/radar');
    const leads = (Array.isArray(all) ? all : []).filter(l => (l.fit_score ?? 0) >= minScore);

    if (!leads.length) { console.log(d(`  Nenhum lead com score ≥ ${minScore}.\n`)); return; }

    for (const lead of leads.slice(0, 20)) {
        console.log(
            `  ${scoreColor(lead.fit_score)} ` +
            c((lead.empresa || '–').padEnd(22).slice(0, 22)) +
            ' ' + (lead.vaga || '–').slice(0, 32)
        );
        const meta = [lead.modalidade, lead.tipo_contratacao, lead.nivel].filter(Boolean).join(' · ');
        if (meta) console.log(`       ${d(meta)}`);
    }
    if (leads.length > 20) console.log(d(`  … e mais ${leads.length - 20} leads`));
    console.log('');
}

async function cmdFollowup(config, args) {
    header('Follow-ups sugeridos');
    // __h=followup-suggestions retorna array de sugestões
    const sugs = await apiFetch(config, '/api/admin/applications?__h=followup-suggestions');
    const list = Array.isArray(sugs) ? sugs : [];

    const dueOnly = args.includes('--due-today');
    const today   = new Date().toDateString();
    const items   = dueOnly
        ? list.filter(s => s.detected_at && new Date(s.detected_at).toDateString() === today)
        : list;

    if (!items.length) { console.log(d('  Nenhum follow-up pendente.\n')); return; }

    for (const s of items) {
        const empresa = s.job_applications?.empresa || '–';
        const vaga    = s.job_applications?.vaga    || '–';
        console.log(`\n  ${b(empresa)} — ${vaga}`);
        console.log(`  ${d(`${s.days_idle ?? '?'} dias sem atualização · Etapa: ${s.current_stage || '–'}`)}`);
        if (s.suggested_message) {
            const preview = s.suggested_message.slice(0, 120).replace(/\n/g, ' ');
            console.log(`  "${d(preview)}${s.suggested_message.length > 120 ? '…' : ''}"`);
        }
        console.log(`  ${d('ID: ' + s.id)}`);
    }
    console.log('');
}

async function cmdApply(config, args) {
    const leadId = args[0];
    if (!leadId) die('Informe o lead_id. Ex: apply abc123');

    header('Registrar candidatura');

    // GET /api/admin/radar?id=xxx
    const lead = await apiFetch(config, `/api/admin/radar?id=${encodeURIComponent(leadId)}`);
    console.log(`  Vaga:    ${b(lead.vaga || '–')}`);
    console.log(`  Empresa: ${c(lead.empresa || '–')}`);
    console.log(`  Score:   ${scoreColor(lead.fit_score ?? 0)}`);

    // POST /api/admin/applications  {empresa, vaga, origin_radar_id}
    const result = await apiFetch(config, '/api/admin/applications', {
        method: 'POST',
        body: JSON.stringify({
            empresa: lead.empresa,
            vaga: lead.vaga,
            origin_radar_id: leadId,
            link_vaga: lead.link_vaga,
            modalidade: lead.modalidade,
            tipo_contratacao: lead.tipo_contratacao,
        }),
    });

    console.log(g(`\n  ✓ Candidatura criada (ID: ${result.id || '–'})`));
    console.log('');
}

async function cmdNote(config, args) {
    const appId = args[0];
    const text  = args.slice(1).join(' ');
    if (!appId || !text) die('Use: note <app_id> <texto da observação>');

    // PATCH /api/admin/applications?id=xxx  {observacoes}
    await apiFetch(config, `/api/admin/applications?id=${encodeURIComponent(appId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ observacoes: text }),
    });

    console.log(g('✓ Observação salva.'));
}

async function cmdTrends(config) {
    header('Tendências de mercado pessoal');
    // __h=market-trends retorna {top_keywords, modalidade, conversion_rate_pct, ...}
    const data = await apiFetch(config, '/api/admin/applications?__h=market-trends');

    console.log(`  Leads (6 meses): ${b(String(data.total_leads ?? 0))}  ·  Candidaturas: ${b(String(data.total_apps ?? 0))}`);
    if (data.conversion_rate_pct != null) {
        console.log(`  Taxa de aprovação: ${data.conversion_rate_pct >= 20 ? g : y}(${data.conversion_rate_pct}%${RESET})`);
    }

    if (data.top_keywords?.length) {
        console.log(b('\nTop skills demandadas:'));
        const max = data.top_keywords[0].count || 1;
        for (const s of data.top_keywords.slice(0, 8)) {
            const bar = '█'.repeat(Math.round((s.count / max) * 12));
            console.log(`  ${c(s.skill.padEnd(20))} ${y(bar)} ${d(s.count + 'x')}`);
        }
    }

    if (data.modalidade && Object.keys(data.modalidade).length) {
        console.log(b('\nModalidade:'));
        const total = Object.values(data.modalidade).reduce((a, v) => a + v, 0) || 1;
        for (const [mod, cnt] of Object.entries(data.modalidade)) {
            const pct = Math.round(cnt / total * 100);
            console.log(`  ${mod.padEnd(14)} ${y(pct + '%')}`);
        }
    }

    if (data.fit_buckets) {
        console.log(b('\nDistribuição de score:'));
        for (const [range, cnt] of Object.entries(data.fit_buckets)) {
            console.log(`  Score ${range.padEnd(6)} ${d(String(cnt) + ' leads')}`);
        }
    }
    console.log('');
}

async function cmdExport(config, args) {
    const sinceIdx = args.indexOf('--since');
    const typeIdx  = args.indexOf('--type');
    const anon     = args.includes('--anon');

    const since = sinceIdx !== -1 ? args[sinceIdx + 1] : '';
    const type  = typeIdx  !== -1 ? args[typeIdx  + 1] : 'all';

    header('Exportação LGPD');

    let qs = `?__h=lgpd-export&type=${encodeURIComponent(type)}&anonymous=${anon}`;
    if (since) qs += `&since=${encodeURIComponent(since)}`;

    const res = await apiFetch(config, `/api/admin/applications${qs}`);

    const outFile = `jobsync-export-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(outFile, typeof res === 'string' ? res : JSON.stringify(res, null, 2), 'utf8');
    console.log(g(`✓ Exportado para ${b(outFile)}`));
    console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const [,, cmd, ...args] = process.argv;

    if (!cmd || cmd === '--help' || cmd === 'help') {
        console.log(`
${b('JobSync CLI')} — Radar de Vagas no terminal

${b('Uso:')}
  node cli/jobsync.mjs <comando> [opções]

${b('Comandos:')}
  ${c('config')}   --url <url> --token <token>   Configura acesso à API
  ${c('config')}   --show                         Exibe config atual
  ${c('inbox')}                                   Itens pendentes de ação
  ${c('status')}                                  Candidaturas em andamento
  ${c('leads')}    [--min-score N]                Leads no Radar (padrão: 6)
  ${c('followup')} [--due-today]                  Follow-ups sugeridos
  ${c('apply')}    <lead_id>                      Registra candidatura
  ${c('note')}     <app_id> <texto>               Adiciona observação
  ${c('trends')}                                  Tendências de mercado
  ${c('export')}   [--since YYYY-MM-DD] [--type TYPE] [--anon]   Exporta dados

${b('Exemplos:')}
  node cli/jobsync.mjs leads --min-score 8
  node cli/jobsync.mjs followup --due-today
  node cli/jobsync.mjs export --since 2026-01-01 --anon
  node cli/jobsync.mjs note 550e8400 "empresa disse que retorna em 5 dias"
`);
        return;
    }

    if (cmd === 'config') { await cmdConfig(args); return; }

    const config = loadConfig();

    switch (cmd) {
        case 'inbox':    await cmdInbox(config);          break;
        case 'status':   await cmdStatus(config);         break;
        case 'leads':    await cmdLeads(config, args);    break;
        case 'followup': await cmdFollowup(config, args); break;
        case 'apply':    await cmdApply(config, args);    break;
        case 'note':     await cmdNote(config, args);     break;
        case 'trends':   await cmdTrends(config);         break;
        case 'export':   await cmdExport(config, args);   break;
        default:
            die(`Comando desconhecido: "${cmd}". Use --help para ver os comandos.`);
    }
}

main().catch(err => {
    console.error(r('Erro fatal: ') + err.message);
    process.exit(1);
});
