// functions/importLeads.js
// CSV parser + bulk insert with full duplicate detection
// Duplicates are flagged, stored in duplicates table, never imported

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

const MAX_BATCH = 1000;

// Column name mappings for auto-detection
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
      csvData,
      userId,
      pool,
      batchName,
      batchSize,
      tags,
      niche,
      notes,
      startRow,
    } = JSON.parse(event.body || "{}");

    if (!csvData)  throw new Error("csvData is required");
    if (!userId)   throw new Error("userId is required");
    if (!pool)     throw new Error("pool is required");

    const limit  = Math.min(batchSize || 500, MAX_BATCH);
    const offset = startRow || 0;

    // ── Parse CSV ─────────────────────────────────────────────────────
    const lines = csvData.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error("CSV needs a header row and at least one lead");

    const delim = lines[0].includes("\t") ? "\t" : ",";
    const rawHeaders = parseCSVLine(lines[0], delim).map(h =>
      h.toLowerCase().trim().replace(/['"]/g, "")
    );

    // Map headers to field names
    const colMap = {};
    rawHeaders.forEach((h, i) => {
      Object.entries(FIELD_MAP).forEach(([field, aliases]) => {
        if (aliases.includes(h)) colMap[field] = i;
      });
    });

    if (colMap.email === undefined) {
      throw new Error(`No email column found. Headers detected: ${rawHeaders.join(", ")}`);
    }

    // Get batch of rows to process
    const dataLines = lines.slice(1);
    const batchRows = dataLines.slice(offset, offset + limit);
    const totalRows = dataLines.length;

    // ── Extract and validate emails from this batch ───────────────────
    const parsed   = [];
    const skipped  = [];

    batchRows.forEach((line, i) => {
      const cols  = parseCSVLine(line, delim);
      const email = (cols[colMap.email] || "").trim().toLowerCase().replace(/['"]/g, "");

      if (!isValidEmail(email)) {
        skipped.push({ row: offset + i + 2, reason: "Invalid email", value: email || "(empty)" });
        return;
      }

      parsed.push({
        email,
        first_name: getCol(cols, colMap.first_name),
        last_name:  getCol(cols, colMap.last_name),
        phone:      getCol(cols, colMap.phone),
        postcode:   getCol(cols, colMap.postcode),
        state:      getCol(cols, colMap.state),
        country:    getCol(cols, colMap.country),
      });
    });

    if (!parsed.length) {
      return ok({
        inserted: 0, duplicates: 0, skipped: skipped.length,
        skippedDetails: skipped,
        totalRows, processedRows: offset + batchRows.length,
        hasMore: offset + limit < totalRows,
        nextOffset: offset + limit < totalRows ? offset + limit : null,
        message: "No valid emails found in this batch",
      });
    }

    // ── Check for duplicates against existing leads ───────────────────
    const emails = parsed.map(p => p.email);

    // Fetch existing emails in chunks of 500 to avoid URL length limits
    const existingEmails = new Set();
    const chunkSize = 500;

    for (let i = 0; i < emails.length; i += chunkSize) {
      const chunk = emails.slice(i, i + chunkSize);
      const { data: existing } = await supabase
        .from("leads")
        .select("email")
        .eq("user_id", userId)
        .in("email", chunk);

      (existing || []).forEach(r => existingEmails.add(r.email));
    }

    // Split into new leads and duplicates
    const newLeads   = [];
    const duplicates = [];

    parsed.forEach(lead => {
      if (existingEmails.has(lead.email)) {
        duplicates.push(lead);
      } else {
        newLeads.push(lead);
      }
    });

    // ── Create batch record ───────────────────────────────────────────
    let batchId = null;

    if (newLeads.length > 0) {
      const { data: batchRecord, error: batchErr } = await supabase
        .from("lead_batches")
        .insert({
          user_id:    userId,
          name:       batchName || `${pool.toUpperCase()} Import — ${new Date().toLocaleDateString()}`,
          pool,
          lead_count: 0, // updated after insert
          tags:       tags || [],
          niche:      niche || null,
          notes:      notes || null,
        })
        .select("id")
        .single();

      if (batchErr) throw batchErr;
      batchId = batchRecord.id;
    }

    // ── Insert new leads ──────────────────────────────────────────────
    let inserted = 0;

    if (newLeads.length > 0) {
      const leadsToInsert = newLeads.map(l => ({
        user_id:    userId,
        batch_id:   batchId,
        pool,
        email:      l.email,
        first_name: l.first_name,
        last_name:  l.last_name,
        phone:      l.phone,
        postcode:   l.postcode,
        state:      l.state,
        country:    l.country,
        tags:       tags || [],
        temperature: "cold",
        status:     "active",
      }));

      for (let i = 0; i < leadsToInsert.length; i += chunkSize) {
        const chunk = leadsToInsert.slice(i, i + chunkSize);
        const { error: insertErr, data: insertedData } = await supabase
          .from("leads")
          .insert(chunk)
          .select("id");

        if (insertErr) {
          console.error("[importLeads] Insert error:", insertErr.message);
        } else {
          inserted += (insertedData || chunk).length;
        }
      }

      // Update batch lead count
      await supabase
        .from("lead_batches")
        .update({ lead_count: inserted })
        .eq("id", batchId);
    }

    // ── Store duplicates in duplicates table ──────────────────────────
    let storedDuplicates = 0;

    if (duplicates.length > 0) {
      const dupRecords = duplicates.map(d => ({
        user_id:        userId,
        email:          d.email,
        first_name:     d.first_name,
        last_name:      d.last_name,
        phone:          d.phone,
        postcode:       d.postcode,
        state:          d.state,
        country:        d.country,
        source_file:    batchName || "Unknown batch",
        detected_at:    new Date().toISOString(),
      }));

      for (let i = 0; i < dupRecords.length; i += chunkSize) {
        const chunk = dupRecords.slice(i, i + chunkSize);
        const { error: dupErr } = await supabase
          .from("lead_duplicates")
          .insert(chunk);

        if (!dupErr) storedDuplicates += chunk.length;
      }
    }

    const hasMore      = offset + limit < totalRows;
    const nextOffset   = hasMore ? offset + limit : null;
    const processedRows = offset + batchRows.length;

    return ok({
      inserted,
      duplicates:      storedDuplicates,
      duplicateEmails: duplicates.slice(0, 5).map(d => d.email), // preview first 5
      skipped:         skipped.length,
      skippedDetails:  skipped.slice(0, 10),
      batchId,
      totalRows,
      processedRows,
      hasMore,
      nextOffset,
      message: buildMessage(inserted, storedDuplicates, skipped.length),
    });

  } catch (err) {
    console.error("[importLeads]", err);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMessage(inserted, dupes, skipped) {
  const parts = [];
  if (inserted)  parts.push(`✅ ${inserted} imported`);
  if (dupes)     parts.push(`⚠️ ${dupes} duplicates detected`);
  if (skipped)   parts.push(`❌ ${skipped} invalid`);
  return parts.join(" · ");
}

function parseCSVLine(line, delim = ",") {
  const result = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === delim && !inQuotes) {
      result.push(current.trim()); current = "";
    } else { current += char; }
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

function ok(data) {
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(data) };
}
