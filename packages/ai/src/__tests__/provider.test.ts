/**
 * Which backend gets chosen, and how a service-account key is read.
 *
 * The credential path is the one piece of this that only fails in production:
 * locally it is covered by ADC, so a broken GOOGLE_SERVICE_ACCOUNT_JSON is
 * invisible until it is deployed. These tests are what stands in for that.
 *
 * **Nothing here may construct a client that falls back to Application Default
 * Credentials.** Doing so reaches for the GCE metadata server, which resolves
 * differently on a developer laptop and a CI runner — and, before the client
 * awaited its credentials, left an unhandled rejection that passed locally and
 * killed the CI worker. Every construction below supplies an explicit
 * service-account key, which resolves locally with no network at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeProvider, createForecastClient, describeProvider, modelId, serviceAccountAuth } from "../provider";

const KEYS = [
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "ANTHROPIC_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "AI_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A structurally valid service-account key. The private key is not a real one. */
const FAKE_SA = JSON.stringify({
  type: "service_account",
  project_id: "demo",
  client_email: "forecaster@demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnotarealkey\n-----END PRIVATE KEY-----\n",
});

const opts = { timeoutMs: 1_000, maxRetries: 0 };

describe("activeProvider", () => {
  it("is null when nothing is configured", () => {
    expect(activeProvider()).toBeNull();
  });

  it("picks Vertex from a GCP project", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    expect(activeProvider()).toBe("vertex");
  });

  it("picks the first-party API from a key", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    expect(activeProvider()).toBe("anthropic");
  });

  it("prefers Vertex when both are set", () => {
    // A stale key left in the environment must not silently redirect spend
    // away from the provider the operator deliberately configured.
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    expect(activeProvider()).toBe("vertex");
  });
});

describe("modelId", () => {
  it("defaults to Claude Opus 5", () => {
    expect(modelId()).toBe("claude-opus-5");
  });

  it("is overridable, because Vertex enablement is per project and region", () => {
    process.env["AI_MODEL"] = "claude-sonnet-5";
    expect(modelId()).toBe("claude-sonnet-5");
  });
});

describe("createForecastClient", () => {
  it("returns null with nothing configured", async () => {
    expect(await createForecastClient(opts)).toBeNull();
  });

  it("builds a first-party client from a key", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const made = await createForecastClient(opts);
    expect(made?.provider).toBe("anthropic");
    expect(made?.client.messages).toBeDefined();
  });

  it("builds a Vertex client from a project, defaulting the region to global", async () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;
    const made = await createForecastClient(opts);
    expect(made?.provider).toBe("vertex");
    expect(made?.client.messages).toBeDefined();
  });

  it("accepts an inline service-account key", async () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;
    expect((await createForecastClient(opts))?.provider).toBe("vertex");
  });

  it("accepts that key base64-encoded, since dashboards mangle embedded newlines", async () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = Buffer.from(FAKE_SA).toString("base64");
    expect((await createForecastClient(opts))?.provider).toBe("vertex");
  });

  it("awaits its credentials, so none can reject unobserved", async () => {
    // The regression this guards. `new AnthropicVertex(...)` resolves auth in
    // its CONSTRUCTOR and keeps the promise privately; left alone, a credential
    // failure became an unhandled rejection that passed locally and killed the
    // CI worker. Awaiting it is the fix, so the contract is that this function
    // is async and settles.
    //
    // Asserted with a service-account key rather than ADC on purpose: probing
    // the metadata server is slow, and resolves differently on a laptop, a CI
    // runner and a GCE box — which is the flakiness being removed, not a thing
    // to reintroduce as a test.
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pending = createForecastClient(opts);
      expect(pending).toBeInstanceOf(Promise);
      expect((await pending)?.provider).toBe("vertex");
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("serviceAccountAuth", () => {
  // Tested directly rather than through a client: this is pure parsing, and
  // building a client to reach it would drag in credential resolution.
  it("returns nothing when unset, so the caller falls through to ADC", () => {
    expect(serviceAccountAuth()).toBeUndefined();
  });

  it("ignores an empty or whitespace blob", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "   ";
    expect(serviceAccountAuth()).toBeUndefined();
  });

  it("accepts raw JSON", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;
    expect(serviceAccountAuth()).toBeDefined();
  });

  it("accepts base64, since dashboards mangle the newlines in private_key", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = Buffer.from(FAKE_SA).toString("base64");
    expect(serviceAccountAuth()).toBeDefined();
  });

  it("throws a legible error on an unparseable blob", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "{not json";
    expect(() => serviceAccountAuth()).toThrow(/not valid JSON/);
  });

  it("rejects a blob that parses but is not a service-account key", () => {
    // The likely mistake: pasting an OAuth client or an API key instead.
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = JSON.stringify({ type: "authorized_user" });
    expect(() => serviceAccountAuth()).toThrow(/client_email/);
  });
});

describe("describeProvider", () => {
  it("names the project and region so a misconfiguration is visible", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "my-proj";
    process.env["CLOUD_ML_REGION"] = "us-east5";
    expect(describeProvider("vertex")).toBe("Vertex AI (my-proj · us-east5)");
  });

  it("says global when no region is pinned", () => {
    process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "my-proj";
    expect(describeProvider("vertex")).toContain("global");
  });

  it("names the first-party API", () => {
    expect(describeProvider("anthropic")).toBe("Claude API");
  });
});
