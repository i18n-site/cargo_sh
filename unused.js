#!/usr/bin/env -S bun

// 未引用扫描: bun unused.js [目录]，缺省当前目录

import { $ } from "zx";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXIT_OK = 0,
  EXIT_FAIL = 1,
  EXIT_FOUND = 2,
  KIND_RUSTUP = 0,
  KIND_CARGO = 1,
  NOISE_TOOL_LI = ["cargo_workspace_unused_pub", "Running on", "Found "],
  BIN_PATH = "/src/bin/",
  ARG_TARGET = 2,
  OUT_STDOUT = 0,
  OUT_STDERR = 1;

const binHas = async (name, cwd) => {
    try {
      await $({ quiet: true, cwd })`command -v ${name}`;
      return true;
    } catch {
      return false;
    }
  },
  binEnsure = async (name, kind, pkg, cwd) => {
    if (await binHas(name, cwd)) return;
    process.stderr.write("缺少 " + name + "，正在安装\n");
    if (kind === KIND_RUSTUP) await $({ cwd })`rustup component add ${pkg}`;
    else await $({ cwd })`cargo install ${pkg}`;
  },
  toolNoiseDrop = (text) =>
    text
      .split("\n")
      .filter((line) => !NOISE_TOOL_LI.some((hit) => line.includes(hit)))
      .join("\n")
      .trim(),
  blockKeep = (block) => block && !block.includes(BIN_PATH),
  reportBinNoiseDrop = (text) =>
    text
      .split("\n\n")
      .filter(blockKeep)
      .join("\n\n")
      .trim(),
  outPick = (err, idx) => (idx === OUT_STDOUT ? err.stdout ?? "" : err.stderr ?? ""),
  errDump = (err) => (outPick(err, OUT_STDOUT) + outPick(err, OUT_STDERR)).trim(),
  manifestHas = async (dir) => {
    try {
      return (await stat(join(dir, "Cargo.toml"))).isFile();
    } catch {
      return false;
    }
  },
  workspaceTopFind = async (start) => {
    const { dirname } = await import("node:path");
    let cur = resolve(start),
      top = "";
    try {
      if (!(await stat(cur)).isDirectory()) return "";
    } catch {
      return "";
    }
    for (;;) {
      if (await manifestHas(cur)) top = cur;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return top;
  };

const targetResolve = async (argv) => {
  const start = resolve(argv[ARG_TARGET] || process.cwd()),
    top = await workspaceTopFind(start);
  if (!top) return [EXIT_FAIL, ""];
  return [EXIT_OK, top];
};

const unusedScan = async () => {
  const [target_code, target] = await targetResolve(process.argv);
  if (target_code !== EXIT_OK) {
    process.stderr.write("目录不存在\n");
    return EXIT_FAIL;
  }
  const tmp_dir = await mkdtemp(join(tmpdir(), "unused."));
  try {
    await binEnsure("rust-analyzer", KIND_RUSTUP, "rust-analyzer", target);
    await binEnsure("cargo-workspace-unused-pub", KIND_CARGO, "cargo-workspace-unused-pub", target);
    await binEnsure("cargo-shear", KIND_CARGO, "cargo-shear", target);
    const scip_path = join(tmp_dir, "index.scip"),
      config_path = join(tmp_dir, "ra.json");
    await Bun.write(config_path, JSON.stringify({ cargo: { allTargets: false }, cfg: { setTest: false } }));
    const run_env = { ...process.env, NO_COLOR: "1", CARGO_TERM_COLOR: "never", RA_LOG: "off", RUST_LOG: "off" },
      option = { quiet: true, cwd: target, env: run_env };
    try {
      await $({ ...option })`rust-analyzer scip . --output ${scip_path} --config-path ${config_path}`;
    } catch (err) {
      const dump = errDump(err);
      if (dump) process.stderr.write(dump + "\n");
      return EXIT_FAIL;
    }
    let report = "";
    try {
      ({ stdout: report } = await $({ ...option })`cargo workspace-unused-pub --scip ${scip_path}`);
    } catch (err) {
      if (err.exitCode !== EXIT_FOUND) {
        const dump = errDump(err);
        if (dump) process.stderr.write(dump + "\n");
        return err.exitCode ?? EXIT_FAIL;
      }
      report = toolNoiseDrop(errDump(err));
    }
    const report_body = reportBinNoiseDrop(report);
    if (report_body) console.log(report_body);
    try {
      await $({ ...option })`cargo shear --color never`;
    } catch (err) {
      const shear_out = errDump(err);
      if (shear_out) console.log(shear_out);
    }
  } finally {
    await rm(tmp_dir, { recursive: true, force: true });
  }
  return EXIT_OK;
};

export const run = unusedScan;

process.exit(await run());
