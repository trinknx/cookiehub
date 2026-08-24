import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Dashboard />} />
      <Route path="/settings" element={<div className="p-8">settings coming soon</div>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
