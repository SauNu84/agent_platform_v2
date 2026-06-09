import { chromium } from 'playwright';

const label = process.argv[2] || 'after';
const base = 'http://localhost:3210';
const routes = [
  ['home', '/'],
  ['library', '/library'],
  ['scenario-detail', '/scenarios/sales-objection-handling'],
  ['courses', '/courses'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
for (const [name, route] of routes) {
  await page.goto(base + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/sau-215-reskin/screens/${label}-${name}.png`, fullPage: true });
  console.log(`shot ${label}-${name}`);
}
await browser.close();
