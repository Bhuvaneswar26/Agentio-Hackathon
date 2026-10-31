import Papa from "papaparse";
import readXlsxFile from "read-excel-file";
import type {
  DetectionPayload,
  InvoiceLine,
  PolicyRule,
  SourceFormat,
} from "../types";
import { uid } from "./format";

export type IntakeIssue = {
  row?: string;
  field: string;
  message: string;
  blocking: boolean;
};

export function validateIntakePayload(
  payload: DetectionPayload,
): IntakeIssue[] {
  const issues: IntakeIssue[] = [];
  const amount = payload.claim.requestedAmount;
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    issues.push({
      field: "requestedAmount",
      message: "Claim amount must be a positive number.",
      blocking: true,
    });
  }
  const claimDate = payload.claim.incidentDate;
  if (claimDate && Number.isNaN(Date.parse(claimDate))) {
    issues.push({
      field: "incidentDate",
      message: `Invalid incident date: ${claimDate}`,
      blocking: true,
    });
  }
  if (!payload.invoiceLines.length) {
    issues.push({
      field: "invoiceLines",
      message:
        "No invoice lines were extracted. The pack can still be parked as incomplete.",
      blocking: false,
    });
  }
  for (const [index, line] of payload.invoiceLines.entries()) {
    const row = line.id || `Row ${index + 1}`;
    if (!line.description || /^line\s+\d+$/i.test(line.description)) {
      issues.push({
        row,
        field: "description",
        message: "Add a service/item description.",
        blocking: true,
      });
    }
    if (!Number.isFinite(line.amount) || line.amount <= 0) {
      issues.push({
        row,
        field: "amount",
        message: "Amount is missing, invalid, or not greater than zero.",
        blocking: true,
      });
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      issues.push({
        row,
        field: "quantity",
        message: "Quantity must be a positive number.",
        blocking: true,
      });
    }
    if (line.date && Number.isNaN(Date.parse(line.date))) {
      issues.push({
        row,
        field: "date",
        message: `Invalid service date: ${line.date}`,
        blocking: true,
      });
    }
    if (
      line.amount > 0 &&
      line.quantity > 0 &&
      line.unitPrice > 0 &&
      Math.abs(line.amount - line.quantity * line.unitPrice) > 0.01
    ) {
      issues.push({
        row,
        field: "arithmetic",
        message:
          "Amount does not equal quantity × unit price; verify before analysis.",
        blocking: false,
      });
    }
  }
  return issues;
}

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function pick(row: Record<string, unknown>, keys: string[]) {
  const entries = Object.entries(row);
  for (const key of keys) {
    const found = entries.find(
      ([k]) =>
        k.toLowerCase().replace(/[\s_]/g, "") ===
        key.toLowerCase().replace(/[\s_]/g, ""),
    );
    if (found) return found[1];
  }
  return undefined;
}

function rulesFrom(input: unknown): PolicyRule[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((r, i) => {
    const o = r as Record<string, unknown>;
    const type = str(o.type);
    if (
      !type ||
      ![
        "limit",
        "exclusion",
        "deductible",
        "copay",
        "sublimit",
        "coverage",
      ].includes(type)
    )
      return [];
    return [
      {
        id: str(o.id) ?? `PR-${i + 1}`,
        name: str(o.name) ?? type,
        clause: str(o.clause) ?? "",
        type: type as PolicyRule["type"],
        value: num(o.value),
        unit: str(o.unit),
      },
    ];
  });
}

function linesFromRows(rows: Record<string, unknown>[]): InvoiceLine[] {
  return rows.map((row, i) => {
    const amount =
      num(
        pick(row, [
          "amount",
          "lineamount",
          "charged",
          "total",
          "requestedamount",
        ]),
      ) ?? 0;
    return {
      id: `LINE-${i + 1}`,
      description:
        str(pick(row, ["description", "service", "item", "particulars"])) ??
        `Line ${i + 1}`,
      code: str(pick(row, ["code", "servicecode", "cpt", "hsn"])) ?? "",
      quantity: num(pick(row, ["qty", "quantity"])) ?? 1,
      unitPrice: num(pick(row, ["unitprice", "rate", "unit"])) ?? amount,
      amount,
      provider:
        str(pick(row, ["provider", "hospital", "garage", "vendor"])) ?? "",
      invoiceRef:
        str(pick(row, ["invoice", "invoiceref", "invoicenumber"])) ?? "",
      date: str(pick(row, ["date", "servicedate", "incidentdate"])) ?? "",
    };
  });
}

export function emptyPayload(
  format: SourceFormat,
  engine: string,
  extra?: Partial<DetectionPayload>,
): DetectionPayload {
  return {
    schemaVersion: "1.0",
    ingestedAt: new Date().toISOString(),
    source: {
      format,
      engine,
      ocrUsed: false,
      confidence: 0,
      warnings: [],
      ...extra?.source,
    },
    claim: extra?.claim ?? {},
    invoiceLines: extra?.invoiceLines ?? [],
    policy: extra?.policy ?? { rules: [] },
    history: extra?.history ?? [],
    documents: extra?.documents ?? [],
    extraction: extra?.extraction ?? { missingFields: [], valid: false },
  };
}

export function payloadFromObject(
  input: unknown,
  format: SourceFormat,
  name?: string,
): DetectionPayload {
  const obj = Array.isArray(input)
    ? { claims: input }
    : (input as Record<string, unknown>);
  const claimSrc = (obj.claim as Record<string, unknown> | undefined) ?? obj;
  const rows =
    (obj.invoiceLines as Record<string, unknown>[] | undefined) ??
    (obj.lines as Record<string, unknown>[] | undefined) ??
    (obj.items as Record<string, unknown>[] | undefined) ??
    (Array.isArray(input) ? (input as Record<string, unknown>[]) : []);

  const claim = {
    claimId: str(pick(claimSrc, ["claimid", "id", "claim_id"])),
    policyNumber: str(pick(claimSrc, ["policynumber", "policy", "policy_no"])),
    claimant: str(pick(claimSrc, ["claimant", "insured", "patient", "name"])),
    incidentDate: str(
      pick(claimSrc, ["incidentdate", "dateofloss", "admissiondate"]),
    ),
    filedDate: str(pick(claimSrc, ["fileddate", "intimationdate"])),
    domain: str(pick(claimSrc, ["domain", "lob", "lineofbusiness"])),
    claimType: str(pick(claimSrc, ["claimtype", "type"])),
    requestedAmount: num(
      pick(claimSrc, ["requestedamount", "claimamount", "amount", "billed"]),
    ),
    proposedSettlement: num(
      pick(claimSrc, ["proposedsettlement", "settlement", "payable"]),
    ),
    provider: str(pick(claimSrc, ["provider", "hospital", "garage"])),
    city: str(pick(claimSrc, ["city", "location"])),
  };
  const policySrc =
    obj.policy && typeof obj.policy === "object" && !Array.isArray(obj.policy)
      ? (obj.policy as Record<string, unknown>)
      : {};
  const history = Array.isArray(obj.history)
    ? obj.history.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        const claimId = str(pick(row, ["claimid", "id"]));
        if (!claimId) return [];
        return [
          {
            claimId,
            incidentDate: str(pick(row, ["incidentdate", "dateofloss"])) ?? "",
            amount:
              num(pick(row, ["amount", "requestedamount", "paidamount"])) ?? 0,
            status: str(pick(row, ["status", "settlementstatus"])) ?? "unknown",
            claimant: str(pick(row, ["claimant", "insured", "patient"])),
            provider: str(pick(row, ["provider", "hospital", "garage"])),
            invoiceLines: Array.isArray(row.invoiceLines)
              ? linesFromRows(row.invoiceLines as Record<string, unknown>[])
              : undefined,
          },
        ];
      })
    : [];

  const invoiceLines = linesFromRows(rows);
  const missing: string[] = [];
  if (!claim.claimId && !claim.policyNumber)
    missing.push("claimId or policyNumber");
  if (!claim.requestedAmount && invoiceLines.every((l) => !l.amount))
    missing.push("requestedAmount");
  if (!invoiceLines.length) missing.push("invoice line items");

  return emptyPayload(format, "structured-parser", {
    source: {
      format,
      filename: name,
      engine: "structured-parser",
      ocrUsed: false,
      confidence: missing.length ? 0.62 : 0.95,
      warnings: missing.length ? ["Some mandatory fields were not found"] : [],
    },
    claim,
    invoiceLines,
    policy: {
      policyNumber:
        str(pick(policySrc, ["policynumber", "policy", "policy_no"])) ??
        claim.policyNumber,
      deductible:
        num(pick(policySrc, ["deductible"])) ??
        num(pick(claimSrc, ["deductible"])),
      copayPercent:
        num(pick(policySrc, ["copay", "copaypercent"])) ??
        num(pick(claimSrc, ["copay", "copaypercent"])),
      coverage:
        str(pick(policySrc, ["coverage"])) ?? str(pick(claimSrc, ["coverage"])),
      validFrom:
        str(pick(policySrc, ["validfrom", "policystart"])) ??
        str(pick(claimSrc, ["validfrom", "policystart"])),
      validUntil:
        str(pick(policySrc, ["validuntil", "policyend", "expiry"])) ??
        str(pick(claimSrc, ["validuntil", "policyend", "expiry"])),
      sumInsured:
        num(pick(policySrc, ["suminsured"])) ??
        num(pick(claimSrc, ["suminsured"])),
      rules: rulesFrom((obj.policyRules as unknown) ?? policySrc.rules),
    },
    history,
    documents: name
      ? [{ name, type: format, excerpt: JSON.stringify(claim) }]
      : [],
    extraction: {
      missingFields: missing,
      valid: missing.length === 0,
      rawText: undefined,
    },
  });
}

export function payloadFromCsv(
  text: string,
  name?: string,
  format: SourceFormat = "csv",
): DetectionPayload {
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    const first = parsed.errors[0];
    const row = typeof first.row === "number" ? ` at row ${first.row + 2}` : "";
    throw new Error(
      `CSV parsing found ${parsed.errors.length} issue(s)${row}: ${first.message}. Fix the source file and try again.`,
    );
  }
  if (!parsed.meta.fields?.length) {
    throw new Error(
      "CSV has no header row. Add column names before uploading.",
    );
  }
  if (!parsed.data.length) {
    throw new Error("CSV contains a header but no data rows.");
  }
  return payloadFromObject(
    { claims: parsed.data, ...parsed.data[0], invoiceLines: parsed.data },
    format,
    name,
  );
}

type WorkbookSheet = { sheet: string; data: unknown[][] };

function rowsAsObjects(data: unknown[][]): Record<string, unknown>[] {
  const headers = (data[0] ?? []).map((value) => String(value ?? "").trim());
  return data
    .slice(1)
    .filter((row) =>
      row.some(
        (value) => value !== null && value !== undefined && value !== "",
      ),
    )
    .map((row) =>
      Object.fromEntries(
        headers.flatMap((header, index) =>
          header ? [[header, row[index]]] : [],
        ),
      ),
    );
}

export function payloadFromWorkbookSheets(
  sheets: WorkbookSheet[],
  name?: string,
): DetectionPayload {
  const normalizedNames = sheets.map(({ sheet, data }) => ({
    sheetName: sheet,
    key: sheet.toLowerCase().replace(/[^a-z]/g, ""),
    rows: rowsAsObjects(data),
  }));
  if (!normalizedNames.length)
    throw new Error("Workbook has no readable worksheets.");
  if (normalizedNames.length > 1) {
    const claimSheet = normalizedNames.find(({ key }) =>
      ["claim", "claims", "claimdata"].includes(key),
    );
    const lineSheet = normalizedNames.find(({ key }) =>
      ["invoiceline", "invoicelines", "items", "claimlines"].includes(key),
    );
    const policySheet = normalizedNames.find(({ key }) =>
      ["policy", "policies", "policydetails"].includes(key),
    );
    const ruleSheet = normalizedNames.find(({ key }) =>
      ["policyrule", "policyrules", "rules"].includes(key),
    );
    const historySheet = normalizedNames.find(({ key }) =>
      ["history", "claimhistory", "settlements"].includes(key),
    );
    const recognized = [
      claimSheet,
      lineSheet,
      policySheet,
      ruleSheet,
      historySheet,
    ].filter(Boolean);
    if (!recognized.length) {
      throw new Error(
        "Workbook has multiple sheets but no recognized names. Use Claim, InvoiceLines, Policy, PolicyRules, or History sheet names.",
      );
    }
    if (claimSheet && claimSheet.rows.length > 1) {
      throw new Error(
        "This intake accepts one claim per workbook. Split the Claims sheet into one claim per file; use History for prior claims.",
      );
    }
    const fallback = normalizedNames[0];
    const payload = payloadFromObject(
      {
        claim: claimSheet?.rows[0] ?? {},
        policy: {
          ...(policySheet?.rows[0] ?? {}),
          rules: ruleSheet?.rows ?? [],
        },
        invoiceLines: lineSheet?.rows ?? (claimSheet ? [] : fallback.rows),
        history: historySheet?.rows ?? [],
      },
      "xlsx",
      name,
    );
    const usedFallback = !lineSheet && !claimSheet;
    const ignored = normalizedNames
      .filter(
        (sheet) =>
          !recognized.includes(sheet) && !(usedFallback && sheet === fallback),
      )
      .map((sheet) => sheet.sheetName);
    if (ignored.length)
      payload.source.warnings.push(
        `Unrecognized worksheet(s) were not used: ${ignored.join(", ")}.`,
      );
    return payload;
  }
  const rows = normalizedNames[0].rows;
  if (!rows.length)
    throw new Error(
      `Worksheet "${normalizedNames[0].sheetName}" contains no data rows.`,
    );
  return payloadFromObject({ ...rows[0], invoiceLines: rows }, "xlsx", name);
}

export async function payloadFromWorkbook(
  buffer: ArrayBuffer,
  name?: string,
): Promise<DetectionPayload> {
  return payloadFromWorkbookSheets(await readXlsxFile(buffer), name);
}

export function payloadFromText(
  text: string,
  format: SourceFormat,
  engine: string,
  name?: string,
  ocrUsed = false,
): DetectionPayload {
  const claimId = text
    .match(/CLM[- ]?\d{3,}/i)?.[0]
    ?.toUpperCase()
    .replace(" ", "-");
  const policy = text.match(/(?:policy|pol)[:\s#]*([A-Z]{2}[- ]?\d{3,})/i)?.[1];
  const amountMatch =
    text.match(
      /(?:amount|total|claimed|billed)[:\s]*₹?\s*([\d,]+(?:\.\d+)?)/i,
    ) ?? text.match(/₹\s*([\d,]+(?:\.\d+)?)/);
  const claimant = text
    .match(/(?:claimant|patient|insured)[:\s]+([A-Za-z .]+)/i)?.[1]
    ?.trim();
  const provider = text
    .match(/(?:hospital|provider|garage)[:\s]+([A-Za-z0-9 .&]+)/i)?.[1]
    ?.trim();
  const date =
    text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
    text.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/)?.[0];
  const requestedAmount = num(amountMatch?.[1]);

  const lineRegex = /(.+?)\s+₹?\s*([\d,]+(?:\.\d+)?)/g;
  const invoiceLines: InvoiceLine[] = [];
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(text)) && invoiceLines.length < 20) {
    const desc = m[1].trim();
    if (desc.length < 3 || desc.length > 80) continue;
    if (/total|amount|policy|claim/i.test(desc) && desc.length < 12) continue;
    invoiceLines.push({
      id: uid("LINE"),
      description: desc.slice(-60),
      code: "",
      quantity: 1,
      unitPrice: num(m[2]) ?? 0,
      amount: num(m[2]) ?? 0,
      provider: provider ?? "",
      invoiceRef: text.match(/INV[- ]?\w+/i)?.[0] ?? "",
      date: date ?? "",
    });
  }

  const missing: string[] = [];
  if (!claimId && !policy) missing.push("claimId or policyNumber");
  if (!requestedAmount) missing.push("requestedAmount");
  if (!invoiceLines.length) missing.push("invoice line items");

  return emptyPayload(format, engine, {
    source: {
      format,
      filename: name,
      engine,
      ocrUsed,
      confidence: ocrUsed
        ? missing.length
          ? 0.45
          : 0.72
        : missing.length
          ? 0.55
          : 0.8,
      warnings: missing.length
        ? [
            "Unstructured extraction — please review before sending to the detection agent",
          ]
        : [],
    },
    claim: {
      claimId,
      policyNumber: policy,
      claimant,
      incidentDate: date,
      requestedAmount,
      provider,
    },
    invoiceLines,
    policy: { policyNumber: policy, rules: [] },
    documents: [
      {
        name: name ?? "extracted-text",
        type: format,
        excerpt: text.slice(0, 1200),
      },
    ],
    extraction: {
      rawText: text.slice(0, 8000),
      missingFields: missing,
      valid: missing.length === 0,
    },
  });
}

export function detectFormat(file: File): SourceFormat {
  const name = file.name.toLowerCase();
  const type = file.type;
  if (name.endsWith(".json") || type.includes("json")) return "json";
  if (name.endsWith(".csv") || type.includes("csv")) return "csv";
  if (name.endsWith(".xlsx") || type.includes("spreadsheetml")) return "xlsx";
  if (name.endsWith(".pdf") || type.includes("pdf")) return "pdf";
  if (
    type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)
  )
    return "image";
  if (name.endsWith(".txt")) return "text";
  return "text";
}

export function sampleJsonPayload(): DetectionPayload {
  return payloadFromObject(
    {
      claimId: "CLM-DEMO-01",
      policyNumber: "HL-77821",
      claimant: "Ananya Iyer",
      incidentDate: "2026-09-12",
      domain: "Health",
      claimType: "Hospitalisation",
      requestedAmount: 28000,
      proposedSettlement: 28000,
      provider: "Aarogyam Super Speciality",
      city: "Bengaluru",
      deductible: 10000,
      copay: 20,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
      policyRules: [
        {
          id: "PR-ROOM",
          name: "Room rent sub-limit",
          clause: "Room rent payable up to ₹5,000 per day.",
          type: "sublimit",
          value: 5000,
          unit: "per day",
        },
        {
          id: "PR-EXC",
          name: "Consumables exclusion",
          clause: "Non-medical consumables are excluded.",
          type: "exclusion",
        },
      ],
      invoiceLines: [
        {
          description: "Room rent 3 days",
          code: "ROOM-DLX",
          quantity: 3,
          unitPrice: 7000,
          amount: 21000,
          invoice: "INV-44109",
        },
        {
          description: "CBC diagnostic test",
          code: "LAB-CBC",
          amount: 2000,
          invoice: "INV-44109",
        },
        {
          description: "CBC diagnostic test",
          code: "LAB-CBC",
          amount: 2000,
          invoice: "INV-44109",
        },
        {
          description: "Surgical gloves",
          code: "CONS-01",
          amount: 3000,
          invoice: "INV-44109",
        },
      ],
    },
    "json",
    "sample-health-claim.json",
  );
}
