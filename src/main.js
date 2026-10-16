import { invoke } from "@tauri-apps/api/core";
import { parseM3U, splitPlaylist } from "./m3u.js";
import { createXtream } from "./xtream.js";
import { play, stop } from "./player.js";

const DEFAULT_LIST = "https://iptv-org.github.io/iptv/countries/br.m3u";
const FAV_KEY = "favoritos";
const LAST_LIST_KEY = "ultima-lista";
const XTREAM_KEY = "xtream";
const PAGE = 60;
const EMPTY = { live: [], movies: [], series: [] };

const $ = (id) => document.getElementById(id);
const els = {
  tabs: document.querySelectorAll("[data-tab]"),
  search: $("search"), group: $("group"), list: $("channels"), status: $("status"),
  player: $("player"), video: $("video"), back: $("back"), osd: $("osd"),
  osdNumber: $("osd-number"), osdName: $("osd-name"), empty: $("empty"),
  catalog: $("catalog"), grid: $("grid"), sentinel: $("sentinel"), detail: $("detail"),
  sources: $("sources"), sourcesForm: $("sources-form"), sourcesError: $("sources-error"),
  openSources: $("open-sources"), cancelSources: $("sources-cancel"),
  url: $("playlist-url"), xtServer: $("xt-server"), xtUser: $("xt-user"), xtPass: $("xt-pass"),
};

const state = {
  tab: "live",
  view: "player",
  m3u: EMPTY,
  xt: EMPTY,
  live: [], movies: [], series: [],
  filters: { live: { q: "", group: "" }, movies: { q: "", group: "" }, series: { q: "", group: "" } },
  visible: [],
  current: null,
  detail: null,
  playing: null,
  grid: { items: [], shown: 0 },
};
let xtream = null;
let osdTimer = null;
let loadToken = 0;
let detailToken = 0;
const favorites = loadFavorites();

// ---------- Fontes ----------
async function loadAll() {
  const token = ++loadToken;
  const listUrl = localStorage.getItem(LAST_LIST_KEY) ?? DEFAULT_LIST;
  const config = loadXtreamConfig();
  xtream = config ? createXtream(config) : null;
  setStatus("Carregando…");

  const errors = [];
  const fail = (label) => (err) => { errors.push(`${label}: ${errText(err)}.`); return EMPTY; };
  const [m3u, xt] = await Promise.all([
    // O download é feito no lado Rust, o que evita bloqueios de CORS
    listUrl
      ? invoke("fetch_playlist", { url: listUrl }).then((t) => splitPlaylist(parseM3U(t))).catch(fail("Lista M3U"))
      : EMPTY,
    xtream ? loadXtream(xtream).catch(fail("Xtream")) : EMPTY,
  ]);
  if (token !== loadToken) return;

  state.m3u = m3u;
  state.xt = xt;
  merge();
  renderSidebar();
  if (state.tab !== "live") renderGrid();
  const summary = `${state.live.length} canais, ${state.movies.length} filmes e ${state.series.length} séries.`;
  setStatus([...errors, summary].join(" "));
}

async function loadXtream(client) {
  await client.login();
  const [live, movies, series] = await Promise.all([client.live(), client.movies(), client.series()]);
  return { live, movies, series };
}

// Junta M3U e Xtream sem repetir: canais pelo endereço, filmes e séries pelo nome.
// No VOD o Xtream vem primeiro porque traz sinopse, capa e episódios.
function merge() {
  const withKey = (x) => ({ ...x, key: normalize(x.name) });
  state.live = unique([...state.m3u.live, ...state.xt.live], (c) => c.url)
    .map((c, i) => ({ ...withKey(c), number: i + 1 }));
  state.movies = unique([...state.xt.movies, ...state.m3u.movies].map(withKey), (m) => m.key);
  state.series = unique([...state.xt.series, ...state.m3u.series].map(withKey), (s) => s.key);
}

function openSources() {
  els.url.value = localStorage.getItem(LAST_LIST_KEY) ?? DEFAULT_LIST;
  const c = loadXtreamConfig() || {};
  els.xtServer.value = c.server || "";
  els.xtUser.value = c.username || "";
  els.xtPass.value = c.password || "";
  els.sourcesError.textContent = "";
  els.sources.showModal();
}

function saveSources(e) {
  e.preventDefault();
  const xt = { server: els.xtServer.value.trim(), username: els.xtUser.value.trim(), password: els.xtPass.value };
  const filled = [xt.server, xt.username, xt.password].filter(Boolean).length;
  if (filled && filled < 3) {
    els.sourcesError.textContent = "Preencha servidor, usuário e senha do Xtream, ou deixe os três em branco.";
    return;
  }
  localStorage.setItem(LAST_LIST_KEY, els.url.value.trim());
  if (filled) localStorage.setItem(XTREAM_KEY, JSON.stringify(xt));
  else localStorage.removeItem(XTREAM_KEY);
  els.sources.close();
  loadAll();
}

// ---------- Abas e telas ----------
function setTab(tab) {
  if (tab === state.tab) return;
  stop(els.video);
  state.current = state.playing = state.detail = null;
  state.tab = tab;
  els.tabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  els.search.value = state.filters[tab].q;
  els.search.placeholder = { live: "Buscar canal", movies: "Buscar filme", series: "Buscar série" }[tab];
  els.osd.hidden = true;
  els.empty.hidden = false;
  renderSidebar();
  if (tab === "live") showView("player");
  else { showView("grid"); renderGrid(); }
}

function showView(view) {
  // Sair do player de filmes/séries interrompe o vídeo
  if (view !== "player" && state.tab !== "live") { stop(els.video); state.playing = null; }
  state.view = view;
  els.player.hidden = view !== "player";
  els.catalog.hidden = view !== "grid";
  els.detail.hidden = view !== "detail";
  els.back.hidden = state.tab === "live";
}

function renderSidebar() {
  const live = state.tab === "live";
  els.group.hidden = !live;
  if (live) { fillGroups(); renderLive(); } else renderCategories();
}

// ---------- TV ao vivo ----------
function fillGroups() {
  const groups = [...new Set(state.live.map((c) => c.group))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const options = [["", "Todos os grupos"], ["__fav", "Favoritos"], ...groups.map((g) => [g, g])];
  els.group.replaceChildren(...options.map(([value, label]) => h("option", { value }, label)));
  els.group.value = state.filters.live.group;
}

function renderLive() {
  const { q, group } = state.filters.live;
  const nq = normalize(q);
  state.visible = state.live.filter((c) =>
    (!nq || c.key.includes(nq)) &&
    (!group || (group === "__fav" ? favorites.has(c.url) : c.group === group))
  );
  els.list.replaceChildren(...state.visible.map(channelItem));
}

function channelItem(c) {
  const li = document.createElement("li");
  li.className = "channel";
  li.dataset.url = c.url;
  li.classList.toggle("active", state.current?.url === c.url);

  const play = document.createElement("button");
  play.className = "channel-play";
  play.addEventListener("click", () => playChannel(c));

  const num = document.createElement("span");
  num.className = "channel-number";
  num.textContent = String(c.number).padStart(3, "0");

  const logo = document.createElement("img");
  logo.className = "channel-logo";
  logo.alt = "";
  logo.loading = "lazy";
  setImage(logo, c.logo);

  const name = document.createElement("span");
  name.className = "channel-name";
  name.textContent = c.name;

  play.append(num, logo, name);

  const fav = document.createElement("button");
  fav.className = "channel-fav";
  const setFavState = () => {
    const on = favorites.has(c.url);
    fav.textContent = on ? "★" : "☆";
    fav.setAttribute("aria-label", on ? "Remover dos favoritos" : "Adicionar aos favoritos");
    fav.classList.toggle("on", on);
  };
  fav.addEventListener("click", () => {
    favorites.has(c.url) ? favorites.delete(c.url) : favorites.add(c.url);
    saveFavorites();
    if (state.filters.live.group === "__fav") renderLive(); else setFavState();
  });
  setFavState();

  li.append(play, fav);
  return li;
}

function playChannel(c) {
  state.current = c;
  els.empty.hidden = true;
  showOsd(c);
  markActive();
  play(els.video, c.url, {
    live: true,
    onError: (msg) => setStatus(msg || `${c.name} não respondeu. O canal pode estar fora do ar ou bloquear acesso de fora do navegador.`),
  });
  setStatus(`Assistindo ${c.name}`);
}

function zap(step) {
  const { visible } = state;
  if (!visible.length) return;
  const i = visible.findIndex((c) => c.url === state.current?.url);
  const next = i < 0 ? visible[0] : visible[(i + step + visible.length) % visible.length];
  playChannel(next);
  els.list.querySelector(`[data-url="${CSS.escape(next.url)}"]`)?.scrollIntoView({ block: "nearest" });
}

function markActive() {
  els.list.querySelectorAll(".channel").forEach((li) =>
    li.classList.toggle("active", li.dataset.url === state.current?.url));
}

function showOsd(c) {
  els.osdNumber.textContent = String(c.number).padStart(3, "0");
  els.osdName.textContent = c.name;
  els.osd.hidden = false;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => (els.osd.hidden = true), 3000);
}

// ---------- Filmes e séries: categorias e grade ----------
function renderCategories() {
  const items = state[state.tab];
  const counts = new Map();
  for (const it of items) counts.set(it.category, (counts.get(it.category) || 0) + 1);
  const cats = [
    ["", "Todas", items.length],
    ...[...counts].sort(([a], [b]) => a.localeCompare(b, "pt-BR")).map(([c, n]) => [c, c, n]),
  ];
  const active = state.filters[state.tab].group;
  els.list.replaceChildren(...cats.map(([value, label, n]) =>
    h("li", { class: value === active ? "category active" : "category" },
      h("button", { class: "category-btn", onclick: () => selectCategory(value) },
        h("span", { class: "category-name" }, label),
        h("span", { class: "category-count" }, String(n))))));
}

function selectCategory(value) {
  state.filters[state.tab].group = value;
  renderCategories();
  showView("grid");
  renderGrid();
}

function renderGrid() {
  const { q, group } = state.filters[state.tab];
  const nq = normalize(q);
  const all = state[state.tab];
  state.grid = {
    items: all.filter((it) => (!nq || it.key.includes(nq)) && (!group || it.category === group)),
    shown: 0,
  };
  els.grid.replaceChildren();
  els.catalog.scrollTop = 0;
  if (!state.grid.items.length) {
    const none = state.tab === "movies" ? "Nenhum filme disponível" : "Nenhuma série disponível";
    els.grid.append(h("li", { class: "grid-empty" }, all.length
      ? "Nada encontrado para essa busca."
      : `${none}. Configure uma conta Xtream ou uma lista M3U em Fontes.`));
  }
  renderMorePosters();
  watchSentinel();
}

function renderMorePosters() {
  const { grid } = state;
  const next = grid.items.slice(grid.shown, grid.shown + PAGE);
  grid.shown += next.length;
  els.grid.append(...next.map(posterItem));
}

// Rolagem infinita: desenha mais capas quando o fim da grade se aproxima
const sentinelObserver = new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting || state.grid.shown >= state.grid.items.length) return;
  renderMorePosters();
  watchSentinel(); // observar de novo dispara outra checagem se ainda faltar preencher a tela
}, { root: els.catalog, rootMargin: "600px" });

function watchSentinel() {
  sentinelObserver.unobserve(els.sentinel);
  sentinelObserver.observe(els.sentinel);
}

function posterItem(item) {
  const img = h("img", { alt: "", loading: "lazy" });
  setImage(img, item.poster);
  return h("li", {},
    h("button", { class: "poster", title: item.name, onclick: () => openDetail(item) },
      h("div", { class: "poster-art" }, h("span", { class: "poster-fallback" }, item.name), img),
      h("span", { class: "poster-name" }, item.name)));
}

// ---------- Detalhes ----------
async function openDetail(item) {
  const token = ++detailToken;
  const kind = state.tab;
  state.detail = { item, kind, info: null, season: null };
  showView("detail");
  els.detail.scrollTop = 0;
  renderDetail();

  try {
    const info = item.source === "xtream"
      ? await (kind === "movies" ? xtream.movieInfo(item) : xtream.seriesInfo(item))
      : { episodes: item.episodes };
    info.episodes?.sort((a, b) => a.season - b.season || a.episode - b.episode);
    if (token === detailToken) { state.detail.info = info; renderDetail(); }
  } catch (err) {
    if (token === detailToken) { state.detail.info = { error: errText(err) }; renderDetail(); }
  }
}

function renderDetail() {
  const { item, kind, info } = state.detail;
  const i = info || {};
  const meta = [i.year || item.year, i.genre, i.duration, formatRating(i.rating ?? item.rating)]
    .filter(Boolean).join("  ·  ");
  const plot = !info ? "Carregando detalhes…"
    : i.error ? `Não foi possível carregar os detalhes: ${i.error}`
    : i.plot || item.plot || "Sem sinopse.";

  const poster = h("img", { class: "detail-poster", alt: "" });
  setImage(poster, i.poster || item.poster);

  const hero = h("div", { class: "detail-hero" },
    poster,
    h("div", { class: "detail-info" },
      h("h1", {}, item.name),
      meta && h("p", { class: "detail-meta" }, meta),
      h("p", { class: "detail-plot" }, plot),
      i.cast && h("p", { class: "detail-cast" }, `Elenco: ${i.cast}`),
      kind === "movies" && h("button", {
        class: "primary play-btn",
        onclick: () => playVod({ title: item.name, url: i.url || item.url }),
      }, "▶ Assistir")));
  if (i.backdrop) hero.style.setProperty("--backdrop", `url(${JSON.stringify(i.backdrop)})`);

  els.detail.replaceChildren(...[
    h("button", { class: "back-link", onclick: () => showView("grid") }, "← Voltar"),
    hero,
    kind === "series" && info && !i.error && episodesBlock(i.episodes || []),
  ].filter(Boolean));
}

function episodesBlock(episodes) {
  if (!episodes.length) return h("p", { class: "episodes" }, "Nenhum episódio disponível.");
  const seasons = [...new Set(episodes.map((e) => e.season))];
  const season = seasons.includes(state.detail.season) ? state.detail.season : seasons[0];

  const select = h("select", {
    "aria-label": "Temporada",
    onchange: (e) => { state.detail.season = Number(e.target.value); renderDetail(); },
  }, seasons.map((s) => h("option", { value: s, selected: s === season }, `Temporada ${s}`)));

  return h("section", { class: "episodes" },
    h("div", { class: "episodes-head" }, h("h2", {}, "Episódios"), select),
    h("ol", { class: "episode-list" }, episodes.filter((e) => e.season === season).map((ep) =>
      h("li", {},
        h("button", { class: "episode", onclick: () => playEpisode(ep) },
          h("span", { class: "episode-number" }, String(ep.episode).padStart(2, "0")),
          h("span", { class: "episode-text" },
            h("span", { class: "episode-title" }, ep.title || `Episódio ${ep.episode}`),
            ep.plot && h("span", { class: "episode-plot" }, ep.plot)),
          ep.duration && h("span", { class: "episode-duration" }, ep.duration))))));
}

function playEpisode(ep) {
  const name = state.detail.item.name;
  playVod({ title: `${name} T${ep.season}E${ep.episode}`, url: ep.url, episode: ep });
}

function playVod(entry) {
  state.playing = entry;
  showView("player");
  els.empty.hidden = true;
  play(els.video, entry.url, {
    live: false,
    onError: (msg) => setStatus(msg || `Não foi possível reproduzir ${entry.title}. O arquivo pode estar fora do ar ou num formato (como alguns .mkv) que o sistema não reproduz.`),
  });
  setStatus(`Assistindo ${entry.title}`);
}

// Ao terminar um episódio, toca o próximo
function playNextEpisode() {
  const ep = state.playing?.episode;
  const list = state.detail?.info?.episodes;
  const next = ep && list?.[list.indexOf(ep) + 1];
  if (!next) return;
  state.detail.season = next.season;
  playEpisode(next);
}

// ---------- Utilidades ----------
// Cria um elemento: h("button", { class: "x", onclick: fn }, "texto", filho, ...)
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false && c !== ""));
  return el;
}

function setImage(img, src) {
  img.onerror = () => img.classList.add("missing");
  if (src) img.src = src; else img.classList.add("missing");
}

function unique(list, key) {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Ignora acentos e maiúsculas na busca ("acao" encontra "Ação")
const normalize = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function formatRating(r) {
  const n = Number(r);
  return n > 0 ? `★ ${n.toFixed(1)}` : "";
}

const errText = (err) => err?.message ?? String(err);

function setStatus(msg) { els.status.textContent = msg; }

function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []); }
  catch { return new Set(); }
}
function saveFavorites() { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); }

function loadXtreamConfig() {
  try { return JSON.parse(localStorage.getItem(XTREAM_KEY)); }
  catch { return null; }
}

// ---------- Início ----------
els.tabs.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
els.openSources.addEventListener("click", openSources);
els.cancelSources.addEventListener("click", () => els.sources.close());
els.sourcesForm.addEventListener("submit", saveSources);
els.back.addEventListener("click", () => {
  if (!state.detail) return showView("grid");
  showView("detail");
  renderDetail(); // a temporada pode ter mudado com a reprodução automática
});
els.video.addEventListener("ended", playNextEpisode);

els.search.addEventListener("input", () => {
  state.filters[state.tab].q = els.search.value;
  if (state.tab === "live") return renderLive();
  if (state.view !== "grid") showView("grid");
  renderGrid();
});
els.group.addEventListener("change", () => {
  state.filters.live.group = els.group.value;
  renderLive();
});

document.addEventListener("keydown", (e) => {
  if (state.tab !== "live" || e.target.matches("input, select")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    zap(e.key === "ArrowDown" ? 1 : -1);
  }
});

loadAll();
