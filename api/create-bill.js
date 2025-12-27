// api/create-bill.js
export default async function handler(req, res) {
  return res.status(200).json({ where: "THIS IS VERCEL FILE" });

  // Allow CORS from your GHL domain or everyone (for testing)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { amount, customerName, customerPhone } = req.body;

    // Authenticate (simple: request token every call)
    const authResp = await fetch("https://onboarding-prod.tuwaiqpay.com.sa/api/v1/auth/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language": "ar" },
      body: JSON.stringify({
        username: process.env.TUWAIQ_USERNAME,
        userNameType: process.env.TUWAIQ_USERNAME_TYPE || "MOBILE",
        password: process.env.TUWAIQ_PASSWORD
      })
    });
    const authJson = await authResp.json();
    const token = authJson?.data?.access_token;
    if (!token) return res.status(500).json({ error: "Auth failed", details: authJson });

    // Create bill
    const billRes = await fetch("https://onboarding-prod.tuwaiqpay.com.sa/api/v1/integration/bills", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        actionDateInDays: 1,
        amount,
        currencyId: 1,
        supportedPaymentMethods: ["VISA","MASTER","MADA","AMEX","STC_PAY","APPLE_PAY"],
        description: "Website payment",
        customerName,
        customerMobilePhone: customerPhone,
        includeVat: false,
        continueWithMaxCharge: false
      })
    });
    const billJson = await billRes.json();

    // return the payment link to the frontend
    return res.status(200).json({ success: true, data: billJson.data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
