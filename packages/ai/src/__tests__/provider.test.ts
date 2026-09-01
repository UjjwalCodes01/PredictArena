/**
 * Which backend gets chosen, and how a service-account key is read.
 *
 * The credential path is the one piece of this that only fails in production:
 * locally it is covered by ADC, so a broken GOOGLE_SERVICE_ACCOUNT_JSON is
 * invisible until it is deployed. These tests are what stands in for that.
 *
 * Nothing here reaches the network. Constructing the client does not resolve
 * credentials — this SDK defers that to the first request — so these stay fast
 * and deterministic on a machine with no gcloud and no ADC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeProvider, createForecastClient, describeProvider, modelId, serviceAccountCredentials,
} from "../provider";

const KEYS = [
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_API_KEY",
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

describe("activeProvider", () => {
  it("is null when nothing is configured", () => {
    expect(activeProvider()).toBeNull();
  });

  it("picks Vertex from a GCP project", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "demo";
    expect(activeProvider()).toBe("vertex");
  });

  it("picks the Gemini API from a key", () => {
    process.env["GEMINI_API_KEY"] = "AIza-test";
    expect(activeProvider()).toBe("gemini-api");
  });

  it("prefers Vertex when both are set", () => {
    // A stale key left in the environment must not silently redirect spend
    // away from the provider the operator deliberately configured.
    process.env["GOOGLE_CLOUD_PROJECT"] = "demo";
    process.env["GEMINI_API_KEY"] = "AIza-test";
    expect(activeProvider()).toBe("vertex");
  });
});

describe("modelId", () => {
  it("defaults to a Flash model, because a slow forecast is a missed one", () => {
    expect(modelId()).toBe("gemini-2.5-flash");
  });

  it("is overridable, for a Pro model or a different region's availability", () => {
    process.env["AI_MODEL"] = "gemini-2.5-pro";
    expect(modelId()).toBe("gemini-2.5-pro");
  });
});

describe("createForecastClient", () => {
  it("returns null with nothing configured", () => {
    expect(createForecastClient()).toBeNull();
  });

  it("builds a Gemini API client from a key", () => {
    process.env["GEMINI_API_KEY"] = "AIza-test";
    const made = createForecastClient();
    expect(made?.provider).toBe("gemini-api");
    expect(made?.client.models).toBeDefined();
    expect(made?.client.vertexai).toBe(false);
  });

  it("builds a Vertex client from a project, defaulting the location to global", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "demo";
    const made = createForecastClient();
    expect(made?.provider).toBe("vertex");
    expect(made?.client.vertexai).toBe(true);
    expect(made?.client.models).toBeDefined();
  });

  it("accepts an inline service-account key", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "demo";
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;
    expect(createForecastClient()?.provider).toBe("vertex");
  });

  it("does not resolve credentials while constructing", async () => {
    // The regression this guards, carried over from the previous SDK: a client
    // that resolves auth in its CONSTRUCTOR leaves a rejected promise nobody
    // awaits, which passes locally and kills a CI worker. Verified here rather
    // than assumed, because that is exactly how it was missed before.
    process.env["GOOGLE_CLOUD_PROJECT"] = "demo";
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(createForecastClient()?.provider).toBe("vertex");
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("serviceAccountCredentials", () => {
  // Tested directly rather than through a client: this is pure parsing, and
  // building a client to reach it would drag in credential resolution.
  it("returns nothing when unset, so the caller falls through to ADC", () => {
    expect(serviceAccountCredentials()).toBeUndefined();
  });

  it("ignores an empty or whitespace blob", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "   ";
    expect(serviceAccountCredentials()).toBeUndefined();
  });

  it("accepts raw JSON", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = FAKE_SA;
    expect(serviceAccountCredentials()?.credentials).toBeDefined();
  });

  it("accepts base64, since dashboards mangle the newlines in private_key", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = Buffer.from(FAKE_SA).toString("base64");
    expect(serviceAccountCredentials()?.credentials).toBeDefined();
  });

  it("throws a legible error on an unparseable blob", () => {
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "{not json";
    expect(() => serviceAccountCredentials()).toThrow(/not valid JSON/);
  });

  it("rejects a blob that parses but is not a service-account key", () => {
    // The likely mistake: pasting an OAuth client or an API key instead.
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = JSON.stringify({ type: "authorized_user" });
    expect(() => serviceAccountCredentials()).toThrow(/client_email/);
  });
});

describe("describeProvider", () => {
  it("names the project and location so a misconfiguration is visible", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "my-proj";
    process.env["GOOGLE_CLOUD_LOCATION"] = "us-central1";
    expect(describeProvider("vertex")).toBe("Vertex AI (my-proj · us-central1)");
  });

  it("says global when no location is pinned", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "my-proj";
    expect(describeProvider("vertex")).toContain("global");
  });

  it("names the direct API", () => {
    expect(describeProvider("gemini-api")).toBe("Gemini API");
  });
});
