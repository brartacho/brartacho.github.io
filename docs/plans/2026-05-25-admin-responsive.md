# Admin Responsive Refinement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidar os 10 blocos `@media mobile` do admin.css em 3 seções isoladas, corrigir UX nas 4 áreas problemáticas (nav, vagas, drawers, filtros) por viewport, e adicionar suite Playwright de comportamento completo por viewport.

**Architecture:** CSS desktop-first mantido; único bloco mobile consolidado ao final do arquivo + único bloco tablet expandido. Testes TDD: cada área ganha testes falhando antes da implementação CSS/JS. Suite `admin-responsive.spec.js` usa `page.viewportSize()` para skip por viewport em arquivo único.

**Tech Stack:** CSS (media queries), Playwright (`@playwright/test`), JavaScript (admin-core.js `switchTab`)

**Spec:** `docs/specs/2026-05-25-admin-responsive-design.md`

---

## Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `playwright.config.js` | Adiciona `admin-responsive.spec.js` ao `ALL_PROJECTS_MATCH` |
| `tests/admin-responsive.spec.js` | **NOVO** — suite completa de testes responsivos |
| `admin/assets/css/admin.css` | Fixes de UX nas 4 áreas + consolidação dos 10 blocos mobile em 1 |
| `admin/assets/admin-shell.html` | Adiciona `<div class="drawer-handle">` no `#vagasDrawer` |
| `admin/assets/js/admin-core.js` | `switchTab`: `scrollIntoView` na tab ativa (tablet) |

---

## Task 1: Config + skeleton do spec

**Files:**
- Modify: `playwright.config.js:8`
- Create: `tests/admin-responsive.spec.js`

- [ ] **Step 1: Atualizar `ALL_PROJECTS_MATCH` no playwright.config.js**

Em `playwright.config.js`, linha 8, mudar de:
```js
const ALL_PROJECTS_MATCH = ['**/responsive.spec.js', '**/admin-full.spec.js'];
```
Para:
```js
const ALL_PROJECTS_MATCH = ['**/responsive.spec.js', '**/admin-full.spec.js', '**/admin-responsive.spec.js'];
```

- [ ] **Step 2: Criar `tests/admin-responsive.spec.js` com auth e helpers**

```js
import { test, expect } from '@playwright/test';

// Serial: 1 login por projeto (respeita rate limit de 5 tentativas/15min)
test.describe.configure({ mode: 'serial' });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;
const HAS_CREDS   = Boolean(ADMIN_EMAIL && ADMIN_PASS);

let _sharedJwt = null;

test.beforeAll(async ({ browser }) => {
  if (!HAS_CREDS || _sharedJwt) return;
  const ctx = await browser.newContext();
  const pg  = await ctx.newPage();
  try {
    await pg.goto('/admin', { waitUntil: 'networkidle' });
    await pg.locator('#loginUsername').fill(ADMIN_EMAIL);
    await pg.locator('#loginPassword').fill(ADMIN_PASS);
    await pg.locator('#loginBtn').click();
    await pg.waitForSelector('.app-logout', { state: 'visible', timeout: 15000 });
    _sharedJwt = await pg.evaluate(() => sessionStorage.getItem('admin_jwt'));
  } catch (e) {
    console.warn('\n⚠️  JWT capture failed — testes autenticados serão pulados:', e.message);
  } finally {
    await ctx.close();
  }
});

async function injectAndGoto(page) {
  if (_sharedJwt) {
    await page.addInitScript((t) => sessionStorage.setItem('admin_jwt', t), _sharedJwt);
  }
  await page.goto('/admin', { waitUntil: 'networkidle' });
  if (_sharedJwt) {
    await page.waitForSelector('.app-logout', { state: 'visible', timeout: 12000 });
  }
}

// Retorna a largura atual do viewport
function vp(page) { return page.viewportSize()?.width ?? 1280; }
```

- [ ] **Step 3: Verificar que o arquivo é reconhecido pelo config**

```bash
npx playwright test admin-responsive --list
```
Esperado: lista os testes dos projetos desktop, tablet e mobile (0 testes de conteúdo ainda — apenas a estrutura).

- [ ] **Step 4: Commit**

```bash
git add playwright.config.js tests/admin-responsive.spec.js
git commit -m "test: estrutura base da suite admin-responsive"
```

---

## Task 2: Testes de Navegação (falhando)

**Files:**
- Modify: `tests/admin-responsive.spec.js`

- [ ] **Step 1: Adicionar bloco de testes de navegação ao spec**

Após o helper `vp()`, adicionar:
```js
// ─── NAVEGAÇÃO ────────────────────────────────────────────────────────────────
test.describe('Navegação', () => {

  test('mobile: bottom nav visível, app-tabs ocultas', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await injectAndGoto(page);
    await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
    await expect(page.locator('.app-tabs')).toBeHidden();
  });

  test('mobile: bottom nav muda aba ativa', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await injectAndGoto(page);
    // CVs é o segundo botão primário da bottom nav
    const btn = page.locator('.mobile-nav-btn[data-tab="vagas"]');
    await btn.click();
    await expect(page.locator('#tab-vagas')).toBeVisible({ timeout: 5000 });
  });

  test('mobile: botão ativo tem background (não só cor de texto)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await injectAndGoto(page);
    const btn = page.locator('.mobile-nav-btn.active').first();
    const bg = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
    // cyan-soft = rgba(34, 211, 238, 0.08) — qualquer valor não transparente
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });

  test('tablet: app-tabs visíveis, bottom nav oculta', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await injectAndGoto(page);
    await expect(page.locator('.app-tabs')).toBeVisible();
    await expect(page.locator('.mobile-bottom-nav')).toBeHidden();
  });

  test('tablet: tabs sem causar overflow horizontal na página', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await injectAndGoto(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('desktop: app-tabs visíveis sem overflow horizontal', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    await injectAndGoto(page);
    await expect(page.locator('.app-tabs')).toBeVisible();
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });
});
```

- [ ] **Step 2: Rodar para confirmar falhas esperadas**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Navegação" --project=mobile --project=tablet --project=desktop
```
Esperado: teste "mobile: botão ativo tem background" e possivelmente "tablet: tabs sem overflow" **falhando**. Os outros podem já passar.

---

## Task 3: Fix CSS + JS — Navegação

**Files:**
- Modify: `admin/assets/css/admin.css:368`, `admin/assets/css/admin.css:2025-2076`, `admin/assets/js/admin-core.js:3879`

- [ ] **Step 1: Adicionar background no botão ativo da bottom nav (base CSS, linha ~368)**

Localizar:
```css
        .mobile-nav-btn.active { color: var(--cyan); }
```
Substituir por:
```css
        .mobile-nav-btn.active { color: var(--cyan); background: var(--cyan-soft); border-radius: 10px; }
```

- [ ] **Step 2: Adicionar hover no tab-btn desktop (base CSS, após linha 295)**

Localizar:
```css
        .tab-btn.active { color: var(--cyan); border-bottom-color: var(--cyan); }
```
Adicionar imediatamente após:
```css
        .tab-btn:hover:not(.active) { color: var(--text-soft); background: rgba(255,255,255,0.03); }
```

- [ ] **Step 3: Tornar app-tabs scrollável no bloco tablet (linha ~2028)**

Localizar no bloco `@media (min-width: 601px) and (max-width: 1024px)`:
```css
            .app-tabs { display: flex !important; }
```
Substituir por:
```css
            .app-tabs {
                display: flex !important;
                overflow-x: auto;
                flex-wrap: nowrap;
                scrollbar-width: none;
                -webkit-overflow-scrolling: touch;
            }
            .app-tabs::-webkit-scrollbar { display: none; }
```

- [ ] **Step 4: scrollIntoView na tab ativa ao trocar de aba (admin-core.js, após linha 3881)**

Localizar em `switchTab`:
```js
    document.querySelectorAll(`[data-tab="${name}"]`).forEach(b => b.classList.add('active'));
```
Adicionar imediatamente após:
```js
    // Tablet: rola a tab ativa para o campo de visão nas top tabs
    const _activeTabEl = document.querySelector(`.app-tabs [data-tab="${name}"]`);
    if (_activeTabEl) _activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
```

- [ ] **Step 5: Rodar testes de navegação**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Navegação" --project=mobile --project=tablet --project=desktop
```
Esperado: todos os testes de Navegação **passando**.

- [ ] **Step 6: Commit**

```bash
git add admin/assets/css/admin.css admin/assets/js/admin-core.js
git commit -m "fix: navegação responsiva — active state mobile, scroll tabs tablet, hover desktop"
```

---

## Task 4: Testes de Tabela de Vagas (falhando)

**Files:**
- Modify: `tests/admin-responsive.spec.js`

- [ ] **Step 1: Adicionar bloco de testes de vagas ao spec**

Após o bloco `describe('Navegação')`, adicionar:
```js
// ─── TABELA DE VAGAS ──────────────────────────────────────────────────────────
test.describe('Tabela de Vagas', () => {

  async function gotoVagas(page) {
    await injectAndGoto(page);
    if (vp(page) <= 600) {
      await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    } else {
      await page.locator('.app-tabs [data-tab="vagas"]').click();
    }
    await page.waitForTimeout(600);
  }

  test('mobile: thead oculto, linhas como cards', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagas(page);
    await expect(page.locator('.vagas-table thead')).toBeHidden();
    await expect(page.locator('.vagas-table tbody')).toBeVisible();
  });

  test('mobile: card exibe empresa (vaga-meta-mobile visível)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagas(page);
    const count = await page.locator('.vagas-table tbody tr').count();
    if (count === 0) test.skip(true, 'sem vagas para testar layout de card');
    await expect(page.locator('.vaga-meta-mobile').first()).toBeVisible();
  });

  test('mobile: sem overflow horizontal na aba Vagas', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagas(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('tablet: thead visível', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagas(page);
    await expect(page.locator('.vagas-table thead')).toBeVisible();
  });

  test('tablet: col-gestor e col-cadastrado ocultas', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagas(page);
    // thead th
    const thGestor = page.locator('.vagas-table thead .col-gestor');
    const thCad    = page.locator('.vagas-table thead .col-cadastrado');
    if (await thGestor.count() > 0) await expect(thGestor.first()).toBeHidden();
    if (await thCad.count()    > 0) await expect(thCad.first()).toBeHidden();
  });

  test('tablet: sem overflow horizontal', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagas(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('desktop: thead visível com col-gestor e col-cadastrado', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    await gotoVagas(page);
    await expect(page.locator('.vagas-table thead')).toBeVisible();
    const thGestor = page.locator('.vagas-table thead .col-gestor');
    const thCad    = page.locator('.vagas-table thead .col-cadastrado');
    if (await thGestor.count() > 0) await expect(thGestor.first()).toBeVisible();
    if (await thCad.count()    > 0) await expect(thCad.first()).toBeVisible();
  });
});
```

- [ ] **Step 2: Rodar para confirmar falhas**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Tabela de Vagas" --project=mobile --project=tablet --project=desktop
```
Esperado: testes de tablet sobre colunas ocultas e overflow **falhando**.

---

## Task 5: Fix CSS — Tabela de Vagas

**Files:**
- Modify: `admin/assets/css/admin.css` (bloco tablet ~2067-2075, bloco mobile ~1522-1552)

- [ ] **Step 1: Tablet — ocultar colunas secundárias e evitar overflow**

No bloco `@media (min-width: 601px) and (max-width: 1024px)`, localizar:
```css
            .col-gestor, .col-date, .col-cadastrado { display: table-cell; }
```
Substituir por:
```css
            /* Vagas tablet: oculta colunas de baixa prioridade */
            .col-gestor    { display: none; }
            .col-cadastrado { display: none; }
            .col-date      { display: table-cell; }
            /* Evita overflow: larguras proporcionais fixas */
            .vagas-table   { table-layout: fixed; width: 100%; }
            .col-vaga-title { width: 44%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .col-empresa    { width: 26%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .col-date       { width: 14%; }
            .col-score      { width: 16%; }
```

> **Nota:** Se a tabela não tiver `col-vaga-title` / `col-empresa` / `col-score`, verificar no HTML gerado em `admin-core.js` ao redor da linha 740 e ajustar os nomes de classe.

- [ ] **Step 2: Desktop — sticky header**

No CSS base (fora de qualquer media query), localizar o bloco que define `.vagas-table` (buscar por `vagas-table {` ou `vagas-table th`). Adicionar sticky header logo após:
```css
        .vagas-table thead th {
            position: sticky;
            top: 0;
            z-index: 1;
            background: var(--bg-elevated);
        }
```

- [ ] **Step 3: Rodar testes de vagas**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Tabela de Vagas" --project=mobile --project=tablet --project=desktop
```
Esperado: todos os testes de Vagas **passando**.

- [ ] **Step 4: Commit**

```bash
git add admin/assets/css/admin.css
git commit -m "fix: tabela de vagas — colunas ocultas no tablet, sticky header no desktop"
```

---

## Task 6: Testes de Drawers (falhando)

**Files:**
- Modify: `tests/admin-responsive.spec.js`

- [ ] **Step 1: Adicionar bloco de testes de drawers**

Após `describe('Tabela de Vagas')`:
```js
// ─── DRAWERS ──────────────────────────────────────────────────────────────────
test.describe('Drawers', () => {

  async function openVagasDrawer(page) {
    await injectAndGoto(page);
    if (vp(page) <= 600) {
      await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    } else {
      await page.locator('.app-tabs [data-tab="vagas"]').click();
    }
    await page.waitForTimeout(600);
    const firstRow = page.locator('.vagas-table tbody tr').first();
    const count = await firstRow.count();
    if (count === 0) return false;
    await firstRow.click();
    await page.waitForSelector('#vagasDrawer.open', { timeout: 5000 });
    return true;
  }

  test('mobile: drawer abre como bottom sheet (translateY)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas para abrir drawer');
    const transform = await page.locator('#vagasDrawer').evaluate(
      el => getComputedStyle(el).transform
    );
    // Bottom sheet usa translateY(0) quando aberto — matrix(1,0,0,1,0,0)
    // Verifica que NÃO é translateX (matrix com 4ª coluna ≠ 0 seria lateral)
    expect(transform).toMatch(/matrix\(1, 0, 0, 1, 0,/);
  });

  test('mobile: drawer ocupa ≤90dvh e botão fechar visível', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas');
    const drawerH  = await page.locator('#vagasDrawer').evaluate(el => el.offsetHeight);
    const windowH  = await page.evaluate(() => window.innerHeight);
    expect(drawerH).toBeLessThanOrEqual(windowH * 0.92);
    await expect(page.locator('#vagasDrawer .drawer-close')).toBeVisible();
  });

  test('tablet: drawer abre da direita, largura ≤80vw', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas');
    const drawerW  = await page.locator('#vagasDrawer').evaluate(el => el.offsetWidth);
    const windowW  = await page.evaluate(() => window.innerWidth);
    expect(drawerW).toBeLessThanOrEqual(windowW * 0.82);
  });

  test('desktop: drawer abre da direita, largura ≥460px', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    const opened = await openVagasDrawer(page);
    if (!opened) test.skip(true, 'sem vagas');
    const drawerW = await page.locator('#vagasDrawer').evaluate(el => el.offsetWidth);
    expect(drawerW).toBeGreaterThanOrEqual(460);
  });
});
```

- [ ] **Step 2: Rodar para confirmar falhas**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Drawers" --project=mobile --project=tablet --project=desktop
```
Esperado: "mobile: drawer abre como bottom sheet" e "tablet: drawer largura ≤80vw" **falhando**.

---

## Task 7: Fix CSS + HTML — Drawers

**Files:**
- Modify: `admin/assets/admin-shell.html:1631`, `admin/assets/css/admin.css`

- [ ] **Step 1: Adicionar handle bar no HTML do drawer**

Em `admin/assets/admin-shell.html`, localizar:
```html
        <div class="vagas-drawer" id="vagasDrawer">
            <div class="drawer-header">
```
Inserir `<div class="drawer-handle"></div>` entre as duas divs:
```html
        <div class="vagas-drawer" id="vagasDrawer">
            <div class="drawer-handle"></div>
            <div class="drawer-header">
```

- [ ] **Step 2: Adicionar CSS base do handle (oculto por padrão)**

No CSS base (antes dos blocos de media query), após a definição de `.drawer-close`:
```css
        .drawer-handle {
            display: none;
            width: 40px;
            height: 4px;
            background: var(--border-soft);
            border-radius: 2px;
            margin: 12px auto 4px;
            flex-shrink: 0;
        }
```

- [ ] **Step 3: Aumentar largura do drawer no desktop (base CSS, linha ~2157)**

Localizar:
```css
        .vagas-drawer {
            position:fixed; top:0; right:0; bottom:0; width:420px; max-width:95vw;
```
Substituir `width:420px` por `width:480px`:
```css
        .vagas-drawer {
            position:fixed; top:0; right:0; bottom:0; width:480px; max-width:95vw;
```

- [ ] **Step 4: Mobile — drawer vira bottom sheet**

No bloco `@media (max-width: 600px)`, localizar:
```css
            .vagas-drawer { width: 100vw; max-width: 100vw; }
```
Substituir por:
```css
            /* ── Drawer → bottom sheet no mobile ── */
            .vagas-drawer {
                top: auto !important;
                bottom: 0 !important;
                left: 0 !important;
                right: 0 !important;
                width: 100vw !important;
                max-width: 100vw !important;
                height: 90dvh !important;
                border-left: none !important;
                border-top: 1px solid var(--border) !important;
                border-radius: 16px 16px 0 0 !important;
                transform: translateY(100%) !important;
                transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1) !important;
            }
            .vagas-drawer.open { transform: translateY(0) !important; }
            .drawer-handle { display: block; }
```

- [ ] **Step 5: Tablet — limitar largura do drawer**

No bloco `@media (min-width: 601px) and (max-width: 1024px)`, adicionar:
```css
            .vagas-drawer { max-width: min(560px, 80vw) !important; }
```

- [ ] **Step 6: Rodar testes de drawers**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Drawers" --project=mobile --project=tablet --project=desktop
```
Esperado: todos os testes de Drawers **passando**.

- [ ] **Step 7: Commit**

```bash
git add admin/assets/admin-shell.html admin/assets/css/admin.css
git commit -m "fix: drawer vagas — bottom sheet mobile, max-width tablet, 480px desktop"
```

---

## Task 8: Testes de Filtros (falhando)

**Files:**
- Modify: `tests/admin-responsive.spec.js`

- [ ] **Step 1: Adicionar bloco de testes de filtros**

Após `describe('Drawers')`:
```js
// ─── FILTROS ──────────────────────────────────────────────────────────────────
test.describe('Filtros', () => {

  async function gotoVagasAberto(page) {
    await injectAndGoto(page);
    if (vp(page) <= 600) {
      await page.locator('.mobile-nav-btn[data-tab="vagas"]').click();
    } else {
      await page.locator('.app-tabs [data-tab="vagas"]').click();
    }
    await page.waitForTimeout(600);
    // Abre painel de filtros se estiver colapsado
    const panel = page.locator('#vagasFiltersPanel');
    const collapsed = await panel.evaluate(el => el.classList.contains('collapsed'));
    if (collapsed) await page.locator('#vagasFiltersToggleBtn').click();
    await page.waitForTimeout(300);
  }

  test('mobile: container de chips tem scroll horizontal interno', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagasAberto(page);
    const sw = await page.locator('#vagasFilters').evaluate(el => el.scrollWidth);
    const cw = await page.locator('#vagasFilters').evaluate(el => el.clientWidth);
    // Pode ter scroll interno (chips horizontais) — isso é esperado
    // O que não deve acontecer: overflow na página
    const bodySw = await page.evaluate(() => document.body.scrollWidth);
    const bodyCw = await page.evaluate(() => document.body.clientWidth);
    expect(bodySw).toBeLessThanOrEqual(bodyCw + 5);
  });

  test('mobile: chips não cortados nas bordas (padding-inline)', async ({ page }) => {
    test.skip(vp(page) > 600, 'apenas mobile');
    await gotoVagasAberto(page);
    const paddingLeft = await page.locator('#vagasFilters').evaluate(
      el => parseFloat(getComputedStyle(el).paddingLeft)
    );
    expect(paddingLeft).toBeGreaterThanOrEqual(10);
  });

  test('tablet: filtros sem overflow de página', async ({ page }) => {
    test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
    await gotoVagasAberto(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });

  test('desktop: linha de filtros sem overflow de página', async ({ page }) => {
    test.skip(vp(page) <= 1024, 'apenas desktop');
    await gotoVagasAberto(page);
    const sw = await page.evaluate(() => document.body.scrollWidth);
    const cw = await page.evaluate(() => document.body.clientWidth);
    expect(sw).toBeLessThanOrEqual(cw + 5);
  });
});
```

- [ ] **Step 2: Rodar para confirmar falhas**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Filtros" --project=mobile --project=tablet --project=desktop
```
Esperado: "mobile: chips não cortados" **falhando** se `padding-inline` não existir ainda.

---

## Task 9: Fix CSS — Filtros

**Files:**
- Modify: `admin/assets/css/admin.css` (bloco mobile, bloco tablet)

- [ ] **Step 1: Mobile — padding-inline nos chips**

No bloco `@media (max-width: 600px)`, localizar:
```css
            .vagas-filters { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; -webkit-overflow-scrolling: touch; }
```
Substituir por:
```css
            .vagas-filters {
                flex-wrap: nowrap;
                overflow-x: auto;
                padding-bottom: 4px;
                padding-left: 12px;
                padding-right: 12px;
                -webkit-overflow-scrolling: touch;
                scroll-padding-inline: 12px;
            }
```

- [ ] **Step 2: Tablet — flex-wrap uniforme**

No bloco `@media (min-width: 601px) and (max-width: 1024px)`, adicionar:
```css
            .vagas-filters { flex-wrap: wrap; gap: 6px; }
            .vagas-filter-chip { min-width: 64px; }
```

- [ ] **Step 3: Rodar testes de filtros**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Filtros" --project=mobile --project=tablet --project=desktop
```
Esperado: todos os testes de Filtros **passando**.

- [ ] **Step 4: Commit**

```bash
git add admin/assets/css/admin.css
git commit -m "fix: filtros de vagas — padding-inline mobile, flex-wrap tablet"
```

---

## Task 10: Testes de Overflow Geral

**Files:**
- Modify: `tests/admin-responsive.spec.js`

- [ ] **Step 1: Adicionar bloco de overflow por aba**

Após `describe('Filtros')`:
```js
// ─── OVERFLOW HORIZONTAL GERAL ────────────────────────────────────────────────
test.describe('Overflow horizontal — todas as abas', () => {

  // Abas acessíveis sem login + sem conteúdo problemático
  const TABS_DESKTOP = ['vagas', 'radar', 'metricas'];
  const TABS_MOBILE  = ['vagas', 'radar', 'metricas'];

  for (const tabKey of TABS_DESKTOP) {
    test(`desktop: aba "${tabKey}" sem overflow horizontal`, async ({ page }) => {
      test.skip(vp(page) <= 1024, 'apenas desktop');
      await injectAndGoto(page);
      await page.locator(`.app-tabs [data-tab="${tabKey}"]`).click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => document.body.scrollWidth);
      const cw = await page.evaluate(() => document.body.clientWidth);
      expect(sw, `overflow na aba ${tabKey}`).toBeLessThanOrEqual(cw + 5);
    });
  }

  for (const tabKey of TABS_MOBILE) {
    test(`mobile: aba "${tabKey}" sem overflow horizontal`, async ({ page }) => {
      test.skip(vp(page) > 600, 'apenas mobile');
      await injectAndGoto(page);
      const btn = page.locator(`.mobile-nav-btn[data-tab="${tabKey}"]`);
      if (await btn.count() === 0) return; // aba está no "Mais" menu — skip
      await btn.click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => document.body.scrollWidth);
      const cw = await page.evaluate(() => document.body.clientWidth);
      expect(sw, `overflow na aba ${tabKey}`).toBeLessThanOrEqual(cw + 5);
    });
  }

  for (const tabKey of TABS_DESKTOP) {
    test(`tablet: aba "${tabKey}" sem overflow horizontal`, async ({ page }) => {
      test.skip(vp(page) <= 600 || vp(page) > 1024, 'apenas tablet');
      await injectAndGoto(page);
      await page.locator(`.app-tabs [data-tab="${tabKey}"]`).click();
      await page.waitForTimeout(500);
      const sw = await page.evaluate(() => document.body.scrollWidth);
      const cw = await page.evaluate(() => document.body.clientWidth);
      expect(sw, `overflow na aba ${tabKey}`).toBeLessThanOrEqual(cw + 5);
    });
  }
});
```

- [ ] **Step 2: Rodar testes de overflow**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --grep "Overflow" --project=mobile --project=tablet --project=desktop
```
Esperado: maioria passando após os fixes anteriores. Falhas remanescentes indicam overflow em abas específicas — investigar e corrigir no CSS da aba afetada.

- [ ] **Step 3: Commit**

```bash
git add tests/admin-responsive.spec.js
git commit -m "test: suite completa admin-responsive (navegação, vagas, drawers, filtros, overflow)"
```

---

## Task 11: Consolidação CSS — 10 blocos mobile → 1

**Files:**
- Modify: `admin/assets/css/admin.css`

Esta task é um refactor puro: nenhum comportamento muda. Os testes das tasks anteriores garantem que nada regride.

- [ ] **Step 1: Identificar todos os blocos `@media (max-width: 600px)`**

```bash
grep -n "@media (max-width" admin/assets/css/admin.css
```
Esperado: linhas 1454, 2482, 2529, 2578, 2655, 2702, 2803, 2838, 2886, 2893 (pode variar levemente após edições anteriores).

- [ ] **Step 2: Mover conteúdo dos blocos 2–10 para dentro do bloco 1**

Para cada bloco secundário `@media (max-width: 600px)` (todos exceto o primeiro em ~1454):
1. Copiar todas as regras internas do bloco
2. Colar dentro do bloco principal (linha ~1454) antes do `}` de fechamento
3. Deletar o bloco secundário vazio

Manter a ordem interna do bloco principal por seção de funcionalidade (adicionar comentários de seção se útil).

- [ ] **Step 3: Adicionar selos de seção no CSS**

Antes do bloco tablet (linha ~2025), adicionar:
```css
        /* ════════════════════════════════════════════════════════════
           TABLET  601–1024px
           Altere SOMENTE aqui para ajustes de tablet.
           NÃO adicione regras de mobile/desktop neste bloco.
           ════════════════════════════════════════════════════════════ */
```

Antes do bloco mobile único, adicionar:
```css
        /* ════════════════════════════════════════════════════════════
           MOBILE  ≤600px
           Altere SOMENTE aqui para ajustes de mobile.
           NÃO adicione regras de tablet/desktop neste bloco.
           ════════════════════════════════════════════════════════════ */
```

- [ ] **Step 4: Rodar a suite completa para confirmar zero regressões**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --project=mobile --project=tablet --project=desktop
```
Esperado: todos os testes **passando** — mesma contagem que antes da consolidação.

- [ ] **Step 5: Commit**

```bash
git add admin/assets/css/admin.css
git commit -m "refactor: consolida 10 blocos @media mobile em bloco único + selos de seção"
```

---

## Task 12: Verificação Final

**Files:** nenhum

- [ ] **Step 1: Rodar admin-full para garantir zero regressões**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-full --project=mobile --project=tablet --project=desktop
```
Esperado: todos os testes do `admin-full.spec.js` **passando**.

- [ ] **Step 2: Rodar suite responsiva completa**

```bash
ADMIN_EMAIL=x ADMIN_PASSWORD=y npx playwright test admin-responsive --project=mobile --project=tablet --project=desktop
```
Esperado: todos **passando**.

- [ ] **Step 3: Verificar contagem de blocos mobile no CSS**

```bash
grep -c "@media (max-width: 600px)\|@media (max-width:600px)" admin/assets/css/admin.css
```
Esperado: `1` (um único bloco mobile consolidado).

- [ ] **Step 4: Commit final**

```bash
git add -A
git commit -m "feat: refinamento responsivo painel admin — mobile, tablet, desktop isolados com testes Playwright"
```
