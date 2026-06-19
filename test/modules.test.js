import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLICE_ID_PATTERN,
  DEPTH_PATTERN,
  validateSliceId,
  validateSlices,
  getAllSliceIds,
  getAllSampleIds,
  validateDepth,
  parseCSV,
  normalizeHeader,
  validateCSVImport,
  groupSlicesToSamples
} from "../lib/csvParser.js";

import {
  statuses,
  deliveryStatuses,
  taskSteps,
  getDeliveredSliceIds,
  updateSampleStatus,
  createSampleSnapshot,
  sampleSummary,
  migrateSample,
  migrateDelivery
} from "../lib/sampleStatus.js";

import { computeDeliveryDashboard } from "../lib/deliveryStats.js";

import {
  ACTION_LABELS,
  OBS_FIELDS,
  OBS_FIELD_LABELS,
  ROLE_INFO,
  compareObservations,
  describeDiff,
  recordAudit,
  migrateAuditEntry
} from "../lib/auditDiff.js";

import {
  defaultMethods,
  sortMethods,
  setDefaultMethod,
  ensureDefaultMethod,
  syncUsedMethods
} from "../lib/methodDict.js";

function createMockDb() {
  return {
    samples: [
      {
        id: "CORE-001",
        project: "测试项目",
        borehole: "ZK-001",
        coreBox: "BX-01",
        depth: "100-101m",
        owner: "张三",
        status: "待切割",
        delivery: "未交付",
        slices: [
          { id: "SL-001-A", method: "普通薄片", status: "取样", observations: [], logs: [{ at: "2026-01-01T00:00:00.000Z", step: "取样", operator: "registrar" }] },
          { id: "SL-001-B", method: "茜素红染色", status: "观察", observations: [{ lithology: "花岗岩", minerals: "石英,长石", texture: "中粒结构", remark: "新鲜", at: "2026-01-02T00:00:00.000Z", operator: "observer" }], logs: [{ at: "2026-01-01T00:00:00.000Z", step: "取样", operator: "registrar" }, { at: "2026-01-02T00:00:00.000Z", step: "观察", operator: "producer" }] }
        ]
      },
      {
        id: "CORE-002",
        project: "测试项目",
        borehole: "ZK-001",
        coreBox: "BX-02",
        depth: "101-102m",
        owner: "李四",
        status: "制片中",
        delivery: "部分交付",
        slices: [
          { id: "SL-002-A", method: "普通薄片", status: "观察", observations: [{ lithology: "片麻岩", minerals: "石英,长石,云母", texture: "片麻状构造", remark: "风化", at: "2026-01-03T00:00:00.000Z", operator: "observer" }], logs: [{ at: "2026-01-02T00:00:00.000Z", step: "取样", operator: "registrar" }, { at: "2026-01-03T00:00:00.000Z", step: "观察", operator: "producer" }] },
          { id: "SL-002-B", method: "光片", status: "研磨", observations: [], logs: [{ at: "2026-01-02T00:00:00.000Z", step: "取样", operator: "registrar" }, { at: "2026-01-03T00:00:00.000Z", step: "研磨", operator: "producer" }] }
        ]
      }
    ],
    deliveries: [
      {
        id: "DLV-001",
        sampleId: "CORE-002",
        deliveredAt: "2026-01-04T00:00:00.000Z",
        deliveredBy: "王五",
        receivingUnit: "测试单位",
        remark: "首次交付",
        slices: [{ id: "SL-002-A", method: "普通薄片" }],
        sampleSnapshot: {},
        deliveryType: "partial"
      }
    ],
    methods: JSON.parse(JSON.stringify(defaultMethods)),
    auditLog: [],
    importDrafts: []
  };
}

test("CSV解析模块 - 常量定义正确", () => {
  assert.ok(SLICE_ID_PATTERN instanceof RegExp);
  assert.ok(SLICE_ID_PATTERN.test("SL-001-A"));
  assert.ok(!SLICE_ID_PATTERN.test("invalid"));

  assert.ok(DEPTH_PATTERN instanceof RegExp);
  assert.ok(DEPTH_PATTERN.test("100-101m"));
  assert.ok(DEPTH_PATTERN.test("128.4-128.8m"));
  assert.ok(!DEPTH_PATTERN.test("invalid"));
});

test("CSV解析模块 - validateSliceId 验证切片编号", () => {
  assert.deepEqual(validateSliceId(""), ["切片编号不能为空"]);
  assert.deepEqual(validateSliceId("invalid"), ['切片编号 "invalid" 格式异常，正确格式示例：SL-001-A']);
  assert.deepEqual(validateSliceId("SL-001-A"), []);
  assert.deepEqual(validateSliceId("SL-001-A", ["SL-001-A"]), ['切片编号 "SL-001-A" 重复，该编号已存在']);
});

test("CSV解析模块 - validateDepth 验证深度格式", () => {
  assert.equal(validateDepth(""), false);
  assert.equal(validateDepth("100-101m"), true);
  assert.equal(validateDepth("128.4-128.8m"), true);
  assert.equal(validateDepth("100-101"), true);
  assert.equal(validateDepth("invalid"), false);
});

test("CSV解析模块 - normalizeHeader 标准化表头", () => {
  assert.equal(normalizeHeader("样本编号"), "sampleId");
  assert.equal(normalizeHeader("项目"), "project");
  assert.equal(normalizeHeader("钻孔编号"), "borehole");
  assert.equal(normalizeHeader("岩芯箱号"), "coreBox");
  assert.equal(normalizeHeader("取样深度"), "depth");
  assert.equal(normalizeHeader("负责人"), "owner");
  assert.equal(normalizeHeader("切片编号"), "sliceId");
  assert.equal(normalizeHeader("染色方法"), "method");
  assert.equal(normalizeHeader("未知字段"), "未知字段");
});

test("CSV解析模块 - parseCSV 解析CSV文本", () => {
  const csv = `项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法
测试项目,ZK-001,BX-01,100-101m,张三,SL-001-A,普通薄片
测试项目,ZK-001,BX-01,100-101m,张三,SL-001-B,茜素红染色`;

  const result = parseCSV(csv);
  assert.equal(result.headers.length, 7);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].切片编号, "SL-001-A");
  assert.equal(result.rows[1].染色方法, "茜素红染色");
});

test("CSV解析模块 - parseCSV 处理带引号的字段", () => {
  const csv = `项目,备注
测试,"带逗号,的内容"`;
  const result = parseCSV(csv);
  assert.equal(result.rows[0].备注, "带逗号,的内容");
});

test("CSV解析模块 - validateCSVImport 验证导入数据", () => {
  const db = createMockDb();
  const rows = [
    { project: "测试项目", borehole: "ZK-001", coreBox: "BX-03", depth: "102-103m", owner: "王五", sliceId: "SL-003-A", method: "普通薄片" },
    { project: "测试项目", borehole: "ZK-001", coreBox: "BX-03", depth: "102-103m", owner: "王五", sliceId: "SL-003-B", method: "茜素红染色" }
  ];

  const result = validateCSVImport(rows, db);
  assert.equal(result.totalRows, 2);
  assert.equal(result.validRows, 2);
  assert.equal(result.invalidRows, 0);
  assert.equal(result.sampleGroups.length, 1);
  assert.equal(result.sampleGroups[0].slices.length, 2);
});

test("CSV解析模块 - validateCSVImport 检测重复切片编号", () => {
  const db = createMockDb();
  const rows = [
    { project: "测试项目", borehole: "ZK-001", coreBox: "BX-03", depth: "102-103m", owner: "王五", sliceId: "SL-001-A", method: "普通薄片" }
  ];

  const result = validateCSVImport(rows, db);
  assert.equal(result.validRows, 0);
  assert.equal(result.invalidRows, 1);
  assert.ok(result.validatedRows[0].errors.some(e => e.includes("已存在")));
});

test("CSV解析模块 - getAllSliceIds 获取所有切片编号", () => {
  const db = createMockDb();
  const ids = getAllSliceIds(db);
  assert.deepEqual(ids, ["SL-001-A", "SL-001-B", "SL-002-A", "SL-002-B"]);

  const idsExcluding = getAllSliceIds(db, "CORE-001");
  assert.deepEqual(idsExcluding, ["SL-002-A", "SL-002-B"]);
});

test("CSV解析模块 - getAllSampleIds 获取所有样本编号", () => {
  const db = createMockDb();
  const ids = getAllSampleIds(db);
  assert.deepEqual(ids, ["CORE-001", "CORE-002"]);
});

test("样本状态模块 - 常量定义正确", () => {
  assert.deepEqual(statuses, ["待切割", "制片中", "待观察", "已交付"]);
  assert.deepEqual(deliveryStatuses, ["未交付", "部分交付", "已交付"]);
  assert.deepEqual(taskSteps, ["取样", "切割", "研磨", "染色", "观察"]);
});

test("样本状态模块 - getDeliveredSliceIds 获取已交付切片", () => {
  const db = createMockDb();
  const delivered = getDeliveredSliceIds(db, "CORE-002");
  assert.ok(delivered.has("SL-002-A"));
  assert.ok(!delivered.has("SL-002-B"));
  assert.equal(delivered.size, 1);
});

test("样本状态模块 - updateSampleStatus 更新样本状态", () => {
  const db = createMockDb();
  const sample = { ...db.samples[0], slices: JSON.parse(JSON.stringify(db.samples[0].slices)) };
  
  updateSampleStatus(sample, db);
  assert.equal(sample.delivery, "未交付");
  assert.equal(sample.status, "制片中");

  sample.slices.forEach(s => {
    s.status = "观察";
    s.observations = [{ lithology: "test" }];
  });
  updateSampleStatus(sample, db);
  assert.equal(sample.status, "待观察");
});

test("样本状态模块 - createSampleSnapshot 创建快照", () => {
  const sample = { id: "test", slices: [{ id: "SL-001" }] };
  const snapshot = createSampleSnapshot(sample);
  assert.deepEqual(snapshot, sample);
  assert.notEqual(snapshot, sample);
  assert.notEqual(snapshot.slices, sample.slices);
});

test("样本状态模块 - sampleSummary 生成摘要", () => {
  const db = createMockDb();
  const summary = sampleSummary(db.samples[0]);
  assert.equal(summary.id, "CORE-001");
  assert.equal(summary.sliceCount, 2);
  assert.equal(summary.sliceStatuses.length, 2);
  assert.equal(summary.sliceStatuses[0].id, "SL-001-A");
});

test("样本状态模块 - migrateSample 迁移数据", () => {
  const sample = {};
  const changed = migrateSample(sample);
  assert.equal(changed, true);
  assert.ok(sample.id);
  assert.equal(sample.project, "未指定项目");
  assert.equal(sample.delivery, "未交付");
  assert.deepEqual(sample.slices, []);

  const goodSample = {
    id: "test", project: "p", borehole: "b", coreBox: "c", depth: "d", owner: "o",
    delivery: "未交付", slices: [{ id: "SL-1", method: "m", observation: "", observations: [], status: "取样", logs: [{ at: "2026-01-01T00:00:00.000Z", step: "取样" }] }]
  };
  assert.equal(migrateSample(goodSample), false);
});

test("样本状态模块 - migrateDelivery 迁移交付记录", () => {
  const delivery = {};
  const changed = migrateDelivery(delivery);
  assert.equal(changed, true);
  assert.ok(delivery.id);
  assert.equal(delivery.deliveryType, "full");

  const goodDelivery = {
    id: "DLV-1", deliveredAt: "2026-01-01T00:00:00.000Z", deliveredBy: "test",
    receivingUnit: "test", remark: "", slices: [], sampleSnapshot: {}, deliveryType: "full"
  };
  assert.equal(migrateDelivery(goodDelivery), false);
});

test("交付统计模块 - computeDeliveryDashboard 计算交付看板", () => {
  const db = createMockDb();
  const dashboard = computeDeliveryDashboard(db);

  assert.ok(dashboard.groups);
  assert.ok(dashboard.summary);
  assert.equal(dashboard.groups["未交付"].length, 1);
  assert.equal(dashboard.groups["部分交付"].length, 1);
  assert.equal(dashboard.groups["已交付"].length, 0);
  assert.equal(dashboard.summary.total, 2);
  assert.equal(dashboard.summary.undelivered, 1);
  assert.equal(dashboard.summary.partial, 1);
  assert.equal(dashboard.summary.delivered, 0);
  assert.equal(dashboard.summary.totalSlices, 4);
});

test("审计diff模块 - 常量定义正确", () => {
  assert.equal(ACTION_LABELS["sample:create"], "创建样本");
  assert.deepEqual(OBS_FIELDS, ["lithology", "minerals", "texture", "remark"]);
  assert.equal(OBS_FIELD_LABELS.lithology, "岩性");
  assert.equal(ROLE_INFO.registrar.name, "样本登记人员");
});

test("审计diff模块 - compareObservations 比较观察结果", () => {
  const obsA = { lithology: "花岗岩", minerals: "石英,长石", texture: "中粒结构", remark: "" };
  const obsB = { lithology: "片麻岩", minerals: "石英,长石", texture: "片麻状构造", remark: "风化" };

  const changes = compareObservations(obsA, obsB);
  assert.equal(changes.length, 3);
  assert.equal(changes[0].field, "lithology");
  assert.equal(changes[0].oldValue, "花岗岩");
  assert.equal(changes[0].newValue, "片麻岩");
});

test("审计diff模块 - describeDiff 描述差异", () => {
  const before = { id: "CORE-001", status: "待切割", delivery: "未交付", slices: [{ id: "SL-001-A", status: "取样", observations: [], logs: [] }] };
  const after = { id: "CORE-001", status: "制片中", delivery: "未交付", slices: [{ id: "SL-001-A", status: "切割", observations: [], logs: [] }] };

  const diff = describeDiff(before, after, "step:advance");
  assert.ok(diff.includes("状态：待切割 → 制片中"));
  assert.ok(diff.includes("SL-001-A：取样 → 切割"));

  const createDiff = describeDiff(null, after, "sample:create");
  assert.ok(createDiff.includes("新建样本"));
});

test("审计diff模块 - recordAudit 记录审计", () => {
  const db = createMockDb();
  const sample = db.samples[0];
  const before = JSON.parse(JSON.stringify(sample));
  sample.slices[0].status = "切割";
  const after = JSON.parse(JSON.stringify(sample));

  const entry = recordAudit(db, {
    sampleId: sample.id,
    action: "step:advance",
    operator: "producer",
    sourceApi: "/api/slices/SL-001-A/advance",
    beforeSample: before,
    afterSample: after
  });

  assert.ok(entry.id);
  assert.equal(entry.sampleId, sample.id);
  assert.equal(entry.action, "step:advance");
  assert.equal(entry.actionLabel, "推进步骤");
  assert.equal(entry.operator, "producer");
  assert.equal(entry.operatorName, "制片人员");
  assert.ok(entry.note);
  assert.ok(entry.beforeSummary);
  assert.ok(entry.afterSummary);
  assert.ok(entry.snapshot);
  assert.equal(db.auditLog.length, 1);
});

test("审计diff模块 - migrateAuditEntry 迁移审计记录", () => {
  const entry = {};
  const changed = migrateAuditEntry(entry);
  assert.equal(changed, true);
  assert.ok(entry.id);
  assert.equal(entry.operatorName, "未知");

  const goodEntry = {
    id: "AUD-1", timestamp: "2026-01-01T00:00:00.000Z", operator: "registrar",
    operatorName: "样本登记人员", sourceApi: "test"
  };
  assert.equal(migrateAuditEntry(goodEntry), false);
});

test("制片方法字典模块 - defaultMethods 默认方法", () => {
  assert.equal(defaultMethods.length, 5);
  assert.equal(defaultMethods[0].name, "普通薄片");
  assert.equal(defaultMethods[0].isDefault, true);
  assert.equal(defaultMethods[1].name, "茜素红染色");
});

test("制片方法字典模块 - sortMethods 排序方法", () => {
  const methods = [
    { id: "M-2", name: "B方法", sortOrder: 2 },
    { id: "M-1", name: "A方法", sortOrder: 1 },
    { id: "M-3", name: "C方法", sortOrder: 3 }
  ];
  const sorted = sortMethods(methods);
  assert.equal(sorted[0].id, "M-1");
  assert.equal(sorted[1].id, "M-2");
  assert.equal(sorted[2].id, "M-3");
  assert.notEqual(sorted, methods);
});

test("制片方法字典模块 - setDefaultMethod 设置默认方法", () => {
  const db = createMockDb();
  const result = setDefaultMethod(db, "M-002");
  assert.equal(result, true);
  assert.equal(db.methods.find(m => m.id === "M-001").isDefault, false);
  assert.equal(db.methods.find(m => m.id === "M-002").isDefault, true);

  const result2 = setDefaultMethod(db, "non-existent");
  assert.equal(result2, false);
});

test("制片方法字典模块 - ensureDefaultMethod 确保默认方法", () => {
  const db = createMockDb();
  db.methods.forEach(m => m.isDefault = false);
  
  const result = ensureDefaultMethod(db);
  assert.ok(result);
  assert.equal(result.isDefault, true);
  assert.equal(db.methods.filter(m => m.isDefault).length, 1);
});

test("制片方法字典模块 - syncUsedMethods 同步使用的方法", () => {
  const db = createMockDb();
  db.samples[0].slices.push({ id: "SL-001-C", method: "特殊方法", status: "取样", observations: [], logs: [] });
  
  const result = syncUsedMethods(db);
  assert.equal(result.needSave, true);
  assert.equal(result.hasDefault, true);
  assert.ok(db.methods.some(m => m.name === "特殊方法"));
});

test("模块集成测试 - 完整CSV导入流程", () => {
  const db = createMockDb();
  const csv = `项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法
新项目,ZK-002,BX-01,200-201m,测试人,SL-999-A,普通薄片
新项目,ZK-002,BX-01,200-201m,测试人,SL-999-B,茜素红染色`;

  const { headers, rows } = parseCSV(csv);
  const normalizedRows = rows.map(row => {
    const normalized = {};
    Object.keys(row).forEach(key => {
      normalized[normalizeHeader(key)] = row[key];
    });
    return normalized;
  });

  const validation = validateCSVImport(normalizedRows, db);
  assert.equal(validation.validRows, 2);

  const samples = groupSlicesToSamples(validation.sampleGroups, db);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].isNew, true);
  assert.equal(samples[0].newSlices.length, 2);
});

test("模块集成测试 - 样本状态与交付统计一致性", () => {
  const db = createMockDb();
  
  db.samples.forEach(sample => {
    updateSampleStatus(sample, db);
  });

  const dashboard = computeDeliveryDashboard(db);
  
  const undeliveredSample = dashboard.groups["未交付"][0];
  assert.equal(undeliveredSample.sampleId, "CORE-001");
  assert.equal(undeliveredSample.deliveredSlices, 0);
  assert.equal(undeliveredSample.remainingDeliverable, 1);

  const partialSample = dashboard.groups["部分交付"][0];
  assert.equal(partialSample.sampleId, "CORE-002");
  assert.equal(partialSample.deliveredSlices, 1);
  assert.equal(partialSample.remainingTotal, 1);
});
