# Portfólio ARTACHO.dev

Portfólio profissional de Bruno Artacho — QA Engineer e automation specialist. Reúne apresentação pública, estudos de caso, currículo interativo e um painel administrativo completo para gestão de candidaturas, tokens e métricas.

> Produção: https://bruno-artacho.vercel.app
> Última atualização: 2026-05-23 — veja [STATUS.md](STATUS.md) para o resumo de entregas.

---

## Estrutura do projeto

```text
portfolio/
├── admin/                       # Painel administrativo (SPA)
├── api/                         # Vercel Functions (Node.js)
│   ├── _lib/                    # Auth, db, helpers
│   ├── admin/                   # Endpoints autenticados
│   ├── cv/                      # Tracking de visualizações
│   ├── demo/                    # Reset do banco de demo
│   └── track.js                 # Analytics público
├── supabase/                    # Schema + 21 migrations SQL
├── imagens/                     # Assets visuais
├── tests/                       # Playwright E2E
├── scripts/                     # Utilitários de manutenção
├── index.html                   # Home pública
├── cv.html                      # Currículo interativo
├── estudo-caso-pagamentos.html  # Estudo de caso (funcional)
├── cenario-tecnico-qa.html      # Estudo de caso (técnico)
├── projeto-sistema-admin.html   # Apresentação do painel admin
├── privacidade.html             # Política de privacidade
├── style.css                    # Estilos globais do site público
├── script.js                    # JS público (menu, tabs, accordions)
├── analytics.js                 # Tracking do site público
├── dev-server.mjs               # Servidor local (substitui CDNs)
└── vercel.json                  # Configuração de deploy
```

---

## Frontend público

Site estático com foco em apresentação profissional, performance e SEO.

- Hero com indicador "Disponível para oportunidades"
- Skills grid 2x2 (QA · Automação · APIs · Stack) — Playwright, PyAutoGUI, Postman, Insomnia, Cursor + MCP
- Seção de formação e 5 certificações
- Animações on-scroll via `IntersectionObserver`
- **Self-host completo** de fontes, ícones (Font Awesome) e libs (Devicon, SortableJS) — zero CDN externo
- Metadata social (`canonical`, Open Graph, Twitter Card) para todas as páginas
- Estudos de caso com tabs, accordions, métricas e regras de negócio anonimizadas

---

## Painel administrativo (`/admin`)

SPA leve em HTML/CSS/JS vanilla autenticada com cookie httpOnly + JTI revogável.

### 6 abas
| Aba | Recursos |
|---|---|
| **CVs** | Upload/versionamento, preview de PDF em modal, download |
| **Tokens** | Geração de tokens para envio de CV via link, layout responsivo com CSS grid por breakpoint |
| **Vagas** | CRUD de candidaturas, drag-and-drop de etapas (SortableJS + undo/redo), auto-vínculo de CV e WhatsApp do recrutador, drawer full-screen com preview do CV enviado e link `wa.me` clicável |
| **Logs** | Paginação server-side, filtros, audit trail completo |
| **Segurança** | Tentativas de login, IPs bloqueados, alertas Telegram |
| **Métricas** | 5 modos de gráfico para análise de vagas, export CSV, RPCs de drill-down |

### Características
- Mobile UX completa: bottom navigation, cards, drawer full-screen, touch targets de 48px
- Lazy loading por aba + auto-refresh a cada 60s
- Estratégia de paginação: client-side para CVs/Tokens/Vagas (volume pequeno), server-side para Logs

---

## Radar de Vagas (busca automática)

MCP server local (`mcp/radar-server.js`) que orquestra scrapers de vagas e os integra ao painel admin via Supabase.

### Plataformas suportadas

| Plataforma | Mecanismo | Observações |
|---|---|---|
| **Gupy** | API REST (`employability-portal.gupy.io`) | Retorna descrição nativamente — scores mais confiáveis |
| **LinkedIn** | Playwright + cookie `li_at` | Sessão autenticada salva em `mcp/.linkedin-session.json` (TTL 25 dias) |
| **Maringá.com** | Playwright + stealth plugin | Cloudflare Turnstile bypassado via `playwright-extra` + `puppeteer-extra-plugin-stealth` |
| **Indeed** | Playwright + Chrome real | Habilitado sob demanda (`enabled: false` no perfil) |

### Arquitetura

```
MCP tools: search_all / search_linkedin / search_gupy / search_maringa / search_indeed
  └→ mcp/search/{linkedin,gupy,maringa,indeed}.js   scrapers por plataforma
  └→ mcp/search/normalizer.js                        formato canônico de lead
  └→ ingestLeads()                                   dedup + score + salvar no Supabase
  └→ tabela search_log                               histórico de execuções
```

### Scoring e tiers de expansão

- Score 0–10 com 1 casa decimal, calculado por regras + palavras-chave do perfil (`api/_lib/scoring.js`)
- `search_min_score: 3` (configurável no perfil do candidato)
- **Expansão automática**: se uma plataforma retorna poucos leads novos, ativa `expansion_keywords` mais amplos e registra o run separado no `search_log`

| Badge | Score | Significado |
|-------|-------|-------------|
| 🟢 Verde — `FORTE` | 7–10 | Match forte, candidatar |
| 🩵 Ciano — `OK` | 5–6 | Compatível, vale analisar |
| 🟡 Amarelo — `REVISAR` | 3–4 | Relevância baixa, decidir |
| 🔴 Vermelho — `FRACO` | 0–2 | Irrelevante (filtrado por padrão) |

### Motor de pontuação — `scoreVaga` (0–10 pts)

Função pura sem I/O. Roda no MCP server (recálculo em lote) e pode ser espelhada no front para feedback instantâneo. Score final: `Math.round(soma × 10) / 10` → 1 casa decimal.

#### Matriz de parâmetros

| Dimensão | Peso máx | Lógica |
|---|---|---|
| **Skills** | 4 pts | Match de `skills_core` + bônus de `skills_evolucao` |
| **Nível** | 2 pts | Inferência de senioridade no texto vs. `nivel_alvo` do perfil |
| **Setor** | 2 pts | Match de `setores` na descrição (1 pt por setor, teto 2) |
| **Modalidade** | 1 pt | Preferência de modalidade do perfil vs. campo `modalidade` da vaga |
| **Contratação** | 1 pt | `contratacao_prefs[]` do perfil vs. `tipo_contratacao` da vaga |
| **CNH** | −0,5 pt | Penalidade se vaga exige CNH e candidato não tem |

#### Skills (até 4 pts)

```
coreRatio  = hits_core / total_skills_core    → contribui até 3 pts
evolBonus  = min(0,25 × hits_evolucao, 1,0)  → bônus por diferenciais (nunca penaliza)
skillsPts  = min(4, coreRatio × 3 + evolBonus)
```

- **`skills_core`** (base de match): Testes manuais, Testes funcionais, Testes de regressão, Testes exploratórios, Testes de integração, Elaboração de casos de teste, Análise de requisitos, Validação de regras de negócio, SQL, PostgreSQL, Testes de API, Postman, Thunder Client, Git, GitHub, Metodologias ágeis, Scrum, Homologação, Documentação de bugs
- **`skills_evolucao`** (diferenciais, contam como bônus): Playwright, Playwright MCP, Automação de testes web, IA aplicada a QA, Agentes de IA, MCPs, CI/CD, Java, Spring Boot, APIs REST, Cenários E2E
- **`gaps`** (detectados, não penalizam o score — exibidos como alerta): Automação mobile, Appium, Cypress, Selenium, Robot Framework, k6, JMeter, Docker, Observabilidade, Kibana, Testes de carga

#### Nível (até 2 pts)

Inferência a partir do título + descrição da vaga. `nivel_alvo` atual: **Pleno**.

| Inferência na vaga | Pontuação |
|---|---|
| Exato (`pleno = pleno`) | 2,0 pts |
| Nível vago / não informado | 1,4 pts |
| Junior (aceitável, subvaloriza) | 1,5 pts |
| Sênior fechado (superqualifica) | 0,5 pts |
| Estágio / Trainee | 0,3 pts |

Palavras reconhecidas: `senior/sr/especialista/staff/lead` → sênior · `junior/jr` → junior · `pleno/pl/mid` → pleno · `estagi/trainee` → intern.

#### Setor (até 2 pts)

Setores valorizados no perfil (1 pt por citação, teto 2): **HealthTech, LIS, ERP, WMS, PDV, SaaS**.

#### Modalidade (até 1 pt)

| Modalidade da vaga | Pts |
|---|---|
| Remota | 1,0 |
| Híbrida | 0,7 |
| Não informada | 0,7 |
| Presencial (fora da preferência) | 0,3 |

Preferência atual do perfil: **Remota**.

#### Contratação (até 1 pt)

| Regime da vaga | Pts |
|---|---|
| Match com `contratacao_prefs` (CLT) | 1,0 |
| Regime diferente | 0,5 |
| Não informado | 0,6 |

#### CNH (penalidade)

| Situação | Pts |
|---|---|
| Vaga exige CNH, candidato não tem | −0,5 |
| Candidato tem CNH mas categoria errada | −0,3 |
| Compatível ou não exige | 0 |

Perfil atual: `cnh.has = false`.

#### Scores auxiliares (não compõem o `fit_score` principal)

| Score | Função | Dimensões avaliadas |
|---|---|---|
| **Fit reverso** | `computeReverseFit` | Modalidade, salário (overlap de faixas), contratação, nível |
| **Alinhamento de valores** | `computeAlignmentScore` | WLB, propósito, crescimento, segurança, autonomia, salário |

### Sessão LinkedIn

```bash
node scripts/linkedin-login.mjs   # abre Chrome visível para login manual
```

Cookie salvo em `mcp/.linkedin-session.json` (gitignored). TTL ~25 dias. Quando a sessão expira, o scraper do LinkedIn para de retornar resultados — basta rodar o comando acima novamente para renovar.

### Bypass Cloudflare (Maringá)

Ver [`docs/bypass-cloudflare-turnstile.md`](docs/bypass-cloudflare-turnstile.md) para detalhes do stealth plugin.

---

## Segurança

Implementação em duas fases de hardening (ver [SECURITY.md](SECURITY.md)):

- Autenticação por cookie **httpOnly** + JWT com **JTI revogável** + tabela de sessions
- Rate limiting por IP em endpoints sensíveis
- Content Security Policy aplicada via headers
- Bcrypt para credenciais
- Alertas Telegram em eventos críticos (tentativas de login, mudanças sensíveis)
- Tabela `admin_login_attempts` para análise forense
- Analytics segregada (admin não polui métricas públicas)

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | HTML5, CSS3, JavaScript vanilla |
| Backend | Node.js, Vercel Functions |
| Banco de dados | Supabase (PostgreSQL + Storage) |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) |
| Testes | Playwright |
| Deploy | Vercel + GitHub Pages |
| Dev local | `dev-server.mjs` (substitui CDNs) |

---

## Banco de dados

32+ migrations versionadas em `supabase/` cobrindo:

- Credenciais e tokens (002, 004)
- Snapshot de CVs (003, 019)
- Candidaturas e ciclo de vida (005, 006, 018)
- Vagas, modalidade, arquivamento (008, 009, 012)
- Estatísticas e distribuição (010, 011, 013, 020-metrics)
- Eventos do site e retenção (007, 015, 016, 017)
- Tentativas de login (014)
- Banco de demo descartável (020-demo, 021-demo-seed)

---

## Como rodar localmente

```bash
# Instalar dependências
npm install

# Servidor local (frontend público + admin) — substitui CDNs por self-host
node dev-server.mjs

# Rodar testes E2E
npm test
```

Variáveis de ambiente em `.env.example`. As Vercel Functions só rodam em deploy (não no dev-server local).

---

## Demo / Showcase

Banco descartável para demonstração pública do painel admin com **reset automático** via `api/demo/`. Os dados são populados a partir das migrations 020/021 (seed "Jon Snow") e podem ser zerados a qualquer momento sem afetar produção.

---

## URLs

- Produção: https://bruno-artacho.vercel.app
- Showcase admin: rota interna do painel, ver `projeto-sistema-admin.html`
- Projeto complementar (Padaria do Bairro): https://padaria-do-bairro-premium.vercel.app

---

## Observações

- O frontend público é estático e pode ser servido por qualquer CDN.
- O painel admin e a API exigem Vercel + Supabase configurados.
- Para a prévia social, `imagens/capa-portfolio-ok.jpg` precisa estar publicada no caminho final.
- Histórico de mudanças anteriores ao painel admin está preservado em commits de `main`.
