import { spawn, execSync } from "node:child_process";
import { mkdir, writeFile, unlink, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const VERIFY_PORT = 3030;
const VERIFY_DB_PATH = join(projectRoot, "data", "verify-core-slices.json");

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
  console.log(`  验证端口: ${VERIFY_PORT}`);
  console.log(`  数据隔离: ${VERIFY_DB_PATH.replace(projectRoot + "/", "")}`);
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
  let port = startPort;
  for (let i = 0; i < 20; i++) {
    const inUse = await checkPort(port);
    if (!inUse) return port;
    port++;
  }
  return null;
}

function runNpmScript(scriptName) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", scriptName], {
      cwd: projectRoot,
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        VERIFY_PORT: String(VERIFY_PORT),
        VERIFY_DB_PATH
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
  const result = await runNpmScript(stage.script);

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

async function cleanup() {
  console.log("\n🧹 清理测试资源...");
  try {
    if (existsSync(VERIFY_DB_PATH)) {
      await unlink(VERIFY_DB_PATH);
      console.log("  已清理隔离数据文件");
    }
  } catch (e) {
    console.log(`  清理数据文件失败: ${e.message}`);
  }
  console.log("  清理完成\n");
}

async function main() {
  startTime = Date.now();
  printHeader();

  console.log("🔍 前置检查");
  console.log("");

  const defaultPortInUse = await checkPort(3025);
  if (defaultPortInUse) {
    console.log("  ⚠️  默认端口 3025 已被占用（不影响验证，使用独立端口）");
  } else {
    console.log("  ✅ 默认端口 3025 可用");
  }

  const verifyPortAvailable = await findAvailablePort(VERIFY_PORT);
  if (!verifyPortAvailable) {
    console.log("  ❌ 未找到可用的验证端口");
    process.exit(1);
  }
  console.log(`  ✅ 验证端口 ${verifyPortAvailable} 可用`);

  if (existsSync(VERIFY_DB_PATH)) {
    console.log("  ⚠️  存在遗留验证数据文件，将清理");
    await cleanup();
  } else {
    console.log("  ✅ 无遗留验证数据文件");
  }

  process.env.VERIFY_PORT = String(verifyPortAvailable);

  for (let i = 0; i < stages.length; i++) {
    await runStage(i);
  }

  await cleanup();
  printSummary();

  process.exit(failedCount > 0 ? 1 : 0);
}

process.on("SIGINT", async () => {
  console.log("\n\n收到中断信号，正在清理...");
  await cleanup();
  process.exit(1);
});

main().catch(async (e) => {
  console.error("\n❌ 验证流程异常:", e.message);
  console.error(e.stack);
  await cleanup();
  process.exit(1);
});
