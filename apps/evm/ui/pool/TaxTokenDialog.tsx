import { Currency } from '@sushiswap/currency'
import { shortenAddress } from '@sushiswap/format'
import { useTokenSecurity } from '@sushiswap/react-query'
import { Button, DialogContent, DialogFooter, DialogHeader, DialogNew, DialogTitle } from '@sushiswap/ui'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

const tokenName = (token: Currency) =>
  token.name ? `${token.name} (${token.symbol})` : shortenAddress(token.wrapped.address)

export const TaxTokenDialog = ({ token0, token1 }: { token0: Currency | undefined; token1: Currency | undefined }) => {
  const [open, setOpen] = useState(false)

  const router = useRouter()

  const { data: tokenSecurityResponse } = useTokenSecurity({
    currencies: useMemo(
      () => [...(token0 ? [token0.wrapped] : []), ...(token1 ? [token1.wrapped] : [])],
      [token0, token1]
    ),
    onSuccess(data) {
      if (
        (token0 && (data?.[token0.wrapped.address]?.buy_tax || data?.[token0.wrapped.address]?.sell_tax)) ||
        (token1 && (data?.[token1.wrapped.address]?.buy_tax || data?.[token1.wrapped.address]?.sell_tax))
      )
        setOpen(true)
    },
  })

  const token0HasTax =
    token0 &&
    (tokenSecurityResponse?.[token0.wrapped.address]?.buy_tax ||
      tokenSecurityResponse?.[token0?.wrapped.address]?.sell_tax)

  const token1HasTax =
    token1 &&
    (tokenSecurityResponse?.[token1.wrapped.address]?.buy_tax ||
      tokenSecurityResponse?.[token1.wrapped.address]?.sell_tax)

  return (
    <DialogNew open={open} onOpenChange={(open) => setOpen(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tax token detected</DialogTitle>
        </DialogHeader>
        <div className="gap-3">
          <div>
            {token0HasTax && token1HasTax
              ? `${tokenName(token0)} and ${tokenName(token1)} are tax tokens.`
              : token0HasTax || token1HasTax
              ? `${token0HasTax ? tokenName(token0) : token1HasTax ? tokenName(token1) : null} is a tax token.`
              : null}
          </div>
          <div>
            Tax tokens are not supported in V3. You might not be able to trade, transfer, or withdraw liquidity of this
            token.
          </div>
        </div>
        <DialogFooter>
          <div className="flex gap-3 justify-center">
            <Button onClick={() => setOpen(false)} variant="destructive">
              Continue Anyways
            </Button>
            <Button onClick={router.back}>Cancel</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </DialogNew>
  )
}
