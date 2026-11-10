// Local browser transport only. CORS grants no application authority; the
// configured handler still verifies all student/staff proofs and current scope.
export function withLocalCors(handler, allowedOrigins = []) {
  return withOriginCors(handler,allowedOrigins,"local");
}
export function publicHttpsOrigin(value) {
  const url = new URL(value);
  if (value !== url.origin || url.protocol !== "https:" || url.hostname.includes("*") ||
      ["localhost","0.0.0.0","[::]","[::1]"].includes(url.hostname) ||
      url.hostname.endsWith(".localhost") || /^127\./.test(url.hostname)) throw Error("INVALID_HTTPS_ORIGIN");
  return value;
}
export function withPublicCors(handler, allowedOrigins) {
  return withOriginCors(handler,allowedOrigins,"public_https");
}
function withOriginCors(handler, allowedOrigins, mode) {
  if (!Array.isArray(allowedOrigins)) throw Error(mode==="local"?"INVALID_LOCAL_ORIGINS":"INVALID_HTTPS_ORIGINS");
  const origins = new Set(allowedOrigins.map(value => {
    if (mode === "public_https") return publicHttpsOrigin(value);
    const url = new URL(value);
    if (value !== url.origin || !["http:", "https:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("INVALID_LOCAL_ORIGIN");
    return value;
  }));
  const methods = ["GET", "POST", "PUT", "PATCH"];
  const headers = ["accept", "authorization", "content-type", "idempotency-key"];
  return async request => {
    const origin = request.headers.get("origin");
    const responseHeaders = new Headers({"cache-control":"no-store", "vary":"Origin"});
    const reject = (code, status) => new Response(JSON.stringify({error:{code,message:code,request_id:crypto.randomUUID()}}),
      {status,headers:new Headers([...responseHeaders,["content-type","application/json; charset=utf-8"]])});
    if (origin !== null && !origins.has(origin)) return reject("CORS_ORIGIN_DENIED", 403);
    if (origin !== null) {
      responseHeaders.set("access-control-allow-origin", origin);
      responseHeaders.set("access-control-expose-headers", "Retry-After");
    }
    if (request.method === "OPTIONS") {
      responseHeaders.set("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      const method = request.headers.get("access-control-request-method");
      const requested = (request.headers.get("access-control-request-headers") ?? "").split(",").map(h => h.trim().toLowerCase());
      if (!origin || !methods.includes(method) || requested.some(h => h && !headers.includes(h)) ||
          !new URL(request.url).pathname.startsWith("/api/v1/")) return reject("CORS_PREFLIGHT_DENIED", 403);
      responseHeaders.set("access-control-allow-methods", methods.join(", "));
      responseHeaders.set("access-control-allow-headers", headers.join(", "));
      return new Response(null,{status:204,headers:responseHeaders});
    }
    const response = await handler(request), merged = new Headers(response.headers);
    for (const [name,value] of responseHeaders) {
      if (name === "vary" && merged.has(name)) merged.set(name, merged.get(name) + ", " + value);
      else merged.set(name,value);
    }
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers:merged});
  };
}
