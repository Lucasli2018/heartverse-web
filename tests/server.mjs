/* 本机模拟 Pages Functions 运行时：/api/* → 路由（D1 仿真），其余 → 静态文件
   用途：tests/probe-cloud.js 的 E2E 底座；也可手动 node tests/server.mjs 8787 自测 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { onRequest } from "../functions/api/[[route]].mjs";
import { makeD1 } from "./_d1.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

export function createRuntime(){
  const env = { DB: makeD1() };
  return {
    handle: (req) => onRequest({ request: req, env }),
    env
  };
}

export function startServer(port){
  const runtime = createRuntime();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")){
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
        const r = await runtime.handle(new Request("http://127.0.0.1" + url.pathname + url.search, {
          method: req.method,
          headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : body
        }));
        const text = await r.text();
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch (e){
      res.writeHead(404); res.end("not found");
    }
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && process.argv[1].endsWith("server.mjs")){
  const port = parseInt(process.argv[2], 10) || 8787;
  startServer(port).then(() => console.log("heartverse dev server: http://127.0.0.1:" + port));
}
