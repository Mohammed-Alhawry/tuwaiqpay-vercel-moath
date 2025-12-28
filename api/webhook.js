export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body;
    const { billId, transactionId, amount, status, paymentMethod, paidAt } = payload;

    // 1. Find the record in the Google Sheet
    const sheetUrl = process.env.GSHEET_URL + "?billId=" + billId;
    // (We’ll just re-append extra info; we don’t need to “find” for simplicity)

    // 2. Update Google Sheet with payment success
    await fetch(process.env.GSHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billId,
        name: "",        // already saved
        phone: "",
        email: "",
        amount,
        payment_link: "",
        processed: true,
        transactionId,
        paidAt
      })
    });

    // 3. Forward to GoHighLevel Workflow
    const ghlBody = {
      billId,
      transactionId,
      amount,
      status,
      paymentMethod,
      paidAt
    };

    if (process.env.GHL_WEBHOOK_URL) {
      await fetch(process.env.GHL_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ghlBody)
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("webhook error:", err);
    // always return 200 so TuwaiqPay doesn’t retry forever
    return res.status(200).json({ received: false });
  }
}
