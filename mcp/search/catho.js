// Scraper do Catho (catho.com.br) via Playwright + stealth.
// URL: https://www.catho.com.br/vagas/KEYWORD/
// Segundo maior board de vagas do Brasil. Cloudflare + anti-bot.
// Tenta primeiro RSS (/vagas/KEYWORD/rss/) — se indisponível, usa Playwright.

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { normalize } from './normalizer.js';

chromium.use(StealthPlugin());

const BASE_URL = 'https://www.catho.com.br';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Tenta RSS feed do Catho (nem sempre disponível, mas sem anti-bot quando existe)
async function tryRssFeed(keyword) {
    const slug = encodeURIComponent(keyword.toLowerCase().replace(/\s+/g, '-'));
    const urls = [
        `${BASE_URL}/vagas/${slug}/rss/`,
        `https://www.catho.com.br/vagas/${slug}/feed/`,
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': UA, 'accept': 'application/rss+xml, application/xml, text/xml' },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) continue;
            const xml = await res.text();
            if (!xml.includes('<item>')) continue;

            const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
            return items.map(item => {
                const tag  = (t) => item.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`, 'i'))?.[1]
                                        ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() ?? null;
                return { link: tag('link'), title: tag('title'), company: null, location: tag('description') };
            }).filter(j => j.link && j.title);
        } catch { /* ignora */ }
    }
    return null;
}

async function extractJobsFromPage(page) {
    return page.evaluate(() => {
        const selectors = [
            '[class*="job-card"], [class*="JobCard"]',
            '[class*="vaga-card"], [class*="VagaCard"]',
            'article[class*="job"], article[class*="vaga"]',
            'li[class*="job"], li[class*="vaga"]',
            '[data-testid*="job"], [data-testid*="vaga"]',
        ];

        for (const sel of selectors) {
            const items = [...document.querySelectorAll(sel)].filter(el => el.querySelector('a'));
            if (!items.length) continue;

            return items.slice(0, 40).map(el => {
                const linkEl  = el.querySelector('a[href*="/vagas/"], a[href*="/emprego/"], a[href]');
                const titleEl = el.querySelector('h2, h3, h4, [class*="title"], [class*="cargo"]');
                const compEl  = el.querySelector('[class*="empresa"], [class*="company"], [class*="Company"]');
                const locEl   = el.querySelector('[class*="local"], [class*="location"], [class*="cidade"]');
                const link    = linkEl?.href || null;
                return {
                    link,
                    title:    titleEl?.textContent?.trim() || linkEl?.textContent?.trim() || null,
                    company:  compEl?.textContent?.trim() || null,
                    location: locEl?.textContent?.trim() || null,
                };
            }).filter(j => j.link && j.title);
        }

        return [...document.querySelectorAll('a[href*="/vagas/"]')]
            .filter(a => a.href && a.pathname !== '/vagas/')
            .slice(0, 40)
            .map(a => ({ link: a.href, title: a.textContent?.trim() || null, company: null, location: null }))
            .filter(j => j.link && j.title);
    });
}

export async function searchCatho({ keywords, maxResults = 20 }) {
    const seen    = new Set();
    const results = [];
    let browser;

    try {
        browser = await chromium.launch({
            channel: 'chrome',
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        const ctx = await browser.newContext({
            viewport:  { width: 1280, height: 800 },
            locale:    'pt-BR',
            userAgent: UA,
        });
        const page = await ctx.newPage();
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4}', r => r.abort());

        for (const keyword of keywords) {
            if (results.length >= maxResults) break;
            console.error(`[catho] Buscando: "${keyword}"`);

            // Tentativa 1: RSS (rápido, sem anti-bot)
            const rssJobs = await tryRssFeed(keyword);
            if (rssJobs && rssJobs.length) {
                console.error(`[catho] RSS para "${keyword}": ${rssJobs.length} itens`);
                for (const job of rssJobs) {
                    if (results.length >= maxResults) break;
                    if (!job.link || seen.has(job.link)) continue;
                    seen.add(job.link);
                    results.push(normalize({
                        empresa:   job.company || 'Empresa não informada',
                        vaga:      job.title,
                        link_vaga: job.link,
                        localizacao: 'Brasil',
                    }, 'catho'));
                }
                continue;
            }

            // Tentativa 2: Playwright
            const slug = keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
            const url  = `${BASE_URL}/vagas/${encodeURIComponent(slug)}/`;

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                await page.waitForFunction(
                    () => !/um momento|just a moment|attention required/i.test(document.title),
                    { timeout: 15_000 }
                ).catch(() => {});
                await new Promise(r => setTimeout(r, 2500));
            } catch (e) {
                console.error(`[catho] Erro ao carregar "${keyword}": ${e.message}`);
                continue;
            }

            const jobs = await extractJobsFromPage(page);
            console.error(`[catho] Jobs via Playwright para "${keyword}": ${jobs.length}`);

            for (const job of jobs) {
                if (results.length >= maxResults) break;
                if (!job.link || seen.has(job.link)) continue;
                seen.add(job.link);
                results.push(normalize({
                    empresa:    job.company || 'Empresa não informada',
                    vaga:       job.title,
                    link_vaga:  job.link,
                    localizacao: job.location || 'Brasil',
                }, 'catho'));
            }
            await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
        }

        await page.close();
    } catch (e) {
        console.error(`[catho] Erro fatal: ${e.message}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    console.error(`[catho] Total coletado: ${results.length}`);
    return results;
}
