import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    },
    {
      id: "CORE-002",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-10",
      depth: "132.1-132.5m",
      owner: "陆川",
      status: "待切割",
      delivery: "未交付",
      slices: [
        { id: "SL-002-A", method: "普通薄片", observation: "", status: "取样", logs: [{ at: "2026-06-14T09:00:00.000Z", step: "取样", note: "选取围岩段" }] }
      ]
    },
    {
      id: "CORE-003",
      project: "东岭铜矿薄片",
      borehole: "ZK-18",
      coreBox: "BX-03",
      depth: "85.6-86.0m",
      owner: "陈明",
      status: "待观察",
      delivery: "未交付",
      slices: [
        { id: "SL-003-A", method: "茜素红染色", observation: "", status: "观察", logs: [{ at: "2026-06-10T14:00:00.000Z", step: "取样", note: "矿化富集带" }, { at: "2026-06-11T08:00:00.000Z", step: "切割", note: "定向切割" }, { at: "2026-06-12T10:00:00.000Z", step: "研磨", note: "0.03mm 厚度" }, { at: "2026-06-13T16:00:00.000Z", step: "染色", note: "茜素红+铁氰化钾" }] }
      ]
    },
    {
      id: "CORE-004",
      project: "西山金矿勘探",
      borehole: "ZK-05",
      coreBox: "BX-12",
      depth: "245.2-245.6m",
      owner: "陈明",
      status: "已交付",
      delivery: "已交付",
      slices: [
        { id: "SL-004-A", method: "光片", observation: "可见自然金颗粒，粒径约0.02mm", status: "观察", logs: [{ at: "2026-06-01T10:00:00.000Z", step: "取样", note: "蚀变带" }, { at: "2026-06-02T09:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-03T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-04T14:00:00.000Z", step: "染色", note: "" }, { at: "2026-06-05T16:00:00.000Z", step: "观察", note: "可见自然金颗粒" }] }
      ]
    },
    {
      id: "CORE-005",
      project: "西山金矿勘探",
      borehole: "ZK-05",
      coreBox: "BX-13",
      depth: "268.9-269.3m",
      owner: "李雪",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-005-A", method: "普通薄片", observation: "", status: "染色", logs: [{ at: "2026-06-14T10:00:00.000Z", step: "取样", note: "石英脉" }, { at: "2026-06-15T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-15T14:00:00.000Z", step: "研磨", note: "0.03mm" }] }
      ]
    },
    {
      id: "CORE-006",
      project: "西山金矿勘探",
      borehole: "ZK-06",
      coreBox: "BX-02",
      depth: "312.4-312.8m",
      owner: "李雪",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-006-A", method: "光片", observation: "", status: "切割", logs: [{ at: "2026-06-15T10:00:00.000Z", step: "取样", note: "黄铁矿化带" }] },
        { id: "SL-006-B", method: "普通薄片", observation: "", status: "取样", logs: [{ at: "2026-06-15T10:00:00.000Z", step: "取样", note: "围岩" }] }
      ]
    },
    {
      id: "CORE-007",
      project: "北山铅锌矿",
      borehole: "ZK-22",
      coreBox: "BX-15",
      depth: "178.5-178.9m",
      owner: "王涛",
      status: "待切割",
      delivery: "未交付",
      slices: [
        { id: "SL-007-A", method: "普通薄片", observation: "", status: "取样", logs: [{ at: "2026-06-16T09:00:00.000Z", step: "取样", note: "条带状矿石" }] }
      ]
    },
    {
      id: "CORE-008",
      project: "北山铅锌矿",
      borehole: "ZK-22",
      coreBox: "BX-16",
      depth: "195.2-195.6m",
      owner: "王涛",
      status: "待观察",
      delivery: "未交付",
      slices: [
        { id: "SL-008-A", method: "茜素红染色", observation: "", status: "观察", logs: [{ at: "2026-06-08T10:00:00.000Z", step: "取样", note: "" }, { at: "2026-06-09T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-10T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-11T14:00:00.000Z", step: "染色", note: "" }] }
      ]
    },
    {
      id: "CORE-009",
      project: "北山铅锌矿",
      borehole: "ZK-23",
      coreBox: "BX-04",
      depth: "210.1-210.5m",
      owner: "陆川",
      status: "已交付",
      delivery: "已交付",
      slices: [
        { id: "SL-009-A", method: "光片", observation: "闪锌矿+方铅矿共生", status: "观察", logs: [{ at: "2026-05-20T10:00:00.000Z", step: "取样", note: "" }, { at: "2026-05-21T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-05-22T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-05-23T14:00:00.000Z", step: "染色", note: "" }, { at: "2026-05-24T16:00:00.000Z", step: "观察", note: "闪锌矿+方铅矿共生" }] }
      ]
    },
    {
      id: "CORE-010",
      project: "南山铁矿",
      borehole: "ZK-31",
      coreBox: "BX-07",
      depth: "45.8-46.2m",
      owner: "李雪",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-010-A", method: "普通薄片", observation: "", status: "研磨", logs: [{ at: "2026-06-13T10:00:00.000Z", step: "取样", note: "磁铁矿带" }, { at: "2026-06-14T08:00:00.000Z", step: "切割", note: "" }] }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#e7ece1; color:var(--ink); }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .filter-panel { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:14px; }
    .filter-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
    .filter-row label { margin:0 0 4px; }
    .filter-actions { display:flex; gap:8px; align-items:flex-end; justify-content:flex-end; margin-top:12px; }
    .filter-actions button { padding:8px 14px; }
    .empty { padding:40px; text-align:center; color:var(--muted); background:#fff; border:1px dashed var(--line); border-radius:8px; }
    .result-count { color:var(--muted); font-size:13px; margin-bottom:10px; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤和交付</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="filter-panel">
        <h2>样本筛选</h2>
        <div class="filter-row">
          <div>
            <label>项目</label>
            <select id="filter-project"><option value="">全部项目</option></select>
          </div>
          <div>
            <label>钻孔编号</label>
            <select id="filter-borehole"><option value="">全部钻孔</option></select>
          </div>
          <div>
            <label>岩芯箱号</label>
            <select id="filter-corebox"><option value="">全部箱号</option></select>
          </div>
          <div>
            <label>负责人</label>
            <select id="filter-owner"><option value="">全部负责人</option></select>
          </div>
          <div>
            <label>样本状态</label>
            <select id="filter-status"><option value="">全部状态</option></select>
          </div>
          <div>
            <label>交付状态</label>
            <select id="filter-delivery"><option value="">全部</option><option value="未交付">未交付</option><option value="已交付">已交付</option></select>
          </div>
        </div>
        <div class="filter-actions">
          <button type="button" class="secondary" id="clear-filters">清除筛选</button>
        </div>
      </div>
      <div class="stats" id="stats"></div>
      <div class="result-count" id="result-count"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const resultCountEl = document.querySelector("#result-count");
    let samples = [];
    const filterFields = ["project", "borehole", "corebox", "owner", "status", "delivery"];
    function getFilters() {
      const f = {};
      filterFields.forEach(field => {
        const el = document.querySelector("#filter-" + field);
        if (el && el.value) f[field === "corebox" ? "coreBox" : field] = el.value;
      });
      return f;
    }
    function setFilters(filters) {
      filterFields.forEach(field => {
        const el = document.querySelector("#filter-" + field);
        if (el) {
          const key = field === "corebox" ? "coreBox" : field;
          el.value = filters[key] || "";
        }
      });
    }
    function filtersToUrl(filters) {
      const params = new URLSearchParams();
      Object.keys(filters).forEach(k => { if (filters[k]) params.set(k, filters[k]); });
      return params.toString() ? "?" + params.toString() : location.pathname;
    }
    function urlToFilters() {
      const params = new URLSearchParams(location.search);
      const f = {};
      filterFields.forEach(field => {
        const key = field === "corebox" ? "coreBox" : field;
        if (params.has(key)) f[key] = params.get(key);
      });
      return f;
    }
    function applyFilters(list, filters) {
      return list.filter(item => {
        for (const key in filters) {
          if (filters[key] && item[key] !== filters[key]) return false;
        }
        return true;
      });
    }
    function populateFilterOptions() {
      const filterSelectors = {
        "#filter-project": "project",
        "#filter-borehole": "borehole",
        "#filter-corebox": "coreBox",
        "#filter-owner": "owner",
        "#filter-status": "status"
      };
      Object.keys(filterSelectors).forEach(selector => {
        const field = filterSelectors[selector];
        const el = document.querySelector(selector);
        const current = el.value;
        const values = [...new Set(samples.map(s => s[field]))].sort();
        el.innerHTML = '<option value="">' + (field === "status" ? "全部状态" : field === "owner" ? "全部负责人" : field === "coreBox" ? "全部箱号" : field === "borehole" ? "全部钻孔" : "全部项目") + '</option>' +
          values.map(v => '<option value="' + v + '">' + v + '</option>').join("");
        el.value = current;
      });
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function render() {
      const filters = getFilters();
      const filtered = applyFilters(samples, filters);
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+filtered.filter(item => item.status === s).length+'</strong></div>').join("");
      resultCountEl.textContent = filtered.length ? "筛选结果：共 " + filtered.length + " 个样本" : "没有符合条件的样本";
      if (!filtered.length) {
        samplesEl.innerHTML = '<div class="empty">没有符合筛选条件的样本，请调整筛选条件。</div>';
        return;
      }
      samplesEl.innerHTML = filtered.map(sample => '<article class="card"><h3>'+sample.project+'</h3><div><span class="pill">'+sample.status+'</span> <span class="pill">'+sample.delivery+'</span></div><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div><label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+sample.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>').join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
        await load();
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); });
    }
    async function load(){
      samples = await api("/api/samples");
      populateFilterOptions();
      const urlFilters = urlToFilters();
      if (Object.keys(urlFilters).length) setFilters(urlFilters);
      render();
    }
    function onFilterChange() {
      const filters = getFilters();
      history.replaceState(null, "", filtersToUrl(filters));
      render();
    }
    filterFields.forEach(field => {
      const el = document.querySelector("#filter-" + field);
      if (el) el.addEventListener("change", onFilterChange);
    });
    document.querySelector("#clear-filters").onclick = () => {
      filterFields.forEach(field => {
        const el = document.querySelector("#filter-" + field);
        if (el) el.value = "";
      });
      history.replaceState(null, "", location.pathname);
      render();
    };
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
