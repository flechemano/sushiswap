import { Address } from 'viem'
import { Token } from '../currency'
import { RPool, RToken } from '../tines'
import { PoolEdge, TokenVert, makePoolTokenGraph } from './PoolTokenGraph.js'

const FULL_RECALC_INTERVAL = 6 * 3600 * 1000
const MAX_PRICABLE_LIQUIDITY = 100
const MIN_PRICABLE_LIQUIDITY = 0.8

class TokenInfo {
  address: Address
  decExp: number
  token: RToken
  parent: TokenInfo | undefined
  children: TokenInfo[] = []
  direction: boolean
  poolPrice: number
  totalSuccessors = 0
  changedPoolIndex?: number

  constructor(
    token: RToken,
    direction: boolean,
    poolPrice: number,
    parent?: TokenInfo,
  ) {
    this.token = token
    this.address = token.address as Address
    this.decExp = 10 ** token.decimals
    this.direction = direction
    this.poolPrice = poolPrice
    this.parent = parent
  }
}

// Calculates prices. 2 modes: full recalculate and incremental recalculating having only changed pools
export class IncrementalPricer {
  readonly baseTokens: TokenInfo[] // pricing start
  readonly baseTokenPrices: number[] // prices of baseTokens
  readonly minLiquidity: number // min liquidity pool should have to be used in pricing

  readonly poolTokenMap: Map<string, TokenInfo> = new Map() // pool.uniqueID() => TokenInfo
  readonly tokenMap: Map<Address, TokenInfo> = new Map() // token.address => TokenInfo
  prices: Record<string, number> = {} // calculated prices token.address => <token price>
  pricesSize = 0 // the number of calculated prices

  lastfullPricesRecalcDate = 0
  fullPricesRecalcFlag = false

  constructor(baseTokens: Token[], prices: number[], minLiquidity: number) {
    this.baseTokens = new Array(baseTokens.length)
    this.baseTokenPrices = prices.slice()
    baseTokens.forEach((t, i) => {
      this.baseTokens[i] = new TokenInfo(t as RToken, true, 1)
    })
    this.minLiquidity = minLiquidity
  }

  updatePrices(
    updatedPools: RPool[],
    allPoolsOnDemand: () => RPool[],
    logging = false,
  ): number {
    if (this.isFullPricesRecalcNeeded())
      return this._fullPricesRecalculation(allPoolsOnDemand(), logging)
    else return this._updatePricesForPools(updatedPools)
  }

  isFullPricesRecalcNeeded() {
    return (
      this.fullPricesRecalcFlag ||
      Date.now() - this.lastfullPricesRecalcDate > FULL_RECALC_INTERVAL
    )
  }

  private _fullPricesRecalculation(pools: RPool[], logging = false): number {
    this.poolTokenMap.clear()
    this.tokenMap.clear()
    this.prices = {}
    this.pricesSize = 0

    const baseVerts = makePoolTokenGraph(
      pools,
      this.baseTokens.map((t) => t.address),
    )
    const sortedBaseVerts = this._sortBaseVerts(baseVerts)
    sortedBaseVerts.forEach(([baseVert, baseIndex]) => {
      if (this.prices[baseVert.address] !== undefined) return // the token is already priced

      const baseToken = this.baseTokens[baseIndex] as TokenInfo
      const baseTokenPrice = this.baseTokenPrices[baseIndex] as number
      // if (baseVert === undefined) {
      //   // no pools with this token
      //   this.tokenMap.set(baseToken.address, baseToken)
      //   this.prices[baseToken.address] = baseTokenPrice
      //   ++this.pricesSize
      //   return
      // }

      const nextEdges: PoolEdge[] = []
      if (logging)
        console.log(
          `Pricing: Initial token ${baseVert.token.symbol} price=${baseTokenPrice}`,
        )
      baseVert.obj = baseToken
      this._addVertice(nextEdges, baseVert, baseTokenPrice / baseVert.decExp)

      while (nextEdges.length > 0) {
        const bestEdge = nextEdges.pop() as PoolEdge
        let vFrom = bestEdge.token0
        let vTo = bestEdge.token1
        let direction = true
        if (vTo.price !== undefined) {
          if (vFrom.price !== undefined) continue // token already priced
          const tmp = vFrom
          vFrom = vTo
          vTo = tmp
          direction = false
        }
        const p =
          (vFrom.price as number) *
          bestEdge.pool.calcCurrentPriceWithoutFee(!direction)
        if (logging)
          console.log(
            `Pricing: + Token ${vTo.token.symbol} price=${p * vTo.decExp}` +
              ` from ${vFrom.token.symbol} pool=${bestEdge.pool.address} liquidity=${bestEdge.poolLiquidity}`,
          )
        vTo.obj = new TokenInfo(vTo.token, direction, p, vFrom.obj as TokenInfo)
        this.poolTokenMap.set(bestEdge.pool.uniqueID(), vTo.obj as TokenInfo)
        this._addVertice(nextEdges, vTo, p)
      }

      this._updateTotalSuccessor(baseToken)
      this.lastfullPricesRecalcDate = Date.now()
      this.fullPricesRecalcFlag = false
    })
    return this.pricesSize
  }

  // sorts baseVerts: the best the first
  private _sortBaseVerts(
    baseVerts: (TokenVert | undefined)[],
  ): [TokenVert, number][] {
    const tmp = baseVerts
      .map((b, i) => {
        if (b === undefined) return
        const price = this.baseTokenPrices[i] as number
        const reserve = b.pools.reduce(
          (a, p) => a + price * Number(p.reserve(b)),
          0,
        )
        const decExp = this.baseTokens[i]?.decExp as number
        return [(reserve * price) / decExp, [b, i]] as [
          number,
          [TokenVert, number],
        ]
      })
      .filter((p) => p !== undefined) as [number, [TokenVert, number]][]
    return tmp.sort((a, b) => b[0] - a[0]).map((a) => a[1])
  }

  private _updateTotalSuccessor(token: TokenInfo): number {
    let count = 0
    for (let i = token.children.length - 1; i >= 0; --i)
      count += this._updateTotalSuccessor(token.children[i] as TokenInfo)
    token.totalSuccessors = count
    return count + 1
  }

  private _addVertice(nextEdges: PoolEdge[], v: TokenVert, price: number) {
    v.price = price
    this.tokenMap.set(v.address, v.obj as TokenInfo)
    this.prices[v.address] = price * v.decExp
    ++this.pricesSize
    // if (nextEdges.length === 0) {
    //   // optimization ???
    //   nextEdges = v.pools
    //     .filter((edge) => {
    //       if (v.getNeibour(edge).price !== undefined) return false // token already priced
    //       const liquidity = price * Number(edge.reserve(v))
    //       edge.poolLiquidity = liquidity
    //       return (
    //         liquidity >= this.minLiquidity ||
    //         edge.pool.alwaysAppropriateForPricing()
    //       )
    //     })
    //     .sort((a, b) => a.poolLiquidity - b.poolLiquidity)
    // }
    for (let i = v.pools.length - 1; i >= 0; --i) {
      const edge = v.pools[i] as PoolEdge
      if (v.getNeibour(edge).price !== undefined) continue // token already priced
      const liquidity = price * Number(edge.reserve(v))
      edge.poolLiquidity = liquidity
      if (
        liquidity >= this.minLiquidity ||
        edge.pool.alwaysAppropriateForPricing()
      ) {
        let low = 0
        let up = nextEdges.length
        while (low < up) {
          const middle = (low + up) >> 1
          const diff = (nextEdges[middle]?.poolLiquidity as number) - liquidity
          if (diff > 0) up = middle
          else if (diff < 0) low = middle + 1
          else {
            low = middle
            break
          }
        }
        nextEdges.splice(low, 0, edge)
      }
    }
  }

  private _updatePricesForPools(pools: RPool[]) {
    // Auxiliary
    const tokens: (TokenInfo | undefined)[] = new Array(pools.length)

    // set changedPoolIndex for all tokens with changed price + create new priced tokens
    for (let i = pools.length - 1; i >= 0; --i) {
      const pool = pools[i] as RPool
      const token = this.poolTokenMap.get(pool.uniqueID())
      if (token) {
        if (!this._isPoolStillPricable(pool, token))
          this.fullPricesRecalcFlag = true
      } else this._checkAndAddNewToken(pool) // maybe create new priced token
      if (token && token.changedPoolIndex === undefined) {
        tokens[i] = token
        token.changedPoolIndex = i
      } else tokens[i] = undefined // not price-making pool or duplicated pool
    }

    let changedPrices = 0
    for (let i = pools.length - 1; i >= 0; --i) {
      if (tokens[i] === undefined) continue // just for optimization

      // finding firstChangedToken
      let firstChangedToken: TokenInfo | undefined = undefined
      for (
        let token: TokenInfo | undefined = tokens[i];
        token !== undefined;
        token = token.parent
      ) {
        if (token?.changedPoolIndex !== undefined) firstChangedToken = token
      }

      // update price for firstChangedToken and all dependent tokens
      if (firstChangedToken) {
        this._updatePricesForToken(firstChangedToken, 1, pools, tokens)
        changedPrices += firstChangedToken.totalSuccessors + 1
      }
    }

    return changedPrices
  }

  // recursive function for token and subtokens prices updating
  private _updatePricesForToken(
    token: TokenInfo,
    priceMultiplicator: number,
    pools: RPool[],
    tokens: (TokenInfo | undefined)[],
  ) {
    const poolIndex = token.changedPoolIndex
    if (poolIndex !== undefined) {
      // update priceMultiplicator and poolPrice
      const newPoolPrice = pools[poolIndex]?.calcCurrentPriceWithoutFee(
        !token.direction,
      ) as number
      priceMultiplicator = (priceMultiplicator / token.poolPrice) * newPoolPrice
      tokens[poolIndex] = undefined
      // @ts-ignore
      token.changedPoolIndex = undefined
      token.poolPrice = newPoolPrice
    }

    // update price
    this.prices[token.address] *= priceMultiplicator

    for (let i = token.children.length - 1; i >= 0; --i)
      this._updatePricesForToken(
        token.children[i] as TokenInfo,
        priceMultiplicator,
        pools,
        tokens,
      )
  }

  private _isPoolStillPricable(pool: RPool, tokenInfo: TokenInfo) {
    let token
    let reserve
    if (tokenInfo.direction) {
      token = pool.token0
      reserve = Number(pool.reserve0)
    } else {
      token = pool.token1
      reserve = Number(pool.reserve1)
    }
    const price = this.prices[token.address] as number
    const liquidity = (reserve * price) / 10 ** token.decimals
    const minPricableLiquidity =
      this.minLiquidity *
      (MAX_PRICABLE_LIQUIDITY -
        (MAX_PRICABLE_LIQUIDITY - MIN_PRICABLE_LIQUIDITY) /
          (tokenInfo.totalSuccessors + 1))
    if (liquidity < minPricableLiquidity)
      console.log(
        'Pool not pricable',
        pool.address,
        tokenInfo.direction,
        tokenInfo.totalSuccessors,
        liquidity,
      )
    return liquidity >= minPricableLiquidity
  }

  private _checkAndAddNewToken(pool: RPool): TokenInfo | undefined {
    const price0 = this.prices[pool.token0.address]
    const price1 = this.prices[pool.token1.address]
    if (price1 === undefined) {
      if (price0 === undefined) return // both tokens are unpriced
      const liquidity =
        (Number(pool.reserve0) * price0) / 10 ** pool.token0.decimals
      if (liquidity < this.minLiquidity) return // too low liquidity for pricing
      return this._addNewToken(pool, true, price0)
    } else {
      if (price0 !== undefined) return // both tokens are priced
      const liquidity =
        (Number(pool.reserve1) * price1) / 10 ** pool.token1.decimals
      if (liquidity < this.minLiquidity) return // too low liquidity for pricing
      return this._addNewToken(pool, false, price1)
    }
  }

  private _addNewToken(
    pool: RPool,
    direction: boolean,
    priceFrom: number,
  ): TokenInfo {
    let addrFrom = pool.token0.address as Address
    let addrTo = pool.token1.address as Address
    if (direction === false) {
      const tmp = addrFrom
      addrFrom = addrTo
      addrTo = tmp
    }
    const tokenInfo: TokenInfo = new TokenInfo(
      direction ? pool.token0 : pool.token1,
      direction,
      pool.calcCurrentPriceWithoutFee(!direction),
      this.tokenMap.get(addrFrom) as TokenInfo,
    )
    tokenInfo.parent?.children?.push(tokenInfo)
    this.poolTokenMap.set(pool.uniqueID(), tokenInfo)
    this.tokenMap.set(addrTo, tokenInfo)
    this.prices[addrTo] = priceFrom * tokenInfo.poolPrice
    ++this.pricesSize
    return tokenInfo
  }
}
