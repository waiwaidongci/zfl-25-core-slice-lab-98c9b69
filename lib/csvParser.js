const SLICE_ID_PATTERN = /^SL-\d+-[A-Za-z]+$/;
const DEPTH_PATTERN = /^\d+(\.\d+)?\s*-\s*\d+(\.\d+)?\s*m?$/i;

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

export {
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
};
