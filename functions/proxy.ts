const API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";

// 酷我允许的域名
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;

// 从上游响应中允许转发的普通响应头
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

// 音频播放需要额外暴露给浏览器的响应头
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

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);

    // 只允许酷我域名，避免形成开放代理
    if (!isAllowedKuwoHost(parsed.hostname)) {
      console.warn(`[KUWO] Blocked host: ${parsed.hostname}`);
      return null;
    }

    // 同时允许 HTTP / HTTPS
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn(`[KUWO] Blocked protocol: ${parsed.protocol}`);
      return null;
    }

    // 不再强制 HTTPS 改成 HTTP
    return parsed;
  } catch (err) {
    console.warn("[KUWO] Invalid URL:", rawUrl, err);
    return null;
  }
}

async function proxyKuwoAudio(
  targetUrl: string,
  request: Request
): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);

  if (!normalized) {
    return new Response("Invalid Kuwo target", {
      status: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const requestHeaders = new Headers();

  // 浏览器常见 User-Agent
  requestHeaders.set(
    "User-Agent",
    request.headers.get("User-Agent") ??
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  );

  // 酷我防盗链可能检查 Referer
  requestHeaders.set("Referer", "https://www.kuwo.cn/");

  // 转发 Range，让浏览器可以正常进行音频分段读取和拖动进度
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    requestHeaders.set("Range", rangeHeader);
  }

  // 某些服务器会根据 Accept 判断请求类型
  const acceptHeader = request.headers.get("Accept");
  if (acceptHeader) {
    requestHeaders.set("Accept", acceptHeader);
  } else {
    requestHeaders.set("Accept", "*/*");
  }

  console.log(
    `[KUWO] Fetching: ${normalized.toString()}${
      rangeHeader ? ` Range=${rangeHeader}` : ""
    }`
  );

  let upstream: Response;

  try {
    upstream = await fetch(normalized.toString(), {
      method: request.method,
      headers: requestHeaders,
      redirect: "follow",
    });
  } catch (err) {
    console.error("[KUWO] Fetch failed:", err);

    return new Response("Kuwo upstream fetch failed", {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Type",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  console.log(
    `[KUWO] Upstream response: ${upstream.status} ${upstream.statusText}`
  );

  const headers = createCorsHeaders(upstream.headers);

  // 音频代理不要使用 no-store，允许边缘缓存
  if (upstream.ok) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  // HEAD 请求没有响应体
  if (request.method === "HEAD") {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(
  url: URL,
  request: Request,
  waitUntil?: (promise: Promise<any>) => void
): Promise<Response> {
  const cache = caches.default;

  const cacheUrl = new URL(url.toString());

  // s 参数不参与缓存键
  cacheUrl.searchParams.delete("s");

  const cacheKey = new Request(cacheUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  // =========================
  // Cache HIT
  // =========================

  if (request.method === "GET") {
    try {
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        const response = new Response(
          cachedResponse.body,
          cachedResponse
        );

        response.headers.set("X-Cache-Status", "HIT");
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

  // =========================
  // 构造 GD Studio API URL
  // =========================

  const apiUrl = new URL(API_BASE_URL);

  url.searchParams.forEach((value, key) => {
    // 这些参数不直接传给 GD Studio
    if (
      key === "target" ||
      key === "callback" ||
      key === "s"
    ) {
      return;
    }

    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", {
      status: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  // =========================
  // 默认音乐源
  // =========================

  if (!apiUrl.searchParams.has("source")) {
    apiUrl.searchParams.set("source", "kuwo");
  }

  // 如果使用 keywords，则转换为 name
  if (!apiUrl.searchParams.has("name")) {
    const nameValue =
      url.searchParams.get("keywords") ||
      url.searchParams.get("name");

    if (nameValue) {
      apiUrl.searchParams.set("name", nameValue);
    }
  }

  console.log(
    `[API] Request: ${apiUrl.toString()}`
  );

  // =========================
  // 请求 GD Studio API
  // =========================

  let upstream: Response;

  try {
    upstream = await fetch(apiUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
  } catch (err) {
    console.error("[API] Fetch failed:", err);

    return new Response("Upstream API fetch failed", {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const responseText = await upstream.text();

  // =========================
  // 响应头
  // =========================

  const headers = createCorsHeaders(
    upstream.headers
  );

  if (!headers.has("Content-Type")) {
    headers.set(
      "Content-Type",
      "application/json; charset=utf-8"
    );
  }

  headers.set("X-Cache-Status", "MISS");
  headers.set(
    "Access-Control-Expose-Headers",
    EXPOSED_HEADERS.join(", ")
  );

  // =========================
  // 判断缓存
  // =========================

  const isSearch =
    url.searchParams.get("types") === "search";

  const isEmptyResult =
    responseText.trim() === "[]";

  const isError =
    responseText.includes('"error"') ||
    responseText.includes('"status":0');

  let shouldCache =
    upstream.status === 200 &&
    request.method === "GET" &&
    !isError;

  // 搜索不到结果时不要缓存
  if (isSearch && isEmptyResult) {
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

  // =========================
  // 返回 API 响应
  // =========================

  const response = new Response(
    responseText,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    }
  );

  // =========================
  // 写入 Cloudflare Cache
  // =========================

  if (shouldCache && waitUntil) {
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

// =========================
// Cloudflare Pages Function
// =========================

export async function onRequest({
  request,
  waitUntil,
}: {
  request: Request;
  waitUntil: (promise: Promise<any>) => void;
}): Promise<Response> {
  // CORS 预检
  if (request.method === "OPTIONS") {
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
          "Access-Control-Allow-Origin": "*",
          "Allow": "GET, HEAD, OPTIONS",
        },
      }
    );
  }

  const url = new URL(request.url);

  // =========================
  // 音频代理
  // =========================

  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(
      target,
      request
    );
  }

  // =========================
  // API 代理
  // =========================

  return proxyApiRequest(
    url,
    request,
    waitUntil
  );
}
