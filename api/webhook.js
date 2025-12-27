export default async function handler(req, res) {
  // نسمح فقط بـ POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // هذا هو كل ما أرسله TuwaiqPay
    const payload = req.body;

    // اطبع كل شيء (للفهم والتجربة)
    console.log("===== TuwaiqPay Webhook START =====");
    console.log(JSON.stringify(payload, null, 2));
    console.log("===== TuwaiqPay Webhook END =====");

    /*
      مثال محتمل لما سيصل:
      {
        transactionId,
        merchantTransactionId,
        billId,
        amount,
        status,
        paymentMethod,
        paidAt,
        ...أي حقول إضافية
      }
    */

    // مثال استخدام أهم القيم
    const {
      billId,
      amount,
      status,
      transactionId,
      paymentMethod,
      paidAt
    } = payload;

    if (!billId || !status) {
      console.warn("Webhook received but missing required fields");
    }

    if (status === "SUCCESS") {
      // هنا تعتبر الدفع ناجح
      // todo:
      // - حفظ البيانات في DB
      // - تفعيل اشتراك
      // - إرسال ايميل
      console.log("✅ Payment SUCCESS for bill:", billId);
    } else {
      console.log("❌ Payment NOT successful:", status);
    }

    // مهم جدًا: الرد 200
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Webhook error:", error);
    // حتى لو حصل خطأ، حاول ترجع 200 عشان لا يعيدوا الإرسال
    return res.status(200).json({ received: true });
  }
}
