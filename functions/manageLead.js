// functions/manageLead.js
// Update lead status/tags/notes, delete lead, get batch list

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

  const body = JSON.parse(event.body || "{}");
  const { action, userId } = body;

  if (!userId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "userId required" }) };

  try {
    switch (action) {

      // ── Get all batches for a user ────────────────────────────────────────
      case "getBatches": {
        const { data, error } = await supabase
          .from("lead_batches")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return ok({ batches: data || [] });
      }

      // ── Get lead stats ────────────────────────────────────────────────────
      case "getStats": {
        const { data: mlgs } = await supabase
          .from("leads")
          .select("status", { count: "exact" })
          .eq("user_id", userId)
          .eq("pool", "mlgs");

        const { data: own } = await supabase
          .from("leads")
          .select("status", { count: "exact" })
          .eq("user_id", userId)
          .eq("pool", "own");

        const countByStatus = (arr, s) => (arr || []).filter(l => l.status === s).length;

        return ok({
          mlgs: {
            total: (mlgs || []).length,
            active: countByStatus(mlgs, "active"),
            unsubscribed: countByStatus(mlgs, "unsubscribed"),
            bounced: countByStatus(mlgs, "bounced"),
          },
          own: {
            total: (own || []).length,
            active: countByStatus(own, "active"),
            unsubscribed: countByStatus(own, "unsubscribed"),
            bounced: countByStatus(own, "bounced"),
          },
        });
      }

      // ── Update a single lead ──────────────────────────────────────────────
      case "updateLead": {
        const { leadId, updates } = body;
        if (!leadId) throw new Error("leadId required");

        const allowed = ["status", "tags", "notes", "first_name", "last_name"];
        const safe = Object.fromEntries(
          Object.entries(updates || {}).filter(([k]) => allowed.includes(k))
        );

        const { error } = await supabase
          .from("leads")
          .update(safe)
          .eq("id", leadId)
          .eq("user_id", userId);

        if (error) throw error;
        return ok({ updated: true });
      }

      // ── Delete a single lead ──────────────────────────────────────────────
      case "deleteLead": {
        const { leadId } = body;
        if (!leadId) throw new Error("leadId required");
        const { error } = await supabase
          .from("leads")
          .delete()
          .eq("id", leadId)
          .eq("user_id", userId);
        if (error) throw error;
        return ok({ deleted: true });
      }

      // ── Delete entire batch ───────────────────────────────────────────────
      case "deleteBatch": {
        const { batchId } = body;
        if (!batchId) throw new Error("batchId required");
        // Leads cascade delete via FK
        const { error } = await supabase
          .from("lead_batches")
          .delete()
          .eq("id", batchId)
          .eq("user_id", userId);
        if (error) throw error;
        return ok({ deleted: true });
      }

      // ── Tag entire batch ──────────────────────────────────────────────────
      case "tagBatch": {
        const { batchId, tags: newTags } = body;
        if (!batchId) throw new Error("batchId required");

        // Get current tags on all leads in batch
        const { data: batchLeads } = await supabase
          .from("leads")
          .select("id, tags")
          .eq("batch_id", batchId)
          .eq("user_id", userId);

        // Merge new tags with existing
        for (const lead of batchLeads || []) {
          const merged = [...new Set([...(lead.tags || []), ...(newTags || [])])];
          await supabase
            .from("leads")
            .update({ tags: merged })
            .eq("id", lead.id);
        }

        // Update batch tags too
        await supabase
          .from("lead_batches")
          .update({ tags: newTags })
          .eq("id", batchId);

        return ok({ tagged: (batchLeads || []).length });
      }

      // ── Export own leads (CSV) ────────────────────────────────────────────
      case "exportOwn": {
        const { batchId, tags: filterTags } = body;

        let query = supabase
          .from("leads")
          .select("email,first_name,last_name,phone,postcode,state,country,tags,status")
          .eq("user_id", userId)
          .eq("pool", "own")
          .eq("status", "active");

        if (batchId) query = query.eq("batch_id", batchId);
        if (filterTags?.length) query = query.contains("tags", filterTags);

        const { data, error } = await query;
        if (error) throw error;

        // Build CSV
        const header = "email,first_name,last_name,phone,postcode,state,country,tags";
        const rows = (data || []).map(l =>
          [
            l.email, l.first_name||"", l.last_name||"",
            l.phone||"", l.postcode||"", l.state||"",
            l.country||"", (l.tags||[]).join("|"),
          ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")
        );

        return {
          statusCode: 200,
          headers: { ...HEADERS, "Content-Type": "text/csv" },
          body: [header, ...rows].join("\n"),
        };
      }

      // ── Get duplicates list ────────────────────────────────────────────
      case "getDuplicates": {
        const { page: pg = 1, pageSize: ps = 50 } = body;
        const from = (pg - 1) * ps;
        const { data, count, error } = await supabase
          .from("lead_duplicates")
          .select("*", { count: "exact" })
          .eq("user_id", userId)
          .order("detected_at", { ascending: false })
          .range(from, from + ps - 1);
        if (error) throw error;
        return ok({ duplicates: data || [], total: count || 0, page: pg, pageSize: ps });
      }

      // ── Get duplicate stats ──────────────────────────────────────────────
      case "getDuplicateStats": {
        const { data: stats, error } = await supabase.rpc("get_duplicate_stats", { p_user_id: userId });
        if (error) throw error;
        return ok(stats);
      }

      // ── Delete single duplicate ──────────────────────────────────────────
      case "deleteDuplicate": {
        const { dupId } = body;
        if (!dupId) throw new Error("dupId required");
        const { error } = await supabase.from("lead_duplicates").delete().eq("id", dupId).eq("user_id", userId);
        if (error) throw error;
        return ok({ deleted: true });
      }

      // ── Delete ALL duplicates ────────────────────────────────────────────
      case "deleteAllDuplicates": {
        const { data: count, error } = await supabase.rpc("delete_all_duplicates", { p_user_id: userId });
        if (error) throw error;
        return ok({ deleted: count });
      }

      // ── Import duplicate as real lead ────────────────────────────────────
      case "keepDuplicate": {
        const { dupId } = body;
        const { data: dup, error: fetchErr } = await supabase.from("lead_duplicates").select("*").eq("id", dupId).single();
        if (fetchErr) throw fetchErr;
        await supabase.from("leads").insert({ user_id: userId, pool: "own", email: dup.email, first_name: dup.first_name, last_name: dup.last_name, phone: dup.phone, postcode: dup.postcode, state: dup.state, country: dup.country, temperature: "cold", status: "active" });
        await supabase.from("lead_duplicates").update({ reviewed: true, action: "kept" }).eq("id", dupId);
        return ok({ kept: true });
      }

      default:
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Unknown action" }) };
    }

  } catch (err) {
    console.error("[manageLead]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) };
}
