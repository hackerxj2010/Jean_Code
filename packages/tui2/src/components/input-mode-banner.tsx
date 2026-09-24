import React from 'react'

import { HelpBanner } from './help-banner'
import { PendingAttachmentsBanner } from './pending-attachments-banner'
import { useChatStore } from '../state/chat-store'

/**
 * Registry mapping input modes to their banner components.
 *
 * To add a new banner:
 * 1. Create the banner component using BottomBanner
 * 2. Add an entry here mapping the input mode to a render function
 */
const BANNER_REGISTRY: Record<string, () => React.ReactNode> = {
  default: () => <PendingAttachmentsBanner />,
  image: () => <PendingAttachmentsBanner />,
  help: () => <HelpBanner />,
}

/**
 * Banner component that shows contextual information below the input box.
 * Shows mode-specific banners based on the current input mode.
 */
export const InputModeBanner = () => {
  const inputMode = useChatStore((state) => state.inputMode)
  const renderBanner = BANNER_REGISTRY[inputMode]
  return renderBanner ? <>{renderBanner()}</> : null
}
