-- ============================================================
-- Migration 027 — Seed do perfil do candidato (Bruno Artacho)
-- Executar no SQL Editor do Supabase
-- ============================================================
--
-- Popula candidate_profile apenas se a tabela estiver vazia (idempotente).
-- Dados derivados do currículo (Bruno_Artacho_Curriculo_QA_2026) e do
-- método de busca em vagas_linkedin.
-- ============================================================

INSERT INTO candidate_profile (
  nivel_alvo, skills_core, skills_evolucao, gaps, setores,
  modalidade_pref, contratacao_pref, localizacao, keywords, diferenciais
)
SELECT
  'Pleno',
  '["Testes manuais","Testes funcionais","Testes de regressão","Testes exploratórios","Testes de integração","Elaboração de casos de teste","Análise de requisitos","Validação de regras de negócio","SQL","PostgreSQL","Testes de API","Postman","Thunder Client","Git","GitHub","Metodologias ágeis","Scrum","Homologação","Documentação de bugs"]'::jsonb,
  '["Playwright","Playwright MCP","Automação de testes web","IA aplicada a QA","Agentes de IA","MCPs","CI/CD","Java","Spring Boot","APIs REST","Cenários E2E"]'::jsonb,
  '["Automação mobile","Appium","Cypress","Selenium","Robot Framework","k6","JMeter","Docker","Observabilidade","Kibana","Testes de carga"]'::jsonb,
  '["HealthTech","LIS","ERP","WMS","PDV","SaaS"]'::jsonb,
  'Remota',
  'CLT',
  'Maringá - PR',
  '["QA","Quality Assurance","Analista de Testes","Analista de Qualidade","QA Engineer","Playwright","Postman","SQL","Automação de testes","IA aplicada a QA"]'::jsonb,
  '["Playwright + IA Generativa/MCPs aplicada a QA (combinação rara)","Experiência em sistemas críticos HealthTech/LIS","Vivência com ERP/WMS/PDV","Background em Biomedicina + visão de qualidade"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM candidate_profile);
