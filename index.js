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
let Companies,
  Groups,
  Ledgers,
  VoucherTypes,
  Vouchers,
  Customers,
  Employees,
  Items,
  pricelevels,
  Currencies,
  StockCategories,
  Units,
  Godowns;

const STOCK_VOUCHER_FLOW = {
  purchase: 1,
  receipt_note: 1,
  debit_note: 1,
  sales: -1,
  pos_voucher: -1,
  delivery_note: -1,
  credit_note: -1,
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

function normalizeMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
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

function safeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function voucherTotalAmount(voucher) {
  const inventoryTotal = (voucher.inventoryLines || []).reduce(
    (sum, line) => normalizeMoney(sum + (Number(line.amount) || 0)),
    0,
  );
  if (inventoryTotal > 0) return inventoryTotal;

  return (voucher.lines || []).reduce(
    (sum, line) =>
      Math.max(sum, Number(line.debit || 0), Number(line.credit || 0)),
    0,
  );
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

  const payHeads = (salaryDetails.payHeads || []).map((head, index) => ({
    id: normalizeTextBlock(head.id) || `head-${index + 1}`,
    section:
      nameKey(head.section) === "deduction" ? "Deduction" : "Earning",
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
    employeeNumber: normalizeTextBlock(general.employeeNumber) || employeeNumber,
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
      fatherOrMotherName: normalizeTextBlock(personalDetails.fatherOrMotherName),
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
        dateOfBirth: normalizeTextBlock(statutoryDetails.compliance?.dateOfBirth),
      },
      documents: {
        idProof: normalizeTextBlock(statutoryDetails.documents?.idProof),
        taxDocument: normalizeTextBlock(statutoryDetails.documents?.taxDocument),
        pfDocument: normalizeTextBlock(statutoryDetails.documents?.pfDocument),
        otherDocument: normalizeTextBlock(statutoryDetails.documents?.otherDocument),
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
        department: normalizeTextBlock(additionalInformation.workDetails?.department),
        reportingTo: normalizeTextBlock(additionalInformation.workDetails?.reportingTo),
        jobTitle: normalizeTextBlock(additionalInformation.workDetails?.jobTitle),
      },
      leaveAttendance: {
        leavePolicy: normalizeTextBlock(
          additionalInformation.leaveAttendance?.leavePolicy,
        ),
        weeklyOff: normalizeTextBlock(additionalInformation.leaveAttendance?.weeklyOff),
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
        phone: normalizeTextBlock(additionalInformation.emergencyContact?.phone),
        address: normalizeTextBlock(additionalInformation.emergencyContact?.address),
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
          additionalInformation.previousEmployment?.relevantExperienceYears || 0,
        ),
      },
      otherInformation: {
        maritalStatus: normalizeTextBlock(
          additionalInformation.otherInformation?.maritalStatus,
        ),
        nationality: normalizeTextBlock(
          additionalInformation.otherInformation?.nationality,
        ),
        religion: normalizeTextBlock(additionalInformation.otherInformation?.religion),
        languages: normalizeTextBlock(
          additionalInformation.otherInformation?.languages,
        ),
        hobbies: normalizeTextBlock(additionalInformation.otherInformation?.hobbies),
      },
    },
    summary: summarizeSalaryHeads(payHeads),
    updatedAt: new Date(),
  };
}

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

  vouchers.forEach((voucher) => {
    const voucherDate = voucher?.date ? new Date(voucher.date) : null;
    const beforePeriod =
      fromDate && voucherDate ? voucherDate < fromDate : false;
    const inPeriod =
      (!fromDate || (voucherDate && voucherDate >= fromDate)) &&
      (!toDate || (voucherDate && voucherDate <= toDate));

    (voucher.lines || []).forEach((line) => {
      const ledgerKey = String(line.ledgerId);
      if (beforePeriod) {
        const current = openingMap.get(ledgerKey) || 0;
        openingMap.set(
          ledgerKey,
          normalizeMoney(
            current + (Number(line.debit) || 0) - (Number(line.credit) || 0),
          ),
        );
      }

      if (inPeriod) {
        const current = periodMap.get(ledgerKey) || { debit: 0, credit: 0 };
        current.debit = normalizeMoney(
          current.debit + (Number(line.debit) || 0),
        );
        current.credit = normalizeMoney(
          current.credit + (Number(line.credit) || 0),
        );
        periodMap.set(ledgerKey, current);
      }
    });
  });

  return ledgers.map((ledger) => {
    const openingMovement = openingMap.get(String(ledger._id)) || 0;
    const fixedOpening =
      (ledger.openingDrCr === "DR" ? 1 : -1) *
      (Number(ledger.openingBalance) || 0);
    const opening = normalizeMoney(fixedOpening + openingMovement);
    const periodMovement = periodMap.get(String(ledger._id)) || {
      debit: 0,
      credit: 0,
    };
    const debit = normalizeMoney(periodMovement.debit || 0);
    const credit = normalizeMoney(periodMovement.credit || 0);
    const closing = normalizeMoney(opening + debit - credit);

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
  const voucherTypeNames = new Set(existingVoucherTypes.map((row) => nameKey(row.name)));
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
}

async function ensureCompanyBaseCurrency(company) {
  if (!company?._id) return;
  const companyId = company._id;
  const code = normalizeName(company.baseCurrencyCode || company.baseCurrencySymbol || "BDT");
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

async function buildStockSummary(companyId, fromDate = null, toDate = null) {
  const [groups, items, vouchers] = await Promise.all([
    Groups.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Vouchers.find({
      companyId,
      ...(toDate ? { date: { $lte: toDate } } : {}),
      inventoryLines: { $exists: true, $ne: [] },
    }).toArray(),
  ]);

  const groupsById = new Map(groups.map((group) => [String(group._id), group]));
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

  vouchers
    .slice()
    .sort((left, right) => {
      const leftTime = left?.date ? new Date(left.date).getTime() : 0;
      const rightTime = right?.date ? new Date(right.date).getTime() : 0;
      return leftTime - rightTime;
    })
    .forEach((voucher) => {
      const direction = inferStockDirection(voucher.voucherName);
      if (!Array.isArray(voucher.inventoryLines) || direction === 0) {
        return;
      }

      const voucherDate = voucher?.date ? new Date(voucher.date) : null;
      const beforePeriod = fromDate && voucherDate ? voucherDate < fromDate : false;
      const inPeriod =
        !fromDate ||
        ((voucherDate && voucherDate >= fromDate) &&
          (!toDate || voucherDate <= toDate));

      voucher.inventoryLines.forEach((line) => {
        if (!line?.itemId) return;
        const key = String(line.itemId);
        const state =
          itemStateMap.get(key) || {
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

        const qty = normalizeMoney(Number(line.qty) || 0);
        const purchaseRate = normalizeMoney(Number(line.rate) || state.currentRate || 0);
        const costRate = normalizeMoney(state.currentRate || purchaseRate || 0);

        if (direction > 0) {
          if (beforePeriod) {
            state.currentQty = normalizeMoney(state.currentQty + qty);
            state.currentRate = purchaseRate;
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.inwardQty = normalizeMoney(state.movement.inwardQty + qty);
            state.movement.inwardValue = normalizeMoney(
              state.movement.inwardValue + qty * purchaseRate,
            );
            state.currentQty = normalizeMoney(state.currentQty + qty);
            state.currentRate = purchaseRate;
          }
        } else {
          const outwardValue = normalizeMoney(qty * costRate);

          if (beforePeriod) {
            state.currentQty = normalizeMoney(state.currentQty - qty);
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.outwardQty = normalizeMoney(state.movement.outwardQty + qty);
            state.movement.outwardValue = normalizeMoney(
              state.movement.outwardValue + outwardValue,
            );
            state.currentQty = normalizeMoney(state.currentQty - qty);
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

async function buildInventoryDetailReport(companyId, fromDate = null, toDate = null) {
  const [groups, items, vouchers] = await Promise.all([
    Groups.find({ companyId }).toArray(),
    Items.find({ companyId }).toArray(),
    Vouchers.find({
      companyId,
      ...(toDate ? { date: { $lte: toDate } } : {}),
      inventoryLines: { $exists: true, $ne: [] },
    }).toArray(),
  ]);

  const groupsById = new Map(groups.map((group) => [String(group._id), group]));
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
          },
          lastInwardAt: null,
          lastOutwardAt: null,
          history: [],
        },
      ];
    }),
  );

  vouchers
    .slice()
    .sort((left, right) => {
      const leftTime = left?.date ? new Date(left.date).getTime() : 0;
      const rightTime = right?.date ? new Date(right.date).getTime() : 0;
      return leftTime - rightTime;
    })
    .forEach((voucher) => {
      const direction = inferStockDirection(voucher.voucherName);
      if (!Array.isArray(voucher.inventoryLines) || direction === 0) return;

      const voucherDate = voucher?.date ? new Date(voucher.date) : null;
      const beforePeriod = fromDate && voucherDate ? voucherDate < fromDate : false;
      const inPeriod =
        !fromDate ||
        ((voucherDate && voucherDate >= fromDate) &&
          (!toDate || voucherDate <= toDate));

      voucher.inventoryLines.forEach((line) => {
        if (!line?.itemId) return;
        const key = String(line.itemId);
        const state =
          itemStateMap.get(key) || {
            item: {},
            openingSnapshot: { qty: 0, rate: 0, value: 0 },
            currentQty: 0,
            currentRate: 0,
            movement: {
              inwardQty: 0,
              inwardValue: 0,
              outwardQty: 0,
              outwardValue: 0,
            },
            lastInwardAt: null,
            lastOutwardAt: null,
            history: [],
          };

        const qty = normalizeMoney(Number(line.qty) || 0);
        const purchaseRate = normalizeMoney(Number(line.rate) || state.currentRate || 0);
        const effectiveRate = normalizeMoney(
          direction > 0 ? purchaseRate : state.currentRate || purchaseRate || 0,
        );
        const value = normalizeMoney(qty * effectiveRate);

        if (direction > 0) {
          if (beforePeriod) {
            state.currentQty = normalizeMoney(state.currentQty + qty);
            state.currentRate = effectiveRate;
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.inwardQty = normalizeMoney(state.movement.inwardQty + qty);
            state.movement.inwardValue = normalizeMoney(
              state.movement.inwardValue + value,
            );
            state.currentQty = normalizeMoney(state.currentQty + qty);
            state.currentRate = effectiveRate;
            state.lastInwardAt = voucher.date || state.lastInwardAt;
            state.history.push({
              voucherId: voucher._id,
              date: voucher.date || null,
              dateLabel: formatDateLabel(voucher.date),
              voucherName: voucher.voucherName || "Voucher",
              number:
                voucher.number || voucher.invoiceNumber || voucher.voucherNumber || "",
              direction: "IN",
              qty,
              rate: effectiveRate,
              value,
              closingQty: state.currentQty,
              closingRate: state.currentRate,
              closingValue: normalizeMoney(state.currentQty * state.currentRate),
              itemName: normalizeName(line.itemName || state.item?.name || ""),
            });
          }
        } else {
          if (beforePeriod) {
            state.currentQty = normalizeMoney(state.currentQty - qty);
            state.openingSnapshot = {
              qty: state.currentQty,
              rate: state.currentRate,
              value: normalizeMoney(state.currentQty * state.currentRate),
            };
          } else if (inPeriod) {
            state.movement.outwardQty = normalizeMoney(state.movement.outwardQty + qty);
            state.movement.outwardValue = normalizeMoney(
              state.movement.outwardValue + value,
            );
            state.currentQty = normalizeMoney(state.currentQty - qty);
            state.lastOutwardAt = voucher.date || state.lastOutwardAt;
            state.history.push({
              voucherId: voucher._id,
              date: voucher.date || null,
              dateLabel: formatDateLabel(voucher.date),
              voucherName: voucher.voucherName || "Voucher",
              number:
                voucher.number || voucher.invoiceNumber || voucher.voucherNumber || "",
              direction: "OUT",
              qty,
              rate: effectiveRate,
              value,
              closingQty: state.currentQty,
              closingRate: state.currentRate,
              closingValue: normalizeMoney(state.currentQty * state.currentRate),
              itemName: normalizeName(line.itemName || state.item?.name || ""),
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
        Number(state.movement.inwardQty || 0) + Number(state.movement.outwardQty || 0),
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
        inwardValue: normalizeMoney(state.movement.inwardValue),
        outwardQty: normalizeMoney(state.movement.outwardQty),
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
      openingQty !== 0 ? normalizeMoney(Math.abs(openingValue) / Math.abs(openingQty)) : 0,
    openingValue,
    inwardQty,
    inwardRate:
      inwardQty !== 0 ? normalizeMoney(Math.abs(inwardValue) / Math.abs(inwardQty)) : 0,
    inwardValue,
    outwardQty,
    outwardRate:
      outwardQty !== 0 ? normalizeMoney(Math.abs(outwardValue) / Math.abs(outwardQty)) : 0,
    outwardValue,
    closingQty,
    closingRate:
      closingQty !== 0 ? normalizeMoney(Math.abs(closingValue) / Math.abs(closingQty)) : 0,
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
  target.openingQty = normalizeMoney(target.openingQty + Number(source.openingQty || 0));
  target.openingValue = normalizeMoney(target.openingValue + Number(source.openingValue || 0));
  target.inwardQty = normalizeMoney(target.inwardQty + Number(source.inwardQty || 0));
  target.inwardValue = normalizeMoney(target.inwardValue + Number(source.inwardValue || 0));
  target.outwardQty = normalizeMoney(target.outwardQty + Number(source.outwardQty || 0));
  target.outwardValue = normalizeMoney(target.outwardValue + Number(source.outwardValue || 0));
  target.closingQty = normalizeMoney(target.closingQty + Number(source.closingQty || 0));
  target.closingValue = normalizeMoney(target.closingValue + Number(source.closingValue || 0));
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

async function buildInventoryMovementDimensionReport(
  companyId,
  fromDate = null,
  toDate = null,
  dimension = "stock-item",
) {
  const detailReport = await buildInventoryDetailReport(companyId, fromDate, toDate);

  if (["stock-item", "stock-group", "stock-category"].includes(dimension)) {
    const [items, categories] = await Promise.all([
      Items.find({ companyId }).toArray(),
      StockCategories.find({ companyId }).toArray(),
    ]);

    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const categoryById = new Map(categories.map((row) => [String(row._id), row.name]));
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
        secondaryLabel = `${detailReport.rows.filter((entry) => String(entry.groupId || "") === String(row.groupId || "")).length} items`;
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

  const [vouchers, ledgers] = await Promise.all([
    Vouchers.find({
      companyId,
      ...(toDate ? { date: { $lte: toDate } } : {}),
      inventoryLines: { $exists: true, $ne: [] },
    }).toArray(),
    Ledgers.find({ companyId }).toArray(),
  ]);

  const ledgerMap = new Map(ledgers.map((ledger) => [String(ledger._id), ledger.name]));
  const stateMap = new Map();

  vouchers
    .slice()
    .sort((left, right) => {
      const leftTime = left?.date ? new Date(left.date).getTime() : 0;
      const rightTime = right?.date ? new Date(right.date).getTime() : 0;
      return leftTime - rightTime;
    })
    .forEach((voucher) => {
      const direction = inferStockDirection(voucher.voucherName);
      if (!Array.isArray(voucher.inventoryLines) || direction === 0) return;

      const voucherDate = voucher?.date ? new Date(voucher.date) : null;
      const beforePeriod = fromDate && voucherDate ? voucherDate < fromDate : false;
      const inPeriod =
        !fromDate ||
        ((voucherDate && voucherDate >= fromDate) && (!toDate || voucherDate <= toDate));

      const partyMeta = resolveInventoryPartyMeta(voucher, ledgerMap);
      const key =
        dimension === "group"
          ? normalizeName(partyMeta.groupName).toLowerCase()
          : normalizeName(partyMeta.ledgerName).toLowerCase();
      const label = dimension === "group" ? partyMeta.groupName : partyMeta.ledgerName;
      const secondaryLabel =
        dimension === "group" ? "" : partyMeta.groupName;

      const state = stateMap.get(key) || {
        id: key,
        name: label || "Unassigned",
        secondaryLabel,
        metrics: emptyMovementAccumulator(),
      };

      voucher.inventoryLines.forEach((line) => {
        const qty = normalizeMoney(Number(line.qty) || 0);
        const rate = normalizeMoney(Number(line.rate) || 0);
        const value = normalizeMoney(Number(line.amount) || qty * rate);

        if (beforePeriod) {
          state.metrics.openingQty = normalizeMoney(
            state.metrics.openingQty + (direction > 0 ? qty : -qty),
          );
          state.metrics.openingValue = normalizeMoney(
            state.metrics.openingValue + (direction > 0 ? value : -value),
          );
        }

        if (inPeriod) {
          if (direction > 0) {
            state.metrics.inwardQty = normalizeMoney(state.metrics.inwardQty + qty);
            state.metrics.inwardValue = normalizeMoney(state.metrics.inwardValue + value);
          } else {
            state.metrics.outwardQty = normalizeMoney(state.metrics.outwardQty + qty);
            state.metrics.outwardValue = normalizeMoney(state.metrics.outwardValue + value);
          }
        }

        state.metrics.closingQty = normalizeMoney(
          state.metrics.closingQty + (direction > 0 ? qty : -qty),
        );
        state.metrics.closingValue = normalizeMoney(
          state.metrics.closingValue + (direction > 0 ? value : -value),
        );
      });

      stateMap.set(key, state);
    });

  const rows = [...stateMap.values()]
    .map((row) => ({
      ...row,
      metrics: buildMovementMetrics({
        ...row.metrics,
        closingQty: normalizeMoney(row.metrics.openingQty + row.metrics.inwardQty - row.metrics.outwardQty),
        closingValue: normalizeMoney(
          row.metrics.openingValue + row.metrics.inwardValue - row.metrics.outwardValue,
        ),
      }),
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

async function buildStockGroupSummary(companyId, fromDate = null, toDate = null) {
  const summary = await buildStockSummary(companyId, fromDate, toDate);
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
    ["stock-in-trade", "stock in trade", "primary"].includes(nameKey(group.name)),
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
    target.openingQty = normalizeMoney(target.openingQty + Number(source.openingQty || 0));
    target.openingValue = normalizeMoney(target.openingValue + Number(source.openingValue || 0));
    target.inwardQty = normalizeMoney(target.inwardQty + Number(source.inwardQty || 0));
    target.inwardValue = normalizeMoney(target.inwardValue + Number(source.inwardValue || 0));
    target.outwardQty = normalizeMoney(target.outwardQty + Number(source.outwardQty || 0));
    target.outwardValue = normalizeMoney(target.outwardValue + Number(source.outwardValue || 0));
    target.closingQty = normalizeMoney(target.closingQty + Number(source.closingQty || 0));
    target.closingValue = normalizeMoney(target.closingValue + Number(source.closingValue || 0));
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
    const childGroups = (childrenByParent.get(String(group._id)) || []).map((child) =>
      buildNode(child, level + 1),
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
  Customers = db.collection("customers");
  Employees = db.collection("employees");
  Items = db.collection("items");
  pricelevels = db.collection("pricelevels");
  Currencies = db.collection("currencies");
  StockCategories = db.collection("stockCategories");
  Units = db.collection("units");
  Godowns = db.collection("godowns");
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
    { companyId, name: "POS Voucher", category: "ACCOUNTING", createdAt: now, isSystem: true, systemKey: "pos-voucher" },
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
      createdAt: now,
    });

    const companyId = result.insertedId;
    await seedDefaultMasters(companyId);
    await ensureCompanyCoreMasters(companyId);

    const company = await Companies.findOne({ _id: companyId });
    await ensureCompanyBaseCurrency(company);

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

app.put("/companies/:companyId", async (req, res) => {
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

    await Companies.updateOne({ _id: companyId }, update);
    const company = await Companies.findOne({ _id: companyId });
    await ensureCompanyBaseCurrency(company);
    res.json(company);
  } catch (err) {
    console.error("Error updating company:", err);
    res.status(500).json({ message: "Error updating company" });
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
      return res
        .status(400)
        .json({ message: "System groups cannot be deleted" });
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

app.get("/companies/:companyId/ledgers/with-balances", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const toDate = safeDate(req.query.to);
    const [vouchers, ledgers] = await Promise.all([
      Vouchers.find(
        toDate ? { companyId, date: { $lte: toDate } } : { companyId },
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

    res.json({
      salesLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "sales") || null,
      purchaseLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "purchase") || null,
      cashLedger:
        ledgers.find((ledger) => nameKey(ledger.name) === "cash") || null,
      bankLedgers: ledgers.filter(
        (ledger) =>
          nameKey(groupById.get(String(ledger.groupId))?.name) ===
          "bank accounts",
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
app.delete("/companies/:companyId/ledgers/:ledgerId", async (req, res) => {
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
  },
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
  },
);

// ---------- VOUCHERS (create / alter / delete) ----------

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

app.post("/companies/:companyId/pos-vouchers", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);

    const {
      voucherTypeId,
      number,
      date,
      narration,
      customer,
      salesLedgerId,
      payments = {},
      discountType = "fixed",
      discountValue = 0,
      redeemedPoints = 0,
      items = [],
    } = req.body;

    const normalizedPhone = normalizePhone(customer?.phone);
    if (!normalizedPhone) {
      return res.status(400).json({ message: "Customer phone number is required" });
    }
    if (!normalizeName(customer?.name)) {
      return res.status(400).json({ message: "Customer name is required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "At least one POS item is required" });
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

    const { salesLedger, cashLedger, bankLedger } = await resolveDefaultPosLedgers(companyId);
    const resolvedSalesLedger =
      (salesLedgerId && (await Ledgers.findOne({ _id: new ObjectId(salesLedgerId), companyId }))) ||
      salesLedger;

    if (!resolvedSalesLedger) {
      return res.status(400).json({ message: "Sales ledger is missing for this company" });
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
    const categoryMap = new Map(categories.map((row) => [String(row._id), row]));

    const inventoryLines = items
      .filter((row) => row?.itemId && itemMap.has(String(row.itemId)))
      .map((row) => {
        const item = itemMap.get(String(row.itemId));
        const qty = Number(row.qty || 0);
        const rate = Number(row.rate || 0);
        const mrpRate = Number(row.mrpRate || rate || 0);
        const rowDiscountType = row.discountType || "percent";
        const rowDiscountValue = Number(row.discountValue || 0);
        const grossAmount = normalizeMoney(qty * rate);
        const rowDiscountAmount =
          rowDiscountType === "percent"
            ? normalizeMoney(grossAmount * (rowDiscountValue / 100))
            : normalizeMoney(rowDiscountValue);
        const amount = normalizeMoney(grossAmount - rowDiscountAmount);
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
            row.groupName || groupMap.get(String(item.groupId || ""))?.name || "",
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

    const subtotal = normalizeMoney(
      inventoryLines.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    );
    const invoiceDiscount =
      discountType === "percent"
        ? normalizeMoney(subtotal * (Number(discountValue || 0) / 100))
        : normalizeMoney(discountValue || 0);
    const rewardRedeemed = normalizeMoney(redeemedPoints || 0);
    const totalAmount = normalizeMoney(subtotal - invoiceDiscount - rewardRedeemed);

    const cashAmount = normalizeMoney(payments.cash || 0);
    const cardAmount = normalizeMoney(payments.card || 0);
    const totalPaid = normalizeMoney(cashAmount + cardAmount);

    if (normalizeMoney(totalPaid) !== normalizeMoney(totalAmount)) {
      return res.status(400).json({ message: "Payment total must match total amount payable" });
    }

    const rewardEarned = normalizeMoney(
      inventoryLines.reduce((sum, row) => sum + Number(row.mrpRate || 0) * Number(row.qty || 0), 0),
    );

    const existingCustomer = await Customers.findOne({ companyId, phone: normalizedPhone });
    if (rewardRedeemed > Number(existingCustomer?.rewardPoints || 0)) {
      return res.status(400).json({ message: "Customer does not have enough reward points" });
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
        return res.status(400).json({ message: "Cash ledger is missing for POS cash payment" });
      }
      lines.push({ ledgerId: cashLedger._id, debit: cashAmount, credit: 0 });
    }
    if (cardAmount > 0) {
      if (!bankLedger) {
        return res.status(400).json({ message: "Bank ledger is missing for POS card payment" });
      }
      lines.push({ ledgerId: bankLedger._id, debit: cardAmount, credit: 0 });
    }
    lines.push({ ledgerId: resolvedSalesLedger._id, debit: 0, credit: totalAmount });

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
        changeAmount: normalizeMoney((payments.cashTendered || 0) - cashAmount),
      },
      createdAt: new Date(),
    };

    const result = await Vouchers.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc, customer: customerDoc });
  } catch (err) {
    console.error("Error creating POS voucher:", err);
    res.status(500).json({ message: err.message || "Error creating POS voucher" });
  }
});

app.get("/companies/:companyId/reports/customer-behaviour/overview", async (req, res) => {
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
      Customers.find({ companyId }).sort({ lastPurchaseAt: -1, name: 1 }).toArray(),
      Vouchers.find(voucherFilter).sort({ date: -1 }).toArray(),
    ]);

    const uniqueCustomerIds = new Set(
      vouchers.filter((voucher) => voucher.customerId).map((voucher) => String(voucher.customerId)),
    );
    const totalSales = normalizeMoney(
      vouchers.reduce((sum, voucher) => sum + Number(voucher.posMeta?.totalAmount || 0), 0),
    );
    const totalRewardsEarned = normalizeMoney(
      vouchers.reduce((sum, voucher) => sum + Number(voucher.posMeta?.rewardEarned || 0), 0),
    );
    const totalRewardsRedeemed = normalizeMoney(
      vouchers.reduce((sum, voucher) => sum + Number(voucher.posMeta?.rewardRedeemed || 0), 0),
    );

    const customerRows = customers.map((customer) => {
      const customerVouchers = vouchers.filter(
        (voucher) => String(voucher.customerId || "") === String(customer._id),
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
    res.status(500).json({ message: "Error loading customer behaviour overview" });
  }
});

app.get("/companies/:companyId/reports/customer-behaviour/product-wise", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const itemId = req.query.itemId && ObjectId.isValid(req.query.itemId)
      ? new ObjectId(req.query.itemId)
      : null;
    const vouchers = await Vouchers.find({
      companyId,
      voucherName: { $regex: "^POS Voucher$", $options: "i" },
    }).sort({ date: -1 }).toArray();

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
        current.totalQty = normalizeMoney(current.totalQty + Number(line.qty || 0));
        current.totalAmount = normalizeMoney(current.totalAmount + Number(line.amount || 0));
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
          uniqueCustomers: new Set(row.customers.map((entry) => entry.phone || String(entry.customerId || ""))).size,
          customers: row.customers.sort(
            (left, right) => new Date(right.purchaseDate) - new Date(left.purchaseDate),
          ),
        }))
        .sort((left, right) => left.itemName.localeCompare(right.itemName)),
    );
  } catch (err) {
    console.error("Error loading product-wise customer report:", err);
    res.status(500).json({ message: "Error loading product-wise customer report" });
  }
});

app.get("/companies/:companyId/reports/customer-behaviour/stock-group-wise", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const vouchers = await Vouchers.find({
      companyId,
      voucherName: { $regex: "^POS Voucher$", $options: "i" },
    }).sort({ date: -1 }).toArray();

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
        current.totalQty = normalizeMoney(current.totalQty + Number(line.qty || 0));
        current.totalAmount = normalizeMoney(current.totalAmount + Number(line.amount || 0));
        const customerKey = voucher.customerSnapshot?.phone || String(voucher.customerId || "");
        const customerExisting = current.customers.get(customerKey) || {
          customerName: voucher.customerSnapshot?.name || "",
          phone: voucher.customerSnapshot?.phone || "",
          totalQty: 0,
          totalAmount: 0,
          lastPurchaseAt: null,
        };
        customerExisting.totalQty = normalizeMoney(customerExisting.totalQty + Number(line.qty || 0));
        customerExisting.totalAmount = normalizeMoney(customerExisting.totalAmount + Number(line.amount || 0));
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
            (left, right) => new Date(right.lastPurchaseAt) - new Date(left.lastPurchaseAt),
          ),
        }))
        .sort((left, right) => left.groupName.localeCompare(right.groupName)),
    );
  } catch (err) {
    console.error("Error loading stock group-wise customer report:", err);
    res.status(500).json({ message: "Error loading stock group-wise customer report" });
  }
});

app.get("/companies/:companyId/reports/customer-behaviour/category-wise", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const vouchers = await Vouchers.find({
      companyId,
      voucherName: { $regex: "^POS Voucher$", $options: "i" },
    }).sort({ date: -1 }).toArray();

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
        current.totalQty = normalizeMoney(current.totalQty + Number(line.qty || 0));
        current.totalAmount = normalizeMoney(current.totalAmount + Number(line.amount || 0));
        current.uniqueCustomers.add(voucher.customerSnapshot?.phone || String(voucher.customerId || ""));
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
            (left, right) => new Date(right.purchaseDate) - new Date(left.purchaseDate),
          ),
        }))
        .sort((left, right) => left.categoryName.localeCompare(right.categoryName)),
    );
  } catch (err) {
    console.error("Error loading stock category-wise customer report:", err);
    res.status(500).json({ message: "Error loading stock category-wise customer report" });
  }
});

// List vouchers (basic)
// GET vouchers for a company + voucher type
app.get("/companies/:companyId/vouchers", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  const { type, from, to } = req.query;

  const filter = { companyId };

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

  const list = await Vouchers.find(filter)
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
    const voucher = await Vouchers.findOne({ _id: voucherId, companyId });
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
    if (voucherType.category !== "INVENTORY" && validLines.length < 2) {
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
        godownId:
          i.godownId && ObjectId.isValid(i.godownId)
            ? new ObjectId(i.godownId)
            : null,
        godownName: normalizeName(i.godownName),
        toGodownId:
          i.toGodownId && ObjectId.isValid(i.toGodownId)
            ? new ObjectId(i.toGodownId)
            : null,
        toGodownName: normalizeName(i.toGodownName),
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

    if (
      voucherType.category !== "INVENTORY" &&
      totalDr.toFixed(2) !== totalCr.toFixed(2)
    ) {
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
      lines: voucherType.category === "INVENTORY" ? [] : normalizedLines,
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
    const existingVoucher = await Vouchers.findOne({ _id: voucherId, companyId });
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
      posMeta,
      lines,
      inventoryLines,
    } = req.body;

    const update = { $set: {} };
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
    if (customerId && ObjectId.isValid(customerId)) update.$set.customerId = new ObjectId(customerId);
    if (customerSnapshot) {
      update.$set.customerSnapshot = {
        name: normalizeName(customerSnapshot.name || ""),
        phone: normalizePhone(customerSnapshot.phone || ""),
        address: normalizeName(customerSnapshot.address || ""),
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
        .map((line) => ({
          itemId: new ObjectId(line.itemId),
          itemName: normalizeName(
            line.itemName || line.productSnapshot?.name || "",
          ),
          qty: Number(line.qty) || 0,
          rate: Number(line.rate) || 0,
          amount:
            Number(line.amount) ||
            (Number(line.qty) || 0) * (Number(line.rate) || 0),
          billedQty: Number(line.billedQty) || Number(line.qty) || 0,
          discount: Number(line.discount) || 0,
          mrpRate: Number(line.mrpRate) || Number(line.rate) || 0,
          discountType: line.discountType || "fixed",
          discountValue: Number(line.discountValue) || 0,
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
        }));
    }

    await Vouchers.updateOne({ _id: voucherId, companyId }, update);
    const updated = await Vouchers.findOne({ _id: voucherId, companyId });
    if (
      nameKey(existingVoucher.voucherName || "") === "pos voucher" ||
      nameKey(updated?.voucherName || "") === "pos voucher"
    ) {
      await rebuildPosCustomerFromVouchers(companyId, existingVoucher.customerSnapshot?.phone);
      const nextPhone = updated?.customerSnapshot?.phone;
      if (normalizePhone(nextPhone) !== normalizePhone(existingVoucher.customerSnapshot?.phone)) {
        await rebuildPosCustomerFromVouchers(companyId, nextPhone);
      }
    }
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
      Vouchers.find({
        companyId,
        voucherTypeId: voucherTypeObjectId,
      }).project({ number: 1 }).toArray(),
    ]);

    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }
    if (!voucherType) {
      return res.status(404).json({ message: "Voucher type not found" });
    }

    const companySlug = slugifySegment(company.name || "company") || "company";
    const voucherSlug = slugifySegment(voucherType.name || "voucher") || "voucher";
    const prefix = `${companySlug}-${voucherSlug}-`;

    let maxSequence = 0;
    for (const voucher of vouchers) {
      const numberText = normalizeTextBlock(voucher.number);
      const match = numberText.match(new RegExp(`^${escapeRegex(prefix)}(\\d+)$`, "i"));
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
        toDate ? { companyId, date: { $lte: toDate } } : { companyId },
      ).toArray(),
    ]);

    if (!ledger) {
      return res.status(404).json({ message: "Ledger not found." });
    }

    const ledgerMap = new Map(ledgers.map((row) => [String(row._id), row.name]));
    const fixedOpening =
      (ledger.openingDrCr === "DR" ? 1 : -1) * (Number(ledger.openingBalance) || 0);

    let movementBeforeFrom = 0;
    let periodDebit = 0;
    let periodCredit = 0;
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

        (voucher.lines || []).forEach((line, lineIndex) => {
          if (String(line.ledgerId) !== String(ledgerId)) return;

          const debit = Number(line.debit || 0);
          const credit = Number(line.credit || 0);

          if (beforePeriod) {
            movementBeforeFrom = normalizeMoney(
              movementBeforeFrom + debit - credit,
            );
          }

          if (inPeriod) {
            periodDebit = normalizeMoney(periodDebit + debit);
            periodCredit = normalizeMoney(periodCredit + credit);

            const counterpart = (voucher.lines || [])
              .filter(
                (otherLine, otherIndex) =>
                  otherIndex !== lineIndex &&
                  String(otherLine.ledgerId) !== String(ledgerId),
              )
              .map((otherLine) => ledgerMap.get(String(otherLine.ledgerId)) || "Unknown")
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

    let runningBalance = normalizeMoney(fixedOpening + movementBeforeFrom);
    const entriesWithRunning = entries.map((entry) => {
      runningBalance = normalizeMoney(
        runningBalance + Number(entry.debit || 0) - Number(entry.credit || 0),
      );
      return {
        ...entry,
        runningBalance,
      };
    });

    const openingBalance = normalizeMoney(fixedOpening + movementBeforeFrom);

    res.json({
      ledger: {
        ledgerId: ledger._id,
        ledgerName: ledger.name,
        groupName: ledger.group?.name || "",
      },
      openingBalance,
      fixedOpeningBalance: normalizeMoney(fixedOpening),
      movementBeforeFrom,
      totals: {
        debit: periodDebit,
        credit: periodCredit,
      },
      closingBalance: normalizeMoney(openingBalance + periodDebit - periodCredit),
      entries: entriesWithRunning,
    });
  } catch (err) {
    console.error("Error loading ledger drilldown:", err);
    res.status(500).json({ message: "Error loading ledger drilldown" });
  }
});

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
      openingMap.set(String(m._id), (m.debit || 0) - (m.credit || 0)),
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

    const groups = await Groups.find({ companyId }).toArray();
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
      stockCategoryId,
      stockCategory,
      unitId,
      unitOfMeasure,
      godownId,
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
app.put("/companies/:companyId/items/:itemId", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const itemId = new ObjectId(req.params.itemId);

    const {
      name,
      alias,
      groupId,
      stockCategoryId,
      stockCategory,
      unitId,
      unitOfMeasure,
      godownId,
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
app.put("/companies/:companyId/update-prices-by-group", async (req, res) => {
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
  },
);

app.get("/companies/:companyId/reports/stock-summary", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);
    const summary = await buildStockSummary(companyId, fromDate, toDate);
    res.json(summary);
  } catch (err) {
    console.error("Error building stock summary:", err);
    res.status(500).json({ message: "Error building stock summary" });
  }
});

app.get("/companies/:companyId/reports/stock-group-summary", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);
    const summary = await buildStockGroupSummary(companyId, fromDate, toDate);
    res.json(summary);
  } catch (err) {
    console.error("Error building stock group summary:", err);
    res.status(500).json({ message: "Error building stock group summary" });
  }
});

app.get("/companies/:companyId/reports/stock-item-detailed", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);
    const summary = await buildInventoryDetailReport(companyId, fromDate, toDate);
    res.json(summary);
  } catch (err) {
    console.error("Error building detailed stock item report:", err);
    res.status(500).json({ message: "Error building detailed stock item report" });
  }
});

app.get("/companies/:companyId/reports/inventory-movement-analysis", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
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
    );

    res.json(report);
  } catch (err) {
    console.error("Error building inventory movement analysis:", err);
    res.status(500).json({ message: "Error building inventory movement analysis" });
  }
});

app.get("/companies/:companyId/reports/profit-loss", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [groups, vouchers, ledgers, stockSummary] = await Promise.all([
      Groups.find({ companyId }).toArray(),
      Vouchers.find({ companyId }).toArray(),
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
      if (
        group?.nature === "EXPENSE" &&
        !row.affectsGrossProfit &&
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
    const indirectExpense = expenses.reduce(
      (sum, row) => normalizeMoney(sum + row.amount),
      0,
    );
    const netProfit = normalizeMoney(
      grossProfit + indirectIncome - indirectExpense,
    );
    const profitMargin = netSales
      ? normalizeMoney((netProfit / netSales) * 100)
      : 0;

    res.json({
      incomes: incomes.sort((a, b) => a.ledgerName.localeCompare(b.ledgerName)),
      expenses: expenses.sort((a, b) =>
        a.ledgerName.localeCompare(b.ledgerName),
      ),
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
        netExpense: indirectExpense,
        netProfit,
        profitMargin,
      },
    });
  } catch (err) {
    console.error("Error building profit and loss:", err);
    res.status(500).json({ message: "Error building profit and loss" });
  }
});

app.get("/companies/:companyId/reports/balance-sheet", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    await ensureCompanyCoreMasters(companyId);
    const fromDate = safeDate(req.query.from);
    const toDate = safeDate(req.query.to);

    const [groups, vouchers, ledgers, stockSummary] = await Promise.all([
      Groups.find({ companyId }).toArray(),
      Vouchers.find(
        toDate ? { companyId, date: { $lte: toDate } } : { companyId },
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

    const balances = summarizeLedgerBalances(ledgers, vouchers, fromDate, toDate);
    const groupMap = new Map(groups.map((group) => [String(group._id), group]));

    const assets = new Map();
    const liabilities = new Map();

    balances.forEach((ledger) => {
      const group = groupMap.get(String(ledger.groupId)) || ledger.group;
      if (!group) return;

      if (group.nature === "ASSET") {
        const key = group.name;
        const current = assets.get(key) || {
          groupName: key,
          openingAmount: 0,
          amount: 0,
          ledgers: [],
        };
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
        assets.set(key, current);
      }

      if (group.nature === "LIABILITY") {
        const key = group.name;
        const current = liabilities.get(key) || {
          groupName: key,
          openingAmount: 0,
          amount: 0,
          ledgers: [],
        };
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
        liabilities.set(key, current);
      }
    });

    if (stockSummary?.totals?.openingValue || stockSummary?.totals?.closingValue) {
      const current = assets.get("Closing Stock") || {
        groupName: "Closing Stock",
        openingAmount: 0,
        amount: 0,
        ledgers: [],
      };
      current.openingAmount = normalizeMoney(
        current.openingAmount + Number(stockSummary.totals.openingValue || 0),
      );
      current.amount = normalizeMoney(
        current.amount + Number(stockSummary.totals.closingValue || 0),
      );
      assets.set("Closing Stock", current);
    }

    const assetRows = [...assets.values()].sort((a, b) =>
      a.groupName.localeCompare(b.groupName),
    );
    const liabilityRows = [...liabilities.values()].sort((a, b) =>
      a.groupName.localeCompare(b.groupName),
    );

    res.json({
      assets: assetRows,
      liabilities: liabilityRows,
      totals: {
        openingAssets: assetRows.reduce(
          (sum, row) => normalizeMoney(sum + Number(row.openingAmount || 0)),
          0,
        ),
        openingLiabilities: liabilityRows.reduce(
          (sum, row) => normalizeMoney(sum + Number(row.openingAmount || 0)),
          0,
        ),
        assets: assetRows.reduce(
          (sum, row) => normalizeMoney(sum + Number(row.amount || 0)),
          0,
        ),
        liabilities: liabilityRows.reduce(
          (sum, row) => normalizeMoney(sum + Number(row.amount || 0)),
          0,
        ),
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
    await ensureCompanyCoreMasters(companyId);

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
      Vouchers.countDocuments({ companyId }),
      buildStockSummary(companyId),
      Vouchers.find({ companyId }).toArray(),
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

    const cashBank = balances
      .filter((row) =>
        ["cash-in-hand", "bank accounts"].includes(
          nameKey(row.group?.name || ""),
        ),
      )
      .reduce((sum, row) => normalizeMoney(sum + row.closing), 0);

    const receivables = balances
      .filter((row) => nameKey(row.group?.name || "") === "sundry debtors")
      .reduce((sum, row) => normalizeMoney(sum + row.closingDebit), 0);

    const payables = balances
      .filter((row) => nameKey(row.group?.name || "") === "sundry creditors")
      .reduce((sum, row) => normalizeMoney(sum + row.closingCredit), 0);

    const salesTotal = balances
      .filter((row) => nameKey(row.group?.name || "") === "sales accounts")
      .reduce((sum, row) => normalizeMoney(sum + row.credit - row.debit), 0);

    const purchaseTotal = balances
      .filter((row) => nameKey(row.group?.name || "") === "purchase accounts")
      .reduce((sum, row) => normalizeMoney(sum + row.debit - row.credit), 0);

    const directIncome = balances
      .filter(
        (row) =>
          row.group?.nature === "INCOME" &&
          Boolean(row.group?.affectsGrossProfit),
      )
      .reduce((sum, row) => normalizeMoney(sum + row.credit - row.debit), 0);

    const directExpense = balances
      .filter(
        (row) =>
          row.group?.nature === "EXPENSE" &&
          Boolean(row.group?.affectsGrossProfit),
      )
      .reduce((sum, row) => normalizeMoney(sum + row.debit - row.credit), 0);

    const indirectIncome = balances
      .filter(
        (row) =>
          row.group?.nature === "INCOME" &&
          !Boolean(row.group?.affectsGrossProfit),
      )
      .reduce((sum, row) => normalizeMoney(sum + row.credit - row.debit), 0);

    const indirectExpense = balances
      .filter(
        (row) =>
          row.group?.nature === "EXPENSE" &&
          !Boolean(row.group?.affectsGrossProfit),
      )
      .reduce((sum, row) => normalizeMoney(sum + row.debit - row.credit), 0);

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

    const currentAssets = balances
      .filter((row) => nameKey(row.group?.parentId ? "" : row.group?.name || "") === "current assets")
      .reduce((sum, row) => normalizeMoney(sum + row.closingDebit), 0);

    const currentLiabilities = balances
      .filter((row) => nameKey(row.group?.parentId ? "" : row.group?.name || "") === "current liabilities")
      .reduce((sum, row) => normalizeMoney(sum + row.closingCredit), 0);

    const cashInHandTotal = balances
      .filter((row) => nameKey(row.group?.name || "") === "cash-in-hand")
      .reduce((sum, row) => normalizeMoney(sum + row.closingDebit), 0);

    const bankBalanceTotal = balances
      .filter((row) => nameKey(row.group?.name || "") === "bank accounts")
      .reduce((sum, row) => normalizeMoney(sum + row.closingDebit), 0);

    const bankLedgers = balances
      .filter((row) => nameKey(row.group?.name || "") === "bank accounts")
      .map((row) => ({
        ledgerId: row._id,
        ledgerName: row.name,
        closingBalance: normalizeMoney(row.closingDebit || row.closing),
      }))
      .sort((left, right) => right.closingBalance - left.closingBalance)
      .slice(0, 5);

    const averageInventory = normalizeMoney(
      ((Number(stockSummary.totals.openingValue || 0) + Number(stockSummary.totals.closingValue || 0)) / 2) || 0,
    );
    const inventoryTurnover = averageInventory
      ? normalizeMoney(Number(stockSummary.totals.outwardValue || 0) / averageInventory)
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

app.get("/companies/:companyId/reports/outstanding", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const type = String(req.query.type || "receivable").toLowerCase();
    const toDate = safeDate(req.query.to);

    const [vouchers, ledgers] = await Promise.all([
      Vouchers.find(
        toDate ? { companyId, date: { $lte: toDate } } : { companyId },
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
      Vouchers.find({ companyId }).toArray(),
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
      { $set: { code, name } },
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
      ledgers.find((ledger) => nameKey(ledger.group?.name || "") === "bank accounts") || null,
  };
}

async function upsertPosCustomer(companyId, customerInput, purchaseSummary) {
  const phone = normalizePhone(customerInput?.phone);
  if (!phone) throw new Error("Customer phone number is required");

  const normalizedName = normalizeName(customerInput?.name || "Walk-in Customer");
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

  const vouchers = await Vouchers.find({
    companyId,
    voucherName: { $regex: "^POS Voucher$", $options: "i" },
    "customerSnapshot.phone": phone,
  })
    .sort({ date: 1, createdAt: 1 })
    .toArray();

  if (vouchers.length === 0) {
    await Customers.deleteOne({ companyId, phone });
    return null;
  }

  const firstVoucher = vouchers[0];
  const latestVoucher = vouchers[vouchers.length - 1];
  const totalSpent = normalizeMoney(
    vouchers.reduce((sum, voucher) => sum + Number(voucher.posMeta?.totalAmount || 0), 0),
  );
  const lifetimeRewardEarned = normalizeMoney(
    vouchers.reduce((sum, voucher) => sum + Number(voucher.posMeta?.rewardEarned || 0), 0),
  );
  const lifetimeRewardRedeemed = normalizeMoney(
    vouchers.reduce((sum, voucher) => sum + Number(voucher.posMeta?.rewardRedeemed || 0), 0),
  );
  const rewardPoints = normalizeMoney(lifetimeRewardEarned - lifetimeRewardRedeemed);

  const doc = {
    companyId,
    name: normalizeName(latestVoucher.customerSnapshot?.name || "Walk-in Customer"),
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
      { $set: doc, $setOnInsert: { createdAt: existing.createdAt || new Date() } },
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

app.get("/companies/:companyId/units", async (req, res) => {
  const companyId = new ObjectId(req.params.companyId);
  res.json(await listNamedMasters(Units, companyId, { createdAt: 1 }));
});

app.post("/companies/:companyId/units", async (req, res) => {
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

app.put("/companies/:companyId/units/:id", async (req, res) => {
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

app.delete("/companies/:companyId/units/:id", async (req, res) => {
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

app.post("/companies/:companyId/godowns", async (req, res) => {
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

app.put("/companies/:companyId/godowns/:id", async (req, res) => {
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

app.delete("/companies/:companyId/godowns/:id", async (req, res) => {
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

app.post("/companies/:companyId/stock-categories", async (req, res) => {
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

app.put("/companies/:companyId/stock-categories/:id", async (req, res) => {
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

app.delete("/companies/:companyId/stock-categories/:id", async (req, res) => {
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
  const rows = await Currencies.find({ companyId }).sort({ isBase: -1, code: 1 }).toArray();
  res.json(rows);
});

app.post("/companies/:companyId/currencies", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const code = normalizeName(req.body.code);
    const symbol = normalizeName(req.body.symbol);
    const name = normalizeName(req.body.name);
    const decimalPlaces = Number(req.body.decimalPlaces || 2);
    if (!code || !name) {
      return res.status(400).json({ message: "Currency code and name are required" });
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

app.put("/companies/:companyId/currencies/:id", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const id = new ObjectId(req.params.id);
    const existing = await Currencies.findOne({ _id: id, companyId });
    if (!existing) return res.status(404).json({ message: "Currency not found" });
    if (existing.isSystem) {
      return res.status(400).json({ message: "Base currency cannot be altered here" });
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

app.delete("/companies/:companyId/currencies/:id", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const id = new ObjectId(req.params.id);
    const existing = await Currencies.findOne({ _id: id, companyId });
    if (!existing) return res.status(404).json({ message: "Currency not found" });
    if (existing.isBase || existing.isSystem) {
      return res.status(400).json({ message: "Base currency cannot be deleted" });
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
    res.json(rows);
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
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: "Unable to load employee" });
  }
});

app.post("/companies/:companyId/employees", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const generatedNumber = await generateEmployeeNumber(companyId);
    const doc = normalizeEmployeePayload(req.body, {
      employeeNumber: generatedNumber,
    });

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
        message: "Employee with the same name or employee number already exists",
      });
    }

    const finalDoc = {
      companyId,
      ...doc,
      createdAt: new Date(),
    };

    const result = await Employees.insertOne(finalDoc);
    res.status(201).json({ _id: result.insertedId, ...finalDoc });
  } catch (err) {
    res.status(500).json({ message: err.message || "Unable to create employee" });
  }
});

app.put("/companies/:companyId/employees/:id", async (req, res) => {
  try {
    const companyId = new ObjectId(req.params.companyId);
    const id = new ObjectId(req.params.id);
    const existing = await Employees.findOne({ _id: id, companyId });
    if (!existing) return res.status(404).json({ message: "Employee not found" });

    const doc = normalizeEmployeePayload(req.body, {
      employeeNumber: existing.employeeNumber,
    });

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
        message: "Employee with the same name or employee number already exists",
      });
    }

    await Employees.updateOne(
      { _id: id, companyId },
      { $set: doc },
    );

    res.json(await Employees.findOne({ _id: id, companyId }));
  } catch (err) {
    res.status(500).json({ message: err.message || "Unable to update employee" });
  }
});

app.delete("/companies/:companyId/employees/:id", async (req, res) => {
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
