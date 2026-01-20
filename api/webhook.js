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
          contactName  = parsed.record.name || "";
          contactStatus = parsed.record.customerStatus || "";

          // <-- NEW: grab consultation fields from sheet record (with snake_case fallbacks)
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
          name: contactName || "",
          phone: contactPhone || "",
          email: contactEmail || "",
          amount,
          payment_link: "",
          processed: (status === "SUCCESS" || status === "SETTLED" || status === "PAID") ? true : true,
          transactionId: transactionId || merchantTransactionId || "",
          paidAt: paidAt || new Date().toISOString(),
          paymentStatus: status || ""
        };

        // If consultation, include the extra consultation fields (payload preferred, otherwise use sheet values)
        if (isConsultation) {
          postBody.consultationAtUTC = payload.consultationAtUTC || payload.consultation_at_utc || contactConsultationAtUTC || "";
          postBody.consultationAtRiyadh = payload.consultationAtRiyadh || payload.consultation_at_riyadh || contactConsultationAtRiyadh || "";
          postBody.consultationDateRiyadh = payload.consultationDateRiyadh || payload.consultation_date_riyadh || contactConsultationDateRiyadh || "";
          postBody.consultationTimeRiyadh = payload.consultationTimeRiyadh || payload.consultation_time_riyadh || contactConsultationTimeRiyadh || "";
        }

        await fetch(selectedSheetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(postBody)
        });
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
