import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../hooks/useAuth.js'
import { supabase } from '../../lib/supabase.js'
import { fetchUnreadNotifications, markNotificationsRead } from './notificationsApi.js'

const CHECK_EVERY_MS = 60_000

/**
 * Unread notifications for the header dot and the S6 toast. Guests (or no Supabase) have none.
 * `markRead(ids)` marks them read and drops them from the list straight away.
 */
export function useNotifications() {
  const { isLoggedIn } = useAuth()
  const enabled = Boolean(supabase) && isLoggedIn
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => fetchUnreadNotifications(),
    enabled,
    refetchInterval: enabled ? CHECK_EVERY_MS : false,
  })

  const markRead = useCallback(
    async (ids) => {
      queryClient.setQueryData(['notifications'], (list = []) => list.filter((n) => !ids.includes(n.id)))
      await markNotificationsRead(ids)
    },
    [queryClient],
  )

  return { unread: enabled ? (query.data ?? []) : [], markRead }
}
