import crypto from "node:crypto";

const SALESMARTLY_MESSENGER_SEND_URL = "https://webhook.salesmartly.com/messenger/send";

export async function sendSaleSmartlyMessengerMessage({
  recipient_id,
  replyText
}) {
  const token = process.env.SALES_SMARTLY_API_TOKEN;
  if (!token) {
    throw new Error("SALES_SMARTLY_API_TOKEN is not set");
  }
  if (!recipient_id) {
    throw new Error("recipient_id is required for SaleSmartly active send");
  }

  const body = {
    to: recipient_id,
    message_type: "text",
    data: {
      text: replyText
    }
  };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatureOrder = process.env.SALES_SMARTLY_SIGNATURE_ORDER || "alpha";
  const raw = createSaleSmartlySignatureRaw({ token, body, timestamp, signatureOrder });
  const signature = crypto.createHash("md5").update(raw).digest("hex");
  const url = `${SALESMARTLY_MESSENGER_SEND_URL}?signature=${signature}&timestamp=${timestamp}`;

  console.log("SaleSmartly send request URL:", SALESMARTLY_MESSENGER_SEND_URL);
  console.log("SaleSmartly send body format:", process.env.SALES_SMARTLY_SEND_BODY_FORMAT || "official_to_text");
  console.log("SaleSmartly recipient_id:", recipient_id);
  console.log("SaleSmartly timestamp used:", timestamp);
  console.log("SaleSmartly signature order:", signatureOrder);
  console.log("SaleSmartly signature prefix:", signature.slice(0, 6));
  console.log("SaleSmartly signature raw pattern:", signatureOrder === "timestamp_data" ? "token&timestamp=...&data=..." : "token&data=...&timestamp=...");
  console.log("SaleSmartly send query names:", ["signature", "timestamp"]);
  console.log("SaleSmartly send header names:", ["Content-Type"]);
  console.log("SaleSmartly send request body:", JSON.stringify(body, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  console.log("SaleSmartly active send HTTP status:", response.status);
  const responseText = await response.text();
  console.log("SaleSmartly active send response text:", responseText);

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    parsed = undefined;
  }
  console.log("SaleSmartly active send parsed response:", parsed);
  if (parsed?.code === -1 && parsed?.msg === "签名验证不通过") {
    console.error("Signature failed. Check SALES_SMARTLY_API_TOKEN and signature mode.");
  }

  const ok = response.status === 200 && isSaleSmartlySuccess(parsed);

  return {
    ok,
    http_status: response.status,
    response_text: responseText,
    parsed_response: parsed
  };
}

function createSaleSmartlySignatureRaw({ token, body, timestamp, signatureOrder }) {
  const bodyJson = JSON.stringify(body);
  if (signatureOrder === "timestamp_data") {
    return `${token}&timestamp=${timestamp}&data=${bodyJson}`;
  }

  return `${token}&data=${bodyJson}&timestamp=${timestamp}`;
}

function isSaleSmartlySuccess(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.code === 0 || parsed.code === "0") return true;
  if (parsed.success === true) return true;
  if (parsed.msg === "Success" && (parsed.code === undefined || parsed.code === 0 || parsed.code === "0")) return true;
  return false;
}
