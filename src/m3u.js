// Lê o texto de uma lista M3U e devolve [{ name, url, logo, group }]
export function parseM3U(text) {
  const channels = [];
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.startsWith("#EXTINF")) {
      const attr = (key) => line.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";
      current = {
        name: line.slice(line.indexOf(",") + 1).trim() || "Sem nome",
        logo: attr("tvg-logo"),
        group: attr("group-title").split(";")[0] || "Outros",
      };
    } else if (line && !line.startsWith("#") && current) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

const VIDEO_FILE = /\.(mp4|mkv|avi|mov|m4v|wmv|webm)$/i;
const EPISODE = /^(.*?)[\s._-]*S(\d{1,2})[\s._-]*E(\d{1,3})\b/i;

// Separa as entradas da lista em canais ao vivo, filmes e séries.
// Listas geradas pelo Xtream usam /movie/ e /series/ no endereço; nas demais,
// arquivos de vídeo com "S01E02" no nome viram episódios e o resto vira filme.
export function splitPlaylist(entries) {
  const live = [];
  const movies = [];
  const shows = new Map();

  for (const e of entries) {
    const path = e.url.split("?")[0].toLowerCase();
    const ep = e.name.match(EPISODE);
    if (path.includes("/series/") || (ep && VIDEO_FILE.test(path))) {
      addEpisode(shows, e, ep);
    } else if (path.includes("/movie/") || VIDEO_FILE.test(path)) {
      movies.push({ id: `m3u:${e.url}`, source: "m3u", name: e.name, poster: e.logo, category: e.group, url: e.url });
    } else {
      live.push(e);
    }
  }
  return { live, movies, series: [...shows.values()] };
}

function addEpisode(shows, e, ep) {
  const title = ep?.[1].replace(/[\s._-]+$/, "") || e.name;
  const key = `${e.group}|${title.toLowerCase()}`;
  let show = shows.get(key);
  if (!show) {
    show = { id: `m3u:${key}`, source: "m3u", name: title, poster: e.logo, category: e.group, episodes: [] };
    shows.set(key, show);
  }
  show.episodes.push({
    season: ep ? Number(ep[2]) : 1,
    episode: ep ? Number(ep[3]) : show.episodes.length + 1,
    title: e.name,
    url: e.url,
  });
}