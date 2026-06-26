import { afterEach, describe, expect, it } from "vitest";

import { CONNECTOR_PRESETS } from "../src/presets.js";

const ORIGINAL_OMNIGENT_SERVER_URL = process.env.OMNIGENT_SERVER_URL;

afterEach(() => {
  if (ORIGINAL_OMNIGENT_SERVER_URL === undefined) delete process.env.OMNIGENT_SERVER_URL;
  else process.env.OMNIGENT_SERVER_URL = ORIGINAL_OMNIGENT_SERVER_URL;
});

describe("connector presets", () => {
  it("includes omnigent", () => {
    expect(CONNECTOR_PRESETS.omnigent).toBeDefined();
    expect(CONNECTOR_PRESETS.omnigent.autonomy).toBe("approve");
  });

  it("builds the omnigent OpenAPI transport", () => {
    const transport = CONNECTOR_PRESETS.omnigent.buildTransport();
    expect(transport.type).toBe("openapi");
    if (transport.type !== "openapi") throw new Error("expected openapi transport");
    expect(transport.allowMutating).toBe(true);
    expect(transport.specUrl).toMatch(/\/openapi\.json$/);
  });

  it("uses OMNIGENT_SERVER_URL as the base when set", () => {
    process.env.OMNIGENT_SERVER_URL = "http://omnigent.example.test:6767/root/";

    const transport = CONNECTOR_PRESETS.omnigent.buildTransport();
    expect(transport.type).toBe("openapi");
    if (transport.type !== "openapi") throw new Error("expected openapi transport");
    expect(transport.baseUrl).toBe("http://omnigent.example.test:6767/root");
    expect(transport.specUrl).toBe("http://omnigent.example.test:6767/root/openapi.json");
  });
});
