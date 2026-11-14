export interface Endpoint {
  host: string;
  port: number;
  name: string;
  region: string;
}
export interface Settings {
  nodes: Endpoint[];
  relays: Endpoint[];
  outbound: string;
  mode: "direct" | "auto" | "only";
  ports: number[];
  xhttp: boolean;
  trojan: boolean;
}
export const key = "cf-vless-panel:settings:v1";
export const defaults: Settings = {
  nodes: [],
  relays: [],
  outbound: "",
  mode: "direct",
  ports: [
    80, 443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443, 8880,
  ],
  xhttp: true,
  trojan: true,
};
export async function settings(env: Env): Promise<Settings> {
  return (
    (await env.CONFIG.get<Settings>(key, "json")) ?? structuredClone(defaults)
  );
}
export function validate(value: unknown): Settings {
  const v = value as Settings;
  if (
    !v ||
    !["direct", "auto", "only"].includes(v.mode) ||
    typeof v.outbound !== "string" ||
    v.outbound.length > 4096 ||
    typeof v.xhttp !== "boolean" ||
    typeof v.trojan !== "boolean"
  )
    throw Error("配置格式错误");
  if (
    !Array.isArray(v.ports) ||
    !v.ports.length ||
    v.ports.length > 32 ||
    !v.ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)
  )
    throw Error("目标端口无效");
  for (const [list, max] of [
    [v.nodes, 1000],
    [v.relays, 100],
  ] as const) {
    if (!Array.isArray(list) || list.length > max) throw Error("节点数量超限");
    for (const n of list)
      if (
        !n ||
        typeof n.host !== "string" ||
        !/^[a-zA-Z0-9.:[\]-]{1,253}$/.test(n.host) ||
        !Number.isInteger(n.port) ||
        n.port < 1 ||
        n.port > 65535 ||
        typeof n.name !== "string" ||
        n.name.length > 100 ||
        !/^(?:[A-Z]{2})?$/.test(n.region)
      )
        throw Error("节点格式错误");
  }
  if (v.mode === "only" && !v.outbound) throw Error("仅出口模式必须配置代理");
  return {
    nodes: v.nodes,
    relays: v.relays,
    outbound: v.outbound,
    mode: v.mode,
    ports: v.ports,
    xhttp: v.xhttp,
    trojan: v.trojan,
  };
}
