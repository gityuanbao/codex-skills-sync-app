#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const childProcess = require("child_process");

const VERSION = "0.2.0";
const DEFAULT_BRANCH = "main";
const CONFIG_ENV = "SKILL_SYNC_CONFIG";
const REPO_ENV = "SKILL_SYNC_REPO";
const SKILLS_ENV = "SKILL_SYNC_SKILLS_DIR";
const CODEX_HOME_ENV = "CODEX_HOME";

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positionals[0] || "help";

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return;
      case "version":
      case "--version":
      case "-v":
        console.log(VERSION);
        return;
      case "init":
        commandInit(parsed);
        return;
      case "import":
        commandImport(parsed);
        return;
      case "pull":
        commandPull(parsed);
        return;
      case "publish":
        commandPublish(parsed);
        return;
      case "sync":
        commandSync(parsed);
        return;
      case "status":
        commandStatus(parsed);
        return;
      case "doctor":
        commandDoctor(parsed);
        return;
      case "link":
        commandLink(parsed);
        return;
      case "hook":
        commandHook(parsed);
        return;
      case "install-hook":
        commandInstallHook(parsed);
        return;
      default:
        throw new Error(`未知命令：${command}。运行 "skill-sync help" 查看帮助。`);
    }
  } catch (error) {
    if (!parsed.options.quiet) {
      console.error(`skill-sync: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--no-")) {
      options[toCamel(token.slice(5))] = false;
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
      const key = toCamel(rawKey);
      if (inlineValue !== undefined) {
        options[key] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }

    if (token.startsWith("-")) {
      const flag = token.slice(1);
      if (flag === "q") {
        options.quiet = true;
      } else if (flag === "j") {
        options.json = true;
      } else {
        throw new Error(`不支持的短选项：${token}`);
      }
    }
  }

  return { options, positionals };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`Codex 技能同步器 ${VERSION}

用法：
  skill-sync init [remote] [--repo PATH] [--skills-dir PATH] [--import-existing]
  skill-sync import [--prune|--no-prune]
  skill-sync pull [--quiet] [--prune] [--force]
  skill-sync publish [--message TEXT] [--no-push] [--no-pull]
  skill-sync sync [--message TEXT] [--no-push]
  skill-sync status [--json]
  skill-sync doctor [--json]
  skill-sync link [--backup-existing]
  skill-sync hook
  skill-sync install-hook --target PATH [--write]

同步范围：
  - 只同步包含 SKILL.md 的技能目录。
  - 不同步登录态、token、缓存，也不会同步整个 ~/.codex。

常用环境变量：
  ${CONFIG_ENV}       覆盖配置文件路径。
  ${REPO_ENV}         覆盖同步仓库路径。
  ${SKILLS_ENV}   覆盖 Codex 技能目录。
  ${CODEX_HOME_ENV}              用于发现 ~/.codex/skills。
`);
}

function commandInit(parsed) {
  ensureGit();

  const options = parsed.options;
  const remote = options.remote || parsed.positionals[1] || "";
  const config = loadConfig(options);
  const settings = resolveSettings(options, config, { allowMissingConfig: true });

  return withSyncLock(settings, () => {

  if (fs.existsSync(settings.repoDir) && !isDirectory(settings.repoDir)) {
    throw new Error(`同步仓库路径已存在，但不是目录：${settings.repoDir}`);
  }

  if (!fs.existsSync(path.join(settings.repoDir, ".git"))) {
    if (remote) {
      ensureDir(path.dirname(settings.repoDir));
      const cloneArgs = ["clone"];
      if (options.branch) {
        cloneArgs.push("--branch", String(options.branch));
      }
      cloneArgs.push(remote, settings.repoDir);
      runGit(cloneArgs, { cwd: process.cwd() });
    } else {
      ensureDir(settings.repoDir);
      runGit(["init", "-b", settings.branch], { cwd: settings.repoDir, allowFail: true });
      if (!fs.existsSync(path.join(settings.repoDir, ".git"))) {
        runGit(["init"], { cwd: settings.repoDir });
        runGit(["checkout", "-B", settings.branch], { cwd: settings.repoDir, allowFail: true });
      }
    }
  }

  ensureDir(settings.repoSkillsDir);
  writeRepoScaffold(settings.repoDir);

  if (remote && !gitRemoteUrl(settings.repoDir, "origin")) {
    runGit(["remote", "add", "origin", remote], { cwd: settings.repoDir });
  }

  const nextConfig = {
    repoDir: settings.repoDir,
    skillsDir: settings.skillsDir,
    branch: gitCurrentBranch(settings.repoDir) || settings.branch,
    remote: remote || config.remote || gitRemoteUrl(settings.repoDir, "origin") || "",
    initialDirection: options.importExisting ? "local" : "remote"
  };
  saveConfig(options, nextConfig);

  if (options.importExisting) {
    mirrorSkills(settings.skillsDir, settings.repoSkillsDir, { prune: false });
  }

  printObjectOrText(options, {
    configPath: getConfigPath(options),
    repoDir: settings.repoDir,
    skillsDir: settings.skillsDir,
    remote: nextConfig.remote,
    imported: Boolean(options.importExisting)
  }, [
    "Codex 技能同步器已初始化。",
    `配置文件：${getConfigPath(options)}`,
    `同步仓库：${settings.repoDir}`,
    `Codex 技能目录：${settings.skillsDir}`,
    options.importExisting ? "已将现有技能导入 repo/skills。" : "运行 skill-sync import 可将当前技能复制到同步仓库。"
  ]);
  });
}

function commandImport(parsed) {
  const settings = requireSettings(parsed.options);
  return withSyncLock(settings, () => {
  const prune = parsed.options.prune !== false;
  const result = mirrorSkills(settings.skillsDir, settings.repoSkillsDir, { prune });
  printObjectOrText(parsed.options, result, [
    `已导入 ${result.copied.length} 个技能到 ${settings.repoSkillsDir}。`,
    result.removed.length ? `已移除 ${result.removed.length} 个本机不存在的仓库技能。` : "没有移除仓库技能。"
  ]);
  });
}

function commandPull(parsed) {
  const options = parsed.options;
  const settings = requireSettings(options);
  return withSyncLock(settings, () => {
  ensureGit();
  ensureRepo(settings.repoDir);

  const dirty = gitDirty(settings.repoDir);
  if (dirty.length && !options.force) {
    const message = "同步仓库有未发布改动，已跳过拉取。请先运行 skill-sync publish，或使用 --force。";
    if (options.quiet) {
      return;
    }
    printObjectOrText(options, { skipped: true, reason: message, dirty }, [message]);
    return;
  }

  const remote = gitRemoteUrl(settings.repoDir, "origin");
  let pulled = false;
  if (remote) {
    runGit(["pull", "--ff-only"], { cwd: settings.repoDir });
    pulled = true;
  }

  const result = applyRepoSkills(settings, {
    prune: Boolean(options.prune),
    force: Boolean(options.force),
    quiet: Boolean(options.quiet)
  });

  if (!options.quiet) {
    printObjectOrText(options, { pulled, ...result }, [
      pulled ? "已拉取最新同步仓库。" : "没有配置 origin 远程仓库，已跳过 git pull。",
      `已应用 ${result.applied.length} 个技能。`,
      result.conflicts.length ? `发现 ${result.conflicts.length} 个冲突，本机技能未被覆盖。` : "没有冲突。"
    ]);
  }
  });
}

function commandPublish(parsed) {
  const options = parsed.options;
  const settings = requireSettings(options);
  return withSyncLock(settings, () => {
  ensureGit();
  ensureRepo(settings.repoDir);

  if (options.pull !== false && gitRemoteUrl(settings.repoDir, "origin")) {
    const dirtyBefore = gitDirty(settings.repoDir);
    if (!dirtyBefore.length) {
      runGit(["pull", "--ff-only"], { cwd: settings.repoDir });
    }
  }

  const mirrorResult = mirrorSkills(settings.skillsDir, settings.repoSkillsDir, {
    prune: options.prune !== false
  });

  runGit(["add", ".gitignore", "skill-sync.json", "skills"], { cwd: settings.repoDir });

  const dirty = gitDirty(settings.repoDir);
  if (!dirty.length) {
    printObjectOrText(options, { changed: false, mirror: mirrorResult }, ["没有需要发布的技能改动。"]);
    return;
  }

  ensureGitIdentity(settings.repoDir);
  const message = options.message || `从 ${os.hostname()} 同步 Codex 技能`;
  runGit(["commit", "-m", String(message)], { cwd: settings.repoDir });

  const hasRemote = Boolean(gitRemoteUrl(settings.repoDir, "origin"));
  let pushed = false;
  if (hasRemote && options.push !== false) {
    runGit(["push"], { cwd: settings.repoDir });
    pushed = true;
  }

  writeApplyState(settings, readRepoSkillHashes(settings.repoSkillsDir));

  printObjectOrText(options, { changed: true, pushed, mirror: mirrorResult }, [
    "已发布本机 Codex 技能。",
    pushed ? "已推送到 origin。" : "改动已在本地提交，没有执行 push。"
  ]);
  });
}

function commandSync(parsed) {
  const options = parsed.options;
  const settings = requireSettings(options);
  return withSyncLock(settings, () => performSync(parsed, settings));
}

function performSync(parsed, settings) {
  const options = parsed.options;
  ensureGit();
  ensureRepo(settings.repoDir);

  const branch = gitCurrentBranch(settings.repoDir) || settings.branch;
  const remote = gitRemoteUrl(settings.repoDir, "origin");
  let pulled = false;

  if (!hasApplyState(settings) && settings.initialDirection !== "local") {
    if (remote && !gitDirty(settings.repoDir).length && remoteBranchExists(settings.repoDir, branch)) {
      pullWithRebase(settings.repoDir, branch);
      pulled = true;
    }

    const initialApply = applyRepoSkills(settings, {
      prune: false,
      force: false,
      quiet: Boolean(options.quiet)
    });
    if (initialApply.conflicts.length) {
      fs.rmSync(getStatePath(settings), { force: true });
      throw new Error([
        "首次同步发现本机与远程存在同名但内容不同的技能，未覆盖任何版本。",
        ...initialApply.conflicts.map((item) => `  ${item.name}: ${item.local} | ${item.incoming}`)
      ].join("\n"));
    }
  }

  const mirrorResult = mirrorSkills(settings.skillsDir, settings.repoSkillsDir, {
    prune: options.prune !== false
  });

  runGit(["add", ".gitignore", "skill-sync.json", "skills"], { cwd: settings.repoDir });

  let committed = false;
  if (gitHasStagedChanges(settings.repoDir)) {
    ensureGitIdentity(settings.repoDir);
    const message = options.message || `从 ${os.hostname()} 自动同步 Codex 技能`;
    runGit(["commit", "-m", String(message)], { cwd: settings.repoDir });
    committed = true;
  }

  const remainingDirty = gitDirty(settings.repoDir);
  if (remainingDirty.length) {
    throw new Error([
      "同步仓库还有未处理的改动，自动同步已暂停。",
      ...remainingDirty.map((line) => `  ${line}`)
    ].join("\n"));
  }

  let pushed = false;

  if (remote && remoteBranchExists(settings.repoDir, branch)) {
    pullWithRebase(settings.repoDir, branch);
    pulled = true;
  }

  if (remote && options.push !== false) {
    const pushResult = pushBranch(settings.repoDir, branch, { allowFail: true });
    if (pushResult.status !== 0 && isNonFastForward(pushResult)) {
      pullWithRebase(settings.repoDir, branch);
      pulled = true;
      pushBranch(settings.repoDir, branch);
    } else if (pushResult.status !== 0) {
      throw commandResultError("git push", pushResult);
    }
    pushed = true;
  }

  const applyResult = applyRepoSkills(settings, {
    prune: true,
    force: true,
    quiet: Boolean(options.quiet)
  });

  if (!options.quiet) {
    printObjectOrText(options, {
      changed: committed,
      committed,
      pulled,
      pushed,
      branch,
      mirror: mirrorResult,
      apply: applyResult
    }, [
      committed ? "已保存本机技能改动。" : "本机没有新的技能改动。",
      pulled ? "已合并远程技能版本。" : remote ? "远程分支尚未创建，已准备首次推送。" : "没有配置远程仓库。",
      pushed ? "已推送最新技能版本。" : "没有执行远程推送。",
      `已应用 ${applyResult.applied.length} 个技能。`
    ]);
  }
}

function commandStatus(parsed) {
  const options = parsed.options;
  const settings = requireSettings(options);
  const repoSkills = listSkills(settings.repoSkillsDir);
  const localSkills = listSkills(settings.skillsDir);
  const repoHashes = hashSkills(settings.repoSkillsDir, repoSkills);
  const localHashes = hashSkills(settings.skillsDir, localSkills);
  const allNames = Array.from(new Set([...Object.keys(repoHashes), ...Object.keys(localHashes)])).sort();
  const skills = allNames.map((name) => {
    const inRepo = Object.prototype.hasOwnProperty.call(repoHashes, name);
    const local = Object.prototype.hasOwnProperty.call(localHashes, name);
    let state = "same";
    if (inRepo && !local) state = "missing-local";
    if (!inRepo && local) state = "local-only";
    if (inRepo && local && repoHashes[name] !== localHashes[name]) state = "different";
    return { name, state };
  });

  const result = {
    configPath: getConfigPath(options),
    repoDir: settings.repoDir,
    skillsDir: settings.skillsDir,
    remote: gitRemoteUrl(settings.repoDir, "origin") || "",
    gitDirty: fs.existsSync(path.join(settings.repoDir, ".git")) ? gitDirty(settings.repoDir) : [],
    skills
  };

  printObjectOrText(options, result, [
    `配置文件：${result.configPath}`,
    `同步仓库：${result.repoDir}`,
    `Codex 技能目录：${result.skillsDir}`,
    result.remote ? `远程仓库：${result.remote}` : "远程仓库：无",
    result.gitDirty.length ? `同步仓库有 ${result.gitDirty.length} 项未提交改动。` : "同步仓库是干净的。",
    ...skills.map((skill) => `- ${skill.name}: ${localizeSkillState(skill.state)}`)
  ]);
}

function commandDoctor(parsed) {
  const options = parsed.options;
  const config = loadConfig(options);
  const settings = resolveSettings(options, config, { allowMissingConfig: true });
  const checks = [];

  checks.push(check("node", true, process.version));
  checks.push(check("git", commandExists("git"), safeCommand(["git", "--version"])));
  checks.push(check("config", fs.existsSync(getConfigPath(options)), getConfigPath(options)));
  checks.push(check("repoDir", fs.existsSync(settings.repoDir), settings.repoDir));
  checks.push(check("repoGit", fs.existsSync(path.join(settings.repoDir, ".git")), path.join(settings.repoDir, ".git")));
  checks.push(check("repoSkills", fs.existsSync(settings.repoSkillsDir), settings.repoSkillsDir));
  checks.push(check("skillsDir", fs.existsSync(settings.skillsDir), settings.skillsDir));
  checks.push(check("skillsMode", true, isSymlink(settings.skillsDir) ? "symlink" : "copy"));

  const localCount = listSkills(settings.skillsDir).length;
  const repoCount = listSkills(settings.repoSkillsDir).length;
  checks.push(check("localSkillCount", localCount > 0, String(localCount)));
  checks.push(check("repoSkillCount", repoCount > 0, String(repoCount)));

  const result = {
    settings,
    checks
  };

  printObjectOrText(options, result, checks.map((item) => {
    const mark = item.ok ? "通过" : "提醒";
    return `${mark} ${item.name}: ${item.detail}`;
  }));
}

function commandLink(parsed) {
  const options = parsed.options;
  const settings = requireSettings(options);
  return withSyncLock(settings, () => {
  ensureDir(settings.repoSkillsDir);
  ensureDir(path.dirname(settings.skillsDir));

  if (fs.existsSync(settings.skillsDir)) {
    if (sameRealPath(settings.skillsDir, settings.repoSkillsDir)) {
      printObjectOrText(options, { linked: true, changed: false }, ["技能目录已经指向同步仓库的 skills 目录。"]);
      return;
    }

    if (!options.backupExisting) {
      throw new Error(`技能目录已经存在：${settings.skillsDir}。请先导入当前技能，再使用 --backup-existing。`);
    }

    const backupPath = `${settings.skillsDir}.backup-${timestamp()}`;
    fs.renameSync(settings.skillsDir, backupPath);
    createSkillSymlink(settings.repoSkillsDir, settings.skillsDir);
    printObjectOrText(options, { linked: true, backupPath }, [
      `已将现有技能移动到备份目录：${backupPath}。`,
      `已链接 ${settings.skillsDir} -> ${settings.repoSkillsDir}。`
    ]);
    return;
  }

  createSkillSymlink(settings.repoSkillsDir, settings.skillsDir);
  printObjectOrText(options, { linked: true }, [`已链接 ${settings.skillsDir} -> ${settings.repoSkillsDir}。`]);
  });
}

function commandHook(parsed) {
  const settings = requireSettings(parsed.options);
  const hook = buildHookSnippet(settings);
  if (parsed.options.json) {
    console.log(JSON.stringify(hook, null, 2));
  } else {
    console.log(JSON.stringify(hook, null, 2));
  }
}

function commandInstallHook(parsed) {
  const options = parsed.options;
  const settings = requireSettings(options);
  const target = options.target ? expandPath(String(options.target)) : "";
  if (!target) {
    throw new Error("install-hook 需要 --target PATH。请先运行 skill-sync hook 查看片段。");
  }

  const hook = buildHookSnippet(settings, options.runnerCommand ? String(options.runnerCommand) : "");
  if (!options.write) {
    printObjectOrText(options, { target, hook }, [
      `预演模式。添加 --write 才会更新 ${target}。`,
      JSON.stringify(hook, null, 2)
    ]);
    return;
  }

  ensureDir(path.dirname(target));
  let current = {};
  if (fs.existsSync(target)) {
    current = JSON.parse(fs.readFileSync(target, "utf8"));
  }
  const merged = mergeHookConfig(current, hook);
  writeJson(target, merged);
  printObjectOrText(options, { target, installed: true }, [`已将 hook 安装到 ${target}。`]);
}

function requireSettings(options) {
  const config = loadConfig(options, { required: true });
  const settings = resolveSettings(options, config);
  if (!fs.existsSync(settings.repoDir)) {
    throw new Error(`同步仓库不存在：${settings.repoDir}。请先运行 skill-sync init。`);
  }
  return settings;
}

function resolveSettings(options, config, behavior = {}) {
  const home = os.homedir();
  const repoDir = expandPath(String(options.repo || process.env[REPO_ENV] || config.repoDir || path.join(home, ".codex-skill-sync", "repo")));
  const skillsDir = expandPath(String(options.skillsDir || process.env[SKILLS_ENV] || config.skillsDir || discoverSkillsDir(home)));
  const branch = String(options.branch || config.branch || DEFAULT_BRANCH);
  return {
    configPath: getConfigPath(options),
    repoDir,
    repoSkillsDir: path.join(repoDir, "skills"),
    skillsDir,
    branch,
    initialDirection: String(config.initialDirection || ""),
    allowMissingConfig: Boolean(behavior.allowMissingConfig)
  };
}

function discoverSkillsDir(home) {
  const codexHome = process.env[CODEX_HOME_ENV] ? expandPath(process.env[CODEX_HOME_ENV]) : path.join(home, ".codex");
  const candidates = [
    path.join(home, ".agents", "skills"),
    path.join(codexHome, "skills"),
    path.join(home, ".codex", "skills")
  ];

  const existingWithSkills = candidates.find((candidate) => listSkills(candidate).length > 0);
  if (existingWithSkills) return existingWithSkills;

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing || candidates[0];
}

function getConfigPath(options) {
  return expandPath(String(options.config || process.env[CONFIG_ENV] || path.join(os.homedir(), ".codex-skill-sync", "config.json")));
}

function loadConfig(options, behavior = {}) {
  const configPath = getConfigPath(options);
  if (!fs.existsSync(configPath)) {
    if (behavior.required) {
      throw new Error(`没有找到配置文件：${configPath}。请先运行 skill-sync init，或传入 --config。`);
    }
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function saveConfig(options, value) {
  const configPath = getConfigPath(options);
  ensureDir(path.dirname(configPath));
  writeJson(configPath, value);
}

function writeRepoScaffold(repoDir) {
  const ignorePath = path.join(repoDir, ".gitignore");
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, [".DS_Store", ".skill-sync-conflicts/", ""].join("\n"));
  }
  const metadataPath = path.join(repoDir, "skill-sync.json");
  if (!fs.existsSync(metadataPath)) {
    writeJson(metadataPath, {
      schemaVersion: 1,
      description: "基于 Git 的 Codex 技能同步仓库。",
      skillsPath: "skills"
    });
  }
}

function mirrorSkills(sourceRoot, targetRoot, options = {}) {
  ensureDir(targetRoot);
  const sourceSkills = listSkills(sourceRoot);
  const copied = [];
  const removed = [];

  for (const name of sourceSkills) {
    const source = path.join(sourceRoot, name);
    const target = path.join(targetRoot, name);
    replaceDirectory(source, target);
    copied.push(name);
  }

  if (options.prune) {
    for (const name of listSkills(targetRoot)) {
      if (!sourceSkills.includes(name)) {
        fs.rmSync(path.join(targetRoot, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
  }

  return { copied, removed };
}

function applyRepoSkills(settings, options = {}) {
  ensureDir(settings.skillsDir);
  const repoNames = listSkills(settings.repoSkillsDir);
  const applied = [];
  const conflicts = [];
  const skipped = [];

  if (sameRealPath(settings.skillsDir, settings.repoSkillsDir)) {
    writeApplyState(settings, readRepoSkillHashes(settings.repoSkillsDir));
    return { applied: repoNames, conflicts, skipped, mode: "symlink" };
  }

  const state = readApplyState(settings);
  const nextState = { ...state.skills };
  const conflictRoot = path.join(path.dirname(settings.configPath), "conflicts", timestamp());

  for (const name of repoNames) {
    const source = path.join(settings.repoSkillsDir, name);
    const target = path.join(settings.skillsDir, name);
    const sourceHash = hashDirectory(source);

    if (!fs.existsSync(target)) {
      replaceDirectory(source, target);
      nextState[name] = { hash: sourceHash, appliedAt: new Date().toISOString() };
      applied.push(name);
      continue;
    }

    const targetHash = hashDirectory(target);
    const previousHash = state.skills[name] && state.skills[name].hash;

    if (targetHash === sourceHash) {
      nextState[name] = { hash: sourceHash, appliedAt: new Date().toISOString() };
      skipped.push(name);
      continue;
    }

    if (options.force || (previousHash && targetHash === previousHash)) {
      replaceDirectory(source, target);
      nextState[name] = { hash: sourceHash, appliedAt: new Date().toISOString() };
      applied.push(name);
      continue;
    }

    ensureDir(conflictRoot);
    replaceDirectory(target, path.join(conflictRoot, `${name}.local`));
    replaceDirectory(source, path.join(conflictRoot, `${name}.incoming`));
    conflicts.push({ name, local: path.join(conflictRoot, `${name}.local`), incoming: path.join(conflictRoot, `${name}.incoming`) });
  }

  if (options.prune) {
    for (const name of listSkills(settings.skillsDir)) {
      if (!repoNames.includes(name)) {
        const previousHash = state.skills[name] && state.skills[name].hash;
        const target = path.join(settings.skillsDir, name);
        if (options.force || (previousHash && hashDirectory(target) === previousHash)) {
          fs.rmSync(target, { recursive: true, force: true });
          delete nextState[name];
          applied.push(`${name}（已移除）`);
        }
      }
    }
  }

  writeApplyState(settings, nextState);
  return { applied, conflicts, skipped, mode: "copy" };
}

function readRepoSkillHashes(repoSkillsDir) {
  return Object.fromEntries(listSkills(repoSkillsDir).map((name) => [
    name,
    { hash: hashDirectory(path.join(repoSkillsDir, name)), appliedAt: new Date().toISOString() }
  ]));
}

function readApplyState(settings) {
  const statePath = getStatePath(settings);
  if (!fs.existsSync(statePath)) {
    return { version: 1, skills: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      version: 1,
      skills: parsed.skills || {}
    };
  } catch {
    return { version: 1, skills: {} };
  }
}

function writeApplyState(settings, skills) {
  const statePath = getStatePath(settings);
  ensureDir(path.dirname(statePath));
  writeJson(statePath, {
    version: 1,
    repoDir: settings.repoDir,
    skillsDir: settings.skillsDir,
    updatedAt: new Date().toISOString(),
    skills
  });
}

function getStatePath(settings) {
  const hash = crypto.createHash("sha256").update(`${settings.repoDir}\n${settings.skillsDir}`).digest("hex").slice(0, 16);
  return path.join(path.dirname(settings.configPath), `state-${hash}.json`);
}

function hasApplyState(settings) {
  return fs.existsSync(getStatePath(settings));
}

function withSyncLock(settings, callback) {
  const lockId = crypto.createHash("sha256").update(settings.repoDir).digest("hex").slice(0, 12);
  const lockPath = path.join(path.dirname(settings.configPath), `sync-${lockId}.lock`);
  const deadline = Date.now() + 30000;
  let descriptor = null;

  ensureDir(path.dirname(lockPath));
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (isStaleSyncLock(lockPath)) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error("另一项技能同步仍在运行，请稍后重试。");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }

  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

function isStaleSyncLock(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const pid = Number(value.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        if (error.code === "EPERM") return false;
      }
    }
  } catch {
    // Fall back to age when an interrupted process left a partial lock file.
  }
  return Date.now() - fs.statSync(lockPath).mtimeMs > 5 * 60 * 1000;
}

function listSkills(root) {
  if (!root || !fs.existsSync(root) || !isDirectory(root)) {
    return [];
  }
  return fs.readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .filter((name) => isDirectory(path.join(root, name)))
    .filter((name) => fs.existsSync(path.join(root, name, "SKILL.md")))
    .sort();
}

function hashSkills(root, names) {
  const result = {};
  for (const name of names) {
    result[name] = hashDirectory(path.join(root, name));
  }
  return result;
}

function hashDirectory(root) {
  const hash = crypto.createHash("sha256");
  const files = walk(root);
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const stat = fs.lstatSync(file);
    hash.update(rel);
    hash.update("\0");
    if (stat.isSymbolicLink()) {
      hash.update("symlink");
      hash.update(fs.readlinkSync(file));
    } else {
      hash.update(fs.readFileSync(file));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root).sort();
  const files = [];
  for (const entry of entries) {
    if (entry === ".DS_Store" || entry === ".git") continue;
    const fullPath = path.join(root, entry);
    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      files.push(fullPath);
    }
  }
  return files;
}

function replaceDirectory(source, target) {
  const temp = `${target}.skill-sync-tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(source, temp, {
    recursive: true,
    verbatimSymlinks: true,
    force: true,
    errorOnExist: false
  });
  fs.rmSync(target, { recursive: true, force: true });
  ensureDir(path.dirname(target));
  fs.renameSync(temp, target);
}

function createSkillSymlink(source, target) {
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(source, target, type);
}

function buildHookSnippet(settings, runnerCommand = "") {
  const cliPath = path.resolve(__filename);
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: runnerCommand || `node ${shellQuote(cliPath)} sync --quiet --config ${shellQuote(settings.configPath)}`,
              statusMessage: "正在同步 Codex 技能"
            }
          ]
        }
      ]
    }
  };
}

function mergeHookConfig(current, incoming) {
  const merged = { ...current };
  merged.hooks = { ...(current.hooks || {}) };
  const existing = Array.isArray(merged.hooks.SessionStart) ? merged.hooks.SessionStart : [];
  const withoutOldSkillSync = existing.filter((entry) => {
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    return !hooks.some((hook) => String(hook.statusMessage || "").includes("Codex 技能") || String(hook.statusMessage || "").includes("Codex skills") || String(hook.command || "").includes("skill-sync"));
  });
  merged.hooks.SessionStart = [...withoutOldSkillSync, ...incoming.hooks.SessionStart];
  return merged;
}

function ensureGit() {
  if (!commandExists("git")) {
    throw new Error("需要 git，但当前 PATH 中没有找到 git。");
  }
}

function ensureRepo(repoDir) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error(`这不是 Git 仓库：${repoDir}。请先运行 skill-sync init。`);
  }
}

function runGit(args, options) {
  return runCommand("git", args, options);
}

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    if (options.allowFail) return result;
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFail) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} 执行失败${stderr ? `：${stderr}` : stdout ? `：${stdout}` : ""}`);
  }

  return result;
}

function commandExists(command) {
  const result = childProcess.spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return !result.error && result.status === 0;
}

function safeCommand(args) {
  try {
    const result = runCommand(args[0], args.slice(1), { capture: true, allowFail: true });
    return (result.stdout || result.stderr || "").trim();
  } catch (error) {
    return error.message;
  }
}

function isGitRepo(repoDir) {
  return fs.existsSync(path.join(repoDir, ".git"));
}

function gitDirty(repoDir) {
  if (!isGitRepo(repoDir)) return [];
  const result = runGit(["status", "--porcelain"], { cwd: repoDir, capture: true });
  return result.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function gitRemoteUrl(repoDir, name) {
  if (!isGitRepo(repoDir)) return "";
  const result = runGit(["remote", "get-url", name], { cwd: repoDir, capture: true, allowFail: true });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function gitCurrentBranch(repoDir) {
  if (!isGitRepo(repoDir)) return "";
  const result = runGit(["branch", "--show-current"], { cwd: repoDir, capture: true, allowFail: true });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function gitHasStagedChanges(repoDir) {
  const result = runGit(["diff", "--cached", "--quiet"], { cwd: repoDir, capture: true, allowFail: true });
  return result.status === 1;
}

function remoteBranchExists(repoDir, branch) {
  const result = runGit([
    "ls-remote",
    "--exit-code",
    "--heads",
    "origin",
    `refs/heads/${branch}`
  ], { cwd: repoDir, capture: true, allowFail: true });
  return result.status === 0;
}

function pullWithRebase(repoDir, branch) {
  const result = runGit(["pull", "--rebase", "origin", branch], {
    cwd: repoDir,
    capture: true,
    allowFail: true
  });
  if (result.status === 0) return result;

  const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"], {
    cwd: repoDir,
    capture: true,
    allowFail: true
  }).stdout.trim();
  runGit(["rebase", "--abort"], { cwd: repoDir, capture: true, allowFail: true });

  const detail = conflicts
    ? `以下文件在多台电脑上同时发生了修改：\n${conflicts.split(/\r?\n/).map((name) => `  ${name}`).join("\n")}`
    : commandResultError("git pull --rebase", result).message;
  throw new Error(`自动合并失败，已保留本机版本并暂停同步。\n${detail}`);
}

function pushBranch(repoDir, branch, options = {}) {
  return runGit(["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], {
    cwd: repoDir,
    capture: true,
    allowFail: Boolean(options.allowFail)
  });
}

function isNonFastForward(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return /non-fast-forward|fetch first|rejected/i.test(output);
}

function commandResultError(command, result) {
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  return new Error(`${command} 执行失败${stderr ? `：${stderr}` : stdout ? `：${stdout}` : ""}`);
}

function ensureGitIdentity(repoDir) {
  const name = gitConfigValue(repoDir, "user.name");
  const email = gitConfigValue(repoDir, "user.email");
  if (name && email) {
    return;
  }

  const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, "-").replace(/^-+|-+$/g, "") || "computer";
  if (!name) runGit(["config", "user.name", "Codex Skill Sync"], { cwd: repoDir });
  if (!email) runGit(["config", "user.email", `skill-sync@${host}.local`], { cwd: repoDir });
}

function gitConfigValue(repoDir, key) {
  const result = runGit(["config", "--get", key], { cwd: repoDir, capture: true, allowFail: true });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(value) {
  try {
    return fs.lstatSync(value).isSymbolicLink();
  } catch {
    return false;
  }
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function expandPath(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function printObjectOrText(options, objectValue, lines) {
  if (options.json) {
    console.log(JSON.stringify(objectValue, null, 2));
  } else {
    console.log(lines.join("\n"));
  }
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: String(detail || "") };
}

function localizeSkillState(value) {
  const labels = {
    same: "已同步",
    different: "有差异",
    "local-only": "仅本机",
    "missing-local": "本机缺失"
  };
  return labels[value] || value;
}

function shellQuote(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(stringValue)) {
    return stringValue;
  }
  return `'${stringValue.replace(/'/g, "'\\''")}'`;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

main();
