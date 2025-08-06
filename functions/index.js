const functions = require("firebase-functions");
const admin = require("firebase-admin");
const mercadopago = require("mercadopago");

admin.initializeApp();
const db = admin.firestore();

// Configura o Mercado Pago com o Access Token guardado de forma segura
mercadopago.configure({
  access_token: functions.config().mercadopago.token,
});

// Função que o site vai chamar para criar uma cobrança PIX
exports.createPixPayment = functions.https.onCall(async (data, context) => {
  // Verifica se o usuário está logado para associar a doação
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "Você precisa estar logado para fazer uma doação.",
    );
  }

  const amount = data.amount;
  const userId = context.auth.uid;
  const userEmail = context.auth.token.email;
  const userName = context.auth.token.name;

  if (!(amount > 0)) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "O valor da doação deve ser maior que zero.",
    );
  }

  const paymentData = {
    transaction_amount: amount,
    description: "Doação para Animus ONG",
    payment_method_id: "pix",
    payer: {
      email: userEmail,
    },
    // Este campo é crucial! Ele liga o pagamento ao usuário.
    external_reference: userId,
    // URL que o Mercado Pago vai chamar quando o pagamento for aprovado
    notification_url:
      `https://us-central1-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/paymentWebhook`,
  };

  try {
    const result = await mercadopago.payment.create(paymentData);
    const pixData = result.body.point_of_interaction.transaction_data;

    return {
      paymentId: result.body.id,
      qrCode: pixData.qr_code,
      qrCodeBase64: pixData.qr_code_base64,
    };
  } catch (error) {
    console.error("Erro ao criar pagamento no Mercado Pago:", error);
    throw new functions.https.HttpsError(
        "internal",
        "Não foi possível gerar o PIX. Tente novamente.",
    );
  }
});

// Função que o Mercado Pago vai chamar (Webhook)
exports.paymentWebhook = functions.https.onRequest(async (req, res) => {
  const {query} = req;

  if (query.topic === "payment" || query.type === "payment") {
    try {
      const paymentId = query.id || query["data.id"];
      const payment = await mercadopago.payment.get(paymentId);

      if (payment.body.status === "approved") {
        const userId = payment.body.external_reference;
        const amount = payment.body.transaction_amount;
        const payerEmail = payment.body.payer.email;

        // Precisamos dos dados do usuário para salvar no ranking
        const user = await admin.auth().getUser(userId);

        const donationData = {
          userId: userId,
          userName: user.displayName || "Doador Anônimo",
          userPhoto: user.photoURL || "https://via.placeholder.com/50",
          amount: amount,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          status: "verified", // Aprovado automaticamente!
          paymentId: paymentId,
          payerEmail: payerEmail,
        };
        // Salva a doação verificada na coleção
        await db.collection("donations").add(donationData);
        console.log(`Doação de ${amount} para ${userId} verificada e salva!`);
      }
    } catch (error) {
      console.error("Erro no webhook do Mercado Pago:", error);
    }
  }
  res.status(200).send("OK");
});
