(function () {
  "use strict";

  const CONFIG = repoConfig();
  const API = "https://api.github.com/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/data.json";
  const TOKEN_KEY = "wishlist-token";
  const TABS = [["all", "Все"], ["free", "Свободные"], ["want", "Ждут подарка"], ["gifted", "Подарено"], ["gone", "Не работают"]];
  const GUEST_DOMAIN = "@guest.narlemix.github.io";
  const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*[\p{L}\p{N}]$/u;
  const PRIORITIES = [[1, "Очень нужно"], [2, "Нужно"], [3, "Хочу"], [4, "Было бы приятно"], [5, "Когда-нибудь"]];
  const DEFAULT_PRIORITY = 3;
  const PLATFORMS = [
    [/(^|\.)ozon\.(ru|by|kz)$/, "Ozon"],
    [/(^|\.)(wildberries\.(ru|by|kz|am|uz)|wb\.ru)$/, "Wildberries"],
    [/(^|\.)market\.yandex\.(ru|by|kz)$/, "Яндекс Маркет"],
    [/(^|\.)aliexpress\.(ru|com|us)$/, "AliExpress"],
    [/(^|\.)avito\.ru$/, "Авито"],
    [/(^|\.)megamarket\.ru$/, "Мегамаркет"],
    [/(^|\.)lamoda\.(ru|by|kz)$/, "Lamoda"],
    [/(^|\.)dns-shop\.(ru|kz)$/, "DNS"],
    [/(^|\.)mvideo\.ru$/, "М.Видео"],
    [/(^|\.)eldorado\.ru$/, "Эльдорадо"],
    [/(^|\.)citilink\.ru$/, "Ситилинк"],
    [/(^|\.)goldapple\.(ru|by|kz)$/, "Золотое Яблоко"],
    [/(^|\.)letu\.ru$/, "Летуаль"],
    [/(^|\.)labirint\.ru$/, "Лабиринт"],
    [/(^|\.)chitai-gorod\.ru$/, "Читай-город"],
    [/(^|\.)litres\.ru$/, "Литрес"],
    [/(^|\.)detmir\.ru$/, "Детский мир"],
    [/(^|\.)sportmaster\.ru$/, "Спортмастер"],
    [/(^|\.)amazon\.[a-z.]+$/, "Amazon"],
    [/(^|\.)ebay\.[a-z.]+$/, "eBay"],
    [/(^|\.)store\.steampowered\.com$/, "Steam"],
    [/(^|\.)apple\.com$/, "Apple"]
  ];
  const WB_BASKETS = [[0, 1], [144, 2], [288, 3], [432, 4], [720, 5], [1008, 6], [1062, 7], [1116, 8], [1170, 9], [1314, 10],
    [1602, 11], [1656, 12], [1920, 13], [2046, 14], [2190, 15], [2406, 16], [2622, 17], [2838, 18], [3054, 19], [3270, 20],
    [3486, 21], [3702, 22], [3918, 23], [4134, 24], [4350, 25], [4566, 26], [4956, 27], [5267, 28], [5836, 30], [7074, 34],
    [7868, 36], [8344, 38], [8821, 39], [9617, 41], [10525, 42], [11194, 43], [12479, 44], [12752, 45]];
  const EXAMPLES = [
    { id: "x1", title: "Наушники Sony WH-1000XM5", url: "", platform: "Ozon", price: 32990, note: "чёрные", priority: 1, gifted: false, check: null },
    { id: "x2", title: "«Мастер и Маргарита», иллюстрированное издание", url: "", platform: "Лабиринт", price: 1450, note: "", priority: 4, gifted: false, check: { status: "gone", at: null, note: "Товар закончился" } },
    { id: "x3", title: "Термокружка Stanley, 470 мл", url: "", platform: "Wildberries", price: 3200, note: "", priority: 2, gifted: true, check: null }
  ];

  const app = document.getElementById("app");
  const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite", hidden: true });
  document.body.append(toastEl);

  let state = normalize({});
  let loaded = false;
  let loadFailed = false;
  let token = readToken();
  let sha = null;
  let canEdit = false;
  let editing = null;
  let renaming = false;
  let loggingIn = false;
  let busy = false;
  let saveTimer = null;
  let toastTimer = null;
  let filter = loadFilter();
  let prioFilter = loadPrioFilter();
  let prefill = readPrefill();
  const FB = initFirebase();
  let guest = null;
  let guestReady = !FB;
  let registering = false;
  let reservations = {};
  let reserving = {};
  let authMode = null;
  let pendingReserve = null;
  let guestAdmin = false;
  let confirmUnreserve = null;

  render();
  boot();
  bootGuests();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer) save();
  });

  /** Подключает Firebase, если на сайте заданы его настройки. */
  function initFirebase() {
    const cfg = window.WISHLIST_FIREBASE;
    if (!cfg || !cfg.apiKey || !window.firebase) return null;
    try {
      firebase.initializeApp(cfg);
      return { auth: firebase.auth(), db: firebase.firestore(), fv: firebase.firestore.FieldValue };
    } catch (e) {
      return null;
    }
  }

  /** Следит за входом гостя и за бронями в реальном времени. */
  function bootGuests() {
    if (!FB) return;
    FB.db.collection("reservations").onSnapshot((snap) => {
      const next = {};
      snap.forEach((d) => {
        const v = d.data() || {};
        if (v.uid && v.name) next[d.id] = { uid: String(v.uid), name: String(v.name) };
      });
      reservations = next;
      softRender();
    }, () => {});
    FB.auth.onAuthStateChanged(async (user) => {
      if (registering) return;
      guest = user ? await loadGuest(user) : null;
      guestAdmin = await checkAdmin(guest);
      guestReady = true;
      softRender();
    });
  }

  /** Профиль гостя из базы; без профиля вход не засчитывается. */
  async function loadGuest(user) {
    try {
      const doc = await FB.db.collection("users").doc(user.uid).get();
      const d = doc.exists ? doc.data() || {} : {};
      const name = String(d.name || "");
      return name ? { uid: user.uid, name: name, key: String(d.key || name.toLowerCase()) } : null;
    } catch (e) {
      return null;
    }
  }

  /** Есть ли у гостя права администратора броней (документ admins/<имя>). */
  async function checkAdmin(g) {
    if (!g || !FB) return false;
    try {
      return (await FB.db.collection("admins").doc(g.key).get()).exists;
    } catch (e) {
      return false;
    }
  }

  /** Перерисовка, которая не сбрасывает открытую форму. */
  function softRender() {
    if (editing || renaming || authMode || loggingIn) return;
    render();
  }

  /** Загружает список: владельцу свежий из GitHub, остальным с сайта. */
  async function boot() {
    if (token) {
      try {
        await loadRemote();
        canEdit = true;
      } catch (e) {
        if (e.status === 401) {
          dropToken();
          showToast("Токен больше не действует. Войди заново", 6000);
        }
      }
    }
    if (!canEdit) {
      try {
        await loadPublic();
      } catch (e) {
        loadFailed = true;
      }
    }
    loaded = true;
    if (prefill) {
      if (canEdit) editing = "new";
      else {
        loggingIn = true;
        showToast("Войди, чтобы добавить товар в список", 5000);
      }
    }
    render();
  }

  /** Данные товара из кнопки «В вишлист» или из «Поделиться» на телефоне. */
  function readPrefill() {
    const q = new URLSearchParams(location.search);
    const shared = q.has("text") || q.has("url");
    if (q.get("add") !== "1" && !shared) return null;
    try {
      history.replaceState(null, "", location.pathname);
    } catch (e) {}
    const text = q.get("text") || "";
    const url = cleanUrl(q.get("url") || "") || cleanUrl((text.match(/https?:\/\/\S+/) || [""])[0]);
    let title = (q.get("title") || "").trim();
    if (!title || cleanUrl(title) === url) {
      title = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
      const cut = title.match(/^[^:]{0,60}(?:ozon|wildberries|маркет|aliexpress|посмотр|наш[её]л)[^:]*:\s*(.{4,})$/i);
      if (cut) title = cut[1];
    }
    const price = q.get("price") ? parsePrice(q.get("price")) : null;
    const old = q.get("old") ? parsePrice(q.get("old")) : null;
    return {
      url: url,
      title: title.slice(0, 140),
      price: price ? price : null,
      priceOld: old && price && old > price ? old : null
    };
  }

  /** Читает data.json, опубликованный на сайте. */
  async function loadPublic() {
    const r = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw httpError(r);
    state = normalize(await r.json());
  }

  /** Читает data.json напрямую из репозитория вместе с его версией. */
  async function loadRemote() {
    const r = await gh("GET", API + "?ref=" + encodeURIComponent(CONFIG.branch));
    if (!r.ok) throw httpError(r);
    const j = await r.json();
    state = normalize(JSON.parse(fromB64(j.content)));
    sha = j.sha;
  }

  /** Сохраняет список коммитом в репозиторий. */
  async function save(isRetry) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!canEdit || !token) return;
    if (busy) {
      saveTimer = setTimeout(save, 600);
      return;
    }
    busy = true;
    const retry = { label: "Сохранить", fn: () => save() };
    showToast("Сохраняю…");
    try {
      const r = await gh("PUT", API, { message: "Обновление вишлиста", content: toB64(serialize(state)), sha: sha || undefined, branch: CONFIG.branch });
      if (r.ok) {
        sha = (await r.json()).content.sha;
        showToast("Сохранено. У друзей обновится примерно через минуту", 3500);
      } else if ((r.status === 409 || r.status === 422) && !isRetry) {
        await mergeRemote();
        if (editing === null && !renaming) render();
        busy = false;
        await save(true);
        return;
      } else if (r.status === 401) {
        dropToken();
        canEdit = false;
        editing = null;
        render();
        showToast("Токен больше не действует. Войди заново", 0, { label: "Войти", fn: openLogin });
      } else if (r.status === 403 || r.status === 404) {
        showToast("У токена нет права записи. Нужен доступ Contents: Read and write к репозиторию " + CONFIG.repo, 0, retry);
      } else {
        showToast("Не получилось сохранить, ошибка GitHub " + r.status, 0, retry);
      }
    } catch (e) {
      showToast("Не получилось сохранить. Проверь интернет", 0, retry);
    } finally {
      busy = false;
    }
  }

  /** Подтягивает свежие результаты проверки ссылок поверх локальных правок. */
  async function mergeRemote() {
    const local = state;
    await loadRemote();
    const remote = new Map(state.items.map((i) => [i.id, i]));
    local.items.forEach((i) => {
      const r = remote.get(i.id);
      if (r && r.url === i.url) {
        i.check = r.check;
        if (!i.title && r.title) i.title = r.title;
        if (r.priceAt && r.priceAt !== i.priceAt) {
          Object.assign(i, { price: r.price, priceOld: r.priceOld, priceAt: r.priceAt, pricePrev: r.pricePrev, priceChangedAt: r.priceChangedAt });
        }
      }
    });
    local.checkedAt = state.checkedAt || local.checkedAt;
    state = local;
  }

  /** Откладывает сохранение, чтобы собрать несколько отметок в один коммит. */
  function queueSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, delay);
  }

  /** Запрос к GitHub API с токеном владельца. */
  function gh(method, url, body) {
    const headers = { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" };
    if (body) headers["Content-Type"] = "application/json";
    return fetch(url, { method: method, cache: "no-store", headers: headers, body: body ? JSON.stringify(body) : undefined });
  }

  /** Ошибка с HTTP-статусом ответа. */
  function httpError(r) {
    const e = new Error("HTTP " + r.status);
    e.status = r.status;
    return e;
  }

  /** Владелец и репозиторий по адресу страницы. */
  function repoConfig() {
    const host = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    if (host && seg && !/\.html?$/i.test(seg)) return { owner: host[1], repo: seg, branch: "main" };
    return { owner: "Narlemix", repo: "wishlist", branch: "main" };
  }

  /** Приводит данные к ожидаемой форме. */
  function normalize(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const items = Array.isArray(s.items) ? s.items : [];
    return {
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim().slice(0, 80) : "Мой вишлист",
      checkedAt: typeof s.checkedAt === "string" ? s.checkedAt : null,
      items: items.filter((i) => i && i.id && (i.title || i.url)).map((i) => ({
        id: String(i.id),
        title: String(i.title || "").trim().slice(0, 140),
        url: cleanUrl(i.url),
        platform: String(i.platform || "").slice(0, 40),
        price: typeof i.price === "number" && isFinite(i.price) ? i.price : null,
        priceOld: typeof i.priceOld === "number" && isFinite(i.priceOld) && typeof i.price === "number" && i.priceOld > i.price ? i.priceOld : null,
        priceAt: typeof i.priceAt === "string" ? i.priceAt : null,
        pricePrev: typeof i.pricePrev === "number" && isFinite(i.pricePrev) ? i.pricePrev : null,
        priceChangedAt: typeof i.priceChangedAt === "string" ? i.priceChangedAt : null,
        note: String(i.note || "").slice(0, 200),
        priority: PRIORITIES.some(([p]) => p === i.priority) ? i.priority : DEFAULT_PRIORITY,
        gifted: !!i.gifted,
        giftedAt: typeof i.giftedAt === "string" ? i.giftedAt : null,
        addedAt: typeof i.addedAt === "string" ? i.addedAt : null,
        check: i.check && ["ok", "gone", "unknown"].includes(i.check.status)
          ? { status: i.check.status, at: typeof i.check.at === "string" ? i.check.at : null, note: String(i.check.note || "").slice(0, 120) }
          : null
      })).filter((i) => i.title || i.url)
    };
  }

  /** Перерисовывает страницу целиком. */
  function render() {
    document.title = loaded ? state.title : "Вишлист";
    let tabsNode = null;
    let listNode;
    if (!loaded) {
      listNode = el("p", { class: "empty-filter" }, "Загружаю список…");
    } else if (loadFailed) {
      listNode = el("p", { class: "empty-filter" }, "Не получилось загрузить список. Обнови страницу через минуту.");
    } else if (state.items.length) {
      tabsNode = el("div", { class: "filters" }, tabs(), prioFilterRow());
      const items = visibleItems();
      listNode = items.length
        ? el("ul", { class: "list" }, items.map((i) => row(i, false)))
        : el("div", { class: "empty-filter" },
          el("span", null, "Здесь пусто"),
          prioFilter ? el("button", { type: "button", class: "foot-btn", onclick: () => setPrioFilter(0) }, "Показать любую важность") : null);
    } else {
      listNode = editing === "new" ? null : emptyState();
    }
    app.replaceChildren(...[
      canEdit ? cabinetBar() : null,
      header(),
      loggingIn && !canEdit ? loginPanel() : null,
      authMode ? authPanel() : null,
      editing === "new" ? form(null) : null,
      tabsNode,
      listNode,
      loaded ? footer() : null
    ].filter(Boolean));
  }

  /** Полоса кабинета владельца над страницей. */
  function cabinetBar() {
    return el("div", { class: "cabinet-bar" },
      el("span", { class: "cabinet-title" }, "Кабинет владельца"),
      el("span", { class: "cabinet-text" }, "Здесь ты добавляешь, меняешь и удаляешь товары и отмечаешь подаренное. Гости видят список и могут только забронировать подарок."),
      el("button", { type: "button", class: "cabinet-out", onclick: logout }, "Выйти"),
      FB ? cabinetBookings() : null);
  }

  /** Строка кабинета про управление чужими бронями. */
  function cabinetBookings() {
    if (!guestReady) return null;
    if (guest && guestAdmin) {
      return el("span", { class: "cabinet-sub" },
        "Брони: ты вошёл как " + guest.name + " и можешь снимать любые. ",
        el("button", { type: "button", class: "cabinet-link", onclick: guestLogout }, "Выйти из аккаунта"));
    }
    if (guest) {
      return el("span", { class: "cabinet-sub" },
        "Брони: аккаунт " + guest.name + " не назначен администратором, поэтому снимать чужие брони нельзя. ",
        el("button", { type: "button", class: "cabinet-link", onclick: guestLogout }, "Выйти из аккаунта"));
    }
    return el("span", { class: "cabinet-sub" },
      "Чтобы снимать чужие брони, войди своим аккаунтом гостя. ",
      el("button", { type: "button", class: "cabinet-link", onclick: () => openAuth("login") }, "Войти"));
  }

  /** Шапка: название списка, сводка и кнопки владельца или гостя. */
  function header() {
    return el("header", { class: "head" },
      el("div", { class: "head-text" },
        el("div", { class: "ribbon", "aria-hidden": "true" }, [1, 2, 3, 4, 5].map((p) => el("i", { class: "p" + p }))),
        titleNode(), el("p", { class: "summary" }, loaded ? summaryText() : " ")),
      headerActions());
  }

  /** Кнопки справа в шапке. */
  function headerActions() {
    if (canEdit) {
      return editing !== "new" ? el("button", { type: "button", class: "btn", onclick: () => openForm("new") }, "Добавить") : null;
    }
    if (!FB || !guestReady) return null;
    if (guest) {
      return el("div", { class: "who" },
        el("span", { class: "who-name" }, guest.name),
        el("button", { type: "button", class: "link-btn", onclick: guestLogout }, "Выйти"));
    }
    if (authMode) return null;
    return el("div", { class: "who" },
      el("button", { type: "button", class: "btn ghost", onclick: () => openAuth("login") }, "Войти"),
      el("button", { type: "button", class: "btn", onclick: () => openAuth("register") }, "Регистрация"));
  }

  /** Заголовок, который владелец может переименовать. */
  function titleNode() {
    if (!loaded) return el("h1", { class: "h1" }, " ");
    if (canEdit && renaming) {
      const inp = el("input", { id: "f-name", class: "rename", type: "text", maxlength: "80", "aria-label": "Название списка" });
      inp.value = state.title;
      const finish = (commit) => {
        if (!renaming) return;
        renaming = false;
        const v = inp.value.trim();
        if (commit && v && v !== state.title) {
          state.title = v;
          render();
          save();
        } else {
          render();
        }
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") finish(false);
      });
      inp.addEventListener("blur", () => finish(true));
      focusLater(inp, true);
      return el("h1", { class: "h1" }, inp);
    }
    if (canEdit) {
      return el("h1", { class: "h1" },
        el("button", { type: "button", class: "h1-btn", title: "Переименовать", onclick: () => { renaming = true; editing = null; render(); } }, state.title));
    }
    return el("h1", { class: "h1" }, state.title);
  }

  /** Строка сводки под заголовком. */
  function summaryText() {
    const all = state.items.length;
    if (!all) return "Пока пусто";
    const gifted = state.items.filter((i) => i.gifted).length;
    const rest = state.items.filter((i) => !i.gifted && i.price != null).reduce((a, i) => a + i.price, 0);
    const parts = [all + " " + plural(all, ["желание", "желания", "желаний"])];
    if (gifted) parts.push("подарено " + gifted);
    const reserved = state.items.filter((i) => !i.gifted && reservations[i.id]).length;
    if (reserved) parts.push("забронировано " + reserved);
    if (rest) parts.push((gifted ? "осталось на " : "на ") + fmtPrice(rest));
    return parts.join(" · ");
  }

  /** Вкладки-фильтры с количеством. */
  function tabs() {
    const counts = {
      all: state.items.length,
      free: state.items.filter((i) => !i.gifted && !reservations[i.id]).length,
      want: state.items.filter((i) => !i.gifted).length,
      gifted: state.items.filter((i) => i.gifted).length,
      gone: state.items.filter(isGone).length
    };
    if ((filter === "gone" && !counts.gone) || (filter === "free" && !FB)) filter = "all";
    return el("div", { class: "tabs", role: "tablist", "aria-label": "Фильтр списка" },
      TABS.filter(([k]) => (k !== "gone" || counts.gone) && (k !== "free" || FB)).map(([k, label]) =>
        el("button", {
          type: "button",
          role: "tab",
          class: "tab" + (k === "gone" ? " tab-gone" : ""),
          "aria-selected": filter === k ? "true" : "false",
          onclick: () => { filter = k; storeFilter(); render(); }
        }, label, el("span", { class: "n" }, String(counts[k])))));
  }

  /** Товары текущего фильтра: сначала по важности, подаренные в конце. */
  function visibleItems() {
    return state.items
      .slice()
      .sort((a, b) => {
        if (a.gifted !== b.gifted) return a.gifted ? 1 : -1;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return String(b.addedAt || "").localeCompare(String(a.addedAt || ""));
      })
      .filter(matchesTab)
      .filter((i) => !prioFilter || i.priority === prioFilter);
  }

  /** Подходит ли товар под выбранную вкладку. */
  function matchesTab(i) {
    return filter === "all" || (filter === "free" && !i.gifted && !reservations[i.id]) || (filter === "want" && !i.gifted)
      || (filter === "gifted" && i.gifted) || (filter === "gone" && isGone(i));
  }

  /** Ряд фильтров по важности с количеством товаров в текущей вкладке. */
  function prioFilterRow() {
    const inTab = state.items.filter(matchesTab);
    const chip = (p, label, n) => el("button", {
      type: "button",
      class: "pf" + (p ? " p" + p : ""),
      "aria-pressed": prioFilter === p ? "true" : "false",
      disabled: !n && prioFilter !== p,
      onclick: () => setPrioFilter(prioFilter === p ? 0 : p)
    }, p ? prioBars(p) : null, label, el("span", { class: "n" }, String(n)));
    return el("div", { class: "prio-filter", role: "group", "aria-label": "Фильтр по важности" },
      chip(0, "Любая важность", inTab.length),
      PRIORITIES.map(([p, label]) => chip(p, label, inTab.filter((i) => i.priority === p).length)));
  }

  /** Включает фильтр по важности (0 — показывать всё). */
  function setPrioFilter(p) {
    prioFilter = p;
    try {
      localStorage.setItem("wishlist-prio", String(p));
    } catch (e) {}
    render();
  }

  /** Восстанавливает выбранный фильтр по важности. */
  function loadPrioFilter() {
    try {
      const v = Number(localStorage.getItem("wishlist-prio"));
      return PRIORITIES.some(([p]) => p === v) ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  /** Одна строка списка. */
  function row(item, preview) {
    if (!preview && editing === item.id) return el("li", { class: "item is-editing" }, form(item));
    const interactive = canEdit && !preview;
    const platform = item.platform || detectPlatform(item.url);
    const gift = canEdit || preview ? el("button", {
      type: "button",
      class: "gift",
      "aria-pressed": item.gifted ? "true" : "false",
      "aria-label": item.gifted ? "Подарено, снять отметку" : "Отметить как подаренное",
      title: interactive ? (item.gifted ? "Снять отметку" : "Отметить как подаренное") : null,
      disabled: !interactive,
      onclick: () => toggleGift(item.id)
    }) : null;
    const label = item.title || (platform ? "Товар с " + platform : "Товар по ссылке");
    const nameCls = "name" + (item.title ? "" : " name-pending");
    const name = item.url
      ? el("a", { class: nameCls, href: item.url, target: "_blank", rel: "noopener noreferrer" }, label)
      : el("span", { class: nameCls }, label);
    const waitText = !item.gifted && item.url && item.price == null
      ? (item.title ? "цена — после проверки" : "название и цена — после проверки")
      : !item.gifted && !item.title ? "название — после проверки" : "";
    const meta = el("div", { class: "meta" },
      priorityChip(item.priority),
      platform ? el("span", { class: "platform" }, platform) : null,
      item.gifted ? el("span", { class: "mark gifted" }, "Подарено") : statusMark(item, preview),
      preview ? null : reservationMark(item),
      item.note ? el("span", { class: "note" }, item.note) : null);
    return el("li", { class: "item p" + item.priority + (item.gifted ? " is-gifted" : "") + (isGone(item) ? " is-gone" : "") + (gift ? "" : " no-gift") },
      gift,
      el("div", { class: "body" }, name, meta),
      el("div", { class: "side" },
        item.price != null
          ? el("span", { class: "price", title: item.priceAt ? "Цена со скидкой, с маркетплейса на " + fmtDate(item.priceAt, true) : null }, fmtPrice(item.price))
          : el("span", { class: "price" }, ""),
        interactive && waitText ? el("span", { class: "price-wait" }, waitText) : null,
        priceOldLine(item),
        priceDelta(item),
        interactive ? el("button", { type: "button", class: "link-btn", onclick: () => openForm(item.id) }, "Изменить") : null,
        preview ? null : guestAction(item)));
  }

  /** Плашка брони: кто собирается подарить этот товар. */
  function reservationMark(item) {
    const r = reservations[item.id];
    if (!r) return null;
    if (item.gifted) return el("span", { class: "mark res" }, "Подарок от " + r.name);
    if (guest && r.uid === guest.uid && !canEdit) return el("span", { class: "mark res-mine" }, "Ты даришь это");
    return el("span", { class: "mark res" }, "Хочет подарить " + r.name);
  }

  /** Кнопка гостя: забронировать подарок или отменить свою бронь. */
  function guestAction(item) {
    if (canEdit) return ownerBookingAction(item);
    if (!FB || item.gifted) return null;
    const r = reservations[item.id];
    if (reserving[item.id]) return el("span", { class: "res-wait" }, "Секунду…");
    if (!r) return el("button", { type: "button", class: "btn sm reserve", onclick: () => reserve(item.id) }, "Подарю я");
    if (guest && r.uid === guest.uid) return el("button", { type: "button", class: "link-btn", onclick: () => unreserve(item.id) }, "Отменить бронь");
    return null;
  }

  /** Цена без скидки, зачёркнутая, и размер скидки. */
  function priceOldLine(item) {
    if (item.price == null || item.priceOld == null || item.priceOld <= item.price) return null;
    const pct = Math.round((1 - item.price / item.priceOld) * 100);
    return el("span", { class: "price-old-line", title: "Цена без скидки" },
      el("s", { class: "price-old" }, fmtPrice(item.priceOld)),
      pct > 0 ? el("span", { class: "discount" }, "−" + pct + "%") : null);
  }

  /** Бейдж изменения цены за последние 30 дней. */
  function priceDelta(item) {
    if (item.gifted || item.price == null || item.pricePrev == null || item.pricePrev === item.price || !item.priceChangedAt) return null;
    const when = new Date(item.priceChangedAt).getTime();
    if (!isFinite(when) || Date.now() - when > 30 * 864e5) return null;
    const diff = item.price - item.pricePrev;
    return el("span", {
      class: "delta " + (diff < 0 ? "down" : "up"),
      title: "Было " + fmtPrice(item.pricePrev) + ", цена изменилась " + fmtDate(item.priceChangedAt, false)
    }, (diff < 0 ? "↓ " : "↑ ") + fmtPrice(Math.abs(diff)));
  }

  /** Метка важности: шкала из пяти делений и подпись. */
  function priorityChip(level) {
    const label = (PRIORITIES.find(([p]) => p === level) || PRIORITIES[DEFAULT_PRIORITY - 1])[1];
    return el("span", { class: "prio prio-" + level, title: "Важность: " + label.toLowerCase() }, prioBars(level), label);
  }

  /** Шкала из пяти делений: чем важнее, тем больше закрашено. */
  function prioBars(level) {
    return el("span", { class: "prio-bars", "aria-hidden": "true" },
      [1, 2, 3, 4, 5].map((n) => el("i", { class: n <= 6 - level ? "on" : null })));
  }

  /** Пометка о результате проверки ссылки. */
  function statusMark(item, preview) {
    const c = item.check;
    if (!c) return null;
    if (c.status === "gone") {
      return el("span", { class: "mark gone", title: c.at ? "Проверено " + fmtDate(c.at, true) : null }, c.note || "Ссылка не работает");
    }
    if (c.status === "unknown" && canEdit && !preview) {
      return el("span", { class: "mark unknown", title: c.note || null }, "не удалось проверить");
    }
    return null;
  }

  /** Пустое состояние с примером того, как выглядит список. */
  function emptyState() {
    if (!canEdit) return el("div", { class: "empty" }, el("p", { class: "empty-title" }, "Здесь пока ничего нет"));
    return el("div", { class: "empty" },
      el("p", { class: "empty-title" }, "Список пока пуст"),
      el("p", { class: "empty-text" }, "Нажми «Добавить» и вставь ссылку на товар. Площадка определится по ссылке, цену и заметку можно указать по желанию."),
      el("p", { class: "eyebrow" }, "Пример"),
      el("ul", { class: "list ghost", "aria-hidden": "true" }, EXAMPLES.map((i) => row(i, true))));
  }

  /** Подвал: время проверки ссылок и вход для владельца. */
  function footer() {
    const last = state.checkedAt
      ? "Последняя проверка: " + fmtDate(state.checkedAt, true) + "."
      : "Первой проверки ещё не было.";
    let action = null;
    if (canEdit) action = el("button", { type: "button", class: "foot-btn", onclick: logout }, "Выйти из кабинета");
    else if (!loggingIn) action = el("button", { type: "button", class: "foot-btn", onclick: openLogin }, "Кабинет владельца");
    return el("footer", { class: "foot" },
      FB && !canEdit ? el("p", { class: "foot-lead" }, "Хочешь что-то подарить? Войди и нажми «Подарю я» у товара: бронь увидят все, и никто не купит этот подарок второй раз.") : null,
      el("p", null, "Цены и карточки товаров обновляются каждый день в 18:52 по Москве. " + last),
      canEdit ? quickAdd() : null,
      action ? el("p", { class: "foot-actions" }, action) : null);
  }

  /** Блок с кнопкой для закладок, которая добавляет товар со страницы магазина. */
  function quickAdd() {
    const bm = el("a", { class: "bm", href: bookmarkletHref(), title: "Перетащи на панель закладок" }, "＋ В вишлист");
    bm.addEventListener("click", (e) => {
      e.preventDefault();
      showToast("Эту кнопку нужно перетащить на панель закладок браузера", 4000);
    });
    return el("div", { class: "quick" },
      el("p", { class: "quick-title" }, "Быстрое добавление со страницы магазина"),
      el("p", { class: "quick-text" },
        "Перетащи кнопку ", bm, " на панель закладок браузера. На странице товара в Ozon, Wildberries, Яндекс Маркете и других магазинах нажми её: название, обе цены и ссылка сами подставятся в форму."),
      el("p", { class: "quick-text" }, "На Android установи этот сайт как приложение (меню браузера → «Добавить на главный экран»), и в «Поделиться» у товара появится «Вишлист»."));
  }

  /** Форма входа по токену GitHub. */
  function loginPanel() {
    const f = field("f-token", "Токен GitHub", "", "github_pat_…", { type: "password", autocomplete: "off", spellcheck: "false" });
    const submit = el("button", { type: "submit", class: "btn" }, "Войти");
    const node = el("form", { class: "form", novalidate: true, "aria-label": "Кабинет владельца" },
      el("div", { class: "form-head" },
        el("p", { class: "form-title" }, "Кабинет владельца"),
        el("p", { class: "form-text" }, "Вставь свой токен GitHub. Он хранится только в этом браузере.")),
      f.wrap,
      el("div", { class: "actions" },
        submit,
        el("button", { type: "button", class: "btn ghost", onclick: () => { loggingIn = false; render(); } }, "Отмена")));
    node.addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = f.input.value.trim();
      if (!t) {
        setErr(f, "Вставь токен");
        return;
      }
      submit.disabled = true;
      token = t;
      try {
        await loadRemote();
        storeToken(t);
        canEdit = true;
        loggingIn = false;
        loadFailed = false;
        if (prefill) editing = "new";
        render();
        showToast("Ты в кабинете владельца", 2500);
      } catch (err) {
        token = null;
        submit.disabled = false;
        setErr(f, err.status === 401 ? "GitHub не принял токен. Проверь, что он скопирован целиком"
          : err.status === 404 ? "Токен не видит репозиторий " + CONFIG.owner + "/" + CONFIG.repo
          : "Не получилось проверить токен. Проверь интернет");
      }
    });
    focusLater(f.input);
    return node;
  }

  /** Форма входа и регистрации гостя. */
  function authPanel() {
    const isReg = authMode === "register";
    const name = field("f-gname", "Имя", "", "Как тебя зовут друзья", { maxlength: "20", autocomplete: "username", spellcheck: "false" });
    const pass = field("f-gpass", "Пароль", "", isReg ? "Не короче 6 символов" : "", { type: "password", autocomplete: isReg ? "new-password" : "current-password" });
    const pass2 = isReg ? field("f-gpass2", "Пароль ещё раз", "", "", { type: "password", autocomplete: "new-password" }) : null;
    const ok = el("p", { class: "hint", hidden: true });
    name.wrap.append(ok);
    const submit = el("button", { type: "submit", class: "btn" }, isReg ? "Зарегистрироваться" : "Войти");
    let checkTimer = null;
    if (isReg) {
      name.input.addEventListener("input", () => {
        ok.hidden = true;
        setErr(name, "");
        clearTimeout(checkTimer);
        checkTimer = setTimeout(async () => {
          const n = cleanName(name.input.value);
          if (!NAME_RE.test(n) || n.length < 2) return;
          const taken = await nameTaken(n);
          if (cleanName(name.input.value) !== n) return;
          if (taken) setErr(name, "Это имя уже занято, выбери другое");
          else if (taken === false) {
            ok.textContent = "Имя свободно";
            ok.hidden = false;
          }
        }, 400);
      });
    }
    const node = el("form", { class: "form", novalidate: true, "aria-label": isReg ? "Регистрация" : "Вход" },
      el("div", { class: "auth-tabs", role: "tablist" },
        el("button", { type: "button", role: "tab", class: "auth-tab", "aria-selected": isReg ? "false" : "true", onclick: () => openAuth("login") }, "Вход"),
        el("button", { type: "button", role: "tab", class: "auth-tab", "aria-selected": isReg ? "true" : "false", onclick: () => openAuth("register") }, "Регистрация")),
      pendingReserve ? el("p", { class: "form-text" }, "Войди или зарегистрируйся, и подарок сразу забронируется за тобой.") : null,
      name.wrap, pass.wrap, pass2 ? pass2.wrap : null,
      isReg ? el("p", { class: "form-text" }, "Имя увидят все, кто откроет список. Почта не нужна, поэтому восстановить пароль не получится: запомни его.") : null,
      el("div", { class: "actions" },
        submit,
        el("button", { type: "button", class: "btn ghost", onclick: closeAuth }, "Отмена")));
    node.addEventListener("submit", async (e) => {
      e.preventDefault();
      const n = cleanName(name.input.value);
      const pw = pass.input.value;
      setErr(name, n.length < 2 || n.length > 20 ? "Имя должно быть от 2 до 20 символов"
        : !NAME_RE.test(n) ? "Можно буквы, цифры, пробел, точку, дефис и подчёркивание" : "");
      setErr(pass, pw.length < 6 ? "Пароль должен быть не короче 6 символов" : "");
      if (pass2) setErr(pass2, pass2.input.value !== pw ? "Пароли не совпадают" : "");
      const bad = [name, pass, pass2].filter(Boolean).find((x) => !x.err.hidden);
      if (bad) {
        bad.input.focus();
        return;
      }
      submit.disabled = true;
      try {
        if (isReg) await registerGuest(n, pw);
        else await loginGuest(n, pw);
        authMode = null;
        guestAdmin = await checkAdmin(guest);
        render();
        showToast("Привет, " + guest.name + "!", 2500);
        if (pendingReserve) {
          const id = pendingReserve;
          pendingReserve = null;
          reserve(id);
        }
      } catch (err) {
        submit.disabled = false;
        const code = err && err.code;
        if (code === "name-taken") setErr(name, "Это имя уже занято, выбери другое");
        else if (code === "timeout") setErr(pass, "Сервер не отвечает. Проверь интернет или попробуй без VPN");
        else if (code === "permission-denied" || code === "profile-failed") setErr(pass, "База не приняла профиль (" + code + "). Напиши владельцу списка");
        else if (code === "auth/operation-not-allowed" || code === "auth/configuration-not-found") setErr(pass, "Вход на сайте пока не включён. Напиши владельцу списка");
        else if (code === "auth/too-many-requests") setErr(pass, "Слишком много попыток. Подожди пару минут");
        else if (code === "auth/network-request-failed" || code === "unavailable") setErr(pass, "Нет связи с сервером. Проверь интернет");
        else if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-login-credentials") setErr(pass, "Неверное имя или пароль");
        else setErr(pass, (isReg ? "Не получилось зарегистрироваться" : "Не получилось войти") + (code ? " (" + code + ")" : "") + ". Попробуй ещё раз");
      }
    });
    focusLater(name.input);
    return node;
  }

  /** Открывает вход или регистрацию гостя. */
  function openAuth(mode) {
    authMode = mode;
    loggingIn = false;
    render();
  }

  /** Закрывает форму гостя. */
  function closeAuth() {
    authMode = null;
    pendingReserve = null;
    render();
  }

  /** Регистрирует гостя с уникальным именем. */
  async function registerGuest(name, pw) {
    const key = name.toLowerCase();
    if (await nameTaken(name)) throw { code: "name-taken" };
    registering = true;
    try {
      const email = await nameEmail(key);
      let cred;
      try {
        cred = await withTimeout(FB.auth.createUserWithEmailAndPassword(email, pw));
      } catch (e) {
        if (!e || e.code !== "auth/email-already-in-use") throw e;
        try {
          cred = await withTimeout(FB.auth.signInWithEmailAndPassword(email, pw));
        } catch (x) {
          throw { code: "name-taken" };
        }
      }
      guest = await ensureProfile(cred.user, name);
      guestReady = true;
    } finally {
      registering = false;
    }
  }

  /** Кнопка владельца: снять чужую бронь с подтверждением. */
  function ownerBookingAction(item) {
    const r = reservations[item.id];
    if (!FB || !r || !guestAdmin) return null;
    if (reserving[item.id]) return el("span", { class: "res-wait" }, "Секунду…");
    if (confirmUnreserve === item.id) {
      return el("span", { class: "confirm" },
        el("button", { type: "button", class: "link-btn danger", onclick: () => { confirmUnreserve = null; unreserve(item.id); } }, "Да, снять"),
        el("button", { type: "button", class: "link-btn", onclick: () => { confirmUnreserve = null; render(); } }, "Нет"));
    }
    return el("button", { type: "button", class: "link-btn", onclick: () => { confirmUnreserve = item.id; render(); } }, "Снять бронь");
  }

  /** Входит гостем по имени и паролю; аккаунт без профиля достраивает. */
  async function loginGuest(name, pw) {
    registering = true;
    try {
      const cred = await withTimeout(FB.auth.signInWithEmailAndPassword(await nameEmail(name.toLowerCase()), pw));
      guest = await ensureProfile(cred.user, name);
      guestReady = true;
    } finally {
      registering = false;
    }
  }

  /** Возвращает профиль гостя, при необходимости создавая его в базе. */
  async function ensureProfile(user, name) {
    const existing = await loadGuest(user);
    if (existing) return existing;
    const key = name.toLowerCase();
    const owner = await withTimeout(FB.db.collection("usernames").doc(key).get());
    if (owner.exists && (owner.data() || {}).uid !== user.uid) {
      await FB.auth.signOut();
      throw { code: "name-taken" };
    }
    const batch = FB.db.batch();
    batch.set(FB.db.collection("users").doc(user.uid), { name: name, key: key, createdAt: FB.fv.serverTimestamp() });
    if (!owner.exists) batch.set(FB.db.collection("usernames").doc(key), { uid: user.uid });
    try {
      await withTimeout(batch.commit());
    } catch (e) {
      await FB.auth.signOut();
      throw e && e.code ? e : { code: "profile-failed" };
    }
    return { uid: user.uid, name: name, key: key };
  }

  /** Обрывает зависшую операцию с базой через 15 секунд. */
  function withTimeout(promise) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej({ code: "timeout" }), 15000))]);
  }

  /** Выходит из аккаунта гостя. */
  async function guestLogout() {
    try {
      await FB.auth.signOut();
    } catch (e) {}
    guest = null;
    guestAdmin = false;
    render();
  }

  /** Занято ли имя: true, false или null, если проверить не удалось. */
  async function nameTaken(name) {
    try {
      const doc = await FB.db.collection("usernames").doc(name.toLowerCase()).get();
      return doc.exists;
    } catch (e) {
      return null;
    }
  }

  /** Служебная почта для входа, однозначно выведенная из имени. */
  async function nameEmail(key) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    return "u" + hex.slice(0, 40) + GUEST_DOMAIN;
  }

  /** Убирает лишние пробелы в имени. */
  function cleanName(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  /** Бронирует товар за текущим гостем. */
  async function reserve(id) {
    if (!FB || canEdit) return;
    if (!guest) {
      pendingReserve = id;
      openAuth("login");
      return;
    }
    if (reservations[id] || reserving[id]) return;
    reserving[id] = true;
    render();
    try {
      await FB.db.collection("reservations").doc(id).set({ uid: guest.uid, name: guest.name, at: FB.fv.serverTimestamp() });
      reservations[id] = { uid: guest.uid, name: guest.name };
      showToast("Готово, теперь все видят, что этот подарок за тобой", 3500);
    } catch (e) {
      showToast(e && e.code === "permission-denied" ? "Этот подарок уже забронировал кто-то другой" : "Не получилось забронировать. Попробуй ещё раз", 5000);
    } finally {
      delete reserving[id];
      softRender();
    }
  }

  /** Снимает свою бронь. */
  async function unreserve(id) {
    if (!FB || !guest) return;
    reserving[id] = true;
    render();
    try {
      await FB.db.collection("reservations").doc(id).delete();
      delete reservations[id];
      showToast("Бронь снята", 2500);
    } catch (e) {
      showToast("Не получилось снять бронь. Попробуй ещё раз", 5000);
    } finally {
      delete reserving[id];
      softRender();
    }
  }

  /** Открывает форму входа. */
  function openLogin() {
    loggingIn = true;
    authMode = null;
    editing = null;
    render();
  }

  /** Выходит из режима редактирования на этом устройстве. */
  function logout() {
    if (saveTimer) save();
    dropToken();
    canEdit = false;
    editing = null;
    renaming = false;
    sha = null;
    render();
  }

  /** Форма добавления или изменения товара. */
  function form(item) {
    const isNew = !item;
    const v = item || (prefill ? { url: prefill.url, title: prefill.title, price: prefill.price, priceOld: prefill.priceOld } : {});
    const f = {
      url: field("f-url", "Ссылка", v.url || "", "https://www.ozon.ru/product/…", { inputmode: "url", autocomplete: "off", spellcheck: "false" }),
      title: field("f-title", "Название", v.title || "", "Можно не писать, если есть ссылка", { maxlength: "140" }),
      price: field("f-price", "Цена со скидкой, ₽", v.price != null ? String(v.price) : "", "Подставит проверка", { inputmode: "decimal", autocomplete: "off" }),
      priceOld: field("f-price-old", "Цена без скидки, ₽", v.priceOld != null ? String(v.priceOld) : "", "Если есть скидка", { inputmode: "decimal", autocomplete: "off" }),
      platform: field("f-platform", "Площадка", v.platform || "", detectPlatform(v.url) || "Определится по ссылке", { maxlength: "40" }),
      note: field("f-note", "Заметка", v.note || "", "Размер, цвет, модель", { maxlength: "200" })
    };
    const hint = el("p", { class: "hint", hidden: true });
    f.price.wrap.append(hint);
    const tHint = el("p", { class: "hint muted", hidden: true }, "Название и цену подставит проверка в 18:52 по Москве");
    f.title.wrap.append(tHint);
    const syncTitleHint = () => {
      tHint.hidden = !cleanUrl(f.url.input.value) || !!f.title.input.value.trim();
    };
    syncTitleHint();
    f.title.input.addEventListener("input", syncTitleHint);
    if (isNew && prefill && v.price != null) {
      hint.textContent = "Цена со страницы товара";
      hint.hidden = false;
    } else if (isNew && prefill && v.url && v.title) {
      hint.textContent = "Можно оставить пустой: цену подставит проверка в 18:52 по Москве";
      hint.hidden = false;
    }
    let lookupTimer = null;
    const lookup = async () => {
      const url = cleanUrl(f.url.input.value);
      if (!url || (f.price.input.value.trim() && f.title.input.value.trim())) return;
      const found = await wbLookup(url);
      if (!found || cleanUrl(f.url.input.value) !== url) return;
      if (!f.title.input.value.trim() && found.title) {
        f.title.input.value = found.title;
        syncTitleHint();
      }
      if (found.price && !f.price.input.value.trim()) {
        f.price.input.value = String(found.price);
        if (found.old && found.old > found.price && !f.priceOld.input.value.trim()) f.priceOld.input.value = String(found.old);
        hint.textContent = "Цена с Wildberries";
        hint.hidden = false;
      }
    };
    f.url.input.addEventListener("input", () => {
      f.platform.input.placeholder = detectPlatform(cleanUrl(f.url.input.value)) || "Определится по ссылке";
      syncTitleHint();
      clearTimeout(lookupTimer);
      lookupTimer = setTimeout(lookup, 500);
    });
    f.price.input.addEventListener("input", () => { hint.hidden = true; });
    if (isNew && v.url && (v.price == null || !v.title)) lookup();
    const actions = el("div", { class: "actions" },
      el("button", { type: "submit", class: "btn" }, isNew ? "Добавить в список" : "Сохранить"),
      el("button", { type: "button", class: "btn ghost", onclick: closeForm }, "Отмена"));
    if (!isNew) {
      const del = el("div", { class: "delete" });
      const idle = () => del.replaceChildren(el("button", { type: "button", class: "btn text", onclick: ask }, "Удалить"));
      const ask = () => del.replaceChildren(
        el("span", { class: "delete-q" }, "Удалить насовсем?"),
        el("button", { type: "button", class: "btn danger", onclick: () => removeItem(item.id) }, "Да, удалить"),
        el("button", { type: "button", class: "btn ghost", onclick: idle }, "Нет"));
      idle();
      actions.append(del);
    }
    const prio = priorityPicker(v.priority || DEFAULT_PRIORITY);
    const node = el("form", { class: "form", novalidate: true, "aria-label": isNew ? "Новое желание" : "Изменить желание" },
      f.url.wrap, f.title.wrap, prio, el("div", { class: "row2" }, f.price.wrap, f.priceOld.wrap), el("div", { class: "row2" }, f.platform.wrap, f.note.wrap), actions);
    node.addEventListener("submit", (e) => {
      e.preventDefault();
      const picked = node.querySelector('input[name="f-prio"]:checked');
      submitForm(item, f, picked ? Number(picked.value) : DEFAULT_PRIORITY);
    });
    node.addEventListener("keydown", (e) => { if (e.key === "Escape") closeForm(); });
    focusLater(isNew && !v.url ? f.url.input : f.title.input);
    return node;
  }

  /** Пробует получить название и цену товара Wildberries по ссылке. */
  async function wbLookup(url) {
    const m = url.match(/wildberries\.[a-z]+\/catalog\/(\d+)/i);
    if (!m) return null;
    const nm = Number(m[1]);
    const [price, title] = await Promise.all([wbPrice(nm), wbTitle(nm)]);
    if (!price && !title) return null;
    return Object.assign({ price: null, old: null, title: title || "" }, price || {}, title ? { title: title } : {});
  }

  /** Цена товара WB через открытый API (бывает недоступен). */
  async function wbPrice(nm) {
    for (const ver of ["v4", "v2"]) {
      try {
        const r = await fetch("https://card.wb.ru/cards/" + ver + "/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=" + nm);
        if (!r.ok) continue;
        const j = await r.json();
        const p = ((j.data && j.data.products) || j.products || [])[0];
        if (!p) continue;
        const size = (p.sizes || []).find((s) => s.price && (s.price.product || s.price.total));
        const kop = size ? size.price.product || size.price.total : p.salePriceU || p.priceU;
        if (!kop) continue;
        const basic = size && size.price.basic ? size.price.basic : p.priceU;
        return { price: Math.round(kop / 100), old: basic ? Math.round(basic / 100) : null };
      } catch (e) {}
    }
    return null;
  }

  /** Название товара WB из его карточки на сервере картинок. */
  async function wbTitle(nm) {
    const vol = Math.floor(nm / 1e5);
    const path = "/vol" + vol + "/part" + Math.floor(nm / 1e3) + "/" + nm + "/info/ru/card.json";
    const est = WB_BASKETS.reduce((h, [v, b]) => (vol >= v ? b : h), 1);
    const near = [est - 1, est, est + 1, est + 2].filter((h) => h >= 1);
    const rest = [];
    for (let h = 1; h <= 80; h++) if (!near.includes(h)) rest.push(h);
    const probe = (hosts) => Promise.any(hosts.map((h) =>
      fetch("https://basket-" + String(h).padStart(2, "0") + ".wbbasket.ru" + path)
        .then((r) => (r.ok ? r.json() : Promise.reject()))));
    try {
      const card = await probe(near).catch(() => probe(rest));
      return String(card.imt_name || card.subj_name || "").trim().slice(0, 140);
    } catch (e) {
      return "";
    }
  }

  /** Код кнопки «В вишлист» для панели закладок. */
  function bookmarkletHref() {
    const base = location.origin + location.pathname;
    const code = "(()=>{const d=document,q=s=>d.querySelector(s),t=e=>e?(e.content||e.textContent||'').trim():'';"
      + "const num=s=>{const m=String(s).replace(/[\\s\\u00a0\\u2009\\u202f]/g,'').match(/\\d+(?:[.,]\\d+)?/);return m?parseFloat(m[0].replace(',','.')):NaN};"
      + "let n='',ld=NaN;"
      + "for(const s of d.querySelectorAll('script[type=\"application/ld+json\"]')){try{const j=JSON.parse(s.textContent);"
      + "for(const o of [].concat(j['@graph']||j)){if(o&&/Product/i.test(String(o['@type']))){n=n||o.name||'';"
      + "const f=[].concat(o.offers||[])[0];if(f&&isNaN(ld))ld=num(f.price||f.lowPrice||'')}}}catch(e){}}"
      + "let best=null,bz=0;"
      + "for(const e of d.querySelectorAll('[class*=rice],[class*=Price],[data-widget=webPrice] *,[itemprop=price]')){"
      + "const x=(e.textContent||'').trim();if(x.length<40&&/\\d/.test(x)&&/₽|руб/.test(x)&&e.children.length<4){"
      + "const z=parseFloat(getComputedStyle(e).fontSize)||0;if(z>bz){bz=z;best=e}}}"
      + "const re=/(\\d[\\d\\s\\u00a0\\u2009\\u202f]*(?:[.,]\\d{1,2})?)\\s*(?:₽|руб)/g;"
      + "const grab=el=>{const tx=el.innerText||el.textContent||'';const out=[];let m;re.lastIndex=0;"
      + "while((m=re.exec(tx))){const after=tx.slice(re.lastIndex,re.lastIndex+8);if(!/мес|×/.test(after))out.push(num(m[1]))}return out.filter(x=>x>0)};"
      + "let v=[];if(best){let c=(best.parentElement||best).closest('[data-widget=webPrice],.price-block,[class*=price-block],[class*=PriceBlock]');"
      + "if(!c){c=best;for(let i=0;i<6&&c.parentElement;i++){const p=c.parentElement;if((p.innerText||'').length>300)break;c=p;if(grab(c).length>=2)break}}"
      + "v=grab(c);const mx=Math.max(...v);v=v.filter(x=>x>=mx*0.2)}"
      + "let p=v.length?Math.min(...v):ld,o=v.length?Math.max(...v):NaN;"
      + "if(isNaN(p))p=num(t(q('meta[itemprop=price],meta[property=\"product:price:amount\"],meta[property=\"og:price:amount\"]')));"
      + "if(!(o>p))o=NaN;"
      + "n=n||t(q('meta[property=\"og:title\"]'))||t(q('h1'))||d.title;"
      + "window.open('" + base + "?add=1&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(String(n).slice(0,140))"
      + "+'&price='+(isNaN(p)?'':p)+'&old='+(isNaN(o)?'':o),'_blank')})()";
    return "javascript:" + encodeURI(code);
  }

  /** Выбор важности из пяти уровней, от самого важного к наименее. */
  function priorityPicker(current) {
    return el("fieldset", { class: "fieldset" },
      el("legend", null, "Важность"),
      el("div", { class: "prio-pick" }, PRIORITIES.map(([p, label]) => {
        const input = el("input", { type: "radio", name: "f-prio", id: "f-prio-" + p, value: String(p) });
        input.checked = p === current;
        return [input, el("label", { for: "f-prio-" + p, class: "p" + p }, label)];
      })));
  }

  /** Поле формы с подписью и местом для ошибки. */
  function field(id, label, value, placeholder, extra) {
    const input = el("input", Object.assign({ id: id, name: id, type: "text", placeholder: placeholder, "aria-describedby": id + "-err" }, extra || {}));
    input.value = value;
    const err = el("p", { class: "err", id: id + "-err", hidden: true });
    return { input: input, err: err, wrap: el("div", { class: "field" }, el("label", { for: id }, label), input, err) };
  }

  /** Показывает или скрывает ошибку поля. */
  function setErr(f, msg) {
    f.err.textContent = msg;
    f.err.hidden = !msg;
    f.input.setAttribute("aria-invalid", msg ? "true" : "false");
  }

  /** Проверяет форму и сохраняет товар. */
  function submitForm(item, f, priority) {
    const title = f.title.input.value.trim();
    const rawUrl = f.url.input.value.trim();
    const url = rawUrl ? cleanUrl(rawUrl) : "";
    const rawPrice = f.price.input.value.trim();
    const price = rawPrice ? parsePrice(rawPrice) : null;
    const rawOld = f.priceOld.input.value.trim();
    const priceOld = rawOld ? parsePrice(rawOld) : null;
    setErr(f.url, rawUrl && !url ? "Нужна ссылка на страницу товара, например https://www.ozon.ru/product/…"
      : !item && url && state.items.some((i) => i.url === url) ? "Этот товар уже есть в списке" : "");
    setErr(f.title, title || url ? "" : "Напиши, что это за подарок, или вставь ссылку");
    setErr(f.price, rawPrice && price == null ? "Укажи цену числом, например 4990" : "");
    setErr(f.priceOld, rawOld && priceOld == null ? "Укажи цену числом, например 5990"
      : priceOld != null && price == null ? "Сначала укажи цену со скидкой"
      : priceOld != null && price != null && priceOld <= price ? "Цена без скидки должна быть больше цены со скидкой" : "");
    const bad = ["url", "title", "price", "priceOld"].map((k) => f[k]).find((x) => !x.err.hidden);
    if (bad) {
      bad.input.focus();
      return;
    }
    const data = { title: title, url: url, price: price, priceOld: priceOld, priority: priority, platform: f.platform.input.value.trim(), note: f.note.input.value.trim() };
    if (item) {
      const it = state.items.find((i) => i.id === item.id);
      if (!it) return closeForm();
      if (it.url !== data.url) {
        it.check = null;
        Object.assign(it, { priceAt: null, pricePrev: null, priceChangedAt: null });
      } else if (it.price !== data.price) {
        Object.assign(it, { pricePrev: null, priceChangedAt: null });
      }
      Object.assign(it, data);
    } else {
      state.items.push(Object.assign({ id: newId(), gifted: false, giftedAt: null, addedAt: new Date().toISOString(), check: null, priceAt: null, pricePrev: null, priceChangedAt: null }, data));
      if (filter === "gifted" || filter === "gone") {
        filter = "all";
        storeFilter();
      }
    }
    editing = null;
    prefill = null;
    render();
    save();
  }

  /** Открывает форму нового или существующего товара. */
  function openForm(id) {
    editing = id;
    renaming = false;
    render();
  }

  /** Закрывает форму без сохранения. */
  function closeForm() {
    editing = null;
    prefill = null;
    render();
  }

  /** Удаляет товар. */
  function removeItem(id) {
    state.items = state.items.filter((i) => i.id !== id);
    if (FB && guestAdmin && reservations[id]) FB.db.collection("reservations").doc(id).delete().catch(() => {});
    editing = null;
    render();
    save();
  }

  /** Ставит или снимает отметку «подарено». */
  function toggleGift(id) {
    const it = state.items.find((i) => i.id === id);
    if (!it || !canEdit) return;
    it.gifted = !it.gifted;
    it.giftedAt = it.gifted ? new Date().toISOString() : null;
    render();
    queueSave(1500);
  }

  /** Всплывающее сообщение внизу экрана. */
  function showToast(text, ms, action) {
    clearTimeout(toastTimer);
    toastEl.replaceChildren(...[
      el("span", null, text),
      action ? el("button", { type: "button", onclick: () => { toastEl.hidden = true; action.fn(); } }, action.label) : null
    ].filter(Boolean));
    toastEl.hidden = false;
    if (ms) toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  /** Определяет площадку по адресу ссылки. */
  function detectPlatform(url) {
    if (!url) return "";
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const hit = PLATFORMS.find(([re]) => re.test(host));
      return hit ? hit[1] : host;
    } catch (e) {
      return "";
    }
  }

  /** Достаёт ссылку из вставленного текста и проверяет её. */
  function cleanUrl(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    const found = s.match(/https?:\/\/[^\s<>"']+/i);
    if (found) s = found[0];
    else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    try {
      const u = new URL(s);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".")) return u.href;
    } catch (e) {}
    return "";
  }

  /** Разбирает цену из строки вида «12 990 ₽». */
  function parsePrice(s) {
    const n = Number(String(s).replace(/[\s  ₽]|руб\.?|р\.?$/gi, "").replace(",", "."));
    return isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
  }

  /** Форматирует цену в рублях. */
  function fmtPrice(n) {
    return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n) + " ₽";
  }

  /** Форматирует дату по-русски. */
  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const opts = { day: "numeric", month: "long" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    if (withTime) {
      opts.hour = "2-digit";
      opts.minute = "2-digit";
    }
    return d.toLocaleString("ru-RU", opts);
  }

  /** Склонение по числу. */
  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  /** Товар с неработающей ссылкой, который ещё не подарили. */
  function isGone(i) {
    return !i.gifted && !!i.check && i.check.status === "gone";
  }

  /** Новый идентификатор товара. */
  function newId() {
    return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Данные в том виде, в каком они лежат в data.json. */
  function serialize(s) {
    return JSON.stringify(s, null, 2) + "\n";
  }

  /** Кодирует строку UTF-8 в base64. */
  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** Декодирует base64 в строку UTF-8. */
  function fromB64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /** Ставит фокус после отрисовки. */
  function focusLater(node, select) {
    requestAnimationFrame(() => {
      node.focus();
      if (select) node.select();
    });
  }

  /** Токен владельца из памяти браузера. */
  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  /** Запоминает токен в этом браузере. */
  function storeToken(t) {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch (e) {}
  }

  /** Забывает токен в этом браузере. */
  function dropToken() {
    token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /** Восстанавливает выбранную вкладку. */
  function loadFilter() {
    try {
      const v = localStorage.getItem("wishlist-filter");
      return TABS.some(([k]) => k === v) ? v : "all";
    } catch (e) {
      return "all";
    }
  }

  /** Запоминает выбранную вкладку. */
  function storeFilter() {
    try {
      localStorage.setItem("wishlist-filter", filter);
    } catch (e) {}
  }

  /** Создаёт DOM-элемент с атрибутами и детьми. */
  function el(tag, attrs) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (k === "class") n.className = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of Array.prototype.slice.call(arguments, 2).flat(Infinity)) {
      if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
    }
    return n;
  }
})();
