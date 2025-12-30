// /api/webhook.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // quick debug — trimmed to avoid huge logs
  try {
    console.log("🔥 WEBHOOK RAW (preview):", JSON.stringify(req.body ? req.body : "<no-body>").slice(0, 2000));
  } catch (e) { /* ignore logging errors */ }

  try {
    const payload = req.body || {};

    // --- normalize (support both flat and nested shapes) ---
    let billId, transactionId, amount, status, paymentMethod, paidAt, merchantTransactionId;

    if (payload.transactionDetails) {
      const t = payload.transactionDetails;
      // transaction id
      transactionId = t.transactionId || t.transactionIdDisplay || payload.transactionId || null;
      merchantTransactionId = t.merchantTransactionId || payload.merchantTransactionId || null;

      // bill inside transactionDetails
      if (t.bill) {
        billId = t.bill.id || t.billId || payload.billId || null;
        amount = t.bill.amount ?? payload.amount ?? t.amount ?? null;
        // sometimes status is on transactionDetails
        status = t.transactionStatus || payload.status || null;
        // payment method may be an object
        paymentMethod = (t.paymentMethod && (t.paymentMethod.code || t.paymentMethod.displayName || t.paymentMethod.nameEn)) || payload.paymentMethod || null;
      } else {
        // fallback
        billId = payload.billId || null;
        amount = payload.amount || null;
        status = payload.status || t.transactionStatus || null;
        paymentMethod = payload.paymentMethod || null;
      }

      // paidAt may be an array [YYYY,MM,DD,hh,mm,ss,...] or string
      const paymentDate = t.paymentDate || t.paidAt || payload.paidAt || null;
      if (Array.isArray(paymentDate) && paymentDate.length >= 6) {
        // JS Date month is 0-based
        const [Y, M, D, h, m, s] = paymentDate;
        paidAt = new Date(Y, M - 1, D, h, m, s).toISOString();
      } else {
        paidAt = paymentDate || null;
      }
    } else {
      // flat payload
      billId = payload.billId || null;
      transactionId = payload.transactionId || payload.txnId || null;
      merchantTransactionId = payload.merchantTransactionId || null;
      amount = payload.amount ?? null;
      status = payload.status || null;
      paymentMethod = (payload.paymentMethod && (payload.paymentMethod.code || payload.paymentMethod)) || null;
      paidAt = payload.paidAt || null;
    }

    // If still no billId — log full payload and return 200 (no retry)
    if (!billId) {
      console.warn("Webhook received without billId", payload);
      return res.status(200).json({ received: true, note: "no billId" });
    }

    // --- optional: try to read contact info from the sheet (doGet) ---
    const GSHEET_URL = process.env.GSHEET_URL;
    let contactPhone = "", contactEmail = "", contactName = "";

    if (GSHEET_URL) {
      try {
        const resp = await fetch(`${GSHEET_URL}?billId=${encodeURIComponent(billId)}`);
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) {
          console.error("GSHEET doGet returned non-JSON:", text);
        }
        if (parsed && parsed.success && parsed.record) {
          contactPhone = parsed.record.phone || "";
          contactEmail = parsed.record.email || "";
          contactName  = parsed.record.name || "";
          console.log("Found sheet record for billId", billId, { contactPhone, contactEmail, contactName });
        } else {
          console.warn("No record found in sheet for billId:", billId, parsed);
        }
      } catch (e) {
        console.error("Error fetching GSHEET_URL:", e);
      }
    } else {
      console.warn("GSHEET_URL not set in env");
    }

    // --- POST to sheet (your current behavior: append processed row) ---
    if (GSHEET_URL) {
      try {
        await fetch(GSHEET_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billId,
            name: contactName || "",
            phone: contactPhone || "",
            email: contactEmail || "",
            amount,
            payment_link: "",    // not used on webhook update
            processed: (status === "SUCCESS" || status === "SETTLED" || status === "PAID") ? true : true, // treat as processed for settled/success
            transactionId: transactionId || merchantTransactionId || "",
            paidAt: paidAt || new Date().toISOString()
          })
        });
      } catch (e) {
        console.error("Failed to update sheet processed:", e);
      }
    }

    // --- forward to GoHighLevel (if configured) ---
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
      contactName
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

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("webhook handler error:", err);
    return res.status(200).json({ received: false, error: String(err) });
  }
}
