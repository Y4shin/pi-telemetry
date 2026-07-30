import { describe, it } from "node:test";
import { fork } from "node:child_process";
import { join } from "node:path";

describe("debug soak worker", () => {
  it("runs one worker", async () => {
    const child = fork(join(import.meta.dirname, "helpers", "soak-worker.ts"), [], {
      env: {
        ...process.env,
        PI_TELEMETRY_SOAK_DB_PATH: "/tmp/soak-one.db",
        PI_TELEMETRY_SOAK_WORKER_ID: "0",
        PI_TELEMETRY_SOAK_ROWS_PER_WORKER: "10",
      },
      silent: false,
    });

    child.on("message", (msg) => console.log("parent got:", msg));
    child.on("error", (err) => console.log("child error:", err));
    child.stderr?.on("data", (d) => console.log("stderr:", d.toString()));
    child.stdout?.on("data", (d) => console.log("stdout:", d.toString()));

    await new Promise((resolve) => child.on("exit", resolve));
  });
});
