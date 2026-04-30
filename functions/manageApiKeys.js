// functions/manageApiKeys.js
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { hashKey } = require("../core/apiKeyMiddleware");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MAX_KEYS_PER_USER = 10;
const DEFAULT_PERMISSIONS = ["lead:write", "campaign:read"];
const VALID_PERMISSIONS = [
  "lead:write",
  "lead:read",
  "campaign:read",
  "campaign:write",
  "email:send",
  "admin",
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  const body = JSON.parse(event.body || "{}");
  const { action, userId } = body;

  if (!userId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "userId required" }) };

  try {
    switch (action) {

      case "create": {
        const { name, permissions } = body;

        if (!name || !name.trim()) {
          return badRequest("Key name is required.");
        }

        const { count } = await supabase
          .from("api_keys")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "active");

        if ((count || 0) >= MAX_KEYS_PER_USER) {
          return {
            statusCode: 429,
            headers: HEADERS,
            body: JSON.stringify({
              error:   "Rate limit exceeded",
              message: `Maximum ${MAX_KEYS_PER_USER} active API keys per account.`,
            }),
          };
        }

        const requestedPerms = permissions || DEFAULT_PERMISSIONS;
        const invalidPerms = requestedPerms.filter(p => !VALID_PERMISSIONS.includes(p));
        if (invalidPerms.length) {
          return badRequest(`Invalid permissions: ${invalidPerms.join(", ")}`);
        }

        const randomBytes  = crypto.randomBytes(24).toString("hex");
        const plaintextKey = `frgk_${randomBytes}`;
        const hashedKey    = hashKey(plaintextKey);
        const keyPrefix    = plaintextKey.slice(0, 12);

        const { data: newKey, error } = await supabase
          .from("api_keys")
          .insert({
            user_id:     userId,
            name:        name.trim(),
            hashed_key:  hashedKey,
            key_prefix:  keyPrefix,
            status:      "active",
            permissions: requestedPerms,
          })
          .select("key_id, name, status, permissions, key_prefix, created_at")
          .single();

        if (error) throw error;

        return {
          statusCode: 201,
          headers: HEADERS,
          body: JSON.stringify({
            api_key:     plaintextKey,
            key_id:      newKey.key_id,
            name:        newKey.name,
            key_prefix:  newKey.key_prefix,
            status:      newKey.status,
            permissions: newKey.permissions,
            created_at:  newKey.created_at,
            warning:     "Save this key immediately. It will NOT be shown again.",
          }),
        };
      }

      case "list": {
        const { data, error } = await supabase
          .from("api_keys")
          .select("key_id, name, key_prefix, status, permissions, use_count, last_used_at, created_at, revoked_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error) throw error;

        return ok({
          keys: (data || []).map(k => ({
            ...k,
            display_key: `${k.key_prefix}${"•".repeat(41)}`,
          })),
          total: (data || []).length,
        });
      }

      case "revoke": {
        const { keyId } = body;
        if (!keyId) return badRequest("keyId required");

        const { data: key } = await supabase
          .from("api_keys")
          .select("key_id, name, status")
          .eq("key_id", keyId)
          .eq("user_id", userId)
          .single();

        if (!key)                    return badRequest("Key not found");
        if (key.status === "revoked") return badRequest("Key is already revoked");

        const { error } = await supabase
          .from("api_keys")
          .update({ status: "revoked", revoked_at: new Date().toISOString() })
          .eq("key_id", keyId)
          .eq("user_id", userId);

        if (error) throw error;

        return ok({
          revoked: true,
          key_id:  keyId,
          name:    key.name,
          message: `API key "${key.name}" has been revoked.`,
        });
      }

      case "usage": {
        const { keyId, limit: lim = 50 } = body;
        if (!keyId) return badRequest("keyId required");

        const { data, count, error } = await supabase
          .from("api_key_usage")
          .select("id, endpoint, ip_hash, user_agent, status_code, used_at", { count: "exact" })
          .eq("key_id", keyId)
          .eq("user_id", userId)
          .order("used_at", { ascending: false })
          .limit(lim);

        if (error) throw error;
        return ok({ usage: data || [], total: count || 0, key_id: keyId });
      }

      case "stats": {
        const { data: keys } = await supabase
          .from("api_keys")
          .select("key_id, name, key_prefix, status, use_count, last_used_at")
          .eq("user_id", userId);

        const active   = (keys || []).filter(k => k.status === "active").length;
        const revoked  = (keys || []).filter(k => k.status === "revoked").length;
        const totalUse = (keys || []).reduce((s, k) => s + (k.use_count || 0), 0);

        return ok({ active, revoked, total: (keys || []).length, totalUse });
      }

      default:
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
    }

  } catch (err) {
    console.error("[manageApiKeys]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data)       { return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) }; }
function badRequest(msg){ return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: msg }) }; }
