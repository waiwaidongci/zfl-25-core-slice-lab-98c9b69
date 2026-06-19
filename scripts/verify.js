import { spawn, execSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dataDir = join(projectRoot, "data");

const SMOKE_DEFAULT_PORT = 3027;
const API_DEFAULT_PORT = 3026;
const TEST_PORTS = [API_DEFAULT_PORT, SMOKE_DEFAULT_PORT];

const TEST_DATA_PATTERNS = [
  "test-",
  "smoke-test-",
  "verify-"
];

const stages = [
  { name: "代码检查", script: "lint", status: "pending" },
  { name: "单元测试", script: "test:unit", status: "pending" },
  { name: "API烟测", script: "test:smoke", status: "pending" },
  { name: "API回归测试", script: "test:api", status: "pending" }
];

let startTime;
let passedCount = 0;
let failedCount = 0;
const failures = [];

function printHeader() {
  console.log("\n" + "=".repeat(60));
  console.log("  岩芯切片实验室 - 本地验证流水线");
  console.log("=".repeat(60));
  console.log(`  项目路径: ${projectRoot}`);
  console.log(`  烟测端口: ${SMOKE_DEFAULT_PORT} (自动回退)`);
  console.log(`  回归端口: ${API_DEFAULT_PORT} (自动回退)`);
  console.log("=".repeat(60) + "\n");
}

function printStageStart(stageName) {
  console.log(`\n┌─ ${stageName} ─────────────────────────────`);
  console.log("│");
}

function printStageEnd(success, message = "") {
  const icon = success ? "✅" : "❌";
  const status = success ? "通过" : "失败";
  console.log("│");
  console.log(`└─ ${icon} ${status}${message ? " - " + message : ""}\n`);
}

function printSummary() {
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log("\n" + "=".repeat(60));
  console.log("  验证结果汇总");
  console.log("=".repeat(60));

  for (const stage of stages) {
    const icon = stage.status === "passed" ? "✅" : stage.status === "failed" ? "❌" : "⏭️ ";
    console.log(`  ${icon} ${stage.name.padEnd(16)} ${stage.status === "passed" ? "通过" : stage.status === "failed" ? "失败" : "跳过"}`);
  }

  console.log("─".repeat(60));
  console.log(`  通过: ${passedCount}  |  失败: ${failedCount}  |  耗时: ${duration}s`);
  console.log("=".repeat(60));

  if (failures.length > 0) {
    console.log("\n  失败详情:");
    for (const failure of failures) {
      console.log(`  ❌ ${failure.stage}`);
      console.log(`     ${failure.message}`);
    }
    console.log("");
  }

  if (failedCount === 0) {
    console.log("\n🎉 所有验证全部通过！\n");
  } else {
    console.log("\n⚠️  有验证未通过，请检查上述问题\n");
  }
}

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

function killProcessesOnPort(port) {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .map(p => p.trim())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    return pids.length;
  } catch {
    return 0;
  }
}

function findTestDataFiles() {
  if (!existsSync(dataDir)) return [];
  try {
    return readdirSync(dataDir)
      .filter(f => TEST_DATA_PATTERNS.some(p => f.startsWith(p)) && f.endsWith(".json"))
      .map(f => join(dataDir, f));
  } catch {
    return [];
  }
}

async function cleanupTestDataFiles() {
  const files = findTestDataFiles();
  for (const file of files) {
    try {
      await unlink(file);
    } catch {}
  }
  return files.length;
}

async function cleanupStaleResources() {
  let killedProcs = 0;
  for (const port of TEST_PORTS) {
    const inUse = await checkPort(port);
    if (inUse) {
      const count = killProcessesOnPort(port);
      if (count > 0) {
        killedProcs += count;
        console.log(`  🧹 已清理端口 ${port} 上的 ${count} 个残留进程`);
      }
    }
  }

  if (killedProcs > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const files = findTestDataFiles();
  if (files.length > 0) {
    const count = await cleanupTestDataFiles();
    if (count > 0) {
      console.log(`  🧹 已清理 ${count} 个残留测试数据文件`);
    }
  }

  return { killedProcs, cleanedFiles: files.length };
}

function runNpmScript(scriptName, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", scriptName], {
      cwd: projectRoot,
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env
      }
    });

    let output = "";
    child.stdout.on("data", (data) => {
      const str = data.toString();
      output += str;
      process.stdout.write("  " + str.split("\n").join("\n  "));
    });
    child.stderr.on("data", (data) => {
      const str = data.toString();
      output += str;
      process.stderr.write("  " + str.split("\n").join("\n  "));
    });

    child.on("close", (code) => {
      resolve({ success: code === 0, code, output });
    });
  });
}

async function runStage(index) {
  const stage = stages[index];

  if (index > 0) {
    const prevStage = stages[index - 1];
    if (prevStage.status === "failed") {
      stage.status = "skipped";
      printStageStart(stage.name);
      console.log("│  前序阶段失败，跳过");
      printStageEnd(false, "跳过");
      return;
    }
  }

  printStageStart(stage.name);

  const env = {};
  if (stage.script === "test:smoke") {
    env.SMOKE_TEST_PORT = String(SMOKE_DEFAULT_PORT);
  } else if (stage.script === "test:api") {
    env.API_TEST_PORT = String(API_DEFAULT_PORT);
  }

  const result = await runNpmScript(stage.script, env);

  if (result.success) {
    stage.status = "passed";
    passedCount++;
    printStageEnd(true);
  } else {
    stage.status = "failed";
    failedCount++;
    failures.push({
      stage: stage.name,
      message: `退出码: ${result.code}`
    });
    printStageEnd(false, `退出码: ${result.code}`);
  }
}

async function finalCleanup() {
  console.log("\n🧹 最终清理...");

  for (const port of TEST_PORTS) {
    killProcessesOnPort(port);
  }

  const count = await cleanupTestDataFiles();
  if (count > 0) {
    console.log(`  已清理 ${count} 个测试数据文件`);
  }
  console.log("  清理完成\n");
}

async function main() {
  startTime = Date.now();
  printHeader();

  console.log("🔍 前置检查与环境清理");
  console.log("");

  const defaultPortInUse = await checkPort(3025);
  if (defaultPortInUse) {
    console.log("  ⚠️  默认端口 3025 已被占用（不影响验证，测试使用独立端口）");
  } else {
    console.log("  ✅ 默认端口 3025 可用");
  }

  const smokePortAvailable = await findAvailablePort(SMOKE_DEFAULT_PORT);
  if (!smokePortAvailable) {
    console.log(`  ❌ 烟测端口 ${SMOKE_DEFAULT_PORT}-${SMOKE_DEFAULT_PORT + 19} 均不可用`);
    process.exit(1);
  }
  console.log(`  ✅ 烟测端口 ${smokePortAvailable} 可用`);

  const apiPortAvailable = await findAvailablePort(API_DEFAULT_PORT);
  if (!apiPortAvailable) {
    console.log(`  ❌ 回归测试端口 ${API_DEFAULT_PORT}-${API_DEFAULT_PORT + 19} 均不可用`);
    process.exit(1);
  }
  console.log(`  ✅ 回归测试端口 ${apiPortAvailable} 可用`);

  const { killedProcs, cleanedFiles } = await cleanupStaleResources();
  if (killedProcs === 0 && cleanedFiles === 0) {
    console.log("  ✅ 无残留资源需要清理");
  }

  for (let i = 0; i < stages.length; i++) {
    await runStage(i);
  }

  await finalCleanup();
  printSummary();

  process.exit(failedCount > 0 ? 1 : 0);
}

process.on("SIGINT", async () => {
  console.log("\n\n收到中断信号，正在清理...");
  for (const port of TEST_PORTS) {
    killProcessesOnPort(port);
  }
  await cleanupTestDataFiles();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  console.log("\n\n收到终止信号，正在清理...");
  for (const port of TEST_PORTS) {
    killProcessesOnPort(port);
  }
  await cleanupTestDataFiles();
  process.exit(143);
});

main().catch(async (e) => {
  console.error("\n❌ 验证流程异常:", e.message);
  console.error(e.stack);
  for (const port of TEST_PORTS) {
    killProcessesOnPort(port);
  }
  await cleanupTestDataFiles();
  process.exit(1);
});
