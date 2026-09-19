/* 心动星球 v1.1 功能探针：无头 Chrome + CDP 直测页面上下文
   运行：node tests/probe.js  （需本机 Chrome） */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 9333;
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const PAGE = "file:///" + path.resolve(__dirname, "..").replace(/\\/g, "/") + "/index.html";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, name){ cond ? (pass++, console.log("  PASS", name)) : (fail++, console.log("  FAIL", name)); }

async function wsUrl(){
  for (let i = 0; i < 40; i++){
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch (e){}
    await sleep(250);
  }
  throw new Error("CDP 不可达");
}

class CDP {
  constructor(ws){ this.ws = ws; this.id = 0; this.pend = new Map();
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)){ const p = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    }); }
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

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hv-probe-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*", `--user-data-dir=${tmp}`, "about:blank"
  ], { stdio: "ignore" });
  try {
    const cdp = await CDP.connect(await wsUrl());
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: PAGE });
    await sleep(1200);

    console.log("== 未登录首页 ==");
    ok(await cdp.eval(`document.body.innerHTML.includes("认真谈恋爱")`), "首页渲染");

    console.log("== 注册会话 ==");
    await cdp.eval(`
      DB.set("users", [{ id:"u1", email:"t@t.co", pw:hashPw("123456"), name:"领主", gender:"男", age:28,
        city:"深圳", bio:"爱写代码爱生活", avatar:"🐱", bg:PHOTO_BG[0], tags:["咖啡","健身","旅行"], ts:Date.now() }]);
      DB.set("session", "u1"); render();
    `);
    ok(await cdp.eval(`route.page`) === "discover", "登录后进入发现页");

    console.log("== 动态广场 ==");
    await cdp.eval(`go("posts")`);
    ok(await cdp.eval(`document.body.innerHTML.includes("动态广场")`), "动态页渲染");
    ok(await cdp.eval(`getPosts().length >= 9`), "机器人种子动态存在");
    await cdp.eval(`$("#post-ta").value = "今天上线了新功能！"; publishPost();`);
    ok(await cdp.eval(`getPosts().some(p => p.uid === "u1" && p.text.includes("新功能"))`), "发布动态成功");
    ok(await cdp.eval(`new Promise(r => setTimeout(() => r(getPosts().find(p => p.uid === "u1").likes.length > 0), 7500))`), "机器人点赞我的动态");

    console.log("== 发现页筛选 ==");
    await cdp.eval(`go("discover")`);
    ok(await cdp.eval(`!!document.querySelector(".filter-bar")`), "筛选栏出现");
    ok(await cdp.eval(`document.body.innerHTML.includes("只看在线")`), "在线筛选项存在");
    await cdp.eval(`setFilter("gender", "女")`);
    ok(await cdp.eval(`discoverQueue().length > 0 && discoverQueue().every(p => p.gender === "女")`), "性别筛选生效");
    await cdp.eval(`clearFilter()`);
    ok(await cdp.eval(`discoverQueue().length > 3`), "清除筛选恢复队列");
    await cdp.eval(`DB.set("pin", "bot1"); go("discover")`);
    ok(await cdp.eval(`document.querySelector("#card h3").textContent.includes(DB.get("bots")[1].name)`), "看过我→置顶到发现页首位");

    console.log("== 聊天增强 ==");
    await cdp.eval(`createMatch("u1", "bot0"); go("chat", getMatches()[0].id)`);
    ok(await cdp.eval(`!!document.querySelector(".quick-row")`), "快捷短语条出现");
    await cdp.eval(`document.querySelector(".quick-row button").click()`);
    ok(await cdp.eval(`getMatches()[0].msgs.some(m => m.from === "u1" && m.text === "你好呀 👋")`), "快捷短语发送成功");
    await cdp.eval(`botOpening(getMatches()[0].id, "bot0")`);
    ok(await cdp.eval(`new Promise(r => setTimeout(() => r(getMatches()[0].msgs.some(m => m.from === "bot0")), 5500))`), "机器人主动开场白");
    await cdp.eval(`
      const ms = getMatches(); ms[0].msgs.push({ from:"u1", text:"撤回我", ts:Date.now() });
      DB.set("matches", ms); recallMsg(ms[0].id, ms[0].msgs.length - 1);
    `);
    ok(await cdp.eval(`getMatches()[0].msgs.at(-1).recalled === true`), "消息撤回成功");
    ok(await cdp.eval(`new Promise(r => {
      const ms = getMatches(); ms[0].msgs.push({ from:"u1", text:"过期撤回", ts:Date.now() - 6 * 60e3 });
      DB.set("matches", ms); recallMsg(ms[0].id, ms[0].msgs.length - 1);
      setTimeout(() => r(getMatches()[0].msgs.at(-1).recalled !== true), 50);
    })`), "超时撤回被拒绝");

    console.log("== 心动消息 / 访客 ==");
    await cdp.eval(`simVisits(); go("likedme", "visits")`);
    ok(await cdp.eval(`document.body.innerHTML.includes("看过我")`), "访客 Tab 渲染");
    ok(await cdp.eval(`(getVisits()["u1"] || []).length > 0`), "访客记录已生成");
    await cdp.eval(`go("likedme", "likes")`);
    ok(await cdp.eval(`document.body.innerHTML.includes("喜欢我")`), "喜欢我 Tab 渲染");

    console.log("== 资料完善度 ==");
    await cdp.eval(`go("profile")`);
    ok(await cdp.eval(`document.body.innerHTML.includes("资料完善度")`), "完善度进度条渲染");
    ok(await cdp.eval(`completion(me()) >= 70`), "完善度计算合理");

    console.log("== v1.2 每日精选 ==");
    await cdp.eval(`go("discover")`);
    ok(await cdp.eval(`!!document.querySelector(".daily")`), "今日精选横幅出现");
    ok(await cdp.eval(`dailyPick().id === dailyPick().id`), "当日精选稳定不漂移");

    console.log("== v1.2 置顶 / 情侣 ==");
    await cdp.eval(`go("chat", getMatches()[0].id)`);
    ok(await cdp.eval(`!!document.querySelector(".hbtns")`), "聊天头操作按钮出现");
    await cdp.eval(`togglePin(getMatches()[0].id)`);
    ok(await cdp.eval(`getMatches()[0].pinned === true`), "置顶标记写入");
    ok(await cdp.eval(`myMatches()[0].pinned === true`), "置顶聊天排第一");
    await cdp.eval(`new Promise(res => {
      const ms = getMatches();
      while (ms[0].msgs.length < 8) ms[0].msgs.push({ from:"u1", text:"多聊聊", ts:Date.now() });
      DB.set("matches", ms);
      const _r = Math.random; Math.random = () => 0.01;
      propose(ms[0].id);
      setTimeout(() => { Math.random = _r; res(true); }, 3800);
    })`);
    ok(await cdp.eval(`(DB.get("couples", {})["u1"] || {}).uid === "bot0" && getMatches()[0].msgs.some(m => m.text.includes("我愿意"))`), "表白成功建立情侣关系");
    ok(await cdp.eval(`go("chat", getMatches()[0].id); !!document.querySelector(".couple-line")`), "聊天页显示恋爱状态");
    ok(await cdp.eval(`go("discover"); discoverQueue().every(p => p.id !== (DB.get("couples", {})["u1"] || {}).uid)`), "情侣对象不再出现在发现页");
    ok(await cdp.eval(`go("profile"); document.body.innerHTML.includes("已在一起")`), "资料页情侣卡片显示");

    console.log("== v1.2 图片消息 ==");
    await cdp.eval(`go("chat", getMatches()[0].id)`);
    ok(await cdp.eval(`!!$("#img-file")`), "隐藏图片输入存在");
    await cdp.eval(`{
      const ms = getMatches();
      ms[0].msgs.push({ from:"u1", img:"data:image/gif;base64,R0lGODlhAQABAAAAACw=", ts:Date.now() });
      DB.set("matches", ms); render();
    }`);
    ok(await cdp.eval(`!!document.querySelector(".bubble img.msg-img")`), "图片气泡渲染");
    ok(await cdp.eval(`document.body.innerHTML.includes("📷")`), "📷 发图按钮存在");
    await cdp.eval(`document.querySelector(".msg-img").click()`);
    ok(await cdp.eval(`!!document.querySelector("#imgview") && document.querySelector("#imgview").style.display === "flex"`), "大图预览打开");
    await cdp.eval(`document.querySelector("#imgview").click()`);
    ok(await cdp.eval(`document.querySelector("#imgview").style.display === "none"`), "大图预览关闭");

    console.log("== v1.2 举报拉黑 ==");
    await cdp.eval(`
      createMatch("u1", "bot2");
      window.confirm = () => true;
      blockUser(getMatches().find(x => x.a === "u1" && x.b === "bot2").id);
    `);
    ok(await cdp.eval(`(DB.get("blocks", {})["u1"] || []).includes("bot2")`), "拉黑写入");
    ok(await cdp.eval(`!myMatches().some(x => x.other.id === "bot2")`), "拉黑后聊天隐藏");
    ok(await cdp.eval(`!discoverQueue().some(p => p.id === "bot2")`), "拉黑后不再出现");
    ok(await cdp.eval(`go("profile"); document.body.innerHTML.includes("黑名单")`), "黑名单卡片显示");
    await cdp.eval(`unblockUser("bot2")`);
    ok(await cdp.eval(`!(DB.get("blocks", {})["u1"] || []).includes("bot2")`), "解除拉黑");

    console.log(`\n结果：${pass} 通过，${fail} 失败`);
    process.exitCode = fail ? 1 : 0;
  } catch (e){
    console.error("探针异常:", e.message);
    process.exitCode = 1;
  } finally {
    try { chrome.kill(); } catch (e){}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e){}
  }
})();
