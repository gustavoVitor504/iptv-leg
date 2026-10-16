use std::collections::HashMap;
use std::sync::LazyLock;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};

// User-Agent de navegador: muitos servidores IPTV recusam clientes "desconhecidos"
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .expect("erro ao criar cliente HTTP")
});

fn check_url(url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err("O endereço precisa começar com http:// ou https://".into())
    }
}

// Baixa o texto da lista M3U pelo Rust (sem restrições de CORS do navegador)
#[tauri::command]
async fn fetch_playlist(url: String) -> Result<String, String> {
    check_url(&url)?;
    let resp = CLIENT.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("o servidor respondeu {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

// Chama a API do Xtream Codes (player_api.php) e devolve o JSON da resposta.
// Sem `action`, a resposta traz os dados da conta (usada para validar o login).
#[tauri::command]
async fn xtream_api(
    server: String,
    username: String,
    password: String,
    action: Option<String>,
    params: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    check_url(&server)?;
    let mut query = vec![("username".to_string(), username), ("password".to_string(), password)];
    if let Some(action) = action {
        query.push(("action".to_string(), action));
    }
    query.extend(params.unwrap_or_default());

    let url = format!("{}/player_api.php", server.trim_end_matches('/'));
    // without_url(): a mensagem de erro não pode expor usuário e senha da URL
    let resp = CLIENT
        .get(&url)
        .query(&query)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    match resp.status() {
        s if s == StatusCode::UNAUTHORIZED || s == StatusCode::FORBIDDEN => {
            return Err("usuário ou senha inválidos".into())
        }
        s if !s.is_success() => return Err(format!("o servidor respondeu {s}")),
        _ => {}
    }
    let text = resp.text().await.map_err(|e| e.without_url().to_string())?;
    serde_json::from_str(&text).map_err(|_| "o servidor não respondeu no formato da API Xtream".into())
}

// Proxy do protocolo stream://: o front pede stream://localhost/<url codificada>,
// o Rust baixa o conteúdo e devolve com CORS liberado
async fn proxy(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let target = percent_decode_str(request.uri().path().trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();

    let reply = |status: StatusCode, msg: String| {
        Response::builder()
            .status(status)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(msg.into_bytes())
            .unwrap()
    };

    if let Err(e) = check_url(&target) {
        return reply(StatusCode::BAD_REQUEST, e);
    }

    let mut upstream = CLIENT.get(&target);
    if let Some(range) = request.headers().get(header::RANGE) {
        upstream = upstream.header(header::RANGE, range);
    }

    let resp = match upstream.send().await {
        Ok(r) => r,
        Err(e) => return reply(StatusCode::BAD_GATEWAY, e.to_string()),
    };

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "x-final-url")
        // Endereço após redirecionamentos, para o hls.js resolver caminhos relativos
        .header("x-final-url", final_url);
    for name in [header::CONTENT_TYPE, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
        if let Some(v) = resp.headers().get(&name) {
            builder = builder.header(name, v);
        }
    }

    match resp.bytes().await {
        Ok(body) => builder.body(body.to_vec()).unwrap(),
        Err(e) => reply(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("stream", |_ctx, request, responder| {
            tauri::async_runtime::spawn(async move {
                responder.respond(proxy(request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![fetch_playlist, xtream_api])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o aplicativo");
}
