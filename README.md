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

- Score 0–10 calculado por regras + palavras-chave do perfil
- `search_min_score: 3` (configurável no perfil do candidato)
- **Expansão automática**: se uma plataforma retorna poucos leads novos, ativa `expansion_keywords` mais amplos e registra o run separado no `search_log`

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
