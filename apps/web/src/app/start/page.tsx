"use client";

/**
 * Onboarding.
 *
 * The Phase 3 exit gate is that a stranger with a fresh wallet gets through the
 * whole flow WITHOUT help. This page is that help, written down: add the
 * network, get gas, get stake, place a call. Each step says what to do and
 * shows whether it is already done.
 */
import { useAccount, useBalance, useSwitchChain } from "wagmi";
import Link from "next/link";
import Image from "next/image";
import { TESTNET_CHAIN_ID } from "@/lib/wagmi";
import { stt, shortAddress } from "@/lib/format";
import { ConnectButton } from "@/components/Wallet";
import { Button, Card } from "@/components/ui";

export default function StartPage() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const onRightChain = chainId === TESTNET_CHAIN_ID;

  const { data: gas } = useBalance({
    address,
    query: { enabled: Boolean(address) && onRightChain, refetchInterval: 10_000 },
  });

  const hasGas = gas ? gas.value > 0n : false;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Getting started</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Four steps, about two minutes. Everything here is test money.
        </p>
      </div>

      <ol className="grid gap-3 lg:grid-cols-2">
        <Step n={1} title="Connect a wallet" done={isConnected} image="/img/laptop-hands.jpg">
          {isConnected ? (
            <p className="tabular text-sm text-ink-soft">Connected as {shortAddress(address!)}.</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-soft">
                Any browser wallet works. Nothing is sent until you approve it.
              </p>
              <ConnectButton />
            </>
          )}
        </Step>

        <Step n={2} title="Switch to Somnia Shannon" done={isConnected && onRightChain} image="/img/chain-network-dark.jpg">
          {!isConnected ? (
            <p className="text-sm text-ink-faint">Connect first.</p>
          ) : onRightChain ? (
            <p className="text-sm text-ink-soft">You are on the right network.</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-soft">
                The league runs on Somnia&apos;s test network, chain {TESTNET_CHAIN_ID}. Your wallet
                will offer to add it.
              </p>
              <Button onClick={() => switchChain({ chainId: TESTNET_CHAIN_ID })} disabled={isPending}>
                {isPending ? "Check your wallet" : "Switch network"}
              </Button>
            </>
          )}
        </Step>

        <Step n={3} title="Get test funds" done={hasGas} image="/img/coins-pile.jpg">
          <p className="mb-3 text-sm text-ink-soft">
            You need two things: <strong>STT</strong> to pay for transactions, and{" "}
            <strong>tUSDC</strong> to stake. Both are free and worthless outside this testnet.
          </p>
          {hasGas && gas ? (
            <p className="tabular mb-3 text-sm text-ink-soft">
              You have {stt(gas.value)} STT for gas.
            </p>
          ) : null}
          <a
            href="https://testnet.somnia.network"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Open the faucet
          </a>
        </Step>

        <Step n={4} title="Make your first call" done={false} image="/img/phone-chart-blue.jpg">
          <p className="mb-3 text-sm text-ink-soft">
            Pick a direction, choose a stake, confirm in your wallet. The window settles on its own
            and your result appears on the board.
          </p>
          <Link href="/">
            <Button>Go to Play</Button>
          </Link>
        </Step>
      </ol>

      <p className="mt-6 text-sm text-ink-soft">
        Not sure what the numbers mean?{" "}
        <Link href="/how-it-works" className="text-accent underline underline-offset-2">
          How it works
        </Link>{" "}
        explains the scoring in plain terms.
      </p>
    </>
  );
}

function Step({
  n, title, done, image, children,
}: { n: number; title: string; done: boolean; image?: string; children: React.ReactNode }) {
  return (
    <li>
      <Card className="overflow-hidden">
        {image ? (
          <div className="relative h-24 w-full">
            <Image src={image} alt="" fill sizes="(max-width: 672px) 100vw, 672px" className="object-cover" />
          </div>
        ) : null}
        <div className="flex items-start gap-3 p-4">
          <span
            aria-hidden="true"
            className={`tabular mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
              done ? "border-up bg-up-soft text-up" : "border-border-strong text-ink-faint"
            }`}
          >
            {n}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">
              {title}
              {done ? <span className="ml-2 text-xs font-normal text-up">Done</span> : null}
            </h2>
            <div className="mt-2">{children}</div>
          </div>
        </div>
      </Card>
    </li>
  );
}
