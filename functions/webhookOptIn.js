// functions/webhookOptIn.js
// Receives opt-in from your custom HTML landing page
// Upgrades lead: COLD → WARM
// Also creates the lead if they're not in the system yet (own leads pool)

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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  try {
    // Accept both JSON body and URL-encoded form (from HTML forms)
    let body = {};
    const ct = event.headers["content-type"] || "";

    if (ct.includes("application/json")) {
      body = JSON.parse(event.body || "{}");
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      // Parse form-encoded data
      const params = new URLSearchParams(event.body);
      params.forEach((val, key) => { body[key] = val; });
    } else {
      // Try JSON first, fall back to form parse
      try { body = JSON.parse(event.body || "{}"); }
      catch { const p = new URLSearchParams(event.body); p.forEach((v,k)=>{ body[k]=v; }); }
    }

    const {
      email,
      first_name,
      last_name,
      phone,
      offer_name,
      page_url,
      user_id,      // your Forge user ID — set in your landing page
    } = body;

    if (!email) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "email is required" }) };
    }

    const cleanEmail = email.trim().toLowerCase();
    const ip = event.headers["x-forwarded-for"] || "unknown";
    const ipHash = crypto.createHash("sha256").update(ip).digest("hex");

    // Look up lead by email
    const { data: existingLead } = await supabase
      .from("leads")
      .select("id, temperature, pool, email")
      .eq("email", cleanEmail)
      .maybeSingle();

    let leadId = existingLead?.id;

    if (!existingLead) {
      // Lead not in system — create as own lead (warm already)
      const { data: newLead } = await supabase
        .from("leads")
        .insert({
          user_id:       user_id || process.env.DEFAULT_USER_ID,
          pool:          "own",
          email:         cleanEmail,
          first_name:    first_name || null,
          last_name:     last_name  || null,
          phone:         phone      || null,
          temperature:   "warm",
          became_warm_at: new Date().toISOString(),
          opted_in_offer: offer_name || null,
          status:        "active",
          tags:          ["opted-in"],
        })
        .select("id")
        .single();

      leadId = newLead?.id;

    } else if (existingLead.temperature === "cold") {
      // Upgrade cold → warm
      const { error } = await supabase.rpc("upgrade_lead_temperature", {
        p_email:       cleanEmail,
        p_user_id:     user_id || process.env.DEFAULT_USER_ID,
        p_temperature: "warm",
        p_offer:       offer_name || null,
        p_revenue:     0,
      });

      if (error) throw error;

      // Add opted-in tag
      const currentTags = existingLead.tags || [];
      if (!currentTags.includes("opted-in")) {
        await supabase
          .from("leads")
          .update({ tags: [...currentTags, "opted-in"] })
          .eq("id", existingLead.id);
      }
    }
    // If already warm or hot — just log the opt-in, don't downgrade

    // Log the opt-in event
    await supabase.from("lead_optins").insert({
      user_id:     user_id || process.env.DEFAULT_USER_ID,
      lead_id:     leadId || null,
      email:       cleanEmail,
      first_name:  first_name || null,
      offer_name:  offer_name || null,
      page_url:    page_url   || null,
      ip_hash:     ipHash,
    });

    console.log(`[webhookOptIn] ${cleanEmail} → WARM (offer: ${offer_name || "unknown"})`);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        success:  true,
        email:    cleanEmail,
        upgraded: existingLead?.temperature === "cold",
        wasNew:   !existingLead,
        message:  "Lead upgraded to WARM",
      }),
    };

  } catch (err) {
    console.error("[webhookOptIn]", err);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
