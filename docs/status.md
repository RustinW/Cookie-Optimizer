# Cookie Optimizer — Status Log

## Decisions
- Target: **Steam** (same JS as web; mod = mods/local/CookieOptimizer/{info.txt, main.js}).
- Game version is actually **2.058** (verified from the github.com/ozh/cookieclicker mirror, Jul 2026), not 2.052 as in the first research note.
- The cloud sandbox can't reach orteil.dashnet.org. Testing runs on a local clone of the ozh mirror served at localhost:8765 in headless Chromium.

## v0.1 (2026-10-02)
- Evaluator: mutate state → Game.CalculateGains() → read Game.unbuffedCps → undo. Game.Win is stubbed during the sim, because CalculateGains awards CpS achievements, and cookiesPsRawHighest is restored afterwards.
- Policies: cco (CM payback + achievement-milk credit + tier-unlock combo lookahead), cm, fc, cheapest.
- Lucky bank reserve (6k / 42k × unbuffed CpS) once Lucky day is owned. Cheap no-CpS upgrades are bought if ≤ 1 min of CpS.
- Panel UI and best-building highlight. Config saved through the mod save hook.

## Backtest results (60 game-min, 5 clicks/s)
- No golden cookies (deterministic): cco 37.14M baked vs cm 36.09M vs fc 36.05M → about +3% from lookahead alone.
- With golden cookies, 3 seeds: cco mean ~151M vs cm ~123M. The noise is large (golden-cookie luck), so this is not conclusive.
- cheapest: 13.5M (sanity baseline).

## Next ideas
- Multi-step lookahead / beam search; the swap test; bulk (×10) candidates.
- Synergy and grandma-type unlock thresholds (15/75 buildings); total-building achievements.
- More seeds plus longer horizons; Lucky-bank threshold tuning; golden-cookie/wrinkler automation; ascension timing.

## v0.2 (2026-10-02)
- Tested on a Steam 2.053 build. The first run had bank = Lucky+Frenzy, which reserved 98.9B against a 73.7M bank, so "bought 0". Fixed with an Auto bank mode: bank only when Lucky ROI (0.15 × Lucky rate × golden click rate) beats the best purchase. Added a golden-cookie autoclick toggle.

## v0.3 (2026-10-02) — goal: max progress speed, fully automatic
- New modules, all default on: big-cookie autoclick 30/s, golden + wrath popping, Grandmapocalypse research (One mind bypasses its confirmation), wrinklers (pop to fund the best buy; pop all before ascending; keep shiny), sugar lumps (harvest when ripe → unlock Farm/Temple/Wizard/Bank → best CpS-per-lump level, sim incl. Sugar baking), Grimoire (FtHoF at full magic), Pantheon (brute-force sim over mother/industry/labor/scorn/decadence, with golden/wrinkler adjustments), garden (Baker's wheat on empty tiles), stocks (buy <50% resting, sell > max(resting, 1.3× cost), ≤10% of spendable), dragon (train if rebuy ≤ 15 min CpS; sim-picked auras), ascension (first at +440 prestige, then gain ≥ 1× prestige; buys heavenly upgrades from a priority list then cheapest-first; reincarnates).
- The first load of v0.3 over a v0.1/0.2 save switches every module on and moves bank from lucky/frenzy to auto.
- Integration tests (headless, Date.now advanced with game time): fresh 30 min → 239k CpS (vs ~11k with 5 clicks/s under v0.1; most of the gain is from clicking). A full ascend → heavenly purchases → reincarnate cycle worked. Lumps, gods, spells, garden, stocks and dragon all acted, with no errors.
- Known gaps: seasons/Santa/eggs not automated; garden is wheat only (no mutation farming); FtHoF not combo-timed; Godzamok/sell combos not used; stock strategy not validated for profit; ascension thresholds are heuristics and not yet backtested.
