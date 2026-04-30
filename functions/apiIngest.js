// functions/apiIngest.js
const { createClient } = require("@supabase/supabase-js");
const { validateApiKey } = require("../core/apiKeyMiddleware");

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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  const { error: authError, keyRecord, userId } = await validateApiKey(event, ["lead:write"]);
  if (authError) return authError;

  try {
    const body  = JSON.parse(event.body || "{}");
    const leads = Array.isArray(body) ? body : body.leads ? body.leads : [body];

    if (!leads.length)    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "No leads provided" }) };
    if (leads.length > 500) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Max 500 leads per request" }) };

    const results = { inserted: 0, duplicates: 0, invalid: 0, errors: [] };

    const emails = leads
      .map(l => (l.email || "").trim().toLowerCase())
      .filter(isValidEmail);

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
        tags:        [
          ...(lead.tags || []),
          "api-ingested",
          keyRecord.name.toLowerCase().replace(/\s+/g, "-"),
        ],
      });

      existingSet.add(email);
    }

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
