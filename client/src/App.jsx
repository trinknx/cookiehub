import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<div className="p-8">dashboard coming soon</div>} />
      <Route path="/settings" element={<div className="p-8">settings coming soon</div>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
