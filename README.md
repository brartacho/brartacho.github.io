# Portfólio ARTACHO.dev

Portfólio profissional de Bruno Artacho com foco em apresentação de atuação em QA, estudos de caso e projetos complementares.

## Visão geral

O projeto foi refinado para priorizar:

- hierarquia visual mais clara na home
- melhor ritmo entre títulos, textos, chips, cards e áreas de respiro
- consistência de UI entre a página principal e os estudos de caso
- leitura confortável em desktop, tablet e mobile
- conteúdo estático com manutenção simples e previsível

## Publicação

- URL principal: `https://bruno-artacho.vercel.app`
- domínio exibido no projeto: `ARTACHO.dev`
- imagem social configurada para compartilhamento: `imagens/capa-portfolio-whatsapp-hq.jpg`

## Páginas

- `index.html`
  Página principal com hero, resumo profissional, atuação, stack, projetos e contato.

- `estudo-caso-pagamentos.html`
  Caso focado em regra de negócio, regressão, reteste e impacto funcional.

- `cenario-tecnico-qa.html`
  Caso focado em validação técnica, APIs, logs, banco, mocks e consistência ponta a ponta.

## Tecnologias

- `HTML5`
- `CSS3`
- `JavaScript` vanilla
- `Font Awesome`
- `Devicon`

## Principais refinamentos aplicados

- correção de acentuação e normalização dos HTMLs em UTF-8
- hero com melhor hierarquia, contraste tipográfico e CTA mais claros
- barra de destaques reorganizada para desktop, tablet e mobile
- cards de stack com microespaçamento e alinhamento revisados
- seção de projetos reorganizada, incluindo o próprio portfólio como projeto autoral
- card do portfólio apontando para a URL publicada na Vercel
- estudo complementar `Padaria do Bairro` integrado à mesma linguagem visual da grade
- páginas de caso com melhor leitura entre métricas, grids, accordions e footer
- footers simplificados para uma solução mais minimalista e consistente
- metadata social atualizada com `canonical`, `Open Graph` e `Twitter Card`

## Histórico resumido

- `v1.2.0`
  Estabilização visual do projeto, limpeza de regressões nas páginas de caso, consolidação do CSS responsivo e centralização de tabs e accordions em `script.js`.

- `v1.1.0`
  Refinamento inicial de UI e ganho de consistência entre desktop, tablet e mobile.

- `v1.0.3`
  Ajustes de microcopy e UX.

- `v1.0.2`
  Otimização de preview social.

- `v1.0.0`
  Lançamento inicial do portfólio.

## Metadata social

A home está preparada para compartilhamento em redes sociais com:

- `canonical` apontando para `https://bruno-artacho.vercel.app`
- `og:url` e `twitter:url` apontando para o domínio publicado
- `og:image` e `twitter:image` usando `imagens/capa-portfolio-whatsapp-hq.jpg`
- título, descrição e `alt` da imagem ajustados para apresentação profissional do portfólio

## Estrutura

```text
portfolio/
├── imagens/
├── index.html
├── estudo-caso-pagamentos.html
├── cenario-tecnico-qa.html
├── style.css
├── script.js
├── README.md
└── README.txt
```

## Como abrir

1. Abra `index.html` no navegador para navegação local.
2. Acesse também os dois estudos de caso pela home.
3. Para prévia pública, use `https://bruno-artacho.vercel.app`.

## Observações

- O projeto é estático e não depende de backend.
- O JavaScript controla menu mobile, tabs e accordions.
- O conteúdo dos estudos de caso foi estruturado para leitura profissional, com informações reorganizadas e anonimizadas.
- Para a prévia social funcionar corretamente, `imagens/capa-portfolio-whatsapp-hq.jpg` precisa estar publicada nesse mesmo caminho no domínio final.
- O histórico antigo foi consolidado neste `README.md`; o `README.txt` pode permanecer apenas como referência local.
