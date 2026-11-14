import { stringify } from "yaml";
import type { Settings } from "./config";
export function subscription(url: URL, c: Settings, env: Env): Response {
  const format = url.searchParams.get("format") ?? "uri",
    filter = url.searchParams.get("protocol") ?? "all";
  const entries = c.nodes.length
    ? c.nodes
    : [{ host: url.hostname, port: 443, name: "默认入口", region: "" }];
  const protocols = [
    "vless",
    ...(c.trojan ? ["trojan"] : []),
    ...(c.xhttp && format === "uri" ? ["xhttp"] : []),
  ].filter((p) => filter === "all" || filter === p);
  if (!protocols.length)
    return new Response("当前格式不支持所选协议；XHTTP 请使用 URI / Xray。", {
      status: 400,
    });
  const nodes = entries.flatMap((n, i) =>
    protocols.map((p) => {
      const path = `/${p === "xhttp" ? "xhttp" : p === "trojan" ? "trojan" : "ws"}${n.region ? "/" + n.region : ""}`;
      return {
        n,
        p,
        path,
        name: `${n.name || n.host} · ${p.toUpperCase()} · ${i + 1}`,
      };
    }),
  );
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type":
      format === "clash"
        ? "text/yaml; charset=utf-8"
        : format === "singbox"
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8",
  };
  if (format === "uri") {
    const text = nodes
      .map(({ n, p, path, name }) => {
        const params = new URLSearchParams({
          security: "tls",
          sni: url.hostname,
          type: p === "xhttp" ? "xhttp" : "ws",
          host: url.hostname,
          path,
          ...(p === "xhttp" ? { mode: "packet-up" } : {}),
          ...(p !== "trojan" ? { encryption: "none" } : {}),
        });
        return `${p === "trojan" ? "trojan" : "vless"}://${encodeURIComponent(p === "trojan" ? env.TROJAN_PASSWORD : env.NODE_UUID)}@${n.host.includes(":") ? "[" + n.host.replace(/^\[|\]$/g, "") + "]" : n.host}:${n.port}?${params}#${encodeURIComponent(name)}`;
      })
      .join("\n");
    return new Response(
      url.searchParams.get("base64") === "1"
        ? Buffer.from(text).toString("base64")
        : text,
      { headers },
    );
  }
  if (format === "clash") {
    const proxies = nodes.map(({ n, p, path, name }) => ({
      name,
      type: p === "trojan" ? "trojan" : "vless",
      server: n.host,
      port: n.port,
      ...(p === "trojan"
        ? { password: env.TROJAN_PASSWORD }
        : { uuid: env.NODE_UUID }),
      tls: true,
      servername: url.hostname,
      "skip-cert-verify": false,
      udp: false,
      network: "ws",
      "ws-opts": { path, headers: { Host: url.hostname } },
    }));
    return new Response(
      stringify({
        "mixed-port": 7890,
        mode: "rule",
        proxies,
        "proxy-groups": [
          { name: "代理", type: "select", proxies: proxies.map((p) => p.name) },
        ],
        rules: ["AND,((NETWORK,UDP),(DST-PORT,443)),REJECT", "MATCH,代理"],
      }),
      { headers },
    );
  }
  if (format === "singbox") {
    const outbounds = nodes.map(({ n, p, path, name }) => ({
      type: p === "trojan" ? "trojan" : "vless",
      tag: name,
      server: n.host,
      server_port: n.port,
      ...(p === "trojan"
        ? { password: env.TROJAN_PASSWORD }
        : { uuid: env.NODE_UUID }),
      tls: { enabled: true, server_name: url.hostname },
      transport: { type: "ws", path, headers: { Host: url.hostname } },
    }));
    return new Response(
      JSON.stringify(
        {
          inbounds: [
            {
              type: "mixed",
              tag: "mixed-in",
              listen: "127.0.0.1",
              listen_port: 7890,
            },
          ],
          outbounds: [
            {
              type: "selector",
              tag: "proxy",
              outbounds: outbounds.map((o) => o.tag),
            },
            ...outbounds,
          ],
          route: { final: "proxy" },
        },
        null,
        2,
      ),
      { headers },
    );
  }
  return new Response("Unknown format", { status: 400 });
}
