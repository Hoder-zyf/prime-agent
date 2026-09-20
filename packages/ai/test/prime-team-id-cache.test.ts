import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPrimeTeamId } from "../src/env-api-keys.js";

describe("prime team id config cache", () => {
	let home: string;
	let configPath: string;

	beforeEach(async () => {
		await Promise.all([import("node:fs"), import("node:os")]); // settle env-api-keys' dynamic-import fs/os shims
		home = mkdtempSync(join(tmpdir(), "prime-team-id-"));
		process.env.HOME = home;
		mkdirSync(join(home, ".prime"), { recursive: true });
		configPath = join(home, ".prime", "config.json");
		delete process.env.PRIME_TEAM_ID;
	});

	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("parses once per file identity, re-reads on change, and drops when the file disappears", () => {
		writeFileSync(configPath, '{"team_id": "team-a"}');
		utimesSync(configPath, 1000, 1000);
		expect(getPrimeTeamId()).toBe("team-a");

		// Same size and a re-pinned mtime keep the file identity: the corrupted
		// content is served from the cache, proving no re-read happened.
		writeFileSync(configPath, '{"team_id"  "team-a"}');
		utimesSync(configPath, 1000, 1000);
		expect(getPrimeTeamId()).toBe("team-a");

		writeFileSync(configPath, '{"team_id": "team-b"}');
		expect(getPrimeTeamId()).toBe("team-b");

		rmSync(configPath, { force: true });
		expect(getPrimeTeamId()).toBeUndefined();

		writeFileSync(configPath, '{"team_id": "team-c"}');
		expect(getPrimeTeamId()).toBe("team-c");
	});

	it("keeps the environment variable ahead of the config file", () => {
		writeFileSync(configPath, '{"team_id": "team-a"}');
		expect(getPrimeTeamId()).toBe("team-a");
		process.env.PRIME_TEAM_ID = "team-env";
		expect(getPrimeTeamId()).toBe("team-env");
	});
});
