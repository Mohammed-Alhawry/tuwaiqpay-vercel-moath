// /api/webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    try {
      console.log("🔥 WEBHOOK RAW (preview):", JSON.stringify(req.body ? req.body : "<no-body>").slice(0, 2000));
    } catch (e) { /* ignore */ }

    const payload = req.body || {};

    // small helpers ---------------------------------------------------------
    const stripBidi = (s) => {
      if (!s && s !== 0) return "";
      return String(s).replace(/[\u202A-\u202E]/g, "").trim();
    };

    // parse many shapes into a Date (UTC) or return null
    const parseToDate = (v) => {
      if (!v && v !== 0) return null;

      // If array like [Y,M,D,h,m,s]
      if (Array.isArray(v) && v.length >= 3) {
        const [Y, M, D, h = 0, m = 0, s = 0] = v.map(Number);
        // create as UTC
        return new Date(Date.UTC(Y, M - 1, D, h, m, s));
      }

      // If already a Date
      if (v instanceof Date && !isNaN(v)) return v;

      // Try native parse (covers ISO with TZ)
      try {
        const d = new Date(String(v));
        if (!isNaN(d)) return d;
      } catch (e) { /* fallthrough */ }

      // Match common "YYYY-MM-DD HH:mm(:ss)? (±HH:MM)?" or "YYYY/MM/DD ..." patterns
      const re = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?: *\(?([+\-]?\d{1,2})(?::?(\d{2}))?\)?)?/;
      const m = String(v).match(re);
      if (m) {
        const Y = Number(m[1]), Mo = Number(m[2]), D = Number(m[3]);
        const h = Number(m[4] || 0), mi = Number(m[5] || 0), s = Number(m[6] || 0);
        const tzHour = (typeof m[7] !== "undefined" && m[7] !== "") ? Number(m[7]) : 3; // assume +03 if not provided
        const tzMin = (typeof m[8] !== "undefined" && m[8] !== "") ? Number(m[8]) : 0;
        // Build ISO with explicit offset so Date can parse reliably
        const sign = tzHour >= 0 ? "+" : "-";
        const iso = `${String(Y).padStart(4,"0")}-${String(Mo).padStart(2,"0")}-${String(D).padStart(2,"0")}T${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}:${String(s).padStart(2,"0")}${sign}${String(Math.abs(tzHour)).padStart(2,"0")}:${String(Math.abs(tzMin)).padStart(2,"0")}`;
        const d = new Date(iso);
        if (!isNaN(d)) return d;
      }

      return null;
    };

    const fmtRiyadh = (dt) => {
      if (!dt || isNaN(dt)) return { full: "", date: "", time: "" };
      // dt is a Date (UTC). Riyadh = UTC + 3
      const rMs = dt.getTime() + 3 * 3600 * 1000;
      const r = new Date(rMs);
      const pad = (n) => String(n).padStart(2, "0");
      const yyyy = r.getUTCFullYear();
      const mm = pad(r.getUTCMonth() + 1);
      const dd = pad(r.getUTCDate());
      const HH = pad(r.getUTCHours());
      const MM = pad(r.getUTCMinutes());
      return {
        full: `${yyyy}-${mm}-${dd} ${HH}:${MM} (+03:00)`,
        date: `${yyyy}-${mm}-${dd}`,
        time: `${HH}:${MM}`
      };
    };

    // --- normalize payload (support nested TuwaiqPay shape) ---
    let billId = null;
    let transactionId = null;
    let merchantTransactionId = null;
    let amount = null;
    let status = null;
    let paymentMethod = null;
    let paidAt = null;

    if (payload.transactionDetails) {
      const t = payload.transactionDetails;
      transactionId = t.transactionId || t.transactionIdDisplay || payload.transactionId || null;
      merchantTransactionId = t.merchantTransactionId || payload.merchantTransactionId || null;

      if (t.bill) {
        billId = t.bill.id || payload.billId || null;
        amount = t.bill.amount ?? payload.amount ?? t.amount ?? null;
        status = t.transactionStatus || payload.status || null;
        paymentMethod = (t.paymentMethod && (t.paymentMethod.code || t.paymentMethod.displayName || t.paymentMethod.nameEn)) || payload.paymentMethod || null;
      } else {
        billId = payload.billId || null;
        amount = payload.amount ?? null;
        status = payload.status || t.transactionStatus || null;
        paymentMethod = payload.paymentMethod || null;
      }

      const paymentDate = t.paymentDate || t.paidAt || payload.paidAt || null;
      if (Array.isArray(paymentDate) && paymentDate.length >= 6) {
        const [Y, M, D, h, m, s] = paymentDate;
        paidAt = new Date(Y, M - 1, D, h, m, s).toISOString();
      } else {
        paidAt = paymentDate || null;
      }
    } else {
      billId = payload.billId || null;
      transactionId = payload.transactionId || payload.txnId || null;
      merchantTransactionId = payload.merchantTransactionId || null;
      amount = payload.amount ?? null;
      status = payload.status || null;
      paymentMethod = (payload.paymentMethod && (payload.paymentMethod.code || payload.paymentMethod)) || null;
      paidAt = payload.paidAt || null;
    }

    if (!billId) {
      console.warn("Webhook received without billId", payload);
      return res.status(200).json({ received: true, note: "no billId" });
    }

    // Determine if this is a consultation (amount === 270)
    const isConsultation = Number(amount) === 270;

    // Choose which sheet URL to use depending on consultation or not
    const GSHEET_URL = process.env.GSHEET_URL;
    const GSHEET_CONSULTATION_URL = process.env.GSHEET_CONSULTATION_URL;
    const selectedSheetUrl = isConsultation ? GSHEET_CONSULTATION_URL : GSHEET_URL;

    // contact fields (from sheet lookup)
    let contactPhone = "", contactEmail = "", contactName = "", contactStatus = "";

    // consultation fields (from sheet lookup)
    let contactConsultationAtUTC = "";
    let contactConsultationAtRiyadh = "";
    let contactConsultationDateRiyadh = "";
    let contactConsultationTimeRiyadh = "";

    if (selectedSheetUrl) {
      try {
        const resp = await fetch(`${selectedSheetUrl}?billId=${encodeURIComponent(billId)}`);
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; console.error("GSHEET doGet returned non-JSON:", text); }

        if (parsed && parsed.success && parsed.record) {
          contactPhone = parsed.record.phone || "";
          contactEmail = parsed.record.email || "";
          contactName  = stripBidi(parsed.record.name || "");
          contactStatus = parsed.record.customerStatus || "";

          // grab consultation fields from sheet record (with snake_case fallbacks)
          contactConsultationAtUTC = parsed.record.consultationAtUTC || parsed.record.consultation_at_utc || "";
          contactConsultationAtRiyadh = parsed.record.consultationAtRiyadh || parsed.record.consultation_at_riyadh || "";
          contactConsultationDateRiyadh = parsed.record.consultationDateRiyadh || parsed.record.consultation_date_riyadh || "";
          contactConsultationTimeRiyadh = parsed.record.consultationTimeRiyadh || parsed.record.consultation_time_riyadh || "";

          console.log("Found sheet record for billId", billId, {
            contactPhone,
            contactEmail,
            contactName,
            contactStatus,
            contactConsultationAtUTC,
            contactConsultationAtRiyadh,
            contactConsultationDateRiyadh,
            contactConsultationTimeRiyadh,
            isConsultation
          });
        } else {
          console.warn("No record found in sheet for billId:", billId, parsed);
        }
      } catch (e) {
        console.error("Error fetching selectedSheetUrl:", e);
      }
    } else {
      console.warn("Selected sheet URL not set in env (GSHEET_URL or GSHEET_CONSULTATION_URL)");
    }

    // --- POST update to sheet (append processed row including customerStatus) ---
    if (selectedSheetUrl) {
      try {
        // Build base body
        const postBody = {
          billId,
          customerStatus: contactStatus || "",
          // prefer cleaned name
          name: stripBidi(contactName || payload.name || ""),
          phone: contactPhone || payload.phone || "",
          email: contactEmail || payload.email || "",
          amount,
          payment_link: "",
          processed: (status === "SUCCESS" || status === "SETTLED" || status === "PAID") ? true : true,
          transactionId: transactionId || merchantTransactionId || "",
          paidAt: paidAt || new Date().toISOString(),
          paymentStatus: status || ""
        };

        // If consultation, build normalized consultation fields (prefer payload, else sheet)
        if (isConsultation) {
          const rawUTC = payload.consultationAtUTC || payload.consultation_at_utc || contactConsultationAtUTC || null;
          const rawRiyadh = payload.consultationAtRiyadh || payload.consultation_at_riyadh || contactConsultationAtRiyadh || null;
          const rawDateR = payload.consultationDateRiyadh || payload.consultation_date_riyadh || contactConsultationDateRiyadh || null;
          const rawTimeR = payload.consultationTimeRiyadh || payload.consultation_time_riyadh || contactConsultationTimeRiyadh || null;

          // parse to Date (UTC)
          const dt = parseToDate(rawUTC) || parseToDate(rawRiyadh) || (rawDateR && rawTimeR ? parseToDate(`${rawDateR} ${rawTimeR}`) : null);

          if (dt) {
            postBody.consultationAtUTC = dt.toISOString();
            const r = fmtRiyadh(dt);
            postBody.consultationAtRiyadh = r.full;
            postBody.consultationDateRiyadh = r.date;
            postBody.consultationTimeRiyadh = r.time;
          } else {
            // fallback: send whatever we have (cleaned)
            postBody.consultationAtUTC = rawUTC || "";
            postBody.consultationAtRiyadh = rawRiyadh || "";
            postBody.consultationDateRiyadh = rawDateR || "";
            postBody.consultationTimeRiyadh = rawTimeR || "";
          }
        }

        await fetch(selectedSheetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(postBody)
        });

        console.log("Wrote row to sheet URL (consultation?)", isConsultation, selectedSheetUrl);
      } catch (e) {
        console.error("Failed to write webhook row to sheet:", e);
      }
    }

    // --- forward to GoHighLevel (include contactStatus) ---
    // Only forward when NOT a consultation
    if (!isConsultation) {
      const ghlBody = {
        billId,
        transactionId,
        merchantTransactionId,
        amount,
        status,
        paymentMethod,
        paidAt,
        contactPhone,
        contactEmail,
        contactName,
        contactStatus
      };

      if (process.env.GHL_WEBHOOK_URL) {
        try {
          const f = await fetch(process.env.GHL_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ghlBody)
          });
          console.log("Forwarded to GHL, status:", f.status);
        } catch (e) {
          console.error("Failed to forward to GHL:", e);
        }
      } else {
        console.warn("GHL_WEBHOOK_URL not set");
      }
    } else {
      console.log("Consultation amount detected (270). Skipping GoHighLevel forwarding.");
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("webhook handler error:", err);
    return res.status(200).json({ received: false, error: String(err) });
  }
}
