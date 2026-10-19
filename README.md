# Cookie Optimizer

A full-automation optimizer mod for [Cookie Clicker](https://orteil.dashnet.org/cookieclicker/) (Steam and web, built against 2.053–2.058).

Instead of re-implementing the game's CpS formulas, it values every possible move — a building, an upgrade, a god, a dragon aura, a building level — by applying it to the live game state, calling the game's own `Game.CalculateGains()`, reading the new CpS, and undoing it. Every multiplier the game knows about is counted automatically.

## What it does

| Module | Behaviour |
|---|---|
| **Buy** | Ranks buildings and upgrades by payback period and autobuys the best one. The default `cco` policy adds lookahead for building-count achievements (milk) and tier upgrades unlocked by the next building. |
| **Bank** | Keeps a Lucky reserve only when the expected Lucky return beats the best purchase. |
| **Click** | Clicks the big cookie (30/s) and pops golden and wrath cookies. |
| **Wrinklers** | Lets them feed, pops them to fund the best purchase and before ascending (keeps shinies). |
| **Sugar lumps** | Harvests ripe lumps, unlocks the minigames, then levels the building with the best gain per lump. |
| **Grimoire** | Casts Force the Hand of Fate at full magic. |
| **Pantheon** | Brute-forces god combinations through the simulator and slots the best one. |
| **Garden** | Keeps empty plots planted with Baker's wheat. |
| **Stock Market** | Buys goods far below resting value, sells above it. |
| **Dragon** | Trains Krumblor when the sacrifice is cheap; picks auras by simulation. |
| **Ascension** | Ascends once the prestige gain is large enough, buys heavenly upgrades, reincarnates. |

An in-game panel shows the next six buys with prices and payback times, highlights the best building, and has toggles for every module.

## Install

**Steam:** copy the `CookieOptimizer` folder into your game's `mods/local/` directory, then enable it under Options → Mods.

**Web:** paste the contents of `CookieOptimizer/main.js` into the browser console on the game page (or load it from a bookmarklet/userscript).

## Policies

Pick one in the panel's settings:

- `cco` (default) — Cookie Monster payback, plus achievement and tier-unlock lookahead
- `cm` — Cookie Monster: `max(cost − bank, 0)/CpS + cost/ΔCpS`
- `fc` — Frozen Cookies: `1.15 × cost/CpS + cost/ΔCpS`
- `cheapest` — sanity baseline

## Backtesting

`tools/backtest.js` runs a fresh game per policy in headless Chromium with a seeded RNG, fast-forwarding `Game.Logic()`:

```bash
npm install playwright && npx playwright install chromium
node tools/backtest.js http://localhost:8765/ 60 cheapest fc cm cco
SEEDS=1,2,3 node tools/backtest.js http://localhost:8765/ 60   # several seeds
NOGC=1 node tools/backtest.js http://localhost:8765/ 60        # no golden cookies (deterministic)
```

Point it at a locally served copy of the game. Over 60 game-minutes with no golden cookies, `cco` baked about 3% more than `cm` and `fc`, and about 2.7× `cheapest`.

## Docs

- [`docs/research-and-plan.md`](docs/research-and-plan.md) — game mechanics, prior art and the optimization framing
- [`docs/status.md`](docs/status.md) — version log, backtest results and known gaps
