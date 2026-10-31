import { PageHeader, Panel } from '../components/ui'
import { useAppStore } from '../store/useAppStore'

export function Settings() {
  const { agentUrl, setAgentUrl, clearLocalData, loadDemoData, claims, jobs } = useAppStore()
  return (
    <div>
      <PageHeader
        eyebrow="Integration"
        title="Detection agent connection"
        description="The core leakage engine lives in services/detection-agent (FastAPI). The payload schema is version 1.0 and is produced after OCR or structured parse; the engine returns a scored claim that lands on the desk."
      />
      <Panel title="Endpoint">
        <label className="text-xs text-mute">POST URL</label>
        <input
          value={agentUrl}
          onChange={(e) => setAgentUrl(e.target.value)}
          className="mt-1 w-full rounded-xl border border-line bg-mist px-3 py-2 font-mono text-sm"
        />
        <p className="mt-2 text-xs text-mute">
          Default <code>http://localhost:8000/v1/detect</code>. CORS must allow this origin. If the engine is down, you can still park packs on the desk.
        </p>
      </Panel>
      <Panel title="Recent jobs">
        <ul className="space-y-2 text-sm">
          {jobs.length === 0 ? <li className="text-mute">No ingest jobs yet.</li> : null}
          {jobs.map((j) => (
            <li key={j.id} className="rounded-xl bg-mist px-3 py-2">
              <span className="font-medium">{j.name}</span>
              <span className="ml-2 text-xs text-mute">{j.status}</span>
              {j.error ? <p className="text-xs">{j.error}</p> : null}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Local data">
        <p className="text-sm text-mute">
          {claims.length} claim{claims.length === 1 ? '' : 's'} on the desk in this browser. The dashboard starts empty; claims,
          the audit trail and ingest jobs live in this browser only. The master policy is stored in the engine database and is not affected.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={clearLocalData}
            className="rounded-full border border-red-200 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50"
          >
            Clear claims and audit trail
          </button>
          <button
            type="button"
            onClick={loadDemoData}
            className="rounded-full border border-line bg-white px-4 py-2 text-sm hover:border-ink/40 hover:bg-mist"
          >
            Load demo portfolio
          </button>
        </div>
      </Panel>
    </div>
  )
}
