import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { calculateHumanDesign, ENGINE_VERSION, localToUtcCandidates } from "../src/engine/human-design-engine.js";
import { createHumanDesignProfileSnapshot, PROFILE_SCHEMA_VERSION } from "../src/engine/profile-snapshot.js";
import { PROFILE_VERIFICATION } from "../shared/human-design-profile-contract.js";
import { installNodeFileFetch } from "./node-file-fetch.mjs";

const MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_ORIGINS = Object.freeze([
  "https://alignwithyour.design",
  "https://www.alignwithyour.design",
  "https://www.uskladusasvojimdizajnom.com",
  "https://uskladusasvojimdizajnom.com",
  "http://127.0.0.1:8789",
  "http://localhost:8789",
  "capacitor://localhost",
]);
const ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "INVALID_BIRTH_DATE",
  "INVALID_BIRTH_TIME",
  "INVALID_TIMEZONE",
  "NONEXISTENT_LOCAL_TIME",
  "AMBIGUOUS_LOCAL_TIME",
  "ENGINE_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function envelope(requestId, data = null, error = null) {
  return { data, requestId, error };
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "INVALID_REQUEST", "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "INVALID_REQUEST", "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", "Request body must contain valid JSON.");
  }
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseChartInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_REQUEST", "A JSON object is required.");
  }
  const allowed = new Set(["birthDate", "birthTime", "timezone", "locationLabel", "timeDisambiguation"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "INVALID_REQUEST", "The request contains unsupported fields.");
  }
  if (typeof body.birthDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.birthDate)) {
    throw new ApiError(400, "INVALID_BIRTH_DATE", "birthDate must use YYYY-MM-DD.");
  }
  if (typeof body.birthTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.birthTime)) {
    throw new ApiError(400, "INVALID_BIRTH_TIME", "birthTime must use 24-hour HH:mm.");
  }
  if (typeof body.timezone !== "string" || body.timezone.length > 64 || !validTimezone(body.timezone)) {
    throw new ApiError(400, "INVALID_TIMEZONE", "timezone must be a valid IANA time zone.");
  }
  if (typeof body.locationLabel !== "string" || body.locationLabel.length > 160) {
    throw new ApiError(400, "INVALID_REQUEST", "locationLabel must be a string of at most 160 characters.");
  }
  if (body.timeDisambiguation !== undefined && !["earlier", "later"].includes(body.timeDisambiguation)) {
    throw new ApiError(400, "INVALID_REQUEST", "timeDisambiguation must be earlier or later.");
  }
  const [year, month, day] = body.birthDate.split("-").map(Number);
  const [hour, minute] = body.birthTime.split(":").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() + 1 !== month
    || normalized.getUTCDate() !== day
  ) {
    throw new ApiError(400, "INVALID_BIRTH_DATE", "birthDate is not a valid calendar date.");
  }
  return { ...body, year, month, day, hour, minute };
}

async function calculateSnapshot(input) {
  const candidates = localToUtcCandidates(input.year, input.month, input.day, input.hour, input.minute, input.timezone);
  if (!candidates.length) {
    throw new ApiError(422, "NONEXISTENT_LOCAL_TIME", "The local time did not exist in the specified time zone.");
  }
  if (candidates.length > 1 && !input.timeDisambiguation) {
    throw new ApiError(409, "AMBIGUOUS_LOCAL_TIME", "The local time occurred twice; provide timeDisambiguation.");
  }
  let result;
  try {
    result = await calculateHumanDesign({
      name: "",
      location: input.locationLabel,
      year: input.year,
      month: input.month,
      day: input.day,
      hour: input.hour,
      minute: input.minute,
      timezone: input.timezone,
      timeDisambiguation: input.timeDisambiguation || "earlier",
    });
  } catch (error) {
    if (/Swiss Ephemeris|WASM|ephemeris/i.test(error.message)) {
      throw new ApiError(503, "ENGINE_UNAVAILABLE", "The calculation engine is temporarily unavailable.");
    }
    throw error;
  }
  return createHumanDesignProfileSnapshot({
    input: {
      birthDate: input.birthDate,
      birthTime: input.birthTime,
      timezone: input.timezone,
      locationLabel: input.locationLabel,
    },
    result,
    verificationStatus: PROFILE_VERIFICATION.ENGINE_VERIFIED,
  });
}

function createRateLimiter(limit) {
  const entries = new Map();
  return (key) => {
    const now = Date.now();
    const current = entries.get(key);
    if (!current || current.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, remaining: limit - 1 };
    }
    current.count += 1;
    return { allowed: current.count <= limit, remaining: Math.max(0, limit - current.count) };
  };
}

export function createApiServer(options = {}) {
  installNodeFileFetch();
  const config = {
    appVersion: options.appVersion || process.env.PLUTO_APP_VERSION || "1.0.0",
    gitCommit: options.gitCommit || process.env.PLUTO_GIT_COMMIT || "development",
    buildDate: options.buildDate || process.env.PLUTO_BUILD_DATE || "development",
    origins: new Set(options.origins || (process.env.PLUTO_CORS_ORIGINS || "").split(",").filter(Boolean) || DEFAULT_ORIGINS),
    rateLimit: Number(options.rateLimit || process.env.PLUTO_RATE_LIMIT_PER_MINUTE || 30),
  };
  if (!config.origins.size) DEFAULT_ORIGINS.forEach((origin) => config.origins.add(origin));
  const rateLimit = createRateLimiter(config.rateLimit);
  const calculate = options.calculateSnapshot || calculateSnapshot;
  const log = options.logger || ((entry) => console.info(JSON.stringify(entry)));

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let route = "unknown";
    let errorCode = null;
    const origin = request.headers.origin;
    const corsHeaders = origin && config.origins.has(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
    response.once("finish", () => log({
      requestId,
      method: request.method,
      route,
      status: response.statusCode,
      errorCode,
      durationMs: Math.round(performance.now() - startedAt),
    }));
    try {
      if (origin && !config.origins.has(origin)) throw new ApiError(403, "INVALID_REQUEST", "Origin is not allowed.");
      if (request.method === "OPTIONS") {
        route = "preflight";
        response.writeHead(204, {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/v1/health") {
        route = "/v1/health";
        json(response, 200, envelope(requestId, { status: "ok" }), corsHeaders);
        return;
      }
      if (request.method === "GET" && request.url === "/v1/version") {
        route = "/v1/version";
        json(response, 200, envelope(requestId, {
          appVersion: config.appVersion,
          gitCommit: config.gitCommit,
          buildDate: config.buildDate,
          schemaVersion: PROFILE_SCHEMA_VERSION,
          engineVersion: ENGINE_VERSION,
        }), corsHeaders);
        return;
      }
      if (request.method === "POST" && request.url === "/v1/charts") {
        route = "/v1/charts";
        // Deliberately ignore X-Forwarded-For. A trusted production gateway must
        // apply distributed client-aware rate limiting before this process.
        const client = request.socket.remoteAddress || "unknown";
        const rate = rateLimit(client);
        response.setHeader("X-RateLimit-Limit", String(config.rateLimit));
        response.setHeader("X-RateLimit-Remaining", String(rate.remaining));
        if (!rate.allowed) throw new ApiError(429, "RATE_LIMITED", "Too many requests; try again later.");
        const input = parseChartInput(await readJsonBody(request));
        let snapshot;
        try {
          snapshot = await calculate(input);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (/Swiss Ephemeris|WASM|ephemeris/i.test(error?.message || "")) {
            throw new ApiError(503, "ENGINE_UNAVAILABLE", "The calculation engine is temporarily unavailable.");
          }
          throw error;
        }
        json(response, 200, envelope(requestId, snapshot), corsHeaders);
        return;
      }
      throw new ApiError(404, "INVALID_REQUEST", "Route not found.");
    } catch (error) {
      const safe = error instanceof ApiError
        ? error
        : new ApiError(500, "INTERNAL_ERROR", "An internal error occurred.");
      const code = ERROR_CODES.has(safe.code) ? safe.code : "INTERNAL_ERROR";
      errorCode = code;
      json(response, safe.status || 500, envelope(requestId, null, { code, message: safe.message }), corsHeaders);
    }
  });

  return {
    server,
    async listen({ host = "127.0.0.1", port = 8790 } = {}) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
