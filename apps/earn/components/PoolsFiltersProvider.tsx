import { ChainId } from '@sushiswap/chain'
import { createContext, FC, ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import { SUPPORTED_CHAIN_IDS } from '../config'
import { AVAILABLE_POOL_TYPE_MAP } from '../lib/constants'

enum Filters {
  chainIds = 'chainIds',
  poolTypes = 'poolTypes',
  incentivizedOnly = 'incentivizedOnly',
}

interface FilterContext {
  query: string
  extraQuery: string
  [Filters.chainIds]: ChainId[]
  [Filters.poolTypes]: (keyof typeof AVAILABLE_POOL_TYPE_MAP)[]
  [Filters.incentivizedOnly]: boolean
  setFilters(filters: Partial<Omit<FilterContext, 'setFilters'>>): void
}

const FilterContext = createContext<FilterContext | undefined>(undefined)

export type PoolFilters = Omit<FilterContext, 'setFilters'>

interface PoolsFiltersProvider {
  children?: ReactNode
  passedFilters?: Partial<PoolFilters>
}

const defaultFilters: PoolFilters = {
  query: '',
  extraQuery: '',
  [Filters.chainIds]: SUPPORTED_CHAIN_IDS,
  [Filters.poolTypes]: Object.keys(AVAILABLE_POOL_TYPE_MAP) as unknown as (keyof typeof AVAILABLE_POOL_TYPE_MAP)[],
  [Filters.incentivizedOnly]: false,
}

export const PoolsFiltersProvider: FC<PoolsFiltersProvider> = ({ children, passedFilters }) => {
  const [filters, _setFilters] = useState<PoolFilters>({ ...defaultFilters, ...passedFilters })

  const setFilters = useCallback((filters: PoolFilters) => {
    _setFilters((prevState) => ({
      ...prevState,
      ...filters,
    }))
  }, [])

  useEffect(() => setFilters({ ...defaultFilters, ...passedFilters }), [passedFilters, setFilters])

  return (
    <FilterContext.Provider
      value={{
        ...filters,
        setFilters,
      }}
    >
      {children}
    </FilterContext.Provider>
  )
}

export const usePoolFilters = () => {
  const context = useContext(FilterContext)
  if (!context) {
    throw new Error('Hook can only be used inside Filter Context')
  }

  return context
}
