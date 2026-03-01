========================================================================
👨‍💻 PROJETO: PORTFOLIO ARTACHO.DEV (v1.1.0)
========================================================================

1. 📝 DESCRIÇÃO E EVOLUÇÃO
------------------------------------------------------------------------
Portfólio profissional e cartão de visitas digital de Bruno Artacho. 
A versão 1.1.0 foca em refinamento visual (UI) e consistência de comportamento
entre dispositivos (Mobile vs Desktop), adotando ícones oficiais de mercado
e isolamento de eventos de ponteiro.

LINK OFICIAL: https://brartacho.github.io/

🚧 STATUS DO PROJETO: v1.1.0 - ESTÁVEL (Release Candidate)
- HTML5 (Semântica, SEO & Meta Tags): ✅ Concluído
- CSS3 (Mobile First, Hover Safety): ✅ Refatorado
- JavaScript (UI Control & UX): ✅ Concluído
- Assets (Devicon Integration): ✅ Implementado

2. 🛠️ TECNOLOGIAS E TÉCNICAS APLICADAS
------------------------------------------------------------------------
🔸 HTML5 & Meta Tags: Otimização severa de SEO, Open Graph e Twitter Cards.
🔸 CSS3 Moderno: Scroll nativo e Media Queries de interação (pointer: fine).
🔸 Devicon & FontAwesome: Combinação híbrida para ícones de UI e Logos Oficiais.
🔸 JS Vanilla: Controle de estado da UI e prevenção de FOUC na imagem.
🔸 Acessibilidade (A11y): Legendas dinâmicas via CSS attr() no mobile.
🔸 Zero-API: Dados estáticos no HTML garantindo 100% de uptime.

3. 📂 ORGANIZAÇÃO DE PASTAS E ARQUIVOS
------------------------------------------------------------------------
brartacho.github.io/ (Raiz do Projeto)
│
├── imagens/            # Assets visuais otimizados
│   ├── cuidado_pets.png
│   ├── padaria_do_bairro.png
│   └── og-image.png    # Thumbnail para redes sociais e WhatsApp
│
├── index.html          # Estrutura principal com integração Devicon CDN
├── script.js           # Motor de Interação (Menu, Loaders, Typewriter)
├── style.css           # Design System com isolamento de Hover Desktop
└── README.txt          # Documentação Técnica (Esta versão)

4. 🏗️ REFINAMENTOS DE QA & UX
------------------------------------------------------------------------
- MOBILE HOVER FIX: Implementação de @media (hover: hover) para evitar
  o efeito de "botão travado" (sticky hover) em dispositivos touch.
- UI CONSISTENCY: Migração para biblioteca Devicon, garantindo fidelidade
  visual aos logos das tecnologias (DBeaver, Java, PostgreSQL, etc).
- ARQUITETURA DE INFORMAÇÃO: Reagrupamento de skills (Figma em Front-end)
  para melhor leitura lógica do perfil Fullstack/QA.
- MICROCOPY: Descrições de projetos ajustadas para foco em fundamentos técnicos.

5. 📜 LOG DE VERSÕES (CHANGELOG)
------------------------------------------------------------------------
- v1.1.0: Refatoração de UI e CSS Architecture.
          * Integração da biblioteca Devicon para stack tecnológica.
          * CSS: Separação total de regras de :hover (Desktop) e :active (Mobile).
          * UX: Correção do bug de "Sticky Hover" em botões e cards no mobile.
          * Content: Inclusão do DBeaver e reclassificação do Figma.
          * Refinamento de descrições dos projetos (Pet e Padaria).
          
- v1.0.3: Ajuste de Microcopy e UX.
          * Redução da descrição para evitar truncamento em dispositivos móveis.
          * Otimização de palavras-chave para SEO.
          
- v1.0.2: Otimização de preview social (WhatsApp/LinkedIn).
          * Ajuste de proporção da imagem para 1200x630 (aspect ratio 1.91:1).
          * Correção de metadados Open Graph.

- v1.0.0: Lançamento oficial.

6. 🔮 PRÓXIMOS PASSOS (ROADMAP v2.0)
------------------------------------------------------------------------
1. Implementar testes automatizados de interface (Playwright/Cypress).
2. Configurar pipeline de CI/CD para deploy automático via GitHub Actions.
3. Auditoria contínua via Lighthouse (foco em nota 100/100).

7. 🚀 COMO EXECUTAR O PROJETO
------------------------------------------------------------------------
1. Navegue até a pasta raiz do projeto.
2. Abra o arquivo 'index.html' no seu navegador.
3. Utilize o DevTools (F12) para simular o Mobile e inspecionar o código.

========================================================================
👤 AUTOR: Bruno Artacho | QA Analyst & Software Developer
========================================================================