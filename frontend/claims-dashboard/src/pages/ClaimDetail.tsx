import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { EmptyState, PageHeader, Panel, QueueBadge, SeverityBadge } from '../components/ui'
import { findingLabel, formatDate, inr } from '../lib/format'
import { useAppStore } from '../store/useAppStore'
import type { ClaimQueue } from '../types'

export function ClaimDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { claims, moveQueue, addNote, role } = useAppStore()
  const claim = claims.find((c) => c.id === id)
  const [note, setNote] = useState(claim?.notes ?? '')
  const [reason, setReason] = useState(claim?.specialReason ?? 'Needs supervisor judgement')

  if (!claim) {
    return (
      <EmptyState title="Claim not on the desk" body="It may have been cleared from demo data. Go back to the workspace." />
    )
  }

  const current = claim
  const related = claims.filter((c) => current.relatedClaimIds.includes(c.id))

  function act(queue: ClaimQueue) {
    moveQueue(current.id, queue, queue === 'special' ? reason : note)
  }

  return (
    <div>
      <PageHeader
        eyebrow={claim.domain}
        title={claim.id}
        description={`${claim.claimant} · ${claim.provider} · ${claim.city}`}
        actions={
          <button type="button" className="text-sm text-mute" onClick={() => navigate(-1)}>
            Back
          </button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <QueueBadge queue={claim.queue} />
        <span className="rounded-full bg-white px-3 py-1 text-xs">Risk {claim.riskScore}</span>
        <span className="rounded-full bg-white px-3 py-1 text-xs">
          Source {claim.sourceFormat} · {Math.round(claim.extractionConfidence * 100)}%
        </span>
        {claim.missingFields.length ? (
          <span className="rounded-full bg-ink px-3 py-1 text-xs text-brand">Missing: {claim.missingFields.join(', ')}</span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs text-mute">Requested</p>
          <p className="mt-1 font-mono text-xl">{inr(claim.requestedAmount)}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs text-mute">Proposed settlement</p>
          <p className="mt-1 font-mono text-xl">{inr(claim.proposedSettlement)}</p>
        </div>
        <div className="rounded-2xl border border-brand bg-brand p-4">
          <p className="text-xs text-ink/70">Expected (counterfactual)</p>
          <p className="mt-1 font-mono text-xl">{inr(claim.expectedSettlement)}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs text-mute">Confirmed leakage</p>
          <p className="mt-1 font-mono text-xl">{inr(claim.confirmedLeakage)}</p>
        </div>
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-xs text-mute">Potential only</p>
          <p className="mt-1 font-mono text-xl">{inr(claim.potentialLeakage)}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <Panel title="Line items" action={<span className="text-xs text-mute">{claim.lines.length} rows</span>}>
          {claim.lines.length === 0 ? (
            <p className="text-sm text-mute">No lines extracted. Request the itemised invoice.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {claim.lines.map((l) => (
                <li key={l.id} className="flex justify-between gap-3 rounded-xl bg-mist px-3 py-2">
                  <span>
                    {l.description}
                    <span className="block text-[11px] text-mute">{l.code || l.invoiceRef}</span>
                  </span>
                  <span className="font-mono">{inr(l.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Policy rules applied">
          <ul className="space-y-3 text-sm">
            {claim.policyRules.map((r) => (
              <li key={r.id}>
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-mute">{r.clause}</p>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Actions">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-full bg-brand px-3 py-1.5 text-xs" onClick={() => act('good')}>
              Mark good
            </button>
            <button type="button" className="rounded-full bg-ink px-3 py-1.5 text-xs text-white" onClick={() => act('confirmed')}>
              Confirm leakage
            </button>
            <button type="button" className="rounded-full border border-line px-3 py-1.5 text-xs" onClick={() => act('dismissed')}>
              Dismiss finding
            </button>
            <button type="button" className="rounded-full border border-line px-3 py-1.5 text-xs" onClick={() => act('unassessed')}>
              Request documents
            </button>
            <button type="button" className="rounded-full bg-brand px-3 py-1.5 text-xs" onClick={() => act('special')}>
              Move to special review
            </button>
          </div>
          <textarea
            className="mt-3 w-full rounded-xl border border-line bg-mist p-2 text-sm"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this a special case?"
          />
          <textarea
            className="mt-2 w-full rounded-xl border border-line bg-mist p-2 text-sm"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`${role} note`}
          />
          <button type="button" className="mt-2 rounded-full bg-ink px-3 py-1.5 text-xs text-white" onClick={() => addNote(claim.id, note)}>
            Save note
          </button>
          <p className="mt-3 text-xs text-mute">Filed {formatDate(claim.filedDate)} · incident {formatDate(claim.incidentDate)}</p>
        </Panel>
      </div>

      <div className="mt-4 space-y-3">
        <h2 className="text-sm font-semibold">Explainable findings</h2>
        {claim.findings.length === 0 ? (
          <p className="rounded-2xl border border-line bg-white p-4 text-sm text-mute">No leakage findings. This is a good claim unless new evidence arrives.</p>
        ) : (
          claim.findings.map((f) => (
            <article key={f.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{f.title}</h3>
                <SeverityBadge severity={f.severity} />
                <span className="text-xs text-mute">{findingLabel[f.kind]} · {f.engine} · {f.certainty}</span>
                {f.leakageAmount ? <span className="ml-auto font-mono text-sm">{inr(f.leakageAmount)}</span> : null}
              </div>
              <p className="mt-2 text-sm text-mute">{f.explanation}</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {f.evidence.map((e) => (
                  <li key={e} className="rounded-full bg-mist px-2 py-1 text-[11px]">
                    {e}
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </div>

      {related.length ? (
        <Panel title="Related claims">
          <ul className="text-sm">
            {related.map((r) => (
              <li key={r.id} className="flex justify-between border-t border-line py-2 first:border-0">
                <Link className="hover:text-brand-dark" to={`/claims/${r.id}`}>
                  {r.id} · {r.claimant}
                </Link>
                <QueueBadge queue={r.queue} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}
