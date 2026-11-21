const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(
  rawUrl: string
): URL | null {

  try {
    const parsed = new URL(rawUrl);

    if (
      !isAllowedKuwoHost(
        parsed.hostname
      )
    ) {
      return null;
    }

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    /*
     * 不再强制把 HTTPS 改成 HTTP。
     *
     * 之前我们这里强制：
     * parsed.protocol = "http:";
     *
     * 可能导致某些酷我 CDN 的请求异常。
     *
     * 现在保留酷我返回的原始协议。
     */

    return parsed;

  } catch {
    return null;
  }
}

// ============================================================
// 工具：从酷我 XML 中提取字段
// ============================================================

function getXmlValue(
  xml: string,
  tag: string
): string {

  const pattern =
    new RegExp(
      `<${tag}>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(pattern);

  if (!match) {
    return "";
  }

  return match[1]
    .trim()
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    );
}


// ============================================================
// 酷我方案一：
// getNewMuiseByRid
//
// 这是本次最主要的修改。
//
// 请求：
// https://player.kuwo.cn/webmusic/st/getNewMuiseByRid?rid=MUSIC_歌曲ID
//
// 返回 XML，其中包含：
// <mp3dl>...</mp3dl>
// <mp3path>...</mp3path>
//
// 最终：
// https://mp3dl/resource/mp3path
// ============================================================

async function getKuwoSongInfo(
  songId: string
): Promise<{
  url: string;
  br: number;
  size: number;
} | null> {

  const rid = songId.startsWith("MUSIC_")
    ? songId
    : `MUSIC_${songId}`;

  const endpoints = [
    `https://player.kuwo.cn/webmusic/st/getNewMuiseByRid?rid=${encodeURIComponent(rid)}`,
    `https://player.kuwo.cn/webmusic/st/getMuiseByRid?rid=${encodeURIComponent(rid)}&flag=3`,
  ];

  for (const endpoint of endpoints) {

    console.log(
      `[KUWO INFO] Request: ${endpoint}`
    );

    try {

      const response =
        await fetch(
          endpoint,
          {
            method: "GET",

            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",

              "Accept":
                "application/xml,text/xml,text/plain,*/*",

              "Referer":
                "https://www.kuwo.cn/",
            },

            redirect: "follow",
          }
        );

      const text =
        await response.text();

      console.log(
        `[KUWO INFO] HTTP ${response.status}, length=${text.length}`
      );

      if (!response.ok) {
        continue;
      }

      if (!text.trim()) {
        continue;
      }


      // ------------------------------------------------------
      // 判断是否真的拿到了 Song
      // ------------------------------------------------------

      const musicId =
        getXmlValue(
          text,
          "music_id"
        );

      if (!musicId) {

        console.warn(
          "[KUWO INFO] No music_id in response"
        );

        continue;
      }


      // ------------------------------------------------------
      // MP3 下载服务器
      // ------------------------------------------------------

      const mp3dl =
        getXmlValue(
          text,
          "mp3dl"
        );

      const mp3path =
        getXmlValue(
          text,
          "mp3path"
        );


      console.log(
        `[KUWO INFO] music_id=${musicId}`
      );

      console.log(
        `[KUWO INFO] mp3dl=${mp3dl}`
      );

      console.log(
        `[KUWO INFO] mp3path=${mp3path}`
      );


      if (
        !mp3dl ||
        !mp3path
      ) {

        console.warn(
          "[KUWO INFO] MP3 fields missing"
        );

        continue;
      }


      // ------------------------------------------------------
      // 清理地址
      // ------------------------------------------------------

      let host =
        mp3dl.trim();

      let path =
        mp3path.trim();


      // 有些返回值可能已经带协议
      host =
        host.replace(
          /^https?:\/\//i,
          ""
        );

      // 防止重复 /
      host =
        host.replace(
          /\/+$/,
          ""
        );

      path =
        path.replace(
          /^\/+/,
          ""
        );


      const audioUrl =
        `https://${host}/resource/${path}`;


      console.log(
        `[KUWO INFO] Constructed MP3 URL: ${audioUrl}`
      );


      // ------------------------------------------------------
      // 获取歌曲码率
      //
      // mp3path 中通常包含：
      //
      // n2/128/...
      // n1/320/...
      //
      // 尝试从路径中识别。
      // ------------------------------------------------------

      let bitrate = 128;

      const bitrateMatch =
        path.match(
          /\/(320|256|192|128|64)\//
        );

      if (bitrateMatch) {
        bitrate =
          Number(
            bitrateMatch[1]
          );
      }


      // ------------------------------------------------------
      // 获取文件大小
      // ------------------------------------------------------

      let size = 0;

      const mp3size =
        getXmlValue(
          text,
          "mp3size"
        );

      if (mp3size) {

        const sizeMatch =
          mp3size.match(
            /([\d.]+)\s*(KB|MB|GB)/i
          );

        if (sizeMatch) {

          const value =
            Number(
              sizeMatch[1]
            );

          const unit =
            sizeMatch[2]
              .toUpperCase();

          if (unit === "KB") {
            size =
              Math.round(
                value * 1024
              );
          }

          if (unit === "MB") {
            size =
              Math.round(
                value * 1024 * 1024
              );
          }

          if (unit === "GB") {
            size =
              Math.round(
                value *
                1024 *
                1024 *
                1024
              );
          }
        }
      }


      return {
        url: audioUrl,
        br: bitrate,
        size,
      };

    } catch (err) {

      console.warn(
        "[KUWO INFO] Request failed:",
        err
      );
    }
  }

  return null;
}


// ============================================================
// 酷我方案二：
// antiserver convert_url
//
// 作为备用。
// ============================================================

async function getKuwoAntiServerUrl(
  songId: string
): Promise<string | null> {

  const rid =
    songId.startsWith("MUSIC_")
      ? songId
      : `MUSIC_${songId}`;

  const url =
    new URL(
      "https://antiserver.kuwo.cn/anti.s"
    );

  url.searchParams.set(
    "type",
    "convert_url"
  );

  url.searchParams.set(
    "rid",
    rid
  );

  // 优先要 mp3：浏览器对裸 .aac(ADTS) 的兼容性差，容易播不出声
  url.searchParams.set(
    "format",
    "mp3|aac"
  );

  url.searchParams.set(
    "response",
    "url"
  );


  console.log(
    `[KUWO ANTI] Request: ${url.toString()}`
  );


  try {

    const response =
      await fetch(
        url.toString(),
        {
          method: "GET",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",

            "Accept":
              "*/*",

            "Referer":
              "https://www.kuwo.cn/",
          },

          redirect: "follow",
        }
      );


    const text =
      (
        await response.text()
      ).trim();


    console.log(
      `[KUWO ANTI] HTTP ${response.status}: ${text.substring(0, 500)}`
    );


    if (!response.ok) {
      return null;
    }


    if (
      text.startsWith(
        "http://"
      ) ||
      text.startsWith(
        "https://"
      )
    ) {

      return text;
    }


    try {

      const data =
        JSON.parse(text);

      if (
        data &&
        typeof data.url ===
          "string" &&
        data.url.startsWith(
          "http"
        )
      ) {

        return data.url;
      }

    } catch {
      // 非 JSON，继续
    }


    const match =
      text.match(
        /https?:\/\/[^\s"'<>]+/
      );

    if (match) {
      return match[0];
    }

  } catch (err) {

    console.warn(
      "[KUWO ANTI] Failed:",
      err
    );
  }


  return null;
}


// ============================================================
// 酷我 types=url
//
// /proxy?types=url&id=113118&source=kuwo&br=320
// ============================================================

async function proxyKuwoUrlRequest(
  url: URL,
  request: Request
): Promise<Response> {

  const songId =
    url.searchParams.get(
      "id"
    );

  const requestedBr =
    url.searchParams.get(
      "br"
    );


  if (!songId) {

    return new Response(
      JSON.stringify({
        url: "",
        br: -1,
        size: 0,
        from: "kuwo-direct",
        error:
          "Missing song id",
      }),
      {
        status: 400,

        headers: {
          "Access-Control-Allow-Origin":
            "*",

          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store",
        },
      }
    );
  }


  console.log(
    `[KUWO] Resolving song: ${songId}, requested br=${requestedBr}`
  );


  // ==========================================================
  // 第一优先级：
  // getNewMuiseByRid
  // ==========================================================

  const songInfo =
    await getKuwoSongInfo(
      songId
    );


  if (songInfo) {

    console.log(
      `[KUWO] SUCCESS via getNewMuiseByRid: ${songInfo.url}`
    );


    return new Response(
      JSON.stringify({
        url: songInfo.url,

        br: songInfo.br,

        size: songInfo.size,

        from:
          "kuwo-song-info",
      }),
      {
        status: 200,

        headers: {
          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Expose-Headers":
            "Content-Type",

          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store, no-cache, must-revalidate",
        },
      }
    );
  }


  // ==========================================================
  // 第二优先级：
  // antiserver
  // ==========================================================

  const antiUrl =
    await getKuwoAntiServerUrl(
      songId
    );


  if (antiUrl) {

    console.log(
      `[KUWO] SUCCESS via antiserver: ${antiUrl}`
    );


    let bitrate =
      requestedBr
        ? Number(requestedBr)
        : 128;


    if (
      !Number.isFinite(
        bitrate
      ) ||
      bitrate <= 0
    ) {
      bitrate = 128;
    }


    return new Response(
      JSON.stringify({
        url: antiUrl,

        br: bitrate,

        size: 0,

        from:
          "kuwo-antiserver",
      }),
      {
        status: 200,

        headers: {
          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Expose-Headers":
            "Content-Type",

          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store, no-cache, must-revalidate",
        },
      }
    );
  }


  // ==========================================================
  // 全部失败
  // ==========================================================

  console.warn(
    `[KUWO] Unable to resolve playback URL: ${songId}`
  );


  return new Response(
    JSON.stringify({
      url: "",
      br: -1,
      size: 0,
      from:
        "kuwo-direct",
      error:
        "Kuwo playback URL unavailable",
    }),
    {
      status: 200,

      headers: {
        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Expose-Headers":
          "Content-Type",

        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store, no-cache, must-revalidate",
      },
    }
  );
}


// ============================================================
// 酷我实际音频代理
//
// /proxy?target=https://xxx.kuwo.cn/xxx.mp3
//
// 保留 Range，确保 HTML5 Audio 正常。
// ============================================================

async function proxyKuwoAudio(
  targetUrl: string,
  request: Request
): Promise<Response> {

  const normalized =
    normalizeKuwoUrl(
      targetUrl
    );


  if (!normalized) {

    return new Response(
      "Invalid target",
      {
        status: 400,

        headers: {
          "Access-Control-Allow-Origin":
            "*",

          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }


  const headers =
    new Headers();


  headers.set(
    "User-Agent",
    request.headers.get(
      "User-Agent"
    ) ??
      "Mozilla/5.0"
  );


  headers.set(
    "Referer",
    "https://www.kuwo.cn/"
  );


  headers.set(
    "Accept",
    request.headers.get(
      "Accept"
    ) ??
      "*/*"
  );


  const range =
    request.headers.get(
      "Range"
    );


  if (range) {

    headers.set(
      "Range",
      range
    );
  }


  console.log(
    `[KUWO AUDIO] ${request.method} ${normalized.toString()}`
  );


  if (range) {

    console.log(
      `[KUWO AUDIO] Range: ${range}`
    );
  }


  try {

    const upstream =
      await fetch(
        normalized.toString(),
        {
          method:
            request.method,

          headers,

          redirect:
            "follow",
        }
      );


    console.log(
      `[KUWO AUDIO] Upstream: ${upstream.status} ${upstream.statusText}`
    );


    const responseHeaders =
      createCorsHeaders(
        upstream.headers
      );


    if (
      upstream.status === 200 ||
      upstream.status === 206
    ) {

      responseHeaders.set(
        "Cache-Control",
        "public, max-age=3600"
      );
    }


    return new Response(
      upstream.body,
      {
        status:
          upstream.status,

        statusText:
          upstream.statusText,

        headers:
          responseHeaders,
      }
    );

  } catch (err) {

    console.error(
      "[KUWO AUDIO] Fetch failed:",
      err
    );


    return new Response(
      "Kuwo upstream fetch failed",
      {
        status: 502,

        headers: {
          "Access-Control-Allow-Origin":
            "*",

          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }
}


// ============================================================
// 酷我：搜索 / 歌词 / 封面
//
// GD Studio 已不再支持 source=kuwo（会返回
// "Value of `source` is not supported."），
// 这里直接对接酷我官方接口，绕开第三方。
// ============================================================

const KUWO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function jsonResponse(payload: unknown, cacheSeconds = 0): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Cache-Status",
    "X-Cache-Status": "MISS",
  });

  headers.set(
    "Cache-Control",
    cacheSeconds > 0
      ? `public, max-age=${cacheSeconds}`
      : "no-store, no-cache, must-revalidate"
  );

  return new Response(JSON.stringify(payload), { status: 200, headers });
}

function decodeHtmlEntities(value: unknown): string {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function kuwoSearch(
  keyword: string,
  count: number,
  page: number
): Promise<any[]> {

  const pn = Math.max(0, (page - 1) * count);

  const apiUrl =
    `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}` +
    `&ft=music&itemset=web_2013&client=kt&pn=${pn}&rn=${count}` +
    `&rformat=json&encoding=utf8&mobi=1`;

  let text = "";

  try {
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": KUWO_UA,
        Referer: "https://www.kuwo.cn/",
      },
    });

    text = await res.text();
  } catch (error) {
    console.error("[KUWO SEARCH] fetch failed", error);
    return [];
  }

  let data: any = null;

  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  const list = Array.isArray(data?.abslist) ? data.abslist : [];

  return list
    .map((item: any) => {
      const rid = String(item?.DC_TARGETID || "").trim() ||
        String(item?.MUSICRID || "").replace(/^MUSIC_/i, "").trim();

      if (!rid) return null;

      return {
        id: rid,
        name: decodeHtmlEntities(item?.SONGNAME || item?.NAME),
        artist: [decodeHtmlEntities(item?.ARTIST)]
          .map(v => v.trim())
          .filter(Boolean),
        album: decodeHtmlEntities(item?.ALBUM),
        pic_id: decodeHtmlEntities(item?.web_albumpic_short),
        url_id: rid,
        lyric_id: rid,
        source: "kuwo",
      };
    })
    .filter(Boolean);
}

async function kuwoLyric(songId: string): Promise<{ lyric: string; tlyric: string }> {
  if (!songId) return { lyric: "", tlyric: "" };

  try {
    const res = await fetch(
      `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(songId)}`,
      {
        headers: {
          "User-Agent": KUWO_UA,
          Referer: "https://www.kuwo.cn/",
        },
      }
    );

    const data: any = await res.json();
    const list = data?.data?.lrclist;

    if (!Array.isArray(list) || !list.length) {
      return { lyric: "", tlyric: "" };
    }

    const lines = list.map((item: any) => {
      const seconds = Number(item?.time) || 0;
      const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
      const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
      const cs = String(Math.round((seconds % 1) * 100)).padStart(2, "0");

      return `[${mm}:${ss}.${cs}]${decodeHtmlEntities(item?.lineLyric)}`;
    });

    return { lyric: lines.join("\n"), tlyric: "" };
  } catch {
    return { lyric: "", tlyric: "" };
  }
}

function kuwoPicUrl(picId: string): string {
  if (!picId) return "";

  if (/^https?:\/\//i.test(picId)) return picId;

  return `https://img1.kuwo.cn/star/albumcover/${picId.replace(/^\/+/, "")}`;
}


// ============================================================
// JOOX：播放地址兜底
//
// GD Studio 的 joox 解析在白天限流时会返回空 url。
// 拿到空结果后，用「歌名 + 歌手」到备用解析服务再试一次，
// 仍然是 JOOX 源、仍然可以拿到无损档位，不换歌。
//
// 置为 false 可整体关闭。
// ============================================================

const JOOX_FALLBACK_ENABLED = true;

const JOOX_FALLBACK_API = "https://apicx.asia/api/joox_music";

const JOOX_FALLBACK_TOKEN = "f84ao9lMF_q7husBWRfgUw";

const JOOX_FALLBACK_MAX_TRY = 2;

function normalizeSongName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|（.*?）|\[.*?\]|【.*?】/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function pickJooxLink(
  links: Record<string, string>,
  br: number
): { url: string; tier: string } | null {

  const order =
    br >= 740
      ? ["母带无损", "Hi-Res无损", "无损FLAC", "Atmos全景声", "OGG 320", "MP3 320", "AAC 192"]
      : br >= 320
        ? ["MP3 320", "OGG 320", "AAC 192", "无损FLAC", "MP3 128"]
        : ["MP3 128", "AAC 96", "AAC 48"];

  for (const tier of order) {
    const value = links[tier];

    if (typeof value === "string" && value.startsWith("http")) {
      return { url: value, tier };
    }
  }

  return null;
}

async function resolveJooxUrlByFallback(
  name: string,
  artist: string,
  br: number
): Promise<{ url: string; br: number; tier: string } | null> {

  const targetName = normalizeSongName(name);

  if (!targetName) return null;

  const targetArtists = artist
    .split(/[/、,&]/)
    .map(item => normalizeSongName(item))
    .filter(Boolean);

  for (let index = 1; index <= JOOX_FALLBACK_MAX_TRY; index++) {

    const apiUrl =
      `${JOOX_FALLBACK_API}?msg=${encodeURIComponent(name)}` +
      `&token=${JOOX_FALLBACK_TOKEN}&br=4&n=${index}`;

    let payload: any = null;

    try {
      const res = await fetch(apiUrl, {
        headers: {
          "User-Agent": KUWO_UA,
          Accept: "application/json",
        },
      });

      payload = await res.json();
    } catch (error) {
      console.warn(`[JOOX 兜底] 第 ${index} 次请求异常`, error);
      break;
    }

    const data = payload && payload.data;

    if (!data) break;

    const hitName = normalizeSongName(data["歌曲名称"]);

    const nameHit =
      hitName === targetName ||
      (hitName && (hitName.includes(targetName) || targetName.includes(hitName)));

    if (!nameHit) continue;

    if (targetArtists.length) {
      const hitArtists = String(data["歌手"] || "")
        .split(/[/、,&]/)
        .map(item => normalizeSongName(item))
        .filter(Boolean);

      const artistHit = targetArtists.some(target =>
        hitArtists.some(hit => hit.includes(target) || target.includes(hit))
      );

      if (!artistHit) continue;
    }

    const link = pickJooxLink(data["播放链接"] || {}, br);

    if (link) {
      return { url: link.url, br: br >= 740 ? 999 : br, tier: link.tier };
    }
  }

  return null;
}

async function proxyJooxUrlRequest(
  url: URL,
  request: Request,
  waitUntil?: (promise: Promise<any>) => void,
  apiBaseUrl: string = DEFAULT_API_BASE_URL
): Promise<Response> {

  const br = Number(url.searchParams.get("br")) || 320;

  const name = url.searchParams.get("name") || "";

  const artist = url.searchParams.get("artist") || "";

  const upstreamUrl = new URL(url.toString());

  upstreamUrl.searchParams.delete("name");

  upstreamUrl.searchParams.delete("artist");

  const primary = await proxyApiRequest(upstreamUrl, request, waitUntil, apiBaseUrl);

  let primaryBody = "";

  try {
    primaryBody = await primary.clone().text();
  } catch {
    return primary;
  }

  try {
    const parsed = JSON.parse(primaryBody);

    if (parsed && parsed.url) {
      return primary;
    }
  } catch {
    return primary;
  }

  if (!JOOX_FALLBACK_ENABLED || !name) {
    return primary;
  }

  const fallback = await resolveJooxUrlByFallback(name, artist, br);

  if (!fallback) {
    return primary;
  }

  console.log(`[JOOX 兜底] ${name} -> ${fallback.tier}`);

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Cache-Status, X-Joox-Fallback",
    "X-Cache-Status": "MISS",
    "X-Joox-Fallback": fallback.tier,
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });

  return new Response(
    JSON.stringify({
      url: fallback.url,
      br: fallback.br,
      size: 0,
      from: "joox-fallback",
      tier: fallback.tier,
    }),
    { status: 200, headers }
  );
}

async function proxyApiRequest(url: URL, request: Request, waitUntil?: (promise: Promise<any>) => void, apiBaseUrl: string = DEFAULT_API_BASE_URL): Promise<Response> {
  const cache = caches.default;
  
  // 构建缓存 Key（过滤掉随机签名 s 以及强制刷新标记 nocache，以便重试成功后能更新同一个缓存项）
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  
  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers
  });

  // 如果是 GET 请求且未指定 nocache 强制刷新，尝试命中缓存
  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache HIT] ${url.toString()}`);
        const response = new Response(cachedResponse.body, cachedResponse);
        response.headers.set("X-Cache-Status", "HIT");
        response.headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
        return response;
      }
    } catch (err) {
      console.warn(`[Cache ERROR] ${url.toString()}`, err);
    }
  }

  console.log(`[Cache MISS] Fetching from upstream: ${url.toString()}`);

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "Meting/1.5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }

  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  // 判断是否应该缓存：必须是 200 状态，且内容不能是空数组或包含错误标识，且未指定强制刷新
  const isSearch = url.searchParams.get("types") === "search";
  const isEmptyResult = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');
  
  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;
  
  // 如果是搜索请求且结果为空，通常是 API 繁忙或异常，不建议长缓存
  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  const response = new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  // 写入缓存（不阻塞主流程）
  if (shouldCache && waitUntil) {
    waitUntil(cache.put(cacheKey, response.clone()));
    console.log(`[Cache PUT] Saved to cache: ${url.toString()}`);
  }

  return response;
}

export async function onRequest({ request, waitUntil, env }: { request: Request, waitUntil: (promise: Promise<any>) => void, env: any }): Promise<Response> {
  // 优先使用环境变量中配置的 API 地址，CF 部署未设置时 fallback 到默认节点
  const apiBaseUrl = (typeof env?.API_BASE_URL === "string" && env.API_BASE_URL) ? env.API_BASE_URL : DEFAULT_API_BASE_URL;
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  // 酷我：GD Studio 已不支持 source=kuwo，全部走自建解析
  const types = url.searchParams.get("types");
  const source = url.searchParams.get("source");

  if (source === "kuwo") {
    if (types === "search") {
      const keyword = url.searchParams.get("name") || "";
      const count = Math.min(
        Math.max(Number(url.searchParams.get("count")) || 20, 1),
        50
      );
      const page = Math.max(Number(url.searchParams.get("pages")) || 1, 1);

      return jsonResponse(await kuwoSearch(keyword, count, page), 300);
    }

    if (types === "lyric") {
      return jsonResponse(await kuwoLyric(url.searchParams.get("id") || ""), 3600);
    }

    if (types === "pic") {
      return jsonResponse(
        {
          url: kuwoPicUrl(url.searchParams.get("id") || ""),
          from: "kuwo-direct",
        },
        3600
      );
    }

    if (types === "url") {
      return proxyKuwoUrlRequest(url, request);
    }
  }

  // JOOX：GD 解析不出地址时，用歌名/歌手换解析服务再试
  if (types === "url" && source === "joox") {
    return proxyJooxUrlRequest(url, request, waitUntil, apiBaseUrl);
  }

  return proxyApiRequest(url, request, waitUntil, apiBaseUrl);
}
