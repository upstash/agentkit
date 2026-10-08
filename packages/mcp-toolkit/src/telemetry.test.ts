import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient } from "@upstash/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { addQStashTelemetry, SDK_TELEMETRY } from "./telemetry.js";

const sdkHeader = (client: unknown) =>
  (client as { http: { telemetryHeaders: Headers } }).http.telemetryHeaders.get(
    "Upstash-Telemetry-Sdk",
  );

describe("addQStashTelemetry", () => {
  const saved = process.env.UPSTASH_DISABLE_TELEMETRY;
  afterEach(() => {
    if (saved === undefined) delete process.env.UPSTASH_DISABLE_TELEMETRY;
    else process.env.UPSTASH_DISABLE_TELEMETRY = saved;
  });

  it("appends the package tag to a QStash client's header, once", () => {
    const client = new QStashClient({ token: "t" });
    addQStashTelemetry(client);
    addQStashTelemetry(client);
    expect(sdkHeader(client)).toMatch(/^upstash-qstash-js@[^,]+,@upstash\/mcp-toolkit@/);
    expect(
      sdkHeader(client)
        ?.split(",")
        .filter((tag) => tag === SDK_TELEMETRY),
    ).toHaveLength(1);
  });

  it("reaches the QStash client inside a Workflow client", () => {
    const client = new WorkflowClient({ token: "t" });
    addQStashTelemetry(client);
    expect(sdkHeader((client as unknown as { client: unknown }).client)).toContain(SDK_TELEMETRY);
  });

  it("leaves a client alone when telemetry is off", () => {
    const optedOut = new QStashClient({ token: "t", enableTelemetry: false });
    addQStashTelemetry(optedOut);
    expect(sdkHeader(optedOut)).toBeNull();

    const client = new QStashClient({ token: "t" });
    addQStashTelemetry(client, { enabled: false });
    expect(sdkHeader(client)).not.toContain(SDK_TELEMETRY);

    process.env.UPSTASH_DISABLE_TELEMETRY = "1";
    const viaEnv = new QStashClient({ token: "t" });
    addQStashTelemetry(viaEnv);
    expect(sdkHeader(viaEnv) ?? "").not.toContain(SDK_TELEMETRY);
  });
});
