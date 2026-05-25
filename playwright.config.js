import { defineConfig, devices } from '@playwright/test';

// BASE_URL=http://localhost:3000 npx playwright test  → testa localmente (vercel dev)
// sem BASE_URL                                        → testa produção (artacho.dev)
const BASE_URL = process.env.BASE_URL || 'https://artacho.dev';

// Specs que devem rodar em todos os projetos (incluindo mobile/tablet)
const ALL_PROJECTS_MATCH = ['**/responsive.spec.js', '**/admin-full.spec.js', '**/admin-responsive.spec.js'];

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 2,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test-results/report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'pt-BR',
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9' },
  },
  projects: [
    // Desktop — roda todos os specs
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },

    // Tablet — iPad Air (820×1180) — top tabs visíveis, layout intermediário
    {
      name: 'tablet',
      use: { ...devices['iPad (gen 7)'], viewport: { width: 820, height: 1180 } },
      testMatch: ALL_PROJECTS_MATCH,
    },

    // Mobile — iPhone 14 (390×844) — bottom nav, accordions colapsados
    {
      name: 'mobile',
      use: { ...devices['iPhone 14'] },
      testMatch: ALL_PROJECTS_MATCH,
    },
  ],
  outputDir: 'test-results/artifacts',
});
