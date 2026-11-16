import { reportError } from "./debug";
import panel from "./panel/index.html";
import { settings, validate, key, defaults } from "./config";
import { authenticated, issue, cookie, secureEqual } from "./auth";
import { bounded, decoder } from "./bytes";
import { proxyURL } from "./outbound";
import { websocket } from "./transport";
import { subscription } from "./subscription";
export { XhttpSession } from "./xhttp";
const security = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (
        !env.ADMIN_PASSWORD ||
        env.ADMIN_PASSWORD.length < 16 ||
        !env.SESSION_SECRET ||
        env.SESSION_SECRET.length < 32 ||
        !env.SUB_TOKEN ||
        env.SUB_TOKEN.length < 32 ||
        !env.TROJAN_PASSWORD ||
        env.TROJAN_PASSWORD.length < 16 ||
        !/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
          env.NODE_UUID ?? "",
        )
      )
        return new Response("请先配置全部独立密钥。", {
          status: 503,
          headers: security,
        });
      if (url.pathname === "/" && req.method === "GET")
        return new Response(panel, {
          headers: { ...security, "Content-Type": "text/html; charset=utf-8" },
        });
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.headers.get("Origin") !== url.origin)
          return new Response(null, { status: 403, headers: security });
        if (url.pathname === "/api/login" && req.method === "POST") {
          const data = JSON.parse(
            decoder.decode(await bounded(req.body, 4096)),
          );
          if (
            typeof data.password !== "string" ||
            !secureEqual(data.password, env.ADMIN_PASSWORD)
          )
            return Response.json(
              { error: "登录失败" },
              { status: 401, headers: security },
            );
          return Response.json(
            { ok: true },
            { headers: { ...security, "Set-Cookie": cookie(issue(env)) } },
          );
        }
        if (!authenticated(req, env))
          return new Response(null, { status: 401, headers: security });
        if (url.pathname === "/api/logout" && req.method === "POST")
          return Response.json(
            { ok: true },
            { headers: { ...security, "Set-Cookie": cookie("", 0) } },
          );
        if (url.pathname === "/api/settings" && req.method === "GET") {
          const c = await settings(env);
          return Response.json(
            {
              ...c,
              outbound: c.outbound ? "[已配置]" : "",
              subscription: `${url.origin}/sub/${encodeURIComponent(env.SUB_TOKEN)}`,
              uuid: env.NODE_UUID,
            },
            { headers: security },
          );
        }
        if (url.pathname === "/api/settings" && req.method === "PUT") {
          const data = JSON.parse(
            decoder.decode(await bounded(req.body, 262144)),
          );
          if (data.outbound === "[已配置]")
            data.outbound = (await settings(env)).outbound;
          const c = validate(data);
          if (c.outbound) proxyURL(c.outbound);
          await env.CONFIG.put(key, JSON.stringify(c));
          return Response.json({ ok: true }, { headers: security });
        }
        if (url.pathname === "/api/reset" && req.method === "POST") {
          await env.CONFIG.delete(key);
          return Response.json(
            { ok: true, settings: defaults },
            { headers: security },
          );
        }
        return new Response(null, { status: 404, headers: security });
      }
      const c = await settings(env);
      if (url.pathname.startsWith("/sub/")) {
        if (
          !secureEqual(decodeURIComponent(url.pathname.slice(5)), env.SUB_TOKEN)
        )
          return new Response(null, { status: 404, headers: security });
        const res = subscription(url, c, env);
        for (const [k, v] of Object.entries(security)) res.headers.set(k, v);
        return res;
      }
      const ws = url.pathname.match(/^\/(ws|trojan)(?:\/([A-Z]{2}))?\/?$/);
      if (
        ws &&
        req.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
        (ws[1] !== "trojan" || c.trojan)
      )
        return websocket(
          req,
          env,
          c,
          ws[1] === "trojan" ? "trojan" : "vless",
          ws[2] ?? "",
        );
      const x = url.pathname.match(
        /^\/xhttp\/(?:([A-Z]{2})\/)?([a-zA-Z0-9_-]{16,64})(?:\/(\d{1,10}))?\/?$/,
      );
      if (
        x &&
        c.xhttp &&
        ((req.method === "GET" && x[3] === undefined) ||
          (req.method === "POST" && x[3] !== undefined))
      )
        return await env.XHTTP.getByName(x[2]).handle(req, c, x[1] ?? "");
      return new Response("Not found", { status: 404, headers: security });
    } catch (error) {
      reportError(env, "fetch", error);
      return Response.json(
        { error: "请求失败，请检查输入与服务配置。" },
        { status: 400, headers: security },
      );
    }
  },
} satisfies ExportedHandler<Env>;
