// ─── DEMO-CHROME.JS ──────────────────────────────────────────────────────────
// Chrome exclusivo do demo: session, gate de login, tour, overrides de auth/upload.
// Carregado DEPOIS de admin-core.js — pode sobrescrever funções do core.
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_KEY = 'demo_authed';
const TOUR_KEY = 'demo_tour_done';

// ─── OVERRIDES DO CORE ───────────────────────────────────────────────────────

// Demo não tem #loginScreen — aponta para #heroScreen
window._showLoginScreen = function () {
    const app  = document.getElementById('appScreen');
    const hero = document.getElementById('heroScreen');
    if (app)  app.style.display  = 'none';
    if (hero) hero.style.display = 'flex';
    document.documentElement.classList.add('hero-active');
};

// Logout no demo: reload para limpar estado (sem cookie real)
window.logout = function () {
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(TOUR_KEY);
    location.reload();
};

// Refresh de sessão é no-op no demo (não há JWT httpOnly)
window.scheduleSessionRefresh = function () {};

// ─── DEMO LOGIN ──────────────────────────────────────────────────────────────

async function _demoLoginSubmit(e) {
    e.preventDefault();
    const errEl = document.getElementById('demoLoginErr');
    const btn   = document.getElementById('demoLoginBtn');
    const box   = btn?.closest('.login-box');
    const user  = (document.getElementById('demoUser')?.value || '').trim();
    const pass  = document.getElementById('demoPass')?.value || '';

    if (!user || !pass) {
        if (errEl) errEl.textContent = 'Preencha usuário e senha.';
        if (box) { box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 400); }
        return false;
    }

    if (errEl) errEl.textContent = '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Autenticando…'; }

    try {
        const sid = window.ADMIN_CONFIG.getSessionId();
        const r = await fetch('/api/demo/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Session': sid },
            body: JSON.stringify({ username: user, password: pass, website: '' }),
        });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || `Erro ${r.status}`);
        }
        sessionStorage.setItem(AUTH_KEY, '1');
        revealApp();
    } catch (err) {
        if (errEl) errEl.textContent = err.message || 'Credenciais inválidas.';
        if (box) { box.classList.add('shake'); setTimeout(() => box.classList.remove('shake'), 400); }
        if (document.getElementById('demoPass')) document.getElementById('demoPass').value = '';
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Entrar'; }
    }
    return false;
}

function _toggleDemoPass() {
    const inp = document.getElementById('demoPass');
    const ic  = document.getElementById('demoEyeIcon');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type     = show ? 'text' : 'password';
    if (ic) ic.className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
}

// ─── REVEAL APP ──────────────────────────────────────────────────────────────

function revealApp() {
    document.documentElement.classList.remove('hero-active');
    const hero   = document.getElementById('heroScreen');
    const app    = document.getElementById('appScreen');
    const replay = document.getElementById('tourReplay');
    if (hero)   hero.style.display   = 'none';
    if (app)    app.style.display    = 'block';
    if (replay) replay.classList.add('visible');

    // Painel "Configurar Demo" é exclusivo do prod — oculta no demo
    const demoPanel = document.getElementById('demoSettingsPanel');
    if (demoPanel) demoPanel.style.display = 'none';

    // Injeta banner de modo demo (idempotente)
    if (app && !document.getElementById('demoBanner')) {
        const banner = document.createElement('div');
        banner.id = 'demoBanner';
        banner.className = 'demo-banner';
        banner.innerHTML = '<span class="demo-banner-pill">demo</span>'
            + ' <span>Modo demonstração · dados fictícios isolados na sua sessão · ambiente demo renovado a cada 24h</span>';
        app.insertBefore(banner, app.firstChild);
    }

    loadAll();
    if (typeof setRefreshTs === 'function') setRefreshTs();
    setTimeout(() => { if (!sessionStorage.getItem(TOUR_KEY)) startTour(); }, 600);
}

// ─── UPLOAD CLIENT-SIDE (demo) ───────────────────────────────────────────────
// No demo o PDF permanece somente no cliente (blob URL). Nunca é enviado ao
// servidor, nunca persistido — descartado ao fechar a aba.

window._demoBlobUrls = {};

window.uploadCV = async function uploadCVDemo() {
    const name     = (document.getElementById('cvName')?.value || '').trim();
    const desc     = (document.getElementById('cvDesc')?.value || '').trim();
    const fileName = (document.getElementById('cvFileName')?.value || '').trim();
    const file     = _getSelectedFile(); // acessa via accessor (let não cruza script boundaries)

    if (!name)     { showToast('Informe o nome da versão.', 'error');  return; }
    if (!fileName) { showToast('Informe o nome do arquivo.', 'error'); return; }
    if (!file)     { showToast('Selecione um arquivo PDF.', 'error');  return; }

    try {
        const data = await api('POST', '/api/admin/cv-versions', { name, description: desc, file_name: fileName });
        // Mantém blob local para preview; nunca sobe ao servidor
        const blobUrl = URL.createObjectURL(file);
        window._demoBlobUrls[data.id] = { url: blobUrl, fileName };

        // Limpa form
        if (document.getElementById('cvName'))     document.getElementById('cvName').value = '';
        if (document.getElementById('cvDesc'))     document.getElementById('cvDesc').value = '';
        if (document.getElementById('cvFileName')) document.getElementById('cvFileName').value = '';
        if (document.getElementById('uploadFileName')) document.getElementById('uploadFileName').textContent = '';
        _clearSelectedFile();

        showToast('Currículo cadastrado — preview disponível localmente nesta sessão');
        loadCVs();
    } catch (e) { showToast(e.message, 'error'); }
};

// Override downloadCV: usa blob local se disponível, caso contrário fallback na amostra demo
const _coreDownloadCV = window.downloadCV;
window.downloadCV = async function (id) {
    const local = window._demoBlobUrls[id];
    if (local) {
        const a = document.createElement('a');
        a.href = local.url; a.download = local.fileName; a.click();
        return;
    }
    if (typeof _coreDownloadCV === 'function') await _coreDownloadCV(id);
};

// Override previewCV: usa blob local se disponível, caso contrário fallback na amostra demo
const _corePreviewCV = window.previewCV;
window.previewCV = async function (id, name) {
    const local = window._demoBlobUrls[id];
    if (local) {
        const overlay = document.getElementById('pdfPreviewOverlay');
        const frame   = document.getElementById('pdfPreviewFrame');
        const loading = document.getElementById('pdfLoadingMsg');
        const title   = document.getElementById('pdfPreviewTitle');
        if (overlay && frame) {
            overlay.style.display = 'flex';
            if (loading) loading.style.display = 'none';
            if (title)   title.textContent = name || '';
            frame.src = local.url;
            return;
        }
    }
    if (typeof _corePreviewCV === 'function') await _corePreviewCV(id, name);
};

// ─── TOUR ────────────────────────────────────────────────────────────────────

const TOUR = [
    { target: '.app-header',         emoji: '👋', title: 'Bem-vindo ao painel admin',  body: 'Este é o painel real que uso para gerenciar minhas candidaturas. Os dados são fictícios e isolados na sua sessão — feche a aba para resetar tudo.', tab: 'cvs' },
    { target: '[data-tab="cvs"]',    emoji: '📄', title: 'Currículos versionados',     body: 'Cada versão do CV (geral, automation, SDET, bilíngue, etc.) fica salva aqui. Posso ativar/desativar versões e enviar a certa para cada tipo de vaga.', tab: 'cvs' },
    { target: '[data-tab="tokens"]', emoji: '🔑', title: 'Tokens de acesso',           body: 'Gero links únicos com validade e limite de usos. O recrutador acessa o CV sem precisar de conta — e eu rastreio quem abriu.', tab: 'tokens' },
    { target: '[data-tab="vagas"]',  emoji: '💼', title: 'Gestão de candidaturas',     body: 'Toda candidatura registrada com etapas, observações e link com o recrutador. Clique em uma linha para abrir o detalhe.', tab: 'vagas' },
    { target: '#tourReplay',         emoji: '🎬', title: 'Pronto para explorar',       body: 'Pode interagir com qualquer aba. Tudo funciona de verdade contra o banco demo descartável. Clique no 🎬 a qualquer momento para refazer o tour.', tab: null },
];
let _tourStep = 0;

function startTour() {
    _tourStep = 0;
    const card = document.getElementById('tourCard');
    const vw = window.innerWidth, vh = window.innerHeight;
    if (card) card.style.cssText = `top:${Math.max(16, vh / 2 - 120)}px;left:${Math.max(16, vw / 2 - 160)}px;`;
    document.getElementById('tourOverlay')?.classList.add('open');
    showStep();
}

function skipTour() {
    document.getElementById('tourOverlay')?.classList.remove('open');
    sessionStorage.setItem(TOUR_KEY, '1');
}

function prevStep() { if (_tourStep > 0) { _tourStep--; showStep(); } }

function nextStep() {
    if (_tourStep < TOUR.length - 1) { _tourStep++; showStep(); }
    else skipTour();
}

function showStep() {
    const s = TOUR[_tourStep];
    if (s.tab && typeof switchTab === 'function') {
        const currentTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (currentTab !== s.tab) switchTab(s.tab);
    }
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('tourEmoji',   s.emoji);
    set('tourTitle',   s.title);
    set('tourBody',    s.body);
    set('tourCounter', `${_tourStep + 1} / ${TOUR.length}`);
    const prev = document.getElementById('tourPrev');
    const next = document.getElementById('tourNext');
    if (prev) prev.style.visibility = _tourStep === 0 ? 'hidden' : 'visible';
    if (next) next.textContent = _tourStep === TOUR.length - 1 ? 'Concluir' : 'Próximo';
    setTimeout(() => positionTour(s.target), 100);
}

function positionTour(targetSel) {
    const card = document.getElementById('tourCard');
    const spot = document.getElementById('tourSpotlight');
    if (!card || !spot) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = Math.min(card.offsetWidth || 320, vw - 32);
    const ch = Math.min(card.offsetHeight || 200, vh - 32);
    const M = 16;
    const clampTop  = v => Math.max(M, Math.min(vh - ch - M, v));
    const clampLeft = v => Math.max(M, Math.min(vw - cw - M, v));

    const t = targetSel ? document.querySelector(targetSel) : null;
    const r = (t && t.offsetParent !== null) ? t.getBoundingClientRect() : null;
    const targetVisible = r && r.bottom > 0 && r.top < vh && r.width > 0;

    if (!targetVisible) {
        spot.style.cssText = 'top:-9999px;left:-9999px;width:0;height:0;';
        card.style.cssText = `top:${clampTop(vh / 2 - ch / 2)}px;left:${clampLeft(vw / 2 - cw / 2)}px;`;
        return;
    }

    if (r.top < 0 || r.bottom > vh) t.scrollIntoView({ block: 'center', behavior: 'smooth' });

    const PAD = 8;
    spot.style.cssText = `top:${r.top - PAD}px;left:${r.left - PAD}px;width:${r.width + 2 * PAD}px;height:${r.height + 2 * PAD}px;`;

    const fitBelow = r.bottom + ch + M * 2 < vh;
    const fitAbove = r.top - ch - M * 2 > 0;
    const top  = fitBelow ? r.bottom + 14 : fitAbove ? r.top - ch - 14 : vh / 2 - ch / 2;
    const left = r.left + r.width / 2 - cw / 2;
    card.style.cssText = `top:${clampTop(top)}px;left:${clampLeft(left)}px;`;
}

window.addEventListener('resize', () => {
    if (document.getElementById('tourOverlay')?.classList.contains('open')) {
        positionTour(TOUR[_tourStep].target);
    }
});

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────

(function _demoBoot() {
    document.documentElement.classList.add('hero-active');
    if (sessionStorage.getItem(AUTH_KEY) === '1') {
        revealApp();
    }
    // Turnstile no widget da produção não se aplica ao demo (init usa credenciais)
    // _initTurnstile() pode ser chamado se #turnstileWrap existir no heroScreen
    if (typeof _initTurnstile === 'function') _initTurnstile();
})();
