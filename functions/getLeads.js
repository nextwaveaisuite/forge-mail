// functions/getLeads.js
// Fetch leads with filtering, pagination, search

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  try {
    const {
      userId,
      pool,         // 'mlgs' | 'own' | null (all)
      batchId,
      search,       // search email or name
      state,
      country,
      tags,         // array — leads must have ALL tags
      status,       // 'active' | 'unsubscribed' | 'bounced'
      page = 1,
      pageSize = 50,
    } = JSON.parse(event.body || "{}");

    if (!userId) throw new Error("userId required");

    const from = (page - 1) * pageSize;
    const to   = from + pageSize - 1;

    let query = supabase
      .from("leads")
      .select("*", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (pool)    query = query.eq("pool", pool);
    if (batchId) query = query.eq("batch_id", batchId);
    if (state)   query = query.ilike("state", `%${state}%`);
    if (country) query = query.ilike("country", `%${country}%`);
    if (status)  query = query.eq("status", status);

    if (search) {
      query = query.or(
        `email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`
      );
    }

    if (tags?.length) {
      query = query.contains("tags", tags);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        leads: data || [],
        total: count || 0,
        page,
        pageSize,
        totalPages: Math.ceil((count || 0) / pageSize),
      }),
    };

  } catch (err) {
    console.error("[getLeads]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
