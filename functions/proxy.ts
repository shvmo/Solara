const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";

// 酷我允许的域名。
// 实际音频通常会落到 *.kuwo.cn / *.sycdn.kuwo.cn 等 CDN。
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;

// 允许从上游响应复制的响应头
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

// 浏览器可以读取的响应头
const EXPOSED_HEADERS = [
  "Content-Type",
  "Content-Length",
  "Content-Range",
  "Accept-Ranges",
  "Cache-Control",
  "ETag",
  "Last-Modified",
  "Expires",
  "X-Cache-Status",
];

// ============================================================
// CORS
// ============================================================

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
  headers.set(
    "Access-Control-Expose-Headers",
    EXPOSED_HEADERS.join(", ")
  );

  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": EXPOSED_HEADERS.join(", "),
      "Access-Control-Max-Age": "86400",
    },
  });
}

// ============================================================
// 酷我 URL 校验
// ============================================================

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);

    if (!isAllowedKuwoHost(parsed.hostname)) {
      console.warn(
        `[KUWO] Blocked host: ${parsed.hostname}`
      );
      return null;
    }

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      console.warn(
        `[KUWO] Blocked protocol: ${parsed.protocol}`
      );
      return null;
    }

    // 不再强制 HTTPS -> HTTP
    return parsed;
  } catch (err) {
    console.warn("[KUWO] Invalid URL:", rawUrl, err);
    return null;
  }
}

// ============================================================
// 酷我：通过 antiserver 获取实际播放地址
//
// 不再依赖 GD Studio 的 types=url。
// GD Studio 当前 kuwo types=url 会返回：
// {"url":"","br":-1,"size":0,"from":"music.gdstudio.xyz"}
//
// 酷我自己的 antiserver 接口可以直接通过 RID 获取播放地址。
// ============================================================

async function getKuwoDirectUrl(
  songId: string,
  br: string | null
): Promise<string | null> {
  if (!songId) {
    return null;
  }

  // 防止把奇怪的参数传入酷我接口
  const cleanId = songId.trim();

  if (!/^[A-Za-z0-9_]+$/.test(cleanId)) {
    console.warn(
      `[KUWO] Invalid song id: ${cleanId}`
    );
    return null;
  }

  // 优先使用 MP3。
  //
  // 320 / 192 / 128 的具体可用码率由酷我返回结果决定。
  // antiserver 会返回实际可用资源。
  const apiUrl = new URL(
    "https://antiserver.kuwo.cn/anti.s"
  );

  apiUrl.searchParams.set(
    "type",
    "convert_url3"
  );

  apiUrl.searchParams.set(
    "rid",
    cleanId
  );

  apiUrl.searchParams.set(
    "format",
    "mp3"
  );

  console.log(
    `[KUWO DIRECT] Requesting song ${cleanId}, br=${br ?? "default"}`
  );

  let response: Response;

  try {
    response = await fetch(
      apiUrl.toString(),
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Referer": "https://www.kuwo.cn/",
        },
        redirect: "follow",
      }
    );
  } catch (err) {
    console.error(
      "[KUWO DIRECT] Fetch failed:",
      err
    );
    return null;
  }

  const text = await response.text();

  console.log(
    `[KUWO DIRECT] HTTP ${response.status}: ${text.substring(
      0,
      300
    )}`
  );

  if (!response.ok) {
    return null;
  }

  const trimmed = text.trim();

  // ----------------------------------------------------------
  // 情况 1：
  // 接口直接返回 URL
  //
  // 例如：
  // http://xxx.sycdn.kuwo.cn/...mp3
  // ----------------------------------------------------------

  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }

  // ----------------------------------------------------------
  // 情况 2：
  // 返回 JSON
  //
  // 某些版本会返回：
  // {"code":"200","url":"http://..."}
  //
  // 或：
  // {"data":{"url":"http://..."}}
  // ----------------------------------------------------------

  try {
    const data = JSON.parse(trimmed);

    if (
      data &&
      typeof data.url === "string" &&
      data.url.startsWith("http")
    ) {
      return data.url;
    }

    if (
      data &&
      data.data &&
      typeof data.data.url === "string" &&
      data.data.url.startsWith("http")
    ) {
      return data.data.url;
    }
  } catch {
    // 不是 JSON，继续下面的文本处理
  }

  // ----------------------------------------------------------
  // 情况 3：
  // 返回内容里面包含 URL
  // ----------------------------------------------------------

  const urlMatch = trimmed.match(
    /https?:\/\/[^\s"'<>]+/
  );

  if (urlMatch) {
    return urlMatch[0];
  }

  // ----------------------------------------------------------
  // 情况 4：
  // 酷我返回 IPDeny / 空内容 / 其他错误
  // ----------------------------------------------------------

  if (
    trimmed === "" ||
    trimmed === "IPDeny" ||
    trimmed.toLowerCase() === "null"
  ) {
    console.warn(
      `[KUWO DIRECT] No playable URL for ${cleanId}: ${trimmed}`
    );
    return null;
  }

  console.warn(
    `[KUWO DIRECT] Unknown response for ${cleanId}: ${trimmed.substring(
      0,
      300
    )}`
  );

  return null;
}

// ============================================================
// 酷我：获取播放地址 API
//
// 前端请求：
// /proxy?types=url&id=113118&source=kuwo&br=320
//
// 这里直接绕过 GD Studio 的 kuwo types=url。
// ============================================================

async function proxyKuwoUrlRequest(
  url: URL,
  request: Request
): Promise<Response> {
  const songId = url.searchParams.get("id");
  const br = url.searchParams.get("br");

  if (!songId) {
    return new Response(
      JSON.stringify({
        url: "",
        br: -1,
        size: 0,
        from: "kuwo-direct",
        error: "Missing song id",
      }),
      {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers":
            "Content-Type",
          "Content-Type":
            "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const directUrl = await getKuwoDirectUrl(
    songId,
    br
  );

  if (!directUrl) {
    console.warn(
      `[KUWO DIRECT] Failed to resolve song ${songId}`
    );

    return new Response(
      JSON.stringify({
        url: "",
        br: -1,
        size: 0,
        from: "kuwo-direct",
        error: "Kuwo playback URL unavailable",
      }),
      {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
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

  console.log(
    `[KUWO DIRECT] Resolved ${songId}: ${directUrl}`
  );

  // ==========================================================
  // 注意：
  // 这里不要直接返回音频。
  //
  // 你的 index.js 目前期待的是：
  // {"url":"..."}
  //
  // 因此返回这个结构即可。
  // ==========================================================

  const responseData = {
    url: directUrl,
    br: br
      ? Number(br)
      : 128,
    size: 0,
    from: "kuwo-direct",
  };

  return new Response(
    JSON.stringify(responseData),
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
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
// 酷我：实际音频代理
//
// 前端如果最终请求：
// /proxy?target=https://xxx.kuwo.cn/xxx.mp3
//
// 就会进入这里。
// ============================================================

async function proxyKuwoAudio(
  targetUrl: string,
  request: Request
): Promise<Response> {
  const normalized =
    normalizeKuwoUrl(targetUrl);

  if (!normalized) {
    return new Response(
      "Invalid Kuwo target",
      {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  const requestHeaders = new Headers();

  requestHeaders.set(
    "User-Agent",
    request.headers.get("User-Agent") ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  );

  requestHeaders.set(
    "Referer",
    "https://www.kuwo.cn/"
  );

  // Range 对 HTML5 音频播放器非常重要
  const rangeHeader =
    request.headers.get("Range");

  if (rangeHeader) {
    requestHeaders.set(
      "Range",
      rangeHeader
    );
  }

  const acceptHeader =
    request.headers.get("Accept");

  requestHeaders.set(
    "Accept",
    acceptHeader ?? "*/*"
  );

  console.log(
    `[KUWO AUDIO] Fetching: ${normalized.toString()}${
      rangeHeader
        ? ` Range=${rangeHeader}`
        : ""
    }`
  );

  let upstream: Response;

  try {
    upstream = await fetch(
      normalized.toString(),
      {
        method: request.method,
        headers: requestHeaders,
        redirect: "follow",
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
          "Access-Control-Allow-Origin": "*",
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }

  console.log(
    `[KUWO AUDIO] Upstream response: ${upstream.status} ${upstream.statusText}`
  );

  const headers =
    createCorsHeaders(
      upstream.headers
    );

  if (upstream.ok) {
    headers.set(
      "Cache-Control",
      "public, max-age=3600"
    );
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(
    upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }
  );
}

// ============================================================
// GD Studio API 代理
//
// 网易云等其他音乐源仍然走这里。
// ============================================================

async function proxyApiRequest(
  url: URL,
  request: Request,
  waitUntil?: (
    promise: Promise<any>
  ) => void
): Promise<Response> {
  const cache = caches.default;

  const cacheUrl =
    new URL(url.toString());

  cacheUrl.searchParams.delete("s");

  const cacheKey =
    new Request(
      cacheUrl.toString(),
      {
        method: request.method,
        headers: request.headers,
      }
    );

  // ==========================================================
  // Cache HIT
  // ==========================================================

  if (request.method === "GET") {
    try {
      const cachedResponse =
        await cache.match(cacheKey);

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
          EXPOSED_HEADERS.join(", ")
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
  // 构造 GD Studio API
  // ==========================================================

  const apiUrl =
    new URL(API_BASE_URL);

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
    !apiUrl.searchParams.has("types")
  ) {
    return new Response(
      "Missing types",
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

  // 默认音乐源
  if (
    !apiUrl.searchParams.has("source")
  ) {
    apiUrl.searchParams.set(
      "source",
      "kuwo"
    );
  }

  // name / keywords 兼容
  if (
    !apiUrl.searchParams.has("name")
  ) {
    const nameValue =
      url.searchParams.get(
        "keywords"
      ) ||
      url.searchParams.get("name");

    if (nameValue) {
      apiUrl.searchParams.set(
        "name",
        nameValue
      );
    }
  }

  console.log(
    `[API] Request: ${apiUrl.toString()}`
  );

  // ==========================================================
  // 请求 GD Studio
  // ==========================================================

  let upstream: Response;

  try {
    upstream = await fetch(
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
  } catch (err) {
    console.error(
      "[API] Fetch failed:",
      err
    );

    return new Response(
      "Upstream API fetch failed",
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

  const responseText =
    await upstream.text();

  const headers =
    createCorsHeaders(
      upstream.headers
    );

  if (
    !headers.has("Content-Type")
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
    EXPOSED_HEADERS.join(", ")
  );

  // ==========================================================
  // 判断缓存
  // ==========================================================

  const isSearch =
    url.searchParams.get(
      "types"
    ) === "search";

  const isEmptyResult =
    responseText.trim() === "[]";

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
  // 写入 Cloudflare Cache
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
  // CORS 预检
  if (
    request.method ===
    "OPTIONS"
  ) {
    return handleOptions();
  }

  // 只允许 GET / HEAD
  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return new Response(
      "Method not allowed",
      {
        status: 405,
        headers: {
          "Access-Control-Allow-Origin":
            "*",
          "Allow":
            "GET, HEAD, OPTIONS",
        },
      }
    );
  }

  const url =
    new URL(request.url);

  const target =
    url.searchParams.get(
      "target"
    );

  // ==========================================================
  // 1. 酷我播放地址获取
  //
  // /proxy?types=url&source=kuwo&id=xxx&br=320
  // ==========================================================

  const types =
    url.searchParams.get(
      "types"
    );

  const source =
    url.searchParams.get(
      "source"
    );

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
  // 2. 实际音频代理
  //
  // /proxy?target=https://xxx.kuwo.cn/...
  // ==========================================================

  if (target) {
    return proxyKuwoAudio(
      target,
      request
    );
  }

  // ==========================================================
  // 3. 其他 API
  //
  // 网易云等继续走 GD Studio
  // ==========================================================

  return proxyApiRequest(
    url,
    request,
    waitUntil
  );
}
