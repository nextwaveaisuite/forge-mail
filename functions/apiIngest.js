// functions/apiIngest.js
// Fully self-contained — no external imports
// Protected lead ingestion endpoint — requires Bearer API key

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Inline key validation — no external import needed
async function validateApiKey(event, requiredPermissions = []) {
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
        body: JSON.stringify({ error: "Unauthorized", message: "Invalid API key format" }),
      },
      keyRecord: null,
      userId: null,
    };
  }

  // Hash the incoming key and look it up
  const hashedKey = crypto.createHash("sha256").update(plaintextKey).digest("hex");

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
        body: JSON.stringify({ error: "Unauthorized", message: "Invalid API key" }),
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
        body: JSON.stringify({ error: "Forbidden", message: "This API key has been revoked" }),
      },
      keyRecord: null,
      userId: null,
    };
  }

  if (requiredPermissions.length > 0) {
    const hasPerms = requiredPermissions.every(p => keyRecord.permissions.includes(p));
    if (!hasPerms) {
      return {
        error: {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({
            error:      "Forbidden",
            message:    `Missing required permissions: ${requiredPermissions.join(", ")}`,
            your_perms: keyRecord.permissions,
          }),
        },
        keyRecord: null,
        userId: null,
      };
    }
  }

  // Log usage — fire and forget, don't block response
  const ip     = event.headers["x-forwarded-for"] || "unknown";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");

  Promise.all([
    supabase.from("api_key_usage").insert({
      key_id:      keyRecord.key_id,
      user_id:     keyRecord.user_id,
      endpoint:    event.path || "apiIngest",
      ip_hash:     ipHash,
      user_agent:  event.headers["user-agent"] || "",
      status_code: 200,
    }),
    supabase.rpc("increment_key_use", { p_key_id: keyRecord.key_id }),
  ]).catch(err => console.error("[apiIngest] Usage log error:", err));

  return { error: null, keyRecord, userId: keyRecord.user_id };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  // Authenticate — requires lead:write permission
  const { error: authError, keyRecord, userId } = await validateApiKey(event, ["lead:write"]);
  if (authError) return authError;

  try {
    const body  = JSON.parse(event.body || "{}");
    const leads = Array.isArray(body) ? body : body.leads ? body.leads : [body];

    if (!leads.length) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "No leads provided" }) };
    }
    if (leads.length > 500) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Max 500 leads per request" }) };
    }

    const results = { inserted: 0, duplicates: 0, invalid: 0, errors: [] };

    // Extract valid emails
    const emails = leads
      .map(l => (l.email || "").trim().toLowerCase())
      .filter(isValidEmail);

    // Check for existing leads to detect duplicates
    const { data: existing } = await supabase
      .from("leads")
      .select("email")
      .eq("user_id", userId)
      .in("email", emails);

    const existingSet = new Set((existing || []).map(r => r.email));

    const toInsert = [];
    for (const lead of leads) {
      const email = (lead.email || "").trim().toLowerCase();

      if (!isValidEmail(email)) {
        results.invalid++;
        results.errors.push({ email: lead.email || "(empty)", reason: "Invalid email" });
        continue;
      }
      if (existingSet.has(email)) {
        results.duplicates++;
        continue;
      }

      toInsert.push({
        user_id:     userId,
        pool:        "own",
        email,
        first_name:  lead.first_name  || lead.firstName  || null,
        last_name:   lead.last_name   || lead.lastName   || null,
        phone:       lead.phone       || null,
        postcode:    lead.postcode    || lead.zip        || null,
        state:       lead.state       || null,
        country:     lead.country     || null,
        temperature: lead.temperature || "cold",
        status:      "active",
        tags: [
          ...(lead.tags || []),
          "api-ingested",
          keyRecord.name.toLowerCase().replace(/\s+/g, "-"),
        ],
      });

      existingSet.add(email); // prevent within-batch duplicates
    }

    // Insert in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from("leads")
        .insert(chunk)
        .select("id");

      if (insertErr) {
        console.error("[apiIngest] Insert error:", insertErr);
      } else {
        results.inserted += (inserted || chunk).length;
      }
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        success:    true,
        inserted:   results.inserted,
        duplicates: results.duplicates,
        invalid:    results.invalid,
        errors:     results.errors.slice(0, 10),
        total:      leads.length,
        message:    `${results.inserted} leads ingested via API key: ${keyRecord.name}`,
        key_id:     keyRecord.key_id,
      }),
    };

  } catch (err) {
    console.error("[apiIngest]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
