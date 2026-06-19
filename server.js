import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const deliveryStatuses = ["未交付", "部分交付", "已交付"];
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
    PERMISSIONS.METHOD_MANAGE,
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
  { id: "M-001", name: "普通薄片", description: "标准岩矿薄片制片，厚度0.03mm", enabled: true, isDefault: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 1 },
  { id: "M-002", name: "茜素红染色", description: "碳酸盐矿物染色，区分方解石/白云石", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 2 },
  { id: "M-003", name: "光片", description: "不透明矿物光片制片，用于反光显微镜观察", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 3 },
  { id: "M-004", name: "油浸薄片", description: "油浸法制备薄片，用于精确测定矿物折射率", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 4 },
  { id: "M-005", name: "电子探针片", description: "电子探针显微分析用样品片", enabled: false, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 5 }
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
    },
    {
      id: "DLV-003",
      sampleId: "CORE-011",
      deliveredAt: "2026-06-15T09:30:00.000Z",
      deliveredBy: "陆川",
      receivingUnit: "矿产资源研究所",
      remark: "南山铁矿首批光片交付，普通薄片待制片完成后再交付",
      deliveryType: "partial",
      slices: [
        { id: "SL-011-A", method: "光片", status: "观察", hasObservation: true, observationId: "OBS-011" }
      ],
      sampleSnapshot: {
        id: "CORE-011",
        project: "南山铁矿",
        borehole: "ZK-32",
        coreBox: "BX-09",
        depth: "78.3-78.7m",
        owner: "陆川"
      }
    },
    {
      id: "DLV-004",
      sampleId: "CORE-012",
      deliveredAt: "2026-06-10T11:00:00.000Z",
      deliveredBy: "陈明",
      receivingUnit: "岩矿测试中心",
      remark: "西山金矿第二批首批普通薄片交付，光片和茜素红染色片待后续交付",
      deliveryType: "partial",
      slices: [
        { id: "SL-012-A", method: "普通薄片", status: "观察", hasObservation: true, observationId: "OBS-012A" }
      ],
      sampleSnapshot: {
        id: "CORE-012",
        project: "西山金矿勘探",
        borehole: "ZK-07",
        coreBox: "BX-05",
        depth: "356.8-357.2m",
        owner: "陈明"
      }
    },
    {
      id: "DLV-005",
      sampleId: "CORE-012",
      deliveredAt: "2026-06-17T15:20:00.000Z",
      deliveredBy: "陈明",
      receivingUnit: "岩矿测试中心",
      remark: "西山金矿第二批第二次交付，光片已完成观察，茜素红染色片尚在制片中",
      deliveryType: "partial",
      slices: [
        { id: "SL-012-B", method: "光片", status: "观察", hasObservation: true, observationId: "OBS-012B" }
      ],
      sampleSnapshot: {
        id: "CORE-012",
        project: "西山金矿勘探",
        borehole: "ZK-07",
        coreBox: "BX-05",
        depth: "356.8-357.2m",
        owner: "陈明"
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
    },
    {
      id: "CORE-011",
      project: "南山铁矿",
      borehole: "ZK-32",
      coreBox: "BX-09",
      depth: "78.3-78.7m",
      owner: "陆川",
      status: "制片中",
      delivery: "部分交付",
      slices: [
        { id: "SL-011-A", method: "光片", observation: "磁铁矿呈自形-半自形粒状", status: "观察", observations: [{id:"OBS-011", at:"2026-06-14T16:00:00.000Z", lithology:"磁铁石英岩", minerals:"磁铁矿60%+石英30%+赤铁矿8%+其他2%", texture:"自形-半自形粒状结构，条带状构造", remark:"磁铁矿呈自形-半自形粒状，粒度0.1-0.5mm，沿条带密集分布"}], logs: [{ at: "2026-06-11T09:00:00.000Z", step: "取样", note: "富磁铁矿条带" }, { at: "2026-06-12T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-13T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-14T08:00:00.000Z", step: "染色", note: "" }, { at: "2026-06-14T16:00:00.000Z", step: "观察", note: "磁铁矿呈自形-半自形粒状" }] },
        { id: "SL-011-B", method: "普通薄片", observation: "", status: "染色", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "围岩蚀变带" }, { at: "2026-06-13T09:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-14T10:00:00.000Z", step: "研磨", note: "" }], observations: [] },
        { id: "SL-011-C", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-13T10:00:00.000Z", step: "取样", note: "碳酸盐脉" }, { at: "2026-06-14T09:00:00.000Z", step: "切割", note: "" }], observations: [] }
      ]
    },
    {
      id: "CORE-012",
      project: "西山金矿勘探",
      borehole: "ZK-07",
      coreBox: "BX-05",
      depth: "356.8-357.2m",
      owner: "陈明",
      status: "待观察",
      delivery: "部分交付",
      slices: [
        { id: "SL-012-A", method: "普通薄片", observation: "可见石英脉型金矿化，黄铁矿稠密浸染", status: "观察", observations: [{id:"OBS-012A", at:"2026-06-09T15:00:00.000Z", lithology:"硅化蚀变花岗岩", minerals:"石英55%+长石20%+黄铁矿18%+自然金0.3%+其他6.7%", texture:"碎裂结构，脉状构造", remark:"石英脉中黄铁矿稠密浸染状分布，可见自然金包裹于黄铁矿中"}], logs: [{ at: "2026-06-05T10:00:00.000Z", step: "取样", note: "石英脉型矿化带" }, { at: "2026-06-06T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-07T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-08T14:00:00.000Z", step: "染色", note: "" }, { at: "2026-06-09T15:00:00.000Z", step: "观察", note: "可见石英脉型金矿化" }] },
        { id: "SL-012-B", method: "光片", observation: "黄铁矿与毒砂共生，自然金呈裂隙金", status: "观察", observations: [{id:"OBS-012B", at:"2026-06-16T14:30:00.000Z", lithology:"硅化黄铁矿化蚀变岩", minerals:"黄铁矿40%+毒砂15%+石英25%+自然金0.4%+其他19.6%", texture:"自形-半自形晶粒结构，浸染状构造", remark:"黄铁矿与毒砂紧密共生，自然金沿黄铁矿裂隙分布，粒径0.02-0.06mm"}], logs: [{ at: "2026-06-11T09:00:00.000Z", step: "取样", note: "黄铁矿化蚀变带" }, { at: "2026-06-12T08:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-13T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-15T08:00:00.000Z", step: "染色", note: "" }, { at: "2026-06-16T14:30:00.000Z", step: "观察", note: "黄铁矿与毒砂共生，见自然金" }] },
        { id: "SL-012-C", method: "茜素红染色", observation: "方解石脉穿插，见碳酸盐化蚀变", status: "观察", observations: [{id:"OBS-012C", at:"2026-06-18T10:00:00.000Z", lithology:"碳酸盐化蚀变岩", minerals:"方解石45%+石英25%+黄铁矿15%+绢云母10%+其他5%", texture:"交代残余结构，网脉状构造", remark:"方解石呈网脉状穿插，茜素红染色显深红色，见碳酸盐化交代现象"}], logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "碳酸盐脉发育带" }, { at: "2026-06-13T09:00:00.000Z", step: "切割", note: "" }, { at: "2026-06-14T10:00:00.000Z", step: "研磨", note: "" }, { at: "2026-06-17T08:00:00.000Z", step: "染色", note: "茜素红+铁氰化钾联合染色" }, { at: "2026-06-18T10:00:00.000Z", step: "观察", note: "方解石脉穿插，见碳酸盐化蚀变" }] },
        { id: "SL-012-D", method: "油浸薄片", observation: "", status: "研磨", logs: [{ at: "2026-06-14T10:00:00.000Z", step: "取样", note: "用于精确测折射率的部位" }, { at: "2026-06-15T09:00:00.000Z", step: "切割", note: "" }], observations: [] }
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
  if (!delivery.deliveryType) { delivery.deliveryType = "full"; changed = true; }
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

  db.methods.forEach(m => {
    if (m.isDefault === undefined) {
      m.isDefault = false;
      needSave = true;
    }
  });

  const hasDefault = db.methods.some(m => m.isDefault && m.enabled);
  if (!hasDefault) {
    const sorted = sortMethods(db.methods.filter(m => m.enabled));
    if (sorted.length > 0) {
      sorted[0].isDefault = true;
      needSave = true;
    }
  }

  let nextSort = db.methods.length > 0 ? Math.max(...db.methods.map(m => m.sortOrder || 0)) + 1 : 1;
  usedMethodNames.forEach(name => {
    if (!existingMethodNames.has(name)) {
      db.methods.push({
        id: "M-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4),
        name: name,
        description: "从历史数据自动导入",
        enabled: true,
        isDefault: false,
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

function sortMethods(methods) {
  return [...methods].sort((a, b) => {
    const sa = a.sortOrder || 0;
    const sb = b.sortOrder || 0;
    if (sa !== sb) return sa - sb;
    return (a.name || "").localeCompare(b.name || "", "zh");
  });
}

function setDefaultMethod(db, methodId) {
  const method = db.methods.find(m => m.id === methodId);
  if (!method || !method.enabled) return false;
  db.methods.forEach(m => { m.isDefault = false; });
  method.isDefault = true;
  return true;
}

function ensureDefaultMethod(db) {
  const hasDefault = db.methods.some(m => m.isDefault && m.enabled);
  if (!hasDefault) {
    const sorted = sortMethods(db.methods.filter(m => m.enabled));
    if (sorted.length > 0) {
      sorted[0].isDefault = true;
      return sorted[0];
    }
  }
  return null;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function getDeliveredSliceIds(db, sampleId) {
  const delivered = new Set();
  db.deliveries.forEach(d => {
    if (d.sampleId === sampleId) {
      d.slices.forEach(s => delivered.add(s.id));
    }
  });
  return delivered;
}

function updateSampleStatus(sample, db) {
  const deliveredSliceIds = db ? getDeliveredSliceIds(db, sample.id) : new Set();
  const totalSlices = sample.slices.length;
  const deliveredSlices = sample.slices.filter(s => deliveredSliceIds.has(s.id)).length;
  const undeliveredSlices = sample.slices.filter(s => !deliveredSliceIds.has(s.id));
  const undeliveredStatuses = undeliveredSlices.map(s => s.status);

  if (deliveredSlices > 0 && deliveredSlices === totalSlices) {
    sample.delivery = "已交付";
  } else if (deliveredSlices > 0) {
    sample.delivery = "部分交付";
  } else {
    sample.delivery = "未交付";
  }

  if (sample.delivery === "已交付") {
    sample.status = "已交付";
  } else if (undeliveredSlices.length === 0) {
    sample.status = "待切割";
  } else if (undeliveredStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) {
    sample.status = "制片中";
  } else if (undeliveredStatuses.every(step => step === "观察")) {
    sample.status = "待观察";
  } else {
    sample.status = "待切割";
  }
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
  "step:batch-advance": "批量推进步骤",
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
  const changedSlices = [];
  afterSample.slices.forEach(s => {
    const before = beforeSliceMap[s.id];
    if (!before) {
      parts.push(`新增切片 ${s.id}（${s.method}）`);
    } else {
      if (before.status !== s.status) {
        changedSlices.push(`${s.id}：${before.status} → ${s.status}`);
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
  if (changedSlices.length > 0) {
    if (action === "step:batch-advance") {
      parts.push(`批量推进 ${changedSlices.length} 个切片：${changedSlices.join("、")}`);
    } else if (changedSlices.length === 1) {
      parts.push(`切片 ${changedSlices[0]}`);
    } else {
      changedSlices.forEach(cs => parts.push(`切片 ${cs}`));
    }
  }
  return parts.join("；");
}

function recordAudit(db, { sampleId, action, operator, sourceApi, beforeSample, afterSample, note, deliverySnapshot }) {
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
  if (deliverySnapshot) entry.deliverySnapshot = JSON.parse(JSON.stringify(deliverySnapshot));
  db.auditLog.unshift(entry);
  return entry;
}

const OBS_FIELDS = ["lithology", "minerals", "texture", "remark"];
const OBS_FIELD_LABELS = {
  lithology: "岩性",
  minerals: "矿物",
  texture: "结构构造",
  remark: "备注"
};

function compareObservations(obsA, obsB) {
  const changes = [];
  OBS_FIELDS.forEach(field => {
    const a = (obsA && obsA[field]) || "";
    const b = (obsB && obsB[field]) || "";
    if (a !== b) {
      changes.push({
        field,
        label: OBS_FIELD_LABELS[field],
        oldValue: a,
        newValue: b
      });
    }
  });
  return changes;
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
    .next-hint { display:inline-block; font-size:11px; padding:2px 8px; border-radius:4px; margin-top:4px; font-weight:600; }
    .next-hint-producer { background:#e8f0e0; color:#4a6b3a; border:1px solid #c6dcb8; }
    .next-hint-observer { background:#e0ecf5; color:#3a5a7b; border:1px solid #b8d0e8; }
    .next-hint-deliverer { background:#f5efe0; color:#7b6a3a; border:1px solid #e8d8b8; }
    .next-hint-done { background:#edf5e8; color:var(--accent); border:1px solid #c6dcb8; }
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
    .workbench-toolbar { display:flex; gap:12px; align-items:center; justify-content:space-between; background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 16px; margin-bottom:12px; flex-wrap:wrap; }
    .workbench-toolbar-left { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .workbench-toolbar-right { display:flex; gap:12px; align-items:center; }
    .batch-select-label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px; color:var(--stone); }
    .batch-select-label input { margin:0; }
    .batch-selected-count { background:var(--accent); color:#fff; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
    .batch-advance-btn { background:var(--accent); color:#fff; }
    .workbench-card.selected { background:#fffbe6; border-color:#e6b800; box-shadow:0 2px 8px rgba(230,184,0,0.2); }
    .workbench-card-checkbox { position:absolute; top:8px; right:8px; width:18px; height:18px; cursor:pointer; z-index:10; }
    .workbench-card { position:relative; }
    .workbench-card.has-checkbox { padding-right:36px; }
    .batch-error-list { max-height:200px; overflow-y:auto; background:var(--warn-bg); border:1px solid var(--warn-border); border-radius:6px; padding:10px; margin-top:10px; }
    .batch-error-item { font-size:12px; padding:4px 0; border-bottom:1px dashed var(--warn-border); }
    .batch-error-item:last-child { border-bottom:0; }
    .batch-error-item .slice-id { font-weight:700; color:var(--danger); }
    .batch-success-info { background:#edf5e8; border:1px solid #c6dcb8; border-radius:6px; padding:10px; margin-top:10px; font-size:13px; color:var(--accent); }
    .batch-modal-step-info { display:flex; gap:10px; align-items:center; background:#f5f8f0; border:1px solid #c6dcb8; border-radius:6px; padding:10px; margin-bottom:12px; }
    .batch-modal-step-info .step-arrow { font-size:18px; color:var(--accent); font-weight:700; }
    .batch-modal-step-info .step-badge { background:var(--accent); color:#fff; padding:4px 10px; border-radius:4px; font-weight:600; font-size:13px; }
    .batch-modal-step-info .step-badge.next { background:#e6b800; }
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
    .csv-preview-table td.cell-editable { padding: 2px 4px; }
    .csv-preview-table td.cell-editable input { width: 100%; border: 1px solid var(--line); border-radius: 3px; padding: 3px 5px; font: inherit; font-size: 12px; background: #fff; }
    .csv-preview-table td.cell-editable input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px rgba(82,111,67,0.15); }
    .csv-preview-table tr.row-error td.cell-editable input { background: #fff5f3; }
    .csv-preview-table td.cell-editable input.input-error { border-color: var(--danger); background: #fef2f0; }
    .csv-revalidate-btn { background: #e8a830 !important; color: #fff !important; }
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
    .stats-overview { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; }
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
    .stats-step-dot-abnormal { background:var(--danger); box-shadow:0 0 0 2px #fff, 0 0 0 4px var(--danger); }
    .stats-kpi-abnormal strong { color:var(--danger) !important; }
    .abnormal-config-info { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 14px; background:#fff8e6; border:1px solid #ffe08a; border-radius:6px; margin-bottom:12px; font-size:13px; color:#856404; }
    .abnormal-config-label { font-weight:600; }
    .abnormal-config-item b { color:var(--danger); }
    .abnormal-config-sep { color:#c5a75a; }
    .abnormal-config-count { margin-left:auto; font-weight:600; }
    .abnormal-config-count b { color:var(--danger); font-size:16px; }
    .abnormal-table .abnormal-row { background:#fff5f5; }
    .abnormal-table .abnormal-row:hover td { background:#ffe8e8 !important; }
    .abnormal-step-badge { display:inline-block; padding:2px 8px; background:var(--danger); color:#fff; border-radius:4px; font-size:11px; font-weight:600; }
    .abnormal-duration { color:var(--danger); font-weight:700; }
    .abnormal-reasons { max-width:240px; }
    .abnormal-reason-tag { display:inline-block; padding:2px 6px; margin:2px 4px 2px 0; background:#fde2e2; color:#a83232; border-radius:3px; font-size:11px; }
    .abnormal-badge { display:inline-block; padding:1px 6px; background:var(--danger); color:#fff; border-radius:10px; font-size:11px; font-weight:600; vertical-align:middle; margin-left:4px; }
    .stats-timing-abnormal td { background:#fff8f8 !important; }
    .stats-timing-abnormal:hover td { background:#fff0f0 !important; }
    .abnormal-step-row { background:#fff5f5; }
    .abnormal-step-row td { color:var(--danger); }
    .abnormal-reason-tags { margin-top:4px; }
    .abnormal-reason-tags .abnormal-reason-tag { font-size:10px; }
    .card-abnormal { border-color:var(--danger) !important; box-shadow:0 0 0 2px rgba(239, 68, 68, 0.1); }
    .card-abnormal-banner { background:linear-gradient(135deg, #fee2e2, #fecaca); color:#991b1b; padding:6px 10px; border-radius:6px; font-size:12px; font-weight:600; margin-top:4px; }
    .slice-abnormal { border-top-color:var(--danger) !important; position:relative; }
    .slice-abnormal-badge { color:var(--danger); font-size:14px; font-weight:700; vertical-align:middle; }
    .slice-abnormal-tag { background:#fef2f2; color:#991b1b; border:1px solid #fecaca; padding:4px 8px; border-radius:4px; font-size:11px; margin:6px 0; font-weight:500; }
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
    .method-badge.default { background: linear-gradient(135deg, #ffd700, #ffb347); color: #fff; box-shadow: 0 1px 3px rgba(255, 179, 71, 0.4); }
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
    .obs-compare-toggle { margin: 0 0 10px; display: flex; align-items: center; gap: 10px; }
    .obs-compare-toggle button { padding: 6px 12px; font-size: 12px; }
    .obs-history-item.compare-mode { border-left: 3px solid var(--accent); padding-left: 10px; cursor: pointer; }
    .obs-history-item.selected { background: #fff8e6; border-left-color: #e6b800; }
    .obs-history-item .compare-checkbox { margin-right: 6px; }
    .obs-compare-result { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-top: 12px; }
    .obs-compare-result h3 { margin: 0 0 12px; font-size: 15px; color: var(--stone); }
    .obs-compare-headers { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 10px; font-size: 12px; color: var(--muted); padding-bottom: 6px; border-bottom: 1px solid var(--line); margin-bottom: 8px; font-weight: 600; }
    .obs-compare-row { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--line); align-items: start; font-size: 13px; }
    .obs-compare-row:last-child { border-bottom: 0; }
    .obs-compare-row .field-label { color: var(--stone); font-weight: 600; }
    .obs-compare-row .old-val { background: #fdf2ef; padding: 6px 8px; border-radius: 4px; color: var(--danger); white-space: pre-wrap; word-break: break-all; }
    .obs-compare-row .new-val { background: #edf5e8; padding: 6px 8px; border-radius: 4px; color: var(--accent); white-space: pre-wrap; word-break: break-all; }
    .obs-compare-row.unchanged .old-val, .obs-compare-row.unchanged .new-val { background: #fafcf7; color: var(--ink); }
    .obs-compare-empty { text-align: center; color: var(--muted); padding: 20px; font-size: 13px; }
    .obs-compare-banner { background: #fff8e6; border: 1px solid #e6b800; border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 13px; color: #856404; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .obs-compare-banner button { padding: 4px 10px; font-size: 12px; }
    .audit-obs-diff { background: #fafcf7; border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin-top: 10px; }
    .audit-obs-diff h4 { margin: 0 0 8px; font-size: 13px; color: var(--stone); }
    .audit-obs-diff-row { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; align-items: flex-start; }
    .audit-obs-diff-field { font-weight: 600; color: var(--stone); min-width: 64px; flex-shrink: 0; }
    .audit-obs-diff-old { color: var(--danger); background: #fdf2ef; padding: 2px 6px; border-radius: 3px; text-decoration: line-through; }
    .audit-obs-diff-arrow { color: var(--muted); flex-shrink: 0; }
    .audit-obs-diff-new { color: var(--accent); background: #edf5e8; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
    .dashboard-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 18px; }
    .dashboard-kpi { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 16px; text-align: center; }
    .dashboard-kpi strong { display: block; font-size: 28px; }
    .dashboard-kpi span { font-size: 12px; color: var(--muted); }
    .dashboard-kpi-undelivered strong { color: var(--muted); }
    .dashboard-kpi-partial strong { color: #856404; }
    .dashboard-kpi-delivered strong { color: var(--accent); }
    .dashboard-kpi-total strong { color: var(--ink); }
    .dashboard-group { margin-bottom: 20px; }
    .dashboard-group-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid var(--line); }
    .dashboard-group-header h2 { margin: 0; font-size: 17px; }
    .dashboard-group-count { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; min-width: 24px; text-align: center; }
    .dashboard-group-count-undelivered { background: #eef1ea; color: var(--muted); }
    .dashboard-group-count-partial { background: #fff3cd; color: #856404; }
    .dashboard-group-count-delivered { background: #edf5e8; color: var(--accent); }
    .dashboard-group-empty { padding: 30px; text-align: center; color: var(--muted); background: #fff; border: 1px dashed var(--line); border-radius: 8px; font-size: 13px; }
    .dashboard-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .dashboard-table th, .dashboard-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); }
    .dashboard-table th { background: #f5f8f0; font-weight: 600; color: var(--stone); position: sticky; top: 0; }
    .dashboard-table tr:hover td { background: #fafcf6; }
    .dashboard-table td.num { text-align: center; font-variant-numeric: tabular-nums; }
    .dashboard-slice-progress { display: inline-flex; align-items: center; gap: 6px; }
    .dashboard-slice-bar { display: inline-block; width: 60px; height: 8px; background: #eef1ea; border-radius: 4px; overflow: hidden; vertical-align: middle; }
    .dashboard-slice-bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .dashboard-slice-bar-fill-undelivered { background: var(--muted); }
    .dashboard-slice-bar-fill-partial { background: #f0ad4e; }
    .dashboard-slice-bar-fill-delivered { background: var(--accent); }
    .dashboard-latest-delivery { font-size: 12px; color: var(--stone); }
    .dashboard-latest-delivery b { color: var(--accent); }
    .dashboard-latest-delivery .delivery-type-tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 4px; }
    .delivery-type-tag-full { background: #edf5e8; color: var(--accent); }
    .delivery-type-tag-partial { background: #fff3cd; color: #856404; }
    .dashboard-no-delivery { font-size: 12px; color: var(--muted); font-style: italic; }
    .dashboard-remaining-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .dashboard-remaining-zero { background: #edf5e8; color: var(--accent); }
    .dashboard-remaining-has { background: #fff3cd; color: #856404; }
    .dashboard-remaining-all { background: #eef1ea; color: var(--muted); }
    @media (max-width: 950px) { .dashboard-summary { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 500px) { .dashboard-summary { grid-template-columns: 1fr; } }
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
        <button type="button" class="view-tab" data-view="delivery-dashboard">交付状态看板</button>
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
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div class="format-hint">支持列名：项目、钻孔编号、岩芯箱号、取样深度、负责人、切片编号、染色方法、样本编号（选填，用于追加到已有样本）</div>
          <button type="button" class="secondary" id="csv-download-template" style="padding:6px 12px;font-size:13px;">📥 下载CSV模板</button>
        </div>
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
          <button type="button" class="csv-revalidate-btn" id="csv-revalidate-btn" style="display:none;">修正后再校验</button>
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
              <select id="filter-delivery"><option value="">全部</option><option value="未交付">未交付</option><option value="部分交付">部分交付</option><option value="已交付">已交付</option></select>
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
      <div id="view-delivery-dashboard" class="view-content">
        <div class="dashboard-summary" id="dashboard-summary"></div>
        <div class="dashboard-groups" id="dashboard-groups"></div>
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
          <h2>异常耗时识别</h2>
          <div class="stats-abnormal-config" id="stats-abnormal-config"></div>
          <div id="stats-abnormal-list"></div>
        </div>
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
      const methodActions = document.querySelectorAll("[data-method-edit], [data-method-toggle], [data-method-default]");
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
          if (view === "deliveries" || view === "delivery-dashboard") visible = canDeliveryView;
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
      if (activeView === "delivery-dashboard" && canDeliveryView) return "delivery-dashboard";
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
    let selectedSlices = new Set();
    let batchModeEnabled = false;

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
      const defaultMethod = activeMethods.find(m => m.isDefault);
      const methodInDict = activeMethods.some(m => m.name === initialMethod);
      const useCustom = initialMethod !== "" && !methodInDict;
      let selectedMethod = initialMethod;
      if (selectedMethod === "" && defaultMethod) {
        selectedMethod = defaultMethod.name;
      }
      const selectOptions = '<option value="">-- 选择染色方法 --</option>' +
        activeMethods.map(m => '<option value="' + escapeHtml(m.name) + '"' + (m.name === selectedMethod && !useCustom ? ' selected' : '') + '>' + escapeHtml(m.name) + (m.isDefault ? ' (默认)' : '') + '</option>').join("") +
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
          methodDict.filter(m => m.enabled).map(m => '<option value="' + escapeHtml(m.name) + '"' + (m.name === currentValue && !shouldUseCustom ? ' selected' : '') + '>' + escapeHtml(m.name) + (m.isDefault ? ' (默认)' : '') + '</option>').join("") +
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
      } else if (view === "delivery-dashboard") {
        loadAndRenderDeliveryDashboard();
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

    function getNextStepHint(sliceStatus, hasObservation, deliveryStatus, isSliceDelivered) {
      if (deliveryStatus === "已交付" || isSliceDelivered) return { text: "✓ 已完成交付", cls: "next-hint next-hint-done" };
      if (sliceStatus === "观察") {
        if (hasObservation) {
          const canDeliver = roleHasPerm(PERMISSIONS.DELIVERY_CREATE);
          return { text: "下一步：交付人员处理交付" + (!canDeliver && currentRole ? "（当前角色无权操作）" : ""), cls: "next-hint next-hint-deliverer" };
        }
        const canObserve = roleHasPerm(PERMISSIONS.OBSERVATION_CREATE);
        return { text: "下一步：观察人员填写观察结果" + (!canObserve && currentRole ? "（当前角色无权操作）" : ""), cls: "next-hint next-hint-observer" };
      }
      if (["取样", "切割", "研磨", "染色"].includes(sliceStatus)) {
        const canAdvance = roleHasPerm(PERMISSIONS.STEP_ADVANCE);
        return { text: "下一步：制片人员推进工序" + (!canAdvance && currentRole ? "（当前角色无权操作）" : ""), cls: "next-hint next-hint-producer" };
      }
      return { text: "", cls: "" };
    }

    const ABNORMAL_MULTIPLIER = 2;
    const ABNORMAL_FIXED_DAYS = 3;
    const ABNORMAL_FIXED_HOURS = ABNORMAL_FIXED_DAYS * 24;

    function safeParseLogTime(isoStr) {
      if (!isoStr) return null;
      const t = new Date(isoStr).getTime();
      return isNaN(t) ? null : t;
    }

    function getParsedSliceLogs(slice) {
      const logs = Array.isArray(slice.logs) ? slice.logs : [];
      return logs.map(log => {
        const t = safeParseLogTime(log.at);
        return t === null ? null : { ...log, _time: t };
      }).filter(log => log !== null && log.step).sort((a, b) => a._time - b._time);
    }

    function sliceHasObservationForTiming(slice) {
      const observations = Array.isArray(slice.observations) ? slice.observations : [];
      if (observations.length > 0) return true;
      const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
      return legacyObs.length > 0;
    }

    function getSliceObservationTimeForTiming(slice) {
      const observations = Array.isArray(slice.observations) ? slice.observations : [];
      for (let i = observations.length - 1; i >= 0; i--) {
        const t = safeParseLogTime(observations[i].at);
        if (t !== null) return { time: t, iso: observations[i].at };
      }
      return null;
    }

    function getDeliveredSliceIdsForSample(sampleId) {
      const delivered = new Set();
      deliveries.forEach(d => {
        if (d.sampleId === sampleId) {
          (d.slices || []).forEach(s => delivered.add(s.id));
        }
      });
      return delivered;
    }

    function isSliceDoneForTiming(slice, sample, parsedLogs, deliveredSliceIds) {
      if (deliveredSliceIds && deliveredSliceIds.has(slice.id)) return true;
      if (sample && sample.delivery === "已交付") return true;
      const hasObs = sliceHasObservationForTiming(slice);
      const status = slice.status || "";
      if (hasObs && status === "观察") return true;
      if (parsedLogs && parsedLogs.length > 0) {
        const lastStep = parsedLogs[parsedLogs.length - 1].step;
        if (hasObs && lastStep === "观察") return true;
      }
      return false;
    }

    function getSliceStepDetailsForTiming(slice, sample, deliveredSliceIds, now) {
      const parsedLogs = getParsedSliceLogs(slice);
      if (!parsedLogs.length) return [];
      const done = isSliceDoneForTiming(slice, sample, parsedLogs, deliveredSliceIds);
      const obsTime = getSliceObservationTimeForTiming(slice);
      const details = [];
      for (let i = 0; i < parsedLogs.length; i++) {
        const currentStep = parsedLogs[i].step;
        const currentTime = parsedLogs[i]._time;
        let nextTime;
        if (i < parsedLogs.length - 1) {
          nextTime = parsedLogs[i + 1]._time;
        } else if (done) {
          if (obsTime && obsTime.time > currentTime) {
            nextTime = obsTime.time;
          } else {
            continue;
          }
        } else {
          nextTime = now;
        }
        details.push({
          step: currentStep,
          dwellHours: (nextTime - currentTime) / (1000 * 60 * 60)
        });
      }
      if (done && details.length === 0 && obsTime) {
        const firstLog = parsedLogs[0];
        details.push({
          step: firstLog.step,
          dwellHours: (obsTime.time - firstLog._time) / (1000 * 60 * 60)
        });
      }
      return details;
    }

    function computeStepAverages(sampleList) {
      const stepSums = {};
      const stepCounts = {};
      steps.forEach(s => { stepSums[s] = 0; stepCounts[s] = 0; });
      const now = Date.now();
      sampleList.forEach(sample => {
        if (!sample.slices) return;
        const deliveredSliceIds = getDeliveredSliceIdsForSample(sample.id);
        sample.slices.forEach(slice => {
          const stepDetails = getSliceStepDetailsForTiming(slice, sample, deliveredSliceIds, now);
          stepDetails.forEach(detail => {
            const currentStep = detail.step;
            const dwellHours = detail.dwellHours;
            if (stepSums[currentStep] !== undefined) {
              stepSums[currentStep] += dwellHours;
              stepCounts[currentStep]++;
            }
          });
        });
      });
      const avgs = {};
      steps.forEach(s => {
        avgs[s] = stepCounts[s] > 0 ? stepSums[s] / stepCounts[s] : 0;
      });
      return avgs;
    }

    function getSliceAbnormalInfo(slice, sample, deliveredSliceIds, stepAvgs) {
      const stepDetails = getSliceStepDetailsForTiming(slice, sample, deliveredSliceIds, Date.now());
      const abnormalSteps = [];
      stepDetails.forEach(detail => {
        const currentStep = detail.step;
        const dwellHours = detail.dwellHours;
        const stepAvg = stepAvgs[currentStep] || 0;
        const exceedsAvg = stepAvg > 0 && dwellHours > stepAvg * ABNORMAL_MULTIPLIER;
        const exceedsFixed = dwellHours > ABNORMAL_FIXED_HOURS;
        if (exceedsAvg || exceedsFixed) {
          abnormalSteps.push({
            step: currentStep,
            dwellHours,
            exceedsAvg,
            exceedsFixed,
            stepAvg
          });
        }
      });
      return {
        hasAbnormal: abnormalSteps.length > 0,
        abnormalStepCount: abnormalSteps.length,
        abnormalSteps
      };
    }

    function getSampleAbnormalInfo(sample, stepAvgs) {
      let totalAbnormal = 0;
      const abnormalSliceIds = [];
      const deliveredSliceIds = getDeliveredSliceIdsForSample(sample.id);
      if (sample.slices) {
        sample.slices.forEach(slice => {
          const info = getSliceAbnormalInfo(slice, sample, deliveredSliceIds, stepAvgs);
          if (info.hasAbnormal) {
            totalAbnormal += info.abnormalStepCount;
            abnormalSliceIds.push(slice.id);
          }
        });
      }
      return {
        hasAbnormal: totalAbnormal > 0,
        totalAbnormalSteps: totalAbnormal,
        abnormalSliceCount: abnormalSliceIds.length,
        abnormalSliceIds
      };
    }

    function canSliceAdvance(slice, sample, deliveredSliceIds) {
      const errors = [];
      const producerSteps = ["取样", "切割", "研磨", "染色"];
      if (!slice) {
        errors.push("切片不存在");
        return { valid: false, errors };
      }
      if (deliveredSliceIds && deliveredSliceIds.has(slice.id)) {
        errors.push("该切片已交付，无法推进");
        return { valid: false, errors };
      }
      if (sample && sample.delivery === "已交付") {
        errors.push("所属样本已全部交付，无法推进");
        return { valid: false, errors };
      }
      const currentStep = slice.status;
      if (!roleHasPerm(PERMISSIONS.STEP_ADVANCE)) {
        errors.push("当前角色无推进制片步骤权限");
        return { valid: false, errors };
      }
      if (!producerSteps.includes(currentStep)) {
        errors.push("当前步骤不属于制片工序，无法推进");
        return { valid: false, errors };
      }
      const currentIdx = producerSteps.indexOf(currentStep);
      if (currentIdx >= producerSteps.length - 1) {
        errors.push("当前步骤已是制片最后一步，无法继续推进");
        return { valid: false, errors };
      }
      return { valid: true, errors, nextStep: producerSteps[currentIdx + 1] };
    }

    function validateBatchAdvance(selectedSliceIds, allSlices, deliveredSliceIds) {
      const sliceMap = new Map();
      allSlices.forEach(item => {
        if (item.slice && item.slice.id) {
          sliceMap.set(item.slice.id, item);
        }
      });

      const validItems = [];
      const sliceErrors = [];
      const producerSteps = ["取样", "切割", "研磨", "染色"];

      selectedSliceIds.forEach(sliceId => {
        const item = sliceMap.get(sliceId);
        if (!item) {
          sliceErrors.push({
            sliceId,
            errorCode: "SLICE_NOT_FOUND",
            errorCategory: "individual",
            error: "切片「" + sliceId + "」不存在"
          });
          return;
        }

        const { sample, slice } = item;
        const check = canSliceAdvance(slice, sample, deliveredSliceIds);
        if (!check.valid) {
          sliceErrors.push({
            sliceId,
            sampleId: sample.id,
            currentStep: slice.status,
            errorCode: "ADVANCE_NOT_ALLOWED",
            errorCategory: "individual",
            error: check.errors.join("；")
          });
          return;
        }

        validItems.push({
          sample,
          slice,
          nextStep: check.nextStep,
          currentStep: slice.status
        });
      });

      if (validItems.length === 0) {
        return {
          valid: false,
          errorType: "individual_validation_failed",
          validItems,
          sliceErrors,
          consistencyErrors: [],
          fromStep: null,
          targetStep: null,
          validCount: 0,
          errorCount: sliceErrors.length
        };
      }

      const consistencyErrors = [];
      const fromSteps = [...new Set(validItems.map(v => v.currentStep))];
      if (fromSteps.length > 1) {
        consistencyErrors.push({
          errorCode: "INCONSISTENT_STEP",
          errorCategory: "consistency",
          error: "所选切片处于不同工序步骤，批量推进需选择同一工序步骤的切片",
          details: { stepsFound: fromSteps }
        });
      }

      const sampleStatuses = [...new Set(validItems.map(v => v.sample.status))];
      if (sampleStatuses.length > 1) {
        consistencyErrors.push({
          errorCode: "INCONSISTENT_SAMPLE_STATUS",
          errorCategory: "consistency",
          error: "所选切片所属样本的状态不一致，批量推进需选择状态相同的样本切片",
          details: { sampleStatusesFound: sampleStatuses }
        });
      }

      const fromStep = validItems[0].currentStep;
      const targetStep = validItems[0].nextStep;

      if (consistencyErrors.length > 0) {
        return {
          valid: false,
          errorType: "consistency_validation_failed",
          validItems,
          sliceErrors,
          consistencyErrors,
          fromStep,
          targetStep,
          validCount: validItems.length,
          errorCount: sliceErrors.length
        };
      }

      return {
        valid: true,
        errorType: null,
        validItems,
        sliceErrors,
        consistencyErrors: [],
        fromStep,
        targetStep,
        sampleStatus: sampleStatuses[0],
        validCount: validItems.length,
        errorCount: sliceErrors.length
      };
    }

    function renderWorkbench() {
      try {
        workbenchError = null;
        const filters = getFilters();
        const filtered = applyFilters(samples, filters);
        const allSlices = getAllSlicesWithSample(filtered);
        const groups = groupSlicesByStep(allSlices);
        const totalSlices = allSlices.length;
        
        const deliveredSliceIds = new Set();
        deliveries.forEach(d => {
          d.slices.forEach(s => deliveredSliceIds.add(s.id));
        });

        workbenchCountEl.textContent = totalSlices ? "工作台：共 " + totalSlices + " 个切片任务" : "没有符合条件的切片任务";

        if (!samples.length) {
          workbenchEl.innerHTML = '<div class="workbench-error">数据加载中，请稍后...</div>';
          return;
        }

        const canStepAdvance = roleHasPerm(PERMISSIONS.STEP_ADVANCE);
        const producerSteps = ["取样", "切割", "研磨", "染色"];
        const selectableSlices = allSlices.filter(item => {
          const slice = item.slice || {};
          const sample = item.sample || {};
          return canStepAdvance && canSliceAdvance(slice, sample, deliveredSliceIds).valid;
        });

        let toolbarHtml = "";
        if (canStepAdvance && selectableSlices.length > 0) {
          const producerStepGroups = {};
          producerSteps.forEach(s => { producerStepGroups[s] = []; });
          selectableSlices.forEach(item => {
            const status = item.slice.status || producerSteps[0];
            if (producerStepGroups[status]) producerStepGroups[status].push(item);
          });

          const currentStepCounts = producerSteps.map(s => {
            const count = producerStepGroups[s] ? producerStepGroups[s].length : 0;
            return count > 0 ? '<span class="pill">' + s + '：' + count + ' 可推进</span>' : "";
          }).filter(Boolean).join(" ");

          toolbarHtml = '<div class="workbench-toolbar">' +
            '<div class="workbench-toolbar-left">' +
              '<label class="batch-select-label">' +
                '<input type="checkbox" id="batch-select-all" ' + (selectedSlices.size === selectableSlices.length && selectableSlices.length > 0 ? 'checked' : '') + '> ' +
                '批量选择' +
              '</label>' +
              (selectedSlices.size > 0 ? '<span class="batch-selected-count">已选择 ' + selectedSlices.size + ' 个</span>' : '') +
              '<span class="meta" style="font-size:12px;">可推进步骤：' + currentStepCounts + '</span>' +
            '</div>' +
            '<div class="workbench-toolbar-right">' +
              (selectedSlices.size > 0 ? '<button type="button" class="batch-advance-btn" id="batch-advance-btn">批量推进到下一步</button>' : '') +
              (selectedSlices.size > 0 ? '<button type="button" class="secondary" id="batch-clear-btn">清除选择</button>' : '') +
            '</div>' +
          '</div>';
        }

        workbenchEl.innerHTML = toolbarHtml + steps.map((step, index) => {
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
            const sliceObs = slice.observations || [];
            const sliceLegacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
            const sliceDelivered = deliveredSliceIds.has(slice.id);
            const wbNextHint = getNextStepHint(slice.status, sliceObs.length > 0 || sliceLegacyObs.length > 0, sample.delivery || "", sliceDelivered);
            const wbNextHintHtml = wbNextHint.text ? '<div class="' + wbNextHint.cls + '">' + wbNextHint.text + '</div>' : '';

            const isSelectable = canStepAdvance && canSliceAdvance(slice, sample, deliveredSliceIds).valid;
            const isSelected = selectedSlices.has(sliceId);
            const cardClass = isSelectable ? 'workbench-card has-checkbox' : 'workbench-card';
            const selectedClass = isSelected ? ' selected' : '';

            let checkboxHtml = "";
            if (isSelectable) {
              checkboxHtml = '<input type="checkbox" class="workbench-card-checkbox" data-slice-checkbox="' + sliceId + '" ' + (isSelected ? 'checked' : '') + '>';
            }

            return '<div class="' + cardClass + selectedClass + '" data-workbench-card="' + sampleId + '|' + sliceId + '">' +
              checkboxHtml +
              '<div class="workbench-card-id">' + sliceId + '</div>' +
              '<div class="workbench-card-meta">' + method + '</div>' +
              '<div class="workbench-card-meta">' + borehole + ' · ' + coreBox + ' · ' + depth + '</div>' +
              '<div class="workbench-card-project">' + project + ' · ' + owner + '</div>' +
              wbNextHintHtml +
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
        bindBatchSelectionEvents();
        applyRoleToUI();
      } catch (err) {
        workbenchError = err.message;
        workbenchEl.innerHTML = '<div class="workbench-error">工作台加载失败：' + err.message + '<br><button type="button" class="secondary" style="margin-top:10px;" onclick="location.reload()">重新加载</button></div>';
      }
    }

    function bindBatchSelectionEvents() {
      const selectAllCheckbox = document.querySelector("#batch-select-all");
      if (selectAllCheckbox) {
        selectAllCheckbox.onchange = () => {
          const filters = getFilters();
          const filtered = applyFilters(samples, filters);
          const allSlices = getAllSlicesWithSample(filtered);
          const deliveredSliceIds = new Set();
          deliveries.forEach(d => d.slices.forEach(s => deliveredSliceIds.add(s.id)));
          const selectableSlices = allSlices.filter(item => {
            const slice = item.slice || {};
            const sample = item.sample || {};
            return canSliceAdvance(slice, sample, deliveredSliceIds).valid;
          });

          if (selectAllCheckbox.checked) {
            selectableSlices.forEach(item => selectedSlices.add(item.slice.id));
          } else {
            selectedSlices.clear();
          }
          renderWorkbench();
        };
      }

      const clearBtn = document.querySelector("#batch-clear-btn");
      if (clearBtn) {
        clearBtn.onclick = () => {
          selectedSlices.clear();
          renderWorkbench();
        };
      }

      const advanceBtn = document.querySelector("#batch-advance-btn");
      if (advanceBtn) {
        advanceBtn.onclick = () => {
          openBatchAdvanceModal();
        };
      }

      document.querySelectorAll(".workbench-card-checkbox").forEach(checkbox => {
        checkbox.onclick = (e) => {
          e.stopPropagation();
        };
        checkbox.onchange = (e) => {
          e.stopPropagation();
          const sliceId = checkbox.dataset.sliceCheckbox;
          if (checkbox.checked) {
            selectedSlices.add(sliceId);
          } else {
            selectedSlices.delete(sliceId);
          }
          renderWorkbench();
        };
      });
    }

    function openBatchAdvanceModal() {
      if (selectedSlices.size === 0) return;

      const filters = getFilters();
      const filtered = applyFilters(samples, filters);
      const allSlices = getAllSlicesWithSample(filtered);
      const deliveredSliceIds = new Set();
      deliveries.forEach(d => d.slices.forEach(s => deliveredSliceIds.add(s.id)));

      const validation = validateBatchAdvance(
        Array.from(selectedSlices),
        allSlices,
        deliveredSliceIds
      );

      if (!validation.valid) {
        let errorMsg = "";
        let detailMsg = "";

        if (validation.errorType === "consistency_validation_failed" && validation.consistencyErrors.length > 0) {
          const firstConsistencyError = validation.consistencyErrors[0];
          errorMsg = firstConsistencyError.error;
          if (firstConsistencyError.details) {
            if (firstConsistencyError.details.stepsFound) {
              detailMsg = "当前选中步骤：" + firstConsistencyError.details.stepsFound.join("、");
            } else if (firstConsistencyError.details.deliveryStatusesFound) {
              detailMsg = "当前交付状态：" + firstConsistencyError.details.deliveryStatusesFound.join("、");
            } else if (firstConsistencyError.details.sampleStatusesFound) {
              detailMsg = "当前样本状态：" + firstConsistencyError.details.sampleStatusesFound.join("、");
            }
          }
          if (validation.sliceErrors.length > 0) {
            detailMsg += "\\n另有 " + validation.sliceErrors.length + " 个切片存在单独问题";
          }
        } else if (validation.errorType === "individual_validation_failed") {
          if (validation.sliceErrors.length > 0) {
            const firstError = validation.sliceErrors[0];
            errorMsg = firstError.error;
            if (validation.sliceErrors.length > 1) {
              detailMsg = "共 " + validation.sliceErrors.length + " 个切片无法推进";
            }
          } else {
            errorMsg = "没有可推进的切片";
          }
        } else {
          errorMsg = "校验失败，请检查选中的切片";
        }

        const fullMsg = errorMsg + (detailMsg ? "\\n\\n" + detailMsg : "");
        alert(fullMsg);
        return;
      }

      const { fromStep, targetStep, validItems } = validation;

      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.innerHTML = '<h2>批量推进步骤</h2>' +
        '<div class="batch-modal-step-info">' +
          '<span class="step-badge">' + fromStep + '</span>' +
          '<span class="step-arrow">→</span>' +
          '<span class="step-badge next">' + targetStep + '</span>' +
        '</div>' +
        '<div class="meta" style="margin-bottom:12px;">将批量推进 <b>' + validItems.length + '</b> 个切片，涉及 <b>' + (new Set(validItems.map(i => i.sample.id))).size + '</b> 个样本：' + validItems.slice(0, 10).map(i => i.slice.id).join("、") + (validItems.length > 10 ? '...' : '') + '</div>' +
        '<div>' +
          '<label>统一备注（可选，将应用到所有选中的切片）</label>' +
          '<textarea id="batch-note" placeholder="例如：完成' + fromStep + '，准备进入' + targetStep + '"></textarea>' +
        '</div>' +
        '<div id="batch-result" style="margin-top:10px;"></div>' +
        '<div class="modal-footer">' +
          '<button type="button" class="secondary" id="batch-cancel">取消</button>' +
          '<button type="button" id="batch-confirm">确认批量推进</button>' +
        '</div>';
      mask.appendChild(modal);
      modalRoot.appendChild(mask);

      modal.querySelector("#batch-cancel").onclick = () => mask.remove();
      mask.onclick = e => { if (e.target === mask) mask.remove(); };

      modal.querySelector("#batch-confirm").onclick = async () => {
        const note = modal.querySelector("#batch-note").value.trim();
        const confirmBtn = modal.querySelector("#batch-confirm");
        const resultEl = modal.querySelector("#batch-result");

        try {
          confirmBtn.disabled = true;
          confirmBtn.textContent = "处理中...";
          resultEl.innerHTML = "";

          const validSliceIds = validItems.map(item => item.slice.id);
          const result = await api('/api/slices/batch-advance', {
            method: 'POST',
            body: JSON.stringify({
              sliceIds: validSliceIds,
              note: note
            })
          });

          if (result && result.success) {
            const successMsg = '成功推进 ' + result.advancedCount + ' 个切片' +
              (result.failedCount > 0 ? '，失败 ' + result.failedCount + ' 个' : '') +
              '，从「' + result.fromStep + '」推进到「' + result.targetStep + '」' +
              (result.sampleCount ? '，涉及 ' + result.sampleCount + ' 个样本' : '');

            let errorHtml = "";
            if (result.sliceErrors && result.sliceErrors.length > 0) {
              errorHtml = '<div class="batch-error-list">' +
                '<div style="font-weight:600;color:var(--danger);margin-bottom:6px;">失败切片详情：</div>' +
                result.sliceErrors.map(e => {
                  return '<div class="batch-error-item"><span class="slice-id">' + e.sliceId + '</span>：' + escapeHtml(e.error) + '</div>';
                }).join("") +
              '</div>';
            }

            resultEl.innerHTML = '<div class="batch-success-info">✓ ' + successMsg + '</div>' + errorHtml;

            confirmBtn.textContent = "操作完成";
            confirmBtn.style.display = "none";
            modal.querySelector("#batch-cancel").textContent = "关闭";

            selectedSlices.clear();
            await Promise.all([
              load(),
              loadAndRenderStats()
            ]);
          }
        } catch (err) {
          let errorMsg = err.message || "操作失败";
          let errorHtml = "";
          try {
            const parsed = JSON.parse(errorMsg);
            if (parsed.errorType === "consistency_validation_failed" && parsed.consistencyErrors && parsed.consistencyErrors.length > 0) {
              errorMsg = parsed.error || "批量推进校验失败";
              const consistencyHtml = '<div class="batch-error-list">' +
                '<div style="font-weight:600;color:var(--danger);margin-bottom:6px;">一致性校验失败：</div>' +
                parsed.consistencyErrors.map(e => {
                  let detail = "";
                  if (e.details) {
                    if (e.details.stepsFound) {
                      detail = "（当前步骤：" + e.details.stepsFound.join("、") + "）";
                    } else if (e.details.deliveryStatusesFound) {
                      detail = "（当前状态：" + e.details.deliveryStatusesFound.join("、") + "）";
                    } else if (e.details.sampleStatusesFound) {
                      detail = "（当前状态：" + e.details.sampleStatusesFound.join("、") + "）";
                    }
                  }
                  return '<div class="batch-error-item">' + escapeHtml(e.error) + detail + '</div>';
                }).join("") +
              '</div>';
              if (parsed.sliceErrors && parsed.sliceErrors.length > 0) {
                errorHtml = consistencyHtml +
                  '<div class="batch-error-list" style="margin-top:10px;">' +
                    '<div style="font-weight:600;color:var(--stone);margin-bottom:6px;">其他切片问题：</div>' +
                    parsed.sliceErrors.map(e => {
                      return '<div class="batch-error-item"><span class="slice-id">' + e.sliceId + '</span>：' + escapeHtml(e.error) + '</div>';
                    }).join("") +
                  '</div>';
              } else {
                errorHtml = consistencyHtml;
              }
            } else if (parsed.sliceErrors && parsed.sliceErrors.length > 0) {
              errorHtml = '<div class="batch-error-list">' +
                '<div style="font-weight:600;color:var(--danger);margin-bottom:6px;">错误详情：</div>' +
                parsed.sliceErrors.map(e => {
                  return '<div class="batch-error-item"><span class="slice-id">' + e.sliceId + '</span>：' + escapeHtml(e.error) + '</div>';
                }).join("") +
              '</div>';
              errorMsg = parsed.error || "部分切片无法推进";
            } else if (parsed.error) {
              errorMsg = parsed.error;
            }
          } catch (_) {}

          resultEl.innerHTML = '<div class="alert">' + escapeHtml(errorMsg) + '</div>' + errorHtml;
        } finally {
          confirmBtn.disabled = false;
          if (confirmBtn.style.display !== "none") {
            confirmBtn.textContent = "确认批量推进";
          }
        }
      };
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

    const OBS_FIELD_LABELS_LOCAL = { lithology: "岩性", minerals: "矿物", texture: "结构构造", remark: "备注" };
    const OBS_FIELDS_LOCAL = ["lithology", "minerals", "texture", "remark"];

    function renderObsCompareResult(obsA, obsB, containerEl, changesOnly) {
      const headers = OBS_FIELDS_LOCAL.map(f => OBS_FIELD_LABELS_LOCAL[f]);
      const changedFields = new Set();
      if (changesOnly) {
        OBS_FIELDS_LOCAL.forEach(f => {
          const a = (obsA && obsA[f]) || "";
          const b = (obsB && obsB[f]) || "";
          if (a !== b) changedFields.add(f);
        });
      }
      const rowsHtml = OBS_FIELDS_LOCAL.map(f => {
        const a = (obsA && obsA[f]) || "";
        const b = (obsB && obsB[f]) || "";
        const changed = a !== b;
        if (changesOnly && !changed) return "";
        const rowClass = changed ? "" : "unchanged";
        const oldDisp = a ? escapeHtml(a) : '<span style="color:var(--muted);font-style:italic;">（空）</span>';
        const newDisp = b ? escapeHtml(b) : '<span style="color:var(--muted);font-style:italic;">（空）</span>';
        return '<div class="obs-compare-row ' + rowClass + '">' +
          '<div class="field-label">' + OBS_FIELD_LABELS_LOCAL[f] + '</div>' +
          '<div class="old-val">' + oldDisp + '</div>' +
          '<div class="new-val">' + newDisp + '</div>' +
        '</div>';
      }).join("");
      const hasChanges = changedFields.size > 0;
      const headerInfo = '<div style="margin-bottom:10px;font-size:12px;color:var(--stone);">' +
        '<b style="color:var(--danger);">● 旧版</b> ' + (obsA ? (escapeHtml(obsA.id) + ' · ' + formatObsDate(obsA.at)) : '（无）') +
        ' &nbsp;→&nbsp; ' +
        '<b style="color:var(--accent);">● 新版</b> ' + (obsB ? (escapeHtml(obsB.id) + ' · ' + formatObsDate(obsB.at)) : '（无）') +
        (changesOnly ? (hasChanges ? '（共 ' + changedFields.size + ' 个字段变化）' : '（两版完全一致）') : '') +
      '</div>';
      if (changesOnly && !hasChanges) {
        containerEl.innerHTML = '<div class="obs-compare-result"><h3>📊 版本对比结果</h3>' + headerInfo + '<div class="obs-compare-empty">两版观察记录完全一致，没有字段变化。</div></div>';
        return;
      }
      containerEl.innerHTML = '<div class="obs-compare-result"><h3>📊 版本对比结果' + (changesOnly ? '（仅显示变化字段）' : '') + '</h3>' + headerInfo +
        '<div class="obs-compare-headers"><div>字段</div><div>旧版（' + (obsA ? escapeHtml(obsA.id) : '-') + '）</div><div>新版（' + (obsB ? escapeHtml(obsB.id) : '-') + '）</div></div>' +
        rowsHtml +
      '</div>';
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
      let compareMode = false;
      let selectedObsIds = [];
      const obsOrderedDesc = observations.slice().reverse();
      let historyHtml = "";
      if (observations.length > 0) {
        const canCompare = observations.length >= 2;
        const toggleHtml = canCompare ? '<div class="obs-compare-toggle"><button type="button" class="secondary" id="obs-compare-toggle">🔀 开启版本对比</button><span id="obs-compare-hint" style="font-size:12px;color:var(--muted);display:none;"></span></div>' : '';
        const bannerHtml = canCompare ? '<div id="obs-compare-banner" style="display:none;" class="obs-compare-banner"></div>' : '';
        historyHtml = '<div class="obs-history"><h3 style="margin:0 0 8px;font-size:14px;color:var(--stone);">历史观察记录（共 ' + observations.length + ' 条）</h3>' +
          toggleHtml + bannerHtml +
          '<div id="obs-history-list">' +
          obsOrderedDesc.map((obs, idx) => {
            const revIdx = observations.length - 1 - idx;
            return '<div class="obs-history-item" data-obs-id="' + obs.id + '" data-obs-index="' + revIdx + '">' +
              '<div class="obs-header">' +
                '<b>' + obs.id + '</b>' +
                '<span class="obs-date">' + formatObsDate(obs.at) + '</span>' +
              '</div>' +
              (obs.lithology ? '<div class="obs-row"><b>岩性：</b>' + escapeHtml(obs.lithology) + '</div>' : '') +
              (obs.minerals ? '<div class="obs-row"><b>矿物：</b>' + escapeHtml(obs.minerals) + '</div>' : '') +
              (obs.texture ? '<div class="obs-row"><b>结构构造：</b>' + escapeHtml(obs.texture) + '</div>' : '') +
              (obs.remark ? '<div class="obs-row"><b>备注：</b>' + escapeHtml(obs.remark) + '</div>' : '') +
            '</div>';
          }).join("") +
          '</div>' +
          '<div id="obs-compare-result-container"></div>' +
        '</div>';
      } else if (hasLegacyOnly) {
        historyHtml = '<div class="obs-history"><h3 style="margin:0 0 8px;font-size:14px;color:var(--stone);">历史观察记录</h3><div class="obs-history-item"><div class="obs-header"><b>历史记录</b></div><div class="obs-row">' + escapeHtml(legacyObs) + '</div></div></div>';
      }
      modal.innerHTML = '<h2>观察结果归档 — ' + slice.id + '</h2><div class="meta">' + sample.project + ' · ' + sample.borehole + ' · ' + sample.coreBox + ' · ' + slice.method + '</div><div style="margin-top:14px;"><label>岩性描述</label><textarea id="obs-lithology" placeholder="如：中细粒砂岩、硅化蚀变岩、灰岩等">' + (lastObs ? escapeHtml(lastObs.lithology || "") : "") + '</textarea></div><div><label>矿物组合</label><textarea id="obs-minerals" placeholder="如：石英70%+长石15%+黄铁矿10%+其他5%">' + (lastObs ? escapeHtml(lastObs.minerals || "") : "") + '</textarea></div><div><label>结构构造</label><textarea id="obs-texture" placeholder="如：他形晶粒结构，浸染状构造；晶粒结构，块状构造">' + (lastObs ? escapeHtml(lastObs.texture || "") : "") + '</textarea></div><div><label>备注</label><textarea id="obs-remark" placeholder="其他观察记录或补充说明">' + (lastObs ? escapeHtml(lastObs.remark || "") : (hasLegacyOnly ? escapeHtml(legacyObs) : "")) + '</textarea></div><div id="obs-alert" style="margin-top:10px;"></div>' + historyHtml + '<div class="modal-footer"><button type="button" class="secondary" id="obs-cancel">取消</button><button type="button" id="obs-save">保存观察记录</button></div>';
      mask.appendChild(modal);
      modalRoot.appendChild(mask);

      function refreshCompareUI() {
        const historyList = modal.querySelector("#obs-history-list");
        const items = historyList ? historyList.querySelectorAll(".obs-history-item") : [];
        items.forEach(item => {
          const obsId = item.dataset.obsId;
          item.classList.toggle("compare-mode", compareMode);
          item.classList.toggle("selected", selectedObsIds.includes(obsId));
          const header = item.querySelector(".obs-header");
          let checkHtml = '';
          if (compareMode) {
            const selIdx = selectedObsIds.indexOf(obsId);
            const badge = selIdx >= 0 ? (' <span style="background:#e6b800;color:#fff;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;margin-left:4px;">第' + (selIdx + 1) + '版</span>') : '';
            checkHtml = '<input type="checkbox" class="compare-checkbox" ' + (selIdx >= 0 ? 'checked' : '') + '>' + badge;
          }
          const existingCheck = header.querySelector(".compare-checkbox");
          if (existingCheck) existingCheck.remove();
          const existingBadge = header.querySelector('span[style*="background:#e6b800"]');
          if (existingBadge) existingBadge.remove();
          if (checkHtml) header.insertAdjacentHTML("afterbegin", checkHtml);
        });
        const banner = modal.querySelector("#obs-compare-banner");
        const hint = modal.querySelector("#obs-compare-hint");
        const toggleBtn = modal.querySelector("#obs-compare-toggle");
        if (toggleBtn) {
          toggleBtn.textContent = compareMode ? "✖ 关闭版本对比" : "🔀 开启版本对比";
          toggleBtn.classList.toggle("danger", compareMode);
        }
        if (hint) {
          hint.style.display = compareMode ? "" : "none";
          hint.textContent = compareMode ? "请选择两个版本进行对比..." : "";
        }
        if (banner) {
          if (compareMode && selectedObsIds.length > 0) {
            banner.style.display = "";
            const clearBtn = selectedObsIds.length > 0 ? '<button type="button" class="secondary" id="obs-compare-clear">清除选择</button>' : '';
            const doBtn = selectedObsIds.length === 2 ? '<button type="button" id="obs-compare-do">📊 对比选中版本</button>' : '';
            let text = "";
            if (selectedObsIds.length === 0) text = "请点击历史记录条目选择两个版本进行对比";
            else if (selectedObsIds.length === 1) text = "已选择第1版：" + selectedObsIds[0] + "，请再选一个版本";
            else text = "已选好2个版本，可以开始对比";
            banner.innerHTML = '<span>' + text + '（共选 ' + selectedObsIds.length + '/2）</span><span style="display:flex;gap:6px;">' + clearBtn + doBtn + '</span>';
            const clearBtnEl = banner.querySelector("#obs-compare-clear");
            if (clearBtnEl) clearBtnEl.onclick = () => { selectedObsIds = []; refreshCompareUI(); modal.querySelector("#obs-compare-result-container").innerHTML = ""; };
            const doBtnEl = banner.querySelector("#obs-compare-do");
            if (doBtnEl) doBtnEl.onclick = async () => {
              if (selectedObsIds.length !== 2) return;
              doBtnEl.disabled = true;
              doBtnEl.textContent = "对比中...";
              try {
                const result = await api('/api/samples/' + sampleId + '/slices/' + sliceId + '/observations/compare', {
                  method: 'POST',
                  body: JSON.stringify({ observationIds: selectedObsIds })
                });
                const container = modal.querySelector("#obs-compare-result-container");
                if (container) {
                  renderObsCompareResult(result.observationA, result.observationB, container, true);
                  if (container.firstChild) {
                    container.firstChild.scrollIntoView({ behavior: "smooth", block: "nearest" });
                  }
                }
              } catch (err) {
                alert("对比失败：" + (err.message || "未知错误"));
              } finally {
                doBtnEl.disabled = false;
                doBtnEl.textContent = "📊 对比选中版本";
              }
            };
          } else {
            banner.style.display = "none";
          }
        }
      }

      function bindHistoryItemEvents() {
        const historyList = modal.querySelector("#obs-history-list");
        if (!historyList) return;
        const items = historyList.querySelectorAll(".obs-history-item");
        items.forEach(item => {
          item.onclick = (e) => {
            if (!compareMode) return;
            e.stopPropagation();
            const obsId = item.dataset.obsId;
            const idx = selectedObsIds.indexOf(obsId);
            if (idx >= 0) {
              selectedObsIds.splice(idx, 1);
            } else {
              if (selectedObsIds.length >= 2) {
                selectedObsIds.shift();
              }
              selectedObsIds.push(obsId);
            }
            refreshCompareUI();
          };
        });
      }

      const toggleBtn = modal.querySelector("#obs-compare-toggle");
      if (toggleBtn) {
        toggleBtn.onclick = () => {
          compareMode = !compareMode;
          if (!compareMode) {
            selectedObsIds = [];
            const container = modal.querySelector("#obs-compare-result-container");
            if (container) container.innerHTML = "";
          }
          refreshCompareUI();
        };
      }
      bindHistoryItemEvents();
      refreshCompareUI();

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
      const stepAvgs = computeStepAverages(filtered);
      let abnormalSampleCount = 0;
      filtered.forEach(s => {
        const info = getSampleAbnormalInfo(s, stepAvgs);
        if (info.hasAbnormal) abnormalSampleCount++;
      });
      resultCountEl.innerHTML = filtered.length ? "筛选结果：共 " + filtered.length + " 个样本" + (abnormalSampleCount > 0 ? '，其中 <b style="color:var(--danger);">' + abnormalSampleCount + '</b> 个含异常耗时' : '') : "没有符合条件的样本";
      if (!filtered.length) {
        samplesEl.innerHTML = '<div class="empty">没有符合筛选条件的样本，请调整筛选条件。</div>';
        return;
      }
      
      const allDeliveredSliceIds = new Set();
      deliveries.forEach(d => d.slices.forEach(s => allDeliveredSliceIds.add(s.id)));
      
      samplesEl.innerHTML = filtered.map(sample => {
        const sampleAbnormal = getSampleAbnormalInfo(sample, stepAvgs);
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
        const sampleAbnormalHtml = sampleAbnormal.hasAbnormal
          ? '<div class="card-abnormal-banner" title="' + sampleAbnormal.abnormalSliceCount + '个切片存在异常耗时，共' + sampleAbnormal.totalAbnormalSteps + '个异常工序">⚠ 存在异常耗时（' + sampleAbnormal.abnormalSliceCount + '片/' + sampleAbnormal.totalAbnormalSteps + '步）</div>'
          : '';
        const deliveryHistory = deliveries.filter(d => d.sampleId === sample.id);
        const deliveredSliceIds = new Set();
        deliveryHistory.forEach(d => d.slices.forEach(s => deliveredSliceIds.add(s.id)));
        const deliveredCount = sample.slices.filter(s => deliveredSliceIds.has(s.id)).length;
        const totalSlices = sample.slices.length;
        
        let deliveryBadge = sample.delivery;
        if (sample.delivery === "部分交付") {
          deliveryBadge += '（' + deliveredCount + '/' + totalSlices + '）';
        }
        
        const deliveryHistoryHtml = deliveryHistory.length ? '<div class="meta" style="margin-top:6px;"><b style="color:var(--accent);">历史交付（'+deliveryHistory.length+'）：</b>' + deliveryHistory.map(d => d.id + '（' + (d.deliveryType === 'partial' ? '部分' : '全部') + '，' + d.slices.length + '片，' + formatObsDate(d.deliveredAt) + '）').join('、') + '</div>' : '';
        return '<article class="card' + (sampleAbnormal.hasAbnormal ? ' card-abnormal' : '') + '"><h3>'+sample.project+'</h3><div class="sample-id">'+sample.id+'</div><div><span class="pill">'+sample.status+'</span> <span class="pill">'+deliveryBadge+'</span></div><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div>' + sampleAbnormalHtml + summaryHtml + deliveryHistoryHtml + '<button type="button" class="secondary" data-batch-append="'+sample.id+'">批量追加切片</button>'+sample.slices.map(slice => {
          const sliceAbnormal = getSliceAbnormalInfo(slice, sample, deliveredSliceIds, stepAvgs);
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
          const isSliceDelivered = deliveredSliceIds.has(slice.id);
          const nextHint = getNextStepHint(slice.status, observations.length > 0 || legacyObs.length > 0, sample.delivery, isSliceDelivered);
          const nextHintHtml = nextHint.text ? '<div class="'+nextHint.cls+'">'+nextHint.text+'</div>' : '';
          const sliceAbnormalHtml = sliceAbnormal.hasAbnormal
            ? '<div class="slice-abnormal-tag" title="' + sliceAbnormal.abnormalStepCount + '个异常工序">' + sliceAbnormal.abnormalSteps.map(a => a.step + '（' + (a.dwellHours / 24).toFixed(1) + '天）').join('、') + ' 超时</div>'
            : '';
          return '<div class="slice' + (sliceAbnormal.hasAbnormal ? ' slice-abnormal' : '') + '"><b>'+slice.id+'</b> ' + (sliceAbnormal.hasAbnormal ? '<span class="slice-abnormal-badge" title="异常耗时">⚠</span>' : '') + '<div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div>'+sliceAbnormalHtml+nextHintHtml+'<select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button>' + obsBtn + obsSummaryHtml + '<div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>';
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
      const anySelectable = data.anySelectable;
      const selectableCount = data.selectableCount || 0;
      const deliveredCount = data.deliveredCount || 0;
      const undeliveredCount = data.undeliveredCount || 0;

      let selectedSlices = new Set();
      const selectableSlices = slices.filter(sl => sl.canSelect);
      selectableSlices.forEach(sl => selectedSlices.add(sl.id));

      const basicInfoHtml = '<div class="delivery-section"><h3>样本基础信息</h3><div class="delivery-basic-info"><div><b>样本编号：</b>' + s.id + '</div><div><b>所属项目：</b>' + s.project + '</div><div><b>钻孔编号：</b>' + s.borehole + '</div><div><b>岩芯箱号：</b>' + s.coreBox + '</div><div><b>取样深度：</b>' + s.depth + '</div><div><b>负责人：</b>' + s.owner + '</div><div><b>样本状态：</b>' + s.status + '</div><div><b>交付状态：</b>' + s.delivery + '</div><div><b>已交付切片：</b>' + deliveredCount + '/' + data.sliceCount + '</div><div><b>可交付切片：</b>' + selectableCount + '</div></div></div>';

      const sliceTableHtml = '<div class="delivery-section"><h3>切片选择（' + data.observedCount + '/' + data.sliceCount + ' 已完成观察）</h3><div style="margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;"><label style="margin:0;display:flex;align-items:center;gap:5px;cursor:pointer;"><input type="checkbox" id="select-all-slices" checked> 全选可交付切片</label><span class="meta" id="selected-count-label">已选择 ' + selectedSlices.size + ' 个切片</span></div><table class="slice-status-table"><thead><tr><th style="width:40px;">选择</th><th>切片编号</th><th>染色方法</th><th>当前步骤</th><th>观察结果</th><th>最近日志</th></tr></thead><tbody>' + slices.map(slice => {
        const isComplete = slice.status === "观察" && slice.hasObservation;
        const statusClass = isComplete ? "status-ok" : "status-warn";
        let statusText = "";
        let checkboxDisabled = "";
        let checkboxChecked = "";
        let rowClass = "";
        
        if (slice.isDelivered) {
          statusText = '<span class="status-ok">✓ 已交付</span>';
          checkboxDisabled = "disabled";
          rowClass = 'style="opacity:0.6;"';
        } else if (slice.status !== "观察") {
          statusText = '<span class="status-warn">未到观察步骤（当前：' + slice.status + '）</span>';
          checkboxDisabled = "disabled";
        } else if (!slice.hasObservation) {
          statusText = '<span class="status-warn">已到观察步骤但未填写结果</span>';
          checkboxDisabled = "disabled";
        } else {
          statusText = '<span class="status-ok">✓ 可交付</span>';
          checkboxChecked = "checked";
        }
        const obsSummary = slice.observationSummary ? slice.observationSummary : '<span class="meta">—</span>';
        const lastLogText = slice.lastLog ? (slice.lastLog.step + "：" + (slice.lastLog.note || "无备注")) : '<span class="meta">—</span>';
        return '<tr ' + rowClass + '><td><input type="checkbox" class="slice-select-checkbox" data-slice-id="' + slice.id + '" ' + checkboxChecked + ' ' + checkboxDisabled + '></td><td><b>' + slice.id + '</b></td><td>' + slice.method + '</td><td><span class="' + statusClass + '">' + slice.status + '</span></td><td>' + statusText + '<div style="font-size:11px;color:var(--muted);margin-top:3px;">' + obsSummary + '</div></td><td style="font-size:12px;">' + lastLogText + '</td></tr>';
      }).join("") + '</tbody></table></div>';

      let missingHtml = "";
      if (!anySelectable) {
        const missingReasons = slices.filter(s => !(s.status === "观察" && s.hasObservation && !s.isDelivered)).map(s => {
          if (s.isDelivered) {
            return s.id + ' — 已交付';
          } else if (s.status !== "观察") {
            return s.id + ' — 当前步骤为「' + s.status + '」，尚未进入观察步骤';
          } else {
            return s.id + ' — 已进入观察步骤但未填写观察结果';
          }
        });
        missingHtml = '<div class="delivery-section"><div class="missing-list"><b style="color:var(--danger);">⚠ 没有可交付的切片</b><ul>' + missingReasons.map(r => '<li>' + r + '</li>').join("") + '</ul></div></div>';
      } else if (!allObserved) {
        const missingReasons = slices.filter(s => !(s.status === "观察" && s.hasObservation) && !s.isDelivered).map(s => {
          if (s.status !== "观察") {
            return s.id + ' — 当前步骤为「' + s.status + '」，尚未进入观察步骤';
          } else {
            return s.id + ' — 已进入观察步骤但未填写观察结果';
          }
        });
        if (missingReasons.length > 0) {
          missingHtml = '<div class="delivery-section"><div class="missing-list" style="background:#fff8e6;border-color:#ffeeba;color:#856404;"><b style="color:#856404;">⚠ 部分切片尚未完成观察，可选择已完成的切片进行部分交付</b><ul>' + missingReasons.map(r => '<li>' + r + '</li>').join("") + '</ul></div></div>';
        } else {
          missingHtml = '<div class="delivery-section"><div class="complete-info">✓ 可以选择部分或全部切片进行交付</div></div>';
        }
      } else {
        missingHtml = '<div class="delivery-section"><div class="complete-info">✓ 全部切片已完成观察，可以生成全部或部分交付记录</div></div>';
      }

      const logsHtml = '<div class="delivery-section"><h3>步骤日志摘要（最近 ' + data.logsSummary.length + ' 条 / 共 ' + data.totalLogs + ' 条）</h3><div class="logs-summary">' + data.logsSummary.map(log => {
        return '<div class="logs-summary-item"><span class="log-time">' + formatObsDate(log.at) + '</span><span class="log-slice">' + log.sliceId + '</span><span class="log-step">' + log.step + '</span>' + (log.note || '<span class="meta">无备注</span>') + '</div>';
      }).join("") + '</div></div>';

      const formHtml = anySelectable ? '<div class="delivery-section"><h3>交付信息录入</h3><div class="delivery-form-row"><div><label>交付人 *</label><input id="dlv-deliveredBy" placeholder="请输入交付人姓名"></div><div><label>接收单位 *</label><input id="dlv-receivingUnit" placeholder="请输入接收单位名称"></div><div class="full"><label>备注</label><textarea id="dlv-remark" placeholder="请输入备注信息（选填）"></textarea></div></div><div id="dlv-alert" style="margin-top:10px;"></div></div>' : "";

      const footerHtml = '<div class="modal-footer"><button type="button" class="secondary" id="dlv-cancel">取消</button>' + (anySelectable ? '<button type="button" id="dlv-confirm">生成交付记录</button>' : "") + '</div>';

      modal.innerHTML = '<h2>交付确认 — ' + s.id + '</h2>' + basicInfoHtml + sliceTableHtml + missingHtml + logsHtml + formHtml + footerHtml;

      function updateSelectedCount() {
        const count = selectedSlices.size;
        const label = modal.querySelector("#selected-count-label");
        if (label) {
          label.textContent = '已选择 ' + count + ' 个切片';
        }
        const confirmBtn = modal.querySelector("#dlv-confirm");
        if (confirmBtn) {
          confirmBtn.disabled = count === 0;
          confirmBtn.style.opacity = count === 0 ? '0.5' : '1';
        }
        const selectAll = modal.querySelector("#select-all-slices");
        if (selectAll) {
          const checkboxes = modal.querySelectorAll(".slice-select-checkbox:not(:disabled)");
          const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
          selectAll.checked = allChecked;
        }
      }

      const selectAllCheckbox = modal.querySelector("#select-all-slices");
      if (selectAllCheckbox) {
        selectAllCheckbox.onchange = () => {
          const isChecked = selectAllCheckbox.checked;
          modal.querySelectorAll(".slice-select-checkbox:not(:disabled)").forEach(cb => {
            cb.checked = isChecked;
            const sliceId = cb.dataset.sliceId;
            if (isChecked) {
              selectedSlices.add(sliceId);
            } else {
              selectedSlices.delete(sliceId);
            }
          });
          updateSelectedCount();
        };
      }

      modal.querySelectorAll(".slice-select-checkbox").forEach(cb => {
        cb.onchange = () => {
          const sliceId = cb.dataset.sliceId;
          if (cb.checked) {
            selectedSlices.add(sliceId);
          } else {
            selectedSlices.delete(sliceId);
          }
          updateSelectedCount();
        };
      });

      modal.querySelector("#dlv-cancel").onclick = () => mask.remove();

      if (anySelectable) {
        const sampleOwner = s.owner || "";
        if (sampleOwner) {
          modal.querySelector("#dlv-deliveredBy").value = sampleOwner;
        }
        modal.querySelector("#dlv-confirm").onclick = async () => {
          const deliveredBy = modal.querySelector("#dlv-deliveredBy").value.trim();
          const receivingUnit = modal.querySelector("#dlv-receivingUnit").value.trim();
          const remark = modal.querySelector("#dlv-remark").value.trim();
          const alertEl = modal.querySelector("#dlv-alert");
          const sliceIds = Array.from(selectedSlices);
          
          if (!deliveredBy) {
            showAlert(alertEl, ["请填写交付人"]);
            return;
          }
          if (!receivingUnit) {
            showAlert(alertEl, ["请填写接收单位"]);
            return;
          }
          if (sliceIds.length === 0) {
            showAlert(alertEl, ["请至少选择一个切片"]);
            return;
          }
          try {
            await api('/api/samples/' + sampleId + '/deliveries', {
              method: 'POST',
              body: JSON.stringify({ deliveredBy, receivingUnit, remark, sliceIds })
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
        const deliveryTypeLabel = d.deliveryType === "partial" ? "部分交付" : "全部交付";
        const deliveryTypeClass = d.deliveryType === "partial" ? 'style="background:#fff8e6;color:#856404;border-color:#ffeeba;"' : "";
        return '<div class="delivery-card"><div class="delivery-card-header"><div><span class="delivery-card-id">' + d.id + '</span> <span class="method-badge" ' + deliveryTypeClass + '>' + deliveryTypeLabel + '</span></div><div class="delivery-card-time">' + formatObsDate(d.deliveredAt) + '</div></div><div class="delivery-card-info"><div><b>样本编号：</b>' + (ss.id || "-") + '</div><div><b>所属项目：</b>' + (ss.project || "-") + '</div><div><b>钻孔/箱号：</b>' + (ss.borehole || "-") + ' / ' + (ss.coreBox || "-") + '</div><div><b>取样深度：</b>' + (ss.depth || "-") + '</div><div><b>交付人：</b>' + d.deliveredBy + '</div><div><b>接收单位：</b>' + d.receivingUnit + '</div></div><div class="delivery-card-slices"><b>包含切片（' + d.slices.length + ' 个）：</b>' + d.slices.map(s => '<span class="slice-item">' + s.id + '（' + s.method + '）</span>').join("") + '</div>' + (d.remark ? '<div class="delivery-card-remark"><b>备注：</b>' + d.remark + '</div>' : "") + '</div>';
      }).join("");
    }

    async function loadAndRenderDeliveryDashboard() {
      if (!roleHasPerm(PERMISSIONS.DELIVERY_VIEW)) return;
      const summaryEl = document.querySelector("#dashboard-summary");
      const groupsEl = document.querySelector("#dashboard-groups");
      if (summaryEl) summaryEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);">加载中...</div>';
      try {
        const data = await api("/api/delivery-dashboard");
        renderDeliveryDashboard(data);
      } catch (err) {
        console.error("Failed to load delivery dashboard:", err);
        if (groupsEl) groupsEl.innerHTML = '<div class="dashboard-group-empty">加载交付看板失败：' + escapeHtml(err.message || "未知错误") + '</div>';
      }
    }

    function renderDeliveryDashboard(data) {
      const summaryEl = document.querySelector("#dashboard-summary");
      const groupsEl = document.querySelector("#dashboard-groups");
      const s = data.summary || {};
      const gs = s.groupStats || {};
      if (summaryEl) {
        summaryEl.innerHTML =
          '<div class="dashboard-kpi dashboard-kpi-undelivered"><strong>' + (s.undelivered || 0) + '</strong><span>未交付样本</span><div style="font-size:11px;color:var(--muted);margin-top:4px;">切片 ' + (gs["未交付"]?.totalSlices || 0) + ' · 可交付 ' + (gs["未交付"]?.deliverableSlices || 0) + '</div></div>' +
          '<div class="dashboard-kpi dashboard-kpi-partial"><strong>' + (s.partial || 0) + '</strong><span>部分交付样本</span><div style="font-size:11px;color:var(--muted);margin-top:4px;">已交 ' + (gs["部分交付"]?.deliveredSlices || 0) + ' · 可再交 ' + (gs["部分交付"]?.deliverableSlices || 0) + ' · 包数 ' + (gs["部分交付"]?.deliveryCount || 0) + '</div></div>' +
          '<div class="dashboard-kpi dashboard-kpi-delivered"><strong>' + (s.delivered || 0) + '</strong><span>已交付样本</span><div style="font-size:11px;color:var(--muted);margin-top:4px;">切片 ' + (gs["已交付"]?.totalSlices || 0) + ' · 包数 ' + (gs["已交付"]?.deliveryCount || 0) + '</div></div>' +
          '<div class="dashboard-kpi dashboard-kpi-total"><strong>' + (s.total || 0) + '</strong><span>样本总数</span><div style="font-size:11px;color:var(--muted);margin-top:4px;">切片 ' + (s.totalSlices || 0) + ' · 已交 ' + (s.totalDeliveredSlices || 0) + ' · 待可交 ' + (s.totalDeliverableSlices || 0) + '</div></div>' +
          '<div class="dashboard-kpi"><strong>' + (s.totalDeliveries || 0) + '</strong><span>累计交付包</span><div style="font-size:11px;color:var(--muted);margin-top:4px;">全项目统计</div></div>';
      }
      if (!groupsEl) return;
      const groups = data.groups || {};
      const groupConfigs = [
        { key: "未交付", label: "未交付", countCls: "dashboard-group-count-undelivered", barCls: "dashboard-slice-bar-fill-undelivered" },
        { key: "部分交付", label: "部分交付", countCls: "dashboard-group-count-partial", barCls: "dashboard-slice-bar-fill-partial" },
        { key: "已交付", label: "已交付", countCls: "dashboard-group-count-delivered", barCls: "dashboard-slice-bar-fill-delivered" }
      ];
      let html = "";
      groupConfigs.forEach(cfg => {
        const items = groups[cfg.key] || [];
        const gStat = gs[cfg.key] || {};
        html += '<div class="dashboard-group">';
        html += '<div class="dashboard-group-header"><h2>' + cfg.label + '</h2><span class="dashboard-group-count ' + cfg.countCls + '">' + items.length + ' 样本</span>';
        if (gStat.totalSlices) {
          html += '<span style="font-size:12px;color:var(--muted);margin-left:8px;">共 ' + gStat.totalSlices + ' 切片 · 已交付 ' + gStat.deliveredSlices + ' · 可再交付 ' + gStat.deliverableSlices + ' · 累计 ' + gStat.deliveryCount + ' 包</span>';
        }
        html += '</div>';
        if (!items.length) {
          html += '<div class="dashboard-group-empty">暂无' + cfg.label + '的样本</div>';
        } else {
          html += '<table class="dashboard-table"><thead><tr><th>样本编号</th><th>项目</th><th>钻孔/箱号</th><th>深度</th><th>负责人</th><th>制片状态</th><th>切片交付进度</th><th>剩余切片</th><th>累计交付</th><th>最近交付包</th></tr></thead><tbody>';
          items.forEach(item => {
            const total = item.totalSlices || 0;
            const delivered = item.deliveredSlices || 0;
            const remainingTotal = item.remainingTotal ?? (total - delivered);
            const remainingDeliverable = item.remainingDeliverable ?? 0;
            const remainingInProgress = item.remainingInProgress ?? remainingTotal;
            const pct = total > 0 ? Math.round(delivered / total * 100) : 0;
            let remainingHtml = "";
            if (remainingTotal === 0) {
              remainingHtml = '<span class="dashboard-remaining-badge dashboard-remaining-zero">全部完成</span>';
            } else {
              const parts = [];
              if (remainingDeliverable > 0) {
                parts.push('<span class="dashboard-remaining-badge dashboard-remaining-has" title="已完成观察可立即交付">可交付 ' + remainingDeliverable + '</span>');
              }
              if (remainingInProgress > 0) {
                parts.push('<span class="dashboard-remaining-badge dashboard-remaining-all" title="尚在制片流程中">制片中 ' + remainingInProgress + '</span>');
              }
              remainingHtml = parts.join(" ");
            }
            const deliveryCountHtml = item.deliveryCount
              ? '<div><b style="color:var(--accent);">' + item.deliveryCount + '</b> 包' +
                (item.firstDeliveredAt ? '<div style="font-size:11px;color:var(--muted);">首包: ' + formatObsDate(item.firstDeliveredAt) + '</div>' : '') +
                (item.lastDeliveredAt && item.deliveryCount > 1 ? '<div style="font-size:11px;color:var(--muted);">尾包: ' + formatObsDate(item.lastDeliveredAt) + '</div>' : '') +
                '</div>'
              : '<span class="dashboard-no-delivery">—</span>';
            const latestHtml = item.latestDelivery
              ? '<div class="dashboard-latest-delivery">' +
                '<div><b>' + item.latestDelivery.id + '</b>' +
                '<span class="delivery-type-tag ' + (item.latestDelivery.deliveryType === "partial" ? "delivery-type-tag-partial" : "delivery-type-tag-full") + '">' + (item.latestDelivery.deliveryType === "partial" ? "部分交付" : "全部交付") + '</span>' +
                '</div>' +
                '<div style="font-size:11px;color:var(--muted);">' + formatObsDate(item.latestDelivery.deliveredAt) + '</div>' +
                '<div style="font-size:11px;">👤 ' + item.latestDelivery.deliveredBy + ' → 🏛 ' + item.latestDelivery.receivingUnit + '</div>' +
                '<div style="font-size:11px;">📦 ' + item.latestDelivery.sliceCount + ' 片' + (item.latestDelivery.remark ? ' · ' + escapeHtml(item.latestDelivery.remark) : '') + '</div>' +
                '</div>'
              : '<span class="dashboard-no-delivery">—</span>';
            html += '<tr>' +
              '<td><b>' + item.sampleId + '</b></td>' +
              '<td>' + item.project + '</td>' +
              '<td>' + item.borehole + ' / ' + item.coreBox + '</td>' +
              '<td>' + item.depth + '</td>' +
              '<td>' + item.owner + '</td>' +
              '<td><span class="pill">' + item.status + '</span></td>' +
              '<td class="num"><div class="dashboard-slice-progress"><span class="dashboard-slice-bar"><span class="dashboard-slice-bar-fill ' + cfg.barCls + '" style="width:' + pct + '%;"></span></span> ' + delivered + '/' + total + ' <span style="color:var(--muted);font-size:11px;">(' + pct + '%)</span></div></td>' +
              '<td class="num">' + remainingHtml + '</td>' +
              '<td class="num">' + deliveryCountHtml + '</td>' +
              '<td>' + latestHtml + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';
      });
      groupsEl.innerHTML = html;
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
              const defaultBadge = m.isDefault && m.enabled ? '<span class="method-badge default">★ 默认</span>' : '';
              const defaultBtnText = m.isDefault ? '取消默认' : '设为默认';
              const defaultBtnClass = m.isDefault ? 'secondary' : '';
              return '<div class="method-item ' + itemClass + '" data-method-id="' + escapeHtml(m.id) + '">' +
                '<div class="method-item-main">' +
                  '<div class="method-name-row">' +
                    '<span class="method-name">' + escapeHtml(m.name) + '</span>' +
                    defaultBadge +
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
                  (m.enabled ? '<button type="button" ' + defaultBtnClass + ' data-method-default="' + escapeHtml(m.id) + '">' + defaultBtnText + '</button>' : '') +
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
        modal.querySelectorAll("[data-method-default]").forEach(btn => {
          btn.onclick = async () => {
            const id = btn.dataset.methodDefault;
            try {
              const method = methods.find(m => m.id === id);
              if (!method) return;
              if (method.isDefault) {
                if (!confirm('确认要取消「' + method.name + '」的默认工艺状态吗？')) {
                  return;
                }
              } else {
                if (!confirm('确认要将「' + method.name + '」设为默认工艺吗？\\n新建样本和批量追加切片时将默认选中此工艺。')) {
                  return;
                }
              }
              await api("/api/methods/" + id + "/default", { method: "PATCH" });
              await loadMethodDict();
              renderMethodConfigContent(modal, mask);
            } catch (err) {
              const alertEl = modal.querySelector("#method-alert");
              showAlert(alertEl, [err.message || "操作失败"]);
            }
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
                if (!confirm('确认要禁用工艺「' + method.name + '」吗？\\n该工艺已被使用 ' + usage + ' 次，禁用后不会影响历史切片记录，但在新增切片时将不再显示此选项。' + (method.isDefault ? '\\n注意：这是当前默认工艺，禁用后将自动切换到排序第一的启用工艺。' : ''))) {
                  return;
                }
              } else if (method.enabled && method.isDefault) {
                if (!confirm('确认要禁用默认工艺「' + method.name + '」吗？\\n禁用后将自动切换到排序第一的启用工艺。')) {
                  return;
                }
              }
              const result = await api("/api/methods/" + id + "/toggle", { method: "PATCH" });
              await loadMethodDict();
              renderMethodConfigContent(modal, mask);
              if (result && result.newDefaultMethod) {
                const alertEl = modal.querySelector("#method-alert");
                showAlert(alertEl, ["默认工艺已自动切换为「" + result.newDefaultMethod.name + "」"], "success");
              }
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
      const abnormalSteps = data.abnormalSteps || [];
      const abnormalConfig = data.abnormalConfig || { multiplier: 2, fixedDays: 3 };

      const totalSlices = timings.length;
      const completedSlices = timings.filter(t => t.isComplete).length;
      const validTimings = timings.filter(t => t.totalHours > 0);
      const avgTotalHours = validTimings.length > 0 ? validTimings.reduce((s, t) => s + t.totalHours, 0) / validTimings.length : 0;
      const maxTotalHours = validTimings.length > 0 ? Math.max(...validTimings.map(t => t.totalHours)) : 0;
      const abnormalSlicesCount = timings.filter(t => t.hasAbnormalStep).length;

      document.querySelector("#stats-overview").innerHTML =
        '<div class="stats-kpi"><strong>' + totalSlices + '</strong><span>切片总数</span></div>' +
        '<div class="stats-kpi"><strong>' + completedSlices + '</strong><span>已完成观察</span></div>' +
        '<div class="stats-kpi"><strong>' + formatHours(avgTotalHours) + '</strong><span>平均制片耗时</span></div>' +
        '<div class="stats-kpi"><strong>' + formatHours(maxTotalHours) + '</strong><span>最长制片耗时</span></div>' +
        '<div class="stats-kpi stats-kpi-abnormal"><strong>' + abnormalSlicesCount + '</strong><span>异常切片数</span></div>';

      document.querySelector("#stats-abnormal-config").innerHTML =
        '<div class="abnormal-config-info">' +
        '<span class="abnormal-config-label">判定规则：</span>' +
        '<span class="abnormal-config-item">超过工序平均值 <b>' + abnormalConfig.multiplier + '</b> 倍</span>' +
        '<span class="abnormal-config-sep">或</span>' +
        '<span class="abnormal-config-item">超过 <b>' + abnormalConfig.fixedDays + '</b> 天固定阈值</span>' +
        '<span class="abnormal-config-count">共 <b>' + abnormalSteps.length + '</b> 条异常记录</span>' +
        '</div>';

      document.querySelector("#stats-abnormal-list").innerHTML = abnormalSteps.length
        ? '<div class="stats-timing-scroll"><table class="stats-table abnormal-table"><thead><tr><th>切片编号</th><th>样本编号</th><th>项目</th><th>负责人</th><th>方法</th><th>异常工序</th><th>→ 下一工序</th><th>停留时长</th><th>开始时间</th><th>结束时间</th><th>异常原因</th></tr></thead><tbody>' +
          abnormalSteps.map(a => {
            return '<tr class="abnormal-row">' +
              '<td><b>' + a.sliceId + '</b></td>' +
              '<td>' + a.sampleId + '</td>' +
              '<td>' + a.project + '</td>' +
              '<td>' + a.owner + '</td>' +
              '<td>' + a.method + '</td>' +
              '<td><span class="abnormal-step-badge">' + a.step + '</span></td>' +
              '<td>' + (a.toStep || '—') + '</td>' +
              '<td class="num"><span class="abnormal-duration">' + formatHours(a.dwellHours) + '</span></td>' +
              '<td>' + formatObsDate(a.fromAt) + '</td>' +
              '<td>' + formatObsDate(a.toAt) + '</td>' +
              '<td class="abnormal-reasons">' + a.reasons.map(r => '<span class="abnormal-reason-tag">' + r + '</span>').join('') + '</td>' +
              '</tr>';
          }).join("") +
          '</tbody></table></div>'
        : '<div class="empty">暂无异常耗时记录，所有工序停留时间均在正常范围内。</div>';

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
            const hasAbnormal = !!t.hasAbnormalStep;
            const abnormalCount = t.abnormalStepCount || 0;
            const expandIcon = hasDetails ? '<span class="stats-expand-icon" data-slice-expand="' + t.sliceId + '">▸</span>' : '<span class="meta">—</span>';
            const abnormalBadge = hasAbnormal ? '<span class="abnormal-badge" title="包含' + abnormalCount + '个异常工序">⚠ ' + abnormalCount + '</span>' : '';
            let mainRow = '<tr class="stats-timing-main' + (hasDetails ? ' stats-expandable' : '') + (hasAbnormal ? ' stats-timing-abnormal' : '') + '" data-slice-id="' + t.sliceId + '">' +
              '<td>' + expandIcon + '</td>' +
              '<td><b>' + t.sliceId + '</b> ' + abnormalBadge + '</td>' +
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
                  const isAbnormal = !!d.isAbnormal;
                  const abnormalReasons = d.abnormalReasons || [];
                  let rowClass = isAbnormal ? 'abnormal-step-row' : '';
                  let dwellHtml = formatHours(dwellH);
                  if (isAbnormal) {
                    dwellHtml = '<span class="abnormal-duration">' + dwellHtml + '</span>';
                  }
                  const reasonHtml = isAbnormal && abnormalReasons.length
                    ? '<div class="abnormal-reason-tags">' + abnormalReasons.map(r => '<span class="abnormal-reason-tag">' + r + '</span>').join('') + '</div>'
                    : '';
                  return '<tr class="' + rowClass + '">' +
                    '<td><span class="stats-step-dot' + (isAbnormal ? ' stats-step-dot-abnormal' : '') + '"></span>' + d.from + '</td>' +
                    '<td>' + (d.to || '—') + '</td>' +
                    '<td>' + formatObsDate(d.fromAt) + '</td>' +
                    '<td>' + formatObsDate(d.toAt) + '</td>' +
                    '<td class="num">' + dwellHtml + reasonHtml + '</td>' +
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
      } else if (activeView === "delivery-dashboard") {
        loadAndRenderDeliveryDashboard();
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
        if (filters.operator) params.set("operator", filters.operator);
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
      const operatorEl = document.querySelector("#audit-filter-operator");
      if (sampleEl && sampleEl.value) f.sampleId = sampleEl.value;
      if (actionEl && actionEl.value) f.action = actionEl.value;
      if (operatorEl && operatorEl.value) f.operator = operatorEl.value;
      return f;
    }

    function applyAuditFilters(list, filters) {
      return list.filter(item => {
        if (filters.sampleId && item.sampleId !== filters.sampleId) return false;
        if (filters.action && item.action !== filters.action) return false;
        if (filters.operator && item.operator !== filters.operator) return false;
        return true;
      });
    }

    function populateAuditFilterOptions(data) {
      const sampleSel = document.querySelector("#audit-filter-sample");
      const actionSel = document.querySelector("#audit-filter-action");
      const operatorSel = document.querySelector("#audit-filter-operator");
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
          "step:batch-advance": "批量推进步骤",
          "observation:create": "填写观察结果",
          "delivery:confirm": "确认交付",
          "csv:import": "CSV导入",
          "sample:rollback": "回滚样本"
        };
        actionSel.innerHTML = '<option value="">全部操作</option>' +
          data.actions.map(act => '<option value="' + escapeHtml(act) + '">' + escapeHtml(actionLabels[act] || act) + '</option>').join("");
        actionSel.value = current;
      }
      if (operatorSel && data.operators) {
        const current = operatorSel.value;
        operatorSel.innerHTML = '<option value="">全部操作者</option>' +
          data.operators.map(op => '<option value="' + escapeHtml(op) + '">' + escapeHtml(ROLE_INFO[op]?.name || op) + '</option>').join("");
        operatorSel.value = current;
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

          let obsInlineDiff = "";
          if (item.action === "observation:create" && item.observationDiff && item.observationDiff.changes && item.observationDiff.changes.length > 0) {
            const changeLabels = item.observationDiff.changes.map(c => {
              const shortOld = c.oldValue.length > 20 ? c.oldValue.substring(0, 20) + "…" : c.oldValue;
              const shortNew = c.newValue.length > 20 ? c.newValue.substring(0, 20) + "…" : c.newValue;
              return '<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 6px;border-radius:3px;background:#fff8e6;border:1px solid #e6b800;font-size:11px;">' +
                '<b>' + escapeHtml(c.label) + '</b>: ' +
                (shortOld ? '<span style="color:var(--danger);text-decoration:line-through;">' + escapeHtml(shortOld) + '</span>' : '<span style="color:var(--muted);">空</span>') +
                ' → ' +
                (shortNew ? '<span style="color:var(--accent);font-weight:600;">' + escapeHtml(shortNew) + '</span>' : '<span style="color:var(--muted);">空</span>') +
              '</span>';
            }).join("");
            obsInlineDiff = '<div style="margin-top:8px;padding:8px 10px;background:#fafcf7;border:1px solid var(--line);border-radius:6px;">' +
              '<div style="font-size:12px;color:var(--stone);font-weight:600;margin-bottom:4px;">📝 观察字段变更（' + item.observationDiff.changes.length + '项，切片 ' + escapeHtml(item.observationDiff.sliceId || item.sliceId || "-") + '）：点击查看详情获取完整对比</div>' +
              changeLabels +
            '</div>';
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
            obsInlineDiff +
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

      let obsDiffHtml = "";
      if (entry.action === "observation:create") {
        const obsDiff = entry.observationDiff;
        const sliceId = entry.sliceId;
        const observationId = entry.observationId;
        if (obsDiff && obsDiff.changes && obsDiff.changes.length > 0) {
          const changesHtml = obsDiff.changes.map(c => {
            const oldVal = c.oldValue ? escapeHtml(c.oldValue) : '<span style="color:var(--muted);font-style:italic;">（空）</span>';
            const newVal = c.newValue ? escapeHtml(c.newValue) : '<span style="color:var(--muted);font-style:italic;">（空）</span>';
            return '<div class="audit-obs-diff-row">' +
              '<span class="audit-obs-diff-field">' + escapeHtml(c.label) + '</span>' +
              '<span class="audit-obs-diff-old">' + oldVal + '</span>' +
              '<span class="audit-obs-diff-arrow">→</span>' +
              '<span class="audit-obs-diff-new">' + newVal + '</span>' +
            '</div>';
          }).join("");
          const versionInfo = '<div style="font-size:12px;color:var(--stone);margin-bottom:6px;">' +
            '<b>切片：</b>' + escapeHtml(sliceId || "-") + ' &nbsp;|&nbsp; ' +
            '<b>对比版本：</b>' + escapeHtml(obsDiff.prevObsId || "-") + ' → ' + escapeHtml(obsDiff.newObsId || observationId || "-") + ' &nbsp;|&nbsp; ' +
            '<b>变化字段：</b>' + obsDiff.changes.length + ' 个' +
          '</div>';
          obsDiffHtml = '<div class="delivery-section"><h3>📊 观察记录版本对比（本次 vs 上一版）</h3><div class="audit-obs-diff">' +
            versionInfo + changesHtml +
          '</div></div>';
        } else if (sliceId && observationId) {
          let prevObs = null;
          let currObs = null;
          if (entry.snapshot && Array.isArray(entry.snapshot.slices)) {
            const slice = entry.snapshot.slices.find(s => s.id === sliceId);
            const observations = slice && slice.observations ? slice.observations : [];
            const obsIdx = observations.findIndex(o => o.id === observationId);
            if (obsIdx >= 0) {
              currObs = observations[obsIdx];
              prevObs = obsIdx > 0 ? observations[obsIdx - 1] : null;
            }
          }
          if (prevObs && currObs) {
            const tempContainer = document.createElement("div");
            renderObsCompareResult(prevObs, currObs, tempContainer, true);
            obsDiffHtml = '<div class="delivery-section"><h3>📊 观察记录版本对比（本次 vs 上一版）</h3>' + tempContainer.innerHTML + '</div>';
          } else {
            obsDiffHtml = '<div class="delivery-section"><h3>观察记录变更</h3><div class="meta">本次观察新增了观察记录（' + escapeHtml(observationId) + '），无前置版本对比数据。</div></div>';
          }
        } else {
          obsDiffHtml = '<div class="delivery-section"><h3>观察记录变更</h3><div class="meta">本次操作新增了观察记录。</div></div>';
        }
      }

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
        obsDiffHtml +
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
          alert("回滚成功！\\n" + (result.note || ""));
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
    const csvRevalidateBtn = document.querySelector("#csv-revalidate-btn");
    const csvImportResult = document.querySelector("#csv-import-result");
    const csvDownloadTemplateBtn = document.querySelector("#csv-download-template");

    csvDownloadTemplateBtn.onclick = () => {
      window.location.href = "/api/csv/template";
    };

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
          csvRevalidateBtn.style.display = result.invalidRows > 0 ? "inline-block" : "none";
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

        html += '<tr class="' + rowClass + '" data-row-index="' + (row.rowNum - 2) + '">';
        html += '<td>' + row.rowNum + '</td>';

        const sampleIdWarning = row.warnings.some(w => w.includes("样本编号"));
        html += '<td class="cell-editable ' + (sampleIdWarning ? 'cell-warning' : '') + '"><input type="text" data-field="sampleId" value="' + (d.sampleId || '') + '" placeholder="自动生成"></td>';

        const projectError = !d.project;
        html += '<td class="cell-editable ' + (projectError ? 'cell-error' : '') + '"><input type="text" data-field="project" value="' + (d.project || '') + '" class="' + (projectError ? 'input-error' : '') + '"></td>';

        const boreholeError = !d.borehole;
        html += '<td class="cell-editable ' + (boreholeError ? 'cell-error' : '') + '"><input type="text" data-field="borehole" value="' + (d.borehole || '') + '" class="' + (boreholeError ? 'input-error' : '') + '"></td>';

        const coreBoxError = !d.coreBox;
        html += '<td class="cell-editable ' + (coreBoxError ? 'cell-error' : '') + '"><input type="text" data-field="coreBox" value="' + (d.coreBox || '') + '" class="' + (coreBoxError ? 'input-error' : '') + '"></td>';

        const depthError = !d.depth || row.errors.some(e => e.includes("深度"));
        html += '<td class="cell-editable ' + (depthError ? 'cell-error' : '') + '"><input type="text" data-field="depth" value="' + (d.depth || '') + '" placeholder="如 128.4-128.8m" class="' + (depthError ? 'input-error' : '') + '"></td>';

        const ownerError = !d.owner;
        html += '<td class="cell-editable ' + (ownerError ? 'cell-error' : '') + '"><input type="text" data-field="owner" value="' + (d.owner || '') + '" class="' + (ownerError ? 'input-error' : '') + '"></td>';

        const sliceIdError = !d.sliceId || row.errors.some(e => e.includes("切片编号"));
        html += '<td class="cell-editable ' + (sliceIdError ? 'cell-error' : '') + '"><input type="text" data-field="sliceId" value="' + (d.sliceId || '') + '" placeholder="如 SL-001-A" class="' + (sliceIdError ? 'input-error' : '') + '"></td>';

        const methodError = !d.method;
        html += '<td class="cell-editable ' + (methodError ? 'cell-error' : '') + '"><input type="text" data-field="method" value="' + (d.method || '') + '" class="' + (methodError ? 'input-error' : '') + '"></td>';

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

    function collectEditedRows() {
      const rows = [];
      const trs = document.querySelectorAll("#csv-preview-container .csv-preview-table tbody tr");
      trs.forEach(tr => {
        const row = {};
        tr.querySelectorAll("input[data-field]").forEach(input => {
          row[input.dataset.field] = input.value.trim();
        });
        rows.push(row);
      });
      return rows;
    }

    csvRevalidateBtn.onclick = async () => {
      csvRevalidateBtn.disabled = true;
      csvRevalidateBtn.textContent = "校验中...";
      try {
        const editedRows = collectEditedRows();
        const result = await api("/api/csv/revalidate", {
          method: "POST",
          body: JSON.stringify({ rows: editedRows })
        });
        csvPreviewData = { editedRows, result };
        renderCSVPreview(result);
        csvImportBtn.style.display = result.validRows > 0 ? "inline-block" : "none";
        csvRevalidateBtn.style.display = result.invalidRows > 0 ? "inline-block" : "none";
        csvImportResult.style.display = "none";
      } catch (err) {
        alert("重新校验失败：" + err.message);
      } finally {
        csvRevalidateBtn.disabled = false;
        csvRevalidateBtn.textContent = "修正后再校验";
      }
    };

    csvResetBtn.onclick = () => {
      csvPreviewData = null;
      csvFile = null;
      csvFileInput.value = "";
      csvUploadArea.style.display = "block";
      csvFileInfo.style.display = "none";
      csvPreviewArea.style.display = "none";
      csvImportBtn.style.display = "none";
      csvRevalidateBtn.style.display = "none";
      csvResetBtn.style.display = "none";
      csvImportResult.style.display = "none";
    };

    csvImportBtn.onclick = async () => {
      if (!csvPreviewData) return;
      if (!confirm("确认导入这些数据吗？")) return;
      try {
        csvImportBtn.disabled = true;
        csvImportBtn.textContent = "导入中...";
        const editedRows = collectEditedRows();
        const result = await api("/api/csv/import-rows", {
          method: "POST",
          body: JSON.stringify({ rows: editedRows })
        });
        renderImportResult(result);
        csvImportBtn.style.display = "none";
        csvRevalidateBtn.style.display = "none";
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
      updateSampleStatus(sample, db);
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
      updateSampleStatus(sample, db);
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
      updateSampleStatus(sample, db);
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
      updateSampleStatus(sample, db);
      recordAudit(db, { sampleId: sample.id, action: "step:advance", operator: currentRole, sourceApi: "POST /api/samples/:id/slices/:sliceId/logs", beforeSample, afterSample: sample });
      await saveDb(db);
      return sendJson(res, 200, sample);
    }

    function canAdvanceSlice(slice, targetStep, role, deliveredSliceIds) {
      const errors = [];
      if (!slice) {
        errors.push("切片不存在");
        return { valid: false, errors };
      }
      if (deliveredSliceIds && deliveredSliceIds.has(slice.id)) {
        errors.push("该切片已交付，无法推进");
        return { valid: false, errors };
      }
      const currentStep = slice.status;
      const producerSteps = ["取样", "切割", "研磨", "染色"];
      const isProducerRole = roleHasPermission(role, PERMISSIONS.STEP_ADVANCE);
      if (!isProducerRole) {
        errors.push("当前角色无推进制片步骤权限");
        return { valid: false, errors };
      }
      if (!producerSteps.includes(currentStep)) {
        errors.push(`当前步骤「${currentStep}」不属于制片工序，无法推进`);
        return { valid: false, errors };
      }
      const currentIdx = producerSteps.indexOf(currentStep);
      const targetIdx = producerSteps.indexOf(targetStep);
      if (targetIdx !== currentIdx + 1) {
        const expectedNext = producerSteps[currentIdx + 1];
        if (expectedNext) {
          errors.push(`只能从「${currentStep}」推进到「${expectedNext}」，不能直接跳转到「${targetStep}」`);
        } else {
          errors.push(`当前步骤「${currentStep}」已是制片最后一步，制片人员无法继续推进`);
        }
        return { valid: false, errors };
      }
      return { valid: true, errors };
    }

    if (req.method === "POST" && url.pathname === "/api/slices/batch-advance") {
      if (!requirePermission(currentRole, PERMISSIONS.STEP_ADVANCE, res)) return;
      const input = await body(req);
      const sliceIds = Array.isArray(input.sliceIds) ? input.sliceIds : [];
      const note = (input.note || "").trim();

      if (sliceIds.length === 0) {
        return sendJson(res, 400, { error: "请至少选择一个切片" });
      }

      const allDeliveredSliceIds = new Set();
      db.deliveries.forEach(d => d.slices.forEach(s => allDeliveredSliceIds.add(s.id)));

      const sliceMap = new Map();
      db.samples.forEach(sample => {
        sample.slices.forEach(slice => {
          sliceMap.set(slice.id, { sample, slice });
        });
      });

      const validItems = [];
      const sliceErrors = [];
      const producerSteps = ["取样", "切割", "研磨", "染色"];

      sliceIds.forEach(sliceId => {
        const item = sliceMap.get(sliceId);
        if (!item) {
          sliceErrors.push({
            sliceId,
            errorCode: "SLICE_NOT_FOUND",
            errorCategory: "individual",
            error: `切片「${sliceId}」不存在`
          });
          return;
        }
        const { sample, slice } = item;
        const currentStep = slice.status;
        const currentIdx = producerSteps.indexOf(currentStep);
        const nextStep = currentIdx >= 0 && currentIdx < producerSteps.length - 1 ? producerSteps[currentIdx + 1] : null;

        if (!nextStep) {
          sliceErrors.push({
            sliceId,
            sampleId: sample.id,
            currentStep,
            errorCode: "ALREADY_LAST_STEP",
            errorCategory: "individual",
            error: `当前步骤「${currentStep}」已是制片最后一步，无法继续推进`
          });
          return;
        }

        if (sample.delivery === "已交付") {
          sliceErrors.push({
            sliceId,
            sampleId: sample.id,
            currentStep,
            nextStep,
            errorCode: "SAMPLE_FULLY_DELIVERED",
            errorCategory: "individual",
            error: `样本「${sample.id}」已全部交付，无法推进切片`
          });
          return;
        }

        if (allDeliveredSliceIds.has(slice.id)) {
          sliceErrors.push({
            sliceId,
            sampleId: sample.id,
            currentStep,
            nextStep,
            errorCode: "SLICE_DELIVERED",
            errorCategory: "individual",
            error: `切片「${sliceId}」已交付，无法推进`
          });
          return;
        }

        const check = canAdvanceSlice(slice, nextStep, currentRole, allDeliveredSliceIds);
        if (!check.valid) {
          sliceErrors.push({
            sliceId,
            sampleId: sample.id,
            currentStep,
            nextStep,
            errorCode: "ADVANCE_NOT_ALLOWED",
            errorCategory: "individual",
            error: check.errors.join("；")
          });
          return;
        }

        validItems.push({
          sample,
          slice,
          nextStep,
          currentStep
        });
      });

      if (validItems.length === 0) {
        return sendJson(res, 400, {
          error: "没有可推进的切片",
          sliceErrors,
          errorType: "individual_validation_failed"
        });
      }

      const consistencyErrors = [];
      const fromSteps = [...new Set(validItems.map(v => v.currentStep))];
      if (fromSteps.length > 1) {
        consistencyErrors.push({
          errorCode: "INCONSISTENT_STEP",
          errorCategory: "consistency",
          error: "所选切片处于不同工序步骤，批量推进需选择同一工序步骤的切片",
          details: { stepsFound: fromSteps }
        });
      }

      const sampleStatuses = [...new Set(validItems.map(v => v.sample.status))];
      if (sampleStatuses.length > 1) {
        consistencyErrors.push({
          errorCode: "INCONSISTENT_SAMPLE_STATUS",
          errorCategory: "consistency",
          error: "所选切片所属样本的状态不一致，批量推进需选择状态相同的样本切片",
          details: { sampleStatusesFound: sampleStatuses }
        });
      }

      if (consistencyErrors.length > 0) {
        return sendJson(res, 400, {
          error: consistencyErrors[0].error,
          sliceErrors,
          consistencyErrors,
          errorType: "consistency_validation_failed"
        });
      }

      const fromStep = validItems[0].currentStep;
      const targetStep = validItems[0].nextStep;
      const commonNote = note || `${targetStep}步骤完成`;
      const batchId = `BATCH-${Date.now()}`;

      const affectedSamples = new Map();
      const beforeSnapshots = new Map();
      const advancedSliceIds = [];

      validItems.forEach(({ sample, slice, nextStep }) => {
        if (!beforeSnapshots.has(sample.id)) {
          beforeSnapshots.set(sample.id, createSampleSnapshot(sample));
        }
        slice.status = nextStep;
        slice.logs.push({
          at: new Date().toISOString(),
          step: nextStep,
          note: commonNote
        });
        updateSampleStatus(sample, db);
        affectedSamples.set(sample.id, sample);
        advancedSliceIds.push(slice.id);
      });

      affectedSamples.forEach((sample, sampleId) => {
        const beforeSample = beforeSnapshots.get(sampleId);
        recordAudit(db, {
          sampleId,
          action: "step:batch-advance",
          operator: currentRole,
          sourceApi: "POST /api/slices/batch-advance",
          beforeSample,
          afterSample: sample,
          note: `批量推进 ${advancedSliceIds.filter(id => {
            const item = sliceMap.get(id);
            return item && item.sample.id === sampleId;
          }).length} 个切片：${advancedSliceIds.filter(id => {
            const item = sliceMap.get(id);
            return item && item.sample.id === sampleId;
          }).join("、")}，从「${fromStep}」推进到「${targetStep}」，批量操作ID：${batchId}`
        });
      });

      await saveDb(db);

      return sendJson(res, 200, {
        success: true,
        batchId,
        advancedCount: advancedSliceIds.length,
        failedCount: sliceErrors.length,
        advancedSliceIds,
        targetStep,
        fromStep,
        sliceErrors,
        sampleCount: affectedSamples.size,
        note: commonNote
      });
    }
    const deliveryPreviewMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/delivery-preview$/);
    if (deliveryPreviewMatch && req.method === "GET") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_PREVIEW, res)) return;
      const sample = db.samples.find(item => item.id === deliveryPreviewMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      
      const deliveredSliceIds = getDeliveredSliceIds(db, sample.id);
      
      const slicesInfo = sample.slices.map(slice => {
        const observations = slice.observations || [];
        const lastObs = observations.length ? observations[observations.length - 1] : null;
        const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
        const hasObservation = observations.length > 0 || legacyObs.length > 0;
        const isDelivered = deliveredSliceIds.has(slice.id);
        const canSelect = slice.status === "观察" && hasObservation && !isDelivered;
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
          lastLog: slice.logs && slice.logs.length ? slice.logs[slice.logs.length - 1] : null,
          isDelivered,
          canSelect
        };
      });
      
      const allObserved = slicesInfo.length > 0 && slicesInfo.every(s => s.status === "观察" && s.hasObservation);
      const selectableSlices = slicesInfo.filter(s => s.canSelect);
      const anySelectable = selectableSlices.length > 0;
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
      
      const undeliveredCount = slicesInfo.filter(s => !s.isDelivered).length;
      const deliveredCount = slicesInfo.filter(s => s.isDelivered).length;
      
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
        anySelectable,
        selectableCount: selectableSlices.length,
        missingObservations,
        logsSummary: logsSummary.slice(0, 20),
        totalLogs: logsSummary.length,
        sliceCount: slicesInfo.length,
        observedCount: slicesInfo.filter(s => s.hasObservation).length,
        deliveredCount,
        undeliveredCount
      });
    }

    const createDeliveryMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliveries$/);
    if (createDeliveryMatch && req.method === "POST") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_CREATE, res)) return;
      const sampleId = createDeliveryMatch[1];
      const sample = db.samples.find(item => item.id === sampleId);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      
      const input = await body(req);
      const selectedSliceIds = Array.isArray(input.sliceIds) ? input.sliceIds : [];
      const deliveredSliceIds = getDeliveredSliceIds(db, sampleId);
      
      const slicesInfo = sample.slices.map(slice => {
        const observations = slice.observations || [];
        const lastObs = observations.length ? observations[observations.length - 1] : null;
        const legacyObs = typeof slice.observation === "string" ? slice.observation.trim() : "";
        const hasObservation = observations.length > 0 || legacyObs.length > 0;
        const isDelivered = deliveredSliceIds.has(slice.id);
        const canSelect = slice.status === "观察" && hasObservation && !isDelivered;
        return {
          id: slice.id,
          status: slice.status,
          hasObservation,
          canSelect,
          isDelivered
        };
      });
      
      const selectableSlices = slicesInfo.filter(s => s.canSelect);
      if (selectableSlices.length === 0) {
        return sendJson(res, 400, { error: "没有可交付的切片，请确保切片已完成观察且尚未交付" });
      }
      
      let slicesToDeliver;
      if (selectedSliceIds.length === 0) {
        slicesToDeliver = selectableSlices;
      } else {
        const validSelected = selectedSliceIds.filter(id => {
          const info = slicesInfo.find(s => s.id === id);
          return info && info.canSelect;
        });
        if (validSelected.length === 0) {
          return sendJson(res, 400, { error: "所选切片均不符合交付条件" });
        }
        slicesToDeliver = validSelected.map(id => slicesInfo.find(s => s.id === id));
      }
      
      const deliveredBy = (input.deliveredBy || "").trim();
      const receivingUnit = (input.receivingUnit || "").trim();
      const remark = (input.remark || "").trim();
      if (!deliveredBy) {
        return sendJson(res, 400, { error: "请填写交付人" });
      }
      if (!receivingUnit) {
        return sendJson(res, 400, { error: "请填写接收单位" });
      }
      
      const isFullDelivery = slicesToDeliver.length === selectableSlices.length;
      const deliveryType = isFullDelivery ? "full" : "partial";
      
      const delivery = {
        id: `DLV-${Date.now()}`,
        sampleId,
        deliveredAt: new Date().toISOString(),
        deliveredBy,
        receivingUnit,
        remark,
        deliveryType,
        slices: slicesToDeliver.map(sliceInfo => {
          const slice = sample.slices.find(s => s.id === sliceInfo.id);
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
      
      updateSampleStatus(sample, db);
      
      recordAudit(db, { 
        sampleId: sample.id, 
        action: "delivery:confirm", 
        operator: currentRole, 
        sourceApi: "POST /api/samples/:id/deliveries", 
        beforeSample, 
        afterSample: sample, 
        deliverySnapshot: delivery,
        note: `交付类型：${deliveryType === "full" ? "全部交付" : "部分交付"}，交付切片：${slicesToDeliver.length} 个（${slicesToDeliver.map(s => s.id).join("、")}）`
      });
      
      await saveDb(db);
      return sendJson(res, 201, delivery);
    }

    if (req.method === "GET" && url.pathname === "/api/delivery-dashboard") {
      if (!requirePermission(currentRole, PERMISSIONS.DELIVERY_VIEW, res)) return;
      const groups = { "未交付": [], "部分交付": [], "已交付": [] };
      const groupStats = {
        "未交付": { sampleCount: 0, totalSlices: 0, deliveredSlices: 0, deliverableSlices: 0, deliveryCount: 0 },
        "部分交付": { sampleCount: 0, totalSlices: 0, deliveredSlices: 0, deliverableSlices: 0, deliveryCount: 0 },
        "已交付": { sampleCount: 0, totalSlices: 0, deliveredSlices: 0, deliverableSlices: 0, deliveryCount: 0 }
      };
      db.samples.forEach(sample => {
        const deliveredSliceIds = getDeliveredSliceIds(db, sample.id);
        const totalSlices = sample.slices.length;
        const deliveredCount = sample.slices.filter(s => deliveredSliceIds.has(s.id)).length;
        const remainingTotal = totalSlices - deliveredCount;
        const undeliveredSlices = sample.slices.filter(s => !deliveredSliceIds.has(s.id));
        const deliverableCount = undeliveredSlices.filter(s => s.status === "观察" && s.observations && s.observations.length > 0).length;
        const deliverableList = undeliveredSlices
          .filter(s => s.status === "观察" && s.observations && s.observations.length > 0)
          .map(s => ({ id: s.id, method: s.method }));
        const inProgressCount = undeliveredSlices.filter(s => s.status !== "观察" || !s.observations || s.observations.length === 0).length;
        const sampleDeliveries = db.deliveries
          .filter(d => d.sampleId === sample.id)
          .sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt));
        const latestDelivery = sampleDeliveries.length > 0 ? {
          id: sampleDeliveries[0].id,
          deliveredAt: sampleDeliveries[0].deliveredAt,
          deliveredBy: sampleDeliveries[0].deliveredBy,
          receivingUnit: sampleDeliveries[0].receivingUnit,
          sliceCount: sampleDeliveries[0].slices.length,
          deliveryType: sampleDeliveries[0].deliveryType || "full",
          remark: sampleDeliveries[0].remark || ""
        } : null;
        const entry = {
          sampleId: sample.id,
          project: sample.project,
          borehole: sample.borehole,
          coreBox: sample.coreBox,
          depth: sample.depth,
          owner: sample.owner,
          status: sample.status,
          totalSlices,
          deliveredSlices: deliveredCount,
          remainingTotal,
          remainingDeliverable: deliverableCount,
          remainingInProgress: inProgressCount,
          deliverableList,
          latestDelivery,
          deliveryCount: sampleDeliveries.length,
          firstDeliveredAt: sampleDeliveries.length > 0 ? sampleDeliveries[sampleDeliveries.length - 1].deliveredAt : null,
          lastDeliveredAt: sampleDeliveries.length > 0 ? sampleDeliveries[0].deliveredAt : null
        };
        const key = sample.delivery || "未交付";
        const targetKey = groups[key] ? key : "未交付";
        groups[targetKey].push(entry);
        groupStats[targetKey].sampleCount++;
        groupStats[targetKey].totalSlices += totalSlices;
        groupStats[targetKey].deliveredSlices += deliveredCount;
        groupStats[targetKey].deliverableSlices += deliverableCount;
        groupStats[targetKey].deliveryCount += sampleDeliveries.length;
      });
      const summary = {
        undelivered: groups["未交付"].length,
        partial: groups["部分交付"].length,
        delivered: groups["已交付"].length,
        total: db.samples.length,
        totalSlices: db.samples.reduce((s, sm) => s + sm.slices.length, 0),
        totalDeliveredSlices: Object.values(groupStats).reduce((s, g) => s + g.deliveredSlices, 0),
        totalDeliverableSlices: Object.values(groupStats).reduce((s, g) => s + g.deliverableSlices, 0),
        totalDeliveries: db.deliveries.length,
        groupStats
      };
      return sendJson(res, 200, { groups, summary });
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
        const prevObs = slice.observations.length > 0 ? slice.observations[slice.observations.length - 1] : null;
        slice.observations.push(record);
        const obsDiff = prevObs ? compareObservations(prevObs, record) : null;
        const summaryParts = [];
        if (lithology) summaryParts.push(lithology);
        if (minerals) summaryParts.push(minerals);
        if (texture) summaryParts.push(texture);
        slice.observation = summaryParts.join("；") || remark;
        updateSampleStatus(sample, db);
        const auditEntry = recordAudit(db, { sampleId: sample.id, action: "observation:create", operator: currentRole, sourceApi: "POST /api/samples/:id/slices/:sliceId/observations", beforeSample, afterSample: sample });
        if (obsDiff && obsDiff.length > 0) {
          auditEntry.observationDiff = {
            sliceId: slice.id,
            prevObsId: prevObs.id,
            newObsId: record.id,
            changes: obsDiff
          };
        }
        auditEntry.sliceId = slice.id;
        auditEntry.observationId = record.id;
        await saveDb(db);
        return sendJson(res, 201, { sample, record });
      }
    }

    const obsCompareMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/observations\/compare$/);
    if (obsCompareMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === obsCompareMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === obsCompareMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      if (!requirePermission(currentRole, PERMISSIONS.OBSERVATION_VIEW, res)) return;
      const input = await body(req);
      const obsIds = input.observationIds || [];
      if (obsIds.length !== 2) {
        return sendJson(res, 400, { error: "请指定两个观察记录ID进行对比" });
      }
      const observations = slice.observations || [];
      const obsA = observations.find(o => o.id === obsIds[0]);
      const obsB = observations.find(o => o.id === obsIds[1]);
      if (!obsA || !obsB) {
        return sendJson(res, 404, { error: "指定的观察记录不存在" });
      }
      return sendJson(res, 200, {
        observationA: obsA,
        observationB: obsB,
        changes: compareObservations(obsA, obsB)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/csv/template") {
      if (!requirePermission(currentRole, PERMISSIONS.CSV_IMPORT, res)) return;
      const headers = ["样本编号", "项目", "钻孔编号", "岩芯箱号", "取样深度", "负责人", "切片编号", "染色方法"];
      const sampleRows = [
        ["", "东岭铜矿薄片", "ZK-17", "BX-09", "128.4-128.8m", "陆川", "SL-011-A", "普通薄片"],
        ["", "东岭铜矿薄片", "ZK-17", "BX-09", "128.4-128.8m", "陆川", "SL-011-B", "茜素红染色"],
        ["", "西山金矿勘探", "ZK-05", "BX-12", "245.2-245.6m", "陈明", "SL-012-A", "光片"],
        ["CORE-001", "东岭铜矿薄片", "ZK-17", "BX-09", "128.4-128.8m", "陆川", "SL-001-C", "普通薄片"]
      ];
      const escapeCSV = (val) => {
        const str = String(val || "");
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };
      const csvContent = [
        headers.join(","),
        ...sampleRows.map(row => row.map(escapeCSV).join(","))
      ].join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent("岩芯样本导入模板.csv")
      });
      res.end("\uFEFF" + csvContent);
      return;
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

    if (req.method === "POST" && url.pathname === "/api/csv/revalidate") {
      if (!requirePermission(currentRole, PERMISSIONS.CSV_IMPORT, res)) return;
      const input = await body(req);
      const editedRows = input.rows || [];
      if (!Array.isArray(editedRows) || editedRows.length === 0) {
        return sendJson(res, 400, { error: "请提供有效的行数据" });
      }
      try {
        const result = validateCSVImport(editedRows, db);
        return sendJson(res, 200, {
          totalRows: result.totalRows,
          validRows: result.validRows,
          invalidRows: result.invalidRows,
          validatedRows: result.validatedRows,
          sampleGroupCount: result.sampleGroups.length,
          newSampleCount: result.sampleGroups.filter(g => !g.sampleId).length,
          existingSampleCount: result.sampleGroups.filter(g => g.sampleId).length
        });
      } catch (err) {
        return sendJson(res, 500, { error: "重新校验失败：" + err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/csv/import-rows") {
      if (!requirePermission(currentRole, PERMISSIONS.CSV_IMPORT, res)) return;
      const input = await body(req);
      const editedRows = input.rows || [];
      if (!Array.isArray(editedRows) || editedRows.length === 0) {
        return sendJson(res, 400, { error: "请提供有效的行数据" });
      }
      try {
        const validation = validateCSVImport(editedRows, db);
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
            updateSampleStatus(newSample, db);
            db.samples.unshift(newSample);
            recordAudit(db, { sampleId: newSample.id, action: "csv:import", operator: currentRole, sourceApi: "POST /api/csv/import-rows", beforeSample: null, afterSample: newSample });
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
              updateSampleStatus(sample, db);
              recordAudit(db, { sampleId: sample.id, action: "csv:import", operator: currentRole, sourceApi: "POST /api/csv/import-rows", beforeSample, afterSample: sample });
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
            updateSampleStatus(newSample, db);
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
              updateSampleStatus(sample, db);
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

      function isSliceDone(slice, sampleDelivered, parsedLogs, deliveredSliceIds) {
        if (deliveredSliceIds && deliveredSliceIds.has(slice.id)) return true;
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
        const deliveredSliceIds = getDeliveredSliceIds(db, sample.id);

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

          const done = isSliceDone(slice, sampleDelivered, parsedLogs, deliveredSliceIds);
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

      const abnormalMultiplier = parseFloat(url.searchParams.get("abnormalMultiplier")) || 2;
      const abnormalFixedHours = (parseFloat(url.searchParams.get("abnormalFixedDays")) || 3) * 24;
      const stepAvgMap = {};
      stepAverages.forEach(sa => { stepAvgMap[sa.step] = sa.avgHours; });

      const abnormalSteps = [];
      allSliceTimings.forEach(timing => {
        let hasAbnormal = false;
        if (timing.stepDetails && timing.stepDetails.length > 0) {
          timing.stepDetails.forEach(detail => {
            const stepAvg = stepAvgMap[detail.from] || 0;
            const exceedsAverage = stepAvg > 0 && detail.dwellHours > stepAvg * abnormalMultiplier;
            const exceedsFixed = detail.dwellHours > abnormalFixedHours;
            detail.isAbnormal = exceedsAverage || exceedsFixed;
            detail.abnormalReasons = [];
            if (exceedsAverage) {
              detail.abnormalReasons.push("超过工序平均值" + abnormalMultiplier + "倍（平均" + (stepAvg / 24).toFixed(1) + "天）");
            }
            if (exceedsFixed) {
              detail.abnormalReasons.push("超过固定阈值" + (abnormalFixedHours / 24) + "天");
            }
            if (detail.isAbnormal) {
              hasAbnormal = true;
              abnormalSteps.push({
                sliceId: timing.sliceId,
                sampleId: timing.sampleId,
                project: timing.project,
                owner: timing.owner,
                method: timing.method,
                step: detail.from,
                toStep: detail.to,
                dwellHours: detail.dwellHours,
                fromAt: detail.fromAt,
                toAt: detail.toAt,
                reasons: detail.abnormalReasons,
                isComplete: timing.isComplete,
                status: timing.status
              });
            }
          });
        }
        timing.hasAbnormalStep = hasAbnormal;
        timing.abnormalStepCount = timing.stepDetails ? timing.stepDetails.filter(d => d.isAbnormal).length : 0;
      });

      abnormalSteps.sort((a, b) => b.dwellHours - a.dwellHours);

      const backlogList = Object.values(ownerBacklog);

      const projects = [...new Set(db.samples.map(s => s.project))].sort();
      const owners = [...new Set(db.samples.map(s => s.owner))].sort();

      return sendJson(res, 200, {
        sliceTimings: allSliceTimings,
        sampleTimings,
        stepAverages,
        ownerBacklog: backlogList,
        abnormalSteps,
        abnormalConfig: {
          multiplier: abnormalMultiplier,
          fixedDays: abnormalFixedHours / 24
        },
        projects,
        owners
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
      const hasEnabledMethods = db.methods.some(m => m.enabled);
      const method = {
        id: "M-" + Date.now(),
        name,
        description,
        enabled: true,
        isDefault: !hasEnabledMethods,
        createdAt: new Date().toISOString(),
        sortOrder: maxSort + 1
      };
      db.methods.push(method);
      await saveDb(db);
      return sendJson(res, 201, { ...method, usageCount: 0 });
    }

    const methodSetDefaultMatch = url.pathname.match(/^\/api\/methods\/([^/]+)\/default$/);
    if (methodSetDefaultMatch && req.method === "PATCH") {
      if (!requirePermission(currentRole, PERMISSIONS.METHOD_MANAGE, res)) return;
      const methodId = methodSetDefaultMatch[1];
      const success = setDefaultMethod(db, methodId);
      if (!success) {
        return sendJson(res, 400, { error: "无法设置为默认工艺，请确保工艺已启用" });
      }
      await saveDb(db);
      const method = db.methods.find(m => m.id === methodId);
      return sendJson(res, 200, { ...method, usageCount: countMethodUsage(db, method.name) });
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
      const wasDefault = method.isDefault;
      const wasEnabled = method.enabled;
      method.enabled = !method.enabled;
      let newDefaultMethod = null;
      if (wasEnabled && wasDefault) {
        method.isDefault = false;
        newDefaultMethod = ensureDefaultMethod(db);
      }
      await saveDb(db);
      return sendJson(res, 200, {
        ...method,
        usageCount: countMethodUsage(db, method.name),
        newDefaultMethod: newDefaultMethod ? { id: newDefaultMethod.id, name: newDefaultMethod.name } : null
      });
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      if (!requirePermission(currentRole, PERMISSIONS.AUDIT_VIEW, res)) return;
      const sampleId = url.searchParams.get("sampleId") || "";
      const action = url.searchParams.get("action") || "";
      const operator = url.searchParams.get("operator") || "";
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      let logs = db.auditLog;
      if (sampleId) logs = logs.filter(e => e.sampleId === sampleId);
      if (action) logs = logs.filter(e => e.action === action);
      if (operator) logs = logs.filter(e => e.operator === operator);
      const total = logs.length;
      logs = logs.slice(0, limit);
      const sampleIds = [...new Set(db.auditLog.map(e => e.sampleId))].sort();
      const actions = [...new Set(db.auditLog.map(e => e.action))].sort();
      const operators = [...new Set(db.auditLog.map(e => e.operator))].filter(Boolean).sort();
      return sendJson(res, 200, { logs, total, sampleIds, actions, operators });
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
      updateSampleStatus(restoredSample, db);
      const sampleIdx = db.samples.findIndex(s => s.id === sampleId);
      if (sampleIdx >= 0) db.samples[sampleIdx] = restoredSample;
      const removedDeliveries = [];
      const restoredDeliveries = [];
      if (willBeDelivered) {
        const targetTime = new Date(auditEntry.timestamp || 0).getTime();
        const deliverySnapshots = db.auditLog
          .filter(e => {
            if (e.sampleId !== sampleId || e.action !== "delivery:confirm" || !e.deliverySnapshot) return false;
            const entryTime = new Date(e.timestamp || 0).getTime();
            return Number.isFinite(targetTime) && Number.isFinite(entryTime) && entryTime <= targetTime;
          })
          .map(e => e.deliverySnapshot);
        const targetDeliveryIds = new Set(deliverySnapshots.map(d => d.id));
        const currentDeliveries = db.deliveries.filter(d => d.sampleId === sampleId);
        removedDeliveries.push(...currentDeliveries.filter(d => !targetDeliveryIds.has(d.id)).map(d => d.id));
        db.deliveries = db.deliveries.filter(d => d.sampleId !== sampleId || targetDeliveryIds.has(d.id));
        const currentDeliveryIds = new Set(db.deliveries.filter(d => d.sampleId === sampleId).map(d => d.id));
        deliverySnapshots.slice().reverse().forEach(ds => {
          if (!currentDeliveryIds.has(ds.id)) {
            db.deliveries.unshift(JSON.parse(JSON.stringify(ds)));
            restoredDeliveries.push(ds.id);
            currentDeliveryIds.add(ds.id);
          }
        });
        if (!wasDelivered && willBeDelivered && !restoredDeliveries.length) {
          const latestConfirm = db.auditLog.find(e => e.sampleId === sampleId && e.action === "delivery:confirm" && e.deliverySnapshot);
          if (latestConfirm) {
            db.deliveries.unshift(JSON.parse(JSON.stringify(latestConfirm.deliverySnapshot)));
            restoredDeliveries.push(latestConfirm.deliverySnapshot.id);
          }
        }
      } else if (wasDelivered) {
        const toRemove = db.deliveries.filter(d => d.sampleId === sampleId);
        removedDeliveries.push(...toRemove.map(d => d.id));
        db.deliveries = db.deliveries.filter(d => d.sampleId !== sampleId);
      }
      const rollbackNoteParts = [`回滚到审计记录 ${auditId}（${auditEntry.actionLabel || auditEntry.action}，${auditEntry.timestamp}）`];
      if (removedDeliveries.length) rollbackNoteParts.push(`已删除交付记录：${removedDeliveries.join("、")}`);
      if (restoredDeliveries.length) rollbackNoteParts.push(`已恢复交付记录：${restoredDeliveries.join("、")}`);
      recordAudit(db, {
        sampleId,
        action: "sample:rollback",
        operator: currentRole,
        sourceApi: "POST /api/samples/:id/rollback",
        beforeSample: beforeRollback,
        afterSample: restoredSample,
        note: rollbackNoteParts.join("；")
      });
      await saveDb(db);
      return sendJson(res, 200, {
        sample: restoredSample,
        rollbackTo: auditId,
        removedDeliveries,
        restoredDeliveries,
        note: rollbackNoteParts.join("；")
      });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
