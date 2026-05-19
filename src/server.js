import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import {
  getSaleSmartlyMessengerBindings,
  getSaleSmartlyMessengerChannels,
  sendSaleSmartlyMessengerMessage
} from "./saleSmartlyClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");

const app = express();
const PORT = process.env.PORT || 3000;

const productsPath = path.join(projectRoot, "products.json");
const promptPath = path.join(projectRoot, "prompt.md");
const logPath = path.join(projectRoot, "conversations.jsonl");

const medicalKeywords = [
  "dosage",
  "dose",
  "units",
  "inject",
  "injection",
  "needle",
  "side effects",
  "pregnant",
  "diabetes",
  "cancer",
  "blood pressure",
  "TRT",
  "testosterone",
  "prescription",
  "medication",
  "doctor",
  "allergic"
];

const humanTakeoverReply =
  "I can share general product information, but I can’t provide personal medical, dosage, or injection instructions. For anything related to dosage, injection frequency, or medical conditions, it’s best to confirm with a licensed healthcare professional. I can still help with product options, pricing, COA, shipping, and order details.";

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/test-openai", async (_req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set" });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.responses.create({
      model: "gpt-5.2",
      input: "Reply with only: OpenAI connected",
      store: false
    });

    res.json({ ok: true, message: response.output_text });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/product-search", async (req, res) => {
  const message = String(req.body.message || req.body.query || "");
  const products = await searchProducts(message);

  res.json({
    products,
    quote_table: productsToQuoteTable(products)
  });
});

app.post("/api/generate-reply", async (req, res) => {
  const message = getCustomerMessage(req.body);
  const result = await generateReply(message);
  await logConversation(buildConversationLog({
    route: "/api/generate-reply",
    source: normalizeIncomingMessage({ ...req.body, message_text: message, platform: "api" }),
    result
  }));
  res.json(result);
});

app.all("/agent/salesmartly", async (req, res) => {
  try {
    console.log("Agent endpoint received");
    console.log("Custom agent endpoint received");
    const body = req.method === "GET" ? req.query : req.body;
    const messageText = getCustomerMessage(body);
    const customAgentContext = extractCustomAgentContext(body);
    logCustomAgentPayloadSummary(body, customAgentContext);
    console.log("Agent extracted message_text:", messageText);
    console.log("Custom agent extracted message_text:", messageText);

    const result = await generateReply(messageText);
    console.log("Agent generated reply:", result.reply);
    console.log("Agent human_takeover:", result.human_takeover);
    console.log("Custom agent generated reply:", result.reply);
    console.log("Custom agent human_takeover:", result.human_takeover);

    await sendCustomRobotReply({
      originalPayload: body,
      replyText: result.reply
    });

    await logConversation(buildConversationLog({
      route: "/agent/salesmartly",
      source: normalizeIncomingMessage({
        ...body,
        customer_id: customAgentContext.customer_id,
        session_id: customAgentContext.session_id,
        message_text: messageText,
        platform: "salesmartly_agent"
      }),
      result
    }));

    res.json(formatAgentResponse(result));
  } catch (error) {
    console.error("SaleSmartly agent endpoint failure", { message: error.message });
    res.status(500).json({
      code: 1,
      msg: "Error",
      error: error.message
    });
  }
});

app.post("/api/test-salesmartly-send", async (req, res) => {
  try {
    const { recipient_id, chat_user_id, chat_session_id, channel, replyText } = req.body;
    const resolvedRecipientId = recipient_id || chat_user_id;
    if (!replyText) {
      return res.status(400).json({
        success: false,
        error: "replyText is required"
      });
    }

    const result = await sendSaleSmartlyMessengerMessage({
      recipient_id: resolvedRecipientId,
      saleSmartlyData: {
        chat_user_id,
        chat_session_id,
        channel
      },
      replyText
    });

    console.log("SaleSmartly active send success", {
      recipient_id: resolvedRecipientId
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("SaleSmartly active send failure", { message: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/test-salesmartly-channels", async (req, res) => {
  try {
    const result = await getSaleSmartlyMessengerChannels();
    res.json(result);
  } catch (error) {
    console.error("SaleSmartly channels test failure", { message: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/test-salesmartly-bindings", async (req, res) => {
  try {
    const result = await getSaleSmartlyMessengerBindings({
      psid: String(req.query.psid || "")
    });
    res.json(result);
  } catch (error) {
    console.error("SaleSmartly bindings test failure", { message: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/webhook/salesmartly", async (req, res) => {
  console.log("========== FULL SALES SMARTLY WEBHOOK BODY START ==========");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("========== FULL SALES SMARTLY WEBHOOK BODY END ==========");
  console.log("SaleSmartly query:", JSON.stringify(req.query, null, 2));
  console.log("SaleSmartly content-type:", req.headers["content-type"]);

  const parsedPayload = parseSaleSmartlyPayload(req.body);
  if (!parsedPayload.ok) {
    return res.json({ code: 0, msg: "Success", data: null });
  }

  const { payload, data } = parsedPayload;
  console.log("SaleSmartly webhook received");
  console.log("Full SaleSmartly body:", JSON.stringify(req.body, null, 2));
  console.log("query:", req.query);
  console.log("headers content-type:", req.headers["content-type"]);
  console.log("event:", payload.event);
  console.log("chat_user_id:", data.chat_user_id);
  console.log("chat_session_id:", data.chat_session_id);
  console.log("channel:", data.channel);
  console.log("sender_type:", data.sender_type);
  console.log("msg_type:", data.msg_type);
  console.log("msg:", data.msg);
  console.log("Parsed chat_user_id:", data.chat_user_id || data.customer_id || data.user_id || data.sender);
  console.log("Parsed chat_session_id:", data.chat_session_id || data.session_id || data.chat_session_encrypt_id);
  console.log("Parsed msg:", data.msg || data.message || data.message_text || data.text);
  console.log("Parsed customer_name:", data.chat_user?.name || data.customer_name || data.name || "");

  if (!verifySaleSmartlySignature(req)) {
    return res.status(401).json({ code: 401, msg: "Invalid signature" });
  }

  const incoming = normalizeIncomingMessage(req.body, data);
  if (!incoming.message_text.trim()) {
    console.log("Missing message_text. Check full body above.");
    await logConversation(buildConversationLog({
      route: "/webhook/salesmartly",
      source: incoming,
      result: {
        human_takeover: false,
        reply: "",
        products: [],
        lead_stage: "missing_message_text"
      }
    }));

    return res.json({ code: 0, msg: "Success", data: null });
  }

  if (!shouldProcessSaleSmartlyMessage(req.body, incoming)) {
    await logConversation(buildConversationLog({
      route: "/webhook/salesmartly",
      source: incoming,
      result: {
        human_takeover: false,
        reply: "",
        products: [],
        lead_stage: "ignored_non_customer_message"
      }
    }));

    if (req.query.debug === "1") {
      return res.json({
        success: true,
        ignored: true,
        reason: "Only customer text messages are processed.",
        human_takeover: false,
        lead_stage: "ignored_non_customer_message",
        matched_products: []
      });
    }

    return res.json({ code: 0, msg: "Success", data: null });
  }

  const result = await generateReply(incoming.message_text);
  const replyText = result.reply;
  const human_takeover = result.human_takeover;
  const matchedProducts = result.products || [];
  console.log("AI reply:", replyText);
  console.log("human_takeover:", human_takeover);
  console.log("matched_products:", matchedProducts);

  await logConversation(buildConversationLog({ route: "/webhook/salesmartly", source: incoming, result }));

  const activeSendEnabled =
    process.env.SALES_SMARTLY_ACTIVE_SEND === "true" && !isCustomRobotConfigured();
  console.log("SaleSmartly active send enabled:", activeSendEnabled);
  if (isCustomRobotConfigured()) {
    console.log("SaleSmartly OpenAPI active send skipped because Custom Robot reply URL is configured.");
  }

  if (activeSendEnabled) {
    try {
      const recipient_id = getSaleSmartlyRecipientId(incoming.parsed_data);
      const sendResult = await sendSaleSmartlyMessengerMessage({
        recipient_id,
        saleSmartlyData: incoming.parsed_data,
        replyText: result.reply
      });
      console.log("SaleSmartly active send result:", sendResult);

      if (sendResult.ok) {
        console.log("SaleSmartly active send success", {
          recipient_id,
          customer_id: incoming.customer_id,
          session_id: incoming.session_id,
          channel: incoming.channel || 1
        });
      } else {
        console.error("SaleSmartly active send failure", {
          recipient_id,
          customer_id: incoming.customer_id,
          session_id: incoming.session_id,
          http_status: sendResult.http_status,
          parsed_response: sendResult.parsed_response
        });
      }
    } catch (error) {
      console.error("SaleSmartly active send failure", {
        customer_id: incoming.customer_id,
        session_id: incoming.session_id,
        message: error.message
      });
    }

    if (req.query.debug === "1") {
      return res.json({
        ...formatDebugResponse(result),
        active_send: true
      });
    }

    return res.json({ code: 0, msg: "Success" });
  }

  if (req.query.debug === "1") {
    return res.json(formatDebugResponse(result));
  }

  res.json(formatSaleSmartlyResponse(result, incoming));
});

async function generateReply(message) {
  if (hasMedicalKeyword(message)) {
    return {
      human_takeover: true,
      reply: humanTakeoverReply,
      products: [],
      lead_stage: "human_takeover"
    };
  }

  const products = isPriceListRequest(message)
    ? await listProducts()
    : isRecommendationRequest(message)
      ? await searchRecommendedProducts(message)
      : await searchProducts(message);
  const quoteTable = productsToQuoteTable(products);
  const businessInfo = getBusinessInfo();

  if (!process.env.OPENAI_API_KEY) {
    return {
      human_takeover: false,
      reply: fallbackReply(message, products, quoteTable, businessInfo),
      products,
      lead_stage: detectLeadStage(message, products, false)
    };
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const systemPrompt = await fsp.readFile(promptPath, "utf8");
    const response = await openai.responses.create({
      model: "gpt-5.2",
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                customer_message: message,
                matched_products: products,
                quote_table: quoteTable,
                business_info: businessInfo
              })
            }
          ]
        }
      ],
      store: false
    });

    return {
      human_takeover: false,
      reply: response.output_text || fallbackReply(message, products, quoteTable, businessInfo),
      products,
      lead_stage: detectLeadStage(message, products, false)
    };
  } catch (error) {
    return {
      human_takeover: false,
      reply: fallbackReply(message, products, quoteTable, businessInfo),
      products,
      lead_stage: detectLeadStage(message, products, false),
      openai_error: "OpenAI request failed; used local fallback reply."
    };
  }
}

async function searchProducts(query) {
  const products = await listProducts();
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(normalizedQuery);

  if (!normalizedQuery.trim()) return [];

  const scored = products
    .map((product) => {
      const searchable = productSearchText(product);
      const score = scoreProductMatch(product, searchable, normalizedQuery, queryTokens);
      return { product, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score || 0;
  const exactMatches = bestScore >= 90 ? scored.filter((item) => item.score >= 90) : scored;

  return exactMatches.map((item) => item.product);
}

async function searchRecommendedProducts(query) {
  const products = await listProducts();
  const categories = recommendationCategories(query);
  if (!categories.length) return searchProducts(query);

  return products
    .filter((product) => categories.includes(product.category))
    .filter((product, index, all) => {
      const sameCategory = all.filter((candidate) => candidate.category === product.category);
      return sameCategory.indexOf(product) < 5;
    });
}

async function listProducts() {
  return JSON.parse(await fsp.readFile(productsPath, "utf8"));
}

function productSearchText(product) {
  return normalizeText(
    [
      product.sku,
      product.name,
      product.category,
      product.spec,
      ...(product.aliases || [])
    ].join(" ")
  );
}

function scoreProductMatch(product, searchable, normalizedQuery, queryTokens) {
  if (searchable.includes(normalizedQuery)) return 100 + normalizedQuery.length;
  if (queryTokens.length && queryTokens.every((token) => searchable.includes(token))) return 50 + queryTokens.length;

  const productTerms = productNameTerms(product);
  const specTerms = tokenize(product.spec);
  const sku = normalizeText(product.sku);
  const nameMatched = productTerms.some((term) => term.length > 1 && normalizedQuery.includes(term));
  const specMatched = specTerms.some((term) => normalizedQuery.includes(term));

  if (sku && normalizedQuery.includes(sku)) return 95;
  if (nameMatched && specMatched) return 90;
  if (nameMatched) return 25;
  return 0;
}

function productNameTerms(product) {
  return [
    normalizeText(product.name),
    ...(product.aliases || []).map((alias) => normalizeText(alias))
  ].filter((term) => term && !/^\d+\s*mg$/.test(term));
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function productsToQuoteTable(products) {
  if (!products.length) return "";

  const rows = products.map((product) => `| ${product.sku} | ${product.name} | ${product.spec} | ${product.price} |`);
  return ["| SKU | Product | Spec | Price |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function hasMedicalKeyword(message) {
  const lower = message.toLowerCase();
  return medicalKeywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function isPriceListRequest(message) {
  return /\b(price list|catalog|catalogue|product list|all products|full list|报价|价格表)\b/i.test(message);
}

function isRecommendationRequest(message) {
  return /\b(recommend|suggest|trying to|goal|lose weight|weight loss|skin|anti-aging|recovery|muscle)\b/i.test(message);
}

function recommendationCategories(message) {
  const lower = message.toLowerCase();
  const categories = [];
  if (/\b(weight|lose weight|fat|slim|glp)\b/i.test(lower)) categories.push("Weight management");
  if (/\b(skin|beauty|cosmetic|ghk|copper)\b/i.test(lower)) categories.push("Skin support");
  if (/\b(anti-aging|anti aging|longevity|nad|epithalon)\b/i.test(lower)) categories.push("Anti-aging");
  if (/\b(recovery|repair|joint|bpc|tb500)\b/i.test(lower)) categories.push("Recovery");
  if (/\b(muscle|build|bodybuilding|cjc|ipa)\b/i.test(lower)) categories.push("Muscle building");
  return [...new Set(categories)];
}

function getCustomerMessage(body) {
  const parsedPayload = parseSaleSmartlyPayload(body, { logErrors: false });
  const payload = parsedPayload.ok ? parsedPayload.payload : body || {};
  const data = parsedPayload.ok ? parsedPayload.data : payload.data || payload;

  return String(
    data.msg ||
      data.message ||
      data.message_text ||
      data.text ||
      data.customer_message ||
      data.content ||
      data.query ||
      payload.customer_message ||
      payload.message_text ||
      payload.message ||
      payload.text ||
      payload.content ||
      payload.query ||
      payload.entry?.[0]?.messaging?.[0]?.message?.text ||
      ""
  );
}

function extractCustomAgentContext(body) {
  const parsedPayload = parseSaleSmartlyPayload(body, { logErrors: false });
  const payload = parsedPayload.ok ? parsedPayload.payload : body || {};
  const data = parsedPayload.ok ? parsedPayload.data : payload.data || payload;

  return {
    customer_id: String(
      data.customer_id ||
        data.chat_user_id ||
        data.user_id ||
        data.sender ||
        payload.customer_id ||
        payload.chat_user_id ||
        payload.user_id ||
        payload.sender ||
        ""
    ),
    session_id: String(
      data.chat_session_id ||
        data.session_id ||
        data.chat_session_encrypt_id ||
        payload.chat_session_id ||
        payload.session_id ||
        payload.chat_session_encrypt_id ||
        ""
    )
  };
}

function logCustomAgentPayloadSummary(body, context) {
  const parsedPayload = parseSaleSmartlyPayload(body, { logErrors: false });
  const payload = parsedPayload.ok ? parsedPayload.payload : body || {};
  const data = parsedPayload.ok ? parsedPayload.data : payload.data || {};

  console.log("Custom agent payload top-level keys:", Object.keys(payload));
  console.log("Custom agent payload data keys:", data && typeof data === "object" ? Object.keys(data) : []);
  console.log("Custom agent session/message identifiers:", {
    customer_id: context.customer_id || "",
    session_id: context.session_id || "",
    has_message: Boolean(getCustomerMessage(body))
  });
}

function normalizeIncomingMessage(body, parsedData = null) {
  const messengerEvent = body.entry?.[0]?.messaging?.[0];
  const payload = body || {};
  const data = parsedData || parseSaleSmartlyPayload(body, { logErrors: false }).data || payload.data || payload;
  const isOfficialSaleSmartly = payload.event === "message" || Boolean(payload.data);
  const timestamp =
    payload.timestamp ||
    payload.time ||
    data.timestamp ||
    data.time ||
    data.send_time ||
    messengerEvent?.timestamp ||
    new Date().toISOString();

  return {
    customer_id: String(
      data.chat_user_id ||
      data.customer_id ||
        data.user_id ||
        data.sender ||
        data.customerId ||
        data.sender_id ||
        payload.customer_id ||
        payload.customerId ||
        payload.user_id ||
        payload.sender ||
        payload.sender_id ||
        messengerEvent?.sender?.id ||
        "unknown"
    ),
    session_id: String(
      data.chat_session_id ||
        data.session_id ||
        data.chat_session_encrypt_id ||
        payload.session_id ||
        payload.chat_session_id ||
        payload.chat_session_encrypt_id ||
        "unknown"
    ),
    page_id: String(
      data.page_id ||
        data.pageId ||
        data.recipient_id ||
        payload.page_id ||
        payload.pageId ||
        payload.recipient_id ||
        messengerEvent?.recipient?.id ||
        "unknown"
    ),
    channel: data.channel ?? payload.channel ?? null,
    channel_uid: String(data.channel_uid || payload.channel_uid || "unknown"),
    channel_name: String(data.channel_name || payload.channel_name || "unknown"),
    sender_type: data.sender_type ?? payload.sender_type ?? null,
    msg_type: data.msg_type || payload.msg_type || null,
    sequence_id: String(data.sequence_id || payload.sequence_id || ""),
    event: payload.event || null,
    customer_name: String(
      data.chat_user?.name ||
        data.customer_name ||
        data.name ||
        data.customerName ||
        data.sender_name ||
        payload.customer_name ||
        payload.customerName ||
        payload.sender_name ||
        "unknown"
    ),
    message_text: getCustomerMessage(body),
    timestamp: typeof timestamp === "number" ? new Date(timestamp).toISOString() : String(timestamp),
    platform: String(
      payload.platform ||
        data.platform ||
        (Number(data.channel) === 1 ? "messenger" : null) ||
        (messengerEvent ? "messenger" : null) ||
        (isOfficialSaleSmartly ? "salesmartly" : "salesmartly")
    ),
    raw: body,
    parsed_data: data
  };
}

function parseSaleSmartlyPayload(body, options = {}) {
  const { logErrors = true } = options;
  const payload = body || {};
  let data = payload.data || payload;

  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (err) {
      if (logErrors) console.error("Failed to parse SaleSmartly data string:", err.message);
      return { ok: false, payload, data: {} };
    }
  }

  return { ok: true, payload, data };
}

function getSaleSmartlyRecipientId(data = {}) {
  const candidateRecipientIds = {
    chat_user_channelUid: data.chat_user?.channelUid || "",
    chat_user_channelInfo_psid: parseSaleSmartlyChannelInfoPsid(data.chat_user?.channelInfo),
    sender: data.sender || "",
    chat_user_id: data.chat_user_id || "",
    chat_user_chatUserId: data.chat_user?.chatUserId || "",
    channelInfo_psid: parseSaleSmartlyChannelInfoPsid(data.channelInfo),
    chat_session_id: data.chat_session_id ? String(data.chat_session_id) : "",
    channel_id: data.channel_id ? String(data.channel_id) : ""
  };
  const recipientMode = process.env.SALES_SMARTLY_RECIPIENT_ID_MODE || "psid";
  let selectedRecipientId;
  let selectedRecipientSource;

  switch (recipientMode) {
    case "psid":
      {
        const psidCandidates = [
          ["data.chat_user.channelUid", candidateRecipientIds.chat_user_channelUid],
          ["data.chat_user.channelInfo.psid", candidateRecipientIds.chat_user_channelInfo_psid],
          ["data.sender", candidateRecipientIds.sender]
        ];
        const selectedCandidate = psidCandidates.find(([, value]) => value);
        selectedRecipientSource = selectedCandidate?.[0];
        selectedRecipientId = selectedCandidate?.[1];
      }
      break;
    case "chat_session_id":
      selectedRecipientId = candidateRecipientIds.chat_session_id;
      selectedRecipientSource = "data.chat_session_id";
      break;
    case "channel_id":
      selectedRecipientId = candidateRecipientIds.channel_id;
      selectedRecipientSource = "data.channel_id";
      break;
    case "chat_user_chatUserId":
      selectedRecipientId = candidateRecipientIds.chat_user_chatUserId;
      selectedRecipientSource = "data.chat_user.chatUserId";
      break;
    case "auto":
      {
        const autoCandidates = [
          ["data.chat_user.channelUid", candidateRecipientIds.chat_user_channelUid],
          ["data.chat_user.channelInfo.psid", candidateRecipientIds.chat_user_channelInfo_psid],
          ["data.sender", candidateRecipientIds.sender],
          ["data.channelInfo.psid", candidateRecipientIds.channelInfo_psid],
          ["data.chat_user_id", candidateRecipientIds.chat_user_id],
          ["data.chat_session_id", candidateRecipientIds.chat_session_id],
          ["data.channel_id", candidateRecipientIds.channel_id],
          ["data.chat_user.chatUserId", candidateRecipientIds.chat_user_chatUserId]
        ];
        const selectedCandidate = autoCandidates.find(([, value]) => value);
        selectedRecipientSource = selectedCandidate?.[0];
        selectedRecipientId = selectedCandidate?.[1];
      }
      break;
    case "chat_user_id":
    default:
      selectedRecipientId = candidateRecipientIds.chat_user_id;
      selectedRecipientSource = "data.chat_user_id";
      break;
  }

  console.log("SaleSmartly recipient mode:", recipientMode);
  console.log("SaleSmartly candidate recipient IDs:", candidateRecipientIds);
  console.log("SaleSmartly selected recipient source:", selectedRecipientSource || "");
  console.log("SaleSmartly selected recipient_id:", selectedRecipientId || "");

  return selectedRecipientId || "";
}

function parseSaleSmartlyChannelInfoPsid(channelInfo) {
  if (!channelInfo) return "";

  try {
    const parsed = typeof channelInfo === "string" ? JSON.parse(channelInfo) : channelInfo;
    return parsed?.psid || "";
  } catch (error) {
    console.error("Failed to parse SaleSmartly channelInfo:", error.message);
    return "";
  }
}

function formatSaleSmartlyResponse(result, incoming) {
  const data = incoming.parsed_data || {};

  return {
    code: 0,
    msg: "Success",
    data: {
      msg_type: 1,
      msg: result.reply,
      chat_user_id: data.chat_user_id,
      chat_session_id: String(data.chat_session_id),
      send_time: String(Date.now()),
      channel: data.channel,
      channel_uid: data.channel_uid,
      channel_name: data.channel_name
    }
  };
}

function formatDebugResponse(result) {
  return {
    success: true,
    reply: result.reply,
    human_takeover: result.human_takeover,
    lead_stage: result.lead_stage,
    matched_products: result.products || []
  };
}

function formatAgentResponse(result) {
  const replyText = result.reply || "";
  const matchedProducts = result.products || [];

  return {
    reply: replyText,
    answer: replyText,
    content: replyText,
    text: replyText,
    code: 0,
    msg: "Success",
    data: {
      reply: replyText,
      answer: replyText,
      content: replyText,
      text: replyText
    },
    human_takeover: Boolean(result.human_takeover),
    lead_stage: result.lead_stage || detectLeadStage("", matchedProducts, result.human_takeover),
    matched_products: matchedProducts
  };
}

async function sendCustomRobotReply({ originalPayload, replyText }) {
  const replyUrl =
    process.env.SALES_SMARTLY_CUSTOM_ROBOT_REPLY_URL ||
    "https://msg.salesmartly.com/custom-robot/webhook";
  const accessToken = process.env.SALES_SMARTLY_CUSTOM_ROBOT_ACCESS_TOKEN || "";
  const replyMode = process.env.SALES_SMARTLY_CUSTOM_ROBOT_REPLY_MODE || "access_token_body";
  const context = extractCustomAgentContext(originalPayload);
  const data = getCustomAgentData(originalPayload);

  if (!replyUrl) {
    console.log("SaleSmartly custom robot reply URL is not configured.");
    return { sent: false, http_status: null, response_text: "" };
  }

  const baseBody = {
    reply: replyText,
    message: replyText,
    content: replyText,
    text: replyText,
    session_id: context.session_id,
    customer_id: context.customer_id,
    chat_user_id: data.chat_user_id ?? "",
    chat_session_id: data.chat_session_id != null ? String(data.chat_session_id) : "",
    chat_session_encrypt_id: data.chat_session_encrypt_id ?? "",
    sequence_id: data.sequence_id != null ? String(data.sequence_id) : "",
    mid: data.mid ?? "",
    channel: data.channel ?? "",
    channel_uid: data.channel_uid ?? ""
  };
  const { body, headers } = buildCustomRobotReplyRequest({
    mode: replyMode,
    accessToken,
    baseBody
  });

  console.log("Custom robot reply URL called");
  console.log("SaleSmartly custom robot reply URL:", replyUrl);
  console.log("Custom robot reply mode:", replyMode);
  console.log("Custom robot reply token info:", maskTokenInfo(accessToken));
  console.log("SaleSmartly custom robot reply body keys:", Object.keys(body));
  console.log("Custom robot reply header names:", Object.keys(headers));
  if (body.data && typeof body.data === "object") {
    console.log("SaleSmartly custom robot reply data keys:", Object.keys(body.data));
  }

  try {
    const response = await fetch(replyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    console.log("Custom robot reply HTTP status:", response.status);
    console.log("SaleSmartly custom robot reply URL HTTP status:", response.status);
    const responseText = await response.text();
    console.log("Custom robot reply response text:", responseText);
    console.log("SaleSmartly custom robot reply URL response text:", responseText);

    return {
      sent: response.ok,
      http_status: response.status,
      response_text: responseText
    };
  } catch (error) {
    console.error("SaleSmartly custom robot reply URL failure", { message: error.message });
    return {
      sent: false,
      http_status: null,
      response_text: error.message
    };
  }
}

function getCustomAgentData(body) {
  const parsedPayload = parseSaleSmartlyPayload(body, { logErrors: false });
  const payload = parsedPayload.ok ? parsedPayload.payload : body || {};
  return parsedPayload.ok ? parsedPayload.data : payload.data || payload;
}

function buildCustomRobotReplyRequest({ mode, accessToken, baseBody }) {
  const headers = {
    "Content-Type": "application/json"
  };
  const body = { ...baseBody };

  switch (mode) {
    case "bearer_header":
      headers.Authorization = `Bearer ${accessToken}`;
      break;
    case "accessToken_body":
      body.accessToken = accessToken;
      break;
    case "token_body":
      body.token = accessToken;
      break;
    case "access_token_body":
    default:
      body.access_token = accessToken;
      break;
  }

  return { body, headers };
}

function maskTokenInfo(token) {
  const value = String(token || "");
  return {
    exists: Boolean(value),
    length: value.length,
    preview: value.length > 6 ? `${value.slice(0, 3)}***${value.slice(-3)}` : "***"
  };
}

function isCustomRobotConfigured() {
  return Boolean(
    process.env.SALES_SMARTLY_CUSTOM_ROBOT_REPLY_URL ||
      process.env.SALES_SMARTLY_CUSTOM_ROBOT_ACCESS_TOKEN
  );
}

function shouldProcessSaleSmartlyMessage(body, incoming) {
  const payload = body || {};
  const isOfficialSaleSmartly = Boolean(payload.event || payload.data);
  if (!isOfficialSaleSmartly) return Boolean(incoming.message_text.trim());

  if (payload.event !== "message") return false;
  if (Number(incoming.sender_type) !== 1) return false;
  return isTextCompatibleMessage(incoming.msg_type) && Boolean(incoming.message_text.trim());
}

function isTextCompatibleMessage(msgType) {
  if (msgType === null || msgType === undefined) return true;
  const normalized = String(msgType).toLowerCase();
  return normalized === "text" || normalized === "1" || normalized === "3";
}

function verifySaleSmartlySignature(req) {
  if (process.env.SALES_SMARTLY_VERIFY_SIGNATURE !== "true") return true;

  const secret = process.env.SALES_SMARTLY_WEBHOOK_SECRET;
  const timestamp = String(req.query.timestamp || "");
  const signature = String(req.query.signature || "");
  if (!secret || !timestamp || !signature) return false;

  const payload = `${timestamp}.${JSON.stringify(req.body)}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return timingSafeEqual(signature, expected);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildConversationLog({ route, source, result }) {
  return {
    route,
    customer_id: source.customer_id,
    session_id: source.session_id,
    channel: source.channel,
    channel_uid: source.channel_uid,
    channel_name: source.channel_name,
    platform: source.platform,
    incoming_message: source.message_text,
    ai_reply: result.reply,
    matched_products: result.products || [],
    human_takeover: result.human_takeover,
    lead_stage: result.lead_stage || detectLeadStage(source.message_text, result.products || [], result.human_takeover),
    timestamp: new Date().toISOString(),
    raw_event_id: source.sequence_id || ""
  };
}

function detectLeadStage(message, products, humanTakeover) {
  if (humanTakeover) return "human_takeover";
  if (isPriceListRequest(message)) return "catalog_requested";
  if (products.length) return "quoted";
  if (/\b(shipping|delivery|ship|lead time)\b/i.test(message)) return "shipping_question";
  if (/\b(payment|pay|paypal|card|venmo|zelle|cash app)\b/i.test(message)) return "payment_question";
  if (/\b(coa|lab|test|report|purity)\b/i.test(message)) return "coa_question";
  if (isRecommendationRequest(message)) return "recommendation";
  return "needs_follow_up";
}

function getBusinessInfo() {
  return {
    name: "Steve",
    company: "China-based peptide manufacturer",
    coa: "Third-party lab reports available",
    shipping: "Ships within 24 hours after payment. U.S. delivery usually takes 7-12 days.",
    shipping_fee: "$60",
    free_shipping: "Orders over $500 include free shipping",
    payment_methods: ["credit card", "PayPal", "Cash App", "Venmo", "Zelle"],
    moq: "No minimum order quantity",
    bac_water: "Products do not include BAC water unless listed",
    syringes: "We do not sell syringes"
  };
}

function fallbackReply(message, products, quoteTable, businessInfo) {
  if (products.length) {
    return `Sure, this is Steve. Here are the matching product options:\n\n${quoteTable}\n\n${businessInfo.coa}. Shipping is ${businessInfo.shipping_fee}, and orders over $500 include free shipping.`;
  }

  const lower = message.toLowerCase();
  if (lower.includes("shipping")) {
    return `This is Steve. We ship within 24 hours after payment. U.S. delivery usually takes 7-12 days. Shipping is $60, and orders over $500 include free shipping.`;
  }
  if (lower.includes("payment") || lower.includes("pay")) {
    return `We accept credit card, PayPal, Cash App, Venmo, and Zelle.`;
  }
  if (lower.includes("coa") || lower.includes("lab") || lower.includes("test")) {
    return `Third-party lab reports are available. Tell me which SKU you want to check and I can help with the product details.`;
  }

  return `This is Steve. I can help with product options, pricing, COA, shipping, and order details. Please send the product name or SKU you are looking for.`;
}

async function logConversation(entry) {
  const safeEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  };

  fs.appendFile(logPath, `${JSON.stringify(safeEntry)}\n`, (error) => {
    if (error) console.error("Failed to write conversation log:", error.message);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
