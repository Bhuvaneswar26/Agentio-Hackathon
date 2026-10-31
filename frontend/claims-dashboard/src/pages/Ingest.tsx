import { FileJson, Globe, Image as ImageIcon, Loader2, Send, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, Panel, SeverityBadge } from '../components/ui'
import { runPreviewDetection } from '../lib/detectPreview'
import { extractFromFile, extractFromUrl, formatLabel } from '../lib/extract'
import { payloadFromObject, sampleJsonPayload } from '../lib/ingest'
import { findingLabel, inr, uid } from '../lib/format'
import { useAppStore } from '../store/useAppStore'
import type { Claim, DetectionPayload } from '../types'

export function Ingest() {
  const navigate = useNavigate()
  const { addJob, updateJob, ingestPayloadAsClaim, addAgentClaim, agentUrl, log, claims, jobs } = useAppStore()
  const [payload, setPayload] = useState<DetectionPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(false)
  const [claimId, setClaimId] = useState<string | null>(null)
  const preview = useMemo(() => (payload ? runPreviewDetection(payload, claims) : null), [payload, claims])

  async function run(label: string, fn: () => Promise<DetectionPayload> | DetectionPayload) {
    setError('')
    setBusy(true)
    const jobId = uid('JOB')
    addJob({ id: jobId, name: label, format: 'json', status: 'extracting', payload: null })
    try {
      const next = await fn()
      setPayload(next)
      setClaimId(null)
      updateJob(jobId, { status: 'ready', payload: next, format: next.source.format })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Extraction failed'
      setError(message)
      updateJob(jobId, { status: 'failed', error: message })
    } finally {
      setBusy(false)
    }
  }

  function onFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    void run(file.name, () => extractFromFile(file))
  }

  function parkOnDesk() {
    if (!payload || claimId) return
    const id = ingestPayloadAsClaim(payload)
    setClaimId(id)
  }

  async function sendToAgent() {
    if (!payload) return
    const jobId = uid('JOB')
    addJob({ id: jobId, name: 'Detection agent', format: payload.source.format, status: 'extracting', payload })
    try {
      // Desk claims travel as history so the engine can detect duplicates across the portfolio.
      const history = claims.slice(0, 200).map((c) => ({
        claimId: c.id,
        incidentDate: c.incidentDate,
        amount: c.requestedAmount,
        status: c.queue,
        claimant: c.claimant,
        provider: c.provider,
        invoiceLines: c.lines,
      }))
      const res = await fetch(agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, history: [...payload.history, ...history] }),
      })
      const text = await res.text()
      let parsed: { claim?: Claim; status?: string } | null = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      updateJob(jobId, {
        status: res.ok ? 'sent' : 'failed',
        sentAt: new Date().toISOString(),
        agentResponse: text.slice(0, 4000),
        error: res.ok ? undefined : `HTTP ${res.status}`,
      })
      log({
        actor: 'Ingestion desk',
        action: res.ok ? 'Sent payload to detection agent' : 'Agent call failed — local preview still available',
        detail: `${agentUrl} · ${res.status}`,
      })
      if (res.ok && parsed?.claim && !claimId) {
        setClaimId(addAgentClaim(parsed.claim))
      } else if (!res.ok && !claimId) {
        setClaimId(ingestPayloadAsClaim(payload))
      }
    } catch (err) {
      updateJob(jobId, {
        status: 'failed',
        error: `${err instanceof Error ? err.message : 'Network error'} · parked with local preview instead`,
      })
      if (!claimId) {
        const id = ingestPayloadAsClaim(payload)
        setClaimId(id)
      }
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Intake"
        title="Ingest any claim pack"
        description="Drop a PDF invoice, claim JSON, Excel, CSV, photo, or a public web link. Images go through OCR. Structured files are mapped into the detection-agent payload without guessing missing policy facts."
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-2">
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              onFiles(e.dataTransfer.files)
            }}
            className={`block cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center ${
              drag ? 'border-brand bg-brand/20' : 'border-line bg-white'
            }`}
          >
            <Upload className="mx-auto text-brand-dark" />
            <p className="mt-3 font-medium">Drop PDF, image, JSON, CSV or Excel</p>
            <p className="mt-1 text-sm text-mute">Max 12 MB. Scanned PDFs use OCR automatically.</p>
            <input
              type="file"
              className="hidden"
              accept=".json,.csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp,.txt"
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>

          <Panel title="Paste a web link">
            <div className="flex gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className="flex-1 rounded-xl border border-line bg-mist px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <button
                type="button"
                className="rounded-xl bg-ink px-3 text-white"
                onClick={() => url && void run(url, () => extractFromUrl(url))}
              >
                <Globe size={16} />
              </button>
            </div>
          </Panel>

          <Panel title="Paste JSON">
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={7}
              className="w-full rounded-xl border border-line bg-mist p-3 font-mono text-xs outline-none focus:border-brand"
              placeholder='{"claimId":"CLM-…","requestedAmount":28000,"invoiceLines":[]}'
            />
            <button
              type="button"
              className="mt-3 rounded-full bg-ink px-4 py-2 text-sm text-white"
              onClick={() =>
                jsonText &&
                void run('pasted.json', () => payloadFromObject(JSON.parse(jsonText), 'json', 'paste.json'))
              }
            >
              Parse JSON
            </button>
          </Panel>

          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-line bg-white px-4 py-3 text-sm"
            onClick={() => void run('sample-health-claim.json', () => sampleJsonPayload())}
          >
            <FileJson size={16} className="text-brand-dark" />
            Load the health leakage sample
          </button>
          <p className="text-center text-xs text-mute">
            Also in repo: <a className="underline" href="/samples/health-claim.json">JSON</a>
            {' · '}
            <a className="underline" href="/samples/health-claim.csv">CSV</a>
          </p>
        </div>

        <div className="space-y-4 xl:col-span-3">
          <Panel
            title="Structured detection payload"
            action={
              payload ? (
                <span className="text-xs text-mute">
                  {formatLabel(payload.source.format)} · {Math.round(payload.source.confidence * 100)}% confidence
                </span>
              ) : null
            }
          >
            {busy ? (
              <div className="flex items-center gap-2 py-16 justify-center text-sm text-mute">
                <Loader2 className="animate-spin" size={18} /> Extracting with the matching engine…
              </div>
            ) : error && !payload ? (
              <p className="py-10 text-center text-sm">{error}</p>
            ) : payload ? (
              <div>
                {error ? <p className="mb-3 text-sm">{error}</p> : null}
                {payload.source.ocrUsed ? (
                  <p className="mb-3 flex items-center gap-2 rounded-xl bg-mist px-3 py-2 text-xs">
                    <ImageIcon size={14} /> OCR was used because the source was an image or a scanned PDF.
                  </p>
                ) : null}
                {payload.source.warnings.map((w) => (
                  <p key={w} className="mb-2 rounded-xl border border-line px-3 py-2 text-xs text-mute">
                    {w}
                  </p>
                ))}
                {payload.extraction.missingFields.length ? (
                  <p className="mb-3 rounded-xl bg-ink px-3 py-2 text-xs text-brand">
                    Incomplete pack: {payload.extraction.missingFields.join(', ')}. This will sit in unassessed, not as leakage.
                  </p>
                ) : (
                  <p className="mb-3 rounded-xl bg-brand/20 px-3 py-2 text-xs">Ready for the detection agent.</p>
                )}
                <dl className="mb-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-mute">Claim</dt>
                    <dd>{payload.claim.claimId || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-mute">Policy</dt>
                    <dd>{payload.claim.policyNumber || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-mute">Claimant</dt>
                    <dd>{payload.claim.claimant || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-mute">Amount</dt>
                    <dd>{payload.claim.requestedAmount ?? '—'}</dd>
                  </div>
                </dl>
                {preview ? (
                  <div className="mb-3 rounded-xl border border-line bg-mist p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-mute">Local preview (until the agent replies)</p>
                    <p className="mt-1 text-sm">
                      Queue {preview.queue} · risk {preview.riskScore} · confirmed {inr(preview.confirmedLeakage)} · potential {inr(preview.potentialLeakage)}
                    </p>
                    <ul className="mt-2 space-y-2">
                      {preview.findings.map((f) => (
                        <li key={f.id} className="rounded-lg bg-white px-3 py-2 text-xs">
                          <span className="font-medium">{f.title}</span>
                          <span className="ml-2 text-mute">{findingLabel[f.kind]}</span>
                          <span className="ml-2">
                            <SeverityBadge severity={f.severity} />
                          </span>
                          {f.leakageAmount ? <span className="ml-2 font-mono">{inr(f.leakageAmount)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <pre className="max-h-72 overflow-auto rounded-xl bg-ink p-3 font-mono text-[11px] text-brand">
                  {JSON.stringify(payload, null, 2)}
                </pre>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={parkOnDesk} className="rounded-full bg-brand px-4 py-2 text-sm text-ink">
                    Park on claims desk
                  </button>
                  <button
                    type="button"
                    onClick={() => void sendToAgent()}
                    className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm text-white"
                  >
                    <Send size={14} /> Analyse with ClaimsGuard engine
                  </button>
                  {claimId ? (
                    <button
                      type="button"
                      className="rounded-full border border-line px-4 py-2 text-sm"
                      onClick={() => navigate(`/claims/${claimId}`)}
                    >
                      Open {claimId}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-mute">
                Extraction preview will appear here. The JSON below is the contract for the other project&apos;s detection agent.
              </p>
            )}
          </Panel>
        </div>
      </div>
      {jobs.length ? (
        <div className="mt-4">
          <Panel title="Recent ingest jobs">
            <ul className="grid gap-2 md:grid-cols-2">
              {jobs.slice(0, 6).map((j) => (
                <li key={j.id} className="rounded-xl bg-mist px-3 py-2 text-sm">
                  <span className="font-medium">{j.name}</span>
                  <span className="ml-2 text-xs text-mute">{j.status}</span>
                  {j.error ? <p className="text-xs text-mute">{j.error}</p> : null}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}
    </div>
  )
}
