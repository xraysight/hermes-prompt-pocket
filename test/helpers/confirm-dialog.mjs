// Behavioral fixture ported from Hermes ConfirmDialog at
// fde4997f580c3480798fdf9c7e92c0079d6e03d6:
// apps/desktop/src/components/ui/confirm-dialog.tsx.
// Preserves both run branches, busy/close/key guards, inline errors and the
// 600ms done timer. Styling, localization and focus/DOM integration are omitted.
export function createConfirmDialog(react, sdk, jsx) {
  const { useEffect, useRef, useState } = react
  function ConfirmDialog({ open, onClose, onConfirm, title, confirmLabel = 'Confirm', dismissOnConfirm = false }) {
    const closeTimerRef = useRef(null)
    const [status, setStatus] = useState('idle')
    const [error, setError] = useState(null)
    const busy = status === 'saving' || status === 'done'
    useEffect(() => {
      if (open) {
        setStatus('idle')
        setError(null)
      }
    }, [open])
    useEffect(() => () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }, [])
    async function run() {
      if (busy) return
      setError(null)
      if (dismissOnConfirm) {
        try {
          await onConfirm()
          onClose()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Something went wrong')
        }
        return
      }
      setStatus('saving')
      try {
        await onConfirm()
        setStatus('done')
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null
          onClose()
        }, 600)
      } catch (err) {
        setStatus('idle')
        setError(err instanceof Error ? err.message : 'Something went wrong')
      }
    }
    return jsx(sdk.Dialog, {
      open,
      onOpenChange: value => !value && !busy && onClose(),
      children: jsx(sdk.DialogContent, {
        onKeyDown: event => {
          if ((event.key === 'Enter' || event.key === ' ') && !busy) {
            event.preventDefault()
            void run()
          }
        },
        children: [
          jsx(sdk.DialogTitle, { children: title }),
          error && jsx('span', { children: error }),
          jsx(sdk.Button, { disabled: busy, onClick: onClose, children: 'Cancel' }),
          jsx(sdk.Button, { disabled: busy, onClick: () => void run(), children: confirmLabel })
        ]
      })
    })
  }
  return ConfirmDialog
}
