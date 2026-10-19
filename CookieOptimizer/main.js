/*
 * Cookie Optimizer — v0.3
 * Full-automation optimizer for Cookie Clicker (built against 2.053–2.058).
 *
 * Core idea: to value any change (a building, an upgrade, a god, a dragon aura, a building level)
 * we apply it to the live game state, call the game's own Game.CalculateGains(), read the new
 * CpS, and undo it. No CpS formulas are re-implemented, so every multiplier is counted.
 *
 * Modules (each can be toggled in the panel's settings):
 *   buy      – payback-period autobuyer (buildings + upgrades, incl. Grandmapocalypse research)
 *   bank     – keep a Lucky bank only when it out-earns buying
 *   click    – autoclick the big cookie; pop golden (and optionally wrath) cookies
 *   wrinkler – let wrinklers feed, pop them to fund purchases and before ascending
 *   lumps    – harvest ripe sugar lumps, unlock minigames, level the best building
 *   spells   – Grimoire: cast Force the Hand of Fate when magic is full
 *   gods     – Pantheon: slot the best god combination (simulated)
 *   garden   – keep every free plot planted with Baker's wheat
 *   stocks   – Stock Market: buy far below resting value, sell above it
 *   dragon   – train Krumblor when cheap, pick the best auras (simulated)
 *   ascend   – ascend when prestige gain is big enough, buy heavenly upgrades, reincarnate
 */
(function () {
	if (window.CCO && window.CCO.loaded) return;

	var CCO = window.CCO = {
		loaded: true,
		version: '0.3',
		config: {
			autobuy: true,
			bank: 'auto',          // 'auto' | 'off' | 'lucky' (6,000x CpS) | 'frenzy' (42,000x CpS)
			autoClick: true,
			clicksPerSec: 30,      // the game caps clicks at 50/s
			autoGolden: true,
			clickWrath: true,      // wrath cookies are positive on average (Elder Frenzy)
			allowTech: true,       // Grandmapocalypse research: big CpS upgrades and wrinklers
			wrinklers: true,
			lumps: true,
			spells: true,
			gods: true,
			garden: true,
			stocks: true,
			dragon: true,
			autoAscend: true,
			firstAscend: 440,      // prestige levels to gain before the first ascension
			ascendRatio: 1.0,      // later ascensions: ascend once the gain >= ratio x current prestige
			dragonMinutes: 15,     // train the dragon if rebuying the sacrificed buildings costs <= this many minutes of CpS
			utilityMinutes: 1,
			policy: 'cco',
			showPanel: true
		},
		ranked: [], utility: [], log: [],
		stats: { evals: 0, bought: 0, clicks: 0, golden: 0, spells: 0, wrinklers: 0, lumpsSpent: 0, ascends: 0, trades: 0 },
		status: {}
	};
	var C = CCO.config;

	function note(module, msg) {
		CCO.status[module] = msg;
		CCO.log.push({ t: Date.now(), m: module, msg: msg });
		if (CCO.log.length > 500) CCO.log.shift();
	}

	var BLACKLIST = {
		'Chocolate egg': 1, 'Elder Pledge': 1, 'Elder Covenant': 1, 'Revoke Elder Covenant': 1,
		'Golden switch [off]': 1, 'Golden switch [on]': 1, 'Shimmering veil [off]': 1, 'Shimmering veil [on]': 1,
		'Sugar frenzy': 1
	};
	var BAD_POOLS = { toggle: 1, debug: 1, prestige: 1, unused: 1 };

	/* ================= simulation core ================= */

	var simDepth = 0, savedWin = null, savedHigh = 0;
	function beginSim() {
		if (simDepth++ > 0) return;
		savedWin = Game.Win; savedHigh = Game.cookiesPsRawHighest;
		Game.Win = function () {};           // CalculateGains awards CpS achievements: suppress for hypotheticals
	}
	function endSim() {
		if (--simDepth > 0) return;
		Game.Win = savedWin;
		Game.CalculateGains();
		Game.cookiesPsRawHighest = savedHigh;
	}
	function simCps(mutate, undo) {
		mutate(); Game.CalculateGains();
		var cps = Game.unbuffedCps;
		undo();
		return cps;
	}
	// Income of the current state including autoclicking (used for gods, auras, levels)
	function stateValue() {
		Game.CalculateGains();
		return Game.unbuffedCps + (C.autoClick ? C.clicksPerSec * Game.computedMouseCps : 0);
	}

	function buildingMutator(obj, n, extraUpgrade, achievs) {
		return {
			mutate: function () { obj.amount += n; Game.BuildingsOwned += n; if (extraUpgrade) extraUpgrade.bought = 1; if (achievs) Game.AchievementsOwned += achievs; },
			undo: function () { obj.amount -= n; Game.BuildingsOwned -= n; if (extraUpgrade) extraUpgrade.bought = 0; if (achievs) Game.AchievementsOwned -= achievs; }
		};
	}

	function thresholdEffects(obj) {
		var next = obj.amount + 1, res = { upgrades: [], achievs: 0 };
		for (var i in obj.tieredUpgrades) {
			var u = obj.tieredUpgrades[i], tier = Game.Tiers[u.tier];
			if (tier && tier.unlock === next && !u.unlocked && !u.bought && usableUpgrade(u, true)) res.upgrades.push(u);
		}
		for (var j in obj.tieredAchievs) {
			var a = obj.tieredAchievs[j], t = Game.Tiers[a.tier];
			if (t && t.achievUnlock === next && !a.won && Game.CountsAsAchievementOwned(a.pool)) res.achievs++;
		}
		return res;
	}

	function inVault(u) { return Game.vault && (Game.vault.indexOf(u.id) !== -1 || Game.vault.indexOf(String(u.id)) !== -1); }

	function usableUpgrade(u, ignoreUnlock) {
		if (u.bought) return false;
		if (!ignoreUnlock && !u.unlocked) return false;
		if (BAD_POOLS[u.pool]) return false;
		if (BLACKLIST[u.name]) return false;
		if (u.pool === 'tech') { if (!C.allowTech) return false; }
		else if (u.clickFunction) return false;
		if (u.choicesFunction) return false;
		if (u.priceLumps > 0) return false;
		if (inVault(u)) return false;
		return true;
	}

	/* ================= wrinklers (used by the buyer) ================= */

	function wrinklerPayout(w) {
		var m = 1.1;
		if (Game.Has('Sacrilegious corruption')) m *= 1.05;
		if (Game.Has('Wrinklerspawn')) m *= 1.05;
		if (w.type == 1) m *= 3;
		return w.sucked * m;
	}
	function wrinklerBank(includeShiny) {
		var s = 0, ws = Game.wrinklers || [];
		for (var i = 0; i < ws.length; i++) if (ws[i].phase > 0 && (includeShiny || ws[i].type != 1)) s += wrinklerPayout(ws[i]);
		return s;
	}
	function popWrinklers(needed, includeShiny) {
		var list = (Game.wrinklers || []).filter(function (w) { return w.phase > 0 && w.sucked > 0 && (includeShiny || w.type != 1); });
		list.sort(function (a, b) { return b.sucked - a.sucked; });
		var got = 0, n = 0;
		for (var i = 0; i < list.length && (needed === Infinity || got < needed); i++) {
			got += wrinklerPayout(list[i]); list[i].hp = 0; n++;   // the game pops it on its next wrinkler update
		}
		if (n) { CCO.stats.wrinklers += n; note('wrinkler', 'popped ' + n + ' for ' + B(got)); }
		return n;
	}

	/* ================= buyer ================= */

	function bankPayback() {
		var g = Game.shimmerTypes && Game.shimmerTypes.golden;
		if (!g || !g.maxTime) return Infinity;
		var meanSpawnSec = (g.minTime + g.maxTime) / 2 / Game.fps;
		var clicked = Game.goldenClicksLocal || 0, missed = Game.missedGoldenClicks || 0;
		var clickRate = C.autoGolden ? 1 : (clicked + missed > 5 ? clicked / (clicked + missed) : 0.5);
		var luckyPerSec = 0.45 * clickRate / meanSpawnSec;   // ~45% of golden cookies roll Lucky
		return luckyPerSec > 0 ? 1 / (0.15 * luckyPerSec) : Infinity;
	}

	function reserve(bestRawPayback) {
		CCO.bankStatus = '';
		if (C.bank === 'off') return 0;
		if (C.bank === 'lucky' || C.bank === 'frenzy') {
			if (!Game.Has('Lucky day')) return 0;
			return Game.unbuffedCps * (C.bank === 'frenzy' ? 42000 : 6000);
		}
		var bp = bankPayback();
		CCO.bankPaybackSec = bp;
		if (bestRawPayback <= bp) { CCO.bankStatus = 'buying beats banking'; return 0; }
		CCO.bankStatus = 'saving for Lucky';
		return Game.unbuffedCps * 6000;
	}

	function score(cost, delta, cps, avail) {
		if (!(delta > 0)) return Infinity;
		var incomeRate = Math.max(cps + (C.autoClick ? C.clicksPerSec * Game.computedMouseCps : 0), 1);
		var wait = Math.max(cost - avail, 0) / incomeRate;
		switch (C.policy) {
			case 'fc': return 1.15 * cost / incomeRate + cost / delta;
			case 'cheapest': return cost;
			default: return wait + cost / delta;
		}
	}

	CCO.evaluate = function () {
		var t0 = performance.now();
		if (Game.recalculateGains) Game.CalculateGains();
		var base = Game.unbuffedCps, cps = Game.cookiesPs;
		var avail = Game.cookies + (C.wrinklers ? wrinklerBank(false) : 0);
		var useLookahead = C.policy === 'cco';
		var out = [], util = [];

		beginSim();
		try {
			for (var i = 0; i < Game.ObjectsById.length; i++) {
				var obj = Game.ObjectsById[i];
				var price = obj.getPrice();
				var m = buildingMutator(obj, 1, null, 0);
				var delta = simCps(m.mutate, m.undo) - base;
				var s = score(price, delta, cps, avail), why = '';
				if (useLookahead) {
					var fx = thresholdEffects(obj);
					if (fx.achievs) {
						m = buildingMutator(obj, 1, null, fx.achievs);
						var dA = simCps(m.mutate, m.undo) - base;
						if (dA > delta) { delta = dA; s = score(price, delta, cps, avail); why = '+achiev'; }
					}
					for (var k = 0; k < fx.upgrades.length; k++) {
						var up = fx.upgrades[k];
						m = buildingMutator(obj, 1, up, fx.achievs);
						var dC = simCps(m.mutate, m.undo) - base;
						var sC = score(price + up.getPrice(), dC, cps, avail);
						if (sC < s) { s = sC; why = 'unlocks ' + up.name; }
					}
				}
				out.push({ kind: 'building', ref: obj, name: obj.name, price: price, delta: delta, pp: s, note: why });
			}
			for (var j = 0; j < Game.UpgradesInStore.length; j++) {
				var u = Game.UpgradesInStore[j];
				if (!usableUpgrade(u)) continue;
				var d = (function (uu) { return simCps(function () { uu.bought = 1; }, function () { uu.bought = 0; }); })(u) - base;
				var row = { kind: 'upgrade', ref: u, name: u.name, price: u.getPrice(), delta: d, note: u.pool === 'tech' ? 'research' : '' };
				if (d > base * 1e-9) { row.pp = score(row.price, d, cps, avail); out.push(row); }
				else { row.pp = Infinity; util.push(row); }
			}
		} finally { endSim(); }

		out.sort(function (a, b) { return a.pp - b.pp; });
		util.sort(function (a, b) { return a.price - b.price; });
		var bestRaw = Infinity;
		for (var r = 0; r < out.length; r++) if (out[r].delta > 0) bestRaw = Math.min(bestRaw, out[r].price / out[r].delta);
		CCO.ranked = out; CCO.utility = util; CCO.reserveAmt = reserve(bestRaw);
		CCO.stats.evals++; CCO.stats.lastMs = performance.now() - t0;
		return out;
	};

	function doBuy(row) {
		var before = Game.cookies;
		if (row.kind === 'building') {
			var mode = Game.buyMode; Game.buyMode = 1;   // buyMode -1 would SELL
			row.ref.buy(1);
			Game.buyMode = mode;
		} else row.ref.buy(row.ref.pool === 'tech' ? true : 1);   // bypass the One mind confirmation
		if (Game.cookies < before) {
			CCO.stats.bought++;
			CCO.log.push({ t: Date.now(), m: 'buy', msg: row.name });
			if (CCO.log.length > 500) CCO.log.shift();
			return true;
		}
		return false;
	}

	CCO.step = function () {
		var ranked = CCO.evaluate();
		var spendable = Game.cookies - (CCO.reserveAmt || 0);
		var cap = C.utilityMinutes * 60 * Game.unbuffedCps;
		for (var i = 0; i < CCO.utility.length; i++) {
			var u = CCO.utility[i];
			if (u.price <= Math.max(cap, 1e3) && u.price <= spendable) { if (doBuy(u)) return u; }
		}
		var best = ranked[0];
		if (!best || !isFinite(best.pp)) return null;
		if (best.price <= spendable) return doBuy(best) ? best : null;
		// cash out wrinklers if that makes the best purchase affordable
		if (C.wrinklers && best.price <= spendable + wrinklerBank(false)) popWrinklers(best.price - spendable, false);
		return null;
	};

	/* ================= clicking & shimmers ================= */

	function clickModule(frame) {
		if (C.autoClick && C.clicksPerSec > 0) {
			var every = Math.max(1, Math.round(Game.fps / Math.min(C.clicksPerSec, 45)));
			if (frame % every === 0) { var before = Game.cookieClicks; Game.ClickCookie(); if (Game.cookieClicks > before) CCO.stats.clicks++; }
		}
		if (C.autoGolden) {
			for (var g = Game.shimmers.length - 1; g >= 0; g--) {
				var sh = Game.shimmers[g];
				if (sh.type === 'golden' && (!sh.wrath || C.clickWrath)) { sh.pop(); CCO.stats.golden++; }
			}
		}
	}

	/* ================= sugar lumps ================= */

	var MINIGAME_BUILDINGS = ['Farm', 'Temple', 'Wizard tower', 'Bank'];
	function levelUp(obj) {
		var ask = Game.prefs.askLumps; Game.prefs.askLumps = 0;
		var before = obj.level;
		obj.levelUp();
		Game.prefs.askLumps = ask;
		if (obj.level > before) { CCO.stats.lumpsSpent += obj.level; note('lumps', obj.name + ' → level ' + obj.level); return true; }
		return false;
	}
	function lumpModule() {
		if (!C.lumps || !Game.canLumps()) return;
		if (Date.now() - Game.lumpT >= Game.lumpRipeAge) { Game.clickLump(); note('lumps', 'harvested a ripe lump'); }
		// 1) unlock the minigames first
		for (var i = 0; i < MINIGAME_BUILDINGS.length; i++) {
			var o = Game.Objects[MINIGAME_BUILDINGS[i]];
			if (o && o.amount > 0 && o.level < 1) { if (Game.lumps >= 1) levelUp(o); return; }
		}
		// 2) then the level-up with the best income gain per lump
		var bestObj = null, bestRate = 0;
		beginSim();
		try {
			var base = stateValue();
			for (var j = 0; j < Game.ObjectsById.length; j++) {
				var ob = Game.ObjectsById[j], cost = ob.level + 1;
				if (ob.amount <= 0 || cost > Game.lumps) continue;
				ob.level++; Game.lumps -= cost;          // lumps change too, so "Sugar baking" is counted
				var v = stateValue();
				ob.level--; Game.lumps += cost;
				var rate = (v - base) / base / cost;
				if (rate > bestRate) { bestRate = rate; bestObj = ob; }
			}
		} finally { endSim(); }
		if (bestObj && bestRate > 0.001) levelUp(bestObj);
	}

	/* ================= Grimoire ================= */

	function spellModule() {
		if (!C.spells) return;
		var o = Game.Objects['Wizard tower'], M = o && o.minigame;
		if (!M || !M.spells) return;
		var fthof = M.spells['hand of fate'];
		if (M.magic >= M.magicM - 0.01 && M.magic >= M.getSpellCost(fthof)) {
			if (M.castSpell(fthof)) { CCO.stats.spells++; note('spells', 'cast Force the Hand of Fate (' + CCO.stats.spells + ' total)'); }
		}
	}

	/* ================= Pantheon ================= */

	function godValue(M) {
		var v = stateValue();
		var gShare = C.autoGolden ? 0.3 : 0.1, wShare = Game.elderWrath > 0 ? 0.5 : 0;
		var lv = function (k) { if (!M.gods[k]) return 0; for (var s = 0; s < 3; s++) if (M.slot[s] == M.gods[k].id) return s + 1; return 0; };
		var mother = [0, 0.15, 0.1, 0.05], industry = [0, 0.1, 0.06, 0.03], scorn = [0, 0.15, 0.1, 0.05];
		v *= 1 - gShare * mother[lv('mother')];       // fewer golden cookies
		v *= 1 - gShare * industry[lv('industry')];
		v *= 1 + wShare * scorn[lv('scorn')];          // wrinklers digest more
		return v;
	}
	function godModule() {
		if (!C.gods) return;
		var o = Game.Objects['Temple'], M = o && o.minigame;
		if (!M || !M.gods || !M.slot) return;
		var cands = ['mother', 'industry', 'labor', 'scorn', 'decadence'];
		if (!C.autoGolden) cands.push('asceticism');   // Holobore leaves if a golden cookie is clicked
		var ids = cands.map(function (k) { return M.gods[k] ? M.gods[k].id : undefined; }).filter(function (x) { return x !== undefined; });
		var orig = M.slot.slice(), best = orig.slice(), bestV, curV;
		beginSim();
		try {
			curV = godValue(M); bestV = curV;
			for (var a = -1; a < ids.length; a++) for (var b = -1; b < ids.length; b++) for (var c = -1; c < ids.length; c++) {
				var cfg = [a < 0 ? -1 : ids[a], b < 0 ? -1 : ids[b], c < 0 ? -1 : ids[c]];
				if ((cfg[0] != -1 && (cfg[0] == cfg[1] || cfg[0] == cfg[2])) || (cfg[1] != -1 && cfg[1] == cfg[2])) continue;
				M.slot[0] = cfg[0]; M.slot[1] = cfg[1]; M.slot[2] = cfg[2];
				var v = godValue(M);
				if (v > bestV) { bestV = v; best = cfg; }
			}
		} finally { M.slot[0] = orig[0]; M.slot[1] = orig[1]; M.slot[2] = orig[2]; endSim(); }
		if (bestV < curV * 1.02) return;
		var changes = [0, 1, 2].filter(function (s) { return best[s] != orig[s] && best[s] != -1; });
		if (!changes.length) return;
		if (M.swaps < changes.length) { CCO.status.gods = 'better setup found, waiting for worship swaps'; return; }
		changes.forEach(function (s) { M.slotGod(M.godsById[best[s]], s); M.useSwap(1); });
		try { syncTempleDOM(M); } catch (e) {}
		note('gods', best.map(function (id) { return id == -1 ? '—' : M.godsById[id].name.split(',')[0]; }).join(' / '));
	}
	function syncTempleDOM(M) {
		for (var i in M.godsById) {
			var g = M.godsById[i], div = l('templeGod' + g.id);
			if (!div) continue;
			if (g.slot != -1) l('templeSlot' + g.slot).appendChild(div);
			else { var ph = l('templeGodPlaceholder' + g.id); if (ph) ph.parentNode.insertBefore(div, ph); }
		}
	}

	/* ================= Garden ================= */

	function gardenModule() {
		if (!C.garden) return;
		var o = Game.Objects['Farm'], M = o && o.minigame;
		if (!M || !M.plants || M.freeze) return;
		var wheat = M.plants['bakerWheat'];
		if (!wheat || !wheat.unlocked) return;
		var planted = 0;
		for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
			if (!M.isTileUnlocked(x, y) || M.plot[y][x][0] !== 0) continue;   // only empty tiles (useTool harvests occupied ones)
			if (!M.canPlant(wheat) || M.getCost(wheat) > Game.cookies - (CCO.reserveAmt || 0)) continue;
			if (M.useTool(wheat.id, x, y)) planted++;
		}
		if (planted) { M.toRebuild = true; note('garden', 'planted ' + planted + ' Baker\'s wheat'); }
	}

	/* ================= Stock Market ================= */

	function stockModule() {
		if (!C.stocks) return;
		var o = Game.Objects['Bank'], M = o && o.minigame;
		if (!M || !M.goodsById) return;
		var budget = Math.max(0, (Game.cookies - (CCO.reserveAmt || 0)) * 0.1);
		if (typeof M.profit === 'number') CCO.status.stocks = (CCO.status.stocks || '').split(' · profit')[0] + ' · profit $' + M.profit.toFixed(0);
		for (var i = 0; i < M.goodsById.length; i++) {
			var g = M.goodsById[i];
			if (!g.active || g.hidden) continue;
			var rest = M.getRestingVal(i);
			if (g.stock > 0 && g.val > Math.max(rest, (g.prev || 0) * 1.3)) {
				if (M.sellGood(i, g.stock)) { CCO.stats.trades++; note('stocks', 'sold ' + g.symbol + ' at $' + g.val.toFixed(2)); }
			} else if (g.val < rest * 0.5 && g.stock < M.getGoodMaxStock(g)) {
				var unit = Game.cookiesPsRawHighest * g.val * (1 + 0.01 * (20 * Math.pow(0.95, M.brokers)));
				var n = Math.min(Math.floor(budget / Math.max(unit, 1e-9)), M.getGoodMaxStock(g) - g.stock);
				var room = M.getGoodMaxStock(g) - g.stock;
				if (n < Math.min(room, Math.max(10, Math.ceil(M.getGoodMaxStock(g) * 0.1)))) continue;   // avoid dribbling tiny orders
				if (M.buyGood(i, n)) { budget -= n * unit; CCO.stats.trades++; note('stocks', 'bought ' + n + ' ' + g.symbol + ' at $' + g.val.toFixed(2)); }
			}
		}
	}

	/* ================= Dragon ================= */

	function rebuyCost(obj, n) {
		if (obj.amount < n) return Infinity;
		return obj.getPrice() * (1 - Math.pow(1.15, -n)) / 0.15;
	}
	function dragonModule() {
		if (!C.dragon || !Game.Has('A crumbly egg') || !Game.dragonLevels) return;
		var L = Game.dragonLevel, levels = Game.dragonLevels, cap = C.dragonMinutes * 60 * Game.unbuffedCps;
		if (L < levels.length - 1 && levels[L].cost()) {
			var cost = 0;
			if (L >= 5 && L < levels.length - 3) cost = rebuyCost(Game.ObjectsById[L - 5], 100);   // 100 of one building
			else if (L >= levels.length - 3) {                                                      // N of every building
				var mm = /sacrifice\((\d+)\)/.exec(levels[L].buy.toString()), n = mm ? +mm[1] : 50;
				for (var i = 0; i < Game.ObjectsById.length; i++) cost += rebuyCost(Game.ObjectsById[i], n);
			}
			if (cost <= cap) {
				Game.UpgradeDragon();
				try { Game.ToggleSpecialMenu(0); } catch (e) {}
				note('dragon', 'trained to level ' + Game.dragonLevel);
			}
		}
		var avail = [];
		for (var a in Game.dragonAuras) if (Game.dragonLevel >= +a + 4) avail.push(+a);
		if (avail.length < 2) return;
		var twoSlots = Game.dragonLevel >= levels.length - 1;
		var o1 = Game.dragonAura, o2 = Game.dragonAura2, best = [o1, o2], bestV, curV;
		beginSim();
		try {
			curV = stateValue(); bestV = curV;
			for (var x = 0; x < avail.length; x++) for (var y = 0; y < (twoSlots ? avail.length : 1); y++) {
				var a1 = avail[x], a2 = twoSlots ? avail[y] : o2;
				if (twoSlots && a1 === a2 && a1 !== 0) continue;
				Game.dragonAura = a1; Game.dragonAura2 = a2;
				var v = stateValue();
				if (v > bestV) { bestV = v; best = [a1, a2]; }
			}
		} finally { Game.dragonAura = o1; Game.dragonAura2 = o2; endSim(); }
		if (bestV > curV * 1.02) {
			var highest = null;
			for (var k in Game.Objects) if (Game.Objects[k].amount > 0) highest = Game.Objects[k];
			var changes = (best[0] !== o1 ? 1 : 0) + (best[1] !== o2 ? 1 : 0);
			Game.dragonAura = best[0]; Game.dragonAura2 = best[1];
			if (highest) highest.sacrifice(changes);       // the game charges one building per aura switch
			Game.recalculateGains = 1;
			note('dragon', 'aura: ' + Game.dragonAuras[best[0]].name + (twoSlots ? ' + ' + Game.dragonAuras[best[1]].name : ''));
		}
	}

	/* ================= Ascension ================= */

	var HEAVENLY_PRIORITY = ['Legacy', 'Heavenly cookies', 'How to bake your dragon', 'Starter kit', 'Tin of british tea biscuits',
		'Box of macarons', 'Box of brand biscuits', 'Tin of butter cookies', 'Heavenly luck', 'Persistent memory', 'Permanent upgrade slot I',
		'Lasting fortune', 'Lucky digit', 'Season switcher', 'Starter kitchen', 'Decisive fate', 'Kitten angels', 'Twin Gates of Transcendence',
		'Unholy bait', 'Halo gloves', 'Lucky number', 'Divine discount', 'Divine sales', 'Residual luck', 'Synergies Vol. I', 'Divine bakeries',
		'Sacrilegious corruption', 'Elder spice', 'Five-finger discount', 'Inspired checklist', 'Genius accounting', 'Synergies Vol. II',
		'Wrinkly cookies', 'Distilled essence of redoubled luck', 'Lucky payout', 'Eye of the wrinkler', 'Stevia Caelestis', 'Sugar aging process',
		'Aura gloves', 'Kitten wages', 'Cat ladies', 'Fortune cookies', 'Luminous gloves'];

	CCO.prestigeInfo = function () {
		var owned = Math.floor(Game.HowMuchPrestige(Game.cookiesReset));
		var after = Math.floor(Game.HowMuchPrestige(Game.cookiesReset + Game.cookiesEarned + (C.wrinklers ? wrinklerBank(true) : 0)));
		var target = owned < 1 ? C.firstAscend : Math.max(1, Math.ceil(owned * C.ascendRatio));
		return { owned: owned, gain: after - owned, target: target };
	};

	var ascendPending = 0;
	function ascendModule() {
		if (!C.autoAscend || Game.OnAscend || Game.AscendTimer > 0 || Game.ascensionMode !== 0) return;
		var p = CCO.prestigeInfo();
		CCO.status.ascend = 'prestige +' + B(p.gain) + ' of ' + B(p.target) + ' needed';
		if (p.gain < p.target) { ascendPending = 0; return; }
		if (!ascendPending) {                    // step 1: cash out wrinklers (their cookies count toward prestige)
			popWrinklers(Infinity, true);
			ascendPending = Game.T;
			return;
		}
		if (Game.T - ascendPending < Game.fps * 2) return;
		ascendPending = 0;
		CCO.stats.ascends++;
		note('ascend', 'ascended for +' + B(p.gain) + ' prestige');
		Game.Ascend(1);
	}

	function canBuyHeavenly(u) {
		if (!u || u.bought || u.pool !== 'prestige') return false;
		if (u.showIf && !u.showIf()) return false;
		for (var i = 0; i < (u.parents || []).length; i++) if (u.parents[i] != -1 && !u.parents[i].bought) return false;
		return u.getPrice() <= Game.heavenlyChips;
	}
	var reincarnateAt = 0;
	function heavenModule() {
		if (!C.autoAscend || !Game.OnAscend) { reincarnateAt = 0; return; }
		var bought = 0;
		for (var guard = 0; guard < 300; guard++) {
			var pick = null;
			for (var i = 0; i < HEAVENLY_PRIORITY.length && !pick; i++) if (canBuyHeavenly(Game.Upgrades[HEAVENLY_PRIORITY[i]])) pick = Game.Upgrades[HEAVENLY_PRIORITY[i]];
			if (!pick) {   // spending chips never lowers the prestige bonus, so spend the rest cheapest-first
				var cands = Game.PrestigeUpgrades.filter(canBuyHeavenly).sort(function (a, b) { return a.getPrice() - b.getPrice(); });
				pick = cands[0] || null;
			}
			if (!pick || !pick.buy()) break;
			bought++;
		}
		if (bought) { try { Game.BuildAscendTree(); } catch (e) {} note('ascend', 'bought ' + bought + ' heavenly upgrades'); }
		if (!reincarnateAt) reincarnateAt = Game.T;
		if (Game.T - reincarnateAt > Game.fps * 3) { reincarnateAt = 0; Game.Reincarnate(1); note('ascend', 'reincarnated'); }
	}

	/* ================= UI ================= */

	function fmtTime(s) {
		if (!isFinite(s)) return '—';
		if (s < 60) return s.toFixed(0) + 's';
		if (s < 3600) return (s / 60).toFixed(1) + 'm';
		if (s < 86400) return (s / 3600).toFixed(1) + 'h';
		return (s / 86400).toFixed(1) + 'd';
	}
	function B(n) { return (typeof Beautify === 'function') ? Beautify(n) : Math.round(n).toString(); }

	var TOGGLES = [['autobuy', 'Autobuy'], ['autoClick', 'Click cookie'], ['autoGolden', 'Golden'], ['clickWrath', 'Wrath'],
		['allowTech', 'Research'], ['wrinklers', 'Wrinklers'], ['lumps', 'Lumps'], ['spells', 'Spells'], ['gods', 'Gods'],
		['garden', 'Garden'], ['stocks', 'Stocks'], ['dragon', 'Dragon'], ['autoAscend', 'Ascend']];

	function buildPanel() {
		if (document.getElementById('ccoPanel')) return;
		var css = document.createElement('style');
		css.textContent =
			'#ccoPanel{position:fixed;left:8px;bottom:30px;z-index:100000000;width:350px;background:rgba(0,0,0,.88);color:#fff;' +
			'font:12px Tahoma,Arial,sans-serif;border:1px solid #c90;border-radius:6px;padding:6px 8px;}' +
			'#ccoPanel h4{margin:0 0 4px;font-size:13px;color:#fc6;display:flex;justify-content:space-between}' +
			'#ccoPanel table{width:100%;border-collapse:collapse}#ccoPanel td{padding:1px 3px;white-space:nowrap}' +
			'#ccoPanel tr.best td{color:#6f6;font-weight:bold}#ccoPanel tr.cant td{opacity:.6}' +
			'#ccoPanel .opts{margin-top:4px;display:flex;flex-wrap:wrap;gap:2px 8px}#ccoPanel select{font-size:11px}' +
			'#ccoPanel .note{color:#9cf;font-size:10px}#ccoPanel .st{color:#ccc;font-size:11px;margin-top:3px}' +
			'#ccoPanel a{color:#fc6;cursor:pointer}.ccoBest{box-shadow:inset 0 0 0 3px #6f6 !important}';
		document.head.appendChild(css);
		var d = document.createElement('div');
		d.id = 'ccoPanel';
		d.innerHTML =
			'<h4><span>Cookie Optimizer ' + CCO.version + '</span><span><a id="ccoSet">settings</a> <a id="ccoMin">[–]</a></span></h4>' +
			'<div id="ccoBody"><div id="ccoInfo"></div><table id="ccoTable"></table><div class="st" id="ccoStatus"></div>' +
			'<div id="ccoSettings" style="display:none"><div class="opts" id="ccoToggles"></div>' +
			'<div class="opts"><label>Bank <select id="ccoBank"><option value="auto">Auto</option><option value="off">off</option><option value="lucky">Lucky</option><option value="frenzy">Lucky+Frenzy</option></select></label>' +
			'<label>Policy <select id="ccoPolicy"><option value="cco">CCO</option><option value="cm">CookieMonster</option><option value="fc">FrozenCookies</option><option value="cheapest">cheapest</option></select></label>' +
			'<label>Ascend at ×<input id="ccoRatio" type="number" step="0.1" min="0.1" style="width:42px"></label></div></div></div>';
		document.body.appendChild(d);
		var tg = document.getElementById('ccoToggles');
		TOGGLES.forEach(function (t) {
			var lab = document.createElement('label');
			lab.innerHTML = '<input type="checkbox"> ' + t[1];
			var cb = lab.firstChild; cb.checked = !!C[t[0]];
			cb.onchange = function () { C[t[0]] = cb.checked; };
			tg.appendChild(lab);
		});
		var bank = document.getElementById('ccoBank'), pol = document.getElementById('ccoPolicy'), ratio = document.getElementById('ccoRatio');
		bank.value = C.bank; pol.value = C.policy; ratio.value = C.ascendRatio;
		bank.onchange = function () { C.bank = bank.value; };
		pol.onchange = function () { C.policy = pol.value; };
		ratio.onchange = function () { var v = parseFloat(ratio.value); if (v > 0) C.ascendRatio = v; };
		document.getElementById('ccoMin').onclick = function () { var b = document.getElementById('ccoBody'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
		document.getElementById('ccoSet').onclick = function () { var s = document.getElementById('ccoSettings'); s.style.display = s.style.display === 'none' ? '' : 'none'; };
	}

	var lastHighlight = null;
	function renderPanel() {
		if (!C.showPanel || Game.OnAscend) return;
		buildPanel();
		var spend = Game.cookies - (CCO.reserveAmt || 0);
		var rows = CCO.ranked.slice(0, 6).map(function (r, i) {
			var cls = (i === 0 ? 'best ' : '') + (r.price > spend ? 'cant' : '');
			return '<tr class="' + cls + '"><td>' + (i + 1) + '. ' + r.name + (r.note ? ' <span class="note">' + r.note + '</span>' : '') +
				'</td><td>' + B(r.price) + '</td><td>' + fmtTime(r.pp) + '</td></tr>';
		}).join('');
		document.getElementById('ccoTable').innerHTML = '<tr><td><b>Next buys</b></td><td><b>Price</b></td><td><b>Payback</b></td></tr>' + rows;
		document.getElementById('ccoInfo').innerHTML = 'Bank: ' + B(CCO.reserveAmt || 0) + (CCO.bankStatus ? ' (' + CCO.bankStatus + ')' : '') +
			' · bought ' + CCO.stats.bought + ' · ' + (CCO.stats.lastMs || 0).toFixed(1) + 'ms';
		var st = [];
		['ascend', 'gods', 'dragon', 'lumps', 'spells', 'wrinkler', 'garden', 'stocks', 'buy', 'click'].forEach(function (k) { if (CCO.status[k]) st.push('<b>' + k + ':</b> ' + CCO.status[k]); });
		document.getElementById('ccoStatus').innerHTML = st.join('<br>');
		if (lastHighlight) lastHighlight.classList.remove('ccoBest');
		var best = CCO.ranked[0];
		if (best && best.kind === 'building') { var el = document.getElementById('product' + best.ref.id); if (el) { el.classList.add('ccoBest'); lastHighlight = el; } }
	}

	/* ================= main loop ================= */

	function safe(fn, name) { try { fn(); } catch (e) { CCO.status[name] = 'error: ' + e.message; if (window.console) console.error('[CCO ' + name + ']', e); } }

	CCO.tick = function () {
		if (Game.OnAscend || Game.AscendTimer > 0 || Game.ReincarnateTimer > 0) return;
		if (C.autobuy) { for (var n = 0; n < 5; n++) { if (!CCO.step()) break; } }
		else CCO.evaluate();
	};

	var frame = 0;
	function onLogic() {
		frame++;
		if (Game.OnAscend) { if (frame % 15 === 0) safe(heavenModule, 'ascend'); return; }
		if (Game.AscendTimer > 0 || Game.ReincarnateTimer > 0) return;
		safe(function () { clickModule(frame); }, 'click');
		if (frame % 10 === 0) safe(CCO.tick, 'buy');
		if (frame % 30 === 0) { safe(spellModule, 'spells'); safe(gardenModule, 'garden'); safe(stockModule, 'stocks'); safe(ascendModule, 'ascend'); safe(renderPanel, 'panel'); }
		if (frame % (30 * 60) === 15) { safe(lumpModule, 'lumps'); safe(godModule, 'gods'); safe(dragonModule, 'dragon'); }
	}
	CCO.onLogic = onLogic;
	CCO.modules = { lumps: lumpModule, gods: godModule, dragon: dragonModule, spells: spellModule, garden: gardenModule, stocks: stockModule, ascend: ascendModule, heaven: heavenModule };

	Game.registerMod('cookie optimizer', {
		init: function () {
			Game.registerHook('logic', onLogic);
			if (C.showPanel) buildPanel();
			Game.Notify('Cookie Optimizer ' + CCO.version, 'Full automation is on. Open "settings" in the panel to switch modules off.', [16, 5]);
		},
		save: function () { return JSON.stringify(C); },
		load: function (str) {
			try {
				var c = JSON.parse(str);
				for (var k in c) if (k in C) C[k] = c[k];
				if (!c.v3) {                         // first load after upgrading: switch everything on
					TOGGLES.forEach(function (t) { C[t[0]] = true; });
					if (C.bank === 'frenzy' || C.bank === 'lucky') C.bank = 'auto';
				}
			} catch (e) {}
			C.v3 = true;
			var p = document.getElementById('ccoPanel'); if (p) { p.remove(); buildPanel(); }
		}
	});
	C.v3 = true;
})();
