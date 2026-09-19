/* 心动星球 API 公共库（Node / Workers 双端可运行） */
export function json(data, status = 200){
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
export const newToken = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
export async function sha(s){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export const pwHash = (email, pw) => sha("hv2|" + String(email).trim().toLowerCase() + "|" + pw);
export const validEmail = e => /^\S+@\S+\.\S+$/.test(String(e || ""));
export async function authUser(request, env){
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return null;
  try {
    const row = await env.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1").bind(token).first();
    if (row) await env.DB.prepare("UPDATE users SET last_seen = ?1 WHERE id = ?2").bind(Date.now(), row.id).run();
    return row || null;
  } catch (e){ return null; }
}
export function safeUser(u){
  let tags = [];
  try { tags = JSON.parse(u.tags || "[]"); } catch (e){}
  return { cid: u.id, email: u.email, name: u.name, gender: u.gender, age: u.age, city: u.city, bio: u.bio, avatar: u.avatar, tags, last_seen: u.last_seen };
}
export function bad(error, status = 400){ return json({ ok: false, error }, status); }
