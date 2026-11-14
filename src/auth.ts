import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export function secureEqual(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
function signature(payload: string, env: Env) {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(env.ADMIN_PASSWORD)
    .update(payload)
    .digest("base64url");
}
export function issue(env: Env) {
  const p = `${Date.now() + 8 * 3600000}.${randomBytes(24).toString("base64url")}`;
  return p + "." + signature(p, env);
}
export function authenticated(req: Request, env: Env) {
  const token = req.headers
    .get("Cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("__Host-session="))
    ?.slice(15);
  if (!token) return false;
  const parts = token.split(".");
  return (
    parts.length === 3 &&
    Number(parts[0]) > Date.now() &&
    secureEqual(signature(parts.slice(0, 2).join("."), env), parts[2])
  );
}
export function cookie(value: string, maxAge = 28800) {
  return `__Host-session=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
