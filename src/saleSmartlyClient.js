import crypto from "node:crypto";

const SALESMARTLY_MESSENGER_SEND_URL = "https://webhook.salesmartly.com/messenger/send";
const SALESMARTLY_MESSENGER_CHANNELS_URL = "https://webhook.salesmartly.com/messenger/channels";
const DEFAULT_CHANNEL_UID_TO_CHECK = "136944862844891";

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
  const raw = createSaleSmartlySendSignatureRaw({ token, body, timestamp });
  const signature = crypto.createHash("md5").update(raw).digest("hex");
  const url = buildSaleSmartlyUrl({
    baseUrl: SALESMARTLY_MESSENGER_SEND_URL,
    token,
    timestamp,
    signature
  });

  console.log("SaleSmartly send request URL:", SALESMARTLY_MESSENGER_SEND_URL);
  console.log("SaleSmartly send body format:", sendBodyFormat);
  console.log("SaleSmartly recipient_id:", recipient_id || "");
  console.log("SaleSmartly chat_user_id:", saleSmartlyData.chat_user_id || "");
  console.log("SaleSmartly chat_session_id:", saleSmartlyData.chat_session_id || "");
  console.log("SaleSmartly channel:", saleSmartlyData.channel || 1);
  console.log("SaleSmartly timestamp used:", timestamp);
  console.log("SaleSmartly signature prefix:", signature.slice(0, 6));
  console.log("SaleSmartly signature raw pattern:", "token&data=...&timestamp=...");
  console.log("SaleSmartly send query names:", ["token", "timestamp", "signature"]);
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

export async function getSaleSmartlyMessengerChannels({
  channelUidToCheck = DEFAULT_CHANNEL_UID_TO_CHECK
} = {}) {
  const token = process.env.SALES_SMARTLY_API_TOKEN;
  if (!token) {
    throw new Error("SALES_SMARTLY_API_TOKEN is not set");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const raw = `${token}&timestamp=${timestamp}`;
  const signature = crypto.createHash("md5").update(raw).digest("hex");
  const url = buildSaleSmartlyUrl({
    baseUrl: SALESMARTLY_MESSENGER_CHANNELS_URL,
    token,
    timestamp,
    signature
  });

  console.log("SaleSmartly channels request URL:", SALESMARTLY_MESSENGER_CHANNELS_URL);
  console.log("SaleSmartly channels query names:", ["token", "timestamp", "signature"]);
  console.log("SaleSmartly channels timestamp used:", timestamp);
  console.log("SaleSmartly channels signature prefix:", signature.slice(0, 6));
  console.log("SaleSmartly channels signature raw pattern:", "token&timestamp=...");

  const response = await fetch(url);
  console.log("SaleSmartly channels HTTP status:", response.status);
  const responseText = await response.text();
  console.log("SaleSmartly channels response text:", responseText);

  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    parsed = undefined;
  }

  const includesChannelUid = responseIncludesValue(parsed ?? responseText, channelUidToCheck);
  console.log(`SaleSmartly channels includes channel_uid ${channelUidToCheck}:`, includesChannelUid);

  return {
    ok: response.status === 200 && isSaleSmartlySuccess(parsed),
    http_status: response.status,
    response_text: responseText,
    parsed_response: parsed,
    includes_channel_uid: includesChannelUid
  };
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
      text: replyText
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

function createSaleSmartlySendSignatureRaw({ token, body, timestamp }) {
  const bodyJson = JSON.stringify(body);
  return `${token}&data=${bodyJson}&timestamp=${timestamp}`;
}

function buildSaleSmartlyUrl({ baseUrl, token, timestamp, signature }) {
  const params = new URLSearchParams({
    token,
    timestamp,
    signature
  });
  return `${baseUrl}?${params.toString()}`;
}

function isSaleSmartlySuccess(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.code === 0 || parsed.code === "0") return true;
  if (parsed.success === true) return true;
  if (parsed.msg === "Success" && (parsed.code === undefined || parsed.code === 0 || parsed.code === "0")) return true;
  return false;
}

function responseIncludesValue(value, needle) {
  if (!needle) return false;
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => responseIncludesValue(item, needle));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => responseIncludesValue(item, needle));
  }
  return false;
}
