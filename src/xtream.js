import { invoke } from "@tauri-apps/api/core";

// Cliente da API Xtream Codes. As chamadas passam pelo Rust (comando xtream_api);
// os endereços de vídeo seguem o padrão /movie|series|live/usuário/senha/id.ext
export function createXtream({ server, username, password }) {
  const base = normalizeServer(server);
  const api = (action, params = {}) =>
    invoke("xtream_api", { server: base, username, password, action, params });
  const streamUrl = (type, id, ext) =>
    `${base}/${type}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`;

  async function categories(action) {
    const list = asArray(await api(action));
    return new Map(list.map((c) => [String(c.category_id), c.category_name]));
  }

  async function listWith(categoriesAction, streamsAction, map) {
    const [cats, items] = await Promise.all([categories(categoriesAction), api(streamsAction)]);
    return asArray(items).map((s) => map(s, cats.get(String(s.category_id)) || "Outros"));
  }

  return {
    async login() {
      const info = (await api(null))?.user_info;
      if (!info || String(info.auth) !== "1") throw new Error("usuário ou senha inválidos");
      if (info.status && info.status !== "Active") throw new Error(`conta com status "${info.status}"`);
      return info;
    },

    live: () => listWith("get_live_categories", "get_live_streams", (s, group) => ({
      name: s.name || "Sem nome",
      logo: s.stream_icon || "",
      group,
      url: streamUrl("live", s.stream_id, "m3u8"),
    })),

    movies: () => listWith("get_vod_categories", "get_vod_streams", (s, category) => ({
      id: `xt:${s.stream_id}`,
      source: "xtream",
      streamId: s.stream_id,
      name: s.name || "Sem nome",
      poster: s.stream_icon || "",
      category,
      rating: s.rating,
      url: streamUrl("movie", s.stream_id, s.container_extension || "mp4"),
    })),

    series: () => listWith("get_series_categories", "get_series", (s, category) => ({
      id: `xt:${s.series_id}`,
      source: "xtream",
      seriesId: s.series_id,
      name: s.name || "Sem nome",
      poster: s.cover || "",
      category,
      plot: s.plot || "",
      rating: s.rating,
      year: yearOf(s.releaseDate || s.release_date),
    })),

    async movieInfo(movie) {
      const r = await api("get_vod_info", { vod_id: String(movie.streamId) });
      const i = objectOf(r?.info);
      const ext = r?.movie_data?.container_extension;
      return {
        plot: i.plot || i.description || "",
        genre: i.genre,
        year: yearOf(i.releasedate || i.release_date),
        duration: i.duration,
        rating: i.rating,
        cast: i.cast,
        poster: i.movie_image || i.cover_big,
        backdrop: firstOf(i.backdrop_path),
        url: ext ? streamUrl("movie", movie.streamId, ext) : movie.url,
      };
    },

    async seriesInfo(show) {
      const r = await api("get_series_info", { series_id: String(show.seriesId) });
      const i = objectOf(r?.info);
      // "episodes" vem como { "1": [...], "2": [...] }, com a temporada na chave
      const episodes = Object.entries(r?.episodes || {}).flatMap(([season, list]) =>
        asArray(list).map((e) => ({
          season: Number(e.season ?? season),
          episode: Number(e.episode_num) || 0,
          title: e.title,
          plot: e.info?.plot || "",
          duration: e.info?.duration || "",
          url: streamUrl("series", e.id, e.container_extension || "mp4"),
        })));
      return {
        plot: i.plot || show.plot,
        genre: i.genre,
        year: yearOf(i.releaseDate || i.release_date),
        rating: i.rating,
        cast: i.cast,
        poster: i.cover,
        backdrop: firstOf(i.backdrop_path),
        episodes,
      };
    },
  };
}

export function normalizeServer(server) {
  const s = server.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
}

// O PHP do Xtream às vezes devolve [] no lugar de {} e objetos no lugar de listas
const asArray = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
const objectOf = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const firstOf = (x) => (Array.isArray(x) ? x[0] : x) || "";
const yearOf = (date) => String(date || "").slice(0, 4);
