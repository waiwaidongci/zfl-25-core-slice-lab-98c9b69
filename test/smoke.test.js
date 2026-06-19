import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const testDbPath = join(projectRoot, "data", "smoke-test-core-slices.json");
const defaultPort = Number(process.env.SMOKE_TEST_PORT) || 3027;
let testPort = defaultPort;

const seed = {
  methods: [
    { id: "M-001", name: "普通薄片", description: "标准岩矿薄片制片", enabled: true, isDefault: true, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 1 },
    { id: "M-002", name: "茜素红染色", description: "碳酸盐矿物染色", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 2 },
    { id: "M-003", name: "光片", description: "不透明矿物光片制片", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 3 },
    { id: "M-004", name: "油浸薄片", description: "油浸法折射率测定", enabled: true, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 4 },
    { id: "M-005", name: "电子探针片", description: "电子探针分析用片", enabled: false, isDefault: false, createdAt: "2026-01-01T00:00:00.000Z", sortOrder: 5 }
  ],
  auditLog: [],
  importDrafts: [],
  deliveries: [
    {
      id: "DLV-001",
      sampleId: "CORE-004",
      deliveredAt: "2026-06-06T10:30:00.000Z",
      deliveredBy: "李雪",
      receivingUnit: "地质分析中心",
      remark: "测试交付",
      slices: [{ id: "SL-004-A", method: "光片", status: "观察", hasObservation: true, observationId: "OBS-004" }],
      sampleSnapshot: { id: "CORE-004", project: "测试项目", borehole: "ZK-01", coreBox: "BX-01", depth: "100-101m", owner: "测试员" },
      deliveryType: "full"
    }
  ],
  samples: [
    {
      id: "CORE-001",
      project: "测试项目A",
      borehole: "ZK-01",
      coreBox: "BX-01",
      depth: "100.0-100.5m",
      owner: "张三",
      status: "待切割",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "普通薄片", observation: "", status: "取样", observations: [], logs: [{ at: "2026-06-01T10:00:00.000Z", step: "取样", note: "初始切片" }] }
      ]
    },
    {
      id: "CORE-002",
      project: "测试项目B",
      borehole: "ZK-02",
      coreBox: "BX-02",
      depth: "200.0-200.5m",
      owner: "李四",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-002-A", method: "茜素红染色", observation: "", status: "研磨", observations: [], logs: [{ at: "2026-06-02T10:00:00.000Z", step: "取样" }, { at: "2026-06-03T10:00:00.000Z", step: "切割" }] }
      ]
    },
    {
      id: "CORE-003",
      project: "测试项目C",
      borehole: "ZK-03",
      coreBox: "BX-03",
      depth: "300.0-300.5m",
      owner: "王五",
      status: "待观察",
      delivery: "未交付",
      slices: [
        { id: "SL-003-A", method: "光片", observation: "测试观察结果", status: "观察", observations: [{ id: "OBS-003", at: "2026-06-04T16:00:00.000Z", lithology: "花岗岩", minerals: "石英,长石", texture: "中粒结构", remark: "新鲜" }], logs: [{ at: "2026-06-01T10:00:00.000Z", step: "取样" }] }
      ]
    },
    {
      id: "CORE-004",
      project: "测试项目D",
      borehole: "ZK-04",
      coreBox: "BX-04",
      depth: "400.0-400.5m",
      owner: "赵六",
      status: "已交付",
      delivery: "已交付",
      slices: [
        { id: "SL-004-A", method: "光片", observation: "已交付切片", status: "观察", observations: [{ id: "OBS-004", at: "2026-06-05T16:00:00.000Z", lithology: "片麻岩", minerals: "石英,长石,云母", texture: "片麻状构造", remark: "风化" }], logs: [{ at: "2026-06-01T10:00:00.000Z", step: "取样" }] }
      ]
    }
  ]
};

let serverProcess;

async function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "localhost");
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (!(await checkPort(port))) return port;
  }
  return null;
}

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
        { hostname: "localhost", port: testPort, path: "/api/roles", method: "GET" },
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

async function killServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;

  const alreadyDead = new Promise((resolve) => {
    proc.on("exit", resolve);
  });

  proc.kill("SIGTERM");

  const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
  await Promise.race([alreadyDead, timeout]);

  try {
    proc.kill("SIGKILL");
  } catch {}
  await alreadyDead.catch(() => {});
}

async function cleanupData() {
  try {
    if (existsSync(testDbPath)) await unlink(testDbPath);
  } catch {}
}

async function setupTestServer() {
  const availablePort = await findAvailablePort(defaultPort);
  if (!availablePort) {
    throw new Error(`端口 ${defaultPort}-${defaultPort + 19} 均被占用，无法启动烟测服务`);
  }
  testPort = availablePort;

  await mkdir(dirname(testDbPath), { recursive: true });
  await writeFile(testDbPath, JSON.stringify(seed, null, 2));

  serverProcess = spawn("node", ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(testPort),
      DB_PATH: testDbPath
    },
    stdio: "ignore"
  });

  serverProcess.on("exit", (code) => {
    if (code && code !== 0 && serverProcess) {
      console.error(`烟测服务进程异常退出，退出码: ${code}`);
    }
  });

  await waitForServer();
}

async function teardownTestServer() {
  await killServer();
  await cleanupData();
}

async function emergencyCleanup() {
  await killServer();
  await cleanupData();
}

process.on("SIGINT", async () => {
  await emergencyCleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await emergencyCleanup();
  process.exit(143);
});

describe("API烟测 - 服务启动与基础端点", () => {
  before(async () => {
    await setupTestServer();
  });

  after(async () => {
    await teardownTestServer();
  });

  describe("公共端点", () => {
    it("GET / - 应该返回HTML首页", async () => {
      const res = await request("/");
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"].includes("text/html"));
      assert.ok(typeof res.body === "string");
      assert.ok(res.body.includes("<!doctype html>"));
    });

    it("GET /api/roles - 应该返回角色列表", async () => {
      const res = await request("/api/roles");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.roles));
      assert.ok(res.body.roles.length > 0);
      assert.ok(res.body.roles.some(r => r.key === "registrar"));
    });
  });

  describe("样本相关API", () => {
    it("GET /api/samples - 应该返回样本列表", async () => {
      const res = await request("/api/samples");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 4);
      assert.ok(res.body[0].id);
      assert.ok(res.body[0].slices);
    });

    it("GET /api/samples - 无权限角色应该返回403", async () => {
      const res = await request("/api/samples", {
        headers: { "X-Role": "unknown-role" }
      });
      assert.equal(res.status, 403);
    });
  });

  describe("制片方法API", () => {
    it("GET /api/methods - 应该返回方法列表", async () => {
      const res = await request("/api/methods");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 5);
      assert.ok(res.body.some(m => m.isDefault === true));
    });

    it("GET /api/methods/active - 应该只返回启用的方法", async () => {
      const res = await request("/api/methods/active");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.every(m => m.enabled === true));
    });
  });

  describe("交付统计API", () => {
    it("GET /api/delivery-dashboard - 应该返交付看板数据", async () => {
      const res = await request("/api/delivery-dashboard", {
        headers: { "X-Role": "deliverer" }
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.summary);
      assert.ok(res.body.groups);
      assert.equal(typeof res.body.summary.total, "number");
      assert.equal(typeof res.body.summary.undelivered, "number");
      assert.equal(typeof res.body.summary.partial, "number");
      assert.equal(typeof res.body.summary.delivered, "number");
    });

    it("GET /api/deliveries - 应该返回交付记录列表", async () => {
      const res = await request("/api/deliveries", {
        headers: { "X-Role": "deliverer" }
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.equal(res.body.length, 1);
    });
  });

  describe("统计分析API", () => {
    it("GET /api/stats/time-analysis - 应该返回时间分析数据", async () => {
      const res = await request("/api/stats/time-analysis", {
        headers: { "X-Role": "producer" }
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.sliceTimings));
      assert.ok(Array.isArray(res.body.stepAverages));
    });
  });

  describe("CSV导入API", () => {
    it("GET /api/csv/template - 应该返回CSV模板文件", async () => {
      const res = await request("/api/csv/template");
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"].includes("text/csv"));
    });

    it("POST /api/csv/preview - 应该返回CSV预览结果", async () => {
      const csvText = [
        "项目,钻孔编号,岩芯箱号,取样深度,负责人,切片编号,染色方法",
        "烟测项目,ZK-SMOKE,BX-SMOKE,999.0-999.5m,烟测员,SL-999-A,普通薄片"
      ].join("\n");

      const res = await request("/api/csv/preview", {
        method: "POST",
        body: { csvText }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.validRows, 1);
      assert.equal(res.body.totalRows, 1);
    });
  });

  describe("审计日志API", () => {
    it("GET /api/audit - 应该返回审计日志", async () => {
      const res = await request("/api/audit", {
        headers: { "X-Role": "registrar" }
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.logs));
      assert.equal(typeof res.body.total, "number");
    });
  });

  describe("跨角色权限验证", () => {
    const roles = ["registrar", "producer", "observer", "deliverer"];

    for (const role of roles) {
      it(`角色 ${role} 可以访问样本列表`, async () => {
        const res = await request("/api/samples", {
          headers: { "X-Role": role }
        });
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body));
      });
    }

    it("制片人员不能创建样本", async () => {
      const res = await request("/api/samples", {
        method: "POST",
        headers: { "X-Role": "producer" },
        body: {
          project: "测试",
          borehole: "ZK-01",
          coreBox: "BX-01",
          depth: "100-101m",
          owner: "测试",
          method: "普通薄片"
        }
      });
      assert.equal(res.status, 403);
    });
  });
});
