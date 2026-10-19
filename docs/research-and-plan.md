# Cookie Clicker Optimizer — Research & Plan of Attack (Oct 2026)

## Game state
- Current game: v2.052 (20 buildings; final building added July 2023). Latest console/Steam patch 2.052-1.03c (Oct 2025) — no mechanic changes. Mechanics are stable.
- Web and Steam run the same JS. Mods: `Game.registerMod(id, {init, save, load})` + `info.txt` in `/mods/local` (Steam), or loaded via bookmarklet/userscript on web.

## Mechanics that matter for optimization
- Building price = base × 1.15^owned (bulk buys are a geometric sum).
- CpS = Σ(building CpS × per-building multipliers) × global multipliers (prestige %, kittens × milk, building levels from sugar lumps, dragon aura, Pantheon, garden, golden-cookie buffs).
- Tiered building upgrades ×2; grandma-type upgrades; Thousand Fingers family (cursors gain per non-cursor building); kittens scale with milk, milk = achievements → hidden value in hitting building-count achievements.
- Upgrades unlock at building thresholds (1, 5, 25, 50, 100, 150, ...): buildings carry option value beyond ΔCpS.
- Golden cookies: Lucky = min(15% bank, 900 s of CpS) + 13 → bank 6,000× CpS for max Lucky; ×7 during Frenzy → 42,000× CpS. Banking competes with buying.
- Wrinklers, ascension/heavenly chips, minigames = later-scope layers.

## Prior art
- Cookie Monster: PP = max(cost − bank, 0)/CpS + cost/ΔCpS (lower = better). Advisory only. Computes ΔCpS by simulating the game's own CpS calc on a cloned state.
- Frozen Cookies: efficiency = 1.15 × cost/CpS + cost/ΔCpS; autobuy, golden-cookie autoclick, Lucky bank logic, HC timers.

## Optimization framing
- Problem: choose a purchase order to minimise time to a goal (or maximise cookies by time T). Greedy-by-PP is a strong but not optimal heuristic.
- Pairwise exchange test: buy A before B iff c_A/CpS + c_B/(CpS+Δ_A) < c_B/CpS + c_A/(CpS+Δ_B).
- Upgrades: k-step lookahead / beam search over candidates, scored by simulated time-to-goal.
- Value non-CpS effects: achievements→milk, unlock thresholds, Lucky bank.

## Build phases
0. Harness: bookmarklet/mod skeleton on web build; read Game.Objects, Game.UpgradesInStore, Game.cookiesPs.
1. Evaluator: for each candidate (building ×1/×10, store upgrades minus toggles/risky switches), compute ΔCpS by cloning state + Game.CalculateGains, restore.
2. Policy v1: greedy PP (CM formula) + autobuy. Policy v2: Frozen-Cookies weight, exchange test, 2–3 step lookahead.
3. Bank management: hold Lucky reserve once Lucky upgrades owned.
4. Backtester: headless Chromium (Playwright) fast-forwarding Game.Logic from fixed seeds/saves; compare policies by time-to-milestone. Optional Python model of the economy for fast policy search.
5. Extras: golden cookie / wrinkler automation, ascension timing, minigames.

## Open decisions
- Web vs Steam target; advisor overlay vs full autobuy; scope (early-game first-run vs late-game).
