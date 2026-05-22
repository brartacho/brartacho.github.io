-- ============================================================
-- Migration 024 - Corrige linkedin_empresa no seed demo
-- Substitui URLs de empresas fictícias pelo perfil real do
-- candidato (linkedin.com/in/bruno-artacho), evitando links
-- que apontam para páginas em branco ou com login obrigatório.
-- ============================================================

create or replace function demo_seed(p_session_id uuid) returns void as $$
declare
    cv1 uuid; cv2 uuid; cv3 uuid; cv4 uuid; cv5 uuid;
begin
    -- Idempotente
    if exists (select 1 from demo_cv_versions where session_id = p_session_id limit 1) then
        return;
    end if;

    -- ── 5 variações de currículo com perfis distintos ──
    insert into demo_cv_versions (session_id, name, description, file_name, active, created_at) values
        (p_session_id, 'QA Engineer — Sênior',
         'Foco em automação E2E (Playwright), testes de API (Postman/Newman) e processos de qualidade em HealthTech',
         'cv-jon-snow-qa-senior.pdf', true, now() - interval '35 days')
        returning id into cv1;

    insert into demo_cv_versions (session_id, name, description, file_name, active, created_at) values
        (p_session_id, 'Backend Developer — Node.js',
         'APIs REST com Node.js/Express, PostgreSQL, autenticação JWT, deploy em Vercel/Render',
         'cv-jon-snow-backend-nodejs.pdf', true, now() - interval '12 days')
        returning id into cv2;

    insert into demo_cv_versions (session_id, name, description, file_name, active, created_at) values
        (p_session_id, 'Frontend Developer — React/TypeScript',
         'Interfaces modernas com React, TypeScript, Next.js e Tailwind CSS; foco em acessibilidade e performance',
         'cv-jon-snow-frontend-react.pdf', true, now() - interval '10 days')
        returning id into cv3;

    insert into demo_cv_versions (session_id, name, description, file_name, active, created_at) values
        (p_session_id, 'Desenvolvedor Pleno — Node.js + React',
         'Versão híbrida para startups com times enxutos: back Node.js, front React, infra Vercel/Supabase',
         'cv-jon-snow-dev-pleno.pdf', false, now() - interval '180 days')
        returning id into cv4;

    insert into demo_cv_versions (session_id, name, description, file_name, active, created_at) values
        (p_session_id, 'QA Automation — EN / Remote',
         'Bilíngue para vagas internacionais: Playwright E2E, CI/CD (GitHub Actions), BDD com Cucumber',
         'cv-jon-snow-qa-bilingue-en.pdf', true, now() - interval '55 days')
        returning id into cv5;

    -- ── 8 Tokens (mix de status: ativos, expirados, esgotados, revogados) ──
    insert into demo_download_tokens (session_id, cv_version_id, label, hash, expires_at, max_uses, use_count, revoked, created_at) values
        (p_session_id, cv2, 'Nubank · Ana Costa · Backend Sr',          'a1b2c3d4', now() + interval '5 days',    5, 1, false, now() - interval '2 days'),
        (p_session_id, cv3, 'iFood · Camila Rocha · Frontend Sr',       'e5f6g7h8', now() + interval '3 days',    3, 2, false, now() - interval '4 days'),
        (p_session_id, cv1, 'CI&T · Rafael Dias · QA Automation',       'i9j0k1l2', now() - interval '1 day',     5, 5, false, now() - interval '10 days'),
        (p_session_id, cv5, 'Stark Ventures · Arya Stark · QA Lead',    'm3n4o5p6', now() + interval '7 days', null, 0, false, now() - interval '1 day'),
        (p_session_id, cv2, 'Stone · Marina Souza · Backend',            'q7r8s9t0', now() - interval '3 days',    1, 1, false, now() - interval '8 days'),
        (p_session_id, cv3, 'PagSeguro · Lucas Mendes · Frontend',       'u1v2w3x4', now() + interval '2 days',    3, 0, true,  now() - interval '6 days'),
        (p_session_id, cv4, 'MercadoLivre · João Almeida · Dev Pleno',   'y5z6a7b8', now() + interval '10 days',  10, 3, false, now() - interval '5 days'),
        (p_session_id, cv1, 'Magalu · Lia Pereira · QA Sênior',          'c9d0e1f2', now() + interval '1 day',     5, 2, false, now() - interval '3 days');

    -- ── 10 Candidaturas: mix de QA, Backend, Frontend, Pleno ──
    -- linkedin_empresa aponta para o perfil do candidato (Bruno Artacho) para
    -- evitar links de empresa que exigem login ou aparecem em branco no LinkedIn
    insert into demo_job_applications (session_id, empresa, vaga, gestor_nome, gestor_email, gestor_phone, linkedin_empresa, link_vaga, cv_version_id, modalidade, tipo_contratacao, observacoes, stages, result, data_envio, archived, created_at) values
        (p_session_id, 'Nubank',        'Backend Engineer Sr',       'Ana Costa',    'a.costa@nubank.com.br',       '11987654321', 'https://linkedin.com/in/bruno-artacho', 'https://nubank.com.br/careers/backend',      cv2, 'Remota',     'CLT', 'Processo bem estruturado. Foco em sistemas distribuídos e alta disponibilidade.',  '[{"name":"Enviado","status":"running","date":"2026-05-14"},{"name":"Entrevista RH","status":"pending"},{"name":"Desafio Técnico","status":"pending"},{"name":"Proposta","status":"pending"}]'::jsonb, 'em_processo', now() - interval '1 day',  false, now() - interval '1 day'),
        (p_session_id, 'iFood',         'Frontend Engineer Sr',      'Camila Rocha', 'c.rocha@ifood.com.br',        '11912345678', 'https://linkedin.com/in/bruno-artacho', 'https://ifood.com.br/jobs/frontend-sr',      cv3, 'Híbrida',    'CLT', 'Stack React + Next.js. Time de produto muito técnico e bem estruturado.',         '[{"name":"Enviado","status":"done","date":"2026-05-10"},{"name":"Entrevista RH","status":"done","date":"2026-05-13"},{"name":"Desafio Técnico","status":"running","date":"2026-05-16"},{"name":"Proposta","status":"pending"}]'::jsonb, 'em_processo', now() - interval '5 days', false, now() - interval '5 days'),
        (p_session_id, 'Conta Azul',    'QA Engineer Sênior',        'Rafael Dias',  'r.dias@contaazul.com',        '47999887766', 'https://linkedin.com/in/bruno-artacho', 'https://contaazul.com/careers/qa-senior',    cv1, 'Remota',     'CLT', 'Proposta aceita! Cultura forte de qualidade, automação valorizada.',             '[{"name":"Enviado","status":"done","date":"2026-05-02"},{"name":"Entrevista RH","status":"done","date":"2026-05-06"},{"name":"Proposta","status":"done","date":"2026-05-09"}]'::jsonb, 'aprovado', now() - interval '13 days', false, now() - interval '13 days'),
        (p_session_id, 'CI&T',          'QA Automation Engineer',    'Ana Lima',     'a.lima@ciandt.com',           null,          'https://linkedin.com/in/bruno-artacho', 'https://ciandt.com/jobs/qa-automation',      cv5, 'Híbrida',    'PJ',  'Exigiram Cypress além de Playwright. Processo encerrado.',                       '[{"name":"Enviado","status":"done","date":"2026-04-28"},{"name":"Entrevista RH","status":"rejected","date":"2026-05-05"}]'::jsonb, 'recusado',    now() - interval '17 days', false, now() - interval '17 days'),
        (p_session_id, 'Totvs',         'Desenvolvedor Pleno',        'Pedro Almeida','p.almeida@totvs.com.br',     '41988776655', 'https://linkedin.com/in/bruno-artacho', 'https://totvs.com/jobs/dev-pleno',           cv4, 'Presencial', 'CLT', null,                                                                            '[{"name":"Enviado","status":"running","date":"2026-05-15"},{"name":"Entrevista RH","status":"pending"},{"name":"Desafio Técnico","status":"pending"}]'::jsonb, 'em_processo', now() - interval '0 days', false, now() - interval '0 days'),
        (p_session_id, 'Stone',         'Backend Developer Pleno',   'Marina Souza', 'm.souza@stone.com.br',        '21988112233', 'https://linkedin.com/in/bruno-artacho', 'https://stone.com.br/careers/backend-pleno', cv2, 'Remota',     'CLT', 'Fintech de alto crescimento. Processo técnico exigente mas justo.',              '[{"name":"Enviado","status":"done","date":"2026-05-08"},{"name":"Entrevista RH","status":"done","date":"2026-05-12"},{"name":"Desafio Técnico","status":"pending"}]'::jsonb, 'em_processo', now() - interval '7 days', false, now() - interval '7 days'),
        (p_session_id, 'PagSeguro',     'Frontend Developer Pleno',  'Lucas Mendes', 'l.mendes@pagseguro.com',      null,          'https://linkedin.com/in/bruno-artacho', 'https://pagseguro.uol.com.br/jobs/frontend', cv3, 'Híbrida',    'CLT', 'Aguardando retorno do RH há 3 dias.',                                            '[{"name":"Enviado","status":"running","date":"2026-05-09"},{"name":"Entrevista RH","status":"pending"}]'::jsonb, 'em_processo', now() - interval '6 days', false, now() - interval '6 days'),
        (p_session_id, 'MercadoLivre',  'Software Engineer Pleno',   'João Almeida', 'j.almeida@mercadolivre.com',  '11955443322', 'https://linkedin.com/in/bruno-artacho', 'https://mercadolivre.com/jobs/swe-pleno',    cv4, 'Remota',     'CLT', 'You know nothing, Jon Snow — mas a stack impressiona. Proposta em andamento.',   '[{"name":"Enviado","status":"done","date":"2026-05-04"},{"name":"Entrevista RH","status":"done","date":"2026-05-08"},{"name":"Desafio Técnico","status":"done","date":"2026-05-11"},{"name":"Proposta","status":"running","date":"2026-05-15"}]'::jsonb, 'em_processo', now() - interval '11 days', false, now() - interval '11 days'),
        (p_session_id, 'Magalu',        'QA Engineer Pleno',         'Lia Pereira',  'l.pereira@magazineluiza.com', '11944332211', 'https://linkedin.com/in/bruno-artacho', 'https://magalu.com/jobs/qa-pleno',           cv1, 'Remota',     'PJ',  'Time enxuto, muito produtivo. PJ com desconto razoável.',                        '[{"name":"Enviado","status":"done","date":"2026-05-11"},{"name":"Entrevista RH","status":"running","date":"2026-05-14"}]'::jsonb, 'em_processo', now() - interval '4 days', false, now() - interval '4 days'),
        (p_session_id, 'Banco Inter',   'Backend Developer',         'Carlos Vidal', 'c.vidal@bancointer.com.br',   null,          'https://linkedin.com/in/bruno-artacho', 'https://bancointer.com.br/jobs/backend',     cv2, 'Presencial', 'CLT', 'Vaga antiga (dez/2025). Sem retorno após envio. Candidatura arquivada.',          '[{"name":"Enviado","status":"running","date":"2025-12-20"}]'::jsonb, 'em_processo', now() - interval '146 days', true, now() - interval '146 days');

    -- ── 4 Logs (downloads + envios) — LGPD: IPs sempre hash ──
    insert into demo_download_logs (session_id, cv_version_id, cv_name_snapshot, ip_address, user_agent, empresa, vaga, downloaded_at, created_at) values
        (p_session_id, cv2, 'Backend Developer — Node.js',           'ip:a3f2b8c1',              'Mozilla/5.0 (Macintosh; Intel Mac OS X)',          'Nubank',  'Backend Engineer Sr',  now() - interval '20 hours', now() - interval '20 hours'),
        (p_session_id, cv3, 'Frontend Developer — React/TypeScript',  'ip:e5f6g7h8',              'Mozilla/5.0 (Windows NT 10.0)',                    'iFood',   'Frontend Engineer Sr', now() - interval '4 days',   now() - interval '4 days'),
        (p_session_id, cv2, 'Backend Developer — Node.js',           'admin-send-email',         'Send to Ana Costa <a.costa@nubank.com.br>',        'Nubank',  'Backend Engineer Sr',  now() - interval '1 day',    now() - interval '1 day'),
        (p_session_id, cv3, 'Frontend Developer — React/TypeScript',  'admin-send-whatsapp-link', 'Send to Camila Rocha via whatsapp-link',           'iFood',   'Frontend Engineer Sr', now() - interval '5 days',   now() - interval '5 days');

end;
$$ language plpgsql security definer;
