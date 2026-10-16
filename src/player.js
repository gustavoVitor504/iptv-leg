import Hls from "hls.js";
import { convertFileSrc } from "@tauri-apps/api/core";

// Faz o hls.js buscar playlists, segmentos e chaves pelo proxy stream:// do Rust,
// evitando bloqueios de CORS. O hls.js continua enxergando o endereço original.
class ProxyLoader extends Hls.DefaultConfig.loader {
  load(context, config, callbacks) {
    const original = context.url;
    context.url = convertFileSrc(original, "stream");
    super.load(context, config, {
      ...callbacks,
      onSuccess: (response, stats, ctx, details) => {
        const finalUrl = this.getResponseHeader?.("x-final-url") || original;
        ctx.url = original;
        response.url = finalUrl;
        callbacks.onSuccess(response, stats, ctx, details);
      },
    });
  }
}

let hls = null;

// Canais ao vivo usam HLS pelo proxy. Filmes e episódios (.mp4, .mkv) vão direto
// para o <video>: ele não sofre bloqueio de CORS e assim o avanço/retrocesso funciona.
export function play(video, url, { live, onError }) {
  stop(video);
  const isHls = live ? !/\.(mp4|mkv|webm)(\?|$)/i.test(url) : /\.m3u8(\?|$)/i.test(url);

  if (isHls && Hls.isSupported()) {
    hls = new Hls({ loader: ProxyLoader });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) onError(); });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
    onError("Este sistema não consegue reproduzir streams HLS.");
    return;
  } else {
    video.onerror = () => onError();
    video.src = url; // arquivo direto, ou HLS nativo no macOS
  }
  video.play().catch(() => {});
}

export function stop(video) {
  if (hls) { hls.destroy(); hls = null; }
  video.onerror = null;
  video.removeAttribute("src");
  video.load();
}
