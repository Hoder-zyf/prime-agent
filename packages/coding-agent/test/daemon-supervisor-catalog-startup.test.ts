import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("daemon supervisor catalog startup", () => {
	it("starts the catalog lazily on the first catalog request, not at supervisor boot", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-catalog-lazy-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		});
		// The catalog child is a full extra resident runtime; tests mock the spawn away
		// so no real catalog process boots while asserting the start-on-demand path.
		const catalogStart = vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		const client = new DaemonClient(socketPath);
		try {
			await supervisor.start();
			expect(catalogStart).not.toHaveBeenCalled();

			await client.connect();
			const response = await client.request({ type: "list_saved_sessions", cwd: directory, scope: "all" });
			expect(catalogStart).toHaveBeenCalledTimes(1);
			expect(response).toMatchObject({
				success: false,
				// The spawn itself is mocked, so the first request stops at the
				// readiness gate: the lazy start was attempted exactly once.
				error: "Daemon catalog is not connected",
			});
		} finally {
			await Reflect.apply(Reflect.get(supervisor, "cleanupSupervisorResources"), supervisor, []);
			catalogStart.mockRestore();
		}
	});
});
