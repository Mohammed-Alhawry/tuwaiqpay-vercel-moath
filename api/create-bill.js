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
    const { amount, customerName, customerPhone, customerEmail } = req.body;

    // Validate required fields
    if (!amount || !customerName || !customerPhone) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["amount", "customerName", "customerPhone"]
      });
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
  description: "Course payment",
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
    if (process.env.GSHEET_URL) {
      await fetch(process.env.GSHEET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billId: data.billId,
          name: customerName,
          phone: customerPhone,
          email: customerEmail || "",
          amount: data.amount,
          payment_link: data.link,
          processed: false,
          transactionId: "",
          paidAt: ""
        })
      });
    }

    // ===== 4) RETURN PAYMENT LINK =====
    return res.status(200).json({
      success: true,
      data: {
        billId: data.billId,
        link: data.link
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
