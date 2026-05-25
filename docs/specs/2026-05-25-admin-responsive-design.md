# Admin Responsive Refinement — Design Spec

**Data:** 2026-05-25  
**Abordagem:** A — Consolidação + Polish Incremental  
**Escopo:** `admin/assets/css/admin.css`, `admin/assets/admin-shell.html`, `admin/assets/js/admin-core.js`, `tests/admin-responsive.spec.js`, `playwright.config.js`

---

## Problema

`admin.css` tem 10 blocos `@media (max-width:600px)` espalhados ao longo de 2952 linhas, mais 1 bloco tablet. Essa fragmentação faz com que correções num viewport acidentalmente quebrem outro. Não existe suite de testes que valide comportamento responsivo por viewport para o painel admin.

---

## Arquitetura CSS

### Estrutura alvo de `admin.css`

O arquivo mantém uma única estrutura de 3 seções ordenadas, com selos de comentário que marcam o limite de cada viewport:

```
/* ════════════════════════════════════
   DESKTOP BASE (≥1025px)
   Estilos padrão — sem media query.
   ════════════════════════════════════ */
... todos os estilos base ...

/* ════════════════════════════════════
   TABLET 601–1024px
   NÃO alterar aqui para corrigir mobile/desktop.
   ════════════════════════════════════ */
@media (min-width: 601px) and (max-width: 1024px) {
  ... único bloco tablet consolidado ...
}

/* ════════════════════════════════════
   MOBILE ≤600px
   NÃO alterar aqui para corrigir tablet/desktop.
   ════════════════════════════════════ */
@media (max-width: 600px) {
  ... único bloco mobile consolidado (10 blocos atuais unidos) ...
}
```

### Regra de isolamento

- Regras de desktop ficam no base (sem media query).
- Regras de tablet ficam **somente** no bloco `601–1024px`.
- Regras de mobile ficam **somente** no bloco `≤600px`.
- Os testes Playwright verificam em runtime que cada viewport tem o comportamento correto — qualquer cross-contaminação de CSS se torna um teste falhando.

---

## UX por Área e Viewport

### 1. Navegação

| Viewport | Mudança |
|---|---|
| Mobile ≤600px | Indicador ativo: `background: cyan-soft` no botão inteiro (substituindo o `::after` dot). Tap target mínimo 48×48px. Label com ellipsis. Safe-area bottom garantida. |
| Tablet 601–1024px | Top tabs com `overflow-x: auto` + scrollbar oculta. Tab ativa chamada com `scrollIntoView` no JS ao trocar de aba. |
| Desktop ≥1025px | Indicador ativo: `border-bottom: 2px solid var(--cyan)` mais visível. Gap entre abas consistente. Hover state sutil. |

### 2. Tabela de Vagas

| Viewport | Mudança |
|---|---|
| Mobile ≤600px | Card 3 linhas: (1) título, (2) empresa · localização truncada, (3) data + badge de etapa. Score visível sem abrir drawer. |
| Tablet 601–1024px | Tabela mantida (não card). Ocultar: `col-gestor`, `col-cadastrado`, `col-checkbox`. Colunas restantes com `width` percentual. Título com `max-width + text-overflow: ellipsis`. Sem overflow horizontal. |
| Desktop ≥1025px | Sticky header durante scroll. Larguras de coluna declaradas explicitamente. Row hover mais visível. |

### 3. Drawers e Modais

| Viewport | Mudança |
|---|---|
| Mobile ≤600px | Drawer vagas vira **bottom sheet**: entra de baixo, `height: 90dvh`, handle bar no topo. Modal: `max-height: 88dvh`, header fixo (título + botão fechar), body scrollável. Backdrop escuro uniforme. |
| Tablet 601–1024px | Drawer desliza da direita, `max-width: min(560px, 80vw)`. Modal: `max-width: 560px`, centralizado. |
| Desktop ≥1025px | Drawer vagas: largura 480px (era 420px). Modal header sticky. Backdrop com `backdrop-filter: blur(4px)`. |

### 4. Filtros e Busca

| Viewport | Mudança |
|---|---|
| Mobile ≤600px | `padding-inline: 12px` no container de chips. Fade-out gradiente nas bordas do scroll. Campo de busca sempre acima dos chips. Filtros de data: full-width empilhados. |
| Tablet 601–1024px | `flex-wrap: wrap; gap: 6px` uniforme nos chips. `min-width` nos chips para evitar chips pequenos. Busca e datas na mesma linha (2 colunas). |
| Desktop ≥1025px | Verificar que chips + busca + datas cabem em linha única em 1280px. Botão "Limpar filtros" alinhado à direita. |

---

## Playwright Test Suite

### Novo arquivo: `tests/admin-responsive.spec.js`

**Configuração:** `mode: 'serial'`, JWT compartilhado (1 login por projeto, igual ao `admin-full.spec.js`).

**Adicionado a `ALL_PROJECTS_MATCH`** em `playwright.config.js` para rodar nos projetos desktop (1280px), tablet (820px) e mobile (390px).

**Lógica de viewport:** usa `page.viewportSize().width` para derivar comportamento esperado — um único arquivo sem duplicação de asserts.

### Blocos de teste

**Bloco 1 — Navegação**
- mobile: bottom nav visível, `.app-tabs` ocultas
- mobile: toque no botão da bottom nav muda aba ativa
- tablet: `.app-tabs` visíveis, `.mobile-bottom-nav` oculta
- tablet: tab ativa não causa overflow horizontal
- desktop: todas as tabs visíveis sem scroll horizontal

**Bloco 2 — Tabela de Vagas**
- mobile: `thead` oculto, linhas em layout card
- mobile: card contém título + empresa + badge de etapa
- mobile: sem overflow horizontal na aba Vagas
- tablet: `thead` visível
- tablet: `col-gestor` e `col-cadastrado` ocultas
- tablet: sem overflow horizontal
- desktop: todas as colunas presentes

**Bloco 3 — Drawers**
- mobile: drawer vagas entra de baixo (bottom sheet — `transform: translateY`)
- mobile: drawer ocupa ≤90dvh, botão fechar visível
- tablet: drawer entra da direita, `offsetWidth ≤ 0.8 * viewportWidth`
- desktop: drawer entra da direita, `offsetWidth === 480`

**Bloco 4 — Filtros**
- mobile: container de chips tem `scrollWidth > clientWidth` (scroll horizontal esperado)
- mobile: página não tem overflow horizontal (só o container de chips scrollar)
- tablet: chips sem overflow de página
- desktop: linha de filtros sem wrap (todos os chips na mesma linha)

**Bloco 5 — Overflow horizontal geral**
- Para cada aba (Vagas, CVs, Tokens, Logs, Radar, Config): `document.body.scrollWidth ≤ clientWidth + 5`
- Roda nos 3 viewports

### Execução

```bash
# Apenas a suite responsiva nos 3 projetos
npx playwright test admin-responsive --project=mobile --project=tablet --project=desktop

# Local (contra vercel dev)
BASE_URL=http://localhost:3000 ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive
```

---

## Arquivos modificados

| Arquivo | Tipo de mudança |
|---|---|
| `admin/assets/css/admin.css` | Consolidar 10 blocos mobile em 1; expandir bloco tablet; adicionar selos de seção; aplicar fixes das 4 áreas |
| `admin/assets/admin-shell.html` | Drawer vagas: adicionar handle bar para bottom sheet |
| `admin/assets/js/admin-core.js` | Tab switch: chamar `scrollIntoView` na tab ativa (tablet) |
| `tests/admin-responsive.spec.js` | Novo arquivo — suite completa por viewport |
| `playwright.config.js` | Adicionar `admin-responsive.spec.js` ao `ALL_PROJECTS_MATCH` |

---

## Critérios de aceitação

1. `npx playwright test admin-responsive` passa nos 3 projetos sem falhas.
2. `npx playwright test admin-full` continua passando sem regressões.
3. Nenhum `@media (max-width:600px)` fora do bloco mobile consolidado.
4. Nenhum `@media (min-width:601px) and (max-width:1024px)` fora do bloco tablet.
5. Drawer de vagas no mobile entra de baixo (bottom sheet).
6. Tabela de vagas no tablet não tem overflow horizontal.
