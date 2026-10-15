// REL-09 (partial): automated accessibility checks against a running vault.
//
//   OPENPLOD_A11Y_URL=http://127.0.0.1:3487 [OPENPLOD_TEST_TOKEN_FILE=...] node scripts/check-a11y.mjs
//
// For each main route this injects axe-core (WCAG 2.0/2.1/2.2 A and AA rules, which include
// target-size), repeats the scan with prefers-reduced-motion and a phone viewport, and tabs
// through the page to find focused elements without a visible focus indicator. It fails on
// serious/critical axe violations or invisible focus. It does not replace manual
// keyboard and screen-reader testing, and checks only what the vault currently contains.
//
// Optional: OPENPLOD_A11Y_ROUTES=/,/settings  OPENPLOD_A11Y_REPORT=report.json
//           OPENPLOD_CHROMIUM=/usr/bin/chromium (otherwise Playwright's bundled browser)
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const origin = process.env.OPENPLOD_A11Y_URL;
assert(origin, 'Set OPENPLOD_A11Y_URL to a running vault, for example http://127.0.0.1:3487');
const token = process.env.OPENPLOD_TEST_TOKEN_FILE ? readFileSync(process.env.OPENPLOD_TEST_TOKEN_FILE, 'utf8').trim() : '';
const routes = (process.env.OPENPLOD_A11Y_ROUTES || '/,/transcripts,/notes,/ai,/devices,/import,/settings').split(',').map(route => route.trim()).filter(Boolean);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { chromium } = await import(process.env.OPENPLOD_PLAYWRIGHT_PATH || 'playwright-core');

const browser = await chromium.launch({ headless: true, ...(process.env.OPENPLOD_CHROMIUM ? { executablePath: process.env.OPENPLOD_CHROMIUM } : {}) });
const scenarios = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' },
  { name: 'phone, reduced motion', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true },
];
const report = [];
let failed = false;

try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: scenario.viewport, reducedMotion: scenario.reducedMotion, hasTouch: scenario.hasTouch, isMobile: scenario.isMobile });
    if (token) await context.route(`${origin}/api/**`, route => route.continue({ headers: { ...route.request().headers(), 'X-OpenPlod-Token': token } }));
    const page = await context.newPage();
    for (const route of routes) {
      await page.goto(new URL(route, origin).toString(), { waitUntil: 'networkidle' });
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        return result.violations.map(violation => ({ id: violation.id, impact: violation.impact, help: violation.help, nodes: violation.nodes.slice(0, 5).map(node => node.target.join(' ')) }));
      });
      const invisibleFocus = [];
      for (let step = 0; step < 25; step++) {
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          const visible = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
          return { visible, label: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''} ${(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40)}` };
        });
        if (focus && !focus.visible && !invisibleFocus.includes(focus.label)) invisibleFocus.push(focus.label);
      }
      const serious = axe.filter(violation => ['serious', 'critical'].includes(violation.impact));
      if (serious.length || invisibleFocus.length) failed = true;
      report.push({ scenario: scenario.name, route, violations: axe, invisibleFocus });
      console.log(`${serious.length || invisibleFocus.length ? 'FAIL' : 'PASS'} ${scenario.name} ${route}: ${axe.length} axe violation(s) (${serious.length} serious/critical), ${invisibleFocus.length} focus without indicator`);
      for (const violation of axe) console.log(`  [${violation.impact}] ${violation.id}: ${violation.help} -> ${violation.nodes.join(', ')}`);
      for (const label of invisibleFocus) console.log(`  [focus] no visible indicator: ${label}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (process.env.OPENPLOD_A11Y_REPORT) writeFileSync(process.env.OPENPLOD_A11Y_REPORT, JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
