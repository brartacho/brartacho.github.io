// Heurísticas leves contra automação / scrapers / chatbots tentando atacar
// rotas sensíveis. Não substituem o WAF do Cloudflare — são uma camada de
// defesa em profundidade caso o proxy não esteja na frente, ou caso o
// atacante consiga passar pelas regras de WAF.
//
// Cada função retorna { ok: boolean, reason?: string }. Quem chama decide
// retornar 400/403 — mensagens devem ser genéricas pra não dar feedback útil
// ao atacante sobre qual heurística disparou.

const BOT_UA_PATTERN = /(bot|crawler|spider|curl|wget|python|go-http|java|scrapy|httpclient|libwww|axios\/|node-fetch|okhttp|guzzle|fasthttp|headless|phantomjs|selenium|puppeteer|playwright)/i;

const MAX_LOGIN_PAYLOAD_BYTES = 8 * 1024;       // 8KB — login legítimo ocupa <500B
const MIN_HUMAN_FILL_MS       = 800;            // humano demora ≥800ms entre focar campo e submeter
const MAX_PLAUSIBLE_FILL_MS   = 30 * 60 * 1000; // 30min — descarta fingerprints com clock skew

export function checkUserAgent(req) {
    const ua = (req.headers['user-agent'] || '').trim();
    if (!ua) return { ok: false, reason: 'ua_empty' };
    if (ua.length > 500) return { ok: false, reason: 'ua_too_long' };
    if (BOT_UA_PATTERN.test(ua)) return { ok: false, reason: 'ua_bot' };
    return { ok: true };
}

export function checkContentType(req, expected = 'application/json') {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith(expected)) return { ok: false, reason: 'ct_invalid' };
    return { ok: true };
}

export function checkPayloadSize(req, max = MAX_LOGIN_PAYLOAD_BYTES) {
    // Em Vercel/Node, content-length costuma vir como string. Vercel também
    // tem limite global de body, mas isso aqui rejeita mais cedo (antes de parsear).
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (isNaN(len)) return { ok: true };  // sem header → segue (parser do framework rejeita se for absurdo)
    if (len > max) return { ok: false, reason: 'payload_too_large' };
    return { ok: true };
}

export function checkHoneypot(body, fieldName = 'website') {
    if (!body || typeof body !== 'object') return { ok: true };
    const val = body[fieldName];
    // Bot preenche o campo invisível; humano nunca vê. String vazia e undefined são OK.
    if (val !== undefined && val !== null && String(val).trim() !== '') {
        return { ok: false, reason: 'honeypot_filled' };
    }
    return { ok: true };
}

export function checkFillTime(body, field = 'fillMs', min = MIN_HUMAN_FILL_MS, max = MAX_PLAUSIBLE_FILL_MS) {
    if (!body || typeof body !== 'object') return { ok: true };
    const v = Number(body[field]);
    // Se o campo não foi enviado, tolerante (clientes antigos / curl autorizado).
    // Só rejeita quando veio E está abaixo do mínimo humano.
    if (!Number.isFinite(v)) return { ok: true };
    if (v < min) return { ok: false, reason: 'fill_too_fast' };
    if (v > max) return { ok: false, reason: 'fill_too_slow' };
    return { ok: true };
}

/**
 * Valida token Cloudflare Turnstile no backend.
 * Retorna true se válido. Se TURNSTILE_SECRET não estiver setado (dev local), faz bypass.
 */
export async function verifyTurnstile(token, ip) {
    if (!process.env.TURNSTILE_SECRET) return true;
    if (!token) return false;
    try {
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                secret: process.env.TURNSTILE_SECRET,
                response: token,
                remoteip: ip || '',
            }),
        });
        const json = await r.json();
        return json.success === true;
    } catch { return false; }
}

// Combina todas as heurísticas relevantes pro fluxo de login.
// Retorna { ok, reason } — handler responde 400/403 com mensagem genérica.
export function runLoginGuards(req) {
    const checks = [
        checkContentType(req),
        checkPayloadSize(req),
        checkUserAgent(req),
        checkHoneypot(req.body),
        checkFillTime(req.body),
    ];
    for (const c of checks) {
        if (!c.ok) return c;
    }
    return { ok: true };
}
