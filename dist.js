#!/usr/bin/env -S bun

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { $ } from "bun";

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
const rateLimitWaitSec = (output, default_sec = RETRY_DELAY_SEC) => {
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

const sleep = (sec) =>
  new Promise((resolve) => setTimeout(resolve, sec * 1000));

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
            .map((d) => d.name),
        });
      }
    }
  );

  const visit = (name) => {
    if (visited_set.has(name)) return;
    if (visiting_set.has(name)) {
      throw new Error("检测到循环依赖: " + name);
    }
    visiting_set.add(name);
    const pkg = pkg_map.get(name);
    if (pkg) {
      pkg.dep_li.forEach((dep) => {
        if (pkg_map.has(dep)) {
          visit(dep);
        }
      });
      visited_set.add(name);
      order_li.push(pkg);
    }
    visiting_set.delete(name);
  };

  pkg_map.keys().forEach((name) => visit(name));
  return order_li;
};

// 缓存 crates.io 线上包信息
const crates_io_cache = new Map();

// 2. 查询 crates.io 线上包信息（最新版本、全部已发布版本集合及关联仓库）
const cratesIoInfo = async (name) => {
  if (crates_io_cache.has(name)) {
    return crates_io_cache.get(name);
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
      crates_io_cache.set(name, info);
      return info;
    }
  } catch {}
  const info = [null, new Set(), null];
  crates_io_cache.set(name, info);
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

// 计算 crate 源码的 SHA-256 确定性哈希（基于 src/**/*.rs 与 build.rs）
const srcHash = async (dir) => {
  const src_dir = dir + "/src";
  if (!existsSync(src_dir)) return "";
  const glob = new Bun.Glob("**/*.rs"),
    rel_path_li = [...glob.scanSync({ cwd: src_dir })].sort();
  if (existsSync(dir + "/build.rs")) {
    rel_path_li.push("build.rs");
  }
  const encoder = new TextEncoder(),
    chunk_li = [];
  for (const rel_path of rel_path_li) {
    const file_path =
        rel_path === "build.rs" ? dir + "/build.rs" : src_dir + "/" + rel_path,
      content = await Bun.file(file_path).arrayBuffer();
    chunk_li.push(encoder.encode(rel_path + "\n"));
    chunk_li.push(new Uint8Array(content));
  }
  let total_len = 0;
  chunk_li.forEach((c) => (total_len += c.byteLength));
  const merged = new Uint8Array(total_len);
  let offset = 0;
  chunk_li.forEach((c) => {
    merged.set(c, offset);
    offset += c.byteLength;
  });
  const digest = await crypto.subtle.digest("SHA-256", merged);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    changed_pkg_set = new Set();

  for (const pkg of pkg_li) {
    const { name, version, dir, dep_li, repository: local_repo } = pkg,
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
      is_dep_changed = dep_li.some((d) => changed_pkg_set.has(d));

    if (is_published && !recorded_hash && cur_hash) {
      await crateHashWrite(dir, cur_hash);
    }

    let action = ACTION_SKIP,
      reason = "",
      target_ver = version;

    // 规范化仓库地址对比，检测是否可能误用他人已被占用的包名
    let repo_mismatch = false;
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
      reason =
        "本地 v" +
        version +
        " 低于线上最新 v" +
        max_ver +
        "，自动更新至 v" +
        target_ver;
    } else if (is_force) {
      action = is_published ? ACTION_BUMP_AND_PUBLISH : ACTION_PUBLISH_CURRENT;
      target_ver = is_published ? semverBump(version, bump_type) : version;
      reason = "强制发布 (--force)";
    } else if (!is_published) {
      action = ACTION_PUBLISH_CURRENT;
      reason = "线上 crates.io 暂无 v" + version;
    } else if (has_src_changes) {
      action = ACTION_BUMP_AND_PUBLISH;
      target_ver = semverBump(version, bump_type);
      reason = "检测到源码改动 (Hash 变更)";
    } else if (is_dep_changed) {
      action = ACTION_BUMP_AND_PUBLISH;
      target_ver = semverBump(version, bump_type);
      reason = "依赖的 workspace crate 发生升级";
    }

    if (action !== ACTION_SKIP) {
      changed_pkg_set.add(name);
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
      "==> 分析 Workspace (" +
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
      bump_type: pkg_bump_type,
      repo_mismatch,
    }) => {
      if (action === ACTION_PUBLISH_CURRENT) {
        console.log(
          "  " +
            GREEN +
            "[PUBLISH]" +
            RESET +
            " " +
            BOLD +
            name +
            RESET +
            " (当前 v" +
            version +
            ") -> 待发布 [" +
            reason +
            "]"
        );
      } else if (action === ACTION_BUMP_AND_PUBLISH) {
        console.log(
          "  " +
            CYAN +
            "[BUMP & PUBLISH]" +
            RESET +
            " " +
            BOLD +
            name +
            RESET +
            " (当前 v" +
            version +
            ") -> 待更新至 v" +
            target_ver +
            " (" +
            pkg_bump_type +
            ") 并发布 [" +
            reason +
            "]"
        );
      } else {
        console.log(
          "  " +
            DIM +
            "[SKIP]" +
            RESET +
            " " +
            name +
            " (当前 v" +
            version +
            ") -> 已是最新，跳过"
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
    console.log(GREEN + "该 Workspace 所有 crate 均已是最新版本，无需发布。" + RESET + "\n");
    return;
  }

  if (is_dry_run) {
    console.log(
      YELLOW + "[DRY-RUN] 预览模式已开启，不执行实际版本修改与发布。" + RESET + "\n"
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
    bump_type: pkg_bump_type,
    action,
    dir,
    cur_hash,
  } of to_publish_li) {
    const manifest_path = dir + "/Cargo.toml",
      original_manifest = await Bun.file(manifest_path).text(),
      rollback = async () => {
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
            CYAN + "==> 已自动还原 " + name + " 的版本修改至 v" + version + RESET
          );
        }
      };

    if (action === ACTION_BUMP_AND_PUBLISH) {
      console.log(
        CYAN +
          "==> 更新 " +
          name +
          " 版本至 v" +
          target_ver +
          " (" +
          pkg_bump_type +
          ")..." +
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
      CYAN + "==> 发布 " + name + " v" + new_ver + " 到 crates.io..." + RESET
    );

    let is_success = false;
    const start_time = Date.now();
    let retry = 0;

    while (true) {
      const res =
        await $`cargo publish --registry crates-io --allow-dirty -p ${name}`
          .cwd(root_dir)
          .nothrow();

      const output =
        (res.stderr ? res.stderr.toString() : "") +
        "\n" +
        (res.stdout ? res.stdout.toString() : "");

      if (
        res.exitCode === 0 ||
        output.includes("is already uploaded") ||
        (await cratesIoPublished(name, new_ver))
      ) {
        is_success = true;
        console.log(GREEN + "==> 成功发布 " + name + " v" + new_ver + RESET);
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
            "  提示: 请检查是否包名冲突（需在 Cargo.toml 中更改包名），或联系该 crate 所有者在 crates.io 邀请您为 owner。" +
            RESET
        );
        await rollback();
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
        await rollback();
        console.log("");
        process.exit(1);
      }

      // 3. 限流 (Rate Limit) 或 依赖索引未同步 (Retryable)
      const elapsed_sec = Math.round((Date.now() - start_time) / 1000),
        is_rate_limit = err_type === ERR_RATE_LIMIT,
        wait_sec = is_rate_limit
          ? rateLimitWaitSec(output, RETRY_DELAY_SEC)
          : RETRY_DELAY_SEC;

      if (elapsed_sec + wait_sec >= timeout_sec) {
        console.error(
          RED +
            "错误: 发布 " +
            name +
            " v" +
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

      retry++;
      if (is_rate_limit) {
        console.warn(
          YELLOW +
            "警告: 触发 crates.io 发布频次限制 (Rate Limit / 429)，等待 " +
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
            "警告: 发布遇到依赖索引尚未同步或网络抖动，" +
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
      await sleep(wait_sec);
    }

    if (!is_success) {
      console.error(
        RED +
          "错误: 发布 " +
          name +
          " v" +
          new_ver +
          " 失败，请检查错误后重试。" +
          RESET
      );
      await rollback();
      process.exit(1);
    }

    published_li.push({ name, version: new_ver });
    if (cur_hash) {
      await crateHashWrite(dir, cur_hash);
    }
    await sleep(INDEX_WAIT_SEC);
  }

  const published_summary = published_li
    .map((p) => p.name + "@" + p.version)
    .join(", ");
  console.log("\n" + GREEN + BOLD + "发布成功列表: " + RESET + published_summary);

  // 1. 先进行 Git 提交
  const git_status = (
    await $`git status --porcelain`.cwd(root_dir).quiet().text()
  ).trim();
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
    console.log(BLUE + "==> 已创建/更新 tag: " + tag_name + RESET);
  }

  console.log(CYAN + "==> 推送 Git 提交与 tags..." + RESET);
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
  let is_dry_run = false,
    is_force = false,
    no_test = false,
    bump_type = "patch",
    timeout_sec = PUBLISH_TIMEOUT_SEC;
  const specific_pkg_li = [];

  for (let i = 0; i < arg_li.length; ++i) {
    const arg = arg_li[i];
    if (arg === "-h" || arg === "--help") {
      console.log(`Usage: ./sh/dist.js [OPTIONS] [PACKAGE...]

一键自动检测 Rust Workspace 中有改动的 crate 并按依赖拓扑顺序自动发布到 crates.io。

Options:
  -n, --dry-run             仅检测并预览需要发布/升级的 crate，不执行实际修改与发布
  -b, --bump <TYPE>         当检测到代码修改时执行的版本递增级别: patch (默认), minor, major
  -t, --timeout <HOURS>     发布超时时间（小时），默认 48
      --no-test             跳过发布前的单元测试 (./test.sh)
  -f, --force               强制发布所有 publishable crate（忽略变更检测）
  -h, --help                显示帮助信息

Examples:
  ./sh/dist.js                 # 自动检测所有有改动或未发布的 crate 并一键发布
  ./sh/dist.js --dry-run       # 仅查看哪些 crate 需要升级和发布
  ./sh/dist.js --bump minor    # 若有改动，按 minor 级别递增版本并发布
  ./sh/dist.js zenoh_raft      # 仅处理指定的 crate`);
      return;
    } else if (arg === "-n" || arg === "--dry-run") {
      is_dry_run = true;
    } else if (arg === "-f" || arg === "--force") {
      is_force = true;
    } else if (arg === "-b" || arg === "--bump") {
      bump_type = arg_li[++i] || "patch";
    } else if (arg === "-t" || arg === "--timeout") {
      const val = parseFloat(arg_li[++i]);
      if (!isNaN(val) && val > 0) {
        timeout_sec = Math.round(val * 3600);
      }
    } else if (arg === "--no-test") {
      no_test = true;
    } else if (!arg.startsWith("-")) {
      specific_pkg_li.push(arg);
    }
  }

  const cur_dir = process.cwd();
  let workspace_dir_li = [];

  if (await Bun.file(cur_dir + "/Cargo.toml").exists()) {
    workspace_dir_li = [cur_dir];
  } else {
    // 若当前目录没有 Cargo.toml，检查子目录是否有 Cargo.toml
    const candidate_dir_li = ["embed", "node", "cluster"],
      matched_dir_li = specific_pkg_li.filter((p) =>
        candidate_dir_li.includes(p)
      );
    if (matched_dir_li.length > 0) {
      workspace_dir_li = matched_dir_li.map((d) => cur_dir + "/" + d);
      matched_dir_li.forEach((d) => {
        const idx = specific_pkg_li.indexOf(d);
        if (idx >= 0) specific_pkg_li.splice(idx, 1);
      });
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
    console.error(RED + "错误: 未找到包含 Cargo.toml 的 Workspace 目录！" + RESET);
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
