// app.js
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const dayjs = require("dayjs");
const { default: axios } = require("axios");

require("dotenv").config();

const app = express();

app.use(express.json({ limit: "100mb" }));
app.use(cors()); // Allow cross-origin requests

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://192.168.0.59:27017/Demo-pos";
const PORT = Number(process.env.PORT) || 15001;

app.use(express.json());

let db;
let Companies, Groups, Ledgers, VoucherTypes, Vouchers, Items, pricelevels;

const STOCK_VOUCHER_FLOW = {
  purchase: 1,
  receipt_note: 1,
  debit_note: 1,
  sales: -1,
  delivery_note: -1,
  credit_note: -1,
};

function normalizeName(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

function nameKey(value = "") {
  return normalizeName(value).toLowerCase();
}

function normalizeMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function splitBalance(amount) {
  const normalized = normalizeMoney(amount);
  if (normalized >= 0) {
    return { debit: normalized, credit: 0 };
  }
  return { debit: 0, credit: normalizeMoney(Math.abs(normalized)) };
}

function inferStockDirection(voucherName = "") {
  const key = nameKey(voucherName).replace(/[\s-]+/g, "_");
  return STOCK_VOUCHER_FLOW[key] || 0;
}

async function ensureCompanyCoreMasters(companyId) {
  const now = new Date();
  const groups = await Groups.find({ companyId }).toArray();
  const groupByName = new Map(groups.map((group) => [nameKey(group.name), group]));
  const missingGroups = [];

  if (!groupByName.has("stock-in-trade") && !groupByName.has("stock in trade")) {
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
    refreshedGroups.map((group) => [nameKey(group.name), group])
  );

  const salesAccountsGroup =
    refreshedGroupByName.get("sales accounts") || refreshedGroupByName.get("sales account");
  const purchaseAccountsGroup =
    refreshedGroupByName.get("purchase accounts") ||
    refreshedGroupByName.get("purchase account");

  const ledgers = await Ledgers.find({ companyId }).toArray();
  const ledgerByName = new Map(ledgers.map((ledger) => [nameKey(ledger.name), ledger]));
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
}

async function buildStockSummary(companyId) {
  const [groups, items, vouchers] = await Promise.all([
    Groups.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Vouchers.find({ companyId, inventoryLines: { $exists: true, $ne: [] } }).toArray(),
  ]);

  const groupsById = new Map(groups.map((group) => [String(group._id), group]));
  const movementsByItem = new Map();

  vouchers.forEach((voucher) => {
    const direction = inferStockDirection(voucher.voucherName);
    if (!Array.isArray(voucher.inventoryLines) || direction === 0) {
      return;
    }

    voucher.inventoryLines.forEach((line) => {
      if (!line?.itemId) return;
      const key = String(line.itemId);
      const current = movementsByItem.get(key) || {
        inwardQty: 0,
        inwardValue: 0,
        outwardQty: 0,
        outwardValue: 0,
      };

      const qty = Number(line.qty) || 0;
      const amount =
        Number(line.amount) || normalizeMoney((Number(line.rate) || 0) * qty);

      if (direction > 0) {
        current.inwardQty += qty;
        current.inwardValue += amount;
      } else {
        current.outwardQty += qty;
        current.outwardValue += amount;
      }

      movementsByItem.set(key, current);
    });
  });

  const rows = items
    .map((item) => {
      const movement = movementsByItem.get(String(item._id)) || {
        inwardQty: 0,
        inwardValue: 0,
        outwardQty: 0,
        outwardValue: 0,
      };
      const openingQty = Number(item.openingQty) || 0;
      const openingRate = Number(item.openingRate) || 0;
      const openingValue =
        Number(item.openingValue) || normalizeMoney(openingQty * openingRate);
      const closingQty = normalizeMoney(
        openingQty + movement.inwardQty - movement.outwardQty
      );
      const closingValue = normalizeMoney(
        openingValue + movement.inwardValue - movement.outwardValue
      );
      const closingRate =
        closingQty !== 0 ? normalizeMoney(closingValue / closingQty) : openingRate;

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
    }
  );

  return { rows, totals };
}

async function isStockGroup(companyId, groupId) {
  const groups = await Groups.find({ companyId }).toArray();
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const stockRoot = groups.find((group) =>
    ["stock-in-trade", "stock in trade", "primary"].includes(nameKey(group.name))
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
  Items = db.collection("items");
  pricelevels = db.collection("pricelevels");
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
    {
      _id: g.salesAccounts,
      companyId,
      name: "Sales Accounts",
      parentId: g.directIncomes,
      nature: "INCOME",
      affectsGrossProfit: true,
      createdAt: now,
    },
    {
      _id: g.purchaseAccounts,
      companyId,
      name: "Purchase Accounts",
      parentId: g.directExpenses,
      nature: "EXPENSE",
      affectsGrossProfit: true,
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
      groupId: g.indirectExpenses,
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
}

// ---------- COMPANIES ----------

// Create company + auto-create default groups, ledgers, voucher types
app.post("/companies", async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const { financialYearFrom, financialYearTo } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Company name is required" });
    }

    const existing = await Companies.findOne({ name: new RegExp(`^${name}$`, "i") });
    if (existing) {
      return res.status(400).json({ message: "A company with this name already exists" });
    }

    const now = new Date();
    const result = await Companies.insertOne({
      name,
      financialYearFrom,
      financialYearTo,
      createdAt: now,
    });

    const companyId = result.insertedId;
    await seedDefaultMasters(companyId);
    await ensureCompanyCoreMasters(companyId);

    const company = await Companies.findOne({ _id: companyId });

    res.status(201).json({
      message: "Company created with default masters",
      company,
    });
  } catch (err) {
    console.error("Error creating company:", err);
    res.status(500).json({ message: "Error creating company" });
  }
});

// List companies
app.get("/companies", async (req, res) => {
  const list = await Companies.find().sort({ name: 1 }).toArray();
  res.json(list);
});

app.get("/companies/:companyId/masters/overview", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const [company, groups, ledgers, items, voucherTypes, levels] = await Promise.all([
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
      company,
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

// ---------- GROUPS (CRUD like Tally Masters) ----------

// List groups for a company
app.get("/companies/:companyId/groups", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const groups = await Groups.find({ companyId }).toArray();
  res.json(groups);
});

// Create group
app.post("/companies/:companyId/groups", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const name = normalizeName(req.body.name);
    const { parentId, nature, affectsGrossProfit } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Group name is required" });
    }

    const duplicate = await Groups.findOne({
      companyId,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Group name already exists" });
    }

    if (parentId) {
      const parent = await Groups.findOne({ _id: new ObjectId(parentId), companyId });
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
app.put("/companies/:companyId/groups/:groupId", async (req, res) => {
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
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (duplicate) {
      return res.status(400).json({ message: "Group name already exists" });
    }

    if (parentId) {
      const parentObjectId = new ObjectId(parentId);
      if (String(parentObjectId) === String(groupId)) {
        return res.status(400).json({ message: "Group cannot be parent of itself" });
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

// Delete group (basic guard: no ledgers using it)
app.delete("/companies/:companyId/groups/:groupId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const groupId = new ObjectId(req.params.groupId);
    const existingGroup = await Groups.findOne({ _id: groupId, companyId });
    if (!existingGroup) {
      return res.status(404).json({ message: "Group not found" });
    }
    if (existingGroup.isSystem) {
      return res.status(400).json({ message: "System groups cannot be deleted" });
    }

    const ledgerCount = await Ledgers.countDocuments({ companyId, groupId });
    const childCount = await Groups.countDocuments({
      companyId,
      parentId: groupId,
    });

    if (ledgerCount > 0 || childCount > 0) {
      return res.status(400).json({
        message:
          "Group is in use (has ledgers or child groups). Cannot delete.",
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

app.get("/companies/:companyId/ledgers/defaults", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const [ledgers, groups] = await Promise.all([
      Ledgers.find({ companyId }).toArray(),
      Groups.find({ companyId }).toArray(),
    ]);
    const groupById = new Map(groups.map((group) => [String(group._id), group]));

    res.json({
      salesLedger: ledgers.find((ledger) => nameKey(ledger.name) === "sales") || null,
      purchaseLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "purchase") || null,
      cashLedger: ledgers.find((ledger) => nameKey(ledger.name) === "cash") || null,
      bankLedgers: ledgers.filter(
        (ledger) =>
          nameKey(groupById.get(String(ledger.groupId))?.name) === "bank accounts"
      ),
      debtorLedgers: ledgers.filter(
        (ledger) =>
          nameKey(groupById.get(String(ledger.groupId))?.name) === "sundry debtors"
      ),
      creditorLedgers: ledgers.filter(
        (ledger) =>
          nameKey(groupById.get(String(ledger.groupId))?.name) === "sundry creditors"
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
app.post("/companies/:companyId/ledgers", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const name = normalizeName(req.body.name);
    const {
      groupId,
      openingBalance = 0,
      openingDrCr = "DR",
      priceLevelId = null,
    } = req.body;
    if (!name || !groupId) {
      return res.status(400).json({ message: "Ledger name and group are required" });
    }

    const group = await Groups.findOne({ _id: new ObjectId(groupId), companyId });
    if (!group) {
      return res.status(400).json({ message: "Group not found" });
    }

    const duplicate = await Ledgers.findOne({
      companyId,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
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

    const result = await Ledgers.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating ledger:", err);
    res.status(500).json({ message: "Error creating ledger" });
  }
});

// Alter ledger
app.put("/companies/:companyId/ledgers/:ledgerId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const ledgerId = new ObjectId(req.params.ledgerId);
    const name = normalizeName(req.body.name);
    const { groupId, openingBalance, openingDrCr, priceLevelId } = req.body;
    if (!name) {
      return res.status(400).json({ message: "Ledger name is required" });
    }

    if (groupId) {
      const group = await Groups.findOne({ _id: new ObjectId(groupId), companyId });
      if (!group) {
        return res.status(400).json({ message: "Group not found" });
      }
    }

    const duplicate = await Ledgers.findOne({
      _id: { $ne: ledgerId },
      companyId,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
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
        priceLevelId: priceLevelId !== undefined ? priceLevelId || null : undefined,
      },
    };

    // Clean undefined keys
    Object.keys(update.$set).forEach(
      (k) => update.$set[k] === undefined && delete update.$set[k]
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
app.delete("/companies/:companyId/ledgers/:ledgerId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const ledgerId = new ObjectId(req.params.ledgerId);
    const existingLedger = await Ledgers.findOne({ _id: ledgerId, companyId });
    if (!existingLedger) {
      return res.status(404).json({ message: "Ledger not found" });
    }
    if (existingLedger.isSystem) {
      return res.status(400).json({ message: "System ledgers cannot be deleted" });
    }

    const used = await Vouchers.countDocuments({
      companyId,
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
app.post("/companies/:companyId/voucher-types", async (req, res) => {
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
  }
);

// Delete voucher type (if not used)
app.delete(
  "/companies/:companyId/voucher-types/:voucherTypeId",
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
  }
);

// ---------- VOUCHERS (create / alter / delete) ----------

// List vouchers (basic)
// GET vouchers for a company + voucher type
app.get("/companies/:companyId/vouchers", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const { type } = req.query; // voucherTypeId

  const filter = { companyId };

  if (type) {
    filter.voucherTypeId = new ObjectId(type);
  }

  const list = await Vouchers.find(filter).toArray();
  res.json(list);
});

// Create voucher (like Tally: one header + many lines)
// CREATE PURCHASE / SALES / INVENTORY VOUCHER
app.post("/companies/:companyId/vouchers", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);

    const {
      voucherTypeId,
      voucherName,
      number,
      date,
      narration,
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
    if (validLines.length < 2) {
      return res
        .status(400)
        .json({ message: "Voucher must have at least 2 accounting lines" });
    }

    // Validate inventory lines
    const normalizedInventory = (inventoryLines || [])
      .filter((line) => line?.itemId)
      .map((i) => ({
        itemId: new ObjectId(i.itemId),
        itemName: normalizeName(i.itemName || i.productSnapshot?.name || ""),
        qty: Number(i.qty) || 0,
        rate: Number(i.rate) || 0,
        amount: Number(i.amount) || Number(i.qty) * Number(i.rate),
        billedQty: Number(i.billedQty) || Number(i.qty),
        discount: Number(i.discount) || 0,
      }));

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

    if (totalDr.toFixed(2) !== totalCr.toFixed(2)) {
      return res.status(400).json({
        message: "Total Debit and Credit must be equal",
      });
    }

    const doc = {
      companyId,
      voucherName: normalizeName(voucherName || voucherType.name),
      voucherTypeId: new ObjectId(voucherTypeId),
      number,
      date: new Date(date),
      narration: narration || "",
      lines: normalizedLines,
      inventoryLines: normalizedInventory,
      createdAt: new Date(),
    };

    const result = await Vouchers.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("Error creating voucher:", err);
    res.status(500).json({ message: "Error creating voucher" });
  }
});

// Alter voucher
app.put("/companies/:companyId/vouchers/:voucherId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const voucherId = new ObjectId(req.params.voucherId);
    const { voucherTypeId, voucherName, number, date, narration, lines, inventoryLines } =
      req.body;

    const update = { $set: {} };

    if (voucherTypeId) update.$set.voucherTypeId = new ObjectId(voucherTypeId);
    if (voucherName) update.$set.voucherName = normalizeName(voucherName);
    if (number !== undefined) update.$set.number = number;
    if (date) update.$set.date = new Date(date);
    if (narration !== undefined) update.$set.narration = narration;

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
      if (totalDr.toFixed(2) !== totalCr.toFixed(2)) {
        return res
          .status(400)
          .json({ message: "Total Debit and Credit must be equal" });
      }
      update.$set.lines = normalizedLines;
    }

    if (Array.isArray(inventoryLines)) {
      update.$set.inventoryLines = inventoryLines
        .filter((line) => line?.itemId)
        .map((line) => ({
          itemId: new ObjectId(line.itemId),
          itemName: normalizeName(line.itemName || line.productSnapshot?.name || ""),
          qty: Number(line.qty) || 0,
          rate: Number(line.rate) || 0,
          amount:
            Number(line.amount) || (Number(line.qty) || 0) * (Number(line.rate) || 0),
          billedQty: Number(line.billedQty) || Number(line.qty) || 0,
          discount: Number(line.discount) || 0,
        }));
    }

    await Vouchers.updateOne({ _id: voucherId, companyId }, update);
    const updated = await Vouchers.findOne({ _id: voucherId, companyId });
    res.json(updated);
  } catch (err) {
    console.error("Error updating voucher:", err);
    res.status(500).json({ message: "Error updating voucher" });
  }
});

// Delete voucher
app.delete("/companies/:companyId/vouchers/:voucherId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const voucherId = new ObjectId(req.params.voucherId);

    await Vouchers.deleteOne({ _id: voucherId, companyId });
    res.json({ message: "Voucher deleted" });
  } catch (err) {
    console.error("Error deleting voucher:", err);
    res.status(500).json({ message: "Error deleting voucher" });
  }
});

// Get next voucher number for a voucher type
app.get("/companies/:companyId/vouchers/next-number", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const { voucherTypeId } = req.query;

  if (!voucherTypeId) {
    return res.status(400).json({ message: "voucherTypeId required" });
  }

  const last = await Vouchers.find({
    companyId,
    voucherTypeId: new ObjectId(voucherTypeId),
  })
    .sort({ number: -1 })
    .limit(1)
    .toArray();

  let nextNumber = 1;

  if (last.length > 0 && !isNaN(last[0].number)) {
    nextNumber = Number(last[0].number) + 1;
  }

  res.json({ nextNumber });
});

// ---------- SAMPLE REPORT: Trial Balance (base for BS & P&L) ----------

app.get("/companies/:companyId/reports/trial-balance", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const { from, to } = req.query;

    // Convert to real Dates
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;

    // -----------------------------------------------------
    // 1️⃣ GET MOVEMENTS BEFORE FROM DATE = TRUE OPENING
    // -----------------------------------------------------
    let openingFilter = { companyId };
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
      openingMap.set(String(m._id), (m.debit || 0) - (m.credit || 0))
    );

    // -----------------------------------------------------
    // 2️⃣ MOVEMENTS FOR SELECTED DATE RANGE (FROM <> TO)
    // -----------------------------------------------------
    let periodFilter = { companyId };
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
      const openingMovement = openingMap.get(String(l._id)) || 0;
      const fixedOpening =
        (l.openingDrCr === "DR" ? 1 : -1) * (l.openingBalance || 0);

      // TRUE OPENING = fixed opening + all movements before selected FROM
      const opening = fixedOpening + openingMovement;

      const periodMovement = periodMap.get(String(l._id)) || {
        debit: 0,
        credit: 0,
      };

      const debit = periodMovement.debit || 0;
      const credit = periodMovement.credit || 0;

      const closing = opening + (debit - credit);

      const openingSide = splitBalance(opening);
      const closingSide = splitBalance(closing);

      return {
        ledgerId: l._id,
        ledgerName: l.name,
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

    const totals = rows.reduce(
      (accumulator, row) => ({
        openingDebit: normalizeMoney(accumulator.openingDebit + row.openingDebit),
        openingCredit: normalizeMoney(accumulator.openingCredit + row.openingCredit),
        debit: normalizeMoney(accumulator.debit + row.debit),
        credit: normalizeMoney(accumulator.credit + row.credit),
        closingDebit: normalizeMoney(accumulator.closingDebit + row.closingDebit),
        closingCredit: normalizeMoney(accumulator.closingCredit + row.closingCredit),
      }),
      {
        openingDebit: 0,
        openingCredit: 0,
        debit: 0,
        credit: 0,
        closingDebit: 0,
        closingCredit: 0,
      }
    );

    res.json({ rows, totals });
  } catch (err) {
    console.error("Error building trial balance:", err);
    res.status(500).json({ message: "Error building trial balance" });
  }
});

// ---------- ITEMS (INVENTORY MASTERS) ----------

// List items for a company
app.get("/companies/:companyId/items", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);

  const items = await Items.aggregate([
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

  res.json(items);
});

// Create item (like Stock Item in Tally)
// CREATE ITEM (Tally Style)
app.post("/companies/:companyId/items", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const {
      name,
      alias,
      groupId,
      openingQty,
      openingRate,
      openingValue,
      prices,
    } = req.body;
    const normalizedName = normalizeName(name);
    if (!normalizedName || !groupId) {
      return res.status(400).json({ message: "Item name and group are required" });
    }

    const group = await Groups.findOne({ _id: new ObjectId(groupId), companyId });
    if (!group) {
      return res.status(400).json({ message: "Stock group not found" });
    }
    if (!(await isStockGroup(companyId, group._id))) {
      return res.status(400).json({ message: "Items must be created under a stock group" });
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

    const doc = {
      companyId,
      name: normalizedName,
      alias: normalizeName(alias),
      groupId: new ObjectId(groupId),
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
app.put("/companies/:companyId/items/:itemId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const itemId = new ObjectId(req.params.itemId);

    const {
      name,
      alias,
      groupId,
      openingQty,
      openingRate,
      prices, // NEW
    } = req.body;
    const normalizedName = normalizeName(name);
    if (!normalizedName || !groupId) {
      return res.status(400).json({ message: "Item name and group are required" });
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
    const group = await Groups.findOne({ _id: new ObjectId(groupId), companyId });
    if (!group) {
      return res.status(400).json({ message: "Stock group not found" });
    }
    if (!(await isStockGroup(companyId, group._id))) {
      return res.status(400).json({ message: "Items must be created under a stock group" });
    }

    const openingValue = Number(openingQty) * Number(openingRate);

    const update = {
      $set: {
        name: normalizedName,
        alias: normalizeName(alias),
        groupId: new ObjectId(groupId),
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
app.put("/companies/:companyId/update-prices-by-group", async (req, res) => {
  try {
    const { companyId } = req.params;
    const { groupId, priceLevelId, rate } = req.body;

    // ----------- VALIDATION -----------
    if (!companyId || !groupId || !priceLevelId || rate === undefined) {
      return res.status(400).json({
        message: "companyId, groupId, priceLevelId and rate are required",
      });
    }

    if (isNaN(rate)) {
      return res.status(400).json({ message: "Rate must be a number" });
    }

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

    console.log("ALL GROUPS TO UPDATE:", allGroupIds);

    // ----------- STEP 1: ADD priceLevel IF MISSING -----------
    const addResult = await Items.updateMany(
      {
        companyId: companyObjectId,
        groupId: { $in: allGroupIds },
        prices: { $not: { $elemMatch: { priceLevelId: priceLevelId } } },
      },
      {
        $push: {
          prices: { priceLevelId, rate: Number(rate) },
        },
      }
    );

    console.log("Added missing price level to:", addResult.modifiedCount);

    // ----------- STEP 2: UPDATE EXISTING PRICE LEVELS -----------
    const updateResult = await Items.updateMany(
      {
        companyId: companyObjectId,
        groupId: { $in: allGroupIds },
      },
      {
        $set: {
          "prices.$[elem].rate": Number(rate),
        },
      },
      {
        arrayFilters: [{ "elem.priceLevelId": priceLevelId }], // STRING compare
      }
    );

    console.log("Updated existing price levels:", updateResult.modifiedCount);

    res.json({
      message: "Bulk price update completed",
      addedPriceLevels: addResult.modifiedCount,
      updatedPriceLevels: updateResult.modifiedCount,
    });

  } catch (err) {
    console.error("❌ Bulk update error:", err);
    res.status(500).json({
      message: "Bulk update failed",
      error: err.message,
    });
  }
});


// Delete item (guard: not used in vouchers)
app.delete("/companies/:companyId/items/:itemId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const itemId = new ObjectId(req.params.itemId);

    const used = await Vouchers.countDocuments({
      companyId,
      "inventoryLines.itemId": itemId,
    });

    if (used > 0) {
      return res
        .status(400)
        .json({ message: "Item is used in vouchers. Cannot delete." });
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

    const groups = await Groups.find({ companyId }).toArray();

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
// ---------- CHART OF ACCOUNTS: LEDGERS (hierarchical list) ----------
app.get("/companies/:companyId/chart-of-accounts/ledgers", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);

    const groups = await Groups.find({ companyId }).toArray();
    const ledgers = await Ledgers.find({ companyId }).toArray();

    // Build group → child groups
    const childGroups = new Map();
    groups.forEach((g) => {
      const key = g.parentId ? String(g.parentId) : "ROOT";
      if (!childGroups.has(key)) childGroups.set(key, []);
      childGroups.get(key).push(g);
    });

    // Build group → ledgers
    const groupLedgers = new Map();
    ledgers.forEach((l) => {
      const key = String(l.groupId);
      if (!groupLedgers.has(key)) groupLedgers.set(key, []);
      groupLedgers.get(key).push(l);
    });

    // Sort groups & ledgers alphabetically
    for (const list of childGroups.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    for (const list of groupLedgers.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    const result = [];

    function walkGroup(parentKey, level) {
      const children = childGroups.get(parentKey) || [];

      for (const g of children) {
        // Add group entry
        result.push({
          type: "group",
          id: g._id,
          name: g.name,
          level,
        });

        // Add ledgers of this group
        const lds = groupLedgers.get(String(g._id)) || [];
        lds.forEach((l) => {
          result.push({
            type: "ledger",
            id: l._id,
            name: l.name,
            level: level + 1,
          });
        });

        // Process child groups
        walkGroup(String(g._id), level + 1);
      }
    }

    walkGroup("ROOT", 0);

    res.json(result);
  } catch (err) {
    console.error("Error building ledger tree:", err);
    res.status(500).json({ message: "Error loading ledger tree" });
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
  }
);

app.get("/companies/:companyId/reports/stock-summary", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const summary = await buildStockSummary(companyId);
    res.json(summary);
  } catch (err) {
    console.error("Error building stock summary:", err);
    res.status(500).json({ message: "Error building stock summary" });
  }
});

app.get("/companies/:companyId/reports/dashboard", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const [groupsCount, ledgersCount, itemsCount, vouchersCount, stockSummary] =
      await Promise.all([
        Groups.countDocuments({ companyId }),
        Ledgers.countDocuments({ companyId }),
        Items.countDocuments({ companyId }),
        Vouchers.countDocuments({ companyId }),
        buildStockSummary(companyId),
      ]);

    res.json({
      groupsCount,
      ledgersCount,
      itemsCount,
      vouchersCount,
      stockValue: stockSummary.totals.closingValue,
      stockQuantity: stockSummary.totals.closingQty,
      stockItems: stockSummary.rows.slice(0, 8),
    });
  } catch (err) {
    console.error("Error loading dashboard report:", err);
    res.status(500).json({ message: "Error loading dashboard report" });
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
  }
);

app.post("/companies/:companyId/price-levels", async (req, res) => {
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
app.put("/companies/:companyId/price-levels/:id", async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const companyId = new ObjectId(req.params.companyId);
    const { code, name } = req.body;

    await pricelevels.updateOne(
      { _id: id, companyId },
      { $set: { code, name } }
    );

    const updated = await pricelevels.findOne({ _id: id, companyId });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error updating price level" });
  }
});
app.delete("/companies/:companyId/price-levels/:id", async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const companyId = new ObjectId(req.params.companyId);
    const existingLevel = await pricelevels.findOne({ _id: id, companyId });
    if (!existingLevel) {
      return res.status(404).json({ message: "Price level not found" });
    }
    if (existingLevel.isSystem) {
      return res.status(400).json({ message: "System price levels cannot be deleted" });
    }

    await pricelevels.deleteOne({ _id: id, companyId });
    res.json({ message: "Price level deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error deleting price level" });
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
