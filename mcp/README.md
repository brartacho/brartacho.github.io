# Radar de Vagas — Servidor MCP

Servidor MCP local que conecta o **Claude Code** ao Radar de Vagas, eliminando o
copia-e-cola da análise. Fala direto com o Supabase (service key) e roda na sua
máquina — não consome o runtime do Vercel.

## Instalação

```bash
npm install   # instala @modelcontextprotocol/sdk e zod (devDependencies)
```

## Registro no Claude Code

Adicione ao `.mcp.json` do projeto (ou ao config global do Claude Code):

```json
{
  "mcpServers": {
    "radar-vagas": {
      "command": "node",
      "args": ["mcp/radar-server.js"],
      "env": {
        "SUPABASE_URL": "https://SEU-PROJ.supabase.co",
        "SUPABASE_SERVICE_KEY": "SUA_SERVICE_KEY"
      }
    }
  }
}
```

> A service key é sensível — mantenha o `.mcp.json` fora do versionamento ou use
> variáveis de ambiente do sistema.

## Uso

No Claude Code, peça por exemplo:

> "Analise os leads novos do Radar."

O Claude usa as ferramentas expostas:

| Ferramenta | O que faz |
|---|---|
| `list_leads` | Lista leads (novo/avaliada, ou todos) |
| `get_lead` | Detalhe completo de um lead (com descrição) |
| `get_profile` | Perfil do candidato usado na pontuação |
| `get_analysis_prompt` | Monta o prompt de análise de um lead |
| `save_analysis` | Grava fit_score/keywords/gaps/positioning (status → avaliada) |
| `score_preview` | Calcula o score por regras de um texto, sem salvar |

Fluxo típico: `list_leads` → `get_lead` → análise → `save_analysis`. O resultado
aparece no admin (aba **Radar**) automaticamente.
