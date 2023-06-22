import { Token } from '@sushiswap/currency'
import { PoolCode } from '@sushiswap/router'
import { FeeAmount } from '@sushiswap/v3-sdk'
import IUniswapV3Factory from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'
import IUniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json'
import { Abi, AbiEvent } from 'abitype'
import { Address, Log, PublicClient } from 'viem'
import { Filter } from 'viem/dist/types/types/filter'

import { Counter } from './Counter'
import { MultiCallAggregator } from './MulticallAggregator'
import { PermanentCache } from './PermanentCache'
import { TokenManager } from './TokenManager'
import { UniV3EventsAbi, UniV3PoolWatcher } from './UniV3PoolWatcher'
import { warnLog } from './WarnLog'

export interface FactoryInfo {
  address: Address
  providerName: string
}

export interface PoolInfo {
  address: Address
  token0: Token
  token1: Token
  fee: FeeAmount
  factory: FactoryInfo
}

enum LogsProcessing {
  NotStarted,
  Starting,
  Started,
}

interface PoolCacheRecord {
  address: Address
  token0: Address
  token1: Address
  fee: number
  factory: Address
}

// Usage recomendation:
//   - launch in a separate thread or process, maybe with higher priority. Don't launch anything network or processor
//     consuming in the same thread
//   - provide good blockchain provider account (Alchemy/Infura/...)
//   - don't call getPoolCodes() too often. It consumes much. Good practice is no do it once per second or so
//   - direct logs (std output) to console
//   - direct warnings (std error) to a file
export class UniV3Extractor {
  factories: FactoryInfo[]
  factoryMap: Map<string, FactoryInfo> = new Map()
  tickHelperContract: Address
  client: PublicClient
  multiCallAggregator: MultiCallAggregator
  tokenManager: TokenManager
  poolMap: Map<Address, UniV3PoolWatcher> = new Map()
  poolPermanentCache: PermanentCache<PoolCacheRecord>
  otherFactoryPoolSet: Set<Address> = new Set()
  eventFilters: Filter[] = []
  logProcessGuard = false
  lastProcessdBlock = -1n
  logProcessingStatus = LogsProcessing.NotStarted
  logging: boolean
  busyCounter: Counter

  /// @param client
  /// @param tickHelperContract address of helper contract for pool's ticks download
  /// @param factories list of supported factories
  /// @param cacheDir directory for cache. Extremely recomended
  /// @param logging to write logs in console or not
  constructor(
    client: PublicClient,
    tickHelperContract: Address,
    factories: FactoryInfo[],
    cacheDir: string,
    logging = true
  ) {
    this.client = client
    this.multiCallAggregator = new MultiCallAggregator(client)
    this.tokenManager = new TokenManager(this.multiCallAggregator, cacheDir)
    this.tickHelperContract = tickHelperContract
    this.factories = factories
    factories.forEach((f) => this.factoryMap.set(f.address.toLowerCase(), f))
    this.poolPermanentCache = new PermanentCache(cacheDir, `uniV3Pools-${this.client.chain?.id}`)
    this.logging = logging
    this.busyCounter = new Counter((count) => {
      if (count == 0) this.consoleLog(`All pools were updated`)
    })
  }

  // TODO: stop ?
  async start() {
    if (this.logProcessingStatus == LogsProcessing.NotStarted) {
      this.logProcessingStatus = LogsProcessing.Starting
      // Subscribe to each UniV3 event we are interested
      for (let i = 0; i < UniV3EventsAbi.length; ++i) {
        const filter = (await this.client.createEventFilter({ event: UniV3EventsAbi[i] as AbiEvent })) as Filter
        this.eventFilters.push(filter)
      }

      // Start log watching
      this.client.watchBlockNumber({
        onBlockNumber: async (blockNumber) => {
          if (!this.logProcessGuard) {
            this.logProcessGuard = true
            let logNames: string[] = []
            try {
              const promises = this.eventFilters.map((f) => this.client.getFilterChanges({ filter: f }))
              const logss = await Promise.allSettled(promises)
              logss.forEach((logs) => {
                if (logs.status == 'fulfilled') {
                  const ln = logs.value.map((l) => this.processLog(l))
                  logNames = logNames.concat(ln)
                }
              })
              this.lastProcessdBlock = blockNumber
            } catch (e) {
              warnLog(`Block ${blockNumber} log process error: ${e}`)
            }

            this.logProcessGuard = false
            this.consoleLog(`Block ${blockNumber} ${logNames.length} logs: [${logNames}]`)
          } else {
            warnLog(`Extractor: Log Filtering was skipped for block ${blockNumber}`)
          }
        },
      })
      this.logProcessingStatus = LogsProcessing.Started

      // Add cached pools to watching
      const cachedPools: Map<string, PoolInfo> = new Map() // map instead of array to avoid duplicates
      await this.tokenManager.addCachedTokens()
      const cachedRecords = await this.poolPermanentCache.getAllRecords()
      cachedRecords.forEach((r) => {
        const token0 = this.tokenManager.getKnownToken(r.token0)
        const token1 = this.tokenManager.getKnownToken(r.token1)
        const factory = this.factoryMap.get(r.factory.toLowerCase())
        if (token0 && token1 && factory && r.address && r.fee)
          cachedPools.set(r.address.toLowerCase(), {
            address: r.address,
            token0,
            token1,
            fee: r.fee,
            factory,
          })
      })
      cachedPools.forEach((p) => this.addPoolWatching(p, false))
      this.consoleLog(`${cachedPools.size} pools were taken from cache`)
    }
  }

  async startForever(tokens: Token[]) {
    await this.start()
    await this.addPoolsForTokens(tokens)
    await new Promise(() => {
      // waits forever
    })
  }

  processLog(l: Log): string {
    try {
      const pool = this.poolMap.get(l.address.toLowerCase() as Address)
      if (pool) return pool.processLog(l)
      else this.addPoolByAddress(l.address)
      return 'UnknPool'
    } catch (e) {
      warnLog(`Log processing for pool ${l.address} throwed an exception ${e}`)
      return 'Exception!!!'
    }
  }

  async addPoolsForTokens(tokens: Token[]) {
    this.tokenManager.addTokens(tokens)
    const fees = Object.values(FeeAmount).filter((fee) => typeof fee == 'number')
    const promises: Promise<Address>[] = []
    for (let i = 0, promiseIndex = 0; i < tokens.length; ++i) {
      for (let j = i + 1; j < tokens.length; ++j) {
        const [a0, a1] = tokens[i].sortsBefore(tokens[j])
          ? [tokens[i].address, tokens[j].address]
          : [tokens[j].address, tokens[i].address]
        fees.forEach((fee) => {
          this.factories.forEach((factory) => {
            promises[promiseIndex++] = this.multiCallAggregator.callValue(
              factory.address,
              IUniswapV3Factory.abi as Abi,
              'getPool',
              [a0, a1, fee]
            )
          })
        })
      }
    }

    const result = await Promise.all(promises)

    const pools: PoolInfo[] = []
    for (let i = 0, promiseIndex = 0; i < tokens.length; ++i) {
      for (let j = i + 1; j < tokens.length; ++j) {
        const [token0, token1] = tokens[i].sortsBefore(tokens[j]) ? [tokens[i], tokens[j]] : [tokens[j], tokens[i]]
        fees.forEach((fee) => {
          this.factories.forEach((factory) => {
            const address = result[promiseIndex++]
            if (address !== '0x0000000000000000000000000000000000000000')
              pools.push({
                address,
                token0,
                token1,
                fee: fee as FeeAmount,
                factory,
              })
          })
        })
      }
    }

    pools.forEach((p) => this.addPoolWatching(p))
  }

  addPoolWatching(p: PoolInfo, addToCache = true) {
    if (this.logProcessingStatus !== LogsProcessing.Started) {
      throw new Error('Pools can be added after Log processing have been started')
    }
    if (!this.poolMap.has(p.address.toLowerCase() as Address)) {
      const watcher = new UniV3PoolWatcher(
        p.factory.providerName,
        p.address,
        this.tickHelperContract,
        p.token0,
        p.token1,
        p.fee,
        this.multiCallAggregator,
        this.busyCounter
      )
      watcher.updatePoolState()
      this.poolMap.set(p.address.toLowerCase() as Address, watcher) // lowercase because incoming events have lowcase addresses ((
      if (addToCache)
        this.poolPermanentCache.add({
          address: p.address,
          token0: p.token0.address as Address,
          token1: p.token1.address as Address,
          fee: p.fee,
          factory: p.factory.address,
        })
      this.consoleLog(`add pool ${p.address}, watched pools total: ${this.poolMap.size}`)
    }
  }

  async addPoolByAddress(address: Address) {
    if (this.otherFactoryPoolSet.has(address)) return
    if (this.client.chain?.id === undefined) return

    const factoryAddress = await this.multiCallAggregator.callValue(address, IUniswapV3Pool.abi as Abi, 'factory')
    const factory = this.factoryMap.get((factoryAddress as Address).toLowerCase())
    if (factory !== undefined) {
      const [token0Address, token1Address, fee] = await Promise.all([
        this.multiCallAggregator.callValue(address, IUniswapV3Pool.abi as Abi, 'token0'),
        this.multiCallAggregator.callValue(address, IUniswapV3Pool.abi as Abi, 'token1'),
        this.multiCallAggregator.callValue(address, IUniswapV3Pool.abi as Abi, 'fee'),
      ])
      const [token0, token1] = await Promise.all([
        this.tokenManager.findToken(token0Address as Address),
        this.tokenManager.findToken(token1Address as Address),
      ])
      if (token0 && token1) {
        this.addPoolWatching({ address, token0, token1, fee: fee as FeeAmount, factory })
        return
      }
    }
    this.otherFactoryPoolSet.add(address)
    this.consoleLog(`other factory pool ${address}, such pools known: ${this.otherFactoryPoolSet.size}`)
  }

  getPoolCodes(): PoolCode[] {
    return Array.from(this.poolMap.values())
      .map((p) => p.getPoolCode())
      .filter((pc) => pc !== undefined) as PoolCode[]
  }

  // only for testing
  getStablePoolCodes(): PoolCode[] {
    return Array.from(this.poolMap.values())
      .map((p) => (p.isStable() ? p.getPoolCode() : undefined))
      .filter((pc) => pc !== undefined) as PoolCode[]
  }

  consoleLog(log: string) {
    if (this.logging) console.log('Extractor: ' + log)
  }
}
