import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import type { DetectionPayload, InvoiceLine, PolicyRule, SourceFormat } from '../types'
import { uid } from './format'

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(String(v).replace(/[₹,\s]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s ? s : undefined
}

function pick(row: Record<string, unknown>, keys: string[]) {
  const entries = Object.entries(row)
  for (const key of keys) {
    const found = entries.find(([k]) => k.toLowerCase().replace(/[\s_]/g, '') === key.toLowerCase().replace(/[\s_]/g, ''))
    if (found) return found[1]
  }
  return undefined
}

function rulesFrom(input: unknown): PolicyRule[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((r, i) => {
    const o = r as Record<string, unknown>
    const type = str(o.type)
    if (!type || !['limit', 'exclusion', 'deductible', 'copay', 'sublimit', 'coverage'].includes(type)) return []
    return [{ id: str(o.id) ?? `PR-${i + 1}`, name: str(o.name) ?? type, clause: str(o.clause) ?? '', type: type as PolicyRule['type'], value: num(o.value), unit: str(o.unit) }]
  })
}

function linesFromRows(rows: Record<string, unknown>[]): InvoiceLine[] {
  return rows.slice(0, 80).map((row, i) => {
    const amount = num(pick(row, ['amount', 'lineamount', 'charged', 'total', 'requestedamount'])) ?? 0
    return {
      id: `LINE-${i + 1}`,
      description: str(pick(row, ['description', 'service', 'item', 'particulars'])) ?? `Line ${i + 1}`,
      code: str(pick(row, ['code', 'servicecode', 'cpt', 'hsn'])) ?? '',
      quantity: num(pick(row, ['qty', 'quantity'])) ?? 1,
      unitPrice: num(pick(row, ['unitprice', 'rate', 'unit'])) ?? amount,
      amount,
      provider: str(pick(row, ['provider', 'hospital', 'garage', 'vendor'])) ?? '',
      invoiceRef: str(pick(row, ['invoice', 'invoiceref', 'invoicenumber'])) ?? '',
      date: str(pick(row, ['date', 'servicedate', 'incidentdate'])) ?? '',
    }
  })
}

export function emptyPayload(format: SourceFormat, engine: string, extra?: Partial<DetectionPayload>): DetectionPayload {
  return {
    schemaVersion: '1.0',
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
  }
}

export function payloadFromObject(input: unknown, format: SourceFormat, name?: string): DetectionPayload {
  const obj = Array.isArray(input) ? { claims: input } : (input as Record<string, unknown>)
  const claimSrc = (obj.claim as Record<string, unknown> | undefined) ?? obj
  const rows = (obj.invoiceLines as Record<string, unknown>[] | undefined)
    ?? (obj.lines as Record<string, unknown>[] | undefined)
    ?? (obj.items as Record<string, unknown>[] | undefined)
    ?? (Array.isArray(input) ? (input as Record<string, unknown>[]) : [])

  const claim = {
    claimId: str(pick(claimSrc, ['claimid', 'id', 'claim_id'])),
    policyNumber: str(pick(claimSrc, ['policynumber', 'policy', 'policy_no'])),
    claimant: str(pick(claimSrc, ['claimant', 'insured', 'patient', 'name'])),
    incidentDate: str(pick(claimSrc, ['incidentdate', 'dateofloss', 'admissiondate'])),
    filedDate: str(pick(claimSrc, ['fileddate', 'intimationdate'])),
    domain: str(pick(claimSrc, ['domain', 'lob', 'lineofbusiness'])),
    claimType: str(pick(claimSrc, ['claimtype', 'type'])),
    requestedAmount: num(pick(claimSrc, ['requestedamount', 'claimamount', 'amount', 'billed'])),
    proposedSettlement: num(pick(claimSrc, ['proposedsettlement', 'settlement', 'payable'])),
    provider: str(pick(claimSrc, ['provider', 'hospital', 'garage'])),
    city: str(pick(claimSrc, ['city', 'location'])),
  }

  const invoiceLines = linesFromRows(rows)
  const missing: string[] = []
  if (!claim.claimId && !claim.policyNumber) missing.push('claimId or policyNumber')
  if (!claim.requestedAmount && invoiceLines.every((l) => !l.amount)) missing.push('requestedAmount')
  if (!invoiceLines.length) missing.push('invoice line items')

  return emptyPayload(format, 'structured-parser', {
    source: {
      format,
      filename: name,
      engine: 'structured-parser',
      ocrUsed: false,
      confidence: missing.length ? 0.62 : 0.95,
      warnings: missing.length ? ['Some mandatory fields were not found'] : [],
    },
    claim,
    invoiceLines,
    policy: {
      policyNumber: claim.policyNumber,
      deductible: num(pick(claimSrc, ['deductible'])),
      copayPercent: num(pick(claimSrc, ['copay', 'copaypercent'])),
      coverage: str(pick(claimSrc, ['coverage'])),
      validFrom: str(pick(claimSrc, ['validfrom', 'policystart'])),
      validUntil: str(pick(claimSrc, ['validuntil', 'policyend', 'expiry'])),
      sumInsured: num(pick(claimSrc, ['suminsured'])),
      rules: rulesFrom((obj.policyRules as unknown) ?? (obj.policy as Record<string, unknown> | undefined)?.rules),
    },
    documents: name ? [{ name, type: format, excerpt: JSON.stringify(claim) }] : [],
    extraction: {
      missingFields: missing,
      valid: missing.length === 0,
      rawText: undefined,
    },
  })
}

export function payloadFromCsv(text: string, name?: string, format: SourceFormat = 'csv'): DetectionPayload {
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true })
  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(parsed.errors[0]?.message ?? 'CSV parse failed')
  }
  return payloadFromObject({ claims: parsed.data, ...parsed.data[0], invoiceLines: parsed.data }, format, name)
}

export function payloadFromWorkbook(buffer: ArrayBuffer, name?: string): DetectionPayload {
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
  return payloadFromObject({ ...rows[0], invoiceLines: rows }, 'xlsx', name)
}

export function payloadFromText(text: string, format: SourceFormat, engine: string, name?: string, ocrUsed = false): DetectionPayload {
  const claimId = text.match(/CLM[- ]?\d{3,}/i)?.[0]?.toUpperCase().replace(' ', '-')
  const policy = text.match(/(?:policy|pol)[:\s#]*([A-Z]{2}[- ]?\d{3,})/i)?.[1]
  const amountMatch = text.match(/(?:amount|total|claimed|billed)[:\s]*₹?\s*([\d,]+(?:\.\d+)?)/i)
    ?? text.match(/₹\s*([\d,]+(?:\.\d+)?)/)
  const claimant = text.match(/(?:claimant|patient|insured)[:\s]+([A-Za-z .]+)/i)?.[1]?.trim()
  const provider = text.match(/(?:hospital|provider|garage)[:\s]+([A-Za-z0-9 .&]+)/i)?.[1]?.trim()
  const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? text.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/)?.[0]
  const requestedAmount = num(amountMatch?.[1])

  const lineRegex = /(.+?)\s+₹?\s*([\d,]+(?:\.\d+)?)/g
  const invoiceLines: InvoiceLine[] = []
  let m: RegExpExecArray | null
  while ((m = lineRegex.exec(text)) && invoiceLines.length < 20) {
    const desc = m[1].trim()
    if (desc.length < 3 || desc.length > 80) continue
    if (/total|amount|policy|claim/i.test(desc) && desc.length < 12) continue
    invoiceLines.push({
      id: uid('LINE'),
      description: desc.slice(-60),
      code: '',
      quantity: 1,
      unitPrice: num(m[2]) ?? 0,
      amount: num(m[2]) ?? 0,
      provider: provider ?? '',
      invoiceRef: text.match(/INV[- ]?\w+/i)?.[0] ?? '',
      date: date ?? '',
    })
  }

  const missing: string[] = []
  if (!claimId && !policy) missing.push('claimId or policyNumber')
  if (!requestedAmount) missing.push('requestedAmount')
  if (!invoiceLines.length) missing.push('invoice line items')

  return emptyPayload(format, engine, {
    source: {
      format,
      filename: name,
      engine,
      ocrUsed,
      confidence: ocrUsed ? (missing.length ? 0.45 : 0.72) : missing.length ? 0.55 : 0.8,
      warnings: missing.length ? ['Unstructured extraction — please review before sending to the detection agent'] : [],
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
    documents: [{ name: name ?? 'extracted-text', type: format, excerpt: text.slice(0, 1200) }],
    extraction: {
      rawText: text.slice(0, 8000),
      missingFields: missing,
      valid: missing.length === 0,
    },
  })
}

export function detectFormat(file: File): SourceFormat {
  const name = file.name.toLowerCase()
  const type = file.type
  if (name.endsWith('.json') || type.includes('json')) return 'json'
  if (name.endsWith('.csv') || type.includes('csv')) return 'csv'
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || type.includes('sheet')) return 'xlsx'
  if (name.endsWith('.pdf') || type.includes('pdf')) return 'pdf'
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)) return 'image'
  if (name.endsWith('.txt')) return 'text'
  return 'text'
}

export function sampleJsonPayload(): DetectionPayload {
  return payloadFromObject(
    {
      claimId: 'CLM-DEMO-01',
      policyNumber: 'HL-77821',
      claimant: 'Ananya Iyer',
      incidentDate: '2026-09-12',
      domain: 'Health',
      claimType: 'Hospitalisation',
      requestedAmount: 28000,
      proposedSettlement: 28000,
      provider: 'Aarogyam Super Speciality',
      city: 'Bengaluru',
      deductible: 10000,
      copay: 20,
      validFrom: '2026-01-01',
      validUntil: '2026-12-31',
      policyRules: [
        { id: 'PR-ROOM', name: 'Room rent sub-limit', clause: 'Room rent payable up to ₹5,000 per day.', type: 'sublimit', value: 5000, unit: 'per day' },
        { id: 'PR-EXC', name: 'Consumables exclusion', clause: 'Non-medical consumables are excluded.', type: 'exclusion' },
      ],
      invoiceLines: [
        { description: 'Room rent 3 days', code: 'ROOM-DLX', quantity: 3, unitPrice: 7000, amount: 21000, invoice: 'INV-44109' },
        { description: 'CBC diagnostic test', code: 'LAB-CBC', amount: 2000, invoice: 'INV-44109' },
        { description: 'CBC diagnostic test', code: 'LAB-CBC', amount: 2000, invoice: 'INV-44109' },
        { description: 'Surgical gloves', code: 'CONS-01', amount: 3000, invoice: 'INV-44109' },
      ],
    },
    'json',
    'sample-health-claim.json',
  )
}
