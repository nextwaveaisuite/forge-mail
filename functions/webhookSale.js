// functions/webhookSale.js
// Universal affiliate postback receiver
// Works with ClickBank, Digistore24, JVZoo, WarriorPlus, Whop, and any network
// Upgrades lead: WARM → HOT (or COLD → HOT if they skipped opt-in)
// Also upgrades HOT → VIP on repeat purchase

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  try {
    // ── Parse postback from any network ──────────────────────────────
    // Networks send via GET (query params) or POST (body)
    // We handle both
    let data = {};

    // Query params (GET postback — most common)
    if (event.queryStringParameters) {
      data = { ...event.queryStringParameters };
    }

    // Body params (POST postback)
    if (event.body) {
      try {
        const bodyData = event.headers["content-type"]?.includes("application/json")
          ? JSON.parse(event.body)
          : Object.fromEntries(new URLSearchParams(event.body));
        data = { ...data, ...bodyData };
      } catch {}
    }

    // ── Detect which network this is from ────────────────────────────
    const network = detectNetwork(data, event.headers);

    // ── Extract email and revenue ─────────────────────────────────────
    const email   = extractEmail(data, network);
    const revenue = extractRevenue(data, network);
    const offer   = extractOffer(data, network);
    const userId  = data.user_id || data.forge_user_id || process.env.DEFAULT_USER_ID;

    if (!email) {
      console.warn("[webhookSale] No email found in postback:", JSON.stringify(data));
      // Return 200 to stop network retries — just log it
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ received: true, warning: "No email in postback" }),
      };
    }

    const cleanEmail = email.trim().toLowerCase();

    // ── Find current lead temperature ─────────────────────────────────
    const { data: lead } = await supabase
      .from("leads")
      .select("id, temperature, total_revenue, tags")
      .eq("email", cleanEmail)
      .maybeSingle();

    // Determine new temperature
    let newTemp = "hot";
    if (lead?.temperature === "hot" || lead?.temperature === "vip") {
      newTemp = "vip"; // repeat buyer
    }

    // ── Upgrade temperature ────────────────────────────────────────────
    if (lead) {
      await supabase.rpc("upgrade_lead_temperature", {
        p_email:       cleanEmail,
        p_user_id:     userId,
        p_temperature: newTemp,
        p_offer:       offer,
        p_revenue:     revenue,
      });

      // Add buyer tag
      const tags = lead.tags || [];
      const newTags = [...new Set([...tags, "buyer", network])];
      await supabase.from("leads").update({ tags: newTags }).eq("id", lead.id);

    } else {
      // Lead not in system — create as hot lead (direct buyer, skipped opt-in)
      await supabase.from("leads").insert({
        user_id:       userId,
        pool:          "own",
        email:         cleanEmail,
        temperature:   "hot",
        became_hot_at: new Date().toISOString(),
        bought_offer:  offer,
        total_revenue: revenue,
        status:        "active",
        tags:          ["buyer", "direct-buyer", network],
      });
    }

    // ── Log conversion ─────────────────────────────────────────────────
    await supabase.from("lead_conversions").insert({
      user_id:      userId,
      lead_id:      lead?.id || null,
      email:        cleanEmail,
      offer_name:   offer,
      network,
      revenue,
      postback_data: data,
    });

    console.log(`[webhookSale] ${cleanEmail} → ${newTemp} | $${revenue} | ${network} | ${offer}`);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        success:     true,
        email:       cleanEmail,
        temperature: newTemp,
        revenue,
        network,
        offer,
      }),
    };

  } catch (err) {
    console.error("[webhookSale]", err);
    // Always return 200 to affiliate networks — prevents retry loops
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ received: true, error: err.message }),
    };
  }
};

// ── Network detection ─────────────────────────────────────────────────────────
function detectNetwork(data, headers) {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const ref = (headers["referer"] || "").toLowerCase();

  if (data.vendor || data.cbreceipt)         return "clickbank";
  if (data.ds_product_id || ref.includes("digistore")) return "digistore24";
  if (data.affiliate || data.jvzoo)           return "jvzoo";
  if (data.wplus_tid || ref.includes("warriorplus")) return "warriorplus";
  if (data.whop_sale || ref.includes("whop")) return "whop";
  if (data.network)                           return data.network;
  return "unknown";
}

// ── Email extraction — handles all network formats ────────────────────────────
function extractEmail(data, network) {
  // Try common email field names across all networks
  return (
    data.email          ||  // Generic / custom
    data.customer_email ||  // Common
    data.buyer_email    ||  // WarriorPlus
    data.cbpemail       ||  // ClickBank purchaser email
    data.customer_billing_email || // Digistore
    data.contact_email  ||  // GoHighLevel
    data.purchaser_email||
    data.user_email     ||
    data.e              ||  // Shorthand
    null
  );
}

// ── Revenue extraction ────────────────────────────────────────────────────────
function extractRevenue(data, network) {
  const raw =
    data.amount         ||
    data.revenue        ||
    data.sale_amount    ||
    data.order_amount   ||
    data.total          ||
    data.price          ||
    data.commission     ||  // affiliate commission amount
    data.affiliate_amount ||
    "0";

  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return isNaN(num) ? 0 : num;
}

// ── Offer name extraction ─────────────────────────────────────────────────────
function extractOffer(data, network) {
  return (
    data.offer_name     ||
    data.product_name   ||
    data.item_name      ||
    data.product_title  ||
    data.vendor         ||  // ClickBank vendor ID
    data.ds_product_id  ||  // Digistore product ID
    data.product        ||
    data.offer          ||
    "Unknown Offer"
  );
}
