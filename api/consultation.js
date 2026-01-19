// /api/consultation.js
export default async function handler(req, res) {
  // ===== CORS =====
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Allow only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Safety check for empty body
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: "Empty or invalid JSON body" });
  }

  try {
    const {
      amount,
      customerName,
      customerPhone,
      customerEmail,
      customerStatus,
      consultationAt // expecting ISO string (UTC) from client
    } = req.body;

    // Validate required fields
    if (!amount || !customerName || !customerPhone) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["amount", "customerName", "customerPhone"]
      });
    }

    // Validate consultationAt if provided
    let consultationDateUTC = null;
    let riyadhReadable = "";
    let consultationDateOnly = "";
    let consultationTimeOnly = "";
    if (consultationAt) {
      const parsed = Date.parse(consultationAt);
      if (isNaN(parsed)) {
        return res.status(400).json({ error: "Invalid consultationAt (not a valid ISO timestamp)" });
      }

      consultationDateUTC = new Date(parsed);

      // Must be in the future
      if (consultationDateUTC.getTime() <= Date.now()) {
        return res.status(400).json({ error: "consultationAt must be a future date/time" });
      }

      // Convert to Riyadh time by adding +3 hours (Asia/Riyadh = UTC+3, no DST)
      const riyadhMillis = consultationDateUTC.getTime() + (3 * 60 * 60 * 1000);
      const riyadhDate = new Date(riyadhMillis);

      // Determine day-of-week in Riyadh (0=Sun ... 5=Fri, 6=Sat)
      const riyadhDay = riyadhDate.getUTCDay();
      if (riyadhDay === 5 || riyadhDay === 6) {
        return res.status(400).json({ error: "Selected consultation date falls on Friday or Saturday (not allowed) — use Sunday–Thursday" });
      }

      // Prepare a readable Riyadh timestamp "YYYY-MM-DD HH:MM"
      const pad = (n) => String(n).padStart(2, "0");
      const year = riyadhDate.getUTCFullYear();
      const month = pad(riyadhDate.getUTCMonth() + 1);
      const day = pad(riyadhDate.getUTCDate());
      const hours = pad(riyadhDate.getUTCHours());
      const minutes = pad(riyadhDate.getUTCMinutes());

      riyadhReadable = `${year}-${month}-${day} ${hours}:${minutes} (+03:00)`;

      // separate date & time fields (useful for Google Sheets parsing or filters)
      consultationDateOnly = `${year}-${month}-${day}`; // YYYY-MM-DD (Riyadh)
      consultationTimeOnly = `${hours}:${minutes}`; // HH:MM (Riyadh)
    }

    // ===== 1) AUTH WITH TUWAIQPAY =====
    const authRes = await fetch(
      "https://onboarding-prod.tuwaiqpay.com.sa/api/v1/auth/authenticate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Language": "ar"
        },
        body: JSON.stringify({
          username: process.env.TUWAIQ_USERNAME,
          userNameType: process.env.TUWAIQ_USERNAME_TYPE || "MOBILE",
          password: process.env.TUWAIQ_PASSWORD
        })
      }
    );

    const authText = await authRes.text();
    let authJson;
    try {
      authJson = JSON.parse(authText);
    } catch (e) {
      console.error("Auth response not JSON:", authText);
      return res.status(500).json({
        error: "Auth response is not JSON",
        response: authText
      });
    }

    const token = authJson?.data?.access_token;
    if (!token) {
      console.error("Auth failed:", authJson);
      return res.status(500).json({
        error: "Auth failed with TuwaiqPay",
        response: authJson
      });
    }

    // ===== 2) CREATE BILL =====
    const billRes = await fetch(
      "https://onboarding-prod.tuwaiqpay.com.sa/api/v1/integration/bills",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          actionDateInDays: 1,
          amount: Number(amount),
          currencyId: 1,
          supportedPaymentMethods: [
            "VISA",
            "MASTER",
            "MADA",
            "AMEX",
            "STC_PAY",
            "APPLE_PAY"
          ],
          description: "Consultation booking",
          customerName: customerName,
          customerMobilePhone: customerPhone,
          includeVat: false,
          continueWithMaxCharge: false
        })
      }
    );

    const billText = await billRes.text();
    let billJson;
    try {
      billJson = JSON.parse(billText);
    } catch (e) {
      console.error("Create bill response not JSON:", billText);
      return res.status(500).json({
        error: "Create bill response is not JSON",
        response: billText
      });
    }

    const data = billJson?.data;
    if (!data?.billId || !data?.link) {
      console.error("Create bill failed:", billJson);
      return res.status(500).json({
        error: "Failed to create bill",
        response: billJson
      });
    }

    // ===== 3) SAVE TO GOOGLE SHEETS (OPTIONAL) =====
    // NOTE: Make sure you set env var GSHEET_CONSULTATION_URL to your Apps Script / webhook URL
    if (process.env.GSHEET_CONSULTATION_URL) {
      try {
     const sheetPayload = {
  billId: data.billId,
  customerStatus: customerStatus || "",
  name: customerName,
  phone: customerPhone,
  email: customerEmail || "",
  amount: data.amount,
  payment_link: data.link,
  processed: false,
  transactionId: "",
  paidAt: "",
  paymentStatus: "",
  // always present (null when not provided)
  consultationAtUTC: consultationDateUTC ? consultationDateUTC.toISOString() : null,
  consultationAtRiyadh: consultationDateUTC ? riyadhReadable : null,
  consultationDateRiyadh: consultationDateUTC ? consultationDateOnly : null,
  consultationTimeRiyadh: consultationDateUTC ? consultationTimeOnly : null
};


        // add consultation fields if present
        if (consultationDateUTC) {
          sheetPayload.consultationAtUTC = consultationDateUTC.toISOString(); // UTC ISO string
          sheetPayload.consultationAtRiyadh = riyadhReadable; // human-friendly Riyadh time
          sheetPayload.consultationDateRiyadh = consultationDateOnly; // YYYY-MM-DD
          sheetPayload.consultationTimeRiyadh = consultationTimeOnly; // HH:MM
        }

        await fetch(process.env.GSHEET_CONSULTATION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sheetPayload)
        });
      } catch (e) {
        console.error("Failed to write consultation to sheet:", e);
      }
    }

    // ===== 4) RETURN PAYMENT LINK =====
    return res.status(200).json({
      success: true,
      data: {
        billId: data.billId,
        link: data.link,
        consultationAtUTC: consultationDateUTC ? consultationDateUTC.toISOString() : null,
        consultationAtRiyadh: riyadhReadable || null,
        consultationDateRiyadh: consultationDateOnly || null,
        consultationTimeRiyadh: consultationTimeOnly || null
      }
    });

  } catch (err) {
    console.error("create-bill error:", err);
    return res.status(500).json({
      error: "Server error",
      details: String(err)
    });
  }
}
