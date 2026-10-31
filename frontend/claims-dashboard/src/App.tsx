import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Alerts } from './pages/Alerts'
import { Audit } from './pages/Audit'
import { ClaimDetail } from './pages/ClaimDetail'
import { Claims } from './pages/Claims'
import { CommandCenter } from './pages/CommandCenter'
import { Ingest } from './pages/Ingest'
import { PolicyReader } from './pages/PolicyReader'
import { Providers } from './pages/Providers'
import { Settings } from './pages/Settings'
import { SpecialCases } from './pages/SpecialCases'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<CommandCenter />} />
          <Route path="ingest" element={<Ingest />} />
          <Route path="policy" element={<PolicyReader />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="claims" element={<Claims />} />
          <Route path="claims/:id" element={<ClaimDetail />} />
          <Route path="providers" element={<Providers />} />
          <Route path="special" element={<SpecialCases />} />
          <Route path="audit" element={<Audit />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
