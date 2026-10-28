// Всё, что зависит от игровой системы: золото, тип создаваемого предмета и умения удачи.
import { MODULE_ID } from "./const.mjs";

const setting = key => game.settings.get(MODULE_ID, key);
const isPf2e = () => game.system.id === "pf2e";
const isDnd5e = () => game.system.id === "dnd5e";
const norm = s => String(s ?? "").trim().toLowerCase().replace(/ё/g, "е");

/* ======================================================================
   Золото
   ====================================================================== */

/** Путь к полю золота для систем, где золото лежит в одном поле. */
function goldPath() {
  const custom = setting("currencyPath");
  if (custom) return custom;
  if (isDnd5e()) return "system.currency.gp";
  return null;
}
const usePf2eCoins = () => isPf2e() && !setting("currencyPath");

/** Где модуль берёт золото (для подсказки в окне). */
export function goldSourceLabel() {
  if (usePf2eCoins()) return "монеты в инвентаре PF2e";
  return goldPath() ?? "не настроено";
}

/** Сколько золота у персонажа (в зм), или null, если не удалось узнать. */
export function getGold(actor) {
  if (usePf2eCoins()) {
    const inv = actor.inventory;
    const coins = inv?.currency ?? inv?.coins;
    if (!coins) return null;
    const value = coins.goldValue ?? ((coins.pp ?? 0) * 10 + (coins.gp ?? 0) + (coins.sp ?? 0) / 10 + (coins.cp ?? 0) / 100);
    return Math.round(value * 100) / 100;
  }
  const path = goldPath();
  if (!path) return null;
  const v = foundry.utils.getProperty(actor, path);
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}

/** Списать золото. Возвращает true, если получилось. Нехватку проверяет вызывающий. */
export async function spendGold(actor, price) {
  if (usePf2eCoins()) {
    // PF2e сам разменяет серебро и медь, если золотых не хватает.
    const inv = actor.inventory;
    const remove = (inv.removeCurrency ?? inv.removeCoins).bind(inv);
    return (await remove({ gp: price }, { byValue: true })) !== false;
  }
  const path = goldPath();
  await actor.update({ [path]: getGold(actor) - price });
  return true;
}

/** Тип предмета, который создаём в инвентаре, или null, если такого типа в системе нет. */
export function itemType() {
  const custom = setting("itemType");
  const type = custom || { dnd5e: "loot", pf2e: "equipment" }[game.system.id] || "";
  return type && Item.TYPES.includes(type) ? type : null;
}

/* ======================================================================
   Умения удачи
   ----------------------------------------------------------------------
   Каждое умение даёт переброс одного из трёх видов:
   - "extra":     ещё один бросок, взять можно любой из выпавших (Везунчик 2014);
   - "advantage": то же самое, но преимущества в D&D не складываются,
                  поэтому за бросок срабатывает только один такой источник;
   - "replace":   кость перебрасывается, и нужно взять новый результат.
   Бросок d100 считается проверкой d20: «выпала 1» на d20 соответствует 1–5 на d100
   (тот же шанс 5%).
   ====================================================================== */

export const HALFLING_MAX = 5;

/** Ищет у персонажа предмет-умение по идентификатору, источнику в компендиуме или названию. */
function findItem(actor, { identifiers = [], sourceIds = [], names = [], filter = () => true }) {
  const ids = identifiers.map(norm);
  const nm = names.map(norm);
  return actor.items.find(item => {
    if (!filter(item)) return false;
    const ident = norm(item.system?.identifier ?? item.system?.slug ?? item.slug);
    if (ident && ids.includes(ident)) return true;
    const src = item.sourceId ?? item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? "";
    if (src && sourceIds.some(id => src.endsWith(id))) return true;
    return nm.includes(norm(item.name));
  }) ?? null;
}

/* ---------- D&D 5e ---------- */

const DND_LUCKY_FEAT = {
  identifiers: ["lucky"],
  names: ["Lucky", "Везунчик", "Удачливый", "Счастливчик"],
  filter: i => i.type === "feat" && i.system?.type?.value !== "race"
};
const DND_HALFLING = {
  identifiers: ["lucky", "luck", "halfling-luck"],
  names: ["Lucky", "Luck", "Везучий", "Удача", "Везение", "Удача полурослика"],
  filter: i => i.type === "feat" && i.system?.type?.value === "race"
};
const DND_TIDES = {
  identifiers: ["tides-of-chaos"],
  names: ["Tides of Chaos", "Волна хаоса", "Поток хаоса", "Прилив хаоса"],
  filter: i => i.type === "feat"
};

function dndRules() {
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; }
  catch { return "2014"; }
}

/** Заряды у предмета dnd5e: { value, max } или null, если зарядов нет. */
function dndUses(item) {
  const u = item.system?.uses;
  const max = Number(u?.max) || 0;
  if (!max) return null;
  const value = u.value ?? (max - (u.spent ?? 0));
  return { value: Math.max(0, value), max };
}
async function dndSpendUse(item) {
  const u = item.system.uses;
  if ("spent" in u) return item.update({ "system.uses.spent": (u.spent ?? 0) + 1 });
  return item.update({ "system.uses.value": Math.max(0, (u.value ?? 0) - 1) });
}

function dnd5eSources(actor) {
  const rules = dndRules();
  const out = [];

  const lucky = findItem(actor, DND_LUCKY_FEAT);
  if (lucky) {
    const uses = dndUses(lucky);
    out.push({
      id: "lucky",
      label: lucky.name,
      kind: rules === "2014" ? "extra" : "advantage",
      hint: rules === "2014" ? "Бросить ещё раз и выбрать любой результат." : "Преимущество: бросить ещё раз и выбрать.",
      counter: uses ? `${uses.value}/${uses.max}` : null,
      blocked: !uses ? "У черты не настроены очки удачи" : uses.value < 1 ? "Очки удачи закончились" : null,
      spend: () => dndSpendUse(lucky)
    });
  }

  const tides = findItem(actor, DND_TIDES);
  if (tides) {
    const uses = dndUses(tides);
    out.push({
      id: "tides",
      label: tides.name,
      kind: "advantage",
      hint: "Преимущество: бросить ещё раз и выбрать.",
      counter: uses ? `${uses.value}/${uses.max}` : null,
      blocked: !uses ? "У умения не настроены использования" : uses.value < 1 ? "Уже использовано, нужен продолжительный отдых" : null,
      spend: () => dndSpendUse(tides)
    });
  }

  const halfling = findItem(actor, DND_HALFLING);
  if (halfling) {
    out.push({
      id: "halfling",
      label: halfling.name,
      kind: "replace",
      target: "low",
      hint: `Только если выпало 1–${HALFLING_MAX}. Перебросить и взять новый результат.`,
      counter: null,
      needsLow: true,
      spend: async () => {}
    });
  }

  if (actor.system?.attributes && "inspiration" in actor.system.attributes) {
    const has = !!actor.system.attributes.inspiration;
    out.push({
      id: "inspiration",
      label: rules === "2014" ? "Вдохновение" : "Героическое вдохновение",
      kind: rules === "2014" ? "advantage" : "replace",
      hint: rules === "2014" ? "Преимущество: бросить ещё раз и выбрать." : "Перебросить и взять новый результат.",
      counter: null,
      blocked: has ? null : "Нет вдохновения",
      hideWhenBlocked: true,
      spend: () => actor.update({ "system.attributes.inspiration": false })
    });
  }
  return out;
}

/* ---------- Pathfinder 2e ---------- */

// Черты удачи (fortune), которые позволяют перебросить проверку навыка и взять новый результат.
const PF2E_FORTUNE_FEATS = [
  { sourceIds: ["ZbRVqf14RTJJIZXG"], identifiers: ["halfling-luck"], names: ["Halfling Luck", "Удача полурослика", "Везение полурослика"] },
  { sourceIds: ["XKAPPvPpS4b8rSFp"], identifiers: ["lets-try-that-again"], names: ["Let's Try That Again", "Давай попробуем ещё раз", "Попробуем ещё раз"] },
  { sourceIds: ["3aG0gkHulBIHqqGE"], identifiers: ["turn-back-the-clock"], names: ["Turn Back the Clock", "Повернуть время вспять", "Отмотать время"] },
  { sourceIds: ["cEu8BUS41dlPyPGW"], identifiers: ["spiritual-guides"], names: ["Spiritual Guides", "Духовные проводники", "Духи-проводники"] }
];

function pf2eSources(actor) {
  const out = [];
  const hp = actor.system?.resources?.heroPoints;
  if (hp) {
    out.push({
      id: "hero-point",
      label: "Очко героя",
      kind: "replace",
      hint: "Перебросить и взять новый результат.",
      counter: `${hp.value}/${hp.max}`,
      blocked: hp.value > 0 ? null : "Очков героя нет",
      spend: () => actor.update({ "system.resources.heroPoints.value": hp.value - 1 })
    });
  }
  PF2E_FORTUNE_FEATS.forEach((def, i) => {
    const feat = findItem(actor, { ...def, filter: it => it.type === "feat" });
    if (!feat) return;
    const fr = feat.system?.frequency;
    const value = fr ? (fr.value ?? fr.max) : null;
    out.push({
      id: `fortune-${i}`,
      label: feat.name,
      kind: "replace",
      hint: "Перебросить и взять новый результат.",
      counter: fr ? `${value}/${fr.max}` : null,
      blocked: fr && value < 1 ? "Уже использовано сегодня" : null,
      spend: fr ? () => feat.update({ "system.frequency.value": value - 1 }) : async () => {}
    });
  });
  return out;
}

/* ---------- общее ---------- */

/**
 * Список способов перебросить для текущего броска.
 * @param {Actor} actor
 * @param {{rolls: {n:number, active:boolean}[], used: string[]}} luck
 */
export function rerollOptions(actor, luck) {
  let list = isDnd5e() ? dnd5eSources(actor) : isPf2e() ? pf2eSources(actor) : [];
  const used = new Set(luck.used);
  const usedAdvantage = list.some(o => used.has(o.id) && o.kind === "advantage");
  const pf2eFortuneUsed = isPf2e() && used.size > 0;
  const hasLow = luck.rolls.some(r => r.active && r.n <= HALFLING_MAX);

  list = list.map(o => {
    let reason = o.blocked ?? null;
    if (!reason && used.has(o.id)) reason = "Уже использовано на этом броске";
    if (!reason && pf2eFortuneUsed) reason = "Только один эффект удачи на бросок";
    if (!reason && o.kind === "advantage" && usedAdvantage) reason = "Преимущество уже получено";
    if (!reason && o.needsLow && !hasLow) reason = `Нужно, чтобы выпало 1–${HALFLING_MAX}`;
    return { ...o, reason, available: !reason };
  }).filter(o => o.available || !o.hideWhenBlocked);

  if (setting("allowFreeReroll")) {
    list.push({
      id: "gm", label: "С разрешения мастера", kind: "extra",
      hint: "Без трат. Включается в настройках модуля.", counter: null,
      reason: null, available: true, spend: async () => {}
    });
  }
  return list;
}
