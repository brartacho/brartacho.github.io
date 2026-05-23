# Setup do MCP daemon — pm2 + startup automático no Windows
# Uso: npm run mcp:setup (executar PowerShell como Administrador)

$ErrorActionPreference = 'Stop'

# --- 1. Checa se está rodando como Administrador ---
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host ""
    Write-Warning "Este script precisa ser executado como Administrador para configurar o startup automatico."
    Write-Host ""
    Write-Host "Como fazer:"
    Write-Host "  1. Feche este terminal"
    Write-Host "  2. Clique com botao direito no PowerShell -> 'Executar como Administrador'"
    Write-Host "  3. cd para o diretorio do projeto"
    Write-Host "  4. Rode novamente: npm run mcp:setup"
    Write-Host ""
    exit 1
}

Write-Host "[setup] Executando como Administrador. OK." -ForegroundColor Green

# --- 2. Cria diretorio de logs ---
if (-not (Test-Path logs)) {
    New-Item -ItemType Directory -Path logs | Out-Null
    Write-Host "[setup] Diretorio logs/ criado."
}

# --- 3. Instala pm2 globalmente se nao existir ---
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "[setup] pm2 nao encontrado. Instalando globalmente..."
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Falha ao instalar pm2. Verifique sua instalacao do Node/npm."
        exit 1
    }
}
Write-Host "[setup] pm2 disponivel."

# --- 4. Carrega .env no ambiente do processo atual ---
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^([^#=\s][^=]*)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
    Write-Host "[setup] Variaveis do .env carregadas no ambiente."
} else {
    Write-Warning "[setup] .env nao encontrado. SUPABASE_URL e SUPABASE_SERVICE_KEY precisam estar no ambiente do sistema."
}

# --- 5. Para instancia anterior do radar-mcp (se existir) ---
try { pm2 delete radar-mcp 2>&1 | Out-Null } catch { <# ignorar — processo pode nao existir ainda #> }

# --- 6. Inicia processo ---
Write-Host "[setup] Iniciando radar-mcp..."
pm2 start ecosystem.config.cjs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Falha ao iniciar radar-mcp via pm2."
    exit 1
}

# --- 7. Persiste lista de processos (salva env vars no dump) ---
pm2 save

# --- 8. Configura startup automatico no Windows (Task Scheduler) ---
Write-Host "[setup] Configurando startup automatico do Windows..."
pm2 startup windows --service-name "RadarMCP" 2>&1 | Write-Host

# --- 9. Resumo final ---
Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " OK. radar-mcp configurado." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Comandos uteis:"
Write-Host "  npm run mcp:status   # ver status (pm2 status)"
Write-Host "  npm run mcp:logs     # ver logs em tempo real"
Write-Host "  npm run mcp:restart  # reiniciar processo"
Write-Host "  npm run mcp:stop     # parar processo"
Write-Host ""
Write-Host "O servidor iniciara automaticamente quando voce fizer login no Windows."
Write-Host ""
