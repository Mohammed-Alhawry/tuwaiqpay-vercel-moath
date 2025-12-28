export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });

  try {
    const { amount, customerName, customerPhone, customerEmail } = req.body;

    // Call TuwaiqPay to create bill
    const auth = await fetch("https://onboarding-prod.tuwaiqpay.com.sa/api/v1/auth/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language": "ar" },
      body: JSON.stringify({
        username: process.env.TUWAIQ_USERNAME,
        userNameType: process.env.TUWAIQ_USERNAME_TYPE || "MOBILE",
        password: process.env.TUWAIQ_PASSWORD
      })
    });
    const authJson = await auth.json();
    const token = authJson.data?.access_token;

    if (!token) return res.status(500).json({ error: "Auth failed" });

    const billRes = await fetch("https://onboarding-prod.tuwaiqpay.com.sa/api/v1/integration/bills", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        actionDateInDays: 1,
        amount,
        currencyId: 1,
        supportedPaymentMethods: ["VISA","MASTER","MADA","AMEX","STC_PAY","APPLE_PAY"],
        billItems: [
          {
            description: "Course payment",
            customerName,
            customerMobilePhone: customerPhone,
            includeVat: false,
            continueWithMaxCharge: false
          }
        ]
      })
    });
    const billJson = await billRes.json();

    const data = billJson.data;
    if (!data?.billId) {
      return res.status(500).json({ error: "Bad pay response", billJson });
    }

    // Save to Google Sheet via Apps Script
    await fetch(process.env.GSHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billId: data.billId,
        name: customerName,
        phone: customerPhone,
        email: customerEmail,
        amount: data.amount,
        payment_link: data.link,
        processed: false,
        transactionId: "",
        paidAt: ""
      })
    });

    // Return payment link
    return res.status(200).json({
      success: true,
      data: {
        billId: data.billId,
        link: data.link
      }
    });

  } catch (err) {
    console.error("create-bill error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
