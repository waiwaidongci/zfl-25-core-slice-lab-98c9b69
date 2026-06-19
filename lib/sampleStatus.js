const statuses = ["待切割", "制片中", "待观察", "已交付"];
const deliveryStatuses = ["未交付", "部分交付", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

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
  if (typeof delivery.remark !== "string") { delivery.remark = ""; changed = true; }
  if (!Array.isArray(delivery.slices)) { delivery.slices = []; changed = true; }
  if (!delivery.sampleSnapshot) { delivery.sampleSnapshot = {}; changed = true; }
  if (!delivery.deliveryType) { delivery.deliveryType = "full"; changed = true; }
  return changed;
}

export {
  statuses,
  deliveryStatuses,
  taskSteps,
  getDeliveredSliceIds,
  updateSampleStatus,
  createSampleSnapshot,
  sampleSummary,
  migrateSample,
  migrateDelivery
};
