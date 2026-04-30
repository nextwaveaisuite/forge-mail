// functions/manageApiKeys.js
// Zero dependencies — uses fetch directly instead of Supabase SDK
// This eliminates cold start delays from bundling

const crypto = require("crypto");

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MAX_KEYS   = 10;
const VALID_PERMS = ["lead:write","lead:read","campaign:read","campaign:write","email:send","admin"];
const DEFAULT_PERMS = ["lead:write","campaign:read"];

// Direct Supabase REST fetch
async function sb(table, options = {}) {
  const { method = "GET", filter = "", body, select = "*", count } = options;
  const countHeader = count ? "exact" : null;

  const url = `${SB_URL}/rest/v1/${table}${filter ? `?${filter}` : (select !== "*" ? `?select=${select}` : "")}`;

  const headers = {
    apikey:        SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
    Prefer:        [
      count ? "count=exact" : "",
      method === "POST" ? "return=representation" : "",
    ].filter(Boolean).join(",") || undefined,
  };

  if (countHeader) headers["Prefer"] = "count=exact";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  const totalCount = res.headers.get("content-range")
    ? parseInt(res.headers.get("content-range").split("/")[1])
    : null;

  return { data, count: totalCount, ok: res.ok, status: res.status };
}

// RPC call
async function rpc(fn, params) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey:         SB_KEY,
      Authorization:  `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  return res.ok;
}

function hashKey(k) {
  return crypto.createHash("sha256").update(k).digest("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return bad("Invalid JSON"); }

  const { action, userId } = body;
  if (!userId) return bad("userId required");

  try {
    switch (action) {

      // ── CREATE ──────────────────────────────────────────────────────
      case "create": {
        const { name, permissions } = body;
        if (!name?.trim()) return bad("Key name is required");

        // Rate limit check
        const check = await sb("api_keys",{
          filter: `user_id=eq.${userId}&status=eq.active&select=key_id`,
          count: true
        });
        if ((check.count || 0) >= MAX_KEYS) {
          return { statusCode: 429, headers: HEADERS, body: JSON.stringify({
            error: "Rate limit", message: `Max ${MAX_KEYS} active keys per account`
          })};
        }

        const perms = permissions || DEFAULT_PERMS;
        const bad_p = perms.filter(p => !VALID_PERMS.includes(p));
        if (bad_p.length) return bad(`Invalid permissions: ${bad_p.join(", ")}`);

        const plaintext = `frgk_${crypto.randomBytes(24).toString("hex")}`;
        const hashed    = hashKey(plaintext);
        const prefix    = plaintext.slice(0, 12);

        const ins = await sb("api_keys", {
          method: "POST",
          body: {
            user_id:     userId,
            name:        name.trim(),
            hashed_key:  hashed,
            key_prefix:  prefix,
            status:      "active",
            permissions: perms,
          }
        });

        if (!ins.ok) throw new Error("Failed to create key: " + JSON.stringify(ins.data));

        const newKey = Array.isArray(ins.data) ? ins.data[0] : ins.data;

        return {
          statusCode: 201,
          headers: HEADERS,
          body: JSON.stringify({
            api_key:     plaintext,
            key_id:      newKey?.key_id,
            name:        newKey?.name || name.trim(),
            key_prefix:  prefix,
            status:      "active",
            permissions: perms,
            created_at:  newKey?.created_at,
            warning:     "Save this key now — it will NOT be shown again.",
          }),
        };
      }

      // ── LIST ────────────────────────────────────────────────────────
      case "list": {
        const res = await sb("api_keys", {
          filter: `user_id=eq.${userId}&order=created_at.desc`,
          select: "key_id,name,key_prefix,status,permissions,use_count,last_used_at,created_at,revoked_at",
        });

        return ok({
          keys: (res.data || []).map(k => ({
            ...k,
            display_key: `${k.key_prefix}${"•".repeat(41)}`,
          })),
          total: (res.data || []).length,
        });
      }

      // ── REVOKE ──────────────────────────────────────────────────────
      case "revoke": {
        const { keyId } = body;
        if (!keyId) return bad("keyId required");

        const find = await sb("api_keys", {
          filter: `key_id=eq.${keyId}&user_id=eq.${userId}&select=key_id,name,status`,
        });
        const key = find.data?.[0];
        if (!key)                     return bad("Key not found");
        if (key.status === "revoked") return bad("Already revoked");

        await sb("api_keys", {
          method: "PATCH",
          filter: `key_id=eq.${keyId}&user_id=eq.${userId}`,
          body:   { status: "revoked", revoked_at: new Date().toISOString() },
        });

        return ok({ revoked: true, key_id: keyId, name: key.name });
      }

      // ── USAGE ───────────────────────────────────────────────────────
      case "usage": {
        const { keyId, limit: lim = 50 } = body;
        if (!keyId) return bad("keyId required");

        const res = await sb("api_key_usage", {
          filter: `key_id=eq.${keyId}&user_id=eq.${userId}&order=used_at.desc&limit=${lim}`,
          count:  true,
        });

        return ok({ usage: res.data || [], total: res.count || 0 });
      }

      // ── STATS ───────────────────────────────────────────────────────
      case "stats": {
        const res = await sb("api_keys", {
          filter: `user_id=eq.${userId}&select=status,use_count`,
        });
        const keys     = res.data || [];
        const active   = keys.filter(k => k.status === "active").length;
        const revoked  = keys.filter(k => k.status === "revoked").length;
        const totalUse = keys.reduce((s, k) => s + (k.use_count || 0), 0);
        return ok({ active, revoked, total: keys.length, totalUse });
      }

      default:
        return bad(`Unknown action: ${action}`);
    }

  } catch (err) {
    console.error("[manageApiKeys]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data)  { return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) }; }
function bad(msg)  { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: msg }) }; }
