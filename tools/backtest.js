// Headless backtester: runs a fresh game per policy, fast-forwarding Game.Logic().
// Usage: node backtest.js <gameUrl> <minutes> <policies...>
const { chromium } = require(process.env.PW || 'playwright');
const fs = require('fs'), path = require('path');
const [url, minutesArg, ...policiesArg] = process.argv.slice(2);
const MINUTES = +minutesArg || 60, POLICIES = policiesArg.length ? policiesArg : ['cheapest','fc','cm','cco'];
const SEEDS = (process.env.SEEDS || '1').split(',').map(Number);
const MOD = fs.readFileSync(path.join(__dirname, '..', 'CookieOptimizer', 'main.js'), 'utf8');

async function run(browser, policy, seed) {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  await p.route(u => !u.href.startsWith(new URL(url).origin), r => r.abort());
  await p.addInitScript(s => { // seeded RNG so every policy sees comparable luck
    let a = s >>> 0; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }, seed);
  await p.goto(url); await p.waitForFunction(() => window.Game && Game.ready, null, { timeout: 60000 });
  await p.addScriptTag({ content: MOD });
  return p.evaluate(async ({ policy, MINUTES, NOGC }) => {
    Game.prefs.particles = 0; Game.prefs.numbers = 0;
    Object.assign(CCO.config, { autobuy: true, policy, showPanel: false });
    const fps = Game.fps, marks = [5, 15, 30, 60, 90, 120, 180, 240].filter(m => m <= MINUTES), out = {};
    for (let t = 1; t <= MINUTES * 60 * fps; t++) {
      Game.Earn(Game.computedMouseCps * 5 / fps);                // 5 clicks/sec for everyone
      for (const s of Game.shimmers.slice()) if (s.type === 'golden') { if (NOGC) s.die(); else s.pop(); } // NOGC=1 removes golden cookies for a luck-free comparison
      Game.Logic();
      const min = t / (60 * fps);
      if (marks.includes(min)) out[min + 'm'] = { baked: Game.cookiesEarned, cps: Game.unbuffedCps, buildings: Game.BuildingsOwned, upgrades: Game.UpgradesOwned };
      if (t % (fps * 60) === 0) await new Promise(r => setTimeout(r, 0));
    }
    return out;
  }, { policy, MINUTES, NOGC: !!process.env.NOGC }).finally(() => ctx.close());
}

(async () => {
  const browser = await chromium.launch(); const results = {};
  for (const seed of SEEDS) for (const pol of POLICIES) {
    const t0 = Date.now(); results[`${pol}#${seed}`] = await run(browser, pol, seed);
    console.error(`${pol} seed ${seed} done in ${((Date.now()-t0)/1000).toFixed(0)}s`);
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
