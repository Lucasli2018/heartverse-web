/* node:sqlite → D1 形状仿真（?N 编号参数映射；仅测试用） */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeD1(){
  const db = new DatabaseSync(":memory:");
  for (const stmt of readFileSync(new URL("../schema.sql", import.meta.url), "utf8").split(";\n")){
    if (stmt.trim()) db.exec(stmt.trim() + ";");
  }
  return {
    prepare(sql){
      const idx = [];
      const norm = sql.replace(/\?(\d+)/g, (_, n) => { idx.push(parseInt(n, 10)); return "?"; });
      let bound = [];
      const args = () => idx.map(n => bound[n - 1]);
      const api = {
        bind(...p){ bound = p; return api; },
        async all(){ return { results: db.prepare(norm).all(...args()) }; },
        async first(){ return db.prepare(norm).get(...args()) ?? null; },
        async run(){ db.prepare(norm).run(...args()); return {}; }
      };
      return api;
    }
  };
}
