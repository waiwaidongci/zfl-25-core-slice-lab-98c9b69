import { createSampleSnapshot, sampleSummary } from "./sampleStatus.js";

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

const OBS_FIELDS = ["lithology", "minerals", "texture", "remark"];
const OBS_FIELD_LABELS = {
  lithology: "岩性",
  minerals: "矿物",
  texture: "结构构造",
  remark: "备注"
};

const ROLE_INFO = {
  registrar: { name: "样本登记人员", desc: "负责创建样本、录入切片任务、批量导入" },
  producer: { name: "制片人员", desc: "负责推进制片工序：取样、切割、研磨、染色" },
  observer: { name: "观察人员", desc: "负责填写观察结果、归档观察记录" },
  deliverer: { name: "交付人员", desc: "负责生成交付包、查看历史交付记录" }
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

function migrateAuditEntry(entry) {
  let changed = false;
  if (!entry.id) { entry.id = "AUD-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4); changed = true; }
  if (!entry.timestamp) { entry.timestamp = new Date().toISOString(); changed = true; }
  if (!entry.operator) { entry.operator = "unknown"; changed = true; }
  if (!entry.operatorName) { entry.operatorName = entry.operator ? (ROLE_INFO[entry.operator]?.name || entry.operator) : "未知"; changed = true; }
  if (!entry.sourceApi) { entry.sourceApi = "unknown"; changed = true; }
  return changed;
}

export {
  ACTION_LABELS,
  OBS_FIELDS,
  OBS_FIELD_LABELS,
  ROLE_INFO,
  compareObservations,
  describeDiff,
  recordAudit,
  migrateAuditEntry
};
