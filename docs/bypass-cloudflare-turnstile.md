# Bypass de Cloudflare Turnstile com Playwright

Guia prático para fazer scraping de páginas protegidas pelo desafio
**"Confirme que é humano"** do Cloudflare (Turnstile / Managed Challenge),
usando Playwright em **Node.js**.

Caso real: `empregos.maringa.com` listava cards na home sem desafio mas
disparava Turnstile em toda página individual de vaga. A solução abaixo passa
sem nenhuma interação humana, em modo **headless**.

---

## Por que `playwright` puro não passa

Cloudflare Turnstile detecta automação **antes** de aceitar o clique no
checkbox. Mesmo que você consiga clicar via coordenadas (`page.mouse.click`),
o widget já decidiu que o navegador é um bot por causa de assinaturas como:

| Sinal | Como Playwright/Chrome controlado o expõe |
|---|---|
| `navigator.webdriver` | `true` (em browser normal é `false`/`undefined`) |
| `navigator.plugins.length` | 0 ou lista vazia (Chrome humano tem PDF Viewer etc.) |
| `navigator.languages` | inconsistente com `Accept-Language` |
| `chrome.runtime` | ausente |
| WebGL vendor/renderer | strings específicas do headless |
| Permissions API | retorna estados que não batem com Chrome de verdade |
| User-Agent | tem `HeadlessChrome` em headless puro |

Tentativas que **não** resolvem (já testadas):

1. Reusar o mesmo `BrowserContext` que passou na listagem → contexto novo na navegação interna, fingerprint volta a ser detectada.
2. Trocar `headless: false` (modo com janela visível) → não muda os sinais acima.
3. Clicar manualmente via `page.mouse.click(x, y)` nas coordenadas do iframe → o clique é entregue, mas o Turnstile já marcou o navegador como bot e não converte.
4. `page.goto()` vs `link.click()` (preservar referer) → indiferente.

---

## Solução: `playwright-extra` + `puppeteer-extra-plugin-stealth`

O plugin **stealth** sobrescreve via `addInitScript` todos os pontos acima.
Ele foi feito originalmente para Puppeteer mas funciona perfeitamente com
`playwright-extra`.

### Instalação

```bash
npm install playwright-extra puppeteer-extra-plugin-stealth
```

### Código mínimo (ESM)

```js
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Aplica o stealth no chromium do playwright-extra.
// Faça isso UMA vez no nível do módulo, antes de launch().
chromium.use(StealthPlugin());

const browser = await chromium.launch({
    channel: 'chrome',          // usa o Chrome real instalado, não o Chromium do Playwright
    headless: true,             // funciona em headless!
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});

const page = await ctx.newPage();

await page.goto('https://exemplo.com/pagina-protegida', {
    waitUntil: 'domcontentloaded',
    timeout: 25_000,
});

// Aguarda Cloudflare "soltar" a página.
// Com stealth, normalmente resolve em <1s sem mostrar Turnstile.
await page.waitForFunction(
    () => !/um momento|just a moment|attention required/i.test(document.title),
    { timeout: 15_000 }
);

const html = await page.content();
await browser.close();
```

### Pontos críticos

- **`channel: 'chrome'`** — usa o Google Chrome instalado no sistema, não o Chromium baixado pelo Playwright. Cloudflare é muito mais permissivo com Chrome real (engine + assinaturas TLS diferentes do Chromium puro).
- **`chromium.use(StealthPlugin())`** afeta TODOS os imports de `playwright-extra` no processo. Se você usa o `playwright` puro em outros scrapers, eles continuam sem stealth (são módulos diferentes).
- **`waitForFunction` no `<title>`** — é o sinal mais confiável de que o desafio passou. O título sai de "Um momento…" / "Just a moment…" para o título real da página.
- **Não tente clicar no iframe do Turnstile** — com stealth o widget nem aparece. Sem stealth, clicar não resolve.

---

## Padrão de scraper: listagem + páginas individuais

Caso típico: a listagem é leve (sem Turnstile ou com challenge fraco) e as
páginas individuais têm proteção forte.

```js
const ctx = await browser.newContext({ /* ... */ });
const listPage = await ctx.newPage();
const detailPage = await ctx.newPage();

// 1. Coleta cards da listagem
await listPage.goto(listURL, { waitUntil: 'domcontentloaded' });
const cards = await listPage.evaluate(() =>
    [...document.querySelectorAll('.card-anuncio')].map(el => ({
        title: el.querySelector('b')?.textContent?.trim(),
        link: el.querySelector('a[href]')?.href,
    }))
);

// 2. Para cada card, abre o detalhe no MESMO context (cookies cf_clearance compartilhados)
for (const card of cards) {
    await detailPage.goto(card.link, { waitUntil: 'domcontentloaded' });
    await detailPage.waitForFunction(
        () => !/um momento/i.test(document.title),
        { timeout: 15_000 }
    );
    card.description = await detailPage.evaluate(() => {
        const txt = document.body.innerText;
        const m = txt.match(/Descri[çc][ãa]o:?\s*([\s\S]*?)(?=Enviar Curr[íi]culo|Compartilhar|$)/i);
        return m ? m[1].trim() : null;
    });

    // Throttling: 400-1000ms entre requisições reduz risco de re-challenge
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
}
```

Custo medido em Maringá (5 vagas): **~10s total**, ~2s por página individual
(navegação + challenge + extração).

---

## Limitações e quando o stealth NÃO basta

| Cenário | Comportamento |
|---|---|
| Turnstile interativo "obrigatório" (não Managed) | Stealth não resolve. Site exige clique humano sempre. |
| Cloudflare Bot Fight Mode com WAF customizado | Pode bloquear por IP/rate. Resolva trocando IP, não scripts. |
| Páginas atrás de login + Turnstile | Stealth + sessão salva geralmente passa, mas TTL da sessão é curto. |
| Sites com PerimeterX, DataDome, Akamai | Outras proteções, stealth não cobre. |

### Plano B se stealth falhar

1. **Sessão semi-manual**: abre browser headful, usuário resolve o Turnstile UMA vez, você salva o cookie `cf_clearance` via `ctx.storageState({ path: 'session.json' })`. Próximas runs carregam com `storageState: 'session.json'`. TTL típico: 30min–2h.
2. **Solver pago**: 2Captcha, anti-captcha — resolvem Turnstile por ~$3 USD/1000 chamadas. Você envia o sitekey + URL, recebe um token, injeta via `cf-turnstile-response`.
3. **Aceitar bloqueio**: usar só dados da listagem (que vem sem desafio) e enriquecer via IA partindo do título.

---

## Detecção: como saber se você está bloqueado

```js
const isBlocked = await page.evaluate(() =>
    /just a moment|um momento|attention required|cloudflare/i.test(document.title) ||
    document.body.innerText.length < 500
);
```

O Ray ID (`Ray ID: a0009032ef58f1eb` no rodapé) é assinatura inequívoca do desafio Cloudflare.

---

## Resumo executivo

| Item | Valor |
|---|---|
| Dependências | `playwright-extra`, `puppeteer-extra-plugin-stealth` (~1 MB) |
| Funciona em headless? | **Sim** |
| Funciona em CI sem display? | Sim, mesmo em GitHub Actions com `xvfb` opcional |
| Resolve Managed Challenge? | Sim, na grande maioria dos casos |
| Resolve Turnstile interativo obrigatório? | Não |
| Custo por página | ~1–2s overhead vs fetch direto |

Verificado em: 2026-05-22, `playwright` 1.59.1, `playwright-extra` 4.3.6,
`puppeteer-extra-plugin-stealth` 2.11.2, Chrome canal stable, Windows 11.
