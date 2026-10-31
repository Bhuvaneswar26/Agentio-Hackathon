import { PageHeader } from '../components/ui'
import { formatDate } from '../lib/format'
import { useAppStore } from '../store/useAppStore'
import { Link } from 'react-router-dom'

export function Audit() {
  const audit = useAppStore((s) => s.audit)
  return (
    <div>
      <PageHeader
        eyebrow="Governance"
        title="Audit trail"
        description="Every ingest, queue move, note and agent call is retained for the investigation file."
      />
      <ol className="relative space-y-0 border-l border-line ml-3">
        {audit.map((e) => (
          <li key={e.id} className="mb-6 ml-6">
            <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-brand" />
            <p className="text-xs text-mute">
              {formatDate(e.at)} · {e.actor}
            </p>
            <p className="font-medium">{e.action}</p>
            <p className="text-sm text-mute">{e.detail}</p>
            {e.claimId ? (
              <Link className="text-xs text-brand-dark" to={`/claims/${e.claimId}`}>
                {e.claimId}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
