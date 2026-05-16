import crypto from "node:crypto";

const SALESMARTLY_OPENAPI_BASE_URL = "https://api.salesmartly.com/openapi/v1";
const SALESMARTLY_MESSENGER_SEND_URL = `${SALESMARTLY_OPENAPI_BASE_URL}/messenger/send`;
const SALESMARTLY_MESSENGER_CHANNELS_URL = `${SALESMARTLY_OPENAPI_BASE_URL}/messenger/channels`;
const SALESMARTLY_MESSENGER_BINDINGS_URL = `${SALESMARTLY_OPENAPI_BASE_URL}/messenger/bindings`;

export async function sendSaleSmartlyMessengerMessage({
  recipient_id,
  saleSmartlyData = {},
  replyText
}) {
  const token = process.env.SALES_SMARTLY_API_TOKEN;
  if (!token) {
    throw new Error("SALES_SMARTLY_API_TOKEN is not set");
  }

  const sendBodyFormat = process.env.SALES_SMARTLY_SEND_BODY_FORMAT || "official_to_text";
  const body = buildSaleSmartlySendBody({
    sendBodyFormat,
    recipient_id,
    saleSmartlyData,
    replyText
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatureOrder = process.env.SALES_SMARTLY_SIGNATURE_ORDER || "timestamp_data";
  const raw = createSaleSmartlySendSignatureRaw({ token, body, timestamp, signatureOrder });
  const signature = crypto.createHash("md5").update(raw).digest("hex");
  const url = buildSaleSmartlyUrl({
    baseUrl: SALESMARTLY_MESSENGER_SEND_URL,
    timestamp,
    signature
  });

  console.log("SaleSmartly send request URL:", SALESMARTLY_MESSENGER_SEND_URL);
  console.log("SaleSmartly endpoint domain:", "api.salesmartly.com");
  console.log("SaleSmartly send body format:", sendBodyFormat);
  console.log("SaleSmartly recipient_id:", recipient_id || "");
  console.log("SaleSmartly chat_user_id:", saleSmartlyData.chat_user_id || "");
  console.log("SaleSmartly chat_session_id:", saleSmartlyData.chat_session_id || "");
  console.log("SaleSmartly channel:", saleSmartlyData.channel || 1);
  console.log("SaleSmartly timestamp used:", timestamp);
  console.log("SaleSmartly signature order:", signatureOrder);
  console.log("SaleSmartly signature prefix:", signature.slice(0, 6));
  console.log("SaleSmartly signature raw pattern:", signatureOrder === "alpha" ? "token&data=...&timestamp=..." : "token&timestamp=...&data=...");
  console.log("SaleSmartly send query names:", ["signature", "timestamp"]);
  console.log("SaleSmartly send header names:", ["Authorization", "Content-Type"]);
  console.log("SaleSmartly send request body:", JSON.stringify(body, null, 2));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
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

export async function getSaleSmartlyMessengerChannels() {
  return sendSaleSmartlySignedGet({
    baseUrl: SALESMARTLY_MESSENGER_CHANNELS_URL,
    label: "channels"
  });
}

export async function getSaleSmartlyMessengerBindings({ psid }) {
  if (!psid) {
    throw new Error("psid is required for SaleSmartly bindings test");
  }

  return sendSaleSmartlySignedGet({
    baseUrl: SALESMARTLY_MESSENGER_BINDINGS_URL,
    label: "bindings",
    query: { psid }
  });
}

function buildSaleSmartlySendBody({ sendBodyFormat, recipient_id, saleSmartlyData, replyText }) {
  if (sendBodyFormat === "salesmartly_session_template") {
    validateSaleSmartlySessionData(saleSmartlyData);
    return {
      data: {
        msg_type: 3,
        msg: {
          template1: {
            text: replyText
          }
        },
        chat_user_id: saleSmartlyData.chat_user_id,
        chat_session_id: String(saleSmartlyData.chat_session_id),
        send_time: String(Date.now()),
        channel: saleSmartlyData.channel || 1,
        tag: "CONFIRMED_EVENT_UPDATE"
      }
    };
  }

  if (sendBodyFormat === "salesmartly_session_text") {
    validateSaleSmartlySessionData(saleSmartlyData);
    return {
      data: {
        msg_type: 1,
        msg: replyText,
        chat_user_id: saleSmartlyData.chat_user_id,
        chat_session_id: String(saleSmartlyData.chat_session_id),
        send_time: String(Date.now()),
        channel: saleSmartlyData.channel || 1
      }
    };
  }

  if (!recipient_id) {
    throw new Error("recipient_id is required for SaleSmartly active send");
  }

  return {
    to: recipient_id,
    message_type: "text",
    data: {
      text: replyText,
      metadata: {
        session_id: saleSmartlyData.chat_session_id ? String(saleSmartlyData.chat_session_id) : "",
        ref_user: saleSmartlyData.chat_user_id || ""
      }
    }
  };
}

function validateSaleSmartlySessionData(saleSmartlyData = {}) {
  if (!saleSmartlyData.chat_user_id) {
    throw new Error("chat_user_id is required for SaleSmartly session active send");
  }
  if (!saleSmartlyData.chat_session_id) {
    throw new Error("chat_session_id is required for SaleSmartly session active send");
  }
}

function createSaleSmartlySendSignatureRaw({ token, body, timestamp, signatureOrder }) {
  const bodyJson = JSON.stringify(body);
  if (signatureOrder === "alpha") {
    return `${token}&data=${bodyJson}&timestamp=${timestamp}`;
  }
  return `${token}&timestamp=${timestamp}&data=${bodyJson}`;
}

function buildSaleSmartlyUrl({ baseUrl, timestamp, signature, query = {} }) {
  const params = new URLSearchParams({
    ...query,
    signature,
    timestamp,
  });
  return `${baseUrl}?${params.toString()}`;
}

async function sendSaleSmartlySignedGet({ baseUrl, label, query = {} }) {
  const token = process.env.SALES_SMARTLY_API_TOKEN;
  if (!token) {
    throw new Error("SALES_SMARTLY_API_TOKEN is not set");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const raw = `${token}&timestamp=${timestamp}`;
  const signature = crypto.createHash("md5").update(raw).digest("hex");
  const url = buildSaleSmartlyUrl({
    baseUrl,
    timestamp,
    signature,
    query
  });

  console.log(`SaleSmartly ${label} request URL:`, baseUrl);
  console.log("SaleSmartly endpoint domain:", "api.salesmartly.com");
  console.log(`SaleSmartly ${label} query names:`, [...Object.keys(query), "signature", "timestamp"]);
  console.log(`SaleSmartly ${label} header names:`, ["Authorization", "Content-Type"]);
  console.log(`SaleSmartly ${label} timestamp used:`, timestamp);
  console.log(`SaleSmartly ${label} signature prefix:`, signature.slice(0, 6));
  console.log(`SaleSmartly ${label} signature raw pattern:`, "token&timestamp=...");

  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  console.log(`SaleSmartly ${label} HTTP status:`, response.status);
  const responseText = await response.text();
  console.log(`SaleSmartly ${label} response text:`, responseText);

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    parsed = undefined;
  }

  return {
    ok: response.status === 200 && isSaleSmartlySuccess(parsed),
    http_status: response.status,
    response_text: responseText,
    parsed_response: parsed
  };
}

function isSaleSmartlySuccess(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.code === 0 || parsed.code === "0") return true;
  if (parsed.success === true) return true;
  if (parsed.msg === "Success" && (parsed.code === undefined || parsed.code === 0 || parsed.code === "0")) return true;
  return false;
}
