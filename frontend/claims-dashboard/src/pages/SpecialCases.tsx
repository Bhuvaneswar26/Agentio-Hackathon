import { PageHeader, Panel, QueueBadge, EmptyState } from '../components/ui'
import { inr } from '../lib/format'
import { useQueueMove } from '../lib/useQueueMove'
import { useAppStore } from '../store/useAppStore'
import { Link } from 'react-router-dom'

export function SpecialCases() {
  const { claims, role } = useAppStore()
  const moveQueue = useQueueMove()
  const special = claims.filter((c) => c.queue === 'special')
  const locked = role === 'executive'

  return (
    <div>
      <PageHeader
        eyebrow="Supervisor agents"
        title="Special review queue"
        description="Good claims and bad claims can both land here when judgement is needed: related-party graphs, missing pre-auth, or lookalikes that should not be auto-declined."
      />
      {special.length === 0 ? (
        <EmptyState title="Queue is clear" body="Escalate a claim from the workspace or claim detail." />
      ) : (
        <div className="grid gap-4">
          {special.map((c) => (
            <Panel
              key={c.id}
              title={`${c.id} · ${c.claimant}`}
              action={<QueueBadge queue={c.queue} />}
            >
              <p className="text-sm text-mute">{c.specialReason || 'No reason captured yet.'}</p>
              <div className="mt-3 flex flex-wrap gap-4 text-sm">
                <span>Requested {inr(c.requestedAmount)}</span>
                <span>Risk {c.riskScore}</span>
                <span>{c.provider}</span>
              </div>
              {c.supervisorNote ? <p className="mt-2 rounded-xl bg-mist px-3 py-2 text-sm">{c.supervisorNote}</p> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Link to={`/claims/${c.id}`} className="rounded-full border border-line px-3 py-1.5 text-xs">
                  Open evidence
                </Link>
                {!locked ? (
                  <>
                    <button type="button" className="rounded-full bg-brand px-3 py-1.5 text-xs" onClick={() => moveQueue(c.id, 'good')}>
                      Release as good
                    </button>
                    <button type="button" className="rounded-full bg-ink px-3 py-1.5 text-xs text-white" onClick={() => moveQueue(c.id, 'confirmed')}>
                      Confirm leakage
                    </button>
                    <button type="button" className="rounded-full border border-line px-3 py-1.5 text-xs" onClick={() => moveQueue(c.id, 'unassessed')}>
                      Send back for evidence
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-mute">Executive view is read-only on queue moves.</span>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  )
}
