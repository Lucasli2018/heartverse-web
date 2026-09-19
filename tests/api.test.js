/* 心动星球 API 单测：node:sqlite 仿真 D1，直跑 Pages Functions 路由
   运行：node tests/api.test.js（需 Node 22.13+ / 24+，D:\tools\node\node.exe） */
"use strict";
import { onRequest } from "../functions/api/[[route]].mjs";
import { makeD1 } from "./_d1.mjs";

let pass = 0, fail = 0;
const ok = (cond, name) => cond ? (pass++, console.log("  PASS", name)) : (fail++, console.log("  FAIL", name));

const env = { DB: makeD1() };
const call = async (method, path, { body, token } = {}) => {
  const req = new Request("http://x/api/" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const res = await onRequest({ request: req, env });
  return { status: res.status, data: await res.json() };
};

const U = (email, name, gender) => ({ email, pw: "secret66", name, gender, age: 26, city: "深圳", bio: "测试", avatar: "🐱", tags: ["咖啡"] });

(async () => {
  console.log("== 基础 ==");
  ok((await call("GET", "ping")).data.ok === true, "ping 通");
  ok((await call("POST", "register", { body: { email: "bad", pw: "123456", name: "x" } })).status === 400, "邮箱校验");
  ok((await call("POST", "register", { body: { email: "a@t.co", pw: "12345", name: "x" } })).status === 400, "密码长度校验");
  const ra = await call("POST", "register", { body: U("a@t.co", "小A", "女") });
  ok(ra.data.ok === true && ra.data.token && ra.data.user.cid, "注册成功返回 token+user");
  ok((await call("POST", "register", { body: U("a@t.co", "小A2", "女") })).status === 409, "重复邮箱 409");
  ok((await call("POST", "login", { body: { email: "a@t.co", pw: "wrong11" } })).status === 401, "错误密码 401");
  const la = await call("POST", "login", { body: { email: "a@t.co", pw: "secret66" } });
  ok(la.data.ok === true && la.data.token, "登录成功");
  const ta = la.data.token;
  ok((await call("GET", "me", { token: ta })).data.user.name === "小A", "me 返回资料");
  ok((await call("GET", "me")).status === 401, "无 token 401");

  console.log("== 发现 / 喜欢 / 匹配 ==");
  const rb = await call("POST", "register", { body: U("b@t.co", "小B", "男") });
  const tb = rb.data.token;
  const rc = await call("POST", "register", { body: U("c@t.co", "小C", "女") });
  const tc = rc.data.token;
  const usersForA = (await call("GET", "users", { token: ta })).data.users;
  ok(usersForA.length === 2 && !usersForA.some(u => u.cid === ra.data.user.cid), "users 排除自己");
  ok((await call("POST", "like", { token: ta, body: { target: ra.data.user.cid } })).status === 400, "不能喜欢自己");
  ok((await call("POST", "like", { token: ta, body: { target: "nope" } })).status === 404, "目标不存在 404");
  ok((await call("POST", "like", { token: ta, body: { target: rb.data.user.cid, sup: 1 } })).data.matched === false, "A 喜 B 未匹配");
  ok((await call("GET", "likedme", { token: tb })).data.users.length === 1, "B 看到喜欢我");
  const lk = await call("POST", "like", { token: tb, body: { target: ra.data.user.cid } });
  ok(lk.data.matched === true && lk.data.match.id && lk.data.other.name === "小A", "B 回赞 → 匹配成功");
  const lk2 = await call("POST", "like", { token: tb, body: { target: ra.data.user.cid } });
  ok(lk2.data.matched === true && lk2.data.match.id === lk.data.match.id, "重复喜欢不建新匹配");
  ok((await call("GET", "likedme", { token: tb })).data.users.length === 0, "已匹配者不再出现在喜欢我");

  console.log("== 聊天 ==");
  const mid = lk.data.match.id;
  const s1 = await call("POST", "send", { token: ta, body: { match: mid, text: "你好呀 👋" } });
  ok(s1.data.ok === true && s1.data.msg.text.includes("你好"), "A 发消息");
  ok((await call("POST", "send", { token: ta, body: { match: mid } })).status === 400, "空消息拒绝");
  await call("POST", "send", { token: tb, body: { match: mid, text: "嗨！" } });
  const beforeRead = (await call("GET", "matches", { token: ta })).data.matches.find(m => m.id === mid);
  ok(beforeRead.msgs.length === 2 && beforeRead.msgs.some(g => g.sender === rb.data.user.cid), "消息列表含双方");
  ok(beforeRead.my_read < beforeRead.msgs.at(-1).ts, "A 未读（read 时间落后）");
  await call("POST", "read", { token: ta, body: { match: mid } });
  const afterRead = (await call("GET", "matches", { token: ta })).data.matches.find(m => m.id === mid);
  ok(afterRead.my_read >= afterRead.msgs.at(-1).ts, "已读后 read 时间更新");
  const pin = await call("POST", "pin", { token: ta, body: { match: mid, pinned: true } });
  ok(pin.data.ok === true && (await call("GET", "matches", { token: ta })).data.matches.find(m => m.id === mid).pinned === true, "A 置顶");
  ok((await call("GET", "matches", { token: tb })).data.matches.find(m => m.id === mid).pinned === false, "B 视角逐未置顶");
  const msg1 = s1.data.msg.id;
  ok((await call("POST", "recall", { token: tb, body: { msg: msg1 } })).status === 403, "不能撤回他人消息");
  ok((await call("POST", "recall", { token: ta, body: { msg: msg1 } })).data.ok === true, "5 分钟内撤回成功");
  const respNoMatch = await call("GET", "messages", { token: ta });
  ok(respNoMatch.status === 404, "缺 match 参数 404");
  const r2 = await onRequest({ request: new Request("http://x/api/messages?match=" + mid, { headers: { Authorization: "Bearer " + ta } }), env });
  const msgs2 = (await r2.json()).msgs;
  ok(msgs2.find(g => g.id === msg1).recalled === 1, "撤回状态同步到对方");

  console.log("== 拉黑 ==");
  await call("POST", "like", { token: tc, body: { target: ra.data.user.cid } });
  ok((await call("GET", "likedme", { token: ta })).data.users.length === 1, "C 喜欢 A 出现在喜欢我");
  await call("POST", "block", { token: ta, body: { target: rc.data.user.cid } });
  ok((await call("GET", "likedme", { token: ta })).data.users.length === 0, "拉黑后 C 从喜欢我消失");
  ok(!(await call("GET", "users", { token: ta })).data.users.some(u => u.cid === rc.data.user.cid), "拉黑后 C 从发现消失");
  ok((await call("POST", "like", { token: ta, body: { target: rc.data.user.cid } })).status === 403, "拉黑后不能喜欢");
  const bm = await call("POST", "like", { token: tb, body: {} }); void bm;
  await call("POST", "like", { token: tc, body: { target: rb.data.user.cid } });
  await call("POST", "like", { token: tb, body: { target: rc.data.user.cid } });
  const midBC = (await call("GET", "matches", { token: tb })).data.matches.find(m => m.other.cid === rc.data.user.cid).id;
  await call("POST", "send", { token: tb, body: { match: midBC, text: "要被拉黑的话" } });
  await call("POST", "block", { token: rc.data.user.cid ? tc : tc, body: { target: rb.data.user.cid } });
  ok(!(await call("GET", "matches", { token: tb })).data.matches.some(m => m.id === midBC), "拉黑后匹配与消息删除");

  console.log("== 资料 ==");
  const pf = await call("PATCH", "profile", { token: ta, body: { name: "小A改", age: 27, tags: ["咖啡", "旅行", "健身"] } });
  ok(pf.data.ok === true && pf.data.user.name === "小A改" && pf.data.user.age === 27 && pf.data.user.tags.length === 3, "资料更新");
  ok((await call("PATCH", "profile", { token: ta, body: { name: "" } })).status === 400, "空昵称拒绝");

  console.log("== v2.1 动态云端 ==");
  const pp = await call("POST", "post", { token: ta, body: { text: "第一条云端动态 ✨" } });
  ok(pp.data.ok === true && pp.data.post.sid && pp.data.post.author.name === "小A改", "发云端动态");
  ok((await call("POST", "post", { token: ta, body: { text: "  " } })).status === 400, "空白动态拒绝");
  const pl = await call("POST", "post_like", { token: tb, body: { post: pp.data.post.sid } });
  ok(pl.data.liked === true && pl.data.count === 1, "B 点赞");
  const pl2 = await call("POST", "post_like", { token: tb, body: { post: pp.data.post.sid } });
  ok(pl2.data.liked === false && pl2.data.count === 0, "B 取消点赞");
  await call("POST", "post_like", { token: tb, body: { post: pp.data.post.sid } });
  const pc = await call("POST", "comment", { token: tb, body: { post: pp.data.post.sid, text: "写得好！" } });
  ok(pc.data.ok === true && pc.data.comment.name === "小B", "B 评论");
  const postsB = (await call("GET", "posts", { token: tb })).data.posts;
  ok(postsB.some(p => p.sid === pp.data.post.sid && p.liked === true && p.comments.length === 1), "动态列表含点赞评论状态");
  await call("POST", "block", { token: tb, body: { target: rc.data.user.cid } });
  await call("POST", "post", { token: tc, body: { text: "C 的动态" } });
  ok(!(await call("GET", "posts", { token: tb })).data.posts.some(p => p.author.cid === rc.data.user.cid), "拉黑后动态隐藏");
  await call("POST", "block", { token: tb, body: { target: rc.data.user.cid } }); void 0;

  console.log("== v2.1 访客 / 在线 ==");
  ok((await call("POST", "visit", { token: tb, body: { target: ra.data.user.cid } })).data.ok === true, "B 访问 A 上报");
  const vs = (await call("GET", "visits", { token: ta })).data.visits;
  ok(vs.some(v => v.cid === rb.data.user.cid && v.visited_at > 0), "A 的访客列表含 B");
  const meA = (await call("GET", "me", { token: ta })).data.user;
  ok(meA.last_seen > 0, "心跳刷新 last_seen");

  console.log("== v2.1 云端情侣 ==");
  const pr = await call("POST", "propose", { token: ta, body: { match: mid } });
  ok(pr.data.ok === true, "A 向 B 表白");
  ok((await call("POST", "propose", { token: ta, body: { match: mid } })).status === 409, "重复表白 409");
  const mB = (await call("GET", "matches", { token: tb })).data.matches.find(m => m.id === mid);
  ok(mB.proposal_in && mB.proposal_in.id, "B 收到表白请求");
  ok((await call("GET", "matches", { token: ta })).data.matches.find(m => m.id === mid).proposal_out === true, "A 侧表白待处理");
  const ac = await call("POST", "proposal", { token: tb, body: { id: mB.proposal_in.id, accept: true } });
  ok(ac.data.ok === true, "B 接受表白");
  const mA2 = (await call("GET", "matches", { token: ta })).data.matches.find(m => m.id === mid);
  ok(mA2.couple && mA2.couple.partner === rb.data.user.cid && mA2.couple.since > 0, "A 侧情侣关系生效");
  ok((await call("GET", "matches", { token: tb })).data.matches.find(m => m.id === mid).msgs.some(g => g.text.includes("在一起")), "接受后系统消息");
  ok((await call("POST", "propose", { token: ta, body: { match: mid } })).status === 409, "恋爱中再表白 409");
  const bk = await call("POST", "breakup", { token: ta, body: { match: mid } });
  ok(bk.data.ok === true && !(await call("GET", "matches", { token: tb })).data.matches.find(m => m.id === mid).couple, "分手后情侣解除");

  console.log("== v2.2 头像 / 分页 / 通知源 ==");
  const tinyImg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAj/wAARCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
  ok((await call("PUT", "avatar", { token: ta, body: { img: "http://x/a.jpg" } })).status === 400, "非 dataURL 头像拒绝");
  ok((await call("PUT", "avatar", { token: ta, body: { img: tinyImg } })).data.ok === true, "头像上传");
  ok((await call("GET", "users", { token: tb })).data.users.find(u => u.cid === ra.data.user.cid).avatar_url === tinyImg, "对方看到新头像");
  ok((await call("GET", "me", { token: ta })).data.user.avatar_url === tinyImg, "me 返回头像");
  for (let i = 0; i < 6; i++) await call("POST", "send", { token: ta, body: { match: mid, text: "历史消息" + i } });
  const page1 = await call("GET", "messages?match=" + mid, { token: ta });
  ok(page1.data.msgs.length >= 8 && page1.data.has_more === false, "默认最新一页 + has_more");
  const older = await call("GET", "messages?match=" + mid + "&before=" + page1.data.msgs.at(-1).ts, { token: ta });
  ok(older.data.msgs.length >= 6 && older.data.msgs.every(g => g.ts < page1.data.msgs.at(-1).ts), "before 游标取更早消息");
  ok(older.data.has_more === false, "不足一页 has_more=false");
  const mA3 = (await call("GET", "matches", { token: ta })).data.matches.find(m => m.id === mid);
  ok(typeof mA3.has_more === "boolean", "matches 负载含 has_more");

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error("测试异常:", e.message); process.exit(1); });
