const UPSTREAM_RELAY = "https://bitchat-private-relay.soft-api-7mskfl.workers.dev";
const ALLOWED_PATHS = new Set(["/health", "/poll", "/publish", "/invite/create", "/invite/resolve"]);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const upstreamPath = requestUrl.pathname.replace(/^\/relay(?=\/|$)/, "") || "/health";
  if (!ALLOWED_PATHS.has(upstreamPath)) return new Response("Not found", { status: 404, headers: corsHeaders() });
  if (context.request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  const upstreamUrl = new URL(upstreamPath, UPSTREAM_RELAY);
  upstreamUrl.search = requestUrl.search;
  const upstreamRequest = new Request(upstreamUrl, context.request);
  const response = await fetch(upstreamRequest);
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
