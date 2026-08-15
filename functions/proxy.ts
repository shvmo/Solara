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
      "Access-Control-Expose-Headers":
        EXPOSED_HEADERS.join(", "),
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

    return parsed;

  } catch (err) {
    console.warn(
      "[KUWO] Invalid URL:",
      rawUrl,
      err
    );

    return null;
  }
}


// ============================================================
// 酷我播放地址解析
//
// 重点：
//
// 之前：
// convert_url3 + mp3
//
// 出现了所有歌曲只有约 11 秒的问题。
//
// 现在：
// 1. convert_url + mp3
// 2. convert_url + aac|mp3
// 3. convert_url3 + mp3
// 4. convert_url3 + wma
//
// 按顺序尝试。
// ============================================================

async function requestKuwoAntiServer(
  songId: string,
  type: string,
  format: string
): Promise<string | null> {

  const url = new URL(
    "https://antiserver.kuwo.cn/anti.s"
  );

  url.searchParams.set(
    "type",
    type
  );

  url.searchParams.set(
    "rid",
    songId
  );

  url.searchParams.set(
    "format",
    format
  );

  // convert_url 使用 response=url
  if (type === "convert_url") {
    url.searchParams.set(
      "response",
      "url"
    );
  }

  console.log(
    `[KUWO] Request ${type}/${format}: ${url.toString()}`
  );

  try {

    const response = await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",

          "Accept": "*/*",

          "Referer":
            "https://www.kuwo.cn/",
        },

        redirect: "follow",
      }
    );

    const text = (
      await response.text()
    ).trim();

    console.log(
      `[KUWO] ${type}/${format} HTTP ${response.status}: ${text.substring(
        0,
        500
      )}`
    );

    if (!response.ok) {
      return null;
    }

    if (!text) {
      return null;
    }


    // --------------------------------------------------------
    // 直接返回 URL
    // --------------------------------------------------------

    if (
      text.startsWith("http://") ||
      text.startsWith("https://")
    ) {
      return text;
    }


    // --------------------------------------------------------
    // IPDeny
    // --------------------------------------------------------

    if (
      text === "IPDeny" ||
      text === "IP_DENY"
    ) {
      console.warn(
        `[KUWO] IPDeny returned by ${type}/${format}`
      );

      return null;
    }


    // --------------------------------------------------------
    // JSON 返回
    //
    // 例如：
    // {
    //   "code":"200",
    //   "url":"https://..."
    // }
    // --------------------------------------------------------

    try {

      const data = JSON.parse(text);

      if (
        data &&
        typeof data.url === "string" &&
        (
          data.url.startsWith("http://") ||
          data.url.startsWith("https://")
        )
      ) {

        return data.url;
      }


      if (
        data &&
        data.data &&
        typeof data.data.url === "string" &&
        (
          data.data.url.startsWith("http://") ||
          data.data.url.startsWith("https://")
        )
      ) {

        return data.data.url;
      }

    } catch {
      // 不是 JSON，继续处理
    }


    // --------------------------------------------------------
    // 从文本中提取 URL
    // --------------------------------------------------------

    const match = text.match(
      /https?:\/\/[^\s"'<>]+/
    );

    if (match) {
      return match[0];
    }

  } catch (err) {

    console.warn(
      `[KUWO] ${type}/${format} request failed:`,
      err
    );
  }

  return null;
}


// ============================================================
// 获取酷我实际播放 URL
// ============================================================

async function getKuwoDirectUrl(
  songId: string,
  requestedBr: string | null
): Promise<{
  url: string;
  br: number;
} | null> {

  if (!songId) {
    return null;
  }

  let cleanId = songId.trim();

  if (!cleanId) {
    return null;
  }


  // ----------------------------------------------------------
  // 酷我很多接口使用 MUSIC_XXXXXXXX 格式。
  //
  // 如果前端只传：
  // 113118
  //
  // 我们优先使用：
  // MUSIC_113118
  //
  // 如果失败，再使用原始：
  // 113118
  // ----------------------------------------------------------

  const ids: string[] = [];

  if (cleanId.startsWith("MUSIC_")) {
    ids.push(cleanId);

    const numericId =
      cleanId.substring(6);

    if (numericId) {
      ids.push(numericId);
    }

  } else {
    ids.push(
      `MUSIC_${cleanId}`
    );

    ids.push(cleanId);
  }


  // 去重
  const uniqueIds = [
    ...new Set(ids)
  ];


  // ----------------------------------------------------------
  // 记录请求码率
  // ----------------------------------------------------------

  let requestedBitrate = 128;

  if (requestedBr) {
    const parsed =
      Number(requestedBr);

    if (
      Number.isFinite(parsed) &&
      parsed > 0
    ) {
      requestedBitrate = parsed;
    }
  }


  // ==========================================================
  // 第一优先级
  //
  // convert_url + mp3
  //
  // 这是目前最值得优先尝试的旧版酷我播放接口。
  // ==========================================================

  for (const rid of uniqueIds) {

    const url =
      await requestKuwoAntiServer(
        rid,
        "convert_url",
        "mp3"
      );

    if (url) {

      console.log(
        `[KUWO] SUCCESS convert_url/mp3 RID=${rid}`
      );

      return {
        url,
        br: requestedBitrate,
      };
    }
  }


  // ==========================================================
  // 第二优先级
  //
  // convert_url + aac|mp3
  //
  // 某些酷我接口版本会根据这个参数选择可用格式。
  // ==========================================================

  for (const rid of uniqueIds) {

    const url =
      await requestKuwoAntiServer(
        rid,
        "convert_url",
        "aac|mp3"
      );

    if (url) {

      console.log(
        `[KUWO] SUCCESS convert_url/aac|mp3 RID=${rid}`
      );

      return {
        url,
        br: requestedBitrate,
      };
    }
  }


  // ==========================================================
  // 第三优先级
  //
  // convert_url3 + mp3
  //
  // 这是之前实际能拿到 URL 的方式。
  // 保留作为 fallback。
  // ==========================================================

  for (const rid of uniqueIds) {

    const url =
      await requestKuwoAntiServer(
        rid,
        "convert_url3",
        "mp3"
      );

    if (url) {

      console.log(
        `[KUWO] SUCCESS convert_url3/mp3 RID=${rid}`
      );

      return {
        url,
        br: requestedBitrate,
      };
    }
  }


  // ==========================================================
  // 第四优先级
  //
  // convert_url3 + wma
  //
  // 某些新版酷我接口仍然可以通过 WMA 获取完整资源。
  //
  // 但浏览器不一定支持 WMA，所以只作为最后 fallback。
  // ==========================================================

  for (const rid of uniqueIds) {

    const url =
      await requestKuwoAntiServer(
        rid,
        "convert_url3",
        "wma"
      );

    if (url) {

      console.log(
        `[KUWO] SUCCESS convert_url3/wma RID=${rid}`
      );

      return {
        url,
        br: requestedBitrate,
      };
    }
  }


  console.warn(
    `[KUWO] All playback methods failed for song ${cleanId}`
  );

  return null;
}


// ============================================================
// 酷我：types=url
//
// /proxy?types=url&id=113118&source=kuwo&br=320
//
// 这里不再请求 GD Studio。
// ============================================================

async function proxyKuwoUrlRequest(
  url: URL,
  request: Request
): Promise<Response> {

  const songId =
    url.searchParams.get("id");

  const br =
    url.searchParams.get("br");


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
          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Expose-Headers":
            "Content-Type",

          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            "no-store",
        },
      }
    );
  }


  const result =
    await getKuwoDirectUrl(
      songId,
      br
    );


  if (!result) {

    console.warn(
      `[KUWO] Failed to resolve playback URL for ${songId}`
    );

    return new Response(
      JSON.stringify({
        url: "",
        br: -1,
        size: 0,
        from: "kuwo-direct",
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


  console.log(
    `[KUWO] Playback URL resolved: ${result.url}`
  );


  const responseData = {
    url: result.url,

    br: result.br,

    size: 0,

    from: "kuwo-direct",
  };


  return new Response(
    JSON.stringify(responseData),

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
// Range 对 HTML5 Audio 很重要。
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
      "Invalid Kuwo target",
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


  const requestHeaders =
    new Headers();


  requestHeaders.set(
    "User-Agent",
    request.headers.get(
      "User-Agent"
    ) ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  );


  requestHeaders.set(
    "Referer",
    "https://www.kuwo.cn/"
  );


  requestHeaders.set(
    "Accept",
    request.headers.get(
      "Accept"
    ) ?? "*/*"
  );


  const rangeHeader =
    request.headers.get(
      "Range"
    );


  if (rangeHeader) {

    requestHeaders.set(
      "Range",
      rangeHeader
    );
  }


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
        method:
          request.method,

        headers:
          requestHeaders,

        redirect:
          "follow",
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


  console.log(
    `[KUWO AUDIO] Upstream response: ${upstream.status} ${upstream.statusText}`
  );


  const headers =
    createCorsHeaders(
      upstream.headers
    );


  // ----------------------------------------------------------
  // 音频缓存
  // ----------------------------------------------------------

  if (
    upstream.status === 200 ||
    upstream.status === 206
  ) {

    headers.set(
      "Cache-Control",
      "public, max-age=3600"
    );
  }


  if (
    request.method === "HEAD"
  ) {

    return new Response(
      null,
      {
        status:
          upstream.status,

        statusText:
          upstream.statusText,

        headers,
      }
    );
  }


  return new Response(
    upstream.body,
    {
      status:
        upstream.status,

      statusText:
        upstream.statusText,

      headers,
    }
  );
}


// ============================================================
// GD Studio API
//
// 网易云等其他源继续走这里。
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


  // s 是随机参数，不应该影响缓存
  cacheUrl.searchParams.delete(
    "s"
  );

  // nocache 也不应该进入缓存 key
  cacheUrl.searchParams.delete(
    "nocache"
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
    new URL(
      API_BASE_URL
    );


  url.searchParams.forEach(
    (value, key) => {

      if (
        key === "target" ||
        key === "callback" ||
        key === "s" ||
        key === "nocache"
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

          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  }


  // 默认源：酷我
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


  // name / keywords 兼容
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


  console.log(
    `[API] Request: ${apiUrl.toString()}`
  );


  // ==========================================================
  // 请求 GD Studio
  // ==========================================================

  let upstream: Response;


  try {

    upstream =
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
    EXPOSED_HEADERS.join(", ")
  );


  // ==========================================================
  // 判断是否应该缓存
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
  // 1. 酷我播放地址
  //
  // /proxy?types=url&source=kuwo&id=113118&br=320
  //
  // 这里完全绕过 GD Studio 的 kuwo url 接口。
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
  // 2. 酷我实际音频代理
  //
  // /proxy?target=https://xxx.kuwo.cn/xxx.mp3
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
  // 网易云、JOOX、酷狗等继续走 GD Studio。
  // ==========================================================

  return proxyApiRequest(
    url,
    request,
    waitUntil
  );
}
