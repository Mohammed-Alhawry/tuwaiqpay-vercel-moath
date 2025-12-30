// /api/webhook.js

export default async function handler(req, res) {
  

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body || {};
    const { billId, transactionId, amount, status, paymentMethod, paidAt } = payload;

    if (!billId) {
      console.warn("Webhook received without billId", payload);
      return res.status(200).json({ received: true, note: "no billId" });
    }

    const GSHEET_URL = process.env.GSHEET_URL;
    let contactPhone = "";
    let contactEmail = "";
    let contactName = "";

    // ----- 1) Query Google Sheet (doGet) to get contact info for this billId -----
    if (GSHEET_URL) {
      try {
        const resp = await fetch(`${GSHEET_URL}?billId=${encodeURIComponent(billId)}`);
        const text = await resp.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          console.error("GSHEET doGet returned non-JSON:", text);
        }
        if (parsed && parsed.success && parsed.record) {
          contactPhone = parsed.record.phone || "";
          contactEmail = parsed.record.email || "";
          contactName  = parsed.record.name  || "";
          console.log("Found sheet record for billId", billId, { contactPhone, contactEmail, contactName });
        } else {
          console.warn("No record found in sheet for billId:", billId, parsed);
        }
      } catch (e) {
        console.error("Error fetching GSHEET_URL:", e);
      }
    } else {
      console.warn("GSHEET_URL not set in environment");
    }

    // ----- 2) Update sheet (append processed row) - optional but useful for logs -----
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
            payment_link: "",
            processed: true,
            transactionId,
            paidAt
          })
        });
      } catch (e) {
        console.error("Failed to update sheet processed:", e);
      }
    }

    // ----- 3) Forward to GoHighLevel (include contact fields so GHL can find contact) -----
    const ghlBody = {
      billId,
      transactionId,
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

    // Return 200 to TuwaiqPay (so it won't retry)
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("webhook handler error:", err);
    // Always return 200 to avoid retries, but indicate failure in body
    return res.status(200).json({ received: false, error: String(err) });
  }
}
