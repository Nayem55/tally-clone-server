const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dayjs = require("dayjs");
const { default: axios } = require("axios");
const crypto = require("crypto");

require("dotenv").config();

const app = express();

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://192.168.0.59:27017/Demo-pos";
const PORT = Number(process.env.PORT) || 15001;
const RATE_LIMIT_AUTH_WINDOW_MS = Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 5 * 60 * 1000;
const RATE_LIMIT_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX) || 20;
const RATE_LIMIT_WRITE_WINDOW_MS = Number(process.env.RATE_LIMIT_WRITE_WINDOW_MS) || 60 * 1000;
const RATE_LIMIT_WRITE_MAX = Number(process.env.RATE_LIMIT_WRITE_MAX) || 120;
const EMPLOYEE_SESSION_TTL_MS =
  Number(process.env.EMPLOYEE_SESSION_TTL_MS) || 12 * 60 * 60 * 1000;
const EMPLOYEE_SESSION_SECRET =
  process.env.EMPLOYEE_SESSION_SECRET ||
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update(String(MONGO_URI)).digest("hex");

function parseAllowedOrigins(value = "") {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:15000",
  "http://127.0.0.1:15000",
  "http://175.29.181.245:15000",
  "https://175.29.181.245:15000",
];

const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
]);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-user-context"],
  credentials: false,
  maxAge: 86400,
};

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use(express.json({ limit: "100mb" }));
app.use(cors(corsOptions));
app.use(/^\/companies\/[^/]+/, (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }

  return rateLimit({
    scope: "company-write",
    windowMs: RATE_LIMIT_WRITE_WINDOW_MS,
    max: RATE_LIMIT_WRITE_MAX,
    message: "Too many write requests. Please slow down and try again shortly.",
  })(req, res, next);
});

let db;
let Companies,
  Groups,
  Ledgers,
  VoucherTypes,
  Vouchers,
  AuditLogs,
  Boms,
  Customers,
  Employees,
  Items,
  pricelevels,
  Currencies,
  CostCategories,
  CostCentres,
  StockCategories,
  Units,
  Godowns;

const requestBuckets = new Map();

const STOCK_VOUCHER_FLOW = {
  purchase: 1,
  receipt_note: 1,
  credit_note: 1,
  sales: -1,
  pos_voucher: -1,
  delivery_note: -1,
  debit_note: -1,
};

function normalizeName(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

function slugifySegment(value = "") {
  return normalizeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nameKey(value = "") {
  return normalizeName(value).toLowerCase();
}

function moneyToCents(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100);
}

function centsToMoney(cents) {
  const numeric = Number(cents || 0);
  if (!Number.isFinite(numeric)) return 0;
  return numeric / 100;
}

function normalizeMoney(value) {
  return centsToMoney(moneyToCents(value));
}

function getVoucherTime(value) {
  return value ? new Date(value).getTime() : 0;
}

function sortVouchersByDateAscending(vouchers = []) {
  return vouchers.slice().sort((left, right) => {
    return getVoucherTime(left?.date) - getVoucherTime(right?.date);
  });
}

function sumMoney(...values) {
  return centsToMoney(
    values.reduce((sum, value) => sum + moneyToCents(value), 0),
  );
}

function subtractMoney(base, ...values) {
  return centsToMoney(
    values.reduce(
    (sum, value) => sum - moneyToCents(value),
    moneyToCents(base),
    ),
  );
}

function multiplyMoney(left, right) {
  return normalizeMoney(Number(left || 0) * Number(right || 0));
}

function divideMoney(dividend, divisor) {
  const numericDivisor = Number(divisor || 0);
  if (!numericDivisor) return 0;
  return normalizeMoney(Number(dividend || 0) / numericDivisor);
}

function moneyEquals(left, right) {
  return moneyToCents(left) === moneyToCents(right);
}

function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function getRateLimitKey(req, scope = "default") {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
  return `${scope}:${ip}`;
}

function applyRateLimit({ key, windowMs, max }) {
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || current.resetAt <= now) {
    const nextBucket = { count: 1, resetAt: now + windowMs };
    requestBuckets.set(key, nextBucket);
    return { allowed: true, remaining: Math.max(max - 1, 0), resetAt: nextBucket.resetAt };
  }

  current.count += 1;
  requestBuckets.set(key, current);
  return {
    allowed: current.count <= max,
    remaining: Math.max(max - current.count, 0),
    resetAt: current.resetAt,
  };
}

function rateLimit({ scope, windowMs, max, message }) {
  return (req, res, next) => {
    const key = getRateLimitKey(req, scope);
    const result = applyRateLimit({ key, windowMs, max });
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.resetAt - Date.now()) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        message: message || "Too many requests. Please wait a bit and try again.",
      });
    }

    return next();
  };
}

function hashCompanyPassword(password = "") {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 120000;
  const digest = "sha512";
  const hash = crypto
    .pbkdf2Sync(String(password), salt, iterations, 64, digest)
    .toString("hex");
  return { salt, hash, iterations, digest };
}

function verifyCompanyPassword(password = "", auth = {}) {
  if (!auth?.salt || !auth?.hash) return false;
  const derived = crypto.pbkdf2Sync(
    String(password),
    auth.salt,
    Number(auth.iterations || 120000),
    64,
    auth.digest || "sha512"
  );
  const expected = Buffer.from(auth.hash, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function toBase64Url(value = "") {
  return Buffer.from(String(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value = "") {
  const normalized = String(value)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function signEmployeeSessionPayload(payload = {}) {
  return crypto
    .createHmac("sha256", EMPLOYEE_SESSION_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function createEmployeeSessionToken(employee, company) {
  const now = Date.now();
  const payload = {
    sub: String(employee._id || ""),
    companyId: String(company._id || employee.companyId || ""),
    role: normalizeTextBlock(employee.accessControl?.role || ""),
    name: normalizeTextBlock(employee.name || ""),
    username: normalizeTextBlock(employee.accessControl?.username || ""),
    iat: now,
    exp: now + EMPLOYEE_SESSION_TTL_MS,
    jti: crypto.randomBytes(12).toString("hex"),
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signEmployeeSessionPayload(payload);
  return `${encodedPayload}.${signature}`;
}

function verifyEmployeeSessionToken(token = "") {
  const raw = String(token || "").trim();
  if (!raw || !raw.includes(".")) return null;
  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) return null;

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    const expectedSignature = signEmployeeSessionPayload(payload);
    const actualBuffer = Buffer.from(String(signature), "hex");
    const expectedBuffer = Buffer.from(String(expectedSignature), "hex");
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }

    if (!payload?.sub || !payload?.companyId || Number(payload.exp || 0) < Date.now()) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

function readBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function getVerifiedSessionActor(req) {
  if (req._verifiedSessionActor !== undefined) {
    return req._verifiedSessionActor;
  }

  const token = readBearerToken(req);
  const payload = verifyEmployeeSessionToken(token);
  if (!payload) {
    req._verifiedSessionActor = null;
    return null;
  }

  req._verifiedSessionActor = {
    id: payload.sub,
    name: payload.name || payload.username || "Unknown User",
    role: payload.role || "",
    companyId: payload.companyId,
    username: payload.username || "",
    tokenPayload: payload,
  };
  return req._verifiedSessionActor;
}

function sanitizeCompany(company) {
  if (!company) return null;
  const auth = company.auth || {};
  const { auth: _auth, ...rest } = company;
  return {
    ...rest,
    requiresCompanyLogin: Boolean(auth.enabled && auth.masterUsername),
    masterUsername: auth.enabled ? auth.masterUsername || "" : "",
  };
}

function getRequestActor(req) {
  const verifiedActor = getVerifiedSessionActor(req);
  if (verifiedActor) {
    return {
      id: verifiedActor.id || null,
      name: verifiedActor.name || "Unknown User",
      role: verifiedActor.role || "",
      number: "",
      companyId: verifiedActor.companyId || "",
      username: verifiedActor.username || "",
    };
  }

  try {
    const raw = req.headers["x-user-context"];
    if (!raw) return null;
    const user = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!user || typeof user !== "object") return null;
    return {
      id: user._id || user.id || user.userId || null,
      name:
        user.name ||
        user.fullName ||
        user.username ||
        user.number ||
        user.mobile ||
        "Unknown User",
      role: user.role || "",
      number: user.number || "",
      companyId: user.companyId || "",
      username: user.username || "",
    };
  } catch (error) {
    return null;
  }
}

function buildAuditStamp(actor) {
  const now = new Date();
  if (!actor) {
    return {
      at: now,
      by: null,
    };
  }
  return {
    at: now,
    by: {
      id: actor.id || null,
      name: actor.name || "Unknown User",
      role: actor.role || "",
      number: actor.number || "",
    },
  };
}

function activeVoucherFilter(filter = {}) {
  return {
    ...filter,
    isDeleted: { $ne: true },
  };
}

function activeVoucherMatch(filter = {}) {
  return activeVoucherFilter(filter);
}

async function logAuditEvent({
  companyId,
  entityType,
  entityId,
  action,
  actor,
  before = null,
  after = null,
}) {
  if (!AuditLogs) return;
  try {
    await AuditLogs.insertOne({
      companyId,
      entityType,
      entityId,
      action,
      actor: buildAuditStamp(actor).by,
      before,
      after,
      at: new Date(),
    });
  } catch (error) {
    console.error("Error writing audit log:", error);
  }
}

function splitBalance(amount) {
  const amountCents = moneyToCents(amount);
  if (amountCents >= 0) {
    return { debit: centsToMoney(amountCents), credit: 0 };
  }
  return { debit: 0, credit: centsToMoney(Math.abs(amountCents)) };
}

function inferStockDirection(voucherName = "") {
  const key = nameKey(voucherName).replace(/[\s-]+/g, "_");
  return STOCK_VOUCHER_FLOW[key] || 0;
}

function getPartyMovementDescriptor(voucherName = "") {
  const key = nameKey(voucherName);
  if (key === "purchase" || key === "receipt note") {
    return { bucket: "inward", sign: 1, directionLabel: "Purchase" };
  }
  if (key === "debit note") {
    return { bucket: "inward", sign: -1, directionLabel: "Purchase Return" };
  }
  if (
    key === "sales" ||
    key === "pos voucher" ||
    key === "delivery note"
  ) {
    return { bucket: "outward", sign: 1, directionLabel: "Sale" };
  }
  if (key === "credit note") {
    return { bucket: "outward", sign: -1, directionLabel: "Sales Return" };
  }
  return null;
}

function getStockReportMovementDescriptor(voucherName = "", line = {}) {
  const partyDescriptor = getPartyMovementDescriptor(voucherName);
  if (partyDescriptor) {
    return {
      bucket: partyDescriptor.bucket,
      sign: partyDescriptor.sign,
      directionLabel: partyDescriptor.directionLabel,
      affectsRate:
        partyDescriptor.bucket === "inward" && partyDescriptor.sign > 0,
    };
  }

  const explicit = nameKey(line.direction || "");
  if (["in", "inward"].includes(explicit)) {
    return {
      bucket: "inward",
      sign: 1,
      directionLabel: "IN",
      affectsRate: true,
    };
  }
  if (["out", "outward"].includes(explicit)) {
    return {
      bucket: "outward",
      sign: 1,
      directionLabel: "OUT",
      affectsRate: false,
    };
  }

  const rawDirection = inferStockDirection(voucherName);
  if (rawDirection > 0) {
    return {
      bucket: "inward",
      sign: 1,
      directionLabel: "IN",
      affectsRate: true,
    };
  }
  if (rawDirection < 0) {
    return {
      bucket: "outward",
      sign: 1,
      directionLabel: "OUT",
      affectsRate: false,
    };
  }
  return null;
}

function inventoryRoleKey(value = "") {
  const key = nameKey(value).replace(/[\s-]+/g, "_");
  if (["raw_material", "rawmaterial", "raw"].includes(key))
    return "raw_material";
  if (["finished_good", "finishedgoods", "finished"].includes(key))
    return "finished_good";
  return "standard";
}

function itemMatchesRoleFilter(item = {}, options = {}) {
  const role = inventoryRoleKey(item.inventoryRole);
  const includeRoles = Array.isArray(options.includeRoles)
    ? options.includeRoles.map(inventoryRoleKey)
    : null;
  const excludeRoles = Array.isArray(options.excludeRoles)
    ? options.excludeRoles.map(inventoryRoleKey)
    : [];

  if (includeRoles && includeRoles.length > 0 && !includeRoles.includes(role)) {
    return false;
  }

  if (excludeRoles.includes(role)) {
    return false;
  }

  return true;
}

function getInventoryLineDirection(line = {}, voucherName = "") {
  const explicit = nameKey(line.direction || "");
  if (["in", "inward"].includes(explicit)) return 1;
  if (["out", "outward"].includes(explicit)) return -1;
  return inferStockDirection(voucherName);
}

function normalizeInventoryLinePayload(line = {}) {
  const qty = Number(line.qty) || 0;
  const rate = Number(line.rate) || 0;
  return {
    itemId: new ObjectId(line.itemId),
    itemName: normalizeName(line.itemName || line.productSnapshot?.name || ""),
    qty,
    rate,
    amount: Number(line.amount) || qty * rate,
    billedQty: Number(line.billedQty) || qty,
    discount: Number(line.discount) || 0,
    mrpRate: Number(line.mrpRate) || rate,
    discountType: line.discountType || "fixed",
    discountValue: Number(line.discountValue) || 0,
    direction:
      getInventoryLineDirection(line) > 0
        ? "IN"
        : getInventoryLineDirection(line) < 0
        ? "OUT"
        : "",
    groupId:
      line.groupId && ObjectId.isValid(line.groupId)
        ? new ObjectId(line.groupId)
        : null,
    groupName: normalizeName(line.groupName),
    stockCategoryId:
      line.stockCategoryId && ObjectId.isValid(line.stockCategoryId)
        ? new ObjectId(line.stockCategoryId)
        : null,
    stockCategoryName: normalizeName(line.stockCategoryName),
    alias: normalizeName(line.alias),
    barcode: normalizeName(line.barcode),
    godownId:
      line.godownId && ObjectId.isValid(line.godownId)
        ? new ObjectId(line.godownId)
        : null,
    godownName: normalizeName(line.godownName),
    toGodownId:
      line.toGodownId && ObjectId.isValid(line.toGodownId)
        ? new ObjectId(line.toGodownId)
        : null,
    toGodownName: normalizeName(line.toGodownName),
  };
}

function normalizeManufacturingMeta(meta = {}) {
  if (!meta) return null;
  return {
    bomId:
      meta.bomId && ObjectId.isValid(meta.bomId)
        ? new ObjectId(meta.bomId)
        : null,
    bomName: normalizeName(meta.bomName || ""),
    outputItemId:
      meta.outputItemId && ObjectId.isValid(meta.outputItemId)
        ? new ObjectId(meta.outputItemId)
        : null,
    outputItemName: normalizeName(meta.outputItemName || ""),
    outputQty: normalizeMoney(meta.outputQty || 0),
    componentCost: normalizeMoney(meta.componentCost || 0),
    additionalCost: normalizeMoney(meta.additionalCost || 0),
    totalCost: normalizeMoney(meta.totalCost || 0),
    effectiveRate: normalizeMoney(meta.effectiveRate || 0),
    notes: normalizeTextBlock(meta.notes || ""),
  };
}

function normalizeSalesMeta(meta = {}) {
  if (!meta) return null;
  const employeeName = normalizeName(meta.employeeName || "");
  const employeeNumber = normalizeTextBlock(meta.employeeNumber || "");
  const employeeId =
    meta.employeeId && ObjectId.isValid(meta.employeeId)
      ? new ObjectId(meta.employeeId)
      : null;

  if (!employeeId && !employeeName && !employeeNumber) {
    return null;
  }

  return {
    employeeId,
    employeeName,
    employeeNumber,
    department: normalizeTextBlock(meta.department || ""),
    designation: normalizeTextBlock(meta.designation || ""),
  };
}

function salesPersonKeyFromMeta(meta = {}) {
  if (!meta) return "unassigned";
  return (
    String(meta.employeeId || "") ||
    normalizeTextBlock(meta.employeeNumber || "") ||
    normalizeName(meta.employeeName || "").toLowerCase() ||
    "unassigned"
  );
}

function voucherMatchesSalesPerson(voucher = {}, salesPersonId = "") {
  if (!salesPersonId) return true;
  return (
    salesPersonKeyFromMeta(voucher.salesMeta || {}) === String(salesPersonId)
  );
}

function isSalesPersonTrackedVoucherName(value = "") {
  const key = normalizeName(value || "").toLowerCase();
  return key === "sales" || key === "pos voucher";
}

function formatProductionNumber(companyName = "", currentCount = 0) {
  const companySlug = slugifySegment(companyName || "company") || "company";
  return `${companySlug}-manufacturing-${String(currentCount + 1).padStart(
    2,
    "0",
  )}`;
}

function safeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function voucherTotalAmount(voucher) {
  const commercialTotal = Number(voucher.commercialMeta?.totalAmount || 0);
  if (commercialTotal > 0) return normalizeMoney(commercialTotal);

  const posTotal = Number(voucher.posMeta?.totalAmount || 0);
  if (posTotal > 0) return normalizeMoney(posTotal);

  const accountingTotal = (voucher.lines || []).reduce(
    (sum, line) =>
      Math.max(
        sum,
        moneyToCents(line.debit || 0),
        moneyToCents(line.credit || 0),
      ),
    0,
  );
  if (accountingTotal > 0) return centsToMoney(accountingTotal);

  const inventoryTotal = (voucher.inventoryLines || []).reduce(
    (sum, line) => sum + moneyToCents(line.amount || 0),
    0,
  );
  if (inventoryTotal > 0) return centsToMoney(inventoryTotal);

  return 0;
}

function getAccountingReportLines(voucher) {
  const voucherNameKey = nameKey(voucher?.voucherName || "");
  const shouldSwapDebitCredit =
    voucherNameKey === "credit note" || voucherNameKey === "debit note";

  return (voucher?.lines || []).map((line, lineIndex) => {
    let debit = Number(line?.debit || 0);
    let credit = Number(line?.credit || 0);

    if (shouldSwapDebitCredit) {
      [debit, credit] = [credit, debit];
    }

    return {
      ...line,
      debit: normalizeMoney(debit),
      credit: normalizeMoney(credit),
      __reportLineIndex: lineIndex,
    };
  });
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTextBlock(value = "") {
  return String(value || "").trim();
}

function toBoolean(value) {
  return Boolean(value);
}

function normalizeBankLedgerDetails(details = {}) {
  if (!details || typeof details !== "object") return null;

  const normalized = {
    accountHolderName: normalizeTextBlock(details.accountHolderName || ""),
    accountNumber: normalizeTextBlock(details.accountNumber || ""),
    bankCode: normalizeTextBlock(details.bankCode || ""),
    swiftCode: normalizeTextBlock(details.swiftCode || ""),
    bankName: normalizeTextBlock(details.bankName || ""),
    branchName: normalizeTextBlock(details.branchName || ""),
    branchCode: normalizeTextBlock(details.branchCode || ""),
    bankConfigurationEnabled: toBoolean(details.bankConfigurationEnabled),
    mailingName: normalizeTextBlock(details.mailingName || ""),
    mailingAddress: normalizeTextBlock(details.mailingAddress || ""),
    division: normalizeTextBlock(details.division || ""),
    country: normalizeTextBlock(details.country || ""),
    postalCode: normalizeTextBlock(details.postalCode || ""),
  };

  const hasMeaningfulValue = Object.entries(normalized).some(([key, value]) =>
    key === "bankConfigurationEnabled" ? value === true : Boolean(value),
  );

  return hasMeaningfulValue ? normalized : null;
}

function buildGroupChildrenMap(groups = []) {
  const childMap = new Map();
  groups.forEach((group) => {
    const parentKey = group.parentId ? String(group.parentId) : "ROOT";
    if (!childMap.has(parentKey)) childMap.set(parentKey, []);
    childMap.get(parentKey).push(group);
  });
  return childMap;
}

function collectDescendantGroupIds(rootIds = [], childMap = new Map()) {
  const visited = new Set();
  const stack = [...rootIds.map((value) => String(value || ""))].filter(
    Boolean,
  );

  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const children = childMap.get(currentId) || [];
    children.forEach((child) => stack.push(String(child._id)));
  }

  return [...visited];
}

async function getGroupBranchObjectIds(companyId, rootGroupId) {
  const groups = await Groups.find(
    { companyId },
    { projection: { _id: 1, parentId: 1 } },
  ).toArray();
  const childMap = buildGroupChildrenMap(groups);
  return collectDescendantGroupIds([rootGroupId], childMap)
    .filter((value) => ObjectId.isValid(value))
    .map((value) => new ObjectId(value));
}

function summarizeSalaryHeads(heads = []) {
  const totalEarnings = normalizeMoney(
    heads
      .filter((head) => nameKey(head.section) !== "deduction")
      .reduce((sum, head) => sum + (Number(head.rate) || 0), 0),
  );
  const totalDeductions = normalizeMoney(
    heads
      .filter((head) => nameKey(head.section) === "deduction")
      .reduce((sum, head) => sum + (Number(head.rate) || 0), 0),
  );
  const grossSalary = normalizeMoney(totalEarnings + totalDeductions);
  const netPayable = normalizeMoney(totalEarnings - totalDeductions);

  return {
    grossSalary,
    totalEarnings,
    totalDeductions,
    netPayable,
  };
}

function normalizeEmployeePayload(payload = {}, { employeeNumber = "" } = {}) {
  const general = payload.general || payload || {};
  const personalDetails = payload.personalDetails || {};
  const contactDetails = payload.contactDetails || {};
  const otherDetails = payload.otherDetails || {};
  const salaryDetails = payload.salaryDetails || {};
  const bankDetails = payload.bankDetails || {};
  const statutoryDetails = payload.statutoryDetails || {};
  const additionalInformation = payload.additionalInformation || {};
  const accessControl = payload.accessControl || {};

  const payHeads = (salaryDetails.payHeads || []).map((head, index) => ({
    id: normalizeTextBlock(head.id) || `head-${index + 1}`,
    section: nameKey(head.section) === "deduction" ? "Deduction" : "Earning",
    name: normalizeName(head.name),
    rate: Number(head.rate || 0),
    per: normalizeName(head.per) || "Month",
    payHeadType: normalizeName(head.payHeadType) || "Start Afresh",
    calculationType: normalizeName(head.calculationType) || "As Per Rate",
    computedOn: normalizeTextBlock(head.computedOn),
  }));

  return {
    name: normalizeName(general.name),
    alias: normalizeTextBlock(general.alias),
    under: normalizeName(general.under),
    underCategory: normalizeTextBlock(general.underCategory),
    employeeNumber:
      normalizeTextBlock(general.employeeNumber) || employeeNumber,
    dateOfJoining: normalizeTextBlock(general.dateOfJoining),
    defineSalaryDetails: toBoolean(general.defineSalaryDetails),
    photoName: normalizeTextBlock(general.photoName),
    personalDetails: {
      designation: normalizeTextBlock(personalDetails.designation),
      functionName: normalizeTextBlock(personalDetails.functionName),
      location: normalizeTextBlock(personalDetails.location),
      gender: normalizeTextBlock(personalDetails.gender),
      dateOfBirth: normalizeTextBlock(personalDetails.dateOfBirth),
      bloodGroup: normalizeTextBlock(personalDetails.bloodGroup),
      fatherOrMotherName: normalizeTextBlock(
        personalDetails.fatherOrMotherName,
      ),
      spouseName: normalizeTextBlock(personalDetails.spouseName),
      address: normalizeTextBlock(personalDetails.address),
    },
    contactDetails: {
      phoneCountryCode:
        normalizeTextBlock(contactDetails.phoneCountryCode) || "+880",
      phoneNumber: normalizeTextBlock(contactDetails.phoneNumber),
      email: normalizeTextBlock(contactDetails.email),
    },
    otherDetails: {
      department: normalizeTextBlock(otherDetails.department),
      employeeType: normalizeTextBlock(otherDetails.employeeType),
      status: normalizeTextBlock(otherDetails.status),
      grade: normalizeTextBlock(otherDetails.grade),
      reportingTo: normalizeTextBlock(otherDetails.reportingTo),
      classification: normalizeTextBlock(otherDetails.classification),
    },
    salaryDetails: {
      paymentFrequency: normalizeTextBlock(salaryDetails.paymentFrequency),
      paymentMode: normalizeTextBlock(salaryDetails.paymentMode),
      effectiveFrom: normalizeTextBlock(salaryDetails.effectiveFrom),
      comments: normalizeTextBlock(salaryDetails.comments),
      payHeads,
    },
    bankDetails: {
      provideBankDetails: toBoolean(bankDetails.provideBankDetails),
      bankAccountNo: normalizeTextBlock(bankDetails.bankAccountNo),
      accountHolderName: normalizeTextBlock(bankDetails.accountHolderName),
      bankName: normalizeTextBlock(bankDetails.bankName),
      mobileBankingNo: normalizeTextBlock(bankDetails.mobileBankingNo),
      branchName: normalizeTextBlock(bankDetails.branchName),
      swiftCode: normalizeTextBlock(bankDetails.swiftCode),
      routingNo: normalizeTextBlock(bankDetails.routingNo),
      ibanNo: normalizeTextBlock(bankDetails.ibanNo),
      accountType: normalizeTextBlock(bankDetails.accountType),
      currency: normalizeTextBlock(bankDetails.currency),
    },
    statutoryDetails: {
      identity: {
        nid: normalizeTextBlock(statutoryDetails.identity?.nid),
        tin: normalizeTextBlock(statutoryDetails.identity?.tin),
        passport: normalizeTextBlock(statutoryDetails.identity?.passport),
      },
      tax: {
        applicable: toBoolean(statutoryDetails.tax?.applicable),
        category: normalizeTextBlock(statutoryDetails.tax?.category),
        rate: Number(statutoryDetails.tax?.rate || 0),
      },
      pf: {
        applicable: toBoolean(statutoryDetails.pf?.applicable),
        number: normalizeTextBlock(statutoryDetails.pf?.number),
        contribution: Number(statutoryDetails.pf?.contribution || 0),
      },
      esi: {
        applicable: toBoolean(statutoryDetails.esi?.applicable),
        number: normalizeTextBlock(statutoryDetails.esi?.number),
      },
      professionalTax: Number(statutoryDetails.professionalTax || 0),
      gratuityEligible: toBoolean(statutoryDetails.gratuityEligible),
      lwfApplicable: toBoolean(statutoryDetails.lwfApplicable),
      lwfNumber: normalizeTextBlock(statutoryDetails.lwfNumber),
      compliance: {
        incomeTaxRegime: normalizeTextBlock(
          statutoryDetails.compliance?.incomeTaxRegime,
        ),
        panNumber: normalizeTextBlock(statutoryDetails.compliance?.panNumber),
        uanNumber: normalizeTextBlock(statutoryDetails.compliance?.uanNumber),
        dateOfBirth: normalizeTextBlock(
          statutoryDetails.compliance?.dateOfBirth,
        ),
      },
      documents: {
        idProof: normalizeTextBlock(statutoryDetails.documents?.idProof),
        taxDocument: normalizeTextBlock(
          statutoryDetails.documents?.taxDocument,
        ),
        pfDocument: normalizeTextBlock(statutoryDetails.documents?.pfDocument),
        otherDocument: normalizeTextBlock(
          statutoryDetails.documents?.otherDocument,
        ),
      },
      notes: normalizeTextBlock(statutoryDetails.notes),
    },
    additionalInformation: {
      employmentDetails: {
        employeeType: normalizeTextBlock(
          additionalInformation.employmentDetails?.employeeType,
        ),
        employmentStatus: normalizeTextBlock(
          additionalInformation.employmentDetails?.employmentStatus,
        ),
        probationPeriodDays: Number(
          additionalInformation.employmentDetails?.probationPeriodDays || 0,
        ),
        confirmationDate: normalizeTextBlock(
          additionalInformation.employmentDetails?.confirmationDate,
        ),
      },
      workDetails: {
        workLocation: normalizeTextBlock(
          additionalInformation.workDetails?.workLocation,
        ),
        department: normalizeTextBlock(
          additionalInformation.workDetails?.department,
        ),
        reportingTo: normalizeTextBlock(
          additionalInformation.workDetails?.reportingTo,
        ),
        jobTitle: normalizeTextBlock(
          additionalInformation.workDetails?.jobTitle,
        ),
      },
      leaveAttendance: {
        leavePolicy: normalizeTextBlock(
          additionalInformation.leaveAttendance?.leavePolicy,
        ),
        weeklyOff: normalizeTextBlock(
          additionalInformation.leaveAttendance?.weeklyOff,
        ),
        attendanceType: normalizeTextBlock(
          additionalInformation.leaveAttendance?.attendanceType,
        ),
        defaultLeaveBalanceDays: Number(
          additionalInformation.leaveAttendance?.defaultLeaveBalanceDays || 0,
        ),
      },
      skillsQualifications: {
        highestEducation: normalizeTextBlock(
          additionalInformation.skillsQualifications?.highestEducation,
        ),
        professionalQualification: normalizeTextBlock(
          additionalInformation.skillsQualifications?.professionalQualification,
        ),
        skills: normalizeTextBlock(
          additionalInformation.skillsQualifications?.skills,
        ),
      },
      emergencyContact: {
        name: normalizeTextBlock(additionalInformation.emergencyContact?.name),
        relationship: normalizeTextBlock(
          additionalInformation.emergencyContact?.relationship,
        ),
        phone: normalizeTextBlock(
          additionalInformation.emergencyContact?.phone,
        ),
        address: normalizeTextBlock(
          additionalInformation.emergencyContact?.address,
        ),
      },
      previousEmployment: {
        employer: normalizeTextBlock(
          additionalInformation.previousEmployment?.employer,
        ),
        designation: normalizeTextBlock(
          additionalInformation.previousEmployment?.designation,
        ),
        totalExperienceYears: Number(
          additionalInformation.previousEmployment?.totalExperienceYears || 0,
        ),
        relevantExperienceYears: Number(
          additionalInformation.previousEmployment?.relevantExperienceYears ||
            0,
        ),
      },
      otherInformation: {
        maritalStatus: normalizeTextBlock(
          additionalInformation.otherInformation?.maritalStatus,
        ),
        nationality: normalizeTextBlock(
          additionalInformation.otherInformation?.nationality,
        ),
        religion: normalizeTextBlock(
          additionalInformation.otherInformation?.religion,
        ),
        languages: normalizeTextBlock(
          additionalInformation.otherInformation?.languages,
        ),
        hobbies: normalizeTextBlock(
          additionalInformation.otherInformation?.hobbies,
        ),
      },
    },
    accessControl: {
      loginEnabled: toBoolean(accessControl.loginEnabled),
      username: normalizeTextBlock(accessControl.username),
      role: normalizeTextBlock(accessControl.role),
      status: normalizeTextBlock(accessControl.status) || "Active",
    },
    summary: summarizeSalaryHeads(payHeads),
    updatedAt: new Date(),
  };
}

function sanitizeEmployee(row = null) {
  if (!row) return null;
  const { auth, ...rest } = row;
  return {
    ...rest,
    accessControl: {
      ...(rest.accessControl || {}),
      hasPassword: Boolean(auth?.hash),
      password: "",
      confirmPassword: "",
    },
  };
}

function buildEmployeeSessionUser(employee = null, company = null) {
  if (!employee) return null;
  return {
    _id: String(employee._id || ""),
    employeeId: String(employee._id || ""),
    companyId: String(employee.companyId || company?._id || ""),
    companyName: company?.name || "",
    name: employee.name || "",
    username: employee.accessControl?.username || "",
    role: employee.accessControl?.role || "Viewer",
    designation: employee.personalDetails?.designation || "",
    employeeNumber: employee.employeeNumber || "",
    loginType: "employee",
    attendance_id: String(employee._id || ""),
  };
}

function normalizeRole(role = "") {
  return String(role || "").trim().toLowerCase();
}

const ROLE_GROUPS = {
  companyAdmin: ["admin", "supervisor"],
  accountingMasters: ["admin", "supervisor", "accountant"],
  groupMasters: ["admin", "supervisor", "accountant", "store operator"],
  inventoryMasters: ["admin", "supervisor", "store operator"],
  priceManagement: ["admin", "supervisor", "accountant", "store operator"],
  accountingVouchers: [
    "admin",
    "supervisor",
    "accountant",
    "cashier",
    "sales operator",
    "store operator",
  ],
  inventoryVouchers: ["admin", "supervisor", "store operator"],
  payrollMasters: ["admin", "supervisor"],
};

async function resolveAuthorizedEmployee(companyId, req) {
  const employeeCount = await Employees.countDocuments({ companyId });
  if (employeeCount === 0) {
    return { ok: true, bypass: true, employee: null };
  }

  const actor = getVerifiedSessionActor(req);
  if (!actor?.id) {
    return {
      ok: false,
      status: 401,
      message: "Employee login is required for this company.",
    };
  }

  let employeeId = null;
  try {
    employeeId = new ObjectId(actor.id);
  } catch (error) {
    return {
      ok: false,
      status: 401,
      message: "Employee session is invalid. Please sign in again.",
    };
  }

  const employee = await Employees.findOne({ _id: employeeId, companyId });
  if (!employee) {
    return {
      ok: false,
      status: 403,
      message: "Employee session does not belong to this company.",
    };
  }

  if (!employee.accessControl?.loginEnabled) {
    return {
      ok: false,
      status: 403,
      message: "Employee login is not enabled for this account.",
    };
  }

  if (normalizeName(employee.accessControl?.status) === "inactive") {
    return {
      ok: false,
      status: 403,
      message: "This employee login is inactive.",
    };
  }

  return { ok: true, bypass: false, employee, actor };
}

function requireCompanyWriteAccess(allowedRoles = []) {
  const normalizedAllowedRoles = allowedRoles.map(normalizeRole);

  return async (req, res, next) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const authResult = await resolveAuthorizedEmployee(companyId, req);

      if (!authResult.ok) {
        return res
          .status(authResult.status || 403)
          .json({ message: authResult.message || "Access denied." });
      }

      if (authResult.bypass) {
        req.employeeActor = null;
        req.authActor = null;
        return next();
      }

      const role = normalizeRole(authResult.employee?.accessControl?.role);
      if (
        normalizedAllowedRoles.length > 0 &&
        !normalizedAllowedRoles.includes(role)
      ) {
        return res.status(403).json({
          message: "Your employee role is not allowed to perform this action.",
        });
      }

      req.employeeActor = authResult.employee;
      req.authActor = authResult.actor || getRequestActor(req);
      return next();
    } catch (error) {
      console.error("Error enforcing employee write access:", error);
      return res.status(500).json({ message: "Unable to verify access rights." });
    }
  };
}

const requireCompanyReadAccess = requireCompanyWriteAccess;

async function generateEmployeeNumber(companyId) {
  const rows = await Employees.find(
    { companyId },
    { projection: { employeeNumber: 1 } },
  ).toArray();

  let next = rows.length + 1;
  const used = new Set(
    rows.map((row) => normalizeTextBlock(row.employeeNumber)).filter(Boolean),
  );

  while (used.has(`EMP${String(next).padStart(4, "0")}`)) {
    next += 1;
  }

  return `EMP${String(next).padStart(4, "0")}`;
}

async function resolveMasterName(collection, companyId, idOrName) {
  if (!idOrName) return "";
  const asText = normalizeName(idOrName);
  if (!asText) return "";
  if (ObjectId.isValid(asText)) {
    const row = await collection.findOne({
      _id: new ObjectId(asText),
      companyId,
    });
    if (row?.name) return row.name;
  }
  return asText;
}

function summarizeLedgerBalances(ledgers, vouchers, fromDate, toDate) {
  const openingMap = new Map();
  const periodMap = new Map();
  const fromTime = fromDate ? fromDate.getTime() : null;
  const toTime = toDate ? toDate.getTime() : null;

  vouchers.forEach((voucher) => {
    const voucherTime = getVoucherTime(voucher?.date);
    const hasVoucherTime = voucherTime !== 0;
    const beforePeriod =
      fromTime !== null && hasVoucherTime ? voucherTime < fromTime : false;
    const inPeriod =
      (fromTime === null || (hasVoucherTime && voucherTime >= fromTime)) &&
      (toTime === null || (hasVoucherTime && voucherTime <= toTime));

    getAccountingReportLines(voucher).forEach((line) => {
      const ledgerKey = String(line.ledgerId);
      if (beforePeriod) {
        const current = openingMap.get(ledgerKey) || 0;
        openingMap.set(
          ledgerKey,
          current + moneyToCents(line.debit || 0) - moneyToCents(line.credit || 0),
        );
      }

      if (inPeriod) {
        const current = periodMap.get(ledgerKey) || { debitCents: 0, creditCents: 0 };
        current.debitCents += moneyToCents(line.debit || 0);
        current.creditCents += moneyToCents(line.credit || 0);
        periodMap.set(ledgerKey, current);
      }
    });
  });

  return ledgers.map((ledger) => {
    const openingMovementCents = openingMap.get(String(ledger._id)) || 0;
    const fixedOpeningCents =
      (ledger.openingDrCr === "DR" ? 1 : -1) *
      moneyToCents(ledger.openingBalance || 0);
    const openingCents = fixedOpeningCents + openingMovementCents;
    const periodMovement = periodMap.get(String(ledger._id)) || {
      debitCents: 0,
      creditCents: 0,
    };
    const debit = centsToMoney(periodMovement.debitCents || 0);
    const credit = centsToMoney(periodMovement.creditCents || 0);
    const closingCents =
      openingCents +
      (periodMovement.debitCents || 0) -
      (periodMovement.creditCents || 0);
    const opening = centsToMoney(openingCents);
    const closing = centsToMoney(closingCents);

    return {
      ...ledger,
      opening,
      openingDebit: splitBalance(opening).debit,
      openingCredit: splitBalance(opening).credit,
      debit,
      credit,
      closing,
      closingDebit: splitBalance(closing).debit,
      closingCredit: splitBalance(closing).credit,
    };
  });
}

function buildGroupedBalanceTree(groups, ledgerBalances) {
  const groupsById = new Map(groups.map((group) => [String(group._id), group]));
  const childrenMap = new Map();
  groups.forEach((group) => {
    const key = group.parentId ? String(group.parentId) : "ROOT";
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key).push(group);
  });

  const ledgersByGroup = new Map();
  ledgerBalances.forEach((ledger) => {
    const key = String(ledger.groupId);
    if (!ledgersByGroup.has(key)) ledgersByGroup.set(key, []);
    ledgersByGroup.get(key).push(ledger);
  });

  for (const children of childrenMap.values()) {
    children.sort((left, right) => left.name.localeCompare(right.name));
  }

  function aggregateGroup(group) {
    const directLedgers = ledgersByGroup.get(String(group._id)) || [];
    const childGroups = (childrenMap.get(String(group._id)) || []).map(
      aggregateGroup,
    );

    const totals = {
      openingDebit: 0,
      openingCredit: 0,
      debit: 0,
      credit: 0,
      closingDebit: 0,
      closingCredit: 0,
    };

    directLedgers.forEach((ledger) => {
      totals.openingDebit = normalizeMoney(
        totals.openingDebit + ledger.openingDebit,
      );
      totals.openingCredit = normalizeMoney(
        totals.openingCredit + ledger.openingCredit,
      );
      totals.debit = normalizeMoney(totals.debit + ledger.debit);
      totals.credit = normalizeMoney(totals.credit + ledger.credit);
      totals.closingDebit = normalizeMoney(
        totals.closingDebit + ledger.closingDebit,
      );
      totals.closingCredit = normalizeMoney(
        totals.closingCredit + ledger.closingCredit,
      );
    });

    childGroups.forEach((child) => {
      totals.openingDebit = normalizeMoney(
        totals.openingDebit + child.totals.openingDebit,
      );
      totals.openingCredit = normalizeMoney(
        totals.openingCredit + child.totals.openingCredit,
      );
      totals.debit = normalizeMoney(totals.debit + child.totals.debit);
      totals.credit = normalizeMoney(totals.credit + child.totals.credit);
      totals.closingDebit = normalizeMoney(
        totals.closingDebit + child.totals.closingDebit,
      );
      totals.closingCredit = normalizeMoney(
        totals.closingCredit + child.totals.closingCredit,
      );
    });

    return {
      id: group._id,
      name: group.name,
      parentId: group.parentId || null,
      nature: group.nature,
      level: 0,
      totals,
      ledgers: directLedgers
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((ledger) => ({
          id: ledger._id,
          name: ledger.name,
          groupId: ledger.groupId,
          groupName: groupsById.get(String(ledger.groupId))?.name || "",
          type: "ledger",
          totals: {
            openingDebit: ledger.openingDebit,
            openingCredit: ledger.openingCredit,
            debit: ledger.debit,
            credit: ledger.credit,
            closingDebit: ledger.closingDebit,
            closingCredit: ledger.closingCredit,
          },
        })),
      children: childGroups,
      type: "group",
    };
  }

  return (childrenMap.get("ROOT") || []).map(aggregateGroup);
}

function flattenGroupTree(tree, level = 0) {
  const rows = [];
  tree.forEach((node) => {
    rows.push({ ...node, level });
    node.ledgers.forEach((ledger) =>
      rows.push({
        ...ledger,
        level: level + 1,
        parentGroupId: node.id,
      }),
    );
    rows.push(...flattenGroupTree(node.children, level + 1));
  });
  return rows;
}

function buildProfitLossSnapshot({
  balances,
  vouchers,
  stockSummary,
  groupMap,
  fromDate,
  toDate,
}) {
  const incomes = [];
  const expenses = [];

  balances.forEach((ledger) => {
    const group = groupMap.get(String(ledger.groupId)) || ledger.group;
    const amount =
      group?.nature === "INCOME"
        ? normalizeMoney((ledger.credit || 0) - (ledger.debit || 0))
        : normalizeMoney((ledger.debit || 0) - (ledger.credit || 0));

    const row = {
      ledgerId: ledger._id,
      ledgerName: ledger.name,
      groupName: group?.name || "",
      amount: normalizeMoney(Math.max(amount, 0)),
      affectsGrossProfit: Boolean(group?.affectsGrossProfit),
    };

    if (
      group?.nature === "INCOME" &&
      !row.affectsGrossProfit &&
      row.amount > 0
    ) {
      incomes.push(row);
    }

    // Treat every EXPENSE nature ledger as an expense hit to profit,
    // except purchase accounts because purchase/stock cost is already
    // reflected through COGS in the trading section.
    if (
      group?.nature === "EXPENSE" &&
      nameKey(group?.name || "") !== "purchase accounts" &&
      row.amount > 0
    ) {
      expenses.push(row);
    }
  });

  const periodVouchers = vouchers.filter((voucher) => {
    const voucherDate = voucher?.date ? new Date(voucher.date) : null;
    return (
      (!fromDate || (voucherDate && voucherDate >= fromDate)) &&
      (!toDate || (voucherDate && voucherDate <= toDate))
    );
  });

  const voucherTotals = {
    sales: 0,
    salesReturns: 0,
    purchases: 0,
    purchaseReturns: 0,
  };

  periodVouchers.forEach((voucher) => {
    const name = nameKey(voucher.voucherName || "");
    const amount = voucherTotalAmount(voucher);
    if (name === "sales" || name === "pos voucher") {
      voucherTotals.sales = normalizeMoney(voucherTotals.sales + amount);
    } else if (name === "credit note") {
      voucherTotals.salesReturns = normalizeMoney(
        voucherTotals.salesReturns + amount,
      );
    } else if (name === "purchase") {
      voucherTotals.purchases = normalizeMoney(
        voucherTotals.purchases + amount,
      );
    } else if (name === "debit note") {
      voucherTotals.purchaseReturns = normalizeMoney(
        voucherTotals.purchaseReturns + amount,
      );
    }
  });

  const openingStock = normalizeMoney(
    (stockSummary.rows || []).reduce(
      (sum, row) => sum + Number(row.openingValue || 0),
      0,
    ),
  );
  const closingStock = normalizeMoney(
    (stockSummary.rows || []).reduce(
      (sum, row) => sum + Number(row.closingValue || 0),
      0,
    ),
  );
  const netSales = normalizeMoney(
    voucherTotals.sales - voucherTotals.salesReturns,
  );
  const netPurchases = normalizeMoney(
    voucherTotals.purchases - voucherTotals.purchaseReturns,
  );
  const costOfGoodsSold = normalizeMoney(
    openingStock + netPurchases - closingStock,
  );
  const grossProfit = normalizeMoney(netSales - costOfGoodsSold);
  const indirectIncome = incomes.reduce(
    (sum, row) => normalizeMoney(sum + row.amount),
    0,
  );
  const totalExpense = expenses.reduce(
    (sum, row) => normalizeMoney(sum + row.amount),
    0,
  );
  const netProfit = normalizeMoney(
    grossProfit + indirectIncome - totalExpense,
  );
  const profitMargin = netSales
    ? normalizeMoney((netProfit / netSales) * 100)
    : 0;

  return {
    incomes,
    expenses,
    trading: {
      sales: voucherTotals.sales,
      salesReturns: voucherTotals.salesReturns,
      netSales,
      openingStock,
      purchases: voucherTotals.purchases,
      purchaseReturns: voucherTotals.purchaseReturns,
      netPurchases,
      closingStock,
      costOfGoodsSold,
      grossProfit,
    },
    totals: {
      grossIncome: netSales,
      grossExpense: costOfGoodsSold,
      grossProfit,
      netIncome: indirectIncome,
      netExpense: totalExpense,
      netProfit,
      profitMargin,
    },
  };
}

function summarizeDashboardBalances(balances) {
  const summary = {
    cashBank: 0,
    receivables: 0,
    payables: 0,
    salesTotal: 0,
    purchaseTotal: 0,
    directIncome: 0,
    directExpense: 0,
    indirectIncome: 0,
    indirectExpense: 0,
    currentAssets: 0,
    currentLiabilities: 0,
    cashInHandTotal: 0,
    bankBalanceTotal: 0,
    bankLedgers: [],
  };

  balances.forEach((row) => {
    const groupNameKey = nameKey(row.group?.name || "");
    const topLevelGroupNameKey = nameKey(
      row.group?.parentId ? "" : row.group?.name || "",
    );

    if (["cash-in-hand", "bank accounts"].includes(groupNameKey)) {
      summary.cashBank = normalizeMoney(summary.cashBank + row.closing);
    }
    if (groupNameKey === "sundry debtors") {
      summary.receivables = normalizeMoney(
        summary.receivables + row.closingDebit,
      );
    }
    if (groupNameKey === "sundry creditors") {
      summary.payables = normalizeMoney(summary.payables + row.closingCredit);
    }
    if (groupNameKey === "sales accounts") {
      summary.salesTotal = normalizeMoney(
        summary.salesTotal + row.credit - row.debit,
      );
    }
    if (groupNameKey === "purchase accounts") {
      summary.purchaseTotal = normalizeMoney(
        summary.purchaseTotal + row.debit - row.credit,
      );
    }
    if (row.group?.nature === "INCOME") {
      const amount = normalizeMoney(row.credit - row.debit);
      if (row.group?.affectsGrossProfit) {
        summary.directIncome = normalizeMoney(summary.directIncome + amount);
      } else {
        summary.indirectIncome = normalizeMoney(summary.indirectIncome + amount);
      }
    }
    if (row.group?.nature === "EXPENSE") {
      const amount = normalizeMoney(row.debit - row.credit);
      if (row.group?.affectsGrossProfit) {
        summary.directExpense = normalizeMoney(summary.directExpense + amount);
      } else {
        summary.indirectExpense = normalizeMoney(
          summary.indirectExpense + amount,
        );
      }
    }
    if (topLevelGroupNameKey === "current assets") {
      summary.currentAssets = normalizeMoney(
        summary.currentAssets + row.closingDebit,
      );
    }
    if (topLevelGroupNameKey === "current liabilities") {
      summary.currentLiabilities = normalizeMoney(
        summary.currentLiabilities + row.closingCredit,
      );
    }
    if (groupNameKey === "cash-in-hand") {
      summary.cashInHandTotal = normalizeMoney(
        summary.cashInHandTotal + row.closingDebit,
      );
    }
    if (groupNameKey === "bank accounts") {
      const closingBalance = normalizeMoney(row.closingDebit || row.closing);
      summary.bankBalanceTotal = normalizeMoney(
        summary.bankBalanceTotal + row.closingDebit,
      );
      summary.bankLedgers.push({
        ledgerId: row._id,
        ledgerName: row.name,
        closingBalance,
      });
    }
  });

  summary.bankLedgers.sort(
    (left, right) => right.closingBalance - left.closingBalance,
  );
  summary.bankLedgers = summary.bankLedgers.slice(0, 5);
  return summary;
}

function findGroupNodeById(tree, targetId) {
  for (const node of tree || []) {
    if (String(node.id) === String(targetId)) return node;
    const nested = findGroupNodeById(node.children || [], targetId);
    if (nested) return nested;
  }
  return null;
}

function balanceValueFromSplit(source = {}) {
  return centsToMoney(
    Math.max(
      moneyToCents(source.closingDebit || 0),
      moneyToCents(source.closingCredit || 0),
    ),
  );
}

function buildGroupTrailLabel(groupsById, groupId) {
  if (!groupId) return "";
  const names = [];
  let cursor = groupsById.get(String(groupId));
  const visited = new Set();

  while (cursor && !visited.has(String(cursor._id))) {
    names.unshift(cursor.name);
    visited.add(String(cursor._id));
    cursor = cursor.parentId ? groupsById.get(String(cursor.parentId)) : null;
  }

  return names.join(" / ");
}

function formatDateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dayjs(date).format("DD/MM/YYYY");
}

async function ensureCompanyCoreMasters(companyId) {
  const now = new Date();
  const groups = await Groups.find({ companyId }).toArray();
  const groupByName = new Map(
    groups.map((group) => [nameKey(group.name), group]),
  );
  const missingGroups = [];

  if (
    !groupByName.has("stock-in-trade") &&
    !groupByName.has("stock in trade")
  ) {
    missingGroups.push({
      companyId,
      name: "Stock-in-Trade",
      parentId: null,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
      isSystem: true,
      systemKey: "stock-in-trade",
    });
  }

  if (missingGroups.length > 0) {
    await Groups.insertMany(missingGroups);
  }

  const refreshedGroups = await Groups.find({ companyId }).toArray();
  const refreshedGroupByName = new Map(
    refreshedGroups.map((group) => [nameKey(group.name), group]),
  );

  const salesAccountsGroup =
    refreshedGroupByName.get("sales accounts") ||
    refreshedGroupByName.get("sales account");
  const purchaseAccountsGroup =
    refreshedGroupByName.get("purchase accounts") ||
    refreshedGroupByName.get("purchase account");

  const ledgers = await Ledgers.find({ companyId }).toArray();
  const ledgerByName = new Map(
    ledgers.map((ledger) => [nameKey(ledger.name), ledger]),
  );
  const missingLedgers = [];

  if (salesAccountsGroup && !ledgerByName.has("sales")) {
    missingLedgers.push({
      companyId,
      name: "Sales",
      groupId: salesAccountsGroup._id,
      openingBalance: 0,
      openingDrCr: "CR",
      createdAt: now,
      isSystem: true,
      systemKey: "sales",
    });
  }

  if (purchaseAccountsGroup && !ledgerByName.has("purchase")) {
    missingLedgers.push({
      companyId,
      name: "Purchase",
      groupId: purchaseAccountsGroup._id,
      openingBalance: 0,
      openingDrCr: "DR",
      createdAt: now,
      isSystem: true,
      systemKey: "purchase",
    });
  }

  if (missingLedgers.length > 0) {
    await Ledgers.insertMany(missingLedgers);
  }

  const priceLevel = await pricelevels.findOne({ companyId, code: "MRP" });
  if (!priceLevel) {
    await pricelevels.insertOne({
      companyId,
      code: "MRP",
      name: "Maximum Retail Price",
      createdAt: now,
      isSystem: true,
    });
  }

  const existingVoucherTypes = await VoucherTypes.find({ companyId }).toArray();
  const voucherTypeNames = new Set(
    existingVoucherTypes.map((row) => nameKey(row.name)),
  );
  if (!voucherTypeNames.has("pos voucher")) {
    await VoucherTypes.insertOne({
      companyId,
      name: "POS Voucher",
      category: "ACCOUNTING",
      createdAt: now,
      isSystem: true,
      systemKey: "pos-voucher",
    });
  }

  if (!voucherTypeNames.has("manufacturing")) {
    await VoucherTypes.insertOne({
      companyId,
      name: "Manufacturing",
      category: "INVENTORY",
      createdAt: now,
      isSystem: true,
      systemKey: "manufacturing",
    });
  }
}

async function ensureCompanyBaseCurrency(company) {
  if (!company?._id) return;
  const companyId = company._id;
  const code = normalizeName(
    company.baseCurrencyCode || company.baseCurrencySymbol || "BDT",
  );
  const symbol = normalizeName(company.baseCurrencySymbol || code);
  const name = normalizeName(company.formalName || "Base Currency");
  const decimalPlaces = Number(company.decimalPlaces || 2);

  const existing = await Currencies.findOne({
    companyId,
    code: { $regex: `^${escapeRegex(code)}$`, $options: "i" },
  });

  if (existing) {
    await Currencies.updateOne(
      { _id: existing._id, companyId },
      {
        $set: {
          code,
          symbol,
          name,
          decimalPlaces,
          isBase: true,
        },
      },
    );
    await Currencies.updateMany(
      { companyId, _id: { $ne: existing._id } },
      { $set: { isBase: false } },
    );
    return;
  }

  await Currencies.updateMany({ companyId }, { $set: { isBase: false } });
  await Currencies.insertOne({
    companyId,
    code,
    symbol,
    name,
    decimalPlaces,
    isBase: true,
    isSystem: true,
    createdAt: new Date(),
  });
}

async function buildStockSummary(
  companyId,
  fromDate = null,
  toDate = null,
  options = {},
) {
  const [groups, allItems, vouchers] = await Promise.all([
    Groups.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(toDate ? { date: { $lte: toDate } } : {}),
      inventoryLines: { $exists: true, $ne: [] },
    })).toArray(),
  ]);

  const items = allItems.filter((item) => itemMatchesRoleFilter(item, options));
  const itemIdSet = new Set(items.map((item) => String(item._id)));
  const groupsById = new Map(groups.map((group) => [String(group._id), group]));
  const fromTime = fromDate ? fromDate.getTime() : null;
  const toTime = toDate ? toDate.getTime() : null;
  const itemStateMap = new Map(
    items.map((item) => {
      const openingQty = normalizeMoney(Number(item.openingQty) || 0);
      const openingRate = normalizeMoney(Number(item.openingRate) || 0);
      return [
        String(item._id),
        {
          openingSnapshot: {
            qty: openingQty,
            rate: openingRate,
            value: normalizeMoney(openingQty * openingRate),
          },
          currentQty: openingQty,
          currentRate: openingRate,
          movement: {
            inwardQty: 0,
            inwardValue: 0,
            outwardQty: 0,
            outwardValue: 0,
          },
        },
      ];
    }),
  );

  sortVouchersByDateAscending(vouchers).forEach((voucher) => {
      if (!Array.isArray(voucher.inventoryLines)) {
        return;
      }

      const voucherTime = getVoucherTime(voucher?.date);
      const hasVoucherTime = voucherTime !== 0;
      const beforePeriod =
        fromTime !== null && hasVoucherTime ? voucherTime < fromTime : false;
      const inPeriod =
        fromTime === null ||
        (hasVoucherTime &&
          voucherTime >= fromTime &&
          (toTime === null || voucherTime <= toTime));

      voucher.inventoryLines.forEach((line) => {
        if (!line?.itemId) return;
        const key = String(line.itemId);
        if (!itemIdSet.has(key)) return;
        const state = itemStateMap.get(key) || {
          openingSnapshot: { qty: 0, rate: 0, value: 0 },
          currentQty: 0,
          currentRate: 0,
          movement: {
            inwardQty: 0,
            inwardValue: 0,
            outwardQty: 0,
            outwardValue: 0,
          },
        };

        const movement = getStockReportMovementDescriptor(
          voucher.voucherName,
          line,
        );
        if (!movement) return;

        const qty = normalizeMoney(Number(line.qty) || 0);
        const purchaseRate = normalizeMoney(
          Number(line.rate) || state.currentRate || 0,
        );
        const outwardRate = normalizeMoney(
          Number(line.rate) || state.currentRate || purchaseRate || 0,
        );

        if (movement.bucket === "inward") {
          const inwardValue = normalizeMoney(qty * purchaseRate);
          if (beforePeriod) {
            state.currentQty = normalizeMoney(
              state.currentQty + movement.sign * qty,
            );
            if (movement.affectsRate) {
              state.currentRate = purchaseRate;
            }
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.inwardQty = normalizeMoney(
              state.movement.inwardQty + movement.sign * qty,
            );
            state.movement.inwardValue = normalizeMoney(
              state.movement.inwardValue + movement.sign * inwardValue,
            );
            state.currentQty = normalizeMoney(
              state.currentQty + movement.sign * qty,
            );
            if (movement.affectsRate) {
              state.currentRate = purchaseRate;
            }
          }
        } else {
          const outwardValue = normalizeMoney(qty * outwardRate);

          if (beforePeriod) {
            state.currentQty = normalizeMoney(
              state.currentQty - movement.sign * qty,
            );
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.outwardQty = normalizeMoney(
              state.movement.outwardQty + movement.sign * qty,
            );
            state.movement.outwardValue = normalizeMoney(
              state.movement.outwardValue + movement.sign * outwardValue,
            );
            state.currentQty = normalizeMoney(
              state.currentQty - movement.sign * qty,
            );
          }
        }

        itemStateMap.set(key, state);
      });
    });

  const rows = items
    .map((item) => {
      const state = itemStateMap.get(String(item._id)) || {
        openingSnapshot: {
          qty: normalizeMoney(Number(item.openingQty) || 0),
          rate: normalizeMoney(Number(item.openingRate) || 0),
          value: normalizeMoney(
            (Number(item.openingQty) || 0) * (Number(item.openingRate) || 0),
          ),
        },
        currentQty: normalizeMoney(Number(item.openingQty) || 0),
        currentRate: normalizeMoney(Number(item.openingRate) || 0),
        movement: {
          inwardQty: 0,
          inwardValue: 0,
          outwardQty: 0,
          outwardValue: 0,
        },
      };

      const openingQty = normalizeMoney(state.openingSnapshot.qty || 0);
      const openingRate = normalizeMoney(state.openingSnapshot.rate || 0);
      const openingValue = normalizeMoney(openingQty * openingRate);
      const movement = state.movement;
      const closingQty = normalizeMoney(state.currentQty || 0);
      const closingRate = normalizeMoney(state.currentRate || openingRate || 0);
      const closingValue = normalizeMoney(closingQty * closingRate);

      return {
        itemId: item._id,
        itemName: item.name,
        alias: item.alias || "",
        groupId: item.groupId,
        groupName: groupsById.get(String(item.groupId))?.name || "",
        openingQty: normalizeMoney(openingQty),
        openingRate: normalizeMoney(openingRate),
        openingValue: normalizeMoney(openingValue),
        inwardQty: normalizeMoney(movement.inwardQty),
        inwardValue: normalizeMoney(movement.inwardValue),
        outwardQty: normalizeMoney(movement.outwardQty),
        outwardValue: normalizeMoney(movement.outwardValue),
        closingQty,
        closingRate,
        closingValue,
      };
    })
    .sort((left, right) => left.itemName.localeCompare(right.itemName));

  const totals = rows.reduce(
    (accumulator, row) => ({
      openingQty: normalizeMoney(accumulator.openingQty + row.openingQty),
      openingValue: normalizeMoney(accumulator.openingValue + row.openingValue),
      inwardQty: normalizeMoney(accumulator.inwardQty + row.inwardQty),
      inwardValue: normalizeMoney(accumulator.inwardValue + row.inwardValue),
      outwardQty: normalizeMoney(accumulator.outwardQty + row.outwardQty),
      outwardValue: normalizeMoney(accumulator.outwardValue + row.outwardValue),
      closingQty: normalizeMoney(accumulator.closingQty + row.closingQty),
      closingValue: normalizeMoney(accumulator.closingValue + row.closingValue),
    }),
    {
      openingQty: 0,
      openingValue: 0,
      inwardQty: 0,
      inwardValue: 0,
      outwardQty: 0,
      outwardValue: 0,
      closingQty: 0,
      closingValue: 0,
    },
  );

  return { rows, totals };
}

async function buildInventoryDetailReport(
  companyId,
  fromDate = null,
  toDate = null,
  options = {},
) {
  const [groups, ledgers, allItems, vouchers] = await Promise.all([
    Groups.find({ companyId }).toArray(),
    Ledgers.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(toDate ? { date: { $lte: toDate } } : {}),
      inventoryLines: { $exists: true, $ne: [] },
    })).toArray(),
  ]);

  const requestedGroupId = options.groupId ? String(options.groupId) : "";
  const requestedCategory = normalizeName(options.category || "").toLowerCase();
  const requestedItemId = options.itemId ? String(options.itemId) : "";
  const requestedSalesPersonId = options.salesPersonId
    ? String(options.salesPersonId)
    : "";
  const requestedPartyGroupId = options.partyGroupId
    ? String(options.partyGroupId)
    : "";
  const requestedPartyLedgerId = options.partyLedgerId
    ? String(options.partyLedgerId)
    : "";
  const usePartyPerspective =
    Boolean(requestedPartyGroupId) || Boolean(requestedPartyLedgerId);

  const items = allItems.filter((item) => {
    if (!itemMatchesRoleFilter(item, options)) return false;
    if (requestedItemId && String(item._id) !== requestedItemId) return false;
    if (requestedGroupId && String(item.groupId || "") !== requestedGroupId)
      return false;
    if (
      requestedCategory &&
      normalizeName(item.stockCategory || "").toLowerCase() !==
        requestedCategory
    ) {
      return false;
    }
    return true;
  });
  const itemIdSet = new Set(items.map((item) => String(item._id)));
  const groupsById = new Map(groups.map((group) => [String(group._id), group]));
  const ledgerById = new Map(ledgers.map((ledger) => [String(ledger._id), ledger]));
  const fromTime = fromDate ? fromDate.getTime() : null;
  const toTime = toDate ? toDate.getTime() : null;

  function isDescendantGroup(groupIdValue, ancestorGroupId) {
    if (!ancestorGroupId) return true;
    let currentKey = String(groupIdValue || "");
    const targetKey = String(ancestorGroupId || "");
    while (currentKey) {
      if (currentKey === targetKey) return true;
      const currentGroup = groupsById.get(currentKey);
      currentKey = currentGroup?.parentId ? String(currentGroup.parentId) : "";
    }
    return false;
  }

  const itemStateMap = new Map(
    items.map((item) => {
      const openingQty = normalizeMoney(Number(item.openingQty) || 0);
      const openingRate = normalizeMoney(Number(item.openingRate) || 0);
      return [
        String(item._id),
        {
          item,
          openingSnapshot: {
            qty: openingQty,
            rate: openingRate,
            value: normalizeMoney(openingQty * openingRate),
          },
          currentQty: openingQty,
          currentRate: openingRate,
          movement: {
            inwardQty: 0,
            inwardValue: 0,
            outwardQty: 0,
            outwardValue: 0,
            lastInwardRate: 0,
            lastOutwardRate: 0,
          },
          lastInwardAt: null,
          lastOutwardAt: null,
          history: [],
        },
      ];
    }),
  );

  sortVouchersByDateAscending(vouchers).forEach((voucher) => {
      const partyLedger = resolveInventoryPartyLedger(voucher, ledgerById);
      const partyLedgerId = String(partyLedger?._id || "");
      const partyGroupId = String(partyLedger?.groupId || "");
      const partyGroupName =
        groupsById.get(partyGroupId)?.name ||
        normalizeName(voucher.customerSnapshot?.name || "") ||
        "";

      if (requestedSalesPersonId) {
        if (!isSalesPersonTrackedVoucherName(voucher.voucherName)) return;
        if (!voucherMatchesSalesPerson(voucher, requestedSalesPersonId)) return;
      }
      if (requestedPartyLedgerId && partyLedgerId !== requestedPartyLedgerId) {
        return;
      }
      if (
        requestedPartyGroupId &&
        !isDescendantGroup(partyGroupId, requestedPartyGroupId)
      ) {
        return;
      }
      if (!Array.isArray(voucher.inventoryLines)) return;

      const voucherTime = getVoucherTime(voucher?.date);
      const hasVoucherTime = voucherTime !== 0;
      const beforePeriod =
        fromTime !== null && hasVoucherTime ? voucherTime < fromTime : false;
      const inPeriod =
        fromTime === null ||
        (hasVoucherTime &&
          voucherTime >= fromTime &&
          (toTime === null || voucherTime <= toTime));

      voucher.inventoryLines.forEach((line) => {
        if (!line?.itemId) return;
        const key = String(line.itemId);
        if (!itemIdSet.has(key)) return;
        const state = itemStateMap.get(key) || {
          item: {},
          openingSnapshot: { qty: 0, rate: 0, value: 0 },
          currentQty: 0,
          currentRate: 0,
          movement: {
            inwardQty: 0,
            inwardValue: 0,
            outwardQty: 0,
            outwardValue: 0,
            lastInwardRate: 0,
            lastOutwardRate: 0,
          },
          lastInwardAt: null,
          lastOutwardAt: null,
          history: [],
        };

        const movement = getStockReportMovementDescriptor(
          voucher.voucherName,
          line,
        );
        if (!movement) return;
        const partyMovement = usePartyPerspective
          ? getPartyMovementDescriptor(voucher.voucherName)
          : null;
        const direction = partyMovement ? partyMovement.sign : movement.sign;
        const bucket = partyMovement
          ? partyMovement.bucket
          : movement.bucket;

        const qty = normalizeMoney(Number(line.qty) || 0);
        const purchaseRate = normalizeMoney(
          Number(line.rate) || state.currentRate || 0,
        );
        const saleRate = normalizeMoney(Number(line.rate) || 0);
        const effectiveRate = normalizeMoney(
          bucket === "inward"
            ? purchaseRate
            : saleRate || state.currentRate || purchaseRate || 0,
        );
        const value = normalizeMoney(qty * effectiveRate);
        const signedBucketQty = normalizeMoney(movement.sign * qty);
        const signedBucketValue = normalizeMoney(movement.sign * value);
        const stockDeltaQty = normalizeMoney(
          bucket === "inward" ? signedBucketQty : -signedBucketQty,
        );

        if (bucket === "inward") {
          if (beforePeriod) {
            state.currentQty = normalizeMoney(
              state.currentQty + stockDeltaQty,
            );
            if (movement.affectsRate) {
              state.currentRate = effectiveRate;
            }
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.inwardQty = normalizeMoney(
              state.movement.inwardQty +
                (partyMovement ? direction * qty : signedBucketQty),
            );
            state.movement.inwardValue = normalizeMoney(
              state.movement.inwardValue +
                (partyMovement ? direction * value : signedBucketValue),
            );
            state.movement.lastInwardRate = effectiveRate;
            state.currentQty = normalizeMoney(
              state.currentQty + stockDeltaQty,
            );
            if (movement.affectsRate) {
              state.currentRate = effectiveRate;
            }
            state.lastInwardAt = voucher.date || state.lastInwardAt;
            state.history.push({
              voucherId: voucher._id,
              date: voucher.date || null,
              dateLabel: formatDateLabel(voucher.date),
              voucherName: voucher.voucherName || "Voucher",
              number:
                voucher.number ||
                voucher.invoiceNumber ||
                voucher.voucherNumber ||
                "",
              direction: partyMovement?.directionLabel || movement.directionLabel,
              qty: normalizeMoney(
                partyMovement ? direction * qty : signedBucketQty,
              ),
              rate: effectiveRate,
              value: normalizeMoney(
                partyMovement ? direction * value : signedBucketValue,
              ),
              closingQty: state.currentQty,
              closingRate: state.currentRate,
              closingValue: normalizeMoney(
                state.currentQty * state.currentRate,
              ),
              itemName: normalizeName(line.itemName || state.item?.name || ""),
              partyLedgerId,
              partyLedgerName: normalizeName(partyLedger?.name || ""),
              partyGroupId,
              partyGroupName: normalizeName(partyGroupName),
            });
          }
        } else {
          if (beforePeriod) {
            state.currentQty = normalizeMoney(
              state.currentQty + stockDeltaQty,
            );
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.outwardQty = normalizeMoney(
              state.movement.outwardQty +
                (partyMovement ? direction * qty : signedBucketQty),
            );
            state.movement.outwardValue = normalizeMoney(
              state.movement.outwardValue +
                (partyMovement ? direction * value : signedBucketValue),
            );
            state.movement.lastOutwardRate = effectiveRate;
            state.currentQty = normalizeMoney(
              state.currentQty + stockDeltaQty,
            );
            state.lastOutwardAt = voucher.date || state.lastOutwardAt;
            state.history.push({
              voucherId: voucher._id,
              date: voucher.date || null,
              dateLabel: formatDateLabel(voucher.date),
              voucherName: voucher.voucherName || "Voucher",
              number:
                voucher.number ||
                voucher.invoiceNumber ||
                voucher.voucherNumber ||
                "",
              direction: partyMovement?.directionLabel || movement.directionLabel,
              qty: normalizeMoney(
                partyMovement ? direction * qty : signedBucketQty,
              ),
              rate: effectiveRate,
              value: normalizeMoney(
                partyMovement ? direction * value : signedBucketValue,
              ),
              closingQty: state.currentQty,
              closingRate: state.currentRate,
              closingValue: normalizeMoney(
                state.currentQty * state.currentRate,
              ),
              itemName: normalizeName(line.itemName || state.item?.name || ""),
              partyLedgerId,
              partyLedgerName: normalizeName(partyLedger?.name || ""),
              partyGroupId,
              partyGroupName: normalizeName(partyGroupName),
            });
          }
        }

        itemStateMap.set(key, state);
      });
    });

  const rows = [...itemStateMap.values()]
    .map((state) => {
      const item = state.item || {};
      const openingQty = normalizeMoney(state.openingSnapshot.qty || 0);
      const openingRate = normalizeMoney(state.openingSnapshot.rate || 0);
      const openingValue = normalizeMoney(openingQty * openingRate);
      const closingQty = normalizeMoney(state.currentQty || 0);
      const closingRate = normalizeMoney(state.currentRate || openingRate || 0);
      const closingValue = normalizeMoney(closingQty * closingRate);
      const totalMovementQty = normalizeMoney(
        Number(state.movement.inwardQty || 0) +
          Number(state.movement.outwardQty || 0),
      );
      const stockTurnover = openingQty
        ? normalizeMoney(Number(state.movement.outwardQty || 0) / openingQty)
        : 0;

      return {
        itemId: item._id,
        itemName: item.name,
        alias: item.alias || "",
        groupId: item.groupId,
        groupName: groupsById.get(String(item.groupId))?.name || "",
        stockCategoryId: item.stockCategoryId || "",
        stockCategoryName: item.stockCategory || "",
        unitOfMeasure: item.unitOfMeasure || "",
        openingQty,
        openingRate,
        openingValue,
        inwardQty: normalizeMoney(state.movement.inwardQty),
        inwardRate: normalizeMoney(state.movement.lastInwardRate || 0),
        inwardValue: normalizeMoney(state.movement.inwardValue),
        outwardQty: normalizeMoney(state.movement.outwardQty),
        outwardRate:
          Number(state.movement.outwardQty || 0) !== 0
            ? normalizeMoney(
                Number(state.movement.outwardValue || 0) /
                  Number(state.movement.outwardQty || 0),
              )
            : 0,
        outwardValue: normalizeMoney(state.movement.outwardValue),
        closingQty,
        closingRate,
        closingValue,
        totalMovementQty,
        stockTurnover,
        lastInwardAt: state.lastInwardAt,
        lastOutwardAt: state.lastOutwardAt,
        history: state.history,
      };
    })
    .sort((left, right) => left.itemName.localeCompare(right.itemName));

  const totals = rows.reduce(
    (accumulator, row) => ({
      openingQty: normalizeMoney(accumulator.openingQty + row.openingQty),
      openingValue: normalizeMoney(accumulator.openingValue + row.openingValue),
      inwardQty: normalizeMoney(accumulator.inwardQty + row.inwardQty),
      inwardValue: normalizeMoney(accumulator.inwardValue + row.inwardValue),
      outwardQty: normalizeMoney(accumulator.outwardQty + row.outwardQty),
      outwardValue: normalizeMoney(accumulator.outwardValue + row.outwardValue),
      closingQty: normalizeMoney(accumulator.closingQty + row.closingQty),
      closingValue: normalizeMoney(accumulator.closingValue + row.closingValue),
    }),
    {
      openingQty: 0,
      openingValue: 0,
      inwardQty: 0,
      inwardValue: 0,
      outwardQty: 0,
      outwardValue: 0,
      closingQty: 0,
      closingValue: 0,
    },
  );

  return { rows, totals };
}

function buildMovementMetrics(source = {}) {
  const openingQty = normalizeMoney(source.openingQty || 0);
  const openingValue = normalizeMoney(source.openingValue || 0);
  const inwardQty = normalizeMoney(source.inwardQty || 0);
  const inwardValue = normalizeMoney(source.inwardValue || 0);
  const outwardQty = normalizeMoney(source.outwardQty || 0);
  const outwardValue = normalizeMoney(source.outwardValue || 0);
  const closingQty = normalizeMoney(source.closingQty || 0);
  const closingValue = normalizeMoney(source.closingValue || 0);

  return {
    openingQty,
    openingRate:
      openingQty !== 0
        ? normalizeMoney(Math.abs(openingValue) / Math.abs(openingQty))
        : 0,
    openingValue,
    inwardQty,
    inwardRate:
      inwardQty !== 0
        ? normalizeMoney(Math.abs(inwardValue) / Math.abs(inwardQty))
        : 0,
    inwardValue,
    outwardQty,
    outwardRate:
      outwardQty !== 0
        ? normalizeMoney(Math.abs(outwardValue) / Math.abs(outwardQty))
        : 0,
    outwardValue,
    closingQty,
    closingRate:
      closingQty !== 0
        ? normalizeMoney(Math.abs(closingValue) / Math.abs(closingQty))
        : 0,
    closingValue,
  };
}

function emptyMovementAccumulator() {
  return {
    openingQty: 0,
    openingValue: 0,
    inwardQty: 0,
    inwardValue: 0,
    outwardQty: 0,
    outwardValue: 0,
    closingQty: 0,
    closingValue: 0,
  };
}

function addMovementTotals(target, source = {}) {
  target.openingQty = normalizeMoney(
    target.openingQty + Number(source.openingQty || 0),
  );
  target.openingValue = normalizeMoney(
    target.openingValue + Number(source.openingValue || 0),
  );
  target.inwardQty = normalizeMoney(
    target.inwardQty + Number(source.inwardQty || 0),
  );
  target.inwardValue = normalizeMoney(
    target.inwardValue + Number(source.inwardValue || 0),
  );
  target.outwardQty = normalizeMoney(
    target.outwardQty + Number(source.outwardQty || 0),
  );
  target.outwardValue = normalizeMoney(
    target.outwardValue + Number(source.outwardValue || 0),
  );
  target.closingQty = normalizeMoney(
    target.closingQty + Number(source.closingQty || 0),
  );
  target.closingValue = normalizeMoney(
    target.closingValue + Number(source.closingValue || 0),
  );
}

function basePartyName(value = "") {
  const normalized = normalizeName(value);
  if (!normalized) return "Unassigned Party";
  return normalized.split(":")[0].trim() || normalized;
}

function resolveInventoryPartyMeta(voucher, ledgerMap) {
  if (voucher?.customerSnapshot?.name) {
    const baseName = normalizeName(voucher.customerSnapshot.name);
    const ledgerName = `${baseName} (Customer)`;
    return {
      ledgerName,
      groupName: ledgerName,
    };
  }

  const direction = inferStockDirection(voucher?.voucherName);
  const lines = Array.isArray(voucher?.lines) ? voucher.lines : [];

  const preferredLines =
    direction > 0
      ? lines.filter((line) => Number(line.credit || 0) > 0)
      : direction < 0
      ? lines.filter((line) => Number(line.debit || 0) > 0)
      : lines;

  const ledgerName =
    preferredLines
      .map((line) => normalizeName(ledgerMap.get(String(line.ledgerId)) || ""))
      .find((name) => name && !["sales", "purchase"].includes(nameKey(name))) ||
    normalizeName(ledgerMap.get(String(lines[0]?.ledgerId || "")) || "") ||
    "Internal Inventory";

  return {
    ledgerName,
    groupName: basePartyName(ledgerName),
  };
}

function resolveInventoryPartyLedger(voucher, ledgerById) {
  const voucherNameKey = nameKey(voucher?.voucherName || "");
  const lines = Array.isArray(voucher?.lines) ? voucher.lines : [];

  let preferredLines = lines;

  if (voucherNameKey === "purchase" || voucherNameKey === "receipt note") {
    preferredLines = lines.filter((line) => Number(line.credit || 0) > 0);
  } else if (
    voucherNameKey === "sales" ||
    voucherNameKey === "pos voucher" ||
    voucherNameKey === "delivery note"
  ) {
    preferredLines = lines.filter((line) => Number(line.debit || 0) > 0);
  } else if (voucherNameKey === "credit note") {
    preferredLines = lines.filter((line) => Number(line.debit || 0) > 0);
  } else if (voucherNameKey === "debit note") {
    preferredLines = lines.filter((line) => Number(line.credit || 0) > 0);
  }

  return (
    preferredLines
      .map((line) => ledgerById.get(String(line.ledgerId || "")))
      .find((ledger) => {
        const name = normalizeName(ledger?.name || "");
        return name && !["sales", "purchase"].includes(nameKey(name));
      }) ||
    ledgerById.get(String(lines[0]?.ledgerId || "")) ||
    null
  );
}

async function buildInventoryMovementDimensionReport(
  companyId,
  fromDate = null,
  toDate = null,
  dimension = "stock-item",
  options = {},
) {
  const requestedSalesPersonId = options.salesPersonId
    ? String(options.salesPersonId)
    : "";
  if (dimension === "sales-person") {
    const vouchers = await Vouchers.find(activeVoucherFilter({
      companyId,
      ...(fromDate || toDate
        ? {
            date: {
              ...(fromDate ? { $gte: fromDate } : {}),
              ...(toDate ? { $lte: toDate } : {}),
            },
          }
        : {}),
    }))
      .sort({ date: -1, createdAt: -1 })
      .toArray();

    const accumulator = new Map();

    vouchers
      .filter((voucher) => isSalesPersonTrackedVoucherName(voucher.voucherName))
      .forEach((voucher) => {
        const salesMeta = voucher.salesMeta || {};
        const key = salesPersonKeyFromMeta(salesMeta);
        const employeeName =
          normalizeName(salesMeta.employeeName || "") || "Unassigned";
        const employeeNumber = normalizeTextBlock(
          salesMeta.employeeNumber || "",
        );
        const department = normalizeTextBlock(salesMeta.department || "");
        const designation = normalizeTextBlock(salesMeta.designation || "");
        const state = accumulator.get(key) || {
          id: key,
          name: employeeName,
          secondaryLabel:
            [employeeNumber, department || designation]
              .filter(Boolean)
              .join(" | ") || "Sales employee",
          metrics: {
            salesQty: 0,
            salesValue: 0,
            invoiceCount: 0,
            customerCount: 0,
            lastSaleOn: null,
          },
        };
        const customerKey = normalizeTextBlock(
          voucher.customerSnapshot?.phone ||
            voucher.customerSnapshot?.name ||
            voucher.lines?.[0]?.ledgerId ||
            "",
        );
        const customerSet = state.customerSet || new Set();
        if (customerKey) {
          customerSet.add(customerKey);
        }

        const itemTotals = (voucher.inventoryLines || []).reduce(
          (sum, line) => ({
            salesQty: normalizeMoney(sum.salesQty + Number(line.qty || 0)),
            salesValue: 0,
          }),
          { salesQty: 0, salesValue: 0 },
        );
        const voucherSalesValue = voucherTotalAmount(voucher);

        state.metrics.salesQty = normalizeMoney(
          state.metrics.salesQty + itemTotals.salesQty,
        );
        state.metrics.salesValue = normalizeMoney(
          state.metrics.salesValue + voucherSalesValue,
        );
        state.metrics.invoiceCount += 1;
        state.metrics.customerCount = customerSet.size;
        state.metrics.lastSaleOn =
          !state.metrics.lastSaleOn ||
          new Date(voucher.date) > new Date(state.metrics.lastSaleOn)
            ? voucher.date
            : state.metrics.lastSaleOn;
        state.customerSet = customerSet;
        accumulator.set(key, state);
      });

    const rows = [...accumulator.values()]
      .map((row) => {
        const { customerSet, ...rest } = row;
        return {
          ...rest,
          metrics: {
            ...row.metrics,
            averageValuePerInvoice: row.metrics.invoiceCount
              ? normalizeMoney(
                  row.metrics.salesValue / row.metrics.invoiceCount,
                )
              : 0,
          },
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const totals = rows.reduce(
      (sum, row) => {
        sum.salesQty = normalizeMoney(
          sum.salesQty + Number(row.metrics.salesQty || 0),
        );
        sum.salesValue = normalizeMoney(
          sum.salesValue + Number(row.metrics.salesValue || 0),
        );
        sum.invoiceCount += Number(row.metrics.invoiceCount || 0);
        sum.customerCount += Number(row.metrics.customerCount || 0);
        return sum;
      },
      {
        salesQty: 0,
        salesValue: 0,
        invoiceCount: 0,
        customerCount: 0,
      },
    );

    return {
      rows,
      totals: {
        ...totals,
        averageValuePerInvoice: totals.invoiceCount
          ? normalizeMoney(totals.salesValue / totals.invoiceCount)
          : 0,
      },
    };
  }

  const detailReport = await buildInventoryDetailReport(
    companyId,
    fromDate,
    toDate,
    {
      salesPersonId: options.salesPersonId,
      groupId: options.groupId,
      category: options.category,
      itemId: options.itemId,
    },
  );

  if (["stock-item", "stock-group", "stock-category"].includes(dimension)) {
    const [items, categories] = await Promise.all([
      Items.find({ companyId }).toArray(),
      StockCategories.find({ companyId }).toArray(),
    ]);

    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const categoryById = new Map(
      categories.map((row) => [String(row._id), row.name]),
    );
    const accumulator = new Map();

    detailReport.rows.forEach((row) => {
      const item = itemById.get(String(row.itemId)) || {};
      const categoryName =
        categoryById.get(String(item.stockCategoryId || "")) ||
        item.stockCategory ||
        "Uncategorized";

      let key = String(row.itemId);
      let label = row.itemName;
      let secondaryLabel = row.alias || "";

      if (dimension === "stock-group") {
        key = String(row.groupId || row.groupName || "ungrouped");
        label = row.groupName || "Ungrouped";
        secondaryLabel = `${
          detailReport.rows.filter(
            (entry) =>
              String(entry.groupId || "") === String(row.groupId || ""),
          ).length
        } items`;
      } else if (dimension === "stock-category") {
        key = normalizeName(categoryName).toLowerCase() || "uncategorized";
        label = categoryName;
        secondaryLabel = row.groupName || "";
      }

      if (!accumulator.has(key)) {
        accumulator.set(key, {
          id: key,
          name: label,
          secondaryLabel,
          metrics: emptyMovementAccumulator(),
        });
      }

      addMovementTotals(accumulator.get(key).metrics, row);
    });

    const rows = [...accumulator.values()]
      .map((row) => ({
        ...row,
        metrics: buildMovementMetrics(row.metrics),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const totals = rows.reduce((sum, row) => {
      addMovementTotals(sum, row.metrics);
      return sum;
    }, emptyMovementAccumulator());

    return {
      rows,
      totals: buildMovementMetrics(totals),
    };
  }

  const [vouchers, ledgers, items, groups] = await Promise.all([
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(toDate ? { date: { $lte: toDate } } : {}),
      inventoryLines: { $exists: true, $ne: [] },
    })).toArray(),
    Ledgers.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Groups.find({ companyId }).toArray(),
  ]);

  const ledgerMap = new Map(
    ledgers.map((ledger) => [String(ledger._id), ledger.name]),
  );
  const ledgerById = new Map(
    ledgers.map((ledger) => [String(ledger._id), ledger]),
  );
  const itemMap = new Map(items.map((item) => [String(item._id), item]));
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const fromTime = fromDate ? fromDate.getTime() : null;
  const toTime = toDate ? toDate.getTime() : null;
  const usePartyPerspective = dimension === "ledger" || dimension === "group";
  const ledgerStateMap = new Map();

  function getGroupPath(groupId) {
    const names = [];
    let current = groupById.get(String(groupId || ""));
    while (current) {
      names.unshift(current.name);
      current = current.parentId
        ? groupById.get(String(current.parentId))
        : null;
    }
    return names.join(" / ");
  }

  function isDescendantGroup(groupId, ancestorGroupId) {
    if (!ancestorGroupId) return true;
    let currentKey = String(groupId || "");
    const targetKey = String(ancestorGroupId || "");
    while (currentKey) {
      if (currentKey === targetKey) return true;
      const currentGroup = groupById.get(currentKey);
      currentKey = currentGroup?.parentId ? String(currentGroup.parentId) : "";
    }
    return false;
  }

  sortVouchersByDateAscending(vouchers).forEach((voucher) => {
      if (requestedSalesPersonId) {
        if (!/^sales$/i.test(String(voucher.voucherName || ""))) return;
        if (!voucherMatchesSalesPerson(voucher, requestedSalesPersonId)) return;
      }
      if (!Array.isArray(voucher.inventoryLines)) return;

      const voucherTime = getVoucherTime(voucher?.date);
      const hasVoucherTime = voucherTime !== 0;
      const beforePeriod =
        fromTime !== null && hasVoucherTime ? voucherTime < fromTime : false;
      const inPeriod =
        fromTime === null ||
        (hasVoucherTime &&
          voucherTime >= fromTime &&
          (toTime === null || voucherTime <= toTime));

      const partyLedger = resolveInventoryPartyLedger(voucher, ledgerById);
      if (!partyLedger) return;
      const ledgerKey = String(partyLedger._id);
      const state = ledgerStateMap.get(ledgerKey) || {
        id: ledgerKey,
        groupId: String(partyLedger.groupId || ""),
        name: partyLedger.name || "Unnamed Ledger",
        secondaryLabel: getGroupPath(partyLedger.groupId),
        metrics: emptyMovementAccumulator(),
      };

      voucher.inventoryLines.forEach((line) => {
        if (!line?.itemId) return;
        const item = itemMap.get(String(line.itemId)) || {};

        const stockDirection = getInventoryLineDirection(line, voucher.voucherName);
        if (stockDirection === 0) return;
        const partyMovement = usePartyPerspective
          ? getPartyMovementDescriptor(voucher.voucherName)
          : null;
        const direction = partyMovement ? partyMovement.sign : stockDirection;
        const bucket = partyMovement
          ? partyMovement.bucket
          : direction > 0
          ? "inward"
          : "outward";

        const qty = normalizeMoney(Number(line.qty) || 0);
        const rate = normalizeMoney(Number(line.rate) || 0);
        const value = normalizeMoney(qty * rate);

        if (beforePeriod) {
          state.metrics.openingQty = normalizeMoney(
            state.metrics.openingQty + (bucket === "inward" ? direction * qty : -direction * qty),
          );
          state.metrics.openingValue = normalizeMoney(
            state.metrics.openingValue + (bucket === "inward" ? direction * value : -direction * value),
          );
        }

        if (inPeriod) {
          if (bucket === "inward") {
            state.metrics.inwardQty = normalizeMoney(
              state.metrics.inwardQty + (partyMovement ? direction * qty : qty),
            );
            state.metrics.inwardValue = normalizeMoney(
              state.metrics.inwardValue +
                (partyMovement ? direction * value : value),
            );
          } else {
            state.metrics.outwardQty = normalizeMoney(
              state.metrics.outwardQty +
                (partyMovement ? direction * qty : qty),
            );
            state.metrics.outwardValue = normalizeMoney(
              state.metrics.outwardValue +
                (partyMovement ? direction * value : value),
            );
          }
        }
      });

      ledgerStateMap.set(ledgerKey, state);
    });

  if (dimension === "ledger") {
    const rows = [...ledgerStateMap.values()]
      .map((row) => ({
        id: row.id,
        name: row.name,
        secondaryLabel: row.secondaryLabel,
        metrics: buildMovementMetrics(row.metrics),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const totals = [...ledgerStateMap.values()].reduce((sum, row) => {
      addMovementTotals(sum, row.metrics);
      return sum;
    }, emptyMovementAccumulator());

    return {
      rows,
      totals: buildMovementMetrics(totals),
    };
  }

  const rows = groups
    .filter((group) => !group.parentId)
    .map((group) => {
      const groupMetrics = [...ledgerStateMap.values()].reduce((sum, row) => {
        if (isDescendantGroup(row.groupId, group._id)) {
          addMovementTotals(sum, row.metrics);
        }
        return sum;
      }, emptyMovementAccumulator());

      return {
        id: String(group._id),
        name: group.name,
        secondaryLabel: "",
        metrics: buildMovementMetrics(groupMetrics),
        rawMetrics: groupMetrics,
      };
    })
    .filter(
      (row) =>
        Number(row.rawMetrics.inwardQty || 0) !== 0 ||
        Number(row.rawMetrics.outwardQty || 0) !== 0,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ rawMetrics, ...row }) => row);

  const totals = rows.reduce((sum, row) => {
    addMovementTotals(sum, row.metrics);
    return sum;
  }, emptyMovementAccumulator());

  return {
    rows,
    totals: buildMovementMetrics(totals),
  };
}

async function buildSalesPersonDrillReport(
  companyId,
  fromDate = null,
  toDate = null,
  {
    salesPersonId = "",
    level = "group",
    groupId = "",
    category = "",
    itemId = "",
  } = {},
) {
  const requestedSalesPersonId = String(salesPersonId || "").trim();
  const requestedGroupId = String(groupId || "").trim();
  const requestedCategory = normalizeName(category || "").toLowerCase();
  const requestedItemId = String(itemId || "").trim();

  if (!requestedSalesPersonId) {
    return {
      rows: [],
      totals: {
        salesQty: 0,
        salesValue: 0,
        invoiceCount: 0,
        customerCount: 0,
      },
    };
  }

  const [groups, items, vouchers] = await Promise.all([
    Groups.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(fromDate || toDate
        ? {
            date: {
              ...(fromDate ? { $gte: fromDate } : {}),
              ...(toDate ? { $lte: toDate } : {}),
            },
          }
        : {}),
    }))
      .sort({ date: -1, createdAt: -1 })
      .toArray(),
  ]);

  const itemById = new Map(items.map((item) => [String(item._id), item]));
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const salesVouchers = vouchers.filter(
    (voucher) =>
      isSalesPersonTrackedVoucherName(voucher.voucherName) &&
      voucherMatchesSalesPerson(voucher, requestedSalesPersonId),
  );

  const customerKeyOfVoucher = (voucher = {}) =>
    normalizeTextBlock(
      voucher.customerSnapshot?.phone ||
        voucher.customerSnapshot?.name ||
        voucher.lines?.[0]?.ledgerId ||
        "",
    );

  if (level === "voucher") {
    const rows = [];
    const customerSet = new Set();
    let totalQty = 0;
    let totalValue = 0;

    salesVouchers.forEach((voucher) => {
      const customerKey = customerKeyOfVoucher(voucher);
      if (customerKey) customerSet.add(customerKey);

      (voucher.inventoryLines || []).forEach((line, index) => {
        const item = itemById.get(String(line.itemId)) || {};
        if (inventoryRoleKey(item.inventoryRole) === "raw_material") return;
        if (requestedItemId && String(line.itemId) !== requestedItemId) return;
        if (requestedGroupId && String(item.groupId || "") !== requestedGroupId)
          return;
        if (
          requestedCategory &&
          normalizeName(item.stockCategory || "").toLowerCase() !==
            requestedCategory
        ) {
          return;
        }

        const qty = normalizeMoney(Number(line.qty || 0));
        const rate = normalizeMoney(Number(line.rate || 0));
        const value = normalizeMoney(Number(line.amount || 0) || qty * rate);
        totalQty = normalizeMoney(totalQty + qty);
        totalValue = normalizeMoney(totalValue + value);

        rows.push({
          id: `${voucher._id}-${index}`,
          voucherId: String(voucher._id),
          date: voucher.date || null,
          dateLabel: formatDateLabel(voucher.date),
          voucherName: voucher.voucherName || "Sales",
          number:
            voucher.number ||
            voucher.invoiceNumber ||
            voucher.voucherNumber ||
            "",
          customerName:
            normalizeName(voucher.customerSnapshot?.name || "") ||
            normalizeName(voucher.partyName || "") ||
            "Walk-in Customer",
          itemId: String(line.itemId || ""),
          itemName:
            normalizeName(line.itemName || item.name || "") || "Unnamed Item",
          groupId: String(item.groupId || ""),
          groupName:
            normalizeName(
              groupById.get(String(item.groupId || ""))?.name || "",
            ) || "Ungrouped",
          categoryName:
            normalizeName(item.stockCategory || "") || "Uncategorized",
          qty,
          rate,
          value,
        });
      });
    });

    rows.sort((left, right) => {
      const leftTime = left.date ? new Date(left.date).getTime() : 0;
      const rightTime = right.date ? new Date(right.date).getTime() : 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.itemName.localeCompare(right.itemName);
    });

    return {
      rows,
      totals: {
        salesQty: totalQty,
        salesValue: totalValue,
        invoiceCount: new Set(rows.map((row) => row.voucherId)).size,
        customerCount: customerSet.size,
      },
    };
  }

  const accumulator = new Map();
  const totals = {
    salesQty: 0,
    salesValue: 0,
    invoiceIds: new Set(),
    customerKeys: new Set(),
  };

  salesVouchers.forEach((voucher) => {
    const voucherCustomerKey = customerKeyOfVoucher(voucher);

    (voucher.inventoryLines || []).forEach((line) => {
      const item = itemById.get(String(line.itemId)) || {};
      if (inventoryRoleKey(item.inventoryRole) === "raw_material") return;

      const itemGroupId = String(item.groupId || "");
      const itemGroupName =
        normalizeName(groupById.get(itemGroupId)?.name || "") || "Ungrouped";
      const itemCategoryName =
        normalizeName(item.stockCategory || "") || "Uncategorized";

      if (requestedGroupId && itemGroupId !== requestedGroupId) return;
      if (
        requestedCategory &&
        itemCategoryName.toLowerCase() !== requestedCategory
      ) {
        return;
      }
      if (requestedItemId && String(line.itemId) !== requestedItemId) return;

      const qty = normalizeMoney(Number(line.qty || 0));
      const rate = normalizeMoney(Number(line.rate || 0));
      const value = normalizeMoney(Number(line.amount || 0) || qty * rate);

      totals.salesQty = normalizeMoney(totals.salesQty + qty);
      totals.salesValue = normalizeMoney(totals.salesValue + value);
      totals.invoiceIds.add(String(voucher._id));
      if (voucherCustomerKey) totals.customerKeys.add(voucherCustomerKey);

      let key = String(line.itemId || "");
      let name =
        normalizeName(line.itemName || item.name || "") || "Unnamed Item";
      let secondaryLabel = itemGroupName;

      if (level === "group") {
        key = itemGroupId || "ungrouped";
        name = itemGroupName;
        secondaryLabel = "";
      } else if (level === "category") {
        key = itemCategoryName.toLowerCase() || "uncategorized";
        name = itemCategoryName;
        secondaryLabel = itemGroupName;
      }

      const state = accumulator.get(key) || {
        id: key,
        name,
        secondaryLabel,
        metrics: {
          salesQty: 0,
          salesValue: 0,
          invoiceCount: 0,
          customerCount: 0,
          averageRate: 0,
          lastSaleOn: null,
        },
        invoiceIds: new Set(),
        customerKeys: new Set(),
      };

      state.metrics.salesQty = normalizeMoney(state.metrics.salesQty + qty);
      state.metrics.salesValue = normalizeMoney(
        state.metrics.salesValue + value,
      );
      state.invoiceIds.add(String(voucher._id));
      if (voucherCustomerKey) state.customerKeys.add(voucherCustomerKey);
      state.metrics.invoiceCount = state.invoiceIds.size;
      state.metrics.customerCount = state.customerKeys.size;
      state.metrics.lastSaleOn =
        !state.metrics.lastSaleOn ||
        new Date(voucher.date) > new Date(state.metrics.lastSaleOn)
          ? voucher.date
          : state.metrics.lastSaleOn;
      state.metrics.averageRate =
        state.metrics.salesQty !== 0
          ? normalizeMoney(state.metrics.salesValue / state.metrics.salesQty)
          : 0;

      accumulator.set(key, state);
    });
  });

  const rows = [...accumulator.values()]
    .map((row) => ({
      id: row.id,
      name: row.name,
      secondaryLabel: row.secondaryLabel,
      metrics: row.metrics,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    rows,
    totals: {
      salesQty: totals.salesQty,
      salesValue: totals.salesValue,
      invoiceCount: totals.invoiceIds.size,
      customerCount: totals.customerKeys.size,
      averageRate:
        totals.salesQty !== 0
          ? normalizeMoney(totals.salesValue / totals.salesQty)
          : 0,
    },
  };
}

async function buildPartyMovementDetailReport(
  companyId,
  fromDate = null,
  toDate = null,
  {
    level = "ledger",
    groupId = "",
    ledgerId = "",
    groupName = "",
    ledgerName = "",
  } = {},
) {
  const requestedGroupId = String(groupId || "").trim();
  const requestedLedgerId = String(ledgerId || "").trim();
  const requestedGroupName = normalizeName(groupName || "").toLowerCase();
  const requestedLedgerName = normalizeName(ledgerName || "").toLowerCase();

  const [vouchers, ledgers, items, groups] = await Promise.all([
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(fromDate || toDate
        ? {
            date: {
              ...(fromDate ? { $gte: fromDate } : {}),
              ...(toDate ? { $lte: toDate } : {}),
            },
      }
        : {}),
      inventoryLines: { $exists: true, $ne: [] },
    }))
      .sort({ date: -1, createdAt: -1 })
      .toArray(),
    Ledgers.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Groups.find({ companyId }).toArray(),
  ]);

  const ledgerById = new Map(
    ledgers.map((ledger) => [String(ledger._id), ledger]),
  );
  const itemMap = new Map(items.map((item) => [String(item._id), item]));
  const groupById = new Map(groups.map((group) => [String(group._id), group]));

  function getGroupPath(groupIdValue) {
    const names = [];
    let current = groupById.get(String(groupIdValue || ""));
    while (current) {
      names.unshift(current.name);
      current = current.parentId
        ? groupById.get(String(current.parentId))
        : null;
    }
    return names.join(" / ");
  }

  function isDescendantGroup(groupIdValue, ancestorGroupId) {
    if (!ancestorGroupId) return true;
    let currentKey = String(groupIdValue || "");
    const targetKey = String(ancestorGroupId || "");
    while (currentKey) {
      if (currentKey === targetKey) return true;
      const currentGroup = groupById.get(currentKey);
      currentKey = currentGroup?.parentId ? String(currentGroup.parentId) : "";
    }
    return false;
  }

  const ledgerStateMap = new Map();

  vouchers.forEach((voucher) => {
    const partyLedger = resolveInventoryPartyLedger(voucher, ledgerById);
    if (!partyLedger) return;

    const partyLedgerId = String(partyLedger._id || "");
    const partyGroupId = String(partyLedger.groupId || "");
    const partyGroupName = normalizeName(
      groupById.get(partyGroupId)?.name || "",
    ).toLowerCase();
    const partyLedgerName = normalizeName(partyLedger.name || "").toLowerCase();

    if (requestedGroupId && !isDescendantGroup(partyGroupId, requestedGroupId))
      return;
    if (
      !requestedGroupId &&
      requestedGroupName &&
      partyGroupName !== requestedGroupName
    )
      return;
    if (requestedLedgerId && partyLedgerId !== requestedLedgerId) return;
    if (
      !requestedLedgerId &&
      requestedLedgerName &&
      partyLedgerName !== requestedLedgerName
    )
      return;

    const state = ledgerStateMap.get(partyLedgerId) || {
      id: partyLedgerId,
      name: partyLedger.name || "Unnamed Ledger",
      groupId: partyGroupId,
      groupPath: getGroupPath(partyGroupId),
      metrics: emptyMovementAccumulator(),
      invoiceIds: new Set(),
      voucherRows: [],
    };

    (voucher.inventoryLines || []).forEach((line, index) => {
      const item = itemMap.get(String(line.itemId)) || {};

      const partyMovement = getPartyMovementDescriptor(voucher.voucherName);
      if (!partyMovement) return;

      const qty = normalizeMoney(Number(line.qty || 0));
      const rate = normalizeMoney(Number(line.rate || 0));
      const value = normalizeMoney(Number(line.amount || 0) || qty * rate);
      const voucherTime = getVoucherTime(voucher?.date);
      const hasVoucherTime = voucherTime !== 0;
      const beforePeriod =
        fromTime !== null && hasVoucherTime ? voucherTime < fromTime : false;
      const inPeriod =
        fromTime === null ||
        (hasVoucherTime &&
          voucherTime >= fromTime &&
          (toTime === null || voucherTime <= toTime));

      if (beforePeriod) {
        state.metrics.openingQty = normalizeMoney(
          state.metrics.openingQty +
            (partyMovement.bucket === "inward"
              ? partyMovement.sign * qty
              : -partyMovement.sign * qty),
        );
        state.metrics.openingValue = normalizeMoney(
          state.metrics.openingValue +
            (partyMovement.bucket === "inward"
              ? partyMovement.sign * value
              : -partyMovement.sign * value),
        );
      } else if (inPeriod) {
        if (partyMovement.bucket === "inward") {
          state.metrics.inwardQty = normalizeMoney(
            state.metrics.inwardQty + partyMovement.sign * qty,
          );
          state.metrics.inwardValue = normalizeMoney(
            state.metrics.inwardValue + partyMovement.sign * value,
          );
        } else {
          state.metrics.outwardQty = normalizeMoney(
            state.metrics.outwardQty + partyMovement.sign * qty,
          );
          state.metrics.outwardValue = normalizeMoney(
            state.metrics.outwardValue + partyMovement.sign * value,
          );
        }
      } else {
        return;
      }

      state.invoiceIds.add(String(voucher._id));

      if (inPeriod) {
        state.voucherRows.push({
          id: `${voucher._id}-${index}`,
          voucherId: String(voucher._id),
          date: voucher.date || null,
          dateLabel: formatDateLabel(voucher.date),
          voucherName: voucher.voucherName || "Voucher",
          number:
            voucher.number ||
            voucher.invoiceNumber ||
            voucher.voucherNumber ||
            "",
          groupName: groupById.get(partyGroupId)?.name || "Unassigned Group",
          ledgerName: partyLedger.name || "Unassigned Ledger",
          itemName:
            normalizeName(line.itemName || item.name || "") || "Unnamed Item",
          direction: partyMovement.directionLabel,
          qty: normalizeMoney(partyMovement.sign * qty),
          rate,
          value: normalizeMoney(partyMovement.sign * value),
        });
      }
    });

    ledgerStateMap.set(partyLedgerId, state);
  });

  if (level === "voucher") {
    const targetState = requestedLedgerId
      ? ledgerStateMap.get(requestedLedgerId)
      : [...ledgerStateMap.values()].find(
      (row) =>
        normalizeName(row.name || "").toLowerCase() === requestedLedgerName,
    );

    const rows = (targetState?.voucherRows || [])
      .slice()
      .sort((left, right) => {
        const leftTime = left.date ? new Date(left.date).getTime() : 0;
        const rightTime = right.date ? new Date(right.date).getTime() : 0;
        if (leftTime !== rightTime) return rightTime - leftTime;
        return left.itemName.localeCompare(right.itemName);
      });

    const totals = rows.reduce(
      (sum, row) => {
        if (row.direction === "Purchase") {
          sum.purchaseQty = normalizeMoney(
            sum.purchaseQty + Number(row.qty || 0),
          );
          sum.purchaseValue = normalizeMoney(
            sum.purchaseValue + Number(row.value || 0),
          );
        } else {
          sum.salesQty = normalizeMoney(sum.salesQty + Number(row.qty || 0));
          sum.salesValue = normalizeMoney(
            sum.salesValue + Number(row.value || 0),
          );
        }
        return sum;
      },
      { purchaseQty: 0, purchaseValue: 0, salesQty: 0, salesValue: 0 },
    );

    return { rows, totals };
  }

  if (level === "group") {
    const rows = [];
    const childGroups = groups
      .filter((group) =>
        requestedGroupId
          ? String(group.parentId || "") === requestedGroupId
          : !group.parentId,
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    childGroups.forEach((group) => {
      const rawMetrics = [...ledgerStateMap.values()].reduce((sum, ledgerState) => {
        if (isDescendantGroup(ledgerState.groupId, group._id)) {
          addMovementTotals(sum, ledgerState.metrics);
        }
        return sum;
      }, emptyMovementAccumulator());

      const metrics = buildMovementMetrics({
        ...rawMetrics,
        closingQty: normalizeMoney(
          Number(rawMetrics.openingQty || 0) +
            Number(rawMetrics.inwardQty || 0) -
            Number(rawMetrics.outwardQty || 0),
        ),
        closingValue: normalizeMoney(
          Number(rawMetrics.openingValue || 0) +
            Number(rawMetrics.inwardValue || 0) -
            Number(rawMetrics.outwardValue || 0),
        ),
      });

      if (
        metrics.openingQty !== 0 ||
        metrics.openingValue !== 0 ||
        metrics.inwardQty !== 0 ||
        metrics.inwardValue !== 0 ||
        metrics.outwardQty !== 0 ||
        metrics.outwardValue !== 0 ||
        metrics.closingQty !== 0 ||
        metrics.closingValue !== 0
      ) {
        rows.push({
          id: String(group._id),
          name: group.name,
          rowType: "group",
          secondaryLabel: getGroupPath(group.parentId),
          metrics,
        });
      }
    });

    [...ledgerStateMap.values()]
      .filter((ledgerState) =>
        requestedGroupId
          ? String(ledgerState.groupId || "") === requestedGroupId
          : false,
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((ledgerState) => {
        const metrics = buildMovementMetrics({
          ...ledgerState.metrics,
          closingQty: normalizeMoney(
            Number(ledgerState.metrics.openingQty || 0) +
              Number(ledgerState.metrics.inwardQty || 0) -
              Number(ledgerState.metrics.outwardQty || 0),
          ),
          closingValue: normalizeMoney(
            Number(ledgerState.metrics.openingValue || 0) +
              Number(ledgerState.metrics.inwardValue || 0) -
              Number(ledgerState.metrics.outwardValue || 0),
          ),
        });
        rows.push({
          id: ledgerState.id,
          name: ledgerState.name,
          rowType: "ledger",
          secondaryLabel: getGroupPath(ledgerState.groupId),
          metrics,
        });
      });

    const totals = rows.reduce((sum, row) => {
      addMovementTotals(sum, row.metrics);
      return sum;
    }, emptyMovementAccumulator());

    return {
      rows,
      totals: buildMovementMetrics({
        ...totals,
        closingQty: normalizeMoney(
          Number(totals.openingQty || 0) +
            Number(totals.inwardQty || 0) -
            Number(totals.outwardQty || 0),
        ),
        closingValue: normalizeMoney(
          Number(totals.openingValue || 0) +
            Number(totals.inwardValue || 0) -
            Number(totals.outwardValue || 0),
        ),
      }),
    };
  }

  const rows = [...ledgerStateMap.values()]
    .map((row) => {
      const metrics = buildMovementMetrics({
        ...row.metrics,
        closingQty: normalizeMoney(
          Number(row.metrics.openingQty || 0) +
            Number(row.metrics.inwardQty || 0) -
            Number(row.metrics.outwardQty || 0),
        ),
        closingValue: normalizeMoney(
          Number(row.metrics.openingValue || 0) +
            Number(row.metrics.inwardValue || 0) -
            Number(row.metrics.outwardValue || 0),
        ),
      });
      return {
        id: row.id,
        name: row.name,
        rowType: "ledger",
        secondaryLabel: row.groupPath,
        metrics,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const totals = rows.reduce((sum, row) => {
    addMovementTotals(sum, row.metrics);
    return sum;
  }, emptyMovementAccumulator());

  return {
    rows,
    totals: buildMovementMetrics({
      ...totals,
      closingQty: normalizeMoney(
        Number(totals.openingQty || 0) +
          Number(totals.inwardQty || 0) -
          Number(totals.outwardQty || 0),
      ),
      closingValue: normalizeMoney(
        Number(totals.openingValue || 0) +
          Number(totals.inwardValue || 0) -
          Number(totals.outwardValue || 0),
      ),
    }),
  };
}

async function buildStockGroupSummary(
  companyId,
  fromDate = null,
  toDate = null,
  options = {},
) {
  const summary = await buildStockSummary(companyId, fromDate, toDate, options);
  const groups = await Groups.find({ companyId }).toArray();
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const childrenByParent = new Map();

  groups.forEach((group) => {
    const parentKey = group.parentId ? String(group.parentId) : "ROOT";
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey).push(group);
  });

  for (const list of childrenByParent.values()) {
    list.sort((left, right) => left.name.localeCompare(right.name));
  }

  const itemsByGroup = new Map();
  summary.rows.forEach((row) => {
    const key = String(row.groupId || "");
    if (!itemsByGroup.has(key)) itemsByGroup.set(key, []);
    itemsByGroup.get(key).push(row);
  });

  for (const list of itemsByGroup.values()) {
    list.sort((left, right) => left.itemName.localeCompare(right.itemName));
  }

  const primaryGroup = groups.find((group) =>
    ["stock-in-trade", "stock in trade", "primary"].includes(
      nameKey(group.name),
    ),
  );

  function emptyMetrics() {
    return {
      openingQty: 0,
      openingValue: 0,
      inwardQty: 0,
      inwardValue: 0,
      outwardQty: 0,
      outwardValue: 0,
      closingQty: 0,
      closingValue: 0,
    };
  }

  function addMetrics(target, source) {
    target.openingQty = normalizeMoney(
      target.openingQty + Number(source.openingQty || 0),
    );
    target.openingValue = normalizeMoney(
      target.openingValue + Number(source.openingValue || 0),
    );
    target.inwardQty = normalizeMoney(
      target.inwardQty + Number(source.inwardQty || 0),
    );
    target.inwardValue = normalizeMoney(
      target.inwardValue + Number(source.inwardValue || 0),
    );
    target.outwardQty = normalizeMoney(
      target.outwardQty + Number(source.outwardQty || 0),
    );
    target.outwardValue = normalizeMoney(
      target.outwardValue + Number(source.outwardValue || 0),
    );
    target.closingQty = normalizeMoney(
      target.closingQty + Number(source.closingQty || 0),
    );
    target.closingValue = normalizeMoney(
      target.closingValue + Number(source.closingValue || 0),
    );
  }

  function finalizeMetrics(metrics) {
    const openingRate =
      Number(metrics.openingQty || 0) !== 0
        ? normalizeMoney(metrics.openingValue / metrics.openingQty)
        : 0;
    const inwardRate =
      Number(metrics.inwardQty || 0) !== 0
        ? normalizeMoney(metrics.inwardValue / metrics.inwardQty)
        : 0;
    const outwardRate =
      Number(metrics.outwardQty || 0) !== 0
        ? normalizeMoney(metrics.outwardValue / metrics.outwardQty)
        : 0;
    const closingRate =
      Number(metrics.closingQty || 0) !== 0
        ? normalizeMoney(metrics.closingValue / metrics.closingQty)
        : 0;

    return {
      ...metrics,
      openingRate,
      inwardRate,
      outwardRate,
      closingRate,
    };
  }

  function buildNode(group, level = 0) {
    const childGroups = (childrenByParent.get(String(group._id)) || []).map(
      (child) => buildNode(child, level + 1),
    );
    const itemRows = (itemsByGroup.get(String(group._id)) || []).map((row) => ({
      type: "item",
      id: row.itemId,
      parentId: group._id,
      level: level + 1,
      name: row.itemName,
      alias: row.alias || "",
      groupName: row.groupName || "",
      metrics: finalizeMetrics({
        openingQty: row.openingQty,
        openingValue: row.openingValue,
        inwardQty: row.inwardQty,
        inwardValue: row.inwardValue,
        outwardQty: row.outwardQty,
        outwardValue: row.outwardValue,
        closingQty: row.closingQty,
        closingValue: row.closingValue,
      }),
    }));

    const totals = emptyMetrics();
    itemRows.forEach((item) => addMetrics(totals, item.metrics));
    childGroups.forEach((child) => addMetrics(totals, child.metrics));

    return {
      type: "group",
      id: group._id,
      parentId: group.parentId || null,
      level,
      name: group.name,
      metrics: finalizeMetrics(totals),
      hasChildren: childGroups.length > 0 || itemRows.length > 0,
      children: [...childGroups, ...itemRows],
    };
  }

  const rootGroups = primaryGroup
    ? [buildNode(primaryGroup, 0)]
    : (childrenByParent.get("ROOT") || []).map((group) => buildNode(group, 0));

  function flattenRows(nodes) {
    const rows = [];
    nodes.forEach((node) => {
      rows.push({
        type: node.type,
        id: node.id,
        parentId: node.parentId || null,
        level: node.level,
        name: node.name,
        alias: node.alias || "",
        groupName: node.groupName || "",
        metrics: node.metrics,
        hasChildren: node.type === "group" ? node.hasChildren : false,
      });
      if (node.type === "group") {
        rows.push(...flattenRows(node.children));
      }
    });
    return rows;
  }

  const totals = finalizeMetrics({
    openingQty: summary.totals.openingQty,
    openingValue: summary.totals.openingValue,
    inwardQty: summary.totals.inwardQty,
    inwardValue: summary.totals.inwardValue,
    outwardQty: summary.totals.outwardQty,
    outwardValue: summary.totals.outwardValue,
    closingQty: summary.totals.closingQty,
    closingValue: summary.totals.closingValue,
  });

  return {
    rows: flattenRows(rootGroups),
    tree: rootGroups,
    totals,
    period: {
      from: fromDate ? dayjs(fromDate).format("YYYY-MM-DD") : null,
      to: toDate ? dayjs(toDate).format("YYYY-MM-DD") : null,
    },
  };
}

async function isStockGroup(companyId, groupId) {
  const groups = await Groups.find({ companyId }).toArray();
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const stockRoot = groups.find((group) =>
    ["stock-in-trade", "stock in trade", "primary"].includes(
      nameKey(group.name),
    ),
  );

  if (!stockRoot) return false;

  let current = groupById.get(String(groupId));
  while (current) {
    if (String(current._id) === String(stockRoot._id)) {
      return true;
    }
    current = current.parentId ? groupById.get(String(current.parentId)) : null;
  }

  return false;
}

function normalizeBomComponentPayload(component = {}) {
  return {
    itemId:
      component.itemId && ObjectId.isValid(component.itemId)
        ? new ObjectId(component.itemId)
        : null,
    itemName: normalizeName(component.itemName || ""),
    description: normalizeTextBlock(component.description || ""),
    qty: normalizeMoney(component.qty || 0),
    unitId:
      component.unitId && ObjectId.isValid(component.unitId)
        ? new ObjectId(component.unitId)
        : null,
    unitName: normalizeName(component.unitName || ""),
  };
}

function normalizeAdditionalCostPayload(cost = {}) {
  return {
    label: normalizeName(cost.label || cost.type || "Additional Cost"),
    amount: normalizeMoney(cost.amount || 0),
  };
}

async function enrichBomWithAvailability(
  companyId,
  bom,
  rawMaterialSummary = null,
) {
  const rawSummary =
    rawMaterialSummary ||
    (await buildStockSummary(companyId, null, null, {
      includeRoles: ["raw_material"],
    }));
  const rowsByItemId = new Map(
    (rawSummary.rows || []).map((row) => [String(row.itemId), row]),
  );

  let maxProducible = Number.POSITIVE_INFINITY;
  const outputQty = normalizeMoney(bom.outputQty || 1) || 1;
  let totalComponentCost = 0;

  const components = (bom.components || []).map((component) => {
    const stockRow = rowsByItemId.get(String(component.itemId)) || {};
    const availableQty = normalizeMoney(stockRow.closingQty || 0);
    const rate = normalizeMoney(stockRow.closingRate || component.rate || 0);
    const requiredPerUnit =
      outputQty !== 0
        ? normalizeMoney((Number(component.qty) || 0) / outputQty)
        : 0;
    const possibleOutput =
      requiredPerUnit > 0
        ? Math.floor((availableQty / requiredPerUnit) * 100) / 100
        : Number.POSITIVE_INFINITY;

    if (requiredPerUnit > 0) {
      maxProducible = Math.min(maxProducible, possibleOutput);
    }

    totalComponentCost = normalizeMoney(
      totalComponentCost + (Number(component.qty) || 0) * rate,
    );

    return {
      ...component,
      availableQty,
      currentRate: rate,
      currentValue: normalizeMoney(availableQty * rate),
      requiredPerUnit,
      possibleOutput:
        possibleOutput === Number.POSITIVE_INFINITY
          ? null
          : normalizeMoney(possibleOutput),
    };
  });

  const additionalCost = (bom.additionalCosts || []).reduce(
    (sum, row) => normalizeMoney(sum + Number(row.amount || 0)),
    0,
  );
  const totalCost = normalizeMoney(totalComponentCost + additionalCost);
  const effectiveRate = outputQty ? normalizeMoney(totalCost / outputQty) : 0;

  return {
    ...bom,
    components,
    totalComponentCost,
    additionalCost,
    totalCost,
    effectiveRate,
    maxProducible:
      maxProducible === Number.POSITIVE_INFINITY
        ? 0
        : normalizeMoney(maxProducible),
  };
}

async function buildManufacturingRawMaterialSummary(
  companyId,
  fromDate = null,
  toDate = null,
) {
  return buildInventoryDetailReport(companyId, fromDate, toDate, {
    includeRoles: ["raw_material"],
  });
}

async function buildProductionRegister(
  companyId,
  fromDate = null,
  toDate = null,
) {
  const [vouchers, companies] = await Promise.all([
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(fromDate || toDate
        ? {
            date: {
              ...(fromDate ? { $gte: fromDate } : {}),
              ...(toDate ? { $lte: toDate } : {}),
            },
          }
        : {}),
      "manufacturingMeta.outputItemId": { $exists: true },
    }))
      .sort({ date: -1, createdAt: -1 })
      .toArray(),
    Companies.findOne({ _id: companyId }),
  ]);

  const rows = vouchers.map((voucher) => {
    const meta = voucher.manufacturingMeta || {};
    const outputLine =
      (voucher.inventoryLines || []).find(
        (line) => getInventoryLineDirection(line, voucher.voucherName) > 0,
      ) || {};
    const componentCount = (voucher.inventoryLines || []).filter(
      (line) => getInventoryLineDirection(line, voucher.voucherName) < 0,
    ).length;

    return {
      voucherId: voucher._id,
      voucherName: voucher.voucherName || "Manufacturing",
      number:
        voucher.number ||
        formatProductionNumber(companies?.name || "company", 0),
      date: voucher.date,
      dateLabel: formatDateLabel(voucher.date),
      bomId: meta.bomId || null,
      bomName: meta.bomName || "",
      outputItemId: meta.outputItemId || outputLine.itemId || null,
      outputItemName: meta.outputItemName || outputLine.itemName || "",
      outputQty: normalizeMoney(meta.outputQty || outputLine.qty || 0),
      effectiveRate: normalizeMoney(meta.effectiveRate || outputLine.rate || 0),
      totalCost: normalizeMoney(meta.totalCost || outputLine.amount || 0),
      componentCount,
      notes: meta.notes || voucher.narration || "",
    };
  });

  const totals = rows.reduce(
    (sum, row) => ({
      outputQty: normalizeMoney(sum.outputQty + Number(row.outputQty || 0)),
      totalCost: normalizeMoney(sum.totalCost + Number(row.totalCost || 0)),
    }),
    { outputQty: 0, totalCost: 0 },
  );

  return { rows, totals };
}

async function buildComponentConsumptionReport(
  companyId,
  fromDate = null,
  toDate = null,
) {
  const [vouchers, items] = await Promise.all([
    Vouchers.find(activeVoucherFilter({
      companyId,
      ...(fromDate || toDate
        ? {
            date: {
              ...(fromDate ? { $gte: fromDate } : {}),
              ...(toDate ? { $lte: toDate } : {}),
            },
          }
        : {}),
      "manufacturingMeta.outputItemId": { $exists: true },
      inventoryLines: { $exists: true, $ne: [] },
    })).toArray(),
    Items.find({ companyId }).toArray(),
  ]);

  const itemMap = new Map(items.map((item) => [String(item._id), item]));
  const accumulator = new Map();

  vouchers.forEach((voucher) => {
    (voucher.inventoryLines || []).forEach((line) => {
      if (getInventoryLineDirection(line, voucher.voucherName) >= 0) return;
      const item = itemMap.get(String(line.itemId)) || {};
      const role = inventoryRoleKey(item.inventoryRole);
      if (role !== "raw_material") return;

      const key = String(line.itemId);
      const state = accumulator.get(key) || {
        itemId: line.itemId,
        itemName: normalizeName(line.itemName || item.name || ""),
        unitName: normalizeName(item.unitOfMeasure || line.unitName || ""),
        qty: 0,
        value: 0,
        rate: 0,
        lastUsedOn: null,
      };

      state.qty = normalizeMoney(state.qty + Number(line.qty || 0));
      state.value = normalizeMoney(state.value + Number(line.amount || 0));
      state.rate = state.qty ? normalizeMoney(state.value / state.qty) : 0;
      state.lastUsedOn = voucher.date || state.lastUsedOn;
      accumulator.set(key, state);
    });
  });

  const rows = [...accumulator.values()].sort((left, right) =>
    left.itemName.localeCompare(right.itemName),
  );
  const totals = rows.reduce(
    (sum, row) => ({
      qty: normalizeMoney(sum.qty + Number(row.qty || 0)),
      value: normalizeMoney(sum.value + Number(row.value || 0)),
    }),
    { qty: 0, value: 0 },
  );

  return { rows, totals };
}

function summarizeBomBottleneck(bom = {}) {
  const components = Array.isArray(bom.components) ? bom.components : [];
  const constrained = components.filter(
    (component) => component.requiredPerUnit > 0 && component.possibleOutput !== null,
  );

  if (constrained.length === 0) {
    return {
      bottleneckName: "",
      bottleneckAvailableQty: 0,
      bottleneckPossibleOutput: 0,
      readiness: "Blocked",
    };
  }

  const bottleneck = constrained.reduce((lowest, component) => {
    if (!lowest) return component;
    return Number(component.possibleOutput || 0) <
      Number(lowest.possibleOutput || 0)
      ? component
      : lowest;
  }, null);

  const possible = Number(bottleneck?.possibleOutput || 0);
  return {
    bottleneckName: bottleneck?.itemName || "",
    bottleneckAvailableQty: normalizeMoney(bottleneck?.availableQty || 0),
    bottleneckPossibleOutput: normalizeMoney(possible),
    readiness: possible > 0 ? "Ready" : "Blocked",
  };
}

async function buildManufacturingDashboard(companyId) {
  const [rawSummary, bomRows] = await Promise.all([
    buildStockSummary(companyId, null, null, {
      includeRoles: ["raw_material"],
    }),
    Boms.find({ companyId }).sort({ updatedAt: -1, createdAt: -1 }).toArray(),
  ]);

  const enrichedBoms = await Promise.all(
    bomRows.map((row) => enrichBomWithAvailability(companyId, row, rawSummary)),
  );

  const activeBoms = enrichedBoms.filter(
    (row) => nameKey(row.status || "active") !== "inactive",
  );
  const readyBoms = activeBoms.filter((row) => Number(row.maxProducible || 0) > 0);
  const blockedBoms = activeBoms.filter((row) => Number(row.maxProducible || 0) <= 0);

  const bomCapacityRows = activeBoms
    .map((bom) => {
      const bottleneck = summarizeBomBottleneck(bom);
      return {
        _id: bom._id,
        name: bom.name,
        finishedItemId: bom.finishedItemId || null,
        finishedItemName: bom.finishedItemName || "",
        outputQty: normalizeMoney(bom.outputQty || 0),
        unitName: bom.unitName || "",
        componentsCount: Array.isArray(bom.components) ? bom.components.length : 0,
        maxProducible: normalizeMoney(bom.maxProducible || 0),
        effectiveRate: normalizeMoney(bom.effectiveRate || 0),
        totalCost: normalizeMoney(bom.totalCost || 0),
        additionalCost: normalizeMoney(bom.additionalCost || 0),
        bottleneckName: bottleneck.bottleneckName,
        bottleneckAvailableQty: bottleneck.bottleneckAvailableQty,
        bottleneckPossibleOutput: bottleneck.bottleneckPossibleOutput,
        readiness: bottleneck.readiness,
        status: bom.status || "active",
      };
    })
    .sort((left, right) => {
      if (left.readiness !== right.readiness) {
        return left.readiness === "Ready" ? -1 : 1;
      }
      return Number(right.maxProducible || 0) - Number(left.maxProducible || 0);
    });

  const rawMaterialRows = (rawSummary.rows || [])
    .map((row) => ({
      itemId: row.itemId,
      itemName: row.itemName || "",
      groupName: row.groupName || "",
      closingQty: normalizeMoney(row.closingQty || 0),
      closingRate: normalizeMoney(row.closingRate || 0),
      closingValue: normalizeMoney(row.closingValue || 0),
      inwardQty: normalizeMoney(row.inwardQty || 0),
      outwardQty: normalizeMoney(row.outwardQty || 0),
    }))
    .sort((left, right) => Number(right.closingValue || 0) - Number(left.closingValue || 0));

  const topRawMaterials = rawMaterialRows.slice(0, 8);
  const topBuildOpportunities = bomCapacityRows.slice(0, 8);

  return {
    generatedAt: new Date(),
    rawMaterials: {
      itemsCount: rawMaterialRows.length,
      closingQty: normalizeMoney(rawSummary.totals?.closingQty || 0),
      closingValue: normalizeMoney(rawSummary.totals?.closingValue || 0),
      inwardValue: normalizeMoney(rawSummary.totals?.inwardValue || 0),
      consumedValue: normalizeMoney(rawSummary.totals?.outwardValue || 0),
      rows: rawMaterialRows,
      topRows: topRawMaterials,
    },
    boms: {
      total: bomRows.length,
      active: activeBoms.length,
      ready: readyBoms.length,
      blocked: blockedBoms.length,
      rows: bomCapacityRows,
      topRows: topBuildOpportunities,
    },
    notes: {
      capacityBasis:
        "BoM capacity is calculated against current raw material closing stock for each BoM independently.",
      caution:
        "Shared raw materials can be consumed by multiple BoMs, so simultaneous total output across all BoMs may be lower than the sum of individual capacities.",
    },
  };
}

// ---------- CONNECT MONGODB ----------
async function connectDb() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(); // Demo-pos
  Companies = db.collection("companies");
  Groups = db.collection("groups");
  Ledgers = db.collection("ledgers");
  VoucherTypes = db.collection("voucherTypes");
  Vouchers = db.collection("vouchers");
  AuditLogs = db.collection("auditLogs");
  Boms = db.collection("boms");
  Customers = db.collection("customers");
  Employees = db.collection("employees");
  Items = db.collection("items");
  pricelevels = db.collection("pricelevels");
  Currencies = db.collection("currencies");
  CostCategories = db.collection("costCategories");
  CostCentres = db.collection("costCentres");
  StockCategories = db.collection("stockCategories");
  Units = db.collection("units");
  Godowns = db.collection("godowns");

  await Promise.all([
    Companies.createIndex({ name: 1 }, { sparse: true }),
    Groups.createIndex({ companyId: 1, parentId: 1, name: 1 }),
    Ledgers.createIndex({ companyId: 1, groupId: 1, name: 1 }),
    VoucherTypes.createIndex({ companyId: 1, category: 1, name: 1 }),
    Vouchers.createIndex({ companyId: 1, date: -1 }),
    Vouchers.createIndex({ companyId: 1, voucherTypeId: 1, date: -1 }),
    Vouchers.createIndex({ companyId: 1, isDeleted: 1, date: -1 }),
    Vouchers.createIndex({ "lines.ledgerId": 1, companyId: 1 }),
    AuditLogs.createIndex({ companyId: 1, entityType: 1, entityId: 1, at: -1 }),
    Boms.createIndex({ companyId: 1, updatedAt: -1 }),
    Customers.createIndex({ companyId: 1, phone: 1 }),
    Employees.createIndex({ companyId: 1, name: 1 }),
    Items.createIndex({ companyId: 1, groupId: 1, name: 1 }),
    pricelevels.createIndex({ companyId: 1, name: 1 }),
    Currencies.createIndex({ companyId: 1, name: 1 }),
    CostCategories.createIndex({ companyId: 1, name: 1 }),
    CostCentres.createIndex({ companyId: 1, name: 1 }),
    StockCategories.createIndex({ companyId: 1, name: 1 }),
    Units.createIndex({ companyId: 1, name: 1 }),
    Godowns.createIndex({ companyId: 1, name: 1 }),
  ]);
  console.log("Connected to MongoDB");
}

// ---------- UTIL: seed default masters (like Tally) ----------
async function seedDefaultMasters(companyId) {
  // Pre-generate ObjectIds so we can wire parents/children
  const g = {
    capital: new ObjectId(),
    currentAssets: new ObjectId(),
    stockInTrade: new ObjectId(),
    cashInHand: new ObjectId(),
    bankAccounts: new ObjectId(),
    sundryDebtors: new ObjectId(),
    fixedAssets: new ObjectId(),
    currentLiabilities: new ObjectId(),
    sundryCreditors: new ObjectId(),
    directExpenses: new ObjectId(),
    indirectExpenses: new ObjectId(),
    directIncomes: new ObjectId(),
    indirectIncomes: new ObjectId(),
    salesAccounts: new ObjectId(),
    purchaseAccounts: new ObjectId(),
    profitAndLoss: new ObjectId(),
  };

  const now = new Date();

  await Groups.insertMany([
    {
      _id: g.capital,
      companyId,
      name: "Capital Account",
      parentId: null,
      nature: "LIABILITY",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.currentAssets,
      companyId,
      name: "Current Assets",
      parentId: null,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.stockInTrade,
      companyId,
      name: "Stock-in-Trade",
      parentId: g.currentAssets,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
      isSystem: true,
      systemKey: "stock-in-trade",
    },

    {
      _id: g.cashInHand,
      companyId,
      name: "Cash-in-Hand",
      parentId: g.currentAssets,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.bankAccounts,
      companyId,
      name: "Bank Accounts",
      parentId: g.currentAssets,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.sundryDebtors,
      companyId,
      name: "Sundry Debtors",
      parentId: g.currentAssets,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.fixedAssets,
      companyId,
      name: "Fixed Assets",
      parentId: null,
      nature: "ASSET",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.currentLiabilities,
      companyId,
      name: "Current Liabilities",
      parentId: null,
      nature: "LIABILITY",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.sundryCreditors,
      companyId,
      name: "Sundry Creditors",
      parentId: g.currentLiabilities,
      nature: "LIABILITY",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.directExpenses,
      companyId,
      name: "Direct Expenses",
      parentId: null,
      nature: "EXPENSE",
      affectsGrossProfit: true,
      createdAt: now,
    },

    {
      _id: g.indirectExpenses,
      companyId,
      name: "Indirect Expenses",
      parentId: null,
      nature: "EXPENSE",
      affectsGrossProfit: false,
      createdAt: now,
    },

    {
      _id: g.directIncomes,
      companyId,
      name: "Direct Incomes",
      parentId: null,
      nature: "INCOME",
      affectsGrossProfit: true,
      createdAt: now,
    },

    {
      _id: g.indirectIncomes,
      companyId,
      name: "Indirect Incomes",
      parentId: null,
      nature: "INCOME",
      affectsGrossProfit: false,
      createdAt: now,
    },

    // =========================
    // SALES ACCOUNT (PRIMARY)
    // =========================
    {
      _id: g.salesAccounts,
      companyId,
      name: "Sales Accounts",
      parentId: null,
      nature: "INCOME",
      affectsGrossProfit: true,
      createdAt: now,
    },

    // =========================
    // PURCHASE ACCOUNT (PRIMARY)
    // =========================
    {
      _id: g.purchaseAccounts,
      companyId,
      name: "Purchase Accounts",
      parentId: null,
      nature: "EXPENSE",
      affectsGrossProfit: true,
      createdAt: now,
    },

    // =========================
    // PROFIT & LOSS GROUP
    // =========================
    {
      _id: g.profitAndLoss,
      companyId,
      name: "Profit & Loss",
      parentId: null,
      nature: "LIABILITY",
      affectsGrossProfit: false,
      createdAt: now,
    },
  ]);

  // Default ledgers like Tally

  await Ledgers.insertMany([
    {
      companyId,
      name: "Cash",
      groupId: g.cashInHand,
      openingBalance: 0,
      openingDrCr: "DR",
      createdAt: now,
    },

    {
      companyId,
      name: "Profit & Loss A/c",
      groupId: g.profitAndLoss,
      openingBalance: 0,
      openingDrCr: "CR",
      createdAt: now,
    },

    {
      companyId,
      name: "Sales",
      groupId: g.salesAccounts,
      openingBalance: 0,
      openingDrCr: "CR",
      createdAt: now,
      isSystem: true,
      systemKey: "sales",
    },

    {
      companyId,
      name: "Purchase",
      groupId: g.purchaseAccounts,
      openingBalance: 0,
      openingDrCr: "DR",
      createdAt: now,
      isSystem: true,
      systemKey: "purchase",
    },
  ]);
  // Default voucher types
  await VoucherTypes.insertMany([
    { companyId, name: "Contra", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Payment", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Receipt", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Journal", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Sales", category: "ACCOUNTING", createdAt: now },
    {
      companyId,
      name: "POS Voucher",
      category: "ACCOUNTING",
      createdAt: now,
      isSystem: true,
      systemKey: "pos-voucher",
    },
    { companyId, name: "Purchase", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Debit Note", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Credit Note", category: "ACCOUNTING", createdAt: now },
    { companyId, name: "Stock Journal", category: "INVENTORY", createdAt: now },
    { companyId, name: "Delivery Note", category: "INVENTORY", createdAt: now },
    { companyId, name: "Receipt Note", category: "INVENTORY", createdAt: now },
  ]);

  await pricelevels.insertOne({
    companyId,
    code: "MRP",
    name: "Maximum Retail Price",
    createdAt: now,
    isSystem: true,
  });

  const company = await Companies.findOne({ _id: companyId });
  await ensureCompanyBaseCurrency(company);

  await Units.insertOne({
    companyId,
    name: "Nos",
    symbol: "Nos",
    decimalPlaces: 2,
    createdAt: now,
    isSystem: true,
  });

  await Godowns.insertOne({
    companyId,
    name: "Main Location",
    alias: "",
    address: "",
    createdAt: now,
    isSystem: true,
  });
}

// ---------- COMPANIES ----------

// Create company + auto-create default groups, ledgers, voucher types
app.post("/companies", async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const {
      financialYearFrom,
      financialYearTo,
      booksBeginningFrom,
      mailingName,
      country,
      address,
      state,
      city,
      postalCode,
      telephone,
      mobile,
      fax,
      email,
      website,
      division,
      baseCurrencyCode,
      baseCurrencySymbol,
      formalName,
      decimalPlaces,
      incomeTaxNumber,
      vatTinNumber,
      serviceTaxNumber,
      panNumber,
      enableInventoryManagement,
      enableBillWiseDetails,
      enableCostCentres,
      enableMultiCurrency,
      requireCompanyLogin,
      masterUsername,
      masterPassword,
    } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Company name is required" });
    }

    const existing = await Companies.findOne({
      name: new RegExp(`^${name}$`, "i"),
    });
    if (existing) {
      return res
        .status(400)
        .json({ message: "A company with this name already exists" });
    }

    const normalizedMasterUsername = normalizeName(masterUsername);
    if (requireCompanyLogin) {
      if (!normalizedMasterUsername) {
        return res
          .status(400)
          .json({ message: "Master username is required when company login is enabled" });
      }
      if (!String(masterPassword || "").trim()) {
        return res
          .status(400)
          .json({ message: "Master password is required when company login is enabled" });
      }
    }

    const now = new Date();
    const result = await Companies.insertOne({
      name,
      financialYearFrom,
      financialYearTo,
      booksBeginningFrom,
      mailingName,
      country,
      address,
      state,
      city,
      postalCode,
      telephone,
      mobile,
      fax,
      email,
      website,
      division,
      baseCurrencyCode: baseCurrencyCode || "BDT",
      baseCurrencySymbol: baseCurrencySymbol || "TK",
      formalName: formalName || "Bangladeshi Taka",
      decimalPlaces: Number(decimalPlaces || 2),
      incomeTaxNumber,
      vatTinNumber,
      serviceTaxNumber,
      panNumber,
      options: {
        enableInventoryManagement: enableInventoryManagement !== false,
        enableBillWiseDetails: Boolean(enableBillWiseDetails),
        enableCostCentres: Boolean(enableCostCentres),
        enableMultiCurrency: Boolean(enableMultiCurrency),
      },
      auth: requireCompanyLogin
        ? {
            enabled: true,
            masterUsername: normalizedMasterUsername,
            ...hashCompanyPassword(masterPassword),
            updatedAt: now,
          }
        : {
            enabled: false,
          },
      createdAt: now,
    });

    const companyId = result.insertedId;
    await seedDefaultMasters(companyId);
    await ensureCompanyCoreMasters(companyId);

    const company = await Companies.findOne({ _id: companyId });
    await ensureCompanyBaseCurrency(company);

    res.status(201).json({
      message: "Company created with default masters",
      company: sanitizeCompany(company),
    });
  } catch (err) {
    console.error("Error creating company:", err);
    res.status(500).json({ message: "Error creating company" });
  }
});

// List companies
app.get("/companies", async (req, res) => {
  const list = await Companies.find().sort({ name: 1 }).toArray();
  res.json(list.map(sanitizeCompany));
});

app.get("/companies/:companyId/masters/overview", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const [company, groups, ledgers, items, voucherTypes, levels] =
      await Promise.all([
        Companies.findOne({ _id: companyId }),
        Groups.find({ companyId }).sort({ name: 1 }).toArray(),
        Ledgers.find({ companyId }).sort({ name: 1 }).toArray(),
        Items.find({ companyId }).sort({ name: 1 }).toArray(),
        VoucherTypes.find({ companyId }).sort({ name: 1 }).toArray(),
        pricelevels.find({ companyId }).sort({ code: 1 }).toArray(),
      ]);

    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    res.json({
      company: sanitizeCompany(company),
      groups,
      ledgers,
      items,
      voucherTypes,
      priceLevels: levels,
    });
  } catch (err) {
    console.error("Error loading company overview:", err);
    res.status(500).json({ message: "Error loading company overview" });
  }
});

app.put("/companies/:companyId", requireCompanyWriteAccess(ROLE_GROUPS.companyAdmin), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const name = normalizeName(req.body.name);
    if (!name) {
      return res.status(400).json({ message: "Company name is required" });
    }

    const existing = await Companies.findOne({
      _id: { $ne: companyId },
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    });
    if (existing) {
      return res
        .status(400)
        .json({ message: "A company with this name already exists" });
    }

    const update = {
      $set: {
        name,
        financialYearFrom: req.body.financialYearFrom || "",
        financialYearTo: req.body.financialYearTo || "",
        booksBeginningFrom: req.body.booksBeginningFrom || "",
        mailingName: req.body.mailingName || "",
        country: req.body.country || "",
        address: req.body.address || "",
        state: req.body.state || "",
        city: req.body.city || "",
        postalCode: req.body.postalCode || "",
        telephone: req.body.telephone || "",
        mobile: req.body.mobile || "",
        fax: req.body.fax || "",
        email: req.body.email || "",
        website: req.body.website || "",
        division: req.body.division || "",
        baseCurrencyCode: req.body.baseCurrencyCode || "BDT",
        baseCurrencySymbol: req.body.baseCurrencySymbol || "TK",
        formalName: req.body.formalName || "Bangladeshi Taka",
        decimalPlaces: Number(req.body.decimalPlaces || 2),
        incomeTaxNumber: req.body.incomeTaxNumber || "",
        vatTinNumber: req.body.vatTinNumber || "",
        serviceTaxNumber: req.body.serviceTaxNumber || "",
        panNumber: req.body.panNumber || "",
        options: {
          enableInventoryManagement:
            req.body.enableInventoryManagement !== false,
          enableBillWiseDetails: Boolean(req.body.enableBillWiseDetails),
          enableCostCentres: Boolean(req.body.enableCostCentres),
          enableMultiCurrency: Boolean(req.body.enableMultiCurrency),
        },
        updatedAt: new Date(),
      },
    };

    const requireCompanyLogin = Boolean(req.body.requireCompanyLogin);
    const normalizedMasterUsername = normalizeName(req.body.masterUsername);
    const masterPassword = String(req.body.masterPassword || "").trim();

    if (requireCompanyLogin) {
      const existingCompany = await Companies.findOne({ _id: companyId });
      if (!normalizedMasterUsername) {
        return res
          .status(400)
          .json({ message: "Master username is required when company login is enabled" });
      }
      if (!masterPassword && !existingCompany?.auth?.enabled) {
        return res
          .status(400)
          .json({ message: "Master password is required when company login is enabled" });
      }

      update.$set.auth = {
        ...(existingCompany?.auth || {}),
        enabled: true,
        masterUsername: normalizedMasterUsername,
        updatedAt: new Date(),
      };
      if (masterPassword) {
        Object.assign(update.$set.auth, hashCompanyPassword(masterPassword));
      }
    } else {
      update.$set.auth = { enabled: false };
    }

    await Companies.updateOne({ _id: companyId }, update);
    const company = await Companies.findOne({ _id: companyId });
    await ensureCompanyBaseCurrency(company);
    res.json(sanitizeCompany(company));
  } catch (err) {
    console.error("Error updating company:", err);
    res.status(500).json({ message: "Error updating company" });
  }
});

app.post(
  "/companies/:companyId/authenticate",
  rateLimit({
    scope: "company-auth",
    windowMs: RATE_LIMIT_AUTH_WINDOW_MS,
    max: RATE_LIMIT_AUTH_MAX,
    message: "Too many company login attempts. Please wait and try again.",
  }),
  async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const company = await Companies.findOne({ _id: companyId });
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    const auth = company.auth || {};
    if (!auth.enabled) {
      return res.json({ ok: true, company: sanitizeCompany(company) });
    }

    const username = normalizeName(req.body.masterUsername);
    const password = String(req.body.masterPassword || "");
    if (!username || !password) {
      return res.status(400).json({ message: "Master username and password are required" });
    }

    if (username !== normalizeName(auth.masterUsername)) {
      return res.status(401).json({ message: "Invalid master username or password" });
    }
    if (!verifyCompanyPassword(password, auth)) {
      return res.status(401).json({ message: "Invalid master username or password" });
    }

    return res.json({ ok: true, company: sanitizeCompany(company) });
  } catch (err) {
    console.error("Error authenticating company:", err);
    res.status(500).json({ message: "Error authenticating company" });
  }
});

app.post(
  "/companies/:companyId/employee-authenticate",
  rateLimit({
    scope: "employee-auth",
    windowMs: RATE_LIMIT_AUTH_WINDOW_MS,
    max: RATE_LIMIT_AUTH_MAX,
    message: "Too many employee login attempts. Please wait and try again.",
  }),
  async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const company = await Companies.findOne({ _id: companyId });
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    const username = normalizeTextBlock(req.body.username).toLowerCase();
    const password = String(req.body.password || "");
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    const employee = await Employees.findOne({
      companyId,
      "accessControl.loginEnabled": true,
      "accessControl.username": { $regex: `^${escapeRegex(username)}$`, $options: "i" },
    });

    if (!employee) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    if (normalizeName(employee.accessControl?.status) === "inactive") {
      return res.status(403).json({ message: "This employee login is inactive" });
    }

    if (!verifyCompanyPassword(password, employee.auth || {})) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    return res.json({
      ok: true,
      company: sanitizeCompany(company),
      user: buildEmployeeSessionUser(employee, company),
      token: createEmployeeSessionToken(employee, company),
    });
  } catch (err) {
    console.error("Error authenticating employee:", err);
    res.status(500).json({ message: "Error authenticating employee" });
  }
});

app.get(
  "/companies/:companyId/audit-logs",
  requireCompanyReadAccess(ROLE_GROUPS.accountingMasters),
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const {
        from = "",
        to = "",
        action = "",
        entityType = "",
        entityId = "",
        actorId = "",
        search = "",
      } =
        req.query || {};

      const filter = { companyId };

      if (action) {
        filter.action = normalizeTextBlock(action);
      }

      if (entityType) {
        filter.entityType = normalizeTextBlock(entityType);
      }

      if (entityId) {
        const normalizedEntityId = normalizeTextBlock(entityId);
        filter.entityId = ObjectId.isValid(normalizedEntityId)
          ? new ObjectId(normalizedEntityId)
          : normalizedEntityId;
      }

      if (actorId) {
        filter["actor.id"] = normalizeTextBlock(actorId);
      }

      if (from || to) {
        const range = {};
        if (from) {
          const fromDate = dayjs(from).startOf("day");
          if (fromDate.isValid()) {
            range.$gte = fromDate.toDate();
          }
        }
        if (to) {
          const toDate = dayjs(to).endOf("day");
          if (toDate.isValid()) {
            range.$lte = toDate.toDate();
          }
        }
        if (Object.keys(range).length > 0) {
          filter.at = range;
        }
      }

      if (search) {
        const safeSearch = escapeRegex(normalizeTextBlock(search));
        filter.$or = [
          { entityType: { $regex: safeSearch, $options: "i" } },
          { action: { $regex: safeSearch, $options: "i" } },
          { "actor.name": { $regex: safeSearch, $options: "i" } },
          { "actor.role": { $regex: safeSearch, $options: "i" } },
        ];
      }

      const rows = await AuditLogs.find(filter)
        .sort({ at: -1 })
        .limit(500)
        .toArray();

      const actorOptions = [];
      const actorMap = new Map();
      rows.forEach((row) => {
        const id = normalizeTextBlock(row.actor?.id);
        if (!id || actorMap.has(id)) return;
        const label = row.actor?.name
          ? `${row.actor.name}${row.actor?.role ? ` (${row.actor.role})` : ""}`
          : id;
        actorMap.set(id, { value: id, label });
      });
      actorOptions.push(...actorMap.values());

      res.json({
        rows,
        actorOptions,
      });
    } catch (err) {
      console.error("Error loading audit logs:", err);
      res.status(500).json({ message: "Unable to load audit logs" });
    }
  },
);

// ---------- GROUPS (CRUD like Tally Masters) ----------

// List groups for a company
app.get("/companies/:companyId/groups", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const groups = await Groups.find({ companyId }).toArray();
  res.json(groups);
});

// Create group
app.post("/companies/:companyId/groups", requireCompanyWriteAccess(ROLE_GROUPS.groupMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const name = normalizeName(req.body.name);
    const { parentId, nature, affectsGrossProfit } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Group name is required" });
    }

    const duplicate = await Groups.findOne({
      companyId,
      name: {
        $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Group name already exists" });
    }

    if (parentId) {
      const parent = await Groups.findOne({
        _id: new ObjectId(parentId),
        companyId,
      });
      if (!parent) {
        return res.status(400).json({ message: "Parent group not found" });
      }
    }

    const doc = {
      companyId,
      name,
      parentId: parentId ? new ObjectId(parentId) : null,
      nature, // 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE'
      affectsGrossProfit: !!affectsGrossProfit,
      createdAt: new Date(),
    };

    const result = await Groups.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating group:", err);
    res.status(500).json({ message: "Error creating group" });
  }
});

// Alter group
app.put("/companies/:companyId/groups/:groupId", requireCompanyWriteAccess(ROLE_GROUPS.groupMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const groupId = new ObjectId(req.params.groupId);
    const name = normalizeName(req.body.name);
    const { parentId, nature, affectsGrossProfit } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Group name is required" });
    }

    const duplicate = await Groups.findOne({
      _id: { $ne: groupId },
      companyId,
      name: {
        $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Group name already exists" });
    }

    if (parentId) {
      const parentObjectId = new ObjectId(parentId);
      if (String(parentObjectId) === String(groupId)) {
        return res
          .status(400)
          .json({ message: "Group cannot be parent of itself" });
      }
      const parent = await Groups.findOne({ _id: parentObjectId, companyId });
      if (!parent) {
        return res.status(400).json({ message: "Parent group not found" });
      }
    }

    const update = {
      $set: {
        name,
        parentId: parentId ? new ObjectId(parentId) : null,
        nature,
        affectsGrossProfit: !!affectsGrossProfit,
      },
    };

    await Groups.updateOne({ _id: groupId, companyId }, update);
    const updated = await Groups.findOne({ _id: groupId, companyId });
    res.json(updated);
  } catch (err) {
    console.error("Error updating group:", err);
    res.status(500).json({ message: "Error updating group" });
  }
});

// Delete group (guard: no dependent groups/ledgers/items or voucher usage in the branch)
app.delete("/companies/:companyId/groups/:groupId", requireCompanyWriteAccess(ROLE_GROUPS.groupMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const groupId = new ObjectId(req.params.groupId);
    const existingGroup = await Groups.findOne({ _id: groupId, companyId });
    if (!existingGroup) {
      return res.status(404).json({ message: "Group not found" });
    }
    if (existingGroup.isSystem) {
      return res
        .status(400)
        .json({ message: "System groups cannot be deleted" });
    }

    const branchGroupIds = await getGroupBranchObjectIds(companyId, groupId);
    const hasChildGroups = branchGroupIds.length > 1;

    const [ledgerIds, itemIds] = await Promise.all([
      Ledgers.find(
        { companyId, groupId: { $in: branchGroupIds } },
        { projection: { _id: 1 } },
      ).toArray(),
      Items.find(
        { companyId, groupId: { $in: branchGroupIds } },
        { projection: { _id: 1 } },
      ).toArray(),
    ]);

    if (hasChildGroups || ledgerIds.length > 0 || itemIds.length > 0) {
      return res.status(400).json({
        message:
          "Group is in use (has child groups, ledgers, or items). Cannot delete.",
      });
    }

    const [ledgerVoucherUse, itemVoucherUse] = await Promise.all([
      ledgerIds.length
        ? Vouchers.countDocuments({
            ...activeVoucherFilter({ companyId }),
            "lines.ledgerId": { $in: ledgerIds.map((row) => row._id) },
          })
        : 0,
      itemIds.length
        ? Vouchers.countDocuments({
            ...activeVoucherFilter({ companyId }),
            "inventoryLines.itemId": { $in: itemIds.map((row) => row._id) },
          })
        : 0,
    ]);

    if (ledgerVoucherUse > 0 || itemVoucherUse > 0) {
      return res.status(400).json({
        message:
          "Group is used in vouchers through its branch. Cannot delete.",
      });
    }

    await Groups.deleteOne({ _id: groupId, companyId });
    res.json({ message: "Group deleted" });
  } catch (err) {
    console.error("Error deleting group:", err);
    res.status(500).json({ message: "Error deleting group" });
  }
});

// ---------- LEDGERS (CRUD) ----------

// List ledgers
app.get("/companies/:companyId/ledgers", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const ledgers = await Ledgers.aggregate([
    { $match: { companyId } },
    {
      $lookup: {
        from: "groups",
        localField: "groupId",
        foreignField: "_id",
        as: "group",
      },
    },
    { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
  ]).toArray();
  res.json(ledgers);
});

app.get("/companies/:companyId/ledgers/with-balances", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const toDate = safeDate(req.query.to);
    const [vouchers, ledgers] = await Promise.all([
      Vouchers.find(
        activeVoucherFilter(
          toDate ? { companyId, date: { $lte: toDate } } : { companyId },
        ),
      ).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
    ]);

    const balances = summarizeLedgerBalances(ledgers, vouchers, null, toDate);
    const rows = balances.map((ledger) => ({
      ...ledger,
      currentBalance: normalizeMoney(ledger.closing || 0),
      currentBalanceSide: ledger.closing >= 0 ? "DR" : "CR",
      currentBalanceAbs: normalizeMoney(Math.abs(ledger.closing || 0)),
    }));
    res.json(rows);
  } catch (err) {
    console.error("Error loading ledger balances:", err);
    res.status(500).json({ message: "Error loading ledger balances" });
  }
});

app.get("/companies/:companyId/ledgers/defaults", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const [ledgers, groups] = await Promise.all([
      Ledgers.find({ companyId }).toArray(),
      Groups.find({ companyId }).toArray(),
    ]);
    const groupById = new Map(
      groups.map((group) => [String(group._id), group]),
    );
    const bankAccountRoots = groups.filter(
      (group) => nameKey(group.name) === "bank accounts",
    );
    const bankAccountGroupIds = new Set(
      collectDescendantGroupIds(
        bankAccountRoots.map((group) => group._id),
        buildGroupChildrenMap(groups),
      ),
    );

    res.json({
      salesLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "sales") || null,
      purchaseLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "purchase") || null,
      cashLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "cash") || null,
      bankLedgers: ledgers.filter((ledger) =>
        bankAccountGroupIds.has(String(ledger.groupId)),
      ),
      debtorLedgers: ledgers.filter(
        (ledger) =>
          nameKey(groupById.get(String(ledger.groupId))?.name) ===
          "sundry debtors",
      ),
      creditorLedgers: ledgers.filter(
        (ledger) =>
          nameKey(groupById.get(String(ledger.groupId))?.name) ===
          "sundry creditors",
      ),
    });
  } catch (err) {
    console.error("Error loading default ledgers:", err);
    res.status(500).json({ message: "Error loading default ledgers" });
  }
});

// GET ledgers by group names (comma separated)
app.get("/companies/:companyId/ledgers/by-group", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const names = req.query.names?.split(",").map((n) => n.trim()) || [];

    if (!names.length)
      return res.status(400).json({ message: "Group names are required" });

    // 1️⃣ Load EVERY group of this company
    const allGroups = await Groups.find({ companyId }).toArray();

    // Helper: build map parentId → children
    const childMap = new Map();
    allGroups.forEach((g) => {
      const pid = g.parentId ? String(g.parentId) : "ROOT";
      if (!childMap.has(pid)) childMap.set(pid, []);
      childMap.get(pid).push(g);
    });

    // 2️⃣ Find root groups (the names we asked for)
    const selectedRoots = allGroups.filter((g) => names.includes(g.name));

    if (!selectedRoots.length) return res.json([]); // no match

    // 3️⃣ Recursively collect ALL children
    let groupIds = [];

    function collectGroupTree(group) {
      groupIds.push(group._id); // include itself
      const children = childMap.get(String(group._id)) || [];
      children.forEach((c) => collectGroupTree(c));
    }

    selectedRoots.forEach((root) => collectGroupTree(root));

    // 4️⃣ Get ledgers whose groupId is in ANY of these groups
    const ledgers = await Ledgers.find({
      companyId,
      groupId: { $in: groupIds },
    }).toArray();

    res.json(ledgers);
  } catch (err) {
    console.error("Error loading filtered ledgers:", err);
    res.status(500).json({ message: "Error loading filtered ledgers" });
  }
});

// Create ledger
app.post("/companies/:companyId/ledgers", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const name = normalizeName(req.body.name);
    const {
      groupId,
      openingBalance = 0,
      openingDrCr = "DR",
      priceLevelId = null,
      bankDetails = null,
    } = req.body;
    if (!name || !groupId) {
      return res
        .status(400)
        .json({ message: "Ledger name and group are required" });
    }

    const group = await Groups.findOne({
      _id: new ObjectId(groupId),
      companyId,
    });
    if (!group) {
      return res.status(400).json({ message: "Group not found" });
    }

    const duplicate = await Ledgers.findOne({
      companyId,
      name: {
        $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Ledger name already exists" });
    }

    const doc = {
      companyId,
      name,
      groupId: new ObjectId(groupId),
      openingBalance: Number(openingBalance) || 0,
      openingDrCr,
      priceLevelId: priceLevelId || null,
      createdAt: new Date(),
    };

    const normalizedBankDetails = normalizeBankLedgerDetails(bankDetails);
    if (normalizedBankDetails) {
      doc.bankDetails = normalizedBankDetails;
    }

    const result = await Ledgers.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating ledger:", err);
    res.status(500).json({ message: "Error creating ledger" });
  }
});

// Alter ledger
app.put("/companies/:companyId/ledgers/:ledgerId", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const ledgerId = new ObjectId(req.params.ledgerId);
    const name = normalizeName(req.body.name);
    const { groupId, openingBalance, openingDrCr, priceLevelId, bankDetails } =
      req.body;
    if (!name) {
      return res.status(400).json({ message: "Ledger name is required" });
    }

    if (groupId) {
      const group = await Groups.findOne({
        _id: new ObjectId(groupId),
        companyId,
      });
      if (!group) {
        return res.status(400).json({ message: "Group not found" });
      }
    }

    const duplicate = await Ledgers.findOne({
      _id: { $ne: ledgerId },
      companyId,
      name: {
        $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Ledger name already exists" });
    }

    const update = {
      $set: {
        name,
        groupId: groupId ? new ObjectId(groupId) : undefined,
        openingBalance:
          openingBalance !== undefined ? Number(openingBalance) : undefined,
        openingDrCr,
        priceLevelId:
          priceLevelId !== undefined ? priceLevelId || null : undefined,
      },
    };

    if (bankDetails !== undefined) {
      const normalizedBankDetails = normalizeBankLedgerDetails(bankDetails);
      if (normalizedBankDetails) {
        update.$set.bankDetails = normalizedBankDetails;
      } else {
        update.$unset = { ...(update.$unset || {}), bankDetails: "" };
      }
    }

    // Clean undefined keys
    Object.keys(update.$set).forEach(
      (k) => update.$set[k] === undefined && delete update.$set[k],
    );

    await Ledgers.updateOne({ _id: ledgerId, companyId }, update);
    const updated = await Ledgers.findOne({ _id: ledgerId, companyId });
    res.json(updated);
  } catch (err) {
    console.error("Error updating ledger:", err);
    res.status(500).json({ message: "Error updating ledger" });
  }
});

// Delete ledger (guard: no vouchers using it)
app.delete("/companies/:companyId/ledgers/:ledgerId", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const ledgerId = new ObjectId(req.params.ledgerId);
    const existingLedger = await Ledgers.findOne({ _id: ledgerId, companyId });
    if (!existingLedger) {
      return res.status(404).json({ message: "Ledger not found" });
    }
    if (existingLedger.isSystem) {
      return res
        .status(400)
        .json({ message: "System ledgers cannot be deleted" });
    }

    const used = await Vouchers.countDocuments({
      ...activeVoucherFilter({ companyId }),
      "lines.ledgerId": ledgerId,
    });

    if (used > 0) {
      return res.status(400).json({
        message: "Ledger is used in vouchers. Cannot delete.",
      });
    }

    await Ledgers.deleteOne({ _id: ledgerId, companyId });
    res.json({ message: "Ledger deleted" });
  } catch (err) {
    console.error("Error deleting ledger:", err);
    res.status(500).json({ message: "Error deleting ledger" });
  }
});

// ---------- VOUCHER TYPES (CRUD / defaults are set on company create) ----------

// List voucher types
app.get("/companies/:companyId/voucher-types", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const list = await VoucherTypes.find({ companyId }).toArray();
  res.json(list);
});

// Create voucher type
app.post("/companies/:companyId/voucher-types", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const { name, category = "ACCOUNTING" } = req.body;
    const doc = { companyId, name, category, createdAt: new Date() };
    const result = await VoucherTypes.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating voucher type:", err);
    res.status(500).json({ message: "Error creating voucher type" });
  }
});

// Alter voucher type
app.put(
  "/companies/:companyId/voucher-types/:voucherTypeId",
  requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters),
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const voucherTypeId = new ObjectId(req.params.voucherTypeId);
      const { name, category } = req.body;

      const update = { $set: {} };
      if (name) update.$set.name = name;
      if (category) update.$set.category = category;

      await VoucherTypes.updateOne({ _id: voucherTypeId, companyId }, update);
      const updated = await VoucherTypes.findOne({
        _id: voucherTypeId,
        companyId,
      });
      res.json(updated);
    } catch (err) {
      console.error("Error updating voucher type:", err);
      res.status(500).json({ message: "Error updating voucher type" });
    }
  },
);

// Delete voucher type (if not used)
app.delete(
  "/companies/:companyId/voucher-types/:voucherTypeId",
  requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters),
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const voucherTypeId = new ObjectId(req.params.voucherTypeId);

      const used = await Vouchers.countDocuments({ companyId, voucherTypeId });
      if (used > 0) {
        return res
          .status(400)
          .json({ message: "Voucher type in use. Cannot delete." });
      }

      await VoucherTypes.deleteOne({ _id: voucherTypeId, companyId });
      res.json({ message: "Voucher type deleted" });
    } catch (err) {
      console.error("Error deleting voucher type:", err);
      res.status(500).json({ message: "Error deleting voucher type" });
    }
  },
);

// ---------- VOUCHERS (create / alter / delete) --------

app.get("/companies/:companyId/customers", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const phone = normalizePhone(req.query.phone);
    const query = normalizeName(req.query.q || "");
    const filter = { companyId };

    if (phone) {
      filter.phone = { $regex: phone };
    }
    if (query) {
      filter.$or = [
        { name: { $regex: escapeRegex(query), $options: "i" } },
        { phone: { $regex: escapeRegex(query), $options: "i" } },
        { address: { $regex: escapeRegex(query), $options: "i" } },
      ];
    }

    const rows = await Customers.find(filter)
      .sort({ lastPurchaseAt: -1, name: 1 })
      .limit(limit)
      .toArray();

    res.json(rows);
  } catch (err) {
    console.error("Error loading customers:", err);
    res.status(500).json({ message: "Error loading customers" });
  }
});

app.get(
  "/companies/:companyId/customers/purchase-history",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const phone = normalizePhone(req.query.phone || "");

      if (!phone) {
        return res.json({ customer: null, purchases: [] });
      }

      const [customer, vouchers] = await Promise.all([
        Customers.findOne({ companyId, phone }),
        Vouchers.find(
          activeVoucherFilter({
            companyId,
            voucherName: { $regex: "^POS Voucher$", $options: "i" },
            "customerSnapshot.phone": phone,
          }),
        )
          .sort({ date: -1, createdAt: -1, _id: -1 })
          .toArray(),
      ]);

      const purchases = [];
      vouchers.forEach((voucher) => {
        const purchaseDate = voucher.date
          ? new Date(voucher.date).toISOString().slice(0, 10)
          : "";
        (voucher.inventoryLines || []).forEach((line) => {
          purchases.push({
            voucherId: voucher._id,
            voucherNumber: voucher.number || "",
            purchaseDate,
            itemId: line.itemId || null,
            itemName: line.itemName || "",
            qty: normalizeMoney(line.qty || line.billedQty || 0),
          });
        });
      });

      return res.json({
        customer: customer
          ? {
              _id: customer._id,
              name: customer.name || "",
              phone: customer.phone || "",
              address: customer.address || "",
              rewardPoints: normalizeMoney(customer.rewardPoints || 0),
            }
          : null,
        purchases,
      });
    } catch (err) {
      console.error("Error loading customer purchase history:", err);
      return res
        .status(500)
        .json({ message: "Error loading customer purchase history" });
    }
  },
);

app.post("/companies/:companyId/pos-vouchers", requireCompanyWriteAccess(ROLE_GROUPS.accountingVouchers), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const {
      voucherTypeId,
      number,
      date,
      narration,
      customer,
      salesMeta,
      salesLedgerId,
      payments = {},
      discountType = "fixed",
      discountValue = 0,
      redeemedPoints = 0,
      items = [],
    } = req.body;

    const normalizedPhone = normalizePhone(customer?.phone);
    if (!normalizedPhone) {
      return res
        .status(400)
        .json({ message: "Customer phone number is required" });
    }
    if (!normalizeName(customer?.name)) {
      return res.status(400).json({ message: "Customer name is required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one POS item is required" });
    }

    const posVoucherType =
      (voucherTypeId &&
        (await VoucherTypes.findOne({
          _id: new ObjectId(voucherTypeId),
          companyId,
        }))) ||
      (await VoucherTypes.findOne({
        companyId,
        name: { $regex: "^POS Voucher$", $options: "i" },
      }));

    if (!posVoucherType) {
      return res.status(400).json({ message: "POS Voucher type not found" });
    }

    const { salesLedger, cashLedger, bankLedger } =
      await resolveDefaultPosLedgers(companyId);
    const resolvedSalesLedger =
      (salesLedgerId &&
        (await Ledgers.findOne({
          _id: new ObjectId(salesLedgerId),
          companyId,
        }))) ||
      salesLedger;

    if (!resolvedSalesLedger) {
      return res
        .status(400)
        .json({ message: "Sales ledger is missing for this company" });
    }

    const itemIds = items
      .filter((row) => row?.itemId && ObjectId.isValid(row.itemId))
      .map((row) => new ObjectId(row.itemId));
    const [itemDocs, groups, categories] = await Promise.all([
      Items.find({ companyId, _id: { $in: itemIds } }).toArray(),
      Groups.find({ companyId }).toArray(),
      StockCategories.find({ companyId }).toArray(),
    ]);
    const itemMap = new Map(itemDocs.map((row) => [String(row._id), row]));
    const groupMap = new Map(groups.map((row) => [String(row._id), row]));
    const categoryMap = new Map(
      categories.map((row) => [String(row._id), row]),
    );

    const inventoryLines = items
      .filter((row) => row?.itemId && itemMap.has(String(row.itemId)))
      .map((row) => {
        const item = itemMap.get(String(row.itemId));
        const qty = Number(row.qty || 0);
        const rate = Number(row.rate || 0);
        const mrpRate = Number(row.mrpRate || rate || 0);
        const rowDiscountType = row.discountType || "percent";
        const rowDiscountValue = Number(row.discountValue || 0);
        const grossAmount = multiplyMoney(qty, rate);
        const rowDiscountAmount =
          rowDiscountType === "percent"
            ? multiplyMoney(grossAmount, rowDiscountValue / 100)
            : normalizeMoney(rowDiscountValue);
        const amount = subtractMoney(grossAmount, rowDiscountAmount);
        return {
          itemId: item._id,
          itemName: normalizeName(item.name),
          qty,
          billedQty: qty,
          rate,
          mrpRate,
          amount,
          discount: rowDiscountAmount,
          discountType: rowDiscountType,
          discountValue: rowDiscountValue,
          groupId: item.groupId || null,
          groupName: normalizeName(
            row.groupName ||
              groupMap.get(String(item.groupId || ""))?.name ||
              "",
          ),
          stockCategoryId: item.stockCategoryId || null,
          stockCategoryName: normalizeName(
            row.stockCategoryName ||
              categoryMap.get(String(item.stockCategoryId || ""))?.name ||
              item.stockCategory ||
              "",
          ),
          alias: normalizeName(item.alias || ""),
          barcode: normalizeName(item.barcode || ""),
        };
      });

    if (inventoryLines.length === 0) {
      return res.status(400).json({ message: "No valid POS items found" });
    }

    const subtotal = inventoryLines.reduce(
      (sum, row) => sumMoney(sum, row.amount || 0),
      0,
    );
    const invoiceDiscount =
      discountType === "percent"
        ? multiplyMoney(subtotal, Number(discountValue || 0) / 100)
        : normalizeMoney(discountValue || 0);
    const rewardRedeemed = normalizeMoney(redeemedPoints || 0);
    const totalAmount = subtractMoney(subtotal, invoiceDiscount, rewardRedeemed);

    const cashAmount = normalizeMoney(payments.cash || 0);
    const cardAmount = normalizeMoney(payments.card || 0);
    const totalPaid = sumMoney(cashAmount, cardAmount);

    if (!moneyEquals(totalPaid, totalAmount)) {
      return res
        .status(400)
        .json({ message: "Payment total must match total amount payable" });
    }

    const rewardEarned = inventoryLines.reduce(
      (sum, row) => sumMoney(sum, multiplyMoney(row.mrpRate || 0, row.qty || 0)),
      0,
    );

    const existingCustomer = await Customers.findOne({
      companyId,
      phone: normalizedPhone,
    });
    if (rewardRedeemed > Number(existingCustomer?.rewardPoints || 0)) {
      return res
        .status(400)
        .json({ message: "Customer does not have enough reward points" });
    }

    const customerDoc = await upsertPosCustomer(companyId, customer, {
      rewardEarned,
      rewardRedeemed,
      totalAmount,
      date,
    });

    const lines = [];
    if (cashAmount > 0) {
      if (!cashLedger) {
        return res
          .status(400)
          .json({ message: "Cash ledger is missing for POS cash payment" });
      }
      lines.push({ ledgerId: cashLedger._id, debit: cashAmount, credit: 0 });
    }
    if (cardAmount > 0) {
      if (!bankLedger) {
        return res
          .status(400)
          .json({ message: "Bank ledger is missing for POS card payment" });
      }
      lines.push({ ledgerId: bankLedger._id, debit: cardAmount, credit: 0 });
    }
    lines.push({
      ledgerId: resolvedSalesLedger._id,
      debit: 0,
      credit: totalAmount,
    });

    const doc = {
      companyId,
      voucherName: "POS Voucher",
      voucherTypeId: posVoucherType._id,
      number,
      date: new Date(date),
      narration: narration || "",
      lines,
      inventoryLines,
      customerId: customerDoc._id,
      customerSnapshot: {
        name: customerDoc.name,
        phone: customerDoc.phone,
        address: customerDoc.address || "",
      },
      posMeta: {
        discountType,
        discountValue: normalizeMoney(discountValue || 0),
        invoiceDiscount,
        subtotal,
        totalAmount,
        rewardEarned,
        rewardRedeemed,
        cashAmount,
        cardAmount,
        cashTendered: normalizeMoney(payments.cashTendered || 0),
        changeAmount: subtractMoney(payments.cashTendered || 0, cashAmount),
      },
      createdAt: new Date(),
    };

    const normalizedSalesMeta = normalizeSalesMeta(salesMeta);
    if (normalizedSalesMeta) {
      doc.salesMeta = normalizedSalesMeta;
    }

    const result = await Vouchers.insertOne(doc);
    res
      .status(201)
      .json({ _id: result.insertedId, ...doc, customer: customerDoc });
  } catch (err) {
    console.error("Error creating POS voucher:", err);
    res
      .status(500)
      .json({ message: err.message || "Error creating POS voucher" });
  }
});

app.get(
  "/companies/:companyId/reports/customer-behaviour/overview",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const voucherFilter = {
        companyId,
        voucherName: { $regex: "^POS Voucher$", $options: "i" },
      };
      if (fromDate || toDate) {
        voucherFilter.date = {};
        if (fromDate) voucherFilter.date.$gte = fromDate;
        if (toDate) {
          const inclusiveTo = new Date(toDate);
          inclusiveTo.setHours(23, 59, 59, 999);
          voucherFilter.date.$lte = inclusiveTo;
        }
      }

      const [customers, vouchers] = await Promise.all([
        Customers.find({ companyId })
          .sort({ lastPurchaseAt: -1, name: 1 })
          .toArray(),
        Vouchers.find(activeVoucherFilter(voucherFilter))
          .sort({ date: -1 })
          .toArray(),
      ]);

      const uniqueCustomerIds = new Set(
        vouchers
          .filter((voucher) => voucher.customerId)
          .map((voucher) => String(voucher.customerId)),
      );
      const totalSales = normalizeMoney(
        vouchers.reduce(
          (sum, voucher) => sum + Number(voucher.posMeta?.totalAmount || 0),
          0,
        ),
      );
      const totalRewardsEarned = normalizeMoney(
        vouchers.reduce(
          (sum, voucher) => sum + Number(voucher.posMeta?.rewardEarned || 0),
          0,
        ),
      );
      const totalRewardsRedeemed = normalizeMoney(
        vouchers.reduce(
          (sum, voucher) => sum + Number(voucher.posMeta?.rewardRedeemed || 0),
          0,
        ),
      );

      const customerRows = customers.map((customer) => {
        const customerVouchers = vouchers.filter(
          (voucher) =>
            String(voucher.customerId || "") === String(customer._id),
        );
        const spent = normalizeMoney(
          customerVouchers.reduce(
            (sum, voucher) => sum + Number(voucher.posMeta?.totalAmount || 0),
            0,
          ),
        );
        return {
          customerId: customer._id,
          name: customer.name,
          phone: customer.phone,
          address: customer.address || "",
          rewardPoints: normalizeMoney(customer.rewardPoints || 0),
          totalOrders: customerVouchers.length,
          totalSpent: spent,
          averageOrderValue: customerVouchers.length
            ? normalizeMoney(spent / customerVouchers.length)
            : 0,
          lastPurchaseAt:
            customerVouchers[0]?.date || customer.lastPurchaseAt || null,
        };
      });

      res.json({
        summary: {
          totalCustomers: customers.length,
          activeCustomers: uniqueCustomerIds.size,
          totalOrders: vouchers.length,
          totalSales,
          totalRewardsEarned,
          totalRewardsRedeemed,
        },
        customers: customerRows,
        recentVouchers: vouchers.slice(0, 20).map((voucher) => ({
          voucherId: voucher._id,
          date: voucher.date,
          number: voucher.number,
          customerName: voucher.customerSnapshot?.name || "",
          phone: voucher.customerSnapshot?.phone || "",
          totalAmount: normalizeMoney(voucher.posMeta?.totalAmount || 0),
          rewardEarned: normalizeMoney(voucher.posMeta?.rewardEarned || 0),
        })),
      });
    } catch (err) {
      console.error("Error loading customer behaviour overview:", err);
      res
        .status(500)
        .json({ message: "Error loading customer behaviour overview" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/customer-behaviour/product-wise",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const itemId =
        req.query.itemId && ObjectId.isValid(req.query.itemId)
          ? new ObjectId(req.query.itemId)
          : null;
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const voucherFilter = {
        companyId,
        voucherName: { $regex: "^POS Voucher$", $options: "i" },
      };
      if (fromDate || toDate) {
        voucherFilter.date = {};
        if (fromDate) voucherFilter.date.$gte = fromDate;
        if (toDate) {
          const inclusiveTo = new Date(toDate);
          inclusiveTo.setHours(23, 59, 59, 999);
          voucherFilter.date.$lte = inclusiveTo;
        }
      }
      const vouchers = await Vouchers.find(activeVoucherFilter(voucherFilter))
        .sort({ date: -1 })
        .toArray();

      const productMap = new Map();
      vouchers.forEach((voucher) => {
        (voucher.inventoryLines || []).forEach((line) => {
          if (itemId && String(line.itemId) !== String(itemId)) return;
          const key = String(line.itemId);
          if (!productMap.has(key)) {
            productMap.set(key, {
              itemId: line.itemId,
              itemName: line.itemName,
              groupName: line.groupName || "",
              stockCategoryName: line.stockCategoryName || "",
              totalQty: 0,
              totalAmount: 0,
              customers: [],
            });
          }
          const current = productMap.get(key);
          current.totalQty = normalizeMoney(
            current.totalQty + Number(line.qty || 0),
          );
          current.totalAmount = normalizeMoney(
            current.totalAmount + Number(line.amount || 0),
          );
          current.customers.push({
            customerId: voucher.customerId || null,
            customerName: voucher.customerSnapshot?.name || "",
            phone: voucher.customerSnapshot?.phone || "",
            address: voucher.customerSnapshot?.address || "",
            voucherId: voucher._id,
            voucherNo: voucher.number || "",
            purchaseDate: voucher.date,
            qty: Number(line.qty || 0),
            amount: normalizeMoney(line.amount || 0),
          });
        });
      });

      res.json(
        [...productMap.values()]
          .map((row) => ({
            ...row,
            uniqueCustomers: new Set(
              row.customers.map(
                (entry) => entry.phone || String(entry.customerId || ""),
              ),
            ).size,
            customers: row.customers.sort(
              (left, right) =>
                new Date(right.purchaseDate) - new Date(left.purchaseDate),
            ),
          }))
          .sort((left, right) => left.itemName.localeCompare(right.itemName)),
      );
    } catch (err) {
      console.error("Error loading product-wise customer report:", err);
      res
        .status(500)
        .json({ message: "Error loading product-wise customer report" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/customer-behaviour/stock-group-wise",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const vouchers = await Vouchers.find(
        activeVoucherFilter({
          companyId,
          voucherName: { $regex: "^POS Voucher$", $options: "i" },
        }),
      )
        .sort({ date: -1 })
        .toArray();

      const groupMap = new Map();
      vouchers.forEach((voucher) => {
        (voucher.inventoryLines || []).forEach((line) => {
          const key = line.groupName || "Ungrouped";
          if (!groupMap.has(key)) {
            groupMap.set(key, {
              groupName: key,
              totalQty: 0,
              totalAmount: 0,
              customers: new Map(),
              lastPurchaseAt: null,
            });
          }
          const current = groupMap.get(key);
          current.totalQty = normalizeMoney(
            current.totalQty + Number(line.qty || 0),
          );
          current.totalAmount = normalizeMoney(
            current.totalAmount + Number(line.amount || 0),
          );
          const customerKey =
            voucher.customerSnapshot?.phone || String(voucher.customerId || "");
          const customerExisting = current.customers.get(customerKey) || {
            customerName: voucher.customerSnapshot?.name || "",
            phone: voucher.customerSnapshot?.phone || "",
            totalQty: 0,
            totalAmount: 0,
            lastPurchaseAt: null,
          };
          customerExisting.totalQty = normalizeMoney(
            customerExisting.totalQty + Number(line.qty || 0),
          );
          customerExisting.totalAmount = normalizeMoney(
            customerExisting.totalAmount + Number(line.amount || 0),
          );
          customerExisting.lastPurchaseAt = voucher.date;
          current.customers.set(customerKey, customerExisting);
          current.lastPurchaseAt = voucher.date;
        });
      });

      res.json(
        [...groupMap.values()]
          .map((row) => ({
            groupName: row.groupName,
            totalQty: row.totalQty,
            totalAmount: row.totalAmount,
            uniqueCustomers: row.customers.size,
            lastPurchaseAt: row.lastPurchaseAt,
            customers: [...row.customers.values()].sort(
              (left, right) =>
                new Date(right.lastPurchaseAt) - new Date(left.lastPurchaseAt),
            ),
          }))
          .sort((left, right) => left.groupName.localeCompare(right.groupName)),
      );
    } catch (err) {
      console.error("Error loading stock group-wise customer report:", err);
      res
        .status(500)
        .json({ message: "Error loading stock group-wise customer report" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/customer-behaviour/category-wise",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const vouchers = await Vouchers.find(
        activeVoucherFilter({
          companyId,
          voucherName: { $regex: "^POS Voucher$", $options: "i" },
        }),
      )
        .sort({ date: -1 })
        .toArray();

      const categoryMap = new Map();
      vouchers.forEach((voucher) => {
        (voucher.inventoryLines || []).forEach((line) => {
          const key = line.stockCategoryName || "Uncategorized";
          if (!categoryMap.has(key)) {
            categoryMap.set(key, {
              categoryName: key,
              totalQty: 0,
              totalAmount: 0,
              uniqueCustomers: new Set(),
              purchases: [],
            });
          }
          const current = categoryMap.get(key);
          current.totalQty = normalizeMoney(
            current.totalQty + Number(line.qty || 0),
          );
          current.totalAmount = normalizeMoney(
            current.totalAmount + Number(line.amount || 0),
          );
          current.uniqueCustomers.add(
            voucher.customerSnapshot?.phone || String(voucher.customerId || ""),
          );
          current.purchases.push({
            customerName: voucher.customerSnapshot?.name || "",
            phone: voucher.customerSnapshot?.phone || "",
            itemName: line.itemName || "",
            qty: Number(line.qty || 0),
            amount: normalizeMoney(line.amount || 0),
            purchaseDate: voucher.date,
          });
        });
      });

      res.json(
        [...categoryMap.values()]
          .map((row) => ({
            categoryName: row.categoryName,
            totalQty: row.totalQty,
            totalAmount: row.totalAmount,
            uniqueCustomers: row.uniqueCustomers.size,
            purchases: row.purchases.sort(
              (left, right) =>
                new Date(right.purchaseDate) - new Date(left.purchaseDate),
            ),
          }))
          .sort((left, right) =>
            left.categoryName.localeCompare(right.categoryName),
          ),
      );
    } catch (err) {
      console.error("Error loading stock category-wise customer report:", err);
      res
        .status(500)
        .json({ message: "Error loading stock category-wise customer report" });
    }
  },
);

// List vouchers (basic)
// GET vouchers for a company + voucher type
app.get("/companies/:companyId/vouchers", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const { type, from, to } = req.query;

  const filter = activeVoucherFilter({ companyId });

  if (type) {
    filter.voucherTypeId = new ObjectId(type);
  }

  const fromDate = safeDate(from);
  const toDate = safeDate(to);

  if (fromDate || toDate) {
    filter.date = {};
    if (fromDate) filter.date.$gte = fromDate;
    if (toDate) {
      const inclusiveTo = new Date(toDate);
      inclusiveTo.setHours(23, 59, 59, 999);
      filter.date.$lte = inclusiveTo;
    }
  }

  const list = await Vouchers.find(activeVoucherFilter(filter))
    .sort({ date: -1, createdAt: -1 })
    .toArray();
  res.json(list);
});

app.get("/companies/:companyId/vouchers/:voucherId", async (req, res, next) => {
  try {
    if (req.params.voucherId === "next-number") {
      return next();
    }
    const companyId = new ObjectId(req.params.companyId);
    const voucherId = new ObjectId(req.params.voucherId);
    const voucher = await Vouchers.findOne(
      activeVoucherFilter({ _id: voucherId, companyId }),
    );
    if (!voucher) {
      return res.status(404).json({ message: "Voucher not found" });
    }
    res.json(voucher);
  } catch (err) {
    console.error("Error loading voucher:", err);
    res.status(500).json({ message: "Error loading voucher" });
  }
});

// Create voucher (like Tally: one header + many lines)
// CREATE PURCHASE / SALES / INVENTORY VOUCHER
app.post("/companies/:companyId/vouchers", requireCompanyWriteAccess(ROLE_GROUPS.accountingVouchers), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const actor = getRequestActor(req);

    const {
      voucherTypeId,
      voucherName,
      number,
      date,
      narration,
      commercialMeta,
      salesMeta,
      manufacturingMeta,
      lines,
      inventoryLines,
    } = req.body;

    const voucherType = await VoucherTypes.findOne({
      _id: new ObjectId(voucherTypeId),
      companyId,
    });
    if (!voucherType) {
      return res.status(400).json({ message: "Voucher type not found" });
    }

    // Validate accounting lines
    const validLines = Array.isArray(lines)
      ? lines.filter((line) => line?.ledgerId)
      : [];
    if (voucherType.category !== "INVENTORY" && validLines.length < 2) {
      return res
        .status(400)
        .json({ message: "Voucher must have at least 2 accounting lines" });
    }

    // Validate inventory lines
    const normalizedInventory = (inventoryLines || [])
      .filter((line) => line?.itemId)
      .map(normalizeInventoryLinePayload);

    let totalDr = 0;
    let totalCr = 0;

    const normalizedLines = validLines.map((l) => {
      const debit = Number(l.debit) || 0;
      const credit = Number(l.credit) || 0;
      totalDr += debit;
      totalCr += credit;

      return {
        ledgerId: new ObjectId(l.ledgerId),
        debit,
        credit,
      };
    });

    if (normalizedLines.length > 0) {
      const ledgerIds = normalizedLines.map((line) => line.ledgerId);
      const ownedLedgers = await Ledgers.find({
        companyId,
        _id: { $in: ledgerIds },
      })
        .project({ _id: 1 })
        .toArray();
      if (ownedLedgers.length !== ledgerIds.length) {
        return res.status(400).json({
          message: "One or more selected ledgers do not belong to this company",
        });
      }
    }

    if (
      voucherType.category !== "INVENTORY" &&
      totalDr.toFixed(2) !== totalCr.toFixed(2)
    ) {
      return res.status(400).json({
        message: "Total Debit and Credit must be equal",
      });
    }

    const createdStamp = buildAuditStamp(actor);
    const doc = {
      companyId,
      voucherName: normalizeName(voucherName || voucherType.name),
      voucherTypeId: new ObjectId(voucherTypeId),
      number,
      date: new Date(date),
      narration: narration || "",
      lines: voucherType.category === "INVENTORY" ? [] : normalizedLines,
      inventoryLines: normalizedInventory,
      createdAt: createdStamp.at,
      updatedAt: createdStamp.at,
      createdBy: createdStamp.by,
      updatedBy: createdStamp.by,
      isDeleted: false,
    };

    if (commercialMeta) {
      doc.commercialMeta = {
        subtotal: normalizeMoney(commercialMeta.subtotal || 0),
        lineDiscountTotal: normalizeMoney(
          commercialMeta.lineDiscountTotal || 0,
        ),
        invoiceDiscount: normalizeMoney(commercialMeta.invoiceDiscount || 0),
        additionalCharges: normalizeMoney(
          commercialMeta.additionalCharges || 0,
        ),
        totalAmount: normalizeMoney(commercialMeta.totalAmount || 0),
      };
    }

    if (salesMeta) {
      const normalizedSalesMeta = normalizeSalesMeta(salesMeta);
      if (normalizedSalesMeta) {
        doc.salesMeta = normalizedSalesMeta;
      }
    }

    if (manufacturingMeta) {
      doc.manufacturingMeta = normalizeManufacturingMeta(manufacturingMeta);
    }

    const result = await Vouchers.insertOne(doc);
    await logAuditEvent({
      companyId,
      entityType: "voucher",
      entityId: result.insertedId,
      action: "create",
      actor,
      after: { ...doc, _id: result.insertedId },
    });
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating voucher:", err);
    res.status(500).json({ message: "Error creating voucher" });
  }
});

// Alter voucher
app.put("/companies/:companyId/vouchers/:voucherId", requireCompanyWriteAccess(ROLE_GROUPS.accountingVouchers), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const voucherId = new ObjectId(req.params.voucherId);
    const actor = getRequestActor(req);
    const existingVoucher = await Vouchers.findOne(
      activeVoucherFilter({
        _id: voucherId,
        companyId,
      }),
    );
    if (!existingVoucher) {
      return res.status(404).json({ message: "Voucher not found" });
    }
    const {
      voucherTypeId,
      voucherName,
      number,
      date,
      narration,
      referenceNo,
      customerId,
      customerSnapshot,
      commercialMeta,
      posMeta,
      salesMeta,
      manufacturingMeta,
      lines,
      inventoryLines,
    } = req.body;

    const update = { $set: {}, $unset: {} };
    let voucherType = null;

    if (voucherTypeId) {
      update.$set.voucherTypeId = new ObjectId(voucherTypeId);
      voucherType = await VoucherTypes.findOne({
        _id: new ObjectId(voucherTypeId),
        companyId,
      });
    }
    if (voucherName) update.$set.voucherName = normalizeName(voucherName);
    if (number !== undefined) update.$set.number = number;
    if (date) update.$set.date = new Date(date);
    if (narration !== undefined) update.$set.narration = narration;
    if (referenceNo !== undefined) update.$set.referenceNo = referenceNo;
    if (customerId && ObjectId.isValid(customerId))
      update.$set.customerId = new ObjectId(customerId);
    if (customerSnapshot) {
      update.$set.customerSnapshot = {
        name: normalizeName(customerSnapshot.name || ""),
        phone: normalizePhone(customerSnapshot.phone || ""),
        address: normalizeName(customerSnapshot.address || ""),
      };
    }
    if (commercialMeta) {
      update.$set.commercialMeta = {
        subtotal: normalizeMoney(commercialMeta.subtotal || 0),
        lineDiscountTotal: normalizeMoney(
          commercialMeta.lineDiscountTotal || 0,
        ),
        invoiceDiscount: normalizeMoney(commercialMeta.invoiceDiscount || 0),
        additionalCharges: normalizeMoney(
          commercialMeta.additionalCharges || 0,
        ),
        totalAmount: normalizeMoney(commercialMeta.totalAmount || 0),
      };
    }
    if (posMeta) {
      update.$set.posMeta = {
        discountType: posMeta.discountType || "fixed",
        discountValue: normalizeMoney(posMeta.discountValue || 0),
        invoiceDiscount: normalizeMoney(posMeta.invoiceDiscount || 0),
        subtotal: normalizeMoney(posMeta.subtotal || 0),
        totalAmount: normalizeMoney(posMeta.totalAmount || 0),
        rewardEarned: normalizeMoney(posMeta.rewardEarned || 0),
        rewardRedeemed: normalizeMoney(posMeta.rewardRedeemed || 0),
        cashAmount: normalizeMoney(posMeta.cashAmount || 0),
        cardAmount: normalizeMoney(posMeta.cardAmount || 0),
        cashTendered: normalizeMoney(posMeta.cashTendered || 0),
        changeAmount: normalizeMoney(posMeta.changeAmount || 0),
      };
    }
    if (salesMeta !== undefined) {
      const normalizedSalesMeta = normalizeSalesMeta(salesMeta);
      if (normalizedSalesMeta) {
        update.$set.salesMeta = normalizedSalesMeta;
        delete update.$unset.salesMeta;
      } else {
        update.$unset.salesMeta = "";
      }
    }
    if (manufacturingMeta) {
      update.$set.manufacturingMeta =
        normalizeManufacturingMeta(manufacturingMeta);
    }

    if (Array.isArray(lines)) {
      const validLines = lines.filter((line) => line?.ledgerId);
      let totalDr = 0;
      let totalCr = 0;
      const normalizedLines = validLines.map((l) => {
        const debit = Number(l.debit) || 0;
        const credit = Number(l.credit) || 0;
        totalDr += debit;
        totalCr += credit;
        return {
          ledgerId: new ObjectId(l.ledgerId),
          debit,
          credit,
        };
      });
      if (normalizedLines.length > 0) {
        const ledgerIds = normalizedLines.map((line) => line.ledgerId);
        const ownedLedgers = await Ledgers.find({
          companyId,
          _id: { $in: ledgerIds },
        })
          .project({ _id: 1 })
          .toArray();
        if (ownedLedgers.length !== ledgerIds.length) {
          return res.status(400).json({
            message:
              "One or more selected ledgers do not belong to this company",
          });
        }
      }
      if (
        voucherType?.category !== "INVENTORY" &&
        totalDr.toFixed(2) !== totalCr.toFixed(2)
      ) {
        return res
          .status(400)
          .json({ message: "Total Debit and Credit must be equal" });
      }
      update.$set.lines =
        voucherType?.category === "INVENTORY" ? [] : normalizedLines;
    }

    if (Array.isArray(inventoryLines)) {
      update.$set.inventoryLines = inventoryLines
        .filter((line) => line?.itemId)
        .map(normalizeInventoryLinePayload);
    }

    if (Object.keys(update.$unset).length === 0) {
      delete update.$unset;
    }

    const updatedStamp = buildAuditStamp(actor);
    update.$set.updatedAt = updatedStamp.at;
    update.$set.updatedBy = updatedStamp.by;

    await Vouchers.updateOne(
      activeVoucherFilter({ _id: voucherId, companyId }),
      update,
    );
    const updated = await Vouchers.findOne(
      activeVoucherFilter({ _id: voucherId, companyId }),
    );
    if (
      nameKey(existingVoucher.voucherName || "") === "pos voucher" ||
      nameKey(updated?.voucherName || "") === "pos voucher"
    ) {
      await rebuildPosCustomerFromVouchers(
        companyId,
        existingVoucher.customerSnapshot?.phone,
      );
      const nextPhone = updated?.customerSnapshot?.phone;
      if (
        normalizePhone(nextPhone) !==
        normalizePhone(existingVoucher.customerSnapshot?.phone)
      ) {
        await rebuildPosCustomerFromVouchers(companyId, nextPhone);
      }
    }
    await logAuditEvent({
      companyId,
      entityType: "voucher",
      entityId: voucherId,
      action: "update",
      actor,
      before: existingVoucher,
      after: updated,
    });
    res.json(updated);
  } catch (err) {
    console.error("Error updating voucher:", err);
    res.status(500).json({ message: "Error updating voucher" });
  }
});

// Delete voucher
app.delete("/companies/:companyId/vouchers/:voucherId", requireCompanyWriteAccess(ROLE_GROUPS.accountingVouchers), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const voucherId = new ObjectId(req.params.voucherId);
    const actor = getRequestActor(req);
    const existingVoucher = await Vouchers.findOne(
      activeVoucherFilter({ _id: voucherId, companyId }),
    );
    if (!existingVoucher) {
      return res.status(404).json({ message: "Voucher not found" });
    }

    const deletedStamp = buildAuditStamp(actor);
    await Vouchers.updateOne(
      activeVoucherFilter({ _id: voucherId, companyId }),
      {
        $set: {
          isDeleted: true,
          deletedAt: deletedStamp.at,
          deletedBy: deletedStamp.by,
          updatedAt: deletedStamp.at,
          updatedBy: deletedStamp.by,
        },
      },
    );
    await logAuditEvent({
      companyId,
      entityType: "voucher",
      entityId: voucherId,
      action: "delete",
      actor,
      before: existingVoucher,
      after: {
        ...existingVoucher,
        isDeleted: true,
        deletedAt: deletedStamp.at,
        deletedBy: deletedStamp.by,
      },
    });
    res.json({ message: "Voucher deleted" });
  } catch (err) {
    console.error("Error deleting voucher:", err);
    res.status(500).json({ message: "Error deleting voucher" });
  }
});

// Get next voucher number for a voucher type
app.get("/companies/:companyId/vouchers/next-number", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const { voucherTypeId } = req.query;

    if (!voucherTypeId || !ObjectId.isValid(voucherTypeId)) {
      return res.status(400).json({ message: "voucherTypeId required" });
    }

    const voucherTypeObjectId = new ObjectId(voucherTypeId);
    const [company, voucherType, vouchers] = await Promise.all([
      Companies.findOne({ _id: companyId }),
      VoucherTypes.findOne({ _id: voucherTypeObjectId, companyId }),
      Vouchers.find(
        activeVoucherFilter({
          companyId,
          voucherTypeId: voucherTypeObjectId,
        }),
      )
        .project({ number: 1 })
        .toArray(),
    ]);

    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }
    if (!voucherType) {
      return res.status(404).json({ message: "Voucher type not found" });
    }

    const companySlug = slugifySegment(company.name || "company") || "company";
    const voucherSlug =
      slugifySegment(voucherType.name || "voucher") || "voucher";
    const prefix = `${companySlug}-${voucherSlug}-`;

    let maxSequence = 0;
    for (const voucher of vouchers) {
      const numberText = normalizeTextBlock(voucher.number);
      const match = numberText.match(
        new RegExp(`^${escapeRegex(prefix)}(\\d+)$`, "i"),
      );
      if (match) {
        maxSequence = Math.max(maxSequence, Number(match[1] || 0));
        continue;
      }

      if (/^\d+$/.test(numberText)) {
        maxSequence = Math.max(maxSequence, Number(numberText));
      }
    }

    if (maxSequence === 0 && vouchers.length > 0) {
      maxSequence = vouchers.length;
    }

    const nextNumber = maxSequence + 1;
    const formattedNumber = `${prefix}${String(nextNumber).padStart(2, "0")}`;

    res.json({
      nextNumber,
      formattedNumber,
      prefix,
      companySlug,
      voucherSlug,
    });
  } catch (err) {
    console.error("Error generating next voucher number:", err);
    res.status(500).json({ message: "Unable to generate next voucher number" });
  }
});

// ---------- SAMPLE REPORT: Trial Balance (base for BS & P&L) ----------

app.get("/companies/:companyId/reports/ledger-drilldown", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const ledgerIdText = String(req.query.ledgerId || "");
    if (!ObjectId.isValid(ledgerIdText)) {
      return res.status(400).json({ message: "Valid ledgerId is required." });
    }

    const ledgerId = new ObjectId(ledgerIdText);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [ledger, ledgers, vouchers] = await Promise.all([
      Ledgers.aggregate([
        { $match: { _id: ledgerId, companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).next(),
      Ledgers.find({ companyId }).toArray(),
      Vouchers.find(
        activeVoucherFilter(
          toDate ? { companyId, date: { $lte: toDate } } : { companyId },
        ),
      ).toArray(),
    ]);

    if (!ledger) {
      return res.status(404).json({ message: "Ledger not found." });
    }

    const ledgerMap = new Map(
      ledgers.map((row) => [String(row._id), row.name]),
    );
    const fixedOpeningCents =
      (ledger.openingDrCr === "DR" ? 1 : -1) *
      moneyToCents(ledger.openingBalance || 0);

    let movementBeforeFromCents = 0;
    let periodDebitCents = 0;
    let periodCreditCents = 0;
    const entries = [];

    vouchers
      .slice()
      .sort((left, right) => {
        const leftTime = left?.date ? new Date(left.date).getTime() : 0;
        const rightTime = right?.date ? new Date(right.date).getTime() : 0;
        return leftTime - rightTime;
      })
      .forEach((voucher) => {
        const voucherDate = voucher?.date ? new Date(voucher.date) : null;
        const beforePeriod =
          fromDate && voucherDate ? voucherDate < fromDate : false;
        const inPeriod =
          (!fromDate || (voucherDate && voucherDate >= fromDate)) &&
          (!toDate || (voucherDate && voucherDate <= toDate));

        const reportLines = getAccountingReportLines(voucher);

        reportLines.forEach((line, lineIndex) => {
          if (String(line.ledgerId) !== String(ledgerId)) return;

          const debit = normalizeMoney(line.debit || 0);
          const credit = normalizeMoney(line.credit || 0);
          const debitCents = moneyToCents(debit);
          const creditCents = moneyToCents(credit);

          if (beforePeriod) {
            movementBeforeFromCents += debitCents - creditCents;
          }

          if (inPeriod) {
            periodDebitCents += debitCents;
            periodCreditCents += creditCents;

            const counterpart = (voucher.lines || [])
              .filter(
                (otherLine, otherIndex) =>
                  otherIndex !== (line.__reportLineIndex ?? lineIndex) &&
                  String(otherLine.ledgerId) !== String(ledgerId),
              )
              .map(
                (otherLine) =>
                  ledgerMap.get(String(otherLine.ledgerId)) || "Unknown",
              )
              .filter(Boolean)
              .join(", ");

            entries.push({
              voucherId: voucher._id,
              voucherName: voucher.voucherName || "Voucher",
              voucherNumber:
                voucher.number ||
                voucher.invoiceNumber ||
                voucher.voucherNumber ||
                "",
              date: voucher.date || null,
              dateLabel: formatDateLabel(voucher.date),
              lineIndex,
              debit: normalizeMoney(debit),
              credit: normalizeMoney(credit),
              narration:
                line.narration || voucher.narration || voucher.note || "",
              counterpart,
              itemName: (voucher.inventoryLines || [])
                .map((inventoryLine) => normalizeName(inventoryLine.itemName))
                .filter(Boolean)
                .join(", "),
            });
          }
        });
      });

    let runningBalanceCents = fixedOpeningCents + movementBeforeFromCents;
    const entriesWithRunning = entries.map((entry) => {
      runningBalanceCents +=
        moneyToCents(entry.debit || 0) - moneyToCents(entry.credit || 0);
      return {
        ...entry,
        runningBalance: centsToMoney(runningBalanceCents),
      };
    });

    const openingBalance = centsToMoney(
      fixedOpeningCents + movementBeforeFromCents,
    );
    const periodDebit = centsToMoney(periodDebitCents);
    const periodCredit = centsToMoney(periodCreditCents);

    res.json({
      ledger: {
        ledgerId: ledger._id,
        ledgerName: ledger.name,
        groupName: ledger.group?.name || "",
      },
      openingBalance,
      fixedOpeningBalance: centsToMoney(fixedOpeningCents),
      movementBeforeFrom: centsToMoney(movementBeforeFromCents),
      totals: {
        debit: periodDebit,
        credit: periodCredit,
      },
      closingBalance: centsToMoney(
        moneyToCents(openingBalance) + periodDebitCents - periodCreditCents,
      ),
      entries: entriesWithRunning,
    });
  } catch (err) {
    console.error("Error loading ledger drilldown:", err);
    res.status(500).json({ message: "Error loading ledger drilldown" });
  }
});

app.get("/companies/:companyId/reports/profit-loss-drilldown", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [groups, vouchers, ledgers, stockSummary] = await Promise.all([
      Groups.find({ companyId }).toArray(),
      Vouchers.find(activeVoucherFilter({ companyId })).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
      buildStockSummary(companyId, fromDate, toDate),
    ]);

    const groupMap = new Map(groups.map((group) => [String(group._id), group]));
    const ledgerMap = new Map(ledgers.map((ledger) => [String(ledger._id), ledger]));
    const periodVouchers = vouchers
      .filter((voucher) => {
        const voucherDate = voucher?.date ? new Date(voucher.date) : null;
        return (
          (!fromDate || (voucherDate && voucherDate >= fromDate)) &&
          (!toDate || (voucherDate && voucherDate <= toDate))
        );
      })
      .sort((left, right) => {
        const leftTime = left?.date ? new Date(left.date).getTime() : 0;
        const rightTime = right?.date ? new Date(right.date).getTime() : 0;
        return leftTime - rightTime;
      });

    const entries = [];
    const openingStock = normalizeMoney(
      (stockSummary.rows || []).reduce(
        (sum, row) => sum + Number(row.openingValue || 0),
        0,
      ),
    );
    const closingStock = normalizeMoney(
      (stockSummary.rows || []).reduce(
        (sum, row) => sum + Number(row.closingValue || 0),
        0,
      ),
    );

    if (openingStock > 0) {
      entries.push({
        voucherId: null,
        voucherName: "Opening Stock",
        voucherNumber: "",
        date: fromDate || null,
        dateLabel: formatDateLabel(fromDate),
        lineIndex: 0,
        debit: 0,
        credit: openingStock,
        narration: "Opening stock valuation for the selected period.",
        counterpart: "Inventory Valuation",
        itemName: "",
        isSynthetic: true,
      });
    }

    periodVouchers.forEach((voucher) => {
      const voucherNameKey = nameKey(voucher.voucherName || "");
      const voucherAmount = voucherTotalAmount(voucher);
      const itemName = (voucher.inventoryLines || [])
        .map((inventoryLine) => normalizeName(inventoryLine.itemName))
        .filter(Boolean)
        .join(", ");

      function pushVoucherEntry({
        debit = 0,
        credit = 0,
        counterpart = "",
        narration = "",
        itemNameOverride = itemName,
      }) {
        entries.push({
          voucherId: voucher._id,
          voucherName: voucher.voucherName || "Voucher",
          voucherNumber:
            voucher.number || voucher.invoiceNumber || voucher.voucherNumber || "",
          date: voucher.date || null,
          dateLabel: formatDateLabel(voucher.date),
          lineIndex: 0,
          debit: normalizeMoney(debit),
          credit: normalizeMoney(credit),
          narration: narration || voucher.narration || voucher.note || "",
          counterpart,
          itemName: itemNameOverride,
          isSynthetic: false,
        });
      }

      if (voucherNameKey === "sales" || voucherNameKey === "pos voucher") {
        pushVoucherEntry({
          debit: voucherAmount,
          counterpart:
            (voucher.lines || [])
              .map((line) => ledgerMap.get(String(line.ledgerId))?.name || "")
              .find((name) => name && nameKey(name) !== "sales") || "Sales",
        });
      } else if (voucherNameKey === "credit note") {
        pushVoucherEntry({
          credit: voucherAmount,
          counterpart: "Sales Return",
        });
      } else if (voucherNameKey === "purchase") {
        pushVoucherEntry({
          credit: voucherAmount,
          counterpart:
            (voucher.lines || [])
              .map((line) => ledgerMap.get(String(line.ledgerId))?.name || "")
              .find((name) => name && nameKey(name) !== "purchase") || "Purchase",
        });
      } else if (voucherNameKey === "debit note") {
        pushVoucherEntry({
          debit: voucherAmount,
          counterpart: "Purchase Return",
        });
      }

      (voucher.lines || []).forEach((line, lineIndex) => {
        const ledger = ledgerMap.get(String(line.ledgerId));
        const group = groupMap.get(String(ledger?.groupId)) || ledger?.group;
        if (!ledger || !group || group.affectsGrossProfit) return;

        const debit = Number(line.debit || 0);
        const credit = Number(line.credit || 0);

        if (group.nature === "INCOME") {
          const effect = normalizeMoney(credit - debit);
          if (!effect) return;
          entries.push({
            voucherId: voucher._id,
            voucherName: voucher.voucherName || "Voucher",
            voucherNumber:
              voucher.number || voucher.invoiceNumber || voucher.voucherNumber || "",
            date: voucher.date || null,
            dateLabel: formatDateLabel(voucher.date),
            lineIndex,
            debit: effect > 0 ? effect : 0,
            credit: effect < 0 ? Math.abs(effect) : 0,
            narration: line.narration || voucher.narration || voucher.note || "",
            counterpart: ledger.name,
            itemName: "",
            isSynthetic: false,
          });
        }

        if (group.nature === "EXPENSE") {
          const effect = normalizeMoney(debit - credit);
          if (!effect) return;
          entries.push({
            voucherId: voucher._id,
            voucherName: voucher.voucherName || "Voucher",
            voucherNumber:
              voucher.number || voucher.invoiceNumber || voucher.voucherNumber || "",
            date: voucher.date || null,
            dateLabel: formatDateLabel(voucher.date),
            lineIndex,
            debit: effect < 0 ? Math.abs(effect) : 0,
            credit: effect > 0 ? effect : 0,
            narration: line.narration || voucher.narration || voucher.note || "",
            counterpart: ledger.name,
            itemName: "",
            isSynthetic: false,
          });
        }
      });
    });

    if (closingStock > 0) {
      entries.push({
        voucherId: null,
        voucherName: "Closing Stock",
        voucherNumber: "",
        date: toDate || null,
        dateLabel: formatDateLabel(toDate),
        lineIndex: 0,
        debit: closingStock,
        credit: 0,
        narration: "Closing stock valuation for the selected period.",
        counterpart: "Inventory Valuation",
        itemName: "",
        isSynthetic: true,
      });
    }

    const totalDebitCents = entries.reduce(
      (sum, entry) => sum + moneyToCents(entry.debit || 0),
      0,
    );
    const totalCreditCents = entries.reduce(
      (sum, entry) => sum + moneyToCents(entry.credit || 0),
      0,
    );
    const totalDebit = centsToMoney(totalDebitCents);
    const totalCredit = centsToMoney(totalCreditCents);

    let runningBalanceCents = 0;
    const entriesWithRunning = entries.map((entry) => {
      runningBalanceCents +=
        moneyToCents(entry.debit || 0) - moneyToCents(entry.credit || 0);
      return {
        ...entry,
        runningBalance: centsToMoney(runningBalanceCents),
      };
    });

    res.json({
      ledger: {
        ledgerId: "__profit_loss__",
        ledgerName: "Profit & Loss A/c",
        groupName: "Profit & Loss",
      },
      openingBalance: 0,
      fixedOpeningBalance: 0,
      movementBeforeFrom: 0,
      totals: {
        debit: totalDebit,
        credit: totalCredit,
      },
      closingBalance: centsToMoney(totalDebitCents - totalCreditCents),
      entries: entriesWithRunning,
    });
  } catch (err) {
    console.error("Error loading profit & loss drilldown:", err);
    res.status(500).json({ message: "Error loading profit & loss drilldown" });
  }
});

app.get("/companies/:companyId/reports/trial-balance", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const { from, to } = req.query;

    // Convert to real Dates
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    // -----------------------------------------------------
    // 1️⃣ GET MOVEMENTS BEFORE FROM DATE = TRUE OPENING
    // -----------------------------------------------------
    let openingFilter = activeVoucherMatch({ companyId });
    if (fromDate) {
      openingFilter.date = { $lt: fromDate };
    }

    const openingMoves = await Vouchers.aggregate([
      { $match: openingFilter },
      { $unwind: "$lines" },
      {
        $group: {
          _id: "$lines.ledgerId",
          debit: { $sum: "$lines.debit" },
          credit: { $sum: "$lines.credit" },
        },
      },
    ]).toArray();

    const openingMap = new Map();
    openingMoves.forEach((m) =>
      openingMap.set(
        String(m._id),
        moneyToCents(m.debit || 0) - moneyToCents(m.credit || 0),
      ),
    );

    // -----------------------------------------------------
    // 2️⃣ MOVEMENTS FOR SELECTED DATE RANGE (FROM <> TO)
    // -----------------------------------------------------
    let periodFilter = activeVoucherMatch({ companyId });
    if (fromDate || toDate) {
      periodFilter.date = {};
      if (fromDate) periodFilter.date.$gte = fromDate;
      if (toDate) periodFilter.date.$lte = toDate;
    }

    const periodMoves = await Vouchers.aggregate([
      { $match: periodFilter },
      { $unwind: "$lines" },
      {
        $group: {
          _id: "$lines.ledgerId",
          debit: { $sum: "$lines.debit" },
          credit: { $sum: "$lines.credit" },
        },
      },
    ]).toArray();

    const periodMap = new Map();
    periodMoves.forEach((m) => periodMap.set(String(m._id), m));

    // -----------------------------------------------------
    // 3️⃣ GET ALL LEDGERS WITH THEIR GROUPS
    // -----------------------------------------------------
    const ledgers = await Ledgers.aggregate([
      { $match: { companyId } },
      {
        $lookup: {
          from: "groups",
          localField: "groupId",
          foreignField: "_id",
          as: "group",
        },
      },
      { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
    ]).toArray();

    // -----------------------------------------------------
    // 4️⃣ FINAL TRIAL BALANCE ROW CALCULATION
    // -----------------------------------------------------
    const rows = ledgers.map((l) => {
      const openingMovementCents = openingMap.get(String(l._id)) || 0;
      const fixedOpeningCents =
        (l.openingDrCr === "DR" ? 1 : -1) *
        moneyToCents(l.openingBalance || 0);

      // TRUE OPENING = fixed opening + all movements before selected FROM
      const openingCents = fixedOpeningCents + openingMovementCents;

      const periodMovement = periodMap.get(String(l._id)) || {
        debit: 0,
        credit: 0,
      };

      const debitCents = moneyToCents(periodMovement.debit || 0);
      const creditCents = moneyToCents(periodMovement.credit || 0);
      const debit = centsToMoney(debitCents);
      const credit = centsToMoney(creditCents);

      const closingCents = openingCents + debitCents - creditCents;
      const opening = centsToMoney(openingCents);
      const closing = centsToMoney(closingCents);

      const openingSide = splitBalance(opening);
      const closingSide = splitBalance(closing);

      return {
        ledgerId: l._id,
        ledgerName: l.name,
        groupId: l.group?._id || null,
        parentGroupId: l.group?.parentId || null,
        groupName: l.group?.name,
        nature: l.group?.nature,
        opening: normalizeMoney(opening),
        openingDebit: openingSide.debit,
        openingCredit: openingSide.credit,
        debit: normalizeMoney(debit),
        credit: normalizeMoney(credit),
        closing: normalizeMoney(closing),
        closingDebit: closingSide.debit,
        closingCredit: closingSide.credit,
      };
    });

    const allGroups = await Groups.find({ companyId }).toArray();
    const groupById = new Map(
      allGroups.map((group) => [String(group._id), group]),
    );
    const stockRoot = allGroups.find((group) =>
      ["stock-in-trade", "stock in trade", "primary"].includes(
        nameKey(group.name),
      ),
    );

    const groups = allGroups.filter((group) => {
      if (!stockRoot) return true;
      let current = group;
      while (current) {
        if (String(current._id) === String(stockRoot._id)) {
          return false;
        }
        current = current.parentId
          ? groupById.get(String(current.parentId))
          : null;
      }
      return true;
    });
    const tree = buildGroupedBalanceTree(
      groups,
      rows.map((row) => ({
        _id: row.ledgerId,
        name: row.ledgerName,
        groupId: row.groupId,
        openingDebit: row.openingDebit,
        openingCredit: row.openingCredit,
        debit: row.debit,
        credit: row.credit,
        closingDebit: row.closingDebit,
        closingCredit: row.closingCredit,
      })),
    );

    const totals = rows.reduce(
      (accumulator, row) => ({
        openingDebit: normalizeMoney(
          accumulator.openingDebit + row.openingDebit,
        ),
        openingCredit: normalizeMoney(
          accumulator.openingCredit + row.openingCredit,
        ),
        debit: normalizeMoney(accumulator.debit + row.debit),
        credit: normalizeMoney(accumulator.credit + row.credit),
        closingDebit: normalizeMoney(
          accumulator.closingDebit + row.closingDebit,
        ),
        closingCredit: normalizeMoney(
          accumulator.closingCredit + row.closingCredit,
        ),
      }),
      {
        openingDebit: 0,
        openingCredit: 0,
        debit: 0,
        credit: 0,
        closingDebit: 0,
        closingCredit: 0,
      },
    );

    res.json({
      rows,
      tree,
      flattened: flattenGroupTree(tree),
      totals,
    });
  } catch (err) {
    console.error("Error building trial balance:", err);
    res.status(500).json({ message: "Error building trial balance" });
  }
});

app.get(
  "/companies/:companyId/reports/account-books-summary",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);

      const mode =
        String(req.query.mode || "group").toLowerCase() === "ledger"
          ? "ledger"
          : "group";
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const groupIdText = String(req.query.groupId || "");
      const selectedGroupId = ObjectId.isValid(groupIdText) ? groupIdText : "";

      const [groups, ledgers, vouchers] = await Promise.all([
        Groups.find({ companyId }).toArray(),
        Ledgers.aggregate([
          { $match: { companyId } },
          {
            $lookup: {
              from: "groups",
              localField: "groupId",
              foreignField: "_id",
              as: "group",
            },
          },
          { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
        ]).toArray(),
        Vouchers.find(
          activeVoucherFilter(
            toDate ? { companyId, date: { $lte: toDate } } : { companyId },
          ),
        ).toArray(),
      ]);

      const groupsById = new Map(
        groups.map((group) => [String(group._id), group]),
      );
      const ledgerBalances = summarizeLedgerBalances(
        ledgers,
        vouchers,
        fromDate,
        toDate,
      )
        .map((ledger) => ({
          ...ledger,
          value: balanceValueFromSplit(ledger),
          groupName: ledger.group?.name || "",
          groupTrail: buildGroupTrailLabel(groupsById, ledger.groupId),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      const tree = buildGroupedBalanceTree(
        groups,
        ledgerBalances.map((ledger) => ({
          _id: ledger._id,
          name: ledger.name,
          groupId: ledger.groupId,
          openingDebit: ledger.openingDebit,
          openingCredit: ledger.openingCredit,
          debit: ledger.debit,
          credit: ledger.credit,
          closingDebit: ledger.closingDebit,
          closingCredit: ledger.closingCredit,
        })),
      );

      if (mode === "ledger") {
        const rows = ledgerBalances.map((ledger) => ({
          id: ledger._id,
          name: ledger.name,
          rowType: "ledger",
          openingValue: balanceValueFromSplit({
            closingDebit: ledger.openingDebit,
            closingCredit: ledger.openingCredit,
          }),
          openingSide:
            Number(ledger.openingCredit || 0) > Number(ledger.openingDebit || 0)
              ? "CR"
              : "DR",
          debit: normalizeMoney(ledger.debit || 0),
          credit: normalizeMoney(ledger.credit || 0),
          closingValue: ledger.value,
          closingSide:
            Number(ledger.closingCredit || 0) > Number(ledger.closingDebit || 0)
              ? "CR"
              : "DR",
          groupId: ledger.groupId || null,
          groupName: ledger.groupName,
          groupTrail: ledger.groupTrail,
        }));

        return res.json({
          mode,
          rows,
          totals: {
            count: rows.length,
            openingValue: rows.reduce(
              (sum, row) => normalizeMoney(sum + Number(row.openingValue || 0)),
              0,
            ),
            debit: rows.reduce(
              (sum, row) => normalizeMoney(sum + Number(row.debit || 0)),
              0,
            ),
            credit: rows.reduce(
              (sum, row) => normalizeMoney(sum + Number(row.credit || 0)),
              0,
            ),
            closingValue: rows.reduce(
              (sum, row) => normalizeMoney(sum + Number(row.closingValue || 0)),
              0,
            ),
          },
          trail: [],
        });
      }

      const selectedGroup = selectedGroupId
        ? findGroupNodeById(tree, selectedGroupId)
        : null;
      const toGroupSummaryRow = (group) => ({
        id: group.id,
        name: group.name,
        rowType: "group",
        openingValue: balanceValueFromSplit({
          closingDebit: group.totals.openingDebit,
          closingCredit: group.totals.openingCredit,
        }),
        openingSide:
          Number(group.totals.openingCredit || 0) >
          Number(group.totals.openingDebit || 0)
            ? "CR"
            : "DR",
        debit: normalizeMoney(group.totals.debit || 0),
        credit: normalizeMoney(group.totals.credit || 0),
        closingValue: balanceValueFromSplit(group.totals),
        closingSide:
          Number(group.totals.closingCredit || 0) >
          Number(group.totals.closingDebit || 0)
            ? "CR"
            : "DR",
        groupTrail: buildGroupTrailLabel(groupsById, group.parentId),
      });
      const toLedgerSummaryRow = (ledger) => ({
        id: ledger.id,
        name: ledger.name,
        rowType: "ledger",
        openingValue: balanceValueFromSplit({
          closingDebit: ledger.totals.openingDebit,
          closingCredit: ledger.totals.openingCredit,
        }),
        openingSide:
          Number(ledger.totals.openingCredit || 0) >
          Number(ledger.totals.openingDebit || 0)
            ? "CR"
            : "DR",
        debit: normalizeMoney(ledger.totals.debit || 0),
        credit: normalizeMoney(ledger.totals.credit || 0),
        closingValue: balanceValueFromSplit(ledger.totals),
        closingSide:
          Number(ledger.totals.closingCredit || 0) >
          Number(ledger.totals.closingDebit || 0)
            ? "CR"
            : "DR",
        groupId: ledger.groupId || null,
        groupName: ledger.groupName || "",
        groupTrail: buildGroupTrailLabel(groupsById, ledger.groupId),
      });
      function collectSearchRows(node) {
        return [
          toGroupSummaryRow(node),
          ...(node.ledgers || []).map(toLedgerSummaryRow),
          ...((node.children || []).flatMap(collectSearchRows) || []),
        ];
      }
      const rows = selectedGroup
        ? [
            ...(selectedGroup.children || []).map(toGroupSummaryRow),
            ...((selectedGroup.ledgers || []).map(toLedgerSummaryRow) || []),
          ]
        : (tree || []).map(toGroupSummaryRow);
      const searchRows = selectedGroup
        ? [
            ...((selectedGroup.children || []).flatMap(collectSearchRows) ||
              []),
            ...((selectedGroup.ledgers || []).map(toLedgerSummaryRow) || []),
          ]
        : (tree || []).flatMap(collectSearchRows);

      const trail = [];
      if (selectedGroupId) {
        let cursor = groupsById.get(selectedGroupId);
        const visited = new Set();
        while (cursor && !visited.has(String(cursor._id))) {
          trail.unshift({
            id: String(cursor._id),
            name: cursor.name,
          });
          visited.add(String(cursor._id));
          cursor = cursor.parentId
            ? groupsById.get(String(cursor.parentId))
            : null;
        }
      }

      res.json({
        mode,
        rows,
        searchRows,
        totals: {
          count: rows.length,
          openingValue: rows.reduce(
            (sum, row) => normalizeMoney(sum + Number(row.openingValue || 0)),
            0,
          ),
          debit: rows.reduce(
            (sum, row) => normalizeMoney(sum + Number(row.debit || 0)),
            0,
          ),
          credit: rows.reduce(
            (sum, row) => normalizeMoney(sum + Number(row.credit || 0)),
            0,
          ),
          closingValue: rows.reduce(
            (sum, row) => normalizeMoney(sum + Number(row.closingValue || 0)),
            0,
          ),
        },
        trail,
        currentGroupId: selectedGroupId || "",
        currentGroupName: selectedGroup?.name || "",
      });
    } catch (err) {
      console.error("Error building account books summary:", err);
      res.status(500).json({ message: "Error building account books summary" });
    }
  },
);

// ---------- ITEMS (INVENTORY MASTERS) ----------

function normalizeItemIdentifierList(values = []) {
  const seen = new Set();
  return values
    .map((value) => normalizeName(value))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function collectItemIdentifiers(item = {}) {
  return normalizeItemIdentifierList([
    item.alias,
    ...(item.secondaryAliases || []),
  ]);
}

async function findConflictingItemIdentifier(
  companyId,
  identifiers = [],
  excludeItemId = null,
) {
  if (!identifiers.length) return null;
  const items = await Items.find({
    companyId,
    ...(excludeItemId ? { _id: { $ne: excludeItemId } } : {}),
  }).toArray();

  const targetKeys = new Set(
    identifiers.map((value) => String(value).toLowerCase()),
  );
  return (
    items.find((item) =>
      collectItemIdentifiers(item).some((identifier) =>
        targetKeys.has(String(identifier).toLowerCase()),
      ),
    ) || null
  );
}

// List items for a company
app.get("/companies/:companyId/items", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);

  const [items, vouchers] = await Promise.all([
    Items.aggregate([
      { $match: { companyId } },
      {
        $lookup: {
          from: "groups",
          localField: "groupId",
          foreignField: "_id",
          as: "group",
        },
      },
      { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "stockCategories",
          localField: "stockCategoryId",
          foreignField: "_id",
          as: "stockCategoryMaster",
        },
      },
      {
        $unwind: {
          path: "$stockCategoryMaster",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "units",
          localField: "unitId",
          foreignField: "_id",
          as: "unitMaster",
        },
      },
      { $unwind: { path: "$unitMaster", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "godowns",
          localField: "godownId",
          foreignField: "_id",
          as: "godownMaster",
        },
      },
      { $unwind: { path: "$godownMaster", preserveNullAndEmptyArrays: true } },
    ]).toArray(),
    Vouchers.find(
      activeVoucherFilter({
        companyId,
        voucherName: { $in: ["Purchase"] },
        inventoryLines: { $exists: true, $ne: [] },
      }),
    ).toArray(),
  ]);

  const latestPurchaseByItem = new Map();
  vouchers
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.date || left.createdAt || 0).getTime();
      const rightTime = new Date(right.date || right.createdAt || 0).getTime();
      return leftTime - rightTime;
    })
    .forEach((voucher) => {
      const lines = Array.isArray(voucher.inventoryLines)
        ? voucher.inventoryLines
        : [];
      lines.forEach((line) => {
        const itemId = String(line.itemId || "");
        if (!itemId) return;
        const rate = Number(line.rate || 0);
        if (!Number.isFinite(rate)) return;
        latestPurchaseByItem.set(itemId, rate);
      });
    });

  const enrichedItems = items.map((item) => ({
    ...item,
    lastPurchaseRate: latestPurchaseByItem.has(String(item._id))
      ? Number(latestPurchaseByItem.get(String(item._id)) || 0)
      : Number(item.openingRate || 0),
  }));

  res.json(enrichedItems);
});

// Create item (like Stock Item in Tally)
// CREATE ITEM (Tally Style)
app.post("/companies/:companyId/items", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const {
      name,
      alias,
      secondaryAliases,
      groupId,
      stockCategoryId,
      stockCategory,
      unitId,
      unitOfMeasure,
      godownId,
      inventoryRole,
      description,
      notes,
      picture,
      narration,
      openingQty,
      openingRate,
      openingValue,
      prices,
    } = req.body;
    const normalizedName = normalizeName(name);
    if (!normalizedName || !groupId) {
      return res
        .status(400)
        .json({ message: "Item name and group are required" });
    }

    const group = await Groups.findOne({
      _id: new ObjectId(groupId),
      companyId,
    });
    if (!group) {
      return res.status(400).json({ message: "Stock group not found" });
    }
    if (!(await isStockGroup(companyId, group._id))) {
      return res
        .status(400)
        .json({ message: "Items must be created under a stock group" });
    }

    const duplicate = await Items.findOne({
      companyId,
      name: {
        $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Item name already exists" });
    }

    const normalizedIdentifiers = normalizeItemIdentifierList([
      alias,
      ...(Array.isArray(secondaryAliases) ? secondaryAliases : []),
    ]);
    const conflictingIdentifierItem = await findConflictingItemIdentifier(
      companyId,
      normalizedIdentifiers,
    );
    if (conflictingIdentifierItem) {
      return res.status(400).json({
        message: `Alias or secondary alias already used by ${conflictingIdentifierItem.name}`,
      });
    }

    const resolvedStockCategory = await resolveMasterName(
      StockCategories,
      companyId,
      stockCategoryId || stockCategory,
    );
    const resolvedUnit = await resolveMasterName(
      Units,
      companyId,
      unitId || unitOfMeasure,
    );
    const resolvedGodown = await resolveMasterName(
      Godowns,
      companyId,
      godownId,
    );

    const doc = {
      companyId,
      name: normalizedName,
      alias: normalizeName(alias),
      secondaryAliases: normalizeItemIdentifierList(secondaryAliases || []),
      groupId: new ObjectId(groupId),
      stockCategoryId:
        stockCategoryId && ObjectId.isValid(stockCategoryId)
          ? new ObjectId(stockCategoryId)
          : null,
      stockCategory: normalizeName(resolvedStockCategory),
      unitId: unitId && ObjectId.isValid(unitId) ? new ObjectId(unitId) : null,
      unitOfMeasure: normalizeName(resolvedUnit),
      godownId:
        godownId && ObjectId.isValid(godownId) ? new ObjectId(godownId) : null,
      godownName: normalizeName(resolvedGodown),
      inventoryRole: inventoryRoleKey(inventoryRole),
      description: normalizeName(description),
      notes: normalizeName(notes),
      picture: picture || "",
      narration: normalizeName(narration),
      openingQty: Number(openingQty) || 0,
      openingRate: Number(openingRate) || 0,
      openingValue: Number(openingValue) || 0,
      prices: prices || [], // ← PRICE LEVELS ARRAY
      createdAt: new Date(),
    };

    const result = await db.collection("items").insertOne(doc);

    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating item:", err);
    res.status(500).json({ message: "Error creating item" });
  }
});

// Update item
app.put("/companies/:companyId/items/:itemId", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const itemId = new ObjectId(req.params.itemId);

    const {
      name,
      alias,
      secondaryAliases,
      groupId,
      stockCategoryId,
      stockCategory,
      unitId,
      unitOfMeasure,
      godownId,
      inventoryRole,
      description,
      notes,
      picture,
      narration,
      openingQty,
      openingRate,
      prices, // NEW
    } = req.body;
    const normalizedName = normalizeName(name);
    if (!normalizedName || !groupId) {
      return res
        .status(400)
        .json({ message: "Item name and group are required" });
    }

    const duplicate = await Items.findOne({
      _id: { $ne: itemId },
      companyId,
      name: {
        $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Item name already exists" });
    }
    const normalizedIdentifiers = normalizeItemIdentifierList([
      alias,
      ...(Array.isArray(secondaryAliases) ? secondaryAliases : []),
    ]);
    const conflictingIdentifierItem = await findConflictingItemIdentifier(
      companyId,
      normalizedIdentifiers,
      itemId,
    );
    if (conflictingIdentifierItem) {
      return res.status(400).json({
        message: `Alias or secondary alias already used by ${conflictingIdentifierItem.name}`,
      });
    }
    const group = await Groups.findOne({
      _id: new ObjectId(groupId),
      companyId,
    });
    if (!group) {
      return res.status(400).json({ message: "Stock group not found" });
    }
    if (!(await isStockGroup(companyId, group._id))) {
      return res
        .status(400)
        .json({ message: "Items must be created under a stock group" });
    }

    const resolvedStockCategory = await resolveMasterName(
      StockCategories,
      companyId,
      stockCategoryId || stockCategory,
    );
    const resolvedUnit = await resolveMasterName(
      Units,
      companyId,
      unitId || unitOfMeasure,
    );
    const resolvedGodown = await resolveMasterName(
      Godowns,
      companyId,
      godownId,
    );

    const openingValue = Number(openingQty) * Number(openingRate);

    const update = {
      $set: {
        name: normalizedName,
        alias: normalizeName(alias),
        secondaryAliases: normalizeItemIdentifierList(secondaryAliases || []),
        groupId: new ObjectId(groupId),
        stockCategoryId:
          stockCategoryId && ObjectId.isValid(stockCategoryId)
            ? new ObjectId(stockCategoryId)
            : null,
        stockCategory: normalizeName(resolvedStockCategory),
        unitId:
          unitId && ObjectId.isValid(unitId) ? new ObjectId(unitId) : null,
        unitOfMeasure: normalizeName(resolvedUnit),
        godownId:
          godownId && ObjectId.isValid(godownId)
            ? new ObjectId(godownId)
            : null,
        godownName: normalizeName(resolvedGodown),
        inventoryRole: inventoryRoleKey(inventoryRole),
        description: normalizeName(description),
        notes: normalizeName(notes),
        picture: picture || "",
        narration: normalizeName(narration),
        openingQty: Number(openingQty),
        openingRate: Number(openingRate),
        openingValue,
        prices: prices || [], // NEW
      },
    };

    await Items.updateOne({ _id: itemId, companyId }, update);

    const updated = await Items.findOne({ _id: itemId, companyId });
    res.json(updated);
  } catch (err) {
    console.error("Error updating item:", err);
    res.status(500).json({ message: "Error updating item" });
  }
});

// Bulk update item prices by group (includes child groups)
app.put("/companies/:companyId/update-prices-by-group", requireCompanyWriteAccess(ROLE_GROUPS.priceManagement), async (req, res) => {
  try {
    const { companyId } = req.params;
    const { groupId, priceLevelId, rate, effectiveFrom } = req.body;

    // ----------- VALIDATION -----------
    if (!companyId || !groupId || !priceLevelId || rate === undefined) {
      return res.status(400).json({
        message: "companyId, groupId, priceLevelId and rate are required",
      });
    }

    if (isNaN(rate)) {
      return res.status(400).json({ message: "Rate must be a number" });
    }

    const effectiveDate = safeDate(effectiveFrom) || new Date();
    const effectiveDateKey = effectiveDate.toISOString().slice(0, 10);

    let companyObjectId, groupObjectId;

    try {
      companyObjectId = new ObjectId(companyId);
      groupObjectId = new ObjectId(groupId);
    } catch (err) {
      return res.status(400).json({ message: "Invalid ID format" });
    }

    // ----------- CHECK GROUP IS VALID FOR THIS COMPANY -----------
    const groupExists = await Groups.findOne({
      _id: groupObjectId,
      companyId: companyObjectId,
    });

    if (!groupExists) {
      return res.status(404).json({ message: "Group not found in company" });
    }

    // ----------- RECURSIVE CHILD GROUP COLLECTOR -----------
    const getAllChildGroupIds = async (parentId) => {
      const children = await Groups.find({
        companyId: companyObjectId,
        parentId,
      }).toArray();

      let ids = [parentId]; // include self

      for (const child of children) {
        const childIds = await getAllChildGroupIds(child._id);
        ids = ids.concat(childIds);
      }

      return ids;
    };

    const allGroupIds = await getAllChildGroupIds(groupObjectId);
    const targetItems = await Items.find({
      companyId: companyObjectId,
      groupId: { $in: allGroupIds },
    }).toArray();

    let addedPriceLevels = 0;
    let updatedPriceLevels = 0;

    for (const item of targetItems) {
      const prices = Array.isArray(item.prices) ? [...item.prices] : [];
      const existingIndex = prices.findIndex((entry) => {
        const entryDateKey = entry?.effectiveFrom
          ? new Date(entry.effectiveFrom).toISOString().slice(0, 10)
          : "";
        return (
          entry?.priceLevelId === priceLevelId &&
          entryDateKey === effectiveDateKey
        );
      });

      if (existingIndex >= 0) {
        prices[existingIndex] = {
          ...prices[existingIndex],
          rate: Number(rate),
          effectiveFrom: effectiveDate,
        };
        updatedPriceLevels += 1;
      } else {
        prices.push({
          priceLevelId,
          rate: Number(rate),
          effectiveFrom: effectiveDate,
        });
        addedPriceLevels += 1;
      }

      await Items.updateOne(
        { _id: item._id, companyId: companyObjectId },
        { $set: { prices } },
      );
    }

    res.json({
      message: "Bulk price update completed",
      effectiveFrom: effectiveDateKey,
      addedPriceLevels,
      updatedPriceLevels,
    });
  } catch (err) {
    console.error("❌ Bulk update error:", err);
    res.status(500).json({
      message: "Bulk update failed",
      error: err.message,
    });
  }
});

app.put("/companies/:companyId/update-price-by-item", requireCompanyWriteAccess(ROLE_GROUPS.priceManagement), async (req, res) => {
  try {
    const { companyId } = req.params;
    const { itemId, priceLevelId, rate, effectiveFrom } = req.body;

    if (!companyId || !itemId || !priceLevelId || rate === undefined) {
      return res.status(400).json({
        message: "companyId, itemId, priceLevelId and rate are required",
      });
    }

    if (isNaN(rate)) {
      return res.status(400).json({ message: "Rate must be a number" });
    }

    let companyObjectId, itemObjectId;
    try {
      companyObjectId = new ObjectId(companyId);
      itemObjectId = new ObjectId(itemId);
    } catch (err) {
      return res.status(400).json({ message: "Invalid ID format" });
    }

    const item = await Items.findOne({
      _id: itemObjectId,
      companyId: companyObjectId,
    });

    if (!item) {
      return res.status(404).json({ message: "Item not found in company" });
    }

    const effectiveDate = safeDate(effectiveFrom) || new Date();
    const effectiveDateKey = effectiveDate.toISOString().slice(0, 10);
    const prices = Array.isArray(item.prices) ? [...item.prices] : [];

    const existingIndex = prices.findIndex((entry) => {
      const entryDateKey = entry?.effectiveFrom
        ? new Date(entry.effectiveFrom).toISOString().slice(0, 10)
        : "";
      return (
        entry?.priceLevelId === priceLevelId &&
        entryDateKey === effectiveDateKey
      );
    });

    if (existingIndex >= 0) {
      prices[existingIndex] = {
        ...prices[existingIndex],
        rate: Number(rate),
        effectiveFrom: effectiveDate,
      };
    } else {
      prices.push({
        priceLevelId,
        rate: Number(rate),
        effectiveFrom: effectiveDate,
      });
    }

    await Items.updateOne(
      { _id: itemObjectId, companyId: companyObjectId },
      { $set: { prices } },
    );

    res.json({
      message: "Item price update completed",
      effectiveFrom: effectiveDateKey,
      itemId,
    });
  } catch (err) {
    console.error("Error updating item price:", err);
    res.status(500).json({
      message: "Item price update failed",
      error: err.message,
    });
  }
});

// Delete item (guard: not used in vouchers)
app.delete("/companies/:companyId/items/:itemId", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const itemId = new ObjectId(req.params.itemId);
    const existingItem = await Items.findOne({ _id: itemId, companyId });
    if (!existingItem) {
      return res.status(404).json({ message: "Item not found" });
    }

    const used = await Vouchers.countDocuments({
      ...activeVoucherFilter({ companyId }),
      "inventoryLines.itemId": itemId,
    });

    if (used > 0) {
      return res
        .status(400)
        .json({ message: "Item is used in vouchers. Cannot delete." });
    }

    const usedInBom = await Boms.countDocuments({
      companyId,
      $or: [
        { outputItemId: itemId },
        { "components.itemId": itemId },
      ],
    });

    if (usedInBom > 0) {
      return res
        .status(400)
        .json({ message: "Item is used in BOM or production setup. Cannot delete." });
    }

    await Items.deleteOne({ _id: itemId, companyId });
    res.json({ message: "Item deleted" });
  } catch (err) {
    console.error("Error deleting item:", err);
    res.status(500).json({ message: "Error deleting item" });
  }
});

// ---------- CHART OF ACCOUNTS: GROUPS (hierarchical list) ----------
app.get("/companies/:companyId/chart-of-accounts/groups", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);

    const allGroups = await Groups.find({ companyId }).toArray();
    const groupById = new Map(
      allGroups.map((group) => [String(group._id), group]),
    );
    const stockRoot = allGroups.find(
      (group) =>
        group.systemKey === "stock-in-trade" ||
        ["stock-in-trade", "stock in trade"].includes(nameKey(group.name)),
    );

    const groups = allGroups.filter((group) => {
      if (!stockRoot) return true;
      let current = group;
      while (current) {
        if (String(current._id) === String(stockRoot._id)) {
          return false;
        }
        current = current.parentId
          ? groupById.get(String(current.parentId))
          : null;
      }
      return true;
    });

    // Build parent → children map
    const childrenMap = new Map(); // parentId(string|null) -> [groups]
    groups.forEach((g) => {
      const key = g.parentId ? String(g.parentId) : "ROOT";
      if (!childrenMap.has(key)) childrenMap.set(key, []);
      childrenMap.get(key).push(g);
    });

    // Sort children of each parent alphabetically
    for (const [key, arr] of childrenMap.entries()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }

    const ordered = [];

    function walk(parentKey, level) {
      const kids = childrenMap.get(parentKey) || [];
      for (const g of kids) {
        ordered.push({
          type: "group",
          ...g,
          level, // depth for indentation
        });
        walk(String(g._id), level + 1);
      }
    }

    // Start from ROOT (groups without parent)
    walk("ROOT", 0);

    res.json(ordered);
  } catch (err) {
    console.error("Error building chart-of-accounts groups:", err);
    res.status(500).json({ message: "Error loading chart of account groups" });
  }
});
// ---------- CHART OF ACCOUNTS: LEDGERS (ledger-only hierarchy) ----------
app.get("/companies/:companyId/chart-of-accounts/ledgers", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);

    const groups = await Groups.find({ companyId }).toArray();
    const ledgers = await Ledgers.find({ companyId }).toArray();
    const childGroups = new Map();
    const groupLedgers = new Map();

    groups.forEach((group) => {
      const parentKey = group.parentId ? String(group.parentId) : "ROOT";
      if (!childGroups.has(parentKey)) childGroups.set(parentKey, []);
      childGroups.get(parentKey).push(group);
    });

    ledgers.forEach((ledger) => {
      const groupKey = ledger.groupId ? String(ledger.groupId) : "ROOT";
      if (!groupLedgers.has(groupKey)) groupLedgers.set(groupKey, []);
      groupLedgers.get(groupKey).push(ledger);
    });

    for (const list of childGroups.values()) {
      list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    }
    for (const list of groupLedgers.values()) {
      list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    }

    const result = [];

    function walkGroups(parentKey = "ROOT", level = 0) {
      const currentGroups = childGroups.get(parentKey) || [];
      currentGroups.forEach((group) => {
        const groupId = String(group._id);
        result.push({
          type: "group",
          id: group._id,
          parentId: group.parentId ? String(group.parentId) : null,
          name: group.name,
          level,
        });

        walkGroups(groupId, level + 1);

        const currentLedgers = groupLedgers.get(groupId) || [];
        currentLedgers.forEach((ledger) => {
          result.push({
            type: "ledger",
            id: ledger._id,
            parentId: groupId,
            name: ledger.name,
            level: level + 1,
          });
        });
      });
    }

    walkGroups();

    res.json(result);
  } catch (err) {
    console.error("Error building chart-of-accounts ledgers:", err);
    res.status(500).json({ message: "Error loading chart of account ledgers" });
  }
});
// ---------- CHART OF ACCOUNTS: STOCK ITEMS (hierarchical list) ----------
app.get(
  "/companies/:companyId/chart-of-accounts/stock-items",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);

      // Step 1: Find the Primary Stock Group (usually named "Stock-in-Trade" or "Primary")
      const primaryGroup = await db.collection("groups").findOne({
        companyId,
        name: { $in: ["Stock-in-Trade", "Primary", "Stock In Trade"] }, // adjust name as needed
        // or if you have a flag:
        // isPrimary: true
      });

      if (!primaryGroup) {
        return res
          .status(404)
          .json({ message: "Primary stock group not found" });
      }

      // Step 2: Load all groups and items (still efficient)
      const allGroups = await db
        .collection("groups")
        .find({ companyId })
        .toArray();
      const allItems = await db
        .collection("items")
        .find({ companyId })
        .toArray();

      // Build maps for fast lookup
      const childGroups = new Map();
      const groupItems = new Map();

      allGroups.forEach((g) => {
        const parentKey = g.parentId ? String(g.parentId) : "ROOT";
        if (!childGroups.has(parentKey)) childGroups.set(parentKey, []);
        childGroups.get(parentKey).push(g);
      });

      allItems.forEach((i) => {
        const key = String(i.groupId);
        if (!groupItems.has(key)) groupItems.set(key, []);
        groupItems.get(key).push(i);
      });

      // Sort alphabetically
      for (const list of childGroups.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }
      for (const list of groupItems.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }

      const result = [];

      // Step 3: Only walk from the Primary group (not from ROOT)
      function walkGroup(groupId, level) {
        const children = childGroups.get(String(groupId)) || [];

        for (const group of children) {
          result.push({
            type: "group",
            id: group._id,
            name: group.name,
            level,
          });

          // Add items directly under this group
          const items = groupItems.get(String(group._id)) || [];
          items.forEach((item) => {
            result.push({
              type: "item",
              id: item._id,
              name: item.name,
              barcode: item.barcode || "",
              level: level + 1,
            });
          });

          // Recursively walk its children
          walkGroup(group._id, level + 1);
        }
      }

      // Start walking only from the Primary group
      result.push({
        type: "group",
        id: primaryGroup._id,
        name: primaryGroup.name,
        level: 0,
      });

      // Add items directly under Primary
      const primaryItems = groupItems.get(String(primaryGroup._id)) || [];
      primaryItems.forEach((item) => {
        result.push({
          type: "item",
          id: item._id,
          name: item.name,
          barcode: item.barcode || "",
          level: 1,
        });
      });

      // Now walk its child groups
      walkGroup(primaryGroup._id, 1);

      res.json(result);
    } catch (err) {
      console.error("Error loading stock item tree:", err);
      res.status(500).json({ message: "Error loading stock item structure" });
    }
  },
);

app.get("/companies/:companyId/manufacturing/reference", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const [items, units, voucherTypes, rawMaterialSummary] = await Promise.all([
      Items.find({ companyId }).sort({ name: 1 }).toArray(),
      Units.find({ companyId }).sort({ name: 1 }).toArray(),
      VoucherTypes.find({ companyId }).toArray(),
      buildStockSummary(companyId, null, null, {
        includeRoles: ["raw_material"],
      }),
    ]);

    const manufacturingVoucherType = voucherTypes.find(
      (row) => nameKey(row.name) === "manufacturing",
    );

    const rawSummaryMap = new Map(
      (rawMaterialSummary.rows || []).map((row) => [String(row.itemId), row]),
    );
    const rawMaterials = items
      .filter((item) => inventoryRoleKey(item.inventoryRole) === "raw_material")
      .map((item) => ({
        ...item,
        availableQty: normalizeMoney(
          rawSummaryMap.get(String(item._id))?.closingQty || 0,
        ),
        currentRate: normalizeMoney(
          rawSummaryMap.get(String(item._id))?.closingRate || 0,
        ),
        currentValue: normalizeMoney(
          rawSummaryMap.get(String(item._id))?.closingValue || 0,
        ),
      }));

    res.json({
      voucherTypeId: manufacturingVoucherType?._id || null,
      items,
      rawMaterials,
      finishedGoods: items.filter(
        (item) => inventoryRoleKey(item.inventoryRole) !== "raw_material",
      ),
      units,
    });
  } catch (err) {
    console.error("Error loading manufacturing reference data:", err);
    res
      .status(500)
      .json({ message: "Unable to load manufacturing reference data" });
  }
});

app.get("/companies/:companyId/manufacturing/boms", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const rawMaterialSummary = await buildStockSummary(companyId, null, null, {
      includeRoles: ["raw_material"],
    });
    const rows = await Boms.find({ companyId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();
    const enriched = await Promise.all(
      rows.map((row) =>
        enrichBomWithAvailability(companyId, row, rawMaterialSummary),
      ),
    );
    res.json(enriched);
  } catch (err) {
    console.error("Error loading BOM list:", err);
    res.status(500).json({ message: "Unable to load BOM list" });
  }
});

app.post("/companies/:companyId/manufacturing/boms", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const {
      name,
      finishedItemId,
      finishedItemName,
      outputQty,
      unitId,
      unitName,
      description,
      status = "active",
      notes,
      components = [],
      additionalCosts = [],
    } = req.body || {};

    if (!finishedItemId || !ObjectId.isValid(finishedItemId)) {
      return res.status(400).json({ message: "Finished item is required." });
    }

    const finishedItem = await Items.findOne({
      _id: new ObjectId(finishedItemId),
      companyId,
    });
    if (!finishedItem) {
      return res.status(400).json({ message: "Finished item not found." });
    }

    const normalizedComponents = components
      .map(normalizeBomComponentPayload)
      .filter((row) => row.itemId && Number(row.qty || 0) > 0);
    if (normalizedComponents.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one component is required." });
    }

    const doc = {
      companyId,
      name: normalizeName(
        name || finishedItemName || finishedItem.name || "Manufacturing BoM",
      ),
      finishedItemId: new ObjectId(finishedItemId),
      finishedItemName: normalizeName(
        finishedItemName || finishedItem.name || "",
      ),
      outputQty: normalizeMoney(outputQty || 1),
      unitId: unitId && ObjectId.isValid(unitId) ? new ObjectId(unitId) : null,
      unitName: normalizeName(unitName || finishedItem.unitOfMeasure || ""),
      description: normalizeTextBlock(description || ""),
      status: nameKey(status) === "inactive" ? "inactive" : "active",
      notes: normalizeTextBlock(notes || ""),
      components: normalizedComponents,
      additionalCosts: (additionalCosts || [])
        .map(normalizeAdditionalCostPayload)
        .filter((row) => Number(row.amount || 0) > 0),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await Boms.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating BOM:", err);
    res.status(500).json({ message: "Unable to create BOM" });
  }
});

app.put("/companies/:companyId/manufacturing/boms/:bomId", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const bomId = new ObjectId(req.params.bomId);
    const existing = await Boms.findOne({ _id: bomId, companyId });
    if (!existing) {
      return res.status(404).json({ message: "BOM not found." });
    }

    const {
      name,
      finishedItemId,
      finishedItemName,
      outputQty,
      unitId,
      unitName,
      description,
      status = "active",
      notes,
      components = [],
      additionalCosts = [],
    } = req.body || {};

    const normalizedComponents = components
      .map(normalizeBomComponentPayload)
      .filter((row) => row.itemId && Number(row.qty || 0) > 0);

    const update = {
      $set: {
        name: normalizeName(name || existing.name || "Manufacturing BoM"),
        finishedItemId:
          finishedItemId && ObjectId.isValid(finishedItemId)
            ? new ObjectId(finishedItemId)
            : existing.finishedItemId,
        finishedItemName: normalizeName(
          finishedItemName || existing.finishedItemName || "",
        ),
        outputQty: normalizeMoney(outputQty || existing.outputQty || 1),
        unitId:
          unitId && ObjectId.isValid(unitId)
            ? new ObjectId(unitId)
            : existing.unitId || null,
        unitName: normalizeName(unitName || existing.unitName || ""),
        description: normalizeTextBlock(description || ""),
        status: nameKey(status) === "inactive" ? "inactive" : "active",
        notes: normalizeTextBlock(notes || ""),
        components:
          normalizedComponents.length > 0
            ? normalizedComponents
            : existing.components || [],
        additionalCosts: (additionalCosts || [])
          .map(normalizeAdditionalCostPayload)
          .filter((row) => Number(row.amount || 0) > 0),
        updatedAt: new Date(),
      },
    };

    await Boms.updateOne({ _id: bomId, companyId }, update);
    res.json(await Boms.findOne({ _id: bomId, companyId }));
  } catch (err) {
    console.error("Error updating BOM:", err);
    res.status(500).json({ message: "Unable to update BOM" });
  }
});

app.delete(
  "/companies/:companyId/manufacturing/boms/:bomId",
  requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters),
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const bomId = new ObjectId(req.params.bomId);
      const used = await Vouchers.countDocuments({
        companyId,
        "manufacturingMeta.bomId": bomId,
      });
      if (used > 0) {
        return res
          .status(400)
          .json({ message: "BOM is used in production. Cannot delete." });
      }
      await Boms.deleteOne({ _id: bomId, companyId });
      res.json({ message: "BOM deleted" });
    } catch (err) {
      console.error("Error deleting BOM:", err);
      res.status(500).json({ message: "Unable to delete BOM" });
    }
  },
);

app.get("/companies/:companyId/reports/stock-summary", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);
    const summary = await buildStockSummary(companyId, fromDate, toDate, {
      excludeRoles: ["raw_material"],
    });
    res.json(summary);
  } catch (err) {
    console.error("Error building stock summary:", err);
    res.status(500).json({ message: "Error building stock summary" });
  }
});

app.get(
  "/companies/:companyId/reports/stock-group-summary",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const summary = await buildStockGroupSummary(
        companyId,
        fromDate,
        toDate,
        {
          salesPersonId: req.query.salesPersonId || "",
          groupId: req.query.groupId || "",
          category: req.query.category || "",
          itemId: req.query.itemId || "",
        },
      );
      res.json(summary);
    } catch (err) {
      console.error("Error building stock group summary:", err);
      res.status(500).json({ message: "Error building stock group summary" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/stock-item-detailed",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const summary = await buildInventoryDetailReport(
        companyId,
        fromDate,
        toDate,
        {
          salesPersonId: req.query.salesPersonId || "",
          groupId: req.query.groupId || "",
          category: req.query.category || "",
          itemId: req.query.itemId || "",
          partyGroupId: req.query.partyGroupId || "",
          partyLedgerId: req.query.partyLedgerId || "",
        },
      );
      res.json(summary);
    } catch (err) {
      console.error("Error building detailed stock item report:", err);
      res
        .status(500)
        .json({ message: "Error building detailed stock item report" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/raw-material-summary",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      res.json(
        await buildManufacturingRawMaterialSummary(companyId, fromDate, toDate),
      );
    } catch (err) {
      console.error("Error building raw material summary:", err);
      res.status(500).json({ message: "Error building raw material summary" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/manufacturing/production-register",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      res.json(await buildProductionRegister(companyId, fromDate, toDate));
    } catch (err) {
      console.error("Error building production register:", err);
      res.status(500).json({ message: "Error building production register" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/manufacturing/component-consumption",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      res.json(
        await buildComponentConsumptionReport(companyId, fromDate, toDate),
      );
    } catch (err) {
      console.error("Error building component consumption:", err);
      res.status(500).json({ message: "Error building component consumption" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/inventory-movement-analysis",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const dimension = normalizeName(req.query.dimension || "stock-group")
        .toLowerCase()
        .replace(/\s+/g, "-");
      const report = await buildInventoryMovementDimensionReport(
        companyId,
        fromDate,
        toDate,
        dimension,
        {
          salesPersonId: req.query.salesPersonId || "",
          groupId: req.query.groupId || "",
          category: req.query.category || "",
          itemId: req.query.itemId || "",
        },
      );

      res.json(report);
    } catch (err) {
      console.error("Error building inventory movement analysis:", err);
      res
        .status(500)
        .json({ message: "Error building inventory movement analysis" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/sales-person-drill",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const level = normalizeName(req.query.level || "group").toLowerCase();
      const report = await buildSalesPersonDrillReport(
        companyId,
        fromDate,
        toDate,
        {
          salesPersonId: req.query.salesPersonId || "",
          level,
          groupId: req.query.groupId || "",
          category: req.query.category || "",
          itemId: req.query.itemId || "",
        },
      );
      res.json(report);
    } catch (err) {
      console.error("Error building sales person drill report:", err);
      res
        .status(500)
        .json({ message: "Error building sales person drill report" });
    }
  },
);

app.get(
  "/companies/:companyId/reports/party-movement-detail",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);
      const fromDate = safeDate(req.query.from);
      const toDate = safeDate(req.query.to);
      const level = normalizeName(req.query.level || "ledger").toLowerCase();
      const report = await buildPartyMovementDetailReport(
        companyId,
        fromDate,
        toDate,
        {
          level,
          groupId: req.query.groupId || "",
          ledgerId: req.query.ledgerId || "",
          groupName: req.query.groupName || "",
          ledgerName: req.query.ledgerName || "",
        },
      );
      res.json(report);
    } catch (err) {
      console.error("Error building party movement detail report:", err);
      res
        .status(500)
        .json({ message: "Error building party movement detail report" });
    }
  },
);

app.get("/companies/:companyId/reports/profit-loss", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [groups, vouchers, ledgers, stockSummary] = await Promise.all([
      Groups.find({ companyId }).toArray(),
      Vouchers.find(activeVoucherFilter({ companyId })).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
      buildStockSummary(companyId, fromDate, toDate),
    ]);

    const balances = summarizeLedgerBalances(
      ledgers,
      vouchers,
      fromDate,
      toDate,
    );
    const groupMap = new Map(groups.map((group) => [String(group._id), group]));

    const snapshot = buildProfitLossSnapshot({
      balances,
      vouchers,
      stockSummary,
      groupMap,
      fromDate,
      toDate,
    });

    res.json({
      incomes: snapshot.incomes.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName)),
      expenses: snapshot.expenses.sort((a, b) =>
        a.ledgerName.localeCompare(b.ledgerName),
      ),
      trading: snapshot.trading,
      totals: snapshot.totals,
    });
  } catch (err) {
    console.error("Error building profit and loss:", err);
    res.status(500).json({ message: "Error building profit and loss" });
  }
});

app.get("/companies/:companyId/reports/balance-sheet", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [groups, vouchers, ledgers, stockSummary] = await Promise.all([
      Groups.find({ companyId }).toArray(),
      Vouchers.find(
        activeVoucherFilter(
          toDate ? { companyId, date: { $lte: toDate } } : { companyId },
        ),
      ).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
      buildStockSummary(companyId, fromDate, toDate),
    ]);

    const balances = summarizeLedgerBalances(
      ledgers,
      vouchers,
      fromDate,
      toDate,
    );
    const groupMap = new Map(groups.map((group) => [String(group._id), group]));

    const assetNodes = new Map();
    const liabilityNodes = new Map();

    function ensureBalanceNode(sideMap, group) {
      const key = String(group._id);
      if (!sideMap.has(key)) {
        sideMap.set(key, {
          id: group._id,
          groupName: group.name,
          parentId: group.parentId || null,
          nature: group.nature,
          openingAmount: 0,
          amount: 0,
          ledgers: [],
          children: [],
        });
      }
      return sideMap.get(key);
    }

    function ensureAncestorChain(sideMap, group, nature) {
      let currentGroup = group;
      let lowestNode = null;
      let targetNode = null;

      while (currentGroup && currentGroup.nature === nature) {
        const currentNode = ensureBalanceNode(sideMap, currentGroup);
        if (!targetNode) {
          targetNode = currentNode;
        }
        if (lowestNode && !currentNode.children.some((child) => String(child.id) === String(lowestNode.id))) {
          currentNode.children.push(lowestNode);
        }
        lowestNode = currentNode;
        currentGroup = currentGroup.parentId
          ? groupMap.get(String(currentGroup.parentId))
          : null;
      }

      return targetNode;
    }

    balances.forEach((ledger) => {
      const group = groupMap.get(String(ledger.groupId)) || ledger.group;
      if (!group) return;

      if (group.nature === "ASSET") {
        const current = ensureAncestorChain(assetNodes, group, "ASSET");
        current.openingAmount = normalizeMoney(
          current.openingAmount + (ledger.openingDebit || 0),
        );
        current.amount = normalizeMoney(
          current.amount + (ledger.closingDebit || 0),
        );
        current.ledgers.push({
            ledgerId: ledger._id,
            ledgerName: ledger.name,
            openingAmount: normalizeMoney(ledger.openingDebit || 0),
            amount: normalizeMoney(ledger.closingDebit || 0),
          });
      }

      if (group.nature === "LIABILITY") {
        const current = ensureAncestorChain(liabilityNodes, group, "LIABILITY");
        current.openingAmount = normalizeMoney(
          current.openingAmount + (ledger.openingCredit || 0),
        );
        current.amount = normalizeMoney(
          current.amount + (ledger.closingCredit || 0),
        );
        current.ledgers.push({
            ledgerId: ledger._id,
            ledgerName: ledger.name,
            openingAmount: normalizeMoney(ledger.openingCredit || 0),
            amount: normalizeMoney(ledger.closingCredit || 0),
          });
      }
    });

    function buildHierarchy(sideMap, nature) {
      const nodes = [...sideMap.values()].map((node) => ({
        ...node,
        children: [],
        ledgers: node.ledgers
          .slice()
          .sort((left, right) => left.ledgerName.localeCompare(right.ledgerName)),
      }));
      const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
      const roots = [];

      nodes.forEach((node) => {
        const parent = node.parentId ? nodeById.get(String(node.parentId)) : null;
        const parentGroup = node.parentId ? groupMap.get(String(node.parentId)) : null;
        if (parent && parentGroup?.nature === nature) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      });

      function rollup(node) {
        node.children
          .sort((left, right) => left.groupName.localeCompare(right.groupName))
          .forEach((child) => {
            rollup(child);
            node.openingAmount = normalizeMoney(
              node.openingAmount + Number(child.openingAmount || 0),
            );
            node.amount = normalizeMoney(node.amount + Number(child.amount || 0));
          });
      }

      roots
        .sort((left, right) => left.groupName.localeCompare(right.groupName))
        .forEach(rollup);
      return roots;
    }

    const snapshot = buildProfitLossSnapshot({
      balances,
      vouchers,
      stockSummary,
      groupMap,
      fromDate,
      toDate,
    });
    const netProfit = snapshot.totals.netProfit;

    if (
      stockSummary?.totals?.openingValue ||
      stockSummary?.totals?.closingValue
    ) {
      const current = {
        id: "__closing_stock__",
        groupName: "Closing Stock",
        parentId: null,
        nature: "ASSET",
        openingAmount: 0,
        amount: 0,
        ledgers: [],
        children: [],
      };
      current.openingAmount = normalizeMoney(
        current.openingAmount + Number(stockSummary.totals.openingValue || 0),
      );
      current.amount = normalizeMoney(
        current.amount + Number(stockSummary.totals.closingValue || 0),
      );
      assetNodes.set(String(current.id), current);
    }

    if (netProfit !== 0) {
      const profitLossLedger =
        ledgers.find((ledger) => nameKey(ledger.name || "") === "profit & loss a/c") || null;
      const profitLossGroup = groups.find(
        (group) => nameKey(group.name || "") === "profit & loss",
      );
      const profitLossAmount = normalizeMoney(Math.abs(netProfit));
      const targetCollection = netProfit >= 0 ? liabilityNodes : assetNodes;
      const oppositeCollection = netProfit >= 0 ? assetNodes : liabilityNodes;
      const targetGroupName = profitLossGroup?.name || "Profit & Loss";
      const targetKey = profitLossGroup?._id
        ? String(profitLossGroup._id)
        : "__profit_loss_group__";
      oppositeCollection.delete(targetKey);
      const current = targetCollection.get(targetKey) || {
        id: profitLossGroup?._id || "__profit_loss_group__",
        groupName: targetGroupName,
        parentId: profitLossGroup?.parentId || null,
        nature: netProfit >= 0 ? "LIABILITY" : "ASSET",
        openingAmount: 0,
        amount: 0,
        ledgers: [],
        children: [],
      };
      current.amount = profitLossAmount;
      current.pnlType = netProfit >= 0 ? "profit" : "loss";
      current.ledgers = [
        {
          ledgerId: profitLossLedger?._id || "__profit_loss__",
          ledgerName: profitLossLedger?.name || "Profit & Loss A/c",
          openingAmount: 0,
          amount: profitLossAmount,
          pnlType: netProfit >= 0 ? "profit" : "loss",
          virtualMode: "profit-loss",
        },
      ];
      targetCollection.set(targetKey, current);
    }

    const assetRows = buildHierarchy(assetNodes, "ASSET");
    const liabilityRows = buildHierarchy(liabilityNodes, "LIABILITY");

    function sumRows(rows) {
      return rows.reduce(
        (sum, row) => ({
          opening: normalizeMoney(sum.opening + Number(row.openingAmount || 0)),
          closing: normalizeMoney(sum.closing + Number(row.amount || 0)),
        }),
        { opening: 0, closing: 0 },
      );
    }
    const assetTotals = sumRows(assetRows);
    const liabilityTotals = sumRows(liabilityRows);

    res.json({
      assets: assetRows,
      liabilities: liabilityRows,
      totals: {
        openingAssets: assetTotals.opening,
        openingLiabilities: liabilityTotals.opening,
        assets: assetTotals.closing,
        liabilities: liabilityTotals.closing,
      },
      period: {
        from: fromDate ? dayjs(fromDate).format("YYYY-MM-DD") : null,
        to: toDate ? dayjs(toDate).format("YYYY-MM-DD") : null,
      },
    });
  } catch (err) {
    console.error("Error building balance sheet:", err);
    res.status(500).json({ message: "Error building balance sheet" });
  }
});

app.get("/companies/:companyId/reports/dashboard", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);

    const [
      groupsCount,
      ledgersCount,
      itemsCount,
      vouchersCount,
      stockSummary,
      vouchers,
      ledgers,
    ] = await Promise.all([
      Groups.countDocuments({ companyId }),
      Ledgers.countDocuments({ companyId }),
      Items.countDocuments({ companyId }),
      Vouchers.countDocuments(activeVoucherFilter({ companyId })),
      buildStockSummary(companyId),
      Vouchers.find(activeVoucherFilter({ companyId })).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
    ]);

    const balances = summarizeLedgerBalances(ledgers, vouchers, null, null);
    const monthLabels = [];
    const monthMap = new Map();
    for (let index = 11; index >= 0; index -= 1) {
      const date = dayjs().subtract(index, "month");
      const key = date.format("YYYY-MM");
      const label = date.format("MMM");
      monthLabels.push({ key, label });
      monthMap.set(key, { label, sales: 0, purchase: 0 });
    }

    const balanceSummary = summarizeDashboardBalances(balances);
    const {
      cashBank,
      receivables,
      payables,
      salesTotal,
      purchaseTotal,
      directIncome,
      directExpense,
      indirectIncome,
      indirectExpense,
      currentAssets,
      currentLiabilities,
      cashInHandTotal,
      bankBalanceTotal,
      bankLedgers,
    } = balanceSummary;

    const grossProfit = normalizeMoney(directIncome - directExpense);
    const netProfit = normalizeMoney(
      grossProfit + indirectIncome - indirectExpense,
    );

    vouchers.forEach((voucher) => {
      const voucherDate = voucher?.date ? dayjs(voucher.date) : null;
      if (!voucherDate?.isValid()) return;
      const key = voucherDate.format("YYYY-MM");
      if (!monthMap.has(key)) return;
      const current = monthMap.get(key);
      const amount = voucherTotalAmount(voucher);
      const voucherKey = nameKey(voucher.voucherName || "");

      if (voucherKey === "sales" || voucherKey === "pos voucher") {
        current.sales = normalizeMoney(current.sales + amount);
      }
      if (voucherKey === "purchase") {
        current.purchase = normalizeMoney(current.purchase + amount);
      }
      monthMap.set(key, current);
    });

    const averageInventory = normalizeMoney(
      (Number(stockSummary.totals.openingValue || 0) +
        Number(stockSummary.totals.closingValue || 0)) /
        2 || 0,
    );
    const inventoryTurnover = averageInventory
      ? normalizeMoney(
          Number(stockSummary.totals.outwardValue || 0) / averageInventory,
        )
      : 0;
    const receivableTurnoverDays = salesTotal
      ? normalizeMoney((receivables / salesTotal) * 365)
      : 0;
    const debtEquityRatio = netProfit
      ? normalizeMoney(payables / Math.max(Math.abs(netProfit), 1))
      : 0;
    const returnOnInvestment = currentAssets
      ? normalizeMoney((netProfit / currentAssets) * 100)
      : 0;

    res.json({
      groupsCount,
      ledgersCount,
      itemsCount,
      vouchersCount,
      cashInHandBalance: cashInHandTotal,
      bankBalance: bankBalanceTotal,
      stockValue: stockSummary.totals.closingValue,
      stockQuantity: stockSummary.totals.closingQty,
      stockItems: stockSummary.rows.slice(0, 8),
      cashBankBalance: cashBank,
      receivables,
      payables,
      salesTotal,
      purchaseTotal,
      grossProfit,
      netProfit,
      salesTrend: monthLabels.map(({ key, label }) => ({
        label,
        value: monthMap.get(key)?.sales || 0,
      })),
      purchaseTrend: monthLabels.map(({ key, label }) => ({
        label,
        value: monthMap.get(key)?.purchase || 0,
      })),
      cashFlow: {
        netInflow: normalizeMoney(cashBank),
        totalInflow: balances.reduce(
          (sum, row) => normalizeMoney(sum + Number(row.debit || 0)),
          0,
        ),
        totalOutflow: balances.reduce(
          (sum, row) => normalizeMoney(sum + Number(row.credit || 0)),
          0,
        ),
      },
      topBankLedgers: bankLedgers,
      assetsLiabilities: {
        currentAssets,
        currentLiabilities,
      },
      receivablesPayables: {
        receivables,
        payables,
      },
      inventorySummary: {
        closingStockQty: stockSummary.totals.closingQty,
        closingStockValue: stockSummary.totals.closingValue,
        outwardQty: stockSummary.totals.outwardQty,
        outwardValue: stockSummary.totals.outwardValue,
        inwardQty: stockSummary.totals.inwardQty,
        inwardValue: stockSummary.totals.inwardValue,
      },
      accountingRatios: {
        inventoryTurnover,
        debtEquityRatio,
        receivableTurnoverDays,
        returnOnInvestment,
      },
      cashBankAccounts: {
        cashInHand: cashInHandTotal,
        bankAccounts: bankBalanceTotal,
      },
      tradingDetails: {
        grossProfit,
        netLoss: netProfit < 0 ? Math.abs(netProfit) : 0,
        salesAccounts: salesTotal,
        purchaseAccounts: purchaseTotal,
      },
      recentVouchers: vouchers
        .slice()
        .sort((left, right) => new Date(right.date) - new Date(left.date))
        .slice(0, 6),
    });
  } catch (err) {
    console.error("Error loading dashboard report:", err);
    res.status(500).json({ message: "Error loading dashboard report" });
  }
});

app.get("/companies/:companyId/reports/manufacturing-dashboard", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    res.json(await buildManufacturingDashboard(companyId));
  } catch (err) {
    console.error("Error loading manufacturing dashboard report:", err);
    res.status(500).json({ message: "Error loading manufacturing dashboard report" });
  }
});

app.get("/companies/:companyId/reports/outstanding", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const type = String(req.query.type || "receivable").toLowerCase();
    const toDate = safeDate(req.query.to);

    const [vouchers, ledgers] = await Promise.all([
      Vouchers.find(
        activeVoucherFilter(
          toDate ? { companyId, date: { $lte: toDate } } : { companyId },
        ),
      ).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
    ]);

    const balances = summarizeLedgerBalances(ledgers, vouchers, null, toDate);
    const targetGroupName =
      type === "payable" ? "sundry creditors" : "sundry debtors";

    const rows = balances
      .filter((row) => nameKey(row.group?.name || "") === targetGroupName)
      .map((row) => ({
        ledgerId: row._id,
        ledgerName: row.name,
        amount:
          type === "payable"
            ? normalizeMoney(row.closingCredit || 0)
            : normalizeMoney(row.closingDebit || 0),
      }))
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    res.json({
      type,
      rows,
      total: rows.reduce((sum, row) => normalizeMoney(sum + row.amount), 0),
      asOn: toDate || new Date(),
    });
  } catch (err) {
    console.error("Error loading outstanding report:", err);
    res.status(500).json({ message: "Error loading outstanding report" });
  }
});

app.get("/companies/:companyId/reports/cash-flow", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [vouchers, ledgers] = await Promise.all([
      Vouchers.find(activeVoucherFilter({ companyId })).toArray(),
      Ledgers.aggregate([
        { $match: { companyId } },
        {
          $lookup: {
            from: "groups",
            localField: "groupId",
            foreignField: "_id",
            as: "group",
          },
        },
        { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
      ]).toArray(),
    ]);

    const cashBankLedgers = ledgers.filter((row) =>
      ["cash-in-hand", "bank accounts"].includes(
        nameKey(row.group?.name || ""),
      ),
    );
    const cashBankIds = new Set(cashBankLedgers.map((row) => String(row._id)));
    const balances = summarizeLedgerBalances(
      ledgers,
      vouchers,
      fromDate,
      toDate,
    );
    const cashBalances = balances.filter((row) =>
      cashBankIds.has(String(row._id)),
    );

    let inflow = 0;
    let outflow = 0;
    const monthlyMap = new Map();

    vouchers.forEach((voucher) => {
      const voucherDate = voucher?.date ? new Date(voucher.date) : null;
      const inPeriod =
        (!fromDate || (voucherDate && voucherDate >= fromDate)) &&
        (!toDate || (voucherDate && voucherDate <= toDate));
      if (!inPeriod) return;

      let monthKey = "Unknown";
      if (voucherDate) {
        monthKey = dayjs(voucherDate).format("MMM YYYY");
      }
      const month = monthlyMap.get(monthKey) || { inflow: 0, outflow: 0 };

      (voucher.lines || []).forEach((line) => {
        if (!cashBankIds.has(String(line.ledgerId))) return;
        const debit = Number(line.debit || 0);
        const credit = Number(line.credit || 0);
        inflow = normalizeMoney(inflow + debit);
        outflow = normalizeMoney(outflow + credit);
        month.inflow = normalizeMoney(month.inflow + debit);
        month.outflow = normalizeMoney(month.outflow + credit);
      });

      monthlyMap.set(monthKey, month);
    });

    res.json({
      openingBalance: cashBalances.reduce(
        (sum, row) => normalizeMoney(sum + Number(row.opening || 0)),
        0,
      ),
      inflow,
      outflow,
      netFlow: normalizeMoney(inflow - outflow),
      closingBalance: cashBalances.reduce(
        (sum, row) => normalizeMoney(sum + Number(row.closing || 0)),
        0,
      ),
      monthly: [...monthlyMap.entries()].map(([label, value]) => ({
        label,
        inflow: value.inflow,
        outflow: value.outflow,
        net: normalizeMoney(value.inflow - value.outflow),
      })),
      ledgerBalances: cashBalances
        .map((row) => ({
          ledgerId: row._id,
          ledgerName: row.name,
          opening: normalizeMoney(row.opening || 0),
          inflow: normalizeMoney(row.debit || 0),
          outflow: normalizeMoney(row.credit || 0),
          closing: normalizeMoney(row.closing || 0),
        }))
        .sort((a, b) => a.ledgerName.localeCompare(b.ledgerName)),
    });
  } catch (err) {
    console.error("Error loading cash flow:", err);
    res.status(500).json({ message: "Error loading cash flow" });
  }
});

// ---------- CHART OF ACCOUNTS: STOCK GROUPS (hierarchical list) ----------
// ---------- CHART OF ACCOUNTS: STOCK GROUPS (hierarchical like Tally) ----------
app.get(
  "/companies/:companyId/chart-of-accounts/stock-groups",
  async (req, res) => {
    try {
      const companyId = new ObjectId(req.params.companyId);

      // 1. Find PRIMARY stock group (same as stock-items API)
      const primaryGroup = await db.collection("groups").findOne({
        companyId,
        name: { $in: ["Stock-in-Trade", "Primary", "Stock In Trade"] },
      });

      if (!primaryGroup) {
        return res
          .status(404)
          .json({ message: "Primary stock group not found" });
      }

      // 2. Load ALL groups (ONLY GROUPS, not items)
      const allGroups = await db
        .collection("groups")
        .find({ companyId })
        .toArray();

      // 3. Build child-group map
      const childGroups = new Map();
      allGroups.forEach((g) => {
        const parentKey = g.parentId ? String(g.parentId) : "ROOT";
        if (!childGroups.has(parentKey)) childGroups.set(parentKey, []);
        childGroups.get(parentKey).push(g);
      });

      // Sort alphabetically
      for (const list of childGroups.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
      }

      const result = [];

      // 4. WALK JUST LIKE STOCK-ITEM API (but skip items)
      function walkGroup(groupId, level) {
        const children = childGroups.get(String(groupId)) || [];

        for (const group of children) {
          result.push({
            type: "group",
            id: group._id,
            name: group.name,
            level,
          });

          // Continue deeper (even last-level groups)
          walkGroup(group._id, level + 1);
        }
      }

      // 5. Start from PRIMARY group (just like stock-items)
      result.push({
        type: "group",
        id: primaryGroup._id,
        name: primaryGroup.name,
        level: 0,
      });

      walkGroup(primaryGroup._id, 1);

      res.json(result);
    } catch (err) {
      console.error("Error loading stock groups:", err);
      res.status(500).json({ message: "Error loading stock group list" });
    }
  },
);

app.post("/companies/:companyId/price-levels", requireCompanyWriteAccess(ROLE_GROUPS.priceManagement), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const { code, name } = req.body;

    if (!code || !name) {
      return res.status(400).json({ message: "Code and Name required" });
    }

    // Prevent duplicates
    const exists = await pricelevels.findOne({ companyId, code });
    if (exists)
      return res.status(400).json({ message: "Price level already exists" });

    const doc = {
      companyId,
      code: code.trim(),
      name: name.trim(),
      createdAt: new Date(),
    };

    const result = await pricelevels.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error creating price level" });
  }
});
app.get("/companies/:companyId/price-levels", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const list = await pricelevels
    .find({ companyId })
    .sort({ code: 1 })
    .toArray();
  res.json(list);
});
app.put("/companies/:companyId/price-levels/:id", requireCompanyWriteAccess(ROLE_GROUPS.priceManagement), async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const companyId = new ObjectId(req.params.companyId);
    const { code, name } = req.body;

    await pricelevels.updateOne(
      { _id: id, companyId },
      { $set: { code, name } },
    );

    const updated = await pricelevels.findOne({ _id: id, companyId });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error updating price level" });
  }
});
app.delete("/companies/:companyId/price-levels/:id", requireCompanyWriteAccess(ROLE_GROUPS.priceManagement), async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const companyId = new ObjectId(req.params.companyId);
    const existingLevel = await pricelevels.findOne({ _id: id, companyId });
    if (!existingLevel) {
      return res.status(404).json({ message: "Price level not found" });
    }
    if (existingLevel.isSystem) {
      return res
        .status(400)
        .json({ message: "System price levels cannot be deleted" });
    }

    await pricelevels.deleteOne({ _id: id, companyId });
    res.json({ message: "Price level deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error deleting price level" });
  }
});

async function listNamedMasters(collection, companyId, extraSort = {}) {
  return collection
    .find({ companyId })
    .sort({ name: 1, ...extraSort })
    .toArray();
}

async function createNamedMaster(collection, companyId, payload, options = {}) {
  const name = normalizeName(payload.name);
  if (!name) throw new Error("Name is required");

  const duplicate = await collection.findOne({
    companyId,
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  });
  if (duplicate)
    throw new Error(options.duplicateMessage || "Name already exists");

  const doc = {
    companyId,
    name,
    createdAt: new Date(),
    ...(options.mapPayload ? options.mapPayload(payload, companyId) : {}),
  };

  const result = await collection.insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

async function updateNamedMaster(
  collection,
  companyId,
  id,
  payload,
  options = {},
) {
  const rowId = new ObjectId(id);
  const existing = await collection.findOne({ _id: rowId, companyId });
  if (!existing) throw new Error("Record not found");
  if (existing.isSystem) throw new Error("System master cannot be altered");

  const name = normalizeName(payload.name);
  if (!name) throw new Error("Name is required");

  const duplicate = await collection.findOne({
    _id: { $ne: rowId },
    companyId,
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  });
  if (duplicate)
    throw new Error(options.duplicateMessage || "Name already exists");

  await collection.updateOne(
    { _id: rowId, companyId },
    {
      $set: {
        name,
        ...(options.mapPayload ? options.mapPayload(payload, companyId) : {}),
      },
    },
  );
}

async function deleteNamedMaster(collection, companyId, id, usageCheck) {
  const row = await collection.findOne({ _id: new ObjectId(id), companyId });
  if (!row) throw new Error("Record not found");
  if (row.isSystem) throw new Error("System master cannot be deleted");
  if (usageCheck) await usageCheck(row);
  await collection.deleteOne({ _id: row._id, companyId });
}

async function resolveDefaultPosLedgers(companyId) {
  const ledgers = await Ledgers.aggregate([
    { $match: { companyId } },
    {
      $lookup: {
        from: "groups",
        localField: "groupId",
        foreignField: "_id",
        as: "group",
      },
    },
    { $unwind: { path: "$group", preserveNullAndEmptyArrays: true } },
  ]).toArray();

  return {
    salesLedger:
      ledgers.find((ledger) => nameKey(ledger.name) === "sales") || null,
    cashLedger:
      ledgers.find((ledger) => nameKey(ledger.name) === "cash") || null,
    bankLedger:
      ledgers.find(
        (ledger) => nameKey(ledger.group?.name || "") === "bank accounts",
      ) || null,
  };
}

async function upsertPosCustomer(companyId, customerInput, purchaseSummary) {
  const phone = normalizePhone(customerInput?.phone);
  if (!phone) throw new Error("Customer phone number is required");

  const normalizedName = normalizeName(
    customerInput?.name || "Walk-in Customer",
  );
  const normalizedAddress = normalizeName(customerInput?.address || "");
  const rewardEarned = normalizeMoney(purchaseSummary.rewardEarned);
  const rewardRedeemed = normalizeMoney(purchaseSummary.rewardRedeemed);
  const totalSpent = normalizeMoney(purchaseSummary.totalAmount);
  const voucherDate = new Date(purchaseSummary.date);

  const existing = await Customers.findOne({ companyId, phone });
  if (!existing) {
    const doc = {
      companyId,
      name: normalizedName,
      phone,
      address: normalizedAddress,
      rewardPoints: normalizeMoney(rewardEarned - rewardRedeemed),
      lifetimeRewardEarned: rewardEarned,
      lifetimeRewardRedeemed: rewardRedeemed,
      totalSpent,
      totalOrders: 1,
      firstPurchaseAt: voucherDate,
      lastPurchaseAt: voucherDate,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await Customers.insertOne(doc);
    return { _id: result.insertedId, ...doc };
  }

  const nextRewardPoints = normalizeMoney(
    Number(existing.rewardPoints || 0) + rewardEarned - rewardRedeemed,
  );

  await Customers.updateOne(
    { _id: existing._id, companyId },
    {
      $set: {
        name: normalizedName || existing.name,
        address: normalizedAddress || existing.address || "",
        lastPurchaseAt: voucherDate,
        updatedAt: new Date(),
        rewardPoints: nextRewardPoints,
      },
      $inc: {
        totalSpent,
        totalOrders: 1,
        lifetimeRewardEarned: rewardEarned,
        lifetimeRewardRedeemed: rewardRedeemed,
      },
    },
  );

  return await Customers.findOne({ _id: existing._id, companyId });
}

async function rebuildPosCustomerFromVouchers(companyId, phoneInput) {
  const phone = normalizePhone(phoneInput);
  if (!phone) return null;

  const vouchers = await Vouchers.find(activeVoucherFilter({
    companyId,
    voucherName: { $regex: "^POS Voucher$", $options: "i" },
    "customerSnapshot.phone": phone,
  }))
    .sort({ date: 1, createdAt: 1 })
    .toArray();

  if (vouchers.length === 0) {
    await Customers.deleteOne({ companyId, phone });
    return null;
  }

  const firstVoucher = vouchers[0];
  const latestVoucher = vouchers[vouchers.length - 1];
  const totalSpent = normalizeMoney(
    vouchers.reduce(
      (sum, voucher) => sum + Number(voucher.posMeta?.totalAmount || 0),
      0,
    ),
  );
  const lifetimeRewardEarned = normalizeMoney(
    vouchers.reduce(
      (sum, voucher) => sum + Number(voucher.posMeta?.rewardEarned || 0),
      0,
    ),
  );
  const lifetimeRewardRedeemed = normalizeMoney(
    vouchers.reduce(
      (sum, voucher) => sum + Number(voucher.posMeta?.rewardRedeemed || 0),
      0,
    ),
  );
  const rewardPoints = normalizeMoney(
    lifetimeRewardEarned - lifetimeRewardRedeemed,
  );

  const doc = {
    companyId,
    name: normalizeName(
      latestVoucher.customerSnapshot?.name || "Walk-in Customer",
    ),
    phone,
    address: normalizeName(latestVoucher.customerSnapshot?.address || ""),
    rewardPoints,
    lifetimeRewardEarned,
    lifetimeRewardRedeemed,
    totalSpent,
    totalOrders: vouchers.length,
    firstPurchaseAt: new Date(firstVoucher.date),
    lastPurchaseAt: new Date(latestVoucher.date),
    updatedAt: new Date(),
  };

  const existing = await Customers.findOne({ companyId, phone });
  if (existing) {
    await Customers.updateOne(
      { _id: existing._id, companyId },
      {
        $set: doc,
        $setOnInsert: { createdAt: existing.createdAt || new Date() },
      },
    );
    return Customers.findOne({ _id: existing._id, companyId });
  }

  const insertDoc = {
    ...doc,
    createdAt: new Date(),
  };
  const result = await Customers.insertOne(insertDoc);
  return { _id: result.insertedId, ...insertDoc };
}

app.get("/companies/:companyId/cost-categories", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  res.json(await listNamedMasters(CostCategories, companyId, { createdAt: 1 }));
});

app.post("/companies/:companyId/cost-categories", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const row = await createNamedMaster(CostCategories, companyId, req.body, {
      duplicateMessage: "Cost category already exists",
      mapPayload: (payload) => ({
        alias: normalizeTextBlock(payload.alias),
        description: normalizeTextBlock(payload.description),
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.put("/companies/:companyId/cost-categories/:id", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await updateNamedMaster(
      CostCategories,
      companyId,
      req.params.id,
      req.body,
      {
        duplicateMessage: "Cost category already exists",
        mapPayload: (payload) => ({
          alias: normalizeTextBlock(payload.alias),
          description: normalizeTextBlock(payload.description),
        }),
      },
    );
    res.json(
      await CostCategories.findOne({
        _id: new ObjectId(req.params.id),
        companyId,
      }),
    );
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete("/companies/:companyId/cost-categories/:id", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await deleteNamedMaster(CostCategories, companyId, req.params.id);
    res.json({ message: "Cost category deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.get("/companies/:companyId/cost-centres", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  res.json(await listNamedMasters(CostCentres, companyId, { createdAt: 1 }));
});

app.post("/companies/:companyId/cost-centres", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const row = await createNamedMaster(CostCentres, companyId, req.body, {
      duplicateMessage: "Cost centre already exists",
      mapPayload: (payload) => ({
        alias: normalizeTextBlock(payload.alias),
        description: normalizeTextBlock(payload.description),
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.put("/companies/:companyId/cost-centres/:id", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await updateNamedMaster(CostCentres, companyId, req.params.id, req.body, {
      duplicateMessage: "Cost centre already exists",
      mapPayload: (payload) => ({
        alias: normalizeTextBlock(payload.alias),
        description: normalizeTextBlock(payload.description),
      }),
    });
    res.json(
      await CostCentres.findOne({
        _id: new ObjectId(req.params.id),
        companyId,
      }),
    );
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete("/companies/:companyId/cost-centres/:id", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await deleteNamedMaster(CostCentres, companyId, req.params.id);
    res.json({ message: "Cost centre deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.get("/companies/:companyId/units", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  res.json(await listNamedMasters(Units, companyId, { createdAt: 1 }));
});

app.post("/companies/:companyId/units", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const row = await createNamedMaster(Units, companyId, req.body, {
      duplicateMessage: "Unit already exists",
      mapPayload: (payload) => ({
        symbol: normalizeName(payload.symbol),
        decimalPlaces: Number(payload.decimalPlaces || 2),
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message || "Unable to create unit" });
  }
});

app.put("/companies/:companyId/units/:id", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await updateNamedMaster(Units, companyId, req.params.id, req.body, {
      duplicateMessage: "Unit already exists",
      mapPayload: (payload) => ({
        symbol: normalizeName(payload.symbol),
        decimalPlaces: Number(payload.decimalPlaces || 2),
      }),
    });
    res.json(
      await Units.findOne({ _id: new ObjectId(req.params.id), companyId }),
    );
  } catch (err) {
    res.status(400).json({ message: err.message || "Unable to update unit" });
  }
});

app.delete("/companies/:companyId/units/:id", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await deleteNamedMaster(Units, companyId, req.params.id, async (row) => {
      const used = await Items.countDocuments({
        companyId,
        $or: [{ unitId: row._id }, { unitOfMeasure: row.name }],
      });
      if (used > 0) throw new Error("Unit is used in stock items");
    });
    res.json({ message: "Unit deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message || "Unable to delete unit" });
  }
});

app.get("/companies/:companyId/godowns", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  res.json(await listNamedMasters(Godowns, companyId, { createdAt: 1 }));
});

app.post("/companies/:companyId/godowns", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const row = await createNamedMaster(Godowns, companyId, req.body, {
      duplicateMessage: "Godown already exists",
      mapPayload: (payload) => ({
        alias: normalizeName(payload.alias),
        address: normalizeName(payload.address),
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message || "Unable to create godown" });
  }
});

app.put("/companies/:companyId/godowns/:id", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await updateNamedMaster(Godowns, companyId, req.params.id, req.body, {
      duplicateMessage: "Godown already exists",
      mapPayload: (payload) => ({
        alias: normalizeName(payload.alias),
        address: normalizeName(payload.address),
      }),
    });
    res.json(
      await Godowns.findOne({ _id: new ObjectId(req.params.id), companyId }),
    );
  } catch (err) {
    res.status(400).json({ message: err.message || "Unable to update godown" });
  }
});

app.delete("/companies/:companyId/godowns/:id", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await deleteNamedMaster(Godowns, companyId, req.params.id);
    res.json({ message: "Godown deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message || "Unable to delete godown" });
  }
});

app.get("/companies/:companyId/stock-categories", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const rows = await StockCategories.aggregate([
    { $match: { companyId } },
    {
      $lookup: {
        from: "stockCategories",
        localField: "parentId",
        foreignField: "_id",
        as: "parent",
      },
    },
    { $unwind: { path: "$parent", preserveNullAndEmptyArrays: true } },
    { $sort: { name: 1 } },
  ]).toArray();
  res.json(rows);
});

app.post("/companies/:companyId/stock-categories", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const row = await createNamedMaster(StockCategories, companyId, req.body, {
      duplicateMessage: "Stock category already exists",
      mapPayload: (payload) => ({
        parentId: payload.parentId ? new ObjectId(payload.parentId) : null,
      }),
    });
    res.status(201).json(row);
  } catch (err) {
    res
      .status(400)
      .json({ message: err.message || "Unable to create stock category" });
  }
});

app.put("/companies/:companyId/stock-categories/:id", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await updateNamedMaster(
      StockCategories,
      companyId,
      req.params.id,
      req.body,
      {
        duplicateMessage: "Stock category already exists",
        mapPayload: (payload) => ({
          parentId: payload.parentId ? new ObjectId(payload.parentId) : null,
        }),
      },
    );
    res.json(
      await StockCategories.findOne({
        _id: new ObjectId(req.params.id),
        companyId,
      }),
    );
  } catch (err) {
    res
      .status(400)
      .json({ message: err.message || "Unable to update stock category" });
  }
});

app.delete("/companies/:companyId/stock-categories/:id", requireCompanyWriteAccess(ROLE_GROUPS.inventoryMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await deleteNamedMaster(
      StockCategories,
      companyId,
      req.params.id,
      async (row) => {
        const childCount = await StockCategories.countDocuments({
          companyId,
          parentId: row._id,
        });
        if (childCount > 0)
          throw new Error("Stock category has child categories");
        const used = await Items.countDocuments({
          companyId,
          $or: [{ stockCategoryId: row._id }, { stockCategory: row.name }],
        });
        if (used > 0) throw new Error("Stock category is used in stock items");
      },
    );
    res.json({ message: "Stock category deleted" });
  } catch (err) {
    res
      .status(400)
      .json({ message: err.message || "Unable to delete stock category" });
  }
});

app.get("/companies/:companyId/currencies", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const company = await Companies.findOne({ _id: companyId });
  await ensureCompanyBaseCurrency(company);
  const rows = await Currencies.find({ companyId })
    .sort({ isBase: -1, code: 1 })
    .toArray();
  res.json(rows);
});

app.post("/companies/:companyId/currencies", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const code = normalizeName(req.body.code);
    const symbol = normalizeName(req.body.symbol);
    const name = normalizeName(req.body.name);
    const decimalPlaces = Number(req.body.decimalPlaces || 2);
    if (!code || !name) {
      return res
        .status(400)
        .json({ message: "Currency code and name are required" });
    }

    const duplicate = await Currencies.findOne({
      companyId,
      code: { $regex: `^${escapeRegex(code)}$`, $options: "i" },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Currency already exists" });
    }

    const doc = {
      companyId,
      code,
      symbol: symbol || code,
      name,
      decimalPlaces,
      isBase: false,
      createdAt: new Date(),
    };
    const result = await Currencies.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    res.status(500).json({ message: "Unable to create currency" });
  }
});

app.put("/companies/:companyId/currencies/:id", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const id = new ObjectId(req.params.id);
    const existing = await Currencies.findOne({ _id: id, companyId });
    if (!existing)
      return res.status(404).json({ message: "Currency not found" });
    if (existing.isSystem) {
      return res
        .status(400)
        .json({ message: "Base currency cannot be altered here" });
    }

    const code = normalizeName(req.body.code);
    const symbol = normalizeName(req.body.symbol);
    const name = normalizeName(req.body.name);
    const decimalPlaces = Number(req.body.decimalPlaces || 2);
    await Currencies.updateOne(
      { _id: id, companyId },
      { $set: { code, symbol: symbol || code, name, decimalPlaces } },
    );
    res.json(await Currencies.findOne({ _id: id, companyId }));
  } catch (err) {
    res.status(500).json({ message: "Unable to update currency" });
  }
});

app.delete("/companies/:companyId/currencies/:id", requireCompanyWriteAccess(ROLE_GROUPS.accountingMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const id = new ObjectId(req.params.id);
    const existing = await Currencies.findOne({ _id: id, companyId });
    if (!existing)
      return res.status(404).json({ message: "Currency not found" });
    if (existing.isBase || existing.isSystem) {
      return res
        .status(400)
        .json({ message: "Base currency cannot be deleted" });
    }
    await Currencies.deleteOne({ _id: id, companyId });
    res.json({ message: "Currency deleted" });
  } catch (err) {
    res.status(500).json({ message: "Unable to delete currency" });
  }
});

app.get("/companies/:companyId/employees", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const search = normalizeTextBlock(req.query.search);
    const query = { companyId };

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { name: regex },
        { employeeNumber: regex },
        { alias: regex },
        { "personalDetails.designation": regex },
      ];
    }

    const rows = await Employees.find(query)
      .sort({ createdAt: -1, name: 1 })
      .toArray();
    res.json(rows.map((row) => sanitizeEmployee(row)));
  } catch (err) {
    res.status(500).json({ message: "Unable to load employees" });
  }
});

app.get("/companies/:companyId/employees/:id", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const row = await Employees.findOne({
      _id: new ObjectId(req.params.id),
      companyId,
    });
    if (!row) return res.status(404).json({ message: "Employee not found" });
    res.json(sanitizeEmployee(row));
  } catch (err) {
    res.status(500).json({ message: "Unable to load employee" });
  }
});

app.post("/companies/:companyId/employees", requireCompanyWriteAccess(ROLE_GROUPS.payrollMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const generatedNumber = await generateEmployeeNumber(companyId);
    const doc = normalizeEmployeePayload(req.body, {
      employeeNumber: generatedNumber,
    });
    const loginEnabled = Boolean(doc.accessControl?.loginEnabled);
    const username = normalizeTextBlock(doc.accessControl?.username).toLowerCase();
    const password = normalizeTextBlock(req.body?.accessControl?.password);

    if (loginEnabled && !username) {
      return res.status(400).json({ message: "Login username is required when employee login is enabled" });
    }
    if (loginEnabled && !doc.accessControl?.role) {
      return res.status(400).json({ message: "Access role is required when employee login is enabled" });
    }
    if (loginEnabled && !password) {
      return res.status(400).json({ message: "Login password is required when employee login is enabled" });
    }

    const duplicateConditions = [];
    if (doc.employeeNumber) {
      duplicateConditions.push({ employeeNumber: doc.employeeNumber });
    }
    if (doc.name) {
      duplicateConditions.push({
        name: { $regex: `^${escapeRegex(doc.name)}$`, $options: "i" },
      });
    }

    const duplicate = duplicateConditions.length
      ? await Employees.findOne({
          companyId,
          $or: duplicateConditions,
        })
      : null;

    if (duplicate) {
      return res.status(400).json({
        message:
          "Employee with the same name or employee number already exists",
      });
    }

    if (loginEnabled) {
      const existingUsername = await Employees.findOne({
        companyId,
        "accessControl.username": { $regex: `^${escapeRegex(username)}$`, $options: "i" },
      });
      if (existingUsername) {
        return res.status(400).json({ message: "Employee login username already exists in this company" });
      }
    }

    const finalDoc = {
      companyId,
      ...doc,
      createdAt: new Date(),
    };
    finalDoc.accessControl.username = username;
    if (loginEnabled) {
      finalDoc.auth = hashCompanyPassword(password);
    }

    const result = await Employees.insertOne(finalDoc);
    res.status(201).json(sanitizeEmployee({ _id: result.insertedId, ...finalDoc }));
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Unable to create employee" });
  }
});

app.put("/companies/:companyId/employees/:id", requireCompanyWriteAccess(ROLE_GROUPS.payrollMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const id = new ObjectId(req.params.id);
    const existing = await Employees.findOne({ _id: id, companyId });
    if (!existing)
      return res.status(404).json({ message: "Employee not found" });

    const doc = normalizeEmployeePayload(req.body, {
      employeeNumber: existing.employeeNumber,
    });
    const loginEnabled = Boolean(doc.accessControl?.loginEnabled);
    const username = normalizeTextBlock(doc.accessControl?.username).toLowerCase();
    const password = normalizeTextBlock(req.body?.accessControl?.password);

    if (loginEnabled && !username) {
      return res.status(400).json({ message: "Login username is required when employee login is enabled" });
    }
    if (loginEnabled && !doc.accessControl?.role) {
      return res.status(400).json({ message: "Access role is required when employee login is enabled" });
    }

    const duplicateConditions = [];
    if (doc.employeeNumber) {
      duplicateConditions.push({ employeeNumber: doc.employeeNumber });
    }
    if (doc.name) {
      duplicateConditions.push({
        name: { $regex: `^${escapeRegex(doc.name)}$`, $options: "i" },
      });
    }

    const duplicate = duplicateConditions.length
      ? await Employees.findOne({
          companyId,
          _id: { $ne: id },
          $or: duplicateConditions,
        })
      : null;

    if (duplicate) {
      return res.status(400).json({
        message:
          "Employee with the same name or employee number already exists",
      });
    }

    if (loginEnabled) {
      const existingUsername = await Employees.findOne({
        companyId,
        _id: { $ne: id },
        "accessControl.username": { $regex: `^${escapeRegex(username)}$`, $options: "i" },
      });
      if (existingUsername) {
        return res.status(400).json({ message: "Employee login username already exists in this company" });
      }
    }

    doc.accessControl.username = username;
    const updatePayload = { ...doc };
    if (loginEnabled) {
      updatePayload.auth = password ? hashCompanyPassword(password) : existing.auth || null;
    } else {
      updatePayload.auth = null;
    }

    await Employees.updateOne({ _id: id, companyId }, { $set: updatePayload });

    res.json(sanitizeEmployee(await Employees.findOne({ _id: id, companyId })));
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Unable to update employee" });
  }
});

app.delete("/companies/:companyId/employees/:id", requireCompanyWriteAccess(ROLE_GROUPS.payrollMasters), async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await Employees.deleteOne({
      _id: new ObjectId(req.params.id),
      companyId,
    });
    res.json({ message: "Employee deleted" });
  } catch (err) {
    res.status(500).json({ message: "Unable to delete employee" });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running");
});

// ---------- START SERVER ----------
connectDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
    });
  })
  .catch((err) => {
    console.error("Failed to connect DB:", err);
    process.exit(1);
  });
