import { MODULE_ID } from "./const.mjs";
import { BagShop } from "./shop-app.mjs";

let shop = null;

/** Открыть лавку. Один экземпляр на клиента: если закрыть окно с рукой в мешке, при открытии всё сохранится. */
export function openShop() {
  shop ??= new BagShop();
  return shop.render({ force: true });
}

function rerender() {
  if (shop?.rendered) shop.render();
}

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });

  reg("priceBlind",  { name: "Цена: наугад",            type: Number, default: 5,  onChange: rerender });
  reg("priceLuck",   { name: "Цена: на удачу",          type: Number, default: 10, onChange: rerender });
  reg("priceFeel",   { name: "Цена: пощупать",          type: Number, default: 20, onChange: rerender });
  reg("priceChoose", { name: "Цена: пощупать и выбрать", type: Number, default: 50, onChange: rerender });

  reg("trackGold", {
    name: "Списывать золото",
    hint: "Если выключено, покупки бесплатные, а оплату вы ведёте вручную.",
    type: Boolean, default: true, onChange: rerender
  });
  reg("currencyPath", {
    name: "Путь к золоту на листе персонажа",
    hint: "Оставьте пустым: D&D 5e и PF2e определяются сами. Для другой системы укажите поле, например system.currency.gp.",
    type: String, default: "", onChange: rerender
  });
  reg("createItems", {
    name: "Класть предмет в инвентарь",
    hint: "Создаёт предмет на листе персонажа. Если выключено, результат появится только в чате.",
    type: Boolean, default: true
  });
  reg("itemType", {
    name: "Тип создаваемого предмета",
    hint: "Оставьте пустым: в D&D 5e будет loot, в PF2e equipment. Для другой системы укажите тип, который в ней есть.",
    type: String, default: ""
  });
  reg("allowFreeReroll", {
    name: "Переброс с разрешения мастера",
    hint: "Добавляет на бросок d100 один бесплатный переброс для всех. Для домашних правил и умений, которых модуль не знает.",
    type: Boolean, default: false, onChange: rerender
  });
  reg("showMissed", {
    name: "Показывать упущенное в чате",
    hint: "После вытаскивания на ощупь в чат пишется, что ещё побывало в руке.",
    type: Boolean, default: true
  });
  reg("showButton", {
    name: "Кнопка на панели токенов",
    hint: "Иконка мешка в левой панели инструментов (раздел токенов).",
    type: Boolean, default: true, requiresReload: true
  });

  game.modules.get(MODULE_ID).api = { open: openShop };
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.settings.get(MODULE_ID, "showButton")) return;
  const tool = {
    name: MODULE_ID,
    title: "Мешок чудес",
    icon: "fa-solid fa-sack-dollar",
    button: true,
    visible: true,
    onChange: () => openShop(),
    onClick: () => openShop() // для совместимости со старым форматом
  };

  // v13+: controls — объект, tools — объект.
  const tokens = controls.tokens ?? controls.token;
  if (tokens?.tools && !Array.isArray(tokens.tools)) {
    tool.order = Object.keys(tokens.tools).length;
    delete tool.onClick;
    tokens.tools[MODULE_ID] = tool;
    return;
  }
  // Старый формат: массив.
  if (Array.isArray(controls)) {
    const t = controls.find(c => c.name === "token");
    t?.tools.push(tool);
  }
});
