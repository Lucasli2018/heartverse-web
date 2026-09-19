/* 心动星球 v2.0 API 路由（Cloudflare Pages Functions，D1 绑定名 DB）
   鉴权：Authorization: Bearer <token>（sessions 表） */
import { json, bad, now, uid, newToken, pwHash, validEmail, authUser, safeUser } from "../_lib/core.mjs";

const FIVE_MIN = 5 * 60e3;
const MAX_TEXT = 2000;
const MAX_IMG = 200000;

export async function onRequest(context){
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;
  if (!env.DB) return bad("D1 未绑定（需在 Pages 配置名为 DB 的 D1 绑定）", 500);
  if (path === "ping") return json({ ok: true, ts: now() });

  let body = {};
  if (method === "POST" || method === "PATCH" || method === "PUT"){
    try { body = await request.json(); } catch (e){ return bad("请求体必须是 JSON"); }
  }

  /* ---- 注册 ---- */
  if (path === "register" && method === "POST"){
    const email = String(body.email || "").trim().toLowerCase();
    const pw = String(body.pw || "");
    const name = String(body.name || "").trim();
    if (!validEmail(email)) return bad("邮箱格式不正确");
    if (pw.length < 6) return bad("密码至少 6 位");
    if (!name || name.length > 20) return bad("昵称必填且不超过 20 字");
    const dup = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (dup) return bad("该邮箱已注册", 409);
    const id = uid();
    const age = Math.max(18, Math.min(99, parseInt(body.age, 10) || 25));
    await env.DB.prepare("INSERT INTO users (id, email, pw, name, gender, age, city, bio, avatar, tags, created, last_seen) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)")
      .bind(id, email, await pwHash(email, pw), name, String(body.gender || "保密"), age,
        String(body.city || "深圳"), String(body.bio || "").slice(0, 500), String(body.avatar || "😊"),
        JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 8) : []), now(), now()).run();
    const token = newToken();
    await env.DB.prepare("INSERT INTO sessions (token, user_id, created) VALUES (?1,?2,?3)").bind(token, id, now()).run();
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first();
    return json({ ok: true, token, user: safeUser(u) });
  }

  /* ---- 登录 ---- */
  if (path === "login" && method === "POST"){
    const email = String(body.email || "").trim().toLowerCase();
    const pw = String(body.pw || "");
    const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first();
    if (!u || u.pw !== (await pwHash(email, pw))) return bad("邮箱或密码错误", 401);
    const token = newToken();
    await env.DB.prepare("INSERT INTO sessions (token, user_id, created) VALUES (?1,?2,?3)").bind(token, u.id, now()).run();
    return json({ ok: true, token, user: safeUser(u) });
  }

  /* ---- 以下全部需要登录 ---- */
  const me = await authUser(request, env);
  if (!me) return bad("未登录或会话已过期", 401);

  if (path === "me" && method === "GET") return json({ ok: true, user: safeUser(me) });

  if (path === "profile" && (method === "PATCH" || method === "POST")){
    const name = String(body.name ?? me.name).trim();
    if (!name || name.length > 20) return bad("昵称必填且不超过 20 字");
    const age = Math.max(18, Math.min(99, parseInt(body.age, 10) || me.age));
    await env.DB.prepare("UPDATE users SET name=?1, gender=?2, age=?3, city=?4, bio=?5, avatar=?6, tags=?7 WHERE id=?8")
      .bind(name, String(body.gender || me.gender), age, String(body.city || me.city),
        String(body.bio ?? me.bio).slice(0, 500), String(body.avatar || me.avatar),
        JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 8) : JSON.parse(me.tags || "[]")), me.id).run();
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(me.id).first();
    return json({ ok: true, user: safeUser(u) });
  }

  /* ---- 发现：真实用户列表（排除自己/我拉黑的/拉黑我的） ---- */
  if (path === "users" && method === "GET"){
    const r = await env.DB.prepare(`SELECT * FROM users WHERE id != ?1
      AND id NOT IN (SELECT blocked FROM blocks WHERE user_id = ?1)
      AND id NOT IN (SELECT user_id FROM blocks WHERE blocked = ?1)
      ORDER BY created DESC LIMIT 200`).bind(me.id).all();
    return json({ ok: true, users: r.results.map(safeUser) });
  }

  /* ---- 喜欢（双向即匹配） ---- */
  if (path === "like" && method === "POST"){
    const target = String(body.target || "");
    const sup = body.sup ? 1 : 0;
    if (target === me.id) return bad("不能喜欢自己");
    const t = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(target).first();
    if (!t) return bad("用户不存在", 404);
    const blocked = await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE (user_id=?1 AND blocked=?2) OR (user_id=?2 AND blocked=?1)").bind(me.id, target).first();
    if (blocked) return bad("该用户不可用", 403);
    await env.DB.prepare("INSERT OR IGNORE INTO likes (liker, target, sup, ts) VALUES (?1,?2,?3,?4)").bind(me.id, target, sup, now()).run();
    const back = await env.DB.prepare("SELECT 1 AS x FROM likes WHERE liker=?1 AND target=?2").bind(target, me.id).first();
    if (!back) return json({ ok: true, matched: false });
    let m = await env.DB.prepare("SELECT * FROM matches WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)").bind(me.id, target).first();
    if (!m){
      const mid = uid();
      await env.DB.prepare("INSERT INTO matches (id, a, b, ts, pinned_a, pinned_b, read_a, read_b) VALUES (?1,?2,?3,?4,0,0,?4,?4)").bind(mid, me.id, target, now()).run();
      m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    }
    return json({ ok: true, matched: true, match: await matchPayload(env, m, me), other: safeUser(t) });
  }

  /* ---- 喜欢我的人（未回赞、无匹配的） ---- */
  if (path === "likedme" && method === "GET"){
    const r = await env.DB.prepare(`SELECT u.*, l.sup FROM likes l JOIN users u ON u.id = l.liker
      WHERE l.target = ?1
      AND l.liker NOT IN (SELECT blocked FROM blocks WHERE user_id = ?1)
      AND l.liker NOT IN (SELECT user_id FROM blocks WHERE blocked = ?1)
      AND l.liker NOT IN (SELECT CASE WHEN a=?1 THEN b ELSE a END FROM matches WHERE a=?1 OR b=?1)
      ORDER BY l.ts DESC LIMIT 100`).bind(me.id).all();
    return json({ ok: true, users: r.results.map(row => ({ ...safeUser(row), sup: row.sup })) });
  }

  /* ---- 匹配列表（含最近消息与未读） ---- */
  if (path === "matches" && method === "GET"){
    const r = await env.DB.prepare("SELECT * FROM matches WHERE a=?1 OR b=?1 ORDER BY ts DESC").bind(me.id).all();
    const out = [];
    for (const m of r.results){
      const otherId = m.a === me.id ? m.b : m.a;
      const blocked = await env.DB.prepare("SELECT 1 AS x FROM blocks WHERE (user_id=?1 AND blocked=?2) OR (user_id=?2 AND blocked=?1)").bind(me.id, otherId).first();
      if (blocked) continue;
      out.push(await matchPayload(env, m, me));
    }
    return json({ ok: true, matches: out });
  }

  /* ---- 消息：分页（before 为游标取更早，默认最新 200 条） ---- */
  if (path === "messages" && method === "GET"){
    const mid = url.searchParams.get("match") || "";
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("匹配不存在", 404);
    const before = parseInt(url.searchParams.get("before"), 10) || 0;
    let r;
    if (before > 0){
      r = await env.DB.prepare("SELECT id, sender, text, img, recalled, ts FROM messages WHERE match_id = ?1 AND ts < ?2 ORDER BY ts DESC LIMIT 50").bind(mid, before).all();
      r.results.reverse();
    } else {
      r = await env.DB.prepare("SELECT id, sender, text, img, recalled, ts FROM messages WHERE match_id = ?1 ORDER BY ts DESC LIMIT 200").bind(mid).all();
      r.results.reverse();
    }
    return json({ ok: true, msgs: r.results, has_more: r.results.length === (before > 0 ? 50 : 200) });
  }

  /* ---- 发消息 ---- */
  if (path === "send" && method === "POST"){
    const mid = String(body.match || "");
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("匹配不存在", 404);
    const text = String(body.text || "").slice(0, MAX_TEXT);
    const img = String(body.img || "").slice(0, MAX_IMG);
    if (!text && !img) return bad("消息不能为空");
    if (img && !img.startsWith("data:image/")) return bad("图片格式不支持");
    const g = uid();
    await env.DB.prepare("INSERT INTO messages (id, match_id, sender, text, img, recalled, ts) VALUES (?1,?2,?3,?4,?5,0,?6)").bind(g, mid, me.id, text, img, now()).run();
    return json({ ok: true, msg: { id: g, sender: me.id, text, img, recalled: 0, ts: now() } });
  }

  /* ---- 撤回（自己 5 分钟内） ---- */
  if (path === "recall" && method === "POST"){
    const g = await env.DB.prepare("SELECT * FROM messages WHERE id = ?1").bind(String(body.msg || "")).first();
    if (!g) return bad("消息不存在", 404);
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(g.match_id).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("无权操作", 403);
    if (g.sender !== me.id) return bad("只能撤回自己的消息", 403);
    if (now() - g.ts > FIVE_MIN) return bad("超过 5 分钟，无法撤回", 403);
    await env.DB.prepare("UPDATE messages SET recalled = 1 WHERE id = ?1").bind(g.id).run();
    return json({ ok: true });
  }

  /* ---- 置顶 ---- */
  if (path === "pin" && method === "POST"){
    const mid = String(body.match || "");
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("匹配不存在", 404);
    const col = m.a === me.id ? "pinned_a" : "pinned_b";
    await env.DB.prepare(`UPDATE matches SET ${col} = ?1 WHERE id = ?2`).bind(body.pinned ? 1 : 0, mid).run();
    return json({ ok: true });
  }

  /* ---- 已读 ---- */
  if (path === "read" && method === "POST"){
    const mid = String(body.match || "");
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("匹配不存在", 404);
    const col = m.a === me.id ? "read_a" : "read_b";
    await env.DB.prepare(`UPDATE matches SET ${col} = ?1 WHERE id = ?2`).bind(now(), mid).run();
    return json({ ok: true });
  }

  /* ---- 拉黑：删匹配、删消息、删点赞 ---- */
  if (path === "block" && method === "POST"){
    const target = String(body.target || "");
    if (target === me.id) return bad("不能拉黑自己");
    const t = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(target).first();
    if (!t) return bad("用户不存在", 404);
    await env.DB.prepare("INSERT OR IGNORE INTO blocks (user_id, blocked, ts) VALUES (?1,?2,?3)").bind(me.id, target, now()).run();
    const ms = await env.DB.prepare("SELECT id FROM matches WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)").bind(me.id, target).all();
    for (const m of ms.results){
      await env.DB.prepare("DELETE FROM messages WHERE match_id = ?1").bind(m.id).run();
      await env.DB.prepare("DELETE FROM matches WHERE id = ?1").bind(m.id).run();
    }
    await env.DB.prepare("DELETE FROM likes WHERE (liker=?1 AND target=?2) OR (liker=?2 AND target=?1)").bind(me.id, target).run();
    await env.DB.prepare("UPDATE proposals SET status = 'rejected' WHERE status = 'pending' AND ((from_uid=?1 AND to_uid=?2) OR (from_uid=?2 AND to_uid=?1))").bind(me.id, target).run();
    await env.DB.prepare("DELETE FROM couples WHERE (user_id=?1 AND partner=?2) OR (user_id=?2 AND partner=?1)").bind(me.id, target).run();
    return json({ ok: true });
  }

  /* ---- 头像上传（压缩 dataURL，≤40KB 字符） ---- */
  if (path === "avatar" && (method === "PUT" || method === "POST")){
    const img = String(body.img || "");
    if (!img.startsWith("data:image/")) return bad("图片格式不支持");
    if (img.length > 40000) return bad("头像图片过大，请重新选择");
    await env.DB.prepare("UPDATE users SET avatar_url = ?1 WHERE id = ?2").bind(img, me.id).run();
    return json({ ok: true, avatar_url: img });
  }

  /* ---- 动态广场（云端） ---- */
  if (path === "posts" && method === "GET"){
    const r = await env.DB.prepare(`SELECT p.id, p.uid, p.text, p.ts, u.name, u.avatar, u.city FROM posts p JOIN users u ON u.id = p.uid
      WHERE p.uid NOT IN (SELECT blocked FROM blocks WHERE user_id = ?1)
      AND p.uid NOT IN (SELECT user_id FROM blocks WHERE blocked = ?1)
      ORDER BY p.ts DESC LIMIT 50`).bind(me.id).all();
    const out = [];
    for (const row of r.results){
      const likes = await env.DB.prepare("SELECT uid FROM post_likes WHERE post_id = ?1").bind(row.id).all();
      const cmts = await env.DB.prepare("SELECT c.id, c.uid, c.text, c.ts, u.name FROM comments c JOIN users u ON u.id = c.uid WHERE c.post_id = ?1 ORDER BY c.ts ASC LIMIT 50").bind(row.id).all();
      out.push({ sid: row.id, author: { cid: row.uid, name: row.name, avatar: row.avatar, city: row.city }, text: row.text, ts: row.ts,
        liked: likes.results.some(l => l.uid === me.id), likes: likes.results.length,
        comments: cmts.results.map(c => ({ cid: c.uid, name: c.name, text: c.text, ts: c.ts })) });
    }
    return json({ ok: true, posts: out });
  }
  if (path === "post" && method === "POST"){
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return bad("动态不能为空");
    const pid = uid();
    await env.DB.prepare("INSERT INTO posts (id, uid, text, ts) VALUES (?1,?2,?3,?4)").bind(pid, me.id, text, now()).run();
    return json({ ok: true, post: { sid: pid, author: { cid: me.id, name: me.name, avatar: me.avatar, city: me.city }, text, ts: now(), liked: false, likes: 0, comments: [] } });
  }
  if (path === "post_like" && method === "POST"){
    const pid = String(body.post || "");
    const p = await env.DB.prepare("SELECT id FROM posts WHERE id = ?1").bind(pid).first();
    if (!p) return bad("动态不存在", 404);
    const hit = await env.DB.prepare("SELECT 1 AS x FROM post_likes WHERE post_id = ?1 AND uid = ?2").bind(pid, me.id).first();
    if (hit){
      await env.DB.prepare("DELETE FROM post_likes WHERE post_id = ?1 AND uid = ?2").bind(pid, me.id).run();
    } else {
      await env.DB.prepare("INSERT INTO post_likes (post_id, uid, ts) VALUES (?1,?2,?3)").bind(pid, me.id, now()).run();
    }
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?1").bind(pid).first();
    return json({ ok: true, liked: !hit, count: c.n });
  }
  if (path === "comment" && method === "POST"){
    const pid = String(body.post || "");
    const text = String(body.text || "").trim().slice(0, 200);
    if (!text) return bad("评论不能为空");
    const p = await env.DB.prepare("SELECT id FROM posts WHERE id = ?1").bind(pid).first();
    if (!p) return bad("动态不存在", 404);
    const cid = uid();
    await env.DB.prepare("INSERT INTO comments (id, post_id, uid, text, ts) VALUES (?1,?2,?3,?4,?5)").bind(cid, pid, me.id, text, now()).run();
    return json({ ok: true, comment: { cid: me.id, name: me.name, text, ts: now() } });
  }

  /* ---- 访客 ---- */
  if (path === "visit" && method === "POST"){
    const target = String(body.target || "");
    if (target === me.id) return json({ ok: true });
    const t = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(target).first();
    if (!t) return bad("用户不存在", 404);
    await env.DB.prepare("INSERT OR REPLACE INTO visits (owner, visitor, ts) VALUES (?1,?2,?3)").bind(target, me.id, now()).run();
    return json({ ok: true });
  }
  if (path === "visits" && method === "GET"){
    const r = await env.DB.prepare(`SELECT v.ts, u.* FROM visits v JOIN users u ON u.id = v.visitor
      WHERE v.owner = ?1
      AND v.visitor NOT IN (SELECT blocked FROM blocks WHERE user_id = ?1)
      AND v.visitor NOT IN (SELECT user_id FROM blocks WHERE blocked = ?1)
      ORDER BY v.ts DESC LIMIT 50`).bind(me.id).all();
    return json({ ok: true, visits: r.results.map(u => ({ ...safeUser(u), visited_at: u.ts })) });
  }

  /* ---- 表白 / 情侣（云端，双方同意） ---- */
  if (path === "propose" && method === "POST"){
    const mid = String(body.match || "");
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("匹配不存在", 404);
    const otherId = m.a === me.id ? m.b : m.a;
    const cp = await env.DB.prepare("SELECT partner FROM couples WHERE user_id = ?1 OR user_id = ?2").bind(me.id, otherId).first();
    if (cp) return bad("有一方已在恋爱中", 409);
    const pend = await env.DB.prepare("SELECT id FROM proposals WHERE status = 'pending' AND ((from_uid=?1 AND to_uid=?2) OR (from_uid=?2 AND to_uid=?1))").bind(me.id, otherId).first();
    if (pend) return bad("已有待处理的表白", 409);
    await env.DB.prepare("INSERT INTO proposals (id, from_uid, to_uid, ts, status) VALUES (?1,?2,?3,?4,'pending')").bind(uid(), me.id, otherId, now()).run();
    return json({ ok: true });
  }
  if (path === "proposal" && method === "POST"){
    const pr = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?1").bind(String(body.id || "")).first();
    if (!pr || pr.to_uid !== me.id || pr.status !== "pending") return bad("表白不存在或已处理", 404);
    await env.DB.prepare("UPDATE proposals SET status = ?1 WHERE id = ?2").bind(body.accept ? "accepted" : "rejected", pr.id).run();
    if (body.accept){
      const since = now();
      await env.DB.prepare("INSERT OR REPLACE INTO couples (user_id, partner, since) VALUES (?1,?2,?3)").bind(me.id, pr.from_uid, since).run();
      await env.DB.prepare("INSERT OR REPLACE INTO couples (user_id, partner, since) VALUES (?1,?2,?3)").bind(pr.from_uid, me.id, since).run();
      const m = await env.DB.prepare("SELECT * FROM matches WHERE (a=?1 AND b=?2) OR (a=?2 AND b=?1)").bind(me.id, pr.from_uid).first();
      if (m) await env.DB.prepare("INSERT INTO messages (id, match_id, sender, text, img, recalled, ts) VALUES (?1,?2,?3,?4,'',0,?5)")
        .bind(uid(), m.id, me.id, "💞 我们在一起啦！从今天起要好好相爱哦 🎉", since).run();
    }
    return json({ ok: true });
  }
  if (path === "breakup" && method === "POST"){
    const mid = String(body.match || "");
    const m = await env.DB.prepare("SELECT * FROM matches WHERE id = ?1").bind(mid).first();
    if (!m || (m.a !== me.id && m.b !== me.id)) return bad("匹配不存在", 404);
    const otherId = m.a === me.id ? m.b : m.a;
    await env.DB.prepare("DELETE FROM couples WHERE (user_id=?1 AND partner=?2) OR (user_id=?2 AND partner=?1)").bind(me.id, otherId).run();
    return json({ ok: true });
  }

  return bad("接口不存在: " + path, 404);
}

/* 匹配详情负载（对方资料 + 我的置顶/已读 + 最近消息 + 表白/情侣状态） */
async function matchPayload(env, m, me){
  const otherId = m.a === me.id ? m.b : m.a;
  const mine = m.a === me.id;
  const other = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(otherId).first();
  const msgs = await env.DB.prepare("SELECT id, sender, text, img, recalled, ts FROM messages WHERE match_id = ?1 ORDER BY ts DESC LIMIT 200").bind(m.id).all();
  const read = mine ? m.read_a : m.read_b;
  const prop = await env.DB.prepare("SELECT id, from_uid, ts FROM proposals WHERE status = 'pending' AND ((from_uid=?1 AND to_uid=?2) OR (from_uid=?2 AND to_uid=?1))").bind(me.id, otherId).first();
  const cp = await env.DB.prepare("SELECT partner, since FROM couples WHERE user_id = ?1").bind(me.id).first();
  return {
    id: m.id, a: m.a, b: m.b, ts: m.ts,
    pinned: mine ? !!m.pinned_a : !!m.pinned_b,
    my_read: read,
    other: other ? safeUser(other) : null,
    msgs: msgs.results.reverse(),
    has_more: msgs.results.length === 200,
    proposal_in: prop && prop.from_uid === otherId ? { id: prop.id, ts: prop.ts } : null,
    proposal_out: !!(prop && prop.from_uid === me.id),
    couple: cp && cp.partner === otherId ? { partner: otherId, since: cp.since } : null
  };
}
