#!/usr/bin/env -S bun

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
  MAX_RETRY = 5,
  RETRY_DELAY_SEC = 20,
  INDEX_WAIT_SEC = 10;

const sleep = (sec) =>
  new Promise((resolve) => setTimeout(resolve, sec * 1000));

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
    ({ name, version, manifest_path, publish, dependencies }) => {
      if (
        publish === null ||
        (Array.isArray(publish) && publish.length > 0)
      ) {
        pkg_map.set(name, {
          name,
          version,
          manifest_path,
          dir: dirname(manifest_path),
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

// 2. 查询 crates.io 线上版本是否存在
const cratesIoPublished = async (name, version) => {
  try {
    const res = await fetch("https://crates.io/api/v1/crates/" + name + "/" + version, {
      headers: { "User-Agent": "cargo-dist-bun" },
    });
    return res.status === 200;
  } catch {
    return false;
  }
};

// 3. 检测本地未提交修改及自上一次 Tag 以来的代码变更
const gitChangesCheck = async (dir, name, version) => {
  const uncommitted = (
    await $`git status --porcelain -- ${dir}`.quiet().text()
  ).trim();
  if (uncommitted) return true;

  const candidate_tag_li = [
    name + "-v" + version,
    name + "@v" + version,
    name + "@" + version,
    name + "-" + version,
    "v" + version,
  ];

  let found_tag = null;
  for (const tag of candidate_tag_li) {
    const res = await $`git rev-parse --verify --quiet refs/tags/${tag}`
      .quiet()
      .nothrow();
    if (res.exitCode === 0) {
      found_tag = tag;
      break;
    }
  }

  if (found_tag) {
    const diff = (
      await $`git diff --name-only ${found_tag}..HEAD -- ${dir}`
        .quiet()
        .text()
    ).trim();
    return Boolean(diff);
  }

  // 若无对应版本的 tag，尝试查找将当前版本写入 Cargo.toml 的 commit 作为锚点
  const commit_res = (
    await $`git log -n 1 -S ${'version = "' + version + '"'} --format=%H -- ${dir}/Cargo.toml`
      .quiet()
      .text()
  ).trim();

  if (commit_res) {
    const diff = (
      await $`git diff --name-only ${commit_res}..HEAD -- ${dir}`
        .quiet()
        .text()
    ).trim();
    return Boolean(diff);
  }

  // 线上如果已经存在该版本且无任何未提交代码与修改记录，默认无新改动
  return false;
};

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
    const { name, version, dir, dep_li } = pkg,
      pkg_folder = dir.split("/").pop();

    if (
      specific_pkg_li.length > 0 &&
      !specific_pkg_li.includes(name) &&
      !specific_pkg_li.includes(pkg_folder)
    ) {
      continue;
    }

    const is_published = await cratesIoPublished(name, version),
      has_git_changes = await gitChangesCheck(dir, name, version),
      is_dep_changed = dep_li.some((d) => changed_pkg_set.has(d));

    let action = ACTION_SKIP,
      reason = "";

    if (is_force) {
      action = is_published ? ACTION_BUMP_AND_PUBLISH : ACTION_PUBLISH_CURRENT;
      reason = "强制发布 (--force)";
    } else if (!is_published) {
      action = ACTION_PUBLISH_CURRENT;
      reason = "线上 crates.io 暂无 v" + version;
    } else if (has_git_changes) {
      action = ACTION_BUMP_AND_PUBLISH;
      reason = "检测到代码改动";
    } else if (is_dep_changed) {
      action = ACTION_BUMP_AND_PUBLISH;
      reason = "依赖的 workspace crate 发生升级";
    }

    if (action !== ACTION_SKIP) {
      changed_pkg_set.add(name);
    }

    plan_li.push({
      name,
      version,
      dir,
      dep_li,
      action,
      reason,
      bump_type,
    });
  }

  return plan_li;
};

// 5. 主执行逻辑
const distRun = async (arg_li = process.argv.slice(2)) => {
  let is_dry_run = false,
    is_force = false,
    no_test = false,
    bump_type = "patch";
  const specific_pkg_li = [];

  for (let i = 0; i < arg_li.length; ++i) {
    const arg = arg_li[i];
    if (arg === "-h" || arg === "--help") {
      console.log(`Usage: ./sh/dist.js [OPTIONS] [PACKAGE...]

一键自动检测 Rust Workspace 中有改动的 crate 并按依赖拓扑顺序自动发布到 crates.io。

Options:
  -n, --dry-run             仅检测并预览需要发布/升级的 crate，不执行实际修改与发布
  -b, --bump <TYPE>         当检测到代码修改时执行的版本递增级别: patch (默认), minor, major
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
    } else if (arg === "--no-test") {
      no_test = true;
    } else if (!arg.startsWith("-")) {
      specific_pkg_li.push(arg);
    }
  }

  console.log(CYAN + "==> 分析 Workspace 依赖与发布状态..." + RESET + "\n");
  const plan_li = await planMake(is_force, bump_type, specific_pkg_li),
    to_publish_li = plan_li.filter((p) => p.action !== ACTION_SKIP);

  plan_li.forEach(({ name, version, action, reason, bump_type: pkg_bump_type }) => {
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
          ") -> 待递增 (" +
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
  });
  console.log("");

  if (to_publish_li.length === 0) {
    console.log(GREEN + "所有 crate 均已是最新版本，无需发布。" + RESET);
    return;
  }

  if (is_dry_run) {
    console.log(YELLOW + "[DRY-RUN] 预览模式已开启，不执行实际版本修改与发布。" + RESET);
    return;
  }

  // 运行前置自动化测试
  if (!no_test) {
    console.log(CYAN + "==> 运行自动化测试..." + RESET);
    const has_test_sh = (
        await $`test -f ./test.sh`.quiet().nothrow()
      ).exitCode === 0,
      test_res = has_test_sh
        ? await $`./test.sh`.nothrow()
        : await $`cargo test --workspace --all-features`.nothrow();

    if (test_res.exitCode !== 0) {
      console.error(RED + "错误: 测试失败，中止发布流程！" + RESET);
      process.exit(1);
    }
    console.log(GREEN + "==> 测试通过！" + RESET + "\n");
  }

  // 依次升级与发布
  const published_li = [];

  for (const { name, version, bump_type: pkg_bump_type, action } of to_publish_li) {
    if (action === ACTION_BUMP_AND_PUBLISH) {
      console.log(CYAN + "==> 递增 " + name + " 版本 (" + pkg_bump_type + ")..." + RESET);
      await $`cargo set-version --bump ${pkg_bump_type} -p ${name}`;
      await $`bun x cargo_upgrade`.quiet().nothrow();
    }

    const meta = await $`cargo metadata --format-version=1 --no-deps`.json(),
      updated_pkg = meta.packages.find((p) => p.name === name),
      new_ver = updated_pkg?.version ?? version;

    await $`bun x mdt .`.quiet().nothrow();

    console.log(CYAN + "==> 发布 " + name + " v" + new_ver + " 到 crates.io..." + RESET);

    let is_success = false;

    for (let retry = 0; retry < MAX_RETRY; ++retry) {
      const res =
        await $`cargo publish --registry crates-io --allow-dirty -p ${name}`.nothrow();
      if (res.exitCode === 0) {
        is_success = true;
        console.log(GREEN + "==> 成功发布 " + name + " v" + new_ver + RESET);
        break;
      }

      if (retry < MAX_RETRY - 1) {
        console.warn(
          YELLOW +
            "警告: 发布遇到限制或依赖索引尚未同步，" +
            RETRY_DELAY_SEC +
            " 秒后进行第 " +
            (retry + 1) +
            "/" +
            MAX_RETRY +
            " 次重试..." +
            RESET
        );
        await sleep(RETRY_DELAY_SEC);
      }
    }

    if (!is_success) {
      console.error(RED + "错误: 发布 " + name + " v" + new_ver + " 失败，请检查错误后重试。" + RESET);
      process.exit(1);
    }

    published_li.push({ name, version: new_ver });
    await sleep(INDEX_WAIT_SEC);
  }

  const published_summary = published_li
    .map((p) => p.name + "@" + p.version)
    .join(", ");
  console.log("\n" + GREEN + BOLD + "发布成功列表: " + RESET + published_summary);

  // 1. 先进行 Git 提交
  const git_status = (await $`git status --porcelain`.quiet().text()).trim();
  if (git_status) {
    console.log(CYAN + "==> 提交版本更新..." + RESET);
    await $`git add -u`;
    await $`git add Cargo.lock`.quiet().nothrow();
    const msg = "chore(release): " + published_summary;
    await $`git commit -m ${msg}`.nothrow();
  }

  // 2. 在提交之后为发布的所有包创建 tag（确保 tag 准确指向 release commit）
  for (const { name, version } of published_li) {
    const tag_name = name + "-v" + version;
    await $`git tag -f ${tag_name}`;
    console.log(BLUE + "==> 已创建/更新 tag: " + tag_name + RESET);
  }

  console.log(CYAN + "==> 推送 Git 提交与 tags..." + RESET);
  let cur_branch = "main";
  try {
    cur_branch =
      (await $`git branch --show-current`.quiet().text()).trim() || "main";
  } catch {}

  const push_res = await $`git push origin ${cur_branch} --tags`.nothrow();
  if (push_res.exitCode !== 0) {
    console.warn(YELLOW + "警告: Git 推送失败，请手动执行 git push。" + RESET);
  }

  console.log(GREEN + BOLD + "全部完成！" + RESET);
};

if (import.meta.main) {
  await distRun();
}

export default distRun;
