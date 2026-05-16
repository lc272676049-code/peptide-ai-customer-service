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
import { sendSaleSmartlyMessengerMessage } from "./saleSmartlyClient.js";

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

app.post("/api/test-salesmartly-send", async (req, res) => {
  try {
    const { chat_user_id, chat_session_id, channel, replyText } = req.body;
    if (!chat_user_id || !chat_session_id || !replyText) {
      return res.status(400).json({
        success: false,
        error: "chat_user_id, chat_session_id, and replyText are required"
      });
    }

    const result = await sendSaleSmartlyMessengerMessage({
      chat_user_id,
      chat_session_id,
      channel,
      replyText
    });

    console.log("SaleSmartly active send success", {
      chat_user_id,
      chat_session_id: String(chat_session_id),
      channel: channel || 1
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error("SaleSmartly active send failure", { message: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/webhook/salesmartly", async (req, res) => {
  console.log("========== FULL SALES SMARTLY WEBHOOK BODY START ==========");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("========== FULL SALES SMARTLY WEBHOOK BODY END ==========");
  console.log("SaleSmartly query:", JSON.stringify(req.query, null, 2));
  console.log("SaleSmartly content-type:", req.headers["content-type"]);

  const payload = req.body || {};
  const data = payload.data || payload;
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

  if (!verifySaleSmartlySignature(req)) {
    return res.status(401).json({ code: 401, msg: "Invalid signature" });
  }

  const incoming = normalizeIncomingMessage(req.body);
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

  const activeSendEnabled = process.env.SALES_SMARTLY_ACTIVE_SEND === "true";
  console.log("SaleSmartly active send enabled:", activeSendEnabled);

  if (activeSendEnabled) {
    try {
      await sendSaleSmartlyMessengerMessage({
        chat_user_id: incoming.customer_id,
        chat_session_id: incoming.session_id,
        channel: incoming.channel,
        replyText: result.reply
      });

      console.log("SaleSmartly active send success", {
        customer_id: incoming.customer_id,
        session_id: incoming.session_id,
        channel: incoming.channel || 1
      });
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
  const payload = body || {};
  const data = payload.data || payload;

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

function normalizeIncomingMessage(body) {
  const messengerEvent = body.entry?.[0]?.messaging?.[0];
  const payload = body || {};
  const data = payload.data || payload;
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
      data.customer_name ||
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
    raw: body
  };
}

function formatSaleSmartlyResponse(result, incoming) {
  const data = incoming.raw?.data || incoming.raw || {};

  return {
    code: 0,
    msg: "Success",
    data: {
      msg_type: 1,
      msg: result.reply,
      chat_user_id: data.chat_user_id || incoming.customer_id,
      chat_session_id: String(data.chat_session_id || incoming.session_id),
      send_time: String(Date.now()),
      channel: data.channel ?? incoming.channel,
      channel_uid: data.channel_uid || incoming.channel_uid,
      channel_name: data.channel_name || incoming.channel_name
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
