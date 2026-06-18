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

const ROLES = {
  REGISTRAR: "registrar",
  PRODUCER: "producer",
  OBSERVER: "observer",
  DELIVERER: "deliverer"
};

const ROLE_INFO = {
  [ROLES.REGISTRAR]: { name: "样本登记人员", desc: "负责创建样本、录入切片任务、批量导入" },
  [ROLES.PRODUCER]: { name: "制片人员", desc: "负责推进制片工序：取样、切割、研磨、染色" },
  [ROLES.OBSERVER]: { name: "观察人员", desc: "负责填写观察结果、归档观察记录" },
  [ROLES.DELIVERER]: { name: "交付人员", desc: "负责生成交付包、查看历史交付记录" }
};

const PERMISSIONS = {
  SAMPLE_CREATE: "sample:create",
  SAMPLE_APPEND_SLICE: "sample:appendSlice",
  SAMPLE_VIEW: "sample:view",
  CSV_IMPORT: "csv:import",
  STEP_ADVANCE: "step:advance",
  STEP_LOG: "step:log",
  OBSERVATION_CREATE: "observation:create",
  OBSERVATION_VIEW: "observation:view",
  DELIVERY_CREATE: "delivery:create",
  DELIVERY_VIEW: "delivery:view",
  DELIVERY_PREVIEW: "delivery:preview",
  STATS_VIEW: "stats:view",
  METHOD_MANAGE: "method:manage",
  METHOD_VIEW: "method:view",
  AUDIT_VIEW: "audit:view",
  AUDIT_ROLLBACK: "audit:rollback"
};

const ROLE_PERMISSIONS = {
  [ROLES.REGISTRAR]: [
    PERMISSIONS.SAMPLE_CREATE,
    PERMISSIONS.SAMPLE_APPEND_SLICE,
    PERMISSIONS.SAMPLE_VIEW,
    PERMISSIONS.CSV_IMPORT,
    PERMISSIONS.STATS_VIEW,
    PERMISSIONS.METHOD_VIEW,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.AUDIT_ROLLBACK
  ],
  [ROLES.PRODUCER]: [
    PERMISSIONS.SAMPLE_VIEW,
    PERMISSIONS.STEP_ADVANCE,
    PERMISSIONS.STEP_LOG,
    PERMISSIONS.STATS_VIEW,
    PERMISSIONS.METHOD_VIEW,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.AUDIT_ROLLBACK
  ],
  [ROLES.OBSERVER]: [
    PERMISSIONS.SAMPLE_VIEW,
    PERMISSIONS.OBSERVATION_CREATE,
    PERMISSIONS.OBSERVATION_VIEW,
    PERMISSIONS.STEP_LOG,
    PERMISSIONS.STATS_VIEW,
    PERMISSIONS.METHOD_VIEW,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.AUDIT_ROLLBACK
  ],
  [ROLES.DELIVERER]: [
    PERMISSIONS.SAMPLE_VIEW,
    PERMISSIONS.DELIVERY_CREATE,
    PERMISSIONS.DELIVERY_VIEW,
    PERMISSIONS.DELIVERY_PREVIEW,
    PERMISSIONS.OBSERVATION_VIEW,
    PERMISSIONS.STATS_VIEW,
    PERMISSIONS.METHOD_VIEW,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.AUDIT_ROLLBACK
  ]
};

function roleHasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  return perms && perms.includes(permission);
}

function requirePermission(role, permission, res) {
  if (!role || !roleHasPermission(role, permission)) {
    const roleName = role ? (ROLE_INFO[role]?.name || role) : "未登录";
    sendJson(res, 403, { error: `权限不足：${roleName}无法执行此操作（需要 ${permission}）` });
    return false;
  }
  return true;
}

function getRoleFromRequest(req) {
  const headerRole = req.headers["x-role"];
  if (headerRole && ROLE_PERMISSIONS[headerRole]) {
    return headerRole;
  }
  return null;
}

const defaultMethods = [
  { id: "M-001", name: "普通薄片", description: "标准岩矿薄片制片，厚度0.03mm", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 1 },
  { id: "M-002", name: "茜素红染色", description: "碳酸盐矿物染色，区分方解石/白云石", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 2 },
  { id: "M-003", name: "光片", description: "不透明矿物光片制片，用于反光显微镜观察", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 3 },
  { id: "M-004", name: "油浸薄片", description: "油浸法制备薄片，用于精确测定矿物折射率", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 4 },
  { id: "M-005", name: "电子探针片", description: "电子探针显微分析用样品片", enabled: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 5 }
];

const seed = {
  methods: defaultMethods,
  auditLog: [],
  deliveries: [
    {
      id: "DLV-001",
      sampleId: "CORE-004",
      deliveredAt: "2026-06-06T10:30:00.000Z",
      deliveredBy: "李雪",
      receivingUnit: "地质分析中心",
      remark: "西山金矿首批薄片交付，共1个切片",
      slices: [
        { id: "SL-004-A", method: "光片", status: "观察", hasObservation: true, observationId: "OBS-004" }
      ],
      sampleSnapshot: {
        id: "CORE-004",
        project: "西山金矿勘探",
        borehole: "ZK-05",
        coreBox: "BX-12",
        depth: "245.2-245.6m",
        owner: "陈明"
      }
    },
    {
      id: "DLV-002",
      sampleId: "CORE-009",
      deliveredAt: "2026-05-25T14:00:00.000Z",
      deliveredBy: "王涛",
      receivingUnit: "岩矿鉴定实验室",
      remark: "铅锌矿光片交付，含黄铜矿固溶体分离特征",
      slices: [
        { id: "SL-009-A", method: "光片", status: "观察", hasObservation: true, observationId: "OBS-009" }
      ],
      sampleSnapshot: {
        id: "CORE-009",
        project: "北山铅锌矿",
        borehole: "ZK-22",
        coreBox: "BX-16",
        depth: "195.2-195.6m",
        owner: "王涛"
      }
    }
  ],
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
        { id: "SL-004-A", method: "光片", observation: "可见自然金颗粒，粒径约0.02mm", status: "观察", observations: [{id:"OBS-004", at:"2026-06-05T16:00:00.000Z", lithology:"硅化蚀变岩", minerals:"石英70%+黄铁矿15%+自然金0.5%+其他14.5%", texture:"晶粒结构，块状构造", remark:"自然金呈不规则粒状嵌布于石英颗粒间，粒径0.01-0.03mm"}], logs: [{ at: "2026-06-01T10:00:00.000Z", step: "取样", note: "蚀变带" }, { at: "2026-06-02T09:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-03T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-04T14:00:00.000Z", step: "染色", note: "" }, { at: "2026-06-05T16:00:00.000Z", step: "观察", note: "可见自然金颗粒" }] }
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
        { id: "SL-009-A", method: "光片", observation: "闪锌矿+方铅矿共生", status: "观察", observations: [{id:"OBS-009", at:"2026-05-24T16:00:00.000Z", lithology:"中细粒砂岩", minerals:"闪锌矿35%+方铅矿25%+黄铁矿10%+石英20%+其他10%", texture:"他形晶粒结构，浸染状构造", remark:"闪锌矿与方铅矿紧密共生，闪锌矿内见乳浊状黄铜矿固溶体分离物"}], logs: [{ at: "2026-05-20T10:00:00.000Z", step: "取样", note: "" }, { at: "2026-05-21T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-05-22T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-05-23T14:00:00.000Z", step: "染色", note: "" }, { at: "2026-05-24T16:00:00.000Z", step: "观察", note: "闪锌矿+方铅矿共生" }] }
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

function migrateSample(sample) {
  let changed = false;
  if (!sample.id) { sample.id = "CORE-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4); changed = true; }
  if (!sample.project) { sample.project = "未指定项目"; changed = true; }
  if (!sample.borehole) { sample.borehole = "未指定"; changed = true; }
  if (!sample.coreBox) { sample.coreBox = "未指定"; changed = true; }
  if (!sample.depth) { sample.depth = "0-0m"; changed = true; }
  if (!sample.owner) { sample.owner = "未指定"; changed = true; }
  if (!sample.delivery) { sample.delivery = "未交付"; changed = true; }
  if (!Array.isArray(sample.slices)) { sample.slices = []; changed = true; }
  sample.slices.forEach(slice => {
    if (!slice.id) { slice.id = "SL-" + Date.now() + "-" + Math.random().toString(36).substr(2, 2); changed = true; }
    if (!slice.method) { slice.method = "未指定"; changed = true; }
    if (typeof slice.observation !== "string") { slice.observation = ""; changed = true; }
    if (!Array.isArray(slice.observations)) { slice.observations = []; changed = true; }
    if (!slice.status) { slice.status = "取样"; changed = true; }
    if (!Array.isArray(slice.logs)) { slice.logs = []; changed = true; }
    slice.logs.forEach(log => {
      if (!log.at) { log.at = new Date().toISOString(); changed = true; }
      if (!log.step) { log.step = "取样"; changed = true; }
    });
  });
  updateSampleStatus(sample);
  return changed;
}

function migrateDelivery(delivery) {
  let changed = false;
  if (!delivery.id) { delivery.id = "DLV-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4); changed = true; }
  if (!delivery.deliveredAt) { delivery.deliveredAt = new Date().toISOString(); changed = true; }
  if (!delivery.deliveredBy) { delivery.deliveredBy = "未指定"; changed = true; }
  if (!delivery.receivingUnit) { delivery.receivingUnit = "未指定"; changed = true; }
  if (!delivery.remark) { delivery.remark = ""; changed = true; }
  if (!Array.isArray(delivery.slices)) { delivery.slices = []; changed = true; }
  if (!delivery.sampleSnapshot) { delivery.sampleSnapshot = {}; changed = true; }
  return changed;
}

function migrateAuditEntry(entry) {
  let changed = false;
  if (!entry.id) { entry.id = "AUD-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4); changed = true; }
  if (!entry.timestamp) { entry.timestamp = new Date().toISOString(); changed = true; }
  if (!entry.operator) { entry.operator = "unknown"; changed = true; }
  if (!entry.operatorName) { entry.operatorName = entry.operator ? (ROLE_INFO[entry.operator]?.name || entry.operator) : "未知"; changed = true; }
  if (!entry.sourceApi) { entry.sourceApi = "unknown"; changed = true; }
  return changed;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  let needSave = false;
  if (!Array.isArray(db.samples)) {
    db.samples = [];
    needSave = true;
  }
  if (!Array.isArray(db.deliveries)) {
    db.deliveries = [];
    needSave = true;
  }
  if (!Array.isArray(db.methods)) {
    db.methods = JSON.parse(JSON.stringify(defaultMethods));
    needSave = true;
  }
  if (!Array.isArray(db.auditLog)) {
    db.auditLog = [];
    needSave = true;
  }
  db.samples.forEach(sample => {
    if (migrateSample(sample)) needSave = true;
  });
  db.deliveries.forEach(delivery => {
    if (migrateDelivery(delivery)) needSave = true;
  });
  db.auditLog.forEach(entry => {
    if (migrateAuditEntry(entry)) needSave = true;
  });
  const existingMethodNames = new Set(db.methods.map(m => m.name));
  const usedMethodNames = new Set();
  db.samples.forEach(sample => {
    sample.slices.forEach(slice => {
      if (slice.method && typeof slice.method === "string" && slice.method.trim()) {
        usedMethodNames.add(slice.method.trim());
      }
    });
  });
  db.deliveries.forEach(delivery => {
    delivery.slices.forEach(s => {
      if (s.method && typeof s.method === "string" && s.method.trim()) {
        usedMethodNames.add(s.method.trim());
      }
    });
  });
  let nextSort = db.methods.length > 0 ? Math.max(...db.methods.map(m => m.sortOrder || 0)) + 1 : 1;
  usedMethodNames.forEach(name => {
    if (!existingMethodNames.has(name)) {
      db.methods.push({
        id: "M-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4),
        name: name,
        description: "从历史数据自动导入",
        enabled: true,
        createdAt: new Date().toISOString(),
        sortOrder: nextSort++
      });
      needSave = true;
    }
  });
  if (needSave) await saveDb(db);
  return db;
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
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  else sample.status = "待切割";
}

function createSampleSnapshot(sample) {
  return JSON.parse(JSON.stringify(sample));
}

function sampleSummary(sample) {
  return {
    id: sample.id,
    project: sample.project,
    borehole: sample.borehole,
    coreBox: sample.coreBox,
    depth: sample.depth,
    owner: sample.owner,
    status: sample.status,
    delivery: sample.delivery,
    sliceCount: sample.slices.length,
    sliceStatuses: sample.slices.map(s => ({
      id: s.id,
      method: s.method,
      status: s.status,
      observationCount: (s.observations || []).length,
      lastLog: s.logs && s.logs.length ? s.logs[s.logs.length - 1] : null,
      lastObservation: s.observations && s.observations.length ? s.observations[s.observations.length - 1] : null
    }))
  };
}

const ACTION_LABELS = {
  "sample:create": "创建样本",
  "slice:append": "追加切片",
  "slice:batch": "批量追加切片",
  "step:advance": "推进步骤",
  "observation:create": "填写观察结果",
  "delivery:confirm": "确认交付",
  "csv:import": "CSV导入",
  "sample:rollback": "回滚样本"
};

function describeDiff(beforeSample, afterSample, action) {
  const parts = [];
  if (!beforeSample && afterSample) {
    parts.push(`新建样本 ${afterSample.id}（${afterSample.project}），含 ${afterSample.slices.length} 个切片`);
    return parts.join("；");
  }
  if (!beforeSample || !afterSample) return "";
  if (action === "sample:rollback") {
    parts.push(`样本状态从「${beforeSample.status}」回滚至「${afterSample.status}」`);
    parts.push(`交付状态从「${beforeSample.delivery}」变为「${afterSample.delivery}」`);
  }
  if (beforeSample.status !== afterSample.status) {
    parts.push(`状态：${beforeSample.status} → ${afterSample.status}`);
  }
  if (beforeSample.delivery !== afterSample.delivery) {
    parts.push(`交付：${beforeSample.delivery} → ${afterSample.delivery}`);
  }
  if (beforeSample.slices.length !== afterSample.slices.length) {
    parts.push(`切片数量：${beforeSample.slices.length} → ${afterSample.slices.length}`);
  }
  const beforeSliceMap = {};
  beforeSample.slices.forEach(s => { beforeSliceMap[s.id] = s; });
  afterSample.slices.forEach(s => {
    const before = beforeSliceMap[s.id];
    if (!before) {
      parts.push(`新增切片 ${s.id}（${s.method}）`);
    } else {
      if (before.status !== s.status) {
        parts.push(`切片 ${s.id}：${before.status} → ${s.status}`);
      }
      const beforeObsCount = (before.observations || []).length;
      const afterObsCount = (s.observations || []).length;
      if (beforeObsCount !== afterObsCount) {
        parts.push(`切片 ${s.id} 观察记录：${beforeObsCount} → ${afterObsCount} 条`);
      }
      const beforeLogCount = (before.logs || []).length;
      const afterLogCount = (s.logs || []).length;
      if (beforeLogCount !== afterLogCount) {
        parts.push(`切片 ${s.id} 步骤日志：${beforeLogCount} → ${afterLogCount} 条`);
      }
    }
  });
  return parts.join("；");
}

function recordAudit(db, { sampleId, action, operator, sourceApi, beforeSample, afterSample, note }) {
  const entry = {
    id: `AUD-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    sampleId,
    action,
    actionLabel: ACTION_LABELS[action] || action,
    operator: operator || "unknown",
    operatorName: operator ? (ROLE_INFO[operator]?.name || operator) : "未知",
    timestamp: new Date().toISOString(),
    sourceApi,
    note: note || describeDiff(beforeSample, afterSample, action),
    beforeSummary: beforeSample ? sampleSummary(beforeSample) : null,
    afterSummary: afterSample ? sampleSummary(afterSample) : null,
    snapshot: afterSample ? createSampleSnapshot(afterSample) : null
  };
  db.auditLog.unshift(entry);
  return entry;
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

function getAllSampleIds(db) {
  return db.samples.map(s => s.id);
}

const DEPTH_PATTERN = /^\d+(\.\d+)?\s*-\s*\d+(\.\d+)?\s*m?$/i;

function validateDepth(depth) {
  if (!depth || typeof depth !== "string" || depth.trim() === "") {
    return false;
  }
  return DEPTH_PATTERN.test(depth.trim());
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map(h => h.trim().replace(/^["']|["']$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] !== undefined ? values[idx] : "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

function normalizeHeader(header) {
  const map = {
    "样本编号": "sampleId",
    "sampleId": "sampleId",
    "sample_id": "sampleId",
    "项目": "project",
    "project": "project",
    "钻孔编号": "borehole",
    "钻孔": "borehole",
    "borehole": "borehole",
    "岩芯箱号": "coreBox",
    "箱号": "coreBox",
    "coreBox": "coreBox",
    "core_box": "coreBox",
    "取样深度": "depth",
    "深度": "depth",
    "depth": "depth",
    "负责人": "owner",
    "owner": "owner",
    "切片编号": "sliceId",
    "sliceId": "sliceId",
    "slice_id": "sliceId",
    "染色方法": "method",
    "方法": "method",
    "method": "method",
    "制片方法": "method"
  };
  return map[header] || header;
}

function validateCSVImport(rows, db) {
  const errors = [];
  const warnings = [];
  const validatedRows = [];
  const allExistingSliceIds = getAllSliceIds(db);
  const allExistingSampleIds = getAllSampleIds(db);
  const seenSliceIds = [];
  const sampleGroups = {};

  rows.forEach((row, index) => {
    const rowNum = index + 2;
    const rowErrors = [];
    const rowWarnings = [];

    const project = (row.project || "").trim();
    const borehole = (row.borehole || "").trim();
    const coreBox = (row.coreBox || "").trim();
    const depth = (row.depth || "").trim();
    const owner = (row.owner || "").trim();
    const sliceId = (row.sliceId || "").trim();
    const method = (row.method || "").trim();
    const sampleId = (row.sampleId || "").trim();

    if (!project) rowErrors.push("项目不能为空");
    if (!borehole) rowErrors.push("钻孔编号不能为空");
    if (!coreBox) rowErrors.push("岩芯箱号不能为空");
    if (!depth) {
      rowErrors.push("取样深度不能为空");
    } else if (!validateDepth(depth)) {
      rowErrors.push("深度格式异常 \"" + depth + "\"，正确格式示例：128.4-128.8m");
    }
    if (!owner) rowErrors.push("负责人不能为空");
    if (!sliceId) {
      rowErrors.push("切片编号不能为空");
    } else {
      if (!SLICE_ID_PATTERN.test(sliceId)) {
        rowErrors.push("切片编号格式异常 \"" + sliceId + "\"，正确格式示例：SL-001-A");
      }
      if (allExistingSliceIds.includes(sliceId)) {
        rowErrors.push("切片编号 \"" + sliceId + "\" 已存在");
      }
      if (seenSliceIds.includes(sliceId)) {
        rowErrors.push("切片编号 \"" + sliceId + "\" 在CSV中重复");
      }
      if (rowErrors.length === 0) seenSliceIds.push(sliceId);
    }
    if (!method) rowErrors.push("染色方法不能为空");

    if (sampleId && allExistingSampleIds.includes(sampleId)) {
      rowWarnings.push("样本编号 \"" + sampleId + "\" 已存在，将追加切片添加到该样本");
    }

    validatedRows.push({
      rowNum,
      data: { project, borehole, coreBox, depth, owner, sliceId, method, sampleId },
      errors: rowErrors,
      warnings: rowWarnings,
      hasError: rowErrors.length > 0,
      hasWarning: rowWarnings.length > 0
    });

    const groupKey = sampleId || `${project}|${borehole}|${coreBox}|${depth}|${owner}`;
    if (!sampleGroups[groupKey]) {
      sampleGroups[groupKey] = { sampleId, project, borehole, coreBox, depth, owner, slices: [] };
    }
    if (!rowErrors.length) {
      sampleGroups[groupKey].slices.push({ id: sliceId, method });
    }
  });

  const validRows = validatedRows.filter(r => !r.hasError);
  const invalidRows = validatedRows.filter(r => r.hasError);

  return {
    totalRows: rows.length,
    validRows: validRows.length,
    invalidRows: invalidRows.length,
    validatedRows,
    sampleGroups: Object.values(sampleGroups),
    errors,
    warnings
  };
}

function groupSlicesToSamples(groups, db) {
  const samples = [];
  const allExistingSliceIds = getAllSliceIds(db);
  const usedSliceIds = [];

  groups.forEach(group => {
    if (group.slices.length === 0) return;

    let sample;
    if (group.sampleId) {
      sample = db.samples.find(s => s.id === group.sampleId);
    }
    if (sample) {
      const newSlices = group.slices.filter(s => !allExistingSliceIds.includes(s.id) && !usedSliceIds.includes(s.id));
      newSlices.forEach(s => usedSliceIds.push(s.id));
      samples.push({
        isNew: false,
        sampleId: sample.id,
        newSlices
      });
    } else {
      const validSlices = group.slices.filter(s => !allExistingSliceIds.includes(s.id) && !usedSliceIds.includes(s.id));
      validSlices.forEach(s => usedSliceIds.push(s.id));
      samples.push({
        isNew: true,
        sampleData: {
          project: group.project,
          borehole: group.borehole,
          coreBox: group.coreBox,
          depth: group.depth,
          owner: group.owner
        },
        newSlices: validSlices
      });
    }
  });

  return samples;
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
    .modal.wide { width:620px; }
    .modal h2 { margin:0 0 14px; }
    .modal-footer { display:flex; gap:10px; justify-content:flex-end; margin-top:14px; }
    .obs-summary { background:#f5f8f0; border:1px solid #c6dcb8; border-radius:6px; padding:8px 10px; margin-top:8px; font-size:13px; }
    .obs-summary .label { color:var(--accent); font-weight:700; margin-right:4px; }
    .obs-row { margin-top:6px; }
    .obs-row b { color:var(--stone); }
    .obs-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
    .obs-header .obs-date { color:var(--muted); font-size:12px; }
    .obs-history { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); }
    .obs-history-item { padding:8px 0; border-bottom:1px solid var(--line); font-size:13px; }
    .obs-history-item:last-child { border-bottom:0; }
    .obs-btn { margin-top:6px; }
    .view-tabs { display:flex; gap:4px; background:#eef1ea; padding:4px; border-radius:8px; }
    .view-tab { padding:8px 16px; border-radius:6px; background:transparent; color:var(--muted); font-weight:600; }
    .view-tab.active { background:#fff; color:var(--ink); box-shadow:0 1px 2px rgba(0,0,0,0.08); }
    .view-content { display:none; }
    .view-content.active { display:block; }
    .workbench { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; min-height:400px; }
    .workbench-column { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px; display:flex; flex-direction:column; min-height:0; }
    .workbench-column-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:8px; border-bottom:2px solid var(--line); }
    .workbench-column-header h3 { margin:0; font-size:15px; display:flex; align-items:center; gap:6px; }
    .workbench-column-count { background:var(--accent); color:#fff; border-radius:999px; padding:2px 8px; font-size:12px; font-weight:700; min-width:24px; text-align:center; }
    .workbench-cards { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; }
    .workbench-card { background:#f8faf5; border:1px solid var(--line); border-radius:6px; padding:10px; cursor:pointer; transition:all 0.15s; }
    .workbench-card:hover { background:#fff; border-color:var(--accent); box-shadow:0 2px 6px rgba(82,111,67,0.15); }
    .workbench-card-id { font-weight:700; font-size:13px; margin-bottom:4px; }
    .workbench-card-meta { font-size:12px; color:var(--muted); margin-bottom:2px; }
    .workbench-card-project { font-size:11px; color:var(--stone); }
    .workbench-card-actions { margin-top:8px; display:flex; flex-direction:column; gap:6px; }
    .workbench-card-actions textarea { min-height:50px; font-size:12px; padding:6px; }
    .workbench-card-actions button { padding:6px 10px; font-size:12px; }
    .workbench-card-actions .row { display:flex; gap:6px; }
    .workbench-card-actions select { font-size:12px; padding:6px; }
    .workbench-empty { text-align:center; color:var(--muted); font-size:12px; padding:20px 8px; border:1px dashed var(--line); border-radius:6px; }
    .workbench-error { background:var(--warn-bg); border:1px solid var(--warn-border); border-radius:8px; padding:16px; text-align:center; color:var(--danger); grid-column:1/-1; }
    .step-indicator { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:700; }
    @media (max-width:1200px){ .workbench{grid-template-columns:repeat(3,1fr);} }
    @media (max-width:800px){ .workbench{grid-template-columns:1fr 1fr;} }
    @media (max-width:500px){ .workbench{grid-template-columns:1fr;} }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} .view-tabs{margin-top:12px;} }
    .delivery-modal { width: 780px; }
    .delivery-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
    .delivery-section:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
    .delivery-section h3 { margin: 0 0 10px; font-size: 15px; color: var(--stone); }
    .delivery-basic-info { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; }
    .delivery-basic-info div { font-size: 13px; }
    .delivery-basic-info div b { color: var(--stone); margin-right: 6px; }
    .slice-status-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .slice-status-table th, .slice-status-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); }
    .slice-status-table th { background: #f5f8f0; font-weight: 600; color: var(--stone); }
    .slice-status-table tr:hover td { background: #fafcf6; }
    .status-ok { color: var(--accent); font-weight: 600; }
    .status-warn { color: var(--danger); font-weight: 600; }
    .missing-list { background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 6px; padding: 10px 12px; }
    .missing-list ul { margin: 6px 0 0 0; padding-left: 20px; }
    .missing-list li { color: var(--danger); font-size: 13px; margin: 2px 0; }
    .complete-info { background: #edf5e8; border: 1px solid #c6dcb8; border-radius: 6px; padding: 10px 12px; color: var(--accent); font-size: 13px; }
    .logs-summary { max-height: 180px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; }
    .logs-summary-item { padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
    .logs-summary-item:last-child { border-bottom: 0; }
    .logs-summary-item .log-time { color: var(--muted); margin-right: 8px; }
    .logs-summary-item .log-step { display: inline-block; background: #e7ece1; padding: 1px 6px; border-radius: 4px; margin-right: 6px; font-weight: 600; color: var(--stone); }
    .logs-summary-item .log-slice { color: var(--accent); font-weight: 600; margin-right: 6px; }
    .delivery-form-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 10px; }
    .delivery-form-row .full { grid-column: 1 / -1; }
    .deliveries-list { display: flex; flex-direction: column; gap: 12px; }
    .delivery-card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .delivery-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
    .delivery-card-id { font-size: 15px; font-weight: 700; color: var(--accent); }
    .delivery-card-time { font-size: 12px; color: var(--muted); }
    .delivery-card-info { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; font-size: 13px; margin-bottom: 10px; }
    .delivery-card-info b { color: var(--stone); }
    .delivery-card-slices { background: #f5f8f0; border-radius: 6px; padding: 10px; font-size: 12px; }
    .delivery-card-slices b { color: var(--stone); display: block; margin-bottom: 4px; }
    .delivery-card-slices .slice-item { display: inline-block; background: #fff; border: 1px solid var(--line); border-radius: 4px; padding: 3px 8px; margin: 3px 6px 3px 0; }
    .delivery-card-remark { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); font-size: 13px; color: var(--stone); }
    .delivery-empty { padding: 60px; text-align: center; color: var(--muted); background: #fff; border: 1px dashed var(--line); border-radius: 8px; font-size: 14px; }
    .import-tabs { display: flex; gap: 0; border-bottom: 2px solid var(--line); margin-bottom: 14px; }
    .import-tab { padding: 10px 16px; background: none; border: 0; color: var(--muted); font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; }
    .import-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .import-content { display: none; }
    .import-content.active { display: block; }
    .csv-upload-area { border: 2px dashed var(--line); border-radius: 8px; padding: 30px; text-align: center; background: #fafcf7; cursor: pointer; transition: all 0.2s; }
    .csv-upload-area:hover { border-color: var(--accent); background: #f0f5eb; }
    .csv-upload-area.dragover { border-color: var(--accent); background: #e7f0dd; }
    .csv-upload-icon { font-size: 48px; margin-bottom: 10px; }
    .csv-upload-text { color: var(--muted); font-size: 14px; }
    .csv-upload-text strong { color: var(--accent); }
    .csv-file-info { background: #f5f8f0; border: 1px solid #c6dcb8; border-radius: 6px; padding: 10px 12px; margin-top: 10px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
    .csv-file-info .filename { font-weight: 600; color: var(--stone); }
    .csv-preview-container { max-height: 400px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; margin-top: 12px; }
    .csv-preview-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .csv-preview-table th, .csv-preview-table td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
    .csv-preview-table th { background: #f5f8f0; position: sticky; top: 0; font-weight: 600; color: var(--stone); }
    .csv-preview-table tr:hover td { background: #fafcf6; }
    .csv-preview-table tr.row-error td { background: #fdf2ef; }
    .csv-preview-table tr.row-warning td { background: #fff8e6; }
    .csv-preview-table td.cell-error { background: #fde8e4; color: var(--danger); }
    .csv-preview-table td.cell-warning { background: #fff3cd; }
    .csv-error-badge { display: inline-block; background: var(--danger); color: #fff; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 4px; }
    .csv-warn-badge { display: inline-block; background: #f0ad4e; color: #fff; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 4px; }
    .csv-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
    .csv-stat { background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: center; }
    .csv-stat strong { display: block; font-size: 20px; color: var(--stone); }
    .csv-stat.valid strong { color: var(--accent); }
    .csv-stat.invalid strong { color: var(--danger); }
    .csv-stat span { font-size: 12px; color: var(--muted); }
    .csv-issues-list { max-height: 150px; overflow-y: auto; background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin-top: 10px; }
    .csv-issue-item { font-size: 12px; padding: 4px 6px; border-bottom: 1px solid var(--line); }
    .csv-issue-item:last-child { border-bottom: 0; }
    .csv-issue-item.error { color: var(--danger); }
    .csv-issue-item.warning { color: #c69a00; }
    .csv-issue-item .row-num { font-weight: 600; margin-right: 6px; }
    .csv-sample-summary { background: #f5f8f0; border: 1px solid #c6dcb8; border-radius: 6px; padding: 10px 12px; margin-top: 12px; font-size: 13px; }
    .csv-import-modal { width: 820px; }
    .csv-import-result { background: #edf5e8; border: 1px solid #c6dcb8; border-radius: 8px; padding: 16px; margin-top: 12px; }
    .csv-import-result.error { background: var(--warn-bg); border-color: var(--warn-border); }
    .csv-import-result h3 { margin: 0 0 8px; color: var(--accent); }
    .csv-import-result.error h3 { color: var(--danger); }
    .csv-import-result ul { margin: 8px 0 0; padding-left: 20px; }
    .csv-import-result li { font-size: 13px; margin: 3px 0; }
    .stats-overview { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; }
    .stats-kpi { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; text-align:center; }
    .stats-kpi strong { display:block; font-size:28px; color:var(--accent); }
    .stats-kpi span { font-size:12px; color:var(--muted); }
    .stats-section { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:14px; }
    .stats-section h2 { margin:0 0 12px; font-size:16px; }
    .stats-table { width:100%; border-collapse:collapse; font-size:13px; }
    .stats-table th, .stats-table td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--line); }
    .stats-table th { background:#f5f8f0; font-weight:600; color:var(--stone); position:sticky; top:0; }
    .stats-table tr:hover td { background:#fafcf6; }
    .stats-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .stats-bar-wrap { background:#eef1ea; border-radius:4px; height:18px; position:relative; min-width:60px; }
    .stats-bar { background:var(--accent); border-radius:4px; height:100%; transition:width 0.3s; }
    .stats-bar-label { position:absolute; right:6px; top:0; line-height:18px; font-size:11px; color:var(--ink); font-weight:600; }
    .stats-backlog-cell { display:inline-block; min-width:22px; text-align:center; padding:2px 6px; border-radius:4px; font-weight:600; font-size:12px; }
    .stats-backlog-zero { background:#eef1ea; color:var(--muted); }
    .stats-backlog-low { background:#edf5e8; color:var(--accent); }
    .stats-backlog-mid { background:#fff3cd; color:#856404; }
    .stats-backlog-high { background:var(--warn-bg); color:var(--danger); }
    .stats-timing-scroll { max-height:420px; overflow-y:auto; }
    .stats-step-row { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
    .stats-step-label { width:50px; font-weight:600; color:var(--stone); font-size:13px; flex-shrink:0; }
    .stats-step-bar-wrap { flex:1; }
    .stats-step-value { width:80px; text-align:right; font-size:13px; color:var(--ink); flex-shrink:0; }
    .stats-progress-zero { background:#eef1ea; color:var(--muted); }
    .stats-progress-low { background:#edf5e8; color:var(--accent); }
    .stats-progress-mid { background:#fff3cd; color:#856404; }
    .stats-progress-done { background:#d4edda; color:#155724; }
    .stats-expand-icon { cursor:pointer; font-size:14px; color:var(--accent); font-weight:700; user-select:none; }
    .stats-timing-main:hover td { background:#f0f4ec; }
    .stats-step-detail-row td { padding:0 !important; border-bottom:1px solid var(--line); }
    .stats-step-detail-wrap { padding:12px 16px 12px 44px; background:#fafcf7; }
    .stats-inner-table { width:100%; border-collapse:collapse; font-size:12px; }
    .stats-inner-table th, .stats-inner-table td { padding:6px 10px; text-align:left; border-bottom:1px solid #eef1ea; }
    .stats-inner-table th { color:var(--stone); font-weight:600; background:#f0f4ec; }
    .stats-inner-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .stats-step-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--accent); margin-right:6px; vertical-align:middle; }
    .method-config-btn { background:var(--stone); padding:8px 14px; }
    .method-modal { width: 680px; }
    .method-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .method-item { background: #fafcf7; border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: start; }
    .method-item.disabled { background: #f5f5f4; opacity: 0.7; }
    .method-item-main { display: flex; flex-direction: column; gap: 4px; }
    .method-name-row { display: flex; align-items: center; gap: 8px; }
    .method-name { font-weight: 700; font-size: 15px; }
    .method-desc { color: var(--muted); font-size: 13px; }
    .method-meta { font-size: 12px; color: var(--stone); margin-top: 4px; }
    .method-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .method-actions button { padding: 6px 10px; font-size: 12px; }
    .method-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .method-badge.enabled { background: #edf5e8; color: var(--accent); }
    .method-badge.disabled { background: #eef1ea; color: var(--muted); }
    .method-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .method-form-grid .full { grid-column: 1 / -1; }
    .slice-method-select-wrap { position: relative; }
    .slice-method-select-wrap select { padding-right: 40px; }
    .slice-method-custom-toggle { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: none; border: 0; color: var(--stone); cursor: pointer; padding: 4px 8px; font-size: 12px; }
    .role-selector { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: #f5f8f0; border: 1px solid var(--line); border-radius: 8px; }
    .role-selector label { margin: 0; font-size: 13px; color: var(--stone); font-weight: 600; }
    .role-selector select { width: auto; min-width: 160px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--line); }
    .role-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; }
    .role-desc { font-size: 11px; color: var(--muted); max-width: 240px; }
    .role-info-tip { padding: 10px 14px; background: #f5f8f0; border: 1px solid #c6dcb8; border-radius: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .role-info-tip .role-main { display: flex; align-items: center; gap: 10px; }
    .role-info-tip .role-perms { font-size: 12px; color: var(--stone); }
    .role-required-warn { padding: 40px; text-align: center; color: var(--muted); background: #fff; border: 1px dashed var(--line); border-radius: 8px; }
    .role-required-warn h3 { color: var(--danger); margin: 0 0 8px; }
    .no-perm-hint { font-size: 12px; color: var(--muted); font-style: italic; padding: 20px; text-align: center; background: #fafafa; border-radius: 6px; }
    .audit-timeline { position: relative; padding-left: 28px; }
    .audit-timeline::before { content: ''; position: absolute; left: 10px; top: 8px; bottom: 8px; width: 2px; background: var(--line); }
    .audit-item { position: relative; padding: 12px 14px; background: #fff; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 12px; }
    .audit-item::before { content: ''; position: absolute; left: -23px; top: 16px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid #fff; box-shadow: 0 0 0 2px var(--line); }
    .audit-item.rollback::before { background: var(--danger); }
    .audit-item-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
    .audit-item-title { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .audit-item-action { background: var(--accent); color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .audit-item.rollback .audit-item-action { background: var(--danger); }
    .audit-item-time { font-size: 12px; color: var(--muted); white-space: nowrap; }
    .audit-item-meta { display: flex; gap: 16px; font-size: 12px; color: var(--stone); margin-bottom: 8px; flex-wrap: wrap; }
    .audit-item-meta span b { color: var(--ink); }
    .audit-item-note { font-size: 13px; color: var(--ink); background: #f5f8f0; padding: 8px 10px; border-radius: 6px; margin-bottom: 8px; }
    .audit-item-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 12px; }
    .audit-summary-block { background: #fafcf7; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
    .audit-summary-block h4 { margin: 0 0 6px; font-size: 12px; color: var(--stone); }
    .audit-summary-block .status-pill { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #e7ece1; font-size: 11px; margin-right: 4px; }
    .audit-item-actions { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
    .audit-item-actions button { padding: 6px 12px; font-size: 12px; }
    .audit-filter-panel { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 14px; }
    .audit-filter-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    .audit-filter-row label { margin: 0 0 4px; font-size: 13px; color: var(--muted); display: block; }
    .audit-filter-actions { display: flex; gap: 8px; align-items: flex-end; justify-content: flex-end; margin-top: 12px; }
    .audit-filter-actions button { padding: 8px 14px; }
    .audit-empty { padding: 60px; text-align: center; color: var(--muted); background: #fff; border: 1px dashed var(--line); border-radius: 8px; }
    .audit-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
    .audit-stat { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 14px; text-align: center; }
    .audit-stat strong { display: block; font-size: 24px; color: var(--accent); }
    .audit-stat span { font-size: 12px; color: var(--muted); }
    .rollback-confirm-info { background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 6px; padding: 12px; margin: 12px 0; }
    .rollback-confirm-info h4 { margin: 0 0 8px; color: var(--danger); font-size: 14px; }
    .rollback-confirm-info ul { margin: 6px 0 0; padding-left: 20px; font-size: 13px; }
    .rollback-confirm-info li { margin: 3px 0; }
    .slices-summary-list { font-size: 12px; color: var(--stone); }
    .slices-summary-list div { padding: 2px 0; }
    .view-audit { padding-bottom: 20px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>岩芯样本切片实验室</h1>
      <div class="meta">样本、切片任务、制片步骤和交付</div>
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
      <div class="role-selector" id="role-selector">
        <label>🔐 当前角色：</label>
        <select id="role-select">
          <option value="">-- 请选择角色 --</option>
        </select>
      </div>
      <div class="view-tabs" id="view-tabs">
        <button type="button" class="view-tab active" data-view="cards">样本卡片</button>
        <button type="button" class="view-tab" data-view="workbench">实验室工作台</button>
        <button type="button" class="view-tab" data-view="deliveries">历史交付包</button>
        <button type="button" class="view-tab" data-view="stats">制片耗时统计</button>
        <button type="button" class="view-tab" data-view="audit">变更审计</button>
      </div>
      <button id="method-config-btn" class="method-config-btn">⚙ 工艺配置</button>
      <button id="reload">刷新</button>
    </div>
  </header>
  <main>
    <div id="role-info-container"></div>
    <div id="no-role-warn" style="display:none;" class="panel">
      <div class="role-required-warn">
        <h3>⚠️ 请先选择角色</h3>
        <p>为确保操作安全，本系统需要先选择当前操作角色才能使用功能。</p>
        <p style="margin-top:10px;">请在页面右上角的「当前角色」下拉框中选择您的角色。</p>
        <div style="margin-top:16px; display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:10px; text-align:left;">
          <div style="padding:12px; background:#f8faf5; border:1px solid var(--line); border-radius:6px;">
            <b style="color:var(--accent);">📋 样本登记人员</b>
            <div style="font-size:12px; color:var(--muted); margin-top:4px;">创建样本、录入切片任务、CSV批量导入</div>
          </div>
          <div style="padding:12px; background:#f8faf5; border:1px solid var(--line); border-radius:6px;">
            <b style="color:var(--accent);">🔬 制片人员</b>
            <div style="font-size:12px; color:var(--muted); margin-top:4px;">推进工序：取样→切割→研磨→染色</div>
          </div>
          <div style="padding:12px; background:#f8faf5; border:1px solid var(--line); border-radius:6px;">
            <b style="color:var(--accent);">👁️ 观察人员</b>
            <div style="font-size:12px; color:var(--muted); margin-top:4px;">填写观察结果、归档观察记录</div>
          </div>
          <div style="padding:12px; background:#f8faf5; border:1px solid var(--line); border-radius:6px;">
            <b style="color:var(--accent);">📦 交付人员</b>
            <div style="font-size:12px; color:var(--muted); margin-top:4px;">生成交付包、查看历史交付记录</div>
          </div>
        </div>
      </div>
    </div>
    <div class="panel sample-form">
      <div class="import-tabs">
        <button type="button" class="import-tab active" data-import-tab="manual">手动创建</button>
        <button type="button" class="import-tab" data-import-tab="csv">CSV批量导入</button>
      </div>

      <div id="import-manual" class="import-content active">
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
      </div>

      <div id="import-csv" class="import-content">
        <h2>CSV批量导入</h2>
        <div class="format-hint" style="margin-bottom:10px;">支持列名：项目、钻孔编号、岩芯箱号、取样深度、负责人、切片编号、染色方法、样本编号（选填，用于追加到已有样本）</div>
        <div class="csv-upload-area" id="csv-upload-area">
          <div class="csv-upload-icon">📄</div>
          <div class="csv-upload-text">
            <strong>点击选择CSV文件</strong> 或拖拽文件到此处
          </div>
          <div class="format-hint" style="margin-top:8px;">每行代表一个切片任务，相同样本信息的行会自动合并</div>
        </div>
        <input type="file" id="csv-file-input" accept=".csv" style="display:none;">
        <div id="csv-file-info" style="display:none;"></div>
        <div id="csv-preview-area" style="display:none;">
          <div class="csv-stats">
            <div class="csv-stat"><strong id="csv-stat-total">0</strong><span>总行数</span></div>
            <div class="csv-stat valid"><strong id="csv-stat-valid">0</strong><span>有效行</span></div>
            <div class="csv-stat invalid"><strong id="csv-stat-invalid">0</strong><span>问题行</span></div>
            <div class="csv-stat"><strong id="csv-stat-samples">0</strong><span>涉及样本</span></div>
          </div>
          <div class="csv-sample-summary" id="csv-sample-summary"></div>
          <div style="margin-top:12px;">
            <h3 style="margin:0 0 6px;font-size:14px;color:var(--stone);">数据预览</h3>
            <div class="csv-preview-container" id="csv-preview-container"></div>
          </div>
          <div style="margin-top:12px;">
            <h3 style="margin:0 0 6px;font-size:14px;color:var(--stone);">问题列表</h3>
            <div class="csv-issues-list" id="csv-issues-list"></div>
          </div>
        </div>
        <div id="csv-import-result" style="display:none;"></div>
        <div class="modal-footer" style="margin-top:14px;">
          <button type="button" class="secondary" id="csv-reset-btn" style="display:none;">重新选择</button>
          <button type="button" id="csv-import-btn" style="display:none;">确认导入</button>
        </div>
      </div>
    </div>
    <section>
      <div id="view-samples-area">
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
        <div id="view-cards" class="view-content active">
          <div class="result-count" id="result-count"></div>
          <div class="grid" id="samples"></div>
        </div>
        <div id="view-workbench" class="view-content">
          <div class="result-count" id="workbench-count"></div>
          <div class="workbench" id="workbench"></div>
        </div>
      </div>
      <div id="view-deliveries" class="view-content">
        <div class="filter-panel">
          <h2>交付包筛选</h2>
          <div class="filter-row">
            <div>
              <label>项目</label>
              <select id="delivery-filter-project"><option value="">全部项目</option></select>
            </div>
            <div>
              <label>接收单位</label>
              <select id="delivery-filter-unit"><option value="">全部单位</option></select>
            </div>
            <div>
              <label>交付人</label>
              <select id="delivery-filter-person"><option value="">全部交付人</option></select>
            </div>
          </div>
          <div class="filter-actions">
            <button type="button" class="secondary" id="clear-delivery-filters">清除筛选</button>
          </div>
        </div>
        <div class="result-count" id="deliveries-count"></div>
        <div class="deliveries-list" id="deliveries"></div>
      </div>
      <div id="view-stats" class="view-content">
        <div class="filter-panel">
          <h2>耗时统计筛选</h2>
          <div class="filter-row">
            <div>
              <label>项目</label>
              <select id="stats-filter-project"><option value="">全部项目</option></select>
            </div>
            <div>
              <label>负责人</label>
              <select id="stats-filter-owner"><option value="">全部负责人</option></select>
            </div>
          </div>
          <div class="filter-actions">
            <button type="button" class="secondary" id="clear-stats-filters">清除筛选</button>
          </div>
        </div>
        <div class="stats-overview" id="stats-overview"></div>
        <div class="stats-section">
          <h2>样本维度耗时汇总</h2>
          <div id="stats-sample-timings"></div>
        </div>
        <div class="stats-section">
          <h2>各工序平均停留时间</h2>
          <div id="stats-step-avg"></div>
        </div>
        <div class="stats-section">
          <h2>样本切片耗时明细</h2>
          <div id="stats-slice-timings"></div>
        </div>
        <div class="stats-section">
          <h2>负责人任务积压</h2>
          <div id="stats-owner-backlog"></div>
        </div>
      </div>
      <div id="view-audit" class="view-content view-audit">
        <div class="audit-filter-panel">
          <h2>审计记录筛选</h2>
          <div class="audit-filter-row">
            <div>
              <label>样本编号</label>
              <select id="audit-filter-sample"><option value="">全部样本</option></select>
            </div>
            <div>
              <label>操作类型</label>
              <select id="audit-filter-action"><option value="">全部操作</option></select>
            </div>
            <div>
              <label>操作者</label>
              <select id="audit-filter-operator"><option value="">全部操作者</option></select>
            </div>
          </div>
          <div class="audit-filter-actions">
            <button type="button" class="secondary" id="clear-audit-filters">清除筛选</button>
          </div>
        </div>
        <div class="audit-stats" id="audit-stats"></div>
        <div class="result-count" id="audit-count"></div>
        <div class="audit-timeline" id="audit-timeline"></div>
      </div>
    </section>
  </main>
  <div id="modal-root"></div>
  <script>
    const ROLES = ${JSON.stringify(ROLES)};
    const ROLE_INFO = ${JSON.stringify(ROLE_INFO)};
    const PERMISSIONS = ${JSON.stringify(PERMISSIONS)};
    const ROLE_PERMISSIONS = ${JSON.stringify(ROLE_PERMISSIONS)};
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};

    let currentRole = localStorage.getItem("currentRole") || "";

    function roleHasPerm(perm) {
      if (!currentRole) return false;
      const perms = ROLE_PERMISSIONS[currentRole];
      return perms && perms.includes(perm);
    }

    function setRole(roleKey) {
      currentRole = roleKey || "";
      if (currentRole) {
        localStorage.setItem("currentRole", currentRole);
      } else {
        localStorage.removeItem("currentRole");
      }
      const roleSelect = document.querySelector("#role-select");
      if (roleSelect) roleSelect.value = currentRole;
      applyRoleToUI();
    }

    function initRoleSelector() {
      const roleSelect = document.querySelector("#role-select");
      if (!roleSelect) return;
      roleSelect.innerHTML = '<option value="">-- 请选择角色 --</option>' +
        Object.keys(ROLE_INFO).map(key =>
          '<option value="' + key + '"' + (key === currentRole ? ' selected' : '') + '>' +
          ROLE_INFO[key].name + '</option>'
        ).join("");
      roleSelect.onchange = () => {
        setRole(roleSelect.value);
        load();
      };
    }

    function applyRoleToUI() {
      const sampleForm = document.querySelector(".sample-form");
      const methodConfigBtn = document.querySelector("#method-config-btn");
      const createSliceArea = document.querySelector("#create-slice-rows");
      const importTabs = document.querySelector(".import-tabs");
      const viewTabs = document.querySelector("#view-tabs");
      const viewDeliveries = document.querySelector("#view-deliveries");
      const viewStats = document.querySelector("#view-stats");
      const batchAppendBtns = document.querySelectorAll("[data-batch-append]");
      const deliverBtns = document.querySelectorAll("[data-deliver]");
      const obsBtns = document.querySelectorAll("[data-observation]");
      const logBtns = document.querySelectorAll("[data-log]");
      const stepSelects = document.querySelectorAll("[data-step]");
      const noteInputs = document.querySelectorAll("[data-note]");
      const workbenchAdvanceBtns = document.querySelectorAll("[data-workbench-advance]");
      const workbenchLogBtns = document.querySelectorAll("[data-workbench-log]");
      const workbenchObsBtns = document.querySelectorAll("[data-workbench-obs]");
      const methodActions = document.querySelectorAll("[data-method-edit], [data-method-toggle]");
      const methodAddBtn = document.querySelector("#method-add-btn");
      const roleInfoContainer = document.querySelector("#role-info-container");
      const noRoleWarn = document.querySelector("#no-role-warn");
      const formEl = document.querySelector("#form");
      const csvImportEl = document.querySelector("#import-csv");
      const viewCards = document.querySelector("#view-cards");
      const viewWorkbench = document.querySelector("#view-workbench");

      if (!currentRole) {
        if (sampleForm) sampleForm.style.display = "none";
        if (viewSamplesArea) viewSamplesArea.style.display = "none";
        if (methodConfigBtn) methodConfigBtn.style.display = "none";
        if (viewDeliveries) viewDeliveries.classList.remove("active");
        if (viewStats) viewStats.classList.remove("active");
        if (viewCards) viewCards.classList.remove("active");
        if (viewWorkbench) viewWorkbench.classList.remove("active");
        if (noRoleWarn) noRoleWarn.style.display = "";
        if (roleInfoContainer) roleInfoContainer.innerHTML = "";
        return;
      }

      if (noRoleWarn) noRoleWarn.style.display = "none";
      if (roleInfoContainer) {
        const roleInfo = ROLE_INFO[currentRole] || {};
        const rolePerms = ROLE_PERMISSIONS[currentRole] || [];
        const permNames = {
          "sample:create": "创建样本",
          "sample:appendSlice": "追加切片",
          "sample:view": "查看样本",
          "csv:import": "CSV导入",
          "step:advance": "推进工序",
          "step:log": "记录步骤",
          "observation:create": "填写观察",
          "observation:view": "查看观察",
          "delivery:create": "创建交付",
          "delivery:view": "查看交付",
          "delivery:preview": "交付预览",
          "stats:view": "查看统计",
          "method:manage": "工艺管理",
          "method:view": "查看工艺",
          "audit:view": "查看审计",
          "audit:rollback": "回滚数据"
        };
        const permLabels = rolePerms.map(p => permNames[p] || p).join("、");
        roleInfoContainer.innerHTML = '<div class="role-info-tip">' +
          '<div class="role-main">' +
            '<span class="role-badge">🔐 ' + (roleInfo.name || currentRole) + '</span>' +
            '<span class="role-desc">' + (roleInfo.desc || "") + '</span>' +
          '</div>' +
          '<div class="role-perms">权限：' + permLabels + '</div>' +
        '</div>';
      }

      const canCreateSample = roleHasPerm(PERMISSIONS.SAMPLE_CREATE);
      const canAppendSlice = roleHasPerm(PERMISSIONS.SAMPLE_APPEND_SLICE);
      const canCsvImport = roleHasPerm(PERMISSIONS.CSV_IMPORT);
      const canViewSamples = roleHasPerm(PERMISSIONS.SAMPLE_VIEW);
      const canStepAdvance = roleHasPerm(PERMISSIONS.STEP_ADVANCE);
      const canStepLog = roleHasPerm(PERMISSIONS.STEP_LOG);
      const canObsCreate = roleHasPerm(PERMISSIONS.OBSERVATION_CREATE);
      const canDeliveryCreate = roleHasPerm(PERMISSIONS.DELIVERY_CREATE);
      const canDeliveryView = roleHasPerm(PERMISSIONS.DELIVERY_VIEW);
      const canStatsView = roleHasPerm(PERMISSIONS.STATS_VIEW);
      const canMethodManage = roleHasPerm(PERMISSIONS.METHOD_MANAGE);
      const canAuditView = roleHasPerm(PERMISSIONS.AUDIT_VIEW);
      const canAuditRollback = roleHasPerm(PERMISSIONS.AUDIT_ROLLBACK);

      if (sampleForm) sampleForm.style.display = (canCreateSample || canAppendSlice || canCsvImport) ? "" : "none";
      if (formEl) formEl.style.display = canCreateSample ? "" : "none";
      if (importTabs) {
        if (!canCsvImport && !canCreateSample) {
          importTabs.style.display = "none";
        } else {
          importTabs.style.display = "";
          const manualTab = importTabs.querySelector('[data-import-tab="manual"]');
          const csvTab = importTabs.querySelector('[data-import-tab="csv"]');
          if (manualTab) manualTab.style.display = canCreateSample ? "" : "none";
          if (csvTab) csvTab.style.display = canCsvImport ? "" : "none";
        }
      }
      if (csvImportEl) csvImportEl.style.display = canCsvImport ? "" : "none";
      if (viewSamplesArea) viewSamplesArea.style.display = canViewSamples ? "" : "none";
      if (methodConfigBtn) methodConfigBtn.style.display = canMethodManage ? "" : "none";

      batchAppendBtns.forEach(btn => btn.style.display = canAppendSlice ? "" : "none");
      deliverBtns.forEach(btn => btn.style.display = canDeliveryCreate ? "" : "none");
      obsBtns.forEach(btn => btn.style.display = canObsCreate ? "" : "none");
      logBtns.forEach(btn => btn.style.display = (canStepLog || canStepAdvance || canObsCreate) ? "" : "none");
      stepSelects.forEach(sel => sel.style.display = (canStepLog || canStepAdvance || canObsCreate) ? "" : "none");
      noteInputs.forEach(input => input.style.display = (canStepLog || canStepAdvance || canObsCreate) ? "" : "none");
      workbenchAdvanceBtns.forEach(btn => btn.style.display = canStepAdvance ? "" : "none");
      workbenchLogBtns.forEach(btn => btn.style.display = (canStepLog || canStepAdvance || canObsCreate) ? "" : "none");
      workbenchObsBtns.forEach(btn => btn.style.display = canObsCreate ? "" : "none");
      methodActions.forEach(btn => btn.style.display = canMethodManage ? "" : "none");
      if (methodAddBtn) methodAddBtn.style.display = canMethodManage ? "" : "none";

      if (viewTabs) {
        const tabs = viewTabs.querySelectorAll(".view-tab");
        tabs.forEach(tab => {
          const view = tab.dataset.view;
          let visible = true;
          if (view === "deliveries") visible = canDeliveryView;
          if (view === "stats") visible = canStatsView;
          if (view === "audit") visible = canAuditView;
          if (view === "cards" || view === "workbench") visible = canViewSamples;
          tab.style.display = visible ? "" : "none";
        });
      }
    }

    function resolveDefaultView() {
      if (!currentRole) return "cards";
      const canViewSamples = roleHasPerm(PERMISSIONS.SAMPLE_VIEW);
      const canDeliveryView = roleHasPerm(PERMISSIONS.DELIVERY_VIEW);
      const canStatsView = roleHasPerm(PERMISSIONS.STATS_VIEW);
      const canAuditView = roleHasPerm(PERMISSIONS.AUDIT_VIEW);

      if (activeView === "deliveries" && canDeliveryView) return "deliveries";
      if (activeView === "stats" && canStatsView) return "stats";
      if (activeView === "audit" && canAuditView) return "audit";
      if ((activeView === "cards" || activeView === "workbench") && canViewSamples) return activeView;

      if (canViewSamples) return "cards";
      if (canDeliveryView) return "deliveries";
      if (canStatsView) return "stats";
      if (canAuditView) return "audit";
      return "cards";
    }

    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const resultCountEl = document.querySelector("#result-count");
    const workbenchEl = document.querySelector("#workbench");
    const workbenchCountEl = document.querySelector("#workbench-count");
    const createSliceRowsEl = document.querySelector("#create-slice-rows");
    const createAlertEl = document.querySelector("#create-alert");
    const modalRoot = document.querySelector("#modal-root");
    const deliveriesEl = document.querySelector("#deliveries");
    const deliveriesCountEl = document.querySelector("#deliveries-count");
    const viewSamplesArea = document.querySelector("#view-samples-area");
    const auditTimelineEl = document.querySelector("#audit-timeline");
    const auditCountEl = document.querySelector("#audit-count");
    const auditStatsEl = document.querySelector("#audit-stats");
    let samples = [];
    let deliveries = [];
    let methodDict = [];
    let methodDictLoaded = false;
    let workbenchError = null;
    let activeView = "cards";
    let auditLog = [];
    let auditTotal = 0;
    const auditFilterFields = ["sample", "action", "operator"];
    const filterFields = ["project", "borehole", "corebox", "owner", "status", "delivery"];
    const deliveryFilterFields = ["project", "unit", "person"];

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function createSliceRow(initialId = "", initialMethod = "") {
      const row = document.createElement("div");
      row.className = "slice-row";
      const activeMethods = methodDict.filter(m => m.enabled);
      const methodInDict = activeMethods.some(m => m.name === initialMethod);
      const useCustom = initialMethod !== "" && !methodInDict;
      const selectOptions = '<option value="">-- 选择染色方法 --</option>' +
        activeMethods.map(m => '<option value="' + escapeHtml(m.name) + '"' + (m.name === initialMethod && !useCustom ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>').join("") +
        '<option value="__custom__"' + (useCustom ? ' selected' : '') + '>✏ 自定义输入...</option>';
      row.innerHTML = '<input placeholder="切片编号，如 SL-001-A" value="' + escapeHtml(initialId) + '" data-slice-id>' +
        '<div class="slice-method-select-wrap" data-method-wrap>' +
          (useCustom
            ? '<input placeholder="自定义染色方法" value="' + escapeHtml(initialMethod) + '" data-slice-method>'
            : '<select data-slice-method>' + selectOptions + '</select>') +
          '<button type="button" class="slice-method-custom-toggle" data-toggle-method title="切换自定义/选择">↔</button>' +
        '</div>' +
        '<button type="button" class="secondary row-btn" data-remove-row title="删除此行">×</button>';
      const methodWrap = row.querySelector("[data-method-wrap]");
      const toggleBtn = row.querySelector("[data-toggle-method]");
      function rebuildMethodWidget(currentValue, forceCustom) {
        const shouldUseCustom = forceCustom || (currentValue === "__custom__");
        const newOptions = '<option value="">-- 选择染色方法 --</option>' +
          methodDict.filter(m => m.enabled).map(m => '<option value="' + escapeHtml(m.name) + '"' + (m.name === currentValue && !shouldUseCustom ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>').join("") +
          '<option value="__custom__"' + (shouldUseCustom ? ' selected' : '') + '>✏ 自定义输入...</option>';
        methodWrap.innerHTML = shouldUseCustom
          ? '<input placeholder="自定义染色方法" value="' + escapeHtml(shouldUseCustom && currentValue !== "__custom__" ? currentValue : "") + '" data-slice-method>' +
            '<button type="button" class="slice-method-custom-toggle" data-toggle-method title="切换回工艺选择">↔</button>'
          : '<select data-slice-method>' + newOptions + '</select>' +
            '<button type="button" class="slice-method-custom-toggle" data-toggle-method title="切换自定义/选择">↔</button>';
        bindMethodWidgetEvents();
      }
      function bindMethodWidgetEvents() {
        const sel = methodWrap.querySelector("select[data-slice-method]");
        const inp = methodWrap.querySelector("input[data-slice-method]");
        const toggle = methodWrap.querySelector("[data-toggle-method]");
        if (sel) {
          sel.onchange = () => {
            if (sel.value === "__custom__") {
              rebuildMethodWidget("", true);
            }
          };
        }
        if (toggle) {
          toggle.onclick = () => {
            const currSel = methodWrap.querySelector("select[data-slice-method]");
            const currInp = methodWrap.querySelector("input[data-slice-method]");
            if (currSel) {
              rebuildMethodWidget("", true);
            } else if (currInp) {
              rebuildMethodWidget(currInp.value, false);
            }
          };
        }
      }
      bindMethodWidgetEvents();
      row.querySelector("[data-remove-row]").onclick = () => {
        if (row.parentElement && row.parentElement.children.length > 1) row.remove();
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
      const headers = (options && options.headers) ? { ...options.headers } : {};
      headers["Content-Type"] = "application/json";
      if (currentRole) {
        headers["X-Role"] = currentRole;
      }
      const finalOptions = options ? { ...options, headers } : { headers };
      const res = await fetch(path, finalOptions);
      const data = await res.json();
      if (!res.ok) {
        const errMsg = data.error ? (typeof data.error === "object" ? JSON.stringify(data.error) : data.error) : "请求失败";
        throw new Error(errMsg);
      }
      return data;
    }
    function formatObsDate(isoStr) {
      try {
        const d = new Date(isoStr);
        const pad = n => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
      } catch { return isoStr; }
    }

    function switchView(view) {
      if (!currentRole) return;
      activeView = view;
      document.querySelectorAll(".view-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.view === view);
      });
      document.querySelectorAll(".view-content").forEach(content => {
        content.classList.remove("active");
      });
      const targetEl = document.querySelector("#view-" + view);
      if (targetEl) targetEl.classList.add("active");
      if (view === "deliveries") {
        renderDeliveries();
      } else if (view === "stats") {
        loadAndRenderStats();
      } else if (view === "audit") {
        loadAndRenderAudit();
      } else if (view === "workbench") {
        renderWorkbench();
      } else {
        render();
      }
    }

    function getAllSlicesWithSample(filteredSamples) {
      const allSlices = [];
      filteredSamples.forEach(sample => {
        if (!sample || !Array.isArray(sample.slices)) return;
        sample.slices.forEach(slice => {
          allSlices.push({
            sample,
            slice
          });
        });
      });
      return allSlices;
    }

    function groupSlicesByStep(allSlices) {
      const groups = {};
      steps.forEach(step => {
        groups[step] = [];
      });
      allSlices.forEach(item => {
        const status = item.slice && item.slice.status ? item.slice.status : steps[0];
        if (groups[status]) {
          groups[status].push(item);
        } else {
          groups[steps[0]].push(item);
        }
      });
      return groups;
    }

    function getNextStep(currentStep) {
      const idx = steps.indexOf(currentStep);
      if (idx >= 0 && idx < steps.length - 1) {
        return steps[idx + 1];
      }
      return null;
    }

    function renderWorkbench() {
      try {
        workbenchError = null;
        const filters = getFilters();
        const filtered = applyFilters(samples, filters);
        const allSlices = getAllSlicesWithSample(filtered);
        const groups = groupSlicesByStep(allSlices);
        const totalSlices = allSlices.length;

        workbenchCountEl.textContent = totalSlices ? "工作台：共 " + totalSlices + " 个切片任务" : "没有符合条件的切片任务";

        if (!samples.length) {
          workbenchEl.innerHTML = '<div class="workbench-error">数据加载中，请稍后...</div>';
          return;
        }

        workbenchEl.innerHTML = steps.map((step, index) => {
          const stepSlices = groups[step] || [];
          const cardsHtml = stepSlices.length ? stepSlices.map(item => {
            const sample = item.sample || {};
            const slice = item.slice || {};
            const sampleId = sample.id || "";
            const sliceId = slice.id || "";
            const method = slice.method || "";
            const project = sample.project || "";
            const borehole = sample.borehole || "";
            const coreBox = sample.coreBox || "";
            const depth = sample.depth || "";
            const owner = sample.owner || "";
            const lastLog = slice.logs && slice.logs.length ? slice.logs[slice.logs.length - 1] : null;
            const lastNote = lastLog && lastLog.note ? lastLog.note : "";
            const nextStep = getNextStep(step);
            const canObserve = slice.status === "观察";

            return '<div class="workbench-card" data-workbench-card="' + sampleId + '|' + sliceId + '">' +
              '<div class="workbench-card-id">' + sliceId + '</div>' +
              '<div class="workbench-card-meta">' + method + '</div>' +
              '<div class="workbench-card-meta">' + borehole + ' · ' + coreBox + ' · ' + depth + '</div>' +
              '<div class="workbench-card-project">' + project + ' · ' + owner + '</div>' +
              (lastNote ? '<div class="workbench-card-meta" style="margin-top:4px;color:var(--stone);font-style:italic;">' + lastNote + '</div>' : '') +
              '<div class="workbench-card-actions" style="display:none;" data-workbench-actions="' + sampleId + '|' + sliceId + '">' +
                '<textarea data-workbench-note="' + sampleId + '|' + sliceId + '" placeholder="步骤备注..."></textarea>' +
                '<div class="row">' +
                  '<select data-workbench-step="' + sampleId + '|' + sliceId + '">' +
                    steps.map(s => '<option value="' + s + '"' + (s === step ? ' selected' : '') + '>' + s + '</option>').join("") +
                  '</select>' +
                  (nextStep ? '<button type="button" data-workbench-advance="' + sampleId + '|' + sliceId + '">推进到 ' + nextStep + '</button>' : '') +
                '</div>' +
                '<div class="row">' +
                  '<button type="button" class="secondary" data-workbench-log="' + sampleId + '|' + sliceId + '">记录备注</button>' +
                  (canObserve ? '<button type="button" class="secondary" data-workbench-obs="' + sampleId + '|' + sliceId + '">📝 观察结果</button>' : '') +
                '</div>' +
              '</div>' +
            '</div>';
          }).join("") : '<div class="workbench-empty">暂无 ' + step + ' 任务</div>';

          return '<div class="workbench-column">' +
            '<div class="workbench-column-header">' +
              '<h3><span class="step-indicator">' + (index + 1) + '</span>' + step + '</h3>' +
              '<span class="workbench-column-count">' + stepSlices.length + '</span>' +
            '</div>' +
            '<div class="workbench-cards">' + cardsHtml + '</div>' +
          '</div>';
        }).join("");

        bindWorkbenchEvents();
        applyRoleToUI();
      } catch (err) {
        workbenchError = err.message;
        workbenchEl.innerHTML = '<div class="workbench-error">工作台加载失败：' + err.message + '<br><button type="button" class="secondary" style="margin-top:10px;" onclick="location.reload()">重新加载</button></div>';
      }
    }

    function bindWorkbenchEvents() {
      document.querySelectorAll("[data-workbench-card]").forEach(card => {
        card.onclick = (e) => {
          if (e.target.closest("button") || e.target.closest("select") || e.target.closest("textarea")) return;
          const key = card.dataset.workbenchCard;
          const actions = document.querySelector('[data-workbench-actions="' + key + '"]');
          if (actions) {
            const isVisible = actions.style.display !== "none";
            document.querySelectorAll("[data-workbench-actions]").forEach(a => {
              if (a !== actions) a.style.display = "none";
            });
            actions.style.display = isVisible ? "none" : "flex";
            if (!isVisible) {
              const noteEl = document.querySelector('[data-workbench-note="' + key + '"]');
              if (noteEl) noteEl.focus();
            }
          }
        };
      });

      document.querySelectorAll("[data-workbench-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.workbenchStep.split("|");
        try {
          const sample = samples.find(s => s.id === sampleId);
          if (sample) {
            const slice = sample.slices.find(s => s.id === sliceId);
            if (slice) sel.value = slice.status;
          }
        } catch (_) {}
      });

      document.querySelectorAll("[data-workbench-advance]").forEach(btn => {
        btn.onclick = async () => {
          const [sampleId, sliceId] = btn.dataset.workbenchAdvance.split("|");
          try {
            const sample = samples.find(s => s.id === sampleId);
            if (!sample) return;
            const slice = sample.slices.find(s => s.id === sliceId);
            if (!slice) return;
            const nextStep = getNextStep(slice.status);
            if (!nextStep) return;
            const noteEl = document.querySelector('[data-workbench-note="' + sampleId + '|' + sliceId + '"]');
            const note = noteEl ? noteEl.value.trim() : "";
            await api('/api/samples/' + sampleId + '/slices/' + sliceId + '/logs', {
              method: 'POST',
              body: JSON.stringify({ step: nextStep, note: note || (nextStep + "步骤完成") })
            });
            await load();
          } catch (err) {
            const msg = err.message || "推进失败";
            alert(msg);
          }
        };
      });

      document.querySelectorAll("[data-workbench-log]").forEach(btn => {
        btn.onclick = async () => {
          const [sampleId, sliceId] = btn.dataset.workbenchLog.split("|");
          try {
            const stepEl = document.querySelector('[data-workbench-step="' + sampleId + '|' + sliceId + '"]');
            const noteEl = document.querySelector('[data-workbench-note="' + sampleId + '|' + sliceId + '"]');
            const step = stepEl ? stepEl.value : "";
            const note = noteEl ? noteEl.value.trim() : "";
            if (!step) {
              alert("请选择步骤");
              return;
            }
            await api('/api/samples/' + sampleId + '/slices/' + sliceId + '/logs', {
              method: 'POST',
              body: JSON.stringify({ step: step, note: note || "步骤完成" })
            });
            await load();
          } catch (err) {
            const msg = err.message || "记录失败";
            alert(msg);
          }
        };
      });

      document.querySelectorAll("[data-workbench-obs]").forEach(btn => {
        btn.onclick = () => {
          const [sampleId, sliceId] = btn.dataset.workbenchObs.split("|");
          openObservationModal(sampleId, sliceId);
        };
      });
    }

    function openObservationModal(sampleId, sliceId) {
      const sample = samples.find(s => s.id === sampleId);
      if (!sample) return;
      const slice = sample.slices.find(s => s.id === sliceId);
      if (!slice) return;
      const observations = slice.observations || [];
      const lastObs = observations.length ? observations[observations.length - 1] : null;
      const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
      const hasLegacyOnly = !observations.length && legacyObs.length > 0;
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal wide";
      let historyHtml = "";
      if (observations.length > 0) {
        historyHtml = '<div class="obs-history"><h3 style="margin:0 0 8px;font-size:14px;color:var(--stone);">历史观察记录（共 ' + observations.length + ' 条）</h3>' + observations.slice().reverse().map(obs => '<div class="obs-history-item"><div class="obs-header"><b>' + obs.id + '</b><span class="obs-date">' + formatObsDate(obs.at) + '</span></div>' + (obs.lithology ? '<div class="obs-row"><b>岩性：</b>' + obs.lithology + '</div>' : '') + (obs.minerals ? '<div class="obs-row"><b>矿物：</b>' + obs.minerals + '</div>' : '') + (obs.texture ? '<div class="obs-row"><b>结构构造：</b>' + obs.texture + '</div>' : '') + (obs.remark ? '<div class="obs-row"><b>备注：</b>' + obs.remark + '</div>' : '') + '</div>').join("") + '</div>';
      } else if (hasLegacyOnly) {
        historyHtml = '<div class="obs-history"><h3 style="margin:0 0 8px;font-size:14px;color:var(--stone);">历史观察记录</h3><div class="obs-history-item"><div class="obs-header"><b>历史记录</b></div><div class="obs-row">' + legacyObs + '</div></div></div>';
      }
      modal.innerHTML = '<h2>观察结果归档 — ' + slice.id + '</h2><div class="meta">' + sample.project + ' · ' + sample.borehole + ' · ' + sample.coreBox + ' · ' + slice.method + '</div><div style="margin-top:14px;"><label>岩性描述</label><textarea id="obs-lithology" placeholder="如：中细粒砂岩、硅化蚀变岩、灰岩等">' + (lastObs ? (lastObs.lithology || "") : "") + '</textarea></div><div><label>矿物组合</label><textarea id="obs-minerals" placeholder="如：石英70%+长石15%+黄铁矿10%+其他5%">' + (lastObs ? (lastObs.minerals || "") : "") + '</textarea></div><div><label>结构构造</label><textarea id="obs-texture" placeholder="如：他形晶粒结构，浸染状构造；晶粒结构，块状构造">' + (lastObs ? (lastObs.texture || "") : "") + '</textarea></div><div><label>备注</label><textarea id="obs-remark" placeholder="其他观察记录或补充说明">' + (lastObs ? (lastObs.remark || "") : (hasLegacyOnly ? legacyObs : "")) + '</textarea></div><div id="obs-alert" style="margin-top:10px;"></div>' + historyHtml + '<div class="modal-footer"><button type="button" class="secondary" id="obs-cancel">取消</button><button type="button" id="obs-save">保存观察记录</button></div>';
      mask.appendChild(modal);
      modalRoot.appendChild(mask);
      const obsAlert = modal.querySelector("#obs-alert");
      modal.querySelector("#obs-cancel").onclick = () => mask.remove();
      mask.onclick = e => { if (e.target === mask) mask.remove(); };
      modal.querySelector("#obs-save").onclick = async () => {
        const lithology = modal.querySelector("#obs-lithology").value.trim();
        const minerals = modal.querySelector("#obs-minerals").value.trim();
        const texture = modal.querySelector("#obs-texture").value.trim();
        const remark = modal.querySelector("#obs-remark").value.trim();
        try {
          await api('/api/samples/' + sampleId + '/slices/' + sliceId + '/observations', { method:'POST', body: JSON.stringify({ lithology, minerals, texture, remark }) });
          mask.remove();
          await load();
        } catch (err) {
          const msg = err.message;
          try {
            const parsed = JSON.parse(msg);
            if (Array.isArray(parsed)) {
              showAlert(obsAlert, parsed);
              return;
            }
          } catch (_) {}
          showAlert(obsAlert, [msg]);
        }
      };
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
      samplesEl.innerHTML = filtered.map(sample => {
        const allObservations = [];
        sample.slices.forEach(slice => {
          const obs = slice.observations && slice.observations.length ? slice.observations[slice.observations.length - 1] : null;
          const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
          if (obs || legacyObs) {
            allObservations.push({ sliceId: slice.id, obs, legacyObs });
          }
        });
        const summaryHtml = allObservations.length ? '<div class="obs-summary"><span class="label">最近观察摘要：</span>' + allObservations.map(item => {
          const parts = [];
          if (item.obs) {
            if (item.obs.lithology) parts.push(item.obs.lithology);
            if (item.obs.minerals) parts.push(item.obs.minerals);
            if (item.obs.texture) parts.push(item.obs.texture);
          } else if (item.legacyObs) {
            parts.push(item.legacyObs);
          }
          return item.sliceId + '[' + parts.join('；') + ']';
        }).join(' ') + '</div>' : '';
        const deliveryHistory = deliveries.filter(d => d.sampleId === sample.id);
        const deliveryHistoryHtml = deliveryHistory.length ? '<div class="meta" style="margin-top:6px;"><b style="color:var(--accent);">历史交付（'+deliveryHistory.length+'）：</b>' + deliveryHistory.map(d => d.id + '（' + formatObsDate(d.deliveredAt) + '）').join('、') + '</div>' : '';
        return '<article class="card"><h3>'+sample.project+'</h3><div class="sample-id">'+sample.id+'</div><div><span class="pill">'+sample.status+'</span> <span class="pill">'+sample.delivery+'</span></div><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div>' + summaryHtml + deliveryHistoryHtml + '<button type="button" class="secondary" data-batch-append="'+sample.id+'">批量追加切片</button>'+sample.slices.map(slice => {
          const observations = slice.observations || [];
          const lastObs = observations.length ? observations[observations.length - 1] : null;
          const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
          let obsSummaryHtml = "";
          if (lastObs) {
            obsSummaryHtml = '<div class="obs-summary" style="margin-top:10px;"><div class="obs-header"><span class="label">最近观察（' + formatObsDate(lastObs.at) + '）</span>' + (observations.length > 1 ? '<span class="obs-date">共 '+observations.length+' 条</span>' : '') + '</div>' + (lastObs.lithology ? '<div class="obs-row"><b>岩性：</b>' + lastObs.lithology + '</div>' : '') + (lastObs.minerals ? '<div class="obs-row"><b>矿物：</b>' + lastObs.minerals + '</div>' : '') + (lastObs.texture ? '<div class="obs-row"><b>结构构造：</b>' + lastObs.texture + '</div>' : '') + (lastObs.remark ? '<div class="obs-row"><b>备注：</b>' + lastObs.remark + '</div>' : '') + '</div>';
          } else if (legacyObs) {
            obsSummaryHtml = '<div class="obs-summary" style="margin-top:10px;"><div class="obs-header"><span class="label">观察结果</span></div><div class="obs-row">' + legacyObs + '</div></div>';
          }
          const obsBtn = slice.status === '观察' ? '<button type="button" class="secondary obs-btn" data-observation="'+sample.id+'|'+slice.id+'">📝 填写观察结果</button>' : '';
          return '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button>' + obsBtn + obsSummaryHtml + '<div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>';
        }).join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>';
      }).join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-batch-append]").forEach(btn => btn.onclick = () => {
        openBatchAppendModal(btn.dataset.batchAppend);
      });
      document.querySelectorAll("[data-observation]").forEach(btn => btn.onclick = () => {
        const [sampleId, sliceId] = btn.dataset.observation.split("|");
        openObservationModal(sampleId, sliceId);
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = () => openDeliveryConfirmModal(btn.dataset.deliver));
      applyRoleToUI();
    }
    function getDeliveryFilters() {
      const f = {};
      deliveryFilterFields.forEach(field => {
        const el = document.querySelector("#delivery-filter-" + (field === "unit" ? "unit" : field === "person" ? "person" : field));
        if (el && el.value) {
          if (field === "unit") f.receivingUnit = el.value;
          else if (field === "person") f.deliveredBy = el.value;
          else f[field === "project" ? "project" : field] = el.value;
        }
      });
      return f;
    }
    function applyDeliveryFilters(list, filters) {
      return list.filter(item => {
        for (const key in filters) {
          if (filters[key]) {
            if (key === "project") {
              if (!item.sampleSnapshot || item.sampleSnapshot.project !== filters[key]) return false;
            } else if (item[key] !== filters[key]) return false;
          }
        }
        return true;
      });
    }
    function populateDeliveryFilterOptions() {
      const projects = [...new Set(deliveries.map(d => d.sampleSnapshot && d.sampleSnapshot.project).filter(Boolean))].sort();
      const units = [...new Set(deliveries.map(d => d.receivingUnit).filter(Boolean))].sort();
      const persons = [...new Set(deliveries.map(d => d.deliveredBy).filter(Boolean))].sort();
      const projectSel = document.querySelector("#delivery-filter-project");
      if (projectSel) {
        const current = projectSel.value;
        projectSel.innerHTML = '<option value="">全部项目</option>' + projects.map(v => '<option value="' + v + '">' + v + '</option>').join("");
        projectSel.value = current;
      }
      const unitSel = document.querySelector("#delivery-filter-unit");
      if (unitSel) {
        const current = unitSel.value;
        unitSel.innerHTML = '<option value="">全部单位</option>' + units.map(v => '<option value="' + v + '">' + v + '</option>').join("");
        unitSel.value = current;
      }
      const personSel = document.querySelector("#delivery-filter-person");
      if (personSel) {
        const current = personSel.value;
        personSel.innerHTML = '<option value="">全部交付人</option>' + persons.map(v => '<option value="' + v + '">' + v + '</option>').join("");
        personSel.value = current;
      }
    }
    function onDeliveryFilterChange() {
      renderDeliveries();
    }

    async function openDeliveryConfirmModal(sampleId) {
      const sample = samples.find(s => s.id === sampleId);
      if (!sample) return;
      let previewData = null;
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal delivery-modal";
      modal.innerHTML = '<h2>交付确认 — ' + sample.id + '</h2><div style="margin-top:16px;text-align:center;color:var(--muted);padding:20px;">正在加载交付预览数据...</div>';
      mask.appendChild(modal);
      modalRoot.appendChild(mask);
      mask.onclick = e => { if (e.target === mask) mask.remove(); };
      try {
        previewData = await api('/api/samples/' + sampleId + '/delivery-preview');
        renderDeliveryConfirmContent(modal, mask, previewData, sampleId);
      } catch (err) {
        modal.innerHTML = '<h2>交付确认 — ' + sample.id + '</h2><div class="alert" style="margin-top:16px;">加载失败：' + (err.message || '未知错误') + '</div><div class="modal-footer"><button type="button" class="secondary" id="dlg-cancel">关闭</button></div>';
        modal.querySelector("#dlg-cancel").onclick = () => mask.remove();
      }
    }

    function renderDeliveryConfirmContent(modal, mask, data, sampleId) {
      const s = data.sample;
      const slices = data.slices;
      const allObserved = data.allObserved;

      const basicInfoHtml = '<div class="delivery-section"><h3>样本基础信息</h3><div class="delivery-basic-info"><div><b>样本编号：</b>' + s.id + '</div><div><b>所属项目：</b>' + s.project + '</div><div><b>钻孔编号：</b>' + s.borehole + '</div><div><b>岩芯箱号：</b>' + s.coreBox + '</div><div><b>取样深度：</b>' + s.depth + '</div><div><b>负责人：</b>' + s.owner + '</div><div><b>样本状态：</b>' + s.status + '</div><div><b>交付状态：</b>' + s.delivery + '</div></div></div>';

      const sliceTableHtml = '<div class="delivery-section"><h3>全部切片状态（' + data.observedCount + '/' + data.sliceCount + ' 已完成观察）</h3><table class="slice-status-table"><thead><tr><th>切片编号</th><th>染色方法</th><th>当前步骤</th><th>观察结果</th><th>最近日志</th></tr></thead><tbody>' + slices.map(slice => {
        const isComplete = slice.status === "观察" && slice.hasObservation;
        const statusClass = isComplete ? "status-ok" : "status-warn";
        let statusText = "";
        if (slice.status !== "观察") {
          statusText = '<span class="status-warn">未到观察步骤（当前：' + slice.status + '）</span>';
        } else if (!slice.hasObservation) {
          statusText = '<span class="status-warn">已到观察步骤但未填写结果</span>';
        } else {
          statusText = '<span class="status-ok">✓ 已完成</span>';
        }
        const obsSummary = slice.observationSummary ? slice.observationSummary : '<span class="meta">—</span>';
        const lastLogText = slice.lastLog ? (slice.lastLog.step + "：" + (slice.lastLog.note || "无备注")) : '<span class="meta">—</span>';
        return '<tr><td><b>' + slice.id + '</b></td><td>' + slice.method + '</td><td><span class="' + statusClass + '">' + slice.status + '</span></td><td>' + statusText + '<div style="font-size:11px;color:var(--muted);margin-top:3px;">' + obsSummary + '</div></td><td style="font-size:12px;">' + lastLogText + '</td></tr>';
      }).join("") + '</tbody></table></div>';

      let missingHtml = "";
      if (!allObserved) {
        const missingReasons = slices.filter(s => !(s.status === "观察" && s.hasObservation)).map(s => {
          if (s.status !== "观察") {
            return s.id + ' — 当前步骤为「' + s.status + '」，尚未进入观察步骤';
          } else {
            return s.id + ' — 已进入观察步骤但未填写观察结果';
          }
        });
        missingHtml = '<div class="delivery-section"><div class="missing-list"><b style="color:var(--danger);">⚠ 观察结果缺失，无法生成交付记录</b><ul>' + missingReasons.map(r => '<li>' + r + '</li>').join("") + '</ul></div></div>';
      } else {
        missingHtml = '<div class="delivery-section"><div class="complete-info">✓ 全部切片已完成观察，可以生成交付记录</div></div>';
      }

      const logsHtml = '<div class="delivery-section"><h3>步骤日志摘要（最近 ' + data.logsSummary.length + ' 条 / 共 ' + data.totalLogs + ' 条）</h3><div class="logs-summary">' + data.logsSummary.map(log => {
        return '<div class="logs-summary-item"><span class="log-time">' + formatObsDate(log.at) + '</span><span class="log-slice">' + log.sliceId + '</span><span class="log-step">' + log.step + '</span>' + (log.note || '<span class="meta">无备注</span>') + '</div>';
      }).join("") + '</div></div>';

      const formHtml = allObserved ? '<div class="delivery-section"><h3>交付信息录入</h3><div class="delivery-form-row"><div><label>交付人 *</label><input id="dlv-deliveredBy" placeholder="请输入交付人姓名"></div><div><label>接收单位 *</label><input id="dlv-receivingUnit" placeholder="请输入接收单位名称"></div><div class="full"><label>备注</label><textarea id="dlv-remark" placeholder="请输入备注信息（选填）"></textarea></div></div><div id="dlv-alert" style="margin-top:10px;"></div></div>' : "";

      const footerHtml = '<div class="modal-footer"><button type="button" class="secondary" id="dlv-cancel">取消</button>' + (allObserved ? '<button type="button" id="dlv-confirm">生成交付记录</button>' : "") + '</div>';

      modal.innerHTML = '<h2>交付确认 — ' + s.id + '</h2>' + basicInfoHtml + sliceTableHtml + missingHtml + logsHtml + formHtml + footerHtml;

      modal.querySelector("#dlv-cancel").onclick = () => mask.remove();

      if (allObserved) {
        const sampleOwner = s.owner || "";
        if (sampleOwner) {
          modal.querySelector("#dlv-deliveredBy").value = sampleOwner;
        }
        modal.querySelector("#dlv-confirm").onclick = async () => {
          const deliveredBy = modal.querySelector("#dlv-deliveredBy").value.trim();
          const receivingUnit = modal.querySelector("#dlv-receivingUnit").value.trim();
          const remark = modal.querySelector("#dlv-remark").value.trim();
          const alertEl = modal.querySelector("#dlv-alert");
          if (!deliveredBy) {
            showAlert(alertEl, ["请填写交付人"]);
            return;
          }
          if (!receivingUnit) {
            showAlert(alertEl, ["请填写接收单位"]);
            return;
          }
          try {
            await api('/api/samples/' + sampleId + '/deliveries', {
              method: 'POST',
              body: JSON.stringify({ deliveredBy, receivingUnit, remark })
            });
            mask.remove();
            await load();
          } catch (err) {
            const msg = err.message;
            try {
              const parsed = JSON.parse(msg);
              if (Array.isArray(parsed)) {
                showAlert(alertEl, parsed);
                return;
              }
            } catch (_) {}
            showAlert(alertEl, [msg]);
          }
        };
      }
    }

    function renderDeliveries() {
      populateDeliveryFilterOptions();
      const filters = getDeliveryFilters();
      const filtered = applyDeliveryFilters(deliveries, filters);
      deliveriesCountEl.textContent = filtered.length ? "筛选结果：共 " + filtered.length + " 个交付包" : "没有符合条件的交付包";
      if (!filtered.length) {
        deliveriesEl.innerHTML = '<div class="delivery-empty">还没有交付包记录。完成样本观察后，在「样本卡片」中点击「标记交付」按钮生成交付记录。</div>';
        return;
      }
      deliveriesEl.innerHTML = filtered.map(d => {
        const ss = d.sampleSnapshot || {};
        return '<div class="delivery-card"><div class="delivery-card-header"><div class="delivery-card-id">' + d.id + '</div><div class="delivery-card-time">' + formatObsDate(d.deliveredAt) + '</div></div><div class="delivery-card-info"><div><b>样本编号：</b>' + (ss.id || "-") + '</div><div><b>所属项目：</b>' + (ss.project || "-") + '</div><div><b>钻孔/箱号：</b>' + (ss.borehole || "-") + ' / ' + (ss.coreBox || "-") + '</div><div><b>取样深度：</b>' + (ss.depth || "-") + '</div><div><b>交付人：</b>' + d.deliveredBy + '</div><div><b>接收单位：</b>' + d.receivingUnit + '</div></div><div class="delivery-card-slices"><b>包含切片（' + d.slices.length + ' 个）：</b>' + d.slices.map(s => '<span class="slice-item">' + s.id + '（' + s.method + '）</span>').join("") + '</div>' + (d.remark ? '<div class="delivery-card-remark"><b>备注：</b>' + d.remark + '</div>' : "") + '</div>';
      }).join("");
    }

    async function loadMethodDict() {
      try {
        methodDict = await api("/api/methods");
        methodDictLoaded = true;
      } catch (err) {
        methodDict = [];
        methodDictLoaded = false;
        console.error("Failed to load method dict:", err);
      }
    }

    function openMethodConfigModal() {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal method-modal";
      renderMethodConfigContent(modal, mask);
      mask.appendChild(modal);
      modalRoot.appendChild(mask);
      mask.onclick = e => { if (e.target === mask) mask.remove(); };
    }

    async function renderMethodConfigContent(modal, mask) {
      modal.innerHTML = '<h2>染色方法 / 制片工艺配置</h2><div style="margin-top:10px;text-align:center;color:var(--muted);padding:20px;">加载中...</div>';
      try {
        const methods = await api("/api/methods");
        const enabledCount = methods.filter(m => m.enabled).length;
        const totalUsage = methods.reduce((s, m) => s + (m.usageCount || 0), 0);
        const listHtml = methods.length
          ? '<div class="method-list">' + methods.map(m => {
              const badgeClass = m.enabled ? "enabled" : "disabled";
              const badgeText = m.enabled ? "启用中" : "已禁用";
              const itemClass = m.enabled ? "" : "disabled";
              return '<div class="method-item ' + itemClass + '" data-method-id="' + escapeHtml(m.id) + '">' +
                '<div class="method-item-main">' +
                  '<div class="method-name-row">' +
                    '<span class="method-name">' + escapeHtml(m.name) + '</span>' +
                    '<span class="method-badge ' + badgeClass + '">' + badgeText + '</span>' +
                  '</div>' +
                  (m.description ? '<div class="method-desc">' + escapeHtml(m.description) + '</div>' : '') +
                  '<div class="method-meta">' +
                    '使用次数：<b>' + (m.usageCount || 0) + '</b> 次' +
                    (m.createdAt ? ' · 创建于 ' + formatObsDate(m.createdAt) : '') +
                    ' · 排序优先级：' + (m.sortOrder || 0) +
                  '</div>' +
                '</div>' +
                '<div class="method-actions">' +
                  '<button type="button" class="secondary" data-method-edit="' + escapeHtml(m.id) + '">编辑</button>' +
                  '<button type="button" data-method-toggle="' + escapeHtml(m.id) + '">' + (m.enabled ? '禁用' : '启用') + '</button>' +
                '</div>' +
              '</div>';
            }).join("") + '</div>'
          : '<div class="empty" style="margin-top:12px;">还没有配置任何工艺</div>';

        modal.innerHTML =
          '<h2>染色方法 / 制片工艺配置</h2>' +
          '<div class="meta" style="margin-bottom:4px;">统一维护制片工艺字典，新增切片时优先从字典中选择</div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px;">' +
            '<div class="csv-stat valid"><strong>' + enabledCount + '</strong><span>启用中工艺</span></div>' +
            '<div class="csv-stat"><strong>' + (methods.length - enabledCount) + '</strong><span>已禁用工艺</span></div>' +
            '<div class="csv-stat"><strong>' + totalUsage + '</strong><span>累计使用次数</span></div>' +
          '</div>' +
          listHtml +
          '<div id="method-alert" style="margin-top:12px;"></div>' +
          '<div class="modal-footer">' +
            '<button type="button" class="secondary" id="method-close-btn">关闭</button>' +
            '<button type="button" id="method-add-btn">+ 新增工艺</button>' +
          '</div>';

        modal.querySelector("#method-close-btn").onclick = () => {
          mask.remove();
          refreshSliceRowMethods();
        };
        modal.querySelector("#method-add-btn").onclick = () => {
          openMethodFormModal(modal, mask, null);
        };
        modal.querySelectorAll("[data-method-edit]").forEach(btn => {
          btn.onclick = () => {
            const id = btn.dataset.methodEdit;
            const method = methods.find(m => m.id === id);
            if (method) openMethodFormModal(modal, mask, method);
          };
        });
        modal.querySelectorAll("[data-method-toggle]").forEach(btn => {
          btn.onclick = async () => {
            const id = btn.dataset.methodToggle;
            try {
              const method = methods.find(m => m.id === id);
              if (!method) return;
              const action = method.enabled ? "禁用" : "启用";
              const usage = method.usageCount || 0;
              if (method.enabled && usage > 0) {
                if (!confirm('确认要禁用工艺「' + method.name + '」吗？\\n该工艺已被使用 ' + usage + ' 次，禁用后不会影响历史切片记录，但在新增切片时将不再显示此选项。')) {
                  return;
                }
              }
              await api("/api/methods/" + id + "/toggle", { method: "PATCH" });
              await loadMethodDict();
              renderMethodConfigContent(modal, mask);
            } catch (err) {
              const alertEl = modal.querySelector("#method-alert");
              showAlert(alertEl, [err.message || "操作失败"]);
            }
          };
        });
      } catch (err) {
        modal.innerHTML = '<h2>染色方法 / 制片工艺配置</h2><div class="alert" style="margin-top:16px;">加载失败：' + (err.message || '未知错误') + '</div><div class="modal-footer"><button type="button" class="secondary" id="dlg-cancel">关闭</button></div>';
        modal.querySelector("#dlg-cancel").onclick = () => mask.remove();
      }
    }

    function openMethodFormModal(parentModal, mask, editingMethod) {
      const isEdit = editingMethod !== null;
      const formMask = document.createElement("div");
      formMask.className = "modal-mask";
      const formModal = document.createElement("div");
      formModal.className = "modal";
      const title = isEdit ? "编辑工艺" : "新增工艺";
      const oldName = isEdit ? editingMethod.name : "";
      const hasUsage = isEdit && (editingMethod.usageCount || 0) > 0;
      formModal.innerHTML =
        '<h2>' + title + '</h2>' +
        '<div class="method-form-grid" style="margin-top:12px;">' +
          '<div class="full">' +
            '<label>工艺名称 *</label>' +
            '<input id="mf-name" placeholder="如：普通薄片、茜素红染色" value="' + escapeHtml(isEdit ? editingMethod.name : "") + '">' +
          '</div>' +
          '<div class="full">' +
            '<label>工艺说明</label>' +
            '<textarea id="mf-desc" placeholder="简要描述该工艺的用途和特点">' + escapeHtml(isEdit ? (editingMethod.description || "") : "") + '</textarea>' +
          '</div>' +
          '<div>' +
            '<label>排序优先级（数字越小越靠前）</label>' +
            '<input id="mf-sort" type="number" value="' + (isEdit ? (editingMethod.sortOrder || 0) : 0) + '">' +
          '</div>' +
        '</div>' +
        (isEdit && hasUsage ?
          '<div style="margin-top:12px;">' +
            '<label style="display:flex;align-items:center;gap:6px;">' +
              '<input type="checkbox" id="mf-update-existing">' +
              '<span>同时更新历史切片中的工艺名称（共 ' + editingMethod.usageCount + ' 条记录）</span>' +
            '</label>' +
            '<div class="meta" style="font-size:12px;margin-top:4px;color:var(--stone);">不勾选则仅修改字典，历史切片仍显示原名称</div>' +
          '</div>' : '') +
        (isEdit ?
          '<div style="margin-top:12px;"><div class="method-badge ' + (editingMethod.enabled ? 'enabled' : 'disabled') + '">' +
            (editingMethod.enabled ? '● 当前状态：启用中' : '○ 当前状态：已禁用') +
          '</div></div>' : '') +
        '<div id="mf-alert" style="margin-top:12px;"></div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="secondary" id="mf-cancel">取消</button>' +
          '<button type="button" id="mf-save">' + (isEdit ? '保存修改' : '新增工艺') + '</button>' +
        '</div>';
      formMask.appendChild(formModal);
      modalRoot.appendChild(formMask);
      formMask.onclick = e => { if (e.target === formMask) formMask.remove(); };
      formModal.querySelector("#mf-cancel").onclick = () => formMask.remove();
      formModal.querySelector("#mf-save").onclick = async () => {
        const name = formModal.querySelector("#mf-name").value.trim();
        const description = formModal.querySelector("#mf-desc").value.trim();
        const sortOrder = Number(formModal.querySelector("#mf-sort").value) || 0;
        const alertEl = formModal.querySelector("#mf-alert");
        if (!name) {
          showAlert(alertEl, ["请填写工艺名称"]);
          return;
        }
        try {
          if (isEdit) {
            const updateExisting = hasUsage ? !!formModal.querySelector("#mf-update-existing").checked : false;
            if (name !== oldName && updateExisting) {
              if (!confirm('确认要将所有使用「' + oldName + '」的切片记录更新为「' + name + '」吗？\\n此操作将修改 ' + editingMethod.usageCount + ' 条历史记录。')) {
                return;
              }
            }
            await api("/api/methods/" + editingMethod.id, {
              method: "PUT",
              body: JSON.stringify({ name, description, sortOrder, updateExisting })
            });
          } else {
            await api("/api/methods", {
              method: "POST",
              body: JSON.stringify({ name, description, sortOrder })
            });
          }
          await loadMethodDict();
          formMask.remove();
          renderMethodConfigContent(parentModal, mask);
        } catch (err) {
          const msg = err.message;
          try {
            const parsed = JSON.parse(msg);
            if (Array.isArray(parsed)) {
              showAlert(alertEl, parsed);
              return;
            }
          } catch (_) {}
          showAlert(alertEl, [msg]);
        }
      };
    }

    function refreshSliceRowMethods() {
      if (!createSliceRowsEl) return;
      const rows = createSliceRowsEl.querySelectorAll(".slice-row");
      const preserved = [];
      rows.forEach(row => {
        const idEl = row.querySelector("[data-slice-id]");
        const methodEl = row.querySelector("[data-slice-method]");
        preserved.push({
          id: idEl ? idEl.value : "",
          method: methodEl ? methodEl.value : ""
        });
      });
      initCreateSliceRows();
      preserved.forEach((p, idx) => {
        let targetRow;
        if (idx === 0) {
          targetRow = createSliceRowsEl.querySelector(".slice-row");
        } else {
          targetRow = createSliceRow(p.id, p.method);
          createSliceRowsEl.appendChild(targetRow);
        }
        if (targetRow) {
          const idEl = targetRow.querySelector("[data-slice-id]");
          if (idEl) idEl.value = p.id;
        }
      });
    }

    let statsData = null;
    const statsFilterFields = ["project", "owner"];

    function getStatsFilters() {
      const f = {};
      statsFilterFields.forEach(field => {
        const el = document.querySelector("#stats-filter-" + field);
        if (el && el.value) f[field] = el.value;
      });
      return f;
    }

    function populateStatsFilterOptions(data) {
      const projectSel = document.querySelector("#stats-filter-project");
      const ownerSel = document.querySelector("#stats-filter-owner");
      if (projectSel && data) {
        const current = projectSel.value;
        projectSel.innerHTML = '<option value="">全部项目</option>' + data.projects.map(v => '<option value="' + v + '">' + v + '</option>').join("");
        projectSel.value = current;
      }
      if (ownerSel && data) {
        const current = ownerSel.value;
        ownerSel.innerHTML = '<option value="">全部负责人</option>' + data.owners.map(v => '<option value="' + v + '">' + v + '</option>').join("");
        ownerSel.value = current;
      }
    }

    async function loadAndRenderStats() {
      const filters = getStatsFilters();
      const params = new URLSearchParams();
      if (filters.project) params.set("project", filters.project);
      if (filters.owner) params.set("owner", filters.owner);
      const queryStr = params.toString() ? "?" + params.toString() : "";
      try {
        statsData = await api("/api/stats/time-analysis" + queryStr);
        populateStatsFilterOptions(statsData);
        renderStats(statsData);
      } catch (err) {
        document.querySelector("#stats-overview").innerHTML = '<div class="empty">统计数据加载失败：' + (err.message || "未知错误") + '</div>';
      }
    }

    function formatHours(h) {
      if (h < 1) return Math.round(h * 60) + "分钟";
      if (h < 24) return h.toFixed(1) + "小时";
      return (h / 24).toFixed(1) + "天";
    }

    function renderStats(data) {
      const timings = data.sliceTimings || [];
      const sampleTimings = data.sampleTimings || [];
      const stepAvgs = data.stepAverages || [];
      const backlog = data.ownerBacklog || [];

      const totalSlices = timings.length;
      const completedSlices = timings.filter(t => t.isComplete).length;
      const validTimings = timings.filter(t => t.totalHours > 0);
      const avgTotalHours = validTimings.length > 0 ? validTimings.reduce((s, t) => s + t.totalHours, 0) / validTimings.length : 0;
      const maxTotalHours = validTimings.length > 0 ? Math.max(...validTimings.map(t => t.totalHours)) : 0;

      document.querySelector("#stats-overview").innerHTML =
        '<div class="stats-kpi"><strong>' + totalSlices + '</strong><span>切片总数</span></div>' +
        '<div class="stats-kpi"><strong>' + completedSlices + '</strong><span>已完成观察</span></div>' +
        '<div class="stats-kpi"><strong>' + formatHours(avgTotalHours) + '</strong><span>平均制片耗时</span></div>' +
        '<div class="stats-kpi"><strong>' + formatHours(maxTotalHours) + '</strong><span>最长制片耗时</span></div>';

      const sortedSampleTimings = [...sampleTimings].sort((a, b) => b.totalHours - a.totalHours);
      document.querySelector("#stats-sample-timings").innerHTML = sortedSampleTimings.length
        ? '<div class="stats-timing-scroll"><table class="stats-table"><thead><tr><th>样本编号</th><th>项目</th><th>负责人</th><th>钻孔/箱号</th><th>深度</th><th>切片数</th><th>已完成</th><th>最早日志</th><th>最近日志</th><th>制片总耗时</th><th>状态</th><th>备注</th></tr></thead><tbody>' +
          sortedSampleTimings.map(st => {
            const hasData = !!st.firstAt;
            const completePct = st.sliceCount > 0 ? Math.round(st.completedSlices / st.sliceCount * 100) : 0;
            let progressCls = "stats-progress-zero";
            if (completePct === 100) progressCls = "stats-progress-done";
            else if (completePct >= 50) progressCls = "stats-progress-mid";
            else if (completePct > 0) progressCls = "stats-progress-low";
            return '<tr>' +
              '<td><b>' + st.sampleId + '</b></td>' +
              '<td>' + st.project + '</td>' +
              '<td>' + st.owner + '</td>' +
              '<td>' + (st.borehole || '') + '/' + (st.coreBox || '') + '</td>' +
              '<td>' + (st.depth || '') + '</td>' +
              '<td class="num">' + st.sliceCount + '</td>' +
              '<td class="num"><span class="stats-backlog-cell ' + progressCls + '">' + st.completedSlices + '/' + st.sliceCount + '</span></td>' +
              '<td>' + (hasData ? formatObsDate(st.firstAt) : '<span class="meta">—</span>') + '</td>' +
              '<td>' + (hasData ? formatObsDate(st.lastAt) : '<span class="meta">—</span>') + '</td>' +
              '<td class="num">' + (hasData && st.totalHours > 0 ? (st.isComplete ? formatHours(st.totalHours) : '<span style="color:var(--danger);">' + formatHours(st.totalHours) + ' (进行中)</span>') : '<span class="meta">—</span>') + '</td>' +
              '<td><span class="pill">' + st.status + '</span></td>' +
              '<td>' + (st.note ? '<span class="meta">' + st.note + '</span>' : '') + '</td>' +
              '</tr>';
          }).join("") +
          '</tbody></table></div>'
        : '<div class="empty">暂无样本汇总数据</div>';

      const maxAvg = Math.max(...stepAvgs.map(s => s.avgHours), 1);
      document.querySelector("#stats-step-avg").innerHTML = stepAvgs.map(s => {
        const pct = (s.avgHours / maxAvg * 100).toFixed(1);
        return '<div class="stats-step-row">' +
          '<div class="stats-step-label">' + s.step + '</div>' +
          '<div class="stats-step-bar-wrap"><div class="stats-bar-wrap"><div class="stats-bar" style="width:' + pct + '%"></div></div></div>' +
          '<div class="stats-step-value">' + (s.count > 0 ? formatHours(s.avgHours) + ' <span class="meta" style="font-size:11px;">(' + s.count + '条)</span>' : '<span class="meta">无数据</span>') + '</div>' +
          '</div>';
      }).join("");

      const sortedTimings = [...timings].sort((a, b) => b.totalHours - a.totalHours);
      document.querySelector("#stats-slice-timings").innerHTML = sortedTimings.length
        ? '<div class="stats-timing-scroll"><table class="stats-table"><thead><tr><th style="width:28px;"></th><th>切片编号</th><th>样本编号</th><th>项目</th><th>负责人</th><th>方法</th><th>当前步骤</th><th>开始时间</th><th>最近步骤</th><th>日志数</th><th>制片耗时</th><th>备注</th></tr></thead><tbody>' +
          sortedTimings.map(t => {
            const isComplete = !!t.isComplete;
            const hasData = !!t.firstAt;
            const hasDetails = t.stepDetails && t.stepDetails.length > 0;
            const expandIcon = hasDetails ? '<span class="stats-expand-icon" data-slice-expand="' + t.sliceId + '">▸</span>' : '<span class="meta">—</span>';
            let mainRow = '<tr class="stats-timing-main' + (hasDetails ? ' stats-expandable' : '') + '" data-slice-id="' + t.sliceId + '">' +
              '<td>' + expandIcon + '</td>' +
              '<td><b>' + t.sliceId + '</b></td>' +
              '<td>' + t.sampleId + '</td>' +
              '<td>' + t.project + '</td>' +
              '<td>' + t.owner + '</td>' +
              '<td>' + t.method + '</td>' +
              '<td><span class="pill">' + t.status + '</span></td>' +
              '<td>' + (hasData ? formatObsDate(t.firstAt) : '<span class="meta">—</span>') + '</td>' +
              '<td>' + (t.lastLogAt ? formatObsDate(t.lastLogAt) : '<span class="meta">—</span>') + '</td>' +
              '<td class="num">' + t.logsCount + '</td>' +
              '<td class="num">' + (hasData ? (isComplete ? formatHours(t.totalHours) : '<span style="color:var(--danger);">' + formatHours(t.totalHours) + ' (进行中)</span>') : '<span class="meta">—</span>') + '</td>' +
              '<td>' + (t.note ? '<span class="meta">' + t.note + '</span>' : '') + '</td>' +
              '</tr>';
            let detailRow = '';
            if (hasDetails) {
              detailRow = '<tr class="stats-step-detail-row" id="detail-' + t.sliceId + '" style="display:none;"><td colspan="12"><div class="stats-step-detail-wrap"><table class="stats-inner-table"><thead><tr><th>步骤</th><th>→ 下一工序</th><th>开始时间</th><th>结束时间</th><th>停留时间</th></tr></thead><tbody>' +
                t.stepDetails.map(d => {
                  const dwellH = d.dwellHours;
                  let dwellColor = '';
                  if (dwellH >= 48) dwellColor = ' style="color:var(--danger);"';
                  else if (dwellH >= 24) dwellColor = ' style="color:#856404;"';
                  return '<tr>' +
                    '<td><span class="stats-step-dot"></span>' + d.from + '</td>' +
                    '<td>' + (d.to || '—') + '</td>' +
                    '<td>' + formatObsDate(d.fromAt) + '</td>' +
                    '<td>' + formatObsDate(d.toAt) + '</td>' +
                    '<td class="num"' + dwellColor + '>' + formatHours(dwellH) + '</td>' +
                    '</tr>';
                }).join("") +
                '</tbody></table></div></td></tr>';
            }
            return mainRow + detailRow;
          }).join("") +
          '</tbody></table></div>'
        : '<div class="empty">暂无切片耗时数据</div>';

      document.querySelectorAll(".stats-expandable").forEach(row => {
        row.addEventListener("click", function() {
          const sliceId = this.dataset.sliceId;
          const detailRow = document.getElementById("detail-" + sliceId);
          const icon = this.querySelector(".stats-expand-icon");
          if (detailRow) {
            const isVisible = detailRow.style.display !== "none";
            detailRow.style.display = isVisible ? "none" : "table-row";
            if (icon) icon.textContent = isVisible ? "▸" : "▾";
          }
        });
        row.style.cursor = "pointer";
      });

      document.querySelector("#stats-owner-backlog").innerHTML = backlog.length
        ? '<table class="stats-table"><thead><tr><th>负责人</th><th>切片总数</th>' + steps.map(s => '<th>' + s + '</th>').join("") + '<th>已完成</th></tr></thead><tbody>' +
          backlog.map(row => {
            const cells = steps.map(step => {
              const count = row[step] || 0;
              let cls = "stats-backlog-zero";
              if (count >= 5) cls = "stats-backlog-high";
              else if (count >= 3) cls = "stats-backlog-mid";
              else if (count > 0) cls = "stats-backlog-low";
              return '<td class="num"><span class="stats-backlog-cell ' + cls + '">' + count + '</span></td>';
            }).join("");
            const backlogTotal = steps.reduce((sum, step) => sum + (row[step] || 0), 0);
            const completedCount = Math.max(0, row.total - backlogTotal);
            return '<tr><td><b>' + row.owner + '</b></td><td class="num">' + row.total + '</td>' + cells + '<td class="num"><span class="stats-backlog-cell ' + (completedCount > 0 ? 'stats-backlog-low' : 'stats-backlog-zero') + '">' + completedCount + '</span></td></tr>';
          }).join("") +
          '</tbody></table>'
        : '<div class="empty">暂无负责人积压数据</div>';
    }

    async function load(){
      initRoleSelector();
      if (!currentRole) {
        samples = [];
        deliveries = [];
        methodDict = [];
        methodDictLoaded = false;
        applyRoleToUI();
        return;
      }
      try {
        const results = await Promise.allSettled([
          roleHasPerm(PERMISSIONS.SAMPLE_VIEW) ? api("/api/samples") : Promise.resolve([]),
          roleHasPerm(PERMISSIONS.DELIVERY_VIEW) ? api("/api/deliveries") : Promise.resolve([])
        ]);
        samples = results[0].status === "fulfilled" ? results[0].value : [];
        deliveries = results[1].status === "fulfilled" ? results[1].value : [];
        if (roleHasPerm(PERMISSIONS.METHOD_VIEW)) {
          await loadMethodDict();
        }
        if (!createSliceRowsEl.querySelectorAll(".slice-row").length) {
          initCreateSliceRows();
        }
      } catch (err) {
        console.error("Failed to load data:", err);
      }
      populateFilterOptions();
      populateDeliveryFilterOptions();
      const urlFilters = urlToFilters();
      if (Object.keys(urlFilters).length) setFilters(urlFilters);
      activeView = resolveDefaultView();
      applyRoleToUI();
      if (activeView === "workbench") {
        renderWorkbench();
      } else if (activeView === "deliveries") {
        renderDeliveries();
      } else if (activeView === "stats") {
        loadAndRenderStats();
      } else if (activeView === "audit") {
        loadAndRenderAudit();
      } else {
        render();
      }
    }

    async function loadAndRenderAudit() {
      if (!roleHasPerm(PERMISSIONS.AUDIT_VIEW)) return;
      try {
        const filters = getAuditFilters();
        const params = new URLSearchParams();
        if (filters.sampleId) params.set("sampleId", filters.sampleId);
        if (filters.action) params.set("action", filters.action);
        const queryStr = params.toString() ? "?" + params.toString() : "";
        const data = await api("/api/audit" + queryStr);
        auditLog = data.logs || [];
        auditTotal = data.total || 0;
        populateAuditFilterOptions(data);
        renderAudit();
      } catch (err) {
        console.error("Failed to load audit log:", err);
        if (auditTimelineEl) {
          auditTimelineEl.innerHTML = '<div class="audit-empty">加载审计记录失败：' + escapeHtml(err.message || "未知错误") + '</div>';
        }
      }
    }

    function getAuditFilters() {
      const f = {};
      const sampleEl = document.querySelector("#audit-filter-sample");
      const actionEl = document.querySelector("#audit-filter-action");
      if (sampleEl && sampleEl.value) f.sampleId = sampleEl.value;
      if (actionEl && actionEl.value) f.action = actionEl.value;
      return f;
    }

    function applyAuditFilters(list, filters) {
      return list.filter(item => {
        if (filters.sampleId && item.sampleId !== filters.sampleId) return false;
        if (filters.action && item.action !== filters.action) return false;
        return true;
      });
    }

    function populateAuditFilterOptions(data) {
      const sampleSel = document.querySelector("#audit-filter-sample");
      const actionSel = document.querySelector("#audit-filter-action");
      if (sampleSel && data.sampleIds) {
        const current = sampleSel.value;
        sampleSel.innerHTML = '<option value="">全部样本</option>' +
          data.sampleIds.map(id => '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>').join("");
        sampleSel.value = current;
      }
      if (actionSel && data.actions) {
        const current = actionSel.value;
        const actionLabels = {
          "sample:create": "创建样本",
          "slice:append": "追加切片",
          "slice:batch": "批量追加切片",
          "step:advance": "推进步骤",
          "observation:create": "填写观察结果",
          "delivery:confirm": "确认交付",
          "csv:import": "CSV导入",
          "sample:rollback": "回滚样本"
        };
        actionSel.innerHTML = '<option value="">全部操作</option>' +
          data.actions.map(act => '<option value="' + escapeHtml(act) + '">' + escapeHtml(actionLabels[act] || act) + '</option>').join("");
        actionSel.value = current;
      }
    }

    function renderAudit() {
      const filters = getAuditFilters();
      const filtered = applyAuditFilters(auditLog, filters);
      const count = filtered.length;

      if (auditCountEl) {
        auditCountEl.textContent = count ? "筛选结果：共 " + count + " 条审计记录（总计 " + auditTotal + " 条）" : "没有符合条件的审计记录";
      }

      if (auditStatsEl) {
        const actionCounts = {};
        filtered.forEach(item => {
          actionCounts[item.action] = (actionCounts[item.action] || 0) + 1;
        });
        const sampleCount = new Set(filtered.map(i => i.sampleId)).size;
        const operatorCount = new Set(filtered.map(i => i.operator)).size;
        auditStatsEl.innerHTML =
          '<div class="audit-stat"><strong>' + count + '</strong><span>审计记录数</span></div>' +
          '<div class="audit-stat"><strong>' + sampleCount + '</strong><span>涉及样本</span></div>' +
          '<div class="audit-stat"><strong>' + operatorCount + '</strong><span>操作者</span></div>' +
          '<div class="audit-stat"><strong>' + Object.keys(actionCounts).length + '</strong><span>操作类型</span></div>';
      }

      if (auditTimelineEl) {
        if (filtered.length === 0) {
          auditTimelineEl.innerHTML = '<div class="audit-empty">还没有审计记录。进行样本创建、切片追加、步骤推进等操作后，会自动生成审计记录。</div>';
          return;
        }

        const canRollback = roleHasPerm(PERMISSIONS.AUDIT_ROLLBACK);
        auditTimelineEl.innerHTML = filtered.map(item => {
          const isRollback = item.action === "sample:rollback";
          const itemClass = isRollback ? "audit-item rollback" : "audit-item";
          const actionLabel = item.actionLabel || item.action;
          const operatorName = item.operatorName || item.operator || "未知";
          const timestamp = item.timestamp ? formatObsDate(item.timestamp) : "";
          const note = item.note || "";
          const hasSnapshot = !!item.snapshot;
          const beforeSummary = item.beforeSummary;
          const afterSummary = item.afterSummary;

          let summaryHtml = "";
          if (beforeSummary || afterSummary) {
            const beforeHtml = beforeSummary ? renderAuditSummaryBlock("变更前", beforeSummary) : "";
            const afterHtml = afterSummary ? renderAuditSummaryBlock("变更后", afterSummary) : "";
            summaryHtml = '<div class="audit-item-summary">' + beforeHtml + afterHtml + '</div>';
          }

          let actionsHtml = "";
          if (canRollback && hasSnapshot && !isRollback) {
            actionsHtml = '<div class="audit-item-actions">' +
              '<button type="button" class="secondary" data-audit-detail="' + item.id + '">查看详情</button>' +
              '<button type="button" class="danger" data-rollback="' + item.id + '">回滚到此版本</button>' +
              '</div>';
          } else if (canRollback && hasSnapshot && isRollback) {
            actionsHtml = '<div class="audit-item-actions">' +
              '<button type="button" class="secondary" data-audit-detail="' + item.id + '">查看详情</button>' +
              '</div>';
          }

          return '<div class="' + itemClass + '" data-audit-id="' + escapeHtml(item.id) + '">' +
            '<div class="audit-item-header">' +
              '<div class="audit-item-title">' +
                '<span class="audit-item-action">' + escapeHtml(actionLabel) + '</span>' +
                '<span>' + escapeHtml(item.sampleId || "-") + '</span>' +
              '</div>' +
              '<div class="audit-item-time">' + timestamp + '</div>' +
            '</div>' +
            '<div class="audit-item-meta">' +
              '<span>操作者：<b>' + escapeHtml(operatorName) + '</b></span>' +
              '<span>来源接口：<b>' + escapeHtml(item.sourceApi || "-") + '</b></span>' +
            '</div>' +
            (note ? '<div class="audit-item-note">' + escapeHtml(note) + '</div>' : "") +
            summaryHtml +
            actionsHtml +
            '</div>';
        }).join("");

        bindAuditEvents();
      }
    }

    function renderAuditSummaryBlock(title, summary) {
      const slicesHtml = summary.sliceStatuses && summary.sliceStatuses.length
        ? '<div class="slices-summary-list">' + summary.sliceStatuses.map(s =>
            '<div><span class="status-pill">' + escapeHtml(s.status) + '</span>' +
            escapeHtml(s.id) + '（' + escapeHtml(s.method) + '）' +
            '</div>'
          ).join("") + '</div>'
        : '<div class="meta">无切片数据</div>';

      return '<div class="audit-summary-block">' +
        '<h4>' + escapeHtml(title) + '</h4>' +
        '<div style="margin-bottom:6px;">' +
          '<span class="status-pill">' + escapeHtml(summary.status || "-") + '</span>' +
          '<span class="status-pill" style="background:#eef1ea;">' + escapeHtml(summary.delivery || "-") + '</span>' +
          '<span style="color:var(--muted);font-size:11px;">' + (summary.sliceCount || 0) + ' 个切片</span>' +
        '</div>' +
        slicesHtml +
        '</div>';
    }

    function bindAuditEvents() {
      document.querySelectorAll("[data-rollback]").forEach(btn => {
        btn.onclick = () => {
          const auditId = btn.dataset.rollback;
          openRollbackConfirmModal(auditId);
        };
      });
      document.querySelectorAll("[data-audit-detail]").forEach(btn => {
        btn.onclick = () => {
          const auditId = btn.dataset.auditDetail;
          openAuditDetailModal(auditId);
        };
      });
    }

    function openAuditDetailModal(auditId) {
      const entry = auditLog.find(e => e.id === auditId);
      if (!entry) return;

      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal wide";

      const snapshotHtml = entry.snapshot
        ? '<div class="delivery-section"><h3>完整快照数据</h3>' +
          '<pre style="background:#f5f8f0;border:1px solid var(--line);border-radius:6px;padding:12px;max-height:300px;overflow:auto;font-size:11px;">' +
          escapeHtml(JSON.stringify(entry.snapshot, null, 2)) +
          '</pre></div>'
        : '<div class="delivery-section"><h3>快照数据</h3><div class="meta">该审计记录没有快照数据</div></div>';

      modal.innerHTML = '<h2>审计记录详情 — ' + escapeHtml(entry.id) + '</h2>' +
        '<div class="delivery-section">' +
          '<h3>基本信息</h3>' +
          '<div class="delivery-basic-info">' +
            '<div><b>操作类型：</b>' + escapeHtml(entry.actionLabel || entry.action) + '</div>' +
            '<div><b>操作时间：</b>' + formatObsDate(entry.timestamp) + '</div>' +
            '<div><b>样本编号：</b>' + escapeHtml(entry.sampleId || "-") + '</div>' +
            '<div><b>操作者：</b>' + escapeHtml(entry.operatorName || entry.operator || "未知") + '</div>' +
            '<div><b>来源接口：</b>' + escapeHtml(entry.sourceApi || "-") + '</div>' +
            '<div><b>记录ID：</b>' + escapeHtml(entry.id) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="delivery-section">' +
          '<h3>变更说明</h3>' +
          '<div class="audit-item-note">' + escapeHtml(entry.note || "无") + '</div>' +
        '</div>' +
        snapshotHtml +
        '<div class="modal-footer">' +
          '<button type="button" class="secondary" id="audit-detail-close">关闭</button>' +
          (roleHasPerm(PERMISSIONS.AUDIT_ROLLBACK) && entry.snapshot && entry.action !== "sample:rollback"
            ? '<button type="button" class="danger" id="audit-detail-rollback">回滚到此版本</button>'
            : "") +
        '</div>';

      mask.appendChild(modal);
      modalRoot.appendChild(mask);

      modal.querySelector("#audit-detail-close").onclick = () => mask.remove();
      mask.onclick = e => { if (e.target === mask) mask.remove(); };

      const rollbackBtn = modal.querySelector("#audit-detail-rollback");
      if (rollbackBtn) {
        rollbackBtn.onclick = () => {
          mask.remove();
          openRollbackConfirmModal(auditId);
        };
      }
    }

    function openRollbackConfirmModal(auditId) {
      const entry = auditLog.find(e => e.id === auditId);
      if (!entry) return;
      if (!entry.snapshot) {
        alert("该审计记录没有快照数据，无法回滚");
        return;
      }

      const sampleId = entry.sampleId;
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal";

      const summary = entry.afterSummary || {};
      const sliceCount = summary.sliceCount || 0;
      const status = summary.status || "-";
      const delivery = summary.delivery || "-";

      modal.innerHTML = '<h2>确认回滚 — ' + escapeHtml(sampleId) + '</h2>' +
        '<div class="meta">将回滚到审计记录 ' + escapeHtml(auditId) + '（' + formatObsDate(entry.timestamp) + '）</div>' +
        '<div class="rollback-confirm-info">' +
          '<h4>⚠️ 回滚操作不可逆</h4>' +
          '<ul>' +
            '<li>样本状态将恢复为「' + escapeHtml(status) + '」</li>' +
            '<li>交付状态将恢复为「' + escapeHtml(delivery) + '」</li>' +
            '<li>切片数量：' + sliceCount + ' 个</li>' +
            '<li>切片日志、观察记录将全部恢复到该版本</li>' +
            '<li>如果该版本之后有交付记录，回滚后可能会被删除</li>' +
            '<li>回滚操作本身也会被记录到审计日志</li>' +
          '</ul>' +
        '</div>' +
        '<div id="rollback-alert" style="margin-top:10px;"></div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="secondary" id="rollback-cancel">取消</button>' +
          '<button type="button" class="danger" id="rollback-confirm">确认回滚</button>' +
        '</div>';

      mask.appendChild(modal);
      modalRoot.appendChild(mask);

      modal.querySelector("#rollback-cancel").onclick = () => mask.remove();
      mask.onclick = e => { if (e.target === mask) mask.remove(); };

      modal.querySelector("#rollback-confirm").onclick = async () => {
        const confirmBtn = modal.querySelector("#rollback-confirm");
        const alertEl = modal.querySelector("#rollback-alert");
        try {
          confirmBtn.disabled = true;
          confirmBtn.textContent = "回滚中...";
          const result = await api('/api/samples/' + encodeURIComponent(sampleId) + '/rollback', {
            method: 'POST',
            body: JSON.stringify({ auditId })
          });
          mask.remove();
          alert("回滚成功！\n" + (result.note || ""));
          await Promise.all([
            load(),
            loadAndRenderAudit()
          ]);
        } catch (err) {
          const msg = err.message || "回滚失败";
          showAlert(alertEl, [msg]);
          confirmBtn.disabled = false;
          confirmBtn.textContent = "确认回滚";
        }
      };
    }

    function onAuditFilterChange() {
      loadAndRenderAudit();
    }

    function onFilterChange() {
      const filters = getFilters();
      history.replaceState(null, "", filtersToUrl(filters));
      if (activeView === "workbench") {
        renderWorkbench();
      } else {
        render();
      }
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
      if (activeView === "workbench") {
        renderWorkbench();
      } else {
        render();
      }
    };
    deliveryFilterFields.forEach(field => {
      const id = field === "unit" ? "delivery-filter-unit" : field === "person" ? "delivery-filter-person" : ("delivery-filter-" + field);
      const el = document.querySelector("#" + id);
      if (el) el.addEventListener("change", onDeliveryFilterChange);
    });
    document.querySelector("#clear-delivery-filters").onclick = () => {
      deliveryFilterFields.forEach(field => {
        const id = field === "unit" ? "delivery-filter-unit" : field === "person" ? "delivery-filter-person" : ("delivery-filter-" + field);
        const el = document.querySelector("#" + id);
        if (el) el.value = "";
      });
      renderDeliveries();
    };
    statsFilterFields.forEach(field => {
      const el = document.querySelector("#stats-filter-" + field);
      if (el) el.addEventListener("change", () => { loadAndRenderStats(); });
    });
    document.querySelector("#clear-stats-filters").onclick = () => {
      statsFilterFields.forEach(field => {
        const el = document.querySelector("#stats-filter-" + field);
        if (el) el.value = "";
      });
      loadAndRenderStats();
    };
    const auditFilterSelects = ["#audit-filter-sample", "#audit-filter-action", "#audit-filter-operator"];
    auditFilterSelects.forEach(selector => {
      const el = document.querySelector(selector);
      if (el) el.addEventListener("change", onAuditFilterChange);
    });
    const clearAuditFiltersBtn = document.querySelector("#clear-audit-filters");
    if (clearAuditFiltersBtn) {
      clearAuditFiltersBtn.onclick = () => {
        auditFilterSelects.forEach(selector => {
          const el = document.querySelector(selector);
          if (el) el.value = "";
        });
        loadAndRenderAudit();
      };
    }
    document.querySelector("#reload").onclick = load;
    document.querySelectorAll(".view-tab").forEach(tab => {
      tab.onclick = () => switchView(tab.dataset.view);
    });
    let csvPreviewData = null;
    let csvFile = null;

    function switchImportTab(tabName) {
      document.querySelectorAll(".import-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.importTab === tabName);
      });
      document.querySelectorAll(".import-content").forEach(content => {
        content.classList.toggle("active", content.id === "import-" + tabName);
      });
    }

    document.querySelectorAll(".import-tab").forEach(tab => {
      tab.onclick = () => switchImportTab(tab.dataset.importTab);
    });

    const csvUploadArea = document.querySelector("#csv-upload-area");
    const csvFileInput = document.querySelector("#csv-file-input");
    const csvFileInfo = document.querySelector("#csv-file-info");
    const csvPreviewArea = document.querySelector("#csv-preview-area");
    const csvImportBtn = document.querySelector("#csv-import-btn");
    const csvResetBtn = document.querySelector("#csv-reset-btn");
    const csvImportResult = document.querySelector("#csv-import-result");

    csvUploadArea.onclick = () => csvFileInput.click();
    csvFileInput.onchange = e => {
      const file = e.target.files[0];
      if (file && file.name.toLowerCase().endsWith('.csv')) {
        handleCSVFile(file);
      } else if (file) {
        alert("请选择CSV文件");
      }
    };

    csvUploadArea.ondragover = e => {
      e.preventDefault();
      csvUploadArea.classList.add("dragover");
    };
    csvUploadArea.ondragleave = () => {
      csvUploadArea.classList.remove("dragover");
    };
    csvUploadArea.ondrop = e => {
      e.preventDefault();
      csvUploadArea.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file && file.name.toLowerCase().endsWith('.csv')) {
        handleCSVFile(file);
      } else if (file) {
        alert("请选择CSV文件");
      }
    };

    function handleCSVFile(file) {
      csvFile = file;
      const reader = new FileReader();
      reader.onload = async e => {
        const text = e.target.result;
        try {
          const result = await api("/api/csv/preview", {
            method: "POST",
            body: JSON.stringify({ csvText: text })
          });
          csvPreviewData = { text, result };
          renderCSVPreview(result);
          csvFileInfo.style.display = "flex";
          csvFileInfo.innerHTML = '<span class="filename">📄 ' + file.name + '</span><span class="meta">' + (file.size / 1024).toFixed(1) + ' KB</span>';
          csvUploadArea.style.display = "none";
          csvPreviewArea.style.display = "block";
          csvImportBtn.style.display = result.validRows > 0 ? "inline-block" : "none";
          csvResetBtn.style.display = "inline-block";
          csvImportResult.style.display = "none";
        } catch (err) {
          alert("CSV解析失败：" + err.message);
        }
      };
      reader.readAsText(file, "UTF-8");
    }

    function renderCSVPreview(data) {
      document.querySelector("#csv-stat-total").textContent = data.totalRows;
      document.querySelector("#csv-stat-valid").textContent = data.validRows;
      document.querySelector("#csv-stat-invalid").textContent = data.invalidRows;
      document.querySelector("#csv-stat-samples").textContent = data.sampleGroupCount;

      const summaryEl = document.querySelector("#csv-sample-summary");
      summaryEl.innerHTML = "将创建 <strong>" + data.newSampleCount + "</strong> 个新样本" +
        (data.existingSampleCount > 0 ? '，向 <strong>' + data.existingSampleCount + '</strong> 个已有样本追加切片' : '');

      const container = document.querySelector("#csv-preview-container");
      const rows = data.validatedRows;
      const headers = ["行号", "样本编号", "项目", "钻孔编号", "岩芯箱号", "取样深度", "负责人", "切片编号", "染色方法", "状态"];

      let html = '<table class="csv-preview-table"><thead><tr>';
      headers.forEach(h => { html += '<th>' + h + '</th>'; });
      html += '</tr></thead><tbody>';

      rows.forEach(row => {
        const d = row.data;
        let rowClass = "";
        if (row.hasError) rowClass = "row-error";
        else if (row.hasWarning) rowClass = "row-warning";

        html += '<tr class="' + rowClass + '">';
        html += '<td>' + row.rowNum + '</td>';

        const sampleIdDisplay = d.sampleId ? d.sampleId : '<span class="meta">自动生成</span>';
        html += '<td class="' + (row.warnings.some(w => w.includes("样本编号")) ? 'cell-warning' : '') + '">' + sampleIdDisplay + '</td>';

        const projectClass = !d.project ? 'cell-error' : '';
        html += '<td class="' + projectClass + '">' + (d.project || '<span class="meta">空</span>') + '</td>';

        const boreholeClass = !d.borehole ? 'cell-error' : '';
        html += '<td class="' + boreholeClass + '">' + (d.borehole || '<span class="meta">空</span>') + '</td>';

        const coreBoxClass = !d.coreBox ? 'cell-error' : '';
        html += '<td class="' + coreBoxClass + '">' + (d.coreBox || '<span class="meta">空</span>') + '</td>';

        const depthClass = !d.depth || row.errors.some(e => e.includes("深度")) ? 'cell-error' : '';
        html += '<td class="' + depthClass + '">' + (d.depth || '<span class="meta">空</span>') + '</td>';

        const ownerClass = !d.owner ? 'cell-error' : '';
        html += '<td class="' + ownerClass + '">' + (d.owner || '<span class="meta">空</span>') + '</td>';

        const sliceIdClass = !d.sliceId || row.errors.some(e => e.includes("切片编号")) ? 'cell-error' : '';
        html += '<td class="' + sliceIdClass + '">' + (d.sliceId || '<span class="meta">空</span>') + '</td>';

        const methodClass = !d.method ? 'cell-error' : '';
        html += '<td class="' + methodClass + '">' + (d.method || '<span class="meta">空</span>') + '</td>';

        let statusHtml = "";
        if (row.hasError) {
          statusHtml = '<span class="csv-error-badge">错误</span>';
        } else if (row.hasWarning) {
          statusHtml = '<span class="csv-warn-badge">警告</span>';
        } else {
          statusHtml = '<span style="color:var(--accent);">✓</span>';
        }
        html += '<td>' + statusHtml + '</td>';

        html += '</tr>';
      });

      html += '</tbody></table>';
      container.innerHTML = html;

      const issuesList = document.querySelector("#csv-issues-list");
      let issuesHtml = "";
      let issueCount = 0;
      rows.forEach(row => {
        row.errors.forEach(err => {
          issuesHtml += '<div class="csv-issue-item error"><span class="row-num">第' + row.rowNum + '行:</span>' + err + '</div>';
          issueCount++;
        });
        row.warnings.forEach(warn => {
          issuesHtml += '<div class="csv-issue-item warning"><span class="row-num">第' + row.rowNum + '行:</span>' + warn + '</div>';
          issueCount++;
        });
      });
      issuesHtml = issueCount === 0
        ? '<div class="csv-issue-item" style="color:var(--accent);">✓ 没有发现问题，所有数据均有效</div>'
        : issuesHtml;
      issuesList.innerHTML = issuesHtml;
    }

    csvResetBtn.onclick = () => {
      csvPreviewData = null;
      csvFile = null;
      csvFileInput.value = "";
      csvUploadArea.style.display = "block";
      csvFileInfo.style.display = "none";
      csvPreviewArea.style.display = "none";
      csvImportBtn.style.display = "none";
      csvResetBtn.style.display = "none";
      csvImportResult.style.display = "none";
    };

    csvImportBtn.onclick = async () => {
      if (!csvPreviewData) return;
      if (!confirm("确认导入这些数据吗？")) return;
      try {
        csvImportBtn.disabled = true;
        csvImportBtn.textContent = "导入中...";
        const result = await api("/api/csv/import", {
          method: "POST",
          body: JSON.stringify({ csvText: csvPreviewData.text })
        });
        renderImportResult(result);
        csvImportBtn.style.display = "none";
        csvResetBtn.textContent = "继续导入";
        await load();
      } catch (err) {
        const msg = err.message;
        csvImportResult.style.display = "block";
        csvImportResult.className = "csv-import-result error";
        csvImportResult.innerHTML = '<h3>导入失败</h3><div>' + msg + '</div>';
      } finally {
        csvImportBtn.disabled = false;
        csvImportBtn.textContent = "确认导入";
      }
    };

    function renderImportResult(result) {
      csvImportResult.style.display = "block";
      csvImportResult.className = "csv-import-result";
      let html = '<h3>导入完成！</h3>';
      html += '<div>共处理 ' + result.totalRows + ' 行数据</div>';
      html += '<ul>';
      html += '<li>成功导入 ' + result.successSlices + ' 个切片任务</li>';
      html += '<li>新建 ' + result.successSamples + ' 个样本</li>';
      html += '<li>失败 ' + result.failedSlices + ' 行</li>';
      html += '</ul>';
      if (result.results && result.results.length > 0) {
        html += '<div style="margin-top:8px;"><b>详细结果：</b><ul>';
        result.results.forEach(r => {
          if (r.type === "new_sample") {
            html += '<li>新建样本 ' + r.sampleId + '（' + r.project + '），含 ' + r.sliceCount + ' 个切片）</li>';
          } else {
            html += '<li>向样本 ' + r.sampleId + ' 追加 ' + r.sliceCount + ' 个切片</li>';
          }
        });
        html += '</ul></div>';
      }
      csvImportResult.innerHTML = html;
    }

    document.querySelector("#add-create-slice").onclick = () => {
      createSliceRowsEl.appendChild(createSliceRow());
    };
    const methodConfigBtn = document.querySelector("#method-config-btn");
    if (methodConfigBtn) {
      methodConfigBtn.onclick = openMethodConfigModal;
    }
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
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const currentRole = getRoleFromRequest(req);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/roles") {
      const roleList = Object.keys(ROLE_INFO).map(key => ({
        key,
        name: ROLE_INFO[key].name,
        desc: ROLE_INFO[key].desc,
        permissions: ROLE_PERMISSIONS[key]
      }));
      return sendJson(res, 200, {
        roles: roleList,
        currentRole: currentRole ? {
          key: currentRole,
          name: ROLE_INFO[currentRole].name,
          desc: ROLE_INFO[currentRole].desc,
          permissions: ROLE_PERMISSIONS[currentRole]
        } : null
      });
    }
    if (req.method === "GET" && url.pathname === "/api/samples") {
      if (!requirePermission(currentRole, PERMISSIONS.SAMPLE_VIEW, res)) return;
      return sendJson(res, 200, db.samples);
    }

    if (req.method === "POST" && url.pathname === "/api/samples") {
      if (!requirePermission(currentRole, PERMISSIONS.SAMPLE_CREATE, res)) return;
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
          observations: [],
          status: "取样",
          logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }]
        }))
      };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      recordAudit(db, { sampleId: sample.id, action: "sample:create", operator: currentRole, sourceApi: "POST /api/samples", beforeSample: null, afterSample: sample });
      await saveDb(db);
      return sendJson(res, 201, sample);
    }

    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      if (!requirePermission(currentRole, PERMISSIONS.SAMPLE_APPEND_SLICE, res)) return;
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const allExistingIds = getAllSliceIds(db, sample.id);
      const sampleExistingIds = sample.slices.map(s => s.id);
      const validationErrors = validateSlices([{ id: input.id, method: input.method }], [...allExistingIds, ...sampleExistingIds]);
      if (validationErrors.length > 0) {
        return sendJson(res, 400, { error: validationErrors });
      }
      const beforeSample = createSampleSnapshot(sample);
      sample.slices.push({ id: input.id.trim(), method: (input.method || "未指定").trim(), observation: "", observations: [], status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      recordAudit(db, { sampleId: sample.id, action: "slice:append", operator: currentRole, sourceApi: "POST /api/samples/:id/slices", beforeSample, afterSample: sample });
      await saveDb(db);
      return sendJson(res, 201, sample);
    }

    const batchSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/batch$/);
    if (batchSlice && req.method === "POST") {
      if (!requirePermission(currentRole, PERMISSIONS.SAMPLE_APPEND_SLICE, res)) return;
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
      const beforeSample = createSampleSnapshot(sample);
      slices.forEach(s => {
        sample.slices.push({
          id: s.id.trim(),
          method: (s.method || "未指定").trim(),
          observation: "",
          observations: [],
          status: "取样",
          logs: [{ at: new Date().toISOString(), step: "取样", note: "批量追加切片任务" }]
        });
      });
      updateSampleStatus(sample);
      recordAudit(db, { sampleId: sample.id, action: "slice:batch", operator: currentRole, sourceApi: "POST /api/samples/:id/slices/batch", beforeSample, afterSample: sample });
      await saveDb(db);
      return sendJson(res, 201, sample);
    }

    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const input = await body(req);
      const stepName = input.step || "";
      const isObservationStep = stepName === "观察";
      const isProductionStep = ["取样", "切割", "研磨", "染色"].includes(stepName);
      let canLogThisStep = false;
      if (roleHasPermission(currentRole, PERMISSIONS.STEP_ADVANCE)) {
        canLogThisStep = true;
      } else if (isObservationStep && roleHasPermission(currentRole, PERMISSIONS.OBSERVATION_CREATE)) {
        canLogThisStep = true;
      }
      if (!canLogThisStep) {
        const roleName = currentRole ? (ROLE_INFO[currentRole]?.name || currentRole) : "未登录";
        if (isProductionStep) {
          return sendJson(res, 403, { error: `权限不足：${roleName}无法推进制片步骤「${stepName}」，该操作仅限制片人员` });
        } else if (isObservationStep) {
          return sendJson(res, 403, { error: `权限不足：${roleName}无法操作观察步骤，该操作仅限观察人员` });
        } else {
          return sendJson(res, 403, { error: `权限不足：${roleName}无法操作「${stepName}」步骤` });
        }
      }
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const beforeSample = createSampleSnapshot(sample);
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      recordAudit(db, { sampleId: sample.id, action: "step:advance", operator: currentRole, sourceApi: "POST /api/samples/:id/slices/:sliceId/logs", beforeSample, afterSample: sample });
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const deliveryPreviewMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/delivery-preview$/);
    if (deliveryPreviewMatch && req.method === "GET") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_PREVIEW, res)) return;
      const sample = db.samples.find(item => item.id === deliveryPreviewMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slicesInfo = sample.slices.map(slice => {
        const observations = slice.observations || [];
        const lastObs = observations.length ? observations[observations.length - 1] : null;
        const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
        const hasObservation = observations.length > 0 || legacyObs.length > 0;
        let observationSummary = "";
        if (lastObs) {
          observationSummary = [lastObs.lithology, lastObs.minerals, lastObs.texture].filter(Boolean).join("；");
        } else if (legacyObs) {
          observationSummary = legacyObs;
        }
        return {
          id: slice.id,
          method: slice.method,
          status: slice.status,
          hasObservation,
          observationId: lastObs ? lastObs.id : null,
          isLegacyObservation: observations.length === 0 && legacyObs.length > 0,
          observationSummary,
          logsCount: slice.logs ? slice.logs.length : 0,
          lastLog: slice.logs && slice.logs.length ? slice.logs[slice.logs.length - 1] : null
        };
      });
      const allObserved = slicesInfo.length > 0 && slicesInfo.every(s => s.status === "观察" && s.hasObservation);
      const missingObservations = slicesInfo.filter(s => !(s.status === "观察" && s.hasObservation)).map(s => s.id);
      const logsSummary = [];
      sample.slices.forEach(slice => {
        if (slice.logs) {
          slice.logs.forEach(log => {
            logsSummary.push({
              sliceId: slice.id,
              at: log.at,
              step: log.step,
              note: log.note
            });
          });
        }
      });
      logsSummary.sort((a, b) => new Date(b.at) - new Date(a.at));
      return sendJson(res, 200, {
        sample: {
          id: sample.id,
          project: sample.project,
          borehole: sample.borehole,
          coreBox: sample.coreBox,
          depth: sample.depth,
          owner: sample.owner,
          status: sample.status,
          delivery: sample.delivery
        },
        slices: slicesInfo,
        allObserved,
        missingObservations,
        logsSummary: logsSummary.slice(0, 20),
        totalLogs: logsSummary.length,
        sliceCount: slicesInfo.length,
        observedCount: slicesInfo.filter(s => s.hasObservation).length
      });
    }

    const createDeliveryMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliveries$/);
    if (createDeliveryMatch && req.method === "POST") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_CREATE, res)) return;
      const sampleId = createDeliveryMatch[1];
      const sample = db.samples.find(item => item.id === sampleId);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slicesInfo = sample.slices.map(slice => {
        const observations = slice.observations || [];
        const lastObs = observations.length ? observations[observations.length - 1] : null;
        const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
        const hasObservation = observations.length > 0 || legacyObs.length > 0;
        return {
          status: slice.status,
          hasObservation,
          observationId: lastObs ? lastObs.id : null
        };
      });
      const allObserved = slicesInfo.length > 0 && slicesInfo.every(s => s.status === "观察" && s.hasObservation);
      if (!allObserved) {
        return sendJson(res, 400, { error: "全部切片完成观察后才能生成交付记录" });
      }
      const input = await body(req);
      const deliveredBy = (input.deliveredBy || "").trim();
      const receivingUnit = (input.receivingUnit || "").trim();
      const remark = (input.remark || "").trim();
      if (!deliveredBy) {
        return sendJson(res, 400, { error: "请填写交付人" });
      }
      if (!receivingUnit) {
        return sendJson(res, 400, { error: "请填写接收单位" });
      }
      const delivery = {
        id: `DLV-${Date.now()}`,
        sampleId,
        deliveredAt: new Date().toISOString(),
        deliveredBy,
        receivingUnit,
        remark,
        slices: sample.slices.map(slice => {
          const observations = slice.observations || [];
          const lastObs = observations.length ? observations[observations.length - 1] : null;
          const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
          const hasObservation = observations.length > 0 || legacyObs.length > 0;
          return {
            id: slice.id,
            method: slice.method,
            status: slice.status,
            hasObservation,
            observationId: lastObs ? lastObs.id : null
          };
        }),
        sampleSnapshot: {
          id: sample.id,
          project: sample.project,
          borehole: sample.borehole,
          coreBox: sample.coreBox,
          depth: sample.depth,
          owner: sample.owner
        }
      };
      const beforeSample = createSampleSnapshot(sample);
      db.deliveries.unshift(delivery);
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      recordAudit(db, { sampleId: sample.id, action: "delivery:confirm", operator: currentRole, sourceApi: "POST /api/samples/:id/deliveries", beforeSample, afterSample: sample });
      await saveDb(db);
      return sendJson(res, 201, delivery);
    }

    const listDeliveriesMatch = url.pathname.match(/^\/api\/deliveries$/);
    if (listDeliveriesMatch && req.method === "GET") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_VIEW, res)) return;
      const sampleFilter = url.searchParams.get("sampleId");
      let deliveries = db.deliveries;
      if (sampleFilter) {
        deliveries = deliveries.filter(d => d.sampleId === sampleFilter);
      }
      return sendJson(res, 200, deliveries);
    }

    const deliveryDetailMatch = url.pathname.match(/^\/api\/deliveries\/([^/]+)$/);
    if (deliveryDetailMatch && req.method === "GET") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_VIEW, res)) return;
      const delivery = db.deliveries.find(item => item.id === deliveryDetailMatch[1]);
      if (!delivery) return sendJson(res, 404, { error: "delivery_not_found" });
      return sendJson(res, 200, delivery);
    }

    const observationMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/observations$/);
    if (observationMatch) {
      const sample = db.samples.find(item => item.id === observationMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === observationMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });

      if (req.method === "GET") {
        if (!requirePermission(currentRole, PERMISSIONS.OBSERVATION_VIEW, res)) return;
        return sendJson(res, 200, slice.observations || []);
      }
      if (req.method === "POST") {
        if (!requirePermission(currentRole, PERMISSIONS.OBSERVATION_CREATE, res)) return;
        if (slice.status !== "观察") {
          return sendJson(res, 400, { error: ["切片进入观察步骤后才能归档观察结果"] });
        }
        const input = await body(req);
        const lithology = (input.lithology || "").trim();
        const minerals = (input.minerals || "").trim();
        const texture = (input.texture || "").trim();
        const remark = (input.remark || "").trim();
        if (!lithology && !minerals && !texture && !remark) {
          return sendJson(res, 400, { error: ["请至少填写一项观察结果"] });
        }
        const record = {
          id: `OBS-${Date.now()}`,
          at: new Date().toISOString(),
          lithology,
          minerals,
          texture,
          remark
        };
        if (!Array.isArray(slice.observations)) slice.observations = [];
        const beforeSample = createSampleSnapshot(sample);
        slice.observations.push(record);
        const summaryParts = [];
        if (lithology) summaryParts.push(lithology);
        if (minerals) summaryParts.push(minerals);
        if (texture) summaryParts.push(texture);
        slice.observation = summaryParts.join("；") || remark;
        updateSampleStatus(sample);
        recordAudit(db, { sampleId: sample.id, action: "observation:create", operator: currentRole, sourceApi: "POST /api/samples/:id/slices/:sliceId/observations", beforeSample, afterSample: sample });
        await saveDb(db);
        return sendJson(res, 201, { sample, record });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/csv/preview") {
      if (!requirePermission(currentRole, PERMISSIONS.CSV_IMPORT, res)) return;
      const input = await body(req);
      const csvText = input.csvText || "";
      if (!csvText || typeof csvText !== "string") {
        return sendJson(res, 400, { error: "请上传有效的CSV文件" });
      }
      try {
        const { headers, rows } = parseCSV(csvText);
        if (rows.length === 0) {
          return sendJson(res, 400, { error: "CSV文件中没有数据行" });
        }
        const normalizedRows = rows.map(row => {
          const normalized = {};
          Object.keys(row).forEach(key => {
            const normalizedKey = normalizeHeader(key);
            normalized[normalizedKey] = row[key];
          });
          return normalized;
        });
        const result = validateCSVImport(normalizedRows, db);
        return sendJson(res, 200, {
          originalHeaders: headers,
          totalRows: result.totalRows,
          validRows: result.validRows,
          invalidRows: result.invalidRows,
          validatedRows: result.validatedRows,
          sampleGroupCount: result.sampleGroups.length,
          newSampleCount: result.sampleGroups.filter(g => !g.sampleId).length,
          existingSampleCount: result.sampleGroups.filter(g => g.sampleId).length
        });
      } catch (err) {
        return sendJson(res, 500, { error: "CSV解析失败：" + err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/csv/import") {
      if (!requirePermission(currentRole, PERMISSIONS.CSV_IMPORT, res)) return;
      const input = await body(req);
      const csvText = input.csvText || "";
      if (!csvText || typeof csvText !== "string") {
        return sendJson(res, 400, { error: "请上传有效的CSV文件" });
      }
      try {
        const { rows } = parseCSV(csvText);
        const normalizedRows = rows.map(row => {
          const normalized = {};
          Object.keys(row).forEach(key => {
            const normalizedKey = normalizeHeader(key);
            normalized[normalizedKey] = row[key];
          });
          return normalized;
        });
        const validation = validateCSVImport(normalizedRows, db);
        if (validation.validRows === 0) {
          return sendJson(res, 400, { error: "没有可导入的有效数据行" });
        }

        const sampleData = groupSlicesToSamples(validation.sampleGroups, db);
        let successSamples = 0;
        let successSlices = 0;
        let failedSlices = 0;
        const results = [];

        sampleData.forEach(item => {
          if (item.isNew) {
            const newSample = {
              id: "CORE-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4),
              project: item.sampleData.project,
              borehole: item.sampleData.borehole,
              coreBox: item.sampleData.coreBox,
              depth: item.sampleData.depth,
              owner: item.sampleData.owner,
              status: "待切割",
              delivery: "未交付",
              slices: item.newSlices.map(s => ({
                id: s.id,
                method: s.method || "未指定",
                observation: "",
                observations: [],
                status: "取样",
                logs: [{ at: new Date().toISOString(), step: "取样", note: "CSV批量导入创建初始切片任务" }]
              }))
            };
            updateSampleStatus(newSample);
            db.samples.unshift(newSample);
            recordAudit(db, { sampleId: newSample.id, action: "csv:import", operator: currentRole, sourceApi: "POST /api/csv/import", beforeSample: null, afterSample: newSample });
            successSamples++;
            successSlices += item.newSlices.length;
            results.push({
              type: "new_sample",
              sampleId: newSample.id,
              sliceCount: item.newSlices.length,
              project: newSample.project
            });
          } else {
            const sample = db.samples.find(s => s.id === item.sampleId);
            if (sample) {
              const beforeSample = createSampleSnapshot(sample);
              item.newSlices.forEach(s => {
                sample.slices.push({
                  id: s.id,
                  method: s.method || "未指定",
                  observation: "",
                  observations: [],
                  status: "取样",
                  logs: [{ at: new Date().toISOString(), step: "取样", note: "CSV批量导入追加切片任务" }]
                });
              });
              updateSampleStatus(sample);
              recordAudit(db, { sampleId: sample.id, action: "csv:import", operator: currentRole, sourceApi: "POST /api/csv/import", beforeSample, afterSample: sample });
              successSlices += item.newSlices.length;
              results.push({
                type: "append_slices",
                sampleId: sample.id,
                sliceCount: item.newSlices.length,
                project: sample.project
              });
            }
          }
        });

        failedSlices = validation.invalidRows;

        await saveDb(db);

        return sendJson(res, 200, {
          success: true,
          totalRows: validation.totalRows,
          validRows: validation.validRows,
          invalidRows: validation.invalidRows,
          successSamples,
          successSlices,
          failedSlices,
          results,
          validatedRows: validation.validatedRows
        });
      } catch (err) {
        return sendJson(res, 500, { error: "导入失败：" + err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/stats/time-analysis") {
      if (!requirePermission(currentRole, PERMISSIONS.STATS_VIEW, res)) return;
      const projectFilter = url.searchParams.get("project") || "";
      const ownerFilter = url.searchParams.get("owner") || "";
      let filtered = db.samples;
      if (projectFilter) filtered = filtered.filter(s => s.project === projectFilter);
      if (ownerFilter) filtered = filtered.filter(s => s.owner === ownerFilter);

      const now = Date.now();
      const allSliceTimings = [];
      const stepDwellSums = {};
      const stepDwellCounts = {};
      const ownerBacklog = {};
      const stepIndexMap = {};
      taskSteps.forEach((step, idx) => {
        stepDwellSums[step] = 0;
        stepDwellCounts[step] = 0;
        stepIndexMap[step] = idx;
      });

      function safeParseDate(isoStr) {
        if (!isoStr) return null;
        try {
          const t = new Date(isoStr).getTime();
          return isNaN(t) ? null : t;
        } catch {
          return null;
        }
      }

      function sliceHasObservation(slice) {
        if (!slice) return false;
        const observations = Array.isArray(slice.observations) ? slice.observations : [];
        if (observations.length > 0) return true;
        const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
        return legacyObs.length > 0;
      }

      function getSliceObservationTime(slice) {
        if (!slice) return null;
        const observations = Array.isArray(slice.observations) ? slice.observations : [];
        for (let i = observations.length - 1; i >= 0; i--) {
          const t = safeParseDate(observations[i].at);
          if (t !== null) return { time: t, iso: observations[i].at };
        }
        return null;
      }

      function isSliceDone(slice, sampleDelivered, parsedLogs) {
        if (sampleDelivered) return true;
        const hasObs = sliceHasObservation(slice);
        const status = slice.status || "";
        if (hasObs && status === "观察") return true;
        if (parsedLogs && parsedLogs.length > 0) {
          const lastStep = parsedLogs[parsedLogs.length - 1].step;
          if (hasObs && lastStep === "观察") return true;
        }
        return false;
      }

      function ensureOwnerBacklog(owner) {
        if (!ownerBacklog[owner]) {
          ownerBacklog[owner] = { owner: owner, total: 0 };
          taskSteps.forEach(step => { ownerBacklog[owner][step] = 0; });
        }
        return ownerBacklog[owner];
      }

      function addToBacklog(owner, status) {
        const bl = ensureOwnerBacklog(owner);
        bl.total++;
        if (stepIndexMap[status] !== undefined) {
          bl[status]++;
        } else {
          bl[taskSteps[0]]++;
        }
      }

      const sampleTimingsMap = {};

      filtered.forEach(sample => {
        if (!sample.slices || !Array.isArray(sample.slices)) return;
        const sampleDelivered = sample.delivery === "已交付";

        if (!sampleTimingsMap[sample.id]) {
          sampleTimingsMap[sample.id] = {
            sampleId: sample.id,
            project: sample.project,
            owner: sample.owner,
            borehole: sample.borehole,
            coreBox: sample.coreBox,
            depth: sample.depth,
            status: sample.status,
            sliceCount: 0,
            completedSlices: 0,
            firstAt: null,
            lastAt: null,
            totalHours: 0,
            isComplete: false,
            note: null
          };
        }
        const st = sampleTimingsMap[sample.id];

        sample.slices.forEach(slice => {
          const sliceStatus = slice.status || taskSteps[0];
          const rawLogs = slice.logs || [];
          const parsedLogs = (Array.isArray(rawLogs) ? rawLogs : [])
            .map(log => ({ ...log, _time: safeParseDate(log.at) }))
            .filter(log => log._time !== null && log.step)
            .sort((a, b) => a._time - b._time);

          const done = isSliceDone(slice, sampleDelivered, parsedLogs);
          const obsTime = getSliceObservationTime(slice);

          if (done) {
            st.sliceCount++;
            st.completedSlices++;
          } else {
            st.sliceCount++;
            addToBacklog(sample.owner, sliceStatus);
          }

          if (parsedLogs.length === 0) {
            if (done && obsTime) {
              const firstTime = obsTime.time;
              const lastTime = obsTime.time;
              const totalTimeMs = lastTime - firstTime;
              allSliceTimings.push({
                sampleId: sample.id,
                sliceId: slice.id,
                project: sample.project,
                owner: sample.owner,
                method: slice.method,
                status: sliceStatus,
                firstStep: "观察",
                lastStep: "观察",
                firstAt: obsTime.iso,
                lastLogAt: obsTime.iso,
                lastAt: obsTime.iso,
                totalHours: totalTimeMs / (1000 * 60 * 60),
                totalDays: totalTimeMs / (1000 * 60 * 60 * 24),
                logsCount: 0,
                stepDetails: [],
                isComplete: true,
                note: sampleDelivered ? "样本已交付（步骤日志缺失）" : "仅有观察记录（步骤日志缺失）"
              });
              if (!st.firstAt || firstTime < new Date(st.firstAt).getTime()) st.firstAt = obsTime.iso;
              if (!st.lastAt || lastTime > new Date(st.lastAt).getTime()) st.lastAt = obsTime.iso;
            } else if (done) {
              allSliceTimings.push({
                sampleId: sample.id,
                sliceId: slice.id,
                project: sample.project,
                owner: sample.owner,
                method: slice.method,
                status: sliceStatus,
                firstStep: null,
                lastStep: null,
                firstAt: null,
                lastLogAt: null,
                lastAt: null,
                totalHours: 0,
                totalDays: 0,
                logsCount: 0,
                stepDetails: [],
                isComplete: true,
                note: sampleDelivered ? "样本已交付（无可用日志时间）" : "观察已完成（无可用日志时间）"
              });
              if (!st.note) st.note = "部分切片完成但缺少日志时间";
            } else {
              allSliceTimings.push({
                sampleId: sample.id,
                sliceId: slice.id,
                project: sample.project,
                owner: sample.owner,
                method: slice.method,
                status: sliceStatus,
                firstStep: null,
                lastStep: null,
                firstAt: null,
                lastLogAt: null,
                lastAt: null,
                totalHours: 0,
                totalDays: 0,
                logsCount: 0,
                stepDetails: [],
                isComplete: false,
                note: "无日志数据，无法计算耗时"
              });
              if (!st.note) st.note = "部分切片无日志数据";
            }
            return;
          }

          const firstLog = parsedLogs[0];
          const lastLog = parsedLogs[parsedLogs.length - 1];
          const firstTime = firstLog._time;
          let lastTime;
          let lastAtIso;
          if (done) {
            if (obsTime) {
              lastTime = Math.max(obsTime.time, lastLog._time);
              lastAtIso = lastTime === obsTime.time ? obsTime.iso : lastLog.at;
            } else {
              lastTime = lastLog._time;
              lastAtIso = lastLog.at;
            }
          } else {
            lastTime = now;
            lastAtIso = new Date(now).toISOString();
          }

          const totalTimeMs = lastTime - firstTime;

          const timing = {
            sampleId: sample.id,
            sliceId: slice.id,
            project: sample.project,
            owner: sample.owner,
            method: slice.method,
            status: sliceStatus,
            firstStep: firstLog.step,
            lastStep: done ? "观察" : lastLog.step,
            firstAt: firstLog.at,
            lastLogAt: lastLog.at,
            lastAt: lastAtIso,
            totalHours: totalTimeMs / (1000 * 60 * 60),
            totalDays: totalTimeMs / (1000 * 60 * 60 * 24),
            logsCount: parsedLogs.length,
            stepDetails: [],
            isComplete: done
          };

          for (let i = 0; i < parsedLogs.length; i++) {
            const currentStep = parsedLogs[i].step;
            const currentTime = parsedLogs[i]._time;
            let nextTime;
            let nextStep;
            let nextAt;
            if (i < parsedLogs.length - 1) {
              nextTime = parsedLogs[i + 1]._time;
              nextStep = parsedLogs[i + 1].step;
              nextAt = parsedLogs[i + 1].at;
            } else if (done) {
              if (obsTime && obsTime.time > currentTime) {
                nextTime = obsTime.time;
                nextStep = "观察完成";
                nextAt = obsTime.iso;
              } else {
                continue;
              }
            } else {
              nextTime = now;
              nextStep = "(进行中)";
              nextAt = new Date(now).toISOString();
            }

            const dwellMs = nextTime - currentTime;
            const dwellHours = dwellMs / (1000 * 60 * 60);

            timing.stepDetails.push({
              from: currentStep,
              to: nextStep,
              dwellHours,
              fromAt: parsedLogs[i].at,
              toAt: nextAt
            });

            if (stepDwellSums[currentStep] !== undefined) {
              stepDwellSums[currentStep] += dwellHours;
              stepDwellCounts[currentStep]++;
            }
          }

          if (done && timing.stepDetails.length === 0 && parsedLogs.length > 0) {
            if (obsTime) {
              const dwellMs = obsTime.time - firstLog._time;
              timing.stepDetails.push({
                from: firstLog.step,
                to: "观察完成",
                dwellHours: dwellMs / (1000 * 60 * 60),
                fromAt: firstLog.at,
                toAt: obsTime.iso
              });
            }
          }

          allSliceTimings.push(timing);

          if (firstTime && (!st.firstAt || firstTime < new Date(st.firstAt).getTime())) {
            st.firstAt = firstLog.at;
          }
          if (done) {
            const doneTime = obsTime ? Math.max(obsTime.time, lastLog._time) : lastLog._time;
            const doneIso = obsTime && doneTime === obsTime.time ? obsTime.iso : lastLog.at;
            if (!st.lastAt || doneTime > new Date(st.lastAt).getTime()) {
              st.lastAt = doneIso;
            }
          } else {
            const nowIso = new Date(now).toISOString();
            if (!st.lastAt || now > new Date(st.lastAt).getTime()) {
              st.lastAt = nowIso;
            }
          }
        });
      });

      const sampleTimings = Object.values(sampleTimingsMap);
      sampleTimings.forEach(st => {
        if (st.sliceCount === 0) {
          st.note = "无切片数据";
        } else if (st.firstAt && st.lastAt) {
          const ms = new Date(st.lastAt).getTime() - new Date(st.firstAt).getTime();
          st.totalHours = ms / (1000 * 60 * 60);
          st.isComplete = st.completedSlices === st.sliceCount;
        } else if (!st.note) {
          st.note = "日志数据不足，无法计算耗时";
        }
      });

      const stepAverages = taskSteps.map(step => ({
        step,
        avgHours: stepDwellCounts[step] > 0 ? stepDwellSums[step] / stepDwellCounts[step] : 0,
        avgDays: stepDwellCounts[step] > 0 ? (stepDwellSums[step] / stepDwellCounts[step]) / 24 : 0,
        count: stepDwellCounts[step]
      }));

      const backlogList = Object.values(ownerBacklog);

      const projects = [...new Set(db.samples.map(s => s.project))].sort();
      const owners = [...new Set(db.samples.map(s => s.owner))].sort();

      return sendJson(res, 200, {
        sliceTimings: allSliceTimings,
        sampleTimings,
        stepAverages,
        ownerBacklog: backlogList,
        projects,
        owners
      });
    }

    function sortMethods(methods) {
      return [...methods].sort((a, b) => {
        const sa = a.sortOrder || 0;
        const sb = b.sortOrder || 0;
        if (sa !== sb) return sa - sb;
        return (a.name || "").localeCompare(b.name || "", "zh");
      });
    }

    function countMethodUsage(db, methodName) {
      let count = 0;
      db.samples.forEach(sample => {
        sample.slices.forEach(slice => {
          if (slice.method && slice.method.trim() === methodName) count++;
        });
      });
      db.deliveries.forEach(delivery => {
        delivery.slices.forEach(s => {
          if (s.method && s.method.trim() === methodName) count++;
        });
      });
      return count;
    }

    if (req.method === "GET" && url.pathname === "/api/methods") {
      if (!requirePermission(currentRole, PERMISSIONS.METHOD_VIEW, res)) return;
      const sorted = sortMethods(db.methods);
      const withUsage = sorted.map(m => ({
        ...m,
        usageCount: countMethodUsage(db, m.name)
      }));
      return sendJson(res, 200, withUsage);
    }

    if (req.method === "GET" && url.pathname === "/api/methods/active") {
      if (!requirePermission(currentRole, PERMISSIONS.METHOD_VIEW, res)) return;
      const active = db.methods.filter(m => m.enabled);
      return sendJson(res, 200, sortMethods(active));
    }

    if (req.method === "POST" && url.pathname === "/api/methods") {
      if (!requirePermission(currentRole, PERMISSIONS.METHOD_MANAGE, res)) return;
      const input = await body(req);
      const name = (input.name || "").trim();
      const description = (input.description || "").trim();
      if (!name) {
        return sendJson(res, 400, { error: "工艺名称不能为空" });
      }
      const duplicate = db.methods.find(m => m.name === name);
      if (duplicate) {
        return sendJson(res, 400, { error: "工艺名称已存在" });
      }
      const maxSort = db.methods.length > 0 ? Math.max(...db.methods.map(m => m.sortOrder || 0)) : 0;
      const method = {
        id: "M-" + Date.now(),
        name,
        description,
        enabled: true,
        createdAt: new Date().toISOString(),
        sortOrder: maxSort + 1
      };
      db.methods.push(method);
      await saveDb(db);
      return sendJson(res, 201, { ...method, usageCount: 0 });
    }

    const methodMatch = url.pathname.match(/^\/api\/methods\/([^/]+)$/);
    if (methodMatch && req.method === "PUT") {
      if (!requirePermission(currentRole, PERMISSIONS.METHOD_MANAGE, res)) return;
      const methodId = methodMatch[1];
      const method = db.methods.find(m => m.id === methodId);
      if (!method) {
        return sendJson(res, 404, { error: "method_not_found" });
      }
      const input = await body(req);
      const name = (input.name || "").trim();
      const description = (input.description !== undefined ? (input.description || "").trim() : method.description);
      if (!name) {
        return sendJson(res, 400, { error: "工艺名称不能为空" });
      }
      const duplicate = db.methods.find(m => m.id !== methodId && m.name === name);
      if (duplicate) {
        return sendJson(res, 400, { error: "工艺名称已存在" });
      }
      const oldName = method.name;
      method.name = name;
      method.description = description;
      if (input.sortOrder !== undefined) {
        method.sortOrder = Number(input.sortOrder) || method.sortOrder;
      }
      if (oldName !== name) {
        const updateInSamples = input.updateExisting === true;
        if (updateInSamples) {
          db.samples.forEach(sample => {
            sample.slices.forEach(slice => {
              if (slice.method && slice.method.trim() === oldName) {
                slice.method = name;
              }
            });
          });
          db.deliveries.forEach(delivery => {
            delivery.slices.forEach(s => {
              if (s.method && s.method.trim() === oldName) {
                s.method = name;
              }
            });
          });
        }
      }
      await saveDb(db);
      return sendJson(res, 200, { ...method, usageCount: countMethodUsage(db, method.name) });
    }

    const methodToggleMatch = url.pathname.match(/^\/api\/methods\/([^/]+)\/toggle$/);
    if (methodToggleMatch && req.method === "PATCH") {
      if (!requirePermission(currentRole, PERMISSIONS.METHOD_MANAGE, res)) return;
      const methodId = methodToggleMatch[1];
      const method = db.methods.find(m => m.id === methodId);
      if (!method) {
        return sendJson(res, 404, { error: "method_not_found" });
      }
      method.enabled = !method.enabled;
      await saveDb(db);
      return sendJson(res, 200, { ...method, usageCount: countMethodUsage(db, method.name) });
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      if (!requirePermission(currentRole, PERMISSIONS.AUDIT_VIEW, res)) return;
      const sampleId = url.searchParams.get("sampleId") || "";
      const action = url.searchParams.get("action") || "";
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      let logs = db.auditLog;
      if (sampleId) logs = logs.filter(e => e.sampleId === sampleId);
      if (action) logs = logs.filter(e => e.action === action);
      const total = logs.length;
      logs = logs.slice(0, limit);
      const sampleIds = [...new Set(db.auditLog.map(e => e.sampleId))].sort();
      const actions = [...new Set(db.auditLog.map(e => e.action))].sort();
      return sendJson(res, 200, { logs, total, sampleIds, actions });
    }

    const rollbackMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/rollback$/);
    if (rollbackMatch && req.method === "POST") {
      if (!requirePermission(currentRole, PERMISSIONS.AUDIT_ROLLBACK, res)) return;
      const sampleId = rollbackMatch[1];
      const sample = db.samples.find(item => item.id === sampleId);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const auditId = input.auditId;
      if (!auditId) return sendJson(res, 400, { error: "请指定要回滚到的审计记录ID" });
      const auditEntry = db.auditLog.find(e => e.id === auditId && e.sampleId === sampleId);
      if (!auditEntry) return sendJson(res, 404, { error: "audit_entry_not_found" });
      if (!auditEntry.snapshot) return sendJson(res, 400, { error: "该审计记录没有快照数据，无法回滚" });
      const beforeRollback = createSampleSnapshot(sample);
      const restoredSample = JSON.parse(JSON.stringify(auditEntry.snapshot));
      migrateSample(restoredSample);
      const wasDelivered = beforeRollback.delivery === "已交付";
      const willBeDelivered = restoredSample.delivery === "已交付";
      updateSampleStatus(restoredSample);
      const sampleIdx = db.samples.findIndex(s => s.id === sampleId);
      if (sampleIdx >= 0) db.samples[sampleIdx] = restoredSample;
      const removedDeliveries = [];
      if (wasDelivered && !willBeDelivered) {
        const toRemove = db.deliveries.filter(d => d.sampleId === sampleId);
        removedDeliveries.push(...toRemove.map(d => d.id));
        db.deliveries = db.deliveries.filter(d => d.sampleId !== sampleId);
      }
      const rollbackNote = `回滚到审计记录 ${auditId}（${auditEntry.actionLabel || auditEntry.action}，${auditEntry.timestamp}）` +
        (removedDeliveries.length ? `；已删除交付记录：${removedDeliveries.join("、")}` : "");
      recordAudit(db, {
        sampleId,
        action: "sample:rollback",
        operator: currentRole,
        sourceApi: "POST /api/samples/:id/rollback",
        beforeSample: beforeRollback,
        afterSample: restoredSample,
        note: rollbackNote
      });
      await saveDb(db);
      return sendJson(res, 200, {
        sample: restoredSample,
        rollbackTo: auditId,
        removedDeliveries,
        note: rollbackNote
      });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
