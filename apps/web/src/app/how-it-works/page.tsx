import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Card } from "@/components/ui";

export const metadata: Metadata = {
  title: "How it works",
  description: "Scoring, streaks, accuracy and settlement, explained plainly.",
};

/**
 * The rules.
 *
 * A scoring system nobody can find is a scoring system nobody trusts. Every
 * number the app shows is explained here in the same words the interface uses.
 */
export default function HowItWorksPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">How it works</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Everything the league counts, and how it counts it.
        </p>
      </div>

      {/* Two columns of cards on a wide screen. Each card's prose stays inside
          its own column, so the measure never runs to a full 1600px line. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="The call" image="/img/buy-sell-cards.jpg">
          <p>
            Each window asks one question: will BTC or ETH close higher than it opened? You pick
            Up or Down before the window closes, and stake test tUSDC on it.
          </p>
          <p>
            The percentage on each side is the market&apos;s implied chance of that outcome, and it
            is also what one contract costs. A winning contract pays exactly 1 tUSDC, so a call at
            40% costs 0.40 and returns 1.00 if it lands.
          </p>
        </Section>

        <Section title="Scoring" image="/img/chart-candles-dark.jpg">
          <ul className="list-disc space-y-1 pl-5">
            <li>A win scores 10 points.</li>
            <li>Three wins in a row and each win scores 15.</li>
            <li>Five in a row and each scores 20. That is the cap.</li>
            <li>A loss scores nothing and ends the streak.</li>
          </ul>
          <p>
            Only your first call on any one window scores. You can place more, and they still trade
            on-chain — they simply do not add points, so nobody can climb by spraying tiny calls at
            the same window.
          </p>
        </Section>

        <Section title="When a window voids" image="/img/chart-candles-red.jpg">
          <p>
            Sometimes a window cannot be settled reliably. That is a <strong>void</strong>: both
            sides are refunded at 0.50 per contract and the pooled stake is returned evenly.
          </p>
          <p>
            A void scores nothing, but it does <strong>not</strong> break your streak and it is not
            counted in your accuracy. It is the venue&apos;s problem, not your bad call.
          </p>
        </Section>

        <Section title="Accuracy" image="/img/terminal-numbers.jpg">
          <p>
            Accuracy is your wins divided by your settled calls, with voids excluded. It stays
            hidden until you have five settled calls, because a number based on two is noise.
          </p>
        </Section>

        <Section title="The week" image="/img/team-meeting.jpg">
          <p>
            The league runs Monday to Monday and resets at 00:00 UTC. A call belongs to the week its
            window <em>closes</em> in, so a call placed at 23:59 on Sunday for a window closing
            after midnight counts toward the new week.
          </p>
          <p>Streaks do not carry across the reset. Everyone starts Monday level.</p>
        </Section>

        <Section title="Claiming what you win" id="claiming" image="/img/coins-stacking.jpg">
          <p>
            Winnings are <strong>claimed, not sent</strong>. A settled window pays out only when
            someone asks it to, so a winning call does not move your balance by itself.
          </p>
          <p>
            Your calls page shows anything waiting. Until you redeem, the money sits with the
            settled window — safe, but not in your wallet.
          </p>
        </Section>

        <Section title="This is a testnet" image="/img/chain-blocks-3d.jpg">
          <p>
            Everything runs on Somnia Shannon with test tokens. tUSDC and STT have no value and
            cannot be exchanged for anything.{" "}
            <Link href="/start" className="text-accent underline underline-offset-2">
              Getting started
            </Link>{" "}
            explains how to get some.
          </p>
        </Section>
      </div>
    </>
  );
}

function Section({
  title, id, image, children,
}: { title: string; id?: string; image?: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      {image ? (
        <div className="relative h-28 w-full sm:h-32">
          {/* Decorative: the text carries the meaning, so no alt text to read out. */}
          <Image src={image} alt="" fill sizes="(max-width: 672px) 100vw, 672px" className="object-cover" />
        </div>
      ) : null}
      <div className="p-5">
        <h2 id={id} className="scroll-mt-28 text-sm font-semibold text-ink">
          {title}
        </h2>
        <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-soft">{children}</div>
      </div>
    </Card>
  );
}
