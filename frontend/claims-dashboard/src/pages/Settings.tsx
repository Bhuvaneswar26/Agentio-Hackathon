import { PageHeader, Panel } from '../components/ui'
import { useAppStore } from '../store/useAppStore'

export function Settings() {
  const { agentUrl, setAgentUrl, resetDemo, jobs } = useAppStore()
  return (
    <div>
      <PageHeader
        eyebrow="Integration"
        title="Detection agent connection"
        description="This UI does not own the core leakage engine. Point it at the FastAPI project. The payload schema is version 1.0 and is produced after OCR or structured parse."
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
      <button type="button" onClick={resetDemo} className="rounded-full border border-line bg-white px-4 py-2 text-sm">
        Reset demo portfolio
      </button>
    </div>
  )
}
