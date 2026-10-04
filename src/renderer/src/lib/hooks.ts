/**
 * Data-fetching hooks.
 *
 * Every page needs the same three-state dance — loading, error, data — and the
 * same debounce for search-as-you-type. Doing it here keeps pages to their
 * actual content and makes cancellation consistent: a page that unmounts (or
 * whose query changes) must not write a stale result into state.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data?: T
  loading: boolean
  error?: string
  /** Re-runs the loader; useful for a retry button. */
  reload: () => void
  setData: (updater: T | ((current: T | undefined) => T | undefined)) => void
}

/**
 * Runs `loader` whenever `deps` change. `loader` must be stable (wrap it in
 * `useCallback`) or pass an inline arrow and list its inputs in `deps`.
 *
 * `deps` is the source of truth for *when* to reload, and the previous entity's
 * data is cleared first: showing playlist 1's tracks under playlist 2's title
 * is worse than a moment of skeleton.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    setData(undefined)
    loader()
      .then((result) => {
        if (current !== generation.current) return
        setData(result)
      })
      .catch((cause) => {
        if (current !== generation.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (current !== generation.current) return
        setLoading(false)
      })
    // `loader` is intentionally not a dependency: callers pass an inline arrow
    // and describe its inputs through `deps`, which is what useAsync's contract
    // documents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  return { data, loading, error, reload, setData: setData as AsyncState<T>['setData'] }
}

/** Debounces a value; the returned value trails `value` by `delay` ms. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * Paginated loading for infinite lists. `loadPage` receives the offset to
 * fetch and returns the items plus whether more remain.
 *
 * `deps` must identify the collection being paged (e.g. `[playlistId]`,
 * `[category, order]`): when they change the list resets and reloads from
 * offset 0. Omitting them is how a paged view ends up appending page 2 of the
 * *previous* collection.
 */
export function usePaged<T>(
  loadPage: (offset: number, limit: number) => Promise<{ items: T[]; more?: boolean }>,
  deps: unknown[] = [],
  pageSize = 50
): {
  items: T[]
  loading: boolean
  loadingMore: boolean
  error?: string
  more: boolean
  loadMore: () => void
  reset: () => void
  setItems: (updater: (current: T[]) => T[]) => void
} {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [more, setMore] = useState(true)
  const offset = useRef(0)
  const generation = useRef(0)
  // Refs mirror the state that `loadMore` reads: it is called from scroll
  // handlers, where a stale closure would fire a second request for the same
  // page or keep paging past the end.
  const loadingMoreRef = useRef(false)
  const moreRef = useRef(true)
  const loadingRef = useRef(true)
  // The loader is kept in a ref so an inline arrow does not retrigger the
  // effect on every render — `deps` alone decides when to reload.
  const loaderRef = useRef(loadPage)
  loaderRef.current = loadPage

  const fetchFirstPage = useCallback(() => {
    const current = ++generation.current
    offset.current = 0
    setItems([])
    setMore(true)
    moreRef.current = true
    setError(undefined)
    setLoading(true)
    loadingRef.current = true
    loaderRef
      .current(0, pageSize)
      .then((page) => {
        if (current !== generation.current) return
        offset.current = page.items.length
        setItems(page.items)
        const hasMore = page.more ?? page.items.length >= pageSize
        setMore(hasMore)
        moreRef.current = hasMore
      })
      .catch((cause) => {
        if (current !== generation.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (current !== generation.current) return
        setLoading(false)
        loadingRef.current = false
      })
  }, [pageSize])

  useEffect(() => {
    fetchFirstPage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchFirstPage, ...deps])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || !moreRef.current || loadingRef.current) return
    const current = generation.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    loaderRef
      .current(offset.current, pageSize)
      .then((page) => {
        if (current !== generation.current) return
        offset.current += page.items.length
        setItems((existing) => [...existing, ...page.items])
        const hasMore = page.more ?? page.items.length >= pageSize
        setMore(hasMore)
        moreRef.current = hasMore
      })
      .catch((cause) => {
        if (current !== generation.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (current !== generation.current) return
        setLoadingMore(false)
        loadingMoreRef.current = false
      })
  }, [pageSize])

  return { items, loading, loadingMore, error, more, loadMore, reset: fetchFirstPage, setItems }
}
