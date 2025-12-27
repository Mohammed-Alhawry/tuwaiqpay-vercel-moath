export default async function handler(req, res) {
  // ✅ CORS HEADERS (REQUIRED)
  res.setHeader("Access-Control-Allow-Origin", "https://app.emsprofitai.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Origin", "*");


  // ✅ Handle preflight (browser check)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      amount,
      customerName,
      customerPhone,
      customerEmail,
      customerStatus
    } = req.body;

    // --- AUTH ---
    const authResp = await fetch(
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

    const authJson = await authResp.json();
    const token = authJson?.data?.access_token;

    if (!token) {
      return res.status(500).json({ error: "Auth failed", authJson });
    }

    // --- CREATE BILL ---
    const billResp = await fetch(
      "https://onboarding-prod.tuwaiqpay.com.sa/api/v1/integration/bills",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          actionDateInDays: 1,
          amount,
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
          customerName,
          customerMobilePhone: customerPhone,
          includeVat: false,
          continueWithMaxCharge: false
        })
      }
    );

    const billJson = await billResp.json();

    return res.status(200).json({
      success: true,
      data: billJson.data
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      details: err.message
    });
  }
}
