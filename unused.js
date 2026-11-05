#!/usr/bin/env -S bun

// 未引用扫描: bun unused.js [目录]，缺省当前目录
//   未引用 pub 方法: rust-analyzer scip 出索引，cargo-workspace-unused-pub 判读
//   未使用依赖: cargo-shear
// 退出码: 0 干净 / 2 有发现 / 1 出错

import { $ } from "zx";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXIT_OK = 0,
  EXIT_FAIL = 1,
  EXIT_FOUND = 2,
  SHEAR_FOUND = 1,
  NOISE_TOOL_LI = ["cargo_workspace_unused_pub", "Running on", "Found "],
  NOISE_RA_LI = ["Generating SCIP start", "rust-analyzer: Loading"],
  BIN_PATH = "/src/bin/",
  ARG_TARGET = 2,
  OUT_STDOUT = 0,
  OUT_STDERR = 1,
  RA_CONFIG = { cargo: { allTargets: false }, cfg: { setTest: false } },
  RUN_ENV = { ...process.env, NO_COLOR: "1", CARGO_TERM_COLOR: "never", RA_LOG: "off", RUST_LOG: "off" };

const lineDrop = (text, noise_li) =>
    text
      .split("\n")
      .filter((line) => !noise_li.some((hit) => line.includes(hit)))
      .join("\n")
      .trim(),
  toolNoiseDrop = (text) => lineDrop(text, NOISE_TOOL_LI),
  raNoiseDrop = (text) => lineDrop(text, NOISE_RA_LI),
  blockKeep = (block) => block && !block.includes(BIN_PATH),
  reportBinNoiseDrop = (text) => text.split("\n\n").filter(blockKeep).join("\n\n").trim(),
  outPick = (err, idx) => String((idx === OUT_STDOUT ? err.stdout : err.stderr) ?? ""),
  errDump = (err) => (outPick(err, OUT_STDOUT) + outPick(err, OUT_STDERR)).trim(),
  manifestHas = (dir) => existsSync(join(dir, "Cargo.toml")),
  dirHas = (dir) => existsSync(dir),
  sectionShow = (title, body) => {
    if (body) console.log(">>> " + title + "\n\n" + body + "\n");
    else console.log(">>> " + title + ": 无\n");
  };

// zx 的 `command -v` 只认 PATH：rustup 代理在、组件不在时仍报存在，
// 故一律实跑探针，装不上就报错，不再静默带病往下走
const toolEnsure = async (name, probe, install) => {
    try {
      await probe();
      return;
    } catch {}
    process.stderr.write("缺少 " + name + "，正在安装\n");
    try {
      await install();
    } catch (err) {
      const dump = errDump(err);
      if (dump) process.stderr.write(dump + "\n");
      throw new Error(name + " 安装失败");
    }
    try {
      await probe();
    } catch (err) {
      const dump = errDump(err);
      if (dump) process.stderr.write(dump + "\n");
      throw new Error(name + " 安装后仍不可用");
    }
  },
  toolLiEnsure = async (option) => {
    await toolEnsure(
      "rust-analyzer",
      () => $({ ...option, quiet: true })`rust-analyzer --version`,
      () => $({ ...option })`rustup component add rust-analyzer`,
    );
    await toolEnsure(
      "cargo-workspace-unused-pub",
      () => $({ ...option, quiet: true })`cargo workspace-unused-pub --help`,
      () => $({ ...option })`cargo install cargo-workspace-unused-pub`,
    );
    await toolEnsure(
      "cargo-shear",
      () => $({ ...option, quiet: true })`cargo shear --help`,
      () => $({ ...option })`cargo install cargo-shear`,
    );
  };

const workspaceTopFind = async (start) => {
    let cur = resolve(start),
      top = "";
    if (!dirHas(cur)) return "";
    for (;;) {
      if (manifestHas(cur)) top = cur;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return top;
  },
  targetResolve = async (argv) => {
    const start = resolve(argv[ARG_TARGET] || process.cwd()),
      top = await workspaceTopFind(start);
    return top ? [EXIT_OK, top] : [EXIT_FAIL, ""];
  };

// 未引用 pub 方法: 0 干净，2 有发现，其余算错
const pubScan = async (option, scip_path) => {
    let report = "",
      found = false;
    try {
      ({ stdout: report } = await $({ ...option })`cargo workspace-unused-pub --scip ${scip_path}`);
    } catch (err) {
      if (err.exitCode !== EXIT_FOUND) {
        const dump = errDump(err);
        if (dump) process.stderr.write(dump + "\n");
        return EXIT_FAIL;
      }
      report = errDump(err);
      found = true;
    }
    sectionShow("未引用 pub 方法", reportBinNoiseDrop(toolNoiseDrop(report)));
    return found ? EXIT_FOUND : EXIT_OK;
  },
  // 未使用依赖: 0 干净，1 有发现，其余算错
  shearScan = async (option) => {
    let out = "",
      found = false;
    try {
      ({ stdout: out } = await $({ ...option })`cargo shear --color never`);
    } catch (err) {
      if (err.exitCode !== SHEAR_FOUND) {
        const dump = errDump(err);
        if (dump) process.stderr.write(dump + "\n");
        return EXIT_FAIL;
      }
      out = errDump(err);
      found = true;
    }
    sectionShow("未使用依赖", out.trim());
    return found ? EXIT_FOUND : EXIT_OK;
  };

const unusedScan = async () => {
  const [target_code, target] = await targetResolve(process.argv);
  if (target_code !== EXIT_OK) {
    process.stderr.write("目录不存在\n");
    return EXIT_FAIL;
  }
  const tmp_dir = await mkdtemp(join(tmpdir(), "unused."));
  try {
    const option = { quiet: true, cwd: target, env: RUN_ENV };
    await toolLiEnsure(option);
    const scip_path = join(tmp_dir, "index.scip"),
      config_path = join(tmp_dir, "ra.json");
    await Bun.write(config_path, JSON.stringify(RA_CONFIG));
    try {
      await $({ ...option })`rust-analyzer scip . --output ${scip_path} --config-path ${config_path}`;
    } catch (err) {
      const dump = raNoiseDrop(errDump(err));
      if (dump) process.stderr.write(dump + "\n");
      return EXIT_FAIL;
    }
    const pub_code = await pubScan(option, scip_path);
    if (pub_code === EXIT_FAIL) return EXIT_FAIL;
    const shear_code = await shearScan(option);
    if (shear_code === EXIT_FAIL) return EXIT_FAIL;
    return pub_code === EXIT_FOUND || shear_code === EXIT_FOUND ? EXIT_FOUND : EXIT_OK;
  } finally {
    await rm(tmp_dir, { recursive: true, force: true });
  }
};

const main = async () => {
  try {
    return await unusedScan();
  } catch (err) {
    process.stderr.write((err?.message ?? String(err)) + "\n");
    return EXIT_FAIL;
  }
};

export const run = unusedScan;

if (import.meta.main) process.exit(await main());
