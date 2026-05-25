// ─── STATE ───────────────────────────────────────────────
let selectedFile = null;
let selectedFilePath = null;
let currentExpiryHours = 24;

// Accessors expostos globalmente para que demo-chrome.js acesse variáveis let-scoped
function _getSelectedFile() { return selectedFile; }
function _clearSelectedFile() { selectedFile = null; }

// ─── TURNSTILE ───────────────────────────────────────────
let _turnstileToken = null;
let _turnstileWidgetId = null;

function _initTurnstile() {
    const wrap = document.getElementById('turnstileWrap');
    if (!wrap) return;
    const sitekey = (window.ADMIN_CONFIG && window.ADMIN_CONFIG.turnstileSitekey) || '';
    if (!sitekey) {
        wrap.innerHTML = '<div style="font-size:0.7rem;color:var(--text-dim);font-family:var(--font-mono);padding:8px 0">// captcha desativado (dev mode)</div>';
        return;
    }
    if (!window.turnstile) { setTimeout(_initTurnstile, 200); return; }
    if (_turnstileWidgetId !== null) return;
    _turnstileWidgetId = window.turnstile.render('#turnstileWrap', {
        sitekey,
        theme: 'dark',
        callback:          t  => { _turnstileToken = t; },
        'error-callback':  () => { _turnstileToken = null; },
        'expired-callback':() => { _turnstileToken = null; },
    });
}

function _resetTurnstile() {
    _turnstileToken = null;
    if (window.turnstile && _turnstileWidgetId !== null) {
        window.turnstile.reset(_turnstileWidgetId);
    }
}

// ─── AUTH ─────────────────────────────────────────────────
// JWT em cookie httpOnly — JS não acessa o token diretamente.
// credentials:'include' no fetch garante envio automático do cookie.

let _sessionRefreshTimer = null;

function scheduleSessionRefresh() {
    clearInterval(_sessionRefreshTimer);
    _sessionRefreshTimer = setInterval(async () => {
        try {
            await fetch('/api/admin/sessions', {
                method: 'PATCH',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch { /* swallow — servidor decide se renova */ }
    }, 10 * 60 * 1000); // 10min
}

function _showLoginScreen() {
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    const tsEl = document.getElementById('refreshTs');
    if (tsEl) tsEl.textContent = '';
    const usr = document.getElementById('loginUsername');
    if (usr) usr.value = '';
    const pw = document.getElementById('loginPassword');
    if (pw) { pw.value = ''; pw.type = 'password'; }
    const icon = document.getElementById('pwToggleIcon');
    if (icon) icon.className = 'fa-regular fa-eye';
    const errEl = document.getElementById('loginError');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    _loginFormStartedAt = null;
}

async function logout() {
    clearInterval(_sessionRefreshTimer);
    clearTimeout(_refreshTimer);
    _lastRefreshAt = null;
    try {
        await fetch('/api/admin/sessions', { method: 'DELETE', credentials: 'include' });
    } catch { /* swallow — limpa UI de qualquer forma */ }
    _showLoginScreen();
}

// Marca o instante em que o usuário começou a interagir com o form de login.
// Bots costumam submeter em <100ms. Humanos demoram ≥800ms entre focar e enviar.
let _loginFormStartedAt = null;
function _markLoginFormStart() {
    if (_loginFormStartedAt === null) _loginFormStartedAt = Date.now();
}
['loginUsername', 'loginPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('focus', _markLoginFormStart, { once: false });
        el.addEventListener('input', _markLoginFormStart, { once: false });
    }
});

async function doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const pw = document.getElementById('loginPassword').value;
    const honeypot = (document.getElementById('loginWebsite') || {}).value || '';
    const fillMs = _loginFormStartedAt ? (Date.now() - _loginFormStartedAt) : 1500;
    const btn = document.getElementById('loginBtn');
    const errEl = document.getElementById('loginError');
    errEl.style.display = 'none';

    if (!username) {
        errEl.textContent = 'Informe seu email.';
        errEl.style.display = 'block';
        return;
    }
    if (!pw) {
        errEl.textContent = 'Informe a senha.';
        errEl.style.display = 'block';
        return;
    }

    try {
        await withLoading(btn, async () => {
            await api('POST', '/api/admin/login', {
                username,
                password: pw,
                website: honeypot,
                fillMs,
                cf_token: _turnstileToken || '',
            }, false);
            // Cookie setado pelo servidor — sem token no body
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('appScreen').style.display = 'block';
            scheduleSessionRefresh();
            // Marca visitas históricas deste dispositivo como admin (best-effort)
            api('POST', '/api/admin/mark-my-visits', {}).catch(() => {});
            loadAll();
        }, 'Autenticando…');
    } catch (e) {
        errEl.textContent = e.message || 'Usuário ou senha incorretos.';
        errEl.style.display = 'block';
        _resetTurnstile();
    } finally {
        // Reset timer para próximas tentativas (rate limit + backoff cuida do resto)
        _loginFormStartedAt = null;
    }
}

document.getElementById('loginUsername')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('loginPassword').focus();
});
document.getElementById('loginPassword')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
});

function togglePassword() {
    const input = document.getElementById('loginPassword');
    const icon = document.getElementById('pwToggleIcon');
    const btn = document.getElementById('pwToggleBtn');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    icon.className = showing ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
    btn.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
    input.focus();
}

function openForgot() {
    document.getElementById('forgotModal').hidden = false;
    document.getElementById('forgotMessage').hidden = true;
    document.getElementById('forgotMessage').className = 'forgot-msg';
    document.getElementById('forgotMessage').textContent = '';
    document.getElementById('forgotBtn').disabled = false;
}

function closeForgot() {
    document.getElementById('forgotModal').hidden = true;
}

async function sendRecovery() {
    const btn = document.getElementById('forgotBtn');
    const msg = document.getElementById('forgotMessage');
    msg.hidden = true;

    try {
        await withLoading(btn, async () => {
            const r = await fetch('/api/admin/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'forgot' }) });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'Falha ao gerar link');

            msg.className = 'forgot-msg success';
            msg.textContent = data.message || 'Link enviado! Verifique seu email (incluindo spam) nos próximos minutos.';
            msg.hidden = false;
        }, 'Enviando…');
    } catch (e) {
        msg.className = 'forgot-msg error';
        msg.textContent = e.message;
        msg.hidden = false;
    }
}

// ─── Helpers de modal ─────────────────────────────────────
function modalHasUnsavedData(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return false;
    const inputs = modal.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea');
    for (const el of inputs) {
        if (el.value && el.value.trim()) return true;
    }
    return false;
}
function showPrompt(title, placeholder = '') {
    return new Promise(resolve => {
        document.getElementById('promptTitle').textContent = title;
        const input = document.getElementById('promptInput');
        input.value = '';
        input.placeholder = placeholder;
        const overlay = document.getElementById('promptModal');
        overlay.classList.add('open');
        const close = result => {
            overlay.classList.remove('open');
            document.removeEventListener('keydown', escHandler);
            resolve(result);
        };
        const escHandler = e => { if (e.key === 'Escape') close(null); };
        document.addEventListener('keydown', escHandler, { once: true });
        input.onkeydown = e => { if (e.key === 'Enter') close(input.value.trim() || null); };
        document.getElementById('promptOkBtn').onclick  = () => close(input.value.trim() || null);
        document.getElementById('promptCancelBtn').onclick = () => close(null);
        setTimeout(() => input.focus(), 60);
    });
}

function showConfirm(title, message, { okText = 'Confirmar', danger = true } = {}) {
    return new Promise(resolve => {
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;
        const okBtn = document.getElementById('confirmOkBtn');
        okBtn.textContent = okText;
        okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-cyan'}`;
        const overlay = document.getElementById('confirmModal');
        overlay.classList.add('open');
        const close = result => {
            overlay.classList.remove('open');
            document.removeEventListener('keydown', escHandler);
            resolve(result);
        };
        const escHandler = e => { if (e.key === 'Escape') close(false); };
        document.addEventListener('keydown', escHandler, { once: true });
        okBtn.onclick = () => close(true);
        document.getElementById('confirmCancelBtn').onclick = () => close(false);
    });
}

async function safeCloseModal(modalId, closeFn) {
    if (modalHasUnsavedData(modalId)) {
        if (!await showConfirm('Fechar formulário?', 'Você tem dados não enviados nesse formulário.', { okText: 'Fechar assim mesmo', danger: false })) return;
    }
    closeFn();
}

// Escape fecha qualquer modal aberto (com proteção)
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const openModals = [
        ['forgotModal', closeForgot],
        ['sendCvModal', closeSendCV],
        ['editCvModal', closeEditCV],
        ['radarAdaptarCvModal', closeRadarAdaptarCv],
    ];
    for (const [id, fn] of openModals) {
        const el = document.getElementById(id);
        if (el && (el.classList.contains('open') || !el.hidden)) { safeCloseModal(id, fn); break; }
    }
});

// Click no backdrop fecha (com proteção)
document.getElementById('forgotModal')?.addEventListener('click', e => {
    if (e.target.id === 'forgotModal') safeCloseModal('forgotModal', closeForgot);
});

// ─── API HELPER ───────────────────────────────────────────
async function api(method, path, body, auth = true) {
    const cfg = window.ADMIN_CONFIG || { mode: 'prod', apiBase: '/api/admin' };
    const headers = { 'Content-Type': 'application/json' };
    const fetchOpts = { method, headers, body: body ? JSON.stringify(body) : undefined };
    let url = path;

    if (cfg.mode === 'demo') {
        // Demo nunca toca dados de produção: reescreve /api/admin/* para o apiBase do demo,
        // injeta o header de sessão e bloqueia qualquer chamada que escape do namespace demo.
        const base = cfg.apiBase || '/api/demo';
        url = path.replace(/^\/api\/admin/, base);
        if (!url.startsWith(base)) {
            throw new Error('Chamada bloqueada no modo demo: ' + path);
        }
        const sid = (typeof cfg.getSessionId === 'function')
            ? cfg.getSessionId()
            : sessionStorage.getItem(cfg.sessionKey || 'demo_session_id');
        if (sid) headers['X-Demo-Session'] = sid;
    } else {
        fetchOpts.credentials = 'include';
    }

    const r = await fetch(url, fetchOpts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
        if (r.status === 401 && auth) {
            clearInterval(_sessionRefreshTimer);
            clearTimeout(_refreshTimer);
            _lastRefreshAt = null;
            _showLoginScreen();
            throw new Error('Sessão encerrada. Faça login novamente.');
        }
        throw new Error(data.error || `HTTP ${r.status}`);
    }
    return data;
}

// Wrapper fetch com assinatura nativa (url, opts?) + auth + demo mode
async function apiFetch(url, opts = {}) {
    const cfg = window.ADMIN_CONFIG || { mode: 'prod', apiBase: '/api/admin' };
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const fetchOpts = { method: opts.method || 'GET', headers };
    if (opts.body !== undefined) fetchOpts.body = opts.body;

    if (cfg.mode === 'demo') {
        const base = cfg.apiBase || '/api/demo';
        url = url.replace(/^\/api\/admin/, base);
        const sid = (typeof cfg.getSessionId === 'function')
            ? cfg.getSessionId()
            : sessionStorage.getItem(cfg.sessionKey || 'demo_session_id');
        if (sid) headers['X-Demo-Session'] = sid;
    } else {
        fetchOpts.credentials = 'include';
    }

    const r = await fetch(url, fetchOpts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
        if (r.status === 401) {
            clearInterval(_sessionRefreshTimer);
            clearTimeout(_refreshTimer);
            _lastRefreshAt = null;
            _showLoginScreen();
            throw new Error('Sessão encerrada. Faça login novamente.');
        }
        throw new Error(data.error || `HTTP ${r.status}`);
    }
    return data;
}

// ─── HELPERS DE UI ASYNC ──────────────────────────────────
// Botão fica desabilitado + spinner girando + label trocada durante a operação
async function withLoading(btn, asyncFn, loadingLabel = 'Processando…') {
    if (!btn) return asyncFn();
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${loadingLabel}`;
    try {
        return await asyncFn();
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

// Upload via XHR com progresso real (fetch não suporta upload.onprogress)
function uploadWithProgress(signedUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', signedUrl);
        xhr.setRequestHeader('Content-Type', 'application/pdf');
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300
            ? resolve(xhr)
            : reject(new Error(`Upload falhou (HTTP ${xhr.status})`));
        xhr.onerror = () => reject(new Error('Erro de rede no upload'));
        xhr.send(file);
    });
}

// Atualiza o widget de progresso do upload (mode: 'indeterminate' ou 'progress')
function setUploadPhase(text, mode = 'indeterminate', percent = 0) {
    document.getElementById('uploadPhaseText').textContent = text;
    const bar = document.getElementById('uploadBar');
    const pct = document.getElementById('uploadPercent');
    if (mode === 'indeterminate') {
        bar.classList.add('indeterminate');
        pct.textContent = '';
    } else {
        bar.classList.remove('indeterminate');
        bar.style.width = (percent * 100).toFixed(0) + '%';
        pct.textContent = (percent * 100).toFixed(0) + '%';
    }
}

// Download direto de uma versão de CV (atalho da lista)
async function downloadCV(id) {
    try {
        const dl = await api('GET', `/api/admin/cv-storage-url?id=${id}`);
        const a = document.createElement('a');
        a.href = dl.signedUrl;
        a.download = dl.file_name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast(`Baixando ${dl.file_name}`);
    } catch (e) { showToast(e.message, 'error'); }
}

let _previewCvId = null;

async function previewCV(id, name) {
    _previewCvId = id;
    const isMobile = window.matchMedia('(max-width: 768px)').matches
        || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    try {
        const dl = await api('GET', `/api/admin/cv-storage-url?id=${id}&preview=1`);
        if (isMobile) {
            // Blob URL em iframe é bloqueado por mobile Safari/Chrome — abre direto em nova aba
            window.open(dl.signedUrl, '_blank');
            return;
        }
        // Desktop: overlay com iframe
        const overlay = document.getElementById('pdfPreviewOverlay');
        const frame   = document.getElementById('pdfPreviewFrame');
        const loading = document.getElementById('pdfLoadingMsg');
        const title   = document.getElementById('pdfPreviewTitle');
        title.textContent = name;
        frame.style.display = 'none';
        _revokePdfBlob();
        frame.src = '';
        loading.style.display = 'flex';
        loading.textContent = 'Carregando PDF…';
        overlay.style.display = 'flex';
        // Fetch como blob para ignorar Content-Disposition do Storage e forçar renderização inline
        const resp = await fetch(dl.signedUrl);
        if (!resp.ok) throw new Error(`Erro ao baixar PDF (${resp.status})`);
        const raw  = await resp.blob();
        const blob = raw.type === 'application/pdf' ? raw : new Blob([raw], { type: 'application/pdf' });
        frame.src = URL.createObjectURL(blob);
    } catch (e) {
        const loading = document.getElementById('pdfLoadingMsg');
        if (loading) loading.textContent = 'Erro ao carregar PDF: ' + e.message;
    }
}

function _revokePdfBlob() {
    const frame = document.getElementById('pdfPreviewFrame');
    if (frame?.src?.startsWith('blob:')) URL.revokeObjectURL(frame.src);
}

function closePdfPreview() {
    const overlay = document.getElementById('pdfPreviewOverlay');
    const frame   = document.getElementById('pdfPreviewFrame');
    overlay.style.display = 'none';
    _revokePdfBlob();
    frame.src = '';
}

// ─── DATA STORES (filter-aware rendering) ─────────────────
let _cvData     = [];
let _tokenData  = [];

let _logData    = [];
let _logPage    = 1;
let _logTotal   = 0;
let _logPages   = 0;
let _logSearchTimer = null;

// ─── SORT ─────────────────────────────────────────────────
let _cvSort    = { col: 'created_at', dir: 'desc' };
let _tokenSort = { col: 'expires_at', dir: 'asc' };
let _logSort   = { col: 'downloaded_at', dir: 'desc' };

function _getVal(obj, col) {
    return col.split('.').reduce((o, k) => o?.[k], obj) ?? '';
}

function _sortData(data, col, dir) {
    return [...data].sort((a, b) => {
        const va = String(_getVal(a, col));
        const vb = String(_getVal(b, col));
        const cmp = va.localeCompare(vb, 'pt-BR', { numeric: true, sensitivity: 'base' });
        return dir === 'asc' ? cmp : -cmp;
    });
}

function toggleSort(table, col) {
    const state = { cvs: _cvSort, tokens: _tokenSort, logs: _logSort }[table];
    if (state.col === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.col = col; state.dir = 'asc'; }
    if (table === 'cvs')         renderCVs();
    else if (table === 'tokens') renderTokens();
    else                         { _logPage = 1; loadLogs(); }
}

function updateSortHeaders(table) {
    const state = { cvs: _cvSort, tokens: _tokenSort, logs: _logSort }[table];
    document.querySelectorAll(`#tab-${table} th[data-sort]`).forEach(th => {
        const arrow = th.querySelector('.sort-arrow');
        if (!arrow) return;
        if (th.dataset.sort === state.col) {
            th.classList.add('sort-active');
            arrow.textContent = state.dir === 'asc' ? '▲' : '▼';
        } else {
            th.classList.remove('sort-active');
            arrow.textContent = '↕';
        }
    });
}

// ─── AUTO-REFRESH ─────────────────────────────────────────
let _activeTab      = 'cvs';
let _refreshTimer   = null;
let _lastRefreshAt  = null;
const AUTO_REFRESH_MS = 60_000;

function _getTabLoader() {
    if (_activeTab === 'cvs')      return () => Promise.all([loadCVs(), loadStorageStats()]);
    if (_activeTab === 'tokens')   return loadTokens;
    if (_activeTab === 'logs')     return loadLogs;
    if (_activeTab === 'vagas')    return _vagasSubTab === 'analise' ? loadVagasAnalysis : loadApplications;
    if (_activeTab === 'metricas') return () => Promise.all([loadAnalytics(), loadLoginAttempts()]);
    return loadCVs;
}

function _updateRefreshTs() {
    const el = document.getElementById('refreshTs');
    if (!el || !_lastRefreshAt) return;
    const sec = Math.round((Date.now() - _lastRefreshAt) / 1000);
    if (sec < 5)         el.textContent = 'atualizado agora';
    else if (sec < 60)   el.textContent = `há ${sec}s`;
    else                 el.textContent = `há ${Math.floor(sec / 60)}min`;
}

function _scheduleRefresh() {
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(doRefresh, AUTO_REFRESH_MS);
}

function doRefresh() {
    const btn  = document.getElementById('refreshBtn');
    if (btn) btn.classList.add('spinning');
    Promise.resolve(_getTabLoader()()).finally(() => {
        _lastRefreshAt = Date.now();
        _updateRefreshTs();
        if (btn) btn.classList.remove('spinning');
        _scheduleRefresh();
    });
}

function manualRefresh() { doRefresh(); }

setInterval(_updateRefreshTs, 5000);

// ─── GESTÃO DE VAGAS ──────────────────────────────────────
let _applications = [];
let _vagasFilter           = 'all';
let _vagasModalidadeFilter = 'all';
let _vagasTipoFilter       = 'all';
let _vagasFiltersOpen      = false;
let _openAppId             = null;
let _filteredApplications  = [];
let _vagasSort             = { col: 'data_envio', dir: 'desc' };
let _vagasSelecting        = false;
let _vagasSelected         = new Set();

// Retorna status canônico de uma etapa (lê s.status; fallback p/ dados antigos)
function stageStatus(s) {
    if (s.status) return s.status;
    if (s.done)    return 'done';
    if (s.current) return 'running';
    return 'pending';
}

// Resultado da candidatura: vem direto do campo `result` (em_processo|aprovado|recusado)
// Frontend traduz para os slugs do filtro: aprovado / recusado / em-processo
function getAppStatus(app) {
    const r = app.result || 'em_processo';
    return r === 'em_processo' ? 'em-processo' : r;
}

function normalizeStageName(name) {
    return (name || '').replace(/\s*\/\s*Oferta$/i, '');
}

function getAppCurrentStageName(app) {
    const active = (app.stages || []).filter(s => s.active !== false);
    const running = active.find(s => stageStatus(s) === 'running');
    if (running) return normalizeStageName(running.name);
    const lastDone = [...active].reverse().find(s => ['done','rejected'].includes(stageStatus(s)));
    return lastDone ? normalizeStageName(lastDone.name) : '—';
}

async function loadApplications() {
    const tbody = document.getElementById('vagasTableBody');
    if (_applications.length) {
        renderApplicationsTable();
    } else {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-dim);padding:32px">Carregando…</td></tr>';
    }

    try {
        const data = await api('GET', '/api/admin/applications');
        _applications = data;
        renderApplicationsTable();
    } catch (e) {
        if (!_applications.length) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--danger);padding:32px">${esc(e.message)}</td></tr>`;
        }
    }
    loadDigestBanner();
}

async function loadDigestBanner() {
    const el = document.getElementById('digestBanner');
    if (!el) return;
    try {
        const d = await api('GET', '/api/admin/applications?__h=digest');
        const parts = [];
        if (d.radar_new > 0) parts.push(`<b>${d.radar_new}</b> lead${d.radar_new > 1 ? 's' : ''} novo${d.radar_new > 1 ? 's' : ''} no Radar${d.radar_high_fit > 0 ? ` (${d.radar_high_fit} score ≥ 7)` : ''}`);
        if (d.followup_due > 0) parts.push(`<b>${d.followup_due}</b> follow-up${d.followup_due > 1 ? 's' : ''} pendente${d.followup_due > 1 ? 's' : ''}`);
        if (d.message_pending > 0) parts.push(`<b>${d.message_pending}</b> mensagem${d.message_pending > 1 ? 'ns' : ''} pronta${d.message_pending > 1 ? 's' : ''} sem envio`);
        if (!parts.length) { el.hidden = true; return; }
        el.hidden = false;
        el.innerHTML = `<i class="fa-solid fa-circle-info" style="color:var(--cyan)"></i> ${parts.join(' · ')} <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="document.getElementById('digestBanner').hidden=true">×</button>`;
    } catch { el.hidden = true; }
}

function renderApplicationsTable() {
    const tbody = document.getElementById('vagasTableBody');
    const countEl = document.getElementById('vagasCount');

    const search = (document.getElementById('vagasSearch')?.value || '').toLowerCase();

    let filtered = _applications;
    // N39: ocultar candidaturas privadas por padrão (exceto se filtro 'privadas' ativo)
    if (_vagasFilter === 'privadas') {
        filtered = filtered.filter(app => app.private);
    } else if (_vagasFilter === 'arquivadas') {
        filtered = filtered.filter(app => app.archived);
    } else {
        filtered = filtered.filter(app => !app.archived && !app.private);
        if (_vagasFilter !== 'all') filtered = filtered.filter(app => getAppStatus(app) === _vagasFilter);
    }
    if (_vagasModalidadeFilter !== 'all') filtered = filtered.filter(app => app.modalidade === _vagasModalidadeFilter);
    if (_vagasTipoFilter       !== 'all') filtered = filtered.filter(app => app.tipo_contratacao === _vagasTipoFilter);

    const dateFrom = document.getElementById('vagasDateFrom')?.value;
    const dateTo   = document.getElementById('vagasDateTo')?.value;
    if (dateFrom) filtered = filtered.filter(app => app.data_envio && app.data_envio.slice(0,10) >= dateFrom);
    if (dateTo)   filtered = filtered.filter(app => app.data_envio && app.data_envio.slice(0,10) <= dateTo);
    const dateActive = dateFrom || dateTo;
    const dateBtn = document.getElementById('vagasDateClear');
    if (dateBtn) dateBtn.style.display = dateActive ? '' : 'none';

    if (search) filtered = filtered.filter(app =>
        (app.empresa || '').toLowerCase().includes(search) ||
        (app.vaga || '').toLowerCase().includes(search) ||
        (app.gestor_nome || '').toLowerCase().includes(search)
    );

    // Sort
    const sortDir = _vagasSort.dir === 'asc' ? 1 : -1;
    filtered = [...filtered].sort((a, b) => {
        switch (_vagasSort.col) {
            case 'empresa':   return sortDir * (a.empresa || '').localeCompare(b.empresa || '', 'pt-BR');
            case 'gestor':    return sortDir * (a.gestor_nome || '').localeCompare(b.gestor_nome || '', 'pt-BR');
            case 'data_envio': {
                const da = a.data_envio ? a.data_envio.slice(0,10) : '';
                const db = b.data_envio ? b.data_envio.slice(0,10) : '';
                return sortDir * da.localeCompare(db);
            }
            case 'created_at': return sortDir * (a.created_at || '').localeCompare(b.created_at || '');
            case 'updated_at': return sortDir * (a.updated_at || '').localeCompare(b.updated_at || '');
            case 'stage':     return sortDir * getAppCurrentStageName(a).localeCompare(getAppCurrentStageName(b), 'pt-BR');
            default:          return 0;
        }
    });

    // Atualizar ícones de sort nos headers
    document.querySelectorAll('.sort-icon').forEach(el => el.textContent = '');
    const activeIcon = document.getElementById(`sort-${_vagasSort.col}`);
    if (activeIcon) activeIcon.textContent = _vagasSort.dir === 'asc' ? ' ↑' : ' ↓';

    if (countEl) countEl.textContent = _applications.length
        ? (filtered.length !== _applications.length ? `${filtered.length} de ${_applications.length}` : `${_applications.length} registros`)
        : '';

    _filteredApplications = filtered;

    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:32px">Nenhuma candidatura encontrada.</td></tr>';
        _updateVagasSelectAll();
        return;
    }

    tbody.innerHTML = filtered.map(app => {
        const status      = getAppStatus(app);
        const stage       = esc(getAppCurrentStageName(app));
        const empresa     = esc(app.empresa || '—');
        const vaga        = esc(app.vaga || '');
        const gestor      = esc(app.gestor_nome || '—');
        const dt          = app.data_envio ? fmtDate(app.data_envio) : '—';
        const dtCadastro  = app.created_at ? fmtDate(app.created_at) : '—';
        const isSelected  = _vagasSelected.has(app.id);
        const rowSelected = _openAppId === app.id ? ' selected' : '';
        const rowClass    = `${rowSelected}${isSelected ? ' selected' : ''}`;
        const metaMobile  = [gestor !== '—' ? gestor : '', dt !== '—' ? dt : ''].filter(Boolean).join(' · ');
        const tagBadges   = [app.modalidade, app.tipo_contratacao].filter(Boolean)
            .map(t => `<span style="display:inline-block;font-size:0.62rem;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text-dim);margin-right:3px">${esc(t)}</span>`)
            .join('');
        const rowAction = _vagasSelecting
            ? `onclick="toggleVagasSelect('${app.id}')"`
            : `onclick="openDrawer('${app.id}')"`;
        return `<tr class="${rowClass}" ${rowAction}>
            ${_vagasSelecting ? `<td onclick="event.stopPropagation()" style="width:36px;padding-right:4px">
                <input type="checkbox" class="vagas-row-check" ${isSelected ? 'checked' : ''} onchange="toggleVagasSelect('${app.id}')" aria-label="Selecionar ${esc(app.empresa||'vaga')}">
            </td>` : ''}
            <td>
                <div>
                    <div style="font-size:0.82rem;font-weight:500">${empresa}</div>
                    ${vaga ? `<div style="font-size:0.72rem;color:var(--text-soft)">${vaga}</div>` : ''}
                    ${tagBadges ? `<div style="margin-top:3px">${tagBadges}</div>` : ''}
                    ${metaMobile ? `<div class="vaga-meta-mobile">${metaMobile}</div>` : ''}
                </div>
            </td>
            <td class="col-gestor" style="font-size:0.75rem;color:var(--text-soft)">${gestor}</td>
            <td class="col-date" style="font-size:0.72rem;color:var(--text-dim)">${dt}</td>
            <td class="col-cadastrado" style="font-size:0.72rem;color:var(--text-dim)">${dtCadastro}</td>
            <td><span class="stage-badge status-${status}">${stage}</span></td>
        </tr>`;
    }).join('');
    _updateVagasSelectAll();
}

function setVagasFilter(filter, btn) {
    _vagasFilter = filter;
    document.querySelectorAll('#vagasFilters .vagas-filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderApplicationsTable();
    _updateVagasFilterBadge();
}
function setVagasModalidadeFilter(filter, btn) {
    _vagasModalidadeFilter = filter;
    document.querySelectorAll('#vagasFiltersModalidade .vagas-filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderApplicationsTable();
    _updateVagasFilterBadge();
}
function setVagasTipoFilter(filter, btn) {
    _vagasTipoFilter = filter;
    document.querySelectorAll('#vagasFiltersTipo .vagas-filter-chip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderApplicationsTable();
    _updateVagasFilterBadge();
}
function toggleVagasFilters() {
    _vagasFiltersOpen = !_vagasFiltersOpen;
    document.getElementById('vagasFiltersPanel')?.classList.toggle('collapsed', !_vagasFiltersOpen);
    const ch = document.getElementById('vagasFiltersChevron');
    if (ch) ch.style.transform = _vagasFiltersOpen ? '' : 'rotate(180deg)';
}
function _updateVagasFilterBadge() {
    let n = 0;
    if (_vagasFilter           !== 'all') n++;
    if (_vagasModalidadeFilter !== 'all') n++;
    if (_vagasTipoFilter       !== 'all') n++;
    const badge = document.getElementById('vagasFiltersBadge');
    if (badge) { badge.textContent = n; badge.style.display = n ? 'inline-flex' : 'none'; }
}

function sortVagas(col) {
    if (_vagasSort.col === col) {
        _vagasSort.dir = _vagasSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        _vagasSort.col = col;
        _vagasSort.dir = col === 'empresa' ? 'asc' : 'desc';
    }
    // Sincronizar chips
    document.querySelectorAll('.vagas-sort-chip').forEach(c => c.classList.remove('active'));
    const chip = document.getElementById(`sort-chip-${col}`);
    if (chip) chip.classList.add('active');
    renderApplicationsTable();
}
function sortVagasChip(col, btn) {
    sortVagas(col);
}

function toggleVagasSelectMode() {
    _vagasSelecting = !_vagasSelecting;
    _vagasSelected.clear();
    const btn = document.getElementById('vagasSelectBtn');
    if (btn) btn.classList.toggle('active', _vagasSelecting);
    const th = document.getElementById('vagasSelectAllTh');
    if (th) th.style.display = _vagasSelecting ? '' : 'none';
    const sortBar = document.querySelector('.vagas-sort-bar');
    if (sortBar) sortBar.style.paddingLeft = _vagasSelecting ? '44px' : '';
    const all = document.getElementById('vagasSelectAll');
    if (all) { all.checked = false; all.indeterminate = false; }
    renderApplicationsTable();
    _renderBulkBar();
}

function toggleSelectAllVagas(checkbox) {
    const visibleIds = _filteredApplications.map(a => a.id);
    if (checkbox.checked) visibleIds.forEach(id => _vagasSelected.add(id));
    else visibleIds.forEach(id => _vagasSelected.delete(id));
    renderApplicationsTable();
    _renderBulkBar();
}

function _updateVagasSelectAll() {
    const all = document.getElementById('vagasSelectAll');
    if (!all || !_vagasSelecting) return;
    const visibleIds = _filteredApplications.map(a => a.id);
    const selectedVisible = visibleIds.filter(id => _vagasSelected.has(id));
    all.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
    all.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
}

function toggleVagasSelect(id) {
    if (_vagasSelected.has(id)) {
        _vagasSelected.delete(id);
    } else {
        _vagasSelected.add(id);
    }
    renderApplicationsTable();
    _renderBulkBar();
}

function _renderBulkBar() {
    let bar = document.getElementById('vagas-bulk-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'vagas-bulk-bar';
        document.body.appendChild(bar);
    }
    if (!_vagasSelecting || _vagasSelected.size === 0) {
        bar.style.display = 'none';
        return;
    }
    const n = _vagasSelected.size;
    bar.style.display = 'flex';
    bar.innerHTML = `
        <span style="font-size:0.8rem;color:var(--text-soft);margin-right:4px">${n} selecionada${n > 1 ? 's' : ''}</span>
        <button class="btn btn-sm" onclick="bulkArchive(true)"><i class="fa-solid fa-box-archive"></i> Arquivar</button>
        <button class="btn btn-sm" onclick="bulkArchive(false)"><i class="fa-solid fa-box-open"></i> Desarquivar</button>
        <button class="btn btn-danger btn-sm" onclick="bulkDelete()"><i class="fa-solid fa-trash"></i> Excluir</button>
        <button class="btn btn-sm" onclick="toggleVagasSelectMode()" style="margin-left:auto">Cancelar</button>
    `;
}

async function bulkArchive(archive) {
    const ids = [..._vagasSelected];
    let count = 0;
    for (const id of ids) {
        const app = _applications.find(a => a.id === id);
        if (app && app.archived !== archive) {
            try {
                const updated = await api('PUT', `/api/admin/applications?id=${id}`, { archived: archive });
                const idx = _applications.findIndex(a => a.id === id);
                if (idx !== -1) _applications[idx] = updated;
                count++;
            } catch (_) {}
        }
    }
    toggleVagasSelectMode();
    renderApplicationsTable();
    showToast(`${count} candidatura${count !== 1 ? 's' : ''} ${archive ? 'arquivada' : 'desarquivada'}${count !== 1 ? 's' : ''}.`);
}

async function bulkDelete() {
    const n = _vagasSelected.size;
    if (!await showConfirm(`Deletar ${n} candidatura${n > 1 ? 's' : ''}?`, 'Esta ação não pode ser desfeita.', { okText: 'Deletar' })) return;
    const ids = [..._vagasSelected];
    for (const id of ids) {
        try {
            await api('DELETE', `/api/admin/applications?id=${id}`);
            _applications = _applications.filter(a => a.id !== id);
        } catch (_) {}
    }
    closeDrawer();
    toggleVagasSelectMode();
    renderApplicationsTable();
    showToast(`${ids.length} candidatura${ids.length !== 1 ? 's' : ''} removida${ids.length !== 1 ? 's' : ''}.`);
}

function clearVagasSearch() {
    const el = document.getElementById('vagasSearch');
    if (el) el.value = '';
    renderApplicationsTable();
}
function clearVagasDate() {
    const from = document.getElementById('vagasDateFrom');
    const to   = document.getElementById('vagasDateTo');
    if (from) from.value = '';
    if (to)   to.value   = '';
    renderApplicationsTable();
}

function exportCSV() {
    if (!_filteredApplications.length) {
        showToast('Nenhuma candidatura para exportar.', 'error');
        return;
    }
    const headers = [
        'Empresa', 'Vaga', 'Modalidade', 'Tipo', 'Gestor', 'Email Gestor',
        'Data Envio', 'Resultado', 'Etapa Atual', 'Observações', 'Fonte', 'Arquivada'
    ];
    function csvCell(val) {
        const s = String(val == null ? '' : val);
        if (s.includes('"') || s.includes(',') || s.includes('\n')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }
    const rows = _filteredApplications.map(app => [
        app.empresa          || '',
        app.vaga             || '',
        app.modalidade       || '',
        app.tipo_contratacao || '',
        app.gestor_nome      || '',
        app.gestor_email     || '',
        app.data_envio ? app.data_envio.slice(0, 10) : '',
        app.result           || 'em_processo',
        getAppCurrentStageName(app),
        app.observacoes      || '',
        app.source           || '',
        app.archived ? 'Sim' : 'Não',
    ].map(csvCell).join(','));

    const bom  = '﻿';
    const csv  = bom + [headers.map(csvCell).join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `candidaturas-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exportando ${_filteredApplications.length} candidatura(s).`);
}

function openDrawer(id) {
    _openAppId = id;
    const app = _applications.find(a => a.id === id);
    if (!app) return;

    document.getElementById('drawerEmpresa').textContent = app.empresa || '—';
    document.getElementById('drawerVaga').textContent    = app.vaga || '';
    const srcBadge = app.source === 'cv_send'
        ? '<span class="vaga-source-badge email"><i class="fa-solid fa-envelope"></i> via email</span>'
        : '<span class="vaga-source-badge manual"><i class="fa-solid fa-pen"></i> manual</span>';
    const dt = app.data_envio ? fmtDate(app.data_envio) : '—';
    const archivedBadge = app.archived ? ' · <span class="vaga-source-badge" style="opacity:0.7"><i class="fa-solid fa-box-archive"></i> arquivada</span>' : '';
    document.getElementById('drawerMeta').innerHTML = `${dt} · ${srcBadge}${archivedBadge}`;

    renderDrawerBody(app);

    document.getElementById('vagasDrawer').classList.add('open');
    document.getElementById('vagasOverlay').classList.add('open');
    renderApplicationsTable();
}

function closeDrawer() {
    _openAppId = null;
    document.getElementById('vagasDrawer').classList.remove('open');
    document.getElementById('vagasOverlay').classList.remove('open');
    renderApplicationsTable();
}

function renderDrawerBody(app) {
    const body = document.getElementById('drawerBody');

    const recruiterRows = [];
    if (app.gestor_nome) {
        recruiterRows.push(`<div class="dinfo-row"><i class="fa-solid fa-user dinfo-icon"></i>${esc(app.gestor_nome)}</div>`);
    }
    if (app.gestor_email) {
        recruiterRows.push(`<div class="dinfo-row"><i class="fa-solid fa-envelope dinfo-icon"></i><a href="mailto:${esc(app.gestor_email)}" class="dinfo-link">${esc(app.gestor_email)}</a></div>`);
    }
    if (app.gestor_phone) {
        const phone = app.gestor_phone.replace(/\D/g, '');
        recruiterRows.push(`<div class="dinfo-row"><i class="fa-brands fa-whatsapp dinfo-icon" style="color:#25d366"></i><a href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener" class="dinfo-link">${esc(app.gestor_phone)}</a></div>`);
    }

    const chips = [
        app.linkedin_empresa ? `<a href="${esc(app.linkedin_empresa)}" target="_blank" rel="noopener" class="dinfo-chip"><i class="fa-brands fa-linkedin"></i> LinkedIn</a>` : '',
        app.link_vaga        ? `<a href="${esc(app.link_vaga)}" target="_blank" rel="noopener" class="dinfo-chip"><i class="fa-solid fa-link"></i> Vaga</a>` : '',
        app.modalidade       ? `<span class="dinfo-chip"><i class="fa-solid fa-map-pin"></i> ${esc(app.modalidade)}</span>` : '',
        app.tipo_contratacao ? `<span class="dinfo-chip"><i class="fa-solid fa-file-contract"></i> ${esc(app.tipo_contratacao)}</span>` : '',
    ].filter(Boolean);

    const hasRecruiter = recruiterRows.length > 0;
    const hasChips     = chips.length > 0;
    const hasObs       = !!app.observacoes;
    const hasCv        = !!app.cv_versions;

    const cvSection = hasCv ? `
        <div class="dinfo-section">
            <div class="dinfo-label">Currículo enviado</div>
            <div class="dinfo-row" style="display:flex;align-items:center;gap:8px">
                <i class="fa-solid fa-file-pdf dinfo-icon" style="color:#f87171"></i>
                <span>${esc(app.cv_versions.name)}</span>
                <button class="btn btn-sm" style="padding:2px 8px;font-size:0.7rem"
                    onclick="previewCV('${app.cv_versions.id}','${esc(app.cv_versions.name)}')" title="Pré-visualizar">
                    <i class="fa-solid fa-eye"></i>
                </button>
            </div>
        </div>` : '';

    const recruiterSection = hasRecruiter || hasChips ? `
        <div class="dinfo-section">
            <div class="dinfo-label">Recrutador</div>
            ${recruiterRows.join('')}
            ${hasChips ? `<div class="dinfo-chips">${chips.join('')}</div>` : ''}
        </div>` : '';

    const obsSection = hasObs ? `
        <div class="dinfo-section">
            <div class="dinfo-label">Observações</div>
            <div class="dinfo-obs">${esc(app.observacoes)}</div>
        </div>` : '';

    const syncTs = app.last_synced_at ? new Date(app.last_synced_at).toLocaleString('pt-BR') : null;
    const syncSection = app.platform ? `
        <div class="dinfo-section" style="padding:8px 10px;background:rgba(34,211,238,0.04);border:1px solid rgba(34,211,238,0.12);border-radius:6px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <div style="font-size:0.78rem;color:var(--text-soft)">
                    <i class="fa-solid fa-rotate" style="color:var(--cyan);margin-right:4px"></i>
                    ${app.platform ? `<span style="text-transform:capitalize">${esc(app.platform)}</span>` : ''}
                    ${app.external_status ? `<span style="margin-left:6px;color:var(--text-dim)">${esc(app.external_status)}</span>` : ''}
                    ${app.sync_error ? `<span style="color:#f87171;margin-left:6px" title="${esc(app.sync_error)}"><i class="fa-solid fa-triangle-exclamation"></i></span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:6px">
                    ${syncTs ? `<span style="font-size:0.7rem;color:var(--text-dim)">${syncTs}</span>` : ''}
                    <button class="btn btn-sm" style="padding:3px 8px;font-size:0.72rem" onclick="syncAppStatus('${app.id}')" title="Verificar status agora na plataforma">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                </div>
            </div>
        </div>` : '';

    body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
            ${cvSection}
            ${recruiterSection}
            ${obsSection}
            ${syncSection}
        </div>

        <div>
            <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:10px">Resultado</div>
            <div class="result-segmented" id="drawerResult">${renderResultSegmented(app)}</div>
        </div>

        <div>
            <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:10px">Processo seletivo</div>
            <div class="stage-timeline" id="drawerTimeline">
                ${renderTimeline(app.stages || [])}
            </div>
        </div>

        <div class="drawer-actions">
            ${(app.application_message_text && !app.application_message_sent && app.link_vaga) ? `<button class="btn btn-cyan btn-sm" onclick="applyNow('${app.id}')" title="Copiar mensagem, abrir vaga e marcar como enviada"><i class="fa-solid fa-rocket"></i> Aplicar agora</button>` : ''}
            <button class="btn btn-sm" onclick="openEditVaga('${app.id}')"><i class="fa-solid fa-pen"></i> Editar vaga</button>
            <button class="btn btn-sm" onclick="toggleStageManager('${app.id}')"><i class="fa-solid fa-gear"></i> Gerenciar etapas</button>
            <button class="btn btn-sm" onclick="openCalcModal()" title="Comparar CLT vs PJ vs MEI"><i class="fa-solid fa-calculator"></i> Calculadora</button>
            <button class="btn btn-sm" onclick="startVoiceMemo('${app.id}')" title="Adicionar nota por voz (Web Speech API)"><i class="fa-solid fa-microphone"></i></button>
            ${(app.result !== 'em_processo' || app.archived) ? `<button class="btn btn-sm" onclick="reopenInRadar('${app.id}')" title="Reabrir esta vaga no Radar para nova avaliação"><i class="fa-solid fa-arrow-rotate-left"></i> Voltar para Radar</button>` : ''}
            <button class="btn btn-sm" onclick="openInterviewPanel('${app.id}')" title="Sessões de entrevista e análise de IA"><i class="fa-solid fa-comments"></i> Entrevistas</button>
            <button class="btn btn-sm" onclick="openBriefing('${app.id}')" title="Briefing pré-entrevista: dados consolidados da candidatura e vaga"><i class="fa-solid fa-file-lines"></i> Briefing</button>
            <button class="btn btn-sm" onclick="openContextNotes('${app.id}')" title="Notas de contexto — insights sobre esta candidatura"><i class="fa-solid fa-note-sticky"></i></button>
            <button class="btn btn-sm" onclick="openEmailThreads('${app.id}')" title="E-mails vinculados a esta candidatura"><i class="fa-solid fa-envelope"></i> E-mails</button>
            <button class="btn btn-sm" onclick="openMessageTimeline('${app.id}')" title="Timeline de mensagens desta candidatura"><i class="fa-solid fa-timeline"></i> Mensagens</button>
            <button class="btn btn-sm${app.private ? ' active' : ''}" onclick="toggleAppPrivate('${app.id}', ${!app.private})" title="${app.private ? 'Candidatura privada — clique para tornar pública' : 'Tornar privada (modo stealth)'}" style="${app.private ? 'border-color:var(--cyan);color:var(--cyan)' : 'opacity:0.7'}"><i class="fa-solid fa-${app.private ? 'eye-slash' : 'eye'}"></i></button>
            <button class="btn btn-sm" style="padding:6px 10px;opacity:0.7" title="${app.archived ? 'Desarquivar candidatura' : 'Arquivar candidatura'}"
                onclick="toggleArchive('${app.id}', ${app.archived})"><i class="fa-solid fa-${app.archived ? 'box-open' : 'box-archive'}"></i></button>
            <button class="btn btn-danger btn-sm" style="padding:6px 10px" title="Deletar candidatura"
                onclick="deleteApplication('${app.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>

        <div id="stageManagerSection" hidden></div>
        <div id="editVagaSection" hidden></div>
        <div id="interviewSection" hidden></div>
        <div id="contextNotesSection" hidden></div>
        <div id="emailThreadsSection" hidden></div>
        <div id="briefingSection" hidden></div>
        <div id="messagesSection" hidden></div>
    `;
}

function renderTimeline(stages) {
    const visible = stages.filter(s => s.active !== false);
    return visible.map((s, i) => {
        const isLast = i === visible.length - 1;
        const st = stageStatus(s);
        let circleClass, lineClass, labelClass, content = '';

        if (st === 'done') {
            circleClass = 'done'; lineClass = 'done'; labelClass = 'done';
            content = '<i class="fa-solid fa-check" style="font-size:0.55rem"></i>';
        } else if (st === 'rejected') {
            circleClass = 'rejected'; lineClass = 'other'; labelClass = 'rejected';
            content = '<i class="fa-solid fa-xmark" style="font-size:0.55rem"></i>';
        } else if (st === 'running') {
            circleClass = 'current'; lineClass = 'current'; labelClass = 'current';
        } else {
            circleClass = 'pending'; lineClass = 'other'; labelClass = 'pending';
        }

        return `<div class="stage-row">
            <div class="stage-icon-col">
                <div class="stage-circle ${circleClass}">${content}</div>
                ${!isLast ? `<div class="stage-line ${lineClass}"></div>` : ''}
            </div>
            <div class="stage-label ${labelClass}">${esc(normalizeStageName(s.name))}</div>
        </div>`;
    }).join('');
}

async function applyNow(id) {
    const app = _applications.find(a => a.id === id);
    if (!app) return;

    // 1. Copy message to clipboard
    if (app.application_message_text) {
        try { await navigator.clipboard.writeText(app.application_message_text); } catch { /* ignore */ }
    }

    // 2. Open link_vaga in new tab
    if (app.link_vaga) window.open(app.link_vaga, '_blank', 'noopener');

    // 3. Optimistically update UI + toast with undo
    const updated = await api('PUT', `/api/admin/applications?id=${id}`, { application_message_sent: true }).catch(() => null);
    const appUpdated = updated || { ...app, application_message_sent: true };
    const idx = _applications.findIndex(a => a.id === id);
    if (idx !== -1) _applications[idx] = appUpdated;
    renderDrawerBody(appUpdated);

    // 4. Toast with undo for 6s
    showToast('Mensagem copiada e vaga aberta. Enviada ✓', 'success', {
        label: 'Não enviei',
        callback: async () => {
            const rev = await api('PUT', `/api/admin/applications?id=${id}`, { application_message_sent: false }).catch(() => null);
            if (rev) {
                const i = _applications.findIndex(a => a.id === id);
                if (i !== -1) _applications[i] = rev;
                renderDrawerBody(rev);
            }
            showToast('Marcação desfeita.', 'info');
        },
    });
}

async function toggleArchive(id, currentlyArchived) {
    try {
        const updated = await api('PUT', `/api/admin/applications?id=${id}`, { archived: !currentlyArchived });
        const idx = _applications.findIndex(a => a.id === id);
        if (idx !== -1) _applications[idx] = updated;
        renderDrawerBody(updated);
        openDrawer(id);
        showToast(currentlyArchived ? 'Candidatura desarquivada.' : 'Candidatura arquivada.');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ─── N39 — Modo stealth ────────────────────────────────────────────────────
async function toggleAppPrivate(id, makePrivate) {
    try {
        const updated = await api('PUT', `/api/admin/applications?id=${id}`, { private: makePrivate });
        const idx = _applications.findIndex(a => a.id === id);
        if (idx !== -1) _applications[idx] = updated;
        renderDrawerBody(updated);
        openDrawer(id);
        showToast(makePrivate ? 'Candidatura marcada como privada.' : 'Candidatura agora visível na lista.','success');
    } catch (e) { showToast(e.message, 'error'); }
}

// ─── N28 — Timeline de mensagens ───────────────────────────────────────────
const _channelIcons = { email:'fa-envelope', linkedin:'fa-linkedin', whatsapp:'fa-whatsapp', platform_chat:'fa-comment', phone_call:'fa-phone', manual:'fa-pen' };
const _channelColors = { email:'var(--text-soft)', linkedin:'#0a66c2', whatsapp:'#25d366', platform_chat:'var(--cyan)', phone_call:'#a78bfa', manual:'var(--text-dim)' };

async function openMessageTimeline(appId) {
    const sec = document.getElementById('messagesSection');
    if (!sec) return;
    if (!sec.hidden && sec.dataset.appId === appId) { sec.hidden = true; return; }
    sec.dataset.appId = appId;
    sec.hidden = false;
    sec.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:16px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    try {
        const r = await apiFetch(`/api/admin/applications?__h=application-messages&application_id=${appId}`);
        const msgs = r.messages || [];
        const channelOpts = ['email','linkedin','whatsapp','platform_chat','phone_call','manual'].map(c => `<option value="${c}">${c}</option>`).join('');
        sec.innerHTML = `<div style="padding:12px;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <span style="font-size:0.82rem;font-weight:600;color:var(--text)"><i class="fa-solid fa-timeline" style="color:var(--cyan);margin-right:6px"></i> Mensagens (${msgs.length})</span>
                <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="_openAddMessageForm('${appId}')"><i class="fa-solid fa-plus"></i> Adicionar</button>
            </div>
            <div id="addMsgForm-${appId}" style="display:none;margin-bottom:10px;padding:10px;background:var(--bg-soft);border:1px solid var(--border);border-radius:6px">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                    <select id="msgChannel-${appId}" class="mock-input" style="padding:5px 8px;font-size:0.8rem">${channelOpts}</select>
                    <select id="msgDir-${appId}" class="mock-input" style="padding:5px 8px;font-size:0.8rem"><option value="inbound">Recebida</option><option value="outbound" selected>Enviada</option></select>
                </div>
                <input id="msgSubject-${appId}" class="mock-input" placeholder="Assunto (opcional)" style="margin-bottom:6px;font-size:0.8rem">
                <textarea id="msgBody-${appId}" class="mock-input" rows="3" placeholder="Conteúdo da mensagem…" style="resize:vertical;font-size:0.8rem;margin-bottom:6px"></textarea>
                <div style="display:flex;gap:6px;justify-content:flex-end">
                    <button class="btn btn-sm" onclick="document.getElementById('addMsgForm-${appId}').style.display='none'">Cancelar</button>
                    <button class="btn btn-cyan btn-sm" onclick="_saveMessage('${appId}')"><i class="fa-solid fa-check"></i> Salvar</button>
                </div>
            </div>
            ${msgs.length ? msgs.map(m => {
                const isIn = m.direction === 'inbound';
                const icon = _channelIcons[m.channel] || 'fa-message';
                const color = _channelColors[m.channel] || 'var(--text-dim)';
                const dt = new Date(m.message_at).toLocaleString('pt-BR', { day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit' });
                return `<div style="display:flex;gap:8px;margin-bottom:8px;${isIn?'':'flex-direction:row-reverse'}">
                    <div style="width:28px;height:28px;border-radius:50%;background:var(--bg-soft);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                        <i class="fa-${m.channel==='linkedin'?'brands':'solid'} ${icon}" style="font-size:0.75rem;color:${color}"></i>
                    </div>
                    <div style="flex:1;min-width:0;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:8px 10px;${isIn?'border-top-left-radius:2px':'border-top-right-radius:2px'}">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
                            <span style="font-size:0.72rem;color:var(--text-dim)">${isIn ? esc(m.sender_name||'Empresa') : 'Você'} · ${dt}</span>
                            <button class="btn btn-sm" style="padding:1px 5px;font-size:0.65rem;opacity:0.5" onclick="_deleteMessage('${m.id}','${appId}')"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        ${m.subject ? `<div style="font-size:0.78rem;font-weight:600;color:var(--text);margin-bottom:2px">${esc(m.subject)}</div>` : ''}
                        <div style="font-size:0.8rem;color:var(--text);white-space:pre-wrap;word-break:break-word">${esc(m.body||'')}</div>
                    </div>
                </div>`;
            }).join('') : '<div style="color:var(--text-dim);font-size:0.82rem;padding:8px 0">Nenhuma mensagem registrada.</div>'}
        </div>`;
    } catch(e) { sec.innerHTML = `<div style="color:var(--danger);padding:12px;font-size:0.8rem">${esc(e.message)}</div>`; }
}

function _openAddMessageForm(appId) {
    const f = document.getElementById(`addMsgForm-${appId}`);
    if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
}

async function _saveMessage(appId) {
    const channel = document.getElementById(`msgChannel-${appId}`)?.value;
    const direction = document.getElementById(`msgDir-${appId}`)?.value || 'outbound';
    const subject = document.getElementById(`msgSubject-${appId}`)?.value.trim() || null;
    const body = document.getElementById(`msgBody-${appId}`)?.value.trim() || null;
    if (!body) { showToast('Conteúdo obrigatório.','error'); return; }
    try {
        await apiFetch('/api/admin/applications?__h=application-messages', {
            method: 'POST',
            body: JSON.stringify({ application_id: appId, channel, direction, subject, body })
        });
        showToast('Mensagem adicionada.','success');
        openMessageTimeline(appId);
    } catch(e) { showToast(e.message,'error'); }
}

async function _deleteMessage(msgId, appId) {
    if (!confirm('Remover mensagem?')) return;
    try {
        await apiFetch(`/api/admin/applications?__h=application-messages&id=${msgId}`, { method:'DELETE' });
        openMessageTimeline(appId);
    } catch(e) { showToast(e.message,'error'); }
}

async function deleteApplication(id) {
    if (!await showConfirm('Deletar candidatura?', 'Esta ação não pode ser desfeita.', { okText: 'Deletar' })) return;
    try {
        await api('DELETE', `/api/admin/applications?id=${id}`);
        closeDrawer();
        await loadApplications();
        showToast('Candidatura removida.');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

const DEFAULT_STAGE_NAMES = [
    'Enviado', 'Triagem de CV', 'Entrevista RH', 'Teste Técnico',
    'Entrevista Técnica', 'Entrevista Coordenador', 'Proposta'
];

let _stageManagerOpen       = false;
let _dragUnlocked           = localStorage.getItem('admin_drag_unlocked') === 'true';
let _sortableInst           = null;
let _undoStack              = [];
let _redoStack              = [];
let _reorderModeSnapshot    = null;

function toggleStageManager(appId) {
    const section = document.getElementById('stageManagerSection');
    if (_stageManagerOpen) {
        section.hidden = true;
        _stageManagerOpen = false;
        _sortableInst     = null;
        _undoStack        = [];
        _redoStack        = [];
        return;
    }
    // Fecha o form de edição se estiver aberto
    const editSection = document.getElementById('editVagaSection');
    if (editSection && !editSection.hidden) editSection.hidden = true;
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    renderStageManager(app);
    section.hidden = false;
    _stageManagerOpen = true;
}

function renderStageManager(app) {
    const section = document.getElementById('stageManagerSection');
    const rows = app.stages.map((s, i) => {
        const st = stageStatus(s);
        const stBtn = (v, icon, title) => {
            const active = st === v ? ` active st-${v}` : '';
            const disabled = !s.active ? ' disabled' : '';
            return `<button class="sm-status-btn${active}" title="${title}"${disabled}
                onclick="setStageStatus('${app.id}',${i},'${v}')">
                <i class="fa-${v === 'pending' ? 'regular' : 'solid'} fa-${icon}"></i>
            </button>`;
        };
        return `
        <div class="stage-manager-row${!s.active ? ' inactive' : ''}${_dragUnlocked ? ' drag-active' : ''}">
            <span class="drag-handle"><i class="fa-solid fa-grip-vertical"></i></span>
            <span class="stage-toggle${s.active ? ' active' : ''}"
                  title="${s.active ? 'Ativa — clique para ocultar' : 'Oculta — clique para ativar'}"
                  onclick="toggleStageActive('${app.id}',${i})">
                <i class="fa-solid fa-${s.active ? 'toggle-on' : 'toggle-off'}"></i>
            </span>
            <input class="stage-name-input" value="${esc(s.name)}" maxlength="80"
                   onblur="renameStage('${app.id}',${i},this.value)"
                   onkeydown="if(event.key==='Enter')this.blur()">
            <span class="sm-status-btns">
                ${stBtn('pending',  'circle',      'Não iniciado')}
                ${stBtn('running',  'circle-dot',  'Executando')}
                ${stBtn('done',     'check',       'Aprovado')}
                ${stBtn('rejected', 'xmark',       'Reprovado')}
            </span>
        </div>`;
    }).join('');

    section.innerHTML = `
        <div style="border-top:1px solid var(--border-soft);padding-top:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:6px">
                <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);flex-shrink:0">Gerenciar etapas</div>
                <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
                    <button class="sm-hist-btn" id="smUndoBtn" title="Desfazer reordenamento"
                            disabled onclick="undoReorder('${app.id}')">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                    <button class="sm-hist-btn" id="smRedoBtn" title="Refazer reordenamento"
                            disabled onclick="redoReorder('${app.id}')">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                    <button class="sm-reorder-btn${_dragUnlocked ? ' unlocked' : ''}" id="smReorderBtn"
                            onclick="toggleDragMode('${app.id}')">
                        <i class="fa-solid fa-${_dragUnlocked ? 'lock-open' : 'lock'}"></i>
                        ${_dragUnlocked ? 'Concluir' : 'Reordenar'}
                    </button>
                    <button class="sm-cancel-btn" id="smCancelBtn"
                            title="Cancelar — desfaz todas as mudanças desta sessão"
                            onclick="cancelDragMode('${app.id}')">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="stage-manager" id="stageManagerList">${rows}</div>
            <button class="btn btn-sm" id="smAddStageBtn" style="margin-top:8px;width:100%"
                    onclick="addCustomStage('${app.id}')"
                    ${_dragUnlocked ? 'disabled' : ''}>
                <i class="fa-solid fa-plus"></i> Adicionar etapa
            </button>
            <button class="sm-reset-link${_dragUnlocked ? ' visible' : ''}" id="smResetLink"
                    onclick="resetStageOrder('${app.id}')">
                ↺ Restaurar ordem padrão
            </button>
        </div>
    `;
    initSortable(app.id);
}

function initSortable(appId) {
    const el = document.getElementById('stageManagerList');
    if (!el) return;
    _sortableInst = Sortable.create(el, {
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        disabled: !_dragUnlocked,
        onEnd: async (evt) => {
            if (evt.oldIndex === evt.newIndex) return;
            const app = _applications.find(a => a.id === appId);
            if (!app) return;
            const snapshot = app.stages.map(s => ({
                name: s.name, status: stageStatus(s), active: s.active !== false
            }));
            const reordered = [...app.stages];
            const [moved] = reordered.splice(evt.oldIndex, 1);
            reordered.splice(evt.newIndex, 0, moved);
            const next = reordered.map(s => ({
                name: s.name, status: stageStatus(s), active: s.active !== false
            }));
            _sortableInst?.option('disabled', true);
            try {
                _undoStack.push(snapshot);
                _redoStack = [];
                await patchStages(appId, next);
                if (_dragUnlocked) _applyDragMode(true);
                showToast('Etapa reordenada');
            } catch (e) {
                _undoStack.pop();
                showToast(e.message, 'error');
                if (_dragUnlocked) _sortableInst?.option('disabled', false);
            }
        }
    });
}

function toggleDragMode(appId) {
    if (!_dragUnlocked) {
        // Entrando no modo reordenação — salva snapshot para cancelar depois
        const app = _applications.find(a => a.id === appId);
        if (app) _reorderModeSnapshot = app.stages.map(s => ({
            name: s.name, status: stageStatus(s), active: s.active !== false
        }));
        _undoStack = [];
        _redoStack = [];
    } else {
        // Concluindo — descarta snapshot e histórico
        _reorderModeSnapshot = null;
        _undoStack = [];
        _redoStack = [];
    }
    _dragUnlocked = !_dragUnlocked;
    localStorage.setItem('admin_drag_unlocked', _dragUnlocked);
    _applyDragMode(_dragUnlocked);
}

async function cancelDragMode(appId) {
    const snapshot = _reorderModeSnapshot;
    _reorderModeSnapshot = null;
    _undoStack = [];
    _redoStack = [];
    _dragUnlocked = false;
    localStorage.setItem('admin_drag_unlocked', false);
    if (snapshot) {
        const app = _applications.find(a => a.id === appId);
        const changed = app?.stages.map(s => s.name).join(',') !== snapshot.map(s => s.name).join(',');
        if (changed) {
            try {
                await patchStages(appId, snapshot);
                showToast('Reordenamento cancelado');
            } catch (e) { showToast(e.message, 'error'); return; }
        }
    }
    _applyDragMode(false);
}

function _applyDragMode(enabled) {
    _sortableInst?.option('disabled', !enabled);
    document.querySelectorAll('#stageManagerList .stage-manager-row')
            .forEach(r => r.classList.toggle('drag-active', enabled));
    const btn       = document.getElementById('smReorderBtn');
    const resetLnk  = document.getElementById('smResetLink');
    const undoBtn   = document.getElementById('smUndoBtn');
    const redoBtn   = document.getElementById('smRedoBtn');
    const cancelBtn = document.getElementById('smCancelBtn');
    const addBtn    = document.getElementById('smAddStageBtn');
    if (btn) {
        btn.classList.toggle('unlocked', enabled);
        btn.innerHTML = `<i class="fa-solid fa-${enabled ? 'lock-open' : 'lock'}"></i> ${enabled ? 'Concluir' : 'Reordenar'}`;
    }
    if (resetLnk) resetLnk.classList.toggle('visible', enabled);
    if (undoBtn)   { undoBtn.style.display = enabled ? 'flex' : 'none'; undoBtn.disabled = _undoStack.length === 0; }
    if (redoBtn)   { redoBtn.style.display = enabled ? 'flex' : 'none'; redoBtn.disabled = _redoStack.length === 0; }
    if (cancelBtn) cancelBtn.style.display = enabled ? 'flex' : 'none';
    if (addBtn)    addBtn.disabled = enabled;
}

async function undoReorder(appId) {
    if (_undoStack.length === 0) return;
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const current = app.stages.map(s => ({ name: s.name, status: stageStatus(s), active: s.active !== false }));
    const prev = _undoStack.pop();
    _redoStack.push(current);
    try {
        await patchStages(appId, prev);
        if (_dragUnlocked) _applyDragMode(true);
        showToast('Reordenamento desfeito');
    } catch (e) {
        _undoStack.push(prev);
        _redoStack.pop();
        showToast(e.message, 'error');
    }
}

async function redoReorder(appId) {
    if (_redoStack.length === 0) return;
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const current = app.stages.map(s => ({ name: s.name, status: stageStatus(s), active: s.active !== false }));
    const next = _redoStack.pop();
    _undoStack.push(current);
    try {
        await patchStages(appId, next);
        if (_dragUnlocked) _applyDragMode(true);
        showToast('Reordenamento refeito');
    } catch (e) {
        _redoStack.push(next);
        _undoStack.pop();
        showToast(e.message, 'error');
    }
}

async function resetStageOrder(appId) {
    if (!await showConfirm('Restaurar ordem das etapas?', 'Etapas personalizadas irão para o final da lista.', { okText: 'Restaurar', danger: false })) return;
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const sorted = [...app.stages].sort((a, b) => {
        const ia = DEFAULT_STAGE_NAMES.indexOf(a.name);
        const ib = DEFAULT_STAGE_NAMES.indexOf(b.name);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });
    const normalized = sorted.map(s => ({
        name: s.name, status: stageStatus(s), active: s.active !== false
    }));
    try {
        await patchStages(appId, normalized);
        if (_dragUnlocked) _applyDragMode(true);
        showToast('Ordem restaurada');
    } catch (e) { showToast(e.message, 'error'); }
}

async function patchStages(appId, stages) {
    const updated = await api('PUT', `/api/admin/applications?id=${appId}`, { stages });
    const idx = _applications.findIndex(a => a.id === appId);
    if (idx !== -1) _applications[idx] = updated;
    // Atualiza timeline in place (preserva scroll do drawer)
    const timeline = document.getElementById('drawerTimeline');
    if (timeline) timeline.innerHTML = renderTimeline(updated.stages || []);
    // Re-renderiza manager sem fechar/abrir (evita jump)
    if (_stageManagerOpen) renderStageManager(updated);
    renderApplicationsTable();
    return updated;
}

async function toggleStageActive(appId, stageIdx) {
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const prevResult = app.result || 'em_processo';
    const stages = app.stages.map((s, i) => {
        const nextActive = i === stageIdx ? !s.active : s.active !== false;
        const nextStatus = i === stageIdx ? 'pending' : stageStatus(s);
        return { name: s.name, status: nextStatus, active: nextActive };
    });
    try {
        await patchStages(appId, stages);
        await autoUpdateResult(appId, prevResult);
    } catch (e) { showToast(e.message, 'error'); }
}

async function renameStage(appId, stageIdx, newName) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const app = _applications.find(a => a.id === appId);
    if (!app || app.stages[stageIdx].name === trimmed) return;
    const stages = app.stages.map((s, i) => ({
        name: i === stageIdx ? trimmed : s.name,
        status: stageStatus(s),
        active: s.active !== false,
    }));
    try { await patchStages(appId, stages); } catch (e) { showToast(e.message, 'error'); }
}

function deriveResult(stages) {
    const active = stages.filter(s => s.active !== false);
    if (!active.length) return 'em_processo';
    if (active.some(s => stageStatus(s) === 'rejected')) return 'recusado';
    if (active.some(s => stageStatus(s) === 'running'))  return 'em_processo';
    if (active.every(s => stageStatus(s) === 'done'))    return 'aprovado';
    return 'em_processo';
}

async function autoUpdateResult(appId, prevResult) {
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const current = app.result || 'em_processo';
    const derived = deriveResult(app.stages);
    if (derived === current) return;
    try {
        const updated = await api('PUT', `/api/admin/applications?id=${appId}`, { result: derived });
        const idx = _applications.findIndex(a => a.id === appId);
        if (idx !== -1) _applications[idx] = updated;
        const seg = document.getElementById('drawerResult');
        if (seg) seg.innerHTML = renderResultSegmented(updated);
        renderApplicationsTable();
        const label  = derived === 'recusado' ? 'Vaga marcada como Recusada'
                     : derived === 'aprovado'  ? 'Vaga marcada como Aprovada'
                     : 'Status atualizado para Em Processo';
        const type   = derived === 'recusado' ? 'error'
                     : derived === 'aprovado'  ? 'success'
                     : 'info';
        showToast(label, type, {
            label: '↩ Desfazer',
            callback: async () => {
                try {
                    const rev = await api('PUT', `/api/admin/applications?id=${appId}`, { result: prevResult });
                    const i2 = _applications.findIndex(a => a.id === appId);
                    if (i2 !== -1) _applications[i2] = rev;
                    const s2 = document.getElementById('drawerResult');
                    if (s2) s2.innerHTML = renderResultSegmented(rev);
                    renderApplicationsTable();
                } catch (e) { showToast(e.message, 'error'); }
            }
        });
    } catch (e) { showToast(e.message, 'error'); }
}

async function setStageStatus(appId, stageIdx, status) {
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const prevResult = app.result || 'em_processo';
    // Atualiza apenas a etapa clicada — sem cascade nas demais
    const stages = app.stages.map((s, i) => i === stageIdx
        ? { name: s.name, status, active: s.active !== false }
        : { name: s.name, status: stageStatus(s), active: s.active !== false }
    );
    try {
        await patchStages(appId, stages);
        await autoUpdateResult(appId, prevResult);
    } catch (e) { showToast(e.message, 'error'); }
}

function renderResultSegmented(app) {
    const r = app.result || 'em_processo';
    const item = (val, icon, label) => `
        <button class="result-seg${r === val ? ` active r-${val}` : ''}"
                onclick="setAppResult('${app.id}','${val}')">
            <i class="fa-solid fa-${icon}"></i> ${label}
        </button>`;
    return item('em_processo', 'clock',        'Em processo')
         + item('aprovado',    'circle-check', 'Aprovado')
         + item('recusado',    'circle-xmark', 'Recusado');
}

async function setAppResult(appId, result) {
    const app = _applications.find(a => a.id === appId);
    if (result === 'aprovado' && app) {
        const active = (app.stages || []).filter(s => s.active !== false);
        const hasRunning  = active.some(s => stageStatus(s) === 'running');
        const hasRejected = active.some(s => stageStatus(s) === 'rejected');
        if (hasRunning || hasRejected) {
            const reason = hasRejected ? 'Há etapas reprovadas' : 'Há etapas em execução';
            showToast(`${reason} — não é possível aprovar.`, 'error');
            return;
        }
    }
    try {
        const updated = await api('PUT', `/api/admin/applications?id=${appId}`, { result });
        const idx = _applications.findIndex(a => a.id === appId);
        if (idx !== -1) _applications[idx] = updated;
        const seg = document.getElementById('drawerResult');
        if (seg) seg.innerHTML = renderResultSegmented(updated);
        renderApplicationsTable();
        if (result === 'aprovado') {
            openLinkedinUpdateModal(appId, updated.empresa, updated.vaga);
            // N35: sugerir manter rede aquecida com recrutadores de candidaturas avançadas
            setTimeout(() => showWarmNetworkSuggestions(appId), 4000);
        }
    } catch (e) { showToast(e.message, 'error'); }
}

async function addCustomStage(appId) {
    const name = await showPrompt('Nova etapa', 'Ex.: Entrevista com Diretor…');
    if (!name) return;
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    const normalized = app.stages.map(s => ({ name: s.name, status: stageStatus(s), active: s.active !== false }));
    const stages = [...normalized, { name: name.trim(), status: 'pending', active: true }];
    try { await patchStages(appId, stages); } catch (e) { showToast(e.message, 'error'); }
}

function vagaFormHTML(app) {
    const v = (field, max) => `value="${esc(app?.[field] || '')}" maxlength="${max}"`;
    const platforms = (window._platformSettings || []);
    const platformOptions = platforms.map(p =>
        `<option value="${esc(p.fonte)}" ${app?.platform === p.fonte ? 'selected' : ''}>${esc(p.display_name)}</option>`
    ).join('');
    const radarBadge = app?.origin_radar_id
        ? `<span class="radar-origin-badge"><i class="fa-solid fa-satellite-dish"></i> do Radar</span>`
        : '';
    const msgText = app?.application_message_text || '';
    const msgSent = app?.application_message_sent ? 'checked' : '';
    const currentPlatform = app?.platform || '';
    const charLimit = platforms.find(p => p.fonte === currentPlatform)?.char_limit ?? 0;
    const charCountClass = charLimit > 0 && msgText.length > charLimit ? 'vf-char-over' : '';
    const charDisplay = charLimit > 0 ? `${msgText.length}/${charLimit}` : `${msgText.length}`;

    return `
        <div style="border-top:1px solid var(--border-soft);padding-top:12px;display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;align-items:center;gap:8px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim)">
                ${app ? 'Editar candidatura' : 'Nova candidatura'} ${radarBadge}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Empresa *</label>
                    <input id="vfEmpresa" class="mock-input" placeholder="Nubank…" ${v('empresa',200)} autocomplete="off" data-form-type="other">
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Vaga</label>
                    <input id="vfVaga" class="mock-input" placeholder="Sr QA…" ${v('vaga',200)} autocomplete="off" data-form-type="other">
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">LinkedIn empresa</label>
                    <input id="vfLinkedin" class="mock-input" placeholder="linkedin.com/company/…" ${v('linkedin_empresa',300)} autocomplete="off" data-form-type="other">
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Link da vaga</label>
                    <input id="vfLinkVaga" class="mock-input" placeholder="linkedin.com/jobs/…" ${v('link_vaga',500)} autocomplete="off" data-form-type="other">
                </div>
            </div>
            <div class="form-group" style="margin:0">
                <label style="font-size:0.75rem">Observações</label>
                <textarea id="vfObs" class="mock-input" placeholder="headhunter, urgência…" maxlength="500" rows="2" autocomplete="off" data-form-type="other" style="resize:vertical;font-family:inherit;font-size:inherit">${esc(app?.observacoes || '')}</textarea>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Gestor (nome)</label>
                    <input id="vfGestorNome" class="mock-input" placeholder="Maria Silva" ${v('gestor_nome',100)} autocomplete="off" data-form-type="other">
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Gestor (email)</label>
                    <input id="vfGestorEmail" class="mock-input" placeholder="m.silva@empresa.com" ${v('gestor_email',120)} autocomplete="off" data-form-type="other">
                </div>
            </div>
            <div class="form-group" style="margin:0">
                <label style="font-size:0.75rem">WhatsApp do recrutador</label>
                <input id="vfGestorPhone" class="mock-input" placeholder="+55 44 99999-0000" value="${esc(app?.gestor_phone || '')}" maxlength="30" autocomplete="off" data-form-type="other">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Modalidade</label>
                    <select id="vfModalidade" class="mock-input">
                        <option value="">—</option>
                        <option value="Presencial" ${app?.modalidade === 'Presencial' ? 'selected' : ''}>Presencial</option>
                        <option value="Híbrida" ${app?.modalidade === 'Híbrida' ? 'selected' : ''}>Híbrida</option>
                        <option value="Remota" ${app?.modalidade === 'Remota' ? 'selected' : ''}>Remota</option>
                    </select>
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Tipo de contratação</label>
                    <select id="vfTipoContratacao" class="mock-input">
                        <option value="">—</option>
                        <option value="CLT" ${app?.tipo_contratacao === 'CLT' ? 'selected' : ''}>CLT</option>
                        <option value="PJ" ${app?.tipo_contratacao === 'PJ' ? 'selected' : ''}>PJ</option>
                        <option value="Freelancer" ${app?.tipo_contratacao === 'Freelancer' ? 'selected' : ''}>Freelancer</option>
                    </select>
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Plataforma</label>
                    <select id="vfPlatform" class="mock-input" onchange="onVfPlatformChange()">
                        <option value="">— Selecionar —</option>
                        ${platformOptions}
                    </select>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Data de envio</label>
                    <input id="vfDataEnvio" type="date" class="mock-input" value="${app?.data_envio ? app.data_envio.slice(0,10) : ''}" autocomplete="off">
                </div>
                <div class="form-group" style="margin:0">
                    <label style="font-size:0.75rem">Currículo enviado</label>
                    <select id="vfCvVersion" class="mock-input">
                        <option value="">— Nenhum —</option>
                    </select>
                </div>
            </div>

            <!-- ── Mensagem de candidatura ── -->
            <div class="vf-message-section" id="vfMessageSection">
                <div class="vf-message-header">
                    <label style="font-size:0.75rem;font-weight:600">Mensagem de candidatura</label>
                    <div style="display:flex;gap:6px;align-items:center">
                        <button class="btn btn-sm" id="vfGenerateBtn" onclick="generateApplicationMessage()" title="Gerar mensagem com IA">
                            <i class="fa-solid fa-wand-sparkles"></i> Gerar com IA
                        </button>
                        <button class="btn btn-sm" id="vfCopyMsgBtn" onclick="copyApplicationMessage()" title="Copiar mensagem" style="display:none">
                            <i class="fa-regular fa-copy"></i>
                        </button>
                    </div>
                </div>
                <div class="vf-message-wrap">
                    <textarea id="vfMessageText" class="mock-input vf-message-textarea" rows="5"
                        placeholder="Escreva ou gere a mensagem de candidatura…"
                        maxlength="5000"
                        oninput="updateVfCharCount()"
                        autocomplete="off" data-form-type="other">${esc(msgText)}</textarea>
                    <div class="vf-char-count ${charCountClass}" id="vfCharCount">${charDisplay}</div>
                </div>
                <div id="vfMsgFieldHint" class="vf-platform-hint" style="display:none"></div>
                <label class="vf-sent-label">
                    <input type="checkbox" id="vfMsgSent" ${msgSent}> Mensagem já enviada
                </label>
            </div>

            <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;padding-top:4px">
                <button class="btn btn-sm" style="opacity:0.6;background:none;border:none;padding:6px 10px"
                    onclick="${app ? 'closeEditVaga()' : 'closeNovaVaga()'}">Cancelar</button>
                <button class="btn btn-cyan btn-sm" onclick="${app ? `saveEditVaga('${app.id}')` : 'saveNovaVaga()'}">
                    <i class="fa-solid fa-check"></i> ${app ? 'Salvar' : 'Criar candidatura'}
                </button>
            </div>
            <p id="vfMsg" hidden style="font-size:0.78rem"></p>
        </div>
    `;
}

function _populateCvSelect(app) {
    api('GET', '/api/admin/cv-versions?limit=100').then(cvs => {
        const sel = document.getElementById('vfCvVersion');
        if (!sel) return;
        while (sel.options.length > 1) sel.remove(1);
        cvs.forEach(cv => {
            const opt = new Option(`${cv.name}${cv.active ? '' : ' (inativo)'}`, cv.id);
            opt.selected = cv.id === (app?.cv_version_id || null);
            sel.add(opt);
        });
    }).catch(() => {});
}

// Carrega configurações de plataformas (chamado no init)
window._platformSettings = window._platformSettings || [];
async function loadPlatformSettings() {
    try {
        const data = await api('GET', '/api/admin/applications?__h=platform-settings');
        window._platformSettings = (data || []).filter(p => p.enabled !== false);
    } catch { window._platformSettings = []; }
}

// ─── ABA CONFIGURAR ──────────────────────────────────────────

async function loadConfigTab() {
    await Promise.all([renderPlatformSettingsTable(), renderQuickAnswersTable(), loadPipelineTemplate(), loadPlatformSessions(), loadLLMProviders(), loadVault(), loadWeeklyGoals(), loadStudyPlan(), loadSearchAlerts(), loadStarStories(), loadNotificationSettings(), loadValuesWeights()]);
}

// ─── HISTÓRIAS STAR (N6) ──────────────────────────────────────
async function loadStarStories(q) {
    const el = document.getElementById('starStoriesList');
    if (!el) return;
    try {
        const url = '/api/admin/applications?__h=star-stories' + (q ? '&q=' + encodeURIComponent(q) : '');
        const r = await apiFetch(url);
        const stories = r.stories ?? [];
        if (!stories.length) {
            el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhuma história cadastrada.</div>';
            return;
        }
        el.innerHTML = stories.map(s => {
            const comps = (s.competencies || []).map(c => `<span style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:1px 7px;font-size:0.7rem;color:var(--cyan)">${esc(c)}</span>`).join(' ');
            const themes = (s.themes || []).map(t => `<span style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:1px 7px;font-size:0.7rem;color:var(--text-soft)">${esc(t)}</span>`).join(' ');
            return `<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--bg-card)">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
                    <div style="font-weight:600;font-size:0.88rem;color:var(--text);margin-bottom:4px">${esc(s.title)}</div>
                    <div style="display:flex;gap:6px;flex-shrink:0">
                        <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="openStarForm('${s.id}')"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem;color:var(--danger)" onclick="deleteStarStory('${s.id}')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <div style="font-size:0.78rem;color:var(--text-soft);margin-bottom:6px;line-height:1.5">
                    <strong>S:</strong> ${esc((s.situation||'').slice(0,120))}${s.situation?.length>120?'…':''}<br>
                    <strong>R:</strong> ${esc((s.result||'').slice(0,120))}${s.result?.length>120?'…':''}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:4px">${comps}${themes}</div>
            </div>`;
        }).join('');
    } catch(e) {
        if (el) el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}

let _starData = {};
async function openStarForm(id) {
    document.getElementById('starId').value = id || '';
    const fields = ['starTitle','starSituation','starTask','starAction','starResult','starCompetencies','starThemes','starEmpresa','starImportance'];
    if (id) {
        try {
            const r = await apiFetch(`/api/admin/applications?__h=star-stories&id=${id}`);
            const s = r.stories?.[0] || r;
            document.getElementById('starTitle').value = s.title || '';
            document.getElementById('starSituation').value = s.situation || '';
            document.getElementById('starTask').value = s.task || '';
            document.getElementById('starAction').value = s.action || '';
            document.getElementById('starResult').value = s.result || '';
            document.getElementById('starCompetencies').value = (s.competencies||[]).join(', ');
            document.getElementById('starThemes').value = (s.themes||[]).join(', ');
            document.getElementById('starEmpresa').value = s.empresa_id || '';
            document.getElementById('starImportance').value = s.importance ?? 0.5;
        } catch(e) { showToast(e.message,'error'); return; }
    } else {
        fields.forEach(f => { const el = document.getElementById(f); if (el) el.value = f === 'starImportance' ? '0.5' : ''; });
    }
    document.getElementById('starForm').style.display = 'block';
    document.getElementById('starForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeStarForm() {
    document.getElementById('starForm').style.display = 'none';
}

async function saveStarStory() {
    const id = document.getElementById('starId').value;
    const body = {
        title: document.getElementById('starTitle').value.trim(),
        situation: document.getElementById('starSituation').value.trim(),
        task: document.getElementById('starTask').value.trim(),
        action: document.getElementById('starAction').value.trim(),
        result: document.getElementById('starResult').value.trim(),
        competencies: document.getElementById('starCompetencies').value.split(',').map(s=>s.trim()).filter(Boolean),
        themes: document.getElementById('starThemes').value.split(',').map(s=>s.trim()).filter(Boolean),
        empresa_id: document.getElementById('starEmpresa').value.trim() || null,
        importance: parseFloat(document.getElementById('starImportance').value) || 0.5
    };
    if (!body.title || !body.situation || !body.task || !body.action || !body.result) {
        showToast('Preencha todos os campos obrigatórios.','error'); return;
    }
    try {
        const method = id ? 'PUT' : 'POST';
        const url = '/api/admin/applications?__h=star-stories' + (id ? `&id=${id}` : '');
        await apiFetch(url, { method, body: JSON.stringify(body) });
        showToast(id ? 'História atualizada.' : 'História criada.');
        closeStarForm();
        loadStarStories();
    } catch(e) { showToast(e.message,'error'); }
}

async function deleteStarStory(id) {
    if (!confirm('Excluir esta história STAR?')) return;
    try {
        await apiFetch(`/api/admin/applications?__h=star-stories&id=${id}`, { method: 'DELETE' });
        showToast('História excluída.');
        loadStarStories();
    } catch(e) { showToast(e.message,'error'); }
}

// ─── PLANO DE ESTUDOS (N16) ──────────────────────────────────
async function loadStudyPlan() {
    const el = document.getElementById('studyPlanList');
    if (!el) return;
    try {
        const r = await apiFetch('/api/admin/applications?__h=study-plan');
        const items = r.items || [];
        if (!items.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhuma skill no plano. Adicione acima.</div>'; return; }
        const statusLabel = { planned:'Planejado', in_progress:'Em andamento', done:'Concluído', paused:'Pausado' };
        const statusColor = { planned:'var(--text-dim)', in_progress:'var(--cyan)', done:'#4ade80', paused:'#fb923c' };
        el.innerHTML = items.map(item => {
            const done = item.hours_completed || 0;
            const plan = item.hours_planned || 0;
            const pct  = plan > 0 ? Math.min(100, Math.round(done / plan * 100)) : 0;
            const color = pct >= 100 ? '#4ade80' : 'var(--cyan)';
            return `<div style="padding:8px 10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-soft)">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                    <div>
                        <span style="font-size:0.85rem;font-weight:600;color:var(--text)">${esc(item.skill)}</span>
                        ${item.demand_pct ? `<span style="font-size:0.7rem;color:var(--text-dim);margin-left:6px">${item.demand_pct}% das vagas</span>` : ''}
                    </div>
                    <span style="font-size:0.68rem;color:${statusColor[item.status]||'var(--text-dim)'};font-weight:600">${statusLabel[item.status]||item.status}</span>
                </div>
                ${plan > 0 ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:${color};border-radius:3px"></div>
                    </div>
                    <span style="font-size:0.72rem;color:var(--text-dim);white-space:nowrap">${done}h / ${plan}h</span>
                </div>` : ''}
                ${item.course_title ? `<div style="font-size:0.72rem;color:var(--text-dim)"><i class="fa-solid fa-play-circle" style="margin-right:3px"></i>${esc(item.course_title)}</div>` : ''}
                <div style="display:flex;gap:6px;margin-top:6px">
                    <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="logStudyHours('${item.id}')">+1h</button>
                    ${item.status !== 'done' ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="updateStudyStatus('${item.id}','done')"><i class="fa-solid fa-check"></i></button>` : ''}
                    <button class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="deleteStudyItem('${item.id}')"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
        }).join('');
    } catch(e) { el.innerHTML = `<div style="color:#f87171;font-size:0.82rem">${esc(e.message)}</div>`; }
}

function openStudyItemForm() {
    const form = document.getElementById('studyItemForm');
    if (form) { form.style.display = form.style.display === 'none' ? '' : 'none'; }
}
function closeStudyItemForm() {
    const form = document.getElementById('studyItemForm');
    if (form) form.style.display = 'none';
}
async function saveStudyItem() {
    const skill = document.getElementById('siSkill')?.value.trim();
    if (!skill) { showToast('Skill é obrigatório','error'); return; }
    const body = {
        skill,
        hours_planned: parseInt(document.getElementById('siHours')?.value)||null,
        course_url:    document.getElementById('siCourseUrl')?.value.trim()||null,
        course_title:  document.getElementById('siCourseTitle')?.value.trim()||null,
    };
    try {
        await apiFetch('/api/admin/applications?__h=study-plan', { method:'POST', body: JSON.stringify(body) });
        closeStudyItemForm();
        showToast('Skill adicionada ao plano','success');
        loadStudyPlan();
    } catch(e) { showToast(e.message,'error'); }
}
async function logStudyHours(id) {
    const h = parseFloat(prompt('Horas estudadas agora:', '1')) || 0;
    if (!h) return;
    try {
        await apiFetch('/api/admin/applications?__h=study-plan', { method:'POST', body: JSON.stringify({ study_plan_item_id: id, hours: h }) });
        showToast(`+${h}h registrado`,'success');
        loadStudyPlan();
    } catch(e) { showToast(e.message,'error'); }
}
async function updateStudyStatus(id, status) {
    try {
        await apiFetch(`/api/admin/applications?__h=study-plan&id=${id}`, { method:'PUT', body: JSON.stringify({ status }) });
        loadStudyPlan();
    } catch(e) { showToast(e.message,'error'); }
}
async function deleteStudyItem(id) {
    if (!confirm('Remover skill do plano?')) return;
    try {
        await apiFetch(`/api/admin/applications?__h=study-plan&id=${id}`, { method:'DELETE' });
        loadStudyPlan();
    } catch(e) { showToast(e.message,'error'); }
}

async function autoSuggestStudyPlan(btn) {
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analisando…';
    try {
        const r = await apiFetch('/api/admin/applications?__h=study-plan-autosuggest', { method: 'POST' });
        const msg = r.message || `${r.created} skills adicionadas, ${r.updated} atualizadas`;
        showToast(msg, 'success');
        if (r.created > 0 || r.updated > 0) loadStudyPlan();
    } catch(e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = orig; }
}

// ─── ALERTAS DE BUSCA (N17) ──────────────────────────────────
async function loadSearchAlerts() {
    const el = document.getElementById('searchAlertsList');
    if (!el) return;
    try {
        const r = await apiFetch('/api/admin/applications?__h=search-alerts');
        const alerts = r.alerts || [];
        if (!alerts.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhum alerta configurado.</div>'; return; }
        el.innerHTML = alerts.map(a => `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-soft)">
            <div style="flex:1;min-width:0">
                <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${esc(a.name)}</div>
                <div style="font-size:0.72rem;color:var(--text-dim)">${(a.keywords||[]).slice(0,4).join(', ')}${(a.keywords||[]).length>4?'…':''} · Fit ≥ ${a.min_fit_score||6}</div>
                <div style="font-size:0.7rem;color:var(--text-dim)">${(a.fontes||[]).join(', ')} · ${a.frequencia_horas||6}h ${a.last_run_at?'· Último: '+new Date(a.last_run_at).toLocaleString('pt-BR'):''}</div>
            </div>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:0.78rem">
                <input type="checkbox" ${a.active?'checked':''} onchange="toggleAlert('${a.id}',this.checked)"> Ativo
            </label>
            <button class="btn btn-sm" style="padding:3px 8px;font-size:0.72rem;color:var(--cyan)" onclick="runSearchAlert('${a.id}','${esc(a.name)}')" title="Buscar leads correspondentes agora"><i class="fa-solid fa-play"></i></button>
            <button class="btn btn-danger btn-sm" style="padding:3px 8px" onclick="deleteAlert('${a.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div id="alert-results-${a.id}" style="display:none;padding:6px 10px;font-size:0.78rem;color:var(--text-soft);border-top:1px solid var(--border)"></div>`).join('');
    } catch(e) { el.innerHTML = `<div style="color:#f87171;font-size:0.82rem">${esc(e.message)}</div>`; }
}

function openAlertForm() {
    const form = document.getElementById('alertForm');
    if (form) { form.style.display = form.style.display === 'none' ? '' : 'none'; }
}
function closeAlertForm() {
    const form = document.getElementById('alertForm');
    if (form) form.style.display = 'none';
}
async function saveAlert() {
    const name = document.getElementById('alName')?.value.trim();
    const kwStr = document.getElementById('alKeywords')?.value.trim();
    if (!name || !kwStr) { showToast('Nome e keywords são obrigatórios','error'); return; }
    const keywords = kwStr.split(',').map(k => k.trim()).filter(Boolean);
    const excludes = (document.getElementById('alExcludes')?.value||'').split(',').map(k=>k.trim()).filter(Boolean);
    const body = {
        name, keywords, excludes,
        fontes: ['gupy','linkedin','indeed'],
        min_fit_score: parseFloat(document.getElementById('alMinScore')?.value)||6,
        modalidade: document.getElementById('alModalidade')?.value||null,
        frequencia_horas: parseInt(document.getElementById('alFreq')?.value)||6,
    };
    try {
        await apiFetch('/api/admin/applications?__h=search-alerts', { method:'POST', body: JSON.stringify(body) });
        closeAlertForm();
        showToast('Alerta criado','success');
        loadSearchAlerts();
    } catch(e) { showToast(e.message,'error'); }
}
async function runSearchAlert(id, name) {
    const resDiv = document.getElementById(`alert-results-${id}`);
    if (!resDiv) return;
    resDiv.style.display = 'block';
    resDiv.innerHTML = '<span style="color:var(--text-dim)">Buscando...</span>';
    try {
        const r = await apiFetch(`/api/admin/applications?__h=search-alerts&id=${id}`, { method:'POST' });
        const leads = r.leads || [];
        if (!leads.length) {
            resDiv.innerHTML = '<span style="color:var(--text-dim)">Nenhum lead encontrado para este alerta.</span>';
            return;
        }
        resDiv.innerHTML = leads.map(l => {
            const score = l.fit_score != null ? `<span style="color:var(--cyan);font-weight:600">${parseFloat(l.fit_score).toFixed(1)}</span>` : '';
            return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
                <span style="flex:1;font-size:0.8rem">${esc(l.empresa||'')} — <em>${esc(l.vaga||'')}</em></span>
                ${score}
                <span style="font-size:0.7rem;color:var(--text-dim)">${l.modalidade||''}</span>
                <button class="btn btn-sm" style="padding:2px 7px;font-size:0.7rem" onclick="openLeadDetail('${l.id}')">Ver</button>
            </div>`;
        }).join('');
        showToast(`${leads.length} lead(s) encontrado(s) para "${name}"`,'success');
    } catch(e) {
        resDiv.innerHTML = `<span style="color:#f87171">${esc(e.message)}</span>`;
    }
}
async function toggleAlert(id, active) {
    try {
        await apiFetch(`/api/admin/applications?__h=search-alerts&id=${id}`, { method:'PUT', body: JSON.stringify({ active }) });
        showToast(active ? 'Alerta ativado' : 'Alerta pausado');
    } catch(e) { showToast(e.message,'error'); loadSearchAlerts(); }
}
async function deleteAlert(id) {
    if (!confirm('Remover alerta?')) return;
    try {
        await apiFetch(`/api/admin/applications?__h=search-alerts&id=${id}`, { method:'DELETE' });
        loadSearchAlerts();
    } catch(e) { showToast(e.message,'error'); }
}

async function loadWeeklyGoals() {
    const bars = document.getElementById('weeklyProgressBars');
    try {
        const r = await apiFetch('/api/admin/applications?__h=weekly-goals');
        const { goals, progress, week_start } = r;
        if (document.getElementById('goalCandidaturas')) document.getElementById('goalCandidaturas').value = goals.candidaturas_semana || 3;
        if (document.getElementById('goalFollowups'))   document.getElementById('goalFollowups').value   = goals.followups_semana || 1;
        if (!bars) return;
        const weekDay = new Date(week_start).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' });
        const render = (label, done, goal) => {
            const pct = goal > 0 ? Math.min(100, Math.round(done / goal * 100)) : 0;
            const color = pct >= 100 ? '#4ade80' : pct >= 50 ? 'var(--cyan)' : '#fb923c';
            return `<div style="margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text);margin-bottom:3px">
                    <span>${label}</span>
                    <span style="color:${color};font-weight:600">${done}/${goal}</span>
                </div>
                <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width 0.4s"></div>
                </div>
            </div>`;
        };
        bars.innerHTML = `<div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:8px">Semana de ${weekDay}</div>
            ${render('Candidaturas', progress.candidaturas, goals.candidaturas_semana)}
            ${render('Follow-ups enviados', progress.followups, goals.followups_semana)}`;
    } catch(e) {
        if (bars) bars.innerHTML = `<div style="color:#f87171;font-size:0.8rem">${esc(e.message)}</div>`;
    }
}

async function saveWeeklyGoals() {
    const cand = parseInt(document.getElementById('goalCandidaturas')?.value) || 3;
    const fup  = parseInt(document.getElementById('goalFollowups')?.value) || 1;
    try {
        await apiFetch('/api/admin/applications?__h=weekly-goals', { method:'PUT', body: JSON.stringify({ candidaturas_semana: cand, followups_semana: fup }) });
        showToast('Meta semanal salva');
        loadWeeklyGoals();
    } catch(e) { showToast(e.message,'error'); }
}

// ─── TENDÊNCIAS DE MERCADO (N18) ─────────────────────────────
async function loadTrends() {
    const el = document.getElementById('trendsContent');
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:32px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    try {
        const r = await apiFetch('/api/admin/applications?__h=market-trends');
        const { total_leads, total_apps, conversion_rate_pct, modalidade, status, fit_buckets, top_keywords, monthly_leads, monthly_apps, fonte } = r;

        const kpiCard = (label, val, sub) => `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:1.5rem;font-weight:700;color:var(--cyan)">${val}</div>
            <div style="font-size:0.72rem;color:var(--text)">${label}</div>
            ${sub ? `<div style="font-size:0.68rem;color:var(--text-dim)">${sub}</div>` : ''}
        </div>`;

        const barChart = (data, total) => Object.entries(data).sort((a,b)=>b[1]-a[1]).map(([k,v]) => {
            const pct = total > 0 ? Math.round(v/total*100) : 0;
            return `<div style="margin-bottom:6px">
                <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--text);margin-bottom:2px"><span>${esc(k)}</span><span style="color:var(--text-dim)">${v} (${pct}%)</span></div>
                <div style="height:5px;background:var(--border);border-radius:3px"><div style="height:100%;width:${pct}%;background:var(--cyan);border-radius:3px"></div></div>
            </div>`;
        }).join('');

        const topKwHtml = top_keywords.map(kw => `<span style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:2px 8px;font-size:0.72rem;color:var(--text)">
            ${esc(kw.skill)} <span style="color:var(--cyan)">${kw.count}</span>
        </span>`).join(' ');

        const months = [...new Set([...Object.keys(monthly_leads||{}), ...Object.keys(monthly_apps||{})])].sort();
        const monthlyHtml = months.length ? months.slice(-6).map(m => {
            const l = monthly_leads[m] || 0;
            const a = monthly_apps[m] || { total: 0, aprovado: 0, recusado: 0 };
            return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:0.75rem;color:var(--text-dim);min-width:55px">${m}</div>
                <div style="flex:1">
                    <div style="font-size:0.75rem;color:var(--text)"><span style="color:var(--cyan)">${l}</span> leads capturados</div>
                    ${a.total ? `<div style="font-size:0.72rem;color:var(--text-dim)">${a.total} candidaturas · ${a.aprovado} aprovadas · ${a.recusado} recusadas</div>` : ''}
                </div>
            </div>`;
        }).join('') : '<div style="color:var(--text-dim);font-size:0.82rem">Sem dados mensais ainda.</div>';

        el.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
                ${kpiCard('Leads (6 meses)', total_leads, 'Total capturado')}
                ${kpiCard('Candidaturas', total_apps, 'Total enviadas')}
                ${kpiCard('Taxa de conversão', conversion_rate_pct !== null ? conversion_rate_pct+'%' : '—', 'Aprovadas / enviadas')}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
                <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px">
                    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:8px">Modalidade</div>
                    ${barChart(modalidade, total_leads)}
                </div>
                <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px">
                    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:8px">Fit score</div>
                    ${barChart(fit_buckets, total_leads)}
                </div>
                <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px">
                    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:8px">Status no Radar</div>
                    ${barChart(status, total_leads)}
                </div>
                <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px">
                    <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:8px">Fonte</div>
                    ${barChart(fonte, total_leads)}
                </div>
            </div>
            <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:16px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:10px">Top skills nas vagas</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px">${topKwHtml || '<span style="color:var(--text-dim);font-size:0.82rem">Sem dados ainda.</span>'}</div>
            </div>
            <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:8px">Evolução mensal</div>
                ${monthlyHtml}
            </div>`;
    } catch(e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}

// ─── N19 — Watchlist de empresas ────────────────────────────
async function loadWatchlist() {
    const el = document.getElementById('watchlistContent');
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:12px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    try {
        const r = await apiFetch('/api/admin/applications?__h=watchlist');
        const companies = r.companies || [];
        if (!companies.length) {
            el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;padding:8px 0">Nenhuma empresa na watchlist. Adicione clicando em "+ Adicionar".</div>';
            return;
        }
        el.innerHTML = companies.map(c => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-soft)">
                <div style="width:28px;height:28px;border-radius:50%;background:rgba(34,211,238,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                    <i class="fa-solid fa-building" style="color:var(--cyan);font-size:0.75rem"></i>
                </div>
                <div style="flex:1;min-width:0">
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${esc(c.display_name||c.empresa_normalized)}</div>
                    ${c.watchlist_added_at ? `<div style="font-size:0.72rem;color:var(--text-dim)">Monitorada desde ${new Date(c.watchlist_added_at).toLocaleDateString('pt-BR')}</div>` : ''}
                    ${c.situacao ? `<div style="font-size:0.72rem;color:${c.situacao==='ATIVA'?'#34d399':'#f87171'}">${c.situacao}</div>` : ''}
                </div>
                ${c.glassdoor_rating ? `<span style="font-size:0.78rem;color:#fb923c">★ ${c.glassdoor_rating}</span>` : ''}
                <button class="btn btn-sm" style="padding:3px 8px;font-size:0.72rem;color:var(--danger)" onclick="removeFromWatchlist('${esc(c.display_name||c.empresa_normalized)}')" title="Remover da watchlist"><i class="fa-solid fa-bell-slash"></i></button>
            </div>
        `).join('');
    } catch(e) { el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`; }
}

async function addToWatchlistPrompt() {
    const empresa = await showPrompt('Nome da empresa para monitorar:', 'Ex: Google, Nubank…');
    if (!empresa?.trim()) return;
    try {
        await apiFetch('/api/admin/applications?__h=watchlist', {
            method: 'POST',
            body: JSON.stringify({ empresa: empresa.trim(), watchlist: true })
        });
        showToast(`${empresa} adicionada à watchlist.`,'success');
        loadWatchlist();
    } catch(e) { showToast(e.message,'error'); }
}

async function removeFromWatchlist(empresa) {
    const ok = await showConfirm('Remover da watchlist', `Remover "${empresa}"?`, { okText: 'Remover', danger: true });
    if (!ok) return;
    try {
        await apiFetch('/api/admin/applications?__h=watchlist', {
            method: 'POST',
            body: JSON.stringify({ empresa, watchlist: false })
        });
        showToast('Removida da watchlist.','success');
        loadWatchlist();
    } catch(e) { showToast(e.message,'error'); }
}

// ─── N40 — LGPD export seletivo ─────────────────────────────
async function runLgpdExport() {
    const type = document.getElementById('lgpdType')?.value || 'todos';
    const since = document.getElementById('lgpdSince')?.value || '';
    const anonymous = document.getElementById('lgpdAnon')?.checked ? 'true' : 'false';
    let url = `/api/admin/applications?__h=lgpd-export&type=${type}&anonymous=${anonymous}`;
    if (since) url += `&since=${encodeURIComponent(since + 'T00:00:00Z')}`;
    try {
        const r = await apiFetch(url);
        const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `lgpd-export-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        showToast('Exportação concluída.','success');
    } catch(e) { showToast(e.message,'error'); }
}

// ─── MAPA DE CARREIRA (N41) ──────────────────────────────────
async function loadCareerPaths() {
    const el = document.getElementById('careerPathsContent');
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:16px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    try {
        const r = await apiFetch('/api/admin/applications?__h=career-paths');
        const paths = r.paths || [];
        if (!paths.length) {
            el.innerHTML = `<div style="color:var(--text-dim);font-size:0.82rem;padding:12px">Nenhum caminho cadastrado. <button class="btn btn-sm" onclick="generateCareerPaths(this)"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar com IA</button></div>`;
            return;
        }

        // Agrupa por from_role
        const byRole = {};
        for (const p of paths) { (byRole[p.from_role] = byRole[p.from_role] || []).push(p); }
        const diffColor = d => d <= 2 ? 'var(--success,#34d399)' : d <= 3 ? '#f59e0b' : '#f87171';
        const diffLabel = d => '★'.repeat(d) + '☆'.repeat(5-d);
        const fmtSalary = s => s ? `R$ ${(s/1000).toFixed(0)}k` : '—';

        el.innerHTML = Object.entries(byRole).map(([role, ps]) => `
            <div style="margin-bottom:16px">
                <div style="font-size:0.82rem;font-weight:700;color:var(--text);margin-bottom:8px;padding:6px 10px;background:var(--bg-soft);border-radius:6px;border-left:3px solid var(--cyan)">
                    <i class="fa-solid fa-location-crosshairs" style="color:var(--cyan);margin-right:6px"></i>${esc(role)}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;padding-left:8px">
                    ${ps.map(p => `<div style="flex:1;min-width:180px;max-width:260px;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:10px">
                        <div style="font-size:0.82rem;font-weight:600;color:var(--text);margin-bottom:6px">
                            <i class="fa-solid fa-arrow-right" style="color:var(--cyan);margin-right:4px;font-size:0.7rem"></i>${esc(p.to_role)}
                        </div>
                        <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text-dim);margin-bottom:6px">
                            <span><i class="fa-solid fa-clock" style="margin-right:3px"></i>${p.horizon_years}a</span>
                            <span style="color:${fmtSalary(p.median_salary_brl)==='—'?'var(--text-dim)':'#34d399'}">${fmtSalary(p.median_salary_brl)}</span>
                        </div>
                        <div style="font-size:0.7rem;color:${diffColor(p.transition_difficulty)};margin-bottom:6px">${diffLabel(p.transition_difficulty)}</div>
                        ${(p.required_skills||[]).length ? `<div style="display:flex;flex-wrap:wrap;gap:3px">${(p.required_skills||[]).slice(0,4).map(s=>`<span style="font-size:0.65rem;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:1px 6px;color:var(--text-soft)">${esc(s)}</span>`).join('')}</div>` : ''}
                    </div>`).join('')}
                </div>
            </div>
        `).join('');
    } catch(e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}

async function generateCareerPaths(btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    try {
        const r = await apiFetch('/api/admin/applications?__h=career-paths', {
            method: 'POST',
            body: JSON.stringify({ action: 'generate' })
        });
        showToast(`${r.generated} caminhos de carreira gerados!`, 'success');
        const el = document.getElementById('careerPathsContent');
        if (el) loadCareerPaths?.();
    } catch(e) { showToast(e.message, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Gerar com IA'; } }
}

// ─── DIÁRIO DE CARREIRA (N15) ────────────────────────────────
async function loadJournal() {
    const el = document.getElementById('journalList');
    if (!el) return;
    try {
        const r = await apiFetch('/api/admin/applications?__h=career-journal');
        const entries = r.entries ?? [];
        if (!entries.length) {
            el.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;padding:24px 0">Nenhuma entrada. Clique em "Gerar este mês" para começar.</div>';
            return;
        }
        el.innerHTML = entries.map(e => {
            const dt = new Date(e.generated_at).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
            const full = e.content_markdown || '';
            const preview = full.replace(/^#+\s*/gm,'').slice(0, 200);
            const hasMore = preview.length < full.length;
            return `<div style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:10px;background:var(--bg-card)">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
                    <div>
                        <div style="font-weight:600;font-size:0.9rem;color:var(--text)">${esc(e.title || e.scope_ref || e.scope)}</div>
                        <div style="font-size:0.72rem;color:var(--text-dim)">${esc(e.scope)} · ${dt} · ${esc(e.generated_by || 'manual')}</div>
                    </div>
                    <div style="display:flex;gap:6px;flex-shrink:0">
                        ${hasMore ? `<button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="toggleJournalExpand(this,'${e.id}')"><i class="fa-solid fa-eye"></i></button>` : ''}
                        <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="openJournalEditor('${e.id}')"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem;color:var(--danger)" onclick="deleteJournalEntry('${e.id}')"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <div id="journal-preview-${e.id}" style="font-size:0.78rem;color:var(--text-soft);white-space:pre-line">${esc(preview)}${hasMore ? '…' : ''}</div>
            </div>`;
        }).join('');
    } catch(e) {
        if (el) el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}

async function generateMonthJournal() {
    const ref = new Date().toISOString().slice(0,7);
    try {
        showToast('Gerando diário do mês…');
        await apiFetch('/api/admin/applications?__h=career-journal', {
            method: 'POST',
            body: JSON.stringify({ scope: 'month', scope_ref: ref })
        });
        showToast('Diário gerado.');
        loadJournal();
    } catch(e) { showToast(e.message,'error'); }
}

async function toggleJournalExpand(btn, id) {
    const el = document.getElementById(`journal-preview-${id}`);
    if (!el) return;
    if (btn.dataset.expanded === '1') {
        btn.dataset.expanded = '0';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
        el.textContent = el.dataset.preview || '';
    } else {
        btn.dataset.expanded = '1';
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
        if (!el.dataset.full) {
            try {
                const data = await apiFetch(`/api/admin/applications?__h=career-journal&id=${id}`);
                el.dataset.full = data.content_markdown || '';
                el.dataset.preview = el.textContent;
            } catch { return; }
        }
        el.style.whiteSpace = 'pre-wrap';
        el.textContent = el.dataset.full;
    }
}

async function openJournalEditor(id) {
    document.getElementById('journalId').value = id || '';
    if (id) {
        try {
            const e = await apiFetch(`/api/admin/applications?__h=career-journal&id=${encodeURIComponent(id)}`);
            if (e) {
                document.getElementById('journalTitle').value = e.title || '';
                document.getElementById('journalContent').value = e.content_markdown || '';
            }
        } catch { /* ignore */ }
    } else {
        document.getElementById('journalTitle').value = '';
        document.getElementById('journalContent').value = '';
    }
    document.getElementById('journalEditor').style.display = 'block';
    document.getElementById('journalEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeJournalEditor() {
    document.getElementById('journalEditor').style.display = 'none';
}

async function saveJournalEntry() {
    const id = document.getElementById('journalId').value;
    const title = document.getElementById('journalTitle').value.trim();
    const content = document.getElementById('journalContent').value.trim();
    if (!content) { showToast('Conteúdo obrigatório.','error'); return; }
    try {
        if (id) {
            await apiFetch(`/api/admin/applications?__h=career-journal&id=${id}`, {
                method: 'PUT',
                body: JSON.stringify({ title, content_markdown: content })
            });
        } else {
            await apiFetch('/api/admin/applications?__h=career-journal', {
                method: 'POST',
                body: JSON.stringify({ scope: 'manual', title, content_markdown: content })
            });
        }
        showToast('Entrada salva.');
        closeJournalEditor();
        loadJournal();
    } catch(e) { showToast(e.message,'error'); }
}

async function deleteJournalEntry(id) {
    if (!confirm('Excluir esta entrada do diário?')) return;
    try {
        await apiFetch(`/api/admin/applications?__h=career-journal&id=${id}`, { method: 'DELETE' });
        showToast('Entrada excluída.');
        loadJournal();
    } catch(e) { showToast(e.message,'error'); }
}

// ─── COMPASS DE VALORES (N42) ────────────────────────────────
async function loadValuesWeights() {
    try {
        const r = await apiFetch('/api/admin/applications?__h=values-weights');
        const w = r.weights || {};
        const m = { salario: 'vwSalario', wlb: 'vwWlb', growth: 'vwGrowth', proposito: 'vwProposito', seguranca: 'vwSeguranca', autonomia: 'vwAutonomia' };
        for (const [k, id] of Object.entries(m)) {
            const el = document.getElementById(id);
            if (el && w[k] !== undefined) el.value = Math.round((w[k] || 0) * 100);
        }
        if (r.expected_salary_min && document.getElementById('expSalaryMin')) document.getElementById('expSalaryMin').value = r.expected_salary_min;
        if (r.expected_salary_max && document.getElementById('expSalaryMax')) document.getElementById('expSalaryMax').value = r.expected_salary_max;
        updateValuesTotal();
    } catch(e) { /* silencioso */ }
}

function updateValuesTotal() {
    const ids = ['vwSalario','vwWlb','vwGrowth','vwProposito','vwSeguranca','vwAutonomia'];
    const total = ids.reduce((s, id) => s + (parseInt(document.getElementById(id)?.value)||0), 0);
    const ind = document.getElementById('valuesTotalIndicator');
    if (!ind) return;
    const ok = total === 100;
    ind.textContent = `Total: ${total}%${ok ? ' ✓' : ' ⚠ deve somar 100%'}`;
    ind.style.color = ok ? '#4ade80' : '#fb923c';
}

async function saveValuesWeights() {
    const ids = ['vwSalario','vwWlb','vwGrowth','vwProposito','vwSeguranca','vwAutonomia'];
    const keys = ['salario','wlb','growth','proposito','seguranca','autonomia'];
    const total = ids.reduce((s, id) => s + (parseInt(document.getElementById(id)?.value)||0), 0);
    if (total !== 100) { showToast('Os pesos devem somar 100%.','error'); return; }
    const weights = {};
    ids.forEach((id, i) => { weights[keys[i]] = (parseInt(document.getElementById(id)?.value)||0) / 100; });
    const body = {
        weights,
        expected_salary_min: parseInt(document.getElementById('expSalaryMin')?.value)||null,
        expected_salary_max: parseInt(document.getElementById('expSalaryMax')?.value)||null,
    };
    try {
        await apiFetch('/api/admin/applications?__h=values-weights', { method:'PUT', body: JSON.stringify(body) });
        showToast('Compass de valores salvo.');
    } catch(e) { showToast(e.message,'error'); }
}

// ─── IMPORTAR CV (N21) ──────────────────────────────────────
async function runImportCV() {
    const textarea = document.getElementById('cvImportText');
    const resultEl = document.getElementById('cvImportResult');
    const text = textarea?.value?.trim();
    if (!text || text.length < 50) { showToast('Cole o texto do CV antes de estruturar.','error'); return; }

    resultEl.style.display = 'none';
    showToast('Estruturando currículo via IA…');

    let data;
    try {
        data = await apiFetch('/api/admin/applications?__h=import-cv', { method:'POST', body: JSON.stringify({ cv_text: text }) });
    } catch(e) { showToast(e.message,'error'); return; }

    const s = data.structured || {};
    const skillsCore = (s.skills_core||[]).join(', ');
    const skillsEvol = (s.skills_evolucao||[]).join(', ');
    const setores    = (s.setores||[]).join(', ');
    const idiomas    = (s.languages||[]).map(l => `${l.lang} (${l.level})`).join(', ');
    const certs      = (s.certifications||[]).map(c => c.name).join(', ');
    const exps       = (s.experiences||[]).map(e => `<li><strong>${esc(e.role)}</strong> @ ${esc(e.company)} (${e.start||''}–${e.end||'atual'})</li>`).join('');
    const edus       = (s.education||[]).map(e => `<li>${esc(e.degree)} — ${esc(e.institution)} (${e.year||''})</li>`).join('');

    resultEl.innerHTML = `
        <div style="border:1px solid var(--border);border-radius:10px;padding:16px;background:var(--bg-soft)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
                <div style="font-weight:600;font-size:0.9rem;color:var(--text)"><i class="fa-solid fa-check-circle" style="color:var(--green);margin-right:6px"></i> Currículo estruturado — revise antes de aplicar</div>
                <button class="btn btn-cyan btn-sm" onclick="applyImportedCV(${JSON.stringify(JSON.stringify(s))})"><i class="fa-solid fa-check"></i> Aplicar ao perfil</button>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.8rem">
                <div><label style="font-size:0.72rem;color:var(--text-soft)">Nome</label><div style="color:var(--text)">${esc(s.nome||'–')}</div></div>
                <div><label style="font-size:0.72rem;color:var(--text-soft)">Nível alvo</label><div style="color:var(--text)">${esc(s.nivel_alvo||'–')}</div></div>
                <div><label style="font-size:0.72rem;color:var(--text-soft)">Skills core</label><div style="color:var(--cyan)">${esc(skillsCore||'–')}</div></div>
                <div><label style="font-size:0.72rem;color:var(--text-soft)">Skills evolução</label><div style="color:var(--text)">${esc(skillsEvol||'–')}</div></div>
                <div><label style="font-size:0.72rem;color:var(--text-soft)">Setores</label><div style="color:var(--text)">${esc(setores||'–')}</div></div>
                <div><label style="font-size:0.72rem;color:var(--text-soft)">Idiomas</label><div style="color:var(--text)">${esc(idiomas||'–')}</div></div>
            </div>
            ${exps ? `<div style="margin-top:10px"><label style="font-size:0.72rem;color:var(--text-soft)">Experiências</label><ul style="margin:4px 0 0;padding-left:18px;font-size:0.78rem;color:var(--text)">${exps}</ul></div>` : ''}
            ${edus ? `<div style="margin-top:8px"><label style="font-size:0.72rem;color:var(--text-soft)">Formação</label><ul style="margin:4px 0 0;padding-left:18px;font-size:0.78rem;color:var(--text)">${edus}</ul></div>` : ''}
            ${certs ? `<div style="margin-top:8px"><label style="font-size:0.72rem;color:var(--text-soft)">Certificações</label><div style="font-size:0.78rem;color:var(--text)">${esc(certs)}</div></div>` : ''}
        </div>
    `;
    resultEl.style.display = '';
    showToast('CV estruturado! Revise e clique "Aplicar ao perfil".','success');
}

async function applyImportedCV(structuredJson) {
    let s;
    try { s = JSON.parse(structuredJson); } catch { showToast('Erro ao processar dados.','error'); return; }

    // Monta patch do candidate_profile com os dados extraídos
    const profilePatch = {};
    if (s.nivel_alvo) profilePatch.nivel_alvo = s.nivel_alvo;
    if (s.skills_core?.length)    profilePatch.skills_core    = s.skills_core;
    if (s.skills_evolucao?.length) profilePatch.skills_evolucao = s.skills_evolucao;
    if (s.setores?.length)         profilePatch.setores        = s.setores;
    if (s.keywords?.length)        profilePatch.keywords       = s.keywords;

    try {
        await apiFetch('/api/admin/radar?__h=profile', { method:'PUT', body: JSON.stringify(profilePatch) });
        showToast('Perfil atualizado com dados do CV!','success');
        document.getElementById('cvImportResult').style.display = 'none';
        document.getElementById('cvImportText').value = '';
    } catch(e) { showToast(e.message,'error'); }
}

// ─── NOTIFICAÇÕES / DND (N29/N30) ────────────────────────────
async function loadNotificationSettings() {
    try {
        const r = await apiFetch('/api/admin/applications?__h=notification-settings');
        const s = r.settings || {};
        const h = s.dnd_hours_weekday || [22, 8];
        const w = s.dnd_hours_weekend || [23, 10];
        if (document.getElementById('dndWeekdayStart')) document.getElementById('dndWeekdayStart').value = h[0] ?? 22;
        if (document.getElementById('dndWeekdayEnd'))   document.getElementById('dndWeekdayEnd').value   = h[1] ?? 8;
        if (document.getElementById('dndWeekendStart')) document.getElementById('dndWeekendStart').value = w[0] ?? 23;
        if (document.getElementById('dndWeekendEnd'))   document.getElementById('dndWeekendEnd').value   = w[1] ?? 10;
        if (document.getElementById('dndCriticalOverride')) document.getElementById('dndCriticalOverride').checked = s.critical_overrides_dnd !== false;
        if (document.getElementById('pauseMode')) document.getElementById('pauseMode').checked = !!s.pause_mode;
        const status = document.getElementById('notifSettingsStatus');
        if (status && s.pause_mode) status.textContent = 'Modo pausa ativo — buscas e alertas suspensos.';
    } catch(e) { /* silencioso */ }
}

async function saveNotificationSettings() {
    const settings = {
        dnd_hours_weekday: [
            parseInt(document.getElementById('dndWeekdayStart')?.value) ?? 22,
            parseInt(document.getElementById('dndWeekdayEnd')?.value) ?? 8,
        ],
        dnd_hours_weekend: [
            parseInt(document.getElementById('dndWeekendStart')?.value) ?? 23,
            parseInt(document.getElementById('dndWeekendEnd')?.value) ?? 10,
        ],
        critical_overrides_dnd: document.getElementById('dndCriticalOverride')?.checked !== false,
        pause_mode: !!document.getElementById('pauseMode')?.checked,
    };
    try {
        await apiFetch('/api/admin/applications?__h=notification-settings', { method:'PUT', body: JSON.stringify({ settings }) });
        showToast('Configurações de notificação salvas.');
        loadNotificationSettings();
    } catch(e) { showToast(e.message,'error'); }
}

// ─── LINKEDIN UPDATE (N14) + ONBOARDING (N33) ────────────────
let _linkedinUpdateAppId = null;
let _onboardingProcessId = null;

function openLinkedinUpdateModal(appId, empresa, vaga) {
    _linkedinUpdateAppId = appId;
    document.getElementById('liHeadline').value = vaga ? `${vaga} @ ${empresa}` : '';
    document.getElementById('liStartDate').value = new Date().toISOString().slice(0,10);
    const modal = document.getElementById('linkedinUpdateModal');
    modal.style.display = 'flex';
}

function dismissLinkedinUpdate() {
    document.getElementById('linkedinUpdateModal').style.display = 'none';
}

async function applyLinkedinUpdate() {
    const appId = _linkedinUpdateAppId;
    if (!appId) return;
    const headline = document.getElementById('liHeadline')?.value.trim();
    const startDate = document.getElementById('liStartDate')?.value;
    const createOnboarding = document.getElementById('liCreateOnboarding')?.checked;
    try {
        if (headline) {
            await apiFetch(`/api/admin/applications?__h=linkedin-update&id=${appId}`, {
                method: 'PUT',
                body: JSON.stringify({ linkedin_update_status: 'applied', linkedin_update_applied_at: new Date().toISOString() })
            });
        }
        if (createOnboarding) {
            const appData = await apiFetch(`/api/admin/applications?id=${appId}`);
            const r = await apiFetch('/api/admin/applications?__h=onboarding', {
                method: 'POST',
                body: JSON.stringify({ application_id: appId, company: appData.empresa, role: appData.vaga, start_date: startDate || null })
            });
            _onboardingProcessId = r.id;
        }
        dismissLinkedinUpdate();
        showToast('Atualizado! ' + (createOnboarding ? 'Checklist de onboarding criado.' : ''));
        if (createOnboarding && _onboardingProcessId) openOnboardingModal(_onboardingProcessId);
        renderVagas?.();
    } catch(e) { showToast(e.message,'error'); }
}

async function openOnboardingModal(onboardingId) {
    const modal = document.getElementById('onboardingModal');
    const content = document.getElementById('onboardingContent');
    if (!modal || !content) return;
    modal.style.display = 'flex';
    content.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Carregando…</div>';
    try {
        let data;
        if (onboardingId) {
            data = (await apiFetch(`/api/admin/applications?__h=onboarding&id=${onboardingId}`))?.onboarding;
        }
        if (!data) { content.innerHTML = '<div style="color:var(--text-dim)">Não encontrado.</div>'; return; }
        _onboardingProcessId = data.id;
        content.innerHTML = _renderOnboardingChecklist(data);
    } catch(e) { content.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`; }
}

function closeOnboardingModal() {
    document.getElementById('onboardingModal').style.display = 'none';
}

function _renderOnboardingChecklist(data) {
    const items = data.checklist || [];
    const catLabels = { docs:'📄 Documentos', health:'🏥 Saúde', prep:'🚀 Preparação' };
    const grouped = {};
    for (const it of items) { const c = it.category || 'outros'; (grouped[c] = grouped[c] || []).push(it); }
    return `<div>
        <div style="font-size:0.78rem;color:var(--text-soft);margin-bottom:12px">
            ${data.company ? `<strong>${esc(data.company)}</strong>` : ''}
            ${data.start_date ? ` · Início: ${new Date(data.start_date+'T12:00:00').toLocaleDateString('pt-BR')}` : ''}
        </div>
        ${Object.entries(grouped).map(([cat, its]) => `
            <div style="margin-bottom:12px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:6px">${catLabels[cat] || cat}</div>
                ${its.map(it => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
                    <input type="checkbox" ${it.done?'checked':''} style="accent-color:var(--cyan)" onchange="toggleOnboardingItem('${data.id}','${it.id}',this.checked)">
                    <span style="font-size:0.83rem;color:var(--text);${it.done?'text-decoration:line-through;color:var(--text-dim)':''}">${esc(it.label)}</span>
                </div>`).join('')}
            </div>
        `).join('')}
        <div style="margin-top:12px">
            <textarea id="onboardingNotes" class="mock-input" rows="2" placeholder="Notas…" style="resize:vertical;font-size:0.82rem">${esc(data.notes||'')}</textarea>
            <button class="btn btn-cyan btn-sm" style="margin-top:6px" onclick="saveOnboardingNotes('${data.id}')"><i class="fa-solid fa-check"></i> Salvar notas</button>
        </div>
        ${data.application_id ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <span style="font-size:0.8rem;font-weight:600;color:var(--text)"><i class="fa-solid fa-calendar-check" style="color:var(--cyan);margin-right:6px"></i> Plano 30/60/90 dias</span>
                <button class="btn btn-sm" style="padding:3px 10px;font-size:0.75rem" onclick="generatePlan306090('${data.application_id}','plan306090Container')"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar</button>
            </div>
            <div id="plan306090Container" style="font-size:0.82rem;color:var(--text-dim)">Clique em "Gerar" para criar um plano personalizado com IA.</div>
        </div>` : ''}
    </div>`;
}

async function toggleOnboardingItem(processId, itemId, checked) {
    try {
        const r = await apiFetch(`/api/admin/applications?__h=onboarding&id=${processId}`);
        const data = r?.onboarding;
        if (!data) return;
        const checklist = (data.checklist || []).map(it => it.id === itemId ? { ...it, done: checked } : it);
        await apiFetch(`/api/admin/applications?__h=onboarding&id=${processId}`, {
            method: 'PUT',
            body: JSON.stringify({ checklist })
        });
    } catch(e) { showToast(e.message,'error'); }
}

async function saveOnboardingNotes(processId) {
    const notes = document.getElementById('onboardingNotes')?.value || '';
    try {
        await apiFetch(`/api/admin/applications?__h=onboarding&id=${processId}`, {
            method: 'PUT',
            body: JSON.stringify({ notes })
        });
        showToast('Notas salvas.');
    } catch(e) { showToast(e.message,'error'); }
}

// ─── N34 — Plano 30/60/90 dias ──────────────────────────────────────────────
async function generatePlan306090(appId, planContainerId) {
    const el = document.getElementById(planContainerId);
    if (!el) return;
    el.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:16px"><i class="fa-solid fa-circle-notch fa-spin"></i> Gerando plano…</div>';
    try {
        const r = await apiFetch('/api/admin/applications?__h=plan-30-60-90', {
            method: 'POST',
            body: JSON.stringify({ application_id: appId })
        });
        const plan = r.plan || {};
        const renderBlock = (block, label, color) => {
            if (!block) return '';
            const items = (block.objetivos || []).map(o => `<li style="margin-bottom:4px">${esc(o)}</li>`).join('');
            return `<div style="flex:1;min-width:200px;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:12px">
                <div style="font-weight:700;font-size:0.82rem;color:${color};margin-bottom:4px">${label}</div>
                <div style="font-size:0.75rem;color:var(--text-soft);margin-bottom:8px;font-style:italic">${esc(block.foco||'')}</div>
                <ul style="margin:0;padding-left:16px;font-size:0.8rem;color:var(--text)">${items}</ul>
            </div>`;
        };
        el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px">
            ${renderBlock(plan.dias_30, '30 dias', 'var(--cyan)')}
            ${renderBlock(plan.dias_60, '60 dias', '#a78bfa')}
            ${renderBlock(plan.dias_90, '90 dias', '#34d399')}
        </div>`;
    } catch(e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">${esc(e.message)}</div>`;
    }
}

// ─── N35 — Manter rede aquecida pós-contratação ──────────────────────────────
async function showWarmNetworkSuggestions(approvedAppId) {
    try {
        const r = await apiFetch(`/api/admin/applications?__h=warm-network&application_id=${approvedAppId}`);
        const suggestions = r.suggestions || [];
        if (!suggestions.length) { showToast('Nenhuma candidatura avançada encontrada para reaquecer.'); return; }
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
        const checks = suggestions.map((s, i) =>
            `<label style="display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;background:var(--bg-soft)">
                <input type="checkbox" value="${i}" checked style="margin-top:3px;accent-color:var(--cyan)">
                <div>
                    <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${esc(s.recruiter_name || 'Recrutador')} ${s.empresa ? '— ' + esc(s.empresa) : ''}</div>
                    <div style="font-size:0.75rem;color:var(--text-soft)">${esc(s.vaga || '')}</div>
                </div>
            </label>`
        ).join('');
        modal.innerHTML = `<div style="background:var(--bg-card);border-radius:12px;padding:20px;max-width:500px;width:100%;max-height:80vh;overflow-y:auto">
            <h4 style="margin:0 0 12px;font-size:0.95rem;color:var(--text)"><i class="fa-solid fa-people-group" style="color:var(--cyan);margin-right:6px"></i> Manter rede aquecida</h4>
            <p style="font-size:0.82rem;color:var(--text-soft);margin:0 0 12px">Candidaturas onde você chegou longe mas não foi aprovado — vale manter contato.</p>
            <div>${checks}</div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button class="btn btn-sm" onclick="this.closest('[style]').remove()">Cancelar</button>
                <button class="btn btn-cyan btn-sm" id="warmNetworkConfirmBtn" onclick="_confirmWarmNetwork(${JSON.stringify(suggestions).replace(/"/g,'&quot;')}, this)"><i class="fa-solid fa-plus"></i> Adicionar à Rede</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
        window._warmNetworkSuggestions = suggestions;
        window._warmNetworkModal = modal;
    } catch(e) { showToast(e.message,'error'); }
}

async function _confirmWarmNetwork(suggestions, btn) {
    const modal = btn.closest('[style*="position:fixed"]');
    const checks = modal ? [...modal.querySelectorAll('input[type=checkbox]:checked')] : [];
    const selected = checks.map(c => suggestions[parseInt(c.value)]).filter(Boolean);
    if (!selected.length) { showToast('Selecione pelo menos um contato.','error'); return; }
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
    try {
        const r = await apiFetch('/api/admin/applications?__h=warm-network', {
            method: 'POST',
            body: JSON.stringify({ contacts: selected })
        });
        modal.remove();
        showToast(`${r.created} contato(s) adicionados à Rede.`,'success');
    } catch(e) {
        btn.disabled = false; btn.innerHTML = 'Adicionar à Rede';
        showToast(e.message,'error');
    }
}

async function loadPipelineTemplate() {
    const el = document.getElementById('pipelineTemplateInput');
    if (!el) return;
    const saved = localStorage.getItem('stages_template');
    if (saved) el.value = saved;
    else el.value = 'Aplicado\nTriagem\nEntrevista com RH\nEntrevista Técnica\nEntrevista com Gestor\nTeste\nProposta';
    window._stagesTemplate = el.value.split('\n').map(s => s.trim()).filter(Boolean);
}

async function savePipelineTemplate() {
    const el = document.getElementById('pipelineTemplateInput');
    if (!el) return;
    const stages = el.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!stages.length) { showToast('Adicione ao menos uma etapa.', 'error'); return; }
    localStorage.setItem('stages_template', el.value.trim());
    window._stagesTemplate = stages;
    showToast('Pipeline padrão salvo.');
}

async function runAutoArchiveScan() {
    try {
        const r = await api('POST', '/api/admin/applications?__h=auto-archive-scan', {});
        const total = (r.archived_em_processo || 0) + (r.archived_recusado || 0);
        showToast(`${total} candidatura${total !== 1 ? 's' : ''} arquivada${total !== 1 ? 's' : ''}.${r.errors?.length ? ' (com erros)' : ''}`);
        if (total > 0) loadApplications();
    } catch (e) { showToast(e.message, 'error'); }
}

async function runLinkChecker() {
    showToast('Verificando links… pode demorar alguns segundos.', 'info');
    try {
        const r = await api('POST', '/api/admin/applications?__h=link-checker', {});
        showToast(`${r.checked} links verificados. ${r.removed} vaga${r.removed !== 1 ? 's' : ''} removida${r.removed !== 1 ? 's' : ''} arquivada${r.removed !== 1 ? 's' : ''}.`);
        if (r.removed > 0) loadApplications();
    } catch (e) { showToast(e.message, 'error'); }
}

async function renderPlatformSettingsTable() {
    const el = document.getElementById('platformSettingsTable');
    if (!el) return;
    try {
        const rows = await api('GET', '/api/admin/applications?__h=platform-settings');
        if (!rows?.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhuma plataforma cadastrada.</div>'; return; }
        el.innerHTML = `<table class="vagas-table" style="font-size:0.8rem">
            <thead><tr><th>Plataforma</th><th>Limite chars</th><th>Campo</th><th>Ativo</th><th></th></tr></thead>
            <tbody>
            ${rows.map(p => `
                <tr id="plt-row-${p.fonte}">
                    <td><strong>${esc(p.display_name)}</strong><br><span style="color:var(--text-dim);font-size:0.7rem">${esc(p.fonte)}</span></td>
                    <td><input id="plt-char-${p.fonte}" class="mock-input" type="number" min="0" value="${p.char_limit}" style="width:80px;padding:3px 6px" onchange="savePlatformRow('${p.fonte}')"></td>
                    <td><input id="plt-field-${p.fonte}" class="mock-input" value="${esc(p.field_name || '')}" style="width:160px;padding:3px 6px" onchange="savePlatformRow('${p.fonte}')" placeholder="nome do campo"></td>
                    <td><input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePlatformEnabled('${p.fonte}', this.checked)" style="accent-color:var(--cyan)"></td>
                    <td><span id="plt-saved-${p.fonte}" style="color:var(--success);font-size:0.72rem;display:none"><i class="fa-solid fa-check"></i></span></td>
                </tr>`).join('')}
            </tbody>
        </table>`;
    } catch (e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}
async function savePlatformRow(fonte) {
    const charLimit = parseInt(document.getElementById(`plt-char-${fonte}`)?.value || '0', 10);
    const fieldName = document.getElementById(`plt-field-${fonte}`)?.value.trim() || null;
    try {
        await api('PUT', '/api/admin/applications?__h=platform-settings', { fonte, char_limit: charLimit, field_name: fieldName });
        const saved = document.getElementById(`plt-saved-${fonte}`);
        if (saved) { saved.style.display = 'inline'; setTimeout(() => saved.style.display = 'none', 2000); }
        window._platformSettings = (window._platformSettings || []).map(p => p.fonte === fonte ? { ...p, char_limit: charLimit, field_name: fieldName } : p);
    } catch (e) { showToast('Erro: ' + e.message); }
}
async function togglePlatformEnabled(fonte, enabled) {
    try {
        await api('PUT', '/api/admin/applications?__h=platform-settings', { fonte, enabled });
        window._platformSettings = enabled
            ? [...(window._platformSettings || []), { fonte, enabled: true }]
            : (window._platformSettings || []).filter(p => p.fonte !== fonte);
    } catch (e) { showToast('Erro: ' + e.message); }
}

// ── LLM Providers ─────────────────────────────────────────
async function loadLLMProviders() {
    const el = document.getElementById('llmProvidersTable');
    if (!el) return;
    try {
        const providers = await api('GET', '/api/admin/applications?__h=llm-providers');
        if (!providers?.length) {
            el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhum provider encontrado. Aplique a migration-043 no Supabase.</div>';
            return;
        }
        el.innerHTML = `<table class="vagas-table" style="font-size:0.79rem">
            <thead><tr><th>Provider</th><th>Modelo</th><th>Tier</th><th>Tasks</th><th>Chave</th><th>Hoje (OK/Err)</th><th>Ativo</th><th>Prioridade</th></tr></thead>
            <tbody>
            ${providers.map(p => {
                const todayCalls = `${p.today.calls_ok}/${p.today.calls_error}`;
                const tierColor  = p.tier === 'free' ? 'var(--success)' : 'var(--warn,#fbbf24)';
                const keyIcon    = p.api_key_configured
                    ? '<i class="fa-solid fa-key" style="color:var(--success)" title="Configurada"></i>'
                    : '<i class="fa-solid fa-key" style="color:var(--danger);opacity:0.5" title="Não configurada — adicione a env var no Vercel"></i>';
                const tasks = (p.task_types || []).map(t => `<span style="font-size:0.68rem;padding:1px 5px;border-radius:4px;background:rgba(34,211,238,0.1);color:var(--cyan)">${t}</span>`).join(' ');
                return `<tr>
                    <td><strong>${esc(p.display_name)}</strong></td>
                    <td style="color:var(--text-dim);font-size:0.72rem">${esc(p.model)}</td>
                    <td style="color:${tierColor};font-weight:600">${esc(p.tier)}</td>
                    <td style="white-space:nowrap">${tasks}</td>
                    <td style="text-align:center">${keyIcon}</td>
                    <td style="color:var(--text-dim)">${todayCalls}</td>
                    <td style="text-align:center"><input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="toggleLLMProvider('${p.id}', this.checked)" style="accent-color:var(--cyan)"></td>
                    <td><input type="number" min="0" max="99" value="${p.priority}" class="mock-input" style="width:52px;padding:2px 6px" onchange="saveLLMPriority('${p.id}', this.value)"></td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;
    } catch (e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}
async function toggleLLMProvider(id, enabled) {
    try { await api('PUT', `/api/admin/applications?__h=llm-providers&id=${id}`, { enabled }); }
    catch (e) { showToast('Erro: ' + e.message, 'error'); }
}
async function saveLLMPriority(id, priority) {
    try { await api('PUT', `/api/admin/applications?__h=llm-providers&id=${id}`, { priority: parseInt(priority, 10) }); }
    catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ── Auto-Sync de status ────────────────────────────────────
async function loadPlatformSessions() {
    const el = document.getElementById('platformSessionsList');
    if (!el) return;
    try {
        const sessions = await api('GET', '/api/admin/applications?__h=platform-sessions');
        if (!sessions?.length) {
            el.innerHTML = `<div style="font-size:0.82rem;color:var(--text-dim)">Nenhuma sessão ativa. Use o MCP <code>sync_application_status</code> para disparar sincronizações.</div>`;
            return;
        }
        el.innerHTML = `<table class="vagas-table" style="font-size:0.8rem">
            <thead><tr><th>Plataforma</th><th>Tipo</th><th>Válida</th><th>Último uso</th><th>Expira</th><th></th></tr></thead>
            <tbody>
            ${sessions.map(s => {
                const lastUsed = s.last_used_at ? new Date(s.last_used_at).toLocaleDateString('pt-BR') : '—';
                const expires  = s.expires_at  ? new Date(s.expires_at).toLocaleDateString('pt-BR')  : '—';
                const valid    = s.is_valid;
                return `<tr>
                    <td><strong>${esc(s.display_name || s.fonte)}</strong></td>
                    <td style="color:var(--text-dim)">${esc(s.session_type)}</td>
                    <td>${valid ? '<i class="fa-solid fa-circle-check" style="color:var(--success)"></i>' : '<i class="fa-solid fa-circle-xmark" style="color:var(--danger)"></i>'}</td>
                    <td style="color:var(--text-dim)">${lastUsed}</td>
                    <td style="color:var(--text-dim)">${expires}</td>
                    <td><button class="btn btn-sm" style="padding:2px 8px;font-size:0.7rem;color:var(--danger)" onclick="deleteSession('${esc(s.fonte)}')" title="Remover sessão"><i class="fa-solid fa-trash"></i></button></td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>`;
    } catch (e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}

async function deleteSession(fonte) {
    if (!confirm(`Remover sessão de "${fonte}"?`)) return;
    try {
        await api('DELETE', `/api/admin/applications?__h=platform-sessions&fonte=${encodeURIComponent(fonte)}`);
        showToast(`Sessão "${fonte}" removida.`);
        loadPlatformSessions();
    } catch (e) { showToast(e.message, 'error'); }
}

async function runSyncAll() {
    const btn = document.getElementById('syncAllBtn');
    const banner = document.getElementById('syncResultBanner');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Sincronizando…'; }
    if (banner) banner.style.display = 'none';
    try {
        // Chama link-checker + auto-archive como proxy de sync (o sync real roda via MCP)
        const [linkRes, archRes] = await Promise.allSettled([
            api('POST', '/api/admin/applications?__h=link-checker', {}),
            api('POST', '/api/admin/applications?__h=auto-archive-scan', {}),
        ]);
        const removed  = linkRes.status === 'fulfilled' ? (linkRes.value.removed  || 0) : 0;
        const archived = archRes.status === 'fulfilled' ? ((archRes.value.archived_em_processo || 0) + (archRes.value.archived_recusado || 0)) : 0;
        if (banner) {
            banner.style.display = 'block';
            banner.textContent = `Sincronização concluída: ${removed} vaga${removed !== 1 ? 's' : ''} removida${removed !== 1 ? 's' : ''}, ${archived} arquivada${archived !== 1 ? 's' : ''}. Para sync em tempo real de status, use o MCP sync_application_status.`;
        }
        if (removed > 0 || archived > 0) loadApplications();
    } catch (e) {
        if (banner) { banner.style.display = 'block'; banner.style.color = 'var(--danger)'; banner.textContent = e.message; }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Sincronizar tudo'; }
    }
}

async function syncAppStatus(appId) {
    showToast('Verificando status na plataforma…', 'info');
    try {
        // Usa link-checker para este app específico (verifica link_vaga)
        const r = await api('POST', '/api/admin/applications?__h=link-checker', { application_ids: [appId] });
        const removed = r.removed || 0;
        if (removed > 0) {
            showToast('Vaga removida da plataforma. Candidatura arquivada.', 'error');
            loadApplications();
        } else {
            showToast('Link ativo — nenhuma mudança detectada.', 'success');
        }
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Contexto evolutivo (Onda 8) ───────────────────────────
async function openContextNotes(appId) {
    const sec = document.getElementById('contextNotesSection');
    if (!sec) return;
    const isOpen = !sec.hidden && sec.dataset.appId === appId;
    if (isOpen) { sec.hidden = true; sec.dataset.appId = ''; return; }
    sec.hidden = false;
    sec.dataset.appId = appId;
    sec.innerHTML = `<div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <strong style="font-size:0.85rem"><i class="fa-solid fa-note-sticky" style="color:var(--cyan);margin-right:6px"></i>Notas de contexto</strong>
            <button class="btn btn-cyan btn-sm" style="font-size:0.72rem" onclick="openNoteForm('${appId}')"><i class="fa-solid fa-plus"></i> Nota</button>
        </div>
        <div id="notesList_${appId}"><div style="color:var(--text-dim);font-size:0.8rem">Carregando…</div></div>
        <div id="noteForm_${appId}" style="display:none;margin-top:10px"></div>
    </div>`;
    loadContextNotes(appId);
}

async function loadContextNotes(appId) {
    const el = document.getElementById(`notesList_${appId}`);
    if (!el) return;
    try {
        const notes = await api('GET', `/api/admin/applications?__h=context-notes&entity_type=application&entity_id=${appId}`);
        if (!notes?.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">Nenhuma nota. Adicione insights sobre esta candidatura.</div>'; return; }
        const impColor = { 1:'var(--text-dim)', 2:'var(--text-soft)', 3:'var(--cyan)', 4:'var(--warn,#fbbf24)', 5:'var(--danger)' };
        el.innerHTML = notes.map(n => `
            <div style="padding:7px 9px;border:1px solid var(--border);border-radius:5px;margin-bottom:5px;display:flex;align-items:flex-start;gap:8px">
                <i class="fa-solid fa-circle-dot" style="color:${impColor[n.importance]||'var(--text-dim)'};font-size:0.62rem;margin-top:3px;flex-shrink:0"></i>
                <div style="flex:1;min-width:0;font-size:0.78rem;line-height:1.5;color:var(--text)">${esc(n.note)}</div>
                <button class="btn btn-sm" style="padding:1px 6px;font-size:0.66rem;flex-shrink:0;opacity:0.6" onclick="deleteNote('${n.id}','${appId}')" title="Remover"><i class="fa-solid fa-xmark"></i></button>
            </div>`).join('');
    } catch (e) { el.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">${esc(e.message)}</div>`; }
}

function openNoteForm(appId) {
    const formEl = document.getElementById(`noteForm_${appId}`);
    if (!formEl) return;
    formEl.style.display = 'block';
    formEl.innerHTML = `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:flex-start">
        <textarea id="noteText_${appId}" class="mock-input" rows="2" maxlength="3000" style="resize:vertical;font-family:inherit;font-size:0.8rem" placeholder="Insight, red flag, comportamento do entrevistador, detalhe relevante…"></textarea>
        <div style="display:flex;flex-direction:column;gap:4px">
            <select id="noteImp_${appId}" class="mock-input" style="padding:4px 6px;font-size:0.75rem">
                <option value="1">Baixa</option>
                <option value="2" selected>Normal</option>
                <option value="3">Alta</option>
                <option value="4">Urgente</option>
                <option value="5">Crítica</option>
            </select>
            <button class="btn btn-cyan btn-sm" onclick="saveNote('${appId}')"><i class="fa-solid fa-check"></i></button>
            <button class="btn btn-sm" onclick="document.getElementById('noteForm_${appId}').style.display='none'"><i class="fa-solid fa-xmark"></i></button>
        </div>
    </div>`;
}

async function saveNote(appId) {
    const note       = document.getElementById(`noteText_${appId}`)?.value.trim();
    const importance = parseInt(document.getElementById(`noteImp_${appId}`)?.value || '2', 10);
    if (!note) { showToast('Escreva a nota antes de salvar.', 'error'); return; }
    try {
        await api('POST', '/api/admin/applications?__h=context-notes', { entity_type: 'application', entity_id: appId, note, importance });
        document.getElementById(`noteForm_${appId}`).style.display = 'none';
        showToast('Nota salva.');
        loadContextNotes(appId);
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteNote(noteId, appId) {
    try {
        await api('DELETE', `/api/admin/applications?__h=context-notes&id=${noteId}`);
        loadContextNotes(appId);
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Resumo mensal (Onda 8) ─────────────────────────────────
async function generateMonthlySummary() {
    const month = document.getElementById('summaryMonthInput')?.value;
    const btn   = document.getElementById('generateSummaryBtn');
    const el    = document.getElementById('summaryOutput');
    if (!month) { showToast('Selecione um mês.', 'error'); return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Gerando…'; }
    if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Gerando resumo com IA…</div>';
    try {
        const result = await api('POST', '/api/admin/applications?__h=context-summary', { scope: 'month', scope_ref: month });
        if (el) {
            el.innerHTML = `<div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft)">
                <div style="font-weight:600;font-size:0.9rem;margin-bottom:8px;color:var(--text)">${esc(result.title || 'Resumo')}</div>
                ${result.highlights?.length ? `<ul style="margin:0 0 10px 16px;padding:0;font-size:0.8rem;line-height:1.6">${result.highlights.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
                <div style="font-size:0.8rem;line-height:1.6;color:var(--text-soft)">${esc(result.summary_md || '').replace(/\n/g, '<br>')}</div>
                ${result.provider ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:8px">Gerado por: ${esc(result.provider)}</div>` : ''}
            </div>`;
        }
    } catch (e) {
        if (el) el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-brain"></i> Gerar resumo'; }
    }
}

// ── Entrevistas (Onda 7) ──────────────────────────────────
async function openInterviewPanel(appId) {
    const sec = document.getElementById('interviewSection');
    if (!sec) return;
    const isOpen = !sec.hidden && sec.dataset.appId === appId;
    if (isOpen) { sec.hidden = true; sec.dataset.appId = ''; return; }
    sec.hidden = false;
    sec.dataset.appId = appId;
    sec.innerHTML = `<div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <strong style="font-size:0.85rem"><i class="fa-solid fa-comments" style="color:var(--cyan);margin-right:6px"></i>Sessões de entrevista</strong>
            <button class="btn btn-cyan btn-sm" style="font-size:0.72rem" onclick="openNewInterviewForm('${appId}')"><i class="fa-solid fa-plus"></i> Nova sessão</button>
        </div>
        <div id="interviewList_${appId}"><div style="color:var(--text-dim);font-size:0.8rem">Carregando…</div></div>
        <div id="interviewForm_${appId}" style="display:none;margin-top:10px"></div>
    </div>`;
    await loadInterviewSessions(appId);
}

async function loadInterviewSessions(appId) {
    const el = document.getElementById(`interviewList_${appId}`);
    if (!el) return;
    try {
        const sessions = await api('GET', `/api/admin/applications?__h=interview-sessions&application_id=${appId}`);
        if (!sessions?.length) {
            el.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">Nenhuma sessão. Clique em "Nova sessão" para registrar.</div>';
            return;
        }
        el.innerHTML = sessions.map(s => {
            const dateStr  = s.interview_at ? new Date(s.interview_at).toLocaleString('pt-BR') : 'Data não definida';
            const analyses = s.interview_analyses || [];
            const score    = analyses[0]?.overall_score;
            const statusColor = { planned: 'var(--text-dim)', in_progress: 'var(--cyan)', done: 'var(--success)', cancelled: 'var(--danger)' }[s.status] || 'var(--text-dim)';
            return `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
                <div style="flex:1;min-width:0">
                    <div style="font-size:0.82rem;font-weight:600;color:var(--text)">${esc(s.stage_name || 'Entrevista')}</div>
                    <div style="font-size:0.75rem;color:var(--text-dim)">${dateStr}${s.interviewer_name ? ` · ${esc(s.interviewer_name)}` : ''}</div>
                    <div style="font-size:0.72rem;color:${statusColor};margin-top:2px">${s.status}</div>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                    ${score != null ? `<span style="font-size:0.8rem;font-weight:700;color:var(--cyan)">${score}/10</span>` : ''}
                    ${s.status === 'done' && !analyses.length ? `<button class="btn btn-cyan btn-sm" style="font-size:0.7rem;padding:2px 8px" onclick="openAnalyzeForm('${s.id}','${appId}')"><i class="fa-solid fa-brain"></i> Analisar</button>` : ''}
                    ${analyses.length ? `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px" onclick="openAnalysisResult('${analyses[0].id}','${s.id}','${appId}')"><i class="fa-solid fa-chart-bar"></i> Ver análise</button>` : ''}
                    <button class="btn btn-sm" style="padding:2px 8px;font-size:0.7rem" onclick="openMarkDone('${s.id}','${appId}')" title="${s.status === 'done' ? 'Editar notas' : 'Marcar como concluída'}"><i class="fa-solid fa-${s.status === 'done' ? 'pen' : 'check'}"></i></button>
                </div>
            </div>`;
        }).join('');
    } catch (e) { el.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">${esc(e.message)}</div>`; }
}

function openNewInterviewForm(appId) {
    const formEl = document.getElementById(`interviewForm_${appId}`);
    if (!formEl) return;
    formEl.style.display = 'block';
    formEl.innerHTML = `<div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <div style="font-size:0.78rem;font-weight:600;margin-bottom:8px">Nova sessão de entrevista</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div class="form-group" style="margin:0"><label style="font-size:0.72rem">Etapa</label>
                <input id="intStageName_${appId}" class="mock-input" placeholder="RH / Técnica / Gestor" maxlength="80"></div>
            <div class="form-group" style="margin:0"><label style="font-size:0.72rem">Data/hora</label>
                <input id="intDate_${appId}" class="mock-input" type="datetime-local"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div class="form-group" style="margin:0"><label style="font-size:0.72rem">Entrevistador</label>
                <input id="intName_${appId}" class="mock-input" placeholder="Nome" maxlength="100"></div>
            <div class="form-group" style="margin:0"><label style="font-size:0.72rem">E-mail</label>
                <input id="intEmail_${appId}" class="mock-input" placeholder="email@empresa.com" maxlength="120"></div>
        </div>
        <div class="form-group" style="margin:0 0 8px"><label style="font-size:0.72rem">Notas de preparação</label>
            <textarea id="intNotesBefore_${appId}" class="mock-input" rows="2" maxlength="2000" style="resize:vertical;font-family:inherit;font-size:inherit" placeholder="Pontos para estudar, perguntas para fazer…"></textarea></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" onclick="document.getElementById('interviewForm_${appId}').style.display='none'">Cancelar</button>
            <button class="btn btn-cyan btn-sm" onclick="saveInterview('${appId}')"><i class="fa-solid fa-check"></i> Salvar</button>
        </div>
    </div>`;
}

async function saveInterview(appId) {
    const stageName   = document.getElementById(`intStageName_${appId}`)?.value.trim();
    const interviewAt = document.getElementById(`intDate_${appId}`)?.value;
    const intName     = document.getElementById(`intName_${appId}`)?.value.trim();
    const intEmail    = document.getElementById(`intEmail_${appId}`)?.value.trim();
    const notesBefore = document.getElementById(`intNotesBefore_${appId}`)?.value.trim();
    try {
        await api('POST', '/api/admin/applications?__h=interview-sessions', {
            application_id: appId, stage_name: stageName || null, interview_at: interviewAt || null,
            interviewer_name: intName || null, interviewer_email: intEmail || null, notes_before: notesBefore || null,
        });
        const formEl = document.getElementById(`interviewForm_${appId}`);
        if (formEl) formEl.style.display = 'none';
        showToast('Sessão de entrevista salva.');
        loadInterviewSessions(appId);
    } catch (e) { showToast(e.message, 'error'); }
}

function openMarkDone(sessionId, appId) {
    const formEl = document.getElementById(`interviewForm_${appId}`);
    if (!formEl) return;
    formEl.style.display = 'block';
    formEl.innerHTML = `<div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <div style="font-size:0.78rem;font-weight:600;margin-bottom:8px">Registrar conclusão da entrevista</div>
        <div class="form-group" style="margin:0 0 8px"><label style="font-size:0.72rem">Notas pós-entrevista</label>
            <textarea id="notesAfter_${sessionId}" class="mock-input" rows="3" maxlength="2000" style="resize:vertical;font-family:inherit;font-size:inherit" placeholder="Como foi? Tom do entrevistador, perguntas difíceis, impressões gerais…"></textarea></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" onclick="document.getElementById('interviewForm_${appId}').style.display='none'">Cancelar</button>
            <button class="btn btn-cyan btn-sm" onclick="markInterviewDone('${sessionId}','${appId}')"><i class="fa-solid fa-check"></i> Concluir</button>
        </div>
    </div>`;
}

async function markInterviewDone(sessionId, appId) {
    const notesAfter = document.getElementById(`notesAfter_${sessionId}`)?.value.trim();
    try {
        await api('PUT', `/api/admin/applications?__h=interview-sessions&id=${sessionId}`, { status: 'done', notes_after: notesAfter || null });
        document.getElementById(`interviewForm_${appId}`).style.display = 'none';
        showToast('Entrevista marcada como concluída.');
        loadInterviewSessions(appId);
    } catch (e) { showToast(e.message, 'error'); }
}

function openAnalyzeForm(sessionId, appId) {
    const formEl = document.getElementById(`interviewForm_${appId}`);
    if (!formEl) return;
    formEl.style.display = 'block';
    formEl.innerHTML = `<div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
        <div style="font-size:0.78rem;font-weight:600;margin-bottom:8px"><i class="fa-solid fa-brain" style="color:var(--cyan);margin-right:4px"></i>Analisar com IA</div>
        <p style="font-size:0.75rem;color:var(--text-soft);margin:0 0 8px">Cole a transcrição ou escreva um resumo do que foi discutido. A IA gera pontuações e feedback.</p>
        <div class="form-group" style="margin:0 0 8px"><label style="font-size:0.72rem">Transcrição / resumo da entrevista</label>
            <textarea id="transcript_${sessionId}" class="mock-input" rows="5" maxlength="5000" style="resize:vertical;font-family:inherit;font-size:inherit" placeholder="Transcrição completa ou resumo detalhado do que foi perguntado e respondido…"></textarea></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-sm" onclick="document.getElementById('interviewForm_${appId}').style.display='none'">Cancelar</button>
            <button class="btn btn-cyan btn-sm" id="analyzeBtn_${sessionId}" onclick="runInterviewAnalysis('${sessionId}','${appId}')"><i class="fa-solid fa-brain"></i> Analisar</button>
        </div>
    </div>`;
}

async function runInterviewAnalysis(sessionId, appId) {
    const transcript = document.getElementById(`transcript_${sessionId}`)?.value.trim();
    const btn = document.getElementById(`analyzeBtn_${sessionId}`);
    if (!transcript) { showToast('Adicione a transcrição ou resumo.', 'error'); return; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Analisando…'; }
    try {
        await api('POST', '/api/admin/applications?__h=interview-analyze', { session_id: sessionId, transcript });
        document.getElementById(`interviewForm_${appId}`).style.display = 'none';
        showToast('Análise concluída! Clique em "Ver análise".', 'success');
        loadInterviewSessions(appId);
    } catch (e) {
        showToast(e.message, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-brain"></i> Analisar'; }
    }
}

async function openAnalysisResult(analysisId, sessionId, appId) {
    const formEl = document.getElementById(`interviewForm_${appId}`);
    if (!formEl) return;
    formEl.style.display = 'block';
    formEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--text-dim)">Carregando…</div>';
    try {
        const { data } = await api('GET', `/api/admin/applications?__h=interview-sessions&id=${sessionId}`);
        const analysis  = data?.interview_analyses?.[0];
        if (!analysis) { formEl.innerHTML = '<div style="color:var(--danger)">Análise não encontrada.</div>'; return; }

        const bar = (v) => v != null ? `<div style="display:inline-block;width:${Math.round(v * 10)}%;height:4px;background:var(--cyan);border-radius:2px;vertical-align:middle;margin-left:6px"></div>` : '';
        const score = (label, v) => v != null ? `<div style="display:flex;align-items:center;justify-content:space-between;font-size:0.78rem;margin-bottom:4px"><span style="color:var(--text-soft)">${label}</span><span style="font-weight:600">${v.toFixed(1)}${bar(v)}</span></div>` : '';

        formEl.innerHTML = `<div style="padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <strong style="font-size:0.85rem"><i class="fa-solid fa-chart-bar" style="color:var(--cyan);margin-right:4px"></i>Análise da entrevista</strong>
                <button class="btn btn-sm" style="font-size:0.7rem" onclick="document.getElementById('interviewForm_${appId}').style.display='none'"><i class="fa-solid fa-xmark"></i></button>
            </div>
            ${score('Geral', analysis.overall_score)}
            ${score('Comunicação', analysis.communication)}
            ${score('Técnico', analysis.technical)}
            ${score('Comportamental', analysis.behavioral)}
            ${analysis.strengths?.length ? `<div style="margin-top:8px;font-size:0.78rem"><strong style="color:var(--success)">Pontos fortes:</strong><ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem">${analysis.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
            ${analysis.improvements?.length ? `<div style="margin-top:6px;font-size:0.78rem"><strong style="color:var(--warn,#fbbf24)">Melhorias:</strong><ul style="margin:4px 0 0 16px;padding:0;font-size:0.75rem">${analysis.improvements.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
            ${analysis.full_feedback ? `<div style="margin-top:8px;font-size:0.78rem;color:var(--text-soft);line-height:1.5">${esc(analysis.full_feedback)}</div>` : ''}
            ${analysis.next_steps ? `<div style="margin-top:6px;font-size:0.78rem;padding:6px 8px;border-radius:5px;background:rgba(34,211,238,0.06);color:var(--cyan)"><i class="fa-solid fa-arrow-right" style="margin-right:4px"></i>${esc(analysis.next_steps)}</div>` : ''}
        </div>`;
    } catch (e) {
        formEl.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">${esc(e.message)}</div>`;
    }
}

// ── Quick Answers ──────────────────────────────────────────
window._quickAnswers = [];
async function renderQuickAnswersTable() {
    const el = document.getElementById('quickAnswersTable');
    if (!el) return;
    try {
        const rows = await api('GET', '/api/admin/applications?__h=quick-answers');
        window._quickAnswers = rows || [];
        if (!rows?.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhuma resposta cadastrada. Clique em "Adicionar".</div>'; return; }
        el.innerHTML = `<table class="vagas-table" style="font-size:0.8rem">
            <thead><tr><th>Slug</th><th>Nome</th><th>Valor</th><th></th></tr></thead>
            <tbody>
            ${rows.map(q => `
                <tr>
                    <td><code style="font-size:0.75rem">/${esc(q.slug)}</code></td>
                    <td>${esc(q.display_name)}</td>
                    <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(q.value)}</td>
                    <td>
                        <button class="btn btn-sm" style="padding:2px 7px;font-size:0.72rem" onclick="openEditQuickAnswer('${q.id}')"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn btn-sm" style="padding:2px 7px;font-size:0.72rem;color:var(--danger)" onclick="deleteQuickAnswer('${q.id}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>`;
    } catch (e) {
        el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`;
    }
}
function openAddQuickAnswer() {
    document.getElementById('qaEditId').value = '';
    document.getElementById('qaSlug').value = '';
    document.getElementById('qaDisplayName').value = '';
    document.getElementById('qaValue').value = '';
    document.getElementById('qaSlug').removeAttribute('readonly');
    document.getElementById('quickAnswerForm').style.display = 'block';
    document.getElementById('qaSlug').focus();
}
function openEditQuickAnswer(id) {
    const q = window._quickAnswers.find(x => x.id === id);
    if (!q) return;
    document.getElementById('qaEditId').value = id;
    document.getElementById('qaSlug').value = q.slug;
    document.getElementById('qaDisplayName').value = q.display_name;
    document.getElementById('qaValue').value = q.value;
    document.getElementById('qaSlug').setAttribute('readonly', 'readonly');
    document.getElementById('quickAnswerForm').style.display = 'block';
    document.getElementById('qaDisplayName').focus();
}
function closeQuickAnswerForm() { document.getElementById('quickAnswerForm').style.display = 'none'; }
async function saveQuickAnswer() {
    const id = document.getElementById('qaEditId').value;
    const slug = document.getElementById('qaSlug').value.trim();
    const display_name = document.getElementById('qaDisplayName').value.trim();
    const value = document.getElementById('qaValue').value.trim();
    if (!slug || !display_name || !value) { showToast('Preencha todos os campos.'); return; }
    try {
        if (id) {
            await api('PUT', `/api/admin/applications?__h=quick-answers&id=${id}`, { display_name, value });
        } else {
            await api('POST', '/api/admin/applications?__h=quick-answers', { slug, display_name, value });
        }
        closeQuickAnswerForm();
        await renderQuickAnswersTable();
        showToast('Resposta salva!');
    } catch (e) { showToast('Erro: ' + e.message); }
}
async function deleteQuickAnswer(id) {
    if (!await showConfirm('Remover resposta?', 'Isso não pode ser desfeito.', { okText: 'Remover', danger: true })) return;
    try {
        await api('DELETE', `/api/admin/applications?__h=quick-answers&id=${id}`);
        await renderQuickAnswersTable();
        showToast('Removido.');
    } catch (e) { showToast('Erro: ' + e.message); }
}

// ── Follow-up Scan ─────────────────────────────────────────
async function runFollowupScan() {
    const btn = document.getElementById('followupScanBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Escaneando…'; }
    try {
        const res = await api('POST', '/api/admin/applications?__h=followup-scan');
        showToast(`${res.created} nova${res.created !== 1 ? 's' : ''} sugestão${res.created !== 1 ? 'ões' : ''} gerada${res.created !== 1 ? 's' : ''}.`);
        await renderFollowupSuggestions();
    } catch (e) { showToast('Erro: ' + e.message); } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Escanear'; }
    }
}
async function renderFollowupSuggestions() {
    const el = document.getElementById('followupSuggestionsList');
    if (!el) return;
    try {
        const rows = await api('GET', '/api/admin/applications?__h=followup-suggestions');
        if (!rows?.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhum follow-up pendente. Candidaturas em dia!</div>'; return; }
        el.innerHTML = rows.map(s => {
            const app = s.job_applications || {};
            return `<div class="followup-card" data-followup-id="${s.id}">
                <div class="followup-header">
                    <span class="followup-company">${esc(app.empresa || '—')}</span>
                    <span class="followup-days">${s.days_idle}d parado</span>
                </div>
                <div style="font-size:0.8rem;color:var(--text-soft);margin:2px 0 6px">${esc(app.vaga || '')} · Etapa: ${esc(s.current_stage || '—')}</div>
                <div class="followup-msg" id="followup-msg-${s.id}">${esc(s.suggested_message || '')}</div>
                <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
                    <button class="btn btn-sm" style="font-size:0.72rem;color:var(--cyan)" onclick="generateFollowupMsg('${s.id}')">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Gerar com IA
                    </button>
                    <button class="btn btn-sm btn-cyan" style="font-size:0.72rem" onclick="copyFollowupMsg('${s.id}')">
                        <i class="fa-regular fa-copy"></i> Copiar
                    </button>
                    <button class="btn btn-sm" style="font-size:0.72rem" onclick="markFollowupSent('${s.id}')">
                        <i class="fa-solid fa-check"></i> Enviado
                    </button>
                    <button class="btn btn-sm" style="font-size:0.72rem;opacity:0.6" onclick="dismissFollowup('${s.id}')">
                        Dispensar
                    </button>
                </div>
            </div>`;
        }).join('');
    } catch { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Erro ao carregar.</div>'; }
}
async function generateFollowupMsg(id) {
    const card = document.querySelector(`[data-followup-id="${id}"]`) || document.getElementById('followupSuggestionsList');
    try {
        showToast('Gerando mensagem personalizada…');
        const r = await api('POST', '/api/admin/applications?__h=followup-generate', { suggestion_id: id });
        // Atualiza a mensagem exibida no card sem recarregar a lista
        const msgEl = document.getElementById(`followup-msg-${id}`);
        if (msgEl) msgEl.textContent = r.message_text || '';
        showToast('Mensagem gerada!','success');
    } catch(e) { showToast(e.message,'error'); }
}
async function copyFollowupMsg(id) {
    const msgEl = document.getElementById(`followup-msg-${id}`);
    const msg = msgEl?.textContent || '';
    await navigator.clipboard?.writeText(msg).catch(() => {});
    showToast('Mensagem copiada!');
}
async function markFollowupSent(id) {
    await api('PATCH', `/api/admin/applications?__h=followup-suggestions&id=${id}`, { status: 'sent', sent_via: 'manual' });
    await renderFollowupSuggestions();
}
async function dismissFollowup(id) {
    await api('PATCH', `/api/admin/applications?__h=followup-suggestions&id=${id}`, { status: 'dismissed' });
    await renderFollowupSuggestions();
}

// ── Calculadora CLT/PJ/MEI ─────────────────────────────────
function openCalcModal(prefillClt) {
    if (prefillClt) document.getElementById('calcCltBruto').value = prefillClt;
    document.getElementById('calcModal').classList.add('open');
    calcRun();
}
function closeCalcModal() { document.getElementById('calcModal').classList.remove('open'); }
async function calcRun() {
    const cltBruto = parseFloat(document.getElementById('calcCltBruto')?.value) || 0;
    const pjBruto  = parseFloat(document.getElementById('calcPjBruto')?.value) || 0;
    const meiBruto = parseFloat(document.getElementById('calcMeiBruto')?.value) || 0;
    const pjAliq   = parseFloat(document.getElementById('calcPjAliq')?.value) || 6;
    const cltVr    = parseFloat(document.getElementById('calcCltVr')?.value) || 0;
    const cltSaude = parseFloat(document.getElementById('calcCltSaude')?.value) || 0;

    if (!cltBruto && !pjBruto && !meiBruto) {
        document.getElementById('calcResults').innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:16px">Preencha ao menos um valor acima.</div>';
        return;
    }

    try {
        const body = {};
        if (cltBruto) body.clt = { salarioBruto: cltBruto, vr: cltVr, planoSaude: cltSaude };
        if (pjBruto)  body.pj  = { faturamentoBruto: pjBruto, aliquotaSimplesPct: pjAliq };
        if (meiBruto) body.mei = { faturamentoBruto: meiBruto };

        const res = await api('POST', '/api/admin/applications?__h=calc-liquido', body);
        const fmt = v => v != null ? `R$ ${Number(v).toLocaleString('pt-BR', {minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';

        const blocks = [];
        if (res.clt) blocks.push(calcBlock('CLT', res.clt, fmt));
        if (res.pj)  blocks.push(calcBlock('PJ', res.pj, fmt));
        if (res.mei) blocks.push(calcBlock('MEI', res.mei, fmt));

        document.getElementById('calcResults').innerHTML = `<div style="display:grid;grid-template-columns:repeat(${blocks.length},1fr);gap:10px">${blocks.join('')}</div>`;
    } catch (e) {
        document.getElementById('calcResults').innerHTML = `<div style="color:var(--danger);font-size:0.8rem">${esc(e.message)}</div>`;
    }
}
function calcBlock(regime, data, fmt) {
    const hasIndiretos = data.indiretos;
    return `<div class="calc-result-col">
        <div class="calc-result-regime">${esc(regime)}</div>
        <div class="calc-result-row"><span>Bruto</span><span>${fmt(data.bruto)}</span></div>
        ${data.inss ? `<div class="calc-result-row deduction"><span>INSS</span><span>-${fmt(data.inss)}</span></div>` : ''}
        ${data.ir   ? `<div class="calc-result-row deduction"><span>IR</span><span>-${fmt(data.ir)}</span></div>` : ''}
        ${data.simples ? `<div class="calc-result-row deduction"><span>Simples (${data.simples_pct}%)</span><span>-${fmt(data.simples)}</span></div>` : ''}
        ${data.das  ? `<div class="calc-result-row deduction"><span>DAS-MEI</span><span>-${fmt(data.das)}</span></div>` : ''}
        ${data.beneficios_diretos > 0 ? `<div class="calc-result-row benefit"><span>Benef. diretos</span><span>+${fmt(data.beneficios_diretos)}</span></div>` : ''}
        <div class="calc-result-row total"><span>Líquido efetivo</span><span>${fmt(data.total_efetivo)}</span></div>
        ${hasIndiretos ? `<div style="margin-top:6px;font-size:0.7rem;color:var(--text-dim)">
            + FGTS ${fmt(data.indiretos.fgts)} · 13º ${fmt(data.indiretos.decimoTerceiro)} · Férias ${fmt(data.indiretos.ferias)}
        </div>` : ''}
    </div>`;
}

// Atualiza hint de plataforma e limite de chars ao trocar plataforma
function onVfPlatformChange() {
    const fonte = document.getElementById('vfPlatform')?.value || '';
    const platform = (window._platformSettings || []).find(p => p.fonte === fonte);
    const hint = document.getElementById('vfMsgFieldHint');
    if (hint) {
        if (platform?.field_name) {
            hint.textContent = `Campo na plataforma: "${platform.field_name}"`;
            hint.style.display = 'block';
        } else {
            hint.style.display = 'none';
        }
    }
    updateVfCharCount();
}

function updateVfCharCount() {
    const ta = document.getElementById('vfMessageText');
    const counter = document.getElementById('vfCharCount');
    const copyBtn = document.getElementById('vfCopyMsgBtn');
    if (!ta || !counter) return;
    const len = ta.value.length;
    const fonte = document.getElementById('vfPlatform')?.value || '';
    const platform = (window._platformSettings || []).find(p => p.fonte === fonte);
    const limit = platform?.char_limit ?? 0;
    counter.textContent = limit > 0 ? `${len}/${limit}` : `${len}`;
    counter.className = 'vf-char-count' + (limit > 0 && len > limit ? ' vf-char-over' : '');
    if (copyBtn) copyBtn.style.display = ta.value.trim() ? 'inline-flex' : 'none';
}

function copyApplicationMessage() {
    const text = document.getElementById('vfMessageText')?.value || '';
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => showToast('Mensagem copiada!')).catch(() => {});
}

async function generateApplicationMessage() {
    const btn = document.getElementById('vfGenerateBtn');
    if (!btn) return;
    const empresa = document.getElementById('vfEmpresa')?.value.trim();
    const vaga    = document.getElementById('vfVaga')?.value.trim() || null;
    const fonte   = document.getElementById('vfPlatform')?.value || null;
    if (!empresa) { showToast('Preencha a empresa primeiro.'); return; }

    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Gerando…';
    btn.disabled = true;

    try {
        // Busca lead do Radar se houver origin_radar_id no app sendo editado
        const section = document.getElementById('editVagaSection') || document.getElementById('novaVagaForm');
        const leadId = section?.dataset?.radarLeadId || null;

        const result = await api('POST', '/api/admin/applications?__h=generate-message', { empresa, vaga, fonte, lead_id: leadId || undefined });

        if (result.message_text) {
            const ta = document.getElementById('vfMessageText');
            if (ta) { ta.value = result.message_text; updateVfCharCount(); }
            showToast('Mensagem gerada!');
        } else if (result.prompt) {
            // Sem LLM configurado: copia o prompt para usar manualmente no Claude/ChatGPT
            navigator.clipboard?.writeText(result.prompt).then(() =>
                showToast('LLM não configurado. Prompt copiado — cole no Claude ou ChatGPT.')
            ).catch(() => showToast('LLM não configurado. Configure LLM_API_KEY no .env'));
        }
    } catch (e) {
        showToast('Erro ao gerar: ' + e.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
}

function openNovaVaga(radarLead) {
    const existing = document.getElementById('novaVagaForm');
    if (existing && !radarLead) { existing.remove(); return; }
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'novaVagaForm';
    // Pre-popula com dados do lead do Radar se vier de promoteRadar
    const prefill = radarLead ? {
        empresa: radarLead.empresa,
        vaga: radarLead.vaga,
        link_vaga: radarLead.link_vaga,
        modalidade: radarLead.modalidade,
        tipo_contratacao: radarLead.tipo_contratacao,
        origin_radar_id: radarLead.id,
    } : null;
    wrap.innerHTML = vagaFormHTML(prefill);
    wrap.dataset.radarLeadId = radarLead?.id || '';
    document.getElementById('vagasTableWrap').before(wrap);
    document.getElementById('vfEmpresa').focus();
    _populateCvSelect(null);
    onVfPlatformChange();
}
function closeNovaVaga() {
    document.getElementById('novaVagaForm')?.remove();
}
function _collectVagaFormData() {
    return {
        empresa:          document.getElementById('vfEmpresa')?.value.trim() || '',
        vaga:             document.getElementById('vfVaga')?.value.trim() || null,
        linkedin_empresa: document.getElementById('vfLinkedin')?.value.trim() || null,
        link_vaga:        document.getElementById('vfLinkVaga')?.value.trim() || null,
        observacoes:      document.getElementById('vfObs')?.value.trim() || null,
        gestor_nome:      document.getElementById('vfGestorNome')?.value.trim() || null,
        gestor_email:     document.getElementById('vfGestorEmail')?.value.trim() || null,
        gestor_phone:     document.getElementById('vfGestorPhone')?.value.trim() || null,
        data_envio:       document.getElementById('vfDataEnvio')?.value || null,
        modalidade:       document.getElementById('vfModalidade')?.value || null,
        tipo_contratacao: document.getElementById('vfTipoContratacao')?.value || null,
        cv_version_id:    document.getElementById('vfCvVersion')?.value || null,
        platform:         document.getElementById('vfPlatform')?.value || null,
        application_message_text: document.getElementById('vfMessageText')?.value.trim() || null,
        application_message_sent: document.getElementById('vfMsgSent')?.checked || false,
    };
}

async function saveNovaVaga() {
    const msg = document.getElementById('vfMsg');
    const data = _collectVagaFormData();
    if (!data.empresa) { msg.textContent = 'Empresa é obrigatório.'; msg.hidden = false; return; }

    // N32 — Alerta de overload: >10 candidaturas nas últimas 24h
    const recent = (_applications || []).filter(a => {
        const ts = a.created_at ? new Date(a.created_at).getTime() : 0;
        return Date.now() - ts < 86400000;
    });
    if (recent.length >= 10) {
        const overloadOk = await showConfirm('Muitas candidaturas hoje', `Você já aplicou ${recent.length} vezes nas últimas 24h. Candidaturas em quantidade podem reduzir a qualidade das mensagens.\n\nDeseja criar mesmo assim?`, { okText: 'Criar mesmo assim', danger: false });
        if (!overloadOk) return;
    }

    try {
        await api('POST', '/api/admin/applications', data);
        closeNovaVaga();
        await loadApplications();
        showToast('Candidatura criada.');
    } catch (e) {
        msg.textContent = e.message;
        msg.hidden = false;
    }
}

function openEditVaga(appId) {
    const section = document.getElementById('editVagaSection');
    if (!section.hidden) { section.hidden = true; return; }
    const app = _applications.find(a => a.id === appId);
    if (!app) return;
    // Fecha o stage manager se estiver aberto
    const smSection = document.getElementById('stageManagerSection');
    if (_stageManagerOpen) {
        smSection.hidden = true;
        _stageManagerOpen = false;
        _sortableInst = null;
        _undoStack = [];
        _redoStack = [];
    }
    section.innerHTML = vagaFormHTML(app);
    section.dataset.radarLeadId = app?.origin_radar_id || '';
    section.hidden = false;
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    _populateCvSelect(app);
    onVfPlatformChange();
}
function closeEditVaga() {
    document.getElementById('editVagaSection').hidden = true;
}
async function saveEditVaga(appId) {
    const msg = document.getElementById('vfMsg');
    const data = _collectVagaFormData();
    if (!data.empresa) { msg.textContent = 'Empresa é obrigatório.'; msg.hidden = false; return; }
    try {
        const updated = await api('PUT', `/api/admin/applications?id=${appId}`, data);
        const idx = _applications.findIndex(a => a.id === appId);
        if (idx !== -1) _applications[idx] = updated;
        renderDrawerBody(updated);
        renderApplicationsTable();
        showToast('Candidatura atualizada.');
    } catch (e) {
        msg.textContent = e.message;
        msg.hidden = false;
    }
}

// ─── CVs UPLOAD ACCORDION ────────────────────────────────
function toggleCvsUpload() {
    const btn = document.getElementById('cvsUploadToggleBtn');
    const panel = document.getElementById('cvsUploadCollapsible');
    const open = panel.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ─── TOKENS FORM ACCORDION ───────────────────────────────
function toggleTokenForm() {
    const btn = document.getElementById('tokenFormToggleBtn');
    const panel = document.getElementById('tokenFormCollapsible');
    const open = panel.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ─── CUSTOM SELECT ────────────────────────────────────────
function toggleCustomSelect(btn) {
    const wrap = btn.closest('.custom-select');
    const isOpen = !wrap.classList.contains('open');
    document.querySelectorAll('.custom-select.open').forEach(s => {
        s.classList.remove('open');
        s.querySelector('.custom-select-btn')?.setAttribute('aria-expanded', 'false');
    });
    if (isOpen) {
        wrap.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
    }
}

function selectCustomOption(opt) {
    const wrap = opt.closest('.custom-select');
    wrap.dataset.value = opt.dataset.value;
    wrap.querySelector('.custom-select-label').textContent = opt.textContent;
    wrap.querySelectorAll('.custom-select-option').forEach(o => o.classList.toggle('active', o === opt));
    wrap.classList.remove('open');
    wrap.querySelector('.custom-select-btn')?.setAttribute('aria-expanded', 'false');
    const cb = wrap.dataset.onchange;
    if (cb && window[cb]) window[cb]();
}

function _resetCustomSelect(id) {
    const wrap = document.getElementById(id);
    if (!wrap?.classList.contains('custom-select')) return;
    wrap.dataset.value = '';
    const opts = wrap.querySelectorAll('.custom-select-option');
    if (opts.length) {
        wrap.querySelector('.custom-select-label').textContent = opts[0].textContent;
        opts.forEach((o, i) => o.classList.toggle('active', i === 0));
    }
}

document.addEventListener('click', e => {
    if (!e.target.closest('.custom-select')) {
        document.querySelectorAll('.custom-select.open').forEach(s => {
            s.classList.remove('open');
            s.querySelector('.custom-select-btn')?.setAttribute('aria-expanded', 'false');
        });
    }
    if (!e.target.closest('#maisMenu') && !e.target.closest('.mobile-nav-mais')) {
        toggleMaisMenu(false);
    }
});

// ─── TABS ─────────────────────────────────────────────────
function switchTab(name) {
    // Guard: aba inexistente ou bloqueada no demo
    if (!ADMIN_TABS.some(t => t.key === name)) return;
    const _enabled = window.ADMIN_CONFIG?.enabledTabs;
    if (Array.isArray(_enabled) && _enabled.length > 0 && !_enabled.includes(name)) return;

    // Fecha modais abertos: permite que bottom-nav funcione mesmo com modal visível
    ['sendCvModal','editCvModal','forgotModal','shareModal','confirmModal','promptModal','kpiDetailModal']
        .forEach(id => { const m = document.getElementById(id); if (m && !m.hidden) m.hidden = true; });
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    const vagasOverlay = document.getElementById('vagasOverlay');
    if (vagasOverlay) vagasOverlay.classList.remove('open');
    const logDrawerOverlay = document.getElementById('logDrawerOverlay');
    if (logDrawerOverlay) logDrawerOverlay.classList.remove('open');

    // Fecha painel "Mais" e sincroniza estado do botão
    toggleMaisMenu(false);
    const _maisBtn = document.querySelector('.mobile-nav-mais');
    if (_maisBtn) _maisBtn.classList.toggle('active', ADMIN_TABS.filter(t => t.mobileOverflow).some(t => t.key === name));

    // Sair de Vagas com modo de seleção ativo: desliga e remove a bulk bar flutuante
    if (name !== 'vagas' && typeof _vagasSelecting !== 'undefined' && _vagasSelecting) {
        toggleVagasSelectMode();
    }
    // Sair de Tokens com modo de seleção ativo
    if (name !== 'tokens' && typeof _tokenSelecting !== 'undefined' && _tokenSelecting) {
        toggleTokenSelectMode();
    }

    _activeTab = name;
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-${name}`).classList.add('active');
    document.querySelectorAll(`[data-tab="${name}"]`).forEach(b => b.classList.add('active'));

    if (name === 'cvs') loadCVs();
    if (name === 'tokens') { loadCVs(); loadTokens(); }
    if (name === 'logs') { loadLogs(); loadLogKpis(); }
    if (name === 'vagas') loadApplications();
    if (name === 'radar') loadRadar();
    if (name === 'metricas') { loadAnalytics(); loadLoginAttempts(); }
    if (name === 'seguranca') { loadSessions(); loadDemoSettings(); }
    if (name === 'config') loadConfigTab();
    if (name === 'inbox') loadInbox();
    if (name === 'rede') loadRede();
    if (name === 'diario') loadJournal();
    if (name === 'tendencias') { loadTrends(); loadCareerPaths(); loadWatchlist(); }
    _scheduleRefresh();
}

// ─── LOAD ALL ─────────────────────────────────────────────
function loadAll() {
    // Renderiza as abas (fonte única em ADMIN_TABS) antes de qualquer switchTab.
    renderAdminTabs();

    // Carrega a aba inicial (CVs) + stats; pré-carrega demais abas em background.
    loadCVs();
    loadStorageStats();
    loadPlatformSettings();
    detectReplyContext();
    _lastRefreshAt = Date.now();
    _scheduleRefresh();
    setTimeout(() => {
        loadTokens().catch(() => {});
        loadApplications().catch(() => {});
    }, 500);
    // N30 — Detecção automática de pausa (14 dias sem atividade)
    setTimeout(_checkAutoPause, 3000);
}

async function _checkAutoPause() {
    try {
        const [notifRes, appsRes] = await Promise.allSettled([
            apiFetch('/api/admin/applications?__h=notification-settings'),
            apiFetch('/api/admin/applications'),
        ]);
        const notifSettings = notifRes.status === 'fulfilled' ? (notifRes.value?.settings || {}) : {};
        if (notifSettings.pause_mode) return; // já em modo pausa
        const apps = appsRes.status === 'fulfilled' ? (appsRes.value?.applications || appsRes.value || []) : [];
        if (!Array.isArray(apps) || !apps.length) return;
        const sorted = [...apps].sort((a,b) => new Date(b.updated_at||b.created_at) - new Date(a.updated_at||a.created_at));
        const lastActivity = sorted[0]?.updated_at || sorted[0]?.created_at;
        if (!lastActivity) return;
        const daysSince = (Date.now() - new Date(lastActivity).getTime()) / 86400000;
        if (daysSince < 14) return;
        const key = `_pausePrompted_${lastActivity.slice(0,10)}`;
        if (sessionStorage.getItem(key)) return; // já mostrou nesta sessão
        sessionStorage.setItem(key, '1');
        const activate = await showConfirm('Modo Pausa Profissional', `Faz ${Math.floor(daysSince)} dias sem atividade. Deseja ativar o Modo Pausa Profissional? Isso suspende buscas automáticas, alertas e notificações leves enquanto você está fora.`, { okText: 'Ativar pausa', danger: false });
        if (activate) {
            await apiFetch('/api/admin/applications?__h=notification-settings', {
                method: 'PUT',
                body: JSON.stringify({ settings: { ...notifSettings, pause_mode: true } })
            });
            showToast('Modo pausa ativado. Reative quando quiser retomar.', 'success');
        }
    } catch { /* silencioso */ }
}

// ─── STORAGE STATS ────────────────────────────────────────
let _storageAlertShown = false;
function _timeAgo(iso) {
    if (!iso) return '';
    const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (diff < 60)   return 'agora';
    if (diff < 3600) return `há ${Math.floor(diff / 60)}min`;
    if (diff < 86400) return `há ${Math.floor(diff / 3600)}h`;
    return `há ${Math.floor(diff / 86400)}d`;
}

function fmtBytes(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
async function loadStorageStats() {
    try {
        const s = await api('GET', '/api/admin/storage-stats');
        const card = document.getElementById('storageCard');
        const fill = document.getElementById('storageBarFill');
        const pct = Math.min(100, s.used_percent);

        card.hidden = false;
        document.getElementById('storageSub').textContent = `bucket "${s.bucket}" · ${fmtBytes(s.used_bytes)} de ${fmtBytes(s.limit_bytes)}`;
        fill.style.width = pct + '%';
        fill.classList.remove('warn', 'danger');
        if (pct >= 80) fill.classList.add('danger');
        else if (pct >= 60) fill.classList.add('warn');

        document.getElementById('storagePct').textContent = pct.toFixed(1) + '% usado';
        document.getElementById('storageFiles').textContent = `${s.files_count} arquivo${s.files_count === 1 ? '' : 's'}`;

        const dashLink = document.getElementById('storageDashLink');
        if (s.dashboard_url) {
            dashLink.href = s.dashboard_url;
            dashLink.hidden = false;
        }

        document.getElementById('storageAlert').hidden = !s.should_alert;
        if (s.should_alert && !_storageAlertShown) {
            showToast(`⚠ Storage em ${pct.toFixed(1)}% — quase no limite. Faça limpeza ou upgrade.`, 'error');
            _storageAlertShown = true;
        }
    } catch (e) {
        // Silencioso — endpoint pode não existir em dev sem migration
        console.warn('Storage stats indisponível:', e.message);
    }
}

// ─── REPLY BANNER (vindo do email do recrutador) ─────────
function detectReplyContext() {
    const params = new URLSearchParams(location.search);
    const name    = params.get('to_name')?.trim();
    const email   = params.get('to_email')?.trim();
    const company = params.get('to_company')?.trim();
    const role    = params.get('to_role')?.trim();
    if (!name || !email) return;

    _pendingReply = { name, email, company: company || '', role: role || '' };
    document.getElementById('rbName').textContent = name;
    document.getElementById('rbEmail').textContent = email;
    if (company) {
        document.getElementById('rbCompany').textContent = company;
        document.getElementById('rbCompanyWrap').style.display = '';
    } else {
        document.getElementById('rbCompanyWrap').style.display = 'none';
    }
    if (role) {
        document.getElementById('rbRole').textContent = role;
        document.getElementById('rbRoleWrap').style.display = '';
    } else {
        document.getElementById('rbRoleWrap').style.display = 'none';
    }
    document.getElementById('replyBanner').hidden = false;

    // Garante que está na aba de Currículos
    const cvTabBtn = document.querySelector('.tab-btn[onclick*="cvs"]');
    if (cvTabBtn) cvTabBtn.click();
}

function dismissReply() {
    _pendingReply = null;
    document.getElementById('replyBanner').hidden = true;
    // Limpa a URL pra não reativar em refresh
    if (location.search) history.replaceState(null, '', location.pathname);
}

function startReply() {
    // Se só houver 1 versão ativa, abre o modal direto. Senão, scroll pra tabela e dá feedback visual.
    api('GET', '/api/admin/cv-versions?limit=100&status=ativo').then(active => {
        if (active.length === 1) {
            const cv = active[0];
            openSendCV({ id: cv.id, name: cv.name, file_name: cv.file_name });
        } else if (active.length === 0) {
            showToast('Nenhuma versão ativa. Suba um CV primeiro.', 'error');
        } else {
            // Várias versões: scroll pra tabela e pisca os botões de envio
            document.getElementById('cvTable').scrollIntoView({ behavior: 'smooth', block: 'center' });
            const btns = document.querySelectorAll('#cvTable .btn.btn-cyan.btn-sm');
            btns.forEach(b => {
                b.style.transition = 'box-shadow 0.6s';
                b.style.boxShadow = '0 0 0 3px rgba(34, 211, 238, 0.5)';
                setTimeout(() => b.style.boxShadow = '', 1800);
            });
            showToast(`Escolha qual versão enviar para ${_pendingReply.name}.`);
        }
    }).catch(e => showToast(e.message, 'error'));
}

async function _refreshCvSelect() {
    try {
        const data = await api('GET', '/api/admin/cv-versions?limit=100&status=ativo');
        const sel = document.getElementById('tokenCV');
        const cur = sel?.value;
        if (!sel) return;
        sel.innerHTML = '<option value="">Selecione…</option>' + data.map(cv =>
            `<option value="${cv.id}">${esc(cv.name)}</option>`
        ).join('');
        if (cur) sel.value = cur;
    } catch (_) {}
}

// ─── CVS ──────────────────────────────────────────────────
async function loadCVs() {
    if (_cvData.length) renderCVs();
    try {
        const data = await api('GET', '/api/admin/cv-versions');
        _cvData = data;
        renderCVs();
        _refreshCvSelect();
    } catch (e) {
        if (!_cvData.length) showToast(e.message, 'error');
    }
}

function renderCVs() {
    updateSortHeaders('cvs');

    const tbody = document.getElementById('cvTable');
    const countEl = document.getElementById('cvCount');

    const search = (document.getElementById('cvSearch')?.value || '').toLowerCase();
    const status = document.getElementById('cvStatusFilter')?.dataset.value || '';

    let data = _cvData;
    if (search) data = data.filter(cv =>
        (cv.name || '').toLowerCase().includes(search) ||
        (cv.description || '').toLowerCase().includes(search) ||
        (cv.file_name || '').toLowerCase().includes(search)
    );
    if (status === 'ativo')   data = data.filter(cv => cv.active);
    if (status === 'inativo') data = data.filter(cv => !cv.active);
    data = _sortData(data, _cvSort.col, _cvSort.dir);

    if (countEl) countEl.textContent = _cvData.length
        ? (data.length !== _cvData.length ? `${data.length} de ${_cvData.length}` : `${_cvData.length} registros`)
        : '';

    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:32px">Nenhum currículo encontrado</td></tr>`;
        return;
    }
    tbody.innerHTML = data.map(cv => `
        <tr>
            <td data-label="Nome"><span><strong style="color:var(--text)">${esc(cv.name)}</strong>${cv.description ? `<br><small style="color:var(--text-dim)">${esc(cv.description)}</small>` : ''}</span></td>
            <td data-label="Arquivo"><span style="font-family:var(--font-mono);font-size:0.78rem">${esc(cv.file_name)}</span></td>
            <td data-label="Status"><span class="badge ${cv.active ? 'badge-active' : 'badge-esgotado'}">${cv.active ? '● ativo' : '○ inativo'}</span></td>
            <td data-label="Adicionado">${fmtDate(cv.created_at)}</td>
            <td>
                <div class="row-actions">
                    <button class="btn btn-sm cv-action-btn" onclick="previewCV('${cv.id}', '${esc(cv.name)}')" title="Pré-visualizar PDF"><i class="fa-solid fa-eye"></i></button>
                    <button class="btn btn-sm cv-action-btn" onclick="downloadCV('${cv.id}')" title="Baixar PDF"><i class="fa-solid fa-download"></i></button>
                    <button class="btn btn-cyan btn-sm cv-action-btn" onclick='openSendCV(${JSON.stringify({ id: cv.id, name: cv.name, file_name: cv.file_name })})' title="Enviar agora"><i class="fa-solid fa-paper-plane"></i><span class="cv-btn-lbl">Enviar</span></button>
                    <button class="btn btn-sm cv-action-btn" onclick='openEditCV(${JSON.stringify({ id: cv.id, name: cv.name, file_name: cv.file_name || '', description: cv.description || '', active: cv.active })})' title="Editar"><i class="fa-solid fa-pen"></i><span class="cv-btn-lbl">Editar</span></button>
                    <button class="btn btn-danger btn-sm" onclick="deleteCV('${cv.id}', '${esc(cv.name)}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>
    `).join('');
}

function clearCvFilters() {
    const s = document.getElementById('cvSearch'); if (s) s.value = '';
    _resetCustomSelect('cvStatusFilter');
    _cvSort = { col: 'created_at', dir: 'desc' };
    renderCVs();
}

async function deleteCV(id, name) {
    if (!await showConfirm(`Excluir "${name}"?`, 'Os tokens associados serão apagados.', { okText: 'Excluir' })) return;
    try {
        await api('DELETE', `/api/admin/cv-versions?id=${id}`);
        showToast('Currículo excluído');
        loadCVs();
        loadStorageStats();
    } catch (e) { showToast(e.message, 'error'); }
}

// ─── UPLOAD ───────────────────────────────────────────────

// Espelha api/_lib/filename.js — mantém em sync se mexer um, mexer o outro.
function normalizeFileNameClient(input) {
    if (!input || typeof input !== 'string') return 'arquivo.pdf';
    let clean = input.trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const dotIdx = clean.lastIndexOf('.');
    let base = dotIdx > 0 ? clean.slice(0, dotIdx) : clean;
    let ext = (dotIdx > 0 ? clean.slice(dotIdx) : '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (ext !== '.pdf') ext = '.pdf';
    base = base
        .replace(/[^a-zA-Z0-9.]+/g, '_')   // preserva pontos (v1.4 fica legível)
        .replace(/\.+/g, '.')              // colapsa pontos duplicados
        .replace(/^[._]+|[._]+$/g, '');    // limpa pontas
    if (!base) base = 'arquivo';
    if (base.length > 200) base = base.slice(0, 200).replace(/[._]+$/, '');
    return base + ext;
}

function updateFileNamePreview() {
    const input = document.getElementById('cvFileName');
    const preview = document.getElementById('cvFileNamePreview');
    if (!input.value.trim()) { preview.textContent = ''; return; }
    const normalized = normalizeFileNameClient(input.value);
    if (normalized !== input.value.trim()) {
        preview.textContent = `Será salvo como: ${normalized}`;
        preview.style.color = 'var(--cyan)';
    } else {
        preview.textContent = '✓ Nome já está padronizado';
        preview.style.color = 'var(--success)';
    }
}

function onFileSelect(input) {
    const file = input.files[0];
    if (!file) return;
    selectedFile = file;
    document.getElementById('uploadFileName').textContent = file.name;
    if (!document.getElementById('cvFileName').value) {
        document.getElementById('cvFileName').value = file.name;
    }
    updateFileNamePreview();
}

document.getElementById('cvFileName')?.addEventListener('input', updateFileNamePreview);

const uploadZone = document.getElementById('uploadZone');
uploadZone?.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone?.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') {
        selectedFile = file;
        document.getElementById('uploadFileName').textContent = file.name;
        if (!document.getElementById('cvFileName').value) document.getElementById('cvFileName').value = file.name;
        updateFileNamePreview();
    } else {
        showToast('Apenas arquivos PDF são aceitos', 'error');
    }
});

async function uploadCV() {
    const name = document.getElementById('cvName').value.trim();
    const desc = document.getElementById('cvDesc').value.trim();
    const fileName = document.getElementById('cvFileName').value.trim();

    if (!name) return showToast('Nome da versão obrigatório', 'error');
    if (!fileName) return showToast('Nome do arquivo obrigatório', 'error');
    if (!selectedFile) return showToast('Selecione um arquivo PDF', 'error');

    const progress = document.getElementById('uploadProgress');
    progress.style.display = 'block';

    try {
        // Fase 1: gera URL assinada de upload (rápido, indeterminate)
        setUploadPhase('Preparando upload…', 'indeterminate');
        const { signedUrl, filePath } = await api('POST', '/api/admin/cv-storage-url', { fileName: selectedFile.name });

        // Fase 2: upload do PDF com progresso real (XHR)
        setUploadPhase('Enviando arquivo…', 'progress', 0);
        await uploadWithProgress(signedUrl, selectedFile, p => {
            setUploadPhase('Enviando arquivo…', 'progress', p);
        });

        // Fase 3: registra no banco (rápido, indeterminate)
        setUploadPhase('Registrando no banco…', 'indeterminate');
        await api('POST', '/api/admin/cv-versions', { name, description: desc, file_path: filePath, file_name: fileName });

        // Fase 4: concluído
        setUploadPhase('Concluído ✓', 'progress', 1);
        setTimeout(() => {
            progress.style.display = 'none';
            setUploadPhase('Preparando…', 'progress', 0);
        }, 1200);

        // Reset form
        selectedFile = null;
        document.getElementById('cvName').value = '';
        document.getElementById('cvDesc').value = '';
        document.getElementById('cvFileName').value = '';
        document.getElementById('uploadFileName').textContent = '';
        document.getElementById('fileInput').value = '';

        showToast('Currículo enviado com sucesso!');
        loadCVs();
        loadStorageStats();
    } catch (e) {
        progress.style.display = 'none';
        showToast(e.message, 'error');
    }
}

// ─── TOKENS ───────────────────────────────────────────────
function setExpiry(btn) {
    document.querySelectorAll('.expiry-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const h = btn.dataset.hours;
    currentExpiryHours = h === 'custom' ? 'custom' : Number(h);
    document.getElementById('expiryDate').style.display = h === 'custom' ? 'block' : 'none';
}

async function createToken() {
    const cv_version_id = document.getElementById('tokenCV').value;
    const label = document.getElementById('tokenLabel').value.trim();
    const max_uses = document.getElementById('tokenMaxUses').value || null;

    if (!cv_version_id) return showToast('Selecione um currículo', 'error');

    let body = { cv_version_id, label: label || null, max_uses: max_uses ? Number(max_uses) : null };

    if (currentExpiryHours === 'custom') {
        const dt = document.getElementById('expiryDate').value;
        if (!dt) return showToast('Selecione a data de expiração', 'error');
        body.expires_at_date = dt;
    } else {
        body.expires_in_hours = currentExpiryHours;
    }

    try {
        const data = await api('POST', '/api/admin/tokens', body);
        openShareModal(data);
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

async function loadTokens() {
    if (_tokenData.length) renderTokens();
    try {
        const [data] = await Promise.all([
            api('GET', '/api/admin/tokens'),
            _refreshCvSelect(),
        ]);
        _tokenData = data;
        renderTokens();
    } catch (e) {
        if (!_tokenData.length) showToast(e.message, 'error');
    }
}

// Estado de seleção em lote de tokens
let _tokenSelecting = false;
let _tokenSelected = new Set();
let _tokenFilteredData = []; // última lista filtrada renderizada

function _tokenEffectiveStatus(t) {
    if (t.status !== 'ativo') return t.status;
    const exp = new Date(t.expires_at).getTime();
    if (!isNaN(exp) && exp > Date.now() && exp - Date.now() < 24 * 3600 * 1000) return 'expirando';
    return 'ativo';
}

function renderTokens() {
    updateSortHeaders('tokens');

    const tbody = document.getElementById('tokenTable');
    const countEl = document.getElementById('tokenCount');

    const search = (document.getElementById('tokenSearch')?.value || '').toLowerCase();
    const status = document.getElementById('tokenStatusFilter')?.dataset.value || '';

    let data = _tokenData;
    if (search) data = data.filter(t =>
        (t.label || '').toLowerCase().includes(search) ||
        (t.cv_versions?.name || '').toLowerCase().includes(search)
    );
    if (status) {
        if (status === 'expirando') {
            data = data.filter(t => _tokenEffectiveStatus(t) === 'expirando');
        } else {
            data = data.filter(t => t.status === status);
        }
    }
    data = _sortData(data, _tokenSort.col, _tokenSort.dir);
    _tokenFilteredData = data;

    if (countEl) countEl.textContent = _tokenData.length
        ? (data.length !== _tokenData.length ? `${data.length} de ${_tokenData.length}` : `${_tokenData.length} registros`)
        : '';

    updateTokenKpis();

    if (!data.length) {
        const emptyMsg = _tokenData.length ? 'Nenhum token encontrado' : 'Nenhum token criado ainda';
        const emptyIcon = _tokenData.length ? 'fa-filter' : 'fa-key';
        tbody.innerHTML = `<tr><td colspan="${_tokenSelecting ? 7 : 6}" style="text-align:center;color:var(--text-dim);padding:40px">
            <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
                <i class="fa-solid ${emptyIcon}" style="font-size:1.4rem;opacity:0.3"></i>
                <span>${emptyMsg}</span>
                ${!_tokenData.length ? '<button class="btn btn-sm btn-cyan" onclick="document.getElementById(\'tokenFormToggleBtn\')?.click()||document.getElementById(\'tokenCV\')?.focus()" style="margin-top:4px"><i class="fa-solid fa-plus"></i> Criar token</button>' : ''}
            </div>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = data.map(t => {
        const effStatus = _tokenEffectiveStatus(t);
        const badgeCls = effStatus === 'ativo' ? 'badge-active'
                       : effStatus === 'expirando' ? 'badge-expiring'
                       : effStatus === 'expirado'  ? 'badge-expired'
                       : effStatus === 'revogado'  ? 'badge-revoked'
                       : 'badge-esgotado';
        const badgeLabel = effStatus === 'expirando' ? '⚡ expirando' : `● ${t.status}`;
        const uses = t.max_uses ? `${t.use_count}/${t.max_uses}` : `${t.use_count} / ∞`;
        const expRel  = _relTime(t.expires_at);
        const expAbs  = fmtDate(t.expires_at);
        const checked = _tokenSelected.has(t.id) ? 'checked' : '';

        const tokenPath = `/cv?t=${t.id}`;
        const fullLink  = `${location.origin}${tokenPath}`;

        return `
            <tr class="${_tokenSelected.has(t.id) ? 'token-row-selected' : ''}" style="cursor:pointer" onclick="openTokenDrawer(${JSON.stringify(t).replace(/"/g,'&quot;')})">
                ${_tokenSelecting ? `<td onclick="event.stopPropagation()" style="width:36px;padding-right:4px">
                    <input type="checkbox" ${checked} onchange="toggleTokenSelect('${t.id}',this)" aria-label="Selecionar token ${esc(t.label||'(sem label)')}" style="accent-color:var(--cyan);cursor:pointer">
                </td>` : ''}
                <td data-label="Label"><span><strong style="color:var(--text)">${esc(t.label || '(sem label)')}</strong></span></td>
                <td data-label="Currículo" style="color:var(--text-soft)">${esc(t.cv_versions?.name || '—')}</td>
                <td data-label="Status"><span class="badge ${badgeCls}">${badgeLabel}</span></td>
                <td data-label="Usos" style="font-family:var(--font-mono);font-size:0.8rem">${uses}</td>
                <td data-label="Expira" style="font-size:0.8rem" title="${expAbs}">${expRel}</td>
                <td onclick="event.stopPropagation()">
                    <div class="row-actions">
                        <button class="btn btn-sm" onclick="copyTokenLink('${fullLink}')" title="Copiar link" aria-label="Copiar link do token"><i class="fa-solid fa-copy"></i></button>
                        <button class="btn btn-sm" onclick="regenerateToken(${JSON.stringify(t).replace(/"/g,'&quot;')})" title="Regenerar (criar cópia)" aria-label="Criar cópia deste token"><i class="fa-solid fa-rotate"></i></button>
                        ${effStatus === 'ativo' || effStatus === 'expirando' ? `<button class="btn btn-sm" onclick="revokeToken('${t.id}')" title="Revogar" aria-label="Revogar token"><i class="fa-solid fa-ban"></i></button>` : ''}
                        <button class="btn btn-danger btn-sm" onclick="confirmDeleteToken('${t.id}', '${esc(t.label || '(sem label)')}')" title="Excluir" aria-label="Excluir token"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function clearTokenFilters() {
    const s = document.getElementById('tokenSearch'); if (s) s.value = '';
    _resetCustomSelect('tokenStatusFilter');
    _tokenSort = { col: 'expires_at', dir: 'asc' };
    // Reset preset chips
    document.querySelectorAll('#tokenPresetChips .preset-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.preset === '');
        c.setAttribute('aria-pressed', c.dataset.preset === '' ? 'true' : 'false');
    });
    renderTokens();
}

async function revokeToken(id) {
    if (!await showConfirm('Revogar token?', 'O link deixará de funcionar imediatamente.', { okText: 'Revogar' })) return;
    try {
        await api('PATCH', `/api/admin/tokens?id=${id}`);
        showToast('Token revogado');
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

async function confirmDeleteToken(id, label) {
    if (!await showConfirm(`Excluir token "${label}"?`, 'Esta ação remove o token permanentemente — perde-se o histórico de associação.\nOs logs de download ficam preservados.', { okText: 'Excluir' })) return;
    try {
        await api('DELETE', `/api/admin/tokens?id=${id}`);
        showToast('Token excluído');
        _tokenSelected.delete(id);
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

// Alias para compatibilidade com chamadas existentes
const deleteToken = confirmDeleteToken;

// ─── TOKEN KPIS & FILTROS ──────────────────────────────────

function updateTokenKpis() {
    const counts = { ativo: 0, expirando: 0, expirado: 0, revogado: 0, esgotado: 0 };
    (_tokenData || []).forEach(t => {
        const s = _tokenEffectiveStatus(t);
        if (s in counts) counts[s]++;
    });
    const ids = { ativo: 'kpiTokenAtivo', expirando: 'kpiTokenExpirando', expirado: 'kpiTokenExpirado', revogado: 'kpiTokenRevogado', esgotado: 'kpiTokenEsgotado' };
    Object.entries(ids).forEach(([k, id]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = counts[k];
    });
}

function filterTokenKpi(status) {
    const sel = document.getElementById('tokenStatusFilter');
    const current = sel?.value;
    const next = current === status ? '' : status;
    if (sel) sel.value = next;
    // Sync preset chips
    document.querySelectorAll('#tokenPresetChips .preset-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.preset === next);
        c.setAttribute('aria-pressed', c.dataset.preset === next ? 'true' : 'false');
    });
    // Highlight active KPI card
    document.querySelectorAll('#tokenKpis .tab-kpi-card').forEach(c => c.classList.remove('kpi-selected'));
    if (next) {
        const map = { ativo: 'kpi-green', expirando: 'kpi-yellow', expirado: 'kpi-dim', revogado: 'kpi-red', esgotado: 'kpi-dim' };
        const card = document.querySelector(`#tokenKpis .tab-kpi-card.${map[next]}`);
        if (card) card.classList.add('kpi-selected');
    }
    renderTokens();
}

function applyTokenPreset(preset, btn) {
    const sel = document.getElementById('tokenStatusFilter');
    if (sel) sel.value = preset;
    document.querySelectorAll('#tokenPresetChips .preset-chip').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
    });
    if (btn) { btn.classList.add('active'); btn.setAttribute('aria-pressed', 'true'); }
    renderTokens();
}

// ─── TOKEN SELEÇÃO EM LOTE ────────────────────────────────

function toggleTokenSelectMode() {
    _tokenSelecting = !_tokenSelecting;
    _tokenSelected.clear();
    const btn = document.getElementById('tokenSelectBtn');
    if (btn) btn.classList.toggle('active', _tokenSelecting);
    const th = document.getElementById('tokenSelectAllTh');
    if (th) th.style.display = _tokenSelecting ? '' : 'none';
    const all = document.getElementById('tokenSelectAll');
    if (all) { all.checked = false; all.indeterminate = false; }
    renderTokens();
    _updateTokenBulkBar();
}

function toggleTokenSelect(id, checkbox) {
    if (checkbox.checked) _tokenSelected.add(id);
    else _tokenSelected.delete(id);
    // Atualiza visual da linha
    const row = checkbox.closest('tr');
    if (row) row.classList.toggle('token-row-selected', checkbox.checked);
    _updateTokenBulkBar();
    // Atualiza checkbox-mestre
    const all = document.getElementById('tokenSelectAll');
    if (all) {
        const visibleIds = _tokenFilteredData.map(t => t.id);
        const selectedVisible = visibleIds.filter(id => _tokenSelected.has(id));
        all.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
        all.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    }
}

function toggleSelectAllTokens(checkbox) {
    const visibleIds = _tokenFilteredData.map(t => t.id);
    if (checkbox.checked) visibleIds.forEach(id => _tokenSelected.add(id));
    else visibleIds.forEach(id => _tokenSelected.delete(id));
    renderTokens();
    _updateTokenBulkBar();
}

function _updateTokenBulkBar() {
    const bar = document.getElementById('token-bulk-bar');
    const countEl = document.getElementById('tokenBulkCount');
    if (!bar) return;
    const n = _tokenSelected.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    if (countEl) countEl.textContent = `${n} selecionado${n !== 1 ? 's' : ''}`;
}

function clearTokenSelection() {
    _tokenSelected.clear();
    renderTokens();
    _updateTokenBulkBar();
}

async function revokeTokensBulk() {
    const ids = [..._tokenSelected];
    const ativoIds = ids.filter(id => {
        const t = _tokenData.find(x => x.id === id);
        return t && (t.status === 'ativo');
    });
    if (!ativoIds.length) return showToast('Nenhum token ativo selecionado', 'error');
    if (!await showConfirm(`Revogar ${ativoIds.length} token(s)?`, 'Os links deixarão de funcionar imediatamente.', { okText: 'Revogar' })) return;
    try {
        await Promise.all(ativoIds.map(id => api('PATCH', `/api/admin/tokens?id=${id}`)));
        showToast(`${ativoIds.length} token(s) revogado(s)`);
        clearTokenSelection();
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteTokensBulk() {
    const ids = [..._tokenSelected];
    if (!ids.length) return;
    if (!await showConfirm(`Excluir ${ids.length} token(s)?`, 'Esta ação é permanente. Os logs de download ficam preservados.', { okText: 'Excluir' })) return;
    try {
        await Promise.all(ids.map(id => api('DELETE', `/api/admin/tokens?id=${id}`)));
        showToast(`${ids.length} token(s) excluído(s)`);
        clearTokenSelection();
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

async function extendTokensBulk() {
    const ids = [..._tokenSelected];
    const ativoIds = ids.filter(id => {
        const t = _tokenData.find(x => x.id === id);
        return t && (t.status === 'ativo' || _tokenEffectiveStatus(t) === 'expirando');
    });
    if (!ativoIds.length) return showToast('Nenhum token ativo/expirando selecionado', 'error');
    if (!await showConfirm(`Estender ${ativoIds.length} token(s) em +24h?`, '', { okText: 'Estender' })) return;
    try {
        await Promise.all(ativoIds.map(id => api('PATCH', `/api/admin/tokens?id=${id}&extend=24`)));
        showToast(`${ativoIds.length} token(s) estendido(s) em +24h`);
        clearTokenSelection();
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

async function clearExpiredTokens() {
    const expired = (_tokenData || []).filter(t => t.status === 'expirado');
    if (!expired.length) return showToast('Nenhum token expirado', 'error');
    if (!await showConfirm(`Excluir ${expired.length} token(s) expirado(s)?`, 'Os logs de download ficam preservados.', { okText: 'Limpar' })) return;
    try {
        await Promise.all(expired.map(t => api('DELETE', `/api/admin/tokens?id=${t.id}`)));
        showToast(`${expired.length} token(s) expirado(s) excluído(s)`);
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

// ─── TOKEN AÇÕES INLINE ────────────────────────────────────

async function copyTokenLink(link) {
    try {
        await navigator.clipboard.writeText(link);
        showToast('Link copiado!');
    } catch {
        showToast('Erro ao copiar — copie manualmente: ' + link, 'error');
    }
}

async function regenerateToken(t) {
    const label = await showPrompt('Label para o novo token:', t.label || '');
    if (label === null) return;
    const body = {
        cv_version_id: t.cv_version_id,
        label: label || null,
        max_uses: t.max_uses || null,
        expires_in_hours: 24,
    };
    try {
        const data = await api('POST', '/api/admin/tokens', body);
        openShareModal(data);
        loadTokens();
    } catch (e) { showToast(e.message, 'error'); }
}

// ─── TOKEN DRAWER (histórico) ─────────────────────────────

function openTokenDrawer(t) {
    document.getElementById('tokenDrawer').classList.add('open');
    document.getElementById('tokenDrawerOverlay').classList.add('open');
    document.getElementById('tokDrawerTitle').textContent = esc(t.label || '(sem label)');
    renderTokenDrawer(t);
}

function closeTokenDrawer() {
    document.getElementById('tokenDrawer').classList.remove('open');
    document.getElementById('tokenDrawerOverlay').classList.remove('open');
}

function renderTokenDrawer(t) {
    const effStatus = _tokenEffectiveStatus(t);
    const badgeCls  = effStatus === 'ativo' ? 'badge-active' : effStatus === 'expirando' ? 'badge-expiring' : effStatus === 'expirado' ? 'badge-expired' : effStatus === 'revogado' ? 'badge-revoked' : 'badge-esgotado';
    const tokenPath = `/cv?t=${t.id}`;
    const fullLink  = `${location.origin}${tokenPath}`;

    const body = document.getElementById('tokDrawerBody');
    body.innerHTML = `
        <div>
            <div class="tok-section-title">Detalhes</div>
            <div class="tok-info-row"><span class="tok-info-label">Status</span><span class="tok-info-val"><span class="badge ${badgeCls}">● ${effStatus}</span></span></div>
            <div class="tok-info-row"><span class="tok-info-label">Currículo</span><span class="tok-info-val">${esc(t.cv_versions?.name || '—')}</span></div>
            <div class="tok-info-row"><span class="tok-info-label">Usos</span><span class="tok-info-val" style="font-family:var(--font-mono)">${t.max_uses ? `${t.use_count}/${t.max_uses}` : `${t.use_count} / ∞`}</span></div>
            <div class="tok-info-row"><span class="tok-info-label">Expira</span><span class="tok-info-val" title="${fmtDate(t.expires_at)}">${_relTime(t.expires_at)}</span></div>
            <div class="tok-info-row"><span class="tok-info-label">Criado</span><span class="tok-info-val">${fmtDate(t.created_at)}</span></div>
        </div>
        <div>
            <div class="tok-section-title">Link público</div>
            <div style="display:flex;gap:8px;align-items:center">
                <code style="font-size:0.7rem;color:var(--text-dim);background:var(--bg-surface);padding:6px 10px;border-radius:8px;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${esc(fullLink)}</code>
                <button class="btn btn-sm" onclick="copyTokenLink('${fullLink}')" aria-label="Copiar link"><i class="fa-solid fa-copy"></i></button>
            </div>
        </div>
        <div>
            <div class="tok-section-title">Acessos recentes</div>
            <div id="tokDrawerLogs" style="color:var(--text-dim);font-size:0.82rem;padding:8px 0">
                <i class="fa-solid fa-circle-notch fa-spin"></i> Carregando…
            </div>
        </div>
    `;

    const actions = document.getElementById('tokDrawerActions');
    actions.innerHTML = `
        ${effStatus === 'ativo' || effStatus === 'expirando' ? `<button class="btn btn-sm" onclick="revokeToken('${t.id}');closeTokenDrawer()" aria-label="Revogar token"><i class="fa-solid fa-ban"></i> Revogar</button>` : ''}
        <button class="btn btn-sm" onclick="regenerateToken(${JSON.stringify(t).replace(/"/g,'&quot;')})" aria-label="Regenerar token"><i class="fa-solid fa-rotate"></i> Regenerar</button>
        <button class="btn btn-sm" onclick="copyTokenLink('${fullLink}')" aria-label="Copiar link"><i class="fa-solid fa-copy"></i> Copiar link</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteToken('${t.id}','${esc(t.label||'(sem label)')}');closeTokenDrawer()" aria-label="Excluir token"><i class="fa-solid fa-trash"></i></button>
    `;

    // Carrega acessos do token
    api('GET', `/api/admin/logs?token_id=${t.id}&limit=10`)
        .then(r => {
            const logs = r.data || r;
            const logsEl = document.getElementById('tokDrawerLogs');
            if (!logsEl) return;
            if (!logs.length) { logsEl.textContent = 'Nenhum acesso registrado.'; return; }
            logsEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;margin-top:4px">` + logs.map(l => `
                <div style="display:flex;justify-content:space-between;gap:8px;font-size:0.8rem;padding:5px 0;border-bottom:1px solid var(--border-soft)">
                    <span style="color:var(--text-soft)">${esc(l.ip_address || '—')}</span>
                    <span style="color:var(--text-dim)">${fmtDate(l.downloaded_at, true)}</span>
                </div>
            `).join('') + `</div>`;
        })
        .catch(() => {
            const logsEl = document.getElementById('tokDrawerLogs');
            if (logsEl) logsEl.textContent = 'Não foi possível carregar os acessos.';
        });
}

// ─── HELPERS DE TEMPO RELATIVO ─────────────────────────────

function _relTime(iso) {
    if (!iso) return '—';
    const diffMs  = new Date(iso).getTime() - Date.now();
    const diffSec = Math.round(diffMs / 1000);
    const abs     = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
    if (abs < 60)   return diffSec < 0 ? 'agora há pouco' : 'em segundos';
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    return rtf.format(Math.round(diffSec / 86400), 'day');
}

// ─── SEND CV MODAL ────────────────────────────────────────
let _sendCv = null;     // {id, name, file_name}
let _sendMode = 'email';
let _pendingReply = null;   // {name, email, company, role} pré-preenchido vindo do email do recrutador

function openSendCV(cv) {
    _sendCv = cv;
    document.getElementById('sendCvSubtitle').textContent = `Versão: ${cv.name} (${cv.file_name})`;

    // Pré-preenche se houver dados do banner de reply
    document.getElementById('sendName').value    = _pendingReply?.name || '';
    document.getElementById('sendEmail').value   = _pendingReply?.email || '';
    document.getElementById('sendPhone').value   = '';
    document.getElementById('sendMessage').value = '';
    document.getElementById('sendEmpresa').value         = '';
    document.getElementById('sendVaga').value            = '';
    document.getElementById('sendLinkedinEmpresa').value = '';
    document.getElementById('sendLinkVaga').value        = '';
    document.getElementById('sendObservacoes').value     = '';
    document.getElementById('sendMsg').hidden = true;

    // Reset da área pós-processamento (waReadyArea) — começa fechada
    document.getElementById('waReadyArea').hidden = true;
    document.getElementById('waOpenLink').href = '#';
    _pendingWaUrl = null;
    _pendingWaMessage = null;

    _waSubmode = 'link';    // padrão: link rastreado (anexo manual é exceção)
    _lastDefaultMsg = '';   // reset: textarea vazio é "default", próxima atualização escreve

    // Restaura últimas escolhas de parametrização do link (sticky via localStorage)
    const savedExpires = localStorage.getItem('waLinkExpires');
    const savedUses = localStorage.getItem('waLinkUses');
    if (savedExpires) document.getElementById('waLinkExpires').value = savedExpires;
    if (savedUses !== null) document.getElementById('waLinkUses').value = savedUses;

    setSendMode('email');
    document.getElementById('sendCvModal').hidden = false;
    // Foca no campo certo: mensagem se já tem nome+email, senão nome
    const focusEl = (_pendingReply?.name && _pendingReply?.email) ? 'sendMessage' : 'sendName';
    setTimeout(() => document.getElementById(focusEl).focus(), 50);
}
function closeSendCV() { document.getElementById('sendCvModal').hidden = true; }

// Templates aprovados pelo usuário — placeholder [nome] substituído ao digitar.
// Email: corpo enxuto, contatos vão na assinatura visual injetada pelo backend.
// WhatsApp: fechamento com "Atenciosamente,\nBruno Artacho". Email: sem nome (assinatura HTML já assina).
const _msgTemplates = {
    email: `Olá [nome],\n\nConforme nossa conversa, segue meu currículo em anexo.\nEstou à disposição para conversarmos sobre a oportunidade.\n\nAtenciosamente,`,
    whatsapp_attach: `Olá [nome], tudo bem? Aqui é o Bruno.\n\nConforme combinado, segue meu currículo em anexo.\nEstou à disposição para conversarmos sobre a oportunidade.\n\nAtenciosamente,\nBruno Artacho`,
    whatsapp_link: `Olá [nome], tudo bem? Aqui é o Bruno.\n\nConforme combinado, segue o link para download do meu currículo:\n\n[link]\n\nO link é válido até [validade].\n\nEstou à disposição para conversarmos sobre a oportunidade.\n\nAtenciosamente,\nBruno Artacho`,
};
let _waSubmode = 'link';     // sub-modo do WhatsApp ('link' = padrão | 'attach' = exceção)
let _pendingWaUrl = null;    // URL final do wa.me a abrir quando user clicar
let _pendingWaMessage = null;// Mensagem completa pra "Copiar mensagem"

// Última mensagem default que escrevemos no textarea — usada pra detectar edição do usuário.
// Se o textarea ainda for igual a isso, atualizamos livremente. Se mudou, o usuário editou
// e respeitamos o conteúdo.
let _lastDefaultMsg = '';

function setSendMode(mode) {
    _sendMode = mode;
    const isEmail = mode === 'email';
    document.getElementById('sendModeEmail').className = 'btn btn-sm' + (isEmail ? ' btn-cyan' : '');
    document.getElementById('sendModeWhatsapp').className = 'btn btn-sm' + (!isEmail ? ' btn-cyan' : '');
    document.getElementById('sendEmailField').style.display = isEmail ? 'block' : 'none';
    document.getElementById('sendPhoneField').style.display = isEmail ? 'none' : 'block';
    document.getElementById('waSubmodeGroup').style.display = isEmail ? 'none' : 'block';
    if (isEmail) document.getElementById('waLinkParamsGroup').style.display = 'none';

    if (isEmail) {
        document.getElementById('sendBtnLabel').textContent = 'Enviar email com PDF';
        document.getElementById('sendBtnIcon').className = 'fa-solid fa-paper-plane';
        refreshDefaultMessage();
    } else {
        // Aplica o sub-modo atual (que ajusta label do submit, hint e mensagem)
        setWaSubmode(_waSubmode);
    }
}

function setWaSubmode(mode) {
    _waSubmode = mode;
    const isAttach = mode === 'attach';
    document.getElementById('waSubAttach').className = 'btn btn-sm' + (isAttach ? ' btn-cyan' : '');
    document.getElementById('waSubLink').className = 'btn btn-sm' + (!isAttach ? ' btn-cyan' : '');
    document.getElementById('waSubmodeHint').textContent = isAttach
        ? 'PDF baixa local — você anexa manualmente no WhatsApp.'
        : 'Mensagem com link de download. Você é notificado quando o recrutador abre.';
    document.getElementById('sendBtnLabel').textContent = isAttach
        ? 'Baixar PDF + preparar WhatsApp'
        : 'Gerar link + preparar WhatsApp';
    document.getElementById('sendBtnIcon').className = 'fa-brands fa-whatsapp';
    // Selects de parametrização do link visíveis só no modo link
    document.getElementById('waLinkParamsGroup').style.display = isAttach ? 'none' : 'block';
    refreshDefaultMessage();
}

function refreshDefaultMessage() {
    const nameInput = document.getElementById('sendName').value.trim();
    const cur = document.getElementById('sendMessage').value;

    // Pode atualizar se: textarea está vazio OU bateu exatamente o último default que setamos
    if (cur && cur !== _lastDefaultMsg) return;

    let tpl;
    if (_sendMode === 'email') tpl = _msgTemplates.email;
    else tpl = _waSubmode === 'link' ? _msgTemplates.whatsapp_link : _msgTemplates.whatsapp_attach;

    const newMsg = nameInput ? tpl.replace(/\[nome\]/g, nameInput) : tpl;
    document.getElementById('sendMessage').value = newMsg;
    _lastDefaultMsg = newMsg;
}

document.getElementById('sendCvModal').addEventListener('click', e => {
    if (e.target.id === 'sendCvModal') safeCloseModal('sendCvModal', closeSendCV);
});

async function sendCV() {
    if (!_sendCv) return;
    const btn = document.getElementById('sendBtn');
    const msgEl = document.getElementById('sendMsg');
    msgEl.hidden = true;
    msgEl.className = 'forgot-msg';

    const name            = document.getElementById('sendName').value.trim();
    const empresa         = document.getElementById('sendEmpresa').value.trim();
    const vaga            = document.getElementById('sendVaga').value.trim();
    const linkedinEmpresa = document.getElementById('sendLinkedinEmpresa').value.trim();
    const linkVaga        = document.getElementById('sendLinkVaga').value.trim();
    const observacoes     = document.getElementById('sendObservacoes').value.trim();
    const rawMessage = document.getElementById('sendMessage').value.trim();

    if (name.length < 2) return showSendError('Informe o nome do destinatário (pelo menos 2 chars).');

    // Substitui [nome] / [name] (case-insensitive) pelo nome real, mesmo se o usuário
    // editou a mensagem mas esqueceu de trocar o placeholder
    const message = rawMessage.replace(/\[nome\]|\[name\]/gi, name);

    function showSendError(text) {
        msgEl.className = 'forgot-msg error';
        msgEl.textContent = text;
        msgEl.hidden = false;
    }

    // Validações por modo (antes do withLoading pra não travar UI à toa)
    if (_sendMode === 'email') {
        const email = document.getElementById('sendEmail').value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showSendError('Email inválido.');
    } else {
        const phone = document.getElementById('sendPhone').value.replace(/\D/g, '');
        if (phone.length < 10) return showSendError('Telefone inválido (mínimo 10 dígitos com DDI+DDD).');
    }

    const loadingLabel = _sendMode === 'email'
        ? 'Enviando email…'
        : (_waSubmode === 'link' ? 'Gerando link…' : 'Baixando PDF…');

    try {
        await withLoading(btn, async () => {
            if (_sendMode === 'email') {
                const email = document.getElementById('sendEmail').value.trim();
                const r = await api('POST', '/api/admin/send-cv-email', {
                    cv_version_id:    _sendCv.id,
                    recipient_name:   name,
                    recipient_email:  email,
                    message:          message || null,
                    empresa:          empresa          || null,
                    vaga:             vaga             || null,
                    linkedin_empresa: linkedinEmpresa  || null,
                    link_vaga:        linkVaga         || null,
                    observacoes:      observacoes      || null,
                    modalidade:       document.getElementById('sendModalidade').value || null,
                    tipo_contratacao: document.getElementById('sendTipoContratacao').value || null,
                });
                msgEl.className = 'forgot-msg success';
                msgEl.textContent = r.message || 'Enviado!';
                msgEl.hidden = false;
                if (_pendingReply && _pendingReply.email === email) dismissReply();
                setTimeout(closeSendCV, 2500);
                return;
            }

            // ─── WhatsApp ──────────────────────────────────────
            // Estratégia: NÃO chama window.open() aqui (browser bloqueia depois
            // de await). Em vez disso, prepara waUrl/mensagem e mostra área
            // pós-processamento com botão clicável — clique dispara window.open()
            // dentro de event handler real, sem bloqueio.
            const phone = document.getElementById('sendPhone').value.replace(/\D/g, '');
            let waUrl, finalMsg, titleText, detailHtml;

            if (_waSubmode === 'link') {
                // LINK RASTREADO (padrão): valores parametrizáveis pelo usuário (sticky)
                const expiresHours = Number(document.getElementById('waLinkExpires').value) || 24;
                const maxUsesRaw = Number(document.getElementById('waLinkUses').value);
                const maxUses = maxUsesRaw === 0 ? null : maxUsesRaw;   // 0 = ilimitado

                // Persiste escolhas pra próxima vez
                localStorage.setItem('waLinkExpires', String(expiresHours));
                localStorage.setItem('waLinkUses', String(maxUsesRaw));

                const tk = await api('POST', '/api/admin/tokens', {
                    cv_version_id: _sendCv.id,
                    label: `WhatsApp · ${name}`,
                    expires_in_hours: expiresHours,
                    max_uses: maxUses,
                    empresa: empresa || null,
                    vaga:    vaga    || null,
                });

                // Loga o envio do link (fire & forget — não bloqueia o fluxo)
                api('POST', '/api/admin/log-share', {
                    cv_version_id:    _sendCv.id,
                    cv_name_snapshot: _sendCv.name,
                    cv_id_snapshot:   _sendCv.id,
                    ip_address:       'admin-send-whatsapp-link',
                    user_agent:       `Send to ${name} via whatsapp-link`,
                    token_id:         tk.id,
                    empresa:          empresa         || null,
                    vaga:             vaga            || null,
                    linkedin_empresa: linkedinEmpresa || null,
                    link_vaga:        linkVaga        || null,
                    notas:            observacoes     || null,
                    modalidade:       document.getElementById('sendModalidade').value || null,
                    tipo_contratacao: document.getElementById('sendTipoContratacao').value || null,
                }).catch(() => {});

                const validade = fmtDate(tk.expires_at, true).replace(',', ' às');
                finalMsg = message.replace(/\[link\]/g, tk.shareUrl).replace(/\[validade\]/g, validade);
                waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(finalMsg)}`;

                // Texto humano da validade pra o detail
                const validityText = expiresHours < 24
                    ? `${expiresHours}h`
                    : (expiresHours === 24 ? '24h' : `${Math.round(expiresHours / 24)} dia(s)`);
                const usesText = maxUses === null ? 'usos ilimitados' : `${maxUses} uso(s)`;

                titleText = '✓ Link gerado!';
                detailHtml = `Validade: <strong>${validityText}</strong> · <strong>${usesText}</strong>. Token "WhatsApp · ${esc(name)}" disponível na aba Tokens. Clique abaixo pra abrir o WhatsApp.`;
                loadTokens();
            } else {
                // ANEXO MANUAL (exceção): baixa PDF + envio fica registrado em logs
                finalMsg = message.replace(/\[link\]\s*\n*/g, '');
                const _waModalidade       = document.getElementById('sendModalidade').value;
                const _waTipoContratacao  = document.getElementById('sendTipoContratacao').value;
                const dlUrl = `/api/admin/cv-storage-url?id=${_sendCv.id}`
                    + `&recipient=${encodeURIComponent(name)}&channel=whatsapp`
                    + (empresa              ? `&empresa=${encodeURIComponent(empresa)}`                           : '')
                    + (vaga                 ? `&vaga=${encodeURIComponent(vaga)}`                                 : '')
                    + (linkedinEmpresa      ? `&linkedin_empresa=${encodeURIComponent(linkedinEmpresa)}`           : '')
                    + (linkVaga             ? `&link_vaga=${encodeURIComponent(linkVaga)}`                         : '')
                    + (observacoes          ? `&observacoes=${encodeURIComponent(observacoes)}`                   : '')
                    + (_waModalidade        ? `&modalidade=${encodeURIComponent(_waModalidade)}`                  : '')
                    + (_waTipoContratacao   ? `&tipo_contratacao=${encodeURIComponent(_waTipoContratacao)}`       : '')
                    + (phone               ? `&contato=${encodeURIComponent(phone)}`                             : '');
                const dl = await api('GET', dlUrl);
                const a = document.createElement('a');
                a.href = dl.signedUrl;
                a.download = dl.file_name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(finalMsg)}`;
                titleText = '✓ PDF baixado!';
                detailHtml = `Clique abaixo pra abrir o WhatsApp. Depois <strong>arraste o PDF da pasta <em>Downloads</em></strong> pra dentro da conversa. Envio registrado nos Logs.`;
                loadLogs?.();   // refresh dos logs se a aba estiver carregada
            }

            // Guarda mensagem pra copyWaMessage(); URL vai direto no <a href>
            _pendingWaUrl = waUrl;
            _pendingWaMessage = finalMsg;

            // Popula o <a target="_blank"> com a URL real — anchor click NÃO é
            // bloqueado por popup blocker (é navegação explícita do usuário)
            document.getElementById('waOpenLink').href = waUrl;
            document.getElementById('waReadyTitle').textContent = titleText;
            document.getElementById('waReadyDetail').innerHTML = detailHtml;
            document.getElementById('waReadyArea').hidden = false;

            // NÃO fecha o modal automaticamente — espera o user clicar em "Abrir WhatsApp"
            if (_pendingReply) dismissReply();
        }, loadingLabel);
    } catch (e) {
        showSendError(e.message);
    }
}

// Chamado depois que o user clica no <a> pra abrir WhatsApp.
// Não tenta abrir nada (o anchor já fez isso); só fecha o modal com pequeno delay.
function afterWhatsAppOpened() {
    setTimeout(closeSendCV, 500);
}

// Botão "Copiar mensagem" — útil pra quem prefere outro canal ou WhatsApp Desktop
async function copyWaMessage() {
    if (!_pendingWaMessage) return;
    try {
        await navigator.clipboard.writeText(_pendingWaMessage);
        showToast('Mensagem copiada para a área de transferência');
    } catch {
        showToast('Falha ao copiar — selecione e copie manualmente', 'error');
    }
}

// Atualiza msg padrão quando user digita o nome
document.getElementById('sendName').addEventListener('input', refreshDefaultMessage);

// ─── EDIT CV MODAL ────────────────────────────────────────
function openEditCV(cv) {
    document.getElementById('editCvId').value = cv.id;
    document.getElementById('editCvName').value = cv.name;
    document.getElementById('editCvFileName').value = cv.file_name || '';
    document.getElementById('editCvDesc').value = cv.description || '';
    document.getElementById('editCvActive').checked = !!cv.active;
    document.getElementById('editCvModal').hidden = false;
}
function closeEditCV() { document.getElementById('editCvModal').hidden = true; }
async function saveEditCV() {
    const id = document.getElementById('editCvId').value;
    const name = document.getElementById('editCvName').value.trim();
    const file_name = document.getElementById('editCvFileName').value.trim();
    const description = document.getElementById('editCvDesc').value.trim();
    const active = document.getElementById('editCvActive').checked;
    const btn = document.getElementById('editCvSaveBtn');
    if (!name) return showToast('Nome obrigatório', 'error');
    if (!file_name) return showToast('Nome do arquivo obrigatório', 'error');
    try {
        await withLoading(btn, async () => {
            await api('PATCH', `/api/admin/cv-versions?id=${id}`, { name, file_name, description, active });
            showToast('Versão atualizada');
            closeEditCV();
            loadCVs();
        }, 'Salvando…');
    } catch (e) { showToast(e.message, 'error'); }
}
document.getElementById('editCvModal')?.addEventListener('click', e => {
    if (e.target.id === 'editCvModal') safeCloseModal('editCvModal', closeEditCV);
});

// ─── LOGS ─────────────────────────────────────────────────

// Renderiza label inteligente: usa o token.label se houver, senão deduz do
// ip_address + user_agent (envios admin têm padrão "admin-send-X" + "Send to Y via X")
function smartLogLabel(l) {
    if (l.download_tokens?.label) return esc(l.download_tokens.label);
    const ip = l.ip_address || '';
    const ua = l.user_agent || '';

    if (ip.startsWith('admin-send-')) {
        const channel = ip.replace('admin-send-', '');
        // Captura nome do recrutador: "Send to Maria <..." ou "Send to Maria via..."
        const m = ua.match(/^Send to ([^<\(]+?)(?:\s*<|\s+via|\s*$)/);
        const recipient = m ? m[1].trim() : '?';
        const channelLabel = channel === 'whatsapp-link'   ? 'WhatsApp · link'
                           : channel === 'whatsapp'        ? 'WhatsApp · arquivo'
                           : channel === 'email'           ? 'Email'
                           : channel;
        return `<span title="${esc(ua)}">${esc(channelLabel)} · <strong>${esc(recipient)}</strong></span>`;
    }

    // Download real do recrutador (token deletado mas log preservado)
    if (ua && !ua.startsWith('Send to')) {
        return '<span style="color:var(--text-dim)" title="Download direto via token (token deletado da base)">(download direto)</span>';
    }

    return '<span style="color:var(--text-dim)">(sem label)</span>';
}

function smartCvName(l) {
    const live = l.cv_versions?.name;
    const snap = l.cv_name_snapshot;
    const idSnap = l.cv_id_snapshot;
    if (live) return esc(live);
    if (snap) {
        const shortId = idSnap ? idSnap.replace(/-/g, '').slice(0, 8) : '';
        const idPart = shortId ? ` <span style="font-family:var(--font-mono);font-size:0.68rem;color:var(--text-dim)" title="${esc(idSnap || '')}">· id:${shortId}</span>` : '';
        return `${esc(snap)}${idPart} <span style="font-family:var(--font-mono);font-size:0.7rem;color:var(--danger);background:var(--danger-soft);border:1px solid rgba(239,68,68,0.2);padding:1px 6px;border-radius:4px;margin-left:4px">excluído</span>`;
    }
    return '<span style="color:var(--text-dim)">—</span>';
}

function _showLogOverlay() {
    document.getElementById('logOverlay')?.classList.add('visible');
}
function _hideLogOverlay() {
    document.getElementById('logOverlay')?.classList.remove('visible');
}

function _renderLogSkeletons(n = 10) {
    const widths = [
        ['58%','65%','72%','40%'],['45%','75%','55%','50%'],
        ['70%','45%','68%','55%'],['52%','60%','78%','45%'],
        ['65%','52%','50%','60%'],['42%','70%','62%','65%'],
        ['75%','58%','45%','52%'],['55%','48%','70%','62%'],
        ['48%','68%','55%','48%'],['68%','55%','65%','55%'],
    ];
    document.getElementById('logTable').innerHTML = Array.from({ length: n }, (_, i) => {
        const w = widths[i % widths.length];
        return `<tr class="skel-row">
            <td><span class="skel-cell" style="width:${w[0]}"></span></td>
            <td><span class="skel-cell" style="width:${w[1]}"></span></td>
            <td><span class="skel-cell" style="width:${w[2]}"></span></td>
            <td><span class="skel-cell" style="width:${w[3]}"></span></td>
        </tr>`;
    }).join('');
}

async function loadLogs() {
    const search = document.getElementById('logSearch')?.value || '';
    const tipo   = document.getElementById('logTipoFilter')?.dataset.value || '';
    const from   = document.getElementById('logFrom')?.value || '';
    const to     = document.getElementById('logTo')?.value || '';

    const params = new URLSearchParams({ page: _logPage, limit: 50, sort: _logSort.col, dir: _logSort.dir });
    if (search) params.set('search', search);
    if (tipo)   params.set('tipo', tipo);
    if (from)   params.set('from', from);
    if (to)     params.set('to', to);

    // Primeira carga: tbody vazio → skeleton para reservar altura
    if (!document.getElementById('logTable').children.length) _renderLogSkeletons();
    _showLogOverlay();

    try {
        const result = await api('GET', `/api/admin/logs?${params}`);
        _logData  = result.data;
        _logTotal = result.total;
        _logPages = result.pages;
        renderLogs();
        _updateLogPagination();
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        _hideLogOverlay();
    }
}

function _debouncedLogLoad() {
    _logPage = 1;
    _showLogOverlay(); // feedback imediato antes do debounce disparar
    clearTimeout(_logSearchTimer);
    _logSearchTimer = setTimeout(loadLogs, 300);
}

function _resetAndLoadLogs() {
    _logPage = 1;
    loadLogs();
}

function setLogPage(p) {
    const np = Math.max(1, Math.min(_logPages || 1, p));
    if (np === _logPage) return;
    _logPage = np;
    loadLogs();
}

function _updateLogPagination() {
    const el = document.getElementById('logPagination');
    if (!el) return;
    if (_logPages <= 1) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    document.getElementById('logPrevBtn').disabled = _logPage <= 1;
    document.getElementById('logNextBtn').disabled = _logPage >= _logPages;
    document.getElementById('logPageInfo').textContent = `Página ${_logPage} de ${_logPages}`;
}

function renderLogs() {
    updateSortHeaders('logs');
    const tbody   = document.getElementById('logTable');
    const countEl = document.getElementById('logCount');
    if (countEl) countEl.textContent = _logTotal ? `${_logTotal} registros` : '';

    if (!_logData.length) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-dim);padding:40px">
            <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
                <i class="fa-solid fa-magnifying-glass" style="font-size:1.4rem;opacity:0.3"></i>
                <span>Nenhum resultado</span>
            </div>
        </td></tr>`;
        return;
    }
    tbody.innerHTML = _logData.map(l => `
        <tr onclick="openLogDetail(${JSON.stringify(l).replace(/"/g,'&quot;')})" style="cursor:pointer">
            <td data-label="Evento"><span>${smartLogLabel(l)}</span></td>
            <td data-label="Currículo"><span>${smartCvName(l)}</span></td>
            <td data-label="Origem" style="font-size:0.78rem">${smartLogOrigin(l)}</td>
            <td data-label="Data" style="font-size:0.82rem" title="${fmtDate(l.downloaded_at, true)}">${_relTime(l.downloaded_at)}</td>
        </tr>
    `).join('');
}

function smartLogOrigin(l) {
    const ip = l.ip_address || '';
    if (ip.startsWith('admin-send-')) {
        const ua = l.user_agent || '';
        const m  = ua.match(/^Send to ([^<(]+?)(?:\s*<|\s+via|\s*$)/);
        const recipient = m ? m[1].trim() : '?';
        return `<span style="color:var(--text-soft)" title="${esc(ua)}">${esc(recipient)}</span>`;
    }
    if (!ip) return '<span style="color:var(--text-dim)">—</span>';
    return `<span style="font-family:var(--font-mono)" title="IP do visitante">${esc(ip)}</span>`;
}

// ─── LOG KPIS ──────────────────────────────────────────────

async function loadLogKpis() {
    const fmt = d => d.toLocaleDateString('en-CA');
    const now   = new Date();
    const today = fmt(now);
    const ago7  = fmt(new Date(now - 7  * 86400000));
    const ago30 = fmt(new Date(now - 30 * 86400000));

    const reset = id => { const el = document.getElementById(id); if (el) el.textContent = '…'; };
    ['kpiLogHoje','kpiLog7d','kpiLog30d','kpiLogTotal'].forEach(reset);

    try {
        const [r1, r7, r30, rAll] = await Promise.all([
            api('GET', `/api/admin/logs?limit=1&from=${today}`),
            api('GET', `/api/admin/logs?limit=1&from=${ago7}`),
            api('GET', `/api/admin/logs?limit=1&from=${ago30}`),
            api('GET', '/api/admin/logs?limit=1'),
        ]);
        const set = (id, r) => { const el = document.getElementById(id); if (el) el.textContent = r.total ?? '?'; };
        set('kpiLogHoje',  r1);
        set('kpiLog7d',    r7);
        set('kpiLog30d',   r30);
        set('kpiLogTotal', rAll);
    } catch { /* silencioso: KPIs são acessórios */ }
}

function applyLogPreset(preset) {
    const fmt = d => d.toLocaleDateString('en-CA');
    const now  = new Date();
    const from = document.getElementById('logFrom');
    const to   = document.getElementById('logTo');

    // Destaca card clicado
    document.querySelectorAll('#logKpis .tab-kpi-card').forEach(c => c.classList.remove('kpi-selected'));
    event?.currentTarget?.classList.add('kpi-selected');

    if (preset === 'today') {
        if (from) from.value = fmt(now);
        if (to)   to.value   = fmt(now);
    } else if (preset === '7d') {
        if (from) from.value = fmt(new Date(now - 7  * 86400000));
        if (to)   to.value   = fmt(now);
    } else if (preset === '30d') {
        if (from) from.value = fmt(new Date(now - 30 * 86400000));
        if (to)   to.value   = fmt(now);
    } else { // 'all'
        if (from) from.value = '';
        if (to)   to.value   = '';
    }
    _resetAndLoadLogs();
}

function exportLogsCsv() {
    if (!_logData.length) return showToast('Sem dados para exportar', 'error');
    const rows = [['Data/hora', 'Evento', 'Currículo', 'Origem', 'Token/Label']];
    _logData.forEach(l => {
        const ip = l.ip_address || '';
        const evento = ip.startsWith('admin-send-') ? ip.replace('admin-send-','') : 'download';
        const origem = (() => {
            if (ip.startsWith('admin-send-')) {
                const m = (l.user_agent||'').match(/^Send to ([^<(]+?)(?:\s*<|\s+via|\s*$)/);
                return m ? m[1].trim() : ip;
            }
            return ip || '—';
        })();
        rows.push([
            fmtDate(l.downloaded_at, true),
            evento,
            l.cv_versions?.name || l.cv_name_snapshot || '—',
            origem,
            l.download_tokens?.label || '(download direto)',
        ]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `logs-${new Date().toLocaleDateString('en-CA')}.csv` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    showToast(`${_logData.length} registros exportados`);
}

function clearLogFilters() {
    ['logSearch', 'logFrom', 'logTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    _resetCustomSelect('logTipoFilter');
    _logSort = { col: 'downloaded_at', dir: 'desc' };
    _logPage = 1;
    loadLogs();
}

// ─── LOG DETAIL DRAWER ────────────────────────────────────

function openLogDetail(logData) {
    document.getElementById('logDrawer').classList.add('open');
    document.getElementById('logDrawerOverlay').classList.add('open');
    document.getElementById('ldTitle').textContent = 'Carregando…';
    document.getElementById('ldBody').innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:56px"><i class="fa-solid fa-circle-notch fa-spin fa-lg"></i></div>';

    api('GET', `/api/admin/logs?id=${logData.id}`)
        .then(data => renderLogDetail(data))
        .catch(e => { document.getElementById('ldBody').innerHTML = `<p style="color:var(--danger);padding:20px">${esc(e.message)}</p>`; });
}

function closeLogDetail() {
    document.getElementById('logDrawer').classList.remove('open');
    document.getElementById('logDrawerOverlay').classList.remove('open');
}

function _parseUA(ua) {
    if (!ua) return null;
    const browser = ua.match(/(Edg|Chrome|Firefox|Safari|OPR|Opera)\/[\d.]+/)?.[1] || null;
    const os = ua.includes('Windows') ? 'Windows'
             : ua.includes('Mac')     ? 'macOS'
             : ua.includes('iPhone')  ? 'iPhone'
             : ua.includes('Android') ? 'Android'
             : ua.includes('Linux')   ? 'Linux'
             : null;
    return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 80);
}

function renderLogDetail({ log, accesses }) {
    const ip = log.ip_address || '';
    const ua = log.user_agent || '';
    const isAdminSend = ip.startsWith('admin-send-');

    let channelIcon, channelLabel;
    if      (ip === 'admin-send-email')          { channelIcon = '✉️';  channelLabel = 'Email (anexo)'; }
    else if (ip === 'admin-send-whatsapp-link')  { channelIcon = '🔗';  channelLabel = 'WhatsApp · link rastreado'; }
    else if (ip === 'admin-send-whatsapp')       { channelIcon = '📎';  channelLabel = 'WhatsApp · arquivo manual'; }
    else                                          { channelIcon = '⬇️'; channelLabel = 'Acesso do recrutador'; }

    document.getElementById('ldTitle').textContent = channelLabel;

    const recName = isAdminSend
        ? (ua.match(/^Send to ([^<(]+?)(?:\s*<|\s+via|\s*$)/)?.[1]?.trim() || '')
        : '';
    const tk   = log.download_tokens;
    const cv   = log.cv_versions;
    const meta = {
        empresa: tk?.empresa || log.empresa || null,
        vaga:    tk?.vaga    || log.vaga    || null,
        notas:   tk?.notas   || log.notas   || null,
        contato: tk?.contato || log.contato || null,
    };

    const row = (label, val, mono) => val
        ? `<div class="ld-row"><span class="ld-label">${label}</span><span class="ld-value${mono ? ' ' : ''}" style="${mono ? 'font-family:var(--font-mono);font-size:0.8rem' : ''}">${val}</span></div>`
        : '';

    let html = '';

    // ── Envio ──
    html += `<div class="ld-section"><div class="ld-section-title">Envio</div>
        ${row('Canal', `${channelIcon} ${esc(channelLabel)}`)}
        ${row('Data/hora', esc(fmtDate(log.downloaded_at, true)))}
        ${recName ? row('Destinatário', `<strong>${esc(recName)}</strong>`) : ''}
    </div>`;

    // ── Contexto da vaga ──
    if (meta.empresa || meta.vaga || meta.contato || meta.notas) {
        html += `<div class="ld-section"><div class="ld-section-title">Contexto da vaga</div>
            ${row('Empresa', meta.empresa ? esc(meta.empresa) : null)}
            ${row('Vaga',    meta.vaga    ? esc(meta.vaga)    : null)}
            ${meta.contato ? (() => { const c = meta.contato; const href = c.startsWith('http') ? esc(c) : /^\+?\d{6,}$/.test(c) ? `https://wa.me/${c.replace(/\D/g,'')}` : `mailto:${esc(c)}`; return `<div class="ld-row"><span class="ld-label">Contato</span><span class="ld-value"><a href="${href}" target="_blank" rel="noreferrer" style="color:var(--cyan)">${esc(c)}</a></span></div>`; })() : ''}
            ${row('Notas',   meta.notas   ? `<em style="color:var(--text-soft)">${esc(meta.notas)}</em>` : null)}
        </div>`;
    }

    // ── Currículo ──
    html += `<div class="ld-section"><div class="ld-section-title">Currículo</div>
        ${row('Versão',    esc(cv?.name || log.cv_name_snapshot || '—'))}
        ${cv?.description ? row('Descrição', `<span style="color:var(--text-soft)">${esc(cv.description)}</span>`) : ''}
    </div>`;

    // ── Token ──
    if (tk) {
        const tkStatus = tk.revoked ? '<span class="ld-badge red">revogado</span>'
            : new Date(tk.expires_at) < new Date() ? '<span class="ld-badge dim">expirado</span>'
            : '<span class="ld-badge green">ativo</span>';
        html += `<div class="ld-section"><div class="ld-section-title">Token</div>
            ${row('Label',  `<span style="font-family:var(--font-mono)">${esc(tk.label || '—')}</span>`)}
            ${row('Status', tkStatus)}
            ${row('Expira', esc(fmtDate(tk.expires_at, true)))}
            ${row('Usos',   `${tk.use_count ?? 0} / ${tk.max_uses ?? '∞'}`)}
        </div>`;
    }

    // ── Acesso do recrutador (para envios de link) ──
    if (ip === 'admin-send-whatsapp-link' || (isAdminSend && log.token_id)) {
        html += `<div class="ld-section"><div class="ld-section-title">Recrutador abriu?</div>`;
        if (!accesses?.length) {
            html += '<span class="ld-badge red"><i class="fa-solid fa-clock"></i> Ainda não visualizou</span>';
        } else {
            html += `<span class="ld-badge green"><i class="fa-solid fa-check"></i> Visualizou ${accesses.length}×</span>`;
            accesses.forEach((acc, i) => {
                html += `<div class="ld-access-entry">
                    <div style="font-weight:600;color:var(--cyan);margin-bottom:5px">Acesso ${i + 1}</div>
                    <div style="color:var(--text-dim);font-size:0.78rem">📅 ${esc(fmtDate(acc.downloaded_at, true))}</div>
                    <div style="color:var(--text-dim);font-size:0.78rem;font-family:var(--font-mono)">🌐 ${esc(acc.ip_address)}</div>
                    ${_parseUA(acc.user_agent) ? `<div style="color:var(--text-dim);font-size:0.78rem">💻 ${esc(_parseUA(acc.user_agent))}</div>` : ''}
                </div>`;
            });
        }
        html += '</div>';
    } else if (!isAdminSend) {
        // É um acesso direto do recrutador — mostra IP + UA
        html += `<div class="ld-section"><div class="ld-section-title">Detalhes do acesso</div>
            ${row('IP', `<span style="font-family:var(--font-mono)">${esc(log.ip_address)}</span>`)}
            ${_parseUA(ua) ? row('Dispositivo', esc(_parseUA(ua))) : ''}
            ${ua ? `<div class="ld-row" style="align-items:start"><span class="ld-label">User-Agent</span><span class="ld-value" style="font-size:0.68rem;font-family:var(--font-mono);color:var(--text-dim);word-break:break-all">${esc(ua)}</span></div>` : ''}
        </div>`;
    }

    document.getElementById('ldBody').innerHTML = html;
}

// ─── SHARE MODAL ──────────────────────────────────────────
let _shareUrl    = '';
let _shareExpiry = '';

function openShareModal(data) {
    _shareUrl = data.shareUrl;
    _shareExpiry = new Date(data.expires_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const uses = data.max_uses ? `máx. ${data.max_uses} usos` : 'usos ilimitados';

    document.getElementById('shareModalMeta').textContent = `${data.label || 'Sem label'} · expira ${_shareExpiry} · ${uses}`;
    document.getElementById('shareUrl').textContent = _shareUrl;

    const msg = encodeURIComponent(`Olá! Segue meu currículo: ${_shareUrl} (disponível até ${_shareExpiry})`);
    document.getElementById('whatsappBtn').href = `https://wa.me/?text=${msg}`;

    document.getElementById('copyBtn').textContent = '';
    document.getElementById('copyBtn').innerHTML = '<i class="fa-solid fa-copy"></i> Copiar link';
    document.getElementById('copyBtn').classList.remove('copied');

    cancelShareEmail();
    document.getElementById('shareModal').classList.add('open');
}

function closeShareModal() {
    document.getElementById('shareModal').classList.remove('open');
}

function showShareEmailForm() {
    document.getElementById('emailBtn').style.display = 'none';
    document.getElementById('shareEmailForm').style.display = 'block';
    document.getElementById('shareEmailInput').value = '';
    document.getElementById('shareEmailInput').focus();
}

function cancelShareEmail() {
    document.getElementById('shareEmailForm').style.display = 'none';
    document.getElementById('emailBtn').style.display = '';
}

async function sendShareEmail() {
    const input = document.getElementById('shareEmailInput');
    const email = input.value.trim();
    if (!email) { input.focus(); return; }

    const btn = document.getElementById('shareEmailSendBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';

    try {
        await api('POST', '/api/admin/tokens?action=send-email', {
            share_url: _shareUrl,
            recipient_email: email,
            expiry: _shareExpiry,
        });
        cancelShareEmail();
        showToast(`E-mail enviado para ${email}`, 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    }
}

async function copyShareUrl() {
    try {
        await navigator.clipboard.writeText(_shareUrl);
        const btn = document.getElementById('copyBtn');
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copiar link';
            btn.classList.remove('copied');
        }, 2500);
    } catch { showToast('Não foi possível copiar', 'error'); }
}

document.getElementById('shareModal').addEventListener('click', e => {
    if (e.target === document.getElementById('shareModal')) closeShareModal();
});

// ─── TOAST ────────────────────────────────────────────────
function showToast(msg, type = 'success', action = null) {
    const t = document.getElementById('toast');
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    if (action) {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.onclick = () => { t.classList.remove('show'); action.callback(); };
        t.appendChild(btn);
    }
    t.className = `toast ${type} show`;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 3500);
}

// ─── UTILS ────────────────────────────────────────────────
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function fmtDate(iso, withTime = false) {
    if (!iso) return '—';
    if (!withTime) {
        // Usa sempre os primeiros 10 chars (YYYY-MM-DD) sem passar pelo construtor Date,
        // evitando o shift UTC→BRT que causa o dia anterior em timestamps de meia-noite UTC.
        const datePart = iso.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
            const [y, m, d] = datePart.split('-');
            return `${d}/${m}/${y}`;
        }
    }
    const opts = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' };
    if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return new Date(iso).toLocaleString('pt-BR', opts);
}

// ─── ANALYTICS / MÉTRICAS ─────────────────────────────────
let _analyticsPeriod = 7;
let _analyticsChart = null;
let _hourlyChart    = null;
let _dowChart       = null;
let _lastAnalyticsData  = null;
let _lastAnalyticsRange = null; // { from, to } em BRT YYYY-MM-DD

let _metricsExcludeAdmin = false;
function toggleMetricsExcludeAdmin(el) {
    _metricsExcludeAdmin = el.checked;
    loadAnalytics();
}

function setAnalyticsPeriod(days, btn) {
    _analyticsPeriod = days;
    document.querySelectorAll('.metrics-period-bar .metrics-period-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadAnalytics();
}

function _metricsPeriodLabel(days) {
    if (days === 1)   return 'Visitas hoje';
    if (days === 365) return 'Visitas no último ano';
    return `Visitas dos últimos ${days} dias`;
}

async function loadAnalytics() {
    const tz = 'America/Sao_Paulo';
    const fmt = d => d.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD em BRT
    const today = new Date();
    const to = fmt(today);
    const fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - (_analyticsPeriod - 1));
    const from = fmt(fromDate);
    _lastAnalyticsRange = { from, to };
    try {
        const excludeParam = _metricsExcludeAdmin ? '&exclude_admin=1' : '';
        const data = await api('GET', `/api/admin/analytics?from=${from}&to=${to}${excludeParam}&_=${Date.now()}`);
        _lastAnalyticsData = data;
        renderAnalytics(data);
    } catch (e) {
        ['kpi-pageviews','kpi-unique','kpi-engaged','kpi-cv-clicks','kpi-cv-downloads','kpi-recurring']
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    }
}

// Calcula delta percentual entre período atual e anterior; null se não há base
function _metricsDelta(curr, prev) {
    const c = Number(curr ?? 0);
    const p = Number(prev ?? 0);
    if (p === 0) return c > 0 ? { dir: 'up', pct: null, raw: c } : null;
    const diff = c - p;
    const pct = Math.round((diff / p) * 1000) / 10;
    return { dir: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat'), pct, raw: diff };
}

function _renderDelta(elId, delta, opts) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!delta) { el.innerHTML = ''; el.removeAttribute('title'); return; }
    const arrow = delta.dir === 'up' ? '▲' : (delta.dir === 'down' ? '▼' : '■');
    const color = delta.dir === 'up'
        ? (opts && opts.inverse ? '#fb7185' : '#34d399')
        : (delta.dir === 'down' ? (opts && opts.inverse ? '#34d399' : '#fb7185') : '#a8a8c0');
    const pctTxt = delta.pct == null ? 'novo' : (delta.pct > 0 ? '+' : '') + delta.pct + '%';
    el.innerHTML = `<span style="color:${color};font-weight:600">${arrow} ${pctTxt}</span>`;
    el.title = `Variação vs período anterior (${delta.raw > 0 ? '+' : ''}${delta.raw})`;
}

function renderAnalytics(data) {
    const { kpis = {}, kpis_prev = {}, series = [], top_pages = [], top_referrers = [],
            devices = [], countries = [], funnel = {}, funnel_unique = {},
            hourly = [], dow = [], referrer_conversion = [] } = data;

    // KPIs principais
    const setKpi = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
    setKpi('kpi-pageviews',    kpis.pageviews    ?? '—');
    setKpi('kpi-unique',       kpis.unique_visitors ?? '—');
    setKpi('kpi-engaged',      kpis.engaged_rate != null ? kpis.engaged_rate + '%' : '—');
    setKpi('kpi-cv-clicks',    kpis.cv_download_clicks ?? '—');
    setKpi('kpi-cv-downloads', kpis.cv_downloads ?? '—');
    setKpi('kpi-recurring',    kpis.recurring_visitors ?? '—');
    setKpi('kpi-demo-accesses', data.demo_accesses ?? '—');
    const erEl = document.getElementById('kpi-engaged-rate');
    if (erEl) erEl.textContent = kpis.engaged_rate != null ? `${kpis.engaged_rate}% das visitas` : '—';
    const cnvEl = document.getElementById('kpi-conversion');
    if (cnvEl) cnvEl.textContent = kpis.conversion_rate != null ? `${kpis.conversion_rate}% conversão` : '—';

    // Deltas vs período anterior
    _renderDelta('kpi-pageviews-delta',    _metricsDelta(kpis.pageviews,          kpis_prev.pageviews));
    _renderDelta('kpi-unique-delta',       _metricsDelta(kpis.unique_visitors,    kpis_prev.unique));
    _renderDelta('kpi-engaged-delta',      _metricsDelta(kpis.engaged_rate,       kpis_prev.pageviews ? Math.round((kpis_prev.engaged / kpis_prev.pageviews) * 1000) / 10 : 0));
    _renderDelta('kpi-cv-clicks-delta',    _metricsDelta(kpis.cv_download_clicks, kpis_prev.cv_clicks));
    _renderDelta('kpi-cv-downloads-delta', _metricsDelta(kpis.cv_downloads,       kpis_prev.cv_downloads));
    _renderDelta('kpi-recurring-delta',    _metricsDelta(kpis.recurring_visitors, kpis_prev.recurring));

    // Card Sessões + Retenção
    setKpi('kpi-sessions',         kpis.total_sessions     ?? '—');
    setKpi('kpi-bounce',           kpis.bounce_rate != null ? kpis.bounce_rate + '%' : '—');
    setKpi('kpi-pages-per-session',kpis.pages_per_session  ?? '—');
    setKpi('kpi-avg-duration',     _fmtDuration(kpis.avg_session_seconds));
    setKpi('kpi-retention-7d',     kpis.retention_7d_pct  != null ? kpis.retention_7d_pct  + '%' : '—');
    setKpi('kpi-retention-30d',    kpis.retention_30d_pct != null ? kpis.retention_30d_pct + '%' : '—');

    // Título dinâmico
    const titleEl = document.getElementById('metricsChartTitle');
    if (titleEl) titleEl.textContent = _metricsPeriodLabel(_analyticsPeriod);

    // Série temporal — gap-filler agora usa from/to BRT (alinhado com loadAnalytics)
    const range = _lastAnalyticsRange || {};
    const filledSeries = _fillTimelineGaps(series, 'day', range.from || '', range.to || '', ['pageviews', 'unique_visitors']);
    const labels  = filledSeries.map(s => new Date(s.bucket).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', timeZone: 'UTC' }));
    const pvData  = filledSeries.map(s => s.pageviews ?? 0);
    const uniqData = filledSeries.map(s => s.unique_visitors ?? 0);
    const ctx = document.getElementById('analyticsChart');
    if (ctx) {
        if (_analyticsChart) { _analyticsChart.destroy(); _analyticsChart = null; }
        _analyticsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Visitas',
                        data: pvData,
                        backgroundColor: 'rgba(34,211,238,0.25)',
                        borderColor: 'rgba(34,211,238,0.8)',
                        borderWidth: 1.5,
                        borderRadius: 4,
                        order: 2,
                    },
                    {
                        label: 'Únicos',
                        data: uniqData,
                        type: 'line',
                        borderColor: '#7c3aed',
                        backgroundColor: 'transparent',
                        pointRadius: 3,
                        pointBackgroundColor: '#7c3aed',
                        tension: 0.3,
                        order: 1,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#a8a8c0', font: { size: 11 }, boxWidth: 12 } } },
                scales: {
                    x: { ticks: { color: '#5c5c80', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#5c5c80', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
                },
            },
        });
    }

    // Funil
    const fKeys   = ['pageview','engaged','cv-click','cv-download'];
    const fLabels = ['Visitas','Engajados','Clicou no CV','Baixou o CV'];
    const fVals   = [funnel.pageview ?? 0, funnel.engaged ?? 0, funnel.cv_click ?? 0, funnel.cv_download ?? 0];
    const fMax    = fVals[0] || 1;
    fKeys.forEach((key, i) => {
        const bar  = document.getElementById(`funnel-bar-${key}`);
        const val  = document.getElementById(`funnel-val-${key}`);
        const pct  = document.getElementById(`funnel-pct-${key}`);
        if (!bar || !val || !pct) return;
        const w    = Math.round((fVals[i] / fMax) * 100);
        bar.style.width  = w + '%';
        val.textContent  = fVals[i];
        pct.textContent  = i === 0 ? '100%' : (fMax > 0 ? Math.round((fVals[i] / fMax) * 100) + '%' : '—');
    });

    // Top páginas
    const pagesEl = document.getElementById('metricsTopPages');
    if (pagesEl) {
        if (!top_pages.length) { pagesEl.innerHTML = '<div class="metrics-empty">Sem dados ainda</div>'; }
        else {
            const maxV = top_pages[0]?.views || 1;
            pagesEl.innerHTML = top_pages.slice(0, 8).map(p => {
                const path = p.path || '/';
                const label = path === '/' ? 'Início' : path;
                return `
                <div class="metrics-row">
                    <span class="metrics-row-label" title="${esc(path)}">${esc(label)}</span>
                    <span class="metrics-row-value">${p.views}</span>
                </div>
                <div class="metrics-bar-wrap"><div class="metrics-bar-fill" style="width:${Math.round(p.views/maxV*100)}%"></div></div>`;
            }).join('');
        }
    }

    // Top referrers
    const refEl = document.getElementById('metricsReferrers');
    if (refEl) {
        if (!top_referrers.length) { refEl.innerHTML = '<div class="metrics-empty">Sem dados ainda</div>'; }
        else {
            const maxV = top_referrers[0]?.views || 1;
            refEl.innerHTML = top_referrers.slice(0, 8).map(r => `
                <div class="metrics-row">
                    <span class="metrics-row-label">${esc(r.host)}</span>
                    <span class="metrics-row-value">${r.views}</span>
                </div>
                <div class="metrics-bar-wrap"><div class="metrics-bar-fill" style="width:${Math.round(r.views/maxV*100)}%"></div></div>
            `).join('');
        }
    }

    // Dispositivos
    const devEl = document.getElementById('metricsDevices');
    if (devEl) {
        if (!devices.length) { devEl.innerHTML = '<div class="metrics-empty">Sem dados ainda</div>'; }
        else {
            const total = devices.reduce((s, d) => s + (d.views || 0), 0) || 1;
            const icons = { mobile: 'fa-mobile-screen', tablet: 'fa-tablet-screen-button', desktop: 'fa-desktop' };
            devEl.innerHTML = devices.map(d => {
                const pct = Math.round(d.views / total * 100);
                const icon = icons[d.device] || 'fa-display';
                return `
                    <div class="metrics-row">
                        <span class="metrics-row-label"><i class="fa-solid ${icon}" style="width:14px;text-align:center;margin-right:6px;color:var(--text-dim)"></i>${esc(d.device)}</span>
                        <span class="metrics-row-value">${pct}%</span>
                    </div>
                    <div class="metrics-bar-wrap"><div class="metrics-bar-fill" style="width:${pct}%"></div></div>
                `;
            }).join('');
        }
    }

    // Países
    const cntEl = document.getElementById('metricsCountries');
    if (cntEl) {
        if (!countries.length) { cntEl.innerHTML = '<div class="metrics-empty">Sem dados ainda</div>'; }
        else {
            const maxV = countries[0]?.views || 1;
            cntEl.innerHTML = countries.slice(0, 8).map(c => `
                <div class="metrics-row">
                    <span class="metrics-row-label">${esc(c.country)}</span>
                    <span class="metrics-row-value">${c.views}</span>
                </div>
                <div class="metrics-bar-wrap"><div class="metrics-bar-fill" style="width:${Math.round(c.views/maxV*100)}%"></div></div>
            `).join('');
        }
    }

    // Funil pareado (% de visitantes únicos)
    const fuKeys   = ['pageview','engaged','cv-click','cv-download'];
    const fuVals   = [funnel_unique.pageview ?? 0, funnel_unique.engaged ?? 0, funnel_unique.cv_click ?? 0, funnel_unique.cv_download ?? 0];
    const fuMax    = fuVals[0] || 1;
    fuKeys.forEach((key, i) => {
        const bar  = document.getElementById(`fu-bar-${key}`);
        const val  = document.getElementById(`fu-val-${key}`);
        const pct  = document.getElementById(`fu-pct-${key}`);
        if (!bar || !val || !pct) return;
        const w    = Math.round((fuVals[i] / fuMax) * 100);
        bar.style.width  = w + '%';
        val.textContent  = fuVals[i];
        pct.textContent  = i === 0 ? '100%' : (fuMax > 0 ? Math.round((fuVals[i] / fuMax) * 100) + '%' : '—');
    });

    // Hora-do-dia (0-23, BRT)
    _renderHourlyChart(hourly);

    // Dia-da-semana
    _renderDowChart(dow);

    // Conversão por origem
    const rcEl = document.getElementById('metricsRefConversion');
    if (rcEl) {
        if (!referrer_conversion.length) { rcEl.innerHTML = '<div class="metrics-empty">Sem dados ainda</div>'; }
        else {
            rcEl.innerHTML = `
                <table class="metrics-table">
                    <thead><tr><th>Origem</th><th class="num">Visitas</th><th class="num">CV</th><th class="num">Conv.</th></tr></thead>
                    <tbody>${referrer_conversion.slice(0, 10).map(r => `
                        <tr>
                            <td title="${esc(r.host)}">${esc(r.host)}</td>
                            <td class="num">${r.views}</td>
                            <td class="num">${r.cv_clicks}</td>
                            <td class="num"><strong style="color:${r.conversion_rate > 0 ? 'var(--cyan)' : 'var(--text-dim)'}">${r.conversion_rate}%</strong></td>
                        </tr>`).join('')}
                    </tbody>
                </table>`;
        }
    }
}

function _fmtDuration(secs) {
    const s = Number(secs ?? 0);
    if (!s) return '—';
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return r ? `${m}m ${r}s` : `${m}m`;
}

function _renderHourlyChart(hourly) {
    const ctx = document.getElementById('hourlyChart');
    if (!ctx) return;
    const byHour = new Map((hourly || []).map(r => [Number(r.hour), Number(r.views)]));
    const labels = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + 'h');
    const data   = Array.from({ length: 24 }, (_, i) => byHour.get(i) || 0);
    if (_hourlyChart) { _hourlyChart.destroy(); _hourlyChart = null; }
    _hourlyChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Visitas', data, backgroundColor: 'rgba(124,58,237,0.35)', borderColor: 'rgba(124,58,237,0.9)', borderWidth: 1, borderRadius: 3 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#5c5c80', font: { size: 9 } }, grid: { display: false } },
                y: { ticks: { color: '#5c5c80', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
            },
        },
    });
}

function _renderDowChart(dow) {
    const ctx = document.getElementById('dowChart');
    if (!ctx) return;
    const byDow = new Map((dow || []).map(r => [Number(r.dow), Number(r.views)]));
    const labels = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const data   = Array.from({ length: 7 }, (_, i) => byDow.get(i) || 0);
    if (_dowChart) { _dowChart.destroy(); _dowChart = null; }
    _dowChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Visitas', data, backgroundColor: 'rgba(34,211,238,0.3)', borderColor: 'rgba(34,211,238,0.85)', borderWidth: 1, borderRadius: 3 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#5c5c80', font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: '#5c5c80', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
            },
        },
    });
}

// Drill-down de jornada do visitante (hash7) — abre modal com timeline
async function openVisitorJourney(hash7) {
    if (!/^[a-f0-9]{7}$/.test(String(hash7 || '').toLowerCase())) return;
    document.getElementById('kpiDetailModal').classList.add('open');
    document.getElementById('kpiDetailTitle').textContent = `Jornada do visitante ${hash7}`;
    const body = document.getElementById('kpiDetailBody');
    body.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:40px"><i class="fa-solid fa-circle-notch fa-spin fa-lg"></i></div>';
    try {
        const r = _lastAnalyticsRange || {};
        const qs = new URLSearchParams({ hash7, from: r.from || '', to: r.to || '' });
        const data = await api('GET', `/api/admin/visitor-journey?${qs}`);
        const events = data.events || [];
        if (!events.length) {
            body.innerHTML = '<div class="metrics-empty">Nenhum evento encontrado para esse visitante no período.</div>';
            return;
        }
        const fmtTs = ts => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const evColor = e => ({ pageview: 'var(--cyan)', engaged: '#7c3aed', cv_download_click: '#f59e0b', cv_view: '#f59e0b', contact_click: '#34d399', case_open: '#22d3ee', project_click: '#22d3ee' }[e] || 'var(--text-soft)');
        body.innerHTML = `
            <div class="visitor-journey">
                ${events.map(ev => `
                    <div class="vj-row">
                        <span class="vj-time">${fmtTs(ev.occurred_at)}</span>
                        <span class="vj-event" style="color:${evColor(ev.event)}">${esc(ev.event)}</span>
                        <span class="vj-path">${esc(ev.path || '—')}</span>
                        ${ev.session_id ? `<span class="vj-sess" title="Sessão">${esc(ev.session_id.slice(0, 8))}</span>` : ''}
                    </div>
                `).join('')}
            </div>`;
    } catch (e) {
        body.innerHTML = `<div class="metrics-empty">Erro ao carregar jornada: ${esc(e.message || 'desconhecido')}</div>`;
    }
}

// ─── DRILL-DOWN DOS CARDS DE MÉTRICAS ─────────────────────
function openKpiDetail(kind) {
    if (!_lastAnalyticsData) return;
    document.getElementById('kpiDetailModal').classList.add('open');
    const titles = {
        visitas:             'Visitas — detalhes',
        unicos:              'Visitantes únicos — detalhes',
        engajados:           'Engajados — detalhes',
        'cv-clicks':         'Cliques em CV — detalhes',
        'cv-downloads':      'Downloads reais — detalhes',
        recorrentes:         'Recorrentes — detalhes',
        sessoes:             'Sessões — detalhes',
        bounce:              'Bounce rate — detalhes',
        'pages-per-session': 'Páginas por sessão — detalhes',
        'avg-duration':      'Duração média — detalhes',
        'retention-7d':      'Retenção 7 dias — detalhes',
        'retention-30d':     'Retenção 30 dias — detalhes',
        demo:                'Acessos demo — detalhes',
    };
    document.getElementById('kpiDetailTitle').textContent = titles[kind] || 'Detalhes';
    (_kpiRenderers[kind] || (() => {}))(_lastAnalyticsData);
}
function closeKpiDetail() { document.getElementById('kpiDetailModal').classList.remove('open'); }
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('kpiDetailModal')?.classList.contains('open')) closeKpiDetail();
});

// ─── ATALHOS DE TECLADO GLOBAIS ────────────────────────────
(function _initKeyboardShortcuts() {
    let _gPressed = false, _gTimer = null;

    document.addEventListener('keydown', e => {
        // Ignora quando foco está em campo de texto
        const tag = e.target.tagName;
        const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;

        // Esc: fecha drawers/modais abertos
        if (e.key === 'Escape') {
            if (!document.getElementById('shortcutsOverlay')?.hidden) { closeShortcuts(); return; }
            if (document.getElementById('tokenDrawer')?.classList.contains('open')) { closeTokenDrawer(); return; }
        }

        if (editable) return;

        // ? → toggle shortcuts
        if (e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }

        // / → foca busca da aba ativa
        if (e.key === '/') {
            e.preventDefault();
            const tab = typeof _activeTab !== 'undefined' ? _activeTab : '';
            const map = { tokens: 'tokenSearch', logs: 'logSearch', cvs: 'cvSearch', vagas: 'vagasSearch' };
            const id  = map[tab];
            if (id) document.getElementById(id)?.focus();
            return;
        }

        // n → expande form de criação de token (aba tokens)
        if (e.key === 'n' || e.key === 'N') {
            const tab = typeof _activeTab !== 'undefined' ? _activeTab : '';
            if (tab === 'tokens') {
                e.preventDefault();
                const btn = document.getElementById('tokenFormToggleBtn');
                if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
                setTimeout(() => document.getElementById('tokenCV')?.focus(), 100);
            }
            return;
        }

        // g + [t/l/c/v/m] → navegar abas
        if (e.key === 'g') { _gPressed = true; clearTimeout(_gTimer); _gTimer = setTimeout(() => { _gPressed = false; }, 1000); return; }
        if (_gPressed) {
            _gPressed = false;
            clearTimeout(_gTimer);
            const tabMap = { t: 'tokens', l: 'logs', c: 'cvs', v: 'vagas', m: 'metricas' };
            const dest = tabMap[e.key];
            if (dest) { e.preventDefault(); switchTab(dest); }
        }
    });
})();

function toggleShortcuts() {
    const el = document.getElementById('shortcutsOverlay');
    if (!el) return;
    el.hidden = !el.hidden;
}
function closeShortcuts() {
    const el = document.getElementById('shortcutsOverlay');
    if (el) el.hidden = true;
}

function _kpiSection(title, html) {
    return `<div class="kpi-detail-section"><div class="kpi-detail-section-title">${esc(title)}</div>${html || '<div class="kpi-detail-row meta">Sem dados</div>'}</div>`;
}
function _kpiRow(left, right) {
    return `<div class="kpi-detail-row"><span>${left}</span><span>${right}</span></div>`;
}
// Bloco explicativo colapsado dos drill-downs ("O que isto mede?")
function _explain(html) {
    return `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>${html}</details>`;
}
function _kpiEventRow(occurred_at, path, country, device, hash7, isAdmin) {
    const adminBadge = isAdmin ? `<span style="color:#4ade80;font-size:0.7rem;margin-left:5px">● você</span>` : '';
    const hashEl = hash7
        ? `<span class="kpi-hash" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" title="Ver jornada deste visitante" onclick="event.stopPropagation();openVisitorJourney('${esc(hash7)}')">#${esc(hash7)}</span>`
        : '';
    const meta = [fmtDate(occurred_at, true), country || '?', device || '', hashEl].filter(Boolean).join(' · ');
    const rowStyle = isAdmin ? ' style="background:rgba(74,222,128,0.05)"' : '';
    return `<div class="kpi-detail-row"${rowStyle}><span>${esc(path || '/')}${adminBadge}</span><span class="meta">${meta}</span></div>`;
}

const _kpiRenderers = {
    visitas: data => {
        const { kpis = {}, top_pages = [], latest_visits = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Total de visitas', `<strong>${kpis.pageviews ?? 0}</strong>`)}
            ${_kpiRow('Engajamento', `<strong>${kpis.engaged_rate ?? 0}%</strong>`)}
            ${_kpiRow('Conversão para download', `<strong>${kpis.conversion_rate ?? 0}%</strong>`)}
        </div>`;
        const topHtml = top_pages.length ? `<div class="kpi-detail-list">${top_pages.slice(0, 10).map(p => {
            const label = (p.path || '/') === '/' ? 'Início' : p.path;
            return _kpiRow(esc(label), `<span class="meta">${p.views} visitas · ${p.unique_visitors} únicos</span>`);
        }).join('')}</div>` : '';
        const visitsHtml = latest_visits.length ? `<div class="kpi-detail-list">${latest_visits.map(v =>
            _kpiEventRow(v.occurred_at, v.path === '/' ? 'Início' : v.path, v.country, v.device, v.hash7, v.is_admin)
        ).join('')}</div>` : '';
        body.innerHTML = _kpiSection('Resumo', resumo) + _kpiSection('Top páginas', topHtml) + _kpiSection('Últimas visitas', visitsHtml)
            + _explain(`<p>Cada visita é um pageview registrado pelo <code>analytics.js</code>: dispara no <code>DOMContentLoaded</code> de qualquer página pública do site. Recarregar a página conta como nova visita; navegar entre páginas internas também. Visitas de bots conhecidos e do próprio admin (quando o toggle está ligado) são excluídas.</p>`);
    },
    unicos: data => {
        const { kpis = {}, devices = [], countries = [], top_referrers = [], utm_sources = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const dList = devices.length ? `<div class="kpi-detail-list">${devices.map(d => _kpiRow(esc(d.device || '?'), `<span class="meta">${d.views} visitas</span>`)).join('')}</div>` : '';
        const cList = countries.length ? `<div class="kpi-detail-list">${countries.slice(0, 10).map(c => _kpiRow(esc(c.country || '?'), `<span class="meta">${c.views} visitas</span>`)).join('')}</div>` : '';
        const rList = top_referrers.length ? `<div class="kpi-detail-list">${top_referrers.slice(0, 10).map(r => _kpiRow(esc(r.host || '(direto)'), `<span class="meta">${r.views} visitas</span>`)).join('')}</div>` : '';
        const utmFiltered = utm_sources.filter(u => u.source && u.source !== '(nenhum)');
        const uList = utmFiltered.length ? `<div class="kpi-detail-list">${utmFiltered.slice(0, 10).map(u => _kpiRow(esc(u.source), `<span class="meta">${u.views} visitas</span>`)).join('')}</div>` : '<div class="metrics-empty" style="font-size:0.82rem">Nenhuma visita via UTM no período.<br>Adicione <code>?utm_source=linkedin</code> nos seus links para rastrear.</div>';
        body.innerHTML = _kpiSection('Total', `<div class="kpi-detail-list">${_kpiRow('Visitantes únicos', `<strong>${kpis.unique_visitors ?? 0}</strong>`)}</div>`)
            + _kpiSection('Dispositivos', dList) + _kpiSection('Países', cList)
            + _kpiSection('Origens', rList) + _kpiSection('UTM sources', uList)
            + _explain(`<p>Visitantes únicos = quantidade distinta de <code>visitor_id_hash</code> no período. O hash é <strong>SHA-256(IP + User-Agent + salt-do-dia)</strong>, calculado no backend e regerado a cada dia — então o mesmo navegador conta como novo a partir do dia seguinte. Não há cookie nem fingerprint persistente.</p>`);
    },
    engajados: data => {
        const { kpis = {}, top_pages = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const ranked = (top_pages || []).filter(p => p.views > 0)
            .map(p => ({ ...p, rate: p.views ? Math.round((p.engaged || 0) / p.views * 1000) / 10 : 0 }))
            .sort((a, b) => b.rate - a.rate).slice(0, 10);
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Engajados (total)', `<strong>${Math.round((kpis.engaged_rate || 0) * (kpis.pageviews || 0) / 100)}</strong>`)}
            ${_kpiRow('Taxa de engajamento', `<strong>${kpis.engaged_rate ?? 0}%</strong> das visitas`)}
        </div>`;
        const rank = ranked.length ? `<div class="kpi-detail-list">${ranked.map(p => {
            const label = (p.path || '/') === '/' ? 'Início' : p.path;
            return _kpiRow(esc(label), `<span class="meta">${p.rate}% · ${p.engaged}/${p.views}</span>`);
        }).join('')}</div>` : '';
        body.innerHTML = _kpiSection('Resumo', resumo) + _kpiSection('Top páginas por engajamento', rank)
            + _explain(`<p>Engajamento dispara via evento <code>engaged</code> quando o visitante permanece <strong>30 segundos</strong> na mesma página sem fechar a aba. É um proxy de interesse real, diferente de uma visita-relâmpago. A taxa = engaged ÷ visitas (limite teórico 100%).</p>`);
    },
    'cv-clicks': data => {
        const { kpis = {}, latest_cv_clicks = [], cv_page_contacts = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Total de cliques', `<strong>${kpis.cv_download_clicks ?? 0}</strong>`)}
            ${_kpiRow('Downloads reais', `<strong>${kpis.cv_downloads ?? 0}</strong>`)}
            ${_kpiRow('Conversão', `<strong>${kpis.conversion_rate ?? 0}%</strong>`)}
        </div>`;
        const labelMap = { whatsapp: 'WhatsApp', email: 'E-mail' };
        const canalRows = cv_page_contacts.length
            ? cv_page_contacts.map(c => _kpiRow(labelMap[c.name] || c.name, `<strong>${c.count}</strong>`)).join('')
            : _kpiRow('Sem dados ainda', '<span class="meta">cliques na página /cv serão exibidos aqui</span>');
        const list = latest_cv_clicks.length ? `<div class="kpi-detail-list">${latest_cv_clicks.map(c =>
            _kpiEventRow(c.occurred_at, c.path === '/' ? 'Início' : c.path, c.country, c.device, c.hash7, c.is_admin)
        ).join('')}</div>` : '';
        body.innerHTML = _kpiSection('Resumo', resumo)
            + _kpiSection('Canal preferido na página CV', `<div class="kpi-detail-list">${canalRows}</div>`)
            + _kpiSection('Últimos cliques em CV', list)
            + _explain(`<p>Clique em qualquer link que leve a <code>/cv</code> ou ao endpoint <code>/api/cv/download</code>. <strong>Não é o download em si</strong> — apenas a intenção. A diferença para "Downloads reais" mostra quantos clicaram mas desistiram (rate-limit, link expirado, etc.).</p>`);
    },
    'cv-downloads': async data => {
        const body = document.getElementById('kpiDetailBody');
        body.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`;
        try {
            const result = await api('GET', `/api/admin/logs?tipo=download&page=1&page_size=30`);
            const rows = (result.data || []).map(l => {
                const ua = _parseUA(l.user_agent) || '';
                const meta = [fmtDate(l.downloaded_at, true), `IP <span class="kpi-hash">${esc(l.ip_address || '?')}</span>`, ua].filter(Boolean).join(' · ');
                return `<div class="kpi-detail-row"><span>${esc(l.cv_name_snapshot || '—')}</span><span class="meta">${meta}</span></div>`;
            }).join('');
            const resumo = `<div class="kpi-detail-list">
                ${_kpiRow('Downloads reais', `<strong>${data.kpis?.cv_downloads ?? 0}</strong>`)}
                ${_kpiRow('Conversão', `<strong>${data.kpis?.conversion_rate ?? 0}%</strong>`)}
            </div>`;
            body.innerHTML = _kpiSection('Resumo', resumo)
                + _kpiSection('Últimos downloads (até 30, com IP real)', rows ? `<div class="kpi-detail-list">${rows}</div>` : '')
                + _explain(`<p>Cada download que efetivamente saiu do servidor é registrado em <code>download_logs</code> com o IP real (apenas para auditoria, não exibido em outras métricas). Conversão = downloads reais ÷ visitas no período. Inserts feitos pelo painel admin (envio por e-mail/WhatsApp) são excluídos quando o toggle "Excluir meus acessos" está ligado.</p>`);
        } catch (e) {
            body.innerHTML = `<p style="color:var(--danger);padding:20px">${esc(e.message)}</p>`;
        }
    },
    recorrentes: data => {
        const { kpis = {}, top_recurring = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const list = top_recurring.length ? `<div class="kpi-detail-list">${top_recurring.map(r => {
            const meta = [`primeira: ${fmtDate(r.first_seen, true)}`, `última: ${fmtDate(r.last_seen, true)}`, r.top_country || ''].filter(Boolean).join(' · ');
            return `<div class="kpi-detail-row"><span><span class="kpi-hash">#${esc(r.hash7 || '???')}</span> · <strong>${r.visit_count} visitas</strong></span><span class="meta">${meta}</span></div>`;
        }).join('')}</div>` : '';
        body.innerHTML = _kpiSection('Resumo', `<div class="kpi-detail-list">${_kpiRow('Visitantes recorrentes', `<strong>${kpis.recurring_visitors ?? 0}</strong>`)}</div>`)
            + _kpiSection('Top 10 (anonimizados)', list)
            + _explain(`<p>Visitante recorrente = mesmo <code>visitor_id_hash</code> visto em <strong>≥ 2 dias distintos</strong> dentro do período (em horário de Brasília). Como o hash regenera a cada dia, isso significa que o IP+UA bate em dias diferentes — sinal forte de retorno legítimo, não refresh.</p>`);
    },

    sessoes: data => {
        const { kpis = {} } = data;
        const body = document.getElementById('kpiDetailBody');
        const total = Number(kpis.total_sessions ?? 0);
        const pv    = Number(kpis.pageviews ?? 0);
        const diff  = pv - total;
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Total de sessões',  `<strong>${total}</strong>`)}
            ${_kpiRow('Bounce rate',       `<strong>${kpis.bounce_rate ?? 0}%</strong>`)}
            ${_kpiRow('Páginas / sessão',  `<strong>${kpis.pages_per_session ?? 0}</strong>`)}
            ${_kpiRow('Duração média',     `<strong>${_fmtDuration(kpis.avg_session_seconds)}</strong>`)}
        </div>`;
        const cmp = `<div class="kpi-detail-list">
            ${_kpiRow('Visitas no período',  `<strong>${pv}</strong>`)}
            ${_kpiRow('Sessões com tracking', `<strong>${total}</strong>`)}
            ${diff > 0 ? _kpiRow('Visitas sem session_id', `<span class="meta">${diff} (anteriores ao tracking)</span>`) : ''}
        </div>`;
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Uma <strong>sessão</strong> é a sequência de eventos do mesmo visitante com menos de 30 minutos de inatividade entre eles. O ID é gerado no <code>localStorage</code> ao primeiro acesso e expira automaticamente. Visitas mais antigas que o tracking de sessão não contam.</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo) + _kpiSection('Comparativo', cmp) + explain;
    },

    bounce: data => {
        const { kpis = {}, top_pages = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const total = Number(kpis.total_sessions ?? 0);
        const rate  = Number(kpis.bounce_rate ?? 0);
        const bouncing = Math.round(rate * total / 100);
        const ranked = (top_pages || []).filter(p => p.views > 0)
            .map(p => ({ ...p, eng_rate: p.views ? Math.round((p.engaged || 0) / p.views * 1000) / 10 : 0 }))
            .sort((a, b) => a.eng_rate - b.eng_rate).slice(0, 10);
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Bounce rate',          `<strong>${rate}%</strong>`)}
            ${_kpiRow('Sessões bouncing',     `<strong>${bouncing}</strong> de ${total}`)}
            ${_kpiRow('Sessões com engajamento', `<strong>${total - bouncing}</strong>`)}
        </div>`;
        const rank = ranked.length ? `<div class="kpi-detail-list">${ranked.map(p => {
            const label = (p.path || '/') === '/' ? 'Início' : p.path;
            return _kpiRow(esc(label), `<span class="meta">${p.eng_rate}% engaj. · ${p.engaged || 0}/${p.views}</span>`);
        }).join('')}</div>` : '';
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Sessão "bouncing" = teve apenas <strong>1 pageview</strong> e <strong>nenhum evento <code>engaged</code></strong> (que dispara após 30s de permanência). Indica visitas que abriram e saíram sem interagir.</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo)
            + _kpiSection('Páginas com menor engajamento (candidatas a bounce)', rank)
            + explain;
    },

    'pages-per-session': data => {
        const { kpis = {}, top_pages = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const avg = Number(kpis.pages_per_session ?? 0);
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Média de páginas / sessão', `<strong>${avg}</strong>`)}
            ${_kpiRow('Total de sessões',         `<strong>${kpis.total_sessions ?? 0}</strong>`)}
            ${_kpiRow('Total de pageviews',       `<strong>${kpis.pageviews ?? 0}</strong>`)}
        </div>`;
        const pages = top_pages.length ? `<div class="kpi-detail-list">${top_pages.slice(0, 10).map(p => {
            const label = (p.path || '/') === '/' ? 'Início' : p.path;
            return _kpiRow(esc(label), `<span class="meta">${p.views} visitas · ${p.unique_visitors} únicos</span>`);
        }).join('')}</div>` : '';
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Quantas páginas, em média, cada sessão visita antes de encerrar. <strong>1.0</strong> = visitantes nunca navegam internamente. <strong>≥ 2.0</strong> = exploração ativa do portfólio.</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo) + _kpiSection('Top páginas no período', pages) + explain;
    },

    'avg-duration': data => {
        const { kpis = {}, hourly = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Duração média da sessão', `<strong>${_fmtDuration(kpis.avg_session_seconds)}</strong>`)}
            ${_kpiRow('Total de sessões',        `<strong>${kpis.total_sessions ?? 0}</strong>`)}
        </div>`;
        const hourlySorted = (hourly || []).slice().sort((a, b) => Number(b.views) - Number(a.views)).slice(0, 8);
        const hourlyHtml = hourlySorted.length ? `<div class="kpi-detail-list">${hourlySorted.map(h => {
            const hh = String(h.hour).padStart(2, '0');
            return _kpiRow(`${hh}h–${String((Number(h.hour) + 1) % 24).padStart(2, '0')}h (BRT)`, `<span class="meta">${h.views} visitas · ${h.unique_visitors} únicos</span>`);
        }).join('')}</div>` : '';
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Diferença em segundos entre o primeiro e o último evento registrado da sessão. Sessões com 1 só evento têm duração 0.</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo)
            + _kpiSection('Horários de pico (top 8 por visitas)', hourlyHtml)
            + explain;
    },

    'retention-7d': data => {
        const { retention = {}, top_recurring = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const total = Number(retention.total_visitors ?? 0);
        const ret7  = Number(retention.returned_in_7d ?? 0);
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Retenção 7 dias',           `<strong>${retention.retention_7d_pct ?? 0}%</strong>`)}
            ${_kpiRow('Visitantes que retornaram', `<strong>${ret7}</strong> de ${total}`)}
            ${_kpiRow('Não retornaram em 7d',      `<strong>${Math.max(0, total - ret7)}</strong>`)}
        </div>`;
        const list = top_recurring.length ? `<div class="kpi-detail-list">${top_recurring.slice(0, 10).map(r => {
            const meta = [`primeira: ${fmtDate(r.first_seen, true)}`, `última: ${fmtDate(r.last_seen, true)}`, r.top_country || ''].filter(Boolean).join(' · ');
            return `<div class="kpi-detail-row"><span><span class="kpi-hash">#${esc(r.hash7 || '???')}</span> · <strong>${r.visit_count} visitas</strong></span><span class="meta">${meta}</span></div>`;
        }).join('')}</div>` : '';
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Percentual de visitantes únicos do período que voltaram ao site dentro de até <strong>7 dias</strong> após a primeira visita (com pelo menos 1h de intervalo entre acessos, evitando reload imediato).</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo)
            + _kpiSection('Visitantes recorrentes (anonimizados)', list)
            + explain;
    },

    'retention-30d': data => {
        const { retention = {}, top_recurring = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const total = Number(retention.total_visitors ?? 0);
        const ret30 = Number(retention.returned_in_30d ?? 0);
        const ret7  = Number(retention.returned_in_7d ?? 0);
        const r7    = Number(retention.retention_7d_pct ?? 0);
        const r30   = Number(retention.retention_30d_pct ?? 0);
        const cresc = (r30 - r7).toFixed(1);
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Retenção 30 dias',          `<strong>${r30}%</strong>`)}
            ${_kpiRow('Visitantes que retornaram', `<strong>${ret30}</strong> de ${total}`)}
            ${_kpiRow('Não retornaram em 30d',     `<strong>${Math.max(0, total - ret30)}</strong>`)}
        </div>`;
        const cmp = `<div class="kpi-detail-list">
            ${_kpiRow('Retornaram em 7 dias',  `<strong>${ret7}</strong> (${r7}%)`)}
            ${_kpiRow('Retornaram em 30 dias', `<strong>${ret30}</strong> (${r30}%)`)}
            ${_kpiRow('Crescimento 7d → 30d',  `<span class="meta">+${cresc}pp</span>`)}
        </div>`;
        const list = top_recurring.length ? `<div class="kpi-detail-list">${top_recurring.slice(0, 10).map(r => {
            const meta = [`primeira: ${fmtDate(r.first_seen, true)}`, `última: ${fmtDate(r.last_seen, true)}`, r.top_country || ''].filter(Boolean).join(' · ');
            return `<div class="kpi-detail-row"><span><span class="kpi-hash">#${esc(r.hash7 || '???')}</span> · <strong>${r.visit_count} visitas</strong></span><span class="meta">${meta}</span></div>`;
        }).join('')}</div>` : '';
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Percentual de visitantes únicos do período que voltaram dentro de até <strong>30 dias</strong>. Comparar com a janela de 7 dias mostra quantos retornam mais tarde — sinal de interesse persistente.</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo)
            + _kpiSection('Comparativo 7d × 30d', cmp)
            + _kpiSection('Visitantes recorrentes (anonimizados)', list)
            + explain;
    },

    demo: data => {
        const { demo_accesses = 0, latest_demo_accesses = [] } = data;
        const body = document.getElementById('kpiDetailBody');
        const resumo = `<div class="kpi-detail-list">
            ${_kpiRow('Total de acessos demo', `<strong style="color:#a78bfa">${demo_accesses}</strong>`)}
        </div>`;
        const list = latest_demo_accesses.length
            ? `<div class="kpi-detail-list">${latest_demo_accesses.map(d => {
                const emailMeta = d.meta && typeof d.meta === 'object' && d.meta.email
                    ? ` · ${esc(String(d.meta.email).slice(0, 30))}` : '';
                const meta = [fmtDate(d.occurred_at, true), d.country || '?', d.device || '', d.browser || ''].filter(Boolean).join(' · ') + emailMeta;
                return `<div class="kpi-detail-row"><span>Login no showcase</span><span class="meta">${meta}</span></div>`;
            }).join('')}</div>`
            : '';
        const explain = `<details class="kpi-detail-explain"><summary>O que isto mede?</summary>
            <p>Cada vez que alguém usa as credenciais <code>demo@artacho.dev</code> na página <code>/projeto-sistema-admin</code> e entra no showcase do painel administrativo. A sessão demo é descartável: usa um banco isolado e é resetada ao fechar a aba.</p>
        </details>`;
        body.innerHTML = _kpiSection('Resumo', resumo)
            + _kpiSection('Últimos acessos demo (até 20)', list)
            + explain;
    },
};

// ─── ANÁLISE DE VAGAS ─────────────────────────────────────
let _vagasSubTab          = 'lista';
let _vagasAnalysisPeriod  = 'month';
let _vagasChartMode       = 'dow';
let _vagasAnalysisChart   = null;
let _vagasAnalysisLoaded  = false;
let _vagasIncludeArchived = false;

function switchVagasSubTab(tab, btn) {
    _vagasSubTab = tab;
    document.querySelectorAll('.vagas-subtab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('vagasListView').style.display      = tab === 'lista'   ? '' : 'none';
    const kanbanEl = document.getElementById('vagasKanbanView');
    if (kanbanEl) kanbanEl.style.display                        = tab === 'kanban'  ? '' : 'none';
    document.getElementById('vagasAnalysisView').style.display  = tab === 'analise' ? '' : 'none';
    if (tab === 'kanban')  renderKanban(_applications);
    if (tab === 'analise' && !_vagasAnalysisLoaded) loadVagasAnalysis();
}

function setVagasAnalysisPeriod(period, btn) {
    _vagasAnalysisPeriod = period;
    if (btn) {
        document.querySelectorAll('#vagasAnalysisPeriodBar .metrics-period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }
    if (period !== 'custom') {
        const from = document.getElementById('vagasAnalysisFrom');
        const to   = document.getElementById('vagasAnalysisTo');
        if (from) from.value = '';
        if (to)   to.value   = '';
    }
    loadVagasAnalysis();
}

function setVagasChartMode(mode, btn) {
    _vagasChartMode = mode;
    document.querySelectorAll('#vagasChartModeBar .metrics-period-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadVagasAnalysis();
}

function setVagasIncludeArchived(checked) {
    _vagasIncludeArchived = !!checked;
    loadVagasAnalysis();
}

function _vagasTimelineBucket(from, to) {
    if (!from || !to) return 'month';
    const days = Math.round((new Date(to) - new Date(from)) / 86400000);
    if (days <= 31)  return 'day';
    if (days <= 180) return 'week';
    if (days <= 730) return 'month';
    return 'year';
}

// Preenche buckets vazios entre `from` e `to` com count 0.
// `valueKeys` define quais campos copiar do bucket existente (default: ['cnt']).
function _fillTimelineGaps(points, bucketType, from, to, valueKeys = ['cnt']) {
    if (!from || !to) return points || [];
    const map = new Map((points || []).map(p => [String(p.bucket).slice(0, 10), p]));
    const result = [];
    let cur = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T23:59:59Z`);

    if (bucketType === 'week') {
        const day = cur.getUTCDay();
        cur.setUTCDate(cur.getUTCDate() + (day === 0 ? -6 : 1 - day));
    } else if (bucketType === 'month') {
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1));
    } else if (bucketType === 'year') {
        cur = new Date(Date.UTC(cur.getUTCFullYear(), 0, 1));
    }

    let guard = 0;
    while (cur <= end && guard++ < 400) {
        const key = cur.toISOString().slice(0, 10);
        const found = map.get(key);
        if (found) {
            result.push({ ...found, bucket: key });
        } else {
            const zero = { bucket: key };
            valueKeys.forEach(k => { zero[k] = 0; });
            result.push(zero);
        }
        if (bucketType === 'day')        cur.setUTCDate(cur.getUTCDate() + 1);
        else if (bucketType === 'week')  cur.setUTCDate(cur.getUTCDate() + 7);
        else if (bucketType === 'month') cur.setUTCMonth(cur.getUTCMonth() + 1);
        else if (bucketType === 'year')  cur.setUTCFullYear(cur.getUTCFullYear() + 1);
        else break;
    }
    return result;
}

function _vagasDateRange() {
    const now = new Date();
    const fmt = d => d.toISOString().slice(0, 10);
    if (_vagasAnalysisPeriod === 'all') return { from: '', to: '' };
    if (_vagasAnalysisPeriod === 'custom') {
        return {
            from: document.getElementById('vagasAnalysisFrom')?.value || '',
            to:   document.getElementById('vagasAnalysisTo')?.value   || fmt(now),
        };
    }
    const days = { today: 0, week: 6, month: 29, year: 364 }[_vagasAnalysisPeriod] ?? 29;
    return { from: fmt(new Date(Date.now() - days * 86400000)), to: fmt(now) };
}

async function loadVagasAnalysis() {
    const { from, to } = _vagasDateRange();
    const params = new URLSearchParams({ scope: 'vagas', mode: _vagasChartMode });
    if (_vagasChartMode === 'timeline') params.set('bucket', _vagasTimelineBucket(from, to));
    if (from) params.set('from', from);
    if (to)   params.set('to',   to);
    if (_vagasIncludeArchived) params.set('include_archived', '1');
    try {
        const data = await api('GET', `/api/admin/analytics?${params}`);
        renderVagasAnalysis(data);
        _vagasAnalysisLoaded = true;
    } catch (e) {
        ['vkpi-total','vkpi-em-processo','vkpi-aprovado','vkpi-recusado']
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    }
}

function renderVagasAnalysis(data) {
    const { total = 0, by_result = [], by_modalidade = [], by_tipo = [], by_stage = [] } = data;
    const chart = data.chart || { mode: 'timeline', bucket: 'week', points: data.series || [] };

    const byResult = Object.fromEntries((by_result || []).map(r => [r.result, r.cnt]));
    document.getElementById('vkpi-total').textContent       = total ?? '—';
    document.getElementById('vkpi-em-processo').textContent = byResult.em_processo ?? 0;
    document.getElementById('vkpi-aprovado').textContent    = byResult.aprovado    ?? 0;
    document.getElementById('vkpi-recusado').textContent    = byResult.recusado    ?? 0;

    const points = chart.points || [];
    let labels, values, title;
    if (chart.mode === 'timeline') {
        title = 'Candidaturas ao longo do tempo';
        const { from, to } = _vagasDateRange();
        const filled = _fillTimelineGaps(points, chart.bucket || 'day', from, to);
        labels = filled.map(s => {
            const d = new Date(s.bucket);
            if (chart.bucket === 'month') return d.toLocaleDateString('pt-BR', { month:'short', year:'2-digit', timeZone: 'UTC' });
            if (chart.bucket === 'year')  return String(d.getUTCFullYear());
            return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', timeZone: 'UTC' });
        });
        values = filled.map(s => Number(s.cnt) || 0);
    } else {
        const cfg = {
            dow: { len: 7,  names: ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'],                                 title: 'Candidaturas por dia da semana' },
            wom: { len: 5,  names: ['Sem 1','Sem 2','Sem 3','Sem 4','Sem 5'],                                  title: 'Candidaturas por semana do mês' },
            dom: { len: 31, names: Array.from({length:31}, (_, i) => String(i + 1)),                          title: 'Candidaturas por dia do mês' },
            moy: { len: 12, names: ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'], title: 'Candidaturas por mês' },
        }[chart.mode] || { len: 0, names: [], title: 'Candidaturas' };
        const counts = new Array(cfg.len).fill(0);
        points.forEach(p => {
            const idx = Number(p.idx);
            const pos = (chart.mode === 'dow') ? (idx === 7 ? 0 : idx) : idx - 1;
            if (pos >= 0 && pos < cfg.len) counts[pos] = Number(p.cnt) || 0;
        });
        title = cfg.title;
        if (chart.mode === 'dow') {
            const { from, to } = _vagasDateRange();
            const fromMs = from ? new Date(from + 'T00:00:00Z').getTime() : null;
            const toMs   = to   ? new Date(to   + 'T23:59:59Z').getTime() : null;
            if (fromMs && toMs) {
                const totalDays = Math.round((toMs - fromMs) / 86400000) + 1;
                if (totalDays <= 7) {
                    const orderedPos = [];
                    for (let i = 0; i < totalDays; i++) {
                        orderedPos.push(new Date(fromMs + i * 86400000).getUTCDay());
                    }
                    labels = orderedPos.map(p => cfg.names[p]);
                    values = orderedPos.map(p => counts[p]);
                } else {
                    labels = cfg.names;
                    values = counts;
                }
            } else {
                labels = cfg.names;
                values = counts;
            }
        } else {
            labels = cfg.names;
            values = counts;
        }
    }

    const titleEl = document.getElementById('vagasChartTitle');
    if (titleEl) titleEl.textContent = title;

    const ctx = document.getElementById('vagasChart');
    if (ctx) {
        if (_vagasAnalysisChart) _vagasAnalysisChart.destroy();
        _vagasAnalysisChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Candidaturas',
                    data: values,
                    backgroundColor: 'rgba(124,58,237,0.35)',
                    borderColor: 'rgba(124,58,237,0.8)',
                    borderWidth: 1.5,
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#5c5c80', font: { size: 10 }, autoSkip: true, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#5c5c80', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
                },
            },
        });
    }

    function renderDist(elId, rows, labelKey, valueKey) {
        const el = document.getElementById(elId);
        if (!el) return;
        if (!rows || !rows.length) { el.innerHTML = '<div class="metrics-empty">Sem dados</div>'; return; }
        const maxV = Math.max(...rows.map(r => Number(r[valueKey]) || 0)) || 1;
        el.innerHTML = rows.map(r => `
            <div class="metrics-row">
                <span class="metrics-row-label">${esc(String(r[labelKey] ?? '—'))}</span>
                <span class="metrics-row-value">${r[valueKey] ?? 0}</span>
            </div>
            <div class="metrics-bar-wrap"><div class="metrics-bar-fill" style="width:${Math.round((Number(r[valueKey])||0)/maxV*100)}%"></div></div>
        `).join('');
    }

    const resultLabel = { em_processo: 'Em processo', aprovado: 'Aprovado', recusado: 'Recusado' };
    renderDist('vagasDistResult',
        (by_result || []).map(r => ({ ...r, _label: resultLabel[r.result] || r.result })),
        '_label', 'cnt');
    renderDist('vagasDistModalidade', by_modalidade, 'modalidade',       'cnt');
    renderDist('vagasDistTipo',       by_tipo,       'tipo_contratacao', 'cnt');
    renderDist('vagasDistStage',      by_stage,      'stage_name',       'cnt');
}

// ─── SEGURANÇA: TENTATIVAS DE ACESSO ──────────────────────
let _loginAttemptsLoaded = false;

async function loadLoginAttempts() {
    const tableEl  = document.getElementById('loginAttemptsTable');
    const alertsEl = document.getElementById('loginAlertsBox');
    if (tableEl) tableEl.innerHTML = '<div class="metrics-empty"><i class="fa-solid fa-circle-notch fa-spin"></i> Carregando…</div>';
    try {
        const data = await api('GET', '/api/admin/login-attempts');
        _loginAttemptsLoaded = true;
        renderLoginAttempts(data);
    } catch (e) {
        if (tableEl) tableEl.innerHTML = `<div class="metrics-empty" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

function renderLoginAttempts({ attempts = [], alert_ips = [] }) {
    const alertsEl = document.getElementById('loginAlertsBox');
    const tableEl  = document.getElementById('loginAttemptsTable');

    if (alert_ips.length) {
        const ips = alert_ips.map(ip => `<span class="kpi-hash">${esc(ip)}</span>`).join(', ');
        alertsEl.innerHTML = `<div class="login-alert-banner">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span><strong>${alert_ips.length} IP(s) suspeito(s)</strong> com 3+ falhas na última hora: ${ips}</span>
        </div>`;
        // Destaca badge na aba Métricas
        const tabBtn = document.querySelector('[data-tab="metricas"]');
        if (tabBtn && !tabBtn.querySelector('.metricas-alert-dot')) {
            const dot = document.createElement('span');
            dot.className = 'metricas-alert-dot';
            dot.title = 'Alerta: tentativas suspeitas de acesso';
            tabBtn.appendChild(dot);
        }
    } else {
        alertsEl.innerHTML = '';
        document.querySelectorAll('.metricas-alert-dot').forEach(d => d.remove());
    }

    const failed     = attempts.filter(a => !a.success);
    const successful = attempts.filter(a =>  a.success);

    if (!failed.length && !successful.length) {
        tableEl.innerHTML = '<p class="metrics-empty">Nenhuma tentativa registrada ainda.</p>';
        return;
    }

    function buildRows(list) {
        return list.map(a => {
            const ua    = _parseUA(a.user_agent) || (a.user_agent || '').slice(0, 50) || '—';
            const badge = a.success
                ? '<span class="la-badge la-badge--ok">Você ✓</span>'
                : '<span class="la-badge la-badge--fail">Falha</span>';
            const hint  = a.username_hint ? `${esc(a.username_hint)}…` : '—';
            const fails = Number(a.recent_failures_from_ip);
            const failBadge = !a.success
                ? (fails >= 3
                    ? `<span class="la-badge la-badge--warn">${fails} falhas/1h</span>`
                    : (fails > 0 ? `<span class="meta">${fails}</span>` : '—'))
                : '—';
            return `<tr class="${a.success ? 'row--success' : 'row--fail'}">
                <td style="white-space:nowrap">${fmtDate(a.occurred_at, true)}</td>
                <td><span class="kpi-hash">${esc(a.ip_address || '?')}</span></td>
                <td class="meta">${esc(ua)}</td>
                <td>${badge}</td>
                <td class="meta">${hint}</td>
                <td>${failBadge}</td>
            </tr>`;
        }).join('');
    }

    function buildTable(list) {
        return `<div style="overflow-x:auto"><table class="login-attempts-table">
            <thead><tr>
                <th>Hora</th><th>IP</th><th>Navegador / SO</th>
                <th>Resultado</th><th>Login (parcial)</th><th>Alertas</th>
            </tr></thead>
            <tbody>${buildRows(list)}</tbody>
        </table></div>`;
    }

    let html = failed.length
        ? buildTable(failed)
        : '<p class="metrics-empty" style="margin-bottom:12px">Nenhuma tentativa suspeita registrada.</p>';

    if (successful.length) {
        html += `<details class="la-seus-acessos">
            <summary><i class="fa-solid fa-chevron-right la-arrow"></i> Seus acessos (${successful.length})</summary>
            <div class="la-seus-acessos-body">${buildTable(successful)}</div>
        </details>`;
    }

    tableEl.innerHTML = html;
}

// ─── SESSÕES ──────────────────────────────────────────────

function _parseUASession(ua) {
    if (!ua) return 'Desconhecido';
    const os = /Windows/.test(ua) ? 'Windows'
        : /Mac OS X/.test(ua) ? 'macOS'
        : /Linux/.test(ua) ? 'Linux'
        : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad/.test(ua) ? 'iOS' : 'Desconhecido';
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /Chrome\/(\d+)/.test(ua) ? `Chrome ${ua.match(/Chrome\/(\d+)/)[1]}`
        : /Firefox\/(\d+)/.test(ua) ? `Firefox ${ua.match(/Firefox\/(\d+)/)[1]}`
        : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const arch = /x64|Win64|WOW64/.test(ua) ? 'x64' : /arm/i.test(ua) ? 'ARM' : '';
    return [os, browser, arch].filter(Boolean).join(' · ');
}

async function loadSessions() {
    const el = document.getElementById('sessionsList');
    if (!el) return;
    try {
        const data = await api('GET', '/api/admin/sessions');
        if (!data.length) {
            el.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:24px">Nenhuma sessão ativa.</p>';
            return;
        }
        el.innerHTML = `<div class="sessions-panel">${data.map(s => {
            const isRevoked  = !!s.revoked_at;
            const isCurrent  = !!s.is_current;
            const dotCls     = isCurrent ? 'dot-current' : isRevoked ? 'dot-revoked' : 'dot-active';
            const itemCls    = isCurrent ? 'is-current' : isRevoked ? 'is-revoked' : '';
            const ua         = _parseUASession(s.user_agent);
            const seen       = new Date(s.last_seen_at).toLocaleString('pt-BR');
            const created    = new Date(s.created_at).toLocaleString('pt-BR');
            const badgeHtml  = isCurrent
                ? '<span class="session-badge badge-current">Esta sessão</span>'
                : isRevoked ? '<span class="session-badge badge-revoked">Revogada</span>' : '';
            const reasonHtml = isRevoked
                ? `<span class="session-revoke-reason">⊘ ${esc(s.revoke_reason || 'revogada')}</span>` : '';
            const actionHtml = isCurrent
                ? '<span class="session-action-none">sessão atual</span>'
                : isRevoked ? ''
                : `<button class="btn-session-revoke" onclick="revokeSession('${s.jti}')">⊘ Revogar</button>`;
            const ipDisplay = s.ip_address || '?';
            const country = s.country_code ? ` <span style="opacity:.5;font-size:0.75em">(${s.country_code})</span>` : '';
            return `<div class="session-item ${itemCls}">
                <div class="session-dot-wrap"><div class="session-dot ${dotCls}"></div></div>
                <div class="session-info">
                    <div class="session-line1"><span class="session-ip">${ipDisplay}</span>${country}${badgeHtml}</div>
                    <div class="session-line2">${esc(ua)}</div>
                    <div class="session-line3">
                        <span>Login: ${created}</span>
                        <span>Última: ${seen}</span>
                        ${reasonHtml}
                    </div>
                </div>
                <div class="session-action">${actionHtml}</div>
            </div>`;
        }).join('')}</div>`;
    } catch (e) {
        if (el) el.innerHTML = `<p style="color:var(--danger);padding:16px">${e.message}</p>`;
    }
}

async function revokeSession(jti) {
    if (!await showConfirm('Revogar sessão?', 'O dispositivo perderá acesso imediatamente.', { okText: 'Revogar' })) return;
    try {
        await api('DELETE', `/api/admin/sessions?jti=${jti}`);
        loadSessions();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function revokeAllSessions() {
    if (!await showConfirm('Forçar logout em todos os devices?', 'Você precisará fazer login novamente.', { okText: 'Forçar logout' })) return;
    try {
        const sessions = await api('GET', '/api/admin/sessions');
        const active = sessions.filter(s => !s.revoked_at);
        await Promise.all(active.map(s => api('DELETE', `/api/admin/sessions?jti=${s.jti}`)));
        await logout();
    } catch (e) {
        alert(e.message);
    }
}

// ─── ABAS DO ADMIN ────────────────────────────────────────
// Fonte única das abas. Renderiza desktop tab bar + mobile-bottom-nav.
// Para adicionar/remover/reordenar uma aba, edite SÓ este array.
const ADMIN_TABS = [
    { key: 'cvs',       label: 'Currículos',      shortLabel: 'Currículos', icon: 'fa-file-pdf',       demoEligible: true,  mobileOverflow: false },
    { key: 'tokens',    label: 'Tokens',          shortLabel: 'Tokens',     icon: 'fa-key',            demoEligible: true,  mobileOverflow: true  },
    { key: 'logs',      label: 'Logs',            shortLabel: 'Logs',       icon: 'fa-chart-bar',      demoEligible: true,  mobileOverflow: true  },
    { key: 'vagas',     label: 'Vagas',           shortLabel: 'Vagas',      icon: 'fa-briefcase',      demoEligible: true,  mobileOverflow: false },
    { key: 'radar',     label: 'Radar',           shortLabel: 'Radar',      icon: 'fa-satellite-dish', demoEligible: true,  mobileOverflow: false },
    { key: 'inbox',     label: 'Inbox',           shortLabel: 'Inbox',      icon: 'fa-inbox',          demoEligible: false, mobileOverflow: false },
    { key: 'rede',      label: 'Rede',            shortLabel: 'Rede',       icon: 'fa-people-group',   demoEligible: false, mobileOverflow: true  },
    { key: 'diario',    label: 'Diário',          shortLabel: 'Diário',     icon: 'fa-book-open',      demoEligible: false, mobileOverflow: true  },
    { key: 'tendencias',label: 'Tendências',      shortLabel: 'Tendências', icon: 'fa-arrow-trend-up', demoEligible: false, mobileOverflow: true  },
    { key: 'metricas',  label: 'Métricas',        shortLabel: 'Métricas',   icon: 'fa-chart-line',     demoEligible: true,  mobileOverflow: false },
    { key: 'config',    label: 'Configurar',      shortLabel: 'Config',     icon: 'fa-sliders',        demoEligible: false, mobileOverflow: true  },
    { key: 'seguranca', label: 'Segurança',       shortLabel: 'Segurança',  icon: 'fa-shield-halved',  demoEligible: true,  mobileOverflow: true  },
];

function renderAdminTabs() {
    const desktopBar = document.querySelector('.app-tabs');
    const mobileBar  = document.getElementById('mobileBottomNav');
    const maisMenu   = document.getElementById('maisMenu');
    const activeKey  = _activeTab || 'cvs';

    // Desktop: todas as abas
    if (desktopBar) {
        desktopBar.innerHTML = ADMIN_TABS.map(t => `
            <button class="tab-btn${t.key === activeKey ? ' active' : ''}" data-tab="${t.key}" onclick="switchTab('${t.key}')">
                <i class="fa-solid ${t.icon}"></i> ${t.label}
            </button>`).join('');
    }

    // Mobile: abas primárias + botão "Mais" com overflow
    const primary  = ADMIN_TABS.filter(t => !t.mobileOverflow);
    const overflow = ADMIN_TABS.filter(t => t.mobileOverflow);
    const overflowActive = overflow.some(t => t.key === activeKey);

    if (mobileBar) {
        const primaryBtns = primary.map(t => `
            <button class="mobile-nav-btn${t.key === activeKey ? ' active' : ''}" data-tab="${t.key}" onclick="switchTab('${t.key}')">
                <i class="fa-solid ${t.icon}"></i>
                <span>${t.shortLabel}</span>
            </button>`).join('');
        const maisBtnHtml = overflow.length ? `
            <button class="mobile-nav-btn mobile-nav-mais${overflowActive ? ' active' : ''}" onclick="toggleMaisMenu()">
                <i class="fa-solid fa-ellipsis"></i>
                <span>Mais</span>
            </button>` : '';
        mobileBar.innerHTML = primaryBtns + maisBtnHtml;
    }

    if (maisMenu) {
        maisMenu.innerHTML = overflow.map(t => `
            <button class="mais-menu-btn${t.key === activeKey ? ' active' : ''}" data-tab="${t.key}" onclick="switchTab('${t.key}')">
                <i class="fa-solid ${t.icon}"></i> ${t.label}
            </button>`).join('');
    }
}

function toggleMaisMenu(force) {
    const menu = document.getElementById('maisMenu');
    if (!menu) return;
    const open = force !== undefined ? force : !menu.classList.contains('open');
    menu.classList.toggle('open', open);
}

// ─── DEMO SETTINGS ────────────────────────────────────────
// _DEMO_ALL_TABS deriva de ADMIN_TABS (filtra demoEligible).
const _DEMO_ALL_TABS = ADMIN_TABS.filter(t => t.demoEligible).map(t => ({
    key: t.key, label: t.label, icon: t.icon,
}));

async function loadDemoSettings() {
    // Só disponível no painel de produção
    if (window.ADMIN_CONFIG?.mode === 'demo') return;
    const el = document.getElementById('demoTabToggles');
    if (!el) return;
    try {
        const data = await api('GET', '/api/admin/demo-settings');
        _renderDemoSettings(el, data.enabled_tabs ?? []);
    } catch (e) {
        el.innerHTML = `<span style="color:var(--danger);font-size:0.82rem">${e.message}</span>`;
    }
}

function _renderDemoSettings(el, enabledTabs) {
    el.innerHTML = _DEMO_ALL_TABS.map(t => `
        <label style="display:inline-flex;align-items:center;gap:10px;cursor:pointer;font-size:0.86rem;color:var(--text-soft)">
            <input type="checkbox" value="${t.key}" ${enabledTabs.includes(t.key) ? 'checked' : ''}
                style="width:15px;height:15px;accent-color:var(--cyan)">
            <i class="fa-solid ${t.icon}" style="color:var(--cyan);width:14px;text-align:center"></i>
            ${t.label}
        </label>
    `).join('');
}

function _demoToggleAll(checked) {
    document.querySelectorAll('#demoTabToggles input[type=checkbox]').forEach(c => { c.checked = checked; });
}

async function saveDemoSettings() {
    const checks = document.querySelectorAll('#demoTabToggles input[type=checkbox]');
    const enabled = [...checks].filter(c => c.checked).map(c => c.value);
    try {
        await api('PATCH', '/api/admin/demo-settings', { enabled_tabs: enabled });
        const savedEl = document.getElementById('demoSettingsSaved');
        if (savedEl) { savedEl.style.display = ''; setTimeout(() => { savedEl.style.display = 'none'; }, 2500); }
        showToast('Configuração do demo salva.');
    } catch (e) { showToast(e.message, 'error'); }
}

// ─── RADAR DE VAGAS ───────────────────────────────────────
let _radarProfile = {};
let _radarAnalysisId = null;
const _linesToArr = s => String(s || '').split(/[\n;]+/).map(x => x.trim()).filter(Boolean);
const _arrToLines = a => (Array.isArray(a) ? a : []).join('\n');

function radarBadge(score) {
    if (score == null) return { cls: 'na',     num: '—',    tier: ''       };
    if (score >= 7)    return { cls: 'green',  num: score,  tier: 'forte'  };
    if (score >= 5)    return { cls: 'yellow', num: score,  tier: 'ok'     };
    if (score >= 3)    return { cls: 'orange', num: score,  tier: 'revisar'};
    return                    { cls: 'red',    num: score,  tier: 'fraco'  };
}

async function loadRadar() {
    try {
        _radarProfile = await api('GET', '/api/admin/profile');
        fillRadarProfileForm(_radarProfile);
        renderRadarSearches(_radarProfile);
        _rsqSyncPlatforms(_radarProfile);
    } catch (e) { /* perfil ainda não criado — segue */ }

    loadRsqHistory();
    loadRadarStats();

    // Parte 2: feedback visual no toggle (mesmo se rede instantânea)
    const sw = document.querySelector('.radar-filter-bar .radar-switch');
    if (sw) {
        sw.classList.add('loading');
        setTimeout(() => sw.classList.remove('loading'), 400);
    }

    const all = document.getElementById('radarShowAll')?.checked ? '?all=1' : '';
    const list = document.getElementById('radarList');
    if (list) list.innerHTML = '<div class="radar-empty"><i class="fa-solid fa-circle-notch fa-spin"></i> Carregando…</div>';
    try {
        const leads = await api('GET', `/api/admin/radar${all}`);
        renderRadarList(leads);
    } catch (e) {
        if (list) list.innerHTML = `<div class="radar-empty">Erro: ${esc(e.message)}</div>`;
    }
}

// Parte 7: breakdown de contadores no header
async function loadRadarStats() {
    const el = document.getElementById('radarStats');
    if (!el) return;
    try {
        const s = await api('GET', '/api/admin/radar?action=stats');
        const parts = [];
        const by = s.by_status || {};
        const ativos = (by.novo || 0) + (by.avaliada || 0);
        if (ativos)          parts.push(`<span class="stat"><span class="stat-val">${ativos}</span> ativos</span>`);
        if (by.promovida)    parts.push(`<span class="stat"><span class="stat-val">${by.promovida}</span> promovidas</span>`);
        if (by.descartada)   parts.push(`<span class="stat"><span class="stat-val">${by.descartada}</span> descartadas</span>`);
        if (s.stale_count)   parts.push(`<span class="stat" title="Leads novos/avaliados parados há mais de 30 dias"><span class="stat-val" style="color:#fbbf24">${s.stale_count}</span> parados</span>`);
        if (parts.length) {
            el.innerHTML = parts.join('<span class="stat-divider">·</span>');
        } else {
            el.innerHTML = '';
        }
    } catch (_) { /* stats são opcionais */ }
}

// Parte 7: modal de limpeza
const CLEANUP_PRESETS_UI = [
    { id: 'descartadas_30d',     label: 'Descartadas há mais de 30 dias',  desc: 'DELETE — leads rejeitados há ≥30d (sem candidatura)', danger: true },
    { id: 'descartadas_60d',     label: 'Descartadas há mais de 60 dias',  desc: 'DELETE — recomendado: vaga provavelmente não está mais ativa', danger: false },
    { id: 'descartadas_90d',     label: 'Descartadas há mais de 90 dias',  desc: 'DELETE — leads bem antigos, baixíssimo risco', danger: false },
    { id: 'promovidas_180d',     label: 'Promovidas há mais de 180 dias',  desc: 'DELETE — só remove se candidatura não estiver em processo', danger: true },
    { id: 'expirar_parados_30d', label: 'Expirar parados há mais de 30d',  desc: 'UPDATE — marca como descartada com motivo "expirado"', danger: false },
];
let _cleanupSelected = null;

function openLimparModal() {
    _cleanupSelected = null;
    document.getElementById('cleanupExecuteBtn').disabled = true;
    document.getElementById('cleanupPreview').hidden = true;
    const list = document.getElementById('cleanupPresetList');
    if (list) {
        list.innerHTML = CLEANUP_PRESETS_UI.map(p => `
            <label class="cleanup-preset" data-id="${p.id}">
                <input type="radio" name="cleanupPreset" value="${p.id}" onchange="selectCleanupPreset('${p.id}')">
                <div class="cleanup-preset-body">
                    <p class="cleanup-preset-label">${esc(p.label)}</p>
                    <p class="cleanup-preset-desc">${esc(p.desc)}</p>
                </div>
                <span class="cleanup-preset-count" id="cpc_${p.id}">…</span>
            </label>
        `).join('');
        // Pré-carrega contagens em paralelo
        CLEANUP_PRESETS_UI.forEach(p => {
            api('GET', `/api/admin/radar?action=cleanup-preview&preset=${p.id}`)
                .then(r => {
                    const el = document.getElementById(`cpc_${p.id}`);
                    if (el) el.textContent = `${r.count || 0} lead${r.count === 1 ? '' : 's'}`;
                })
                .catch(() => {
                    const el = document.getElementById(`cpc_${p.id}`);
                    if (el) el.textContent = '—';
                });
        });
    }
    document.getElementById('radarLimparModal').classList.add('open');
}
function closeLimparModal() {
    document.getElementById('radarLimparModal').classList.remove('open');
}
async function selectCleanupPreset(id) {
    _cleanupSelected = id;
    document.querySelectorAll('.cleanup-preset').forEach(p => p.classList.toggle('selected', p.dataset.id === id));
    document.getElementById('cleanupExecuteBtn').disabled = false;
    const cfg = CLEANUP_PRESETS_UI.find(p => p.id === id);
    try {
        const r = await api('GET', `/api/admin/radar?action=cleanup-preview&preset=${id}`);
        const isExpire = id.startsWith('expirar_');
        const verb = isExpire ? 'marcados como descartados' : 'excluídos permanentemente';
        const prev = document.getElementById('cleanupPreview');
        if (prev) {
            prev.hidden = false;
            prev.className = `cleanup-preview${cfg?.danger && !isExpire ? ' warn' : ''}`;
            prev.innerHTML = `<strong>${r.count || 0} lead${r.count === 1 ? '' : 's'}</strong> serão ${verb}.${cfg?.danger && !isExpire ? '<br>⚠ Leads com candidatura ativa em job_applications são preservados automaticamente.' : ''}`;
        }
    } catch (_) { /* silencioso */ }
}
async function executeCleanup(btn) {
    if (!_cleanupSelected) return;
    const cfg = CLEANUP_PRESETS_UI.find(p => p.id === _cleanupSelected);
    if (!await showConfirm('Confirmar limpeza?', `Tem certeza? ${cfg?.danger ? 'Esta ação não pode ser desfeita.' : 'Esta ação é reversível restaurando os leads.'}`, { okText: cfg?.danger ? 'Limpar' : 'Confirmar', danger: !!cfg?.danger })) return;
    try {
        const r = await withLoading(btn, () => api('DELETE', `/api/admin/radar?action=cleanup&preset=${_cleanupSelected}`), 'Limpando…');
        const n = r.deleted ?? r.updated ?? 0;
        showToast(`${n} lead${n === 1 ? '' : 's'} processado${n === 1 ? '' : 's'}.`);
        closeLimparModal();
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Buscar vagas ─────────────────────────────────────────────────────────────

// Estado do polling/progress (Parte 1)
let _rsqRequestPlats = [];     // plataformas da requisição ativa (para chips)
let _rsqElapsedTimer = null;
let _rsqStartedAt = null;
let _rsqActiveId = null;       // ID da busca ativa — evita race condition entre polls

function _rsqGetSelectedPlats() {
    return _chipsGetSelected(document.getElementById('rsqPlatforms'));
}

function _rsqKeywords() {
    const v = document.getElementById('rsqKeywords')?.value.trim();
    return v ? v.split(',').map(k => k.trim()).filter(Boolean) : null;
}

function _rsqSyncPlatforms(profile) {
    const container = document.getElementById('rsqPlatforms');
    if (!container) return;
    const allPlats = Array.isArray(profile?.search_platforms) ? profile.search_platforms : [];
    if (!allPlats.length) {
        // Fallback: lista padrão se perfil não tem search_platforms
        _chipsRender(container, [
            { value: 'linkedin', label: 'LinkedIn' },
            { value: 'gupy',     label: 'Gupy' },
            { value: 'maringa',  label: 'Maringá' },
            { value: 'indeed',   label: 'Indeed' },
        ], ['linkedin', 'gupy', 'maringa']);
        return;
    }
    _chipsRender(container, allPlats.map(p => ({ value: p.id, label: p.label || p.id })),
        allPlats.filter(p => p.enabled !== false).map(p => p.id));
}

function _rsqStartElapsed(isoDate) {
    clearInterval(_rsqElapsedTimer);
    _rsqStartedAt = isoDate ? new Date(isoDate) : new Date();
    _rsqElapsedTimer = setInterval(_rsqUpdateElapsed, 1000);
    _rsqUpdateElapsed();
}
function _rsqUpdateElapsed() {
    const el = document.getElementById('rsqElapsed');
    if (!el) { clearInterval(_rsqElapsedTimer); return; }
    const s = Math.max(0, Math.floor((Date.now() - _rsqStartedAt) / 1000));
    el.textContent = s < 60 ? `há ${s}s` : `há ${Math.floor(s/60)}m${s % 60}s`;
}

async function requestRadarSearch(btn) {
    const platforms = _rsqGetSelectedPlats();
    if (!platforms.length) { showToast('Selecione ao menos uma plataforma.', 'error'); return; }
    const payload = {
        platforms,
        keywords:    _rsqKeywords(),
        max_results: parseInt(document.getElementById('rsqMaxResults')?.value) || 20,
        dry_run:     document.getElementById('rsqDryRun')?.checked || false,
    };
    try {
        await withLoading(btn, async () => {
            const res = await api('POST', '/api/admin/radar?action=request-search', payload);
            _rsqRequestPlats = payload.platforms;
            _rsqActiveId    = res.id;
            _rsqStartedAt   = null;
            _rsqShowStatus('pending', undefined, { created_at: new Date().toISOString() });
            _rsqPoll(res.id);
        }, 'Solicitando…');
    } catch (e) { showToast(e.message, 'error'); }
}

function copyRadarSearchCmd() {
    const platforms = _rsqGetSelectedPlats();
    const keywords  = _rsqKeywords();
    const max       = parseInt(document.getElementById('rsqMaxResults')?.value) || 20;
    let cmd;
    if (platforms.length === 1) {
        const kw = keywords ? `, keywords: ${JSON.stringify(keywords)}` : '';
        cmd = `search_${platforms[0]}({ max_results: ${max}${kw} })`;
    } else {
        const plStr = platforms.length ? `, platforms: ${JSON.stringify(platforms)}` : '';
        cmd = `search_all({${plStr} })`;
    }
    navigator.clipboard.writeText(cmd)
        .then(() => showToast('Comando copiado!'))
        .catch(() => showToast('Não foi possível copiar.', 'error'));
}

function _rsqShowStatus(status, extra, res, mcp) {
    const el = document.getElementById('rsqStatus');
    if (!el) return;
    el.style.display = '';

    const PLAT_NAMES = { linkedin: 'LinkedIn', gupy: 'Gupy', maringa: 'Maringá', indeed: 'Indeed' };

    if (status === 'pending') {
        const created = res?.created_at;
        // Hint baseado em heartbeat real (não mais heurística de tempo).
        // mcp.online === false → amarelo com instrução; true → cinza ativo; null → cinza neutro
        let hintCls = 'rsq-progress-hint';
        let hintTxt = 'Aguardando MCP server local';
        if (mcp?.online === false) {
            hintCls = 'rsq-progress-hint rsq-hint-warn';
            hintTxt = '⚠ MCP server não está em execução — rode <code>npm run mcp:start</code>';
        } else if (mcp?.online === true) {
            hintTxt = `Aguardando MCP processar (servidor ativo, visto há ${mcp.seconds_ago}s)`;
        }
        el.innerHTML = `<div class="rsq-progress-wrap rsq-pending" aria-live="polite">
            <div class="rsq-progress-header">
                <span><i class="fa-solid fa-clock"></i> Na fila…</span>
                <span class="rsq-elapsed" id="rsqElapsed"></span>
            </div>
            <div class="rsq-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="rsq-bar rsq-bar-pulse"></div>
            </div>
            <div class="${hintCls}">${hintTxt}</div>
        </div>`;
        if (!_rsqStartedAt) _rsqStartElapsed(created);
        else _rsqUpdateElapsed();
        return;
    }

    if (status === 'running') {
        const prog  = res?.progress || {};
        const done  = prog.done || [];
        const cur   = prog.current;
        const plats = _rsqRequestPlats.length ? _rsqRequestPlats : (prog.platforms || []);
        const total = prog.total || plats.length || 1;
        const pct   = Math.max(Math.round(done.length / total * 100), 5);
        const chips = plats.map(p => {
            const isDone = done.includes(p), isCur = p === cur;
            const cls  = isDone ? 'rsq-plat-chip-done' : isCur ? 'rsq-plat-chip-active' : 'rsq-plat-chip-wait';
            const icon = isDone ? 'fa-check' : isCur ? 'fa-circle-notch fa-spin' : 'fa-circle';
            return `<span class="rsq-plat-chip ${cls}"><i class="fa-solid ${icon}"></i> ${esc(PLAT_NAMES[p] || p)}</span>`;
        }).join('');
        el.innerHTML = `<div class="rsq-progress-wrap rsq-running" aria-live="polite">
            <div class="rsq-progress-header">
                <span><i class="fa-solid fa-circle-notch fa-spin"></i> Executando… <span class="rsq-progress-count">${done.length}/${total}</span></span>
                <span class="rsq-elapsed" id="rsqElapsed"></span>
            </div>
            <div class="rsq-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
                <div class="rsq-bar" style="width:${pct}%"></div>
            </div>
            <div class="rp-chips">${chips}</div>
        </div>`;
        if (!_rsqStartedAt) _rsqStartElapsed(res?.started_at);
        else _rsqUpdateElapsed();
        return;
    }

    // done/error: badge simples + reset de estado
    clearInterval(_rsqElapsedTimer);
    _rsqElapsedTimer = null;
    _rsqStartedAt = null;
    _rsqRequestPlats = [];
    _rsqActiveId = null;

    const icons  = { done: 'fa-check', error: 'fa-triangle-exclamation' };
    const labels = { done: extra || 'Concluída!', error: extra || 'Erro na busca' };
    el.innerHTML = `<span class="rsq-badge rsq-${status}"><i class="fa-solid ${icons[status]}"></i> ${labels[status]}</span>`;
}

let _rsqPollTimer = null;
async function _rsqPoll(id) {
    clearTimeout(_rsqPollTimer);
    try {
        // Busca status do request + heartbeat do MCP em paralelo
        const [res, mcp] = await Promise.all([
            api('GET', `/api/admin/radar?action=search-status&id=${id}`),
            api('GET', '/api/admin/radar?action=mcp-status').catch(() => ({ online: null })),
        ]);
        if (id !== _rsqActiveId) return; // poll obsoleto — outra busca foi disparada
        if (res.status === 'done') {
            const n = res.result?.total_new ?? 0;
            _rsqShowStatus('done', `${n} nova${n!==1?'s':''} vaga${n!==1?'s':''}`);
            showToast(`Busca concluída: ${n} novas vagas`);
            loadRadar();
            loadRsqHistory();
        } else if (res.status === 'error') {
            _rsqShowStatus('error', res.error_message || 'Erro desconhecido');
            showToast(res.error_message || 'Erro na busca', 'error');
            loadRsqHistory();
        } else {
            _rsqShowStatus(res.status, undefined, res, mcp);
            _rsqPollTimer = setTimeout(() => _rsqPoll(id), 5000);
        }
    } catch (_) {
        if (id === _rsqActiveId) _rsqPollTimer = setTimeout(() => _rsqPoll(id), 10000);
    }
}

async function loadRsqHistory() {
    const el = document.getElementById('rsqHistory');
    if (!el) return;
    try {
        const rows = await api('GET', '/api/admin/radar?action=search-history');
        if (!rows.length) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.innerHTML = rows.map(r => {
                const ago = _timeAgo(r.ran_at);
                const plat = { linkedin: 'LinkedIn', gupy: 'Gupy', maringa: 'Maringá', indeed: 'Indeed' }[r.platform] || r.platform;
                return `<div class="rsq-hist-row">
                    <span class="rsq-hist-plat">${esc(plat)}</span>
                    <span>${esc(ago)}</span>
                    <span>${r.found_count} encontradas</span>
                    <span class="rsq-hist-new">+${r.new_count} novas</span>
                </div>`;
            }).join('');
    } catch (_) { el.style.display = 'none'; }
}

const QUICK_SEARCH_DEFAULTS = [
    { id: 'linkedin_24h_remote', label: 'Últimas 24h (remoto)', icon: 'fa-clock', url_template: 'https://www.linkedin.com/jobs/search/?keywords={kw}&f_WT=2&f_TPR=r86400&sortBy=DD', enabled: true },
    { id: 'linkedin_7d_remote', label: 'Últimos 7 dias (remoto)', icon: 'fa-calendar-week', url_template: 'https://www.linkedin.com/jobs/search/?keywords={kw}&f_WT=2&f_TPR=r604800&sortBy=DD', enabled: true },
    { id: 'posts_contratando', label: 'Publicações: "contratando"', icon: 'fa-bullhorn', url_template: 'https://www.linkedin.com/search/results/content/?keywords=%22contratando%22%20{kw}', enabled: true },
    { id: 'posts_vaga', label: 'Mercado oculto: "vaga"', icon: 'fa-eye', url_template: 'https://www.linkedin.com/search/results/content/?keywords=%22vaga%22%20{kw}', enabled: true },
    { id: 'people_leads', label: 'Gestores (Tech Lead/Head)', icon: 'fa-user-tie', url_template: 'https://www.linkedin.com/search/results/people/?keywords=%22Tech%20Lead%22%20OR%20%22Head%22%20{kw}', enabled: true },
    { id: 'boolean_qa_playwright', label: 'Boolean: QA + Playwright', icon: 'fa-code', url_template: 'https://www.linkedin.com/jobs/search/?keywords=%28%22QA%22%20OR%20%22Analista%20de%20Testes%22%29%20AND%20%22Playwright%22&f_TPR=r604800&sortBy=DD', enabled: true },
    { id: 'boolean_qa_ia', label: 'Boolean: QA + IA', icon: 'fa-robot', url_template: 'https://www.linkedin.com/jobs/search/?keywords=%22QA%22%20AND%20%28%22IA%22%20OR%20%22Intelig%C3%AAncia%20Artificial%22%29&f_TPR=r604800&sortBy=DD', enabled: true },
];
const QUICK_SEARCH_ICONS = ['fa-clock','fa-calendar-week','fa-bullhorn','fa-eye','fa-user-tie','fa-code','fa-robot','fa-magnifying-glass','fa-briefcase','fa-building','fa-link','fa-star'];

function interpolateSearchUrl(template, profile) {
    const kw = encodeURIComponent((profile?.keywords && profile.keywords[0]) || 'QA');
    return String(template || '').replace(/\{kw\}/g, kw);
}

function renderRadarSearches(profile) {
    const grid = document.getElementById('radarSearchGrid');
    if (!grid) return;
    const list = (profile?.quick_searches?.length ? profile.quick_searches : QUICK_SEARCH_DEFAULTS).filter(q => q.enabled !== false);
    if (!list.length) {
        grid.innerHTML = '<p class="radar-hint" style="margin:0">Nenhuma busca rápida configurada. <a href="#" onclick="openQuickSearchesEditor();return false">Editar</a></p>';
        return;
    }
    grid.innerHTML = list.map(q =>
        `<a class="radar-search-btn" href="${esc(interpolateSearchUrl(q.url_template, profile))}" target="_blank" rel="noopener"><i class="fa-solid ${esc(q.icon || 'fa-link')}"></i> ${esc(q.label)}</a>`
    ).join('');
}

// ── Editor de buscas rápidas (Parte 3) ──
let _qsEditing = [];

function openQuickSearchesEditor() {
    _qsEditing = JSON.parse(JSON.stringify(_radarProfile?.quick_searches?.length ? _radarProfile.quick_searches : QUICK_SEARCH_DEFAULTS));
    _renderQuickSearchesList();
    document.getElementById('quickSearchesModal').classList.add('open');
}
function closeQuickSearchesEditor() {
    document.getElementById('quickSearchesModal').classList.remove('open');
}
function _renderQuickSearchesList() {
    const list = document.getElementById('quickSearchesList');
    if (!list) return;
    if (!_qsEditing.length) {
        list.innerHTML = '<p class="radar-hint" style="margin:0">Nenhuma busca cadastrada. Clique em "Adicionar busca" para começar.</p>';
        return;
    }
    list.innerHTML = _qsEditing.map((q, i) => `
        <div style="display:grid;grid-template-columns:auto 1fr 1fr auto auto;gap:8px;align-items:center;padding:8px;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px">
            <select class="qs-icon" data-i="${i}" onchange="_qsUpdate(${i},'icon',this.value)" style="background:var(--bg-base);border:1px solid var(--border);border-radius:6px;padding:6px;color:var(--text);font-family:inherit">
                ${QUICK_SEARCH_ICONS.map(ic => `<option value="${ic}" ${ic === q.icon ? 'selected' : ''}>${ic.replace('fa-','')}</option>`).join('')}
            </select>
            <input type="text" value="${esc(q.label)}" maxlength="60" placeholder="Label" oninput="_qsUpdate(${i},'label',this.value)" style="background:var(--bg-base);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-family:inherit;font-size:0.85rem">
            <input type="text" value="${esc(q.url_template)}" maxlength="500" placeholder="https://… use {kw} para 1ª keyword" oninput="_qsUpdate(${i},'url_template',this.value)" style="background:var(--bg-base);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-family:var(--font-mono);font-size:0.75rem">
            <label class="radar-switch" style="margin:0" title="Ativar/desativar">
                <input type="checkbox" ${q.enabled !== false ? 'checked' : ''} onchange="_qsUpdate(${i},'enabled',this.checked)">
                <span class="radar-switch-track"><span class="radar-switch-thumb"></span></span>
            </label>
            <button class="btn btn-sm btn-danger" type="button" onclick="removeQuickSearch(${i})" title="Remover"><i class="fa-solid fa-trash"></i></button>
        </div>
    `).join('');
}
function _qsUpdate(i, field, value) {
    if (_qsEditing[i]) _qsEditing[i][field] = value;
}
function addQuickSearch() {
    _qsEditing.push({ id: `custom_${Date.now()}`, label: 'Nova busca', icon: 'fa-magnifying-glass', url_template: 'https://www.linkedin.com/jobs/search/?keywords={kw}', enabled: true });
    _renderQuickSearchesList();
}
function removeQuickSearch(i) {
    _qsEditing.splice(i, 1);
    _renderQuickSearchesList();
}
function resetQuickSearchesToDefault() {
    _qsEditing = JSON.parse(JSON.stringify(QUICK_SEARCH_DEFAULTS));
    _renderQuickSearchesList();
}
async function saveQuickSearches(btn) {
    // Validação client-side
    for (const q of _qsEditing) {
        if (!q.label || q.label.length > 60) { showToast(`Label inválido: "${q.label || '(vazio)'}"`, 'error'); return; }
        if (!q.url_template || !q.url_template.startsWith('https://')) { showToast(`URL inválido: deve começar com https://`, 'error'); return; }
        if (q.url_template.length > 500) { showToast(`URL muito longo: ${q.label}`, 'error'); return; }
    }
    try {
        await withLoading(btn, async () => {
            _radarProfile = await api('PUT', '/api/admin/profile', { quick_searches: _qsEditing });
        }, 'Salvando…');
        renderRadarSearches(_radarProfile);
        closeQuickSearchesEditor();
        showToast('Buscas rápidas salvas.');
    } catch (e) { showToast(e.message, 'error'); }
}

let _radarLeads = [];
let _radarMinScore = 0;
let _radarFonteFilter = 'all';
let _radarModFilter   = 'all';
let _radarSortKey     = 'score';
let _radarFiltersOpen = false;
let _radarSelecting = false;
let _radarSelected  = new Set();
let _adaptarCvLeadId = null;
let _cvVersionsList  = [];

function renderRadarList(leads) {
    _radarLeads = leads;
    const list = document.getElementById('radarList');
    const count = document.getElementById('radarCount');

    // Apply filters
    let filtered = leads;
    if (_radarMinScore > 0) filtered = filtered.filter(l => (l.fit_score ?? 0) >= _radarMinScore);
    if (_radarFonteFilter !== 'all') filtered = filtered.filter(l => (l.fonte || '') === _radarFonteFilter);
    if (_radarModFilter !== 'all') filtered = filtered.filter(l => (l.modalidade || '') === _radarModFilter);
    // Apply sort
    if (_radarSortKey === 'score') filtered = [...filtered].sort((a,b) => (b.fit_score??-1) - (a.fit_score??-1));
    else if (_radarSortKey === 'date') filtered = [...filtered].sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
    else if (_radarSortKey === 'empresa') filtered = [...filtered].sort((a,b) => (a.empresa||'').localeCompare(b.empresa||'','pt-BR'));
    // Update count
    if (count) count.textContent = filtered.length !== leads.length ? `(${filtered.length}/${leads.length})` : (leads.length ? `(${leads.length})` : '');

    if (!list) return;
    if (!filtered.length) { list.innerHTML = '<div class="radar-empty">Nenhum lead. Adicione uma vaga acima ou use as buscas rápidas.</div>'; return; }

    list.innerHTML = filtered.map(l => {
        const b = radarBadge(l.fit_score);
        const chips = [l.nivel, l.modalidade, l.tipo_contratacao].filter(Boolean)
            .map(c => `<span class="radar-chip">${esc(c)}</span>`).join('');
        const kw = (l.keywords_match || []).slice(0, 12)
            .map(k => `<span class="radar-chip kw">${esc(k)}</span>`).join('');
        const gaps = (l.gaps || []).slice(0, 8)
            .map(g => `<span class="radar-chip gap">${esc(g)}</span>`).join('');
        const link = l.link_vaga ? `<a href="${esc(l.link_vaga)}" target="_blank" rel="noopener" title="Abrir vaga" onclick="event.stopPropagation()"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : '';
        const promoted = l.status === 'promovida';
        const discarded = l.status === 'descartada';
        const pos = l.positioning ? `<p class="radar-pos">${esc(l.positioning)}</p>` : '';
        const suspFlags = Array.isArray(l.suspicious_flags) ? l.suspicious_flags : [];
        const suspBadge = suspFlags.length ? `<span class="radar-chip suspicious" title="${esc(suspFlags.join(', '))}"><i class="fa-solid fa-triangle-exclamation"></i> suspeita</span>` : '';
        const revFit = l.reverse_fit_score != null ? `<span title="Fit reverso (empresa → você)" style="font-size:0.62rem;color:var(--text-dim);margin-top:2px;display:block;text-align:center">rev ${l.reverse_fit_score}</span>` : '';
        const aln = l.alignment_score != null ? `<span title="Alinhamento de valores" style="font-size:0.62rem;color:#a78bfa;margin-top:1px;display:block;text-align:center">val ${l.alignment_score}</span>` : '';
        const confPct = l.advance_confidence != null ? `<span title="Estimativa de avançar para entrevista" style="font-size:0.62rem;color:${l.advance_confidence>=50?'#4ade80':l.advance_confidence>=25?'#fb923c':'#f87171'};margin-top:1px;display:block;text-align:center">${l.advance_confidence}%</span>` : '';
        const isSelected = _radarSelected.has(l.id);
        const cardAction = _radarSelecting ? `onclick="toggleRadarSelect('${l.id}')" style="cursor:pointer"` : '';
        return `<div class="radar-lead status-${esc(l.status)}" ${cardAction}>
            ${_radarSelecting ? `<input type="checkbox" class="radar-row-check" ${isSelected ? 'checked' : ''} onchange="toggleRadarSelect('${l.id}')" style="margin:8px;align-self:center" onclick="event.stopPropagation()">` : ''}
            <div class="radar-score badge-${b.cls}"><span class="rs-num">${b.num}</span>${b.tier ? `<span class="rs-tier">${b.tier}</span>` : ''}${revFit}${aln}${confPct}</div>
            <div class="radar-lead-body">
                <div class="radar-lead-head">
                    <strong>${esc(l.vaga || 'Vaga')}</strong> — ${esc(l.empresa)} ${link}
                    <span class="radar-status-tag s-${esc(l.status)}">${esc(l.status)}</span>
                    ${suspBadge}
                </div>
                <div class="radar-chips">${chips}</div>
                ${kw ? `<div class="radar-chips">${kw}</div>` : ''}
                ${gaps ? `<div class="radar-chips"><span class="radar-chip-label">Gaps:</span>${gaps}</div>` : ''}
                ${pos}
                ${_radarSelecting ? '' : _renderLeadActions(l)}
            </div>
        </div>`;
    }).join('');
}

// ── Filter panel toggle ──
function toggleRadarFilters() {
    _radarFiltersOpen = !_radarFiltersOpen;
    document.getElementById('radarFiltersPanel')?.classList.toggle('collapsed', !_radarFiltersOpen);
    const ch = document.getElementById('radarFiltersChevron');
    if (ch) ch.style.transform = _radarFiltersOpen ? 'rotate(180deg)' : '';
}
function _updateRadarFilterBadge() {
    let n = 0;
    if (_radarMinScore > 0)          n++;
    if (_radarFonteFilter !== 'all') n++;
    if (_radarModFilter   !== 'all') n++;
    const badge = document.getElementById('radarFiltersBadge');
    if (badge) { badge.textContent = n; badge.style.display = n ? 'inline-flex' : 'none'; }
}

// ── Filter / sort helpers ──
function setRadarMinScore(val) {
    _radarMinScore = Number(val) || 0;
    renderRadarList(_radarLeads);
    _updateRadarFilterBadge();
}
function setRadarFonteFilter(val, btn) {
    _radarFonteFilter = val;
    document.querySelectorAll('.radar-fonte-chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderRadarList(_radarLeads);
    _updateRadarFilterBadge();
}
function setRadarModFilter(val, btn) {
    _radarModFilter = val;
    document.querySelectorAll('.radar-mod-chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderRadarList(_radarLeads);
    _updateRadarFilterBadge();
}
function setRadarSort(key, btn) {
    _radarSortKey = key;
    document.querySelectorAll('.radar-sort-chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderRadarList(_radarLeads);
}

// ── Bulk select mode ──
function toggleRadarSelectMode() {
    _radarSelecting = !_radarSelecting;
    _radarSelected.clear();
    const btn = document.getElementById('radarSelectBtn');
    if (btn) btn.classList.toggle('active', _radarSelecting);
    renderRadarList(_radarLeads);
    _renderRadarBulkBar();
}
function toggleRadarSelect(id) {
    if (_radarSelected.has(id)) _radarSelected.delete(id);
    else _radarSelected.add(id);
    renderRadarList(_radarLeads);
    _renderRadarBulkBar();
}
function _renderRadarBulkBar() {
    let bar = document.getElementById('radar-bulk-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'radar-bulk-bar';
        bar.className = 'radar-bulk-bar';
        document.body.appendChild(bar);
    }
    if (!_radarSelecting || _radarSelected.size === 0) {
        bar.style.display = 'none';
        return;
    }
    const n = _radarSelected.size;
    bar.style.display = 'flex';
    bar.innerHTML = `
        <span style="font-size:0.8rem;color:var(--text-soft);margin-right:4px">${n} selecionado${n > 1 ? 's' : ''}</span>
        <button class="btn btn-cyan btn-sm" onclick="bulkPromoteRadar()"><i class="fa-solid fa-arrow-right-to-bracket"></i> Promover selecionados</button>
        <button class="btn btn-danger btn-sm" onclick="bulkDiscardRadar()"><i class="fa-solid fa-ban"></i> Descartar selecionados</button>
        <button class="btn btn-sm" onclick="toggleRadarSelectMode()" style="margin-left:auto">Cancelar</button>
    `;
}
async function bulkDiscardRadar() {
    const ids = [..._radarSelected];
    const motivo = await showPrompt('Descartar leads', 'Motivo (opcional)');
    if (motivo === null) return;
    try {
        await api('PUT', '/api/admin/radar?action=bulk-discard', { ids, motivo_descarte: motivo || '' });
        showToast(`${ids.length} lead${ids.length > 1 ? 's' : ''} descartado${ids.length > 1 ? 's' : ''}.`);
        toggleRadarSelectMode();
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

async function bulkPromoteRadar() {
    const ids = [..._radarSelected];
    if (!ids.length) return;
    const n = ids.length;
    if (!confirm(`Promover ${n} lead${n > 1 ? 's' : ''} como candidatura${n > 1 ? 's' : ''}?\n(Sem mensagem personalizada — edite depois em cada candidatura.)`)) return;
    try {
        const res = await api('POST', '/api/admin/applications?__h=batch-promote', { lead_ids: ids });
        showToast(`${res.count} candidatura${res.count > 1 ? 's' : ''} criada${res.count > 1 ? 's' : ''}.`);
        toggleRadarSelectMode();
        loadRadar();
        loadApplications();
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Adaptar CV ──
async function adaptarCvRadar(id) {
    _adaptarCvLeadId = id;
    const lead = _radarLeads.find(l => l.id === id);
    const modal = document.getElementById('radarAdaptarCvModal');
    const body  = document.getElementById('radarAdaptarCvBody');
    if (!modal || !body) return;
    body.innerHTML = '<div style="color:var(--text-dim);padding:8px">Carregando…</div>';
    modal.style.display = '';
    modal.classList.add('open');

    try {
        _cvVersionsList = await api('GET', '/api/admin/cv-versions');
        const adaptedId = lead?.adapted_cv_id;
        const adaptedCv = adaptedId ? _cvVersionsList.find(c => c.id === adaptedId) : null;

        const cvOptions = _cvVersionsList.filter(c => c.active).map(c =>
            `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;cursor:pointer">
                <input type="radio" name="adaptarCvSelect" value="${esc(c.id)}" ${c.id === adaptedId ? 'checked' : ''}>
                <span style="font-size:0.82rem">${esc(c.name)}</span>
                ${c.target_role ? `<span style="font-size:0.7rem;color:var(--text-dim)">(${esc(c.target_role)})</span>` : ''}
            </label>`
        ).join('');

        body.innerHTML = `
            ${adaptedCv ? `<div style="padding:8px 0;border-bottom:1px solid var(--border-soft);margin-bottom:10px">
                <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:4px">CV adaptado atual</div>
                <div style="display:flex;align-items:center;gap:8px">
                    <i class="fa-solid fa-file-pdf" style="color:#f87171"></i>
                    <span style="font-size:0.82rem">${esc(adaptedCv.name)}</span>
                    <button class="btn btn-sm" onclick="previewCV('${adaptedCv.id}','${esc(adaptedCv.name)}')" title="Pré-visualizar">
                        <i class="fa-solid fa-eye"></i>
                    </button>
                </div>
            </div>` : ''}
            <div style="font-size:0.75rem;color:var(--text-soft);margin-bottom:8px">Selecione o CV base e copie o comando para o Claude Code:</div>
            <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:6px;padding:6px 10px;margin-bottom:10px">
                ${cvOptions || '<span style="color:var(--text-dim);font-size:0.8rem">Nenhum CV ativo encontrado.</span>'}
            </div>
            <div style="display:flex;gap:6px">
                <button class="btn btn-sm btn-cyan" onclick="copyAdaptarCvCommand('${id}')"><i class="fa-solid fa-copy"></i> Copiar comando MCP</button>
            </div>
            <p style="font-size:0.72rem;color:var(--text-dim);margin-top:10px">Cole o comando no Claude Code para gerar sugestões de adaptação. Após a análise, use <code>save_cv_adaptation</code> para salvar o resultado.</p>
        `;
    } catch (e) {
        body.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}
async function copyAdaptarCvCommand(leadId) {
    const selected = document.querySelector('input[name="adaptarCvSelect"]:checked');
    if (!selected) { showToast('Selecione um CV base.', 'error'); return; }
    const cvId = selected.value;
    const cmd = `get_cv_adaptation_prompt({ vaga_id: "${leadId}", cv_id: "${cvId}" })`;
    try {
        await navigator.clipboard.writeText(cmd);
        showToast('Comando copiado!');
    } catch { showToast('Não foi possível copiar.', 'error'); }
}
function closeRadarAdaptarCv() {
    _adaptarCvLeadId = null;
    const modal = document.getElementById('radarAdaptarCvModal');
    if (modal) {
        modal.classList.remove('open');
        modal.style.display = 'none';
    }
}

function openBuscarModal() {
    document.getElementById('radarBuscarModal').classList.add('open');
    loadRsqHistory();
}
function closeBuscarModal() {
    document.getElementById('radarBuscarModal').classList.remove('open');
}
function openAdicionarModal() {
    document.getElementById('radarAdicionarModal').classList.add('open');
}
function closeAdicionarModal() {
    document.getElementById('radarAdicionarModal').classList.remove('open');
}

async function addRadarVaga(btn) {
    const empresa = document.getElementById('raEmpresa').value.trim();
    if (!empresa) { showToast('Informe a empresa.', 'error'); return; }
    const payload = {
        empresa,
        vaga: document.getElementById('raVaga').value.trim(),
        link_vaga: document.getElementById('raLink').value.trim(),
        modalidade: document.getElementById('raModalidade').value,
        tipo_contratacao: document.getElementById('raTipo').value,
        nivel: document.getElementById('raNivel').value.trim(),
        descricao: document.getElementById('raDescricao').value.trim(),
    };
    try {
        await withLoading(btn, async () => {
            await api('POST', '/api/admin/radar', payload);
        }, 'Adicionando…');
        ['raEmpresa','raVaga','raLink','raNivel','raDescricao'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('raModalidade').value = '';
        document.getElementById('raTipo').value = '';
        showToast('Vaga adicionada ao Radar.');
        closeAdicionarModal();
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

async function analyzeRadar(id) {
    try {
        const r = await api('GET', `/api/admin/radar-analysis?id=${id}`);
        if (r.mode === 'auto') {
            showToast('Análise por IA concluída.');
            loadRadar();
        } else {
            openRadarAnalysisModal(id, r.prompt);
        }
    } catch (e) { showToast(e.message, 'error'); }
}

function openRadarAnalysisModal(id, prompt) {
    _radarAnalysisId = id;
    document.getElementById('radarPromptText').textContent = prompt || '';
    document.getElementById('radarAnalysisJson').value = '';
    document.getElementById('radarAnalysisModal').classList.add('open');
}
function closeRadarAnalysis() {
    _radarAnalysisId = null;
    document.getElementById('radarAnalysisModal').classList.remove('open');
}
async function copyRadarPrompt(btn) {
    const txt = document.getElementById('radarPromptText').textContent;
    try {
        await navigator.clipboard.writeText(txt);
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
    } catch { showToast('Não foi possível copiar.', 'error'); }
}
async function saveRadarAnalysis(btn) {
    const raw = document.getElementById('radarAnalysisJson').value.trim();
    if (!raw) { showToast('Cole o JSON de análise.', 'error'); return; }
    if (!_radarAnalysisId) return;
    try {
        await withLoading(btn, async () => {
            await api('PUT', `/api/admin/radar-analysis?id=${_radarAnalysisId}`, { raw });
        }, 'Salvando…');
        showToast('Análise salva.');
        closeRadarAnalysis();
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

async function promoteRadar(id) {
    const lead = _radarLeads?.find(l => l.id === id);
    const empresa = lead?.empresa || '';

    // Aviso de candidatura repetida (item C)
    if (empresa) {
        try {
            const dup = await api('GET', `/api/admin/applications?__h=duplicate-check&empresa=${encodeURIComponent(empresa)}`);
            if (dup.found && dup.matches?.length) {
                const last = dup.matches[0];
                const lastDate = last.created_at ? new Date(last.created_at).toLocaleDateString('pt-BR') : '?';
                const msg = `Você já aplicou em "${empresa}" (${dup.matches.length}×).\nÚltima: ${last.vaga || 'vaga'} em ${lastDate} — ${last.result || 'sem resultado'}.\n\nContinuar?`;
                if (!confirm(msg)) return;
            }
        } catch { /* não bloqueia por falha no check */ }
    }

    const doOpen = async () => {
        switchTab('vagas');
        await new Promise(r => setTimeout(r, 100));
        openNovaVaga(lead || { id, empresa: '', vaga: '', link_vaga: '' });
        showToast('Preencha a mensagem e clique em "Criar candidatura".');
    };

    // N2: pré-screening de confiança antes de abrir o formulário
    showAdvanceConfidence(id, doOpen);
}

async function discardRadar(id) {
    const motivo = await showPrompt('Descartar lead', 'Motivo (opcional)');
    if (motivo === null) return; // cancelou
    try {
        await api('PUT', `/api/admin/radar?id=${id}`, { status: 'descartada', motivo_descarte: motivo || '' });
        showToast('Lead descartado.');
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteRadar(id) {
    const lead = _radarLeads.find(l => l.id === id);
    let extra = '';
    if (lead?.link_vaga) {
        try {
            const r = await api('GET', `/api/admin/radar?action=check-app-link&link=${encodeURIComponent(lead.link_vaga)}`);
            if (r?.has_app) extra = '\n\nAtenção: você já tem candidatura registrada para essa vaga. Excluir o lead pode causar duplicata na próxima busca.';
        } catch (_) { /* checagem é opcional */ }
    }
    if (!await showConfirm('Excluir lead?', 'Esta ação não pode ser desfeita.' + extra, { okText: 'Excluir' })) return;
    try {
        await api('DELETE', `/api/admin/radar?id=${id}`);
        showToast('Lead excluído.');
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

// Parte 7 / Camada 4: escape hatch — reabrir candidatura no Radar para nova avaliação
async function reopenInRadar(appId) {
    if (!await showConfirm('Voltar para o Radar?', 'Reabre esta vaga no Radar como "avaliada" para nova avaliação. A candidatura original fica preservada como histórico.', { okText: 'Reabrir', danger: false })) return;
    try {
        const r = await api('POST', `/api/admin/radar?action=reopen-from-app&app_id=${appId}`);
        showToast(r.reused ? 'Lead existente atualizado no Radar.' : 'Lead reaberto no Radar.', 'success', {
            label: 'Ver Radar', callback: () => switchTab('radar')
        });
    } catch (e) { showToast(e.message, 'error'); }
}

async function restoreRadar(id) {
    if (!await showConfirm('Restaurar lead?', 'Volta para o status "avaliada" e limpa o motivo de descarte.', { okText: 'Restaurar', danger: false })) return;
    try {
        await api('PUT', `/api/admin/radar?id=${id}`, { status: 'avaliada', motivo_descarte: null });
        showToast('Lead restaurado.');
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
}

// Parte 6: botões condicionais por status do lead
function _renderLeadActions(l) {
    const id = l.id;
    const empresa = encodeURIComponent(l.empresa || '');
    const analyze = `<button class="btn btn-sm" onclick="analyzeRadar('${id}')"><i class="fa-solid fa-wand-magic-sparkles"></i> Analisar</button>`;
    const intelBtn = l.empresa ? `<button class="btn btn-sm" onclick="showCompanyIntel('${id}','${esc(l.empresa)}')" title="Validar empresa (Receita Federal + red flags)"><i class="fa-solid fa-building-magnifying-glass"></i> Empresa</button>` : '';
    let extra = '';
    if (l.status === 'novo' || l.status === 'avaliada') {
        extra = `
            <button class="btn btn-sm" onclick="adaptarCvRadar('${id}')"><i class="fa-solid fa-wand-sparkles"></i> Adaptar CV</button>
            ${intelBtn}
            <button class="btn btn-cyan btn-sm" onclick="promoteRadar('${id}')"><i class="fa-solid fa-arrow-right-to-bracket"></i> Promover</button>
            <button class="btn btn-sm" onclick="discardRadar('${id}')" title="Marcar como descartada (reversível)"><i class="fa-solid fa-ban"></i> Descartar</button>
        `;
    } else if (l.status === 'descartada') {
        extra = `
            <button class="btn btn-sm" onclick="restoreRadar('${id}')" title="Voltar para avaliação"><i class="fa-solid fa-rotate-left"></i> Restaurar</button>
            <button class="btn btn-danger btn-sm" onclick="deleteRadar('${id}')" title="Excluir permanentemente — não pode ser desfeito"><i class="fa-solid fa-trash-can"></i> Excluir</button>
        `;
    } else if (l.status === 'promovida') {
        extra = `
            ${intelBtn}
            <button class="btn btn-danger btn-sm" onclick="deleteRadar('${id}')" title="Excluir permanentemente — não pode ser desfeito"><i class="fa-solid fa-trash-can"></i> Excluir</button>
        `;
    }
    return `<div class="radar-lead-actions">${analyze}${extra}</div>`;
}

async function showCompanyIntel(leadId, empresa) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `<div style="max-width:500px;width:100%;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;padding:20px">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
            <h4 style="margin:0;font-size:0.95rem;color:var(--text)"><i class="fa-solid fa-building-magnifying-glass" style="color:var(--cyan);margin-right:6px"></i>${esc(empresa)}</h4>
            <button class="btn btn-sm" onclick="this.closest('[style*=fixed]').remove()"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="companyIntelBody" style="font-size:0.82rem;color:var(--text-soft)"><i class="fa-solid fa-circle-notch fa-spin" style="color:var(--cyan)"></i> Buscando...</div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    try {
        const r = await apiFetch(`/api/admin/applications?__h=company-intel&empresa=${encodeURIComponent(empresa)}`);
        const intel = r.intel || {};
        const body = document.getElementById('companyIntelBody');
        if (!body) return;
        const flags = Array.isArray(intel.red_flags) ? intel.red_flags : [];
        const flagsHtml = flags.length
            ? `<div style="margin-top:10px;padding:8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:6px;font-size:0.78rem;color:#f87171"><i class="fa-solid fa-triangle-exclamation"></i> <strong>Red flags:</strong> ${flags.map(f=>esc(f)).join(', ')}</div>`
            : `<div style="margin-top:10px;padding:8px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);border-radius:6px;font-size:0.78rem;color:#4ade80"><i class="fa-solid fa-check-circle"></i> Nenhum red flag detectado</div>`;
        body.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
                <div><span style="color:var(--text-dim)">Status CNPJ:</span> <strong>${esc(intel.situacao||'N/D')}</strong></div>
                <div><span style="color:var(--text-dim)">Abertura:</span> <strong>${intel.date_abertura ? new Date(intel.date_abertura).toLocaleDateString('pt-BR') : 'N/D'}</strong></div>
                <div><span style="color:var(--text-dim)">CNPJ:</span> <strong>${esc(intel.cnpj||'N/D')}</strong></div>
                <div><span style="color:var(--text-dim)">Fonte:</span> <strong>${esc(r.source||'api')}</strong></div>
            </div>
            ${flagsHtml}
            ${intel.fetch_status === 'partial' ? '<div style="margin-top:8px;font-size:0.72rem;color:var(--text-dim)">* Dados parciais — API da Receita Federal pode estar indisponível.</div>' : ''}
        `;
    } catch(e) {
        const body = document.getElementById('companyIntelBody');
        if (body) body.innerHTML = `<div style="color:#f87171">${esc(e.message)}</div>`;
    }
}

// ── Helpers compartilhados: chips, tag-input, CNH toggle ──
function _chipToggle(btn) {
    const cur = btn.getAttribute('data-selected') === 'true';
    btn.setAttribute('data-selected', String(!cur));
}
function _chipsGetSelected(container) {
    if (!container) return [];
    return [...container.querySelectorAll('.rp-chip[data-selected="true"]')].map(b => b.getAttribute('data-value'));
}
function _chipsRender(container, items, selected) {
    if (!container) return;
    const sel = new Set(selected || []);
    container.innerHTML = items.map(it => {
        const val = typeof it === 'string' ? it : it.value;
        const lbl = typeof it === 'string' ? it : it.label;
        return `<button type="button" class="rp-chip" data-value="${esc(val)}" data-selected="${sel.has(val)}" onclick="_chipToggle(this)">${esc(lbl)}</button>`;
    }).join('');
}
function _tagInputInit(container, values = []) {
    if (!container) return;
    const placeholder = container.getAttribute('data-placeholder') || '+ adicionar';
    container.innerHTML = '';
    (values || []).forEach(v => _tagInputAdd(container, v));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rp-tag-add';
    input.placeholder = placeholder;
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const v = input.value.trim().replace(/,$/, '').trim();
            if (v) { _tagInputAdd(container, v); input.value = ''; }
        } else if (e.key === 'Backspace' && !input.value) {
            const tags = container.querySelectorAll('.rp-tag');
            const last = tags[tags.length - 1];
            if (last) last.remove();
        }
    });
    input.addEventListener('blur', () => {
        const v = input.value.trim();
        if (v) { _tagInputAdd(container, v); input.value = ''; }
    });
    container.appendChild(input);
}
function _tagInputAdd(container, value) {
    const tag = document.createElement('span');
    tag.className = 'rp-tag';
    const txt = document.createElement('span');
    txt.textContent = value;
    tag.appendChild(txt);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'rp-tag-x'; x.textContent = '×';
    x.onclick = () => tag.remove();
    tag.appendChild(x);
    const adder = container.querySelector('.rp-tag-add');
    if (adder) container.insertBefore(tag, adder);
    else container.appendChild(tag);
}
function _tagInputGet(container) {
    if (!container) return [];
    return [...container.querySelectorAll('.rp-tag > span:first-child')].map(t => t.textContent.trim()).filter(Boolean);
}
function _rpToggleCnh() {
    const has = document.getElementById('rpCnhHas')?.checked;
    const fld = document.getElementById('rpCnhCategoriesField');
    if (fld) fld.hidden = !has;
    if (!has) {
        document.querySelectorAll('#rpCnhCategories .rp-chip[data-selected="true"]').forEach(c => c.setAttribute('data-selected', 'false'));
    }
}

// ── Perfil-base ──
function toggleRadarProfile() {
    const card = document.getElementById('radarProfileCard');
    if (card) card.hidden = !card.hidden;
}
function fillRadarProfileForm(p) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    set('rpNivel', p.nivel_alvo);
    set('rpModalidade', p.modalidade_pref);
    set('rpLocalizacao', p.localizacao);

    // Tag-inputs
    _tagInputInit(document.getElementById('rpCore'), p.skills_core);
    _tagInputInit(document.getElementById('rpEvolucao'), p.skills_evolucao);
    _tagInputInit(document.getElementById('rpGaps'), p.gaps);
    _tagInputInit(document.getElementById('rpSetores'), p.setores);
    _tagInputInit(document.getElementById('rpKeywords'), p.keywords);

    // Tipos de contratação como chips
    const tipos = ['CLT','PJ','Freelancer','Cooperado','Temporário','Estágio','Autônomo'];
    const prefs = Array.isArray(p.contratacao_prefs) ? p.contratacao_prefs : (p.contratacao_pref ? [p.contratacao_pref] : []);
    _chipsRender(document.getElementById('rpContratacaoChips'), tipos, prefs);

    // CNH: toggle + categorias condicionais como chips
    const cnh = p.cnh || { has: false, categories: [] };
    const cnhHasEl = document.getElementById('rpCnhHas');
    if (cnhHasEl) cnhHasEl.checked = !!cnh.has;
    _chipsRender(document.getElementById('rpCnhCategories'), ['A','B','C','D','E'], cnh.categories || []);
    const catField = document.getElementById('rpCnhCategoriesField');
    if (catField) catField.hidden = !cnh.has;

    // Plataformas de busca como chips (com label + id como value)
    const platforms = Array.isArray(p.search_platforms) ? p.search_platforms : [];
    const cont = document.getElementById('rpPlatformsContainer');
    if (cont) {
        if (platforms.length) {
            _chipsRender(cont, platforms.map(plat => ({ value: plat.id, label: plat.label || plat.id })), platforms.filter(p => p.enabled !== false).map(p => p.id));
        } else {
            cont.innerHTML = '<span style="font-size:0.75rem;color:var(--text-dim)">Nenhuma plataforma configurada no perfil.</span>';
        }
    }

    // Esconde hint "Salvo" — usuário voltou a editar
    const hint = document.getElementById('rpSavedHint');
    if (hint) hint.classList.remove('visible');
}

let _rpSavedTimer = null;
function _rpShowSaved() {
    const hint = document.getElementById('rpSavedHint');
    const txtEl = document.getElementById('rpSavedHintText');
    if (!hint || !txtEl) return;
    clearInterval(_rpSavedTimer);
    const ts = Date.now();
    const update = () => {
        const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        txtEl.textContent = s < 5 ? 'Salvo agora' : s < 60 ? `Salvo há ${s}s` : `Salvo há ${Math.floor(s/60)}min`;
    };
    update();
    hint.classList.add('visible');
    _rpSavedTimer = setInterval(update, 1000);
}

async function saveRadarProfile(btn) {
    const val = id => (document.getElementById(id) || {}).value || '';
    const cnhHas = document.getElementById('rpCnhHas')?.checked || false;
    const cnhCategories = cnhHas ? _chipsGetSelected(document.getElementById('rpCnhCategories')) : [];
    const contratacaoPrefs = _chipsGetSelected(document.getElementById('rpContratacaoChips'));
    const selectedPlats = new Set(_chipsGetSelected(document.getElementById('rpPlatformsContainer')));
    const updatedPlatforms = (_radarProfile.search_platforms || []).map(plat => ({
        ...plat,
        enabled: selectedPlats.has(plat.id),
    }));
    const payload = {
        nivel_alvo: val('rpNivel').trim(),
        modalidade_pref: val('rpModalidade').trim(),
        localizacao: val('rpLocalizacao').trim(),
        skills_core: _tagInputGet(document.getElementById('rpCore')),
        skills_evolucao: _tagInputGet(document.getElementById('rpEvolucao')),
        gaps: _tagInputGet(document.getElementById('rpGaps')),
        setores: _tagInputGet(document.getElementById('rpSetores')),
        keywords: _tagInputGet(document.getElementById('rpKeywords')),
        diferenciais: _radarProfile.diferenciais || [],
        cnh: { has: cnhHas, categories: cnhCategories },
        contratacao_prefs: contratacaoPrefs,
        search_platforms: updatedPlatforms,
    };
    try {
        await withLoading(btn, async () => {
            _radarProfile = await api('PUT', '/api/admin/profile', payload);
        }, 'Salvando…');
        renderRadarSearches(_radarProfile);
        _rsqSyncPlatforms(_radarProfile);
        _rpShowSaved();
        showToast('Perfil salvo.');
    } catch (e) { showToast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════
// ONDA 3 — Produtividade do dia a dia
// ═══════════════════════════════════════════════════════════

// ── Kanban (item J) ──────────────────────────────────────
function renderKanban(apps) {
    const board = document.getElementById('kanbanBoard');
    if (!board) return;

    const COLS = ['Aplicado', 'Triagem', 'Entrevista com RH', 'Entrevista Técnica', 'Entrevista com Gestor', 'Teste', 'Proposta', 'Recusado', 'Aprovado'];
    const active = apps.filter(a => !a.archived);

    const getStage = app => {
        const stages = app.stages || [];
        const last = [...stages].reverse().find(s => s.active !== false && (s.completed_at || s.date));
        if (last) return last.name || last.label || 'Aplicado';
        if (app.result === 'recusado') return 'Recusado';
        if (app.result === 'aprovado') return 'Aprovado';
        return 'Aplicado';
    };

    const byCol = {};
    COLS.forEach(c => { byCol[c] = []; });
    active.forEach(a => {
        const col = getStage(a);
        if (byCol[col]) byCol[col].push(a);
        else byCol['Aplicado'].push(a);
    });

    board.innerHTML = COLS.map(col => {
        const items = byCol[col] || [];
        const colKey = col.toLowerCase().replace(/\s+/g, '-');
        return `<div class="kanban-col" data-col="${esc(col)}">
            <div class="kanban-col-header">
                <span title="${esc(col)}">${esc(col)}</span>
                <span class="kanban-col-count">${items.length}</span>
            </div>
            <div class="kanban-cards" id="kcol-${esc(colKey)}">
                ${items.map(a => `
                <div class="kanban-card" onclick="openDrawer('${a.id}')">
                    <div class="kanban-card-empresa">${esc(a.empresa)}</div>
                    <div class="kanban-card-vaga">${esc(a.vaga || '')}</div>
                    ${a.modalidade ? `<span class="radar-chip" style="font-size:0.68rem">${esc(a.modalidade)}</span>` : ''}
                </div>`).join('')}
                ${items.length === 0 ? '<div style="font-size:0.75rem;color:var(--text-dim);padding:8px;text-align:center">—</div>' : ''}
            </div>
        </div>`;
    }).join('');
}

// ── Triagem swipe (item D) ───────────────────────────────
let _triagemQueue = [];
let _triagemIdx   = 0;

function openTriagemSwipe() {
    const novos = (_radarLeads || []).filter(l => l.status === 'novo' || l.status === 'avaliada');
    if (!novos.length) { showToast('Nenhum lead novo para triagem.', 'info'); return; }
    _triagemQueue = [...novos];
    _triagemIdx   = 0;
    document.getElementById('triagemModal').classList.add('open');
    _renderTriagemCard();
}

function closeTriagemSwipe() {
    document.getElementById('triagemModal').classList.remove('open');
    _triagemQueue = [];
    _triagemIdx   = 0;
    loadRadar();
}

function _renderTriagemCard() {
    const counter = document.getElementById('triagemCounter');
    const card    = document.getElementById('triagemCard');
    if (!card) return;

    if (_triagemIdx >= _triagemQueue.length) {
        counter.textContent = 'Concluída';
        card.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-soft)"><i class="fa-solid fa-check-circle" style="font-size:2rem;color:var(--cyan);display:block;margin-bottom:12px"></i>Triagem concluída! ${_triagemQueue.length} lead${_triagemQueue.length > 1 ? 's' : ''} revisado${_triagemQueue.length > 1 ? 's' : ''}.</div>`;
        return;
    }

    const l = _triagemQueue[_triagemIdx];
    counter.textContent = `${_triagemIdx + 1} / ${_triagemQueue.length}`;
    const b = radarBadge(l.fit_score);
    const kw = (l.keywords_match || []).slice(0, 10).map(k => `<span class="radar-chip kw">${esc(k)}</span>`).join('');
    const gaps = (l.gaps || []).slice(0, 6).map(g => `<span class="radar-chip gap">${esc(g)}</span>`).join('');

    card.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px">
            <div class="radar-score badge-${b.cls}" style="flex-shrink:0"><span class="rs-num">${b.num}</span></div>
            <div>
                <div style="font-weight:700;font-size:1rem">${esc(l.vaga || 'Vaga')}</div>
                <div style="color:var(--text-soft);font-size:0.88rem">${esc(l.empresa)}</div>
                <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
                    ${[l.nivel, l.modalidade, l.tipo_contratacao].filter(Boolean).map(c => `<span class="radar-chip">${esc(c)}</span>`).join('')}
                </div>
            </div>
        </div>
        ${l.positioning ? `<p style="font-size:0.82rem;color:var(--text-soft);margin:0 0 10px;line-height:1.45">${esc(l.positioning)}</p>` : ''}
        ${kw ? `<div class="radar-chips" style="margin-bottom:6px">${kw}</div>` : ''}
        ${gaps ? `<div class="radar-chips"><span class="radar-chip-label">Gaps:</span>${gaps}</div>` : ''}
        ${l.link_vaga ? `<a href="${esc(l.link_vaga)}" target="_blank" rel="noopener" style="font-size:0.78rem;color:var(--cyan)" onclick="event.stopPropagation()"><i class="fa-solid fa-arrow-up-right-from-square"></i> Abrir vaga</a>` : ''}
    `;
}

async function triagemAction(action) {
    const l = _triagemQueue[_triagemIdx];
    if (!l) return;

    if (action === 'promote') {
        closeTriagemSwipe();
        await promoteRadar(l.id);
        return;
    }
    if (action === 'discard') {
        try {
            await api('PUT', `/api/admin/radar?id=${l.id}`, { status: 'descartada', motivo_descarte: 'triagem-swipe' });
        } catch { /* non-fatal */ }
    }
    // skip and discard both advance
    _triagemIdx++;
    _renderTriagemCard();
}

// Kanban subtab support is injected into switchVagasSubTab below

// ── Q&A Bank (item K) ─────────────────────────────────────
let _qaEditId = null;

function openQAModal() {
    document.getElementById('qaModal').classList.add('open');
    loadQABank();
}
function closeQAModal() {
    document.getElementById('qaModal').classList.remove('open');
}

async function loadQABank() {
    const el = document.getElementById('qaBankList');
    if (!el) return;
    const cat = document.getElementById('qaFilterCat')?.value || '';
    try {
        const url = `/api/admin/applications?__h=interview-qa${cat ? '&category=' + encodeURIComponent(cat) : ''}`;
        const data = await api('GET', url);
        if (!data.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhuma pergunta cadastrada.</div>'; return; }
        el.innerHTML = data.map(q => `
            <div class="qa-bank-card">
                <div class="qa-bank-cat">${q.category || '—'}</div>
                <div class="qa-bank-q">${esc(q.question)}</div>
                ${q.answer ? `<div class="qa-bank-a">${esc(q.answer)}</div>` : ''}
                ${(q.tags || []).length ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${q.tags.map(t => `<span class="radar-chip">${esc(t)}</span>`).join('')}</div>` : ''}
                <div style="display:flex;gap:8px;margin-top:8px">
                    <button class="btn btn-sm" style="font-size:0.72rem;padding:2px 8px" onclick="openEditQA('${q.id}')"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-danger btn-sm" style="font-size:0.72rem;padding:2px 8px" onclick="deleteQA('${q.id}')"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`).join('');
    } catch (e) { el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`; }
}

function openAddQA() {
    _qaEditId = null;
    document.getElementById('qaFormQuestion').value = '';
    document.getElementById('qaFormAnswer').value = '';
    document.getElementById('qaFormCat').value = '';
    document.getElementById('qaFormTags').value = '';
    document.getElementById('qaFormId').value = '';
    document.getElementById('qaForm').style.display = '';
}

async function openEditQA(id) {
    _qaEditId = id;
    const url = `/api/admin/applications?__h=interview-qa`;
    const data = await api('GET', url).catch(() => []);
    const q = data.find(x => x.id === id);
    if (!q) return;
    document.getElementById('qaFormQuestion').value = q.question || '';
    document.getElementById('qaFormAnswer').value = q.answer || '';
    document.getElementById('qaFormCat').value = q.category || '';
    document.getElementById('qaFormTags').value = (q.tags || []).join(', ');
    document.getElementById('qaFormId').value = id;
    document.getElementById('qaForm').style.display = '';
}

function closeQAForm() { document.getElementById('qaForm').style.display = 'none'; }

async function saveQA() {
    const id = document.getElementById('qaFormId').value;
    const body = {
        question: document.getElementById('qaFormQuestion').value.trim(),
        answer:   document.getElementById('qaFormAnswer').value.trim() || null,
        category: document.getElementById('qaFormCat').value || null,
        tags:     document.getElementById('qaFormTags').value.split(',').map(s => s.trim()).filter(Boolean),
    };
    if (!body.question) { showToast('Pergunta obrigatória.', 'error'); return; }
    try {
        if (id) {
            await api('PUT', `/api/admin/applications?__h=interview-qa&id=${id}`, body);
        } else {
            await api('POST', '/api/admin/applications?__h=interview-qa', body);
        }
        closeQAForm();
        loadQABank();
        showToast('Salvo.');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteQA(id) {
    if (!await showConfirm('Excluir pergunta?', '', { okText: 'Excluir' })) return;
    try {
        await api('DELETE', `/api/admin/applications?__h=interview-qa&id=${id}`);
        loadQABank();
        showToast('Excluído.');
    } catch (e) { showToast(e.message, 'error'); }
}

// ── Gaps dashboard (item L) ───────────────────────────────
async function loadGapsDashboard() {
    const el = document.getElementById('gapsDashboard');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Carregando…</div>';
    try {
        const { gaps, total_leads } = await api('GET', '/api/admin/applications?__h=gaps-dashboard&days=90');
        if (!gaps.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhum gap identificado nos últimos 90 dias.</div>'; return; }
        el.innerHTML = `
            <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:10px">Baseado em ${total_leads} vagas dos últimos 90 dias</div>
            ${gaps.map(g => `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <div style="width:140px;font-size:0.82rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.skill)}">${esc(g.skill)}</div>
                <div style="flex:1;height:10px;background:var(--border);border-radius:5px;overflow:hidden">
                    <div style="height:100%;width:${g.pct}%;background:var(--cyan);border-radius:5px"></div>
                </div>
                <div style="font-size:0.75rem;color:var(--text-soft);width:50px;text-align:right">${g.pct}% (${g.count})</div>
            </div>`).join('')}
        `;
    } catch (e) { el.innerHTML = `<div style="color:var(--danger);font-size:0.82rem">${esc(e.message)}</div>`; }
}

// ── Voice memo (item N) ───────────────────────────────────
let _voiceRecognition = null;
let _voiceTargetId = null;

function startVoiceMemo(appId) {
    if (!('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
        showToast('Reconhecimento de voz não suportado neste navegador.', 'error');
        return;
    }
    _voiceTargetId = appId;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    _voiceRecognition = new SR();
    _voiceRecognition.lang = 'pt-BR';
    _voiceRecognition.interimResults = false;
    _voiceRecognition.maxAlternatives = 1;
    _voiceRecognition.onresult = async e => {
        const transcript = e.results[0][0].transcript;
        showToast(`Gravado: "${transcript.slice(0, 50)}${transcript.length > 50 ? '…' : ''}"`, 'success');
        const app = _applications.find(a => a.id === appId);
        const obs = [app?.observacoes, transcript].filter(Boolean).join('\n\n[voz] ');
        try {
            const updated = await api('PUT', `/api/admin/applications?id=${appId}`, { observacoes: obs });
            const idx = _applications.findIndex(a => a.id === appId);
            if (idx !== -1) _applications[idx] = updated;
            if (document.getElementById('drawer')?.classList.contains('open')) renderDrawerBody(updated);
        } catch { /* non-fatal */ }
    };
    _voiceRecognition.onerror = e => showToast(`Erro de voz: ${e.error}`, 'error');
    _voiceRecognition.start();
    showToast('Gravando… Fale agora.', 'info');
}

// ── Atalhos de teclado globais (item G) ──────────────────
(function setupKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
        // Ignore when typing in inputs/textarea
        const tag = document.activeElement?.tagName;
        if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;

        // Triagem swipe keys
        if (document.getElementById('triagemModal')?.classList.contains('open')) {
            if (e.key === 'a' || e.key === 'A') { e.preventDefault(); triagemAction('promote'); }
            else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); triagemAction('discard'); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); triagemAction('skip'); }
            else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); triagemAction('skip'); }
            return;
        }

        // Global shortcuts
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
            e.preventDefault();
            showToast('Atalhos: g=gerar msg · c=copiar msg · a=triagem · n=nova candidatura · r=Radar', 'info');
            return;
        }

        // Only active when no modal is open
        const anyModalOpen = document.querySelector('.modal-overlay.open, #contactFormPanel:not([style*="display:none"])');
        if (anyModalOpen) return;

        if (e.key === 'g') {
            e.preventDefault();
            const btn = document.getElementById('vfGenerateBtn');
            if (btn && !btn.hidden) btn.click();
        } else if (e.key === 'c') {
            e.preventDefault();
            const btn = document.getElementById('vfCopyBtn');
            if (btn && !btn.hidden) btn.click();
        } else if (e.key === 'a' && !e.shiftKey) {
            e.preventDefault();
            openTriagemSwipe();
        } else if (e.key === 'n') {
            e.preventDefault();
            if (document.getElementById('tab-vagas')?.classList.contains('active-tab')) {
                openNovaVaga();
            }
        }
    });

    // ─── BRIEFING PRÉ-ENTREVISTA (N11) ───────────────────────
    async function openBriefing(appId) {
        const sec = document.getElementById('briefingSection');
        if (!sec) return;
        if (!sec.hidden && sec.dataset.appId === appId) { sec.hidden = true; return; }
        sec.dataset.appId = appId;
        sec.hidden = false;
        sec.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:16px"><i class="fa-solid fa-circle-notch fa-spin"></i> Montando briefing…</div>';
        try {
            const r = await apiFetch(`/api/admin/applications?__h=briefing-build&application_id=${appId}`);
            // N13: busca intel do entrevistador se app tem next_interview_with
            const interviewerName = r.app?.next_interview_with || r.interview?.interviewer_name || null;
            if (interviewerName) {
                try {
                    const ir = await apiFetch(`/api/admin/applications?__h=interviewer-intel&name=${encodeURIComponent(interviewerName)}`);
                    r.interviewer_intel = ir.intel || null;
                } catch(_) {}
            }
            sec.innerHTML = _renderBriefing(r);
        } catch(e) {
            sec.innerHTML = `<div style="color:#f87171;padding:8px;font-size:0.82rem">${esc(e.message)}</div>`;
        }
    }

    function _renderBriefing(r) {
        const { app, interview, stages, notes, qa, radar, profile } = r;
        const itvDate = interview?.interview_at ? new Date(interview.interview_at) : null;
        const now = Date.now();
        const minLeft = itvDate ? Math.round((itvDate.getTime() - now) / 60000) : null;

        const interviewBlock = interview ? `
            <div style="padding:8px 10px;border-radius:6px;background:rgba(34,211,238,0.08);border:1px solid rgba(34,211,238,0.2);margin-bottom:8px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--cyan);letter-spacing:0.07em;margin-bottom:4px"><i class="fa-solid fa-calendar-check" style="margin-right:4px"></i>Próxima entrevista</div>
                <div style="font-size:0.88rem;color:var(--text);font-weight:600">${esc(interview.stage_name||'Entrevista')} ${interview.interviewer_name?'com '+esc(interview.interviewer_name):''}</div>
                <div style="font-size:0.76rem;color:var(--text-soft)">${itvDate?itvDate.toLocaleString('pt-BR'):''} ${minLeft!==null&&minLeft>0?`<span style="color:#fb923c">— em ${minLeft < 60 ? minLeft+'min' : Math.round(minLeft/60)+'h'}</span>`:''}</div>
                ${interview.location?`<div style="font-size:0.72rem;color:var(--text-dim);margin-top:2px"><i class="fa-solid fa-location-dot" style="margin-right:4px"></i>${esc(interview.location)}</div>`:''}
            </div>` : `<div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:8px"><i class="fa-solid fa-calendar-xmark" style="margin-right:4px"></i>Nenhuma entrevista agendada. <button class="btn btn-sm" style="padding:2px 8px;font-size:0.72rem" onclick="openInterviewPanel('${app.id}')">Agendar</button></div>`;

        const radarBlock = (radar.fit_score || radar.gaps?.length) ? `
            <div style="margin-bottom:8px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.07em;margin-bottom:4px">Vaga</div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:4px">
                    ${radar.fit_score ? `<div style="font-size:0.82rem;color:var(--text)">Fit: <span style="color:${radar.fit_score>=7?'#4ade80':radar.fit_score>=5?'#fb923c':'#f87171'};font-weight:700">${radar.fit_score}</span></div>` : ''}
                    ${radar.advance_confidence != null ? `<div style="font-size:0.82rem;color:var(--text)">Conf: <span style="color:${radar.advance_confidence>=50?'#4ade80':radar.advance_confidence>=25?'#fb923c':'#f87171'};font-weight:700">${radar.advance_confidence}%</span></div>` : ''}
                    ${radar.faixa_salarial ? `<div style="font-size:0.76rem;color:var(--text-soft)">Faixa: ${esc(radar.faixa_salarial)}</div>` : ''}
                </div>
                ${radar.gaps?.length ? `<div style="font-size:0.76rem;color:#fb923c;margin-top:3px"><i class="fa-solid fa-triangle-exclamation" style="margin-right:3px"></i>Gaps: ${radar.gaps.slice(0,5).map(g=>esc(g)).join(', ')}</div>` : ''}
                ${radar.suspicious_flags?.length ? `<div style="font-size:0.72rem;color:#f87171;margin-top:2px"><i class="fa-solid fa-flag" style="margin-right:3px"></i>${radar.suspicious_flags.slice(0,3).map(f=>esc(f.label||f)).join(' · ')}</div>` : ''}
            </div>` : '';

        // N3 — Company intel no briefing
        const ci = r.company_intel;
        const companyBlock = ci ? `
            <div style="margin-bottom:8px;padding:7px 10px;border-radius:6px;background:rgba(34,211,238,0.05);border:1px solid rgba(34,211,238,0.15)">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.07em;margin-bottom:4px"><i class="fa-solid fa-building" style="margin-right:4px;color:var(--cyan)"></i>Empresa</div>
                <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:0.78rem;color:var(--text-soft)">
                    ${ci.situacao ? `<span>Status: <strong style="color:${ci.situacao==='ATIVA'?'#4ade80':'#f87171'}">${esc(ci.situacao)}</strong></span>` : ''}
                    ${ci.glassdoor_rating ? `<span>Glassdoor: <strong>${ci.glassdoor_rating}/5</strong></span>` : ''}
                    ${ci.size_employees ? `<span>Tamanho: <strong>${ci.size_employees.toLocaleString('pt-BR')} func.</strong></span>` : ''}
                </div>
                ${(ci.red_flags||[]).length ? `<div style="font-size:0.72rem;color:#f87171;margin-top:4px"><i class="fa-solid fa-triangle-exclamation" style="margin-right:3px"></i>${(ci.red_flags||[]).slice(0,3).map(f=>esc(f)).join(' · ')}</div>` : ''}
            </div>` : '';

        const stagesBlock = stages.length ? `
            <div style="margin-bottom:8px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.07em;margin-bottom:4px">Histórico</div>
                ${stages.map(s => `<div style="font-size:0.76rem;color:var(--text-soft);margin-bottom:2px"><i class="fa-solid fa-circle-check" style="color:var(--cyan);margin-right:4px;font-size:0.65rem"></i>${esc(s.name||s)}${s.completed_at?' · '+new Date(s.completed_at).toLocaleDateString('pt-BR'):''}</div>`).join('')}
            </div>` : '';

        const notesBlock = notes.length ? `
            <div style="margin-bottom:8px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.07em;margin-bottom:4px">Notas</div>
                ${notes.slice(0,3).map(n => `<div style="font-size:0.78rem;color:var(--text);margin-bottom:4px;padding:4px 8px;background:var(--bg);border-radius:4px">${esc(n.content||n.note||'').slice(0,120)}${(n.content||n.note||'').length>120?'…':''}</div>`).join('')}
            </div>` : '';

        const qaBlock = qa.length ? `
            <div style="margin-bottom:8px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.07em;margin-bottom:4px">Perguntas prováveis</div>
                ${qa.slice(0,5).map(q => `<div style="font-size:0.78rem;margin-bottom:4px">
                    <div style="color:var(--text);font-weight:500">${esc(q.question||'')}</div>
                    ${q.answer?`<div style="color:var(--text-soft);font-size:0.72rem;margin-top:1px">${esc(q.answer||'').slice(0,100)}…</div>`:''}
                </div>`).join('')}
            </div>` : '';

        const stars = r.stars || [];
        const starBlock = stars.length ? `
            <div style="margin-bottom:8px">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.07em;margin-bottom:4px"><i class="fa-solid fa-star" style="color:#fb923c;margin-right:4px"></i>Histórias STAR relevantes</div>
                ${stars.slice(0,3).map(s => `<div style="font-size:0.78rem;margin-bottom:5px;padding:5px 8px;background:var(--bg);border-radius:4px">
                    <div style="font-weight:600;color:var(--text)">${esc(s.title)}</div>
                    <div style="color:var(--text-soft);font-size:0.72rem;margin-top:1px">${(s.competencies||[]).slice(0,3).join(' · ')}</div>
                </div>`).join('')}
            </div>` : '';

        // N13 — Entrevistador
        const itvIntel = r.interviewer_intel;
        const interviewerBlock = itvIntel ? `
            <div style="margin-bottom:8px;padding:8px 10px;border-radius:6px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2)">
                <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:#a78bfa;letter-spacing:0.07em;margin-bottom:5px"><i class="fa-solid fa-user-tie" style="margin-right:4px"></i>Entrevistador</div>
                <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${esc(itvIntel.display_name||itvIntel.name_normalized)}</div>
                ${itvIntel.role_title ? `<div style="font-size:0.75rem;color:var(--text-soft)">${esc(itvIntel.role_title)}${itvIntel.company_at_match?' @ '+esc(itvIntel.company_at_match):''}</div>` : ''}
                ${itvIntel.bio_summary ? `<div style="font-size:0.76rem;color:var(--text-soft);margin-top:4px;line-height:1.4">${esc(itvIntel.bio_summary.slice(0,200))}${itvIntel.bio_summary.length>200?'…':''}</div>` : ''}
                ${(itvIntel.topics_of_interest||[]).length ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:3px">${(itvIntel.topics_of_interest||[]).slice(0,5).map(t=>`<span style="font-size:0.65rem;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);border-radius:10px;padding:1px 6px;color:#a78bfa">${esc(t)}</span>`).join('')}</div>` : ''}
                ${itvIntel.linkedin_url ? `<a href="${esc(itvIntel.linkedin_url)}" target="_blank" rel="noopener" style="font-size:0.72rem;color:#0a66c2;margin-top:4px;display:inline-block"><i class="fa-brands fa-linkedin" style="margin-right:3px"></i>LinkedIn</a>` : ''}
            </div>` :
            (interview?.interviewer_name ? `<div style="margin-bottom:8px;font-size:0.78rem;color:var(--text-dim)">
                <i class="fa-solid fa-user-tie" style="margin-right:4px;color:var(--text-dim)"></i>Entrevistador: <strong style="color:var(--text)">${esc(interview.interviewer_name)}</strong>
                <button class="btn btn-sm" style="padding:1px 6px;font-size:0.65rem;margin-left:6px" onclick="_openAddInterviewerForm('${app.id}','${esc(interview.interviewer_name)}')">+ Intel</button>
            </div>` : '');

        return `<div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);font-weight:700"><i class="fa-solid fa-file-lines" style="color:var(--cyan);margin-right:4px"></i>Briefing — ${esc(app.empresa)}</div>
                <button class="btn btn-sm" style="padding:2px 6px;font-size:0.72rem" onclick="openContextNotes('${app.id}')" title="Adicionar nota"><i class="fa-solid fa-plus"></i> Nota</button>
            </div>
            ${interviewBlock}${interviewerBlock}${companyBlock}${radarBlock}${stagesBlock}${notesBlock}${qaBlock}${starBlock}
        </div>`;
    }

    // ─── N13 — Adicionar intel de entrevistador ───────────────
    function _openAddInterviewerForm(appId, interviewerName) {
        const existing = document.getElementById('addInterviewerForm');
        if (existing) { existing.remove(); return; }
        const sec = document.getElementById('briefingSection');
        if (!sec) return;
        const div = document.createElement('div');
        div.id = 'addInterviewerForm';
        div.style.cssText = 'padding:10px;margin-top:8px;border:1px solid rgba(167,139,250,0.3);border-radius:6px;background:rgba(167,139,250,0.04)';
        div.innerHTML = `<div style="font-size:0.78rem;font-weight:600;color:#a78bfa;margin-bottom:8px">Adicionar intel: ${esc(interviewerName)}</div>
            <input id="itv_role" class="mock-input" placeholder="Cargo" style="margin-bottom:6px;font-size:0.8rem">
            <input id="itv_linkedin" class="mock-input" placeholder="LinkedIn URL" style="margin-bottom:6px;font-size:0.8rem">
            <textarea id="itv_bio" class="mock-input" rows="2" placeholder="Bio / resumo (opcional)" style="resize:vertical;font-size:0.8rem;margin-bottom:6px"></textarea>
            <input id="itv_topics" class="mock-input" placeholder="Tópicos de interesse (vírgulas)" style="margin-bottom:8px;font-size:0.8rem">
            <div style="display:flex;gap:6px;justify-content:flex-end">
                <button class="btn btn-sm" onclick="document.getElementById('addInterviewerForm').remove()">Cancelar</button>
                <button class="btn btn-cyan btn-sm" onclick="_saveInterviewerIntel('${esc(interviewerName)}','${appId}')"><i class="fa-solid fa-check"></i> Salvar</button>
            </div>`;
        sec.appendChild(div);
        div.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }

    async function _saveInterviewerIntel(name, appId) {
        const body = {
            name,
            role_title:   document.getElementById('itv_role')?.value.trim() || null,
            linkedin_url: document.getElementById('itv_linkedin')?.value.trim() || null,
            bio_summary:  document.getElementById('itv_bio')?.value.trim() || null,
            topics_of_interest: (document.getElementById('itv_topics')?.value || '').split(',').map(t => t.trim()).filter(Boolean),
        };
        try {
            await apiFetch('/api/admin/applications?__h=interviewer-intel', {
                method: 'POST', body: JSON.stringify(body)
            });
            showToast('Intel salvo.','success');
            document.getElementById('addInterviewerForm')?.remove();
            openBriefing(appId); // refresh
        } catch(e) { showToast(e.message,'error'); }
    }

    // ─── ADVANCE CONFIDENCE (N2) ──────────────────────────────
    async function showAdvanceConfidence(radarId, onContinue) {
        let data;
        try {
            data = await apiFetch(`/api/admin/applications?__h=advance-confidence&radar_id=${radarId}`);
        } catch { onContinue(); return; }

        const { fit_score, gaps, suspicious_flags, advance_confidence, total_concluded, empresa, vaga } = data;
        if (advance_confidence === null && !gaps?.length && !suspicious_flags?.length) { onContinue(); return; }

        const confColor = advance_confidence >= 50 ? '#4ade80' : advance_confidence >= 25 ? '#fb923c' : '#f87171';
        const confText  = advance_confidence !== null ? `${advance_confidence}%` : 'Sem dados históricos';

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px';
        overlay.innerHTML = `<div style="max-width:480px;width:100%;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;padding:20px">
            <h4 style="margin:0 0 12px;font-size:0.95rem;color:var(--text)"><i class="fa-solid fa-chart-line" style="color:var(--cyan);margin-right:6px"></i>Pré-análise da candidatura</h4>
            <div style="display:flex;gap:16px;margin-bottom:14px">
                <div style="text-align:center">
                    <div style="font-size:1.4rem;font-weight:700;color:${radar_score_color(fit_score||0)}">${fit_score||'—'}</div>
                    <div style="font-size:0.68rem;color:var(--text-dim)">Fit score</div>
                </div>
                <div style="text-align:center">
                    <div style="font-size:1.4rem;font-weight:700;color:${confColor}">${confText}</div>
                    <div style="font-size:0.68rem;color:var(--text-dim)">Estimativa de avançar</div>
                </div>
                ${total_concluded ? `<div style="text-align:center"><div style="font-size:1.4rem;font-weight:700;color:var(--text)">${total_concluded}</div><div style="font-size:0.68rem;color:var(--text-dim)">Candidaturas no histórico</div></div>` : ''}
            </div>
            ${gaps?.length ? `<div style="font-size:0.78rem;margin-bottom:8px"><span style="color:#fb923c;font-weight:600">Gaps detectados:</span> ${gaps.slice(0,5).map(g=>esc(g)).join(', ')}</div>` : ''}
            ${suspicious_flags?.length ? `<div style="font-size:0.78rem;margin-bottom:10px"><span style="color:#f87171;font-weight:600">Flags suspeitos:</span> ${suspicious_flags.slice(0,3).map(f=>esc(f.label||f)).join(' · ')}</div>` : ''}
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
                <button class="btn btn-sm" id="confCancel">Cancelar</button>
                <button class="btn btn-cyan btn-sm" id="confContinue"><i class="fa-solid fa-rocket"></i> Aplicar mesmo assim</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#confCancel').onclick  = () => { overlay.remove(); };
        overlay.querySelector('#confContinue').onclick = () => { overlay.remove(); onContinue(); };
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    function radar_score_color(s) { return s >= 7 ? '#4ade80' : s >= 5 ? '#fb923c' : '#f87171'; }

    // ─── INBOX (N7) ───────────────────────────────────────
    const _inboxPriorityColors = { critico:'#f87171', alto:'#fb923c', medio:'var(--cyan)', baixo:'var(--text-dim)' };
    const _inboxPriorityLabels = { critico:'Crítico', alto:'Alto', medio:'Médio', baixo:'Baixo' };
    const _inboxCategoryIcons  = {
        entrevista_hoje:'fa-calendar-check', resposta_atrasada:'fa-clock', email_novo:'fa-envelope',
        status_mudou:'fa-rotate', lead_alto:'fa-star', followup_due:'fa-bell', sugestao_pendente:'fa-lightbulb',
        lead_medio:'fa-star-half-stroke', lead_novo:'fa-circle-plus'
    };

    async function loadInbox(skipScan = false) {
        const feed = document.getElementById('inboxFeed');
        if (!feed) return;
        const filterVal = document.getElementById('inboxFilter')?.value || 'all';
        feed.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:32px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';

        // Dispara followup-scan em background ao abrir inbox (sem bloquear carregamento)
        if (!skipScan) {
            apiFetch('/api/admin/applications?__h=followup-scan', { method: 'POST' })
                .then(r => { if (r.created > 0) loadInbox(true); })
                .catch(() => {});
        }

        try {
            const r = await apiFetch('/api/admin/applications?__h=inbox');
            let items = r.items || [];
            if (filterVal !== 'all') items = items.filter(i => i.priority === filterVal);
            if (!items.length) {
                feed.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:48px"><i class="fa-solid fa-check-circle" style="color:var(--cyan);margin-right:6px"></i> Tudo em dia!</div>';
                return;
            }
            feed.innerHTML = items.map(item => _renderInboxItem(item)).join('');
        } catch(e) {
            feed.innerHTML = `<div style="color:#f87171;padding:16px">${esc(e.message)}</div>`;
        }
    }

    function _renderInboxItem(item) {
        const color = _inboxPriorityColors[item.priority] || 'var(--text-dim)';
        const label = _inboxPriorityLabels[item.priority] || item.priority;
        const icon  = _inboxCategoryIcons[item.category] || 'fa-circle-info';
        const actions = (item.actions || []).map(a => {
            if (a.type === 'open_application') return `<button class="btn btn-sm" onclick="openDrawer('${a.id}');dismissInboxItem('${item.id}')"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${esc(a.label||'Abrir')}</button>`;
            if (a.type === 'dismiss')         return `<button class="btn btn-sm" onclick="dismissInboxItem('${item.id}')"><i class="fa-solid fa-xmark"></i> ${esc(a.label||'Dispensar')}</button>`;
            if (a.type === 'snooze')          return `<button class="btn btn-sm" onclick="snoozeInboxItem('${item.id}')"><i class="fa-solid fa-clock"></i> +1d</button>`;
            return `<button class="btn btn-sm" onclick="dismissInboxItem('${item.id}')">${esc(a.label||'OK')}</button>`;
        }).join('');
        return `<div id="inbox-item-${item.id}" style="display:flex;gap:12px;padding:12px;margin-bottom:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft);align-items:flex-start">
            <div style="padding-top:2px"><i class="fa-solid ${icon}" style="color:${color};font-size:1rem"></i></div>
            <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                    <span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${color}">${label}</span>
                </div>
                <div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:2px">${esc(item.title||'')}</div>
                ${item.subtitle ? `<div style="font-size:0.78rem;color:var(--text-soft)">${esc(item.subtitle)}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">${actions}</div>
        </div>`;
    }

    function dismissInboxItem(id) {
        const el = document.getElementById(`inbox-item-${id}`);
        if (el) el.remove();
        const feed = document.getElementById('inboxFeed');
        if (feed && !feed.querySelector('[id^="inbox-item-"]')) {
            feed.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:48px"><i class="fa-solid fa-check-circle" style="color:var(--cyan);margin-right:6px"></i> Tudo em dia!</div>';
        }
    }

    function snoozeInboxItem(id) { dismissInboxItem(id); }

    // ─── REDE (N25) ───────────────────────────────────────
    let _allContacts = [];

    async function loadRede() {
        const list = document.getElementById('redeList');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:32px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        try {
            const r = await apiFetch('/api/admin/applications?__h=contacts');
            _allContacts = r.contacts || [];
            _renderContactsList(_allContacts);
        } catch(e) {
            list.innerHTML = `<div style="color:#f87171;padding:16px">${esc(e.message)}</div>`;
        }
    }

    function filterContacts(q) {
        const s = q.toLowerCase();
        const filtered = s ? _allContacts.filter(c =>
            (c.name||'').toLowerCase().includes(s) ||
            (c.empresa||'').toLowerCase().includes(s) ||
            (c.role||'').toLowerCase().includes(s)
        ) : _allContacts;
        _renderContactsList(filtered);
    }

    function _renderContactsList(contacts) {
        const list = document.getElementById('redeList');
        if (!list) return;
        if (!contacts.length) {
            list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:48px">Nenhum contato cadastrado.</div>';
            return;
        }
        const now = Date.now();
        list.innerHTML = contacts.map(c => {
            const nextTouch = c.next_touch_at ? new Date(c.next_touch_at) : null;
            const overdue   = nextTouch && nextTouch.getTime() < now;
            const str = c.relationship_strength || 3;
            const strengthDots = '●'.repeat(str) + '○'.repeat(5 - str);
            return `<div style="display:flex;align-items:center;gap:12px;padding:10px 12px;margin-bottom:6px;border:1px solid ${overdue?'rgba(251,146,60,0.4)':'var(--border)'};border-radius:8px;background:var(--bg-soft)">
                <div style="flex:1;min-width:0">
                    <div style="font-size:0.88rem;font-weight:600;color:var(--text)">${esc(c.name)}</div>
                    <div style="font-size:0.76rem;color:var(--text-soft)">${c.role?esc(c.role):''}${c.role&&c.empresa?' · ':''}${c.empresa?esc(c.empresa):''}</div>
                    <div style="font-size:0.7rem;color:${overdue?'#fb923c':'var(--text-dim)'};margin-top:2px">
                        ${overdue?'<i class="fa-solid fa-bell" style="margin-right:4px"></i>':''}
                        ${nextTouch ? `Próximo contato: ${nextTouch.toLocaleDateString('pt-BR')}` : (c.last_contact_at ? `Último: ${new Date(c.last_contact_at).toLocaleDateString('pt-BR')}` : 'Sem contato registrado')}
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:4px">
                    <span style="font-size:0.7rem;color:var(--cyan);letter-spacing:1px;font-family:monospace">${strengthDots}</span>
                </div>
                <div style="display:flex;gap:6px">
                    <button class="btn btn-sm" style="padding:4px 8px" onclick="openContactForm('${c.id}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-sm" style="padding:4px 8px" onclick="logInteractionModal('${c.id}','${esc(c.name)}')" title="Registrar interação"><i class="fa-solid fa-comment-dots"></i></button>
                    <button class="btn btn-sm" style="padding:4px 8px;color:var(--cyan)" onclick="gerarMensagemContato('${c.id}','${esc(c.name)}')" title="Gerar mensagem IA"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
                    <button class="btn btn-danger btn-sm" style="padding:4px 8px" onclick="deleteContact('${c.id}')" title="Remover"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div id="msg-${c.id}" style="display:none;padding:8px 12px 10px;border-top:1px solid var(--border)"></div>`;
        }).join('');
    }

    async function openContactForm(id) {
        const panel = document.getElementById('contactFormPanel');
        if (!panel) return;
        let c = id ? (_allContacts.find(x => x.id === id) || {}) : {};
        panel.innerHTML = `
            <h4 style="margin:0 0 12px;font-size:0.9rem">${id ? 'Editar contato' : 'Novo contato'}</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">Nome *</label><input id="ctName" class="mock-input" value="${esc(c.name||'')}" placeholder="Nome completo" maxlength="200"></div>
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">Cargo</label><input id="ctRole" class="mock-input" value="${esc(c.role||'')}" placeholder="Head of People" maxlength="200"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">Empresa</label><input id="ctEmpresa" class="mock-input" value="${esc(c.empresa||'')}" placeholder="Stone" maxlength="200"></div>
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">E-mail</label><input id="ctEmail" class="mock-input" type="email" value="${esc(c.email||'')}" placeholder="nome@empresa.com" maxlength="200"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">LinkedIn URL</label><input id="ctLinkedin" class="mock-input" value="${esc(c.linkedin_url||'')}" placeholder="https://linkedin.com/in/…" maxlength="400"></div>
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">Força do vínculo (1-5)</label>
                    <select id="ctStrength" class="mock-input" style="padding:5px 8px">
                        ${[1,2,3,4,5].map(n=>`<option value="${n}"${(c.relationship_strength||3)==n?' selected':''}>${n}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">Frequência de contato (meses)</label><input id="ctFreq" class="mock-input" type="number" min="1" max="36" value="${c.contact_frequency_months||6}"></div>
                <div class="form-group" style="margin:0"><label style="font-size:0.75rem">Fonte</label><input id="ctSource" class="mock-input" value="${esc(c.source||'manual')}" placeholder="manual / meetup / indicacao" maxlength="100"></div>
            </div>
            <div class="form-group" style="margin:0 0 12px"><label style="font-size:0.75rem">Notas</label><textarea id="ctNotes" class="mock-input" rows="2" maxlength="1000" style="resize:vertical;font-family:inherit;font-size:inherit">${esc(c.notes||'')}</textarea></div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="btn btn-sm" onclick="closeContactForm()">Cancelar</button>
                <button class="btn btn-cyan btn-sm" onclick="saveContact('${id||''}')"><i class="fa-solid fa-check"></i> Salvar</button>
            </div>`;
        panel.style.display = '';
        panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }

    function closeContactForm() {
        const panel = document.getElementById('contactFormPanel');
        if (panel) panel.style.display = 'none';
    }

    async function saveContact(id) {
        const body = {
            name:     document.getElementById('ctName')?.value.trim(),
            role:     document.getElementById('ctRole')?.value.trim()||null,
            empresa:  document.getElementById('ctEmpresa')?.value.trim()||null,
            email:    document.getElementById('ctEmail')?.value.trim()||null,
            linkedin_url: document.getElementById('ctLinkedin')?.value.trim()||null,
            relationship_strength: parseInt(document.getElementById('ctStrength')?.value)||3,
            contact_frequency_months: parseInt(document.getElementById('ctFreq')?.value)||6,
            source:   document.getElementById('ctSource')?.value.trim()||'manual',
            notes:    document.getElementById('ctNotes')?.value.trim()||null,
        };
        if (!body.name) { showToast('Nome é obrigatório','error'); return; }
        try {
            const url = id ? `/api/admin/applications?__h=contacts&id=${id}` : '/api/admin/applications?__h=contacts';
            const method = id ? 'PUT' : 'POST';
            await apiFetch(url, { method, body: JSON.stringify(body) });
            closeContactForm();
            showToast(id ? 'Contato atualizado' : 'Contato criado','success');
            loadRede();
        } catch(e) { showToast(e.message,'error'); }
    }

    async function deleteContact(id) {
        if (!confirm('Remover contato?')) return;
        try {
            await apiFetch(`/api/admin/applications?__h=contacts&id=${id}`, { method:'DELETE' });
            showToast('Contato removido','success');
            loadRede();
        } catch(e) { showToast(e.message,'error'); }
    }

    async function logInteractionModal(contactId, contactName) {
        const channel = await showPrompt(`Registrar interação com ${contactName}`, 'Canal: whatsapp / email / linkedin / in_person / call');
        if (!channel) return;
        const summary = await showPrompt('Resumo da conversa (opcional):', 'Ex: combinamos follow-up em 15 dias…') || null;
        try {
            await apiFetch('/api/admin/applications?__h=contact-interactions', {
                method:'POST',
                body: JSON.stringify({ contact_id: contactId, channel, direction:'outbound', summary })
            });
            showToast('Interação registrada','success');
            loadRede();
        } catch(e) { showToast(e.message,'error'); }
    }

    // ─── N26 — Gerar mensagem de relacionamento ───────────────────────────────
    async function gerarMensagemContato(contactId, contactName) {
        const reason = await showPrompt(`Motivo da mensagem para ${contactName}`, 'Ex: aniversário, promoção, touch regular…') || '';
        const msgEl = document.getElementById(`msg-${contactId}`);
        if (msgEl) { msgEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="color:var(--cyan)"></i>'; msgEl.style.display = ''; }
        try {
            const r = await apiFetch('/api/admin/applications?__h=contact-message', {
                method: 'POST',
                body: JSON.stringify({ contact_id: contactId, reason })
            });
            const msgs = r.messages || {};
            const opts = Object.entries(msgs).map(([k, v]) =>
                `<div style="margin-bottom:8px">
                    <div style="font-size:0.72rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">${k}</div>
                    <div style="font-size:0.82rem;color:var(--text);line-height:1.5;white-space:pre-wrap;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:8px">${esc(v)}</div>
                    <button class="btn btn-sm" style="margin-top:4px;padding:2px 8px;font-size:0.72rem" onclick="navigator.clipboard.writeText(${JSON.stringify(v)});showToast('Copiado!','success')"><i class="fa-solid fa-copy"></i> Copiar</button>
                </div>`
            ).join('');
            if (msgEl) { msgEl.innerHTML = opts; msgEl.style.display = ''; }
        } catch(e) {
            if (msgEl) { msgEl.innerHTML = `<div style="color:var(--danger);font-size:0.8rem">${esc(e.message)}</div>`; msgEl.style.display = ''; }
            else showToast(e.message,'error');
        }
    }

    // ─── VAULT (N4) ───────────────────────────────────────
    const _vaultTypeLabels = { rg:'RG', cpf:'CPF', comprov_endereco:'Comprov. Endereço', diploma:'Diploma', cert:'Certificado', cnh:'CNH', foto:'Foto', outro:'Outro' };

    function openVaultUpload() {
        const form = document.getElementById('vaultUploadForm');
        if (form) { form.style.display = ''; form.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
    }

    function closeVaultUpload() {
        const form = document.getElementById('vaultUploadForm');
        if (form) form.style.display = 'none';
    }

    async function uploadVaultDoc() {
        const fileInput = document.getElementById('vaultDocFile');
        const file = fileInput?.files?.[0];
        if (!file) { showToast('Selecione um arquivo','error'); return; }
        const docType  = document.getElementById('vaultDocType')?.value || 'outro';
        const docName  = document.getElementById('vaultDocName')?.value.trim() || file.name;
        const validade = document.getElementById('vaultDocValidade')?.value || null;
        const btn = document.getElementById('vaultUploadBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>'; }
        try {
            const arrayBuffer = await file.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            await apiFetch('/api/admin/applications?__h=vault-register', {
                method: 'POST',
                body: JSON.stringify({
                    doc_type: docType, display_name: docName,
                    filename: file.name, mime_type: file.type,
                    size_bytes: file.size, validade, base64_content: base64
                })
            });
            showToast('Documento adicionado ao Vault','success');
            closeVaultUpload();
            if (fileInput) fileInput.value = '';
            loadVault();
        } catch(e) {
            showToast(e.message,'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-upload"></i> Enviar'; }
        }
    }

    async function loadVault() {
        const el = document.getElementById('vaultDocsList');
        if (!el) return;
        try {
            const r = await apiFetch('/api/admin/applications?__h=vault-list');
            const docs = r.docs || [];
            if (!docs.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem">Nenhum documento no Vault.</div>'; return; }
            const now = Date.now();
            el.innerHTML = docs.map(d => {
                const val = d.validade ? new Date(d.validade) : null;
                const expiring = val && (val.getTime() - now) < 60*24*3600*1000;
                const expired  = val && val.getTime() < now;
                const typeLabel = _vaultTypeLabels[d.doc_type] || d.doc_type;
                const dateStr = val ? val.toLocaleDateString('pt-BR') : '';
                const sizeStr = d.size_bytes ? `${(d.size_bytes/1024).toFixed(0)} KB` : '';
                return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;border:1px solid ${expired?'rgba(248,113,113,0.4)':expiring?'rgba(251,146,60,0.4)':'var(--border)'};border-radius:6px;background:var(--bg-soft)">
                    <div style="font-size:0.9rem;color:var(--cyan);width:20px;text-align:center"><i class="fa-solid fa-file-shield"></i></div>
                    <div style="flex:1;min-width:0">
                        <div style="font-size:0.85rem;font-weight:600;color:var(--text)">${esc(d.display_name)}</div>
                        <div style="font-size:0.72rem;color:var(--text-dim)">${typeLabel}${sizeStr?' · '+sizeStr:''}</div>
                    </div>
                    ${val?`<div style="font-size:0.72rem;color:${expired?'#f87171':expiring?'#fb923c':'var(--text-dim)'}">
                        ${expired?'<i class="fa-solid fa-triangle-exclamation"></i> Vencido':expiring?`<i class="fa-solid fa-clock"></i> Vence ${dateStr}`:`Até ${dateStr}`}
                    </div>`:''}
                    <div style="display:flex;gap:6px">
                        <button class="btn btn-sm" style="padding:3px 8px;font-size:0.72rem" onclick="downloadVaultDoc('${d.id}','${esc(d.display_name)}')" title="Baixar"><i class="fa-solid fa-download"></i></button>
                        <button class="btn btn-danger btn-sm" style="padding:3px 8px;font-size:0.72rem" onclick="deleteVaultDoc('${d.id}')" title="Remover"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>`;
            }).join('');
        } catch(e) {
            el.innerHTML = `<div style="color:#f87171;font-size:0.82rem">${esc(e.message)}</div>`;
        }
    }

    async function downloadVaultDoc(id, name) {
        try {
            const r = await apiFetch(`/api/admin/applications?__h=vault-download-url&id=${id}`);
            if (r.url) {
                const a = document.createElement('a');
                a.href = r.url; a.download = name || 'documento';
                document.body.appendChild(a); a.click(); a.remove();
            }
        } catch(e) { showToast(e.message,'error'); }
    }

    async function deleteVaultDoc(id) {
        if (!confirm('Remover documento do Vault?')) return;
        try {
            await apiFetch(`/api/admin/applications?__h=vault-delete&id=${id}`, { method:'DELETE' });
            showToast('Documento removido','success');
            loadVault();
        } catch(e) { showToast(e.message,'error'); }
    }

    // ─── E-MAIL THREADS (N8) ──────────────────────────────
    async function openEmailThreads(appId) {
        const sec = document.getElementById('emailThreadsSection');
        if (!sec) return;
        if (!sec.hidden && sec.dataset.appId === appId) { sec.hidden = true; return; }
        sec.dataset.appId = appId;
        sec.hidden = false;
        sec.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:16px"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        try {
            const r = await apiFetch(`/api/admin/applications?__h=email-threads&application_id=${appId}`);
            const threads = r.threads || [];
            if (!threads.length) {
                sec.innerHTML = `<div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft)">
                    <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim);margin-bottom:8px">E-mails vinculados</div>
                    <div style="color:var(--text-dim);font-size:0.82rem">Nenhum e-mail vinculado.</div>
                    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
                        <button class="btn btn-sm" onclick="linkEmailThread('${appId}')"><i class="fa-solid fa-link"></i> Vincular thread Gmail</button>
                        <button class="btn btn-sm" style="color:var(--cyan)" onclick="generateAvailability()" title="Gerar 3 horários disponíveis para copiar"><i class="fa-solid fa-calendar-plus"></i> Disponibilidade</button>
                    </div>
                </div>`;
                return;
            }
            sec.innerHTML = `<div style="padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft)">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                    <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim)">E-mails vinculados</div>
                    <button class="btn btn-sm" style="font-size:0.72rem;padding:3px 8px" onclick="linkEmailThread('${appId}')"><i class="fa-solid fa-plus"></i> Vincular</button>
                </div>
                ${threads.map(t => `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
                    <div style="display:flex;align-items:center;gap:8px">
                        ${t.unread_count?`<span style="font-size:0.68rem;background:var(--cyan);color:#000;border-radius:10px;padding:1px 6px;font-weight:700">${t.unread_count}</span>`:''}
                        <div style="flex:1;min-width:0">
                            <div style="font-size:0.82rem;font-weight:${t.unread_count?'700':'400'};color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.subject_snippet||'(sem assunto)')}</div>
                            <div style="font-size:0.7rem;color:var(--text-dim)">${t.sender_name?esc(t.sender_name)+' · ':''}${t.email_count||0} e-mail(s)${t.last_email_at?' · '+new Date(t.last_email_at).toLocaleDateString('pt-BR'):''}</div>
                        </div>
                        <span style="font-size:0.68rem;color:var(--text-dim);text-transform:capitalize">${esc(t.status||'auto')}</span>
                    </div>
                </div>`).join('')}
                <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
                    <button class="btn btn-sm" style="font-size:0.72rem;padding:3px 8px" onclick="detectRejectionFromThread('${appId}')"><i class="fa-solid fa-magnifying-glass"></i> Detectar rejeição</button>
                    <button class="btn btn-sm" style="font-size:0.72rem;padding:3px 8px;color:var(--cyan)" onclick="generateAvailability()" title="Gerar texto com 3 horários disponíveis para entrevista"><i class="fa-solid fa-calendar-plus"></i> Disponibilidade</button>
                </div>
            </div>`;
        } catch(e) {
            sec.innerHTML = `<div style="color:#f87171;padding:8px;font-size:0.82rem">${esc(e.message)}</div>`;
        }
    }

    // ─── N12 — Sugerir disponibilidade ────────────────────────────────────────
    function generateAvailability() {
        const now = new Date();
        const slots = [];
        let d = new Date(now);
        d.setDate(d.getDate() + 1); // começa amanhã
        const timeOptions = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];
        const dayNames = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
        const monthNames = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        let attempts = 0;
        while (slots.length < 3 && attempts < 30) {
            attempts++;
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) { // não é fim de semana
                const time = timeOptions[slots.length * 2]; // espalha horários
                const dayStr = `${dayNames[dow]}, ${d.getDate().toString().padStart(2,'0')}/${monthNames[d.getMonth()]}`;
                slots.push({ label: `${dayStr} às ${time}`, iso: `${d.toISOString().slice(0,10)}T${time}:00` });
            }
            d.setDate(d.getDate() + 1);
        }
        if (!slots.length) { showToast('Não foi possível gerar slots.','error'); return; }
        const bullets = slots.map(s => `• ${s.label}`).join('\n');
        const text = `Tenho disponibilidade nos seguintes horários:\n${bullets}\nAlgum funciona para você?`;
        navigator.clipboard.writeText(text).then(() => showToast('Disponibilidade copiada!','success'))
            .catch(() => {
                prompt('Copie o texto abaixo:', text);
            });
        return text;
    }

    async function detectRejectionFromThread(appId) {
        const snippet = await showPrompt('Detectar rejeição', 'Cole o assunto ou trecho do e-mail aqui…');
        if (!snippet) return;
        try {
            const r = await apiFetch('/api/admin/applications?__h=email-detect-rejection', {
                method: 'POST',
                body: JSON.stringify({ application_id: appId, body_snippet: snippet })
            });
            if (r.detected) {
                showToast(r.created_followup ? 'Rejeição detectada — sugestão de agradecimento criada no Inbox.' : 'Rejeição detectada (já havia sugestão pendente).');
            } else {
                showToast('Nenhuma palavra de rejeição detectada.');
            }
        } catch(e) { showToast(e.message,'error'); }
    }

    async function linkEmailThread(appId) {
        const threadId = await showPrompt('Vincular thread do Gmail', 'Thread ID (ex: 18f2a3b4c5d6e7f8)…');
        if (!threadId) return;
        try {
            await apiFetch('/api/admin/applications?__h=email-threads', {
                method:'POST',
                body: JSON.stringify({ application_id: appId, thread_id: threadId, link_method:'manual', status:'confirmed', link_confidence:1 })
            });
            showToast('Thread vinculada','success');
            openEmailThreads(appId);
        } catch(e) { showToast(e.message,'error'); }
    }

    // ── VOICE COMMANDS (N37) ──────────────────────────────────
    let _voiceRecog = null;
    let _voiceActive = false;

    function toggleVoiceCommand() {
        if (!('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
            showToast('Seu navegador não suporta reconhecimento de voz.','error');
            return;
        }
        if (_voiceActive) {
            _voiceRecog?.stop();
            _stopVoice();
            return;
        }
        const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
        _voiceRecog = new Rec();
        _voiceRecog.lang = 'pt-BR';
        _voiceRecog.interimResults = true;
        _voiceRecog.maxAlternatives = 1;
        document.getElementById('voiceOverlay').style.display = 'block';
        document.getElementById('voiceBtnIcon').style.color = 'var(--cyan)';
        document.getElementById('voiceBtn').style.background = 'rgba(34,211,238,0.15)';
        document.getElementById('voiceTranscript').textContent = '';
        _voiceActive = true;

        _voiceRecog.onresult = (evt) => {
            const t = evt.results[evt.results.length-1][0].transcript;
            document.getElementById('voiceTranscript').textContent = t;
            if (evt.results[evt.results.length-1].isFinal) {
                _execVoiceCommand(t.toLowerCase().trim());
            }
        };
        _voiceRecog.onerror = _voiceRecog.onend = () => _stopVoice();
        _voiceRecog.start();
    }

    function _stopVoice() {
        _voiceActive = false;
        document.getElementById('voiceOverlay').style.display = 'none';
        document.getElementById('voiceBtnIcon').style.color = 'var(--text-dim)';
        document.getElementById('voiceBtn').style.background = 'var(--bg-soft)';
    }

    function _execVoiceCommand(cmd) {
        const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
        const c = norm(cmd);
        // Navegação entre abas
        const tabMap = { radar:'radar', inbox:'inbox', vagas:'vagas', curriculos:'cvs', curriculo:'cvs', rede:'rede', diario:'diario', tendencias:'tendencias', metricas:'metricas', configurar:'config', config:'config' };
        for (const [kw, tab] of Object.entries(tabMap)) {
            if (c.includes(norm('ir para ' + kw)) || c.includes(norm('abrir ' + kw)) || c === norm(kw)) {
                showToast('Abrindo ' + kw + '…');
                switchTab(tab);
                _stopVoice(); return;
            }
        }
        if (c.includes('nova candidatura') || c.includes('criar candidatura')) {
            switchTab('vagas');
            setTimeout(() => openNovaVaga?.(), 300);
            _stopVoice(); return;
        }
        if (c.includes('atualizar') || c.includes('recarregar')) {
            manualRefresh();
            showToast('Atualizando…');
            _stopVoice(); return;
        }
        if (c.includes('sair') || c.includes('logout')) {
            logout?.();
            _stopVoice(); return;
        }
        showToast('Comando não reconhecido: "' + cmd + '"');
        _stopVoice();
    }

    // Exibe botão de voz se API disponível
    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        const btn = document.getElementById('voiceBtn');
        if (btn) btn.style.display = 'flex';
    }

    // Expõe funções do IIFE ao escopo global (necessário para onclick e switchTab)
    Object.assign(window, {
        loadInbox, dismissInboxItem, snoozeInboxItem,
        loadRede, filterContacts, openContactForm, closeContactForm,
        saveContact, deleteContact, logInteractionModal, gerarMensagemContato,
        openBriefing, showAdvanceConfidence,
        openVaultUpload, closeVaultUpload, uploadVaultDoc,
        loadVault, downloadVaultDoc, deleteVaultDoc,
        openEmailThreads, linkEmailThread,
        generateAvailability, detectRejectionFromThread,
        toggleVoiceCommand,
    });

})();
