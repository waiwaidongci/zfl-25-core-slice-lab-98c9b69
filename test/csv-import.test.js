import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const testDbPath = join(projectRoot, "data", "test-core-slices.json");
const originalDbPath = join(projectRoot, "data", "core-slices.json");
const testPort = 3026;

const seed = {
  methods: [
    { id: "M-001", name: "普通薄片", description: "标准岩矿薄片制片", enabled: true, isDefault: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 1 },
    { id: "M-002", name: "茜素红染色", description: "碳酸盐矿物染色", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 2 },
    { id: "M-003", name: "光片", description: "不透明矿物光片制片", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 3 }
  ],
  auditLog: [],
  importDrafts: [],
  deliveries: [],
  samples: [
    {
      id: "CORE-TEST-001",
      project: "测试项目A",
      borehole: "ZK-01",
      coreBox: "BX-01",
      depth: "100.0-100.5m",
      owner: "测试员",
      status: "待切割",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "普通薄片", observation: "", status: "取样", observations: [], logs: [{ at: "2026-06-01T10:00:00.000Z", step: "取样", note: "初始切片" }] }
      ]
    }
  ]
};

let serverProcess;
let originalDbBackup;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: testPort,
        path,
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Role": "registrar",
          ...options.headers
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const contentType = res.headers["content-type"] || "";
            let body;
            if (contentType.includes("application/json")) {
              body = data ? JSON.parse(data) : {};
            } else {
              body = data;
            }
            resolve({ status: res.statusCode, body, headers: res.headers });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function waitForServer() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 30;

    const check = () => {
      attempts++;
      const req = http.request(
        { hostname: "localhost", port: testPort, path: "/api/methods", method: "GET", headers: { "X-Role": "registrar" } },
        (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else if (attempts < maxAttempts) {
            setTimeout(check, 200);
          } else {
            reject(new Error("Server failed to start"));
          }
        }
      );
      req.on("error", () => {
        if (attempts < maxAttempts) {
          setTimeout(check, 200);
        } else {
          reject(new Error("Server failed to start"));
        }
      });
      req.end();
    };

    check();
  });
}

async function setupTestServer() {
  if (existsSync(originalDbPath)) {
    originalDbBackup = await readFile(originalDbPath);
  }

  await mkdir(dirname(testDbPath), { recursive: true });
  await writeFile(testDbPath, JSON.stringify(seed, null, 2));

  serverProcess = spawn("node", ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(testPort),
      DB_PATH: testDbPath
    },
    stdio: "inherit"
  });

  await waitForServer();
}

async function teardownTestServer() {
  if (serverProcess) {
    serverProcess.kill();
    await new Promise((resolve) => {
      serverProcess.on("exit", resolve);
    });
  }

  if (existsSync(testDbPath)) {
    await unlink(testDbPath);
  }

  if (originalDbBackup !== undefined) {
    await writeFile(originalDbPath, originalDbBackup);
  }
}

describe("CSV导入API回归测试", () => {
  before(async () => {
    await setupTestServer();
  });

  after(async () => {
    await teardownTestServer();
  });

  describe("场景1: 中文列名和英文别名混用", () => {
    it("应该正确识别中文列名", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "测试项目B,ZK-02,BX-02,200.0-200.5m,张三,SL-002-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.validatedRows[0].data.project, "测试项目B");
      assert.equal(res.body.validatedRows[0].data.sliceId, "SL-002-A");
    });

    it("应该正确识别英文别名列名", async () => {
      const csvText = [
        "project,borehole,coreBox,depth,owner,sliceId,method",
        "测试项目C,ZK-03,BX-03,300.0-300.5m,李四,SL-003-A,光片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.validatedRows[0].data.project, "测试项目C");
      assert.equal(res.body.validatedRows[0].data.method, "光片");
    });

    it("应该正确识别中英文混合列名", async () => {
      const csvText = [
        "项目,borehole,岩芯箱号,depth,负责人,sliceId,染色方法",
        "测试项目D,ZK-04,BX-04,400.0-400.5m,王五,SL-004-A,茜素红染色"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.validatedRows[0].data.borehole, "ZK-04");
      assert.equal(res.body.validatedRows[0].data.depth, "400.0-400.5m");
      assert.equal(res.body.validatedRows[0].data.method, "茜素红染色");
    });

    it("应该正确识别下划线英文别名", async () => {
      const csvText = [
        "sample_id,project,borehole,core_box,depth,owner,slice_id,method",
        ",测试项目E,ZK-05,BX-05,500.0-500.5m,赵六,SL-005-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.validatedRows[0].data.sliceId, "SL-005-A");
    });

    it("应该正确识别简写中文列名", async () => {
      const csvText = [
        "项目,钻孔,箱号,深度,负责人,切片编号,方法",
        "测试项目F,ZK-06,BX-06,600.0-600.5m,孙七,SL-006-A,光片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.validatedRows[0].data.borehole, "ZK-06");
      assert.equal(res.body.validatedRows[0].data.coreBox, "BX-06");
      assert.equal(res.body.validatedRows[0].data.depth, "600.0-600.5m");
    });
  });

  describe("场景2: 重复切片编号", () => {
    it("应该检测到CSV内部重复的切片编号", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "测试项目G,ZK-07,BX-07,700.0-700.5m,周八,SL-007-A,普通薄片",
        "测试项目G,ZK-07,BX-07,700.0-700.5m,周八,SL-007-A,光片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.invalidRows, 1);
      assert.ok(res.body.validatedRows[1].errors.some(e => e.includes("重复")));
    });

    it("应该检测到与现有数据重复的切片编号", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "测试项目A,ZK-01,BX-01,100.0-100.5m,测试员,SL-001-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 0);
      assert.equal(res.body.invalidRows, 1);
      assert.ok(res.body.validatedRows[0].errors.some(e => e.includes("已存在")));
    });

    it("应该在重新校验时检测修复后的重复编号", async () => {
      const rows = [
        { project: "测试项目H", borehole: "ZK-08", coreBox: "BX-08", depth: "800.0-800.5m", owner: "吴九", sliceId: "SL-008-A", method: "普通薄片" },
        { project: "测试项目H", borehole: "ZK-08", coreBox: "BX-08", depth: "800.0-800.5m", owner: "吴九", sliceId: "SL-008-A", method: "光片" }
      ];

      const res1 = await request("/api/csv/revalidate", {
        method: "POST",
        body: { rows }
      });

      assert.equal(res1.status, 200);
      assert.equal(res1.body.invalidRows, 1);

      rows[1].sliceId = "SL-008-B";

      const res2 = await request("/api/csv/revalidate", {
        method: "POST",
        body: { rows }
      });

      assert.equal(res2.status, 200);
      assert.equal(res2.body.validRows, 2);
      assert.equal(res2.body.invalidRows, 0);
    });
  });

  describe("场景3: 追加到已有样本", () => {
    it("应该识别已有样本编号并标记为追加", async () => {
      const csvText = [
        "样本编号,项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "CORE-TEST-001,测试项目A,ZK-01,BX-01,100.0-100.5m,测试员,SL-009-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.existingSampleCount, 1);
      assert.equal(res.body.newSampleCount, 0);
      assert.ok(res.body.validatedRows[0].warnings.some(w => w.includes("已存在")));
    });

    it("导入时应该将切片追加到已有样本", async () => {
      const rows = [
        { sampleId: "CORE-TEST-001", project: "测试项目A", borehole: "ZK-01", coreBox: "BX-01", depth: "100.0-100.5m", owner: "测试员", sliceId: "SL-010-A", method: "光片" },
        { sampleId: "CORE-TEST-001", project: "测试项目A", borehole: "ZK-01", coreBox: "BX-01", depth: "100.0-100.5m", owner: "测试员", sliceId: "SL-010-B", method: "茜素红染色" }
      ];

      const res = await request("/api/csv/import-rows", {
        method: "POST",
        body: { rows }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.successSlices, 2);
      assert.equal(res.body.results[0].type, "append_slices");
      assert.equal(res.body.results[0].sampleId, "CORE-TEST-001");
      assert.equal(res.body.results[0].sliceCount, 2);
    });

    it("应该正确混合追加和新建样本", async () => {
      const rows = [
        { sampleId: "CORE-TEST-001", project: "测试项目A", borehole: "ZK-01", coreBox: "BX-01", depth: "100.0-100.5m", owner: "测试员", sliceId: "SL-011-A", method: "普通薄片" },
        { project: "全新项目", borehole: "ZK-NEW", coreBox: "BX-NEW", depth: "999.0-999.5m", owner: "新人", sliceId: "SL-011-B", method: "光片" }
      ];

      const csvLines = ["样本编号,项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法"];
      rows.forEach(r => {
        csvLines.push(`${r.sampleId || ""},${r.project},${r.borehole},${r.coreBox},${r.depth},${r.owner},${r.sliceId},${r.method}`);
      });

      const previewRes = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText: csvLines.join("\n") }
      });

      assert.equal(previewRes.status, 200);
      assert.equal(previewRes.body.existingSampleCount, 1);
      assert.equal(previewRes.body.newSampleCount, 1);
    });
  });

  describe("场景4: 新建样本按项目钻孔箱号深度负责人合并", () => {
    it("应该将相同样本信息的多行合并为一个样本", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "合并测试项目,ZK-MERGE,BX-MERGE,1000.0-1000.5m,合并员,SL-012-A,普通薄片",
        "合并测试项目,ZK-MERGE,BX-MERGE,1000.0-1000.5m,合并员,SL-012-B,光片",
        "合并测试项目,ZK-MERGE,BX-MERGE,1000.0-1000.5m,合并员,SL-012-C,茜素红染色"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 3);
      assert.equal(res.body.sampleGroupCount, 1);
      assert.equal(res.body.newSampleCount, 1);
    });

    it("项目不同应该分为不同样本", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "项目X,ZK-SAME,BX-SAME,1100.0-1100.5m,负责人A,SL-013-A,普通薄片",
        "项目Y,ZK-SAME,BX-SAME,1100.0-1100.5m,负责人A,SL-013-B,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.sampleGroupCount, 2);
    });

    it("钻孔不同应该分为不同样本", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "相同项目,ZK-A,BX-SAME,1200.0-1200.5m,负责人A,SL-014-A,普通薄片",
        "相同项目,ZK-B,BX-SAME,1200.0-1200.5m,负责人A,SL-014-B,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.sampleGroupCount, 2);
    });

    it("箱号不同应该分为不同样本", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "相同项目,ZK-SAME,BX-A,1300.0-1300.5m,负责人A,SL-015-A,普通薄片",
        "相同项目,ZK-SAME,BX-B,1300.0-1300.5m,负责人A,SL-015-B,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.sampleGroupCount, 2);
    });

    it("深度不同应该分为不同样本", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "相同项目,ZK-SAME,BX-SAME,1400.0-1400.5m,负责人A,SL-016-A,普通薄片",
        "相同项目,ZK-SAME,BX-SAME,1500.0-1500.5m,负责人A,SL-016-B,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.sampleGroupCount, 2);
    });

    it("负责人不同应该分为不同样本", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "相同项目,ZK-SAME,BX-SAME,1600.0-1600.5m,负责人A,SL-017-A,普通薄片",
        "相同项目,ZK-SAME,BX-SAME,1600.0-1600.5m,负责人B,SL-017-B,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.sampleGroupCount, 2);
    });

    it("确认导入时应该正确创建多个合并样本", async () => {
      const rows = [
        { project: "多样本测试1", borehole: "ZK-M1", coreBox: "BX-M1", depth: "1700.0-1700.5m", owner: "创建员1", sliceId: "SL-018-A", method: "普通薄片" },
        { project: "多样本测试1", borehole: "ZK-M1", coreBox: "BX-M1", depth: "1700.0-1700.5m", owner: "创建员1", sliceId: "SL-018-B", method: "光片" },
        { project: "多样本测试2", borehole: "ZK-M2", coreBox: "BX-M2", depth: "1800.0-1800.5m", owner: "创建员2", sliceId: "SL-018-C", method: "茜素红染色" },
        { project: "多样本测试2", borehole: "ZK-M2", coreBox: "BX-M2", depth: "1800.0-1800.5m", owner: "创建员2", sliceId: "SL-018-D", method: "普通薄片" },
        { project: "多样本测试2", borehole: "ZK-M2", coreBox: "BX-M2", depth: "1800.0-1800.5m", owner: "创建员2", sliceId: "SL-018-E", method: "光片" }
      ];

      const res = await request("/api/csv/import-rows", {
        method: "POST",
        body: { rows }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.successSamples, 2);
      assert.equal(res.body.successSlices, 5);
      assert.equal(res.body.results.length, 2);
      assert.ok(res.body.results.some(r => r.type === "new_sample" && r.project === "多样本测试1" && r.sliceCount === 2));
      assert.ok(res.body.results.some(r => r.type === "new_sample" && r.project === "多样本测试2" && r.sliceCount === 3));
    });
  });

  describe("完整流程: 预览 → 重新校验 → 确认导入", () => {
    it("应该完成完整的CSV导入流程", async () => {
      const csvText = [
        "项目,钻孔,箱号,深度,负责人,切片编号,方法",
        "流程测试项目,ZK-FLOW,BX-FLOW,1900.0-1900.5m,流程员,SL-019-A,普通薄片",
        "流程测试项目,ZK-FLOW,BX-FLOW,1900.0-1900.5m,流程员,SL-019-A,光片",
        "流程测试项目,ZK-FLOW,BX-FLOW,1900.0-1900.5m,流程员,SL-019-B,茜素红染色"
      ].join("\n");

      const previewRes = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(previewRes.status, 200);
      assert.equal(previewRes.body.validRows, 2);
      assert.equal(previewRes.body.invalidRows, 1);

      const fixedRows = [
        { project: "流程测试项目", borehole: "ZK-FLOW", coreBox: "BX-FLOW", depth: "1900.0-1900.5m", owner: "流程员", sliceId: "SL-019-A", method: "普通薄片" },
        { project: "流程测试项目", borehole: "ZK-FLOW", coreBox: "BX-FLOW", depth: "1900.0-1900.5m", owner: "流程员", sliceId: "SL-019-C", method: "光片" },
        { project: "流程测试项目", borehole: "ZK-FLOW", coreBox: "BX-FLOW", depth: "1900.0-1900.5m", owner: "流程员", sliceId: "SL-019-B", method: "茜素红染色" }
      ];

      const revalidateRes = await request("/api/csv/revalidate", {
        method: "POST",
        body: { rows: fixedRows }
      });

      assert.equal(revalidateRes.status, 200);
      assert.equal(revalidateRes.body.validRows, 3);
      assert.equal(revalidateRes.body.invalidRows, 0);
      assert.equal(revalidateRes.body.sampleGroupCount, 1);

      const importRes = await request("/api/csv/import-rows", {
        method: "POST",
        body: { rows: fixedRows }
      });

      assert.equal(importRes.status, 200);
      assert.equal(importRes.body.success, true);
      assert.equal(importRes.body.successSamples, 1);
      assert.equal(importRes.body.successSlices, 3);
      assert.equal(importRes.body.results[0].type, "new_sample");
      assert.equal(importRes.body.results[0].sliceCount, 3);
    });
  });

  describe("边界情况测试", () => {
    it("应该拒绝没有有效行的导入", async () => {
      const rows = [
        { project: "", borehole: "ZK-EMPTY", coreBox: "BX-EMPTY", depth: "2000.0-2000.5m", owner: "测试", sliceId: "SL-020-A", method: "普通薄片" }
      ];

      const res = await request("/api/csv/import-rows", {
        method: "POST",
        body: { rows }
      });

      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes("没有可导入的有效数据行"));
    });

    it("应该正确验证深度格式", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "深度测试,ZK-DEPTH,BX-DEPTH,invalid-depth,测试员,SL-021-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 0);
      assert.ok(res.body.validatedRows[0].errors.some(e => e.includes("深度格式异常")));
    });

    it("应该正确验证切片编号格式", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "格式测试,ZK-FMT,BX-FMT,2100.0-2100.5m,测试员,INVALID-ID,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 0);
      assert.ok(res.body.validatedRows[0].errors.some(e => e.includes("格式异常")));
    });

    it("CSV模板下载应该返回正确的格式", async () => {
      const res = await request("/api/csv/template", {
        method: "GET"
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"].includes("text/csv"));
    });

    it("权限控制应该拒绝未授权角色", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "权限测试,ZK-AUTH,BX-AUTH,2200.0-2200.5m,测试员,SL-022-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText },
        headers: { "X-Role": "producer" }
      });

      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes("权限不足"));
    });
  });
});
