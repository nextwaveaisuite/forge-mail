// functions/manageLead.js
// Lead management — stats, batches, update, delete, export, duplicates

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

      // ── Get all batches with REAL lead counts from DB ─────────────────────
      case "getBatches": {
        const { data, error } = await supabase
          .from("lead_batches")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });
        if (error) throw error;

        // Get real lead count for each batch directly from leads table
        const batchesWithRealCounts = await Promise.all(
          (data || []).map(async (batch) => {
            const { count } = await supabase
              .from("leads")
              .select("*", { count: "exact", head: true })
              .eq("batch_id", batch.id)
              .eq("user_id", userId);

            // Update stored lead_count if it differs from real count
            if (count !== batch.lead_count) {
              await supabase
                .from("lead_batches")
                .update({ lead_count: count || 0 })
                .eq("id", batch.id);
            }

            return { ...batch, lead_count: count || 0 };
          })
        );

        return ok({ batches: batchesWithRealCounts });
      }

      // ── Get lead stats using COUNT queries — precise for any list size ────
      case "getStats": {
        // MLGS counts
        const { count: mlgsTotal } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "mlgs");

        const { count: mlgsActive } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "mlgs")
          .eq("status", "active");

        const { count: mlgsUnsub } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "mlgs")
          .eq("status", "unsubscribed");

        const { count: mlgsBounced } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "mlgs")
          .eq("status", "bounced");

        // Own lead counts
        const { count: ownTotal } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "own");

        const { count: ownActive } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "own")
          .eq("status", "active");

        const { count: ownUnsub } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "own")
          .eq("status", "unsubscribed");

        const { count: ownBounced } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("pool", "own")
          .eq("status", "bounced");

        // Temperature counts (all pools)
        const { count: coldCount } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("temperature", "cold");

        const { count: warmCount } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("temperature", "warm");

        const { count: hotCount } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("temperature", "hot");

        const { count: vipCount } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("temperature", "vip");

        return ok({
          mlgs: {
            total:        mlgsTotal   || 0,
            active:       mlgsActive  || 0,
            unsubscribed: mlgsUnsub   || 0,
            bounced:      mlgsBounced || 0,
          },
          own: {
            total:        ownTotal   || 0,
            active:       ownActive  || 0,
            unsubscribed: ownUnsub   || 0,
            bounced:      ownBounced || 0,
          },
          temperature: {
            cold: coldCount || 0,
            warm: warmCount || 0,
            hot:  hotCount  || 0,
            vip:  vipCount  || 0,
          },
        });
      }

      // ── Update a single lead ──────────────────────────────────────────────
      case "updateLead": {
        const { leadId, updates } = body;
        if (!leadId) throw new Error("leadId required");

        const allowed = ["status", "tags", "notes", "first_name", "last_name", "temperature"];
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

      // ── Delete entire batch + all its leads ───────────────────────────────
      case "deleteBatch": {
        const { batchId } = body;
        if (!batchId) throw new Error("batchId required");

        // Count leads before deletion for accurate reporting
        const { count: leadCount } = await supabase
          .from("leads")
          .select("*", { count: "exact", head: true })
          .eq("batch_id", batchId)
          .eq("user_id", userId);

        // Delete leads first (cascade should handle it but being explicit)
        await supabase
          .from("leads")
          .delete()
          .eq("batch_id", batchId)
          .eq("user_id", userId);

        // Delete batch record
        const { error } = await supabase
          .from("lead_batches")
          .delete()
          .eq("id", batchId)
          .eq("user_id", userId);

        if (error) throw error;
        return ok({ deleted: true, leadsRemoved: leadCount || 0 });
      }

      // ── Tag entire batch ──────────────────────────────────────────────────
      case "tagBatch": {
        const { batchId, tags: newTags } = body;
        if (!batchId) throw new Error("batchId required");

        const { data: batchLeads } = await supabase
          .from("leads")
          .select("id, tags")
          .eq("batch_id", batchId)
          .eq("user_id", userId);

        for (const lead of batchLeads || []) {
          const merged = [...new Set([...(lead.tags || []), ...(newTags || [])])];
          await supabase.from("leads").update({ tags: merged }).eq("id", lead.id);
        }

        await supabase
          .from("lead_batches")
          .update({ tags: newTags })
          .eq("id", batchId);

        return ok({ tagged: (batchLeads || []).length });
      }

      // ── Export own leads as CSV ───────────────────────────────────────────
      case "exportOwn": {
        const { batchId, tags: filterTags } = body;

        let query = supabase
          .from("leads")
          .select("email,first_name,last_name,phone,postcode,state,country,tags,status,temperature")
          .eq("user_id", userId)
          .eq("pool", "own")
          .eq("status", "active");

        if (batchId)          query = query.eq("batch_id", batchId);
        if (filterTags?.length) query = query.contains("tags", filterTags);

        const { data, error } = await query;
        if (error) throw error;

        const header = "email,first_name,last_name,phone,postcode,state,country,tags,temperature";
        const rows = (data || []).map(l =>
          [
            l.email, l.first_name||"", l.last_name||"",
            l.phone||"", l.postcode||"", l.state||"",
            l.country||"", (l.tags||[]).join("|"), l.temperature||"cold",
          ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")
        );

        return {
          statusCode: 200,
          headers: { ...HEADERS, "Content-Type": "text/csv" },
          body: [header, ...rows].join("\n"),
        };
      }

      // ── Get duplicates list ───────────────────────────────────────────────
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
        return ok({
          duplicates: data || [],
          total: count || 0,
          page: pg,
          pageSize: ps,
          totalPages: Math.ceil((count || 0) / ps),
        });
      }

      // ── Get duplicate stats ───────────────────────────────────────────────
      case "getDuplicateStats": {
        const { count: total } = await supabase
          .from("lead_duplicates")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId);

        const { count: pending } = await supabase
          .from("lead_duplicates")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("reviewed", false);

        return ok({
          total:    total   || 0,
          pending:  pending || 0,
          reviewed: (total || 0) - (pending || 0),
        });
      }

      // ── Delete single duplicate ───────────────────────────────────────────
      case "deleteDuplicate": {
        const { dupId } = body;
        if (!dupId) throw new Error("dupId required");
        const { error } = await supabase
          .from("lead_duplicates")
          .delete()
          .eq("id", dupId)
          .eq("user_id", userId);
        if (error) throw error;
        return ok({ deleted: true });
      }

      // ── Delete ALL duplicates ─────────────────────────────────────────────
      case "deleteAllDuplicates": {
        const { count: totalBefore } = await supabase
          .from("lead_duplicates")
          .select("*", { count: "exact", head: true })
          .eq("user_id", userId);

        const { error } = await supabase
          .from("lead_duplicates")
          .delete()
          .eq("user_id", userId);

        if (error) throw error;
        return ok({ deleted: totalBefore || 0 });
      }

      // ── Keep duplicate — move to own leads ────────────────────────────────
      case "keepDuplicate": {
        const { dupId } = body;
        const { data: dup, error: fetchErr } = await supabase
          .from("lead_duplicates")
          .select("*")
          .eq("id", dupId)
          .eq("user_id", userId)
          .single();
        if (fetchErr) throw fetchErr;

        await supabase.from("leads").insert({
          user_id:     userId,
          pool:        "own",
          email:       dup.email,
          first_name:  dup.first_name,
          last_name:   dup.last_name,
          phone:       dup.phone,
          postcode:    dup.postcode,
          state:       dup.state,
          country:     dup.country,
          temperature: "cold",
          status:      "active",
          tags:        ["kept-from-duplicates"],
        });

        await supabase
          .from("lead_duplicates")
          .update({ reviewed: true, action: "kept" })
          .eq("id", dupId);

        return ok({ kept: true });
      }

      default:
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Unknown action: " + action }) };
    }

  } catch (err) {
    console.error("[manageLead]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

function ok(data) {
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) };
}
