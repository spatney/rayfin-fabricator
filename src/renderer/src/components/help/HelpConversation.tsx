import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode
} from 'react'
import {
  createHelpConversation,
  type HelpConversation,
  type HelpConversationState
} from './conversation'

const HelpConversationContext = createContext<HelpConversation | null>(null)

/** One Help conversation for the whole app, shared by Help and Search. */
export function HelpConversationProvider({ children }: { children: ReactNode }): JSX.Element {
  const [conversation] = useState(createHelpConversation)
  useEffect(() => () => conversation.dispose(), [conversation])
  return (
    <HelpConversationContext.Provider value={conversation}>
      {children}
    </HelpConversationContext.Provider>
  )
}

/**
 * The shared Help conversation and its current state. Outside a provider (a
 * test, a docs harness) the component keeps a conversation of its own.
 */
export function useHelpConversation(): [HelpConversation, HelpConversationState] {
  const shared = useContext(HelpConversationContext)
  const [own] = useState(() => (shared ? null : createHelpConversation()))
  const conversation = shared ?? own!
  useEffect(() => (own ? () => own.dispose() : undefined), [own])
  const state = useSyncExternalStore(conversation.subscribe, conversation.getState)
  return [conversation, state]
}
