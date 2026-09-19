#!/usr/bin/env -S bun

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";
import yargs from "yargs";

const RESET = "\x1b[0m",
  BOLD = "\x1b[1m",
  DIM = "\x1b[2m",
  RED = "\x1b[31m",
  GREEN = "\x1b[32m",
  YELLOW = "\x1b[33m",
  BLUE = "\x1b[34m",
  CYAN = "\x1b[36m",
  ACTION_SKIP = 0,
  ACTION_PUBLISH_CURRENT = 1,
  ACTION_BUMP_AND_PUBLISH = 2,
  ERR_NONE = 0,
  ERR_UNAUTHORIZED = 1,
  ERR_RATE_LIMIT = 2,
  ERR_FATAL = 3,
  ERR_OTHER = 4,
  PUBLISH_TIMEOUT_SEC = 48 * 3600, // 发布超时 48 小时
  RETRY_DELAY_SEC = 20,
  INDEX_WAIT_SEC = 10;

// 提取 cargo 输出中的具体错误详情
const publishErrMsgExtract = (output) => {
  const caused_by = "Caused by:",
    idx = output.indexOf(caused_by);
  if (idx !== -1) {
    return output.slice(idx + caused_by.length).trim();
  }
  const line_li = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("error:"));
  if (line_li.length > 0) {
    return line_li.join("\n");
  }
  return output.trim();
};

// 分类发布错误类型（区分权限不足、频次限流、本地致命错误与重试错误）
const publishErrClassify = (output) => {
  const s = output.toLowerCase();

  // 1. 无权限 / 不是模块所有者 (403 Forbidden / 401 Unauthorized / not an owner)
  if (
    s.includes("not seem to be an owner") ||
    s.includes("not an owner") ||
    s.includes("status 403") ||
    s.includes("403 forbidden") ||
    s.includes("status 401") ||
    s.includes("401 unauthorized") ||
    s.includes("unauthorized") ||
    s.includes("permission denied") ||
    s.includes("access denied") ||
    s.includes("not authorized") ||
    s.includes("not permitted")
  ) {
    return ERR_UNAUTHORIZED;
  }

  // 2. 限流 (Rate Limit / 429 Too Many Requests)
  if (
    s.includes("status 429") ||
    s.includes("429 too many requests") ||
    s.includes("too many requests") ||
    s.includes("rate limit") ||
    s.includes("rate-limits") ||
    s.includes("published too many") ||
    s.includes("throttled")
  ) {
    return ERR_RATE_LIMIT;
  }

  // 3. 本地编译 / 打包配置致命错误 (重试无法解决)
  if (
    output.includes("error[E") ||
    s.includes("could not compile") ||
    s.includes("missing or empty metadata fields") ||
    s.includes("failed to parse manifest")
  ) {
    return ERR_FATAL;
  }

  return ERR_OTHER;
};

// 解析 crates.io 限流响应中的等待重试时长
const rateLimitSec = (output, default_sec = RETRY_DELAY_SEC) => {
  const m = output.match(/try again after\s+([^\n.]+?)(?:\s+and\s+see|\.|$)/i);
  if (m) {
    const target = Date.parse(m[1].trim());
    if (!isNaN(target)) {
      const diff_sec = Math.ceil((target - Date.now()) / 1000);
      if (diff_sec > 0) {
        // 多加 2 秒缓冲时间，确保 crates.io 服务端限流窗口已真正刷新
        return diff_sec + 2;
      }
    }
  }
  return default_sec;
};

const durationFormat = (sec) => {
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  if (h > 0) return h + "小时" + (m > 0 ? m + "分" : "") + (s > 0 ? s + "秒" : "");
  if (m > 0) return m + "分" + (s > 0 ? s + "秒" : "");
  return s + "秒";
};

// Semver 辅助函数
const semverParse = (ver) => {
  const [v] = ver.split("-"),
    [maj, min, pat] = v.split(".").map((n) => parseInt(n, 10) || 0);
  return [maj, min, pat];
};

const semverCmp = (v1, v2) => {
  const [maj1, min1, pat1] = semverParse(v1),
    [maj2, min2, pat2] = semverParse(v2);
  if (maj1 !== maj2) return maj1 - maj2;
  if (min1 !== min2) return min1 - min2;
  return pat1 - pat2;
};

const semverBump = (ver, bump_type = "patch") => {
  let [maj, min, pat] = semverParse(ver);
  if (bump_type === "major") {
    maj += 1;
    min = 0;
    pat = 0;
  } else if (bump_type === "minor") {
    min += 1;
    pat = 0;
  } else {
    pat += 1;
  }
  return maj + "." + min + "." + pat;
};

// 判定依赖目标版本是否会导致当前模块需要升级
const depUpgradeNeed = (req, target_ver) => {
  if (!req || req === "*") return false;
  // 匹配类似 "^0.1", "~0.1", "0.1", "^1" 等仅指定主/次版本的前缀要求
  const m = req.trim().match(/^([\^~])?(\d+)(?:\.(\d+))?$/);
  if (m) {
    const is_tilde = m[1] === "~",
      maj = parseInt(m[2], 10),
      min = m[3] !== undefined ? parseInt(m[3], 10) : null,
      [t_maj, t_min] = semverParse(target_ver);

    if (maj === 0) {
      // 0.x 阶段，不同 minor 互不兼容；若未指定 minor（即 ^0），则主版本 0 均兼容
      if (min === null) return t_maj !== 0;
      return !(t_maj === 0 && t_min === min);
    }
    // >= 1.0 阶段
    if (is_tilde) {
      if (min === null) return t_maj !== maj;
      return !(t_maj === maj && t_min === min);
    }
    if (min === null) return t_maj !== maj;
    return !(t_maj === maj && t_min >= min);
  }
  // 指定了具体 patch（三段式），或者包含复杂条件，需跟进升级
  return true;
};

// 1. 获取 Workspace 中所有可发布的 crate 并进行依赖拓扑排序
const workspacePkgLi = async (root_dir = process.cwd()) => {
  const meta = await $`cargo metadata --format-version=1 --no-deps`
      .cwd(root_dir)
      .json(),
    pkg_map = new Map(),
    order_li = [],
    visited_set = new Set(),
    visiting_set = new Set();

  meta.packages.forEach(
    ({ name, version, manifest_path, publish, dependencies, repository }) => {
      if (
        publish === null ||
        (Array.isArray(publish) && publish.length > 0)
      ) {
        pkg_map.set(name, {
          name,
          version,
          manifest_path,
          dir: dirname(manifest_path),
          repository,
          // 仅纳入路径依赖且排除 dev 依赖，避免测试用循环依赖引起假阳性
          dep_li: dependencies
            .filter((d) => d.path != null && d.kind !== "dev")
            .map((d) => ({ name: d.name, req: d.req })),
        });
      }
    }
  );

  const pkgVisit = (name) => {
    if (visited_set.has(name)) return;
    if (visiting_set.has(name)) {
      throw new Error("检测到循环依赖: " + name);
    }
    visiting_set.add(name);
    const pkg = pkg_map.get(name);
    if (pkg) {
      pkg.dep_li.forEach(({ name: dep_name }) => {
        if (pkg_map.has(dep_name)) {
          pkgVisit(dep_name);
        }
      });
      visited_set.add(name);
      order_li.push(pkg);
    }
    visiting_set.delete(name);
  };

  pkg_map.keys().forEach((name) => pkgVisit(name));
  return order_li;
};

// 缓存 crates.io 线上包信息
const CRATES_IO_CACHE = new Map();

// 2. 查询 crates.io 线上包信息（最新版本、全部已发布版本集合及关联仓库）
const cratesIoInfo = async (name) => {
  if (CRATES_IO_CACHE.has(name)) {
    return CRATES_IO_CACHE.get(name);
  }
  try {
    const res = await fetch("https://crates.io/api/v1/crates/" + name, {
      headers: { "User-Agent": "cargo-dist-bun" },
    });
    if (res.status === 200) {
      const data = await res.json(),
        max_ver = data.crate?.max_version ?? null,
        ver_set = new Set((data.versions ?? []).map((v) => v.num)),
        repo = data.crate?.repository ?? null,
        info = [max_ver, ver_set, repo];
      CRATES_IO_CACHE.set(name, info);
      return info;
    }
  } catch {}
  const info = [null, new Set(), null];
  CRATES_IO_CACHE.set(name, info);
  return info;
};

// 查询某个指定版本是否已成功发布到 crates.io
const cratesIoPublished = async (name, version) => {
  const [, ver_set] = await cratesIoInfo(name);
  if (ver_set.has(version)) return true;
  try {
    const res = await fetch(
      "https://crates.io/api/v1/crates/" + name + "/" + version,
      {
        headers: { "User-Agent": "cargo-dist-bun" },
      }
    );
    if (res.status === 200) {
      ver_set.add(version);
      return true;
    }
  } catch {}
  return false;
};

// 3. 统一代码格式化与确定性源码 Hash 计算
const cargoFmt = async (dir) => {
  await $`cargo fmt`.cwd(dir).quiet().nothrow();
};

const crateHashPath = (dir) => dir + "/.dist.hash";

const crateHashRead = async (dir) => {
  const file = Bun.file(crateHashPath(dir));
  if (await file.exists()) {
    return (await file.text()).trim();
  }
  return "";
};

const crateHashWrite = async (dir, hash) => {
  await Bun.write(crateHashPath(dir), hash.trim() + "\n");
};

// 计算 crate 源码的 SHA-256 确定性哈希（流式计算，涵盖 src/**/*.rs, build.rs 与 Cargo.toml 配置）
const srcHash = async (dir) => {
  const hasher = new Bun.CryptoHasher("sha256"),
    manifest_path = dir + "/Cargo.toml",
    build_rs = dir + "/build.rs",
    src_dir = dir + "/src";

  // 1. Cargo.toml 配置（剥离版本号行，仅追踪依赖和元数据配置变动）
  if (await Bun.file(manifest_path).exists()) {
    const text = await Bun.file(manifest_path).text(),
      norm_manifest = text
        .split("\n")
        .filter((l) => !/^\s*version\s*=\s*["'][^"']+["']/.test(l))
        .join("\n");
    hasher.update("Cargo.toml\n");
    hasher.update(norm_manifest);
  }

  // 2. build.rs 构建脚本
  if (existsSync(build_rs)) {
    hasher.update("build.rs\n");
    hasher.update(await Bun.file(build_rs).bytes());
  }

  // 3. src 源码文件（按字典序排序确保确定性）
  if (existsSync(src_dir)) {
    const glob = new Bun.Glob("**/*.rs"),
      rel_path_li = [...glob.scanSync({ cwd: src_dir })].sort();
    for (const rel_path of rel_path_li) {
      hasher.update(rel_path + "\n");
      hasher.update(await Bun.file(src_dir + "/" + rel_path).bytes());
    }
  }

  return hasher.digest("hex");
};

// 规范化仓库地址以进行匹配
const repoNorm = (url) =>
  url
    ? url
        .toLowerCase()
        .replace(/\.git$/, "")
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\/$/, "")
    : "";

// 4. 计算发布计划
const planMake = async (
  is_force = false,
  bump_type = "patch",
  specific_pkg_li = [],
  root_dir = process.cwd()
) => {
  const pkg_li = await workspacePkgLi(root_dir),
    plan_li = [],
    pkg_target_ver_map = new Map();

  for (const pkg of pkg_li) {
    const {
        name,
        version,
        dir,
        dep_li,
        repository: local_repo,
      } = pkg,
      pkg_folder = dir.split("/").pop();

    if (
      specific_pkg_li.length > 0 &&
      !specific_pkg_li.includes(name) &&
      !specific_pkg_li.includes(pkg_folder)
    ) {
      continue;
    }

    const [max_ver, ver_set, online_repo] = await cratesIoInfo(name),
      is_published = ver_set.has(version),
      cur_hash = await srcHash(dir),
      recorded_hash = await crateHashRead(dir),
      has_src_changes = recorded_hash ? cur_hash !== recorded_hash : false,
      is_dep_changed = dep_li.some(({ name: dep_name, req }) => {
        if (!pkg_target_ver_map.has(dep_name)) return false;
        const dep_target_ver = pkg_target_ver_map.get(dep_name);
        return depUpgradeNeed(req, dep_target_ver);
      });

    if (is_published && !recorded_hash && cur_hash) {
      await crateHashWrite(dir, cur_hash);
    }

    let action = ACTION_SKIP,
      reason = "",
      target_ver = version,
      repo_mismatch = false;
    if (online_repo && local_repo) {
      const o_norm = repoNorm(online_repo),
        l_norm = repoNorm(local_repo);
      if (o_norm !== l_norm) {
        const o_owner = o_norm.split("/")[0],
          l_owner = l_norm.split("/")[0];
        if (o_owner && l_owner && o_owner !== l_owner) {
          repo_mismatch = true;
        }
      }
    }

    // 关键：检测本地版本号是否过低（线上已存在大于本地的版本）
    const is_ver_too_low = max_ver != null && semverCmp(version, max_ver) < 0;

    if (is_ver_too_low) {
      action = ACTION_BUMP_AND_PUBLISH;
      target_ver = semverBump(max_ver, bump_type);
      reason = "低于线上最新 " + max_ver;
    } else if (is_force) {
      action = is_published ? ACTION_BUMP_AND_PUBLISH : ACTION_PUBLISH_CURRENT;
      target_ver = is_published ? semverBump(version, bump_type) : version;
      reason = "强制发布";
    } else if (!is_published) {
      action = ACTION_PUBLISH_CURRENT;
      reason = "线上未发布";
    } else if (has_src_changes) {
      action = ACTION_BUMP_AND_PUBLISH;
      target_ver = semverBump(version, bump_type);
      reason = "源码改动";
    } else if (is_dep_changed) {
      action = ACTION_BUMP_AND_PUBLISH;
      target_ver = semverBump(version, bump_type);
      reason = "依赖项升级";
    }

    if (action !== ACTION_SKIP) {
      pkg_target_ver_map.set(name, target_ver);
    }

    plan_li.push({
      name,
      version,
      target_ver,
      dir,
      dep_li,
      action,
      reason,
      bump_type,
      cur_hash,
      repo_mismatch: repo_mismatch ? [online_repo, local_repo] : null,
    });
  }

  return plan_li;
};

// 5. 单 Workspace 执行发布流程
const distWorkspaceRun = async (root_dir, options) => {
  const {
    is_dry_run,
    is_force,
    no_test,
    bump_type,
    timeout_sec,
    specific_pkg_li,
  } = options;

  console.log(
    CYAN +
      "==> 执行 cargo fmt 格式化代码..." +
      RESET
  );
  await cargoFmt(root_dir);
  console.log(
    CYAN +
      "==> 分析工作区 (" +
      root_dir +
      ") 依赖与发布状态..." +
      RESET +
      "\n"
  );
  const plan_li = await planMake(
      is_force,
      bump_type,
      specific_pkg_li,
      root_dir
    ),
    to_publish_li = plan_li.filter((p) => p.action !== ACTION_SKIP);

  plan_li.forEach(
    ({
      name,
      version,
      target_ver,
      action,
      reason,
      repo_mismatch,
    }) => {
      if (action === ACTION_PUBLISH_CURRENT) {
        console.log(
          "  " +
            GREEN +
            "[发布]" +
            RESET +
            " " +
            BOLD +
            name +
            RESET +
            " " +
            version +
            " (" +
            reason +
            ")"
        );
      } else if (action === ACTION_BUMP_AND_PUBLISH) {
        console.log(
          "  " +
            CYAN +
            "[升级]" +
            RESET +
            " " +
            BOLD +
            name +
            RESET +
            " " +
            version +
            " → " +
            target_ver +
            " (" +
            reason +
            ")"
        );
      } else {
        console.log(
          "  " +
            DIM +
            "[跳过]" +
            RESET +
            " " +
            name +
            " " +
            version +
            " (已是最新)"
        );
      }
      if (repo_mismatch) {
        const [o_repo, l_repo] = repo_mismatch;
        console.warn(
          "    " +
            YELLOW +
            "⚠️ 提示: 线上仓库 (" +
            o_repo +
            ") 与本地 (" +
            l_repo +
            ") 不一致，可能已被他人占用！" +
            RESET
        );
      }
    }
  );
  console.log("");

  if (to_publish_li.length === 0) {
    console.log(GREEN + "所有模块均已是最新版本，无需发布。" + RESET + "\n");
    return;
  }

  if (is_dry_run) {
    console.log(
      YELLOW + "[预览] 预览模式，不执行实际修改与发布。" + RESET + "\n"
    );
    return;
  }

  // 运行前置自动化测试
  if (!no_test) {
    console.log(CYAN + "==> 运行自动化测试..." + RESET);
    const has_test_sh = await Bun.file(root_dir + "/test.sh").exists(),
      test_res = has_test_sh
        ? await $`./test.sh`.cwd(root_dir).nothrow()
        : await $`cargo test --workspace --all-features`.cwd(root_dir).nothrow();

    if (test_res.exitCode !== 0) {
      console.error(RED + "错误: 测试失败，中止发布流程！" + RESET);
      process.exit(1);
    }
    console.log(GREEN + "==> 测试通过！" + RESET + "\n");
  }

  // 依次升级与发布
  const published_li = [],
    root_manifest_path = root_dir + "/Cargo.toml",
    root_manifest_exists = await Bun.file(root_manifest_path).exists(),
    root_original_manifest = root_manifest_exists
      ? await Bun.file(root_manifest_path).text()
      : null;

  for (const {
    name,
    version,
    target_ver,
    action,
    dir,
    cur_hash,
  } of to_publish_li) {
    const manifest_path = dir + "/Cargo.toml",
      original_manifest = await Bun.file(manifest_path).text(),
      manifestRollback = async () => {
        if (action === ACTION_BUMP_AND_PUBLISH) {
          await Bun.write(manifest_path, original_manifest);
          if (root_original_manifest != null) {
            await Bun.write(root_manifest_path, root_original_manifest);
          }
          await $`bun x cargo_upgrade`.cwd(root_dir).quiet().nothrow();
          if (root_original_manifest != null) {
            await Bun.write(root_manifest_path, root_original_manifest);
          }
          console.log(
            CYAN + "==> 已自动还原 " + name + " 版本至 " + version + RESET
          );
        }
      };

    if (action === ACTION_BUMP_AND_PUBLISH) {
      console.log(
        CYAN +
          "==> 更新 " +
          name +
          " " +
          version +
          " → " +
          target_ver +
          "..." +
          RESET
      );
      await $`cargo set-version ${target_ver} -p ${name}`.cwd(root_dir);
      await $`bun x cargo_upgrade`.cwd(root_dir).quiet().nothrow();
    }

    const meta = await $`cargo metadata --format-version=1 --no-deps`
        .cwd(root_dir)
        .json(),
      updated_pkg = meta.packages.find((p) => p.name === name),
      new_ver = updated_pkg?.version ?? target_ver ?? version;

    await $`bun x mdt .`.cwd(root_dir).quiet().nothrow();

    console.log(
      CYAN + "==> 发布 " + name + " " + new_ver + " 到 crates.io..." + RESET
    );

    let is_success = false,
      retry = 0;
    const start_time = Date.now();

    while (true) {
      const res =
          await $`cargo publish --registry crates-io --allow-dirty --no-verify -p ${name}`
            .cwd(root_dir)
            .nothrow(),
        output =
          (res.stderr ? res.stderr.toString() : "") +
          "\n" +
          (res.stdout ? res.stdout.toString() : "");

      if (
        res.exitCode === 0 ||
        output.includes("is already uploaded") ||
        (await cratesIoPublished(name, new_ver))
      ) {
        is_success = true;
        console.log(GREEN + "==> 成功发布 " + name + " " + new_ver + RESET);
        break;
      }

      const err_type = publishErrClassify(output),
        detail = publishErrMsgExtract(output);

      // 1. 无权限 / 不属于当前账号 (Fatal) -> 立即退出并提示，禁止反复重试
      if (err_type === ERR_UNAUTHORIZED) {
        console.error(
          "\n" +
            RED +
            BOLD +
            "错误: 发布 " +
            name +
            " 失败: 没有发布权限（该模块在 crates.io 上已被他人占用或不属于当前账号）！" +
            RESET
        );
        if (detail) {
          console.error(RED + "  详情: " + detail + RESET);
        }
        console.error(
          YELLOW +
            "  提示: 请检查是否包名冲突（需在 Cargo.toml 中更改包名），或联系该模块所有者在 crates.io 邀请您为所有者。" +
            RESET
        );
        await manifestRollback();
        console.log("");
        process.exit(1);
      }

      // 2. 本地编译 / 打包配置致命错误 (Fatal) -> 立即退出并提示
      if (err_type === ERR_FATAL) {
        console.error(
          "\n" +
            RED +
            BOLD +
            "错误: 发布 " +
            name +
            " 失败: 本地代码编译或 Cargo.toml 配置错误！" +
            RESET
        );
        if (detail) {
          console.error(RED + "  详情: " + detail + RESET);
        }
        await manifestRollback();
        console.log("");
        process.exit(1);
      }

      // 3. 限流 (Rate Limit) 或 依赖索引未同步 (Retryable)
      const elapsed_sec = Math.round((Date.now() - start_time) / 1000),
        is_rate_limit = err_type === ERR_RATE_LIMIT,
        wait_sec = is_rate_limit
          ? rateLimitSec(output, RETRY_DELAY_SEC)
          : RETRY_DELAY_SEC;

      if (elapsed_sec + wait_sec >= timeout_sec) {
        console.error(
          RED +
            "错误: 发布 " +
            name +
            " " +
            new_ver +
            " 超时 (" +
            durationFormat(elapsed_sec + wait_sec) +
            " >= " +
            durationFormat(timeout_sec) +
            ")！" +
            RESET
        );
        break;
      }

      ++retry;
      if (is_rate_limit) {
        console.warn(
          YELLOW +
            "警告: 触发 crates.io 发布频次限制，等待 " +
            wait_sec +
            " 秒后进行第 " +
            retry +
            " 次重试 (已等待 " +
            durationFormat(elapsed_sec) +
            " / 超时 " +
            durationFormat(timeout_sec) +
            ")..." +
            RESET
        );
      } else {
        console.warn(
          YELLOW +
            "警告: 依赖索引尚未同步或网络抖动，" +
            wait_sec +
            " 秒后进行第 " +
            retry +
            " 次重试 (已等待 " +
            durationFormat(elapsed_sec) +
            " / 超时 " +
            durationFormat(timeout_sec) +
            ")..." +
            RESET
        );
      }
      if (detail) {
        console.warn(DIM + "  提示: " + detail + RESET);
      }
      await Bun.sleep(wait_sec * 1000);
    }

    if (!is_success) {
      console.error(
        RED +
          "错误: 发布 " +
          name +
          " " +
          new_ver +
          " 失败，请检查错误后重试。" +
          RESET
      );
      await manifestRollback();
      process.exit(1);
    }

    published_li.push({ name, version: new_ver });
    if (cur_hash) {
      await crateHashWrite(dir, cur_hash);
    }
    await Bun.sleep(INDEX_WAIT_SEC * 1000);
  }

  const published_summary = published_li
      .map((p) => p.name + "@" + p.version)
      .join(", "),
    git_status = (
      await $`git status --porcelain`.cwd(root_dir).quiet().text()
    ).trim();

  console.log("\n" + GREEN + BOLD + "发布成功列表: " + RESET + published_summary);

  // 1. 先进行 Git 提交
  if (git_status) {
    console.log(CYAN + "==> 提交版本更新..." + RESET);
    await $`git add --all`.cwd(root_dir);
    const msg = "chore(release): " + published_summary;
    await $`git commit -m ${msg}`.cwd(root_dir).nothrow();
  }

  // 2. 在提交之后为发布的所有包创建 tag（确保 tag 准确指向 release commit）
  for (const { name, version } of published_li) {
    const tag_name = name + "-v" + version;
    await $`git tag -f ${tag_name}`.cwd(root_dir);
    console.log(BLUE + "==> 已创建/更新标签: " + tag_name + RESET);
  }

  console.log(CYAN + "==> 推送 Git 提交与标签..." + RESET);
  let cur_branch = "main";
  try {
    cur_branch =
      (await $`git branch --show-current`.cwd(root_dir).quiet().text()).trim() ||
      "main";
  } catch {}

  const push_res = await $`git push origin ${cur_branch} --tags`
    .cwd(root_dir)
    .nothrow();
  if (push_res.exitCode !== 0) {
    console.warn(YELLOW + "警告: Git 推送失败，请手动执行 git push。" + RESET);
  }

  console.log(GREEN + BOLD + "全部完成！" + RESET + "\n");
};

// 6. 主执行逻辑
const distRun = async (arg_li = process.argv.slice(2)) => {
  const argv = await yargs(arg_li)
    .scriptName("dist.js")
    .usage(
      "用法: ./sh/dist.js [选项] [模块名...]\n\n一键自动检测 Rust 工作区中有改动的模块并按依赖拓扑顺序自动发布到 crates.io。"
    )
    .option("dry-run", {
      alias: "n",
      type: "boolean",
      default: false,
      describe: "仅检测并预览需要发布/升级的模块，不执行实际修改与发布",
    })
    .option("bump", {
      alias: "b",
      type: "string",
      default: "patch",
      choices: ["patch", "minor", "major"],
      describe: "代码修改时版本递增级别: patch (默认), minor, major",
    })
    .option("timeout", {
      alias: "t",
      type: "number",
      default: 48,
      describe: "发布超时时间（小时），默认 48",
    })
    .option("test", {
      type: "boolean",
      default: true,
      describe: "是否在发布前执行单元测试 (./test.sh)",
    })
    .option("force", {
      alias: "f",
      type: "boolean",
      default: false,
      describe: "强制发布所有可发布模块（忽略变更检测）",
    })
    .help("h")
    .alias("h", "help")
    .describe("h", "显示帮助信息")
    .version(false)
    .example("./sh/dist.js", "自动检测所有有改动或未发布的模块并一键发布")
    .example("./sh/dist.js --dry-run", "仅查看哪些模块需要升级和发布")
    .example("./sh/dist.js --bump minor", "若有改动，按 minor 级别递增版本并发布")
    .example("./sh/dist.js wedb", "仅处理指定的模块")
    .locale("zh_CN")
    .parseAsync();

  const is_dry_run = Boolean(argv.dryRun),
    is_force = Boolean(argv.force),
    no_test = !Boolean(argv.test),
    bump_type = argv.bump || "patch",
    timeout_sec = Math.round((Number(argv.timeout) || 48) * 3600),
    specific_pkg_li = (argv._ || []).map(String),
    cur_dir = process.cwd();
  let workspace_dir_li = [];

  if (await Bun.file(cur_dir + "/Cargo.toml").exists()) {
    workspace_dir_li = [cur_dir];
  } else {
    // 若当前目录没有 Cargo.toml，检查子目录是否有 Cargo.toml
    const glob = new Bun.Glob("*/Cargo.toml"),
      sub_pkg_li = [...glob.scanSync({ cwd: cur_dir })].map((p) =>
        dirname(p)
      ),
      candidate_dir_li = [...new Set(sub_pkg_li)],
      matched_dir_li = specific_pkg_li.filter((p) =>
        candidate_dir_li.includes(p)
      );
    if (matched_dir_li.length > 0) {
      workspace_dir_li = matched_dir_li.map((d) => cur_dir + "/" + d);
    } else {
      for (const sub of candidate_dir_li) {
        const p = cur_dir + "/" + sub;
        if (await Bun.file(p + "/Cargo.toml").exists()) {
          workspace_dir_li.push(p);
        }
      }
    }
  }

  if (workspace_dir_li.length === 0) {
    console.error(RED + "错误: 未找到包含 Cargo.toml 的工作区目录！" + RESET);
    process.exit(1);
  }

  const options = {
    is_dry_run,
    is_force,
    no_test,
    bump_type,
    timeout_sec,
    specific_pkg_li,
  };

  for (const root_dir of workspace_dir_li) {
    await distWorkspaceRun(root_dir, options);
  }
};

if (import.meta.main) {
  await distRun();
}

export default distRun;
