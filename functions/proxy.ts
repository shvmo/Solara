const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";

const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;

const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "accept-ranges",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
  "expires",
];


// ============================================================
// CORS
// ============================================================

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();

  if (init) {
    for (const [key, value] of init.entries()) {
      if (
        SAFE_RESPONSE_HEADERS.includes(
          key.toLowerCase()
        )
      ) {
        headers.set(key, value);
      }
    }
  }

  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Expose-Headers",
    [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Cache-Control",
      "ETag",
      "Last-Modified",
      "Expires",
      "X-Cache-Status",
    ].join(", ")
  );

  return headers;
}


function handleOptions(): Response {
  return new Response(null, {
    status: 204,

    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}


// ============================================================
// 酷我 HOST 校验
// ============================================================

function isAllowedKuwoHost(
  hostname: string
): boolean {
  if (!hostname) return false;

  return KUWO_HOST_PATTERN.test(
    hostname
  );
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

  url.searchParams.set(
    "format",
    "aac|mp3"
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
// 其他 API
//
// 这里尽量恢复你最开始的版本。
// 网易云、JOOX、酷狗等继续走 GD Studio。
// ============================================================

async function proxyApiRequest(
  url: URL,
  request: Request,
  waitUntil?: (
    promise: Promise<any>
  ) => void
): Promise<Response> {

  const cache =
    caches.default;


  const cacheUrl =
    new URL(
      url.toString()
    );


  // 随机参数不参与缓存
  cacheUrl.searchParams.delete(
    "s"
  );


  const cacheKey =
    new Request(
      cacheUrl.toString(),
      {
        method:
          request.method,

        headers:
          request.headers,
      }
    );


  // ==========================================================
  // Cache HIT
  // ==========================================================

  if (
    request.method === "GET"
  ) {

    try {

      const cachedResponse =
        await cache.match(
          cacheKey
        );


      if (cachedResponse) {

        const response =
          new Response(
            cachedResponse.body,
            cachedResponse
          );


        response.headers.set(
          "X-Cache-Status",
          "HIT"
        );


        response.headers.set(
          "Access-Control-Expose-Headers",
          "X-Cache-Status"
        );


        return response;
      }

    } catch (err) {

      console.warn(
        `[Cache ERROR] ${url.toString()}`,
        err
      );
    }
  }


  console.log(
    `[Cache MISS] Fetching from upstream: ${url.toString()}`
  );


  // ==========================================================
  // GD Studio API
  // ==========================================================

  const apiUrl =
    new URL(
      API_BASE_URL
    );


  url.searchParams.forEach(
    (value, key) => {

      if (
        key === "target" ||
        key === "callback" ||
        key === "s"
      ) {
        return;
      }


      apiUrl.searchParams.set(
        key,
        value
      );
    }
  );


  if (
    !apiUrl.searchParams.has(
      "types"
    )
  ) {

    return new Response(
      "Missing types",
      {
        status: 400,

        headers: {
          "Access-Control-Allow-Origin":
            "*",
        },
      }
    );
  }


  // ==========================================================
  // 默认源
  //
  // 保持你原来的逻辑
  // ==========================================================

  if (
    !apiUrl.searchParams.has(
      "source"
    )
  ) {

    apiUrl.searchParams.set(
      "source",
      "kuwo"
    );
  }


  // ==========================================================
  // name / keywords
  // ==========================================================

  if (
    !apiUrl.searchParams.has(
      "name"
    )
  ) {

    const nameValue =
      url.searchParams.get(
        "keywords"
      ) ||
      url.searchParams.get(
        "name"
      );


    if (nameValue) {

      apiUrl.searchParams.set(
        "name",
        nameValue
      );
    }
  }


  // ==========================================================
  // 请求 GD Studio
  // ==========================================================

  const upstream =
    await fetch(
      apiUrl.toString(),
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",

          "Accept":
            "application/json",
        },
      }
    );


  const responseText =
    await upstream.text();


  const headers =
    createCorsHeaders(
      upstream.headers
    );


  if (
    !headers.has(
      "Content-Type"
    )
  ) {

    headers.set(
      "Content-Type",
      "application/json; charset=utf-8"
    );
  }


  headers.set(
    "X-Cache-Status",
    "MISS"
  );


  headers.set(
    "Access-Control-Expose-Headers",
    "X-Cache-Status"
  );


  // ==========================================================
  // 判断是否搜索
  // ==========================================================

  const isSearch =
    url.searchParams.get(
      "types"
    ) === "search";


  const isEmptyResult =
    responseText.trim() ===
    "[]";


  const isError =
    responseText.includes(
      '"error"'
    ) ||
    responseText.includes(
      '"status":0'
    );


  let shouldCache =
    upstream.status === 200 &&
    request.method === "GET" &&
    !isError;


  if (
    isSearch &&
    isEmptyResult
  ) {

    shouldCache = false;
  }


  if (shouldCache) {

    headers.set(
      "Cache-Control",
      "public, s-maxage=300, max-age=300"
    );

  } else {

    headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );
  }


  const response =
    new Response(
      responseText,
      {
        status:
          upstream.status,

        statusText:
          upstream.statusText,

        headers,
      }
    );


  // ==========================================================
  // Cache PUT
  // ==========================================================

  if (
    shouldCache &&
    waitUntil
  ) {

    waitUntil(
      cache.put(
        cacheKey,
        response.clone()
      )
    );


    console.log(
      `[Cache PUT] Saved to cache: ${url.toString()}`
    );
  }


  return response;
}


// ============================================================
// Cloudflare Pages Function
// ============================================================

export async function onRequest({
  request,
  waitUntil,
}: {
  request: Request;

  waitUntil: (
    promise: Promise<any>
  ) => void;
}): Promise<Response> {


  // ==========================================================
  // OPTIONS
  // ==========================================================

  if (
    request.method ===
    "OPTIONS"
  ) {

    return handleOptions();
  }


  // ==========================================================
  // GET / HEAD
  // ==========================================================

  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {

    return new Response(
      "Method not allowed",
      {
        status: 405,
      }
    );
  }


  const url =
    new URL(
      request.url
    );


  const target =
    url.searchParams.get(
      "target"
    );


  const types =
    url.searchParams.get(
      "types"
    );


  const source =
    url.searchParams.get(
      "source"
    );


  // ==========================================================
  // 酷我：获取播放地址
  //
  // 注意：
  // 只拦截：
  //
  // types=url
  // source=kuwo
  //
  // 其他 API 全部保持原来的 GD Studio 逻辑。
  // ==========================================================

  if (
    types === "url" &&
    source === "kuwo" &&
    !target
  ) {

    return proxyKuwoUrlRequest(
      url,
      request
    );
  }


  // ==========================================================
  // 酷我：实际音频代理
  // ==========================================================

  if (target) {

    return proxyKuwoAudio(
      target,
      request
    );
  }


  // ==========================================================
  // 其他所有 API
  //
  // 网易云在这里保持原来的处理方式。
  // ==========================================================

  return proxyApiRequest(
    url,
    request,
    waitUntil
  );
}
