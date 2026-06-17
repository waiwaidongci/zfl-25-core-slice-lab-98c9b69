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
const SLICE_ID_PATTERN = /^SL-\d+-[A-Za-z]+$/;

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

function validateSliceId(id, existingIds = []) {
  const errors = [];
  if (!id || typeof id !== "string" || id.trim() === "") {
    errors.push("切片编号不能为空");
    return errors;
  }
  const trimmed = id.trim();
  if (!SLICE_ID_PATTERN.test(trimmed)) {
    errors.push(`切片编号 "${trimmed}" 格式异常，正确格式示例：SL-001-A`);
  }
  if (existingIds.includes(trimmed)) {
    errors.push(`切片编号 "${trimmed}" 重复，该编号已存在`);
  }
  return errors;
}

function validateSlices(slices, allExistingSliceIds = []) {
  const errors = [];
  const seenIds = [];
  slices.forEach((slice, index) => {
    const id = slice && slice.id ? slice.id.trim() : "";
    const method = slice && slice.method ? slice.method.trim() : "";
    const currentExisting = [...allExistingSliceIds, ...seenIds];
    const idErrors = validateSliceId(id, currentExisting);
    idErrors.forEach(err => errors.push(`第 ${index + 1} 行：${err}`));
    if (id) seenIds.push(id);
    if (!method) {
      errors.push(`第 ${index + 1} 行：染色方法不能为空`);
    }
  });
  return errors;
}

function getAllSliceIds(db, excludeSampleId = null) {
  const ids = [];
  db.samples.forEach(s => {
    if (excludeSampleId && s.id === excludeSampleId) return;
    s.slices.forEach(slice => ids.push(slice.id));
  });
  return ids;
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --danger:#b54a3a; --warn-bg:#fdf2ef; --warn-border:#e8c5be; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:420px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#e7ece1; color:var(--ink); }
    button.danger { background:var(--danger); }
    button.link { background:none; color:var(--accent); padding:6px 0; font-weight:600; text-align:left; }
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
    .slice-batch-section { border-top:1px solid var(--line); margin-top:14px; padding-top:14px; }
    .slice-batch-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .slice-batch-header h3 { margin:0; font-size:15px; color:var(--stone); }
    .slice-row { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; margin-bottom:8px; align-items:center; }
    .slice-row input { margin:0; }
    .slice-row .row-btn { padding:8px 10px; font-size:14px; }
    .slice-actions { display:flex; gap:8px; margin-top:10px; }
    .alert { background:var(--warn-bg); border:1px solid var(--warn-border); border-radius:6px; padding:10px 12px; color:var(--danger); font-size:13px; margin-top:10px; white-space:pre-line; }
    .alert.success { background:#edf5e8; border-color:#c6dcb8; color:var(--accent); }
    .format-hint { font-size:12px; color:var(--muted); margin-top:4px; }
    .sample-id { font-size:13px; color:var(--stone); font-weight:600; }
    .modal-mask { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; z-index:100; }
    .modal { background:#fff; border-radius:10px; padding:20px; width:460px; max-width:92vw; max-height:85vh; overflow-y:auto; }
    .modal h2 { margin:0 0 14px; }
    .modal-footer { display:flex; gap:10px; justify-content:flex-end; margin-top:14px; }
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

      <div class="slice-batch-section">
        <div class="slice-batch-header">
          <h3>切片任务（批量录入）</h3>
        </div>
        <div class="format-hint">切片编号格式示例：SL-001-A、SL-010-B</div>
        <div id="create-slice-rows"></div>
        <div class="slice-actions">
          <button type="button" class="secondary" id="add-create-slice">+ 添加一行</button>
        </div>
      </div>

      <div id="create-alert"></div>
      <div style="margin-top:14px;">
        <button type="submit">保存样本</button>
      </div>
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
  <div id="modal-root"></div>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const resultCountEl = document.querySelector("#result-count");
    const createSliceRowsEl = document.querySelector("#create-slice-rows");
    const createAlertEl = document.querySelector("#create-alert");
    const modalRoot = document.querySelector("#modal-root");
    let samples = [];
    const filterFields = ["project", "borehole", "corebox", "owner", "status", "delivery"];

    function createSliceRow(initialId = "", initialMethod = "") {
      const row = document.createElement("div");
      row.className = "slice-row";
      row.innerHTML = '<input placeholder="切片编号，如 SL-001-A" value="' + initialId + '" data-slice-id><input placeholder="染色方法，如 普通薄片" value="' + initialMethod + '" data-slice-method><button type="button" class="secondary row-btn" data-remove-row title="删除此行">×</button>';
      row.querySelector("[data-remove-row]").onclick = () => {
        if (createSliceRowsEl.children.length > 1) row.remove();
      };
      return row;
    }

    function initCreateSliceRows() {
      createSliceRowsEl.innerHTML = "";
      createSliceRowsEl.appendChild(createSliceRow());
    }

    function collectCreateSlices() {
      const rows = createSliceRowsEl.querySelectorAll(".slice-row");
      const slices = [];
      rows.forEach(row => {
        const idInput = row.querySelector("[data-slice-id]");
        const methodInput = row.querySelector("[data-slice-method]");
        slices.push({ id: idInput.value.trim(), method: methodInput.value.trim() });
      });
      return slices.filter(s => s.id || s.method);
    }

    function showAlert(container, messages, type = "error") {
      if (!messages || messages.length === 0) {
        container.innerHTML = "";
        return;
      }
      const cls = type === "success" ? "alert success" : "alert";
      container.innerHTML = '<div class="' + cls + '">' + messages.join("\\n") + '</div>';
    }

    function openBatchAppendModal(sampleId) {
      const sample = samples.find(s => s.id === sampleId);
      if (!sample) return;
      const existingIds = sample.slices.map(s => s.id);
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.innerHTML = '<h2>批量追加切片任务 — ' + sample.id + '</h2><div class="meta">' + sample.project + ' · ' + sample.borehole + ' · ' + sample.coreBox + '</div><div style="margin-top:10px;"><div class="format-hint">切片编号格式示例：SL-001-A、SL-010-B。当前已有切片：' + existingIds.join("、") + '</div></div><div id="batch-rows" style="margin-top:12px;"></div><div class="slice-actions"><button type="button" class="secondary" id="add-batch-row">+ 添加一行</button></div><div id="batch-alert" style="margin-top:10px;"></div><div class="modal-footer"><button type="button" class="secondary" id="batch-cancel">取消</button><button type="button" id="batch-confirm">确认追加</button></div>';
      mask.appendChild(modal);
      modalRoot.appendChild(mask);
      const batchRows = modal.querySelector("#batch-rows");
      const batchAlert = modal.querySelector("#batch-alert");
      batchRows.appendChild(createSliceRow());
      modal.querySelector("#add-batch-row").onclick = () => batchRows.appendChild(createSliceRow());
      modal.querySelector("#batch-cancel").onclick = () => mask.remove();
      mask.onclick = e => { if (e.target === mask) mask.remove(); };
      modal.querySelector("#batch-confirm").onclick = async () => {
        const rows = batchRows.querySelectorAll(".slice-row");
        const slices = [];
        rows.forEach(row => {
          const idInput = row.querySelector("[data-slice-id]");
          const methodInput = row.querySelector("[data-slice-method]");
          slices.push({ id: idInput.value.trim(), method: methodInput.value.trim() });
        });
        const validSlices = slices.filter(s => s.id || s.method);
        if (validSlices.length === 0) {
          showAlert(batchAlert, ["请至少填写一个切片任务"]);
          return;
        }
        try {
          const result = await api('/api/samples/' + sampleId + '/slices/batch', { method:'POST', body: JSON.stringify({ slices: validSlices }) });
          mask.remove();
          await load();
        } catch (err) {
          const msg = err.message;
          try {
            const parsed = JSON.parse(msg);
            if (Array.isArray(parsed)) {
              showAlert(batchAlert, parsed);
              return;
            }
          } catch (_) {}
          showAlert(batchAlert, [msg]);
        }
      };
    }

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
      if (!res.ok) {
        const errMsg = data.error ? (typeof data.error === "object" ? JSON.stringify(data.error) : data.error) : "请求失败";
        throw new Error(errMsg);
      }
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
      samplesEl.innerHTML = filtered.map(sample => '<article class="card"><h3>'+sample.project+'</h3><div class="sample-id">'+sample.id+'</div><div><span class="pill">'+sample.status+'</span> <span class="pill">'+sample.delivery+'</span></div><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div><button type="button" class="secondary" data-batch-append="'+sample.id+'">批量追加切片</button>'+sample.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>').join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-batch-append]").forEach(btn => btn.onclick = () => {
        openBatchAppendModal(btn.dataset.batchAppend);
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
    document.querySelector("#add-create-slice").onclick = () => {
      createSliceRowsEl.appendChild(createSliceRow());
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(form);
      const baseData = Object.fromEntries(fd.entries());
      const slices = collectCreateSlices();
      if (slices.length === 0) {
        showAlert(createAlertEl, ["请至少填写一个切片任务"]);
        return;
      }
      const payload = { ...baseData, slices };
      try {
        await api("/api/samples", { method:"POST", body: JSON.stringify(payload) });
        form.reset();
        initCreateSliceRows();
        showAlert(createAlertEl, ["样本创建成功！已创建 " + slices.length + " 个切片任务。"], "success");
        setTimeout(() => showAlert(createAlertEl, []), 3000);
        await load();
      } catch (err) {
        const msg = err.message;
        try {
          const parsed = JSON.parse(msg);
          if (Array.isArray(parsed)) {
            showAlert(createAlertEl, parsed);
            return;
          }
        } catch (_) {}
        showAlert(createAlertEl, [msg]);
      }
    };
    initCreateSliceRows();
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
      if (!input.project || !input.borehole || !input.coreBox || !input.depth || !input.owner) {
        return sendJson(res, 400, { error: "样本基本信息填写不完整" });
      }
      const slices = Array.isArray(input.slices) ? input.slices : [];
      if (slices.length === 0) {
        return sendJson(res, 400, { error: "请至少添加一个切片任务" });
      }
      const allExistingIds = getAllSliceIds(db);
      const validationErrors = validateSlices(slices, allExistingIds);
      if (validationErrors.length > 0) {
        return sendJson(res, 400, { error: validationErrors });
      }
      const sample = {
        id: `CORE-${Date.now()}`,
        project: input.project,
        borehole: input.borehole,
        coreBox: input.coreBox,
        depth: input.depth,
        owner: input.owner,
        status: "待切割",
        delivery: "未交付",
        slices: slices.map(s => ({
          id: s.id.trim(),
          method: s.method.trim() || "未指定",
          observation: "",
          status: "取样",
          logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }]
        }))
      };
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
      const allExistingIds = getAllSliceIds(db, sample.id);
      const sampleExistingIds = sample.slices.map(s => s.id);
      const validationErrors = validateSlices([{ id: input.id, method: input.method }], [...allExistingIds, ...sampleExistingIds]);
      if (validationErrors.length > 0) {
        return sendJson(res, 400, { error: validationErrors });
      }
      sample.slices.push({ id: input.id.trim(), method: (input.method || "未指定").trim(), observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }

    const batchSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/batch$/);
    if (batchSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === batchSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const slices = Array.isArray(input.slices) ? input.slices : [];
      if (slices.length === 0) {
        return sendJson(res, 400, { error: ["请至少提交一个切片任务"] });
      }
      const allExistingIds = getAllSliceIds(db, sample.id);
      const sampleExistingIds = sample.slices.map(s => s.id);
      const validationErrors = validateSlices(slices, [...allExistingIds, ...sampleExistingIds]);
      if (validationErrors.length > 0) {
        return sendJson(res, 400, { error: validationErrors });
      }
      slices.forEach(s => {
        sample.slices.push({
          id: s.id.trim(),
          method: (s.method || "未指定").trim(),
          observation: "",
          status: "取样",
          logs: [{ at: new Date().toISOString(), step: "取样", note: "批量追加切片任务" }]
        });
      });
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
