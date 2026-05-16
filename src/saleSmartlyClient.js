import crypto from "node:crypto";

const SALESMARTLY_MESSENGER_SEND_URL = "https://webhook.salesmartly.com/messenger/send";

export async function sendSaleSmartlyMessengerMessage({
  chat_user_id,
  chat_session_id,
  channel,
  replyText
}) {
  const token = process.env.SALES_SMARTLY_API_TOKEN;
  if (!token) {
    throw new Error("SALES_SMARTLY_API_TOKEN is not set");
  }

  const timestamp = String(Date.now());
  const signature = createSaleSmartlySignature(token, { timestamp });
  const url = new URL(SALESMARTLY_MESSENGER_SEND_URL);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("signature", signature);

  const body = {
    data: {
      msg_type: 3,
      msg: {
        template1: {
          text: replyText
        }
      },
      chat_user_id,
      chat_session_id: String(chat_session_id),
      send_time: String(Date.now()),
      channel: channel || 1,
      tag: "CONFIRMED_EVENT_UPDATE"
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "external-sign": signature
    },
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { raw: responseText };
  }

  if (!response.ok) {
    throw new Error(`SaleSmartly active send failed: ${response.status} ${responseText}`);
  }

  return responseBody;
}

export function createSaleSmartlySignature(token, params) {
  const sortedParams = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const signatureBase = sortedParams ? `${token}&${sortedParams}` : token;
  return crypto.createHash("md5").update(signatureBase).digest("hex");
}
