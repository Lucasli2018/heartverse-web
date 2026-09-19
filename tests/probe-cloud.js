/* v2.0 云端 E2E 探针：本机 Functions 运行时 + 双浏览器实例
   验证跨用户：注册 → 发现 → 双向喜欢 → 匹配 → 聊天 → 撤回 → 拉黑
   运行：node tests/probe-cloud.js */
"use strict";
import { startServer } from "./server.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n) => c ? (pass++, console.log("  PASS", n)) : (fail++, console.log("  FAIL", n));

class CDP {
  constructor(ws){ this.ws = ws; this.id = 0; this.pend = new Map();
    ws.addEventListener("message", ev => { const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)){ const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }); }
  static async connect(url){ const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    return new CDP(ws); }
  send(method, params = {}){ const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pend.set(id, { res, rej })); }
  async eval(expr){
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  }
}
async function launchChrome(port){
  const dir = mkdtempSync(join(tmpdir(), "hv-e2e-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run",
    `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 40; i++){
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pg = list.find(t => t.type === "page");
      if (pg) return { proc, dir, cdp: await CDP.connect(pg.webSocketDebuggerUrl) };
    } catch (e){} await sleep(250);
  }
  throw new Error("chrome 起不来: " + port);
}
const cleanup = [];
async function browserEval(b, expr){ return b.cdp.eval(expr); }

(async () => {
  const PORT = 8790;
  const server = await startServer(PORT);
  const A = await launchChrome(9510); cleanup.push(A);
  const B = await launchChrome(9511); cleanup.push(B);
  await A.cdp.send("Page.enable"); await B.cdp.send("Page.enable");
  await A.cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await B.cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1200);

  console.log("== 双用户注册（云端 D1） ==");
  await browserEval(A, `go("auth"); toggleAuthMode();
    $("#a-email").value = "alice@hv.co"; $("#a-pw").value = "love999"; $("#a-name").value = "艾丽"; doAuth();`);
  await sleep(600);
  ok(await browserEval(A, `Cloud.on() && me() && me().cid`), "A 注册并进入云端模式");
  ok(await browserEval(A, `!!localStorage.getItem("hv_token")`), "token 持久化");
  await browserEval(B, `go("auth"); toggleAuthMode();
    $("#a-email").value = "bob@hv.co"; $("#a-pw").value = "love888"; $("#a-name").value = "波仔"; doAuth();`);
  await sleep(600);
  ok(await browserEval(B, `Cloud.on()`), "B 注册并进入云端模式");

  console.log("== 发现真实用户 + 双向喜欢 ==");
  await browserEval(A, `go("discover")`); await sleep(700);
  ok(await browserEval(A, `getRUsers().some(u => u.name === "波仔")`), "A 的发现页拉到 B");
  await browserEval(A, `syncUsers().then(() => { const u = getRUsers().find(x => x.name === "波仔"); return like(u.id); })`);
  await sleep(400);
  ok(await browserEval(A, `!getMatches().some(x => x.real)`), "A 单方面喜欢未匹配");
  await browserEval(B, `go("discover")`); await sleep(700);
  await browserEval(B, `syncUsers().then(() => { const u = getRUsers().find(x => x.name === "艾丽"); return like(u.id); })`);
  await sleep(600);
  ok(await browserEval(B, `getMatches().filter(x => x.real).length === 1`), "B 回赞 → 匹配建立");
  await browserEval(A, `go("matches"); syncMatches()`); await sleep(600);
  ok(await browserEval(A, `getMatches().filter(x => x.real).length === 1`), "A 同步到匹配");

  console.log("== 跨用户聊天 ==");
  await browserEval(A, `go("chat", getMatches().find(x => x.real).id)`);
  await browserEval(A, `$("#chat-in").value = "在吗？云端聊天测试中"; sendMsg(getMatches().find(x => x.real).id)`);
  await sleep(500);
  ok(await browserEval(A, `getMatches().find(x => x.real).msgs.some(g => g.text.includes("云端聊天")) && !getMatches().find(x => x.real).msgs.some(g => g.pending)`), "A 发送并确认（pending 消除）");
  await browserEval(B, `go("matches"); syncMatches()`); await sleep(600);
  ok(await browserEval(B, `getMatches().find(x => x.real).msgs.some(g => g.text.includes("云端聊天"))`), "B 收到 A 的消息");
  ok(await browserEval(B, `getMatches().find(x => x.real).msgs.some(g => g.from !== me().id)`), "消息归属正确");
  await browserEval(B, `go("chat", getMatches().find(x => x.real).id);
    $("#chat-in").value = "收到！云端通了 🎉"; sendMsg(getMatches().find(x => x.real).id)`);
  await sleep(500);
  await browserEval(A, `syncMatches()`); await sleep(300);
  ok(await browserEval(A, `getMatches().find(x => x.real).msgs.some(g => g.text.includes("云端通了"))`), "A 收到 B 的回复");

  console.log("== v2.1 云端动态 ==");
  await browserEval(A, `go("posts"); $("#post-ta").value = "云端动态测试 ✨"; publishPost()`);
  await sleep(500);
  ok(await browserEval(A, `getCloudPosts().some(p => p.text.includes("云端动态测试"))`), "A 发布云端动态");
  await browserEval(B, `go("posts")`); await sleep(700);
  ok(await browserEval(B, `getCloudPosts().some(p => p.text.includes("云端动态测试"))`), "B 同步到 A 的动态");
  await browserEval(B, `cloudLike(getCloudPosts().find(p => p.text.includes("云端动态测试")).sid)`);
  await sleep(400);
  ok(await browserEval(B, `getCloudPosts().find(p => p.text.includes("云端动态测试")).liked === true`), "B 点赞状态更新");
  await browserEval(A, `syncPosts()`); await sleep(300);
  ok(await browserEval(A, `getCloudPosts().find(p => p.text.includes("云端动态测试")).likeCount === 1`), "A 同步到点赞");

  console.log("== v2.1 云端情侣 ==");
  await browserEval(A, `go("chat", getMatches().find(x => x.real).id); propose(getMatches().find(x => x.real).id)`);
  await sleep(400);
  ok(await browserEval(A, `getMatches().find(x => x.real).proposal_out === true`), "A 表白送达");
  await browserEval(B, `go("chat", getMatches().find(x => x.real).id); syncMatches()`); await sleep(500);
  ok(await browserEval(B, `!!document.querySelector(".prop-banner")`), "B 聊天页表白横幅");
  await browserEval(B, `acceptProposal(getMatches().find(x => x.real).id, getMatches().find(x => x.real).proposal_in.id, true)`);
  await sleep(600);
  await browserEval(A, `syncMatches()`); await sleep(300);
  ok(await browserEval(A, `!!getCouple()`), "A 情侣镜像建立");
  ok(await browserEval(A, `go("profile"); document.body.innerHTML.includes("已在一起")`), "A 资料页恋爱卡片");
  ok(await browserEval(B, `syncMatches(); go("profile"); document.body.innerHTML.includes("已在一起")`), "B 资料页恋爱卡片");
  await browserEval(A, `window.confirm = () => true; breakup()`);
  await sleep(500);
  ok(await browserEval(A, `!getCouple()`), "A 分手后情侣解除");
  await browserEval(B, `syncMatches()`); await sleep(300);
  ok(await browserEval(B, `!getCouple()`), "B 侧情侣同步解除");

  console.log("== v2.1 访客 / 在线 ==");
  await browserEval(A, `go("discover")`); await sleep(400);
  await browserEval(A, `viewUser(getRUsers().find(u => u.name === "波仔").id)`);
  await sleep(300);
  await browserEval(B, `go("likedme", "visits"); syncVisits()`); await sleep(600);
  ok(await browserEval(B, `(DB.get("cloud_visits_sig", "") || "").length > 0`), "B 的云端访客记录含 A");
  ok(await browserEval(B, `getRUsers().filter(u => u.last_seen && Date.now() - u.last_seen < 120e3).length >= 1`), "真实在线状态生效");

  console.log("== 撤回 / 未读 / 拉黑 ==");
  await browserEval(A, `const x = getMatches().find(x => x.real); const i = x.msgs.findIndex(g => g.from === me().id && g.text.includes("云端聊天")); recallMsg(x.id, i)`);
  await sleep(400);
  await browserEval(B, `go("matches"); syncMatches()`); await sleep(500);
  ok(await browserEval(B, `getMatches().find(x => x.real).msgs.find(g => g.text.includes("云端聊天")).recalled === true`), "撤回状态跨用户同步");
  await browserEval(A, `go("home")`); await sleep(300);
  await browserEval(B, `go("chat", getMatches().find(x => x.real).id);
    $("#chat-in").value = "新消息：未读测试"; sendMsg(getMatches().find(x => x.real).id)`);
  await sleep(500);
  const unreadBefore = await browserEval(A, `syncMatches().then(() => myMatches().filter(x => x.real && x.msgs.some(g => g.from !== me().id && g.ts > (x.lastRead[me().id] || 0))).length)`);
  ok(unreadBefore >= 1, "A 有 B 的未读");
  await browserEval(A, `go("chat", getMatches().find(x => x.real).id)`); await sleep(500);
  ok(await browserEval(A, `syncMatches().then(() => !myMatches().find(x => x.real).msgs.some(g => g.from !== me().id && g.ts > (myMatches().find(x => x.real).lastRead[me().id] || 0)))`), "进入聊天即已读");
  await browserEval(A, `window.confirm = () => true; blockUser(getMatches().find(x => x.real).id)`);
  await sleep(400);
  ok(await browserEval(A, `!getMatches().some(x => x.real)`), "A 拉黑后匹配消失");
  await browserEval(B, `syncMatches()`); await sleep(400);
  ok(await browserEval(B, `!getMatches().some(x => x.real)`), "B 侧匹配同步消失");
  ok((await (await fetch(`http://127.0.0.1:${PORT}/api/users`, { headers: { Authorization: "Bearer " + await browserEval(A, `localStorage.getItem("hv_token")`) } })).json()).users.every(u => u.name !== "波仔"), "服务端发现页排除拉黑对象");

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
  server.close();
})().catch(e => { console.error("E2E 异常:", e.message.slice(0, 300)); process.exitCode = 1; })
  .finally(() => { cleanup.forEach(b => { try { b.proc.kill(); rmSync(b.dir, { recursive: true, force: true }); } catch (e){} }); });
