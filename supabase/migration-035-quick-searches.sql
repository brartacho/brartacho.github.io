-- Buscas rápidas personalizáveis por usuário (array JSONB).
-- Default popula com os 7 atalhos do LinkedIn que estavam hardcoded no JS.
-- Frontend interpola {kw} com a primeira keyword do perfil.
ALTER TABLE candidate_profile
  ADD COLUMN IF NOT EXISTS quick_searches JSONB NOT NULL DEFAULT '[
    {"id":"linkedin_24h_remote","label":"Últimas 24h (remoto)","icon":"fa-clock","url_template":"https://www.linkedin.com/jobs/search/?keywords={kw}&f_WT=2&f_TPR=r86400&sortBy=DD","enabled":true},
    {"id":"linkedin_7d_remote","label":"Últimos 7 dias (remoto)","icon":"fa-calendar-week","url_template":"https://www.linkedin.com/jobs/search/?keywords={kw}&f_WT=2&f_TPR=r604800&sortBy=DD","enabled":true},
    {"id":"posts_contratando","label":"Publicações: contratando","icon":"fa-bullhorn","url_template":"https://www.linkedin.com/search/results/content/?keywords=%22contratando%22%20{kw}","enabled":true},
    {"id":"posts_vaga","label":"Mercado oculto: vaga","icon":"fa-eye","url_template":"https://www.linkedin.com/search/results/content/?keywords=%22vaga%22%20{kw}","enabled":true},
    {"id":"people_leads","label":"Gestores (Tech Lead/Head)","icon":"fa-user-tie","url_template":"https://www.linkedin.com/search/results/people/?keywords=%22Tech%20Lead%22%20OR%20%22Head%22%20{kw}","enabled":true},
    {"id":"boolean_qa_playwright","label":"Boolean: QA + Playwright","icon":"fa-code","url_template":"https://www.linkedin.com/jobs/search/?keywords=%28%22QA%22%20OR%20%22Analista%20de%20Testes%22%29%20AND%20%22Playwright%22&f_TPR=r604800&sortBy=DD","enabled":true},
    {"id":"boolean_qa_ia","label":"Boolean: QA + IA","icon":"fa-robot","url_template":"https://www.linkedin.com/jobs/search/?keywords=%22QA%22%20AND%20%28%22IA%22%20OR%20%22Intelig%C3%AAncia%20Artificial%22%29&f_TPR=r604800&sortBy=DD","enabled":true}
  ]'::jsonb;
