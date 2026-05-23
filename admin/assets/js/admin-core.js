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
    try {
        const dl = await api('GET', `/api/admin/cv-storage-url?id=${id}&preview=1`);
        // Fetch como blob para ignorar Content-Disposition do Storage e forçar renderização inline
        const resp = await fetch(dl.signedUrl);
        if (!resp.ok) throw new Error(`Erro ao baixar PDF (${resp.status})`);
        const raw  = await resp.blob();
        const blob = raw.type === 'application/pdf' ? raw : new Blob([raw], { type: 'application/pdf' });
        frame.src = URL.createObjectURL(blob);
    } catch (e) {
        loading.textContent = 'Erro ao carregar PDF: ' + e.message;
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
}

function renderApplicationsTable() {
    const tbody = document.getElementById('vagasTableBody');
    const countEl = document.getElementById('vagasCount');

    const search = (document.getElementById('vagasSearch')?.value || '').toLowerCase();

    let filtered = _applications;
    if (_vagasFilter === 'arquivadas') {
        filtered = filtered.filter(app => app.archived);
    } else {
        filtered = filtered.filter(app => !app.archived);
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

    body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
            ${cvSection}
            ${recruiterSection}
            ${obsSection}
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
            <button class="btn btn-sm" onclick="openEditVaga('${app.id}')"><i class="fa-solid fa-pen"></i> Editar vaga</button>
            <button class="btn btn-sm" onclick="toggleStageManager('${app.id}')"><i class="fa-solid fa-gear"></i> Gerenciar etapas</button>
            <button class="btn btn-sm" style="padding:6px 10px;opacity:0.7" title="${app.archived ? 'Desarquivar candidatura' : 'Arquivar candidatura'}"
                onclick="toggleArchive('${app.id}', ${app.archived})"><i class="fa-solid fa-${app.archived ? 'box-open' : 'box-archive'}"></i></button>
            <button class="btn btn-danger btn-sm" style="padding:6px 10px" title="Deletar candidatura"
                onclick="deleteApplication('${app.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>

        <div id="stageManagerSection" hidden></div>
        <div id="editVagaSection" hidden></div>
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
    return `
        <div style="border-top:1px solid var(--border-soft);padding-top:12px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-dim)">${app ? 'Editar candidatura' : 'Nova candidatura'}</div>
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
                <textarea id="vfObs" class="mock-input" placeholder="headhunter, urgência…" maxlength="500" rows="3" autocomplete="off" data-form-type="other" style="resize:vertical;font-family:inherit;font-size:inherit">${esc(app?.observacoes || '')}</textarea>
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
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
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

function openNovaVaga() {
    const existing = document.getElementById('novaVagaForm');
    if (existing) { existing.remove(); return; }
    const wrap = document.createElement('div');
    wrap.id = 'novaVagaForm';
    wrap.innerHTML = vagaFormHTML(null);
    document.getElementById('vagasTableWrap').before(wrap);
    document.getElementById('vfEmpresa').focus();
    _populateCvSelect(null);
}
function closeNovaVaga() {
    document.getElementById('novaVagaForm')?.remove();
}
async function saveNovaVaga() {
    const msg = document.getElementById('vfMsg');
    const empresa = document.getElementById('vfEmpresa').value.trim();
    if (!empresa) { msg.textContent = 'Empresa é obrigatório.'; msg.hidden = false; return; }
    try {
        await api('POST', '/api/admin/applications', {
            empresa,
            vaga:             document.getElementById('vfVaga').value.trim() || null,
            linkedin_empresa: document.getElementById('vfLinkedin').value.trim() || null,
            link_vaga:        document.getElementById('vfLinkVaga').value.trim() || null,
            observacoes:      document.getElementById('vfObs').value.trim() || null,
            gestor_nome:      document.getElementById('vfGestorNome').value.trim() || null,
            gestor_email:     document.getElementById('vfGestorEmail').value.trim() || null,
            gestor_phone:     document.getElementById('vfGestorPhone').value.trim() || null,
            data_envio:       document.getElementById('vfDataEnvio').value || null,
            modalidade:       document.getElementById('vfModalidade').value || null,
            tipo_contratacao: document.getElementById('vfTipoContratacao').value || null,
            cv_version_id:    document.getElementById('vfCvVersion').value || null,
        });
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
    section.hidden = false;
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    _populateCvSelect(app);
}
function closeEditVaga() {
    document.getElementById('editVagaSection').hidden = true;
}
async function saveEditVaga(appId) {
    const msg = document.getElementById('vfMsg');
    const empresa = document.getElementById('vfEmpresa').value.trim();
    if (!empresa) { msg.textContent = 'Empresa é obrigatório.'; msg.hidden = false; return; }
    try {
        const updated = await api('PUT', `/api/admin/applications?id=${appId}`, {
            empresa,
            vaga:             document.getElementById('vfVaga').value.trim() || null,
            linkedin_empresa: document.getElementById('vfLinkedin').value.trim() || null,
            link_vaga:        document.getElementById('vfLinkVaga').value.trim() || null,
            observacoes:      document.getElementById('vfObs').value.trim() || null,
            gestor_nome:      document.getElementById('vfGestorNome').value.trim() || null,
            gestor_email:     document.getElementById('vfGestorEmail').value.trim() || null,
            gestor_phone:     document.getElementById('vfGestorPhone').value.trim() || null,
            data_envio:       document.getElementById('vfDataEnvio').value || null,
            modalidade:       document.getElementById('vfModalidade').value || null,
            tipo_contratacao: document.getElementById('vfTipoContratacao').value || null,
            cv_version_id:    document.getElementById('vfCvVersion').value || null,
        });
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
});

// ─── TABS ─────────────────────────────────────────────────
function switchTab(name) {
    // Fecha modais abertos: permite que bottom-nav funcione mesmo com modal visível
    ['sendCvModal','editCvModal','forgotModal','shareModal','confirmModal','promptModal','kpiDetailModal']
        .forEach(id => { const m = document.getElementById(id); if (m && !m.hidden) m.hidden = true; });
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    const vagasOverlay = document.getElementById('vagasOverlay');
    if (vagasOverlay) vagasOverlay.classList.remove('open');
    const logDrawerOverlay = document.getElementById('logDrawerOverlay');
    if (logDrawerOverlay) logDrawerOverlay.classList.remove('open');

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
    _scheduleRefresh();
}

// ─── LOAD ALL ─────────────────────────────────────────────
function loadAll() {
    // Carrega a aba inicial (CVs) + stats; pré-carrega demais abas em background.
    loadCVs();
    loadStorageStats();
    detectReplyContext();
    _lastRefreshAt = Date.now();
    _scheduleRefresh();
    setTimeout(() => {
        loadTokens().catch(() => {});
        loadApplications().catch(() => {});
    }, 500);
}

// ─── STORAGE STATS ────────────────────────────────────────
let _storageAlertShown = false;
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
    document.getElementById('vagasListView').style.display    = tab === 'lista'   ? '' : 'none';
    document.getElementById('vagasAnalysisView').style.display = tab === 'analise' ? '' : 'none';
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

function _parseUA(ua) {
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
            const ua         = _parseUA(s.user_agent);
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

// ─── DEMO SETTINGS ────────────────────────────────────────
const _DEMO_ALL_TABS = [
    { key: 'cvs',      label: 'Currículos', icon: 'fa-file-pdf'   },
    { key: 'tokens',   label: 'Tokens',     icon: 'fa-key'        },
    { key: 'vagas',    label: 'Vagas',      icon: 'fa-briefcase'  },
    { key: 'logs',     label: 'Logs',       icon: 'fa-chart-bar'  },
    { key: 'metricas', label: 'Métricas',   icon: 'fa-chart-line' },
];

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
    } catch (e) { /* perfil ainda não criado — segue */ }

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

function renderRadarSearches(profile) {
    const grid = document.getElementById('radarSearchGrid');
    if (!grid) return;
    const kw = (profile.keywords && profile.keywords[0]) || 'QA';
    const enc = encodeURIComponent;
    const jobs = (q, tpr) => `https://www.linkedin.com/jobs/search/?keywords=${enc(q)}&f_WT=2&f_TPR=${tpr}&sortBy=DD`;
    const content = q => `https://www.linkedin.com/search/results/content/?keywords=${enc(q)}`;
    const people = q => `https://www.linkedin.com/search/results/people/?keywords=${enc(q)}`;
    const links = [
        ['Últimas 24h (remoto)', jobs(kw, 'r86400'), 'fa-clock'],
        ['Últimos 7 dias (remoto)', jobs(kw, 'r604800'), 'fa-calendar-week'],
        ['Publicações: "contratando"', content(`"contratando" ${kw}`), 'fa-bullhorn'],
        ['Mercado oculto: "vaga"', content(`"vaga" ${kw}`), 'fa-eye'],
        ['Gestores (Tech Lead/Head)', people(`"Tech Lead" OR "Head" ${kw}`), 'fa-user-tie'],
        ['Boolean: QA + Playwright', jobs('("QA" OR "Analista de Testes") AND "Playwright"', 'r604800'), 'fa-code'],
        ['Boolean: QA + IA', jobs('"QA" AND ("IA" OR "Inteligência Artificial")', 'r604800'), 'fa-robot'],
    ];
    grid.innerHTML = links.map(([label, url, icon]) =>
        `<a class="radar-search-btn" href="${esc(url)}" target="_blank" rel="noopener"><i class="fa-solid ${icon}"></i> ${esc(label)}</a>`
    ).join('');
}

let _radarLeads = [];
let _radarMinScore = 0;
let _radarFonteFilter = 'all';
let _radarModFilter   = 'all';
let _radarSortKey     = 'score';
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
        const isSelected = _radarSelected.has(l.id);
        const cardAction = _radarSelecting ? `onclick="toggleRadarSelect('${l.id}')" style="cursor:pointer"` : '';
        return `<div class="radar-lead status-${esc(l.status)}" ${cardAction}>
            ${_radarSelecting ? `<input type="checkbox" class="radar-row-check" ${isSelected ? 'checked' : ''} onchange="toggleRadarSelect('${l.id}')" style="margin:8px;align-self:center" onclick="event.stopPropagation()">` : ''}
            <div class="radar-score badge-${b.cls}"><span class="rs-num">${b.num}</span>${b.tier ? `<span class="rs-tier">${b.tier}</span>` : ''}</div>
            <div class="radar-lead-body">
                <div class="radar-lead-head">
                    <strong>${esc(l.vaga || 'Vaga')}</strong> — ${esc(l.empresa)} ${link}
                    <span class="radar-status-tag s-${esc(l.status)}">${esc(l.status)}</span>
                </div>
                <div class="radar-chips">${chips}</div>
                ${kw ? `<div class="radar-chips">${kw}</div>` : ''}
                ${gaps ? `<div class="radar-chips"><span class="radar-chip-label">Gaps:</span>${gaps}</div>` : ''}
                ${pos}
                ${_radarSelecting ? '' : `<div class="radar-lead-actions">
                    <button class="btn btn-sm" onclick="analyzeRadar('${l.id}')"><i class="fa-solid fa-wand-magic-sparkles"></i> Analisar</button>
                    <button class="btn btn-sm" onclick="adaptarCvRadar('${l.id}')"><i class="fa-solid fa-wand-sparkles"></i> Adaptar CV</button>
                    ${!promoted && !discarded ? `<button class="btn btn-cyan btn-sm" onclick="promoteRadar('${l.id}')"><i class="fa-solid fa-arrow-right-to-bracket"></i> Promover</button>` : ''}
                    ${!discarded && !promoted ? `<button class="btn btn-sm" onclick="discardRadar('${l.id}')"><i class="fa-solid fa-ban"></i> Descartar</button>` : ''}
                    <button class="btn btn-sm" onclick="deleteRadar('${l.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                </div>`}
            </div>
        </div>`;
    }).join('');
}

// ── Filter / sort helpers ──
function setRadarMinScore(val) {
    _radarMinScore = Number(val) || 0;
    renderRadarList(_radarLeads);
}
function setRadarFonteFilter(val, btn) {
    _radarFonteFilter = val;
    document.querySelectorAll('.radar-fonte-chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderRadarList(_radarLeads);
}
function setRadarModFilter(val, btn) {
    _radarModFilter = val;
    document.querySelectorAll('.radar-mod-chip').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderRadarList(_radarLeads);
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
    if (!await showConfirm('Promover para candidatura?', 'Cria uma vaga na Gestão de Vagas com as etapas padrão.', { okText: 'Promover', danger: false })) return;
    try {
        await api('PUT', `/api/admin/radar?id=${id}&action=promote`);
        showToast('Promovido! Veja em Gestão de Vagas.', 'success', { label: 'Ir para Vagas', callback: () => switchTab('vagas') });
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
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
    if (!await showConfirm('Excluir lead?', 'Esta ação não pode ser desfeita.', { okText: 'Excluir' })) return;
    try {
        await api('DELETE', `/api/admin/radar?id=${id}`);
        showToast('Lead excluído.');
        loadRadar();
    } catch (e) { showToast(e.message, 'error'); }
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
    set('rpCore', _arrToLines(p.skills_core));
    set('rpEvolucao', _arrToLines(p.skills_evolucao));
    set('rpGaps', _arrToLines(p.gaps));
    set('rpSetores', _arrToLines(p.setores));
    set('rpKeywords', _arrToLines(p.keywords));
    // Contratação prefs (array)
    const prefs = Array.isArray(p.contratacao_prefs) ? p.contratacao_prefs :
        (p.contratacao_pref ? [p.contratacao_pref] : []);
    ['CLT','PJ','Freelancer','Cooperado','Temporário','Estágio','Autônomo'].forEach(tipo => {
        const el = document.getElementById(`rpContr${tipo.replace(/[^a-zA-Z]/g,'')}`);
        if (el) el.checked = prefs.includes(tipo);
    });
    // CNH
    const cnh = p.cnh || { has: false, categories: [] };
    const cnhHasEl = document.getElementById('rpCnhHas');
    if (cnhHasEl) cnhHasEl.checked = !!cnh.has;
    ['A','B','C','D','E'].forEach(cat => {
        const el = document.getElementById(`rpCnhCat${cat}`);
        if (el) el.checked = (cnh.categories || []).includes(cat);
    });
    // Platforms (rendered dynamically)
    const platforms = Array.isArray(p.search_platforms) ? p.search_platforms : [];
    const cont = document.getElementById('rpPlatformsContainer');
    if (cont) {
        if (platforms.length) {
            cont.innerHTML = platforms.map(plat =>
                `<label class="radar-check-label"><input type="checkbox" id="rpPlat${esc(plat.id)}" ${plat.enabled ? 'checked' : ''}> ${esc(plat.label || plat.id)}</label>`
            ).join('');
        } else {
            cont.innerHTML = '<span style="font-size:0.75rem;color:var(--text-dim)">Nenhuma plataforma configurada no perfil.</span>';
        }
    }
}
async function saveRadarProfile(btn) {
    const val = id => (document.getElementById(id) || {}).value || '';
    const cnhHas = document.getElementById('rpCnhHas')?.checked || false;
    const cnhCategories = ['A','B','C','D','E'].filter(cat => document.getElementById(`rpCnhCat${cat}`)?.checked);
    const contratacaoPrefs = ['CLT','PJ','Freelancer','Cooperado','Temporário','Estágio','Autônomo']
        .filter(tipo => document.getElementById(`rpContr${tipo.replace(/[^a-zA-Z]/g,'')}`)?.checked);
    const updatedPlatforms = (_radarProfile.search_platforms || []).map(plat => ({
        ...plat,
        enabled: document.getElementById(`rpPlat${plat.id}`)?.checked ?? plat.enabled,
    }));
    const payload = {
        nivel_alvo: val('rpNivel').trim(),
        modalidade_pref: val('rpModalidade').trim(),
        localizacao: val('rpLocalizacao').trim(),
        skills_core: _linesToArr(val('rpCore')),
        skills_evolucao: _linesToArr(val('rpEvolucao')),
        gaps: _linesToArr(val('rpGaps')),
        setores: _linesToArr(val('rpSetores')),
        keywords: _linesToArr(val('rpKeywords')),
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
        showToast('Perfil salvo.');
    } catch (e) { showToast(e.message, 'error'); }
}
