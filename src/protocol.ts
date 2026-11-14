import { createHash } from "node:crypto";
import { Reader, decoder, equal } from "./bytes";
export interface Target {
  host: string;
  port: number;
}
export async function address(
  r: Reader,
  type: number,
  vless = false,
): Promise<string> {
  if (type === 1) return [...(await r.take(4))].join(".");
  if (type === (vless ? 2 : 3))
    return decoder.decode(await r.take((await r.take(1))[0]));
  if (type === (vless ? 3 : 4)) {
    const b = await r.take(16);
    return Array.from({ length: 8 }, (_, i) =>
      ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16),
    ).join(":");
  }
  throw Error("Address type");
}
export async function handshake(
  r: Reader,
  protocol: "vless" | "trojan",
  env: Env,
): Promise<Target & { response: Uint8Array }> {
  if (protocol === "trojan") {
    const h = decoder.decode(await r.take(56));
    if (
      !equal(h, createHash("sha224").update(env.TROJAN_PASSWORD).digest("hex"))
    )
      throw Error("Authentication");
    const prefix = await r.take(4);
    if (prefix[0] !== 13 || prefix[1] !== 10 || prefix[2] !== 1)
      throw Error("TCP only");
    const host = await address(r, prefix[3]);
    const p = await r.take(2);
    const tail = await r.take(2);
    if (tail[0] !== 13 || tail[1] !== 10) throw Error("Header");
    return { host, port: (p[0] << 8) | p[1], response: new Uint8Array() };
  }
  const head = await r.take(18);
  if (head[0] !== 0) throw Error("Version");
  const uuid = [...head.slice(1, 17)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (!equal(uuid, env.NODE_UUID.replaceAll("-", "").toLowerCase()))
    throw Error("Authentication");
  await r.take(head[17]);
  const p = await r.take(4);
  if (p[0] !== 1) throw Error("TCP only");
  return {
    host: await address(r, p[3], true),
    port: (p[1] << 8) | p[2],
    response: new Uint8Array([0, 0]),
  };
}
