// Suite de testes de segurança — executa contra produção (https://artacho.dev).
// Cobre: bypass de autenticação, injeção, validação de token, headers HTTP,
// restrição de métodos, enumeração de usuários e rate limiting.
//
// Rate limiting (força bruta): opt-in com SECURITY_BRUTE_FORCE_TEST=1.
// ATENÇÃO: rode esse flag apenas após limpar a tabela rate_limits no Supabase.

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'https://artacho.dev';
const RUN_BRUTE_FORCE = process.env.SECURITY_BRUTE_FORCE_TEST === '1';

// Endpoints admin que exigem JWT
const ADMIN_ENDPOINTS = [
    '/api/admin/cv-versions',
    '/api/admin/tokens',
    '/api/admin/logs',
    '/api/admin/applications',
    '/api/admin/storage-stats',
];

// Monta JWT com header+payload válidos mas assinatura forjada
function forgedJwt(payload = { role: 'admin' }) {
    const b64url = obj =>
        Buffer.from(JSON.stringify(obj))
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    const hdr = b64url({ alg: 'HS256', typ: 'JWT' });
    const pay = b64url({ ...payload, iat: Math.floor(Date.now() / 1000) });
    return `${hdr}.${pay}.assinatura_forjada_invalida`;
}

// ─── 1. Autenticação e autorização ──────────────────────────────────────────

test.describe('Auth bypass — endpoints admin', () => {
    for (const endpoint of ADMIN_ENDPOINTS) {
        test(`${endpoint} sem Authorization → 401`, async ({ request }) => {
            const res = await request.get(`${BASE}${endpoint}`);
            expect(res.status()).toBe(401);
            const body = await res.json();
            expect(body).toHaveProperty('error');
            // Sem stack trace ou detalhes internos
            expect(JSON.stringify(body)).not.toMatch(/at\s+\w+.*\.js:\d+:\d+/);
        });

        test(`${endpoint} com token malformado → 401`, async ({ request }) => {
            const res = await request.get(`${BASE}${endpoint}`, {
                headers: { Authorization: 'Bearer nao_e_um_jwt' },
            });
            expect(res.status()).toBe(401);
        });

        test(`${endpoint} com JWT forjado (secret errado) → 401`, async ({ request }) => {
            const res = await request.get(`${BASE}${endpoint}`, {
                headers: { Authorization: `Bearer ${forgedJwt()}` },
            });
            expect(res.status()).toBe(401);
        });

        test(`${endpoint} com Bearer vazio → 401`, async ({ request }) => {
            const res = await request.get(`${BASE}${endpoint}`, {
                headers: { Authorization: 'Bearer ' },
            });
            expect(res.status()).toBe(401);
        });
    }
});

// ─── 2. Segurança do login ───────────────────────────────────────────────────

test.describe('Login — validação de entrada', () => {
    test('campos ausentes → 400', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, { data: {} });
        expect(res.status()).toBe(400);
    });

    test('apenas username → 400', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: 'alguem@exemplo.com' },
        });
        expect(res.status()).toBe(400);
    });

    test('apenas password → 400', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { password: 'senhaqualquer' },
        });
        expect(res.status()).toBe(400);
    });

    test('credenciais inválidas → 401 com mensagem genérica (sem enumeração de usuário)', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: 'naoexiste@fake.com', password: 'senhaerrada' },
        });
        expect(res.status()).toBe(401);
        const body = await res.json();
        // Mensagem genérica — não revela se username ou senha estão errados
        expect(body.error).toMatch(/usuário|senha|incorretos/i);
        expect(body.error).not.toMatch(/não encontrado|not found|does not exist|email inexistente|usuário inválido/i);
    });

    test('SQL injection no username → 401 (não 500)', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: "' OR '1'='1'; --", password: "' OR '1'='1" },
        });
        // 400/401 = validação; 429 = rate limit ativo após tentativas anteriores
        expect([400, 401, 429]).toContain(res.status());
    });

    test('payload com objetos aninhados não causa crash → não é 500', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: { nested: true }, password: ['array'] },
        });
        // 400/401 = validação; 429 = rate limit ativo após tentativas anteriores
        expect([400, 401, 429]).toContain(res.status());
    });

    test('username muito longo não causa crash → não é 500', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: 'a'.repeat(1000), password: 'b'.repeat(1000) },
        });
        expect([400, 401, 429]).toContain(res.status());
    });
});

// ─── 3. Segurança do token de download de CV ─────────────────────────────────

test.describe('CV download — validação de token', () => {
    test('sem parâmetro t → 400', async ({ request }) => {
        const res = await request.get(`${BASE}/api/cv/download`);
        expect(res.status()).toBe(400);
    });

    test('token curto (< 10 chars) → 400', async ({ request }) => {
        const res = await request.get(`${BASE}/api/cv/download?t=curto`);
        expect(res.status()).toBe(400);
    });

    test('token inexistente (hash SHA-256 aleatório) → 404', async ({ request }) => {
        const fakeToken = 'a1b2c3d4e5f6'.repeat(5); // 60 chars, válido em tamanho
        const res = await request.get(`${BASE}/api/cv/download?t=${fakeToken}`);
        expect(res.status()).toBe(404);
    });

    test('path traversal no token → 400 ou 404 (não 500)', async ({ request }) => {
        const traversal = encodeURIComponent('../../etc/passwd');
        const res = await request.get(`${BASE}/api/cv/download?t=${traversal}`);
        expect([400, 404]).toContain(res.status());
    });

    test('token com caracteres especiais → 400 ou 404 (não 500)', async ({ request }) => {
        const res = await request.get(`${BASE}/api/cv/download?t=<script>alert(1)</script>`);
        expect([400, 404]).toContain(res.status());
    });
});

// ─── 4. Cabeçalhos de segurança HTTP ─────────────────────────────────────────

test.describe('Headers de segurança HTTP', () => {
    test('/api/* tem X-Content-Type-Options: nosniff', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/cv-versions`);
        expect(res.headers()['x-content-type-options']).toBe('nosniff');
    });

    test('/api/* tem X-Frame-Options: DENY', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/cv-versions`);
        expect(res.headers()['x-frame-options']).toBe('DENY');
    });

    test('/api/* tem X-XSS-Protection', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/cv-versions`);
        expect(res.headers()['x-xss-protection']).toBeDefined();
    });

    test('/admin retorna X-Robots-Tag com noindex (não indexável)', async ({ request }) => {
        // Requer que vercel.json inclua source "/admin" (exato) além de "/admin/(.*)"
        const res = await request.get(`${BASE}/admin`);
        const robotsTag = res.headers()['x-robots-tag'] || '';
        expect(robotsTag).toMatch(/noindex/);
    });

    test('/admin tem X-Frame-Options: DENY (proteção anti-clickjacking)', async ({ request }) => {
        // Requer que vercel.json inclua source "/admin" (exato) além de "/admin/(.*)"
        const res = await request.get(`${BASE}/admin`);
        expect(res.headers()['x-frame-options']).toBe('DENY');
    });

    test('resposta de erro 401 não expõe detalhes internos', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/tokens`);
        const body = await res.json();
        // Apenas a chave "error" esperada — sem "stack", "trace", "detail", etc.
        const keys = Object.keys(body);
        expect(keys).toEqual(['error']);
    });
});

// ─── 5. Restrição de métodos HTTP ────────────────────────────────────────────

test.describe('Restrição de métodos HTTP', () => {
    test('GET /api/admin/login → 405', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/login`);
        expect(res.status()).toBe(405);
    });

    test('DELETE /api/admin/login → 405', async ({ request }) => {
        const res = await request.delete(`${BASE}/api/admin/login`);
        expect(res.status()).toBe(405);
    });

    test('PUT /api/admin/login → 405', async ({ request }) => {
        const res = await request.put(`${BASE}/api/admin/login`, { data: {} });
        expect(res.status()).toBe(405);
    });

    test('POST /api/cv/download → 405', async ({ request }) => {
        const res = await request.post(`${BASE}/api/cv/download`, { data: {} });
        expect(res.status()).toBe(405);
    });

    test('DELETE /api/cv/download → 405', async ({ request }) => {
        const res = await request.delete(`${BASE}/api/cv/download`);
        expect(res.status()).toBe(405);
    });
});

// ─── 6. Hardening Fase 1 — headers globais, CORS, bot guards ─────────────────
// Estes testes validam as mudanças de hardening introduzidas em
// feature/security-hardening-fase1. Rodam apenas após deploy.

test.describe('Headers globais — Fase 1', () => {
    test('HSTS presente em /', async ({ request }) => {
        const res = await request.get(`${BASE}/`);
        const hsts = res.headers()['strict-transport-security'] || '';
        expect(hsts).toMatch(/max-age=\d+/);
        expect(hsts).toMatch(/includeSubDomains/);
    });

    test('Referrer-Policy presente em /', async ({ request }) => {
        const res = await request.get(`${BASE}/`);
        expect(res.headers()['referrer-policy']).toMatch(/strict-origin/);
    });

    test('Permissions-Policy nega camera/microfone/geo', async ({ request }) => {
        const res = await request.get(`${BASE}/`);
        const pp = res.headers()['permissions-policy'] || '';
        expect(pp).toMatch(/camera=\(\)/);
        expect(pp).toMatch(/microphone=\(\)/);
        expect(pp).toMatch(/geolocation=\(\)/);
    });

    test('Cross-Origin-Opener-Policy = same-origin em /', async ({ request }) => {
        const res = await request.get(`${BASE}/`);
        expect(res.headers()['cross-origin-opener-policy']).toBe('same-origin');
    });

    test('/admin tem Content-Security-Policy estrito', async ({ request }) => {
        const res = await request.get(`${BASE}/admin`);
        const csp = res.headers()['content-security-policy'] || '';
        expect(csp).toMatch(/default-src 'self'/);
        expect(csp).toMatch(/frame-ancestors 'none'/);
        expect(csp).toMatch(/object-src 'none'/);
    });
});

test.describe('CORS estrito — Fase 1', () => {
    test('origem não autorizada NÃO recebe Access-Control-Allow-Origin', async ({ request }) => {
        const res = await request.fetch(`${BASE}/api/admin/cv-versions`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example.com' },
        });
        const acao = res.headers()['access-control-allow-origin'];
        // Ou ausente, ou diferente da origem maliciosa
        if (acao) expect(acao).not.toBe('https://evil.example.com');
    });

    test('origem artacho.dev recebe ACAO refletido', async ({ request }) => {
        const res = await request.fetch(`${BASE}/api/admin/cv-versions`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://artacho.dev' },
        });
        expect(res.headers()['access-control-allow-origin']).toBe('https://artacho.dev');
        expect(res.headers()['vary']).toMatch(/Origin/i);
    });
});

test.describe('Bot detection no login — Fase 1', () => {
    test('User-Agent com "python-requests" → 401', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            headers: { 'User-Agent': 'python-requests/2.31' },
            data: { username: 'x@y.com', password: 'x', fillMs: 2000 },
        });
        // Bot detection deve barrar antes de validar credencial
        expect([401, 429]).toContain(res.status());
    });

    test('User-Agent com "curl/" → 401', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            headers: { 'User-Agent': 'curl/8.0.1' },
            data: { username: 'x@y.com', password: 'x', fillMs: 2000 },
        });
        expect([401, 429]).toContain(res.status());
    });

    test('Honeypot preenchido → 401', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Test)' },
            data: { username: 'x@y.com', password: 'x', website: 'spam.com', fillMs: 2000 },
        });
        expect([401, 429]).toContain(res.status());
    });

    test('fillMs muito curto (< 800ms) → 401', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Test)' },
            data: { username: 'x@y.com', password: 'x', fillMs: 50 },
        });
        expect([401, 429]).toContain(res.status());
    });

    test('Content-Type ausente → 401', async ({ request }) => {
        const res = await request.fetch(`${BASE}/api/admin/login`, {
            method: 'POST',
            headers: { 'User-Agent': 'Mozilla/5.0 (Test)' },
            data: 'username=x&password=y',  // text/plain ou form-encoded
        });
        expect([401, 415, 400, 429]).toContain(res.status());
    });
});

// ─── 8. Anti-regressão: assets self-hosted do admin ──────────────────────────
// Garante que /admin carrega sem violações de CSP e que os 4 grupos de assets
// (fontes, Font Awesome, Sortable, Chart.js) estão em paths locais. Se alguém
// reintroduzir CDN externo, o CSP estrito da Fase 1 bloqueia e estes testes
// falham rápido — pegando a regressão antes do deploy.

test.describe('Admin assets self-hosted — anti-regressão CSP', () => {
    test('GET /admin/assets/fonts/fonts.css → 200', async ({ request }) => {
        const r = await request.get(`${BASE}/admin/assets/fonts/fonts.css`);
        expect(r.status()).toBe(200);
        expect(r.headers()['content-type']).toMatch(/css/);
    });

    test('GET /admin/assets/fontawesome/css/all.min.css → 200', async ({ request }) => {
        const r = await request.get(`${BASE}/admin/assets/fontawesome/css/all.min.css`);
        expect(r.status()).toBe(200);
    });

    test('GET /admin/assets/js/sortable.min.js → 200 (javascript)', async ({ request }) => {
        const r = await request.get(`${BASE}/admin/assets/js/sortable.min.js`);
        expect(r.status()).toBe(200);
        expect(r.headers()['content-type']).toMatch(/javascript/);
    });

    test('GET /admin/assets/js/chart.umd.min.js → 200', async ({ request }) => {
        const r = await request.get(`${BASE}/admin/assets/js/chart.umd.min.js`);
        expect(r.status()).toBe(200);
    });

    test('/admin carrega sem violações de CSP no console', async ({ page }) => {
        // Ignora script injetado pelo Vercel apenas em deploys de preview
        // (vercel.live/_next-live/feedback/feedback.js) — não existe em produção.
        const VERCEL_LIVE_PREVIEW = /vercel\.live\/_next-live\/feedback/;
        const cspViolations = [];
        page.on('console', msg => {
            const txt = msg.text();
            if (msg.type() === 'error' && /content security policy|refused to load/i.test(txt) && !VERCEL_LIVE_PREVIEW.test(txt)) {
                cspViolations.push(txt);
            }
        });
        await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
        expect(cspViolations).toEqual([]);
    });

    test('/admin aplica tipografia Plus Jakarta Sans no body', async ({ page }) => {
        await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
        const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
        expect(family).toMatch(/Plus Jakarta Sans/i);
    });

    test('/admin expõe globais Sortable e Chart', async ({ page }) => {
        await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
        const flags = await page.evaluate(() => ({
            sortable: typeof window.Sortable,
            chart: typeof window.Chart,
        }));
        expect(flags.sortable).toBe('function');
        expect(flags.chart).toBe('function');
    });

    test('/admin renderiza ícone Font Awesome com largura > 0', async ({ page }) => {
        await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
        // pwToggleIcon (eye da senha) é uma das primeiras instâncias visíveis.
        // Quando FA falha em carregar, o ícone fica com width 0.
        const w = await page.evaluate(() => {
            const el = document.getElementById('pwToggleIcon');
            return el ? el.getBoundingClientRect().width : 0;
        });
        expect(w).toBeGreaterThan(8);
    });
});


// ─── 9. Rate limiting — força bruta (opt-in) ─────────────────────────────────

test.describe('Rate limiting — força bruta no login', () => {
    test.skip(!RUN_BRUTE_FORCE,
        'Defina SECURITY_BRUTE_FORCE_TEST=1 para rodar. ' +
        'ATENÇÃO: limpe a tabela rate_limits no Supabase antes e depois.');

    test('6ª tentativa falha consecutiva → 429 com Retry-After', async ({ request }) => {
        for (let i = 0; i < 5; i++) {
            const r = await request.post(`${BASE}/api/admin/login`, {
                data: { username: 'bruteforce_test@fake.com', password: `errada${i}` },
            });
            // As 5 primeiras devem ser 401 (não 429 ainda)
            if (r.status() === 429) {
                // Rate limit já existia — limpe a tabela e tente novamente
                test.fail(true, 'Rate limit já estava ativo. Limpe a tabela rate_limits primeiro.');
                return;
            }
        }
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: 'bruteforce_test@fake.com', password: 'errada6' },
        });
        expect(res.status()).toBe(429);
        const body = await res.json();
        expect(body.error).toMatch(/muitas tentativas|aguarde/i);
        expect(res.headers()['retry-after']).toBeDefined();
    });
});

// ─── FASE 2: Cookie HttpOnly Auth ─────────────────────────────────────────

test.describe('Cookie httpOnly — login nao expoe token no body', () => {
    test('POST /api/admin/login com credenciais erradas — body sem campo token', async ({ request }) => {
        const res = await request.post(`${BASE}/api/admin/login`, {
            data: { username: 'nope@test.com', password: 'wrongpass', fillMs: 2000 },
        });
        // 401 = creds inválidas; 429 = rate limit (a invariante "sem token no body" vale nos dois)
        expect([401, 429]).toContain(res.status());
        const body = await res.json().catch(() => ({}));
        expect(body).not.toHaveProperty('token');
    });

    test('DELETE /api/admin/sessions sem cookie valido — idempotente (200 ou 401)', async ({ request }) => {
        const res = await request.delete(`${BASE}/api/admin/sessions`);
        expect([200, 401]).toContain(res.status());
    });

    test('PATCH /api/admin/sessions sem cookie → 401', async ({ request }) => {
        const res = await request.patch(`${BASE}/api/admin/sessions`, {
            headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status()).toBe(401);
    });

    test('GET /api/admin/sessions sem cookie → 401', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/sessions`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/admin/cv-versions sem cookie e sem Bearer → 401', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/cv-versions`);
        expect(res.status()).toBe(401);
    });

    test('GET /api/admin/sessions com JWT Bearer forjado → 401', async ({ request }) => {
        const res = await request.get(`${BASE}/api/admin/sessions`, {
            headers: { Authorization: `Bearer ${forgedJwt()}` },
        });
        expect(res.status()).toBe(401);
    });
});
