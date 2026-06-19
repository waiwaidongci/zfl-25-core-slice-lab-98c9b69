import { getDeliveredSliceIds } from "./sampleStatus.js";

function computeDeliveryDashboard(db) {
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

  return { groups, summary };
}

export { computeDeliveryDashboard };
