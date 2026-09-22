#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const OFFICIAL_UPSTREAM = "https://github.com/PrimeIntellect-ai/prime-agent.git";
export const RECEIPT_PATH = ".git/cwd-update/receipt.json";
const branch = "fix/update";
const cwdTests = ["daemon-supervisor-process", "session-cwd", "agents-view-state", "daemon-mode", "stdout-cleanliness"];

function baseEnvironment() {
	const env = {};
	for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return Object.assign(env, {
		GIT_CONFIG_GLOBAL: devNull,
		GIT_CONFIG_SYSTEM: devNull,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	});
}

function run(command, args, cwd, env, inherit = false) {
	const result = spawnSync(command, args, {
		cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
		stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.error?.message ?? `${result.stdout ?? ""}${result.stderr ?? ""}`}`);
	}
	return (result.stdout ?? "").trim();
}

function git(cwd, env, ...args) {
	return run("git", ["-c", "core.fsmonitor=false", ...args], cwd, env);
}

function exists(path) {
	try { lstatSync(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function inside(parent, child) {
	const path = relative(parent, child);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function assertClean(cwd, env) {
	if (git(cwd, env, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")) {
		throw new Error(`Dirty checkout: ${cwd}. Commit changes and remove untracked files before staging an update.`);
	}
}

function assertCandidate(cwd, env, sha) {
	if (git(cwd, env, "rev-parse", "HEAD") !== sha) throw new Error("Validation changed candidate HEAD.");
	if (git(cwd, env, "symbolic-ref", "--short", "HEAD") !== branch) throw new Error("Validation changed candidate branch.");
	assertClean(cwd, env);
}

function privateTempRoot(source) {
	// POSIX /tmp is independent of inherited TMPDIR and short enough for Unix sockets.
	const base = realpathSync(process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "Temp") : "/tmp");
	if (inside(source, base) || Buffer.byteLength(join(base, "pcw-XXXXXX", "tmp")) > 30) {
		throw new Error("No short, safe system temp base for validation sockets (maximum private TMPDIR: 30 bytes).");
	}
	const path = mkdtempSync(join(base, "pcw-"));
	chmodSync(path, 0o700);
	return path;
}

function validationEnvironment(candidate, sha, upstreamSha, metadata) {
	const env = baseEnvironment();
	const directories = {
		HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache",
		XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime",
		TMPDIR: "tmp", TMP: "tmp", TEMP: "tmp", PRIME_AGENT_CODING_AGENT_DIR: "agent",
	};
	for (const [key, directory] of Object.entries(directories)) {
		env[key] = join(metadata, directory);
		mkdirSync(env[key], { recursive: true, mode: 0o700 });
	}
	return Object.assign(env, {
		NPM_CONFIG_USERCONFIG: join(env.HOME, ".npmrc"), NPM_CONFIG_GLOBALCONFIG: devNull,
		NPM_CONFIG_CACHE: join(env.XDG_CACHE_HOME, "npm"),
		PRIME_AGENT_LAUNCHER_PATH: join(candidate, "prime-agent.sh"), PRIME_AGENT_BUILD_ID: sha,
		PI_OFFLINE: "1", DO_NOT_TRACK: "1", TEST_POLICY_BASE: upstreamSha,
	});
}

export function validateCandidate({ candidate, candidateSha, env }) {
	console.log(`Private validation root: ${dirname(env.HOME)} (removed after validation)`);
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const version = run(npm, ["--version"], candidate, env);
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match || Number(match[1]) < 11 || (Number(match[1]) === 11 && Number(match[2]) < 10)) {
		throw new Error(`npm >=11.10 is required to enforce min-release-age; found ${version}. Put a supported npm on PATH and stage a new candidate.`);
	}
	const steps = [
		[npm, ["ci", "--ignore-scripts"], candidate],
		[npm, ["run", "check"], candidate],
		[npm, ["run", "check:test-policy"], candidate],
		[process.execPath, [join(candidate, "node_modules/tsx/dist/cli.mjs"),
			join(candidate, "node_modules/vitest/dist/cli.js"), "--run", "--no-file-parallelism",
			"--maxWorkers=1", "--bail=1", ...cwdTests.map((name) => `test/${name}.test.ts`)],
			join(candidate, "packages/coding-agent")],
		[process.execPath, ["--test", "--test-concurrency=1", "scripts/test-update-cwd-fork.mjs"], candidate],
	];
	for (const [command, args, cwd] of steps) {
		run(command, args, cwd, env, true);
		assertCandidate(candidate, env, candidateSha);
	}
}

function checkUpstreamUrl(url) {
	if (isAbsolute(url)) return realpathSync(url);
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
		throw new Error("Upstream URL must be credential-free HTTPS or an absolute local repository path.");
	}
	return url;
}

// validate is a programmatic fixture seam, never a CLI option.
export async function stageUpdate({ source = process.cwd(), upstreamRef, destination,
	upstreamUrl = OFFICIAL_UPSTREAM, validate = validateCandidate }) {
	const env = baseEnvironment();
	if (!upstreamRef || upstreamRef.startsWith("-")) throw new Error("An explicit upstream ref is required.");
	git(process.cwd(), env, "check-ref-format", "--allow-onelevel", upstreamRef);
	if (!destination || !isAbsolute(destination)) throw new Error("Destination must be an absolute, nonexistent path.");
	if (exists(destination)) throw new Error(`Destination already exists: ${destination}`);
	source = realpathSync(git(realpathSync(source), env, "rev-parse", "--show-toplevel"));
	destination = join(realpathSync(dirname(destination)), basename(destination));
	const commonDir = realpathSync(git(source, env, "rev-parse", "--path-format=absolute", "--git-common-dir"));
	if (inside(source, destination) || inside(commonDir, destination)) {
		throw new Error("Destination must be outside the source checkout and Git directory.");
	}
	upstreamUrl = checkUpstreamUrl(upstreamUrl);
	if (git(source, env, "rev-parse", "--is-shallow-repository") === "true") {
		throw new Error("Shallow source checkout is unsupported. Use a separate full-history checkout; no history was changed.");
	}
	assertClean(source, env);
	for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
		if (exists(git(source, env, "rev-parse", "--path-format=absolute", "--git-path", marker))) {
			throw new Error(`Source has an unfinished Git operation (${marker}). Finish it before staging.`);
		}
	}
	let sourceBranch;
	try { sourceBranch = git(source, env, "symbolic-ref", "--short", "HEAD"); }
	catch { throw new Error("Source must be on a committed maintained branch, not detached HEAD."); }
	const sourceSha = git(source, env, "rev-parse", "--verify", "HEAD^{commit}");
	const originUrl = git(source, env, "remote", "get-url", "origin");
	const originPushUrl = git(source, env, "remote", "get-url", "--push", "origin");
	mkdirSync(destination, { mode: 0o700 });
	try {
		git(dirname(destination), env, "clone", "--no-hardlinks", "--dissociate", "--", source, destination);
		if (git(destination, env, "rev-parse", "HEAD") !== sourceSha) throw new Error("Source HEAD changed during clone.");
		if (sourceBranch !== branch) git(destination, env, "branch", "-m", branch);
		git(destination, env, "remote", "set-url", "origin", originUrl);
		git(destination, env, "remote", "set-url", "--push", "origin", originPushUrl);
		git(destination, env, "remote", "add", "upstream", upstreamUrl);
		git(destination, env, "fetch", "--no-tags", "--no-recurse-submodules", "upstream", upstreamRef);
		const upstreamSha = git(destination, env, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
		if (git(destination, env, "rev-parse", "--is-shallow-repository") === "true") {
			throw new Error("Fetched history is shallow. Use full upstream history; no automatic recovery was attempted.");
		}
		let mergeBase;
		try { mergeBase = git(destination, env, "merge-base", sourceSha, upstreamSha); }
		catch { throw new Error("Source and upstream have no common ancestry. No history rewrite was attempted."); }
		const metadata = join(destination, ".git", "cwd-update");
		const hooks = join(metadata, "empty-hooks");
		mkdirSync(hooks, { recursive: true, mode: 0o700 });
		const inputs = { source, sourceBranch, sourceSha, originUrl, originPushUrl, upstreamUrl, upstreamRef, upstreamSha, mergeBase };
		writeFileSync(join(metadata, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		const configured = git(destination, env, "config", "--local", "--list").split("\n");
		for (const [key, value] of [["user.name", "CWD update bot"], ["user.email", "cwd-update@localhost"]]) {
			if (!configured.some((line) => line.startsWith(`${key}=`))) git(destination, env, "config", "--local", key, value);
		}
		try {
			git(destination, env, "-c", `core.hooksPath=${hooks}`, "merge", "--no-ff", "--no-edit", "--no-gpg-sign",
				"-m", `Merge upstream ${upstreamRef} into ${branch}`, upstreamSha);
		} catch (error) { throw new Error(`Upstream merge failed; inspect conflicts in the retained candidate.\n${error.message}`); }
		const candidateSha = git(destination, env, "rev-parse", "HEAD");
		assertClean(destination, env);
		const validationRoot = privateTempRoot(source);
		inputs.validationRoot = validationRoot;
		try {
			writeFileSync(join(metadata, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
			await validate({ candidate: destination, candidateSha,
				env: validationEnvironment(destination, candidateSha, upstreamSha, validationRoot) });
		} finally { rmSync(validationRoot, { recursive: true, force: true }); }
		assertCandidate(destination, env, candidateSha);
		assertClean(source, env);
		if (git(source, env, "rev-parse", "HEAD") !== sourceSha ||
			git(source, env, "symbolic-ref", "--short", "HEAD") !== sourceBranch) throw new Error("Source changed during staging.");
		const receipt = { schemaVersion: 1, ...inputs, candidate: destination, candidateBranch: branch, candidateSha,
			validation: validate === validateCandidate ? "project" : "custom", validatedAt: new Date().toISOString() };
		writeFileSync(join(destination, RECEIPT_PATH), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		return receipt;
	} catch (error) {
		throw new Error(`${error.message}\nCandidate retained at ${destination}; no success receipt was written.`, { cause: error });
	}
}

function parseArgs(args) {
	const options = {};
	const names = { "--upstream-ref": "upstreamRef", "--destination": "destination", "--upstream-url": "upstreamUrl" };
	for (let index = 0; index < args.length; index += 2) {
		const name = names[args[index]];
		const value = args[index + 1];
		if (!name || !value || value.startsWith("--") || options[name] !== undefined) {
			throw new Error(`Unknown, duplicate, or incomplete option: ${args[index]}`);
		}
		options[name] = value;
	}
	return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length === 3 && process.argv[2] === "--help") {
			console.log("node scripts/update-cwd-fork.mjs --upstream-ref REF --destination /new/absolute/path [--upstream-url HTTPS_URL_OR_LOCAL_PATH]");
		} else {
			const receipt = await stageUpdate(parseArgs(process.argv.slice(2)));
			const quoted = `'${receipt.candidate.replaceAll("'", "'\\''")}'`;
			console.log(`Validated candidate: ${receipt.candidate}\nReceipt: ${join(receipt.candidate, RECEIPT_PATH)}`);
			console.log(`Review, then push to ${receipt.originPushUrl}:\ngit -C ${quoted} push --set-upstream origin ${branch}`);
		}
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
