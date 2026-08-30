import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-lg font-semibold text-ink">Page not found</h1>
      <p className="mt-1 text-sm text-ink-soft">That page does not exist.</p>
      <Link
        href="/"
        className="mt-4 inline-block text-sm font-medium text-accent underline underline-offset-2"
      >
        Back to the game
      </Link>
    </div>
  );
}
