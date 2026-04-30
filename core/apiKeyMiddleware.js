// core/apiKeyMiddleware.js
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function validateApiKey(event, requiredPermissions = []) {
  const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const authHeader =
    event.headers["authorization"] ||
    event.headers["Authorization"] || "";

  if (!authHeader.startsWith("Bearer ")) {
    return {
      error: {
        statusCode: 401,
        headers: HEADERS,
        body: JSON.stringify({
          error:   "Unauthorized",
          message: "Missing Authorization header. Use: Authorization: Bearer <API_KEY>",
        }),
      },
      keyRecord: null,
      userId: null,
    };
  }

  const plaintextKey = authHeader.slice(7).trim();

  if (!plaintextKey || plaintextKey.length < 32) {
    return {
      error: {
        statusCode: 401,
        headers: HEADERS,
        body: JSON.stringify({
          error:   "Unauthorized",
          message: "Invalid API key format",
        }),
      },
      keyRecord: null,
      userId: null,
    };
  }

  const hashedKey = hashKey(plaintextKey);

  const { data: keyRecord, error: dbError } = await supabase
    .from("api_keys")
    .select("key_id, user_id, name, status, permissions, use_count")
    .eq("hashed_key", hashedKey)
    .single();

  if (dbError || !keyRecord) {
    return {
      error: {
        statusCode: 401,
        headers: HEADERS,
        body: JSON.stringify({
          error:   "Unauthorized",
          message: "Invalid API key",
        }),
      },
      keyRecord: null,
      userId: null,
    };
  }

  if (keyRecord.status !== "active") {
    return {
      error: {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({
          error:   "Forbidden",
          message: "This API key has been revoked",
          key_id:  keyRecord.key_id,
        }),
      },
      keyRecord: null,
      userId: null,
    };
  }

  if (requiredPermissions.length > 0) {
    const hasPermissions = requiredPermissions.every(p =>
      keyRecord.permissions.includes(p)
    );
    if (!hasPermissions) {
      return {
        error: {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({
            error:      "Forbidden",
            message:    `Missing required permissions: ${requiredPermissions.join(", ")}`,
            your_perms: keyRecord.permissions,
            need_perms: requiredPermissions,
          }),
        },
        keyRecord: null,
        userId: null,
      };
    }
  }

  const ip = event.headers["x-forwarded-for"] || "unknown";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");

  Promise.all([
    supabase.from("api_key_usage").insert({
      key_id:      keyRecord.key_id,
      user_id:     keyRecord.user_id,
      endpoint:    event.path || "unknown",
      ip_hash:     ipHash,
      user_agent:  event.headers["user-agent"] || "",
      status_code: 200,
    }),
    supabase.rpc("increment_key_use", { p_key_id: keyRecord.key_id }),
  ]).catch(err => console.error("[apiKeyMiddleware] Usage log error:", err));

  return {
    error:     null,
    keyRecord,
    userId:    keyRecord.user_id,
  };
}

function hashKey(plaintextKey) {
  return crypto
    .createHash("sha256")
    .update(plaintextKey)
    .digest("hex");
}

module.exports = { validateApiKey, hashKey };
