import { MODULE_ID, SAY, rand } from "./const.mjs";
import { ITEMS } from "./items.mjs";
import { getGold, spendGold, goldSourceLabel, itemType, rerollOptions, HALFLING_MAX } from "./systems.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const setting = key => game.settings.get(MODULE_ID, key);
const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

/** Предмет по номеру таблицы (1–100), со случайно выбранным описанием на ощупь. */
function itemByNumber(num) {
  const it = ITEMS[num - 1];
  return { ...it, num, touch: rand(it.t) };
}

/** Случайный номер, не входящий в exclude. */
function randomNumber(exclude = new Set()) {
  const free = ITEMS.map((_, i) => i + 1).filter(n => !exclude.has(n));
  return rand(free.length ? free : ITEMS.map((_, i) => i + 1));
}

export class BagShop extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "meshok-chudes",
    classes: ["meshok-chudes"],
    window: { title: "Мешок чудес", icon: "fa-solid fa-sack-dollar", resizable: true },
    position: { width: 580, height: "auto" },
    actions: {
      buy: BagShop.#onBuy,
      reroll: BagShop.#onReroll,
      takeRoll: BagShop.#onTakeRoll,
      feelNext: BagShop.#onFeelNext,
      pull: BagShop.#onPull,
      dismiss: BagShop.#onDismiss
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/shop.hbs`, scrollable: [""] }
  };

  actorId = null;
  luck = null;    // { rolls: [{ n, active, by }], used: [id умений] } — бросок оплачен, предмет ещё не выбран
  feel = null;    // { mode: "current" | "any", pool: [], felt: 0 }
  result = null;  // последний вытащенный предмет
  busy = false;
  say = rand(SAY.hello);

  /* ---------- данные ---------- */

  #availableActors() {
    const owned = game.actors.filter(a => a.isOwner);
    if (!game.user.isGM) return owned;
    const pcs = owned.filter(a => a.hasPlayerOwner || a.type === "character");
    return pcs.length ? pcs : owned;
  }

  #actor() {
    return game.actors.get(this.actorId) ?? null;
  }

  #prices() {
    return {
      blind: setting("priceBlind"),
      luck: setting("priceLuck"),
      feel: setting("priceFeel"),
      choose: setting("priceChoose")
    };
  }

  async _prepareContext(options) {
    const actors = this.#availableActors();
    if (!actors.some(a => a.id === this.actorId)) {
      const preferred = [game.user.character, globalThis.canvas?.tokens?.controlled?.[0]?.actor];
      this.actorId = preferred.find(a => a && actors.some(x => x.id === a.id))?.id ?? actors[0]?.id ?? null;
    }
    const actor = this.#actor();
    const track = setting("trackGold");
    const gold = track && actor ? getGold(actor) : null;
    const prices = this.#prices();
    const afford = p => !track || (gold ?? 0) >= p;
    const pending = !!this.feel || !!this.luck;
    const locked = this.busy || pending;
    const can = p => !!actor && !locked && afford(p);

    let feel = null;
    if (this.feel) {
      const { pool, felt, mode } = this.feel;
      feel = {
        hint: mode === "any"
          ? "Нащупайте до пяти предметов. Вытащить можно любой из нащупанных, но только один."
          : "Перебирайте по одному, до пяти. Вытащить можно только то, что сейчас в руке. Возьмётесь за следующее, и это уйдёт обратно в глубину.",
        lumps: pool.map((it, i) => {
          const current = i === felt - 1;
          const isFelt = i < felt;
          const released = isFelt && mode === "current" && !current;
          return {
            i, num: i + 1, touch: it.touch,
            released,
            fresh: current,
            isNext: i === felt,
            locked: i > felt,
            nextLabel: mode === "current" && felt > 0 ? "Отпустить и нащупать" : "Нащупать"
          };
        })
      };
    }

    let luck = null;
    if (this.luck && actor) {
      const { rolls } = this.luck;
      const activeCount = rolls.filter(r => r.active).length;
      const options = rerollOptions(actor, this.luck);
      luck = {
        rolls: rolls.map((r, i) => ({ i, n: r.n, active: r.active, by: r.by })),
        single: activeCount === 1,
        options: options.map(o => ({
          id: o.id, label: o.label, hint: o.hint, counter: o.counter,
          available: o.available && !this.busy, reason: o.reason
        })),
        hasOptions: options.length > 0
      };
    }

    return {
      actors: actors.map(a => ({ id: a.id, name: a.name, selected: a.id === this.actorId })),
      hasActor: !!actor,
      track,
      gold,
      goldKnown: gold !== null,
      goldSource: goldSourceLabel(),
      prices,
      can: {
        blind: can(prices.blind),
        luck: can(prices.luck),
        feel: can(prices.feel),
        choose: can(prices.choose)
      },
      locked,
      busy: this.busy,
      pending,
      feel,
      luck,
      result: this.result,
      say: this.say
    };
  }

  _onRender(context, options) {
    this.element.querySelector("[name=actor]")?.addEventListener("change", ev => {
      this.actorId = ev.target.value;
      this.render();
    });
  }

  /* ---------- деньги и выдача ---------- */

  async #pay(actor, price) {
    if (!setting("trackGold") || !price) return true;
    const gold = getGold(actor);
    if (gold === null) {
      ui.notifications.error(`Мешок чудес: не удалось узнать золото персонажа (${goldSourceLabel()}). Проверьте настройки модуля.`);
      return false;
    }
    if (gold < price) {
      this.say = rand(SAY.broke);
      ui.notifications.warn(`Не хватает золота. ${actor.name}: ${gold} зм, нужно ${price}.`);
      return false;
    }
    try {
      if (await spendGold(actor, price)) return true;
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
    }
    ui.notifications.error("Мешок чудес: не получилось списать золото. Подробности в консоли (F12).");
    return false;
  }

  async #rollD100(actor, flavor) {
    const roll = await new Roll("1d100").evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor });
    return roll.total;
  }

  async #give(actor, it, source, missed = []) {
    if (setting("createItems")) {
      const type = itemType();
      if (!type) {
        ui.notifications.warn("Мешок чудес: не знаю, каким типом создавать предмет в этой системе. Укажите тип в настройках. Пока предмет только в чате.");
      } else {
        const data = {
          name: it.n,
          type,
          img: "icons/svg/item-bag.svg",
          flags: { [MODULE_ID]: { num: it.num, source } }
        };
        foundry.utils.setProperty(data, "system.description.value",
          `<p>${it.d}</p><p><em>На ощупь: ${lowerFirst(it.touch)}</em></p><p>Из Мешка чудес, №${it.num}.</p>`);
        try {
          await actor.createEmbeddedDocuments("Item", [data]);
        } catch (err) {
          console.error(`${MODULE_ID} |`, err);
          ui.notifications.error("Мешок чудес: не удалось положить предмет в инвентарь. Подробности в консоли (F12).");
        }
      }
    }

    const missedHtml = missed.length && setting("showMissed")
      ? `<p class="mc-missed">В руке ещё побывали: ${missed.map(m => m.n).join(", ")}</p>`
      : "";
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="mc-chat">
        <div class="mc-src">Мешок чудес · ${source}</div>
        <h3>${it.n}</h3>
        <p>${it.d}</p>
        <p class="mc-touch">На ощупь: ${lowerFirst(it.touch)}</p>
        ${missedHtml}
      </div>`
    });

    this.result = {
      ...it,
      source,
      touchLower: lowerFirst(it.touch),
      missed: missed.map(m => m.n)
    };
    this.say = rand(SAY.done);
  }

  /* ---------- действия ---------- */

  async #run(fn) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } finally {
      this.busy = false;
      this.render();
    }
  }

  static async #onBuy(event, target) {
    if (this.feel || this.luck) return;
    const tier = target.dataset.tier;
    const actor = this.#actor();
    if (!actor) return ui.notifications.warn("Мешок чудес: выберите персонажа.");

    await this.#run(async () => {
      if (!(await this.#pay(actor, this.#prices()[tier]))) return;
      this.result = null;

      if (tier === "blind") {
        this.say = rand(SAY.blind);
        await this.#give(actor, itemByNumber(randomNumber()), "наугад");
      }
      else if (tier === "luck") {
        this.say = rand(SAY.luck);
        this.luck = { rolls: [], used: [] };
        const n = await this.#rollD100(actor, "Мешок чудес: бросок d100");
        this.luck.rolls.push({ n, active: true, by: null });
      }
      else if (tier === "feel" || tier === "choose") {
        this.say = rand(SAY.feel);
        const used = new Set();
        const pool = [];
        for (let i = 0; i < 5; i++) {
          const num = randomNumber(used);
          used.add(num);
          pool.push(itemByNumber(num));
        }
        this.feel = { mode: tier === "feel" ? "current" : "any", pool, felt: 0 };
      }
    });
  }

  static async #onReroll(event, target) {
    if (!this.luck) return;
    const actor = this.#actor();
    if (!actor) return ui.notifications.warn("Мешок чудес: выберите персонажа.");
    const opt = rerollOptions(actor, this.luck).find(o => o.id === target.dataset.source);
    if (!opt?.available) return ui.notifications.warn(`Мешок чудес: ${opt?.reason ?? "этим умением сейчас нельзя перебросить"}.`);

    await this.#run(async () => {
      try {
        await opt.spend();
      } catch (err) {
        console.error(`${MODULE_ID} |`, err);
        return ui.notifications.error("Мешок чудес: не удалось потратить умение. Подробности в консоли (F12).");
      }
      this.luck.used.push(opt.id);

      // «Заменить»: кость перебрасывается, старый результат больше нельзя взять.
      if (opt.kind === "replace") {
        const active = this.luck.rolls.filter(r => r.active);
        const target = opt.target === "low"
          ? active.find(r => r.n <= HALFLING_MAX)
          : active.at(-1);
        if (target) target.active = false;
      }

      this.say = rand(SAY.reroll);
      const n = await this.#rollD100(actor, `Мешок чудес: переброс d100 (${opt.label})`);
      this.luck.rolls.push({ n, active: true, by: opt.label });
    });
  }

  static async #onTakeRoll(event, target) {
    if (!this.luck) return;
    const actor = this.#actor();
    if (!actor) return ui.notifications.warn("Мешок чудес: выберите персонажа.");
    const roll = this.luck.rolls[Number(target.dataset.index)];
    if (!roll?.active) return;
    const n = roll.n;
    await this.#run(async () => {
      this.luck = null;
      await this.#give(actor, itemByNumber(n), `d100: ${n}`);
    });
  }

  static #onFeelNext() {
    if (!this.feel || this.busy || this.feel.felt >= this.feel.pool.length) return;
    this.feel.felt++;
    this.render();
  }

  static async #onPull(event, target) {
    if (!this.feel) return;
    const actor = this.#actor();
    if (!actor) return ui.notifications.warn("Мешок чудес: выберите персонажа.");
    const i = Number(target.dataset.index);
    const { pool, felt, mode } = this.feel;
    if (i >= felt || (mode === "current" && i !== felt - 1)) return;

    const it = pool[i];
    const missed = pool.slice(0, felt).filter((_, k) => k !== i);
    await this.#run(async () => {
      this.feel = null;
      await this.#give(actor, it, mode === "any" ? "пощупать и выбрать" : "пощупать", missed);
    });
  }

  static #onDismiss() {
    this.result = null;
    this.render();
  }
}
