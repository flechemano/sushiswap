'use client'

import { CheckerProvider } from '@sushiswap/wagmi/future/systems/Checker/Provider'
import { DeferUntilWalletReady } from 'ui/swap/defer-until-wallet-ready'
import { DerivedstateSimpleSwapProvider } from 'ui/swap/simple/derivedstate-simple-swap-provider'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <DeferUntilWalletReady>
      <CheckerProvider>
        <DerivedstateSimpleSwapProvider>{children}</DerivedstateSimpleSwapProvider>
      </CheckerProvider>
    </DeferUntilWalletReady>
  )
}