const defaultMethods = [
  { id: "M-001", name: "普通薄片", description: "标准岩矿薄片制片，厚度0.03mm", enabled: true, isDefault: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 1 },
  { id: "M-002", name: "茜素红染色", description: "碳酸盐矿物染色，区分方解石/白云石", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 2 },
  { id: "M-003", name: "光片", description: "不透明矿物光片制片，用于反光显微镜观察", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 3 },
  { id: "M-004", name: "油浸薄片", description: "油浸法制备薄片，用于精确测定矿物折射率", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 4 },
  { id: "M-005", name: "电子探针片", description: "电子探针显微分析用样品片", enabled: false, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 5 }
];

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

function syncUsedMethods(db) {
  let needSave = false;
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

  return { needSave, hasDefault: db.methods.some(m => m.isDefault && m.enabled) };
}

export {
  defaultMethods,
  sortMethods,
  setDefaultMethod,
  ensureDefaultMethod,
  syncUsedMethods
};
