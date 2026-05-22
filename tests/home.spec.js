import { test, expect } from '@playwright/test';

test.describe('HOME — nav', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  });

  test('logo visível e aponta para #home', async ({ page }) => {
    const logo = page.locator('nav .logo');
    await expect(logo).toContainText('ARTACHO');
    await expect(logo).toHaveAttribute('href', '#home');
  });

  test('todos os links do nav presentes', async ({ page }) => {
    const links = page.locator('.nav-links');
    await expect(links.locator('a[href="#home"]')).toBeVisible();
    await expect(links.locator('a[href="#sobre"]')).toBeVisible();
    await expect(links.locator('a[href="#skills"]')).toBeVisible();
    await expect(links.locator('a[href="#formacao"]')).toBeVisible();
    await expect(links.locator('a[href="#projetos"]')).toBeVisible();
    await expect(links.locator('a[href="#contato"]')).toBeVisible();
    await expect(links.locator('a[href="/cv"]')).toBeVisible();
    await expect(links.locator('a[href="https://github.com/brartacho"]')).toBeVisible();
  });
});

test.describe('HOME — hero', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  });

  test('dot "disponível" animado visível', async ({ page }) => {
    await expect(page.locator('.hero-available-dot')).toBeVisible();
    await expect(page.locator('.hero-eyebrow')).toContainText('Disponível para oportunidades');
  });

  test('headline com nome completo', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Bruno');
    await expect(page.locator('h1 em')).toContainText('Artacho');
  });

  test('role contém Playwright e HealthTech', async ({ page }) => {
    await expect(page.locator('.hero-role')).toContainText('Playwright');
    await expect(page.locator('.hero-role')).toContainText('HealthTech');
  });

  test('corpo do hero menciona Playwright e Postman', async ({ page }) => {
    await expect(page.locator('.hero-body')).toContainText('Playwright');
    await expect(page.locator('.hero-body')).toContainText('Postman');
  });

  test('foto de perfil carrega', async ({ page }) => {
    const photo = page.locator('.hero-photo');
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute('src', /github\.com\/brartacho/);
  });

  test('stat card "6+ anos em HealthTech" visível', async ({ page }) => {
    await expect(page.locator('.hero-stat-years')).toContainText('6+');
    await expect(page.locator('.hero-stat-years')).toContainText('HealthTech');
  });

  test('stat card "Playwright E2E" visível', async ({ page }) => {
    await expect(page.locator('.hero-stat-tool')).toContainText('Playwright E2E');
  });

  test('botões CTA "Ver projetos" e "Entrar em contato"', async ({ page }) => {
    await expect(page.locator('.btn-primary')).toContainText('Ver projetos');
    await expect(page.locator('.btn-ghost')).toContainText('Entrar em contato');
  });
});

test.describe('HOME — sobre', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('#sobre')?.scrollIntoView());
  });

  test('blockquote de impacto visível', async ({ page }) => {
    await expect(page.locator('#sobre blockquote')).toContainText('3 meses para 1 mês');
  });

  test('texto principal menciona LIS, Playwright e Biomedicina', async ({ page }) => {
    const body = page.locator('.about-body');
    await expect(body).toContainText('LIS');
    await expect(body).toContainText('Playwright');
    await expect(body).toContainText('Biomedicina');
  });

  test('cards aside visíveis', async ({ page }) => {
    await expect(page.locator('.about-card')).toHaveCount(2);
    await expect(page.locator('.about-card').first()).toContainText('Em evolução');
    await expect(page.locator('.about-card--highlight')).toContainText('Diferencial');
  });
});

test.describe('HOME — skills', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('#skills')?.scrollIntoView());
  });

  test('ticker visível e contém ferramentas-chave', async ({ page }) => {
    const ticker = page.locator('.skills-ticker');
    await expect(ticker).toBeVisible();
    await expect(ticker).toContainText('Playwright');
    await expect(ticker).toContainText('Postman');
    await expect(ticker).toContainText('Cursor + MCP');
  });

  test('4 cards no bento grid', async ({ page }) => {
    await expect(page.locator('.skill-card')).toHaveCount(4);
  });

  test('card QA & Processos com skills corretas', async ({ page }) => {
    const card = page.locator('.skill-wide');
    await expect(card).toContainText('QA & Processos');
    await expect(card).toContainText('Testes funcionais');
    await expect(card).toContainText('Homologação');
  });

  test('card Automação destacado com Playwright, PyAutoGUI, Cursor+MCP', async ({ page }) => {
    const card = page.locator('.skill-featured');
    await expect(card).toContainText('Automação');
    await expect(card).toContainText('Playwright E2E');
    await expect(card).toContainText('PyAutoGUI');
    await expect(card).toContainText('Cursor + MCP');
    await expect(card.locator('.skill-evo-tag')).toContainText('Em evolução');
  });

  test('card APIs com Postman, Insomnia, Thunder Client', async ({ page }) => {
    const card = page.locator('.skill-tools');
    await expect(card).toContainText('Postman');
    await expect(card).toContainText('Insomnia');
    await expect(card).toContainText('Thunder Client');
    await expect(card).toContainText('SoapUI');
  });

  test('card impacto com métrica real', async ({ page }) => {
    const card = page.locator('.skill-impact');
    await expect(card).toContainText('3 meses para 1 mês');
    await expect(card).toContainText('HealthTech');
  });
});

test.describe('HOME — formação', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('#formacao')?.scrollIntoView());
  });

  test('seção formação presente no nav e na página', async ({ page }) => {
    await expect(page.locator('#formacao')).toBeVisible();
    await expect(page.locator('#formacao h2')).toContainText('Formação');
  });

  test('9 entradas no timeline', async ({ page }) => {
    await expect(page.locator('.edu-entry')).toHaveCount(9);
  });

  test('ADS UniCV cursando', async ({ page }) => {
    await expect(page.locator('.edu-active')).toContainText('Cursando');
    await expect(page.locator('#formacao')).toContainText('Análise e Desenvolvimento de Sistemas');
    await expect(page.locator('#formacao')).toContainText('UniCV');
  });

  test('+praTI em andamento', async ({ page }) => {
    await expect(page.locator('.edu-inprogress').first()).toContainText('Em andamento');
    await expect(page.locator('#formacao')).toContainText('+praTI');
  });

  test('Biomedicina concluída', async ({ page }) => {
    await expect(page.locator('#formacao')).toContainText('Biomedicina');
    await expect(page.locator('#formacao')).toContainText('UniCesumar');
  });

  test('certificações Instituto Eldorado presentes', async ({ page }) => {
    await expect(page.locator('#formacao')).toContainText('Instituto Eldorado');
  });
});

test.describe('HOME — projetos', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('#projetos')?.scrollIntoView());
  });

  test('6 project cards no bento', async ({ page }) => {
    await expect(page.locator('.project-card')).toHaveCount(6);
  });

  test('card primário: Pagamentos', async ({ page }) => {
    const card = page.locator('.project-primary');
    await expect(card).toContainText('Pagamentos');
    await expect(card).toContainText('Postman');
  });

  test('card secundário: APIs e integrações', async ({ page }) => {
    await expect(page.locator('.project-secondary')).toContainText('APIs');
  });

  test('card portfólio aponta para case do front-end', async ({ page }) => {
    const link = page.locator('.project-code .project-overlay-link');
    await expect(link).toHaveAttribute('href', /projeto-portfolio\.html/);
  });

  test('card gestão de vagas aponta para demo do admin', async ({ page }) => {
    const link = page.locator('.project-system .project-overlay-link');
    await expect(link).toHaveAttribute('href', /projeto-sistema-admin\.html/);
  });

  test('card Padaria do Bairro tem link do GitHub', async ({ page }) => {
    const repoLink = page.locator('.project-image .project-repo-link');
    await expect(repoLink).toHaveAttribute('href', /github\.com\/brartacho\/Padaria/);
  });

  test('card WIP mostra porcentagem', async ({ page }) => {
    await expect(page.locator('.project-wip')).toContainText('35%');
    await expect(page.locator('.project-wip-bar')).toBeVisible();
  });
});

test.describe('HOME — contato', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('#contato')?.scrollIntoView());
  });

  test('CTA LinkedIn presente', async ({ page }) => {
    const cta = page.locator('.contact-primary-cta');
    await expect(cta).toContainText('LinkedIn');
    await expect(cta).toHaveAttribute('href', /linkedin\.com\/in\/bruno-artacho/);
  });

  test('email de contato é bruno@artacho.dev', async ({ page }) => {
    const emailLink = page.locator('a[href="mailto:bruno@artacho.dev"]');
    await expect(emailLink).toBeVisible();
    await expect(emailLink).toContainText('bruno@artacho.dev');
  });

  test('contato tem 3 secondary links (email, GitHub, CV)', async ({ page }) => {
    const links = page.locator('.contact-secondary .contact-link');
    await expect(links).toHaveCount(3);
  });

  test('GitHub link no contato', async ({ page }) => {
    const gh = page.locator('#contato a[href*="github.com/brartacho"]');
    await expect(gh).toBeVisible();
  });

  test('link do currículo no contato', async ({ page }) => {
    const cv = page.locator('#contato a[href="/cv"]');
    await expect(cv).toBeVisible();
  });
});

test.describe('HOME — footer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.querySelector('footer')?.scrollIntoView());
  });

  test('brand ARTACHO.dev no footer', async ({ page }) => {
    await expect(page.locator('.footer-brand')).toContainText('ARTACHO');
  });

  test('copyright 2026', async ({ page }) => {
    await expect(page.locator('footer')).toContainText('2026');
  });

  test('link de admin no footer', async ({ page }) => {
    await expect(page.locator('a[href="/admin"]')).toBeVisible();
  });

  test('link "voltar ao topo" no footer', async ({ page }) => {
    await expect(page.locator('.footer-top-link')).toBeVisible();
  });
});
