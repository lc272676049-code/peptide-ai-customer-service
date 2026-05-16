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

  const sendMode = process.env.SALES_SMARTLY_SEND_MODE === "template" ? "template" : "text";
  const body = buildSaleSmartlySendBody({
    chat_user_id,
    chat_session_id,
    channel,
    replyText,
    sendMode
  });
  const timestamp = createSaleSmartlyTimestamp();
  const queryParams = { timestamp };
  const signatureConfig = getSignatureConfig();
  const signatureInfo = createSaleSmartlySignature({
    token,
    queryParams,
    body,
    mode: signatureConfig.mode,
    includeBody: signatureConfig.includeBody
  });
  const url = new URL(SALESMARTLY_MESSENGER_SEND_URL);
  url.searchParams.set("timestamp", timestamp);

  if (signatureConfig.authLocation === "query") {
    url.searchParams.set("signature", signatureInfo.signature);
  }

  console.log("SaleSmartly send request URL:", SALESMARTLY_MESSENGER_SEND_URL);
  console.log("SaleSmartly send auth:", `auth location ${signatureConfig.authLocation}; signature value is redacted`);
  console.log("SaleSmartly send mode:", sendMode);
  console.log("SaleSmartly signature mode:", signatureConfig.mode);
  console.log("SaleSmartly timestamp used:", timestamp);
  console.log("SaleSmartly signature included parameter names:", signatureInfo.includedParameterNames);
  console.log("SaleSmartly signature include body:", signatureInfo.bodyIncluded);
  console.log("SaleSmartly signature prefix:", signatureInfo.signature.slice(0, 6));
  console.log("SaleSmartly send query names:", [...url.searchParams.keys()]);
  console.log("SaleSmartly send header names:", signatureConfig.authLocation === "header" ? ["Content-Type", "signature", "timestamp"] : ["Content-Type"]);
  console.log("SaleSmartly send request body:", JSON.stringify(body, null, 2));

  const headers = {
    "Content-Type": "application/json"
  };

  if (signatureConfig.authLocation === "header") {
    headers.signature = signatureInfo.signature;
    headers.timestamp = timestamp;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
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

function createSaleSmartlyTimestamp() {
  if (process.env.SALES_SMARTLY_TIMESTAMP_UNIT === "milliseconds") {
    return String(Date.now());
  }

  return String(Math.floor(Date.now() / 1000));
}

function getSignatureConfig() {
  return {
    mode: process.env.SALES_SMARTLY_SIGNATURE_MODE || "query_values_token",
    includeBody: process.env.SALES_SMARTLY_SIGNATURE_INCLUDE_BODY === "true",
    authLocation: process.env.SALES_SMARTLY_AUTH_LOCATION === "header" ? "header" : "query"
  };
}

function createSaleSmartlySignature({
  token,
  queryParams,
  body,
  mode,
  includeBody
}) {
  const queryPairs = sortedScalarPairs(queryParams);
  const bodyPairs = includeBody ? sortedScalarPairs(flattenObject(body)) : [];
  const queryValues = queryPairs.map(([, value]) => value).join("");
  const bodyValues = bodyPairs.map(([, value]) => value).join("");

  let signatureBase;
  switch (mode) {
    case "query_values_token_values":
      signatureBase = `${queryValues}${token}${bodyValues}`;
      break;
    case "body_values_token":
      signatureBase = `${bodyValues}${token}`;
      break;
    case "token_query_values":
      signatureBase = `${token}${queryValues}`;
      break;
    case "query_values_token":
    default:
      signatureBase = `${queryValues}${token}`;
      break;
  }

  return {
    signature: crypto.createHash("md5").update(signatureBase).digest("hex"),
    includedParameterNames: [
      ...queryPairs.map(([key]) => key),
      ...bodyPairs.map(([key]) => key)
    ],
    bodyIncluded: bodyPairs.length > 0
  };
}

function flattenObject(value, prefix = "", result = {}) {
  if (value === null || value === undefined) return result;

  if (typeof value !== "object" || Array.isArray(value)) {
    result[prefix] = String(value);
    return result;
  }

  for (const [key, childValue] of Object.entries(value)) {
    const childKey = prefix ? `${prefix}.${key}` : key;
    flattenObject(childValue, childKey, result);
  }

  return result;
}

function sortedScalarPairs(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)])
    .sort(([a], [b]) => a.localeCompare(b));
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
