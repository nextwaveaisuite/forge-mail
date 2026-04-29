// functions/importLeads.js
// Parses CSV upload, validates leads, bulk inserts into Supabase
// Supports batch sizes: 100, 250, 350, 500, 1000

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MAX_BATCH_SIZE = 1000;

// Common CSV column name mappings
const FIELD_MAP = {
  email:      ["email", "email address", "e-mail", "emailaddress", "mail"],
  first_name: ["first name", "firstname", "first", "fname", "given name"],
  last_name:  ["last name", "lastname", "last", "lname", "surname", "family name"],
  phone:      ["phone", "phone number", "phonenumber", "telephone", "mobile", "cell"],
  postcode:   ["postcode", "post code", "zip", "zip code", "postal code", "postalcode"],
  state:      ["state", "province", "region"],
  country:    ["country", "country code", "nation"],
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: "Method not allowed" };

  try {
    const {
      csvData,       // raw CSV string
      userId,
      pool,          // 'mlgs' or 'own'
      batchName,
      batchSize,     // 100 | 250 | 350 | 500 | 1000
      tags,          // array of tag strings
      niche,
      notes,
      startRow,      // for pagination through large files
    } = JSON.parse(event.body || "{}");

    if (!csvData)  throw new Error("csvData is required");
    if (!userId)   throw new Error("userId is required");
    if (!pool)     throw new Error("pool is required (mlgs or own)");

    const limit = Math.min(batchSize || 100, MAX_BATCH_SIZE);
    const offset = startRow || 0;

    // ── Parse CSV ────────────────────────────────────────────────────────────
    const lines = csvData.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("CSV must have a header row and at least one lead");

    // Detect delimiter (comma or tab)
    const delim = lines[0].includes("\t") ? "\t" : ",";

    // Parse header row
    const rawHeaders = parseCSVLine(lines[0], delim).map(h =>
      h.toLowerCase().trim().replace(/['"]/g, "")
    );

    // Map headers to our field names
    const colMap = {};
    rawHeaders.forEach((h, i) => {
      Object.entries(FIELD_MAP).forEach(([field, aliases]) => {
        if (aliases.includes(h)) colMap[field] = i;
      });
    });

    if (colMap.email === undefined) {
      throw new Error(`No email column found. Headers detected: ${rawHeaders.join(", ")}`);
    }

    // Parse data rows (with offset and limit for batch processing)
    const dataLines = lines.slice(1); // skip header
    const batch = dataLines.slice(offset, offset + limit);
    const totalRows = dataLines.length;

    const leads = [];
    const skipped = [];

    batch.forEach((line, i) => {
      const cols = parseCSVLine(line, delim);
      const email = (cols[colMap.email] || "").trim().toLowerCase().replace(/['"]/g, "");

      if (!isValidEmail(email)) {
        skipped.push({ row: offset + i + 2, reason: "Invalid email", value: email });
        return;
      }

      leads.push({
        user_id:    userId,
        pool,
        email,
        first_name: getCol(cols, colMap.first_name),
        last_name:  getCol(cols, colMap.last_name),
        phone:      getCol(cols, colMap.phone),
        postcode:   getCol(cols, colMap.postcode),
        state:      getCol(cols, colMap.state),
        country:    getCol(cols, colMap.country),
        tags:       tags || [],
        batch_id:   null, // set after batch record created
      });
    });

    if (!leads.length) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          inserted: 0,
          skipped: skipped.length,
          skippedDetails: skipped,
          totalRows,
          message: "No valid leads found in this batch",
        }),
      };
    }

    // ── Create batch record ───────────────────────────────────────────────────
    const { data: batchRecord, error: batchErr } = await supabase
      .from("lead_batches")
      .insert({
        user_id:    userId,
        name:       batchName || `${pool.toUpperCase()} Batch — ${new Date().toLocaleDateString()}`,
        pool,
        lead_count: leads.length,
        tags:       tags || [],
        niche:      niche || null,
        notes:      notes || null,
      })
      .select("id")
      .single();

    if (batchErr) throw batchErr;

    // Attach batch_id to all leads
    const leadsWithBatch = leads.map(l => ({ ...l, batch_id: batchRecord.id }));

    // ── Bulk insert in chunks of 500 ─────────────────────────────────────────
    let inserted = 0;
    const chunkSize = 500;

    for (let i = 0; i < leadsWithBatch.length; i += chunkSize) {
      const chunk = leadsWithBatch.slice(i, i + chunkSize);
      const { error: insertErr } = await supabase
        .from("leads")
        .insert(chunk);

      if (insertErr) {
        console.error("[importLeads] Chunk insert error:", insertErr);
      } else {
        inserted += chunk.length;
      }
    }

    // Update batch lead_count with actual inserted
    await supabase
      .from("lead_batches")
      .update({ lead_count: inserted })
      .eq("id", batchRecord.id);

    const hasMore = offset + limit < totalRows;

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        inserted,
        skipped: skipped.length,
        skippedDetails: skipped.slice(0, 10), // first 10 skipped rows
        batchId: batchRecord.id,
        totalRows,
        processedRows: offset + batch.length,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
        message: `Imported ${inserted} leads${skipped.length ? `, skipped ${skipped.length} invalid rows` : ""}`,
      }),
    };

  } catch (err) {
    console.error("[importLeads]", err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseCSVLine(line, delim = ",") {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delim && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function getCol(cols, idx) {
  if (idx === undefined) return null;
  const val = (cols[idx] || "").trim().replace(/^["']|["']$/g, "");
  return val || null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
