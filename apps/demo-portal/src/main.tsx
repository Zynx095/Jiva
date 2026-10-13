import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ToastProvider } from '@jiva/ui/src'
import '@jiva/ui/src/fonts'
import './index.css'
import Portal from './Portal.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Portal />
    </ToastProvider>
  </StrictMode>,
)
