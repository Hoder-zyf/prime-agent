import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RECEIPT_PATH, stageUpdate } from "./update-cwd-fork.mjs";

const script = fileURLToPath(new URL("./update-cwd-fork.mjs", import.meta.url));
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
	GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
	if (process.env[key] !== undefined) gitEnv[key] = process.env[key];
}
function execute(command, args, cwd, env = gitEnv) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}
const git = (cwd, ...args) => execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], cwd);
function snapshot(dir, prefix = "") {
	return readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
		const path = join(prefix, entry.name);
		return entry.isDirectory() ? snapshot(dir, path) : [[path, readFileSync(join(dir, path)).toString("base64")]];
	});
}
function fixture(t, conflict = false, sourceBranch = "maintained") {
	const dir = mkdtempSync(join(tmpdir(), "cwd-update-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const upstream = join(dir, "upstream");
	const source = join(dir, "source");
	mkdirSync(upstream);
	git(upstream, "init", "-b", "main");
	writeFileSync(join(upstream, "cwd.txt"), "base\n");
	git(upstream, "add", "cwd.txt");
	git(upstream, "commit", "-m", "base");
	git(dir, "clone", "--no-hardlinks", upstream, source);
	git(source, "switch", "-c", sourceBranch);
	writeFileSync(join(source, "cwd.txt"), "local resume fix\n");
	git(source, "add", "cwd.txt");
	git(source, "commit", "-m", "preserve resume fix");
	git(source, "remote", "set-url", "origin", "https://github.com/Hoder-zyf/prime-agent.git");
	git(source, "remote", "set-url", "--push", "origin", "https://github.com/Hoder-zyf/prime-agent.git");
	writeFileSync(join(upstream, "upstream.txt"), "upstream addition\n");
	if (conflict) writeFileSync(join(upstream, "cwd.txt"), "upstream conflicting cwd\n");
	git(upstream, "add", "cwd.txt", "upstream.txt");
	git(upstream, "commit", "-m", "upstream upgrade");
	git(upstream, "tag", "v-next");
	const validate = ({ candidate, env }) => execute(process.execPath, ["-e",
		'const fs = require("node:fs"), a = require("node:assert/strict"); a.equal(fs.readFileSync("cwd.txt", "utf8"), "local resume fix\\n"); a.equal(fs.readFileSync("upstream.txt", "utf8"), "upstream addition\\n");'], candidate, env);
	return { source, upstreamUrl: upstream, upstreamRef: "v-next", destination: join(dir, "candidate"), validate };
}
const noReceipt = (f) => assert.equal(existsSync(join(f.destination, RECEIPT_PATH)), false);

for (const sourceBranch of ["maintained", "fix/update"]) test(`preserves fix and upstream history from ${sourceBranch}`, async (t) => {
	const f = fixture(t, false, sourceBranch);
	const before = snapshot(f.source);
	const sourceSha = git(f.source, "rev-parse", "HEAD");
	const upstreamSha = git(f.upstreamUrl, "rev-parse", "v-next");
	await stageUpdate(f);
	assert.deepEqual(snapshot(f.source), before);
	assert.equal(git(f.destination, "branch", "--show-current"), "fix/update");
	assert.equal(git(f.destination, "remote", "get-url", "origin"), git(f.source, "remote", "get-url", "origin"));
	assert.equal(git(f.destination, "remote", "get-url", "--push", "origin"), git(f.source, "remote", "get-url", "--push", "origin"));
	assert.equal(git(f.destination, "remote", "get-url", "upstream"), f.upstreamUrl);
	assert.deepEqual(git(f.destination, "show", "-s", "--format=%P", "HEAD").split(" "), [sourceSha, upstreamSha]);
	const receipt = JSON.parse(readFileSync(join(f.destination, RECEIPT_PATH), "utf8"));
	assert.equal(receipt.sourceSha, sourceSha);
	assert.equal(receipt.upstreamSha, upstreamSha);
	assert.equal(receipt.candidateSha, git(f.destination, "rev-parse", "HEAD"));
	assert.equal(receipt.validation, "custom");
	assert.equal(existsSync(receipt.validationRoot), false);
	assert.equal(git(f.destination, "status", "--porcelain"), "");
	const object = join(".git", "objects", sourceSha.slice(0, 2), sourceSha.slice(2));
	assert.notEqual(statSync(join(f.source, object)).ino, statSync(join(f.destination, object)).ino);
	assert.equal(existsSync(join(f.destination, ".git/objects/info/alternates")), false);
	assert.equal(git(f.destination, "config", "--local", "--list").includes("core.hookspath="), false);
});

test("candidate dissociates borrowed Git objects", async (t) => {
	const f = fixture(t);
	const borrowed = `${f.source}-borrowed`;
	git(f.source, "clone", "--shared", f.source, borrowed);
	f.source = borrowed;
	const before = snapshot(f.source);
	await stageUpdate(f);
	assert.deepEqual(snapshot(f.source), before);
	assert.equal(existsSync(join(f.source, ".git/objects/info/alternates")), true);
	assert.equal(existsSync(join(f.destination, ".git/objects/info/alternates")), false);
	assert.equal(git(f.destination, "fsck", "--full", "--no-reflogs"), "");
});

test("conflict fails closed and preserves source bytes, index and HEAD", async (t) => {
	const f = fixture(t, true);
	const before = snapshot(f.source);
	await assert.rejects(stageUpdate(f), /merge failed/);
	assert.deepEqual(snapshot(f.source), before);
	assert.equal(git(f.destination, "rev-parse", "HEAD"), git(f.source, "rev-parse", "HEAD"));
	assert.equal(git(f.destination, "rev-parse", "MERGE_HEAD"), git(f.upstreamUrl, "rev-parse", "v-next"));
	assert.match(git(f.destination, "diff", "--name-only", "--diff-filter=U"), /cwd.txt/);
	noReceipt(f);
});

for (const [name, change, pattern] of [
	["untracked source", (f) => writeFileSync(join(f.source, "dirty.txt"), "dirty"), /Dirty checkout/],
	["staged source", (f) => { writeFileSync(join(f.source, "cwd.txt"), "dirty"); git(f.source, "add", "cwd.txt"); }, /Dirty checkout/],
	["empty destination", (f) => mkdirSync(f.destination), /already exists/],
	["nonempty destination", (f) => { mkdirSync(f.destination); writeFileSync(join(f.destination, "keep"), "keep"); }, /already exists/],
	["inside source", (f) => { f.destination = join(f.source, "candidate"); }, /outside the source/],
]) test(`rejects ${name} without modifying caller or destination`, async (t) => {
	const f = fixture(t);
	change(f);
	const before = snapshot(f.source);
	const destinationBefore = existsSync(f.destination) ? snapshot(f.destination) : undefined;
	await assert.rejects(stageUpdate(f), pattern);
	assert.deepEqual(snapshot(f.source), before);
	assert.deepEqual(existsSync(f.destination) ? snapshot(f.destination) : undefined, destinationBefore);
	noReceipt(f);
});

for (const rewrite of [false, true]) test(`validation ${rewrite ? "rewrite" : "failure"} leaves no receipt`, async (t) => {
	const f = fixture(t);
	const before = snapshot(f.source);
	f.validate = ({ candidate, env }) => {
		if (rewrite) writeFileSync(join(candidate, "cwd.txt"), "formatter changed tracked file\n");
		else execute(process.execPath, ["-e", "process.exit(13)"], candidate, env);
	};
	await assert.rejects(stageUpdate(f));
	assert.deepEqual(snapshot(f.source), before);
	assert.equal(existsSync(f.destination), true);
	noReceipt(f);
});

test("validation subprocess sees private paths and no inherited secrets or session routing", async (t) => {
	const f = fixture(t);
	const keys = ["OPENAI_API_KEY", "GH_TOKEN", "RLM_SESSION_ID", "PRIME_AGENT_INTERNAL_WORKER", "PRIME_AGENT_SESSION_DIR",
		"NODE_OPTIONS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_COUNT", "NPM_CONFIG_USERCONFIG", "HOME", "XDG_CONFIG_HOME", "TMPDIR"];
	const saved = keys.map((key) => [key, process.env[key]]);
	for (const key of keys) process.env[key] = "private-canary";
	try {
		f.validate = ({ candidate, candidateSha, env }) => {
			const observed = JSON.parse(execute(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], candidate, env));
			assert.equal(JSON.stringify(observed).includes("private-canary"), false);
			const privateRoot = dirname(observed.HOME);
			assert.equal(Buffer.byteLength(observed.TMPDIR) <= 30, true);
			assert.equal(privateRoot.startsWith(candidate), false);
			for (const key of keys.slice(0, 6)) assert.equal(observed[key], undefined);
			for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "PRIME_AGENT_CODING_AGENT_DIR"]) {
				assert.equal(observed[key].startsWith(privateRoot), true);
				assert.equal(statSync(observed[key]).isDirectory(), true);
			}
			assert.equal(observed.GIT_CONFIG_GLOBAL, devNull);
			assert.equal(observed.GIT_CONFIG_COUNT, undefined);
			assert.equal(observed.PRIME_AGENT_LAUNCHER_PATH, join(candidate, "prime-agent.sh"));
			assert.equal(observed.PRIME_AGENT_BUILD_ID, candidateSha);
			assert.equal(observed.TEST_POLICY_BASE, git(f.upstreamUrl, "rev-parse", "v-next"));
			assert.equal(observed.PI_OFFLINE, "1");
		};
		await stageUpdate(f);
	} finally {
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
});

for (const shallow of [false, true]) test(`rejects ${shallow ? "shallow source" : "unrelated upstream"} without recovery`, async (t) => {
	const f = fixture(t);
	if (shallow) {
		const path = join(f.source, "..", "shallow");
		git(f.source, "clone", "--depth=1", pathToFileURL(f.source).href, path);
		f.source = path;
	} else {
		git(f.upstreamUrl, "switch", "--orphan", "unrelated");
		writeFileSync(join(f.upstreamUrl, "other.txt"), "unrelated");
		git(f.upstreamUrl, "add", "other.txt");
		git(f.upstreamUrl, "commit", "-m", "unrelated");
		f.upstreamRef = "unrelated";
	}
	const before = snapshot(f.source);
	await assert.rejects(stageUpdate(f), shallow ? /Shallow source/ : /no common ancestry/);
	assert.deepEqual(snapshot(f.source), before);
	noReceipt(f);
});

test("CLI requires explicit ref and has no validation bypass", (t) => {
	const f = fixture(t);
	for (const args of [["--destination", f.destination], ["--skip-validation"], ["--validate", "false"]]) {
		const result = spawnSync(process.execPath, [script, ...args], { cwd: f.source, env: gitEnv, encoding: "utf8" });
		assert.equal(result.status, 1, result.stderr);
		assert.equal(existsSync(f.destination), false);
	}
});
