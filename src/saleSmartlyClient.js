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
  const url = new URL(SALESMARTLY_MESSENGER_SEND_URL);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("signature", token);

  const sendMode = process.env.SALES_SMARTLY_SEND_MODE === "template" ? "template" : "text";
  const body = buildSaleSmartlySendBody({
    chat_user_id,
    chat_session_id,
    channel,
    replyText,
    sendMode
  });

  console.log("SaleSmartly send request URL:", SALESMARTLY_MESSENGER_SEND_URL);
  console.log("SaleSmartly send auth:", "query params timestamp + signature; signature value is redacted");
  console.log("SaleSmartly send mode:", sendMode);
  console.log("SaleSmartly send query names:", ["timestamp", "signature"]);
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

  const ok = response.status === 200 && isSaleSmartlySuccess(parsed);

  return {
    ok,
    http_status: response.status,
    response_text: responseText,
    parsed_response: parsed
  };
}

function buildSaleSmartlySendBody({
  chat_user_id,
  chat_session_id,
  channel,
  replyText,
  sendMode
}) {
  if (sendMode === "template") {
    return {
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
  }

  return {
    data: {
      msg_type: 1,
      msg: replyText,
      chat_user_id,
      chat_session_id: String(chat_session_id),
      send_time: String(Date.now()),
      channel: channel || 1
    }
  };
}

function isSaleSmartlySuccess(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.code === 0 || parsed.code === "0") return true;
  if (parsed.success === true) return true;
  if (parsed.msg === "Success" && (parsed.code === undefined || parsed.code === 0 || parsed.code === "0")) return true;
  return false;
}
