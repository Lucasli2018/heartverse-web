# 心动星球 · 恋爱交友网站

单文件零依赖前端的恋爱交友平台，原生 HTML/CSS/JS。**v2.0 起支持 Cloudflare D1 真后端**：真实注册/登录、跨设备匹配与聊天；机器人生态保留本地，离线也可玩（自动降级本地演示模式）。

## 功能

### 云端（v2.0 · 需部署后端）
- ☁️ 邮箱注册 / 登录（SHA-256 口令哈希 + token 会话，跨浏览器同步）
- 🔥 发现页含**真实用户**（排除自己/互相拉黑者）
- 💞 双向喜欢 → 服务端建立匹配，跨设备生效
- 💬 真实用户聊天：3 秒轮询收信、发送中/失败状态、5 分钟内撤回跨端同步、已读上报、未读角标
- 📌 置顶聊天按人独立存储；⚠️ 举报拉黑服务端删除会话与消息
- 📷 图片消息（canvas 本地压缩 ~480px/JPEG）
- file:// 打开或后端不可达时**自动降级本地模式**，功能不缺席

### 本地（机器人生态，localStorage）
- 🔥 卡片式滑动匹配（拖拽手势 + ←/→/↑ 快捷键）+ 🎯 筛选器（性别/年龄段/城市/只看在线）
- 🤖 12 位虚拟用户：回赞、开场白、动态互动
- 🌟 每日精选推荐（共同兴趣打分，当日稳定）
- ✨ 动态广场（发帖/点赞/评论）
- ❤️ 心动消息（喜欢我 / 看过我访客，访客可置顶到发现页）
- 💗 表白建立情侣关系（恋爱天数）、👤 资料完善度、🌙 深色模式、📱 PWA

## 本地运行

直接双击 `index.html`（本地模式）；或带后端跑：

```bash
node tests/server.mjs 8787   # 本机模拟 Pages Functions + 内存 D1
# 浏览器打开 http://127.0.0.1:8787
```

## 部署到 Cloudflare Pages（领主操作）

1. 代码已推送 Gitee，Pages 项目连接仓库（构建命令留空，输出目录留空）
2. **绑定 D1**：Pages 项目 → 设置 → 函数 → D1 数据库绑定 → 变量名 `DB` → 选择 `heartverse-db`
   （库已创建：`ea1719b2-436d-4aa6-b435-93ebc4430f9b`，表结构见 `schema.sql`，已初始化）
3. 部署后访问 `https://<项目>.pages.dev`，导航栏出现 ☁️ 即云端模式生效

## 测试

```bash
D:/tools/node/node.exe tests/api.test.js      # API 单测（node:sqlite 仿真 D1，35 断言）
D:/tools/node/node.exe tests/probe-cloud.js   # 云端 E2E（双浏览器跨用户，17 断言）
node tests/probe.js                           # 本地模式 UI 探针（无头 Chrome，38 断言）
```

## 文件结构

```
heartverse-web/
├── index.html               # 前端（单文件，全部 UI 逻辑）
├── sw.js                    # Service Worker（页面网络优先；/api/* 永不接管）
├── manifest.webmanifest     # PWA 清单
├── schema.sql               # D1 表结构（users/sessions/likes/matches/messages/blocks）
├── functions/
│   ├── _lib/core.mjs        # 公共库（鉴权/哈希/响应）
│   └── api/[[route]].mjs    # API 路由（register/login/users/like/matches/messages/send/recall/pin/read/block）
└── tests/                   # api.test.js · probe-cloud.js · probe.js · server.mjs · _d1.mjs
```

## 说明

- 云端口令哈希为应用层 SHA-256，演示级安全，请勿使用重要密码
- 机器人数据仅存本地，清除浏览器数据即重置；云端账号数据存 D1
- sw.js 对 `/api/*` 直接放行（接口永不进 Cache API），页面网络优先防更新滞后
