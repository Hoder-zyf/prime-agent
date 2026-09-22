import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

async function runCli(args: string[], inheritedConfig: boolean): Promise<{ stdout: string; stderr: string }> {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	try {
		const projectDir = join(tempRoot, inheritedConfig ? "project with spaces" : "project");
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		writeFileSync(join(projectDir, "tsconfig.json"), '{"extends":"./not-the-launcher-config.json"}');
		const cwdProbe = join(projectDir, "assert-cwd.cjs");
		writeFileSync(cwdProbe, 'require("node:assert/strict").equal(process.cwd(), process.env.EXPECTED_CWD);');
		const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
		writeFileSync(fakeNpmPath, 'console.log("npm noise on stdout");\nprocess.exit(0);\n', "utf-8");
		writeFileSync(
			join(projectDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [process.execPath, fakeNpmPath] }),
			"utf-8",
		);
		const child = spawn("bash", [resolve(__dirname, "../../../prime-agent.sh"), ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				HOME: tempRoot,
				[ENV_AGENT_DIR]: tempRoot,
				TSX_TSCONFIG_PATH: inheritedConfig ? join(projectDir, "tsconfig.json") : undefined,
				NODE_OPTIONS: `--require="${cwdProbe}"`,
				EXPECTED_CWD: projectDir,
			},
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			signal: AbortSignal.timeout(20_000),
			killSignal: "SIGKILL",
		});
		const closed = new Promise<void>((done) => child.once("close", () => done()));
		try {
			const [exit, out, err] = await Promise.all([
				once(child, "close"),
				child.stdout.toArray(),
				child.stderr.toArray(),
			]);
			const errorText = Buffer.concat(err).toString();
			expect(exit[0], errorText).toBe(0);
			return { stdout: Buffer.concat(out).toString(), stderr: errorText };
		} finally {
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
			await closed;
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

describe("stdout cleanliness in source-launcher non-interactive modes", () => {
	it.each([
		[["--mode", "json", "--help"], false],
		[["-p", "-h"], true],
	])("keeps stdout empty and caller cwd for %j with inherited config %s (#2454)", async (args, inheritedConfig) => {
		const result = await runCli(args, inheritedConfig);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toBe("");
		expect(result.stderr).not.toContain("npm noise on stdout");
	});
});
