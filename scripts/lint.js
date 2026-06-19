import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const results = {
  passed: 0,
  warnings: 0,
  errors: 0,
  files: 0,
  details: []
};

function log(message, type = "info") {
  const prefix = {
    info: "ℹ️  ",
    pass: "✅ ",
    warn: "⚠️  ",
    error: "❌ ",
    header: "\n━━━ "
  };
  console.log(`${prefix[type] || ""}${message}`);
}

function getAllJsFiles(dir, files = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getAllJsFiles(fullPath, files);
    } else if (extname(entry) === ".js") {
      files.push(fullPath);
    }
  }
  return files;
}

function getAllJsonFiles(dir, files = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      getAllJsonFiles(fullPath, files);
    } else if (extname(entry) === ".json") {
      files.push(fullPath);
    }
  }
  return files;
}

function checkSyntax(filePath) {
  try {
    execSync(`node --check "${filePath}"`, { stdio: "pipe" });
    return { valid: true };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : e.message;
    return { valid: false, error: stderr };
  }
}

function checkCommonIssues(content, filePath) {
  const issues = [];
  const lines = content.split("\n");

  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.includes("/*")) inComment = true;
    if (line.includes("*/")) { inComment = false; continue; }
    if (inComment) continue;

    const codeLine = line.replace(/\/\/.*$/, "").trim();

    if (codeLine.includes("console.log(") && !codeLine.includes("/*")) {
      issues.push({ type: "warn", line: lineNum, message: "存在 console.log，建议使用正式的日志方案" });
    }

    if (/debugger;?/.test(codeLine)) {
      issues.push({ type: "error", line: lineNum, message: "存在 debugger 语句，提交前应移除" });
    }

    if (line.toLowerCase().includes("todo") && line.includes("//")) {
      issues.push({ type: "info", line: lineNum, message: "存在 TODO 注释" });
    }

    if (line.toLowerCase().includes("fixme") && line.includes("//")) {
      issues.push({ type: "warn", line: lineNum, message: "存在 FIXME 注释，需要修复" });
    }
  }

  if (content.length > 0 && !content.endsWith("\n")) {
    issues.push({ type: "warn", line: lines.length, message: "文件末尾缺少换行符" });
  }

  return issues;
}

function validateJson(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    JSON.parse(content);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function runChecks() {
  log("代码检查开始", "header");

  const jsFiles = getAllJsFiles(projectRoot).filter(f => !f.includes("data/"));
  const jsonFiles = getAllJsonFiles(projectRoot).filter(f => !f.includes("node_modules/") && !f.includes("data/"));

  results.files = jsFiles.length + jsonFiles.length;

  log(`共检查 ${jsFiles.length} 个 JS 文件, ${jsonFiles.length} 个 JSON 文件`);

  log("JS 文件语法检查", "header");
  for (const file of jsFiles) {
    const relativePath = file.replace(projectRoot + "/", "");
    const syntaxResult = checkSyntax(file);
    if (syntaxResult.valid) {
      results.passed++;
      results.details.push({ file: relativePath, status: "pass", type: "syntax" });
    } else {
      results.errors++;
      results.details.push({ file: relativePath, status: "error", type: "syntax", message: syntaxResult.error });
      log(`${relativePath}: 语法错误`, "error");
      log(syntaxResult.error.trim(), "error");
    }
  }

  log("JSON 文件有效性检查", "header");
  for (const file of jsonFiles) {
    const relativePath = file.replace(projectRoot + "/", "");
    const jsonResult = validateJson(file);
    if (jsonResult.valid) {
      results.passed++;
      results.details.push({ file: relativePath, status: "pass", type: "json" });
    } else {
      results.errors++;
      results.details.push({ file: relativePath, status: "error", type: "json", message: jsonResult.error });
      log(`${relativePath}: JSON 格式错误`, "error");
    }
  }

  log("代码质量检查", "header");
  const qualityCheckFiles = jsFiles.filter(f => !f.includes("/scripts/"));
  for (const file of qualityCheckFiles) {
    const relativePath = file.replace(projectRoot + "/", "");
    const content = readFileSync(file, "utf8");
    const issues = checkCommonIssues(content, file);

    if (issues.length === 0) {
      results.passed++;
      continue;
    }

    for (const issue of issues) {
      if (issue.type === "error") {
        results.errors++;
        log(`${relativePath}:${issue.line} - ${issue.message}`, "error");
      } else if (issue.type === "warn") {
        results.warnings++;
        log(`${relativePath}:${issue.line} - ${issue.message}`, "warn");
      }
    }
  }

  log("检查结果汇总", "header");
  log(`文件总数: ${results.files}`);
  log(`通过: ${results.passed}`, "pass");
  if (results.warnings > 0) log(`警告: ${results.warnings}`, "warn");
  if (results.errors > 0) log(`错误: ${results.errors}`, "error");

  if (results.errors > 0) {
    log("\n代码检查未通过，请修复上述错误后重试", "error");
    process.exit(1);
  } else if (results.warnings > 0) {
    log("\n代码检查通过（有警告）", "warn");
    process.exit(0);
  } else {
    log("\n代码检查全部通过 🎉", "pass");
    process.exit(0);
  }
}

runChecks();
